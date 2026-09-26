-- 0005_users_organisation_index
-- Two call sites filter `users` by organisation alone with no other
-- predicate: GET /api/users (server/routes/users.js — "everyone in the
-- admin's organisation") and adminUserIds() (server/notifications.js —
-- called on every admin notification/alert fan-out, including the alert
-- engine's evaluateOrganisation()/emitNotification() path on every fired or
-- renotified alert). The only existing indexes on `users` are on
-- LOWER(email) and LOWER(username) (see server/db.js) — neither helps a
-- plain `WHERE organisation = $1`, so both call sites scan the whole table.

-- +migrate Up
CREATE INDEX IF NOT EXISTS idx_users_organisation ON users (organisation);

-- +migrate Down
DROP INDEX IF EXISTS idx_users_organisation;
