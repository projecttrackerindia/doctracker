// ============================================================================
// Shared SSE connection lifecycle - was duplicated near-identically across
// observability.js and notifications.js (and is about to be duplicated a
// third time for workspace change events), with the same two gaps in both
// copies: res.write()'s boolean back-pressure return value was never read
// (no `drain` handling anywhere), and neither route capped concurrent
// connections - the only ceiling was whatever the OS file-descriptor limit
// allowed. Centralizing here means both existing gaps get fixed once, not
// per-copy, and the next SSE route gets them for free instead of a third
// chance to reintroduce the same bug.
// ============================================================================

// A soft app-level guard, well below where the OS itself would start
// failing opens - the point is a clean 503 under real load, not silently
// serving connections until the process runs out of file descriptors (which
// this same process also needs for its DB pool and static file serving).
const MAX_SSE_CONNECTIONS = parseInt(process.env.MAX_SSE_CONNECTIONS || '2000', 10);

// One shared counter across every route that uses this helper - they all
// compete for the same underlying OS fd budget, so a per-route cap would
// let three routes each admit up to their own limit and still exhaust it
// together.
let activeConnections = 0;

function sseConnectionCount() {
  return activeConnections;
}

// Wires up a standard SSE response: headers, an initial comment, a 25s
// heartbeat, and a `send(payload)` function passed to `subscribe` that is
// back-pressure aware. Returns true if the stream was opened, false if the
// connection ceiling rejected it (the caller has already sent a response in
// that case - nothing more to do).
function attachSseStream(req, res, { eventName, subscribe }) {
  if (activeConnections >= MAX_SSE_CONNECTIONS) {
    res.status(503).json({ error: 'Too many live connections open right now. Try again shortly.' });
    return false;
  }
  activeConnections += 1;
  let closed = false;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    // Deliberately NOT setting Connection: keep-alive here (removed — see
    // below). It used to be set explicitly, on the assumption it was needed
    // to keep the underlying TCP connection open for a long-lived stream —
    // but Connection is a hop-by-hop header, and RFC 7540 §8.1.2.2 forbids
    // it entirely over HTTP/2: "An intermediary transforming an HTTP/1.x
    // message to HTTP/2 MUST remove connection-specific header fields... or
    // their messages will be treated as malformed". Reproduced live: the
    // browser reported net::ERR_HTTP2_PROTOCOL_ERROR specifically on this
    // app's SSE endpoints (Railway terminates HTTP/2 to the browser while
    // this backend still speaks HTTP/1.1), tearing the connection down and
    // forcing EventSource's automatic reconnect — the exact "LIVE badge
    // flickers to CONNECTING/OFFLINE on its own" behavior reported live.
    // Node keeps the underlying HTTP/1.1 connection to Railway's edge alive
    // on its own; this header was never required for that.
    // Tells nginx-style proxies not to buffer this response. Without it, a
    // proxy can hold events until its buffer fills, which defeats the point.
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  // `res.write()` returns false when the OS socket write buffer is full -
  // Node buffers internally regardless, so ignoring this (as both original
  // routes did) means a slow client's unread backlog grows unbounded from
  // this code's perspective. `drained` tracks whether the last write was
  // accepted; while it's false, new sends are coalesced to the single most
  // recent payload instead of queued, because an SSE push here means
  // "something changed, refetch" - a lagging client only ever needs the
  // LATEST state once it catches up, not every intermediate one.
  let drained = true;
  let pending = null;

  function rawSend(payload) {
    try {
      drained = res.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch (err) { /* the socket is gone; the close handler below cleans up */ }
  }

  res.on('drain', () => {
    drained = true;
    if (pending !== null) {
      const payload = pending;
      pending = null;
      rawSend(payload);
    }
  });

  const send = (payload) => {
    if (!drained) {
      pending = payload;
      return;
    }
    rawSend(payload);
  };

  const unsubscribe = subscribe(send);

  const heartbeat = setInterval(() => {
    if (!drained) return; // do not add to an already-backed-up socket's queue
    try { res.write(': ping\n\n'); } catch (err) { /* same as above */ }
  }, 25000);

  req.on('close', () => {
    if (closed) return;
    closed = true;
    activeConnections -= 1;
    clearInterval(heartbeat);
    unsubscribe();
    try { res.end(); } catch (err) { /* already closed */ }
  });

  return true;
}

module.exports = { attachSseStream, sseConnectionCount, MAX_SSE_CONNECTIONS };
