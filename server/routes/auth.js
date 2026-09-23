const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createRateLimiter } = require('../rateLimitStore');
const { pool } = require('../db');
const dataCrypto = require('../crypto');
const { verifySession, IdleTimeoutError } = require('../middleware/authGuard');
const {
  validateEmail,
  validateUsername,
  validateOrganisation,
  validateRole,
  evaluatePassword,
} = require('../validators');

const router = express.Router();

const authLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again in a few minutes.' },
});

// Fixed bcrypt hash of an unguessable, never-used password — used only to
// give the "no such user" login path the same bcrypt.compare() cost as the
// real one (see Finding F-03 below). Generated once, offline; not a secret,
// not tied to any real account.
const DUMMY_HASH_FOR_TIMING_PARITY = '$2b$12$6wvuJdwgOPzlbxVZa5R93.M5JOgFnGT/.1MxqwKGOT9TdwjGCw1hG';

const COOKIE_NAME = 'as_session';
const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
};

function signSession(user) {
  return jwt.sign(
    {
      sub: user.id,
      username: user.username,
      role: user.role,
      organisation: user.organisation,
      tokenVersion: user.token_version || 1,
      customPermissions: user.role === 'custom' ? (user.custom_permissions || null) : undefined,
    },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

// ---- POST /api/auth/password-check (live strength feedback, no DB hit) ----
router.post('/password-check', (req, res) => {
  const { password = '', username = '', email = '' } = req.body || {};
  res.json(evaluatePassword(password, { username, email }));
});

// ---- POST /api/auth/register ----
router.post('/register', authLimiter, async (req, res) => {
  try {
    const { username, email, password, organisation, role } = req.body || {};

    const usernameCheck = validateUsername(username);
    if (!usernameCheck.valid) return res.status(400).json({ field: 'username', error: usernameCheck.reason });

    const emailCheck = validateEmail(email);
    if (!emailCheck.valid) return res.status(400).json({ field: 'email', error: emailCheck.reason });

    const orgCheck = validateOrganisation(organisation);
    if (!orgCheck.valid) return res.status(400).json({ field: 'organisation', error: orgCheck.reason });

    const roleCheck = validateRole(role);
    if (!roleCheck.valid) return res.status(400).json({ field: 'role', error: roleCheck.reason });
    if (roleCheck.value === 'custom') {
      return res.status(400).json({ field: 'role', error: 'The custom role can only be assigned by an Admin after you register.' });
    }

    const pwCheck = evaluatePassword(password, { username: usernameCheck.value, email });
    if (!pwCheck.valid) {
      return res.status(400).json({ field: 'password', error: pwCheck.reasons[0] || 'Password does not meet the security requirements.', reasons: pwCheck.reasons });
    }

    const existing = await pool.query(
      'SELECT id FROM users WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($2)',
      [usernameCheck.value, email.trim()]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'An account with that username or email already exists.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    // SECURITY (Finding 4.1 — tenant takeover via self-registration):
    // `organisation` is a free-text field with no owning tenant table, and
    // role was previously fully self-selectable, including 'admin'. That let
    // anyone who knew/guessed an existing organisation's name string
    // self-register as a full Admin of it, with zero interaction from anyone
    // already inside that org.
    //
    // Fix: only the FIRST account ever registered under a given organisation
    // string may become 'admin' (or keep whatever non-custom role it asked
    // for) — that person is founding the workspace. Every subsequent
    // registration against an organisation that already has members is
    // forced to a safe, unprivileged role ('viewer') regardless of what the
    // client requested; an existing Admin must promote them afterward.
    //
    // The existence check + insert run inside one transaction, serialized by
    // a Postgres transaction-scoped advisory lock keyed on the organisation
    // string, so two concurrent "first" registrations for the same brand-new
    // organisation can't both slip through and both become Admin.
    const client = await pool.connect();
    let user;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [orgCheck.value]);

      const orgMembers = await client.query(
        'SELECT 1 FROM users WHERE organisation = $1 LIMIT 1',
        [orgCheck.value]
      );
      const isFirstInOrg = orgMembers.rows.length === 0;
      const effectiveRole = isFirstInOrg ? roleCheck.value : 'viewer';

      if (!isFirstInOrg && roleCheck.value === 'admin') {
        await client.query('ROLLBACK');
        return res.status(403).json({
          field: 'role',
          error: 'This organisation already has members, so it can\'t be joined as Admin by self-registering. Choose Viewer or Editor, then ask an existing Admin to grant you a higher role.',
        });
      }

      const result = await client.query(
        `INSERT INTO users (username, email, password_hash, organisation, role)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, username, email, organisation, role, token_version, created_at`,
        [usernameCheck.value, email.trim().toLowerCase(), passwordHash, orgCheck.value, effectiveRole]
      );
      user = result.rows[0];
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    const token = signSession(user);
    res.cookie(COOKIE_NAME, token, COOKIE_OPTS);
    const { token_version, ...publicUser } = user; // never expose the revocation counter to the client
    res.status(201).json({ user: publicUser, orgToken: dataCrypto.encryptOrgToken(user.organisation) });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Something went wrong creating your account. Please try again.' });
  }
});

// ---- POST /api/auth/login ----
router.post('/login', authLimiter, async (req, res) => {
  try {
    const { identifier, password } = req.body || {};
    if (!identifier || !password) {
      return res.status(400).json({ error: 'Enter your email/username and password.' });
    }

    const result = await pool.query(
      `SELECT id, username, email, password_hash, organisation, role, custom_permissions, token_version
       FROM users WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($1)`,
      [identifier.trim()]
    );

    const genericError = { error: 'Incorrect email/username or password.' };
    if (result.rows.length === 0) {
      // SECURITY (Finding F-03 — login timing side-channel): a nonexistent
      // identifier used to return here immediately, while a real username
      // with a wrong password went on to run bcrypt.compare() below — at
      // cost factor 12 that's a multi-second difference, live-measured at
      // ~0.45s vs ~3.84s. Both responses already carry the identical generic
      // error text, but that timing gap alone let an attacker enumerate
      // valid usernames/emails without ever seeing a different message. This
      // dummy comparison against a fixed, precomputed hash costs the same
      // ~3s regardless of whether the account exists, so the two code paths
      // are no longer distinguishable by response time.
      await bcrypt.compare(password, DUMMY_HASH_FOR_TIMING_PARITY);
      return res.status(401).json(genericError);
    }

    const user = result.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json(genericError);

    // Reset last_activity_at here too, not just last_login_at — verifySession()
    // (authGuard.js) checks last_activity_at on every subsequent request to
    // decide idle-timeout, and it doesn't know or care that a fresh login just
    // happened. Without this, anyone who was ever idle-logged-out would log
    // back in successfully but get bounced straight back to /login.html?reason=idle
    // on the very next page load, since the DB column would still be ~30+
    // minutes stale from the session that just timed out.
    await pool.query('UPDATE users SET last_login_at = now(), last_activity_at = now() WHERE id = $1', [user.id]);

    const safeUser = {
      id: user.id, username: user.username, email: user.email, organisation: user.organisation, role: user.role,
      ...(user.role === 'custom' ? { customPermissions: user.custom_permissions } : {}),
    };
    const token = signSession(user);
    res.cookie(COOKIE_NAME, token, COOKIE_OPTS);
    res.json({ user: safeUser, orgToken: dataCrypto.encryptOrgToken(user.organisation) });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Something went wrong signing you in. Please try again.' });
  }
});

// ---- POST /api/auth/logout ----
// SECURITY (Finding F-01 — logout didn't revoke the session server-side):
// this used to only call res.clearCookie(), which removes the cookie from
// the browser that called it but leaves the JWT itself fully valid — a
// copied/cached/leaked token kept working for the rest of its 7-day expiry
// even after the user had "logged out." Live-confirmed: the exact cookie
// value from a session was replayed against GET /api/auth/me *after*
// calling this endpoint and still returned 200 with full admin identity.
//
// Fixed the same way password-reset and role-change already revoke old
// sessions (routes/users.js): bump token_version, which makes the tokenVersion
// claim baked into every previously-issued JWT stale, so authGuard.js's
// verifySession() rejects them on their very next use — instantly, not just
// in the browser that clicked Logout. Note this is a *global* sign-out for
// the account (every device/session), the same tradeoff password-reset and
// role-change already make with this same token_version mechanism — there's
// no per-session revocation in this scheme, only per-account.
router.post('/logout', async (req, res) => {
  const token = req.cookies?.[COOKIE_NAME];
  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET, { ignoreExpiration: true });
      if (decoded?.sub) {
        await pool.query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [decoded.sub]);
      }
    } catch {
      // Malformed/already-invalid token — nothing to revoke, just clear the cookie below.
    }
  }
  res.clearCookie(COOKIE_NAME, { ...COOKIE_OPTS, maxAge: undefined });
  res.json({ ok: true });
});

