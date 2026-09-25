// A short-TTL cache in front of observabilityStore.js's two most expensive
// reads (getSummary/getSeries) — each is several aggregate queries over
// potentially millions of rollup rows for a wide date range, and the
// Observability console's own auto-refresh plus multiple viewers on the same
// org/environment mean the same query shape repeats constantly.
//
// Deliberately NOT the same generation-counter invalidation server/cache.js
// uses for GET /api/workspace: that pattern fits workspace because writes
// (project save/delete) are rare, so bumping a version on every write is
// cheap. Rollup data is written by the ingest route roughly every 5 seconds
// per active org — invalidating on every write would mean this almost never
// actually serves a cache hit for an active org, defeating the purpose. A
// short flat TTL (15s — half the workspace cache's, since this data is
// meant to feel closer to live) accepts brief staleness instead, the same
// tradeoff any monitoring dashboard with a refresh interval already makes.
//
// Entirely optional: if REDIS_URL isn't set, every call below is a no-op
// (get always misses, set does nothing) — observabilityStore.js behaves
// exactly as it did with no cache at all.
const TTL_SECONDS = 15;

let redisClient = null;
if (process.env.REDIS_URL) {
  try {
    const Redis = require('ioredis');
    redisClient = new Redis(process.env.REDIS_URL);
    redisClient.on('error', (err) => console.error('Redis (observability cache) connection error:', err.message));
  } catch (err) {
    console.warn('REDIS_URL is set but ioredis failed to load — observability reads will not be cached.', err.message);
    redisClient = null;
  }
}

function isEnabled() {
  return Boolean(redisClient);
}

// `kind` separates getSummary's cache space from getSeries's; `parts` is an
// array of the call's own arguments (organisation, environment, from, to,
// ...) — joined rather than JSON.stringify'd on an options object so key
// order is stable regardless of how the caller constructs it.
function buildKey(kind, parts) {
  return `obs:${kind}:${parts.map((p) => (p === undefined || p === null ? '' : String(p))).join('|')}`;
}

async function get(kind, parts) {
  if (!redisClient) return undefined;
  try {
    const raw = await redisClient.get(buildKey(kind, parts));
    return raw ? JSON.parse(raw) : undefined;
  } catch (err) {
    console.error('Observability cache read failed (falling back to a live query):', err.message);
    return undefined;
  }
}

async function set(kind, parts, payload) {
  if (!redisClient) return;
  try {
    await redisClient.set(buildKey(kind, parts), JSON.stringify(payload), 'EX', TTL_SECONDS);
  } catch (err) {
    console.error('Observability cache write failed (non-fatal):', err.message);
  }
}

module.exports = { isEnabled, get, set };
