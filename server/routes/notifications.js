const express = require('express');
const { authenticate } = require('../middleware/authGuard');
const notifications = require('../notifications');

const router = express.Router();
router.use(authenticate);
// Deliberately NOT behind blockIfScheduleLocked — a locked-out user should
// still be able to see *that* they were, say, approved/denied for something
// while outside their access window, same reasoning GET /api/auth/me already
// follows for the schedule banner itself.

// GET /api/notifications?limit=30&beforeId=123 — newest first, cursor-paginated.
router.get('/', async (req, res) => {
  try {
    const { notifications: rows, hasMore } = await notifications.listForUser(req.authUser.sub, {
      limit: req.query.limit,
      beforeId: req.query.beforeId ? Number(req.query.beforeId) : null,
    });
    res.json({ notifications: rows, hasMore });
  } catch (err) {
    console.error('GET /api/notifications failed:', err);
    res.status(500).json({ error: 'Could not load notifications.' });
  }
});

// GET /api/notifications/unread-count — cheap, polled frequently for the bell badge.
router.get('/unread-count', async (req, res) => {
  try {
    const count = await notifications.unreadCount(req.authUser.sub);
    res.json({ count });
  } catch (err) {
    console.error('GET /api/notifications/unread-count failed:', err);
    res.status(500).json({ error: 'Could not load unread count.' });
  }
});

// POST /api/notifications/:id/read
router.post('/:id/read', async (req, res) => {
  try {
    await notifications.markRead(req.authUser.sub, Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/notifications/:id/read failed:', err);
    res.status(500).json({ error: 'Could not mark notification read.' });
  }
});

// POST /api/notifications/read-all
router.post('/read-all', async (req, res) => {
  try {
    await notifications.markAllRead(req.authUser.sub);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/notifications/read-all failed:', err);
    res.status(500).json({ error: 'Could not mark notifications read.' });
  }
});

module.exports = router;
