-- 0004_audit_id_index
-- server/routes/audit.js's GET /api/audit/events paginates with
-- `WHERE organisation = $1 [AND id < $before] ORDER BY id DESC LIMIT $n` —
-- a cursor on the numeric id, not on created_at. The existing indexes on
-- audit_logs (see 0001_baseline.sql / server/db.js) cover
-- (organisation, created_at DESC) and (organisation, action), neither of
-- which matches this query's ORDER BY, so it falls back to a sort over
-- every row for that organisation on each page past the first.

-- +migrate Up
CREATE INDEX IF NOT EXISTS idx_audit_logs_org_id ON audit_logs (organisation, id DESC);

-- +migrate Down
DROP INDEX IF EXISTS idx_audit_logs_org_id;
