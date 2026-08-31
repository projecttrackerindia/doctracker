# Security Hardening — Implementation Report

Scope note: the uploaded app (API Studio) is a **documentation tool** — endpoint
docs with author-entered example values — not a live API console that proxies
real customer traffic. The changes below adapt the requested PII/audit/storage
hardening to that reality rather than building a live-data proxy that doesn't
apply here.

## Bugs found (before this change)

1. **Audit log was client-authoritative.** `PUT /api/workspace/audit-log`
   accepted a full array from the browser and overwrote Postgres with it —
   actor name, timestamps, and history were all client-supplied and could be
   forged or deleted via devtools.
2. **Masking only covered header rows.** `paramSection()` only masked a value
   when `variant === 'header'`. Query/path/body/response parameters — where a
   field like `mobileNumber` or `pan` actually lives — were rendered in plain
   text. Evidenced by the uploaded screenshot of the JWT auth doc, where the
   `password` request parameter and `token` response parameter are shown
   unmasked.
3. **Raw JSON body examples were never masked**, in the doc viewer, the
   render-view, the PDF export, or the cURL code sample's `--data-raw` body —
   all dumped `ep.requestBody.example` / `r.example` verbatim via `escapeHtml`.
4. **Reveal was a silent client-side flip** with no reason capture, no audit
   trail, and no auto-remask timeout.
5. **`swaggerSample()`** (the OpenAPI code-sample tab) still embeds raw
   examples — intentionally left alone, since a spec-export action arguably
   should reflect true source data; flagging for a product decision rather
   than guessing.

## What changed

**Backend** (`server/`):
- `db.js` — new `audit_logs` table (server-derived columns only), new
  `pii_field_rules` table, new `org_workspace.pii_settings` column. Old
  `org_workspace.audit_log` blob column kept (unused) for backward compat.
- `auditService.js` — single write path for audit events; identity (user,
  role, org), IP, user-agent, and timestamp always come from the authenticated
  session/request, never the request body.
- `routes/audit.js` — `POST/GET /api/audit/events`, rate-limited, org-scoped.
- `routes/pii.js` — `GET /api/pii`, and Admin-only
  `PUT /settings` / `POST /rules` / `PUT /rules/:id` / `DELETE /rules/:id`.
- `routes/workspace.js` — stopped reading/writing the old audit blob; the
  one-time legacy-localStorage migration now inserts into `audit_logs`
  directly as `LEGACY_AUDIT_IMPORTED` events instead of merging into the blob.

**Frontend** (`server/views/studio.html`):
- Centralized PII engine (built-in field-name rules + value-pattern detection
  + admin-defined rules, fail-closed on config-fetch failure) — wired into
  `paramSection()` (now covers every param table, not just headers),
  `headerList()`/`curlSample()`, and a new `maskedJsonString()` helper applied
  everywhere a raw JSON body example was previously dumped unmasked (doc
  viewer, render-view, PDF export). Copy-to-clipboard now copies the masked
  value, not the raw one.
- Authorized reveal: reason-prompt modal → `PII_REVEAL` audit event →
  auto-remask after a configurable timeout (Admin-only, unchanged permission
  model).
- New Security Center (Admin-only, topbar → Security): live PII settings +
  sensitive-field rule CRUD, and a **real** browser-storage scanner
  (`scanClientStorage()` — enumerates actual `localStorage`/`sessionStorage`/
  cookies/IndexedDB/Cache API at click time; nothing hardcoded).
- Sidebar: edge-mounted collapse/expand handle replacing the old
  hamburger-to-invisible behavior.

## Confirmed client-side storage after this change

Only UI preferences — theme, sidebar state, last-selected environment,
legacy pre-login name/role (ignored once signed in), avatar color, and a
one-time migration flag. No tokens, credentials, or customer data. Verifiable
live via Security → Data Storage → Run security scan.

## Known gaps / follow-ups worth a decision

- `swaggerSample()` still unmasked (see above).
- Audit log UI has no server-side date/environment/severity filter UI yet
  (client-side search/filter over the returned set still works as before).
- PII masking rules are shared per-organisation, not per-project.
