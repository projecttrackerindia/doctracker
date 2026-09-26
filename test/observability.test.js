// Tests for the observability time-series layer — the pure logic only, so
// this runs in CI with nothing but Node (no DB, no network), same constraint
// as the other files here.
//
// What it deliberately covers:
//   * the latency percentile estimator, including the property that motivated
//     storing histograms at all (percentiles are not averageable);
//   * the SSE fan-out bus, including that a disconnected subscriber is really
//     removed and that one throwing listener cannot silence the others;
//   * the CROSS-LANGUAGE CONTRACT between the Python agent and this server.
//     Nothing at runtime enforces that they agree on field names, the ingest
//     path, or the histogram bands, and every one of those mismatches fails
//     SILENTLY — rows written as zeros, or skipped, with no error anywhere.
//     Asserting it here turns "the charts are all zero after the deploy" into
//     a failing test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// db.js warns (does not throw) without DATABASE_URL, and observabilityStore
// only builds a pool — it never connects until a query runs, and none do here.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@127.0.0.1:1/unused';

const store = require('../server/observabilityStore');
const bus = require('../server/observabilityBus');

const AGENT_PATH = path.join(__dirname, '..', 'ops', 'sit-doc-agent', 'mule_doc_agent.py');
const agentSrc = fs.readFileSync(AGENT_PATH, 'utf8');
const storeSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'observabilityStore.js'), 'utf8');

// --- Latency percentiles ----------------------------------------------------

const p = store.percentileFromBuckets;

test('an empty histogram returns null, not a confident 0ms', () => {
  assert.equal(p({}, 0.95), null);
  assert.equal(p(null, 0.95), null);
  assert.equal(p({ 10: 0, inf: 0 }, 0.5), null);
});

test('percentiles read off summed bands', () => {
  assert.equal(p({ 10: 100 }, 0.95), 10);
  assert.equal(p({ 10: 50, 100: 50 }, 0.5), 10);
  assert.equal(p({ 10: 50, 100: 50 }, 0.95), 95);
});

test('a lone sample interpolates mid-band, matching histogram_quantile', () => {
  assert.equal(p({ 250: 1 }, 0.5), 175);
});

test('an estimate always stays inside the band the value fell in', () => {
  for (const q of [0.01, 0.25, 0.5, 0.75, 0.95, 0.99]) {
    const v = p({ 250: 7 }, q);
    assert.ok(v > 100 && v <= 250, `q=${q} gave ${v}, outside (100, 250]`);
  }
});

test('the open-ended top band reports its lower edge, not an invented ceiling', () => {
  assert.equal(p({ inf: 5 }, 0.99), 10000);
});

test('percentiles are monotonic', () => {
  const h = { 10: 40, 100: 40, 1000: 20 };
  assert.ok(p(h, 0.5) <= p(h, 0.95));
  assert.ok(p(h, 0.95) <= p(h, 0.99));
});

test('counts arriving as strings (node-pg bigints) are handled', () => {
  assert.equal(p({ 10: '50', 100: '50' }, 0.95), 95);
});

test('summing bands is NOT the same as averaging percentiles', () => {
  // The reason latency is stored as a histogram rather than as a p95 per
  // bucket: averaging sixty one-minute p95s does not give the hour's p95.
  const a = { 10: 30, 100: 20 };
  const b = { 10: 10, 100: 40 };
  const correct = p({ 10: 40, 100: 60 }, 0.95);
  const naive = (p(a, 0.95) + p(b, 0.95)) / 2;
  assert.notEqual(correct, naive);
});

test('latency bucket assignment is inclusive of its upper bound', () => {
  assert.equal(store.latencyBucketKey(0), '10');
  assert.equal(store.latencyBucketKey(10), '10');
  assert.equal(store.latencyBucketKey(11), '25');
  assert.equal(store.latencyBucketKey(10000), '10000');
  assert.equal(store.latencyBucketKey(10001), 'inf');
});

// --- Live-update bus --------------------------------------------------------

test('a subscriber receives what is published to its organisation', () => {
  const got = [];
  const off = bus.subscribe('acme', (m) => got.push(m));
  bus.publish('acme', { hello: 1 });
  off();
  assert.deepEqual(got, [{ hello: 1 }]);
});

