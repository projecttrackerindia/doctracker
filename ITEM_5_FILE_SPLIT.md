# Item #5 — Splitting the 13,700-line studio.html

## What changed

`server/views/studio.html` contained one inline `<script>` block of ~10,450
lines holding the entire client application — markup, styles, and every
feature's JS all in one file, with no way to unit-test a function in
isolation and every change meaning a scroll through one giant file.

The file already had internal `/* ==== SECTION:X ==== */` comment markers
dividing it into 22 logical feature areas (auth, workspace API, spec
parsing, security center, endpoint table, modals, etc.) — so rather than
inventing new boundaries, I split exactly along those existing markers.

**`server/views/studio.html` is now 3,762 lines** (down from ~14,125) and
contains:
- All markup/CSS (unchanged)
- One small inline `<script>` block with just `AUTH_USER` and `ORG_TOKEN` —
  these two lines need per-request server-side templating (see
  `server/server.js`'s `renderDashboard`), so they can't move to a static
  file
- A sequence of 22 `<script src="/js/studio/NN-name.js">` tags, in the
  exact original execution order

**New directory `public/js/studio/`** holds the 22 extracted files:

```
01-constants.js        13 lines
02-workspace-api.js     55 lines
03-notifications.js   733 lines   (the bell/badge code from earlier)
04-state.js             23 lines
05-util.js             258 lines
06-spec-parse.js       580 lines
07-codesamples.js      419 lines
08-render-chrome.js    148 lines
09-render-sidebar.js   184 lines
10-metrics.js          269 lines
11-render-main.js      227 lines
12-security-center.js 1421 lines
13-endpoint-table.js   399 lines
14-users.js           1304 lines
15-render-rail.js       48 lines
16-palette.js          152 lines
17-modals.js          1245 lines
18-renderview.js      1639 lines
19-audit-log-page.js   447 lines
20-export-pdf.js       436 lines
21-events.js           343 lines
22-init.js              53 lines
```

Each file still starts with its original `SECTION:` comment, so it's
self-documenting which feature area it covers.

## Why this approach (and not a bundler)

The original ask was explicit: "even without a bundler: separate `<script
src>` files grouped by feature." Classic (non-module) `<script>` tags all
share one global scope regardless of how many separate files they're split
across, executed strictly in document order — so this is functionally
identical to the old single block, just organized into reviewable,
independently-diffable files, with no build step, no bundler config, and no
change to how the app is served (`express.static` already serves
`public/`).

## What I verified before calling this done

A blind split of a 10,000+ line file is exactly the kind of change that can
silently break something (a function used before its section loads, an
event listener that never gets attached, etc.), so I didn't just eyeball
it:

1. **Every one of the 22 extracted files passes `node --check` on its own**
   — confirming each cut landed on a clean top-level boundary, not
   mid-function.
2. **Ran the exact same real-browser (jsdom) test suites against the split
   version** that I built earlier for items #1–#4 and #6 — registering
   real users against a real Postgres instance, loading the real
   `dashboard.html` the server renders, and exercising:
   - Security nav visibility/badges for Admin vs. project-owner vs. plain
     viewer
   - The Security tab filtering (project owner sees only Documentation
     Access)
   - The Documentation Access table actually rendering with real data
   - The full rollback flow — opening the project modal, the version
     history panel, clicking "Roll back to this," confirming, and the
     server actually recording the rollback
3. **All of it passed identically to the pre-split version** — same
   assertions, same results, run back-to-back against both versions of the
   file to confirm zero behavioral difference.

## Nothing else changed

This was a pure mechanical extraction — no logic was rewritten. The CSP
header already allowlists `'self'` for scripts, so the new `<script src=...>`
tags didn't need any CSP changes (I added the existing nonce to them anyway,
for consistency with the app's other script tags, though it's not strictly
required).
