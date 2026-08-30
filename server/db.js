const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Add a Postgres database and set this env var.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
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

  // Shared, organisation-wide workspace extras that previously lived in their
  // own separate localStorage keys (environments, audit log, try-it request
  // history, custom flow-direction presets). One row per organisation.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_workspace (
      organisation TEXT PRIMARY KEY,
      environments JSONB NOT NULL DEFAULT '[]',
      audit_log JSONB NOT NULL DEFAULT '[]',
      request_history JSONB NOT NULL DEFAULT '{}',
      custom_flow_directions JSONB NOT NULL DEFAULT '[]',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  console.log('Database schema ready.');
}

module.exports = { pool, initDb };
