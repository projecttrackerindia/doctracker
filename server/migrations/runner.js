// Versioned migration runner.
//
// Why this exists alongside server/db.js's initDb(): initDb() is a set of
// idempotent `CREATE TABLE/INDEX IF NOT EXISTS` and `ALTER ... ADD COLUMN IF
// NOT EXISTS` statements. That pattern is fine for additive changes (new
// table, new nullable column) but has no way to express anything else —
// renaming a column, backfilling data, dropping something, or any change
// that needs to run exactly once in a specific order — and it has no
// rollback path at all. This runner adds that, without touching the
// existing initDb() DDL (which stays as the frozen baseline — see
// 0001_baseline.sql).
//
// From now on, any schema change beyond "add a new table or a new nullable
// column" should be a new file in server/migrations/sql/, not a new line in
// db.js.
//
// File format: plain .sql, split into an Up and Down section with a marker
// line (`-- +migrate Up` / `-- +migrate Down`), one file per migration,
// named `NNNN_description.sql` with a zero-padded, strictly increasing
// number. Files are applied in filename order.
const fs = require('fs');
const path = require('path');

const SQL_DIR = path.join(__dirname, 'sql');
const UP_MARKER = '-- +migrate Up';
const DOWN_MARKER = '-- +migrate Down';

function listMigrationFiles() {
  return fs
    .readdirSync(SQL_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // filenames are zero-padded, so lexical sort === numeric order
}

function parseMigration(filename) {
  const raw = fs.readFileSync(path.join(SQL_DIR, filename), 'utf8');
  const upIdx = raw.indexOf(UP_MARKER);
  const downIdx = raw.indexOf(DOWN_MARKER);
  if (upIdx === -1 || downIdx === -1 || downIdx < upIdx) {
    throw new Error(`Migration ${filename} is missing a well-formed "${UP_MARKER}" / "${DOWN_MARKER}" split.`);
  }
  return {
    filename,
    up: raw.slice(upIdx + UP_MARKER.length, downIdx).trim(),
    down: raw.slice(downIdx + DOWN_MARKER.length).trim(),
  };
}

async function ensureMigrationsTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function appliedFilenames(pool) {
  const { rows } = await pool.query('SELECT filename FROM schema_migrations ORDER BY filename');
  return new Set(rows.map((r) => r.filename));
}

// Applies every migration not yet recorded in schema_migrations, in order,
// each inside its own transaction. Called once at boot (see server.js) —
// safe to call on every deploy, since already-applied files are skipped.
async function runMigrations(pool) {
  await ensureMigrationsTable(pool);
  const applied = await appliedFilenames(pool);
  const pending = listMigrationFiles().filter((f) => !applied.has(f));

  for (const filename of pending) {
    const migration = parseMigration(filename);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (migration.up && migration.up !== 'SELECT 1;') {
        await client.query(migration.up);
      }
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
      await client.query('COMMIT');
      console.log(`Migration applied: ${filename}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${filename} failed and was rolled back: ${err.message}`);
    } finally {
      client.release();
    }
  }
  if (!pending.length) console.log('Migrations: nothing pending, schema is up to date.');
}

// Rolls back the single most-recently-applied migration by running its Down
// section, then removing its schema_migrations row. Intended for manual use
// (see migrations/cli.js) — never called automatically at boot.
async function rollbackLast(pool) {
  await ensureMigrationsTable(pool);
  const { rows } = await pool.query('SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1');
  if (!rows.length) {
    console.log('Nothing to roll back — schema_migrations is empty.');
    return null;
  }
  const filename = rows[0].filename;
  const migration = parseMigration(filename);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (migration.down && migration.down !== 'SELECT 1;') {
      await client.query(migration.down);
    }
    await client.query('DELETE FROM schema_migrations WHERE filename = $1', [filename]);
    await client.query('COMMIT');
    console.log(`Rolled back: ${filename}`);
    return filename;
  } catch (err) {
    await client.query('ROLLBACK');
    throw new Error(`Rollback of ${filename} failed and was rolled back: ${err.message}`);
  } finally {
    client.release();
  }
}

async function status(pool) {
  await ensureMigrationsTable(pool);
  const applied = await appliedFilenames(pool);
  return listMigrationFiles().map((f) => ({ filename: f, applied: applied.has(f) }));
}

module.exports = { runMigrations, rollbackLast, status };
