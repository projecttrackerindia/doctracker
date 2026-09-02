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
// Entirely optional: if REDIS_URL isn't set, every function below is a no-op
// (get always misses, bump does nothing) and GET /api/workspace behaves
// exactly as it did with no cache at all — no code path depends on this
// being enabled.

const TTL_SECONDS = 30;

let redisClient = null;
if (process.env.REDIS_URL) {
  try {
    const Redis = require('ioredis');
    redisClient = new Redis(process.env.REDIS_URL);
    redisClient.on('error', (err) => console.error('Redis (workspace cache) connection error:', err.message));
    console.log('Workspace cache: using shared Redis store (REDIS_URL is set).');
  } catch (err) {
    console.warn('REDIS_URL is set but ioredis failed to load — GET /api/workspace will not be cached.', err.message);
    redisClient = null;
  }
}

function isEnabled() {
  return Boolean(redisClient);
}

async function getWorkspace(org, userId) {
  if (!redisClient) return null;
  try {
    const ver = (await redisClient.get(`workspace:ver:${org}`)) || '1';
    const raw = await redisClient.get(`workspace:v${ver}:${org}:${userId}`);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.error('Workspace cache read failed (falling back to a live query):', err.message);
    return null;
  }
}

async function setWorkspace(org, userId, payload) {
  if (!redisClient) return;
  try {
    const ver = (await redisClient.get(`workspace:ver:${org}`)) || '1';
    await redisClient.set(`workspace:v${ver}:${org}:${userId}`, JSON.stringify(payload), 'EX', TTL_SECONDS);
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
  if (!redisClient) return;
  try {
    await redisClient.incr(`workspace:ver:${org}`);
  } catch (err) {
    console.error('Workspace cache invalidation failed (non-fatal — cache will serve stale data until its TTL expires):', err.message);
  }
}

module.exports = { isEnabled, getWorkspace, setWorkspace, invalidateOrg };
