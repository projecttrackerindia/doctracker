// ============================================================================
// Fan-out for live observability updates.
//
// When an agent pushes, every browser currently watching that organisation's
// Observability page should hear about it immediately (see the /stream route
// in server/routes/observability.js). That is trivial with one server process
// and an in-memory listener list - but the agent's push and the browser's SSE
// connection can land on DIFFERENT instances once this runs more than one, and
// then the push notifies nobody.
//
// So: always notify local subscribers, and ALSO relay through Redis pub/sub
// when REDIS_URL is set, so an instance that received the push can wake the
// listeners held by its siblings. With no Redis configured this degrades to
// purely in-process fan-out, which is correct for a single-instance deploy -
// exactly the same optional-Redis posture as server/cache.js and
// server/rateLimitStore.js.
// ============================================================================
const CHANNEL = 'doctracker:obs';

// organisation -> Set<callback>
const localSubscribers = new Map();

let publisher = null;
let subscriber = null;

if (process.env.REDIS_URL) {
  try {
    const Redis = require('ioredis');
    publisher = new Redis(process.env.REDIS_URL);
    subscriber = new Redis(process.env.REDIS_URL);
    publisher.on('error', (err) => console.error('Redis (observability bus, publisher) error:', err.message));
    subscriber.on('error', (err) => console.error('Redis (observability bus, subscriber) error:', err.message));
    subscriber.subscribe(CHANNEL, (err) => {
      if (err) console.error('Observability bus: could not subscribe to Redis channel:', err.message);
      else console.log('Observability live updates: fanning out via Redis pub/sub.');
    });
    subscriber.on('message', (channel, raw) => {
      if (channel !== CHANNEL) return;
      try {
        const { organisation, payload } = JSON.parse(raw);
        deliverLocal(organisation, payload);
      } catch (err) {
        console.error('Observability bus: malformed message from Redis:', err.message);
      }
    });
  } catch (err) {
    console.warn('REDIS_URL is set but ioredis failed to load — live observability updates will be per-instance only.', err.message);
    publisher = null;
    subscriber = null;
  }
}

function deliverLocal(organisation, payload) {
  const listeners = localSubscribers.get(organisation);
  if (!listeners) return;
  for (const listener of listeners) {
    try {
      listener(payload);
    } catch (err) {
      // One broken subscriber (a socket that died between the close event and
      // this tick) must not stop the others from being notified.
      console.error('Observability bus: subscriber threw, continuing:', err.message);
    }
  }
}

function subscribe(organisation, callback) {
  if (!localSubscribers.has(organisation)) localSubscribers.set(organisation, new Set());
  localSubscribers.get(organisation).add(callback);
  return function unsubscribe() {
    const listeners = localSubscribers.get(organisation);
    if (!listeners) return;
    listeners.delete(callback);
    if (!listeners.size) localSubscribers.delete(organisation);
  };
}

// Never awaited by callers on the ingest path: a live-update fan-out failing
// must not fail (or slow down) the agent's push, which has already been
// durably written by the time this is called.
function publish(organisation, payload) {
  deliverLocal(organisation, payload);
  if (publisher) {
    publisher
      .publish(CHANNEL, JSON.stringify({ organisation, payload }))
      .catch((err) => console.error('Observability bus: Redis publish failed:', err.message));
  }
}

function subscriberCount(organisation) {
  return localSubscribers.get(organisation)?.size || 0;
}

module.exports = { subscribe, publish, subscriberCount };
