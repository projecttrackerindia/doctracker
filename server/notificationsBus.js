// ============================================================================
// Fan-out for live notification pushes (bell badge, doc-access status
// changes, alert firing/resolving — anything that already goes through
// server/notifications.js).
//
// Deliberately a SEPARATE module from server/observabilityBus.js rather than
// a reuse of it, for two reasons:
//   1. Notifications are scoped per RECIPIENT (`organisation:userId`), not
//      per organisation — an org-wide channel would mean every open tab in
//      the org receives every user's notification and has to filter its own
//      out client-side, which is a data-exposure smell (e.g. "so-and-so's
//      Live Mode grants changed" leaking to every browser in the org) for no
//      real benefit, since the actual subscriber set is always one user.
//   2. It keeps notification traffic off the same Redis channel/local Map as
//      metrics traffic, so a busy Observability agent push and a quiet
//      notification stream never contend for the same Set of callbacks.
//
// Otherwise this is the exact same shape as observabilityBus.js: an
// in-process Map of subscribers, relayed through Redis pub/sub when
// REDIS_URL is set so a push landing on one instance still reaches a
// subscriber connected to a different one, and pure in-process fan-out
// (correct for a single-instance deploy) when it isn't.
// ============================================================================
const CHANNEL = 'doctracker:notif';

// "organisation:userId" -> Set<callback>
const localSubscribers = new Map();

let publisher = null;
let subscriber = null;

if (process.env.REDIS_URL) {
  try {
    const Redis = require('ioredis');
    publisher = new Redis(process.env.REDIS_URL);
    subscriber = new Redis(process.env.REDIS_URL);
    publisher.on('error', (err) => console.error('Redis (notifications bus, publisher) error:', err.message));
    subscriber.on('error', (err) => console.error('Redis (notifications bus, subscriber) error:', err.message));
    subscriber.subscribe(CHANNEL, (err) => {
      if (err) console.error('Notifications bus: could not subscribe to Redis channel:', err.message);
      else console.log('Live notification updates: fanning out via Redis pub/sub.');
    });
    subscriber.on('message', (channel, raw) => {
      if (channel !== CHANNEL) return;
      try {
        const { key, payload } = JSON.parse(raw);
        deliverLocal(key, payload);
      } catch (err) {
        console.error('Notifications bus: malformed message from Redis:', err.message);
      }
    });
  } catch (err) {
    console.warn('REDIS_URL is set but ioredis failed to load — live notification updates will be per-instance only.', err.message);
    publisher = null;
    subscriber = null;
  }
}

function deliverLocal(key, payload) {
  const listeners = localSubscribers.get(key);
  if (!listeners) return;
  for (const listener of listeners) {
    try {
      listener(payload);
    } catch (err) {
      // One broken subscriber (a socket that died between the close event and
      // this tick) must not stop the others from being notified.
      console.error('Notifications bus: subscriber threw, continuing:', err.message);
    }
  }
}

function subscribe(organisation, userId, callback) {
  const key = `${organisation}:${userId}`;
  if (!localSubscribers.has(key)) localSubscribers.set(key, new Set());
  localSubscribers.get(key).add(callback);
  return function unsubscribe() {
    const listeners = localSubscribers.get(key);
    if (!listeners) return;
    listeners.delete(callback);
    if (!listeners.size) localSubscribers.delete(key);
  };
}

// Never awaited by callers on the notify path: a live-update fan-out failing
// must not fail (or slow down) the write that already durably created the
// notification row.
function publish(organisation, userId, payload) {
  const key = `${organisation}:${userId}`;
  deliverLocal(key, payload);
  if (publisher) {
    publisher
      .publish(CHANNEL, JSON.stringify({ key, payload }))
      .catch((err) => console.error('Notifications bus: Redis publish failed:', err.message));
  }
}

function subscriberCount(organisation, userId) {
  return localSubscribers.get(`${organisation}:${userId}`)?.size || 0;
}

module.exports = { subscribe, publish, subscriberCount };
