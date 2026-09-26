const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createRateLimiter } = require('../rateLimitStore');
const { pool } = require('../db');
const dataCrypto = require('../crypto');
const totp = require('../totp');
const { verifySession, IdleTimeoutError, authenticate } = require('../middleware/authGuard');
const { notifyUsers, adminUserIds } = require('../notifications');
const { log } = require('../logger');
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

// SECURITY (Finding F-04 — per-account lockout): independent of the
// IP-based authLimiter above, which only throttles a given source IP. An
// attacker spreading guesses across many IPs would face no account-specific
// slowdown without this — 5 wrong passwords in a row locks the ACCOUNT
// itself for 15 minutes, regardless of which IP the attempts came from.
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

// Pure decision functions for the two lockout checkpoints below — kept
// separate from the DB writes around them so the boundary cases (exactly at
// the threshold, a lock that just expired, the "at least 1 minute" rounding
// on the message) can be unit-tested without a database. Exported as
// properties on the router (see module.exports at the bottom of this file),
// the same pattern server/routes/workspace.js already uses.

// Given the account's stored locked_until and the current time, says
// whether it's still locked and, if so, how many whole minutes are left to
// show in the message. A locked_until in the past (the lock expired) or
// null (never locked) both read as not locked — this function doesn't clear
// the column, the caller's normal login-success path already does that.
function checkAccountLockout(lockedUntil, now = Date.now()) {
  if (!lockedUntil) return { locked: false, minutesLeft: 0 };
  const untilMs = new Date(lockedUntil).getTime();
  if (untilMs <= now) return { locked: false, minutesLeft: 0 };
  // Rounded UP and floored at 1: "0 minutes left" would read as "not
  // locked" to someone glancing at the message, even with 40 seconds
  // actually remaining.
  return { locked: true, minutesLeft: Math.max(1, Math.ceil((untilMs - now) / 60000)) };
}

// Given a wrong password and the account's CURRENT failed-attempt count,
// decides whether this failure is the one that crosses LOCKOUT_THRESHOLD.
// `failedCount` in the non-locking branch is what the caller should write
// back as the new count; in the locking branch the caller resets it to 0
// (the counter's job ends once a lock starts — see the route below).
function nextFailedLoginState(currentFailedCount) {
  const nextCount = (currentFailedCount || 0) + 1;
  if (nextCount >= LOCKOUT_THRESHOLD) return { shouldLock: true, failedCount: 0 };
  return { shouldLock: false, failedCount: nextCount };
}

// SECURITY (Finding F-04 — MFA): the second factor is only required once a
// password has already been verified correct, so the challenge token below
// deliberately can't be used to skip the password step — it's issued FROM a
// successful password check, not instead of one. Short-lived (5 minutes) so
// an abandoned login attempt's challenge token can't be replayed later.
const MFA_CHALLENGE_EXPIRES = '5m';

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
    log.error('Register error', { requestId: req.id, err });
    res.status(500).json({ error: 'Something went wrong creating your account. Please try again.' });
  }
});

const LOGIN_COLUMNS = `id, username, email, password_hash, organisation, role, custom_permissions, token_version,
       failed_login_count, locked_until, mfa_enabled, mfa_secret_enc, mfa_secret_key_version`;

// Finishes a login that has already cleared password (and, if enabled, MFA)
// checks — issues the real session cookie. Shared by POST /login (no MFA)
// and POST /mfa/challenge (the second step when MFA is enabled), so both
// paths end up in exactly the same place rather than two hand-maintained
// copies of "what a successful login does."
// `redirectTo` is only used by the SSO callback (server/routes/sso.js),
// which lands here via a full-page browser redirect from the IdP rather
// than an XHR call — it needs the browser to land on a real app page next,
// not a bare JSON body. Everything else about issuing the session (the
// last_login/last_activity update, the signed cookie, its options) is
// identical either way; omitting redirectTo (every existing caller) keeps
// the original JSON response exactly as it was.
async function finalizeLogin(user, res, { redirectTo } = {}) {
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
  if (redirectTo) return res.redirect(redirectTo);
  res.json({ user: safeUser, orgToken: dataCrypto.encryptOrgToken(user.organisation) });
}

