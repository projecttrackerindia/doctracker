const express = require('express');
const { pool } = require('../db');
const { authenticate, requireAdmin } = require('../middleware/authGuard');
const { recordAuditEvent } = require('../auditService');

const router = express.Router();
router.use(authenticate);

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
    try { new RegExp(body.fieldName); } catch (e) { return 'fieldName is not a valid regular expression.'; }
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

module.exports = router;
