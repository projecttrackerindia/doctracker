const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { evaluateAccessSchedule } = require('../accessSchedule');

const COOKIE_NAME = 'as_session';

// A session with zero authenticated requests/page loads for this long is
// logged out, regardless of how much of the JWT's 7-day expiry is left.
// Reset to full on every request that comes in before the limit — this is a
// SLIDING window, not a fixed one: someone actively working never hits it, no
// matter how long the session runs; someone who walks away does, in exactly
// 30 minutes, not "whenever the tab next happens to poll something."
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

// verifySession runs on essentially every request. Writing last_activity_at
// to Postgres on literally all of them would double the DB load of the app
// for no real benefit — throttling the WRITE to once a minute still keeps the
// idle-timeout accurate to within a minute, which is plenty for a 30-minute
// window, while cutting the write volume by ~98% under normal use.
const IDLE_TOUCH_THROTTLE_MS = 60 * 1000;

// Thrown by verifySession specifically for "this session WAS valid but has
// been idle too long," so callers can show/redirect with a distinct, honest
// message instead of the generic "session expired" used for a bad/revoked/
// missing token. Kept as its own error type rather than a return value so a
// forgetful call site can't silently treat it the same as `null` — it has to
// opt in to handling it (both call sites below do).
class IdleTimeoutError extends Error {
  constructor() {
    super('idle_timeout');
    this.reason = 'idle_timeout';
  }
}

// Verifies the session cookie AND re-checks the account in the database on
// every call — role, custom permissions, and the account's existence are
// always read fresh here, never trusted from the (up to 7-day-old) JWT
// payload. `tokenVersion` is the revocation mechanism: routes/users.js bumps
// it on role change / password reset, which makes every token issued before
// that instantly fail this check, even though the JWT signature itself is
// still perfectly valid. This is what closes the "demoted/deleted/password-
// reset user keeps their old access for up to 7 days" gap — previously
// nothing here ever looked past the token's own signature and expiry.
// Returns the fresh, authoritative user object, or null if the session is
// invalid/expired/revoked/the account no longer exists. Throws
// IdleTimeoutError (see above) if the account is otherwise fine but has sat
// untouched past IDLE_TIMEOUT_MS.
async function verifySession(token) {
  if (!token) return null;
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return null;
  }
  const { rows } = await pool.query(
    `SELECT id, username, organisation, role, custom_permissions, access_schedule, token_version, last_activity_at FROM users WHERE id = $1`,
    [decoded.sub]
  );
  if (!rows.length) return null; // account deleted since the token was issued
  const user = rows[0];
  if ((decoded.tokenVersion || 1) !== user.token_version) return null; // revoked (role change / password reset / sign-out-everywhere)

  // Idle-timeout check — deliberately BEFORE the touch below, so an already-
  // idle-expired session gets rejected instead of being silently revived by
  // the very request that should have been too late to count.
  const now = Date.now();
  if (user.last_activity_at && now - new Date(user.last_activity_at).getTime() > IDLE_TIMEOUT_MS) {
    throw new IdleTimeoutError();
  }
  if (!user.last_activity_at || now - new Date(user.last_activity_at).getTime() > IDLE_TOUCH_THROTTLE_MS) {
    // Fire-and-forget: never let a slow/failed write to this column block or
    // fail the request it's piggybacking on.
    pool
      .query('UPDATE users SET last_activity_at = now() WHERE id = $1', [user.id])
      .catch((err) => console.error('Idle-activity touch failed (non-fatal):', err.message));
  }

  // Re-evaluated fresh against the server clock on every request — never
  // cached on the JWT, or a session issued while "open" would stay open for
  // up to 7 days after the window closed. Admins are exempt: a schedule is
  // meant to time-box a given account, not risk locking every admin in the
  // org out at once if one gets misconfigured.
  const schedule = user.access_schedule || null;
  const scheduleStatus = evaluateAccessSchedule(schedule, new Date());

  return {
    sub: user.id,
    username: user.username,
    organisation: user.organisation,
    role: user.role,
    tokenVersion: user.token_version,
    accessSchedule: schedule,
    scheduleLocked: user.role !== 'admin' && scheduleStatus.locked,
    ...(user.role === 'custom' ? { customPermissions: user.custom_permissions || null } : {}),
  };
}

// Verifies the session cookie and attaches the fresh, DB-checked user as
// req.authUser. Distinct from server.js's page-level requireAuth (which
// redirects to /login.html) — API routes should return JSON, not a redirect.
async function authenticate(req, res, next) {
  try {
    const authUser = await verifySession(req.cookies?.[COOKIE_NAME]);
    if (!authUser) return res.status(401).json({ error: 'Session expired. Please sign in again.' });
    req.authUser = authUser;
    next();
  } catch (err) {
    if (err instanceof IdleTimeoutError) {
      res.clearCookie(COOKIE_NAME, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' });
      return res.status(401).json({ error: 'idle_timeout', message: "You've been signed out after 30 minutes of inactivity." });
    }
    console.error('authenticate() failed:', err);
    res.status(500).json({ error: 'Could not verify your session. Please try again.' });
  }
}

// Must run after authenticate(). Every user-management action is Admin-only —
// enforced here, server-side, rather than relying on the UI hiding the buttons.
function requireAdmin(req, res, next) {
  if (!req.authUser || req.authUser.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
}

// Mounted after authenticate() on any router whose whole surface counts as
// "using the workspace" (docs data, live-mode calls, PII rules, audit log) —
// not on routes/users.js, since that's Admin-only already and an admin must
// always be able to reach it to extend someone's window. Responds 423
// (Locked, not 403 Forbidden) specifically so the frontend can tell "you're
// not allowed, ever" apart from "you're not allowed *right now*" and render
// the countdown-to-reopen state instead of a hard error.
function blockIfScheduleLocked(req, res, next) {
  if (req.authUser && req.authUser.scheduleLocked) {
    return res.status(423).json({
      error: 'schedule_locked',
      message: 'Your access is currently outside the hours your admin has allowed.',
      accessSchedule: req.authUser.accessSchedule,
    });
  }
  next();
}

module.exports = { authenticate, requireAdmin, blockIfScheduleLocked, verifySession, IdleTimeoutError, IDLE_TIMEOUT_MS, COOKIE_NAME };