// ---- POST /api/auth/login ----
router.post('/login', authLimiter, async (req, res) => {
  try {
    const { identifier, password } = req.body || {};
    if (!identifier || !password) {
      return res.status(400).json({ error: 'Enter your email/username and password.' });
    }

    const result = await pool.query(
      `SELECT ${LOGIN_COLUMNS} FROM users WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($1)`,
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

    // SECURITY (Finding F-04 — account lockout): the bcrypt.compare() below
    // always runs, even for an already-locked account, so a locked account's
    // response takes the same time as a wrong-password response on an
    // unlocked one — the lockout check itself doesn't reopen the timing
    // side-channel F-03 just closed.
    const ok = await bcrypt.compare(password, user.password_hash);

    const now = Date.now();
    const lockout = checkAccountLockout(user.locked_until, now);
    if (lockout.locked) {
      return res.status(423).json({
        error: 'account_locked',
        message: `Too many failed sign-in attempts. This account is temporarily locked — try again in about ${lockout.minutesLeft} minute${lockout.minutesLeft === 1 ? '' : 's'}.`,
      });
    }

    if (!ok) {
      const { shouldLock, failedCount } = nextFailedLoginState(user.failed_login_count);
      if (shouldLock) {
        await pool.query(
          'UPDATE users SET failed_login_count = 0, locked_until = now() + ($1 * interval \'1 millisecond\') WHERE id = $2',
          [LOCKOUT_DURATION_MS, user.id]
        );
      } else {
        await pool.query('UPDATE users SET failed_login_count = $1 WHERE id = $2', [failedCount, user.id]);
      }
      return res.status(401).json(genericError);
    }

    // Correct password — clear any accumulated failed-attempt count.
    if (user.failed_login_count > 0 || user.locked_until) {
      await pool.query('UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1', [user.id]);
    }

    // SECURITY (Finding F-04 — MFA): password alone isn't enough for an
    // account with MFA enabled. Issue a short-lived challenge token instead
    // of a real session — it carries no role/organisation claims an
    // authenticated route would trust, only "this specific account cleared
    // the password step," so it's useless for anything except completing
    // POST /mfa/challenge for this same account within the next 5 minutes.
    if (user.mfa_enabled) {
      const challengeToken = jwt.sign({ sub: user.id, mfaPending: true }, process.env.JWT_SECRET, { expiresIn: MFA_CHALLENGE_EXPIRES });
      return res.json({ mfaRequired: true, challengeToken });
    }

    await finalizeLogin(user, res);
  } catch (err) {
    log.error('Login error', { requestId: req.id, err });
    res.status(500).json({ error: 'Something went wrong signing you in. Please try again.' });
  }
});

// ---- POST /api/auth/mfa/challenge — second step of login when MFA is enabled ----
router.post('/mfa/challenge', authLimiter, async (req, res) => {
  try {
    const { challengeToken, code } = req.body || {};
    if (!challengeToken || !code) return res.status(400).json({ error: 'Enter the 6-digit code from your authenticator app.' });

    let decoded;
    try {
      decoded = jwt.verify(challengeToken, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'This sign-in attempt has expired. Please log in again.' });
    }
    if (!decoded?.mfaPending || !decoded.sub) return res.status(401).json({ error: 'This sign-in attempt has expired. Please log in again.' });

    const result = await pool.query(`SELECT ${LOGIN_COLUMNS} FROM users WHERE id = $1`, [decoded.sub]);
    if (!result.rows.length) return res.status(401).json({ error: 'This sign-in attempt has expired. Please log in again.' });
    const user = result.rows[0];
    if (!user.mfa_enabled || !user.mfa_secret_enc) return res.status(401).json({ error: 'This sign-in attempt has expired. Please log in again.' });

    const secret = dataCrypto.decryptField(user.mfa_secret_enc, `user:${user.id}:mfa`);
    if (!totp.verifyToken(secret, code)) {
      return res.status(401).json({ error: 'Incorrect code. Please try again.' });
    }

    await finalizeLogin(user, res);
  } catch (err) {
    log.error('MFA challenge error', { requestId: req.id, err });
    res.status(500).json({ error: 'Something went wrong verifying your code. Please try again.' });
  }
});

// ---- MFA enrollment/management (self-service, for the logged-in user's own account) ----

// GET /api/auth/mfa/status
router.get('/mfa/status', authenticate, async (req, res) => {
  const { rows } = await pool.query('SELECT mfa_enabled FROM users WHERE id = $1', [req.authUser.sub]);
  res.json({ enabled: Boolean(rows[0]?.mfa_enabled) });
});

// POST /api/auth/mfa/setup — generates a new pending secret (not yet active).
router.post('/mfa/setup', authenticate, async (req, res) => {
  try {
    const secret = totp.generateSecret();
    const enc = dataCrypto.encryptField(secret, `user:${req.authUser.sub}:mfa`);
    await pool.query(
      'UPDATE users SET mfa_pending_secret_enc = $1, mfa_pending_secret_key_version = $2 WHERE id = $3',
      [enc, dataCrypto.currentKeyVersion(), req.authUser.sub]
    );
    const otpauthUri = totp.buildOtpauthUri({ secret, accountLabel: req.authUser.username, issuer: 'DocTracker' });
    res.json({ secret, otpauthUri });
  } catch (err) {
    log.error('MFA setup error', { requestId: req.id, err });
    res.status(500).json({ error: 'Could not start MFA setup. Please try again.' });
  }
});

