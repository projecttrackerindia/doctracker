// Breaking-change detection for the release pipeline (server/routes/workspace.js
// GET /diff, POST /promote). Distinct from diffEndpointLists in workspace.js:
// that produces a generic git-diff-style structural comparison for display
// (every field that changed, whether or not it matters to a caller of the
// API); this asks the narrower question "would an existing client of `from`
// break if `to` went live instead?" and only flags things where the answer
// is yes.
//
// Operates directly on the two endpoint arrays rather than parsing
// diffEndpointLists' string `path`s, since array-item matching in that
// generic diff collapses multiple parameters/headers/responses onto the
// same path key — reliable enough for rendering a before/after, not for
// reliably identifying which specific field changed. Working from the raw
// endpoint objects instead means each check is direct: "does this named
// path parameter still exist," not "does some diff entry whose path
// happens to be 'parameters.required' refer to the param we think it does."
//
// Deliberately conservative: every rule here is a category of change that
// is *definitely* breaking for at least some well-behaved client (one that
// doesn't ignore unknown fields, doesn't retry on 404, etc.) — not every
// change that's merely "risky." A field disappearing from a request-body
// *example* isn't flagged (examples aren't a schema; the app doesn't store
// one), same known gap the client-side PII masking code calls out for body
// examples elsewhere in this app. That's a real limitation, not an
// oversight — see the README note under "Known gaps" once this ships.

function keyByName(list) {
  const m = new Map();
  for (const item of list || []) {
    if (item && item.name) m.set(String(item.name).toLowerCase(), item);
  }
  return m;
}

function keyByCode(list) {
  const m = new Map();
  for (const item of list || []) {
    if (item && item.code != null) m.set(String(item.code), item);
  }
  return m;
}

function isSuccessCode(code) {
  const n = Number(code);
  return n >= 200 && n < 300;
}

function paramType(p) {
  return (p && p.type) || 'string';
}

// Severity tiers for the release pipeline's breaking-change callout — lets a
// reviewer triage a long list at a glance instead of treating every rule as
// equally urgent. "critical" = an existing, well-formed request from before
// this change will now fail outright (404/405, or a response shape it never
// expected). "high" = an existing request can still reach the endpoint but
// may now fail validation (a newly-required field/header it doesn't send,
// or a value it sends in a now-wrong shape). Deliberately just two tiers —
// this is meant to help a human skim a diff quickly, not to encode a
// precise incident-severity taxonomy.
const SEVERITY_BY_RULE = {
  'endpoint-removed': 'critical',
  'method-changed': 'critical',
  'path-changed': 'critical',
  'path-param-removed': 'critical',
  'success-response-removed': 'critical',
  'required-param-added': 'high',
  'param-now-required': 'high',
  'param-type-changed': 'high',
  'header-now-required': 'high',
  'required-header-added': 'high',
};
function severityForRule(rule) {
  return SEVERITY_BY_RULE[rule] || 'high';
}

