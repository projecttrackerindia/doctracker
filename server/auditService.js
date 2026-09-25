const crypto = require('crypto');
const { pool } = require('./db');

// The single place that ever writes to `audit_logs`. Both the audit route
// (frontend-triggered events like endpoint edits, PII reveals) and other
// server routes (e.g. PII rule changes) call this directly rather than
// building INSERTs themselves, so the "never trust client identity" rule
// can't accidentally be bypassed by a future call site.
//
// `authUser` MUST come from the verified session (req.authUser) — never from
// request body. `fields` carries only descriptive, non-identity data.
async function recordAuditEvent(authUser, req, fields = {}) {
  return insertAuditRow(
    {
      organisation: authUser.organisation,
      userId: authUser.sub,
      username: authUser.username,
      role: authUser.role,
      ip: req && req.ip ? String(req.ip).slice(0, 64) : null,
      userAgent: req && req.get ? (req.get('user-agent') || '').slice(0, 300) : null,
      // HYGIENE (6e): previously trusted req.headers['x-request-id'] verbatim
      // with no format validation, so it couldn't be relied on as a genuine
      // correlation key for forensics. Now only accepted if it looks like a
      // real request-id token (loose UUID/opaque-id shape, bounded length);
      // anything else falls back to the server-generated eventId, same as
      // when the header is absent (see insertAuditRow).
      requestId: (req && req.headers && /^[A-Za-z0-9._-]{1,128}$/.test(req.headers['x-request-id'] || ''))
        ? req.headers['x-request-id']
        : null,
    },
    fields
  );
}

// For events triggered by server-side background processes (the alert
// engine's sweep/webhook delivery, for instance) that have no Express `req`
// to derive identity/IP/user-agent from — every existing audit action was
// written assuming an authenticated user triggered it. `role: 'system'` and
// a null `user_id` (the column already tolerates NULL — see db.js) makes
// these visibly distinct from a real user's actions in the audit log rather
// than attributing them to whichever admin happened to be signed in.
async function recordSystemAuditEvent(organisation, fields = {}) {
  return insertAuditRow(
    { organisation, userId: null, username: 'system', role: 'system', ip: null, userAgent: null, requestId: null },
    fields
  );
}

async function insertAuditRow(identity, fields = {}) {
  const eventId = crypto.randomUUID();
  const {
    action,
    resourceType = null,
    resourceId = null,
    entityName = null,
    projectName = null,
    details = null,
    apiName = null,
    environment = null,
    result = 'success',
    severity = 'info',
    metadata = {},
  } = fields;

  if (!action || typeof action !== 'string') {
    throw new Error('recordAuditEvent requires an action string');
  }

  await pool.query(
    `INSERT INTO audit_logs
      (event_id, organisation, user_id, username, role, action, resource_type, resource_id,
       entity_name, project_name, details, api_name, environment, ip_address, user_agent,
       request_id, result, severity, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [
      eventId,
      identity.organisation,
      identity.userId,
      identity.username,
      identity.role,
      String(action).slice(0, 64),
      resourceType,
      resourceId ? String(resourceId).slice(0, 200) : null,
      entityName ? String(entityName).slice(0, 300) : null,
      projectName ? String(projectName).slice(0, 300) : null,
      details ? (typeof details === 'string' ? details : JSON.stringify(details)).slice(0, 1000) : null,
      apiName,
      environment,
      identity.ip,
      identity.userAgent,
      identity.requestId || eventId,
      result === 'failure' ? 'failure' : 'success',
      ['info', 'warning', 'critical'].includes(severity) ? severity : 'info',
      JSON.stringify(metadata && typeof metadata === 'object' ? metadata : {}),
    ]
  );

  return eventId;
}

// Maps a DB row to the shape the frontend's audit log UI already understands
// (actor/entityType/entityName/...), plus a few extra fields (role, environment,
// severity, result) the UI now also renders. Keeping the legacy field names
// meant the existing audit-log popup didn't need a rewrite.
function toClientShape(row) {
  return {
    id: row.event_id,
    // Numeric, strictly-increasing row id — used ONLY as an opaque
    // pagination cursor (see GET /api/audit/events's `before` param).
    // Distinct from `id` above (the client-facing event_id) so existing
    // consumers that key off `id` are unaffected by this addition.
    seq: row.id,
    ts: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    actor: row.username || 'Unknown',
    action: row.action,
    entityType: row.resource_type || '',
    entityName: row.entity_name || '',
    projectName: row.project_name || '',
    details: row.details || '',
    role: row.role || '',
    environment: row.environment || '',
    severity: row.severity || 'info',
    result: row.result || 'success',
    ip: row.ip_address || '',
  };
}

module.exports = { recordAuditEvent, recordSystemAuditEvent, toClientShape };
