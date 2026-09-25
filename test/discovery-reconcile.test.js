// The log agent cannot see the curated documentation, so it pushes every Mule
// app it finds running — including the ones somebody already wrote up by hand.
// That put the same API in the sidebar twice. reconcileDiscovery() is what
// decides which half of the discovery record is already documented.
//
// The failure that matters here is a FALSE match: it hides a real, running,
// undocumented endpoint behind a "documented" tag. Most of these tests exist to
// pin down the cases where matching must refuse to guess.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const UTIL = path.join(__dirname, '..', 'public', 'js', 'studio', '05-util.js');

function load(projects) {
  const sandbox = {
    console, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Set, Map, Date,
    parseInt, parseFloat, isNaN, isFinite, Error, Promise, setTimeout, clearTimeout,
    document: { getElementById: () => null, querySelectorAll: () => [] },
    navigator: { clipboard: null },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    apiGet: () => Promise.reject(new Error('no network in tests')),
    renderAll: () => {},
    toast: () => {},
    state: { env: 'SIT', projects: {}, theme: 'dark' },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(UTIL, 'utf8'), sandbox, { filename: '05-util.js' });
  for (const p of projects) sandbox.state.projects[p.id] = p;
  return sandbox;
}

const documented = (id, name, eps, extra) => Object.assign({
  id, name, endpoints: eps.map(([method, path], i) => ({ id: `${id}-e${i}`, method, path })),
}, extra || {});

const discovered = (id, name, eps) => ({
  id, name, discoveryEnvironment: 'SIT',
  endpoints: eps.map(([method, path], i) => ({ id: `${id}-a${i}`, method, path })),
});

// ---------------------------------------------------------------- path shapes

test('a templated id and a named path parameter are the same endpoint', () => {
  // The agent writes "{id}" (templatize_path); a human writes "{loanId}".
  const s = load([]);
  assert.strictEqual(s.discoveryPathShape('/loan/{id}/dpd'), s.discoveryPathShape('/loan/{loanId}/dpd'));
});

test('a trailing slash and a query string are not a different endpoint', () => {
  const s = load([]);
  assert.strictEqual(s.discoveryPathShape('/loan/dpd/'), '/loan/dpd');
  assert.strictEqual(s.discoveryPathShape('/loan/dpd?from=1'), '/loan/dpd');
});

test('the method is part of the identity', () => {
  const s = load([]);
  assert.notStrictEqual(s.discoveryEndpointKey('GET', '/x'), s.discoveryEndpointKey('POST', '/x'));
});

test('a suffix has to start at a segment boundary', () => {
  // "/dpd" must not be read as the tail of "/loandpd".
  const s = load([]);
  assert.strictEqual(s.discoveryPathIsSuffix('/dpd', '/api/v1/dpd'), true);
  assert.strictEqual(s.discoveryPathIsSuffix('/dpd', '/api/v1/loandpd'), false);
  assert.strictEqual(s.discoveryPathIsSuffix('/dpd', '/dpd'), false, 'identical paths are an exact match, not a suffix');
});

// -------------------------------------------------------------- project match

test('an app documented under the same name is recognised as the same API', () => {
  const s = load([
    documented('p1', 's-ep-internal-api', [['GET', '/status']]),
    discovered('auto-1', 's-ep-internal-api', [['GET', '/status']]),
  ]);
  const cov = s.discoveryCoverage(s.state.projects['auto-1']);
  assert.strictEqual(cov.documented.id, 'p1');
  assert.strictEqual(cov.reason, 'name');
  assert.strictEqual(cov.covered, 1);
  assert.strictEqual(cov.novel, 0);
});

test('punctuation and case do not stop a name match', () => {
  const s = load([
    documented('p1', 'Razor pay', [['POST', '/pay']]),
    discovered('auto-1', 'razor-pay', [['POST', '/pay']]),
  ]);
  assert.strictEqual(s.discoveryCoverage(s.state.projects['auto-1']).reason, 'name');
});

