# Environment-scoped documentation access requests

## The bug

`doc_access_requests` had no concept of environment. Approving a request
unlocked that endpoint's documentation for the requester everywhere it was
visible (Dev, SIT, UAT, ...), even if the intent was "just SIT."

## The fix

- `doc_access_requests` gets two new nullable columns: `environment_id`,
  `environment_label`. Nullable so existing/historical rows (written before
  this change) keep working — they're treated as "applies to every
  environment," so upgrading never silently revokes anyone's access.
- `POST /api/workspace/doc-access/requests` now requires `environmentId` in
  the body, validated against the org's actual pipeline stages (same set
  used for promotion, DR excluded).
- `getDocAccessMap(org, userId, projectId, endpointIds, environmentId)` takes
  a fifth argument and only matches a request scoped to that exact
  environment, or a legacy row with no environment at all. All three call
  sites that decide what a non-owner sees (`GET /api/workspace` — the Dev
  draft view, `GET /projects/:id/snapshot`, `GET /projects/:id/diff`) now
  pass the environment they're actually rendering.
- The "Request documentation access" modal has a new environment picker,
  defaulting to whichever environment the person was looking at when they
  hit the lock. The Security ▸ Documentation Access admin table shows the
  requested environment as its own column.

## Not changed

- Project-level `Share` grants (`project_access`) already supported
  per-environment scoping (`environments: [...]` / `['*']`) — that model was
  correct already and didn't need touching.
- Approve/deny/revoke don't let an Admin change the environment after the
  fact — it's fixed at request time, same as the endpoint itself is.
