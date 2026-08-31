const express = require('express');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const { authenticate } = require('../middleware/authGuard');
const { recordAuditEvent, toClientShape } = require('../auditService');

const router = express.Router();
router.use(authenticate);

// Generous but bounded — this endpoint is called once per user action (endpoint
// saved, PII revealed, etc.), not per keystroke, so normal use never gets close.
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many audit events — please slow down.' },
});

const MAX_RETURNED = 1000; // matches the client's in-memory AUDIT_LOG_CAP

// POST /api/audit/events — append one event. Identity (user/role/org), the
// timestamp, IP, and user-agent all come from the verified session/request,
// never from the request body — see recordAuditEvent().
router.post('/events', writeLimiter, async (req, res) => {
  const body = req.body || {};
  if (!body.action || typeof body.action !== 'string') {
    return res.status(400).json({ error: 'action is required.' });
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

// GET /api/audit/events — most recent events for the caller's organisation.
// The existing audit-log UI does its own client-side search/filter/pagination
// over this set (it always has, even when the data lived in a single JSONB
// blob) — this just swaps where the data comes from.
router.get('/events', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM audit_logs WHERE organisation = $1 ORDER BY created_at DESC LIMIT $2`,
      [req.authUser.organisation, MAX_RETURNED]
    );
    res.json({ entries: rows.map(toClientShape) });
  } catch (err) {
    console.error('GET /api/audit/events failed:', err);
    res.status(500).json({ error: 'Could not load audit log.' });
  }
});

module.exports = router;
