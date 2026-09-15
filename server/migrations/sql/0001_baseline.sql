-- 0001_baseline
-- Marks the schema that already exists via server/db.js's initDb() (which
-- remains the source of truth for every table/column created before this
-- migration system existed). This migration is intentionally a no-op on
-- `up`/`down` — its only job is to be the first row in schema_migrations so
-- every migration added from here on has a real "applied after baseline"
-- ordering to build on, instead of starting from nothing.
--
-- Do NOT add DDL here. If you need to change something initDb() already
-- creates, write a new numbered migration instead.

-- +migrate Up
SELECT 1;

-- +migrate Down
SELECT 1;
