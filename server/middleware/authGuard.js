const jwt = require('jsonwebtoken');
const { pool } = require('../db');

const COOKIE_NAME = 'as_session';

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
// invalid/expired/revoked/the account no longer exists.
async function verifySession(token) {
  if (!token) return null;
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return null;
  }
  const { rows } = await pool.query(
    `SELECT id, username, organisation, role, custom_permissions, token_version FROM users WHERE id = $1`,
    [decoded.sub]
  );
  if (!rows.length) return null; // account deleted since the token was issued
  const user = rows[0];
  if ((decoded.tokenVersion || 1) !== user.token_version) return null; // revoked (role change / password reset / sign-out-everywhere)
  return {
    sub: user.id,
    username: user.username,
    organisation: user.organisation,
    role: user.role,
    tokenVersion: user.token_version,
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

module.exports = { authenticate, requireAdmin, verifySession, COOKIE_NAME };
