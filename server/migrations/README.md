# Schema migrations

`server/db.js`'s `initDb()` is the frozen baseline — every table/column it
creates existed before this system did, and it stays as idempotent
`CREATE ... IF NOT EXISTS` DDL. **From now on, any schema change that isn't
"add a new table" or "add a new nullable column" should be a new file here
instead.** That covers: renaming/dropping a column, backfilling data,
changing a constraint, or anything else that needs to run exactly once, in
order, with a rollback path.

## Adding a migration

1. Create `server/migrations/sql/NNNN_short_description.sql`, where `NNNN`
   is the next zero-padded number (files run in filename order).
2. Write the forward change under `-- +migrate Up` and how to undo it under
   `-- +migrate Down`. Both markers are required, even if one side is just
   `SELECT 1;` for a change that can't be cleanly reversed (say so in a
   comment if so).
3. It runs automatically the next time the app boots (`runMigrations()` is
   called from `server.js`, after `initDb()`, before the app starts
   listening) — nothing else to wire up.

## Commands

```
npm run migrate          # apply all pending migrations (also runs on every app boot)
npm run migrate:down     # roll back the single most recently applied migration
npm run migrate:status   # list every migration and whether it's applied
```

## Notes

- Each migration runs inside its own transaction; a failure rolls back that
  migration only and stops the run (later migrations, and the app itself,
  won't start until it's fixed).
- `rollbackLast()` only ever undoes the most recent migration, one at a
  time — there's no "roll back to version N" in one call, by design, so a
  rollback is always a deliberate, visible step rather than something that
  can accidentally cascade through several unrelated changes.
- The runner itself never runs at import time — only `runMigrations()` (at
  boot) or the CLI (manually) trigger anything.