test('an app renamed between the docs and the deployment still matches on its endpoints', () => {
  const s = load([
    documented('p1', 'Payments (legacy name)', [['POST', '/pay'], ['GET', '/pay/{id}']]),
    discovered('auto-1', 'p-payments-api', [['POST', '/pay'], ['GET', '/pay/{id}']]),
  ]);
  const cov = s.discoveryCoverage(s.state.projects['auto-1']);
  assert.strictEqual(cov.documented.id, 'p1');
  assert.strictEqual(cov.reason, 'endpoints');
});

test('two unrelated APIs are never matched just because they both exist', () => {
  const s = load([
    documented('p1', 'billing-api', [['GET', '/invoices']]),
    discovered('auto-1', 'kyc-api', [['POST', '/verify']]),
  ]);
  const cov = s.discoveryCoverage(s.state.projects['auto-1']);
  assert.strictEqual(cov.documented, null);
  assert.strictEqual(cov.novel, 1, 'an undocumented endpoint was hidden');
});

test('one discovered app never counts as documented by another discovered app', () => {
  // Two agents, or two apps serving the same path — neither is documentation.
  const s = load([
    discovered('auto-1', 'app-a', [['GET', '/health']]),
    discovered('auto-2', 'app-b', [['GET', '/health']]),
  ]);
  assert.strictEqual(s.discoveryCoverage(s.state.projects['auto-1']).documented, null);
  assert.strictEqual(s.discoveryCoverage(s.state.projects['auto-1']).novel, 1);
});

// ------------------------------------------------------------- endpoint match

test('a partially documented app reports exactly what is left to write up', () => {
  const s = load([
    documented('p1', 's-internal-api', [['GET', '/a'], ['POST', '/b']]),
    discovered('auto-1', 's-internal-api', [['GET', '/a'], ['POST', '/b'], ['DELETE', '/c']]),
  ]);
  const cov = s.discoveryCoverage(s.state.projects['auto-1']);
  assert.strictEqual(cov.total, 3);
  assert.strictEqual(cov.covered, 2);
  assert.strictEqual(cov.novel, 1);
  assert.deepStrictEqual([...cov.novelIds], ['auto-1-a2']);
});

test("APIkit's stripped base path still resolves to the documented endpoint", () => {
  // The HTTP listener logs the full URI; the router flow logs it without the
  // listener's base path. Same endpoint, two spellings.
  const s = load([
    documented('p1', 's-enach-api', [['GET', '/api/v1/mandate/{mandateId}']]),
    discovered('auto-1', 's-enach-api', [['GET', '/mandate/{id}']]),
  ]);
  const cov = s.discoveryCoverage(s.state.projects['auto-1']);
  assert.strictEqual(cov.covered, 1);
  assert.strictEqual(cov.matches.get('auto-1-a0').confidence, 'path',
    'a base-path match must be reported as weaker than an exact one');
});

test('a loose suffix match never reaches outside the matched API', () => {
  // "/create" is far too common to match across projects. It may only resolve
  // inside the documented project this app was already tied to.
  const s = load([
    documented('p1', 'other-api', [['POST', '/api/v2/create']]),
    discovered('auto-1', 'kyc-api', [['POST', '/create']]),
  ]);
  const cov = s.discoveryCoverage(s.state.projects['auto-1']);
  assert.strictEqual(cov.documented, null);
  assert.strictEqual(cov.novel, 1);
});

test('an exact match in the matched API wins over the same path elsewhere', () => {
  const s = load([
    documented('p1', 'shared-api', [['GET', '/health']]),
    documented('p2', 's-kyc-api', [['GET', '/health']]),
    discovered('auto-1', 's-kyc-api', [['GET', '/health']]),
  ]);
  assert.strictEqual(s.discoveryCoverage(s.state.projects['auto-1']).matches.get('auto-1-a0').proj.id, 'p2');
});

