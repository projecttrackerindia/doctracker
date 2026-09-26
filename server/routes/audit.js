const express = require('express');
const { createRateLimiter } = require('../rateLimitStore');
const { pool } = require('../db');
const { authenticate, blockIfScheduleLocked } = require('../middleware/authGuard');
const { recordAuditEvent, toClientShape } = require('../auditService');
const workspaceEventsBus = require('../workspaceEventsBus');
const { attachSseStream } = require('../sseHelper');

const router = express.Router();
router.use(authenticate);
router.use(blockIfScheduleLocked);

// Generous but bounded — this endpoint is called once per user action (endpoint
// saved, PII revealed, etc.), not per keystroke, so normal use never gets close.
const writeLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many audit events — please slow down.' },
});

const DEFAULT_PAGE_SIZE = 500;
const MAX_PAGE_SIZE = 1000; // matches the client's in-memory AUDIT_LOG_CAP per page

// Client-writable action vocabulary. Any authenticated user can call this
// endpoint directly (not just through the UI), so `action` must be checked
// against a known set rather than trusted as free text — otherwise anyone
// could write cosmetically-misleading audit entries (fake action names).
// Server-only actions (key rotation, PII rule changes, project promotion,
// etc.) are written by other routes calling recordAuditEvent() directly and
// are intentionally NOT in this list — this endpoint should never accept
// them from a client.
//
// SECURITY (Finding 4.2, consequence #2): PII_REVEAL used to be in this set,
// which meant the "an unmasked value was revealed" audit trail was entirely
// self-reported — any authenticated user could call this endpoint directly
// and either fabricate the event or, just as easily, simply never send it
// before looking at a value via devtools. Reveals are now recorded
// server-side, authoritatively, by POST /api/pii/reveal/:projectId itself
// (the only place unmasked data is ever returned) — so PII_REVEAL is no
// longer accepted from the client at all.
const ALLOWED_CLIENT_ACTIONS = new Set([
  'created',
  'updated',
  'deleted',
  'exported',
  'imported',
  'ADMIN_SETTING_CHANGED',
]);

// POST /api/audit/events — append one event. Identity (user/role/org), the
// timestamp, IP, and user-agent all come from the verified session/request,
// never from the request body — see recordAuditEvent().
router.post('/events', writeLimiter, async (req, res) => {
  const body = req.body || {};
  if (!body.action || typeof body.action !== 'string') {
    return res.status(400).json({ error: 'action is required.' });
  }
  if (!ALLOWED_CLIENT_ACTIONS.has(body.action)) {
    return res.status(400).json({ error: 'Unknown action.' });
  }
  try {
    const eventId = await recordAuditEvent(req.authUser, req, {
      action: body.action,
      resourceType: body.entityType,
      resourceId: body.entityId,
      entityName: body.entityName,
      projectName: body.projectName,
      details: body.details,
      apiName: body.apiName,
      environment: body.environment,
      result: body.result,
      severity: body.severity,
      metadata: body.metadata,
    });
    res.json({ ok: true, eventId });
  } catch (err) {
    console.error('POST /api/audit/events failed:', err);
    res.status(500).json({ error: 'Could not record audit event.' });
  }
});

// GET /api/audit/events — one page of events for the caller's organisation,
// most recent first. The existing audit-log UI does its own client-side
// search/filter/pagination over whatever set it's accumulated so far (it
// always has, even when the data lived in a single JSONB blob) — this just
// swaps where the data comes from and adds a cursor so that accumulated set
// isn't capped at one page forever.
//
// Previously this returned the newest MAX_RETURNED (1000) rows and stopped —
// there was no way to reach anything older through the API at all, so once
// an organisation passed 1000 events, everything before that point became
// permanently unreachable through the UI even though it was still sitting
// in the table. `before` (an opaque `seq` cursor from a previous response —
// see toClientShape in auditService.js) fixes that: pass the `seq` of the
// oldest event you've already loaded to get the next page older than it,
// and repeat until `hasMore` is false to walk the entire history.
router.get('/events', async (req, res) => {
  try {
    const before = req.query.before ? parseInt(req.query.before, 10) : null;
    if (req.query.before && !Number.isFinite(before)) {
      return res.status(400).json({ error: 'Invalid before cursor.' });
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);

    const params = [req.authUser.organisation];
    let cursorClause = '';
    if (before) {
      params.push(before);
      cursorClause = `AND id < $${params.length}`;
    }
    params.push(limit + 1); // fetch one extra to know if there's another page

    const { rows } = await pool.query(
      `SELECT * FROM audit_logs WHERE organisation = $1 ${cursorClause} ORDER BY id DESC LIMIT $${params.length}`,
      params
    );
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map(toClientShape);
    const nextCursor = page.length ? page[page.length - 1].seq : null;
    res.json({ entries: page, hasMore, nextCursor });
  } catch (err) {
    console.error('GET /api/audit/events failed:', err);
    res.status(500).json({ error: 'Could not load audit log.' });
  }
});

// GET /api/audit/stream — SSE. Same plain-HTTP/cookie-auth/native-reconnect
// pattern as /api/notifications/stream and /api/workspace/observability/stream
// (see attachSseStream's own header comment for the shared connection-ceiling
// and backpressure handling). Every 'workspace' event just means "re-check
// the newest audit events" — the client decides what, if anything, to
// refetch; the payload itself (see workspaceEventsBus.publish in
// auditService.js) is a hint, not the data.
router.get('/stream', async (req, res) => {
  attachSseStream(req, res, {
    eventName: 'workspace',
    subscribe: (send) => workspaceEventsBus.subscribe(req.authUser.organisation, send),
  });
});

module.exports = router;
