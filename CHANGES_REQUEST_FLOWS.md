# Request flows — multiple, non-continuous flows per project

A project's Overview page used to draw ONE left-to-right chain. Real
integrations are often several separate exchanges that run at different times
(e.g. get a token about every 30 min → send a business request on every call →
get the third-party token only when its cache is empty). A project can now
describe each of those as its own **flow**.

## Data model

`proj.requestFlows = [{ id, name, when, direction, stages }]`

- `name` / `when` — what the flow is and when it runs (shown above its diagram)
- `direction` — `'1-way'` or `'2-way'` (per flow)
- `stages[]` — `{ k, systems[], icon, mid, next, back, token }`
  - `next` — label on the arrow leaving this stage toward the next one
  - `back` — label on the return arrow (two-way flows only)
  - `token` — optional side branch: `{ k, systems[], icon, note }`. Draws a
    small box above this stage with a connector down into it, for a one-hop
    side exchange (e.g. "this stage also fetches/caches a token") that isn't
    worth a whole separate flow. `note` is the text shown beside the
    connector. Built in the same stage row in the flow editor ("+ Token
    branch above this stage"); omit it (`token: null`) for a plain stage.

## Back-compat

- Projects with no `requestFlows` render exactly as before (legacy
  `requestFlowStages` / `requestFlowDirection` / `requestFlowLabel`, or the
  default Client → Gateway → Flow → Downstream template).
- When such a project is opened in an editor, its legacy chain shows up as
  flow 1; saving writes `requestFlows` and keeps the legacy fields mirrored
  from flow 1 (so an older build reading the same record still works).

## Where things live

| Concern | File |
|---|---|
| Builder UI (shared by both editors) | `public/js/flow-editor.js` |
| Studio "Edit settings" modal (`#mFlowsRoot`) | `server/views/studio.html`, `public/js/studio/17-modals.js` |
| Full-page endpoint editor (`#fFlowsRoot`) | `server/views/editor.html` |
| Read side / legacy fallback | `resolveRequestFlows` in `public/js/studio/03-notifications.js` |
| Overview + PDF rendering (arrow labels) | `requestFlowSectionInnerHtml`, `requestFlowSvg`, `pdfRequestFlowSectionInnerHtml`, `pdfRequestFlowSvg` in `public/js/studio/10-metrics.js` |

`server/views/*.html` are read once at server start — restart/redeploy after
changing them.
