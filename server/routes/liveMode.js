const express = require('express');
const { pool } = require('../db');
const { authenticate, requireAdmin, blockIfScheduleLocked } = require('../middleware/authGuard');
const { recordAuditEvent } = require('../auditService');
const { createRateLimiter } = require('../rateLimitStore');
const { decryptProjectData, getOrgEnvironments } = require('./workspace');

const router = express.Router();
router.use(authenticate);
router.use(blockIfScheduleLocked);

// A real outbound call is a fundamentally bigger blast radius than viewing
// masked docs — this limiter is deliberately tighter than the rest of the
// API, per user, so Live mode can't become an accidental load test (or a way
// to hammer a real payment gateway) even for someone with a legitimate grant.
const liveCallLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `live:${req.authUser.sub}`,
  message: { error: 'Too many live requests — please wait a moment before trying again.' },
});

async function loadGrants(org) {
  const { rows } = await pool.query(`SELECT live_mode_grants FROM org_workspace WHERE organisation = $1`, [org]);
  return rows[0]?.live_mode_grants || {};
}

// GET /api/live-mode/my-access — which environments the CALLER may go live
// against. Every signed-in user can read their own; Try It uses this to
// decide whether to show the Live toggle at all.
router.get('/my-access', async (req, res) => {
  try {
    const grants = await loadGrants(req.authUser.organisation);
    res.json({ environments: grants[String(req.authUser.sub)] || [] });
  } catch (err) {
    console.error('GET /api/live-mode/my-access failed:', err);
    res.status(500).json({ error: 'Could not load Live mode access.' });
  }
});

// GET /api/live-mode/grants — Admin only. Full per-user grant matrix plus the
// org's user list and environment catalog, for Security ▸ Live Mode Access.
router.get('/grants', requireAdmin, async (req, res) => {
  try {
    const org = req.authUser.organisation;
    const [grants, usersResult, environments] = await Promise.all([
      loadGrants(org),
      pool.query(`SELECT id, username, role FROM users WHERE organisation = $1 ORDER BY username ASC`, [org]),
      getOrgEnvironments(org),
    ]);
    res.json({ grants, users: usersResult.rows, environments });
  } catch (err) {
    console.error('GET /api/live-mode/grants failed:', err);
    res.status(500).json({ error: 'Could not load Live mode grants.' });
  }
});

// PUT /api/live-mode/grants — Admin only. Body: { grants: { "<userId>": ["DEV",...] } }.
// Silently drops any user id or environment id that isn't actually valid for
// this organisation, rather than rejecting the whole save over one stale entry.
router.put('/grants', requireAdmin, async (req, res) => {
  const org = req.authUser.organisation;
  const incoming = req.body?.grants;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return res.status(400).json({ error: 'grants must be an object keyed by user id.' });
  }
  try {
    const [validEnvironments, userRows] = await Promise.all([
      getOrgEnvironments(org),
      pool.query(`SELECT id FROM users WHERE organisation = $1`, [org]),
    ]);
    const validEnvIds = new Set(validEnvironments.map((e) => e.id));
    const validUserIds = new Set(userRows.rows.map((r) => String(r.id)));

    const clean = {};
    Object.entries(incoming).forEach(([userId, envIds]) => {
      if (!validUserIds.has(String(userId)) || !Array.isArray(envIds)) return;
      const filtered = envIds.filter((e) => validEnvIds.has(e));
      if (filtered.length) clean[String(userId)] = filtered;
    });

    await pool.query(
      `INSERT INTO org_workspace (organisation, live_mode_grants, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (organisation) DO UPDATE SET live_mode_grants = EXCLUDED.live_mode_grants, updated_at = now()`,
      [org, JSON.stringify(clean)]
    );
    await recordAuditEvent(req.authUser, req, {
      action: 'LIVE_MODE_GRANTS_UPDATED',
      resourceType: 'live_mode_grants',
      details: 'Updated Live mode environment access',
      severity: 'warning',
      metadata: { grants: clean },
    });
    res.json({ grants: clean });
  } catch (err) {
    console.error('PUT /api/live-mode/grants failed:', err);
    res.status(500).json({ error: 'Could not save Live mode grants.' });
  }
});

