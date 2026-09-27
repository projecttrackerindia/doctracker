const crypto = require('crypto');

// Same loose opaque-id shape auditService.js already validates an inbound
// x-request-id header against (see the HYGIENE 6e comment there) — kept in
// sync rather than imported, since this must run before any route/service
// code and auditService.js pulls in db.js at module load.
const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

// Assigns every request a correlation id — an upstream proxy's own id if it
// sent one and it looks genuine, otherwise a fresh one — and echoes it back
// as a response header. Nothing before this session generated one; a caller
// could only ever hand DocTracker an id, never get one out of it, so there
// was no way to hand a support engineer a single token that ties a client
// report to the exact server-side log lines and audit row for that request.
function assignRequestId(req, res, next) {
  const inbound = req.headers['x-request-id'];
  req.id = typeof inbound === 'string' && VALID_REQUEST_ID.test(inbound)
    ? inbound
    : crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
}

module.exports = { assignRequestId, VALID_REQUEST_ID };
