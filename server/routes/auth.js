const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createRateLimiter } = require('../rateLimitStore');
const { pool } = require('../db');
const dataCrypto = require('../crypto');
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

    const result = await pool.query(
      `INSERT INTO users (username, email, password_hash, organisation, role)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, username, email, organisation, role, token_version, created_at`,
      [usernameCheck.value, email.trim().toLowerCase(), passwordHash, orgCheck.value, roleCheck.value]
    );

    const user = result.rows[0];
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
    if (result.rows.length === 0) return res.status(401).json(genericError);

    const user = result.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json(genericError);

    await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);

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
router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, { ...COOKIE_OPTS, maxAge: undefined });
  res.json({ ok: true });
});

// ---- GET /api/auth/me ----
router.get('/me', (req, res) => {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Not signed in.' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    res.json({
      user: {
        username: payload.username, role: payload.role, organisation: payload.organisation,
        ...(payload.role === 'custom' ? { customPermissions: payload.customPermissions || null } : {}),
      },
    });
  } catch {
    res.status(401).json({ error: 'Session expired. Please sign in again.' });
  }
});

module.exports = router;
