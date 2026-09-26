// duplicateEndpointError() and endpointFieldsError() - the save-time gates
// PUT /api/workspace/projects applies to every endpoint in a project (see
// server/routes/workspace.js). Pinned here after a QA regression pass found
// four bugs where the editor's OWN client-side checks only confirmed a
// field wasn't empty - nothing enforced a leading slash, rejected
// whitespace in a path, caught a trailing-slash/case duplicate, capped the
// endpoint name's length, or constrained a response status code to a real
// HTTP range, and nothing server-side checked them either. Client-side
// validation is UX; these tests pin the actual gate.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.MASTER_KEY = process.env.MASTER_KEY || Buffer.alloc(32, 9).toString('base64');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused@127.0.0.1:1/none';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unused-test-secret';
const { duplicateEndpointError, endpointFieldsError } = require('../server/routes/workspace');

function project(endpoints) {
  return { id: 'p1', name: 'Test', endpoints };
}

// ---------- duplicateEndpointError ----------

test('an exact method+path duplicate is rejected (unchanged existing behavior)', () => {
  const err = duplicateEndpointError(project([
    { method: 'GET', path: '/x' },
    { method: 'GET', path: '/x' },
  ]));
  assert.ok(err, 'expected a duplicate error');
});

test('QA bug #1: a trailing slash no longer bypasses the duplicate check', () => {
  const err = duplicateEndpointError(project([
    { method: 'GET', path: '/qa/test-endpoint' },
    { method: 'GET', path: '/qa/test-endpoint/' },
  ]));
  assert.ok(err, 'expected a duplicate error - these resolve to the same editor URL slug');
});

test('a case-only difference no longer bypasses the duplicate check either', () => {
  // The editor's own endpointSlugFor()/slugify() (19-audit-log-page.js)
  // lowercases the path when building the URL - two endpoints differing
  // only by case collide on the same page address exactly like the
  // trailing-slash case does.
  const err = duplicateEndpointError(project([
    { method: 'GET', path: '/Qa/Test-Endpoint' },
    { method: 'GET', path: '/qa/test-endpoint' },
  ]));
  assert.ok(err);
});

test('different methods on the same path are never duplicates', () => {
  const err = duplicateEndpointError(project([
    { method: 'GET', path: '/x' },
    { method: 'POST', path: '/x' },
  ]));
  assert.equal(err, null);
});

test('genuinely different paths are never duplicates', () => {
  const err = duplicateEndpointError(project([
    { method: 'GET', path: '/x' },
    { method: 'GET', path: '/x/y' },
  ]));
  assert.equal(err, null);
});

test('the root path "/" on its own is not treated as empty and stripped to nothing', () => {
  const err = duplicateEndpointError(project([
    { method: 'GET', path: '/' },
    { method: 'GET', path: '/other' },
  ]));
  assert.equal(err, null);
});

// ---------- endpointFieldsError ----------

test('QA bug #3: a path with no leading slash is rejected', () => {
  const err = endpointFieldsError(project([{ method: 'GET', path: 'qa/no-leading-slash' }]));
  assert.match(err, /must start with \//);
});

test('QA bug #4: a path containing a space is rejected', () => {
  const err = endpointFieldsError(project([{ method: 'GET', path: '/qa/has space' }]));
  assert.match(err, /spaces/);
});

test('a normal, valid path (including a {param}) is accepted', () => {
  const err = endpointFieldsError(project([{ method: 'GET', path: '/widgets/{id}' }]));
  assert.equal(err, null);
});

test('QA bug #13: an endpoint name over the length cap is rejected', () => {
  const err = endpointFieldsError(project([{ method: 'GET', path: '/x', name: 'N'.repeat(1000) }]));
  assert.match(err, /too long/);
});

test('an endpoint name at or under the cap is accepted', () => {
  const err = endpointFieldsError(project([{ method: 'GET', path: '/x', name: 'N'.repeat(150) }]));
  assert.equal(err, null);
});

test('QA bug #5: a non-numeric response status code is rejected', () => {
  const err = endpointFieldsError(project([
    { method: 'GET', path: '/x', responses: [{ code: 'abc' }] },
  ]));
  assert.match(err, /must be a whole number from 100 to 599/);
});

test('QA bug #5: a response status code outside 100-599 is rejected', () => {
  const err = endpointFieldsError(project([
    { method: 'GET', path: '/x', responses: [{ code: 999 }] },
  ]));
  assert.match(err, /100 to 599/);
});

test('a response status code as a numeric STRING in range is accepted (matches how the editor stores it)', () => {
  const err = endpointFieldsError(project([
    { method: 'GET', path: '/x', responses: [{ code: '404' }] },
  ]));
  assert.equal(err, null);
});

test('a decimal response status code is rejected', () => {
  const err = endpointFieldsError(project([
    { method: 'GET', path: '/x', responses: [{ code: '200.5' }] },
  ]));
  assert.ok(err);
});

test('a response with no code set yet is not flagged - this validator does not REQUIRE one', () => {
  const err = endpointFieldsError(project([
    { method: 'GET', path: '/x', responses: [{ code: '' }, { description: 'no code field at all' }] },
  ]));
  assert.equal(err, null);
});

test('multiple endpoints: the first invalid one found is reported', () => {
  const err = endpointFieldsError(project([
    { method: 'GET', path: '/ok' },
    { method: 'GET', path: 'bad/no-slash' },
  ]));
  assert.match(err, /must start with \//);
});
