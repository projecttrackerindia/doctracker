-- 0009_collapse_environments
-- Collapses multi-environment support down to a single implicit "default"
-- environment (Cluster B, the last and riskiest cluster of the "remove Live
-- Mode / multi-env / release pipeline / observability" project). Environments
-- are not a dedicated table in this schema — they're JSONB/column-based —
-- so this is a data transform across several JSONB columns, not pure DDL.
--
-- INFERRED SHAPE (no live/scratch DB was available to run a live SELECT
-- against, per the removal plan's constraint — this was inferred by reading
-- the code that constructs/reads these columns):
--   * org_workspace.environments / environments_enc — an array of objects
--     shaped { id, label, color, access, restricted, url, hostIps }, e.g.
--     DEFAULT_ENVIRONMENTS in public/js/studio/03-notifications.js:
--       { id:'DEV', label:'Dev', color:'#ef5c6e', restricted:false,
--         access:'admin', url:'https://dev.example.com' }
--     — constructed by addEnvironment()/updateEnvironment() in that same
--     file. There is NO isDefault/primary/isProd boolean field anywhere in
--     this shape (confirmed by reading every place an environment object is
--     built or patched) — `restricted`/`access` describe who may use an
--     environment, not which one is "the" default. The decision rule below
--     therefore always falls through to "the array's own first entry"
--     (`environments[0]`), per the removal plan's own fallback rule.
--   * project_access.environments — JSONB array of environment ids, or the
--     literal ['*'] wildcard ("every environment this grant covers").
--   * pii_field_rules.environments — JSONB array of environment-name
--     strings (its own column default is
--     '["PROD","PREPROD","UAT","SIT","DEV"]' — see server/db.js).
--   * doc_access_requests.environment_id / environment_label — nullable
--     TEXT columns, a single environment per request row (not an array).
--
-- WHAT THIS MIGRATION DOES, AND WHAT IT PUNTS TO APPLICATION CODE:
--   * org_workspace.environments (the PLAINTEXT legacy column only) is
--     rewritten below to a single-element array holding whichever entry the
--     decision rule keeps, relabeled to the fixed synthetic
--     { id: 'default', label: 'Default' }, with that entry's other fields
--     (color/access/restricted/url/hostIps) preserved.
--   * org_workspace.environments_enc is DELIBERATELY NOT touched here. It is
--     ciphertext, encrypted per-organisation with a DEK this plain-SQL
--     migration has no way to unwrap (see server/crypto.js) — a SQL UPDATE
--     cannot transform data it cannot decrypt. Any organisation whose
--     catalog was already encrypted (environments_enc IS NOT NULL) keeps
--     decrypting to its pre-collapse, possibly-multi-environment shape
--     until application code collapses it. That collapse is self-healing
--     and automatic: server/routes/workspace.js's getOrgEnvironments() now
--     collapses whatever it decrypts down to the one kept entry (same
--     decision rule as below) and writes the result straight back,
--     re-encrypted, the first time anything reads an org's environments
--     after this migration runs. No organisation is left permanently
--     multi-environment; it just finishes lazily instead of in this file.
--   * project_access.environments — plain JSONB, not encrypted, so this IS
--     handled here: collapsed to '["*"]' for every row (now meaning "the
--     only environment there is" rather than "every environment of
--     several"). See server/projectAccess.js for the corresponding code
--     change (grants are project-wide only from here on).
--   * pii_field_rules.environments — plain JSONB, not encrypted, collapsed
--     here to '["default"]' for every row.
--   * Endpoint-level per-environment config (the base URL a project has on
--     file for each environment, e.g. proj.environments[envId] as read by
--     public/js/studio/13-endpoint-table.js and 07-codesamples.js) lives
--     inside `projects.data_enc` — ciphertext, AND arbitrary nested JSON
--     inside one blob column, not a shape a generic SQL UPDATE could safely
--     rewrite even if it could decrypt it. That collapse happens in
--     application code instead: client-side, migrateProject()/
--     migrateEndpoint() in public/js/studio/06-spec-parse.js already upgrade
--     old localStorage/draft shapes on load and now apply this same
--     decision rule when they encounter a multi-environment `environments`
--     map; server-side, nothing needs to rewrite projects.data_enc at all,
--     because envIds() (what every per-environment loop now iterates over)
--     itself returns only the one collapsed id going forward, so a stale
--     multi-key map simply has its extra keys ignored rather than needing
--     to be physically rewritten.
--   * doc_access_requests.environment_id / environment_label — left
--     completely untouched by this migration, per the removal plan: existing
--     rows are a historical audit trail (nullable, already treated as
--     "applies to every environment" when NULL — see getDocAccessMap in
--     server/routes/workspace.js). server/routes/docAccess.js simply stops
--     writing these two columns on new requests going forward.
--
-- server/migrations/runner.js only supports plain SQL Up/Down files (no
-- JS-migration mechanism exists in this codebase, and this project doesn't
-- invent one) — confirmed by reading runner.js before writing this file.
-- That is exactly why the encrypted-column and projects.data_enc halves of
-- this collapse are handled in application code instead of here: there is
-- no SQL-only way to decrypt per-org/per-project ciphertext, and inventing a
-- one-off JS migration path solely for this would be exactly the kind of
-- mechanism the removal plan said not to invent.
--
-- Down is explicitly best-effort/lossy, same convention as 0006/0007/0008:
-- it cannot un-collapse discarded environments (their ids/labels/colors/
-- urls/host IPs are gone the moment the Up side below runs), and it cannot
-- touch ciphertext at all in either direction. Down only restores the
-- shape of project_access.environments and pii_field_rules.environments
-- rows to arrays (impossible to say what they held before collapse, so it
-- leaves them as-is — those two columns are not reshaped, only their VALUES
-- were overwritten by Up, and Down has no better value to put back).

-- +migrate Up

-- org_workspace.environments (plaintext legacy column only — see note
-- above on why environments_enc can't be touched here). Keeps the entry
-- flagged default/primary/prod if the row's own data ever has one (it
-- won't, under the inferred shape, but the check costs nothing and makes
-- the rule self-documenting), else the array's first entry, else falls
-- back to an empty default object so a row with no environments at all
-- still ends up with exactly one.
UPDATE org_workspace
SET environments = jsonb_build_array(
  (
    COALESCE(
      (SELECT e FROM jsonb_array_elements(environments) e
        WHERE (e->>'isDefault')::boolean IS TRUE
           OR (e->>'isProd')::boolean IS TRUE
           OR (e->>'primary')::boolean IS TRUE
        LIMIT 1),
      environments -> 0,
      '{}'::jsonb
    ) - 'id' - 'label'
  ) || jsonb_build_object('id', 'default', 'label', 'Default')
)
WHERE (jsonb_typeof(environments) = 'array' AND jsonb_array_length(environments) <> 1)
   OR (jsonb_typeof(environments) = 'array' AND jsonb_array_length(environments) = 1
       AND environments -> 0 ->> 'id' IS DISTINCT FROM 'default');

-- project_access.environments: every grant now covers "the only environment
-- there is" — see server/projectAccess.js (grants are project-wide only).
UPDATE project_access SET environments = '["*"]'::jsonb;

-- pii_field_rules.environments: every masking rule now applies to the one
-- environment.
UPDATE pii_field_rules SET environments = '["default"]'::jsonb;

-- doc_access_requests.environment_id / environment_label: deliberately NOT
-- touched — historical audit trail, nullable, already read as "every
-- environment" when NULL.

-- +migrate Down
-- Best-effort only, same as 0006/0007/0008's Down sides: the Up side above
-- is a destructive data transform, not a reversible schema change. There is
-- no way to recover which other environments an org_workspace row used to
-- list, what colors/URLs/access levels/host IPs they had, or which specific
-- environments a project_access/pii_field_rules row used to be scoped to —
-- that information was overwritten, not archived. This Down is a no-op:
-- rolling back only means "stop collapsing on the next deploy," not
-- "restore what collapse discarded." (There is also nothing to restore
-- shape-wise — no column types or constraints changed in the Up side above,
-- only JSONB values.)
SELECT 1;