test('organisations are isolated from one another', () => {
  const acme = [];
  const globex = [];
  const offA = bus.subscribe('acme', (m) => acme.push(m));
  const offB = bus.subscribe('globex', (m) => globex.push(m));
  bus.publish('acme', { x: 1 });
  offA();
  offB();
  assert.equal(acme.length, 1);
  assert.equal(globex.length, 0);
});

test('unsubscribing stops delivery and cleans up the listener set', () => {
  const got = [];
  const off = bus.subscribe('acme', (m) => got.push(m));
  off();
  bus.publish('acme', { x: 1 });
  assert.equal(got.length, 0);
  assert.equal(bus.subscriberCount('acme'), 0);
});

test('one throwing subscriber does not stop the others being notified', () => {
  const good = [];
  const offBad = bus.subscribe('acme', () => { throw new Error('dead socket'); });
  const offGood = bus.subscribe('acme', (m) => good.push(m));
  bus.publish('acme', { x: 1 });
  offBad();
  offGood();
  assert.equal(good.length, 1);
});

// --- Agent <-> server contract ---------------------------------------------

test('CONTRACT: the agent and server agree on the latency histogram bands', () => {
  // Drift here silently skews every latency figure on the page: the agent
  // would file a request into one band and the server read percentiles off a
  // different scale.
  const a = /LATENCY_BUCKET_BOUNDS = \(([^)]*)\)/.exec(agentSrc);
  const b = /LATENCY_BUCKET_BOUNDS = \[([^\]]*)\]/.exec(storeSrc);
  assert.ok(a && b, 'could not find LATENCY_BUCKET_BOUNDS on both sides');
  const toNums = (s) => s.split(',').map((x) => x.trim()).filter(Boolean).map(Number);
  assert.deepEqual(toNums(a[1]), store.LATENCY_BUCKET_BOUNDS);
  assert.deepEqual(toNums(b[1]), store.LATENCY_BUCKET_BOUNDS);
});

test('CONTRACT: every rollup field the server reads is one the agent sets', () => {
  // Anchored to the newline and its exact indentation on purpose. An
  // unanchored /b = \{/ also matches any identifier ENDING in b — it started
  // matching an unrelated `ob = {` the moment one was added earlier in the
  // file, and silently compared the wrong literal.
  const bucketLiteral = /\n {8}b = \{([\s\S]*?)\n {8}\}/.exec(agentSrc);
  assert.ok(bucketLiteral, 'could not locate the rollup bucket literal in the agent');
  const agentKeys = new Set([...bucketLiteral[1].matchAll(/"([a-zA-Z0-9_]+)":/g)].map((m) => m[1]));

  // The chunk function is where the bucket fields are actually read; the
  // ingestRollups wrapper only batches. Scanning both keeps this test honest
  // if that split changes again.
  const ingest = /async function ingestRollupChunk[\s\S]*?\n}/.exec(storeSrc)
    || /async function ingestRollups[\s\S]*?\n}/.exec(storeSrc);
  assert.ok(ingest, 'could not locate the rollup ingest function');
  const serverKeys = new Set([...ingest[0].matchAll(/\bb\.([a-zA-Z0-9_]+)/g)].map((m) => m[1]));

  const missing = [...serverKeys].filter((k) => !agentKeys.has(k));
  assert.deepEqual(missing, [], `server reads ${JSON.stringify(missing)} that the agent never sets`);
  const ignored = [...agentKeys].filter((k) => !serverKeys.has(k));
  assert.deepEqual(ignored, [], `agent sends ${JSON.stringify(ignored)} that the server discards`);
});

test('CONTRACT: every rollup field maps to a real column', () => {
  const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'db.js'), 'utf8');
  const table = /CREATE TABLE IF NOT EXISTS endpoint_metrics_rollup \(([\s\S]*?)\n {4}\);/.exec(dbSrc);
  assert.ok(table, 'could not find the rollup table definition');
  // [a-z0-9_] - the digits matter: status_2xx and status_5xx are column names.
  const columns = new Set([...table[1].matchAll(/^\s{6}([a-z0-9_]+)\s+[A-Z]/gm)].map((m) => m[1]));

  const bucketLiteral = /\n {8}b = \{([\s\S]*?)\n {8}\}/.exec(agentSrc);
  const agentKeys = [...bucketLiteral[1].matchAll(/"([a-zA-Z0-9_]+)":/g)].map((m) => m[1]);
  const toSnake = (s) => s.replace(/([a-z])([A-Z0-9])/g, '$1_$2').toLowerCase();

  const missing = agentKeys
    .filter((k) => k !== 'endpointId' && k !== 'bucketStart')
    .map(toSnake)
    .filter((c) => !columns.has(c));
  assert.deepEqual(missing, [], `no column for ${JSON.stringify(missing)}`);
});

