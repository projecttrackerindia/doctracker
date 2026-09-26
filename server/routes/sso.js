// Generic OIDC SSO — additive to password login, never a replacement. Two
// separate routers exported: `publicRouter` (the actual login redirect
// dance, reachable before anyone is authenticated) and `adminRouter` (the
// Workspace/Security settings panel's config CRUD, Admin-only). Mounted
// separately in server.js so the public flow is never accidentally gated
// behind the authenticate() middleware the admin routes need.
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const dataCrypto = require('../crypto');
const { authenticate, requireAdmin } = require('../middleware/authGuard');
const { createRateLimiter } = require('../rateLimitStore');
const { getSsoConfig, saveSsoConfig, toClientSsoConfig, buildOidcClient } = require('../sso');
const { validateUsername, generateTemporaryPassword } = require('../validators');
const { log } = require('../logger');
const auth = require('./auth');

const publicRouter = express.Router();
const adminRouter = express.Router();

const ssoLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again in a few minutes.' },
});

const STATE_COOKIE = 'sso_state';
// sameSite:'lax' (not 'strict') is required here, not just permissive — this
// cookie has to survive the top-level cross-site GET the IdP issues back to
// our own /callback, which 'strict' would drop entirely, breaking the flow
// for every browser that enforces it.
const STATE_COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: 10 * 60 * 1000, // long enough for a real IdP login, short enough to not linger
};

function redirectUriFor(req, organisation) {
  return `${req.protocol}://${req.get('host')}/api/auth/sso/${encodeURIComponent(organisation)}/callback`;
}

// Derives a valid, available username from a verified email's local part —
// SSO provisioning never asks the person to pick one (there's no form; they
// just land back from the IdP), so the app has to invent something that
// both satisfies validateUsername()'s format rules and doesn't collide.
async function deriveAvailableUsername(email) {
  const local = email.split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '');
  const base = (/^[a-z]/.test(local) ? local : `u${local}`).slice(0, 26) || 'ssouser';
  for (let suffix = 0; suffix < 1000; suffix += 1) {
    const candidate = suffix === 0 ? base : `${base}${suffix}`;
    const check = validateUsername(candidate);
    if (!check.valid) continue;
    const { rows } = await pool.query('SELECT 1 FROM users WHERE LOWER(username) = LOWER($1)', [candidate]);
    if (rows.length === 0) return candidate;
  }
  // Astronomically unlikely (1000 collisions on the same local-part), but a
  // clear error beats an infinite-looking retry.
  throw new Error('Could not derive an available username for this SSO account.');
}

// ---- GET /api/auth/sso/:organisation/start ----
publicRouter.get('/:organisation/start', ssoLimiter, async (req, res) => {
  try {
    const organisation = req.params.organisation;
    const config = await getSsoConfig(organisation);
    if (!config.enabled) {
      return res.status(404).send('SSO is not enabled for this organisation.');
    }

    const redirectUri = redirectUriFor(req, organisation);
    const client = await buildOidcClient(organisation, config, redirectUri);
    const state = crypto.randomBytes(24).toString('hex');
    const nonce = crypto.randomBytes(24).toString('hex');

    res.cookie(STATE_COOKIE, JSON.stringify({ state, nonce, organisation }), STATE_COOKIE_OPTS);
    res.redirect(client.authorizationUrl({ scope: 'openid email profile', state, nonce }));
  } catch (err) {
    log.error('GET /api/auth/sso/:organisation/start failed', { requestId: req.id, err });
    res.status(500).send('Could not start SSO sign-in. Try again, or use your password.');
  }
});

// ---- GET /api/auth/sso/:organisation/callback ----
publicRouter.get('/:organisation/callback', ssoLimiter, async (req, res) => {
  try {
    const organisation = req.params.organisation;
    let saved;
    try {
      saved = JSON.parse(req.cookies?.[STATE_COOKIE] || 'null');
    } catch (err) {
      saved = null;
    }
    res.clearCookie(STATE_COOKIE, STATE_COOKIE_OPTS);
    if (!saved || saved.organisation !== organisation) {
      return res.status(400).send('SSO sign-in expired or was not started from this app. Try again.');
    }

    const config = await getSsoConfig(organisation);
    if (!config.enabled) {
      return res.status(404).send('SSO is not enabled for this organisation.');
    }

    const redirectUri = redirectUriFor(req, organisation);
    const client = await buildOidcClient(organisation, config, redirectUri);
    const params = client.callbackParams(req);
    const tokenSet = await client.callback(redirectUri, params, { state: saved.state, nonce: saved.nonce });
    let claims = tokenSet.claims();
    // Not every IdP puts email/email_verified in the ID token itself — some
    // (confirmed against a real spec-compliant provider while building this)
    // only return them from userinfo, keyed on the requested 'email' scope.
    // The ID token's own sub is authoritative either way; this only fills in
    // the claims the ID token left out, never overrides sub.
    if (!claims.email && tokenSet.access_token) {
      const userinfo = await client.userinfo(tokenSet.access_token);
      claims = { ...userinfo, ...claims };
    }

    if (!claims.email || claims.email_verified === false) {
      return res.status(403).send('Your identity provider did not return a verified email address.');
    }
    const email = String(claims.email).trim().toLowerCase();
    if (config.allowedEmailDomain && !email.endsWith(`@${config.allowedEmailDomain}`)) {
      return res.status(403).send(`Only @${config.allowedEmailDomain} accounts may sign in to this organisation.`);
    }

    const { rows } = await pool.query(
      `SELECT id, username, email, organisation, role, custom_permissions, token_version
       FROM users WHERE LOWER(email) = LOWER($1) AND organisation = $2`,
      [email, organisation]
    );

    let user = rows[0];
    if (!user) {
      // First-time SSO login provisions a viewer by default — same
      // safe-default principle self-registration already uses for anyone
      // after an organisation's founding admin. An existing Admin promotes
      // them afterward, same as any other new account.
      const username = await deriveAvailableUsername(email);
      const passwordHash = await bcrypt.hash(generateTemporaryPassword(), 12);
      const inserted = await pool.query(
        `INSERT INTO users (username, email, password_hash, organisation, role)
         VALUES ($1, $2, $3, $4, 'viewer')
         RETURNING id, username, email, organisation, role, custom_permissions, token_version`,
        [username, email, passwordHash, organisation]
      );
      user = inserted.rows[0];
    }

    await auth.finalizeLogin(user, res, { redirectTo: `/${dataCrypto.encryptOrgToken(user.organisation)}/dashboard.html` });
  } catch (err) {
    log.error('GET /api/auth/sso/:organisation/callback failed', { requestId: req.id, err });
    res.status(500).send('Could not complete SSO sign-in. Try again, or use your password.');
  }
});

// ---- Admin config: GET/PUT /api/workspace/sso ----
adminRouter.use(authenticate, requireAdmin);

adminRouter.get('/', async (req, res) => {
  try {
    const config = await getSsoConfig(req.authUser.organisation);
    res.json({ sso: toClientSsoConfig(config) });
  } catch (err) {
    log.error('GET /api/workspace/sso failed', { requestId: req.id, err });
    res.status(500).json({ error: 'Could not load SSO settings.' });
  }
});

adminRouter.put('/', async (req, res) => {
  try {
    const next = await saveSsoConfig(req.authUser.organisation, req.body || {});
    res.json({ sso: toClientSsoConfig(next) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    log.error('PUT /api/workspace/sso failed', { requestId: req.id, err });
    res.status(500).json({ error: 'Could not save SSO settings.' });
  }
});

module.exports = { publicRouter, adminRouter };
