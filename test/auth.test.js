// Account-lockout decision logic (Finding F-04) — pure functions extracted
// from server/routes/auth.js's POST /login so the boundary cases (exactly
// at the lockout threshold, a lock that has just expired, the "at least 1
// minute" rounding in the lockout message) can be exercised without a
// database or a real clock. Same zero-DB, node:test style as every other
// file in this directory.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused@127.0.0.1:1/none';
process.env.MASTER_KEY = process.env.MASTER_KEY || Buffer.alloc(32, 9).toString('base64');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-not-a-real-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../server/routes/auth');

const { checkAccountLockout, nextFailedLoginState } = auth;

/* ---------- checkAccountLockout ---------- */

test('no locked_until at all is not locked', () => {
  assert.deepEqual(checkAccountLockout(null, Date.now()), { locked: false, minutesLeft: 0 });
});

test('a locked_until in the future is locked', () => {
  const now = 1_800_000_000_000;
  const d = checkAccountLockout(new Date(now + 5 * 60000).toISOString(), now);
  assert.equal(d.locked, true);
});

test('a locked_until exactly now (or in the past) reads as expired, not locked', () => {
  const now = 1_800_000_000_000;
  assert.equal(checkAccountLockout(new Date(now).toISOString(), now).locked, false);
  assert.equal(checkAccountLockout(new Date(now - 1000).toISOString(), now).locked, false);
});

test('minutesLeft rounds up so a few seconds remaining never reads as 0', () => {
  const now = 1_800_000_000_000;
  const d = checkAccountLockout(new Date(now + 10 * 1000).toISOString(), now); // 10s left
  assert.equal(d.minutesLeft, 1);
});

test('minutesLeft rounds a partial minute up (14m30s left reads as 15, not 14)', () => {
  const now = 1_800_000_000_000;
  const d = checkAccountLockout(new Date(now + 14.5 * 60000).toISOString(), now);
  assert.equal(d.minutesLeft, 15);
});

/* ---------- nextFailedLoginState ---------- */

test('the first few wrong passwords just increment the counter', () => {
  for (let count = 0; count < 4; count++) {
    const d = nextFailedLoginState(count);
    assert.equal(d.shouldLock, false, `count ${count} should not lock yet`);
    assert.equal(d.failedCount, count + 1);
  }
});

test('the 5th wrong password (LOCKOUT_THRESHOLD) locks the account', () => {
  const d = nextFailedLoginState(4);
  assert.equal(d.shouldLock, true);
});

test('locking resets the counter to 0 rather than leaving it at the threshold', () => {
  // The counter's job ends once a lock starts — a stale non-zero count sitting
  // next to an already-expired lock would otherwise mean the very next wrong
  // password re-locks the account after only ONE attempt, not five.
  const d = nextFailedLoginState(4);
  assert.equal(d.failedCount, 0);
});

test('a null/undefined stored count (a never-failed account) is treated as 0', () => {
  const d = nextFailedLoginState(null);
  assert.equal(d.shouldLock, false);
  assert.equal(d.failedCount, 1);
});

test('a count already past the threshold (e.g. a lowered LOCKOUT_THRESHOLD after deploy) still locks', () => {
  const d = nextFailedLoginState(10);
  assert.equal(d.shouldLock, true);
});
