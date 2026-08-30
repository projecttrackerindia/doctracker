const jwt = require('jsonwebtoken');

const COOKIE_NAME = 'as_session';

// Verifies the session cookie and attaches the decoded token as req.authUser.
// Distinct from server.js's page-level requireAuth (which redirects to
// /login.html) — API routes should return JSON, not a redirect.
function authenticate(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Not signed in.' });
  try {
    req.authUser = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Session expired. Please sign in again.' });
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

module.exports = { authenticate, requireAdmin, COOKIE_NAME };
