const express = require('express');
const bcrypt = require('bcryptjs');
const { createRateLimiter } = require('../rateLimitStore');
const { pool } = require('../db');
const { authenticate, requireAdmin } = require('../middleware/authGuard');
const { notifyUser } = require('../notifications');
const {
  validateEmail,
  validateUsername,
  validateRole,
  validateCustomPermissions,
  validateAccessSchedule,
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

const SAFE_COLUMNS = `id, username, email, organisation, role, custom_permissions, access_schedule, created_at, last_login_at,
  mfa_enabled, password_reset_requested_at,
  (locked_until IS NOT NULL AND locked_until > now()) AS locked,
  locked_until`;

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
    const { username, email, role, customPermissions, accessSchedule } = req.body || {};

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

    const scheduleCheck = validateAccessSchedule(accessSchedule);
    if (!scheduleCheck.valid) return res.status(400).json({ field: 'accessSchedule', error: scheduleCheck.reason });

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
      `INSERT INTO users (username, email, password_hash, organisation, role, custom_permissions, access_schedule)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${SAFE_COLUMNS}`,
      [
        usernameCheck.value, email.trim().toLowerCase(), passwordHash, req.authUser.organisation, roleCheck.value,
        permsToStore ? JSON.stringify(permsToStore) : null,
        scheduleCheck.value ? JSON.stringify(scheduleCheck.value) : null,
      ]
    );

    // Waiting for them the first time they log in — closes the last of the
    // "blind spot" cases from the notification audit: previously a brand-new
    // account had no equivalent of a welcome email, nothing telling them who
    // set the account up or what role/permissions they're starting with.
    // Best-effort: a notification failure shouldn't fail account creation,
    // and this runs before res.json() so a thrown error is still caught by
    // the outer catch below instead of crashing on a double response.
    await notifyUser(result.rows[0].id, {
      organisation: req.authUser.organisation,
      type: 'ACCOUNT_CREATED',
      title: `Welcome — your account was set up by ${req.authUser.username}`,
      body: `Role: ${roleCheck.value}`,
      link: null,
    }).catch((err) => console.error('Welcome notification failed:', err));

    res.status(201).json({ user: result.rows[0], temporaryPassword });
  } catch (err) {
    console.error('Invite user error:', err);
    res.status(500).json({ error: 'Something went wrong creating that account. Please try again.' });
  }
});

// ---- POST /api/users/invite-bulk — provision several accounts at once ----
// Same per-user validation, temp-password generation, and safe-role handling
// as POST /invite, just looped over a small array instead of one call per
// person. All-or-nothing: if any row fails validation or collides with an
// existing account (or with ANOTHER row in the same batch), nothing is
// created and the response lists every problem found, by index, so the
// admin can fix the CSV/list and resubmit rather than guess which of 20
// people actually got an account.
const MAX_BULK_INVITE = 50;

