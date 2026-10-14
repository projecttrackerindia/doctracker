-- 0007_drop_release_pipeline
-- Removes the Release Pipeline feature in its entirety (Cluster C of the
-- "remove Live Mode / multi-env / release pipeline / observability"
-- project). Drops the three tables that backed it: project_env_versions
-- (one row per project+environment "currently pinned" snapshot),
-- project_env_version_history (its append-only promotion/rollback/prune
-- log), and project_promotion_requests (the "protected branch" second-
-- approver workflow). `projects.release_version` is left in place — it's
-- still read by GET /projects/:id/snapshot's draft label.
--
-- NOTE: GET /api/workspace/environment-metrics and
-- GET /api/workspace/projects/:id/snapshot (server/routes/workspace.js)
-- still query project_env_versions for now — they were deliberately left
-- untouched in this cluster and will be rewritten to stop depending on
-- per-environment snapshot tables in the later "environment collapse"
-- cluster. Until that lands, running this migration's Up against a
-- database that still has promoted-environment data will make those two
-- routes report empty promoted-stage counts instead of erroring (the
-- queries against the now-missing table return no rows at the app level
-- only if the table still exists with zero rows; if the table itself is
-- dropped, those two routes will fail until the later cluster's rewrite
-- lands — this is a known, accepted intermediate state of the sequenced
-- rollout, not an oversight).

-- +migrate Up

DROP TABLE IF EXISTS project_promotion_requests;
DROP TABLE IF EXISTS project_env_version_history;
DROP TABLE IF EXISTS project_env_versions;

-- +migrate Down
-- Best-effort only: re-creates empty shells with the pre-removal column
-- shapes (copied from server/db.js's pre-edit initDb()). No data can be
-- recovered — the Up side dropped it along with the tables.

CREATE TABLE IF NOT EXISTS project_env_versions (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  data_enc TEXT NOT NULL,
  data_key_version INTEGER NOT NULL,
  source_environment_id TEXT,
  promoted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  promoted_by_username TEXT,
  auto_mirrored BOOLEAN NOT NULL DEFAULT false,
  promoted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, environment_id)
);

CREATE TABLE IF NOT EXISTS project_env_version_history (
  id BIGSERIAL PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  data_enc TEXT NOT NULL,
  data_key_version INTEGER NOT NULL,
  source_environment_id TEXT,
  action TEXT NOT NULL DEFAULT 'promote' CHECK (action IN ('promote', 'rollback', 'prune')),
  rolled_back_from_id BIGINT REFERENCES project_env_version_history(id) ON DELETE SET NULL,
  promoted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  promoted_by_username TEXT,
  auto_mirrored BOOLEAN NOT NULL DEFAULT false,
  promoted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  release_note TEXT,
  breaking_changes JSONB NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_env_version_history_lookup ON project_env_version_history (project_id, environment_id, promoted_at DESC);
CREATE INDEX IF NOT EXISTS idx_env_version_history_project_feed ON project_env_version_history (project_id, promoted_at DESC);

CREATE TABLE IF NOT EXISTS project_promotion_requests (
  id BIGSERIAL PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_environment_id TEXT NOT NULL,
  to_environment_id TEXT NOT NULL,
  diff_hash TEXT NOT NULL,
  diff_snapshot JSONB NOT NULL,
  breaking_changes JSONB NOT NULL DEFAULT '[]',
  ack_breaking_changes BOOLEAN NOT NULL DEFAULT false,
  release_note TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  requested_by_username TEXT,
  decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_by_username TEXT,
  decision_note TEXT,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_promotion_requests_project ON project_promotion_requests (project_id, status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_promotion_request_pending_target
  ON project_promotion_requests (project_id, to_environment_id)
  WHERE status = 'pending';
