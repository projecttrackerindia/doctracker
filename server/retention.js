// Retention/archival for the two tables that otherwise grow forever:
// audit_logs and notifications. Nothing here is destructive by default —
// both knobs are OFF (keep everything) unless explicitly configured, so
// upgrading to this doesn't silently start deleting anyone's history.
//
//   AUDIT_LOG_RETENTION_DAYS   — unset/0 = keep forever (default).
//                                 If set, rows older than N days are moved
//                                 (not deleted-and-gone) into
//                                 audit_logs_archive — see
//                                 migrations/sql/0002_audit_retention.sql.
//                                 The archive table has the same columns and
//                                 is still queryable directly in Postgres;
//                                 it's just out of the hot table the app
//                                 reads from.
//   NOTIFICATIONS_RETENTION_DAYS — defaults to 90. Only READ notifications
//                                 older than N days are deleted outright —
//                                 unread ones are never auto-deleted,
//                                 regardless of age, since an unread
//                                 notification disappearing is a real loss
//                                 of signal to the recipient. Notifications
//                                 are a fan-out convenience pointer, not a
//                                 record of truth (the underlying event is
//                                 already in audit_logs), so straight
//                                 deletion — not archival — is the right
//                                 call here.
//
// Runs as a daily interval from server.js, plus once shortly after boot.
// Not a cron dependency: this app already assumes a single long-running
// Node process (see rateLimitStore.js's own per-instance-vs-Redis notes),
// so a setInterval is the same amount of infrastructure the rest of the app
// already relies on, and one extra sweep on top of the existing schedule if
// two instances happen to be running is harmless (both operations are
// idempotent — a row that's already archived/deleted just won't match the
// WHERE clause a second time).
const { pool } = require('./db');

const AUDIT_RETENTION_DAYS = parseInt(process.env.AUDIT_LOG_RETENTION_DAYS || '0', 10);
const NOTIFICATIONS_RETENTION_DAYS = parseInt(process.env.NOTIFICATIONS_RETENTION_DAYS || '90', 10);

// Archives (moves) old audit_logs rows in batches rather than one huge
// DELETE ... RETURNING, so a first-ever run against a large, never-pruned
// table doesn't hold a long-running transaction/lock over the whole thing.
async function archiveOldAuditLogs() {
  if (!AUDIT_RETENTION_DAYS || AUDIT_RETENTION_DAYS <= 0) return { archived: 0 };
  const BATCH_SIZE = 5000;
  let totalArchived = 0;
  for (;;) {
    const client = await pool.connect();
    let movedThisBatch = 0;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT id FROM audit_logs
         WHERE created_at < now() - ($1 || ' days')::interval
         ORDER BY id
         LIMIT $2
         FOR UPDATE SKIP LOCKED`,
        [AUDIT_RETENTION_DAYS, BATCH_SIZE]
      );
      if (rows.length) {
        const ids = rows.map((r) => r.id);
        // Explicit column list (not `SELECT *`) — audit_logs_archive has one
        // extra column (archived_at, server-defaulted) that audit_logs
        // doesn't, so a positional `SELECT *` would fail on column-count
        // mismatch.
        await client.query(
          `INSERT INTO audit_logs_archive (
             id, event_id, organisation, user_id, username, role, action,
             resource_type, resource_id, entity_name, project_name, details,
             api_name, environment, ip_address, user_agent, request_id,
             result, severity, metadata, created_at
           )
           SELECT
             id, event_id, organisation, user_id, username, role, action,
             resource_type, resource_id, entity_name, project_name, details,
             api_name, environment, ip_address, user_agent, request_id,
             result, severity, metadata, created_at
           FROM audit_logs WHERE id = ANY($1)
           ON CONFLICT (id) DO NOTHING`,
          [ids]
        );
        const del = await client.query(`DELETE FROM audit_logs WHERE id = ANY($1)`, [ids]);
        movedThisBatch = del.rowCount;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('archiveOldAuditLogs batch failed (will retry next sweep):', err.message);
      break;
    } finally {
      client.release();
    }
    totalArchived += movedThisBatch;
    if (movedThisBatch < BATCH_SIZE) break; // caught up
  }
  if (totalArchived) console.log(`Retention: archived ${totalArchived} audit_logs row(s) older than ${AUDIT_RETENTION_DAYS} days.`);
  return { archived: totalArchived };
}

async function pruneOldNotifications() {
  if (!NOTIFICATIONS_RETENTION_DAYS || NOTIFICATIONS_RETENTION_DAYS <= 0) return { deleted: 0 };
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM notifications
       WHERE read_at IS NOT NULL
         AND created_at < now() - ($1 || ' days')::interval`,
      [NOTIFICATIONS_RETENTION_DAYS]
    );
    if (rowCount) console.log(`Retention: deleted ${rowCount} read notification(s) older than ${NOTIFICATIONS_RETENTION_DAYS} days.`);
    return { deleted: rowCount };
  } catch (err) {
    console.error('pruneOldNotifications failed (will retry next sweep):', err.message);
    return { deleted: 0 };
  }
}

async function runRetentionSweep() {
  await archiveOldAuditLogs();
  await pruneOldNotifications();
}

const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000; // once a day

// Called once from server.js after the DB/migrations are ready. Fires an
// initial sweep shortly after boot (delayed, so it never competes with
// startup for DB connections) and then on a fixed daily interval.
function startRetentionSchedule() {
  setTimeout(() => runRetentionSweep().catch((err) => console.error('Initial retention sweep failed:', err.message)), 60 * 1000);
  setInterval(() => runRetentionSweep().catch((err) => console.error('Scheduled retention sweep failed:', err.message)), SWEEP_INTERVAL_MS);
}

module.exports = { startRetentionSchedule, runRetentionSweep, archiveOldAuditLogs, pruneOldNotifications };
