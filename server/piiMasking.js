// server/piiMasking.js
//
// SECURITY FIX (Finding 4.2 — "PII masking is a client-side display feature,
// not an access control"): the server used to send fully unmasked example
// values for every field of every endpoint a user had doc access to, and
// masking only happened when the browser rendered it. That meant anyone
// could see real values via devtools/Network tab, with no audit trail.
//
// This module ports the same detection rules the client used
// (public/js/studio/03-notifications.js: PII_BUILTIN_FIELDS, PII_PATTERNS,
// maskByStrategy, maskJsonExampleDeep) so the SAME masking can be applied
// authoritatively on the server, before data is ever serialized to JSON and
// sent over the wire. The client-side engine is left in place as a harmless
// no-op belt-and-braces layer (masking already-masked text just returns the
// same text), but it's no longer the only thing standing between a viewer
// and a real value.
//
// Unmasked data is now only ever returned by the audited reveal endpoint
// (see server/routes/pii.js: POST /reveal/:projectId), gated to Admins.

const PII_BUILTIN_FIELDS = [
  { test: /^(mobile|mobilenumber|mobileno|phone|phonenumber|contactnumber)$/, category: 'PII', strategy: 'last4' },
  { test: /^(email|emailaddress|emailid)$/, category: 'PII', strategy: 'email' },
  { test: /^(pan|pannumber)$/, category: 'SENSITIVE_PII', strategy: 'last2' },
  { test: /^(aadhaar|aadhar|aadhaarnumber|aadharnumber|uidai)$/, category: 'SENSITIVE_PII', strategy: 'last4' },
  { test: /^(accountnumber|accountno|acctno|bankaccount|bankaccountnumber)$/, category: 'FINANCIAL', strategy: 'last4' },
  { test: /^(cardnumber|cardno|ccnumber|debitcard|creditcard|creditcardnumber)$/, category: 'FINANCIAL', strategy: 'last4' },
  { test: /^(customername|fullname|firstname|lastname|contactname|accountholdername)$/, category: 'PII', strategy: 'partial' },
  { test: /^(dob|dateofbirth|birthdate)$/, category: 'PII', strategy: 'full' },
  { test: /^(address|addressline1|addressline2|residentialaddress|billingaddress)$/, category: 'PII', strategy: 'full' },
  { test: /^(passport|passportnumber)$/, category: 'SENSITIVE_PII', strategy: 'last2' },
  { test: /^(ifsc|ifsccode)$/, category: 'FINANCIAL', strategy: 'last4' },
  { test: /^(upi|upiid|vpa)$/, category: 'FINANCIAL', strategy: 'partial' },
];

const PII_PATTERNS = [
  { test: (v) => /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(v), category: 'SENSITIVE_PII', strategy: 'last2' },
  { test: (v) => /^\d{12}$/.test(v.replace(/\s/g, '')), category: 'SENSITIVE_PII', strategy: 'last4' },
  { test: (v) => { const d = v.replace(/\D/g, ''); return /^[6-9]\d{9}$/.test(d) && d.length === 10; }, category: 'PII', strategy: 'last4' },
  { test: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), category: 'PII', strategy: 'email' },
  { test: (v) => /^\d{13,19}$/.test(v.replace(/[\s-]/g, '')), category: 'FINANCIAL', strategy: 'last4' },
];

const SENSITIVE_HEADER_RE = /secret|password|passwd|privatekey|apikey|clientid|authorization|token|credential/;

function normFieldKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSensitiveHeaderName(name) {
  const n = normFieldKey(name);
  return !!n && SENSITIVE_HEADER_RE.test(n);
}

function maskSecretValue(val) {
  const s = String(val == null ? '' : val);
  if (!s) return s;
  if (s.length <= 6) return '\u2022'.repeat(Math.max(s.length, 4));
  const head = s.slice(0, Math.min(6, Math.ceil(s.length * 0.3)));
  const tail = s.slice(-Math.min(5, Math.ceil(s.length * 0.25)));
  const midLen = Math.max(5, Math.min(9, s.length - head.length - tail.length));
  return head + '*'.repeat(midLen) + tail;
}

