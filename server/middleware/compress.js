// ============================================================================
// Response compression, built on Node's own zlib.
//
// Deliberately not the `compression` npm package: adding a dependency means
// regenerating package-lock.json, and a lockfile that disagrees with
// package.json fails `npm ci` at build time. This does the same job in a few
// lines with a module Node already ships.
//
// JSON compresses roughly 10x, and the observability payloads are the largest
// JSON this app serves. The CPU spent gzipping is far less than the time saved
// on the wire.
//
// NOT compressed:
//   * text/event-stream - gzip buffers, and a buffered event stream is a
//     broken event stream. This is the whole reason for the explicit check
//     rather than a blanket "compress everything textual".
//   * responses under MIN_BYTES - below roughly a KB the gzip header and the
//     CPU cost outweigh the saving.
//   * anything already carrying a Content-Encoding.
// ============================================================================
const zlib = require('zlib');

const MIN_BYTES = 1024;

const COMPRESSIBLE = /^(?:text\/|application\/(?:json|javascript|xml|manifest\+json)|image\/svg\+xml)/i;

function pickEncoding(acceptEncoding) {
  const header = String(acceptEncoding || '').toLowerCase();
  // Brotli beats gzip on text by a useful margin and every browser this app
  // supports understands it; gzip stays as the fallback.
  if (header.includes('br')) return 'br';
  if (header.includes('gzip')) return 'gzip';
  return null;
}

function compressSync(encoding, buffer) {
  if (encoding === 'br') {
    return zlib.brotliCompressSync(buffer, {
      params: {
        // Quality 4 is the usual sweet spot for dynamic responses: most of the
        // ratio of the default (11) at a small fraction of the CPU. The
        // default is tuned for static assets compressed once, not per request.
        [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buffer.length,
      },
    });
  }
  return zlib.gzipSync(buffer, { level: 6 });
}

function compressionMiddleware(req, res, next) {
  const encoding = pickEncoding(req.headers['accept-encoding']);
  if (!encoding) return next();
  // A HEAD response carries no body; Express strips it for us on the normal
  // path, but this one writes the buffer itself, so it has to opt out.
  if (req.method === 'HEAD') return next();

  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);

  // `serialised` is what actually goes on the wire; `original` is what the
  // caller passed and what the fallback must receive. Keeping them separate
  // matters for res.json: handing the already-stringified text back to
  // Express's own res.json would JSON-encode it a SECOND time and every
  // client would receive a quoted string instead of an object.
  function trySendCompressed(serialised, original, fallback) {
    if (res.headersSent || res.getHeader('Content-Encoding')) return fallback(original);

    const contentType = String(res.getHeader('Content-Type') || '');
    if (contentType && !COMPRESSIBLE.test(contentType)) return fallback(original);
    // An SSE response never reaches here via res.json/res.send, but guard
    // anyway - a buffered event stream fails in a way that is hard to debug.
    if (contentType.includes('text/event-stream')) return fallback(original);

    const buffer = Buffer.isBuffer(serialised) ? serialised : Buffer.from(String(serialised), 'utf8');
    if (buffer.length < MIN_BYTES) return fallback(original);

    let compressed;
    try {
      compressed = compressSync(encoding, buffer);
    } catch (err) {
      // Never fail a response because compressing it failed.
      return fallback(original);
    }

    res.setHeader('Content-Encoding', encoding);
    res.setHeader('Content-Length', compressed.length);
    // Caches keyed only by URL would otherwise hand a brotli body to a client
    // that asked for gzip.
    res.setHeader('Vary', res.getHeader('Vary') ? `${res.getHeader('Vary')}, Accept-Encoding` : 'Accept-Encoding');
    return res.end(compressed);
  }

  res.json = function json(body) {
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    let serialised;
    try {
      serialised = JSON.stringify(body);
    } catch (err) {
      return originalJson(body); // circular structure etc - let Express report it
    }
    if (serialised === undefined) return originalJson(body);
    return trySendCompressed(serialised, body, originalJson);
  };

  res.send = function send(body) {
    // Express's own res.send() delegates objects to res.json(), which is
    // overridden above - so non-string bodies are already handled there.
    if (typeof body !== 'string' && !Buffer.isBuffer(body)) return originalSend(body);
    return trySendCompressed(body, body, originalSend);
  };

  return next();
}

module.exports = compressionMiddleware;
