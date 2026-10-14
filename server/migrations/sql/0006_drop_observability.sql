-- 0006_drop_observability
-- Removes the observability/alerting/auto-discovery stack in its entirety
-- (Cluster D of the "remove Live Mode / multi-env / release pipeline /
-- observability" project). Drops the time-series tables that backed the
-- Observability console (endpoint_metrics_rollup[_hourly],
-- endpoint_log_records + its daily partitions), the agent heartbeat table,
-- the alerting tables (alert_rule, alert_state, and alert_incident from
-- 0003_alert_incident_history.sql — that migration file itself is left
-- untouched as historical record), and the three org_workspace columns that
-- existed only to support this stack.

-- +migrate Up

-- endpoint_log_records' daily partitions must be dropped before the parent
-- (DROP TABLE on the parent cascades to partitions anyway, but naming them
-- explicitly here documents what existed and avoids relying on cascade
-- behavior from a dynamic/unknown set of partition names).
DO $$
DECLARE
  part RECORD;
BEGIN
  FOR part IN
    SELECT c.relname AS name
    FROM pg_class c
    JOIN pg_inherits i ON i.inhrelid = c.oid
    JOIN pg_class parent ON parent.oid = i.inhparent
    WHERE parent.relname = 'endpoint_log_records'
  LOOP
    EXECUTE format('DROP TABLE IF EXISTS %I', part.name);
  END LOOP;
END $$;

DROP TABLE IF EXISTS endpoint_log_records;
DROP TABLE IF EXISTS endpoint_metrics_rollup_hourly;
DROP TABLE IF EXISTS endpoint_metrics_rollup;
DROP TABLE IF EXISTS agent_heartbeat;
DROP TABLE IF EXISTS alert_incident;
DROP TABLE IF EXISTS alert_state;
DROP TABLE IF EXISTS alert_rule;
DROP FUNCTION IF EXISTS jsonb_counter_merge(jsonb, jsonb);

ALTER TABLE org_workspace DROP COLUMN IF EXISTS alert_settings;
ALTER TABLE org_workspace DROP COLUMN IF EXISTS endpoint_metrics_enc;
ALTER TABLE org_workspace DROP COLUMN IF EXISTS endpoint_metrics_key_version;

-- +migrate Down
-- Best-effort only: re-creates empty shells with the pre-removal column
-- shapes (copied from server/db.js's pre-edit initDb() / from
-- 0003_alert_incident_history.sql for alert_incident's shape). No data can
-- be recovered — the Up side dropped it along with the tables.

ALTER TABLE org_workspace ADD COLUMN IF NOT EXISTS alert_settings JSONB NOT NULL DEFAULT '{}';
ALTER TABLE org_workspace ADD COLUMN IF NOT EXISTS endpoint_metrics_enc TEXT;
ALTER TABLE org_workspace ADD COLUMN IF NOT EXISTS endpoint_metrics_key_version INTEGER;

CREATE OR REPLACE FUNCTION jsonb_counter_merge(a jsonb, b jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $fn$
  SELECT coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
  FROM (
    SELECT k, sum(v::numeric) AS v
    FROM (
      SELECT key AS k, value AS v FROM jsonb_each_text(coalesce(a, '{}'::jsonb))
      UNION ALL
      SELECT key AS k, value AS v FROM jsonb_each_text(coalesce(b, '{}'::jsonb))
    ) merged
    GROUP BY k
  ) summed;
$fn$;

CREATE TABLE IF NOT EXISTS alert_rule (
  id BIGSERIAL PRIMARY KEY,
  organisation TEXT NOT NULL,
  name TEXT NOT NULL,
  metric TEXT NOT NULL,
  comparison TEXT NOT NULL DEFAULT 'above',
  threshold DOUBLE PRECISION NOT NULL,
  window_minutes INTEGER NOT NULL DEFAULT 10,
  min_requests INTEGER NOT NULL DEFAULT 20,
  for_minutes INTEGER NOT NULL DEFAULT 5,
  cooldown_minutes INTEGER NOT NULL DEFAULT 60,
  severity TEXT NOT NULL DEFAULT 'warning',
  environment TEXT,
  scope TEXT NOT NULL DEFAULT 'environment',
  endpoint_id TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  notify_admins BOOLEAN NOT NULL DEFAULT true,
  notify_user_ids JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_alert_rule_org ON alert_rule (organisation) WHERE enabled;

CREATE TABLE IF NOT EXISTS alert_state (
  rule_id BIGINT NOT NULL REFERENCES alert_rule(id) ON DELETE CASCADE,
  organisation TEXT NOT NULL,
  environment TEXT NOT NULL,
  endpoint_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ok',
  breached_since TIMESTAMPTZ,
  firing_since TIMESTAMPTZ,
  last_value DOUBLE PRECISION,
  last_sample INTEGER,
  last_notified_at TIMESTAMPTZ,
  notify_count INTEGER NOT NULL DEFAULT 0,
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (rule_id, environment, endpoint_id)
);
CREATE INDEX IF NOT EXISTS idx_alert_state_firing ON alert_state (organisation, status) WHERE status <> 'ok';

CREATE TABLE IF NOT EXISTS alert_incident (
  id BIGSERIAL PRIMARY KEY,
  organisation TEXT NOT NULL,
  rule_id BIGINT NOT NULL,
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

CREATE TABLE IF NOT EXISTS agent_heartbeat (
  organisation  TEXT NOT NULL,
  environment   TEXT NOT NULL,
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation, environment)
);

CREATE TABLE IF NOT EXISTS endpoint_metrics_rollup (
  organisation   TEXT NOT NULL,
  environment    TEXT NOT NULL,
  endpoint_id    TEXT NOT NULL,
  bucket_start   TIMESTAMPTZ NOT NULL,
  request_count  INTEGER NOT NULL DEFAULT 0,
  status_2xx     INTEGER NOT NULL DEFAULT 0,
  status_3xx     INTEGER NOT NULL DEFAULT 0,
  status_4xx     INTEGER NOT NULL DEFAULT 0,
  status_5xx     INTEGER NOT NULL DEFAULT 0,
  status_unknown INTEGER NOT NULL DEFAULT 0,
  latency_sum    BIGINT  NOT NULL DEFAULT 0,
  latency_count  INTEGER NOT NULL DEFAULT 0,
  latency_min    INTEGER,
  latency_max    INTEGER,
  latency_buckets JSONB NOT NULL DEFAULT '{}',
  source_ips     JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY (organisation, environment, endpoint_id, bucket_start)
);
CREATE INDEX IF NOT EXISTS idx_rollup_org_env_bucket ON endpoint_metrics_rollup (organisation, environment, bucket_start DESC);
CREATE INDEX IF NOT EXISTS idx_rollup_org_bucket ON endpoint_metrics_rollup (organisation, bucket_start DESC);

CREATE TABLE IF NOT EXISTS endpoint_metrics_rollup_hourly (
  organisation   TEXT NOT NULL,
  environment    TEXT NOT NULL,
  endpoint_id    TEXT NOT NULL,
  bucket_start   TIMESTAMPTZ NOT NULL,
  request_count  INTEGER NOT NULL DEFAULT 0,
  status_2xx     INTEGER NOT NULL DEFAULT 0,
  status_3xx     INTEGER NOT NULL DEFAULT 0,
  status_4xx     INTEGER NOT NULL DEFAULT 0,
  status_5xx     INTEGER NOT NULL DEFAULT 0,
  status_unknown INTEGER NOT NULL DEFAULT 0,
  latency_sum    BIGINT  NOT NULL DEFAULT 0,
  latency_count  INTEGER NOT NULL DEFAULT 0,
  latency_min    INTEGER,
  latency_max    INTEGER,
  latency_buckets JSONB NOT NULL DEFAULT '{}',
  source_ips     JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY (organisation, environment, endpoint_id, bucket_start)
);
CREATE INDEX IF NOT EXISTS idx_rollup_hourly_org_env_bucket ON endpoint_metrics_rollup_hourly (organisation, environment, bucket_start DESC);
CREATE INDEX IF NOT EXISTS idx_rollup_hourly_org_bucket ON endpoint_metrics_rollup_hourly (organisation, bucket_start DESC);

-- No partitions re-created on the way down — an empty parent with no
-- partition covering any range accepts no INSERTs, same as a truly empty
-- shell. Re-provisioning partitions is ensureLogRecordPartitions()'s job,
-- and that function no longer exists post-removal.
CREATE TABLE IF NOT EXISTS endpoint_log_records (
  id             BIGSERIAL,
  organisation   TEXT NOT NULL,
  environment    TEXT NOT NULL,
  endpoint_id    TEXT NOT NULL,
  ts             TIMESTAMPTZ NOT NULL,
  status_code    SMALLINT,
  latency_ms     INTEGER,
  client_ip      TEXT,
  correlation_id TEXT,
  flow_name      TEXT,
  fields_enc     TEXT,
  key_version    INTEGER,
  PRIMARY KEY (id, ts)
) PARTITION BY RANGE (ts);
CREATE INDEX IF NOT EXISTS idx_logrec_org_env_ts ON endpoint_log_records (organisation, environment, ts DESC);
CREATE INDEX IF NOT EXISTS idx_logrec_org_corr ON endpoint_log_records (organisation, correlation_id);
CREATE INDEX IF NOT EXISTS idx_logrec_org_endpoint_ts ON endpoint_log_records (organisation, endpoint_id, ts DESC);