// POST /api/auth/mfa/confirm — proves the pending secret works, then activates it.
router.post('/mfa/confirm', authenticate, async (req, res) => {
  try {
    const { code } = req.body || {};
    const { rows } = await pool.query('SELECT mfa_pending_secret_enc FROM users WHERE id = $1', [req.authUser.sub]);
    const pendingEnc = rows[0]?.mfa_pending_secret_enc;
    if (!pendingEnc) return res.status(400).json({ error: 'Start MFA setup first.' });

    const secret = dataCrypto.decryptField(pendingEnc, `user:${req.authUser.sub}:mfa`);
    if (!totp.verifyToken(secret, code)) {
      return res.status(400).json({ error: 'Incorrect code. Check your authenticator app and try again.' });
    }

    // Deliberately does NOT bump token_version — unlike password-reset/
    // role-change/logout, there's no leaked-credential concern to force a
    // global sign-out over here, and this request comes from the user's own
    // already-authenticated session: bumping it here would invalidate that
    // very session mid-setup and kick them straight back to the login
    // screen right after they finished enabling MFA.
    await pool.query(
      `UPDATE users SET mfa_enabled = true, mfa_secret_enc = mfa_pending_secret_enc, mfa_secret_key_version = mfa_pending_secret_key_version,
       mfa_pending_secret_enc = NULL, mfa_pending_secret_key_version = NULL WHERE id = $1`,
      [req.authUser.sub]
    );
    res.json({ ok: true });
  } catch (err) {
    log.error('MFA confirm error', { requestId: req.id, err });
    res.status(500).json({ error: 'Could not confirm MFA setup. Please try again.' });
  }
});

// POST /api/auth/mfa/disable — requires re-entering the current password, so
// a hijacked-but-still-unlocked browser session can't silently strip MFA off
// the account by itself.
router.post('/mfa/disable', authenticate, async (req, res) => {
  try {
    const { password } = req.body || {};
    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.authUser.sub]);
    if (!rows.length) return res.status(401).json({ error: 'Session expired. Please sign in again.' });
    const ok = password && (await bcrypt.compare(password, rows[0].password_hash));
    if (!ok) return res.status(401).json({ error: 'Incorrect password.' });

    await pool.query(
      `UPDATE users SET mfa_enabled = false, mfa_secret_enc = NULL, mfa_secret_key_version = NULL,
       mfa_pending_secret_enc = NULL, mfa_pending_secret_key_version = NULL WHERE id = $1`,
      [req.authUser.sub]
    );
    res.json({ ok: true });
  } catch (err) {
    log.error('MFA disable error', { requestId: req.id, err });
    res.status(500).json({ error: 'Could not disable MFA. Please try again.' });
  }
});

// ---- POST /api/auth/request-password-reset ----
// SECURITY (Finding F-04 — self-service password reset): previously ONLY an
// Admin could initiate a reset, which meant a locked-out user was fully
// dependent on an Admin noticing. This lets the user flag it themselves. No
// outbound-email provider is configured in this deployment, so this
// notifies every Admin in the organisation in-app (server/notifications.js)
// rather than emailing a reset link — an Admin completes it with the
// existing POST /api/users/:id/reset-password action after verifying the
// requester's identity out-of-band. The response is deliberately IDENTICAL
// regardless of whether the account exists, so this can't be used to
// enumerate valid usernames/emails — only a real account actually triggers
// the Admin notification below.
router.post('/request-password-reset', authLimiter, async (req, res) => {
  const { identifier } = req.body || {};
  const genericResponse = { message: "If that account exists, your organisation's Admin has been notified and will help you regain access." };
  try {
    // QA regression (2026-09-26, bug #8): an empty identifier used to get
    // the same silent "success" response as a real-but-nonexistent one.
    // That's fine for a nonexistent identifier (that distinction is exactly
    // what anti-enumeration requires hiding) but an outright EMPTY field
    // reveals nothing about any account's existence either way, so there's
    // no enumeration risk in saying so plainly instead.
    if (!identifier || !String(identifier).trim()) {
      return res.status(400).json({ error: 'Enter your email or username.' });
    }
    const result = await pool.query(
      'SELECT id, username, organisation FROM users WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($1)',
      [String(identifier).trim()]
    );
    if (result.rows.length) {
      const user = result.rows[0];
      await pool.query('UPDATE users SET password_reset_requested_at = now() WHERE id = $1', [user.id]);
      const adminIds = await adminUserIds(user.organisation);
      await notifyUsers(adminIds, {
        organisation: user.organisation,
        type: 'password_reset_requested',
        title: `${user.username} requested a password reset`,
        body: 'Verify their identity out-of-band, then use Reset Password on their account.',
        link: { view: 'profile' },
      });
    }
  } catch (err) {
    log.error('Request password reset error', { requestId: req.id, err });
    // Still return the generic response — never let this leak account
    // existence or internal error detail through a different response shape.
  }
  res.json(genericResponse);
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
    log.error('GET /api/auth/me failed', { requestId: req.id, err });
    res.status(401).json({ error: 'Session expired. Please sign in again.' });
  }
});

module.exports = router;
module.exports.checkAccountLockout = checkAccountLockout;
module.exports.nextFailedLoginState = nextFailedLoginState;
module.exports.finalizeLogin = finalizeLogin;
