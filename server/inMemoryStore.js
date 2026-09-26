// A narrow Redis subset — get/set with EX, incr — backed by a capped
// in-process Map. This is the single-instance fallback for cache.js and
// obsCache.js when REDIS_URL isn't set, so a deployment that hasn't
// configured Redis gets SOME caching instead of none (previously every
// getter in both modules was a hard no-op without it — see their own header
// comments). Same trade rateLimitStore.js already makes for rate limiting:
// in-process is correct for one instance, Redis is what makes it correct
// across many.
//
// Deliberately not a general-purpose cache client — only the two call
// patterns cache.js/obsCache.js actually use against a real ioredis client
// are implemented, with the same signatures, so both modules can hold one
// `store` reference (real Redis or this) without branching at every call
// site:
//   - get(key)                       -> string | null
//   - set(key, value, 'EX', seconds) -> sets with expiry
//   - incr(key)                      -> increments (from 0 if absent)
//
// One real divergence from Redis semantics: a real INCR preserves whatever
// TTL the key already had. This never matters for the one key that's ever
// incr'd here (workspace:ver:<org> — always incr'd, never given a TTL by
// anything), so it's left unhandled rather than built out for a case that
// doesn't occur.
const MAX_ENTRIES = parseInt(process.env.IN_PROCESS_CACHE_MAX_ENTRIES || '5000', 10);

const store = new Map(); // key -> { value: string, expiresAt: number|null }

function evictIfOverCap() {
  // Map preserves insertion order; re-inserting a key on every set()/incr()
  // (see below) moves it to the end, so the front of the iteration order is
  // always the least-recently-written entry — close enough to LRU for a
  // bounded safety cap, without pulling in a real LRU library for it.
  while (store.size > MAX_ENTRIES) {
    const oldestKey = store.keys().next().value;
    store.delete(oldestKey);
  }
}

function get(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

function set(key, value, mode, ttlSeconds) {
  const expiresAt = mode === 'EX' && ttlSeconds ? Date.now() + ttlSeconds * 1000 : null;
  store.delete(key);
  store.set(key, { value: String(value), expiresAt });
  evictIfOverCap();
}

function incr(key) {
  const next = (parseInt(get(key), 10) || 0) + 1;
  store.delete(key);
  store.set(key, { value: String(next), expiresAt: null });
  evictIfOverCap();
  return next;
}

module.exports = { get, set, incr };