test('CONTRACT: the agent posts to the path the server actually serves', () => {
  const agentPath = /_request\("PUT", "([^"]*observability[^"]*)"/.exec(agentSrc);
  assert.ok(agentPath, 'agent does not PUT to an observability path');
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'server.js'), 'utf8');
  const mount = /app\.use\('([^']*observability[^']*)', observabilityRoutes\)/.exec(serverSrc);
  assert.ok(mount, 'observability router is not mounted');
  const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'observability.js'), 'utf8');
  assert.match(routeSrc, /router\.put\('\/ingest'/);
  assert.equal(agentPath[1], `${mount[1]}/ingest`);
});

test('CONTRACT: records carry the endpointId the server requires', () => {
  // A record without one is skipped server-side, so this omission would mean
  // the Log Explorer silently stays empty under CAPTURE_MODE=full.
  assert.match(agentSrc, /row\["endpointId"\] = endpoint_rollup_id/);
  assert.match(storeSrc, /if \(!ts \|\| !endpointId\) continue;/);
});

test('CONTRACT: real environment labels pass the server-side validator', () => {
  const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'observability.js'), 'utf8');
  assert.match(routeSrc, /\^\[A-Za-z0-9\]\[A-Za-z0-9 _-\]\{0,31\}\$/);
  const validator = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,31}$/;
  for (const env of ['SIT', 'UAT', 'PROD', 'Dev']) {
    assert.ok(validator.test(env), `${env} would be rejected`);
  }
});

test('CONTRACT: pending rollups are cleared only after a confirmed push', () => {
  // If this became unconditional, a failed push would silently discard a
  // whole interval of traffic counts instead of retrying them.
  assert.match(agentSrc, /if pending_rollups:\s*\n\s*state\["rollups"\] = \{\}/);
  const pushIdx = agentSrc.indexOf('obs_result = client.push_observability');
  const clearIdx = agentSrc.indexOf('state["rollups"] = {}');
  assert.ok(pushIdx > 0 && clearIdx > pushIdx, 'the clear must follow the push call');
});

// --- Previous-window comparison (the "▼ -90%" QA regression) ---------------

process.env.MASTER_KEY = process.env.MASTER_KEY || Buffer.alloc(32, 9).toString('base64');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unused-test-secret';
const { resolvePreviousWindow } = require('../server/routes/observability');

test('no previous window for an unbounded ("all time") range', () => {
  assert.equal(resolvePreviousWindow({ from: null, to: null }, null), null);
});

test('previous window is the same length immediately before the current one', () => {
  const range = { from: '2026-09-26T00:00:00.000Z', to: '2026-09-27T00:00:00.000Z' };
  const win = resolvePreviousWindow(range, null);
  assert.deepEqual(win, { from: '2026-09-25T00:00:00.000Z', to: '2026-09-26T00:00:00.000Z' });
});

test('computed when coverage started at or before the previous window', () => {
  const range = { from: '2026-09-26T00:00:00.000Z', to: '2026-09-27T00:00:00.000Z' };
  // Coverage starts exactly at the previous window's start - fully covered.
  const win = resolvePreviousWindow(range, '2026-09-25T00:00:00.000Z');
  assert.deepEqual(win, { from: '2026-09-25T00:00:00.000Z', to: '2026-09-26T00:00:00.000Z' });
});

test('suppressed when the previous window would reach before recording started', () => {
  // The real SIT case: a "24h" pill on an environment that only started
  // recording a few hours ago. Coverage starts inside what would have been
  // the previous window, so comparing against it is not a fair baseline.
  const range = { from: '2026-09-26T00:00:00.000Z', to: '2026-09-27T00:00:00.000Z' };
  const win = resolvePreviousWindow(range, '2026-09-25T18:00:00.000Z');
  assert.equal(win, null);
});

test('suppressed when coverage only starts after the whole previous window', () => {
  const range = { from: '2026-09-26T00:00:00.000Z', to: '2026-09-27T00:00:00.000Z' };
  const win = resolvePreviousWindow(range, '2026-09-27T00:00:00.000Z');
  assert.equal(win, null);
});
