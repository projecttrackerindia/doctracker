// ============================================================================
// Observability API.
//
// Split out of GET /api/workspace on purpose. That endpoint returns projects +
// environments + request history + Try It collections + ALL metrics in one
// payload, decrypting five separate blobs to do it - and the Observability
// page was polling it every 60 seconds just to read the metrics. Worse, the
// agent's own push called cache.invalidateOrg(), so an active agent wiped
// every user's cached workspace org-wide once a minute and forced a full
// re-decrypt on the next request to ANY page.
//
// These routes read the two purpose-built time-series tables directly (see
// server/observabilityStore.js), return only what the requested date range
// needs, and never touch the workspace cache at all.
// ============================================================================
const express = require('express');
const { authenticate, blockIfScheduleLocked } = require('../middleware/authGuard');
const store = require('../observabilityStore');
const liveBus = require('../observabilityBus');

const router = express.Router();
router.use(authenticate);
router.use(blockIfScheduleLocked);

const MAX_RANGE_DAYS = 400;

// Date inputs are parsed and re-serialised rather than passed through: these
// land in SQL as ::timestamptz, and an unparseable string should fail here
// with a clear 400 rather than becoming a confusing database error.
function parseRange(query) {
  const now = Date.now();
  let to = query.to ? Date.parse(query.to) : now;
  let from = query.from ? Date.parse(query.from) : null;

  if (Number.isNaN(to)) return { error: '`to` is not a valid ISO date.' };
  if (from !== null && Number.isNaN(from)) return { error: '`from` is not a valid ISO date.' };

  // `window` is the convenience form the page's preset pills use; an explicit
  // `from` always wins over it.
  if (from === null) {
    const windowMs = {
      '15m': 15 * 60e3,
      '1h': 3600e3,
      '6h': 6 * 3600e3,
      '24h': 86400e3,
      '7d': 7 * 86400e3,
      '30d': 30 * 86400e3,
      '90d': 90 * 86400e3,
    }[query.window];
    from = windowMs ? to - windowMs : null;
  }

  if (from !== null && from >= to) return { error: '`from` must be earlier than `to`.' };
  if (from !== null && (to - from) > MAX_RANGE_DAYS * 86400e3) {
    return { error: `Range is longer than the ${MAX_RANGE_DAYS}-day maximum.` };
  }

  return {
    from: from === null ? null : new Date(from).toISOString(),
    to: new Date(to).toISOString(),
  };
}

// Picks a bucket size that keeps a chart readable at any range: roughly 200
// points, snapped to a sane unit. Without this, "last 90 days" at 1-minute
// resolution would return 129,600 points to draw ~400 pixels of chart.
function autoInterval(fromIso, toIso) {
  if (!fromIso) return 3600;
  const spanSec = (Date.parse(toIso) - Date.parse(fromIso)) / 1000;
  const target = spanSec / 200;
  const steps = [60, 300, 900, 1800, 3600, 10800, 21600, 43200, 86400];
  return steps.find((s) => s >= target) || 86400;
}

function envParam(req) {
  const raw = typeof req.query.environment === 'string' ? req.query.environment.trim() : '';
  return raw && raw.toLowerCase() !== 'all' ? raw.slice(0, 32) : null;
}

// The API / endpoint the sidebar has selected, as the endpoint ids it resolves
// to. Every read route takes it so that scoping one panel cannot leave another
// showing the whole estate beside it.
//
// Capped at MAX_SCOPE_ENDPOINTS because this arrives in a query string: the
// page is expected to send tens (one Mule app's endpoints), and a caller that
// sends thousands would build a URL no proxy will forward. Ids are validated
// rather than passed through - they reach a query as an array parameter, but
// they are also what an empty-looking result gets blamed on, and a silently
// mangled id is a bad way to spend someone's afternoon.
const MAX_SCOPE_ENDPOINTS = 400;

function endpointIdsParam(req) {
  const raw = req.query.endpointIds;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const ids = raw.split(',')
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z0-9_-]{1,64}$/.test(s));
  if (!ids.length) return null;
  return Array.from(new Set(ids)).slice(0, MAX_SCOPE_ENDPOINTS);
}

// --- Ingest (agent -> server) -----------------------------------------------
// The agent posts pre-aggregated 1-minute buckets and, only under
// CAPTURE_MODE=full, the raw records captured since its last successful push.
//
// Contrast with the old PUT /endpoint-metrics this supersedes: that one read
// the org's whole encrypted blob, decrypted it, merged in memory, re-encrypted
// it and rewrote the row - every cycle, holding a row lock throughout, whether
// or not anything had changed. This is an INSERT ... ON CONFLICT that sums,
// takes no lock anyone else contends on, and decrypts nothing.
router.put('/ingest', async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Expected a JSON body.' });
  }

  const envRaw = typeof body.environment === 'string' ? body.environment.trim() : '';
  // Same constraint as the metrics blob route: this is used as a grouping key
  // and rendered on a page, so it is validated here rather than trusted.
  if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{0,31}$/.test(envRaw)) {
    return res.status(400).json({
      error: 'environment is required, and must be a short label (letters, digits, spaces, - or _, max 32 chars).',
    });
  }

  try {
    const org = req.authUser.organisation;
    const [rollupResult, recordResult] = await Promise.all([
      store.ingestRollups(org, envRaw, body.rollups),
      store.ingestRecords(org, envRaw, body.records),
    ]);

    // Wake any browser currently watching this org's console. Deliberately
    // fire-and-forget and deliberately AFTER the writes above have resolved -
    // a listener that reacts by re-querying must not race the data it is
    // being told about.
    if (rollupResult.written || recordResult.written) {
      liveBus.publish(org, {
        environment: envRaw,
        rollupsWritten: rollupResult.written,
        recordsWritten: recordResult.written,
        at: new Date().toISOString(),
      });
    }

    res.json({
      ok: true,
      rollupsWritten: rollupResult.written,
      recordsWritten: recordResult.written,
      liveSubscribers: liveBus.subscriberCount(org),
    });
  } catch (err) {
    console.error('PUT /api/observability/ingest failed:', err);
    res.status(500).json({ error: 'Could not store observability data.' });
  }
});

