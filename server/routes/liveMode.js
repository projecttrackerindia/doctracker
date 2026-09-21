const express = require('express');
const { pool } = require('../db');
const { authenticate, requireAdmin, blockIfScheduleLocked } = require('../middleware/authGuard');
const { recordAuditEvent } = require('../auditService');
const { notifyUser } = require('../notifications');
const { createRateLimiter } = require('../rateLimitStore');
const { decryptProjectData, getOrgEnvironments } = require('./workspace');
const { validateOutboundUrlAsync } = require('../urlSafety');

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
    const [validEnvironments, userRows, previousGrants] = await Promise.all([
      getOrgEnvironments(org),
      pool.query(`SELECT id, username FROM users WHERE organisation = $1`, [org]),
      loadGrants(org),
    ]);
    const validEnvIds = new Set(validEnvironments.map((e) => e.id));
    const usernameById = new Map(userRows.rows.map((r) => [String(r.id), r.username]));
    const validUserIds = new Set(userRows.rows.map((r) => String(r.id)));

    const clean = {};
    Object.entries(incoming).forEach(([userId, envIds]) => {
      if (!validUserIds.has(String(userId)) || !Array.isArray(envIds)) return;
      const filtered = envIds.filter((e) => validEnvIds.has(e));
      if (filtered.length) clean[String(userId)] = filtered;
    });

    // Diff against what was there before, per user, so the audit trail says
    // exactly what changed instead of just "something changed" — meaningful
    // for a table that controls who can browse/fire real requests against
    // which environment.
    const changedLines = [];
    const perUserChanges = []; // { userId, added, removed } — fed to notifyUser below, after the save succeeds
    new Set([...Object.keys(previousGrants || {}), ...Object.keys(clean)]).forEach((uid) => {
      const before = new Set(previousGrants?.[uid] || []);
      const after = new Set(clean[uid] || []);
      const added = [...after].filter((e) => !before.has(e));
      const removed = [...before].filter((e) => !after.has(e));
      if (!added.length && !removed.length) return;
      const who = usernameById.get(uid) || `user ${uid}`;
      const parts = [];
      if (added.length) parts.push(`granted ${added.join(', ')}`);
      if (removed.length) parts.push(`revoked ${removed.join(', ')}`);
      changedLines.push(`${who}: ${parts.join('; ')}`);
      perUserChanges.push({ userId: Number(uid), added, removed });
    });

    await pool.query(
      `INSERT INTO org_workspace (organisation, live_mode_grants, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (organisation) DO UPDATE SET live_mode_grants = EXCLUDED.live_mode_grants, updated_at = now()`,
      [org, JSON.stringify(clean)]
    );
    await recordAuditEvent(req.authUser, req, {
      action: 'LIVE_MODE_GRANTS_UPDATED',
      resourceType: 'live_mode_grants',
      details: changedLines.length ? changedLines.join(' | ') : 'Saved Live mode access with no effective change',
      severity: 'warning',
      metadata: { grants: clean, previousGrants },
    });

    // The person whose access just changed has no other way to find out —
    // this is exactly the "same blind spot" the Security nav badge covers
    // for doc-access requests, applied to the other side of Security
    // (Live Mode Access). Only notify on an actual change (perUserChanges
    // already filters out no-ops above).
    await Promise.all(perUserChanges.map(({ userId, added, removed }) => {
      const parts = [];
      if (added.length) parts.push(`Granted: ${added.join(', ')}`);
      if (removed.length) parts.push(`Revoked: ${removed.join(', ')}`);
      return notifyUser(userId, {
        organisation: org,
        type: 'LIVE_MODE_GRANTS_UPDATED',
        title: 'Your Live Mode access changed',
        body: parts.join(' · '),
        link: { view: 'tryit' },
      });
    }));

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
// VALUES, query values, headers and body — never a URL or host.
//
// SECURITY (Finding 4.3): that alone does NOT stop this from being an SSRF
// primitive — the "project's own stored environment config" is itself a
// plain string, settable by anyone with edit rights on ANY project
// (including their own private one), to any value at all. This is now
// validated twice: once at save time (server/routes/workspace.js,
// environmentUrlError — rejects the obvious cases: bad scheme, localhost,
// a literal private/loopback/link-local/metadata IP) and again HERE,
// immediately before firing, with a fresh DNS lookup (validateOutboundUrlAsync)
// so a hostname that resolved to something public earlier can't quietly
// have been re-pointed at an internal address since. See server/urlSafety.js
// for the residual DNS-rebinding caveat this check-then-connect approach
// doesn't fully close.
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

    // A deprecated endpoint can still be called (it may well still work in
    // the real environment) — this just stops a live call from going out
    // silently. Same pattern as the breaking-changes ack on promotion:
    // refuse once with a flag the caller has to set on purpose to proceed.
    if (ep.status === 'deprecated' && req.body?.confirmDeprecated !== true) {
      return res.status(409).json({
        error: `${(ep.method || '').toUpperCase()} ${ep.path || ''} is marked Deprecated. Confirm you still want to send this request.`,
        deprecated: true,
      });
    }

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
      // SECURITY (Finding 4.3): fresh, DNS-resolving validation right before
      // the outbound call — see the route-level comment above.
      const urlCheck = await validateOutboundUrlAsync(url);
      if (!urlCheck.valid) {
        clearTimeout(timeout);
        await recordAuditEvent(req.authUser, req, {
          action: 'LIVE_MODE_CALL_DENIED',
          resourceType: 'endpoint',
          resourceId: String(endpointId),
          environment: environmentId,
          result: 'failure',
          severity: 'critical',
          details: `Blocked an outbound call to a disallowed address: ${urlCheck.reason}`,
        });
        return res.status(400).json({ error: `This environment's base URL isn't allowed: ${urlCheck.reason}` });
      }
      response = await fetch(url, {
        method,
        headers,
        body: hasBody ? (typeof req.body.body === 'string' ? req.body.body : JSON.stringify(req.body.body)) : undefined,
        signal: controller.signal,
        // SECURITY (Finding 4.3): was 'follow'. A validated, public target
        // URL could still respond with a 3xx pointing at an internal
        // address, silently bypassing the check above the moment fetch()
        // followed it automatically. Redirects are now followed manually,
        // up to a small cap, re-validating (including a fresh DNS lookup)
        // before following each hop.
        redirect: 'manual',
      });
      let redirectHops = 0;
      while ([301, 302, 303, 307, 308].includes(response.status) && redirectHops < 5) {
        const location = response.headers.get('location');
        if (!location) break;
        const nextUrl = new URL(location, response.url || url).toString();
        const nextCheck = await validateOutboundUrlAsync(nextUrl);
        if (!nextCheck.valid) {
          clearTimeout(timeout);
          await recordAuditEvent(req.authUser, req, {
            action: 'LIVE_MODE_CALL_DENIED',
            resourceType: 'endpoint',
            resourceId: String(endpointId),
            environment: environmentId,
            result: 'failure',
            severity: 'critical',
            details: `Blocked a redirect to a disallowed address: ${nextCheck.reason}`,
          });
          return res.status(400).json({ error: `The target redirected to a disallowed address: ${nextCheck.reason}` });
        }
        redirectHops += 1;
        response = await fetch(nextUrl, {
          method: (response.status === 303) ? 'GET' : method,
          headers,
          body: (response.status === 303) ? undefined : (hasBody ? (typeof req.body.body === 'string' ? req.body.body : JSON.stringify(req.body.body)) : undefined),
          signal: controller.signal,
          redirect: 'manual',
        });
      }
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
    // Real response headers, not guessed — same masking philosophy as the
    // rest of the app: strip hop-by-hop / cookie-setting headers rather than
    // forward anything that could leak session state back into the UI.
    const respHeaders = {};
    response.headers.forEach((value, key) => {
      if (/^(set-cookie|connection|transfer-encoding)$/i.test(key)) return;
      respHeaders[key] = value;
    });
    res.json({ status: response.status, statusText: response.statusText, latencyMs, body: bodyOut, headers: respHeaders });
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