// rules: the org's admin-defined pii_field_rules rows (client-shape, see
// server/routes/pii.js ruleRowToClient). Environment scoping is intentionally
// NOT applied here — this payload isn't split per-environment, and the safe
// default is to mask a matching field everywhere rather than risk leaving it
// unmasked for an environment the caller didn't happen to be filtering by.
function ruleForField(name, orgRules) {
  const raw = String(name || '');
  const key = normFieldKey(raw);
  if (!key) return null;
  const custom = (orgRules || []).find((r) => {
    if (r.enabled === false) return false;
    if (r.matchMode === 'regex') {
      try { return new RegExp(r.fieldName, 'i').test(raw); } catch (e) { return false; }
    }
    if (r.matchMode === 'nested') return normFieldKey(String(r.fieldName || '').split(/[.[]/).pop()) === key;
    if (r.matchMode === 'exact') return r.fieldName === raw;
    return normFieldKey(r.fieldName) === key;
  });
  if (custom) return { category: custom.category, strategy: custom.maskingStrategy, maskChar: custom.maskChar || '*' };
  const builtin = PII_BUILTIN_FIELDS.find((f) => f.test.test(key));
  return builtin || null;
}

function ruleForValue(value) {
  const v = String(value == null ? '' : value).trim();
  if (!v || v.length > 40) return null;
  return PII_PATTERNS.find((p) => { try { return p.test(v); } catch (e) { return false; } }) || null;
}

function ruleFor(name, value, orgRules) {
  return ruleForField(name, orgRules) || ruleForValue(value) ||
    (isSensitiveHeaderName(name) ? { category: 'AUTHENTICATION_SECRET', strategy: 'secret' } : null);
}

function maskByStrategy(value, rule) {
  const s = String(value == null ? '' : value);
  if (!s) return s;
  const mc = (rule && rule.maskChar) || '*';
  switch ((rule && rule.strategy) || 'partial') {
    case 'full': return mc.repeat(Math.min(s.length, 10));
    case 'last4': { const n = Math.min(4, s.length - 1); return n <= 0 ? mc.repeat(s.length) : mc.repeat(Math.max(4, s.length - n)) + s.slice(-n); }
    case 'last2': { const n = Math.min(2, s.length - 1); return n <= 0 ? mc.repeat(s.length) : mc.repeat(Math.max(4, s.length - n)) + s.slice(-n); }
    case 'first2last2': return s.length <= 4 ? mc.repeat(s.length) : s.slice(0, 2) + mc.repeat(Math.max(4, s.length - 4)) + s.slice(-2);
    case 'email': { const at = s.indexOf('@'); if (at < 1) return maskSecretValue(s); return s[0] + mc.repeat(6) + s.slice(at); }
    case 'secret': return maskSecretValue(s);
    case 'partial':
    default: return s.length <= 4 ? mc.repeat(s.length) : s[0] + mc.repeat(Math.max(4, s.length - 2)) + s.slice(-1);
  }
}

function displayValueFor(name, value, orgRules) {
  if (value == null || value === '') return value;
  const rule = ruleFor(name, value, orgRules);
  if (!rule) return value;
  return maskByStrategy(value, rule);
}

// Recursively masks a parsed JSON example (object/array/scalar), same as the
// client's maskJsonExampleDeep — never mutates its input.
function maskJsonExampleDeep(obj, orgRules) {
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out = {};
      Object.keys(node).forEach((k) => {
        const v = node[k];
        out[k] = (v && typeof v === 'object') ? walk(v) : displayValueFor(k, v, orgRules);
      });
      return out;
    }
    return node;
  };
  try { return walk(JSON.parse(JSON.stringify(obj))); } catch (e) { return obj; }
}

// Convenience wrapper for body/response examples stored as a JSON *string*.
// Non-JSON strings are returned unchanged (can't safely find field names in
// free text) — same documented gap as the client version.
function maskedJsonString(rawStr, orgRules) {
  if (rawStr == null || rawStr === '' || typeof rawStr !== 'string') return rawStr;
  let parsed;
  try { parsed = JSON.parse(rawStr); } catch (e) { return rawStr; }
  try { return JSON.stringify(maskJsonExampleDeep(parsed, orgRules), null, 2); } catch (e) { return rawStr; }
}

function maskParamList(params, orgRules) {
  if (!Array.isArray(params)) return params;
  return params.map((p) => (p && p.example !== undefined)
    ? { ...p, example: displayValueFor(p.name, p.example, orgRules) }
    : p);
}

function maskRequestBody(requestBody, orgRules) {
  if (!requestBody) return requestBody;
  return {
    ...requestBody,
    example: maskedJsonString(requestBody.example, orgRules),
    examples: Array.isArray(requestBody.examples)
      ? requestBody.examples.map((ex) => (ex && ex.value !== undefined ? { ...ex, value: maskedJsonString(ex.value, orgRules) } : ex))
      : requestBody.examples,
  };
}

function maskResponses(responses, orgRules) {
  if (!Array.isArray(responses)) return responses;
  return responses.map((r) => (r ? {
    ...r,
    example: maskedJsonString(r.example, orgRules),
    examples: Array.isArray(r.examples)
      ? r.examples.map((ex) => (ex && ex.value !== undefined ? { ...ex, value: maskedJsonString(ex.value, orgRules) } : ex))
      : r.examples,
  } : r));
}

// Masks one endpoint's example-bearing fields (parameters, headers, request
// body, responses) in place on a shallow copy. Leaves everything else
// (method, path, summary, doc-lock flags, etc.) untouched.
function maskEndpoint(ep, orgRules) {
  if (!ep || typeof ep !== 'object') return ep;
  return {
    ...ep,
    parameters: maskParamList(ep.parameters, orgRules),
    headers: maskParamList(ep.headers, orgRules),
    requestBody: maskRequestBody(ep.requestBody, orgRules),
    responses: maskResponses(ep.responses, orgRules),
  };
}

// Masks every endpoint in a project's data envelope. `orgRules` should be the
// caller's organisation's pii_field_rules (client-shape rows) — pass [] to
// fall back to built-in rules only.
function maskProjectData(projectData, orgRules) {
  if (!projectData || typeof projectData !== 'object') return projectData;
  if (!Array.isArray(projectData.endpoints)) return projectData;
  return { ...projectData, endpoints: projectData.endpoints.map((ep) => maskEndpoint(ep, orgRules)) };
}

module.exports = {
  maskProjectData,
  maskEndpoint,
  maskedJsonString,
  maskJsonExampleDeep,
  displayValueFor,
  ruleFor,
};