// ---- GET /api/auth/me ----
// Previously just decoded the JWT's own signature and echoed its payload —
// which meant a demoted/deleted/password-reset/idle-timed-out session still
// read back as "signed in" here for up to 7 days, even though every other
// route in the app (authenticate(), requireAuth()) re-checks the database on
// every call. Routed through the same verifySession() now so this endpoint
// can't disagree with the rest of the app about whether a session is valid.
router.get('/me', async (req, res) => {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Not signed in.' });
  try {
    const authUser = await verifySession(token);
    if (!authUser) return res.status(401).json({ error: 'Session expired. Please sign in again.' });
    res.json({
      user: {
        username: authUser.username, role: authUser.role, organisation: authUser.organisation,
        ...(authUser.role === 'custom' ? { customPermissions: authUser.customPermissions || null } : {}),
      },
    });
  } catch (err) {
    if (err instanceof IdleTimeoutError) {
      res.clearCookie(COOKIE_NAME, { ...COOKIE_OPTS, maxAge: undefined });
      return res.status(401).json({ error: 'idle_timeout', message: "You've been signed out after 30 minutes of inactivity." });
    }
    console.error('GET /api/auth/me failed:', err);
    res.status(401).json({ error: 'Session expired. Please sign in again.' });
  }
});

module.exports = router;
