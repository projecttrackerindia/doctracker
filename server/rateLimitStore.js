const rateLimit = require('express-rate-limit');

// express-rate-limit's default store is in-memory, per Node process. That's
// correct for a single Railway instance, but the moment this app runs 2+
// replicas, each instance tracks its own hit counts — someone could get
// roughly (replicas × limit) attempts by landing on different instances.
//
// If REDIS_URL is set, every limiter created via createRateLimiter() below
// shares counts through Redis instead, so the limit is enforced consistently
// no matter how many instances are running. If it's not set (or the redis
// packages aren't installed), this falls back to the exact previous
// behavior — a plain in-memory express-rate-limit — so nothing breaks for
// a single-instance deployment that hasn't set up Redis.
let RedisStore = null;
let redisClient = null;

if (process.env.REDIS_URL) {
  try {
    const Redis = require('ioredis');
    RedisStore = require('rate-limit-redis').default || require('rate-limit-redis');
    redisClient = new Redis(process.env.REDIS_URL);
    redisClient.on('error', (err) => console.error('Redis (rate limiter) connection error:', err.message));
    console.log('Rate limiting: using shared Redis store (REDIS_URL is set).');
  } catch (err) {
    console.warn(
      'REDIS_URL is set but ioredis/rate-limit-redis failed to load — falling back to per-instance in-memory rate limiting.',
      err.message
    );
    RedisStore = null;
    redisClient = null;
  }
} else {
  console.log('Rate limiting: REDIS_URL not set — using per-instance in-memory store (fine for a single instance).');
}

function createRateLimiter(options) {
  if (RedisStore && redisClient) {
    return rateLimit({
      ...options,
      store: new RedisStore({
        prefix: 'rl:',
        sendCommand: (...args) => redisClient.call(...args),
      }),
    });
  }
  return rateLimit(options);
}

module.exports = { createRateLimiter };
