const express = require('express');
const { authenticate, requireAdmin } = require('../middleware/authGuard');
const engine = require('../alertEngine');
const { recordAuditEvent } = require('../auditService');

const router = express.Router();
router.use(authenticate);

// Reading what is currently firing is NOT an Admin-only act: an alert exists
// to be seen, and an engineer who cannot see it has to ask an Admin what is
// wrong, which is the situation this whole feature exists to remove. Only
// CHANGING the rules is restricted, because a threshold is a policy decision
// and a silenced rule is indistinguishable from a healthy system.
router.get('/', async (req, res) => {
  try {
    const org = req.authUser.organisation;
    // Seeded on first read rather than at signup, so organisations that
    // existed before alerting shipped get the starter set too. It is a no-op
    // once any rule has ever been created for them.
    if (req.authUser.role === 'admin') await engine.seedDefaultRules(org, req.authUser.username);
    const [rules, settings, active] = await Promise.all([
      engine.listRules(org),
      engine.getSettings(org),
      engine.currentAlerts(org),
    ]);
    res.json({
      rules,
      settings,
      active,
      // The catalogue travels with the response so the UI's rule editor
      // cannot drift out of step with what the engine will actually accept.
      metrics: Object.entries(engine.METRICS).map(([key, m]) => ({
        key, label: m.label, unit: m.unit, kind: m.kind, help: m.help,
      })),
      canEdit: req.authUser.role === 'admin',
    });
  } catch (err) {
    console.error('GET /api/workspace/alerts failed:', err);
    res.status(500).json({ error: 'Could not load alert configuration.' });
  }
});

// Acknowledging is deliberately NOT requireAdmin, unlike every route below -
// it says "a person has seen this and is on it", not "change what fires".
// Gating it to Admins would mean the engineer actually responding to an
// incident cannot mark it as theirs. It only touches a FIRING row (a
// pending one has notified nobody yet); acknowledging never hides the row,
// stops re-evaluation, or suppresses the next re-notify - it only drops the
// row out of the tab badge, and clears itself the moment this incident
// resolves or a fresh one starts (see applyState() in alertEngine.js).
router.post('/active/acknowledge', async (req, res) => {
  const { ruleId, environment, endpointId } = req.body || {};
  if (!ruleId || typeof environment !== 'string' || !environment.trim()) {
    return res.status(400).json({ error: 'ruleId and environment are required.' });
  }
  try {
    const org = req.authUser.organisation;
    const ok = await engine.acknowledgeAlert(org, ruleId, environment, endpointId || null, req.authUser.username);
    if (!ok) return res.status(404).json({ error: 'No firing alert matches that rule/environment/endpoint.' });
    const active = await engine.currentAlerts(org);
    const target = active.find((a) => a.ruleId === String(ruleId) && a.environment === environment
      && (a.endpointId || null) === (endpointId || null));
    await recordAuditEvent(req.authUser, req, {
      action: 'ALERT_ACKNOWLEDGED',
      resourceType: 'alert_state',
      resourceId: String(ruleId),
      entityName: target ? target.name : null,
      details: `Acknowledged "${target ? target.name : ruleId}" in ${environment}`
        + (endpointId ? ` (endpoint ${endpointId})` : ''),
      severity: 'info',
    });
    res.json({ active });
  } catch (err) {
    console.error('POST /api/workspace/alerts/active/acknowledge failed:', err);
    res.status(500).json({ error: 'Could not acknowledge the alert.' });
  }
});

router.put('/settings', requireAdmin, async (req, res) => {
  try {
    const settings = await engine.saveSettings(req.authUser.organisation, req.body || {});
    await recordAuditEvent(req.authUser, req, {
      action: 'ADMIN_SETTING_CHANGED',
      resourceType: 'alert_settings',
      details: `Alerting ${settings.enabled ? 'enabled' : 'DISABLED'}`
        + (settings.quietHours.enabled ? `, quiet hours on (${settings.quietHours.timezone})` : ''),
      severity: 'warning',
      metadata: { enabled: settings.enabled, quietHours: settings.quietHours.enabled },
    });
    res.json({ settings });
  } catch (err) {
    console.error('PUT /api/workspace/alerts/settings failed:', err);
    res.status(500).json({ error: 'Could not save alert settings.' });
  }
});

router.post('/rules', requireAdmin, async (req, res) => {
  try {
    const rule = await engine.createRule(req.authUser.organisation, req.body || {}, req.authUser.username);
    await recordAuditEvent(req.authUser, req, {
      action: 'ALERT_RULE_CREATED',
      resourceType: 'alert_rule',
      resourceId: rule.id,
      entityName: rule.name,
      details: `Added alert "${rule.name}" — ${rule.metric} ${rule.comparison} ${rule.threshold}`,
      severity: 'warning',
    });
    res.status(201).json({ rule });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error('POST /api/workspace/alerts/rules failed:', err);
    res.status(500).json({ error: 'Could not create the alert rule.' });
  }
});

router.put('/rules/:id', requireAdmin, async (req, res) => {
  try {
    const rule = await engine.updateRule(
      req.authUser.organisation, req.params.id, req.body || {}, req.authUser.username
    );
    await recordAuditEvent(req.authUser, req, {
      action: 'ALERT_RULE_UPDATED',
      resourceType: 'alert_rule',
      resourceId: rule.id,
      entityName: rule.name,
      // Disabling a rule is the change most worth being able to find later:
      // a silenced alert and a healthy system look identical from outside.
      details: `"${rule.name}" — ${rule.enabled ? 'enabled' : 'DISABLED'}, `
        + `${rule.metric} ${rule.comparison} ${rule.threshold}`,
      severity: rule.enabled ? 'warning' : 'critical',
    });
    res.json({ rule });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    if (err.status === 404) return res.status(404).json({ error: err.message });
    console.error('PUT /api/workspace/alerts/rules/:id failed:', err);
    res.status(500).json({ error: 'Could not update the alert rule.' });
  }
});

router.delete('/rules/:id', requireAdmin, async (req, res) => {
  try {
    const rules = await engine.listRules(req.authUser.organisation);
    const existing = rules.find((r) => r.id === String(req.params.id));
    const ok = await engine.deleteRule(req.authUser.organisation, req.params.id);
    if (!ok) return res.status(404).json({ error: 'No such alert rule.' });
    await recordAuditEvent(req.authUser, req, {
      action: 'ALERT_RULE_DELETED',
      resourceType: 'alert_rule',
      resourceId: String(req.params.id),
      entityName: existing ? existing.name : null,
      details: `Deleted alert rule "${existing ? existing.name : req.params.id}"`,
      severity: 'critical',
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/workspace/alerts/rules/:id failed:', err);
    res.status(500).json({ error: 'Could not delete the alert rule.' });
  }
});

// "Evaluate now" — so an Admin who has just written a rule can see what it
// does against real data instead of waiting up to a minute and guessing.
router.post('/evaluate', requireAdmin, async (req, res) => {
  try {
    const result = await engine.evaluateOrganisation(req.authUser.organisation, { includeAbsence: true });
    const active = await engine.currentAlerts(req.authUser.organisation);
    res.json({ ...result, active });
  } catch (err) {
    console.error('POST /api/workspace/alerts/evaluate failed:', err);
    res.status(500).json({ error: 'Could not evaluate alert rules.' });
  }
});

module.exports = router;