// One endpoint's before (`fe`) vs after (`te`) — both non-null, same id.
function diffOneEndpoint(fe, te) {
  const issues = [];
  const label = `${(fe.method || '').toUpperCase()} ${fe.path || ''}`;

  if ((fe.method || '').toUpperCase() !== (te.method || '').toUpperCase()) {
    issues.push({
      rule: 'method-changed',
      message: `${label} — HTTP method changed to ${(te.method || '').toUpperCase()}. Existing callers using ${(fe.method || '').toUpperCase()} will get a 404 or 405.`,
    });
  }
  if ((fe.path || '') !== (te.path || '')) {
    issues.push({
      rule: 'path-changed',
      message: `${label} — path changed to ${te.path || ''}. Existing callers hitting the old path will get a 404.`,
    });
  }

  // ---- Path/query parameters ----
  const fParams = keyByName((fe.parameters || []).filter((p) => p.in === 'path' || !p.in || p.in === 'query'));
  const tParams = keyByName((te.parameters || []).filter((p) => p.in === 'path' || !p.in || p.in === 'query'));

  for (const [key, tp] of tParams) {
    const fp = fParams.get(key);
    if (!fp) {
      if (tp.required) {
        issues.push({
          rule: 'required-param-added',
          message: `${label} — new required ${tp.in || 'query'} parameter "${tp.name}". Existing callers that don't send it will fail validation.`,
        });
      }
      continue;
    }
    if (!fp.required && tp.required) {
      issues.push({
        rule: 'param-now-required',
        message: `${label} — "${tp.name}" changed from optional to required. Existing callers that omit it will now fail.`,
      });
    }
    if (paramType(fp) !== paramType(tp)) {
      issues.push({
        rule: 'param-type-changed',
        message: `${label} — "${tp.name}" type changed from ${paramType(fp)} to ${paramType(tp)}. Clients that serialize/parse it strictly may break.`,
      });
    }
  }
  for (const [key, fp] of fParams) {
    if (fp.in === 'path' && !tParams.has(key)) {
      issues.push({
        rule: 'path-param-removed',
        message: `${label} — path parameter "${fp.name}" was removed, changing the URL shape. Existing callers building the old URL will get a 404.`,
      });
    }
  }

  // ---- Headers ----
  const fHeaders = keyByName(fe.headers);
  const tHeaders = keyByName(te.headers);
  for (const [key, th] of tHeaders) {
    const fh = fHeaders.get(key);
    if (th.required && (!fh || !fh.required)) {
      issues.push({
        rule: fh ? 'header-now-required' : 'required-header-added',
        message: `${label} — "${th.name}" header is now required. Existing callers that don't send it will fail.`,
      });
    }
  }

  // ---- Responses: a documented success status disappearing entirely ----
  // (Losing a documented error code isn't flagged — that's relaxing a
  // contract, not breaking it. Losing a *success* code is: a client that
  // branches on "was this one of the success codes I was told to expect"
  // now has a status it's never seen.)
  const fResp = keyByCode(fe.responses);
  const tResp = keyByCode(te.responses);
  for (const code of fResp.keys()) {
    if (isSuccessCode(code) && !tResp.has(code)) {
      issues.push({
        rule: 'success-response-removed',
        message: `${label} — documented success response ${code} was removed. Callers expecting that status code may mishandle the new response.`,
      });
    }
  }

  return issues.map((i) => ({ ...i, endpointId: te.id, method: te.method, path: te.path }));
}

// fromEndpoints: what's live today (or in the source stage). toEndpoints:
// what's about to become live (or the target stage). Returns a flat array —
// order is: endpoints removed entirely, then per-endpoint field-level
// issues, in the same endpoint order diffEndpointLists would visit them.
function detectBreakingChanges(fromEndpoints, toEndpoints) {
  const fm = new Map((fromEndpoints || []).filter((e) => e && e.id).map((e) => [e.id, e]));
  const tm = new Map((toEndpoints || []).filter((e) => e && e.id).map((e) => [e.id, e]));
  const issues = [];

  for (const [id, fe] of fm) {
    if (!tm.has(id)) {
      issues.push({
        rule: 'endpoint-removed',
        endpointId: id,
        method: fe.method,
        path: fe.path,
        message: `${(fe.method || '').toUpperCase()} ${fe.path || ''} was removed. Existing callers will get a 404.`,
      });
    }
  }
  for (const [id, fe] of fm) {
    const te = tm.get(id);
    if (te) issues.push(...diffOneEndpoint(fe, te));
  }
  // Tag severity, then surface the more urgent issues first so a reviewer
  // skimming a long list sees the "this will 404" items before the
  // "this will fail validation" ones.
  const withSeverity = issues.map((i) => ({ ...i, severity: severityForRule(i.rule) }));
  const rank = { critical: 0, high: 1 };
  withSeverity.sort((a, b) => (rank[a.severity] ?? 2) - (rank[b.severity] ?? 2));
  return withSeverity;
}

module.exports = { detectBreakingChanges };
