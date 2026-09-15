// Smoke tests for the pure-logic parts of server/validators.js — no DB, no
// network, safe to run in CI with nothing but Node itself. This is a
// starting scaffold, not full coverage: extend it as routes/business logic
// get pulled into testable functions, and add route-level tests (with a
// real or mocked Postgres) separately once that's worth the setup cost.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateEmail,
  validateUsername,
  validateOrganisation,
  validateRole,
  evaluatePassword,
} = require('../server/validators');

test('validateEmail accepts a plausible work address', () => {
  const result = validateEmail('person@acme-corp.com');
  assert.equal(result.valid, true);
  assert.equal(result.kind, 'work');
});

test('validateEmail accepts gmail.com as the one allowed personal domain', () => {
  const result = validateEmail('person@gmail.com');
  assert.equal(result.valid, true);
  assert.equal(result.kind, 'gmail');
});

test('validateEmail rejects other freemail domains', () => {
  const result = validateEmail('person@yahoo.com');
  assert.equal(result.valid, false);
});

test('validateEmail rejects malformed addresses', () => {
  assert.equal(validateEmail('not-an-email').valid, false);
  assert.equal(validateEmail('').valid, false);
});

test('validateUsername rejects empty/too-short input', () => {
  assert.equal(validateUsername('').valid, false);
  assert.equal(validateUsername('ab').valid, false);
});

test('validateOrganisation rejects empty input', () => {
  assert.equal(validateOrganisation('').valid, false);
});

test('validateRole only accepts known, self-registerable roles', () => {
  assert.equal(validateRole('admin').valid, true);
  assert.equal(validateRole('editor').valid, true);
  assert.equal(validateRole('viewer').valid, true);
  assert.equal(validateRole('superuser').valid, false);
});

test('evaluatePassword rejects a common, short password', () => {
  const result = evaluatePassword('password1');
  assert.equal(result.valid, false);
  assert.ok(result.reasons.length > 0);
});

test('evaluatePassword rejects a password containing the username', () => {
  const result = evaluatePassword('vewe12345!Strong', { username: 'vewe' });
  assert.equal(result.checks.noPersonalInfo, false);
  assert.equal(result.valid, false);
});

test('evaluatePassword accepts a strong, unrelated password', () => {
  const result = evaluatePassword('Tr0ub4dor&3xample!', { username: 'someone', email: 'someone@example.com' });
  assert.equal(result.valid, true);
  assert.ok(result.score >= 3);
});

test('evaluatePassword rejects passwords over the 128-char ceiling', () => {
  const result = evaluatePassword('Aa1!' + 'x'.repeat(130));
  assert.equal(result.valid, false);
});
