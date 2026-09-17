# DocTracker

An internal API-documentation workspace: per-organisation projects with
endpoints, environments, and access control, built on Express + PostgreSQL
with a plain HTML/CSS/vanilla-JS frontend (no framework, no bundler).

> This README describes the app as it stands today. For the history of
> specific past changes (why encryption was added, why doc-access requests
> became environment-scoped, why `studio.html` was split into 22 files),
> see `SECURITY_IMPLEMENTATION_REPORT.md`, `CHANGES_ENCRYPTION_AND_ROUTING.md`,
> `ENV_SCOPED_DOC_ACCESS.md`, and `ITEM_5_FILE_SPLIT.md` — those are
> point-in-time change logs, not living docs, so treat this file as the
> source of truth for current behavior.

## What it does

- **Auth & roles** — email/username + password login, `admin` / `editor` /
  `viewer` / `custom` (per-permission) roles, admin-managed user invites and
  password resets (no outbound email is configured, so there's no self-serve
  "forgot password" flow), optional per-user access-time-window scheduling,
  and idle-timeout + revocation-aware sessions (a role change, password
  reset, or "sign out everywhere" invalidates existing JWTs immediately,
  not just on next expiry).
- **Workspace (Studio)** — projects containing endpoints, grouped by
  environment (Dev/SIT/UAT/...), with a diagram editor
  (`architecture-studio.html`) and a dedicated endpoint editor
  (`edit.studio`). All project/environment data is envelope-encrypted at
  rest (see `server/crypto.js`) with admin-triggered key rotation.
- **Doc-access requests** — non-admins request time-boxed access to an
  endpoint's documentation in a given environment; admins/project owners
  approve, deny, or revoke from the Security Center
  (`public/js/studio/12-security-center.js` + `server/routes/docAccess.js`).
  A requester can never approve/deny/revoke/delete their own request,
  regardless of role.
- **AI Studio** — turns pasted notes into structured endpoint documentation
  via an org-configured LLM provider (Anthropic or OpenAI; the API key is
  encrypted at rest and never re-exposed, not even to the admin who set it).
- **PII field rules & masking** — org-level rules for which fields get
  masked where request/response examples are shown or exported.
- **Audit log** — server-recorded, not client-writable; every security-
  relevant action (approvals, key rotation, user role changes, etc.) lands
  here.
- **Notifications** — in-app, polled every 25s (`public/js/studio/03-notifications.js`)
  for unread count and doc-access status changes. Live-tab push (so an open
  tab picks up a revoke without a full reload) is a known gap — see
  "Known gaps" below.
- **Attachments** — inline (base64, encrypted, in the project's own JSON
  blob) by default; optionally offloaded to S3-compatible object storage
  once `S3_*` env vars are set, still encrypted client-side before upload.
- **Export** — OpenAPI spec generation with a signed, time-limited public
  link for "Open in Swagger Editor" (the one deliberately unauthenticated
  route in the app), and PDF export of a project's docs.

## Project layout

```
doctracker-main/
├── server/
│   ├── server.js              # Express app, security middleware (helmet/CSP, CORS, cookies), routing, boots DB + crypto
│   ├── db.js                  # Postgres pool + full schema (initDb, idempotent CREATE TABLE/INDEX IF NOT EXISTS)
│   ├── crypto.js               # Envelope encryption (MASTER_KEY -> DEKs), field- and buffer-level encrypt/decrypt, key rotation
│   ├── validators.js           # Email/password/role/org/custom-permission validation
│   ├── cache.js                 # Optional Redis-backed cache in front of GET /api/workspace
│   ├── rateLimitStore.js        # Rate limiting; Redis-shared across instances if REDIS_URL is set, else per-instance in-memory
│   ├── storage.js               # Optional S3-compatible attachment storage (encrypted client-side before upload)
│   ├── notifications.js         # Notification creation/listing/read-state
│   ├── auditService.js          # Server-side audit event recording
│   ├── accessSchedule.js        # Per-user access-time-window evaluation
│   ├── projectAccess.js         # Project-level access checks
│   ├── openapiExport.js         # Builds masked OpenAPI YAML for a project
│   ├── middleware/authGuard.js  # Session verification (DB-revalidated every request), idle timeout, admin gate
│   ├── routes/
│   │   ├── auth.js              # /register /login /logout /me
│   │   ├── users.js             # Admin: list/invite/reset/role/schedule
│   │   ├── workspace.js         # Projects, environments, attachments, request history
│   │   ├── docAccess.js         # Doc-access request lifecycle + admin queue (cursor-paginated)
│   │   ├── ai.js                # AI Studio: org LLM config + generation
│   │   ├── audit.js             # Audit log read/write
│   │   ├── pii.js               # PII field-rule CRUD
│   │   ├── security.js          # Admin: encryption key status + rotation
│   │   ├── liveMode.js          # Live-mode request proxying
│   │   └── notifications.js     # List/unread-count/mark-read
│   └── views/                   # Server-rendered HTML shells (studio, editor, architecture-studio, auditlog) — injected with a fresh CSP nonce + signed-in user per request
├── public/
│   ├── login.html / register.html / dashboard.html
│   ├── css/auth.css
│   └── js/
│       ├── theme.js, login.js, register.js, idle-session.js
│       └── studio/01-…-22-*.js   # The Studio app, split into 22 load-ordered files (see ITEM_5_FILE_SPLIT.md) — no bundler, so load order in studio.html matters
├── package.json
├── Procfile / railway.json
└── .env.example
```

## Run it locally

```bash
npm install
cp .env.example .env
# edit .env — at minimum set DATABASE_URL, JWT_SECRET, MASTER_KEY (see .env.example for how to generate each)
npm run dev
```

Visit `http://localhost:3000/login.html`. The app creates/updates its own
schema on boot (`initDb()` in `server/db.js`) — there's no separate manual
migration step.

## Environment variables

See `.env.example` for the full, current list with generation instructions
and defaults — it's kept in sync with what the code actually reads
(`DATABASE_URL`, `JWT_SECRET`, `MASTER_KEY` required; `ALLOWED_ORIGINS`,
`DB_POOL_MAX`, `REDIS_URL`, `S3_*`, `PLATFORM_OPERATORS` optional).

## Deploy on Railway

1. **New Project → Deploy from GitHub repo.** Railway detects Node via
   `package.json`; `railway.json` sets the start command and restart policy.
2. **Add a database:** `+ New → Database → PostgreSQL` in the same project —
   Railway injects `DATABASE_URL` automatically.
3. **Set variables** (Settings → Variables) — at minimum `JWT_SECRET`,
   `MASTER_KEY`, `NODE_ENV=production`. Add `REDIS_URL` and/or `S3_*` if you
   want shared rate limiting/caching or offloaded attachment storage (see
   `.env.example`).
4. **Generate a domain:** Settings → Networking → Generate Domain.
5. Every push to `main` redeploys automatically.

## Known gaps

- **No automated tests.** Nothing in `server/` or `public/js/` has test
  coverage; regressions in cursor/permission logic (the kind #6 and #7 were)
  currently rely entirely on manual review to catch.
- **No live push for doc-access revoke.** An open tab only picks up a
  revoked grant on full reload; the 25s notification poll is the natural
  place to extend this (see `03-notifications.js`), but hasn't been done.
- **No MFA.** Login is password-only.
- **No self-serve password reset.** No email service is configured, so only
  an admin can reset a user's password.
- **Frontend has no build step.** `public/js/studio/*.js` are loaded as 22
  separate, order-dependent `<script>` tags with implicit shared global
  scope — no bundling, minification, or per-file isolation for testing.
