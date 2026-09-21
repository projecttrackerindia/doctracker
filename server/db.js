const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Add a Postgres database and set this env var.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  // Was unset before (pg's default is 10). At higher concurrency — several
  // Node instances each wanting their own pool — 10 per instance adds up
  // fast on Postgres's own connection ceiling. Put a connection pooler
  // (PgBouncer, in transaction mode) in front of Postgres when running more
  // than one instance, and size this per-instance pool to what the pooler
  // expects, not to Postgres's raw max_connections. See DB_POOL_MAX in the
  // Railway deployment notes.
  max: parseInt(process.env.DB_POOL_MAX || '10', 10),
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      organisation TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer', 'custom')),
      custom_permissions JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_login_at TIMESTAMPTZ
    );
  `);

  // Migration path for databases created before the 'custom' role existed —
  // adds the column and widens the CHECK constraint without touching data.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_permissions JSONB;`);
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check') THEN
        ALTER TABLE users DROP CONSTRAINT users_role_check;
      END IF;
      ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'editor', 'viewer', 'custom'));
    END $$;
  `);

  // Session revocation counter. Embedded in every JWT as `tokenVersion` and
  // checked against this column on every authenticated request (see
  // middleware/authGuard.js). Bumping it (role change, password reset, or a
  // future "sign out everywhere") instantly invalidates every session token
  // already issued for that user, even though JWTs themselves are stateless
  // and would otherwise keep working, unmodified, until their 7-day expiry.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 1;`);

  // Optional time-and-day access window an Admin can attach to any account
  // (any role). Shape: { enabled, days: [0-6], startTime: 'HH:MM', endTime: 'HH:MM' }.
  // Evaluated fresh on every request in middleware/authGuard.js (see
  // server/accessSchedule.js) — never trusted from a stale JWT, same reasoning
  // as token_version above. Applies regardless of role; Admins are exempted
  // from enforcement in the middleware itself so an org can never lock out
  // every admin at once.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS access_schedule JSONB;`);

  // Sliding idle-timeout tracker. Set on login and touched (throttled — see
  // IDLE_TOUCH_THROTTLE_MS in middleware/authGuard.js) on every authenticated
  // request/page load. verifySession() compares "now" against this column on
  // every call and treats the session as expired once it's been untouched for
  // longer than IDLE_TIMEOUT_MS, independent of the JWT's own 7-day expiry.
  // This is deliberately a DB column, not something read off the JWT: the
  // token is static once signed, so only a server-side, continuously-updated
  // value can implement "log out after N minutes of *inactivity*" rather than
  // "log out N minutes after login" or "log out on the browser's own timer,"
  // either of which a client could just... not enforce.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ;`);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_users_email ON users (LOWER(email));
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_users_username ON users (LOWER(username));
  `);

  // ---- Workspace persistence (projects/endpoints/attachments) ----
  // Replaces the old client-only localStorage workspace. Each project is one
  // row; `data` holds the full nested project object (endpoints[], attachments[],
  // etc.) exactly as the frontend already shapes it — endpoints and attachments
  // are NOT split into their own tables, they stay nested inside `data`.
  // `visibility` on the row is the project's own container-level flag; each
  // endpoint inside `data.endpoints[]` carries its own `visibility` field too
  // (see workspace.js for how the two combine to decide what a non-owner sees).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      organisation TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
      name TEXT NOT NULL,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_projects_org ON projects (organisation);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects (owner_id);`);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_projects_org_public ON projects (organisation) WHERE visibility = 'public';
  `);

  // Denormalized flag, kept in sync on every write (see workspace.js), so
  // GET /api/workspace can filter out other people's fully-private projects
  // in SQL instead of fetching + decrypting every project in the
  // organisation just to throw most of them away afterwards.
  await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS has_public_endpoint BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_projects_org_visible ON projects (organisation)
      WHERE visibility = 'public' OR has_public_endpoint;
  `);

  // Shared, organisation-wide workspace extras that previously lived in their
  // own separate localStorage keys (environments, try-it request history,
  // custom flow-direction presets). One row per organisation.
  //
  // NOTE on `audit_log`: this JSONB column is DEPRECATED. It used to hold the
  // entire audit history as a single blob that the *frontend* overwrote wholesale
  // on every change — which meant a browser could forge actor names, timestamps,
  // or delete history outright, since nothing server-side ever verified it.
  // Audit events now live in the proper `audit_logs` table below, written only
  // by the server from the authenticated session (see server/auditService.js).
  // The column is kept only so any already-migrated data isn't silently dropped;
  // nothing reads or writes it any more.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_workspace (
      organisation TEXT PRIMARY KEY,
      environments JSONB NOT NULL DEFAULT '[]',
      audit_log JSONB NOT NULL DEFAULT '[]',
      request_history JSONB NOT NULL DEFAULT '{}',
      custom_flow_directions JSONB NOT NULL DEFAULT '[]',
      custom_icons JSONB NOT NULL DEFAULT '[]',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Custom icon/logo library (Architecture Studio ▸ "+ Custom icon") — an
  // org can drop in their own logos (e.g. their actual MuleSoft/vendor
  // artwork under their own license) and reuse them across every project's
  // diagram. Added via ALTER too, since org_workspace rows already exist in
  // deployed databases and CREATE TABLE IF NOT EXISTS won't touch them.
  await pool.query(`ALTER TABLE org_workspace ADD COLUMN IF NOT EXISTS custom_icons JSONB NOT NULL DEFAULT '[]';`);

  // Organisation letterhead branding — a logo + display label shown on every
  // page of a PDF export (see public/js/studio/20-export-pdf.js) and set once
  // from Your Profile ▸ Organisation branding (Admin-only). A logo isn't a
  // secret, so this is plaintext JSONB, same pattern as custom_icons above —
  // and added via ALTER for the same reason: org_workspace rows already exist
  // in deployed databases, so a fresh CREATE TABLE IF NOT EXISTS won't touch
  // them. Persists in Postgres, so it survives restarts/redeploys — never
  // stored only in the browser or on local disk.
  await pool.query(`ALTER TABLE org_workspace ADD COLUMN IF NOT EXISTS branding JSONB NOT NULL DEFAULT '{}';`);

  // Org-wide PII masking settings (Admin ▸ Security ▸ PII & Data Masking).
  // Kept separate from the per-rule table below since it's a single JSON blob
  // of switches, not a list of records.
  await pool.query(`
    ALTER TABLE org_workspace ADD COLUMN IF NOT EXISTS pii_settings JSONB NOT NULL DEFAULT '{
      "automaticProtection": true,
      "revealTimeoutSeconds": 60,
      "environmentPolicy": {"PROD":"strict","PREPROD":"strict","UAT":"mask","SIT":"mask","DEV":"configurable"},
      "surfaces": {"params":true,"headers":true,"body":true,"pdfExport":true}
    }'::jsonb;
  `);

  // ---- Live Mode (Try It → real outbound calls) ----
  // Per-user allow-list of environment ids that user may fire a REAL request
  // against from Try It, managed entirely by an Admin (Security ▸ Live Mode
  // Access) — deliberately independent of role, so an Admin can grant a
  // Viewer access to DEV without touching their role, or withhold PROD from
  // an Editor. Shape: { "<userId>": ["DEV","SIT"], ... }. Org-wide (like
  // pii_settings above) rather than per-project, since the grant is about how
  // much real-world blast radius a *person* is trusted with, not which
  // project they happen to be looking at. See server/routes/liveMode.js.
  await pool.query(`ALTER TABLE org_workspace ADD COLUMN IF NOT EXISTS live_mode_grants JSONB NOT NULL DEFAULT '{}';`);

  // ---- Admin-managed sensitive-field masking rules (Admin ▸ Security ▸ PII & Data Masking) ----
  // Every request/response parameter table consults this list (merged with the
  // client's built-in field/pattern detectors) before ever rendering an example
  // value — see displayValueFor()/piiRuleForField() in studio.html.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pii_field_rules (
      id BIGSERIAL PRIMARY KEY,
      organisation TEXT NOT NULL,
      field_name TEXT NOT NULL,
      match_mode TEXT NOT NULL DEFAULT 'case_insensitive'
        CHECK (match_mode IN ('exact', 'case_insensitive', 'nested', 'regex')),
      category TEXT NOT NULL DEFAULT 'PII'
        CHECK (category IN ('PUBLIC','INTERNAL','CONFIDENTIAL','PII','SENSITIVE_PII','FINANCIAL','AUTHENTICATION_SECRET')),
      masking_strategy TEXT NOT NULL DEFAULT 'partial'
        CHECK (masking_strategy IN ('full','last2','last4','first2last2','email','secret','partial')),
      chars_to_keep INTEGER NOT NULL DEFAULT 4,
      mask_char TEXT NOT NULL DEFAULT '*',
      apply_to JSONB NOT NULL DEFAULT '["params","headers","body","pdfExport"]',
      environments JSONB NOT NULL DEFAULT '["PROD","PREPROD","UAT","SIT","DEV"]',
      enabled BOOLEAN NOT NULL DEFAULT true,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_pii_rules_org ON pii_field_rules (organisation);`);

  // ---- Authoritative, append-only audit log (Security ▸ Audit Logs) ----
  // Every column here is derived server-side from the authenticated session/
  // request (see recordAuditEvent in server/auditService.js) — the frontend
  // only ever supplies the descriptive fields (action, entityName, details,
  // metadata, ...), never identity or timestamps. Never store raw sensitive
  // values in `metadata` — only field names, reasons, and other non-sensitive
  // descriptors.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id BIGSERIAL PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE,
      organisation TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
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
      result TEXT NOT NULL DEFAULT 'success' CHECK (result IN ('success','failure')),
      severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','critical')),
      metadata JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_org_created ON audit_logs (organisation, created_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_org_action ON audit_logs (organisation, action);`);

  // ---- Envelope-encryption key registry ----
  // Each row is one Data Encryption Key (DEK), itself encrypted ("wrapped")
  // with the MASTER_KEY env var — the DEK plaintext never touches disk. Admins
  // can rotate (create a new active DEK) instantly, from the app, with no
  // redeploy; old versions are kept forever (deactivated) so previously
  // encrypted rows stay decryptable. See server/crypto.js.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS encryption_keys (
      version INTEGER PRIMARY KEY,
      wrapped_dek TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reason TEXT
    );
  `);
  // Enforces "at most one active key at a time" at the DB level.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_encryption_keys_one_active ON encryption_keys (active) WHERE active;
  `);

  // ---- Encrypted-at-rest columns ----
  // `data`/`environments`/`request_history` above stay in place (JSONB) for
  // backward compatibility with rows written before encryption existed, but
  // are no longer where real content lives going forward — new/updated rows
  // write ciphertext into these TEXT sibling columns instead (see
  // server/crypto.js + server/routes/workspace.js). `*_key_version` records
  // which DEK protects each row so encryption_keys never has to be scanned to
  // find out, and so a row keeps decrypting correctly across key rotations.
  await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS data_enc TEXT;`);
  await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS data_key_version INTEGER;`);
  await pool.query(`ALTER TABLE org_workspace ADD COLUMN IF NOT EXISTS environments_enc TEXT;`);
  await pool.query(`ALTER TABLE org_workspace ADD COLUMN IF NOT EXISTS environments_key_version INTEGER;`);
  await pool.query(`ALTER TABLE org_workspace ADD COLUMN IF NOT EXISTS request_history_enc TEXT;`);
  await pool.query(`ALTER TABLE org_workspace ADD COLUMN IF NOT EXISTS request_history_key_version INTEGER;`);
  // Try It collection variables + saved requests (Postman-style) — same
  // sensitivity class as request_history (can hold a real bearer token in a
  // variable value), so encrypted at rest the same way, org-shared.
  await pool.query(`ALTER TABLE org_workspace ADD COLUMN IF NOT EXISTS tryit_collections_enc TEXT;`);
  await pool.query(`ALTER TABLE org_workspace ADD COLUMN IF NOT EXISTS tryit_collections_key_version INTEGER;`);

  // ---- Environment release pipeline ----
  // `release_version` is the project-wide "cut number" (displayed as 1.0.N) —
  // it increments once each time a new draft is promoted out of the first
  // (Dev) stage. Moving that same release further down the pipeline
  // (SIT -> UAT -> Staging -> Production) carries the version forward
  // unchanged, same as a real release moving through environments.
  await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS release_version INTEGER NOT NULL DEFAULT 0;`);

  // One row per (project, environment) = the environment's CURRENTLY pinned
  // snapshot — overwritten on each promotion, not an unbounded history table.
  // environment_id is a free-text org-configured id (see org_workspace.environments),
  // not a foreign key, since environments live in that JSONB list rather than
  // a normalized table. Encrypted the same way as projects.data — see
  // server/crypto.js and the encrypt/decryptProjectData helpers in
  // server/routes/workspace.js.
  await pool.query(`
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
  `);

  // ---- Per-project, per-environment sharing grants ----
  // Fills the gap between `projects.visibility` ('private' = owner only,
  // 'public' = entire organisation) and the org-wide `live_mode_grants`
  // above: this is how an owner (or Admin) shares ONE private project with a
  // NAMED person, optionally restricted to specific environments, without
  // touching that person's global role or exposing the project to the whole
  // organisation. One row per (project, user) — not per (project, user,
  // environment) — so an access check is a single indexed lookup regardless
  // of how many environments a project has; `environments` holds the scoped
  // list (or the literal ["*"] wildcard for "every environment this project
  // has"), same JSONB-list pattern already used by `custom_permissions.envs`
  // and `pii_field_rules.environments`. Deliberately independent of role,
  // same reasoning as live_mode_grants: an Admin can hand a Viewer edit
  // access to one specific project without promoting them org-wide.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_access (
      id BIGSERIAL PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      environments JSONB NOT NULL DEFAULT '[]',
      permission TEXT NOT NULL DEFAULT 'view' CHECK (permission IN ('view', 'edit')),
      granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (project_id, user_id)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_project_access_user ON project_access (user_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_project_access_project ON project_access (project_id);`);

  // ---- Per-endpoint, time-boxed documentation access requests ----
  // Distinct from project_access above: project_access is a deliberate,
  // owner/Admin-initiated share of an entire private project with a named
  // person. This table is the self-service side of the org-wide PUBLIC
  // catalog instead — a Viewer (or a 'custom' role without edit rights) can
  // already see that a public project and its endpoints exist, but the full
  // documentation of any ONE endpoint stays locked until they ask for, and
  // an Admin approves, a time-boxed window. See getDocAccessMap/applyDocLock
  // in workspace.js (enforcement — GET /api/workspace redacts locked
  // endpoints server-side, it doesn't just hide them in the UI) and
  // server/routes/docAccess.js (the request/approve/deny/revoke API).
  // Full history is kept rather than deleted, so approvals/denials/
  // revocations stay auditable. Whether a grant is CURRENTLY active is
  // always derived at read time from status + the date range (see the
  // is_active computed column in every query against this table) rather
  // than a separately-maintained boolean — nothing to keep in sync, and no
  // expiry job ever needs to run.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS doc_access_requests (
      id BIGSERIAL PRIMARY KEY,
      organisation TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      endpoint_id TEXT NOT NULL,
      endpoint_label TEXT NOT NULL,
      requested_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      requested_by_username TEXT NOT NULL,
      reason TEXT,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'revoked')),
      decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      decided_by_username TEXT,
      decided_at TIMESTAMPTZ,
      decision_note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // environment_id/environment_label: which single pipeline stage (Dev/SIT/UAT/...)
  // this request's grant applies to. Nullable for backward compatibility —
  // rows written before this column existed have no environment recorded, and
  // are treated as "every environment" everywhere they're read (see
  // getDocAccessMap in workspace.js) so upgrading this app doesn't silently
  // revoke access anyone already had approved.
  await pool.query(`ALTER TABLE doc_access_requests ADD COLUMN IF NOT EXISTS environment_id TEXT;`);
  await pool.query(`ALTER TABLE doc_access_requests ADD COLUMN IF NOT EXISTS environment_label TEXT;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_doc_access_org_status ON doc_access_requests (organisation, status);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_doc_access_user_endpoint ON doc_access_requests (requested_by, project_id, endpoint_id, environment_id);`);
  // The "already have a pending request?" check in docAccess.js's POST
  // /requests is check-then-insert, not atomic — two rapid clicks, two open
  // tabs, or a retried request can both pass the check before either
  // commits, leaving two pending rows for the same person/endpoint/
  // environment. This partial unique index is the real guard; the app-level
  // check just avoids hitting it in the common case. Scoped to
  // status='pending' (not all rows) because the approved/denied/revoked
  // history for the same scope is expected and fine — only two
  // simultaneously-open asks for the same thing are not. environment_id
  // is part of the key so a NULL (pre-migration legacy row, "every
  // environment") never collides with a real per-environment row — Postgres
  // treats NULLs as distinct from each other in a unique index, which is
  // the right behavior here since new requests always populate environment_id.
  //
  // Wrapped in try/catch rather than left to fail initDb outright: if an
  // organisation already has duplicate pending rows from before this
  // constraint existed (exactly the bug this is fixing), creating the index
  // errors out — and initDb failing means the whole app refuses to boot
  // (see server.js). Logging instead means the app keeps running with the
  // pre-existing app-level check as the only guard until the duplicates are
  // cleaned up and the app restarted, rather than an old data problem
  // becoming a new outage.
  try {
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_doc_access_pending_per_scope
      ON doc_access_requests (project_id, endpoint_id, environment_id, requested_by)
      WHERE status = 'pending';
    `);
  } catch (err) {
    console.error(
      'Could not create uq_doc_access_pending_per_scope — this organisation\'s data likely already has ' +
      'duplicate pending doc_access_requests rows. The app will keep running without this DB-level guard ' +
      '(the existing app-level check in POST /requests still applies, just not race-proof). To find and ' +
      'resolve duplicates: SELECT project_id, endpoint_id, environment_id, requested_by, count(*) FROM ' +
      "doc_access_requests WHERE status = 'pending' GROUP BY 1,2,3,4 HAVING count(*) > 1; then deny/revoke " +
      'the extras and restart the app to retry index creation.',
      err.message
    );
  }

  // ---- Notifications ----
  // Fan-out of events the recipient couldn't otherwise discover without
  // polling a specific screen on a hunch (a pending doc-access request, a
  // grant that just changed, a new account). Deliberately a thin, generic
  // table — `type`/`link`/`metadata` carry enough for the client to route a
  // click, but the row itself never duplicates data that already lives
  // authoritatively elsewhere (e.g. doc_access_requests) — it's a pointer +
  // a human-readable line, not a second copy of the event. Written from the
  // same call sites that already call recordAuditEvent (see
  // server/notifications.js), so this is fan-out, not new instrumentation.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id BIGSERIAL PRIMARY KEY,
      organisation TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      link JSONB,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications (user_id, created_at DESC) WHERE read_at IS NULL;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications (user_id, created_at DESC);`);

  // ---- Environment promotion history (append-only) ----
  // `project_env_versions` above is deliberately a single overwritten row per
  // (project, environment) — "what's live there right now." This table is
  // its append-only companion: one row per promotion (or rollback) EVER made
  // into an environment, never overwritten, so a bad promotion can be rolled
  // back to a specific prior version instead of only ever moving forward.
  // `data_enc`/`data_key_version` reuse the exact ciphertext already written
  // to project_env_versions for that promotion — no re-encryption needed to
  // keep history, since the AAD (`project-env:<id>:<env>`) only binds to
  // project+environment, not to "current" vs "historical".
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_env_version_history (
      id BIGSERIAL PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      environment_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      data_enc TEXT NOT NULL,
      data_key_version INTEGER NOT NULL,
      source_environment_id TEXT,
      action TEXT NOT NULL DEFAULT 'promote' CHECK (action IN ('promote', 'rollback')),
      rolled_back_from_id BIGINT REFERENCES project_env_version_history(id) ON DELETE SET NULL,
      promoted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      promoted_by_username TEXT,
      auto_mirrored BOOLEAN NOT NULL DEFAULT false,
      promoted_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_env_version_history_lookup ON project_env_version_history (project_id, environment_id, promoted_at DESC);`);
  // Release Pipeline v2 (see server/views/release-pipeline.html): a short,
  // required note captured at promote/rollback time ("why", not "what" —
  // the "what" is already derivable from the diff), plus a frozen snapshot
  // of the breaking changes that were reviewed and acknowledged for THIS
  // specific promotion. Both are denormalized onto the history row rather
  // than recomputed later — recomputing would mean re-diffing against
  // whatever the adjacent stage's content happens to be *now*, which drifts
  // over time as further promotions land; the whole point of a commit-style
  // history is that each entry stays an honest record of what was true at
  // that moment.
  await pool.query(`ALTER TABLE project_env_version_history ADD COLUMN IF NOT EXISTS release_note TEXT;`);
  await pool.query(`ALTER TABLE project_env_version_history ADD COLUMN IF NOT EXISTS breaking_changes JSONB NOT NULL DEFAULT '[]';`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_env_version_history_project_feed ON project_env_version_history (project_id, promoted_at DESC);`);

  // Migration path for databases created before 'prune' existed as an action
  // (see POST /projects/:id/environments/:environmentId/prune-endpoints in
  // workspace.js — pulls specific endpoints back out of one promoted
  // environment without a full re-promotion) — widens the CHECK constraint
  // the same way the 'custom' user role was added above.
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_env_version_history_action_check') THEN
        ALTER TABLE project_env_version_history DROP CONSTRAINT project_env_version_history_action_check;
      END IF;
      ALTER TABLE project_env_version_history ADD CONSTRAINT project_env_version_history_action_check CHECK (action IN ('promote', 'rollback', 'prune'));
    END $$;
  `);

  // ---- Promotion requests (Release Pipeline "protected branch" workflow) ----
  // GitHub's branch-protection model requires a SECOND person to approve a
  // merge into a protected branch — the person who opened the PR can't also
  // approve it. This is the equivalent for environments flagged
  // `requiresApproval` in org_workspace.environments (see getOrgEnvironments
  // in workspace.js — a plain boolean on each environment object, editable
  // from Your Profile ▸ Environments same as color/access): promoting
  // straight into such a stage is refused by POST /promote, and the caller
  // must instead open a request here for a DIFFERENT Admin to approve.
  // Approving actually performs the promotion (see applyPromotion in
  // workspace.js) — this table never holds the "live" state itself, only
  // the pending/decided request envelope around one promotion.
  // `diff_snapshot`/`breaking_changes` are captured at request time (same
  // reasoning as project_env_version_history.breaking_changes — an honest
  // record of what was true when requested) and re-validated by hash at
  // approval time (see checkDiffToken's sibling, checkRequestStillFresh) so
  // a request can't be silently approved against content that has since
  // moved out from under it.
  await pool.query(`
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
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_promotion_requests_project ON project_promotion_requests (project_id, status, created_at DESC);`);
  // At most one pending request per (project, target environment) at a time —
  // mirrors "one open PR against a branch for a given change" closely enough
  // for this app's needs, and avoids two Admins racing to approve conflicting
  // requests into the same stage.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_promotion_request_pending_target
    ON project_promotion_requests (project_id, to_environment_id)
    WHERE status = 'pending';
  `);

  // ---- Org-wide AI configuration (AI Studio) ----
  // One row per organisation. `api_key_enc` is the org's own LLM API key,
  // field-encrypted with the same envelope scheme as everything else (see
  // server/crypto.js) and AAD-bound to `ai:<organisation>` so a copied
  // ciphertext can't be replayed into a different org's row. The key is
  // never returned to any client, admin or otherwise, once saved — only
  // `configured: true/false` and the non-secret fields (provider/model) are
  // ever sent down. Only an Admin can write this row (see
  // server/routes/ai.js); any authenticated org member can use the features
  // it powers.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_ai_settings (
      organisation TEXT PRIMARY KEY,
      provider TEXT NOT NULL DEFAULT 'anthropic',
      model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
      api_key_enc TEXT,
      api_key_last4 TEXT,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  console.log('Database schema ready.');
}

module.exports = { pool, initDb };
