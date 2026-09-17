-- 0002_audit_retention
-- Adds the archive table + supporting indexes that server/retention.js needs
-- to age old audit_logs rows out of the hot table instead of letting it grow
-- forever. See server/retention.js for the policy (retention is OFF/keep-
-- everything by default — this migration only adds the *capability*).

-- +migrate Up

-- Same shape as audit_logs. Rows land here (instead of being deleted
-- outright) when AUDIT_LOG_RETENTION_DAYS is set — see server/retention.js.
-- Kept as a plain table (not partitioned) for now: partitioning audit_logs
-- itself by month would be the next step if this table's own volume ever
-- becomes a problem, but a plain indexed table is the right amount of
-- complexity for "long-term cold storage that's still queryable if needed."
CREATE TABLE IF NOT EXISTS audit_logs_archive (
  id BIGINT PRIMARY KEY,
  event_id TEXT NOT NULL,
  organisation TEXT NOT NULL,
  user_id INTEGER,
  username TEXT,
  role TEXT,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  entity_name TEXT,
  project_name TEXT,
  details TEXT,
  api_name TEXT,
  environment TEXT,
  ip_address TEXT,
  user_agent TEXT,
  request_id TEXT,
  result TEXT NOT NULL DEFAULT 'success',
  severity TEXT NOT NULL DEFAULT 'info',
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_archive_org_created ON audit_logs_archive (organisation, created_at DESC);

-- Needed for the retention sweep's WHERE created_at < ... scan on
-- notifications — the existing indexes on this table are both
-- (user_id, created_at), which don't help a table-wide age scan.
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications (created_at);

-- +migrate Down
DROP INDEX IF EXISTS idx_notifications_created_at;
DROP TABLE IF EXISTS audit_logs_archive;
