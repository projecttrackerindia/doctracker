// ============================================================================
// Fan-out for "something in this organisation's workspace changed" pushes —
// the generic third bus described in the Phase 2 real-time plan, alongside
// notificationsBus.js (per-recipient) and observabilityBus.js (per-org
// metrics traffic). Scoped per organisation, same as observabilityBus.js,
// since a workspace change (an endpoint saved, a project promoted, a
// rollback) is relevant to everyone currently looking at that org's
// workspace, not just the user who made it.
//
// Exact same shape as the other two buses on purpose: in-process Map
// fan-out, relayed through Redis pub/sub when REDIS_URL is set so a push
// landing on one instance still reaches a subscriber connected to a
// sibling, pure in-process fan-out (correct for a single-instance deploy)
// when it isn't.
//
// The only publisher today is auditService.js's insertAuditRow() — audit_logs
// is already, by its own header comment, "the single place that ever writes
// to audit_logs," and virtually every meaningful workspace change (endpoint/
// project saves, promotions, rollbacks, access changes, PII rule edits) is
// already recorded there, from either the client (POST /api/audit/events) or
// a server route directly (recordAuditEvent/recordSystemAuditEvent). Hooking
// that one function gives every consumer of this bus a live "something
// changed" signal without a separate publish call at each of those ~15 write
// paths — the type-specific events sketched in the architecture review
// (project.saved/access.changed/release.updated) can be split out later if a
// consumer ever needs to tell them apart without also fetching the row.
// ============================================================================
const CHANNEL = 'doctracker:wsevents';

// organisation -> Set<callback>
const localSubscribers = new Map();

let publisher = null;
let subscriber = null;

if (process.env.REDIS_URL) {
  try {
    const Redis = require('ioredis');
    publisher = new Redis(process.env.REDIS_URL);
    subscriber = new Redis(process.env.REDIS_URL);
    publisher.on('error', (err) => console.error('Redis (workspace events bus, publisher) error:', err.message));
    subscriber.on('error', (err) => console.error('Redis (workspace events bus, subscriber) error:', err.message));
    subscriber.subscribe(CHANNEL, (err) => {
      if (err) console.error('Workspace events bus: could not subscribe to Redis channel:', err.message);
      else console.log('Live workspace updates: fanning out via Redis pub/sub.');
    });
    subscriber.on('message', (channel, raw) => {
      if (channel !== CHANNEL) return;
      try {
        const { organisation, payload } = JSON.parse(raw);
        deliverLocal(organisation, payload);
      } catch (err) {
        console.error('Workspace events bus: malformed message from Redis:', err.message);
      }
    });
  } catch (err) {
    console.warn('REDIS_URL is set but ioredis failed to load — live workspace updates will be per-instance only.', err.message);
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
      console.error('Workspace events bus: subscriber threw, continuing:', err.message);
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

// Never awaited by callers on the write path: a live-update fan-out failing
// must not fail (or slow down) the write that already durably committed.
function publish(organisation, payload) {
  deliverLocal(organisation, payload);
  if (publisher) {
    publisher
      .publish(CHANNEL, JSON.stringify({ organisation, payload }))
      .catch((err) => console.error('Workspace events bus: Redis publish failed:', err.message));
  }
}

function subscriberCount(organisation) {
  return localSubscribers.get(organisation)?.size || 0;
}

module.exports = { subscribe, publish, subscriberCount };
