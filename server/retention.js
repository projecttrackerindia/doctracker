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
const { log } = require('./logger');

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

// Rolls minute buckets older than the cutoff up into hourly ones, then
// deletes the minute rows that were folded in. The two tables stay DISJOINT,
// which is what lets the read queries union them without double counting.
//
// Runs inside one transaction per batch: if the insert succeeded and the
// delete did not, the same minutes would be added to the hourly row AGAIN on
// the next sweep, permanently inflating them. Batched by day so a first run
// against a long backlog does not hold one enormous transaction open.
const ROLLUP_MINUTE_RETENTION_DAYS = parseInt(process.env.OBS_ROLLUP_MINUTE_RETENTION_DAYS || '30', 10);

async function downsampleOldRollups() {
  if (!ROLLUP_MINUTE_RETENTION_DAYS || ROLLUP_MINUTE_RETENTION_DAYS <= 0) return { folded: 0 };
  let foldedTotal = 0;
  try {
    // At most 30 day-batches per sweep; a longer backlog drains over
    // subsequent nightly runs rather than in one very long transaction.
    for (let batch = 0; batch < 30; batch += 1) {
      const client = await pool.connect();
      let foldedThisBatch = 0;
      try {
        await client.query('BEGIN');
        // The oldest day that still has minute rows past the cutoff.
        const { rows: dayRows } = await client.query(
          `SELECT date_trunc('day', MIN(bucket_start) AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS day
           FROM endpoint_metrics_rollup
           WHERE bucket_start < now() - ($1 || ' days')::interval`,
          [ROLLUP_MINUTE_RETENTION_DAYS]
        );
        const day = dayRows[0] && dayRows[0].day;
        if (!day) { await client.query('ROLLBACK'); break; }

        const { rowCount } = await client.query(
          `WITH src AS (
             SELECT * FROM endpoint_metrics_rollup
             WHERE bucket_start >= $1::timestamptz
               AND bucket_start <  $1::timestamptz + interval '1 day'
           ),
           totals AS (
             SELECT organisation, environment, endpoint_id,
                    date_trunc('hour', bucket_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS h,
                    SUM(request_count)::int  AS request_count,
                    SUM(status_2xx)::int     AS status_2xx,
                    SUM(status_3xx)::int     AS status_3xx,
                    SUM(status_4xx)::int     AS status_4xx,
                    SUM(status_5xx)::int     AS status_5xx,
                    SUM(status_unknown)::int AS status_unknown,
                    SUM(latency_sum)::bigint AS latency_sum,
                    SUM(latency_count)::int  AS latency_count,
                    MIN(latency_min)         AS latency_min,
                    MAX(latency_max)         AS latency_max
             FROM src GROUP BY 1,2,3,4
           ),
           histos AS (
             SELECT organisation, environment, endpoint_id, h,
                    jsonb_object_agg(k, v) AS latency_buckets
             FROM (
               SELECT organisation, environment, endpoint_id,
                      date_trunc('hour', bucket_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS h,
                      kv.key AS k, SUM(kv.value::numeric) AS v
               FROM src, LATERAL jsonb_each_text(latency_buckets) kv
               GROUP BY 1,2,3,4,5
             ) x GROUP BY 1,2,3,4
           ),
           ips AS (
             SELECT organisation, environment, endpoint_id, h,
                    jsonb_object_agg(k, v) AS source_ips
             FROM (
               SELECT organisation, environment, endpoint_id,
                      date_trunc('hour', bucket_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS h,
                      kv.key AS k, SUM(kv.value::numeric) AS v
               FROM src, LATERAL jsonb_each_text(source_ips) kv
               GROUP BY 1,2,3,4,5
             ) y GROUP BY 1,2,3,4
           )
           INSERT INTO endpoint_metrics_rollup_hourly (
             organisation, environment, endpoint_id, bucket_start,
             request_count, status_2xx, status_3xx, status_4xx, status_5xx, status_unknown,
             latency_sum, latency_count, latency_min, latency_max, latency_buckets, source_ips
           )
           SELECT t.organisation, t.environment, t.endpoint_id, t.h,
                  t.request_count, t.status_2xx, t.status_3xx, t.status_4xx,
                  t.status_5xx, t.status_unknown, t.latency_sum, t.latency_count,
                  t.latency_min, t.latency_max,
                  COALESCE(hs.latency_buckets, '{}'::jsonb),
                  COALESCE(ip.source_ips, '{}'::jsonb)
           FROM totals t
           LEFT JOIN histos hs USING (organisation, environment, endpoint_id, h)
           LEFT JOIN ips    ip USING (organisation, environment, endpoint_id, h)
           ON CONFLICT (organisation, environment, endpoint_id, bucket_start) DO UPDATE SET
             request_count  = endpoint_metrics_rollup_hourly.request_count  + EXCLUDED.request_count,
             status_2xx     = endpoint_metrics_rollup_hourly.status_2xx     + EXCLUDED.status_2xx,
             status_3xx     = endpoint_metrics_rollup_hourly.status_3xx     + EXCLUDED.status_3xx,
             status_4xx     = endpoint_metrics_rollup_hourly.status_4xx     + EXCLUDED.status_4xx,
             status_5xx     = endpoint_metrics_rollup_hourly.status_5xx     + EXCLUDED.status_5xx,
             status_unknown = endpoint_metrics_rollup_hourly.status_unknown + EXCLUDED.status_unknown,
             latency_sum    = endpoint_metrics_rollup_hourly.latency_sum    + EXCLUDED.latency_sum,
             latency_count  = endpoint_metrics_rollup_hourly.latency_count  + EXCLUDED.latency_count,
             latency_min    = LEAST(endpoint_metrics_rollup_hourly.latency_min, EXCLUDED.latency_min),
             latency_max    = GREATEST(endpoint_metrics_rollup_hourly.latency_max, EXCLUDED.latency_max),
             latency_buckets = jsonb_counter_merge(endpoint_metrics_rollup_hourly.latency_buckets, EXCLUDED.latency_buckets),
             source_ips      = jsonb_counter_merge(endpoint_metrics_rollup_hourly.source_ips, EXCLUDED.source_ips)`,
          [day]
        );
        foldedThisBatch = rowCount;

        await client.query(
          `DELETE FROM endpoint_metrics_rollup
           WHERE bucket_start >= $1::timestamptz
             AND bucket_start <  $1::timestamptz + interval '1 day'`,
          [day]
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
      foldedTotal += foldedThisBatch;
      if (!foldedThisBatch) break;
    }
    if (foldedTotal) {
      console.log(`Retention: folded ${foldedTotal} minute bucket group(s) into hourly rows (minute data kept for ${ROLLUP_MINUTE_RETENTION_DAYS} days).`);
    }
    return { folded: foldedTotal };
  } catch (err) {
    console.error('downsampleOldRollups failed (will retry next sweep):', err.message);
    return { folded: foldedTotal };
  }
}

// The final horizon, applied to BOTH tiers. Minute rows this old would
// normally have been folded into hourly ones already; the minute sweep is
// kept anyway so that a deployment which had downsampling disabled, or which
// fell far behind, still has its oldest data bounded.
async function pruneOldRollups() {
  if (!ROLLUP_RETENTION_DAYS || ROLLUP_RETENTION_DAYS <= 0) return { deleted: 0 };
  try {
    const { rowCount: hourlyDeleted } = await pool.query(
      `DELETE FROM endpoint_metrics_rollup_hourly
       WHERE bucket_start < now() - ($1 || ' days')::interval`,
      [ROLLUP_RETENTION_DAYS]
    );
    if (hourlyDeleted) console.log(`Retention: deleted ${hourlyDeleted} hourly rollup bucket(s) older than ${ROLLUP_RETENTION_DAYS} days.`);
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

// A fixed, single global key, same reasoning as alertEngine.js's sweep lock:
// this sweep already loops all its sub-tasks in one tick, so the unit of
// "should this run at all right now" is one process, not one org/table.
const RETENTION_LOCK_KEY = "hashtext('doctracker:retention-sweep')";

// Runs on a `setInterval` (see startRetentionSchedule below) with no other
// coordination between processes. Every sub-task here is individually
// idempotent (a row already archived/deleted/dropped just won't match the
// WHERE clause again), which is why this went unlocked for a while — but two
// instances both archiving the same batch, or both trying to DROP the same
// partition, is still wasted duplicate work on every deploy with 2+
// instances, not just a rare race. Same `pg_try_advisory_lock` skip-if-busy
// pattern as the alert sweep: at most one instance actually runs per tick,
// the others no-op and try again next interval.
async function runRetentionSweep() {
  const client = await pool.connect();
  try {
    const { rows: lockRows } = await client.query(`SELECT pg_try_advisory_lock(${RETENTION_LOCK_KEY}) AS acquired`);
    if (!lockRows[0].acquired) {
      return { skipped: 'another instance holds the retention-sweep lock' };
    }
    try {
      await archiveOldAuditLogs();
      await pruneOldNotifications();
      // Creating the next few days' partitions runs BEFORE the drop, so a sweep
      // that fails partway still leaves somewhere for tomorrow's data to land.
      await ensureUpcomingPartitions();
      // Fold before pruning: a minute row that is past the MINUTE horizon but
      // inside the overall one must end up in the hourly tier, not be deleted.
      await downsampleOldRollups();
      await pruneOldRollups();
      await dropOldRecordPartitions();
      return { ran: true };
    } finally {
      await client.query(`SELECT pg_advisory_unlock(${RETENTION_LOCK_KEY})`);
    }
  } finally {
    client.release();
  }
}

const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000; // once a day

// Called once from server.js after the DB/migrations are ready. Fires an
// initial sweep shortly after boot (delayed, so it never competes with
// startup for DB connections) and then on a fixed daily interval.
function startRetentionSchedule() {
  setTimeout(() => runRetentionSweep().catch((err) => log.error('Initial retention sweep failed', { err })), 60 * 1000);
  setInterval(() => runRetentionSweep().catch((err) => log.error('Scheduled retention sweep failed', { err })), SWEEP_INTERVAL_MS);
}

module.exports = {
  startRetentionSchedule,
  runRetentionSweep,
  archiveOldAuditLogs,
  pruneOldNotifications,
  pruneOldRollups,
  downsampleOldRollups,
  dropOldRecordPartitions,
  ensureUpcomingPartitions,
};
