const express = require('express');
const { jsonrepair } = require('jsonrepair');
const { pool } = require('../db');
const dataCrypto = require('../crypto');
const { authenticate, requireAdmin } = require('../middleware/authGuard');
const { createRateLimiter } = require('../rateLimitStore');
const { recordAuditEvent } = require('../auditService');

const router = express.Router();
router.use(authenticate); // everything under /api/ai requires a logged-in session

// Generation calls leave the building (to the org's chosen LLM provider) and
// cost the org money per call, so they get their own, tighter limiter than
// the default — independent of the admin-only config endpoints below.
const generateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many AI requests — please wait a moment and try again.' },
});

const PROVIDERS = {
  anthropic: {
    label: 'Anthropic (Claude)',
    defaultModel: 'claude-sonnet-4-6',
    endpoint: 'https://api.anthropic.com/v1/messages',
  },
  openai: {
    label: 'OpenAI (GPT)',
    defaultModel: 'gpt-4.1',
    endpoint: 'https://api.openai.com/v1/chat/completions',
  },
};

// Appended to every "respond with ONLY a JSON object" prompt below. This
// exists because of a specific, recurring failure: documentation notes very
// often describe headers/config using a bare `key: <PLACEHOLDER>` convention
// (that's exactly how JWT/clientId/clientSecret requirements normally get
// written), and models tend to mirror that convention literally *inside*
// their JSON output — e.g. "token": <JWT_TOKEN> — which is not legal JSON at
// all (an unquoted, un-parseable value). The second failure mode is the
// inverse: embedding a real sample request/response payload's own quotes
// and line breaks directly into a markdown field without escaping them,
// which closes the enclosing JSON string early. Both are called out
// explicitly, with the exact shape this task tends to produce, because
// generic "output valid JSON" instructions don't reliably prevent either one.
const JSON_STRICTNESS_RULES = `
Your entire reply must be ONE valid JSON object that JSON.parse() can consume with no fix-up. Two specific mistakes break this often — avoid both:
1. Never write a bare, unquoted placeholder as a value. token: <JWT_TOKEN> is INVALID JSON. If a placeholder needs to appear as a value, quote it as a string: "token": "<JWT_TOKEN>".
2. Never paste a sample request/response payload's raw quotes or line breaks directly into a JSON string. If a field's content needs to show one, every " inside it must become \\" and every line break must become \\n, so the whole sample is still just one valid JSON string.
No comments, no trailing commas, no text outside the single JSON object.`;

function aad(organisation) {
  return `ai:${organisation}`;
}

// Shared by every prompt below that needs to know who the documentation is
// written for — factored out so the single-shot and staged (plan/section)
// generators stay in sync instead of drifting wording independently.
function buildAudienceLine(audience) {
  return audience === 'business'
    ? 'Write for a business/BRD reader: plain language, purpose, business rules, no jargon.'
    : audience === 'technical'
      ? 'Write for a technical/engineering reader: precise, implementation-level detail.'
      : 'Write so both a business (BRD) reader and a technical/engineering reader get what they each need — separate blocks for each angle rather than blending them.';
}

