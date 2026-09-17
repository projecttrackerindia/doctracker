const express = require('express');
const { pool } = require('../db');
const { authenticate, requireAdmin, blockIfScheduleLocked } = require('../middleware/authGuard');
const { recordAuditEvent } = require('../auditService');
const { createRateLimiter } = require('../rateLimitStore');
const workspace = require('./workspace');

const router = express.Router();
router.use(authenticate);
router.use(blockIfScheduleLocked);

// Tight — a real workflow reveals a handful of times per session, not
// dozens; matches the caution already applied to Live Mode/AI generation.
const revealLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many reveal requests — please slow down.' },
});

const MATCH_MODES = ['exact', 'case_insensitive', 'nested', 'regex'];
const CATEGORIES = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PII', 'SENSITIVE_PII', 'FINANCIAL', 'AUTHENTICATION_SECRET'];
const STRATEGIES = ['full', 'last2', 'last4', 'first2last2', 'email', 'secret', 'partial'];
const DEFAULT_SETTINGS = {
  automaticProtection: true,
  revealTimeoutSeconds: 60,
  environmentPolicy: { PROD: 'strict', PREPROD: 'strict', UAT: 'mask', SIT: 'mask', DEV: 'configurable' },
  surfaces: { params: true, headers: true, body: true, pdfExport: true },
};

function ruleRowToClient(r) {
  return {
    id: r.id,
    fieldName: r.field_name,
    matchMode: r.match_mode,
    category: r.category,
    maskingStrategy: r.masking_strategy,
    charsToKeep: r.chars_to_keep,
    maskChar: r.mask_char,
    applyTo: r.apply_to,
    environments: r.environments,
    enabled: r.enabled,
    updatedAt: r.updated_at,
  };
}

