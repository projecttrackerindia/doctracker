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
const { pool, ensureLogRecordPartitions } = require('./db');

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

// ---- Observability time-series retention ---------------------------------
// Two tiers with very different lifetimes, which is the whole point of the
// split (see server/observabilityStore.js):
//
//   rollups  cheap, tiny, contain nothing sensitive by construction -> kept
//            for a year by default, which is what makes month-over-month
//            comparison possible at all.
//   records  contain real captured field values under CAPTURE_MODE=full ->
//            kept for a week by default, so the privacy exposure of full
//            capture is bounded to a short window instead of being permanent.
//
// Raw records are dropped a PARTITION at a time, never with a DELETE. A
// scheduled DELETE of millions of rows leaves behind dead tuples that then
// need vacuuming, so the cleanup job slowly degrades the table it exists to
// keep healthy. DROP TABLE on a day's partition is effectively instant and
// reclaims the space immediately.
const ROLLUP_RETENTION_DAYS = parseInt(process.env.OBS_ROLLUP_RETENTION_DAYS || '400', 10);
const RECORD_RETENTION_DAYS = parseInt(process.env.OBS_RECORD_RETENTION_DAYS || '7', 10);

async function pruneOldRollups() {
  if (!ROLLUP_RETENTION_DAYS || ROLLUP_RETENTION_DAYS <= 0) return { deleted: 0 };
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM endpoint_metrics_rollup
       WHERE bucket_start < now() - ($1 || ' days')::interval`,
      [ROLLUP_RETENTION_DAYS]
    );
    if (rowCount) console.log(`Retention: deleted ${rowCount} rollup bucket(s) older than ${ROLLUP_RETENTION_DAYS} days.`);
    return { deleted: rowCount };
  } catch (err) {
    console.error('pruneOldRollups failed (will retry next sweep):', err.message);
    return { deleted: 0 };
  }
}

async function dropOldRecordPartitions() {
  if (!RECORD_RETENTION_DAYS || RECORD_RETENTION_DAYS <= 0) return { dropped: [] };
  try {
    // Ask Postgres which partitions exist rather than computing names and
    // hoping - a gap (an instance that was down on a given day) would make a
    // computed-name DROP silently skip real, older partitions behind it.
    const { rows } = await pool.query(
      `SELECT c.relname AS name
       FROM pg_class c
       JOIN pg_inherits i ON i.inhrelid = c.oid
       JOIN pg_class parent ON parent.oid = i.inhparent
       WHERE parent.relname = 'endpoint_log_records'`
    );
    const cutoff = Date.now() - RECORD_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const dropped = [];
    for (const { name } of rows) {
      const match = /^endpoint_log_records_(\d{4})_(\d{2})_(\d{2})$/.exec(name);
      if (!match) continue;
      const partitionDay = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
      // The partition covers [day, day+1), so it is only fully past the cutoff
      // once its END is. Comparing the start would drop a partition still
      // holding records inside the retention window.
      if (partitionDay + 24 * 60 * 60 * 1000 > cutoff) continue;
      await pool.query(`DROP TABLE IF EXISTS ${name};`);
      dropped.push(name);
    }
    if (dropped.length) {
      console.log(`Retention: dropped ${dropped.length} log-record partition(s) older than ${RECORD_RETENTION_DAYS} days: ${dropped.join(', ')}`);
    }
    return { dropped };
  } catch (err) {
    console.error('dropOldRecordPartitions failed (will retry next sweep):', err.message);
    return { dropped: [] };
  }
}

// Partitions must exist BEFORE the agent pushes into them - a partitioned
// table with no partition covering the incoming timestamp rejects the INSERT
// outright. Created several days ahead so a missed sweep (or a restart-free
// stretch longer than a day) can never cause dropped ingest.
async function ensureUpcomingPartitions() {
  try {
    await ensureLogRecordPartitions(7);
    return { ok: true };
  } catch (err) {
    console.error('ensureUpcomingPartitions failed (will retry next sweep):', err.message);
    return { ok: false };
  }
}

async function runRetentionSweep() {
  await archiveOldAuditLogs();
  await pruneOldNotifications();
  // Creating the next few days' partitions runs BEFORE the drop, so a sweep
  // that fails partway still leaves somewhere for tomorrow's data to land.
  await ensureUpcomingPartitions();
  await pruneOldRollups();
  await dropOldRecordPartitions();
}

const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000; // once a day

// Called once from server.js after the DB/migrations are ready. Fires an
// initial sweep shortly after boot (delayed, so it never competes with
// startup for DB connections) and then on a fixed daily interval.
function startRetentionSchedule() {
  setTimeout(() => runRetentionSweep().catch((err) => console.error('Initial retention sweep failed:', err.message)), 60 * 1000);
  setInterval(() => runRetentionSweep().catch((err) => console.error('Scheduled retention sweep failed:', err.message)), SWEEP_INTERVAL_MS);
}

module.exports = {
  startRetentionSchedule,
  runRetentionSweep,
  archiveOldAuditLogs,
  pruneOldNotifications,
  pruneOldRollups,
  dropOldRecordPartitions,
  ensureUpcomingPartitions,
};