// ==================== Admin: org AI configuration ====================
// GET /api/ai/config — any authenticated user can see WHETHER AI is set up
// (so the "Generate" buttons know whether to show a "not configured yet, ask
// your admin" state) but never the key itself, not even to an Admin.
router.get('/config', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT provider, model, api_key_last4, updated_at FROM org_ai_settings WHERE organisation = $1`,
      [req.authUser.organisation]
    );
    const row = rows[0];
    const resolvedProviderId = row?.provider || 'anthropic';
    res.json({
      configured: !!(row && row.api_key_enc !== null) || !!(row && row.api_key_last4),
      provider: resolvedProviderId,
      // Bug fix: this used to always fall back to Anthropic's default model
      // even when the stored provider was OpenAI, which is exactly how a
      // saved row could end up with provider=openai + model=claude-*  — an
      // invalid pairing that fails at generation time with a confusing
      // upstream error. Fall back to the STORED provider's own default.
      model: row?.model || PROVIDERS[resolvedProviderId].defaultModel,
      keyPreview: row?.api_key_last4 ? `••••${row.api_key_last4}` : null,
      updatedAt: row?.updated_at || null,      providers: Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label, defaultModel: p.defaultModel })),
      canManage: req.authUser.role === 'admin',
    });
  } catch (err) {
    console.error('GET /api/ai/config failed:', err);
    res.status(500).json({ error: 'Could not load AI configuration.' });
  }
});

// A model name that obviously belongs to the other provider — e.g. saving
// provider=openai with model="claude-sonnet-4-6" (exactly what happened when
// switching the Provider dropdown didn't also reset a stale Model value) —
// is rejected here, at save time, with a specific message. Without this, the
// mismatch only surfaces later as an opaque upstream error when someone
// actually tries to generate something.
const MODEL_HINTS = {
  anthropic: { foreign: /^(gpt-|o[0-9](-|$)|chatgpt)/i, example: PROVIDERS.anthropic.defaultModel },
  openai: { foreign: /^claude/i, example: PROVIDERS.openai.defaultModel },
};
function checkModelMatchesProvider(provider, model) {
  const hint = MODEL_HINTS[provider];
  if (hint && hint.foreign.test(model)) {
    const otherProvider = provider === 'anthropic' ? 'openai' : 'anthropic';
    return `"${model}" looks like ${PROVIDERS[otherProvider].label}'s model, not ${PROVIDERS[provider].label}'s. Did you mean to pick a different Provider, or use a model like "${hint.example}"?`;
  }
  return null;
}

// PUT /api/ai/config — Admin only. Saves (or rotates) the organisation's own
// LLM API key. The key is encrypted at rest the same way as every other
// secret in this app (see server/crypto.js) and is never echoed back.
router.put('/config', requireAdmin, async (req, res) => {
  const { provider, model, apiKey } = req.body || {};
  if (provider && !PROVIDERS[provider]) {
    return res.status(400).json({ error: `Unknown provider "${provider}".` });
  }
  const resolvedProvider = provider || 'anthropic';
  const resolvedModel = (typeof model === 'string' && model.trim()) || PROVIDERS[resolvedProvider].defaultModel;
  const mismatch = checkModelMatchesProvider(resolvedProvider, resolvedModel);
  if (mismatch) {
    return res.status(400).json({ error: mismatch });
  }

  try {
    if (typeof apiKey === 'string' && apiKey.trim()) {
      const key = apiKey.trim();
      const encrypted = dataCrypto.encryptField(key, aad(req.authUser.organisation));
      const last4 = key.slice(-4);
      await pool.query(
        `INSERT INTO org_ai_settings (organisation, provider, model, api_key_enc, api_key_last4, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (organisation) DO UPDATE
           SET provider = $2, model = $3, api_key_enc = $4, api_key_last4 = $5, updated_by = $6, updated_at = now()`,
        [req.authUser.organisation, resolvedProvider, resolvedModel, encrypted, last4, req.authUser.sub]
      );
    } else {
      // No new key supplied — just updating provider/model on the existing row.
      await pool.query(
        `INSERT INTO org_ai_settings (organisation, provider, model, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (organisation) DO UPDATE
           SET provider = $2, model = $3, updated_by = $4, updated_at = now()`,
        [req.authUser.organisation, resolvedProvider, resolvedModel, req.authUser.sub]
      );
    }
    await recordAuditEvent(req.authUser, req, {
      action: 'ai.config.updated',
      resourceType: 'organisation',
      details: `AI provider set to ${resolvedProvider} (${resolvedModel})`,
      severity: 'info',
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /api/ai/config failed:', err);
    res.status(500).json({ error: 'Could not save AI configuration.' });
  }
});

// DELETE /api/ai/config — Admin only. Removes the stored key entirely
// (provider/model preference is kept so it doesn't need re-picking later).
router.delete('/config', requireAdmin, async (req, res) => {
  try {
    await pool.query(
      `UPDATE org_ai_settings SET api_key_enc = NULL, api_key_last4 = NULL, updated_by = $2, updated_at = now()
       WHERE organisation = $1`,
      [req.authUser.organisation, req.authUser.sub]
    );
    await recordAuditEvent(req.authUser, req, {
      action: 'ai.config.key_removed',
      resourceType: 'organisation',
      severity: 'warning',
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/ai/config failed:', err);
    res.status(500).json({ error: 'Could not remove the AI key.' });
  }
});

// ==================== Shared: call the org's configured LLM ====================
async function loadOrgAiSettings(organisation) {
  const { rows } = await pool.query(
    `SELECT provider, model, api_key_enc FROM org_ai_settings WHERE organisation = $1`,
    [organisation]
  );
  const row = rows[0];
  if (!row || !row.api_key_enc) return null;
  const apiKey = dataCrypto.decryptField(row.api_key_enc, aad(organisation));
  return { provider: row.provider || 'anthropic', model: row.model || PROVIDERS.anthropic.defaultModel, apiKey };
}

// Single call-out point for both providers so every route above just deals
// in { systemPrompt, userPrompt } and gets plain text back. Keeping this in
// one place also means "add a third provider" is a one-function change.
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// A 429 from the upstream provider is very often transient (a brief burst,
// not an exhausted quota), so a single retry with a short backoff clears the
// large majority of them instead of surfacing an error to the person for
// something that would have succeeded a second later. We retry at most
// twice, respect the provider's own Retry-After header when it sends one,
// and never retry non-429 failures (auth/model/quota errors won't resolve
// themselves).
async function fetchWithRetry(url, opts, { retries = 2 } = {}) {
  let lastResp;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const resp = await fetch(url, opts);
    if (resp.status !== 429) return resp;
    lastResp = resp;
    if (attempt === retries) break;
    const retryAfterHeader = Number(resp.headers.get('retry-after'));
    const waitMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
      ? Math.min(retryAfterHeader * 1000, 8000)
      : 600 * Math.pow(2, attempt) + Math.random() * 250; // ~600ms, then ~1.2s
    await sleep(waitMs);
  }
  return lastResp;
}

async function callLlm(settings, systemPrompt, userPrompt, { maxTokens = 4000 } = {}) {
  if (settings.provider === 'openai') {
    const resp = await fetchWithRetry(PROVIDERS.openai.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify({
        model: settings.model,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });
    if (!resp.ok) throw new Error(`OpenAI API error (${resp.status}): ${await resp.text()}`);
    const data = await resp.json();
    // finish_reason 'length' means the response was cut off mid-output, not
    // that the model produced something malformed — that distinction lets
    // describeAiError below give an actionable message ("ask for less at
    // once") instead of a cryptic JSON parse error.
    if (data.choices?.[0]?.finish_reason === 'length') {
      throw new Error('AI_TRUNCATED: response was cut off at the output token limit');
    }
    return data.choices?.[0]?.message?.content || '';
  }
  // default: anthropic
  const resp = await fetchWithRetry(PROVIDERS.anthropic.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': settings.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: settings.model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  if (!resp.ok) throw new Error(`Anthropic API error (${resp.status}): ${await resp.text()}`);
  const data = await resp.json();
  if (data.stop_reason === 'max_tokens') {
    throw new Error('AI_TRUNCATED: response was cut off at the output token limit');
  }
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
}

// Turns the raw thrown error (which carries the provider's own status code
// and response body — see callLlm above) into something an Admin can act on,
// instead of the same generic line for every failure. Falls back to a short
// excerpt of the real error when it doesn't match a known pattern, so
// nothing gets swallowed even for cases this doesn't specifically recognize.
// Returns { message, retryable, code } instead of a bare string so the
// front end can render errors differently (e.g. offer a "Try again" action
// only when retrying is actually likely to help).
function describeAiError(err) {
  const msg = String(err && err.message || err);
  if (/401|invalid[_ ]?api[_ ]?key|incorrect api key|authentication/i.test(msg)) {
    return { code: 'auth', retryable: false, message: 'The stored API key was rejected by the provider — ask an Admin to check or replace it under Security ▸ AI Studio.' };
  }
  if (/model[_ ]?not[_ ]?found|does not exist|invalid model|unknown model/i.test(msg)) {
    return { code: 'model', retryable: false, message: 'The configured model doesn\'t exist for this provider — check Security ▸ AI Studio ▸ Model matches the selected Provider.' };
  }
  if (/429|rate[_ ]?limit/i.test(msg)) {
    return { code: 'rate_limit', retryable: true, message: 'The AI provider is rate-limiting this key right now. This is usually brief — wait a few seconds and try again.' };
  }
  if (/insufficient_quota|billing|exceeded your current quota/i.test(msg)) {
    return { code: 'quota', retryable: false, message: 'The AI provider says this key is out of quota/credit — check billing for the org\'s AI provider account.' };
  }
  if (/timeout|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(msg)) {
    return { code: 'network', retryable: true, message: 'Could not reach the AI provider — check your connection and try again.' };
  }
  if (/^AI_TRUNCATED/.test(msg)) {
    return {
      code: 'truncated', retryable: false,
      message: 'The AI\'s answer got cut off before it finished, because it hit the response length limit — not because anything you pasted was invalid. This happens when the notes ask for a lot of output in one pass (many sections, sequence diagrams, several full sample payloads). Try trimming the notes to what matters for this one endpoint, or split a large multi-section spec into a couple of shorter generations.',
    };
  }
  if (/is not valid JSON|Unexpected token|Unexpected end of JSON|JSON at position/i.test(msg)) {
    return {
      code: 'malformed_json', retryable: true,
      message: 'The AI\'s answer wasn\'t quite valid JSON, and the automatic repair (including asking it to fix its own output) couldn\'t recover it. This is usually a one-off formatting slip on detail-heavy notes, not a problem with what you pasted — click "Try again", or try generating one endpoint at a time if it keeps happening.',
    };
  }
  // Unrecognized failure — still give something diagnosable rather than a flat "it failed".
  return { code: 'unknown', retryable: true, message: `The AI request failed: ${msg.slice(0, 200)}` };
}

// Every prompt below asks for JSON-only output; models occasionally still
// wrap it in ```json fences or add a stray sentence, so this strips both
// before parsing instead of trusting the raw string.
//
// Models also routinely break strict JSON *inside* the string values
// themselves — most often by writing a literal newline instead of "\n"
// when a "content" field holds multi-paragraph markdown (numbered flows,
// "Flow 1: ..." style notes, etc.), and occasionally by writing a bare
// backslash that isn't one of JSON's legal escapes (a Windows path, a
// regex, a markdown escape like "\_"). Either one makes JSON.parse throw
// "Unexpected token" partway through an otherwise well-formed object. We
// try a strict parse first (the common case), and only fall back to a
// character-level repair pass — which walks the text, and *only while
// inside a "..." string*, escapes raw \n/\r/\t and doubles up any
// backslash that isn't followed by a legal JSON escape char — if that
// fails.
const JSON_ESCAPE_CHARS = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u']);
function repairJsonStrings(raw) {
  let out = '';
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (ch === '\\') {
      const next = raw[i + 1];
      if (next !== undefined && JSON_ESCAPE_CHARS.has(next)) {
        out += ch + next;
        i++;
      } else {
        out += '\\\\'; // stray backslash — escape it rather than leave an illegal sequence
      }
      continue;
    }
    if (ch === '"') { inString = false; out += ch; continue; }
    if (ch === '\n') { out += '\\n'; continue; }
    if (ch === '\r') { out += '\\r'; continue; }
    if (ch === '\t') { out += '\\t'; continue; }
    out += ch;
  }
  return out;
}

// Fixes the exact break seen in production: notes that describe headers
// using a bare `key: <PLACEHOLDER>` convention (how JWT/clientId/
// clientSecret requirements normally get written) prime the model to
// mirror that convention *inside* its JSON output too — e.g. "token":
// <JWT_TOKEN> — an unquoted value that isn't legal JSON at all and makes
// JSON.parse throw immediately. This only rewrites a `<...>` that sits
// exactly where a JSON value is expected (right after `:`, `[`, or `,`,
// with only whitespace in between, and right before `,`, `]`, `}`, or a
// line break), so it can't touch a `<...>` that's already safely inside a
// quoted string — it would already have a `"` on one side, not `:`/`,`/`[`.
function quoteBarePlaceholders(raw) {
  return raw.replace(/([:[,]\s*)<([^<>"\r\n]{1,120})>(\s*[,\]}\r\n])/g, '$1"<$2>"$3');
}

// Tries every repair strategy in order of how little they change the
// original, returning the first one that both (a) parses and (b) matches
// the shape the calling route actually expects. That second check matters:
// a repair pass can be syntactically successful but structurally wrong — in
// testing, jsonrepair silently turned one malformed object into an array of
// mismatched fragments rather than throwing, which would otherwise save
// corrupted documentation with no visible error at all. `validate` is what
// stops that — if it's not provided, any syntactically valid JSON is
// accepted, matching this function's original behavior.
function tryParseCandidates(jsonSlice, validate) {
  const attempts = [
    () => JSON.parse(jsonSlice),
    () => JSON.parse(quoteBarePlaceholders(jsonSlice)),
    () => JSON.parse(repairJsonStrings(jsonSlice)),
    () => JSON.parse(repairJsonStrings(quoteBarePlaceholders(jsonSlice))),
    // repairJsonStrings only fixes things *inside* a string it correctly
    // identified as still open. It can't help when an embedded sample (the
    // notes here are full of quoted JSON payloads the model has to
    // re-embed inside a markdown string) contains an unescaped literal
    // quote — that quote closes the outer string early. That's a
    // genuinely different class of break, so it gets a genuinely
    // different, battle-tested fix: jsonrepair.
    () => JSON.parse(jsonrepair(jsonSlice)),
    () => JSON.parse(jsonrepair(quoteBarePlaceholders(jsonSlice))),
  ];
  let firstErr = null;
  for (const attempt of attempts) {
    try {
      const value = attempt();
      if (!validate || validate(value)) return value;
    } catch (err) {
      if (!firstErr) firstErr = err;
    }
  }
  throw firstErr || new Error('AI output could not be parsed as JSON.');
}

// `validate` (optional) checks the parsed object actually matches the
// shape the calling route expects — see tryParseCandidates above for why.
// `settings` (optional) enables a last-resort fallback: asking the same
// model to fix its own output. This is a cheap, targeted follow-up call
// (small input, small output) rather than discarding an otherwise-correct
// draft over a formatting slip. `label` is only for the server log line.
async function extractJson(text, { validate, settings, label = 'response' } = {}) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  const jsonSlice = start !== -1 && end !== -1 ? candidate.slice(start, end + 1) : candidate;

  try {
    return tryParseCandidates(jsonSlice, validate);
  } catch (localErr) {
    if (!settings) {
      console.error(`extractJson: local repairs failed for ${label}:`, localErr.message, '— raw text (truncated):', text.slice(0, 2000));
      throw localErr;
    }
    try {
      const repairSystemPrompt = `You are fixing a JSON formatting error. The text below was supposed to be a single valid JSON object but failed to parse.
The parser said: ${localErr.message}
Return ONLY the corrected, valid JSON object — same fields, same content and meaning — fixing ONLY what's needed to make it valid JSON (quoting bare placeholder values like <TOKEN>, escaping stray quotes/newlines/backslashes inside strings, removing trailing commas). Do not summarize, shorten, or otherwise change the content. No markdown fences, no commentary — just the JSON object.`;
      const repairedText = await callLlm(settings, repairSystemPrompt, jsonSlice.slice(0, 30000), { maxTokens: 8000 });
      const repairedFenced = repairedText.match(/```(?:json)?\s*([\s\S]*?)```/i);
      const repairedCandidate = repairedFenced ? repairedFenced[1] : repairedText;
      const rs = repairedCandidate.indexOf('{');
      const re = repairedCandidate.lastIndexOf('}');
      const repairedSlice = rs !== -1 && re !== -1 ? repairedCandidate.slice(rs, re + 1) : repairedCandidate;
      return tryParseCandidates(repairedSlice, validate);
    } catch (repairErr) {
      console.error(`extractJson: local + AI repair both failed for ${label}:`, localErr.message, '/', repairErr.message, '— raw text (truncated):', text.slice(0, 2000));
      // The original parse error is more informative than the repair
      // attempt's — surface that one.
      throw localErr;
    }
  }
}

// Shape checks used by extractJson (see tryParseCandidates) to reject a
// repair pass that "succeeded" into the wrong structure — cheap, and only
// checks the top-level contract each route actually depends on.
function validateStructureShape(p) {
  return !!p && typeof p === 'object' && !Array.isArray(p)
    && p.project && typeof p.project === 'object'
    && p.endpoint && typeof p.endpoint === 'object'
    && typeof p.apiLevelDescription === 'string'
    && Array.isArray(p.blocks)
    && p.blocks.every(b => b && typeof b === 'object'
      && typeof b.type === 'string' && typeof b.title === 'string' && typeof b.content === 'string');
}
function validateOpenApiShape(p) {
  return !!p && typeof p === 'object' && !Array.isArray(p)
    && p.openapi && typeof p.openapi === 'object'
    && Array.isArray(p.curlExamples);
}
function validateArchitectureShape(p) {
  return !!p && typeof p === 'object' && !Array.isArray(p)
    && Array.isArray(p.nodes) && Array.isArray(p.edges);
}

// ==================== Draft / upload -> structured documentation ====================
// POST /api/ai/structure  — single-shot / "quick" path
// Body: { rawText, audience }  audience: 'business' | 'technical' | 'both' (default)
// Takes completely freeform notes and turns them into the whole document —
// metadata plus every section — in ONE model call. Good for short notes.
// For notes that call for many sections (the common case once auth headers,
// multiple endpoints, S3/downstream integration, and a full error-code
// table are all in scope) prefer the staged path below
// (/structure/plan + /structure/section): one big call means one big JSON
// object the model has to get entirely right in a single pass, and a
// formatting slip anywhere in it loses everything generated so far. The
// staged path generates and applies one section at a time, so a slip in
// section 9 doesn't cost sections 1-8, and only that one section needs a
// retry.
router.post('/structure', generateLimiter, async (req, res) => {
  const { rawText, audience } = req.body || {};
  if (typeof rawText !== 'string' || !rawText.trim()) {
    return res.status(400).json({ error: 'rawText is required.' });
  }
  if (rawText.length > 200000) {
    return res.status(400).json({ error: 'That text is too long for a single pass (200,000 character limit) — try splitting it up.' });
  }
  try {
    const settings = await loadOrgAiSettings(req.authUser.organisation);
    if (!settings) {
      return res.status(409).json({ error: 'AI isn\'t set up for your organisation yet — ask an Admin to add an API key under Security ▸ AI Studio.' });
    }
    const audienceLine = buildAudienceLine(audience);
    const systemPrompt = `You convert raw, unstructured notes (which may mix business intent and technical detail, in any order, in any format) into structured API documentation. ${audienceLine}
Respond with ONLY a JSON object, no prose, no markdown fences, shaped exactly like:
{
  "project": { "name": string, "tag": string },
  "endpoint": { "method": "GET|POST|PUT|PATCH|DELETE", "path": string, "summary": string },
  "apiLevelDescription": string,  // markdown: Overview / Flow / Authentication section for the whole API
  "blocks": [
    { "type": string, "title": string, "content": string }  // content is markdown; type is a short kebab-case slug you choose freely to fit what this content actually is
  ]
}
Infer missing pieces sensibly from context rather than leaving fields empty; if something genuinely isn't present in the notes, use a short honest placeholder instead of inventing specifics.
This has to fit in a single response, so if the notes ask for an unusually large number of sections (many error codes, multiple sample payloads, sequence diagrams, security appendices, etc.), prioritize covering every section the notes call for — keep each individual block's content focused and reasonably concise rather than exhaustive, so breadth doesn't get sacrificed to depth on just the first few sections.
${JSON_STRICTNESS_RULES}`;
    const text = await callLlm(settings, systemPrompt, rawText, { maxTokens: 16000 });
    const parsed = await extractJson(text, { validate: validateStructureShape, settings, label: 'structure' });
    await recordAuditEvent(req.authUser, req, {
      action: 'ai.structure.generated',
      resourceType: 'ai',
      details: `Structured ${rawText.length} chars of input into ${(parsed.blocks || []).length} block(s)`,
      severity: 'info',
    });
    res.json(parsed);
  } catch (err) {
    console.error('POST /api/ai/structure failed:', err);
    const described = describeAiError(err);
    res.status(502).json({ error: described.message, errorCode: described.code, retryable: described.retryable });
  }
});

// ==================== Staged draft -> docs (plan, then one section at a time) ====================
// This is the recommended path for anything but a trivial note: instead of
// asking for the whole document in one shot, it splits generation into a
// cheap PLAN call (metadata + a list of section titles, no section content
// yet) followed by one small call per section. Each section is its own
// tiny, independent JSON response and gets applied to the editor the
// moment it lands — so a formatting slip in one section only costs that
// section (pick "Retry" on just that row), never the sections already
// generated and applied before it, and never the whole document.
//
// Per-section calls are smaller and more frequent than the single-shot
// route's, so they get their own, more generous limiter.
const sectionLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many AI requests — please wait a moment and try again.' },
});

function validatePlanShape(p) {
  return !!p && typeof p === 'object' && !Array.isArray(p)
    && p.project && typeof p.project === 'object'
    && p.endpoint && typeof p.endpoint === 'object'
    && Array.isArray(p.sections)
    && p.sections.every(s => s && typeof s === 'object' && typeof s.type === 'string' && typeof s.title === 'string');
}
function validateSectionShape(p) {
  return !!p && typeof p === 'object' && !Array.isArray(p)
    && typeof p.type === 'string' && typeof p.title === 'string' && typeof p.content === 'string';
}
const AI_MAX_PLANNED_SECTIONS = 25; // a defensive cap, not a realistic ceiling — keeps one bad plan from queuing up dozens of section calls

// POST /api/ai/structure/plan
// Body: { rawText, audience }
// Returns metadata + a list of { type, title, hint } — content, INCLUDING
// the API-level overview, comes later, one call per section, via
// /structure/section below. The overview used to be written here too, but
// notes that describe several endpoints and a long section list (auth,
// multiple sample payloads, error tables, sequence diagrams...) could push
// a decent overview + a full section list past this call's own token
// budget, truncating the plan itself before it ever got to generating
// anything. Planning is now purely structural — metadata and short
// one-line hints only — so its output size no longer scales with how much
// prose the notes eventually need; the overview gets its own full-budget
// section call instead, same as every other section.
router.post('/structure/plan', generateLimiter, async (req, res) => {
  const { rawText, audience } = req.body || {};
  if (typeof rawText !== 'string' || !rawText.trim()) {
    return res.status(400).json({ error: 'rawText is required.' });
  }
  if (rawText.length > 200000) {
    return res.status(400).json({ error: 'That text is too long for a single pass (200,000 character limit) — try splitting it up.' });
  }
  try {
    const settings = await loadOrgAiSettings(req.authUser.organisation);
    if (!settings) {
      return res.status(409).json({ error: 'AI isn\'t set up for your organisation yet — ask an Admin to add an API key under Security ▸ AI Studio.' });
    }
    const audienceLine = buildAudienceLine(audience);
    const systemPrompt = `You are the planning pass of a two-stage documentation generator. From raw, unstructured notes (which may mix business intent and technical detail, in any order, in any format), produce STRUCTURE ONLY — no prose content yet, that all comes from a later pass, one section at a time:
1. Extract the project metadata and the PRIMARY endpoint's method/path/summary. If the notes describe more than one endpoint (e.g. two separate operations sharing one auth scheme), pick the first/primary one for this "endpoint" field and give each of the OTHER endpoints its own section instead (e.g. type "endpoint-call-recording") — never try to merge multiple endpoints' method/path into one field.
2. List every documentation SECTION the notes call for. The list MUST start with one section of type exactly "overview" (title like "API Overview") whose hint tells the next pass to write a markdown Overview / Flow / Authentication summary for the whole API. After that, add one section per remaining topic the notes need (e.g. "Request Headers", "Sample Request", "Sample Response", "Field Descriptions", "Error Responses", "S3 Integration", "Sequence Diagram", additional endpoints as above — whatever the notes actually call for, however many that is).
Each section's "hint" is ONE short sentence pointing the next pass at what to cover — not the content itself.
${audienceLine}
Respond with ONLY a JSON object, no prose, no markdown fences, shaped exactly like:
{
  "project": { "name": string, "tag": string },
  "endpoint": { "method": "GET|POST|PUT|PATCH|DELETE", "path": string, "summary": string },
  "sections": [
    { "type": string, "title": string, "hint": string }
  ]
}
Infer missing pieces sensibly from context; use a short honest placeholder only if something genuinely isn't present in the notes.
${JSON_STRICTNESS_RULES}`;
    const text = await callLlm(settings, systemPrompt, rawText, { maxTokens: 4000 });
    const parsed = await extractJson(text, { validate: validatePlanShape, settings, label: 'structure-plan' });
    parsed.sections = (parsed.sections || []).slice(0, AI_MAX_PLANNED_SECTIONS);
    await recordAuditEvent(req.authUser, req, {
      action: 'ai.structure.plan_generated',
      resourceType: 'ai',
      details: `Planned ${parsed.sections.length} section(s) from ${rawText.length} chars of input`,
      severity: 'info',
    });
    res.json(parsed);
  } catch (err) {
    console.error('POST /api/ai/structure/plan failed:', err);
    const described = describeAiError(err);
    res.status(502).json({ error: described.message, errorCode: described.code, retryable: described.retryable });
  }
});

// POST /api/ai/structure/section
// Body: { rawText, audience, section: { type, title, hint }, apiLevelDescription? }
// Writes ONE section's content. Called once per section from the plan
// above — small input, small output, so it's cheap to retry in isolation.
router.post('/structure/section', sectionLimiter, async (req, res) => {
  const { rawText, audience, section, apiLevelDescription } = req.body || {};
  if (typeof rawText !== 'string' || !rawText.trim()) {
    return res.status(400).json({ error: 'rawText is required.' });
  }
  if (!section || typeof section !== 'object' || typeof section.type !== 'string' || typeof section.title !== 'string') {
    return res.status(400).json({ error: 'section {type, title} is required.' });
  }
  try {
    const settings = await loadOrgAiSettings(req.authUser.organisation);
    if (!settings) {
      return res.status(409).json({ error: 'AI isn\'t set up for your organisation yet — ask an Admin to add an API key under Security ▸ AI Studio.' });
    }
    const audienceLine = buildAudienceLine(audience);
    const systemPrompt = `You are writing ONE section of a larger piece of API documentation — other sections are generated separately, so write only this one. ${audienceLine}
Section to write:
- type: ${section.type}
- title: ${section.title}
- what it should cover: ${section.hint || '(use your judgement based on the raw notes below)'}
${apiLevelDescription ? `For context, here is the API-level overview already written elsewhere — stay consistent with it, don't repeat it:\n${String(apiLevelDescription).slice(0, 2000)}\n` : ''}
Respond with ONLY a JSON object, no prose, no markdown fences, shaped exactly like:
{ "type": ${JSON.stringify(section.type)}, "title": ${JSON.stringify(section.title)}, "content": string }
"content" is markdown. Go into real depth here — you are not sharing a response budget with any other section, so don't compress for space the way a single giant response would have to.
${JSON_STRICTNESS_RULES}`;
    const text = await callLlm(settings, systemPrompt, rawText, { maxTokens: 4000 });
    const parsed = await extractJson(text, { validate: validateSectionShape, settings, label: `structure-section:${section.type}` });
    res.json(parsed);
  } catch (err) {
    console.error(`POST /api/ai/structure/section (${section?.type}) failed:`, err);
    const described = describeAiError(err);
    res.status(502).json({ error: described.message, errorCode: described.code, retryable: described.retryable });
  }
});


// POST /api/ai/generate-openapi
// Body: { endpoint }  — the same shape the editor already works with
// (method, path, params, headers, requestBody, responses, baseUrl…). Returns
// a ready OpenAPI 3.0 path-item fragment plus one cURL command per named
// example, so this works for a single endpoint someone is mid-drafting
// without needing a whole exported project.
router.post('/generate-openapi', generateLimiter, async (req, res) => {
  const { endpoint, baseUrl } = req.body || {};
  if (!endpoint || typeof endpoint !== 'object') {
    return res.status(400).json({ error: 'endpoint is required.' });
  }
  try {
    const settings = await loadOrgAiSettings(req.authUser.organisation);
    if (!settings) {
      return res.status(409).json({ error: 'AI isn\'t set up for your organisation yet — ask an Admin to add an API key under Security ▸ AI Studio.' });
    }
    const systemPrompt = `You generate API tooling artifacts from a documented endpoint description. Respond with ONLY a JSON object, no prose, shaped exactly like:
{
  "openapi": { ... },   // a valid OpenAPI 3.0 PATH ITEM object for this one endpoint (the value that would sit under paths["/the/path"]["get"] etc.) — include parameters, requestBody, and responses drawn from what was given
  "curlExamples": [ { "name": string, "command": string } ]  // one or more realistic cURL commands, using ${baseUrl ? JSON.stringify(baseUrl) : '"https://api.example.com"'} as the host, matching any named request examples given; use placeholder values only where no example value exists
}
Use exactly the method, path, params, headers and body shape given — do not invent additional fields.
${JSON_STRICTNESS_RULES}`;
    const text = await callLlm(settings, systemPrompt, JSON.stringify(endpoint), { maxTokens: 3000 });
    const parsed = await extractJson(text, { validate: validateOpenApiShape, settings, label: 'generate-openapi' });
    res.json(parsed);
  } catch (err) {
    console.error('POST /api/ai/generate-openapi failed:', err);
    const described = describeAiError(err);
    res.status(502).json({ error: described.message, errorCode: described.code, retryable: described.retryable });
  }
});

// ==================== Draft notes -> Architecture Studio diagram ====================
// POST /api/ai/generate-architecture
// Body: { rawText }
// Mirrors /structure's job but targets Architecture Studio's canvas model
// (state.nodes / state.edges) instead of the endpoint editor's blocks. The
// model is deliberately NOT asked for pixel coordinates — it has no idea
// what's already on the canvas — only for *icon* (constrained to the
// studio's real icon catalog, so nothing renders as a broken/missing icon)
// and *layer* (its left-to-right rank in the flow). We turn that into an
// actual layered layout server-side, so the diagram always comes back
// tidy regardless of what the model produces.

// Kept as (id, display name) pairs and cross-checked against
// architecture-studio.html's own ICON_DEFS — if that catalog ever changes,
// update this list too, or generated nodes will fall back to a generic icon.
const ARCH_ICON_DEFS = [
  ['client', 'Browser / Client'], ['mobile', 'Mobile App'], ['user', 'User'],
  ['server', 'Server'], ['vm', 'Virtual Machine'], ['lambda', 'Function (Lambda)'], ['container', 'Container'], ['k8s', 'Kubernetes Cluster'],
  ['s3', 'Object Storage (S3)'], ['sql', 'SQL Database'], ['nosql', 'NoSQL Database'], ['cache', 'Cache (Redis)'], ['warehouse', 'Data Warehouse'],
  ['gateway', 'API Gateway'], ['mulesoft', 'Integration Flow'], ['queue', 'Message Queue'], ['kafka', 'Event Stream (Kafka)'], ['webhook', 'Webhook'],
  ['loadbalancer', 'Load Balancer'], ['broker', 'Message Broker (RabbitMQ/SQS)'], ['graphql', 'GraphQL API'], ['grpc', 'gRPC Service'], ['ingress', 'Ingress Controller'],
  ['salesforce', 'Salesforce'], ['slack', 'Slack'], ['stripe', 'Stripe'], ['twilio', 'Twilio'], ['email', 'Email / SES'],
  ['cdn', 'CDN'], ['firewall', 'Firewall'], ['vpn', 'VPN / Shield'], ['dns', 'DNS'], ['auth', 'Auth / Identity'], ['apikey', 'API Key / Secret'],
  ['secretsvault', 'Secrets Vault'], ['waf', 'Web App Firewall'], ['multiregion', 'Multi-Region / DR'],
  ['cicd', 'CI/CD Pipeline'], ['monitoring', 'Monitoring / APM'], ['logs', 'Logging'], ['scheduler', 'Cron / Scheduler'], ['alert', 'Alert / Incident'],
  ['servicemesh', 'Service Mesh'], ['terraform', 'Infrastructure as Code'], ['featureflag', 'Feature Flags'],
  ['etl', 'ETL / Data Pipeline'], ['datalake', 'Data Lake'], ['analytics', 'Analytics Dashboard'], ['search', 'Search Index'],
  ['elasticsearch', 'Search Engine (Elasticsearch)'], ['blobstorage', 'Blob Storage (GCS/Azure)'],
  ['cloud', 'Cloud (generic)'], ['process', 'Process'], ['decision', 'Decision'], ['actor', 'Actor / Person'],
  ['externalsystem', 'External System'], ['datastore', 'Generic Data Store'],
];
const ARCH_ICON_IDS = new Set(ARCH_ICON_DEFS.map(([id]) => id));
const ARCH_ICON_CATALOG_TEXT = ARCH_ICON_DEFS.map(([id, name]) => `${id} — ${name}`).join('\n');
const ARCH_ICON_FALLBACK = 'externalsystem';

// Matches architecture-studio.html's defaultSize('icon') exactly, so
// generated nodes are pixel-identical in size to hand-placed ones.
const ARCH_NODE_W = 132;
const ARCH_NODE_H = 92;
const ARCH_COL_GAP = 240;
const ARCH_ROW_GAP = 150;
const ARCH_MAX_NODES = 40;
const ARCH_MAX_EDGES = 80;

function slugifyArchId(raw, fallbackIndex) {
  const slug = String(raw || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || `node-${fallbackIndex}`;
}

// Turns the model's { id, icon, label, layer } list — with no positions —
// into a real layered left-to-right layout: nodes are grouped by layer,
// stacked vertically within it, and each layer is centered against the
// tallest column so the whole diagram reads as one balanced composition
// rather than top-aligned columns of differing heights.
function layoutArchitecture(nodesIn, edgesIn) {
  const seenIds = new Set();
  const nodes = [];
  (Array.isArray(nodesIn) ? nodesIn : []).slice(0, ARCH_MAX_NODES).forEach((n, i) => {
    if (!n || typeof n !== 'object') return;
    let id = slugifyArchId(n.id, i);
    while (seenIds.has(id)) id = `${id}-${i}`;
    seenIds.add(id);
    const icon = ARCH_ICON_IDS.has(n.icon) ? n.icon : ARCH_ICON_FALLBACK;
    const label = (typeof n.label === 'string' && n.label.trim()) || id.replace(/-/g, ' ');
    const layer = Number.isFinite(n.layer) ? Math.max(0, Math.round(n.layer)) : 0;
    nodes.push({ id, icon, label, layer });
  });

  // Remap layer numbers to a contiguous 0..k-1 range (the model might say
  // "0, 1, 4" for a 3-stage flow) so column spacing stays even.
  const distinctLayers = [...new Set(nodes.map(n => n.layer))].sort((a, b) => a - b);
  const layerRank = new Map(distinctLayers.map((l, i) => [l, i]));
  const byLayer = new Map();
  nodes.forEach(n => {
    const rank = layerRank.get(n.layer);
    n._rank = rank;
    if (!byLayer.has(rank)) byLayer.set(rank, []);
    byLayer.get(rank).push(n);
  });
  const maxColumnCount = Math.max(1, ...[...byLayer.values()].map(col => col.length));

  const positioned = nodes.map(n => {
    const col = byLayer.get(n._rank);
    const indexInCol = col.indexOf(n);
    const verticalOffset = ((maxColumnCount - col.length) * ARCH_ROW_GAP) / 2;
    return {
      id: n.id,
      icon: n.icon,
      label: n.label,
      layer: n._rank,
      x: n._rank * ARCH_COL_GAP,
      y: verticalOffset + indexInCol * ARCH_ROW_GAP,
      w: ARCH_NODE_W,
      h: ARCH_NODE_H,
    };
  });

  const rankById = new Map(positioned.map(n => [n.id, n.layer]));
  const validIds = new Set(positioned.map(n => n.id));
  const seenEdgeKeys = new Set();
  const edges = [];
  (Array.isArray(edgesIn) ? edgesIn : []).slice(0, ARCH_MAX_EDGES * 2).forEach(e => {
    if (!e || typeof e !== 'object') return;
    const from = slugifyArchId(e.from, -1);
    const to = slugifyArchId(e.to, -1);
    if (from === to || !validIds.has(from) || !validIds.has(to)) return;
    const key = `${from}>${to}`;
    if (seenEdgeKeys.has(key) || edges.length >= ARCH_MAX_EDGES) return;
    seenEdgeKeys.add(key);
    const fromRank = rankById.get(from), toRank = rankById.get(to);
    const [fromSide, toSide] = toRank > fromRank ? ['right', 'left'] : toRank < fromRank ? ['left', 'right'] : ['bottom', 'top'];
    edges.push({ from, to, fromSide, toSide, label: (typeof e.label === 'string' ? e.label.trim().slice(0, 60) : '') });
  });

  return { nodes: positioned, edges };
}

router.post('/generate-architecture', generateLimiter, async (req, res) => {
  const { rawText } = req.body || {};
  if (typeof rawText !== 'string' || !rawText.trim()) {
    return res.status(400).json({ error: 'rawText is required.' });
  }
  if (rawText.length > 200000) {
    return res.status(400).json({ error: 'That text is too long for a single pass (200,000 character limit) — try splitting it up.' });
  }
  try {
    const settings = await loadOrgAiSettings(req.authUser.organisation);
    if (!settings) {
      return res.status(409).json({ error: 'AI isn\'t set up for your organisation yet — ask an Admin to add an API key under Security ▸ AI Studio.' });
    }
    const systemPrompt = `You convert raw notes (a spec, meeting notes, a description of a flow — in any order, any format) into the components and connections of a system architecture diagram.
Respond with ONLY a JSON object, no prose, no markdown fences, shaped exactly like:
{
  "nodes": [
    { "id": string, "icon": string, "label": string, "layer": integer }
  ],
  "edges": [
    { "from": string, "to": string, "label": string }
  ]
}
Rules:
- "id" is a short, unique, kebab-case slug you make up per node (e.g. "mobile-app", "auth-service") — used only to wire up edges, never shown.
- "icon" MUST be exactly one of these catalog ids (pick the closest real match; use "externalsystem" only when truly nothing else fits):
${ARCH_ICON_CATALOG_TEXT}
- "label" is a short human-readable name for that specific component (2-4 words), not the catalog name verbatim unless it genuinely is that generic.
- "layer" is the component's left-to-right rank in the flow: 0 for where the flow starts (a client, a trigger, an inbound request), increasing by 1 for each hop deeper into the system. Give two components the same layer only if they genuinely happen in parallel at that stage.
- "edges[].label" should be short and concrete when the notes support it (an HTTP verb+path, an event/topic name, "sync"/"async") — empty string if nothing concrete is stated.
- Only include components and connections the notes actually describe or clearly imply — do not pad the diagram with generic infrastructure (load balancers, CDNs, monitoring, etc.) that wasn't mentioned or reasonably implied.
${JSON_STRICTNESS_RULES}`;
    const text = await callLlm(settings, systemPrompt, rawText, { maxTokens: 3000 });
    const rawParsed = await extractJson(text, { validate: validateArchitectureShape, settings, label: 'generate-architecture' });
    const { nodes, edges } = layoutArchitecture(rawParsed.nodes, rawParsed.edges);
    if (nodes.length === 0) {
      return res.status(502).json({ error: 'The AI couldn\'t identify any components in that text — try adding more detail about the services involved.', errorCode: 'empty', retryable: false });
    }
    await recordAuditEvent(req.authUser, req, {
      action: 'ai.architecture.generated',
      resourceType: 'ai',
      details: `Generated ${nodes.length} node(s) and ${edges.length} edge(s) from ${rawText.length} chars of input`,
      severity: 'info',
    });
    res.json({ nodes, edges });
  } catch (err) {
    console.error('POST /api/ai/generate-architecture failed:', err);
    const described = describeAiError(err);
    res.status(502).json({ error: described.message, errorCode: described.code, retryable: described.retryable });
  }
});

module.exports = router;