test('an endpoint documented in ANY project counts as documented', () => {
  // Coverage is a documentation question, not a project-ownership one — an
  // endpoint written up somewhere else is still written up.
  const s = load([
    documented('p1', 'somewhere-else', [['GET', '/shared/thing']]),
    discovered('auto-1', 'unmatched-app', [['GET', '/shared/thing']]),
  ]);
  const cov = s.discoveryCoverage(s.state.projects['auto-1']);
  assert.strictEqual(cov.covered, 1);
  assert.strictEqual(cov.reason, 'endpoints');
});

// ------------------------------------------------------------- human verdicts

test('a human link beats the name heuristic', () => {
  const s = load([
    documented('p1', 'totally-different-name', [['GET', '/x']], { discoveryLinks: { 'auto-1': 'linked' } }),
    documented('p2', 'kyc-api', [['GET', '/y']]),
    discovered('auto-1', 'kyc-api', [['GET', '/x']]),
  ]);
  const cov = s.discoveryCoverage(s.state.projects['auto-1']);
  assert.strictEqual(cov.documented.id, 'p1');
  assert.strictEqual(cov.reason, 'linked');
});

test('"not the same API" makes a name collision stop reporting as a duplicate', () => {
  // Two genuinely different APIs can share a name. Once someone says so, the
  // heuristic must not keep overruling them.
  const s = load([
    documented('p1', 'kyc-api', [['GET', '/other']], { discoveryLinks: { 'auto-1': 'separate' } }),
    discovered('auto-1', 'kyc-api', [['GET', '/verify']]),
  ]);
  const cov = s.discoveryCoverage(s.state.projects['auto-1']);
  assert.strictEqual(cov.documented, null);
  assert.strictEqual(cov.novel, 1);
});

test('a dismissal is scoped to the one app it was made about', () => {
  const s = load([
    documented('p1', 'kyc-api', [['GET', '/verify']], { discoveryLinks: { 'auto-other': 'separate' } }),
    discovered('auto-1', 'kyc-api', [['GET', '/verify']]),
  ]);
  assert.strictEqual(s.discoveryCoverage(s.state.projects['auto-1']).documented.id, 'p1');
});

// ------------------------------------------------------------------ roll-up

test('the roll-up counts apps and endpoints the sidebar needs to report', () => {
  const s = load([
    documented('p1', 'app-one', [['GET', '/a'], ['GET', '/b']]),
    documented('p2', 'app-two', [['GET', '/c']]),
    discovered('auto-1', 'app-one', [['GET', '/a'], ['GET', '/b']]),        // fully covered
    discovered('auto-2', 'app-two', [['GET', '/c'], ['POST', '/d']]),        // one new
    discovered('auto-3', 'app-three', [['GET', '/e']]),                      // all new
  ]);
  const r = s.reconcileDiscovery();
  assert.strictEqual(r.duplicateProjects, 2);
  assert.strictEqual(r.duplicateEndpoints, 3);
  assert.strictEqual(r.novelEndpoints, 2);
  assert.strictEqual(r.byAutoId['auto-1'].novel, 0, 'a fully documented app must have nothing new');
  assert.strictEqual(r.byAutoId['auto-3'].documented, null);
});

test('the roll-up is empty, not broken, when nothing has been discovered', () => {
  const s = load([documented('p1', 'app-one', [['GET', '/a']])]);
  const r = s.reconcileDiscovery();
  // Object.keys, not deepStrictEqual — the object is built inside the vm
  // context and so has that realm's prototype, which reference-equality fails.
  assert.strictEqual(Object.keys(r.byAutoId).length, 0);
  assert.strictEqual(r.duplicateProjects, 0);
});

test('an endpoint with no path is skipped rather than matching everything', () => {
  const s = load([
    documented('p1', 'app-one', [['GET', '/a']]),
    { id: 'auto-1', name: 'app-one', discoveryEnvironment: 'SIT',
      endpoints: [{ id: 'x', method: 'GET', path: '' }, { id: 'y', method: 'GET', path: '/a' }] },
  ]);
  const cov = s.discoveryCoverage(s.state.projects['auto-1']);
  assert.strictEqual(cov.total, 1);
  assert.strictEqual(cov.covered, 1);
  assert.strictEqual(cov.novel, 0);
});
