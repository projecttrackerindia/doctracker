-- 0003_alert_incident_history
-- Adds a durable record of "what fired, when, and for how long" for alerts.
-- alert_state (in the baseline) only ever holds CURRENT state — one row per
-- (rule, environment, endpoint), overwritten in place on every evaluation —
-- so there was no way to answer "what fired last week" once an incident
-- resolved. See ALERTING.md's "Known limits" (now closed by this).

-- +migrate Up

CREATE TABLE IF NOT EXISTS alert_incident (
  id BIGSERIAL PRIMARY KEY,
  organisation TEXT NOT NULL,
  rule_id BIGINT NOT NULL,
  -- Snapshot, not a live join to alert_rule: a rule can be edited or deleted
  -- after an incident closes, and the history should still read the way it
  -- did at the time, not silently reflect a rule that no longer exists.
  rule_name TEXT NOT NULL,
  metric TEXT NOT NULL,
  severity TEXT NOT NULL,
  environment TEXT NOT NULL,
  endpoint_id TEXT NOT NULL DEFAULT '',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  last_value DOUBLE PRECISION,
  last_sample INTEGER,
  notify_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_alert_incident_org_started ON alert_incident (organisation, started_at DESC);

-- +migrate Down
DROP INDEX IF EXISTS idx_alert_incident_org_started;
DROP TABLE IF EXISTS alert_incident;
