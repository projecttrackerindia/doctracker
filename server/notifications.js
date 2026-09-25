const { pool } = require('./db');
const liveBus = require('./notificationsBus');

// Single place that ever writes to `notifications` — same pattern as
// auditService.recordAuditEvent, and deliberately called from the exact
// spots that already call recordAuditEvent for these actions (doc-access
// request/approve/deny/revoke, live-mode grant changes, project-access
// shares, new accounts), so this is fan-out to a recipient's inbox, not a
// new, separately-maintained instrumentation surface.
//
// `link` is a small, client-interpreted routing hint — e.g.
// { view: 'security', tab: 'docaccess' } or { view: 'endpoint', projectId, endpointId }
// — never a raw URL, so it stays meaningful even if the SPA's own routing
// changes shape later.
async function notifyUser(userId, { organisation, type, title, body = null, link = null }) {
  if (!userId || !type || !title) return null;
  const { rows } = await pool.query(
    `INSERT INTO notifications (organisation, user_id, type, title, body, link)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, organisation, user_id, type, title, body, link, read_at, created_at`,
    [organisation, userId, String(type).slice(0, 64), String(title).slice(0, 300), body ? String(body).slice(0, 500) : null, link ? JSON.stringify(link) : null]
  );
  const row = rows[0];
  // Fire-and-forget: a live-push failure must never turn an already-committed
  // notification write into a reported error for the caller. Same discipline
  // as observabilityBus.publish (see its own header comment).
  try {
    liveBus.publish(organisation, userId, row);
  } catch (err) {
    console.error('Notifications: live publish failed:', err.message);
  }
  return row.id;
}

// Fan-out helper for the common "notify everyone with a given set of user
// ids" case (e.g. every Admin, or a list of affected grant-holders).
async function notifyUsers(userIds, fields) {
  const unique = [...new Set((userIds || []).filter(Boolean))];
  await Promise.all(unique.map((uid) => notifyUser(uid, fields)));
}

// Every Admin in the organisation — the default recipient set for anything
// that previously had "no signal an Admin needs to look at this."
async function adminUserIds(organisation) {
  const { rows } = await pool.query(`SELECT id FROM users WHERE organisation = $1 AND role = 'admin'`, [organisation]);
  return rows.map((r) => r.id);
}

async function listForUser(userId, { limit = 30, beforeId = null } = {}) {
  const cappedLimit = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100);
  const params = [userId];
  let cursorClause = '';
  if (beforeId) {
    params.push(beforeId);
    cursorClause = `AND id < $${params.length}`;
  }
  params.push(cappedLimit + 1); // fetch one extra to know if there's more
  const { rows } = await pool.query(
    `SELECT id, type, title, body, link, read_at, created_at
     FROM notifications
     WHERE user_id = $1 ${cursorClause}
     ORDER BY id DESC
     LIMIT $${params.length}`,
    params
  );
  const hasMore = rows.length > cappedLimit;
  return { notifications: rows.slice(0, cappedLimit), hasMore };
}

async function unreadCount(userId) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
    [userId]
  );
  return rows[0]?.n || 0;
}

async function markRead(userId, id) {
  await pool.query(
    `UPDATE notifications SET read_at = now() WHERE id = $1 AND user_id = $2 AND read_at IS NULL`,
    [id, userId]
  );
}

async function markAllRead(userId) {
  await pool.query(`UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`, [userId]);
}

module.exports = { notifyUser, notifyUsers, adminUserIds, listForUser, unreadCount, markRead, markAllRead };
