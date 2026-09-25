# DocTracker

An internal API-documentation workspace: per-organisation projects with
endpoints, environments, and access control, built on Express + PostgreSQL
with a plain HTML/CSS/vanilla-JS frontend (no framework, no bundler).

> This README describes the app as it stands today. For the history of
> specific past changes (why encryption was added, why doc-access requests
> became environment-scoped, why `studio.html` was split into 26 files),
> see `SECURITY_IMPLEMENTATION_REPORT.md`, `CHANGES_ENCRYPTION_AND_ROUTING.md`,
> `ENV_SCOPED_DOC_ACCESS.md`, and `ITEM_5_FILE_SPLIT.md` — those are
> point-in-time change logs, not living docs, so treat this file as the
> source of truth for current behavior. `ALERTING.md` is the one exception:
> it's a living reference for the alerting subsystem, kept current alongside
> this file rather than frozen at a point in time.

## What it does

- **Auth & roles** — email/username + password login with account lockout
  and optional per-user TOTP MFA (`server/totp.js`, RFC 6238, built on
  Node's own `crypto` module, no external dependency), `admin` / `editor` /
  `viewer` / `custom` (per-permission) roles, admin-managed user invites and
  password resets, optional per-user access-time-window scheduling, and
  idle-timeout + revocation-aware sessions (a role change, password reset,
  or "sign out everywhere" invalidates existing JWTs immediately, not just
  on next expiry). No outbound email is configured, so password reset stays
  admin-completed: a locked-out user can self-flag it (`POST
  /api/auth/request-password-reset`), which notifies every Admin in-app to
  verify identity out-of-band and finish the reset — there's no emailed
  reset link.
- **Workspace (Studio)** — projects containing endpoints, grouped by
  environment (Dev/SIT/UAT/...), with a diagram editor
  (`architecture-studio.html`) and a dedicated endpoint editor
  (`edit.studio`). All project/environment data is envelope-encrypted at
  rest (see `server/crypto.js`) with admin-triggered key rotation.
- **Release Pipeline** — per-project diff and promote between two
  environments (`server/routes/workspace.js`, rendered by
  `server/views/release-pipeline.html`), gated on a required release note.
  `server/breakingChangeDetector.js` flags only changes a well-behaved
  client would actually break on (a removed required parameter, a changed
  response shape, etc.) — not every structural diff.
- **Observability & Alerting** — the `ops/sit-doc-agent` log agent pushes
  traffic in; the Observability console (`public/js/studio/23-…-26-*.js`)
  gives per-environment traffic charts, a log explorer, and live status.
  `server/alertEngine.js` evaluates threshold rules (error rate, latency,
  request rate) and absence rules (collector gone silent) as a per-rule
  state machine, advisory-locked so only one app instance evaluates per
  sweep tick — with hold times, cooldowns, and quiet hours, so one incident
  produces one notification, not a flood. Firing/resolving optionally POSTs
  a signed (HMAC-SHA256) webhook alongside the in-app notification
  (`server/webhookDelivery.js`), and every incident's start/resolve is kept
  as durable history (`GET /api/workspace/alerts/history`), not just current
  state. See `ALERTING.md` for the full reference.
- **Doc-access requests** — non-admins request time-boxed access to an
  endpoint's documentation in a given environment; admins/project owners
  approve, deny, or revoke from the Security Center
  (`public/js/studio/12-security-center.js` + `server/routes/docAccess.js`).
  A requester can never approve/deny/revoke/delete their own request,
  regardless of role.
- **AI Studio** — turns pasted notes into structured endpoint documentation
  via an org-configured LLM provider (Anthropic or OpenAI; the API key is
  encrypted at rest and never re-exposed, not even to the admin who set it).
- **Auto-discovery & reconciliation** — an unattended log agent
  (`ops/sit-doc-agent`) reports every Mule app it sees serving traffic. It
  cannot see the curated documentation, so DocTracker matches the two lists
  itself (`reconcileDiscovery()` in `public/js/studio/05-util.js`): an app
  already in the Control Center stops appearing twice, and what is left is
  what is running with nothing written about it. See "Apps you have already
  documented" in the agent's README.
- **PII field rules & masking** — org-level rules for which fields get
  masked where request/response examples are shown or exported.
- **Audit log** — server-recorded, not client-writable; every security-
  relevant action (approvals, key rotation, user role changes, etc.) lands
  here.
- **Notifications** — in-app, pushed live over SSE (`server/notificationsBus.js`,
  `GET /api/notifications/stream`, `public/js/studio/03-notifications.js`)
  for unread count, doc-access status changes, and alert firing — an open
  tab picks up a revoke or approval immediately, not on the next poll or
  reload. Falls back to polling if the browser has no `EventSource` support.
- **Attachments** — inline (base64, encrypted, in the project's own JSON
  blob) by default; optionally offloaded to S3-compatible object storage
  once `S3_*` env vars are set, still encrypted client-side before upload.
- **Export** — OpenAPI spec generation with a signed, time-limited public
  link for "Open in Swagger Editor" (the one deliberately unauthenticated
  route in the app), Postman Collection v2.1 export/import, and PDF export
  of a project's docs.
- **Try It / Live Mode** — a Postman-style request builder per endpoint:
  Simulated sends match a real request against documented scenarios and
  return the matching documented response (nothing ever invented); Live
  sends proxy an actual outbound HTTP call through the server
  (`server/routes/liveMode.js`), hardened against SSRF (scheme/IP/DNS-
  rebinding checks with a fresh DNS lookup and manual redirect validation on
  every send, see `server/urlSafety.js`). Also supports collection
  variables (`{{key}}`, resolved for both modes), saving edited requests
  into folders, and "save a response field as a variable" for simple
  request chaining (e.g. carrying a login's token into the next call) —
  see "Live Mode access model" below for who can use any of this.

## Live Mode access model

Two *separate* per-user, per-environment grants control non-admin access,
both managed from Security ▸ Live Mode Access:

- **Browse** — may see and switch to an environment in the top-right
  switcher at all (`state.docBrowseEnvs`, `GET /api/live-mode/my-browse-access`).
- **Live** — may additionally fire a REAL request from Try It against that
  environment, not a simulated one (`state.liveModeEnvs`,
  `GET /api/live-mode/my-access`). Checking Live in the admin UI
  auto-checks Browse (you can't usefully test-fire something you can't look
  at); it never implies the reverse.

Neither grant is tied to role — an Admin can hand a Viewer Live access to
DEV without touching their role, or give an Editor Browse-only access to
UAT while withholding Live. `admin` and `custom` roles don't use this at
all: Admins always see/fire everywhere (except Production/DR stay
Admin-only regardless of any grant), and `custom` role uses its own
`customPermissions.envs` for browsing, kept deliberately separate.

Live Mode never stores a real credential — the secret/auth header is
blanked every time Live is toggled on and has to be retyped per send. A
live response is masked the same way every other render surface in the
app is (`maskJsonExampleDeep`) unless the viewer has already revealed
sensitive values; the "save response as variable" chaining feature is the
one deliberate exception, since a masked token isn't usable to chain into
the next request.

## Project layout

```
doctracker-main/
├── server/
│   ├── server.js                  # Express app, security middleware (helmet/CSP, CORS, cookies), routing, boots DB + crypto + migrations
│   ├── db.js                      # Postgres pool + full schema (initDb, idempotent CREATE TABLE/INDEX IF NOT EXISTS) — the frozen baseline; see migrations/ for anything since
│   ├── migrations/                # Schema changes since the baseline (numbered .sql, up/down) — see migrations/README.md
│   ├── crypto.js                  # Envelope encryption (MASTER_KEY -> DEKs), field- and buffer-level encrypt/decrypt, key rotation
│   ├── totp.js                    # RFC 6238 TOTP for MFA, built on Node's crypto only — no otplib/qrcode dependency
│   ├── validators.js              # Email/password/role/org/custom-permission validation
│   ├── cache.js                   # Optional Redis-backed cache in front of GET /api/workspace
│   ├── rateLimitStore.js          # Rate limiting; Redis-shared across instances if REDIS_URL is set, else per-instance in-memory
│   ├── storage.js                 # Optional S3-compatible attachment storage (encrypted client-side before upload)
│   ├── notifications.js           # Notification creation/listing/read-state; publishes each one to notificationsBus.js
│   ├── notificationsBus.js        # Per-recipient (org:userId) pub/sub for live notification push — see routes/notifications.js's /stream
│   ├── auditService.js            # Server-side audit event recording (recordAuditEvent for requests, recordSystemAuditEvent for background processes)
│   ├── accessSchedule.js          # Per-user access-time-window evaluation
│   ├── projectAccess.js           # Project-level access checks
│   ├── openapiExport.js           # Builds masked OpenAPI YAML for a project
│   ├── piiMasking.js              # Server-enforced PII masking, mirrors the client-side masker
│   ├── breakingChangeDetector.js  # Flags client-breaking changes between two endpoint versions, for the Release Pipeline
│   ├── alertEngine.js             # Alert rule state machine + evaluation (ingest-triggered and advisory-locked 60s sweep) — see ALERTING.md
│   ├── webhookDelivery.js         # Signs + sends one alert webhook delivery; SSRF-validates and audits every outcome
│   ├── outboundHttp.js            # Generic SSRF-safe outbound sender (validate → manual re-validated redirect loop → timeout) webhookDelivery.js is built on
│   ├── observabilityBus.js        # In-process pub/sub fanning live ingests out to open Observability tabs
│   ├── observabilityStore.js      # Rollup read/write, agent heartbeat tracking
│   ├── retention.js               # Time-based cleanup of aged observability/audit data
│   ├── middleware/
│   │   ├── authGuard.js           # Session verification (DB-revalidated every request), idle timeout, admin gate
│   │   └── compress.js            # Response compression for /api
│   ├── routes/
│   │   ├── auth.js                # /register /login /logout /me, MFA challenge/setup, password-reset request
│   │   ├── users.js               # Admin: list/invite/reset/role/schedule
│   │   ├── workspace.js           # Projects, environments, attachments, request history, Release Pipeline diff/promote
│   │   ├── docAccess.js           # Doc-access request lifecycle + admin queue (cursor-paginated)
│   │   ├── ai.js                  # AI Studio: org LLM config + generation
│   │   ├── audit.js               # Audit log read/write
│   │   ├── pii.js                 # PII field-rule CRUD
│   │   ├── security.js            # Admin: encryption key status + rotation
│   │   ├── liveMode.js            # Live-mode request proxying
│   │   ├── observability.js       # Agent ingest endpoint + console read APIs
│   │   ├── alerts.js              # Alert rule CRUD, read/acknowledge, webhook config + test, incident history
│   │   └── notifications.js       # List/unread-count/mark-read + live SSE stream
│   └── views/                     # Server-rendered HTML shells (studio, editor, architecture-studio, auditlog, release-pipeline) — injected with a fresh CSP nonce + signed-in user per request
├── public/
│   ├── login.html / register.html / dashboard.html
│   ├── css/auth.css
│   └── js/
│       ├── theme.js, login.js, register.js, idle-session.js
│       └── studio/01-…-26-*.js    # The Studio app, split into 26 load-ordered files (see ITEM_5_FILE_SPLIT.md) — no bundler, so load order in studio.html matters
├── test/                          # node:test suite — see "Testing" below
├── ops/sit-doc-agent/             # Python log agent that reports Mule traffic in; own README + pytest suite
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
schema on boot (`initDb()` in `server/db.js`, then any pending file in
`server/migrations/`) — there's no separate manual step for a normal run.
`npm run migrate:status` shows what's applied if you want to check; see
`server/migrations/README.md` for the full migration workflow.

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

## Testing

`npm test` runs the `node:test` suite in `test/`: the alert engine's state
machine, breaking-change detection, access-schedule evaluation, discovery
reconciliation, the observability charts/rollups, validators, and — as of
this pass — the doc-access request permission/status/pagination rules
(`docAccess.test.js`) and the account-lockout rules (`auth.test.js`). All
of it is zero-DB: pure functions to begin with, or pure decision functions
deliberately extracted from a route handler and exported off its router
(see `CONTRIBUTING.md`'s "Tests" section for the pattern) so the *decision*
is testable even though the DB write around it isn't. Full route-level
integration coverage (`users.js`, `workspace.js`'s CRUD, `crypto.js`) still
doesn't exist — see "Known gaps." The log agent has its own Python suite
under `ops/sit-doc-agent/tests/` (pytest).

## Known gaps

- **Test coverage is still partial.** The permission/status logic most
  likely to regress silently (doc-access transitions, login lockout,
  cursor pagination) now has unit coverage — see "Testing" above — but
  full route-level integration tests (a real request hitting a real DB)
  don't exist for any route, and `users.js`/`workspace.js`'s CRUD and
  `crypto.js` have no coverage of any kind yet.
- **Password reset isn't link-based self-serve.** A locked-out user can
  request one (`POST /api/auth/request-password-reset`), but it only
  notifies an Admin to verify identity and complete it — there's no
  outbound-email service, so there's no emailed reset link.
- **The alert-engine's ingest-triggered throttle is still per-process.**
  The sweep itself is now advisory-locked across instances (see
  `ALERTING.md`), but `evaluateAfterIngest()`'s per-org-per-environment
  rate limit is an in-memory `Map`, so two instances could each
  independently evaluate the same org's ingest-driven path within the
  throttle window. Lower-stakes than the sweep was — see `ALERTING.md`'s
  "Known limits" for the full picture, including the webhook delivery
  channel's lack of a retry queue.
- **Frontend has no build step.** `public/js/studio/*.js` are loaded as 26
  separate, order-dependent `<script>` tags with implicit shared global
  scope — no bundling, minification, or per-file isolation for testing.