// --- Read -------------------------------------------------------------------

router.get('/summary', async (req, res) => {
  const range = parseRange(req.query);
  if (range.error) return res.status(400).json({ error: range.error });
  try {
    const environment = envParam(req);
    const endpointIds = endpointIdsParam(req);
    const opts = {
      environment, from: range.from, to: range.to, endpointIds,
    };

    // The comparison window is the same length immediately before this one -
    // what the KPI deltas are measured against. Only computed when the range
    // is bounded; "all time" has nothing meaningful to compare to.
    let previous = null;
    if (range.from) {
      const span = Date.parse(range.to) - Date.parse(range.from);
      previous = await store.getSummary(req.authUser.organisation, {
        environment,
        endpointIds,
        from: new Date(Date.parse(range.from) - span).toISOString(),
        to: range.from,
      });
    }

    const [current, coverage] = await Promise.all([
      store.getSummary(req.authUser.organisation, opts),
      store.getCoverage(req.authUser.organisation, environment),
    ]);
    res.json({ range, current, previous, coverage });
  } catch (err) {
    console.error('GET /api/observability/summary failed:', err);
    res.status(500).json({ error: 'Could not load observability summary.' });
  }
});

router.get('/series', async (req, res) => {
  const range = parseRange(req.query);
  if (range.error) return res.status(400).json({ error: range.error });
  try {
    const intervalSeconds = req.query.interval
      ? parseInt(req.query.interval, 10)
      : autoInterval(range.from, range.to);
    const series = await store.getSeries(req.authUser.organisation, {
      environment: envParam(req),
      endpointIds: endpointIdsParam(req),
      from: range.from,
      to: range.to,
      intervalSeconds,
    });
    res.json({ range, intervalSeconds, series });
  } catch (err) {
    console.error('GET /api/observability/series failed:', err);
    res.status(500).json({ error: 'Could not load observability series.' });
  }
});

router.get('/endpoints', async (req, res) => {
  const range = parseRange(req.query);
  if (range.error) return res.status(400).json({ error: range.error });
  try {
    const endpoints = await store.getEndpointBreakdown(req.authUser.organisation, {
      environment: envParam(req),
      endpointIds: endpointIdsParam(req),
      from: range.from,
      to: range.to,
      limit: req.query.limit,
    });
    res.json({ range, endpoints });
  } catch (err) {
    console.error('GET /api/observability/endpoints failed:', err);
    res.status(500).json({ error: 'Could not load endpoint breakdown.' });
  }
});

router.get('/records', async (req, res) => {
  const range = parseRange(req.query);
  if (range.error) return res.status(400).json({ error: range.error });
  try {
    const result = await store.getRecords(req.authUser.organisation, {
      environment: envParam(req),
      from: range.from,
      to: range.to,
      endpointId: typeof req.query.endpointId === 'string' ? req.query.endpointId.slice(0, 64) : null,
      endpointIds: endpointIdsParam(req),
      statusFamily: typeof req.query.statusFamily === 'string' ? req.query.statusFamily : null,
      correlationId: typeof req.query.correlationId === 'string' ? req.query.correlationId.slice(0, 128) : null,
      clientIp: typeof req.query.clientIp === 'string' ? req.query.clientIp.slice(0, 64) : null,
      minLatencyMs: req.query.minLatencyMs,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json({ range, ...result });
  } catch (err) {
    console.error('GET /api/observability/records failed:', err);
    res.status(500).json({ error: 'Could not load log records.' });
  }
});

router.get('/environments', async (req, res) => {
  try {
    res.json({ environments: await store.getEnvironments(req.authUser.organisation) });
  } catch (err) {
    console.error('GET /api/observability/environments failed:', err);
    res.status(500).json({ error: 'Could not load environments.' });
  }
});

// --- Live stream (SSE) ------------------------------------------------------
// Replaces the page's 60-second poll. One-way server->browser is exactly what
// SSE is for: plain HTTP, native auto-reconnect in EventSource, no new
// infrastructure, and it authenticates off the same session cookie as every
// other route here (EventSource cannot set an Authorization header, which is
// why cookie auth matters).
router.get('/stream', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Tells nginx-style proxies not to buffer this response. Without it, a
    // proxy can hold events until its buffer fills, which defeats the point.
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const org = req.authUser.organisation;
  const send = (payload) => {
    try {
      res.write(`event: metrics\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch (err) { /* the socket is gone; the close handler below cleans up */ }
  };
  const unsubscribe = liveBus.subscribe(org, send);

  // Railway (and most proxies/load balancers) will drop a connection that goes
  // quiet. A comment line every 25s keeps it open and costs 15 bytes.
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (err) { /* same as above */ }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
    try { res.end(); } catch (err) { /* already closed */ }
  });
});

module.exports = router;
