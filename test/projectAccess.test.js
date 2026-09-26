// grantCoversEnvironment() — the environment-matching predicate previously
// re-implemented independently as `envs.includes('*') || envs.includes(x)`
// in liveMode.js, pii.js, and workspace.js (twice). Pure function, zero-DB,
// same node:test style as the rest of this directory.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused@127.0.0.1:1/none';
process.env.MASTER_KEY = process.env.MASTER_KEY || Buffer.alloc(32, 9).toString('base64');

const test = require('node:test');
const assert = require('node:assert/strict');
const { grantCoversEnvironment, environmentAllowed } = require('../server/projectAccess');

test('grantCoversEnvironment: allows an environment explicitly listed', () => {
  assert.equal(grantCoversEnvironment(['sit', 'uat'], 'sit'), true);
});

test('grantCoversEnvironment: denies an environment not listed', () => {
  assert.equal(grantCoversEnvironment(['sit', 'uat'], 'prod'), false);
});

test('grantCoversEnvironment: wildcard covers any environment', () => {
  assert.equal(grantCoversEnvironment(['*'], 'prod'), true);
  assert.equal(grantCoversEnvironment(['*'], 'anything-at-all'), true);
});

test('grantCoversEnvironment: treats a non-array as no access', () => {
  assert.equal(grantCoversEnvironment(null, 'sit'), false);
  assert.equal(grantCoversEnvironment(undefined, 'sit'), false);
  assert.equal(grantCoversEnvironment('sit', 'sit'), false);
});

test('grantCoversEnvironment: empty array covers nothing', () => {
  assert.equal(grantCoversEnvironment([], 'sit'), false);
});

/* ---------- environmentAllowed (pre-existing, added here for the same file's coverage) ---------- */

test('environmentAllowed: false when access has no view permission', () => {
  assert.equal(environmentAllowed({ canView: false, allowedEnvironments: 'all' }, 'sit'), false);
  assert.equal(environmentAllowed(null, 'sit'), false);
});

test('environmentAllowed: "all" covers any environment', () => {
  assert.equal(environmentAllowed({ canView: true, allowedEnvironments: 'all' }, 'prod'), true);
});

test('environmentAllowed: an explicit list only covers its own entries', () => {
  assert.equal(environmentAllowed({ canView: true, allowedEnvironments: ['sit'] }, 'sit'), true);
  assert.equal(environmentAllowed({ canView: true, allowedEnvironments: ['sit'] }, 'prod'), false);
});