router.post('/invite-bulk', async (req, res) => {
  try {
    const { users: incoming } = req.body || {};
    if (!Array.isArray(incoming) || incoming.length === 0) {
      return res.status(400).json({ error: 'Expected { users: [ { username, email, role, ... }, ... ] }.' });
    }
    if (incoming.length > MAX_BULK_INVITE) {
      return res.status(400).json({ error: `Too many accounts in one batch (max ${MAX_BULK_INVITE}).` });
    }

    const errors = [];
    const checked = [];
    const seenUsernames = new Map(); // lowercase username -> first index that used it
    const seenEmails = new Map();

    for (let i = 0; i < incoming.length; i += 1) {
      const row = incoming[i] || {};
      const { username, email, role, customPermissions, accessSchedule } = row;

      const usernameCheck = validateUsername(username);
      if (!usernameCheck.valid) { errors.push({ index: i, field: 'username', error: usernameCheck.reason }); continue; }

      const emailCheck = validateEmail(email);
      if (!emailCheck.valid) { errors.push({ index: i, field: 'email', error: emailCheck.reason }); continue; }

      const roleCheck = validateRole(role);
      if (!roleCheck.valid) { errors.push({ index: i, field: 'role', error: roleCheck.reason }); continue; }

      let permsToStore = null;
      if (roleCheck.value === 'custom') {
        const permsCheck = validateCustomPermissions(customPermissions);
        if (!permsCheck.valid) { errors.push({ index: i, field: 'customPermissions', error: permsCheck.reason }); continue; }
        permsToStore = permsCheck.value;
      }

      const scheduleCheck = validateAccessSchedule(accessSchedule);
      if (!scheduleCheck.valid) { errors.push({ index: i, field: 'accessSchedule', error: scheduleCheck.reason }); continue; }

      const uKey = usernameCheck.value.toLowerCase();
      const eKey = email.trim().toLowerCase();
      if (seenUsernames.has(uKey)) {
        errors.push({ index: i, field: 'username', error: `Duplicate of row ${seenUsernames.get(uKey)} in this same batch.` });
        continue;
      }
      if (seenEmails.has(eKey)) {
        errors.push({ index: i, field: 'email', error: `Duplicate of row ${seenEmails.get(eKey)} in this same batch.` });
        continue;
      }
      seenUsernames.set(uKey, i);
      seenEmails.set(eKey, i);

      checked.push({
        index: i,
        username: usernameCheck.value,
        email: eKey,
        role: roleCheck.value,
        customPermissions: permsToStore,
        accessSchedule: scheduleCheck.value,
      });
    }

    if (errors.length) {
      return res.status(400).json({ error: 'One or more accounts could not be validated.', errors });
    }

    const existing = await pool.query(
      `SELECT username, email FROM users WHERE LOWER(username) = ANY($1::text[]) OR LOWER(email) = ANY($2::text[])`,
      [checked.map((c) => c.username.toLowerCase()), checked.map((c) => c.email)]
    );
    if (existing.rows.length) {
      const existingUsernames = new Set(existing.rows.map((r) => r.username.toLowerCase()));
      const existingEmails = new Set(existing.rows.map((r) => r.email.toLowerCase()));
      const collisions = checked
        .filter((c) => existingUsernames.has(c.username.toLowerCase()) || existingEmails.has(c.email))
        .map((c) => ({ index: c.index, error: 'An account with that username or email already exists.' }));
      return res.status(409).json({ error: 'One or more accounts already exist.', errors: collisions });
    }

    const client = await pool.connect();
    let created;
    try {
      await client.query('BEGIN');
      created = [];
      for (const c of checked) {
        const temporaryPassword = generateTemporaryPassword();
        const passwordHash = await bcrypt.hash(temporaryPassword, 12);
        const result = await client.query(
          `INSERT INTO users (username, email, password_hash, organisation, role, custom_permissions, access_schedule)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING ${SAFE_COLUMNS}`,
          [
            c.username, c.email, passwordHash, req.authUser.organisation, c.role,
            c.customPermissions ? JSON.stringify(c.customPermissions) : null,
            c.accessSchedule ? JSON.stringify(c.accessSchedule) : null,
          ]
        );
        created.push({ user: result.rows[0], temporaryPassword });
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    // Best-effort, same as the single-invite welcome notification — never
    // lets a notification failure undo or fail the accounts already created.
    await Promise.all(created.map((c) => notifyUser(c.user.id, {
      organisation: req.authUser.organisation,
      type: 'ACCOUNT_CREATED',
      title: `Welcome — your account was set up by ${req.authUser.username}`,
      body: `Role: ${c.user.role}`,
      link: null,
    }).catch((err) => console.error('Welcome notification failed:', err))));

    res.status(201).json({ created });
  } catch (err) {
    console.error('Bulk invite users error:', err);
    res.status(500).json({ error: 'Something went wrong creating those accounts. Please try again.' });
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

// ---- PATCH /api/users/:id/access-schedule ----
// Deliberately its own endpoint, separate from /role above — setting or
// extending someone's allowed hours/days shouldn't require re-submitting
// their role and (for custom accounts) every environment/canEdit checkbox
// just to change a time. Sending `{ accessSchedule: null }` (or
// `{ enabled: false }`) turns the restriction off entirely, which is also
// how an Admin "extends" someone past a window that already locked them
// out — there's no separate extend action, just widen or disable the window.
router.patch('/:id/access-schedule', async (req, res) => {
  try {
    const user = await findManagedUser(req, res);
    if (!user) return;

    const scheduleCheck = validateAccessSchedule(req.body?.accessSchedule);
    if (!scheduleCheck.valid) return res.status(400).json({ field: 'accessSchedule', error: scheduleCheck.reason });

    // Not a security boundary the way role/password changes are, so this
    // doesn't bump token_version — the schedule is re-evaluated against the
    // server clock on every single request anyway (see authGuard.js), so a
    // change takes effect on the person's very next request regardless of
    // how old their session token is.
    const result = await pool.query(
      `UPDATE users SET access_schedule = $1 WHERE id = $2 RETURNING ${SAFE_COLUMNS}`,
      [scheduleCheck.value ? JSON.stringify(scheduleCheck.value) : null, user.id]
    );
    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error('Update access schedule error:', err);
    res.status(500).json({ error: 'Could not update that access window. Please try again.' });
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
    // on their next un-forced request. Also clears any lockout (Finding
    // F-04) and marks a pending self-service request (if any) resolved,
    // since an Admin completing this action is exactly what that request
    // was asking for.
    await pool.query(
      `UPDATE users SET password_hash = $1, token_version = token_version + 1,
       failed_login_count = 0, locked_until = NULL, password_reset_requested_at = NULL WHERE id = $2`,
      [passwordHash, user.id]
    );

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