// HYGIENE (finding 6f — ReDoS blast radius): a `regex` rule's pattern is
// compiled and *executed client-side, in every viewer's browser* that views
// masked docs (see public/js/studio/03-notifications.js), not just the
// authoring Admin's. `new RegExp(...)` here only proves the pattern
// compiles, not that it's safe to run — a catastrophic-backtracking pattern
// (e.g. `(a+)+$`, `(a|a)*$`, `(.*)+$`) would hang every other viewer's tab,
// not just the Admin's own.
//
// This is a heuristic defense-in-depth check, not a formal proof of safety
// (that would need a linear-time engine like RE2, or executing untrusted
// patterns in a worker with a hard wall-clock kill switch) — it: (a)
// statically rejects the well-known nested-quantifier shapes that cause
// catastrophic backtracking, and (b) actually runs the compiled pattern
// against a handful of short adversarial probe strings and rejects it if
// any single probe takes too long. Between the two, this catches the
// realistic cases (including copy-pasted "here's a ReDoS pattern" examples)
// without needing new infrastructure.
const REDOS_SHAPE_RE = /\([^()]*[+*]\)[+*]|\([^()]*\|[^()]*\)[+*][?]?\{|\(\.[*+][^()]*\)[+*]/;
const REDOS_PROBE_STRINGS = ['a'.repeat(24), 'a'.repeat(24) + '!', ' '.repeat(24)];
const REDOS_PROBE_BUDGET_MS = 50;

function regexRedosError(pattern) {
  if (REDOS_SHAPE_RE.test(pattern)) {
    return 'This pattern uses a nested repetition shape known to cause catastrophic backtracking (e.g. (a+)+). Rewrite it to avoid nested quantifiers.';
  }
  let re;
  try { re = new RegExp(pattern); } catch (e) { return 'fieldName is not a valid regular expression.'; }
  for (const probe of REDOS_PROBE_STRINGS) {
    const start = Date.now();
    try { re.test(probe); } catch (e) { /* ignore — a slow/failing test is caught by the timing check below anyway */ }
    if (Date.now() - start > REDOS_PROBE_BUDGET_MS) {
      return 'This pattern is too slow against short test input and could hang other viewers\u2019 browsers. Please simplify it.';
    }
  }
  return null;
}

function validateRuleBody(body) {
  if (!body || typeof body.fieldName !== 'string' || !body.fieldName.trim()) {
    return 'fieldName is required.';
  }
  if (body.fieldName.length > 200) return 'fieldName is too long.';
  if (body.matchMode && !MATCH_MODES.includes(body.matchMode)) return 'Invalid matchMode.';
  if (body.category && !CATEGORIES.includes(body.category)) return 'Invalid category.';
  if (body.maskingStrategy && !STRATEGIES.includes(body.maskingStrategy)) return 'Invalid maskingStrategy.';
  if (body.charsToKeep != null && (typeof body.charsToKeep !== 'number' || body.charsToKeep < 0 || body.charsToKeep > 20)) {
    return 'charsToKeep must be a number between 0 and 20.';
  }
  if (body.matchMode === 'regex') {
    const redosError = regexRedosError(body.fieldName);
    if (redosError) return redosError;
  }
  return null;
}

// GET /api/pii — rules + settings for the caller's organisation. Every
// signed-in member can read this (they need it client-side to render masked
// tables); only Admins can write it.
router.get('/', async (req, res) => {
  try {
    const org = req.authUser.organisation;
    const [rulesResult, settingsResult] = await Promise.all([
      pool.query(`SELECT * FROM pii_field_rules WHERE organisation = $1 ORDER BY created_at ASC`, [org]),
      pool.query(`SELECT pii_settings FROM org_workspace WHERE organisation = $1`, [org]),
    ]);
    const settings = settingsResult.rows[0]?.pii_settings || DEFAULT_SETTINGS;
    res.json({ rules: rulesResult.rows.map(ruleRowToClient), settings });
  } catch (err) {
    console.error('GET /api/pii failed:', err);
    // Fail closed: if the config can't be loaded, the client falls back to its
    // own built-in rules rather than showing raw values, so a 500 here is safe —
    // but we still want the caller to know the fetch itself failed.
    res.status(500).json({ error: 'Could not load PII masking configuration.' });
  }
});

// PUT /api/pii/settings — Admin only.
router.put('/settings', requireAdmin, async (req, res) => {
  const body = req.body || {};
  const next = {
    automaticProtection: body.automaticProtection !== false,
    revealTimeoutSeconds: Number.isFinite(body.revealTimeoutSeconds)
      ? Math.max(10, Math.min(3600, Math.round(body.revealTimeoutSeconds)))
      : DEFAULT_SETTINGS.revealTimeoutSeconds,
    environmentPolicy: { ...DEFAULT_SETTINGS.environmentPolicy, ...(body.environmentPolicy || {}) },
    surfaces: { ...DEFAULT_SETTINGS.surfaces, ...(body.surfaces || {}) },
  };
  try {
    await pool.query(
      `INSERT INTO org_workspace (organisation, pii_settings, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (organisation) DO UPDATE SET pii_settings = EXCLUDED.pii_settings, updated_at = now()`,
      [req.authUser.organisation, JSON.stringify(next)]
    );
    await recordAuditEvent(req.authUser, req, {
      action: 'ADMIN_SETTING_CHANGED',
      resourceType: 'pii_settings',
      details: 'Updated PII & data masking settings',
      severity: 'warning',
      metadata: { automaticProtection: next.automaticProtection, revealTimeoutSeconds: next.revealTimeoutSeconds },
    });
    res.json({ ok: true, settings: next });
  } catch (err) {
    console.error('PUT /api/pii/settings failed:', err);
    res.status(500).json({ error: 'Could not save settings.' });
  }
});

// POST /api/pii/rules — Admin only.
router.post('/rules', requireAdmin, async (req, res) => {
  const body = req.body || {};
  const invalid = validateRuleBody(body);
  if (invalid) return res.status(400).json({ error: invalid });
  try {
    const { rows } = await pool.query(
      `INSERT INTO pii_field_rules
        (organisation, field_name, match_mode, category, masking_strategy, chars_to_keep, mask_char, apply_to, environments, enabled, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        req.authUser.organisation,
        body.fieldName.trim(),
        body.matchMode || 'case_insensitive',
        body.category || 'PII',
        body.maskingStrategy || 'partial',
        body.charsToKeep != null ? body.charsToKeep : 4,
        (body.maskChar || '*').slice(0, 1) || '*',
        JSON.stringify(Array.isArray(body.applyTo) ? body.applyTo : ['params', 'headers', 'body', 'pdfExport']),
        JSON.stringify(Array.isArray(body.environments) ? body.environments : ['PROD', 'PREPROD', 'UAT', 'SIT', 'DEV']),
        body.enabled !== false,
        req.authUser.sub,
      ]
    );
    await recordAuditEvent(req.authUser, req, {
      action: 'PII_MASK_RULE_CREATED',
      resourceType: 'pii_rule',
      resourceId: String(rows[0].id),
      entityName: rows[0].field_name,
      details: `Added sensitive-field rule "${rows[0].field_name}" (${rows[0].category})`,
      severity: 'warning',
    });
    res.json({ ok: true, rule: ruleRowToClient(rows[0]) });
  } catch (err) {
    console.error('POST /api/pii/rules failed:', err);
    res.status(500).json({ error: 'Could not create rule.' });
  }
});

// PUT /api/pii/rules/:id — Admin only, scoped to caller's organisation.
router.put('/rules/:id', requireAdmin, async (req, res) => {
  const body = req.body || {};
  const invalid = validateRuleBody(body);
  if (invalid) return res.status(400).json({ error: invalid });
  try {
    const { rows } = await pool.query(
      `UPDATE pii_field_rules SET
        field_name = $1, match_mode = $2, category = $3, masking_strategy = $4,
        chars_to_keep = $5, mask_char = $6, apply_to = $7, environments = $8, enabled = $9, updated_at = now()
       WHERE id = $10 AND organisation = $11 RETURNING *`,
      [
        body.fieldName.trim(),
        body.matchMode || 'case_insensitive',
        body.category || 'PII',
        body.maskingStrategy || 'partial',
        body.charsToKeep != null ? body.charsToKeep : 4,
        (body.maskChar || '*').slice(0, 1) || '*',
        JSON.stringify(Array.isArray(body.applyTo) ? body.applyTo : ['params', 'headers', 'body', 'pdfExport']),
        JSON.stringify(Array.isArray(body.environments) ? body.environments : ['PROD', 'PREPROD', 'UAT', 'SIT', 'DEV']),
        body.enabled !== false,
        req.params.id,
        req.authUser.organisation,
      ]
    );
    if (!rows.length) return res.status(404).json({ error: 'Rule not found.' });
    await recordAuditEvent(req.authUser, req, {
      action: 'PII_MASK_RULE_UPDATED',
      resourceType: 'pii_rule',
      resourceId: String(rows[0].id),
      entityName: rows[0].field_name,
      details: `Updated sensitive-field rule "${rows[0].field_name}"`,
      severity: 'warning',
    });
    res.json({ ok: true, rule: ruleRowToClient(rows[0]) });
  } catch (err) {
    console.error('PUT /api/pii/rules/:id failed:', err);
    res.status(500).json({ error: 'Could not update rule.' });
  }
});

// DELETE /api/pii/rules/:id — Admin only, scoped to caller's organisation.
router.delete('/rules/:id', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `DELETE FROM pii_field_rules WHERE id = $1 AND organisation = $2 RETURNING field_name`,
      [req.params.id, req.authUser.organisation]
    );
    if (!rows.length) return res.status(404).json({ error: 'Rule not found.' });
    await recordAuditEvent(req.authUser, req, {
      action: 'PII_MASK_RULE_DELETED',
      resourceType: 'pii_rule',
      resourceId: String(req.params.id),
      entityName: rows[0].field_name,
      details: `Removed sensitive-field rule "${rows[0].field_name}"`,
      severity: 'warning',
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/pii/rules/:id failed:', err);
    res.status(500).json({ error: 'Could not delete rule.' });
  }
});

// POST /api/pii/reveal/:projectId — Admin-only, audited unmask.
//
// SECURITY (Finding 4.2): this is now the ONLY path that ever returns real,
// unmasked example values — GET /api/workspace, /snapshot and /diff all mask
// unconditionally (see server/piiMasking.js). This mirrors the client's
// existing "reveal" UX (Admin role + a reason, auto-remasks client-side after
// PII_CONFIG.settings.revealTimeoutSeconds) but the authorization and the
// audit trail are both enforced here, server-side, instead of being a purely
// client-side flag with a self-reported audit event.
router.post('/reveal/:projectId', revealLimiter, requireAdmin, async (req, res) => {
  try {
    const { environmentId } = req.body || {};
    const reason = typeof (req.body && req.body.reason) === 'string' ? req.body.reason.trim() : '';
    if (!environmentId) return res.status(400).json({ error: 'environmentId is required.' });
    if (!reason) return res.status(400).json({ error: 'A reason is required to reveal sensitive values.' });
    if (reason.length > 300) return res.status(400).json({ error: 'Reason is too long.' });

    const { rows } = await pool.query(
      `SELECT id, owner_id, organisation, visibility, has_public_endpoint, data, data_enc
       FROM projects WHERE id = $1`,
      [req.params.projectId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Project not found.' });
    const project = rows[0];
    if (project.organisation !== req.authUser.organisation) return res.status(404).json({ error: 'Project not found.' });

    const userId = req.authUser.sub;
    const isOwner = project.owner_id === userId;
    let grant = null;
    if (!isOwner) {
      const { rows: grantRows } = await pool.query(
        `SELECT environments, permission FROM project_access WHERE project_id = $1 AND user_id = $2`,
        [project.id, userId]
      );
      if (grantRows.length) grant = grantRows[0];
    }
    if (!isOwner && !grant && project.visibility !== 'public' && !project.has_public_endpoint) {
      return res.status(404).json({ error: 'Project not found.' });
    }
    if (grant) {
      const envs = Array.isArray(grant.environments) ? grant.environments : [];
      if (!envs.includes('*') && !envs.includes(environmentId)) {
        return res.status(403).json({ error: 'You do not have access to this environment for this project.' });
      }
    }

    const allEnvs = await workspace.getOrgEnvironments(project.organisation);
    const stages = workspace.pipelineStages(allEnvs);
    const idx = stages.findIndex((e) => e.id === environmentId);
    if (idx < 0) return res.status(400).json({ error: 'Unknown environment.' });

    const stageData = await workspace.loadStageData(project, environmentId, idx);
    let endpoints = Array.isArray(stageData.endpoints) ? stageData.endpoints : [];

    // Same visibility narrowing as the masked read paths — reveal makes
    // masked fields visible, it doesn't grant access to endpoints the
    // caller couldn't otherwise see at all.
    if (!isOwner && !grant) {
      endpoints = endpoints.filter((ep) => ep && ep.visibility === 'public');
      if (endpoints.length && !workspace.userHasFullDocAccess(req.authUser)) {
        const accessMap = await workspace.getDocAccessMap(project.organisation, userId, project.id, endpoints.map((e) => e.id), environmentId);
        endpoints = endpoints.map((ep) => workspace.applyDocLock(ep, accessMap.get(ep.id)));
      }
    }

    await recordAuditEvent(req.authUser, req, {
      action: 'PII_REVEAL',
      resourceType: 'project',
      resourceId: String(project.id),
      environment: environmentId,
      details: `Revealed sensitive values — ${reason}`,
      severity: 'warning',
    });

    res.json({ ok: true, environmentId, endpoints });
  } catch (err) {
    console.error('POST /api/pii/reveal/:projectId failed:', err);
    res.status(500).json({ error: 'Could not reveal sensitive values.' });
  }
});

module.exports = router;
