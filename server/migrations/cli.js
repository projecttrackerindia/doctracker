#!/usr/bin/env node
// Manual migration control, for local/CI use outside the normal app boot
// (which only ever calls runMigrations() — never rollbackLast()).
//
// Usage:
//   node server/migrations/cli.js up        # apply all pending migrations
//   node server/migrations/cli.js down      # roll back the single most recent migration
//   node server/migrations/cli.js status    # list migrations and whether each is applied
//
// Also wired into package.json as: npm run migrate / npm run migrate:down / npm run migrate:status
require('dotenv').config();
const { pool } = require('../db');
const { runMigrations, rollbackLast, status } = require('./runner');

async function main() {
  const cmd = process.argv[2];
  try {
    if (cmd === 'up') {
      await runMigrations(pool);
    } else if (cmd === 'down') {
      await rollbackLast(pool);
    } else if (cmd === 'status') {
      const rows = await status(pool);
      rows.forEach((r) => console.log(`${r.applied ? '[applied] ' : '[pending] '}${r.filename}`));
    } else {
      console.error('Usage: node server/migrations/cli.js <up|down|status>');
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
