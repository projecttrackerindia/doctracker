// Admin-facing view of DocTracker's OWN usage — distinct from the
// Observability console, which is entirely about monitored Mule endpoints
// fed by the external agent. Nothing tracked this app's own activity
// trends before this: audit_logs already records every audit-worthy action
// (endpoint edits, PII reveals, logins, role changes, ...) with a
// success/failure result per event, so this aggregates that rather than
// adding a second, separate tracking mechanism.
//
// Deliberately NOT "HTTP request volume/error rate" — audit_logs records
// audit-worthy actions, not every request, and this endpoint doesn't
// overstate what it's measuring. See ALERTING.md/README.md's "Known gaps"
// conventions: name what's actually tracked, not what would be nice to.
const express = require('express');
const { pool } = require('../db');
const { authenticate, requireAdmin } = require('../middleware/authGuard');
const { log } = require('../logger');

const router = express.Router();
router.use(authenticate);
router.use(requireAdmin); // everything under /api/admin/analytics is Admin-only

const DEFAULT_DAYS = 30;
const MAX_DAYS = 90; // matches the longest range the Observability console itself offers

// ---- GET /api/admin/analytics/overview?days=30 ----
router.get('/overview', async (req, res) => {
  try {
    const days = Math.max(1, Math.min(MAX_DAYS, parseInt(req.query.days, 10) || DEFAULT_DAYS));
    const organisation = req.authUser.organisation;

    const [totalsResult, dailyResult, actionsResult, usersResult] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE result = 'failure')::int AS failures,
           COUNT(DISTINCT user_id)::int AS active_users
         FROM audit_logs
         WHERE organisation = $1 AND created_at >= now() - ($2 || ' days')::interval`,
        [organisation, days]
      ),
      // date_trunc('day', ...) in UTC, one row per day that actually had
      // events — days with zero events are filled in below rather than
      // asking Postgres to generate them, so this stays one simple query.
      //
      // Formatted to 'YYYY-MM-DD' text IN SQL rather than returned as a
      // timestamp: node-postgres parses a `timestamp without time zone`
      // value (what date_trunc returns) as being in the server's LOCAL
      // zone, not UTC — even though the value was explicitly UTC-normalized
      // by `AT TIME ZONE 'UTC'` above. An event at 2026-09-25T16:42Z on a
      // UTC+5:30 host came back from the driver as `2026-09-24T18:30:00Z`
      // and landed in the wrong day's bucket. A plain text column sidesteps
      // the driver's timestamp parsing entirely.
      pool.query(
        `SELECT
           to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE result = 'failure')::int AS failures
         FROM audit_logs
         WHERE organisation = $1 AND created_at >= now() - ($2 || ' days')::interval
         GROUP BY 1 ORDER BY 1`,
        [organisation, days]
      ),
      pool.query(
        `SELECT action, COUNT(*)::int AS total
         FROM audit_logs
         WHERE organisation = $1 AND created_at >= now() - ($2 || ' days')::interval
         GROUP BY action ORDER BY total DESC LIMIT 10`,
        [organisation, days]
      ),
      pool.query(
        `SELECT username, COUNT(*)::int AS total
         FROM audit_logs
         WHERE organisation = $1 AND created_at >= now() - ($2 || ' days')::interval
           AND username IS NOT NULL
         GROUP BY username ORDER BY total DESC LIMIT 10`,
        [organisation, days]
      ),
    ]);

    const totals = totalsResult.rows[0] || { total: 0, failures: 0, active_users: 0 };

    // Fill in zero-event days so the chart doesn't silently skip gaps —
    // built from `days` rather than the query's own MIN/MAX so a
    // just-created org with zero history still gets a full, honest range.
    const byDay = new Map(
      dailyResult.rows.map((r) => [r.day, { total: r.total, failures: r.failures }])
    );
    const dailySeries = [];
    for (let i = days - 1; i >= 0; i -= 1) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const row = byDay.get(d) || { total: 0, failures: 0 };
      dailySeries.push({ date: d, total: row.total, failures: row.failures });
    }

    res.json({
      rangeDays: days,
      totalEvents: totals.total,
      failureRate: totals.total ? totals.failures / totals.total : 0,
      activeUsers: totals.active_users,
      dailySeries,
      topActions: actionsResult.rows.map((r) => ({ action: r.action, count: r.total })),
      topUsers: usersResult.rows.map((r) => ({ username: r.username, count: r.total })),
    });
  } catch (err) {
    log.error('GET /api/admin/analytics/overview failed', { requestId: req.id, err });
    res.status(500).json({ error: 'Could not load usage analytics.' });
  }
});

module.exports = router;
