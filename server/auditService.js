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
      authUser.organisation,
      authUser.sub,
      authUser.username,
      authUser.role,
      String(action).slice(0, 64),
      resourceType,
      resourceId ? String(resourceId).slice(0, 200) : null,
      entityName ? String(entityName).slice(0, 300) : null,
      projectName ? String(projectName).slice(0, 300) : null,
      details ? String(details).slice(0, 1000) : null,
      apiName,
      environment,
      req && req.ip ? String(req.ip).slice(0, 64) : null,
      req && req.get ? (req.get('user-agent') || '').slice(0, 300) : null,
      (req && req.headers && req.headers['x-request-id']) || eventId,
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
  };
}

module.exports = { recordAuditEvent, toClientShape };
