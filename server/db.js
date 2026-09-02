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

  console.log('Database schema ready.');
}

module.exports = { pool, initDb };
