-- 0008_drop_live_mode_grants
-- Removes the Live Mode real-fire proxy feature in its entirety (Cluster A
-- of the "remove Live Mode / multi-env / release pipeline / observability"
-- project). Drops the two org_workspace columns that backed its grant
-- matrices: live_mode_grants (per-user allow-list of environments a user
-- may fire a REAL outbound request against from Try It) and
-- doc_browse_grants (the separate per-user allow-list of environments a
-- user may merely browse docs for). Both were plain, unencrypted JSONB
-- (no secrets, just environment ids) keyed by user id. The simulated Try
-- It feature (sendTryIt in public/js/studio/18-renderview.js) never read
-- either column and is unaffected.
--
-- Down is best-effort only: re-adds both columns with their original
-- nullable-with-default shape. No grant data can be recovered — the Up
-- side dropped it along with the columns.

-- +migrate Up

ALTER TABLE org_workspace DROP COLUMN IF EXISTS live_mode_grants, DROP COLUMN IF EXISTS doc_browse_grants;

-- +migrate Down

ALTER TABLE org_workspace ADD COLUMN IF NOT EXISTS live_mode_grants JSONB NOT NULL DEFAULT '{}';
ALTER TABLE org_workspace ADD COLUMN IF NOT EXISTS doc_browse_grants JSONB NOT NULL DEFAULT '{}';
