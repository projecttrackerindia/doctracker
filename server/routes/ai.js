const express = require('express');
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

function aad(organisation) {
  return `ai:${organisation}`;
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
  // Unrecognized failure — still give something diagnosable rather than a flat "it failed".
  return { code: 'unknown', retryable: true, message: `The AI request failed: ${msg.slice(0, 200)}` };
}

// Every prompt below asks for JSON-only output; models occasionally still
// wrap it in ```json fences or add a stray sentence, so this strips both
// before parsing instead of trusting the raw string.
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  const jsonSlice = start !== -1 && end !== -1 ? candidate.slice(start, end + 1) : candidate;
  return JSON.parse(jsonSlice);
}

// ==================== Draft / upload -> structured documentation ====================
// POST /api/ai/structure
// Body: { rawText, audience }  audience: 'business' | 'technical' | 'both' (default)
// Takes completely freeform notes — a BRD paragraph, a technical spec dump,
// meeting notes, whatever the person actually has — and turns it into the
// editor's block model: a title/summary, and a list of { type, title,
// content } blocks. `type` is intentionally NOT restricted to the app's
// built-in block types — the model can emit any short slug it wants
// ("business-context", "risk", "sla", "sample-payload"...) and the editor's
// "custom" block renders it as free-form markdown, so nothing about the
// output shape constrains what kind of documentation this can produce.
router.post('/structure', generateLimiter, async (req, res) => {
  const { rawText, audience } = req.body || {};
  if (typeof rawText !== 'string' || !rawText.trim()) {
    return res.status(400).json({ error: 'rawText is required.' });
  }
  if (rawText.length > 60000) {
    return res.status(400).json({ error: 'That text is too long for a single pass — try splitting it up.' });
  }
  try {
    const settings = await loadOrgAiSettings(req.authUser.organisation);
    if (!settings) {
      return res.status(409).json({ error: 'AI isn\'t set up for your organisation yet — ask an Admin to add an API key under Security ▸ AI Studio.' });
    }
    const audienceLine = audience === 'business'
      ? 'Write for a business/BRD reader: plain language, purpose, business rules, no jargon.'
      : audience === 'technical'
        ? 'Write for a technical/engineering reader: precise, implementation-level detail.'
        : 'Write so both a business (BRD) reader and a technical/engineering reader get what they each need — separate blocks for each angle rather than blending them.';
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
Infer missing pieces sensibly from context rather than leaving fields empty; if something genuinely isn't present in the notes, use a short honest placeholder instead of inventing specifics.`;
    const text = await callLlm(settings, systemPrompt, rawText, { maxTokens: 4000 });
    const parsed = extractJson(text);
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

// ==================== Structured endpoint -> OpenAPI + cURL ====================
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
Use exactly the method, path, params, headers and body shape given — do not invent additional fields.`;
    const text = await callLlm(settings, systemPrompt, JSON.stringify(endpoint), { maxTokens: 3000 });
    const parsed = extractJson(text);
    res.json(parsed);
  } catch (err) {
    console.error('POST /api/ai/generate-openapi failed:', err);
    const described = describeAiError(err);
    res.status(502).json({ error: described.message, errorCode: described.code, retryable: described.retryable });
  }
});

module.exports = router;
