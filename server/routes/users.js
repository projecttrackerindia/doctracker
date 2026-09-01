const express = require('express');
const bcrypt = require('bcryptjs');
const { createRateLimiter } = require('../rateLimitStore');
const { pool } = require('../db');
const { authenticate, requireAdmin } = require('../middleware/authGuard');
const {
  validateEmail,
  validateUsername,
  validateRole,
  validateCustomPermissions,
  generateTemporaryPassword,
} = require('../validators');

const router = express.Router();

// Every route here is Admin-only and mutates account state, so it gets its
// own (slightly more generous than login's) rate limit rather than sharing
// the login/register limiter.
const adminActionLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Try again in a few minutes.' },
});

router.use(authenticate, requireAdmin, adminActionLimiter);

const SAFE_COLUMNS = 'id, username, email, organisation, role, custom_permissions, created_at, last_login_at';

// ---- GET /api/users — everyone in the admin's organisation ----
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ${SAFE_COLUMNS} FROM users WHERE organisation = $1 ORDER BY created_at ASC`,
      [req.authUser.organisation]
    );
    res.json({ users: result.rows });
  } catch (err) {
    console.error('List users error:', err);
    res.status(500).json({ error: 'Could not load users. Please try again.' });
  }
});

// ---- POST /api/users/invite — admin-provisions a new account ----
// There's no email service configured, so this can't send mail: it creates
// the account outright and hands back a one-time temporary password for the
// admin to share with the person directly.
router.post('/invite', async (req, res) => {
  try {
    const { username, email, role, customPermissions } = req.body || {};

    const usernameCheck = validateUsername(username);
    if (!usernameCheck.valid) return res.status(400).json({ field: 'username', error: usernameCheck.reason });

    const emailCheck = validateEmail(email);
    if (!emailCheck.valid) return res.status(400).json({ field: 'email', error: emailCheck.reason });

    const roleCheck = validateRole(role);
    if (!roleCheck.valid) return res.status(400).json({ field: 'role', error: roleCheck.reason });

    let permsToStore = null;
    if (roleCheck.value === 'custom') {
      const permsCheck = validateCustomPermissions(customPermissions);
      if (!permsCheck.valid) return res.status(400).json({ field: 'customPermissions', error: permsCheck.reason });
      permsToStore = permsCheck.value;
    }

    const existing = await pool.query(
      'SELECT id FROM users WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($2)',
      [usernameCheck.value, email.trim()]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'An account with that username or email already exists.' });
    }

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await bcrypt.hash(temporaryPassword, 12);

    const result = await pool.query(
      `INSERT INTO users (username, email, password_hash, organisation, role, custom_permissions)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${SAFE_COLUMNS}`,
      [
        usernameCheck.value, email.trim().toLowerCase(), passwordHash, req.authUser.organisation, roleCheck.value,
        permsToStore ? JSON.stringify(permsToStore) : null,
      ]
    );

    res.status(201).json({ user: result.rows[0], temporaryPassword });
  } catch (err) {
    console.error('Invite user error:', err);
    res.status(500).json({ error: 'Something went wrong creating that account. Please try again.' });
  }
});

// Shared lookup: only ever act on a user in the admin's own organisation.
async function findManagedUser(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'Invalid user id.' });
    return null;
  }
  const result = await pool.query(
    `SELECT ${SAFE_COLUMNS} FROM users WHERE id = $1 AND organisation = $2`,
    [id, req.authUser.organisation]
  );
  if (result.rows.length === 0) {
    res.status(404).json({ error: 'User not found.' });
    return null;
  }
  return result.rows[0];
}

// ---- PATCH /api/users/:id/role ----
router.patch('/:id/role', async (req, res) => {
  try {
    const user = await findManagedUser(req, res);
    if (!user) return;

    if (user.id === req.authUser.sub) {
      return res.status(400).json({ error: "You can't change your own role. Ask another Admin to do this." });
    }

    const { role, customPermissions } = req.body || {};
    const roleCheck = validateRole(role);
    if (!roleCheck.valid) return res.status(400).json({ field: 'role', error: roleCheck.reason });

    let permsToStore = null;
    if (roleCheck.value === 'custom') {
      const permsCheck = validateCustomPermissions(customPermissions);
      if (!permsCheck.valid) return res.status(400).json({ field: 'customPermissions', error: permsCheck.reason });
      permsToStore = permsCheck.value;
    }
    // Switching away from 'custom' clears any stored permissions rather than leaving stale data behind.
    // Bumping token_version invalidates every session token already issued to
    // this user — otherwise their existing (up to 7-day-old) cookie would
    // keep granting the OLD role/permissions until it naturally expired,
    // since the JWT itself never gets rewritten mid-flight. See
    // middleware/authGuard.js's verifySession().
    const result = await pool.query(
      `UPDATE users SET role = $1, custom_permissions = $2, token_version = token_version + 1 WHERE id = $3 RETURNING ${SAFE_COLUMNS}`,
      [roleCheck.value, permsToStore ? JSON.stringify(permsToStore) : null, user.id]
    );
    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error('Change role error:', err);
    res.status(500).json({ error: 'Could not update that role. Please try again.' });
  }
});

// ---- POST /api/users/:id/reset-password ----
router.post('/:id/reset-password', async (req, res) => {
  try {
    const user = await findManagedUser(req, res);
    if (!user) return;

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await bcrypt.hash(temporaryPassword, 12);
    // Also bumps token_version — a password reset should sign the user out
    // of any existing session everywhere, not just require the new password
    // on their next un-forced request.
    await pool.query('UPDATE users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2', [passwordHash, user.id]);

    res.json({ user, temporaryPassword });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Could not reset that password. Please try again.' });
  }
});

// ---- DELETE /api/users/:id ----
router.delete('/:id', async (req, res) => {
  try {
    const user = await findManagedUser(req, res);
    if (!user) return;

    if (user.id === req.authUser.sub) {
      return res.status(400).json({ error: "You can't delete your own account." });
    }

    await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete user error:', err);
    res.status(500).json({ error: 'Could not delete that user. Please try again.' });
  }
});

module.exports = router;