// POST /api/live-mode/send — the actual outbound call.
// Body: { projectId, endpointId, environmentId, pathParams, queryParams, headers, body }
// The target HOST is always resolved server-side from the project's own
// stored environment config; the client only ever supplies path-param
// VALUES, query values, headers and body — never a URL or host — so a
// crafted request can't turn this into an open proxy to an arbitrary address.
router.post('/send', liveCallLimiter, async (req, res) => {
  const { projectId, endpointId, environmentId } = req.body || {};
  if (!projectId || !endpointId || !environmentId) {
    return res.status(400).json({ error: 'projectId, endpointId and environmentId are required.' });
  }
  try {
    const org = req.authUser.organisation;
    const userId = req.authUser.sub;

    const grants = await loadGrants(org);
    const allowedEnvs = grants[String(userId)] || [];
    if (!allowedEnvs.includes(environmentId)) {
      await recordAuditEvent(req.authUser, req, {
        action: 'LIVE_MODE_CALL_DENIED',
        resourceType: 'endpoint',
        resourceId: String(endpointId),
        environment: environmentId,
        result: 'failure',
        severity: 'warning',
        details: 'Attempted a live call without a grant for this environment.',
      });
      return res.status(403).json({ error: `You don't have Live mode access to ${environmentId}. Ask an Admin to grant it.` });
    }

    // Same visibility rule as GET /api/workspace — owner, or same-org and
    // (public / has a public endpoint).
    const { rows: projRows } = await pool.query(
      `SELECT id, owner_id, organisation, visibility, has_public_endpoint, data, data_enc
       FROM projects WHERE id = $1
         AND (owner_id = $2 OR (organisation = $3 AND (visibility = 'public' OR has_public_endpoint)))`,
      [projectId, userId, org]
    );
    if (!projRows.length) return res.status(404).json({ error: 'Project not found.' });
    const project = decryptProjectData(projRows[0]);
    const ep = (project.endpoints || []).find((e) => e.id === endpointId);
    if (!ep) return res.status(404).json({ error: 'Endpoint not found.' });

    const baseUrl = project.environments && project.environments[environmentId];
    if (!baseUrl) return res.status(400).json({ error: `No base URL configured for ${environmentId} on this project.` });

    // Path comes from the endpoint's own declared template with path-param
    // VALUES substituted in — never a raw path taken from the request body.
    let path = ep.path || '';
    const pathParams = (req.body.pathParams && typeof req.body.pathParams === 'object') ? req.body.pathParams : {};
    Object.entries(pathParams).forEach(([name, value]) => {
      path = path.split(`{${name}}`).join(encodeURIComponent(String(value ?? '')));
    });

    const qp = new URLSearchParams();
    const queryParams = (req.body.queryParams && typeof req.body.queryParams === 'object') ? req.body.queryParams : {};
    Object.entries(queryParams).forEach(([k, v]) => { if (v !== '' && v != null) qp.append(k, String(v)); });
    const qs = qp.toString();
    const url = `${baseUrl}${path}${qs ? `?${qs}` : ''}`;

    const headers = {};
    if (req.body.headers && typeof req.body.headers === 'object') {
      Object.entries(req.body.headers).forEach(([k, v]) => {
        if (/^(host|content-length)$/i.test(k)) return; // let fetch manage these itself
        headers[k] = String(v);
      });
    }
    const method = (ep.method || 'GET').toUpperCase();
    const hasBody = !['GET', 'HEAD'].includes(method) && req.body.body != null && req.body.body !== '';
    if (hasBody && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }

    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let response, responseText;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: hasBody ? (typeof req.body.body === 'string' ? req.body.body : JSON.stringify(req.body.body)) : undefined,
        signal: controller.signal,
        redirect: 'follow',
      });
      responseText = await response.text();
    } finally {
      clearTimeout(timeout);
    }
    const latencyMs = Date.now() - started;

    await recordAuditEvent(req.authUser, req, {
      action: 'LIVE_MODE_CALL_SENT',
      resourceType: 'endpoint',
      resourceId: String(endpointId),
      entityName: `${method} ${ep.path}`,
      projectName: project.name,
      environment: environmentId,
      severity: response.ok ? 'info' : 'warning',
      details: `Live call -> ${response.status} in ${latencyMs}ms`,
      metadata: { status: response.status, latencyMs },
    });

    let bodyOut = responseText;
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      try { bodyOut = JSON.parse(responseText); } catch (e) { /* leave as text */ }
    }
    res.json({ status: response.status, statusText: response.statusText, latencyMs, body: bodyOut });
  } catch (err) {
    const isAbort = err && err.name === 'AbortError';
    console.error('POST /api/live-mode/send failed:', err);
    try {
      await recordAuditEvent(req.authUser, req, {
        action: 'LIVE_MODE_CALL_FAILED',
        resourceType: 'endpoint',
        resourceId: String(endpointId || ''),
        environment: environmentId,
        result: 'failure',
        severity: 'warning',
        details: isAbort ? 'Live call timed out after 15s.' : `Live call failed: ${err.message}`,
      });
    } catch (auditErr) { console.error('Failed to record live-mode failure audit event:', auditErr); }
    res.status(isAbort ? 504 : 502).json({
      error: isAbort ? 'The live request timed out after 15 seconds.' : 'The live request failed — the target may be unreachable from this server.',
    });
  }
});

module.exports = router;
