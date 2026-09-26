// GET /api/workspace decrypts every project the caller can see on every
// single call — expensive, and usually returns the same data as 10 seconds
// ago. This adds a short-TTL cache in front of it, keyed per (organisation,
// user) since visibility differs per caller.
//
// Invalidation uses a generation counter per organisation instead of trying
// to delete matching keys: every write that could change what GET /workspace
// returns for that org (project save/delete/migrate/promote/visibility
// change) bumps `workspace:ver:<org>`. Cache keys embed the current
// generation, so a bump instantly makes every previously-cached entry for
// that org unreachable (they just age out of Redis on their own TTL) without
// needing a scan-and-delete over an unbounded key set — this matters once an
// org has many concurrent users, each with their own cached copy.
//
// If REDIS_URL isn't set, this now falls back to inMemoryStore.js (a capped
// in-process Map) rather than a hard no-op — a single-instance deployment
// gets real caching instead of none, at the cost of each instance keeping
// its own copy (correct there; Redis is what makes it correct across many
// instances). getWorkspace/setWorkspace/invalidateOrg below always go
// through `store`, whichever backend it is — nothing else in this module
// branches on which one is active.

const TTL_SECONDS = 30;
const inMemoryStore = require('./inMemoryStore');

let redisClient = null;
if (process.env.REDIS_URL) {
  try {
    const Redis = require('ioredis');
    redisClient = new Redis(process.env.REDIS_URL);
    redisClient.on('error', (err) => console.error('Redis (workspace cache) connection error:', err.message));
    console.log('Workspace cache: using shared Redis store (REDIS_URL is set).');
  } catch (err) {
    console.warn('REDIS_URL is set but ioredis failed to load — falling back to a per-instance in-memory workspace cache.', err.message);
    redisClient = null;
  }
} else {
  console.log('Workspace cache: REDIS_URL not set — using a per-instance in-memory cache (fine for a single instance).');
}

const store = redisClient || inMemoryStore;

// Reports whether this instance's cache is backed by shared Redis
// specifically (correct across multiple instances) as opposed to the
// in-memory fallback (correct only for this one instance) — used only for
// the /api/health diagnostic field, not to decide whether caching happens at
// all (it always does now; see `store` above).
function isEnabled() {
  return Boolean(redisClient);
}

// The version fallback here MUST be '0', not '1' - a fresh org's version key
// has genuinely never been written yet, and Redis/inMemoryStore's INCR on an
// absent key also produces 1 (same as any other absent-key INCR). If the
// read-side default here were also '1', the very FIRST invalidateOrg() call
// for a brand-new org would move the physical key from "absent, read as 1"
// to "present, value 1" - the SAME version from a reader's perspective, so
// that first invalidation would silently do nothing and the org's first
// save-after-load would serve stale data for up to TTL_SECONDS. Defaulting
// the absent case to '0' means the first real INCR (0 -> 1) always produces
// a version distinct from the implicit default, so it always actually busts
// the cache. Caught by a real get/set/invalidate/get round trip, not by
// inspection - the bug reads as correct until it's actually exercised.
async function getWorkspace(org, userId) {
  try {
    const ver = (await store.get(`workspace:ver:${org}`)) || '0';
    const raw = await store.get(`workspace:v${ver}:${org}:${userId}`);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.error('Workspace cache read failed (falling back to a live query):', err.message);
    return null;
  }
}

async function setWorkspace(org, userId, payload) {
  try {
    const ver = (await store.get(`workspace:ver:${org}`)) || '0';
    await store.set(`workspace:v${ver}:${org}:${userId}`, JSON.stringify(payload), 'EX', TTL_SECONDS);
  } catch (err) {
    console.error('Workspace cache write failed (non-fatal):', err.message);
  }
}

// Call after any write that changes what GET /api/workspace returns for this
// organisation — project save, delete, migrate, promote, or a visibility
// flip. Cheap (one INCR) and safe to call even when nothing actually changed
// visibility, since a slightly-too-eager invalidation just costs one extra
// decrypt on the next load, not correctness.
async function invalidateOrg(org) {
  try {
    await store.incr(`workspace:ver:${org}`);
  } catch (err) {
    console.error('Workspace cache invalidation failed (non-fatal — cache will serve stale data until its TTL expires):', err.message);
  }
}

module.exports = { isEnabled, getWorkspace, setWorkspace, invalidateOrg };
