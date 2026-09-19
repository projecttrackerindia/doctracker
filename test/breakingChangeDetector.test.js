const { test } = require('node:test');
const assert = require('node:assert/strict');
const { detectBreakingChanges } = require('../server/breakingChangeDetector');

function ep(overrides) {
  return {
    id: 'ep1', method: 'GET', path: '/widgets/{id}', parameters: [], headers: [], responses: [],
    ...overrides,
  };
}

test('no changes → no breaking changes', () => {
  const e = ep();
  assert.deepEqual(detectBreakingChanges([e], [e]), []);
});

test('unrelated field changes (summary/description) are not breaking', () => {
  const from = [ep({ summary: 'Get a widget' })];
  const to = [ep({ summary: 'Fetch a single widget by id' })];
  assert.deepEqual(detectBreakingChanges(from, to), []);
});

test('removing an endpoint is breaking', () => {
  const from = [ep({ id: 'a', method: 'DELETE', path: '/widgets/{id}' })];
  const to = [];
  const issues = detectBreakingChanges(from, to);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].rule, 'endpoint-removed');
  assert.match(issues[0].message, /DELETE \/widgets\/\{id\}/);
});

test('adding a new endpoint is not breaking', () => {
  const from = [ep({ id: 'a' })];
  const to = [ep({ id: 'a' }), ep({ id: 'b', path: '/gadgets' })];
  assert.deepEqual(detectBreakingChanges(from, to), []);
});

test('changing HTTP method on the same endpoint id is breaking', () => {
  const from = [ep({ method: 'GET' })];
  const to = [ep({ method: 'POST' })];
  const issues = detectBreakingChanges(from, to);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].rule, 'method-changed');
});

test('changing the path on the same endpoint id is breaking', () => {
  const from = [ep({ path: '/widgets/{id}' })];
  const to = [ep({ path: '/items/{id}' })];
  const issues = detectBreakingChanges(from, to);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].rule, 'path-changed');
});

test('adding a new required query parameter is breaking', () => {
  const from = [ep({ parameters: [] })];
  const to = [ep({ parameters: [{ name: 'apiVersion', in: 'query', required: true, type: 'string' }] })];
  const issues = detectBreakingChanges(from, to);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].rule, 'required-param-added');
});

test('adding a new OPTIONAL query parameter is not breaking', () => {
  const from = [ep({ parameters: [] })];
  const to = [ep({ parameters: [{ name: 'sort', in: 'query', required: false, type: 'string' }] })];
  assert.deepEqual(detectBreakingChanges(from, to), []);
});

test('making an existing parameter required is breaking', () => {
  const from = [ep({ parameters: [{ name: 'limit', in: 'query', required: false, type: 'integer' }] })];
  const to = [ep({ parameters: [{ name: 'limit', in: 'query', required: true, type: 'integer' }] })];
  const issues = detectBreakingChanges(from, to);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].rule, 'param-now-required');
});

test('relaxing a required parameter to optional is not breaking', () => {
  const from = [ep({ parameters: [{ name: 'limit', in: 'query', required: true, type: 'integer' }] })];
  const to = [ep({ parameters: [{ name: 'limit', in: 'query', required: false, type: 'integer' }] })];
  assert.deepEqual(detectBreakingChanges(from, to), []);
});

test('changing a parameter\'s type is breaking', () => {
  const from = [ep({ parameters: [{ name: 'id', in: 'path', required: true, type: 'integer' }] })];
  const to = [ep({ parameters: [{ name: 'id', in: 'path', required: true, type: 'string' }] })];
  const issues = detectBreakingChanges(from, to);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].rule, 'param-type-changed');
});

test('removing a path parameter is breaking', () => {
  const from = [ep({ path: '/widgets/{id}/{sub}', parameters: [
    { name: 'id', in: 'path', required: true, type: 'string' },
    { name: 'sub', in: 'path', required: true, type: 'string' },
  ] })];
  const to = [ep({ path: '/widgets/{id}/{sub}', parameters: [
    { name: 'id', in: 'path', required: true, type: 'string' },
  ] })];
  const issues = detectBreakingChanges(from, to);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].rule, 'path-param-removed');
});

test('removing a query parameter is NOT breaking (callers can just stop sending it)', () => {
  const from = [ep({ parameters: [{ name: 'debug', in: 'query', required: false, type: 'boolean' }] })];
  const to = [ep({ parameters: [] })];
  assert.deepEqual(detectBreakingChanges(from, to), []);
});

test('adding a newly-required header is breaking', () => {
  const from = [ep({ headers: [] })];
  const to = [ep({ headers: [{ name: 'X-Tenant-Id', required: true }] })];
  const issues = detectBreakingChanges(from, to);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].rule, 'required-header-added');
});

test('making an existing optional header required is breaking, distinct rule from adding one', () => {
  const from = [ep({ headers: [{ name: 'X-Trace-Id', required: false }] })];
  const to = [ep({ headers: [{ name: 'X-Trace-Id', required: true }] })];
  const issues = detectBreakingChanges(from, to);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].rule, 'header-now-required');
});

test('removing a documented success response code is breaking', () => {
  const from = [ep({ responses: [{ code: 200 }, { code: 404 }] })];
  const to = [ep({ responses: [{ code: 404 }] })];
  const issues = detectBreakingChanges(from, to);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].rule, 'success-response-removed');
});

test('removing a documented ERROR response code is not breaking (contract relaxed, not broken)', () => {
  const from = [ep({ responses: [{ code: 200 }, { code: 429 }] })];
  const to = [ep({ responses: [{ code: 200 }] })];
  assert.deepEqual(detectBreakingChanges(from, to), []);
});

test('adding a new success response code is not breaking', () => {
  const from = [ep({ responses: [{ code: 200 }] })];
  const to = [ep({ responses: [{ code: 200 }, { code: 202 }] })];
  assert.deepEqual(detectBreakingChanges(from, to), []);
});

test('multiple simultaneous breaking changes on one endpoint are all reported', () => {
  const from = [ep({
    method: 'GET',
    parameters: [{ name: 'limit', in: 'query', required: false, type: 'integer' }],
    responses: [{ code: 200 }],
  })];
  const to = [ep({
    method: 'GET',
    parameters: [
      { name: 'limit', in: 'query', required: true, type: 'integer' },
      { name: 'token', in: 'query', required: true, type: 'string' },
    ],
    responses: [{ code: 202 }],
  })];
  const issues = detectBreakingChanges(from, to);
  const rules = issues.map((i) => i.rule).sort();
  assert.deepEqual(rules, ['param-now-required', 'required-param-added', 'success-response-removed']);
});

test('every issue carries endpointId/method/path for the client to render against', () => {
  const from = [ep({ id: 'ep-9', method: 'PUT', path: '/x' })];
  const to = [];
  const [issue] = detectBreakingChanges(from, to);
  assert.equal(issue.endpointId, 'ep-9');
  assert.equal(issue.method, 'PUT');
  assert.equal(issue.path, '/x');
});

test('handles empty/missing inputs without throwing', () => {
  assert.deepEqual(detectBreakingChanges(null, null), []);
  assert.deepEqual(detectBreakingChanges(undefined, [ep()]), []);
  assert.deepEqual(detectBreakingChanges([ep()], undefined), [
    { rule: 'endpoint-removed', endpointId: 'ep1', method: 'GET', path: '/widgets/{id}', message: 'GET /widgets/{id} was removed. Existing callers will get a 404.', severity: 'critical' },
  ]);
});
