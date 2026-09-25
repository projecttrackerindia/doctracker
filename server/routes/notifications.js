const express = require('express');
const { authenticate } = require('../middleware/authGuard');
const notifications = require('../notifications');
const liveBus = require('../notificationsBus');

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

// --- Live stream (SSE) ------------------------------------------------------
// Same pattern as GET /api/workspace/observability/stream (see that route's
// header comment for the full rationale): plain HTTP, EventSource's native
// auto-reconnect, cookie auth. The one difference is the subscription key —
// this is per-RECIPIENT (organisation + this user), not per-organisation,
// since a notification is only ever meant for the one user it was written
// for (see notificationsBus.js's header comment for why that's a separate
// bus from observabilityBus.js rather than a reuse of it).
router.get('/stream', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const { organisation, sub: userId } = req.authUser;
  const send = (payload) => {
    try {
      res.write(`event: notification\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch (err) { /* the socket is gone; the close handler below cleans up */ }
  };
  const unsubscribe = liveBus.subscribe(organisation, userId, send);

  // Same 25s keep-alive as the observability stream — proxies/load balancers
  // drop a connection that goes quiet.
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (err) { /* same as above */ }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
    try { res.end(); } catch (err) { /* already closed */ }
  });
});

module.exports = router;
