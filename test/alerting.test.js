// The alert state machine, quiet hours and rule validation.
//
// These are the parts that decide whether someone's phone buzzes, so they are
// tested as pure functions with an injected clock rather than against a
// database. The failure modes worth pinning are not "does it detect a breach"
// - that is one comparison - but everything built around the comparison to
// stop it becoming unusable:
//
//   a breach that lasts 30 seconds during a deploy must not wake anyone
//   one incident must not produce a notification per evaluation
//   a 100% error rate over one request at 3am is arithmetic, not an incident
//   an alert that recovers must SAY so, or the inbox never closes the story
//   quiet hours must not silence an alert that nobody was ever told about
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.MASTER_KEY = process.env.MASTER_KEY || Buffer.alloc(32, 9).toString('base64');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused@127.0.0.1:1/none';
const engine = require('../server/alertEngine');

const MIN = 60000;
const T0 = 1_800_000_000_000;

// A rule shaped like the default "5xx across an environment".
function rule(over = {}) {
  return {
    id: '1',
    name: 'test rule',
    metric: 'server_error_rate',
    comparison: 'above',
    threshold: 5,
    windowMinutes: 10,
    minRequests: 20,
    forMinutes: 5,
    cooldownMinutes: 60,
    severity: 'warning',
    scope: 'environment',
    ...over,
  };
}

const state = (over = {}) => ({ status: 'ok', breached_since: null, firing_since: null, last_notified_at: null, ...over });

test('a healthy reading changes nothing and tells nobody', () => {
  const d = engine.nextState(rule(), null, 1.0, 500, T0);
  assert.equal(d.status, 'ok');
  assert.equal(d.action, 'none');
});

test('a fresh breach goes to pending, not straight to firing', () => {
  // Every deploy crosses most thresholds for a few seconds. Firing here is
  // how an alerting system trains people to ignore it.
  const d = engine.nextState(rule(), null, 40, 500, T0);
  assert.equal(d.status, 'pending');
  assert.equal(d.action, 'none');
  assert.equal(d.breachedSince, T0);
});

test('a breach that has held for the configured time fires', () => {
  const prev = state({ status: 'pending', breached_since: new Date(T0).toISOString() });
  const early = engine.nextState(rule({ forMinutes: 5 }), prev, 40, 500, T0 + 4 * MIN);
  assert.equal(early.action, 'none', 'fired before its hold time elapsed');

  const due = engine.nextState(rule({ forMinutes: 5 }), prev, 40, 500, T0 + 5 * MIN);
  assert.equal(due.status, 'firing');
  assert.equal(due.action, 'fire');
});

test('a breach that clears before firing resolves silently', () => {
  // Nobody was told it started, so nobody is told it stopped. A "resolved"
  // notification for an alert that never fired is pure noise.
  const prev = state({ status: 'pending', breached_since: new Date(T0).toISOString() });
  const d = engine.nextState(rule(), prev, 1, 500, T0 + 2 * MIN);
  assert.equal(d.status, 'ok');
  assert.equal(d.action, 'none');
});

test('a hold time of zero fires immediately', () => {
  // Which is right for collector silence: by the time the threshold is
  // crossed it has ALREADY been quiet for that long.
  const d = engine.nextState(rule({ forMinutes: 0 }), null, 40, 500, T0);
  assert.equal(d.status, 'firing');
  assert.equal(d.action, 'fire');
});

test('a firing alert does not re-notify until its cooldown elapses', () => {
  // The difference between an alert and a denial-of-service on your own
  // inbox: at one evaluation a minute, this is 60 notifications an hour.
  const prev = state({ status: 'firing', firing_since: new Date(T0).toISOString(), last_notified_at: new Date(T0).toISOString() });
  for (const mins of [1, 10, 59]) {
    const d = engine.nextState(rule({ cooldownMinutes: 60 }), prev, 40, 500, T0 + mins * MIN);
    assert.equal(d.action, 'none', `re-notified after only ${mins} minutes`);
    assert.equal(d.status, 'firing', 'stopped considering itself firing');
  }
  const due = engine.nextState(rule({ cooldownMinutes: 60 }), prev, 40, 500, T0 + 60 * MIN);
  assert.equal(due.action, 'renotify');
});

test('a firing alert that recovers sends a resolution', () => {
  const prev = state({ status: 'firing', firing_since: new Date(T0).toISOString(), last_notified_at: new Date(T0).toISOString() });
  const d = engine.nextState(rule(), prev, 0.5, 500, T0 + 10 * MIN);
  assert.equal(d.status, 'ok');
  assert.equal(d.action, 'resolve');
});

test('a breach below the sample floor is not a breach', () => {
  // One failed request at 3am is a 100% error rate. Alerting on it is how
  // an on-call rotation learns to ignore the pager.
  const d = engine.nextState(rule({ minRequests: 20 }), null, 100, 1, T0);
  assert.equal(d.status, 'ok');
  assert.equal(d.action, 'none');
});

test('the sample floor applies to latency too, not just to ratios', () => {
  // A p95 over three requests is one request. Exempting gauges would make
  // latency alerts fire on the first trickle of traffic every morning.
  const r = rule({ metric: 'latency_p95', threshold: 1000, minRequests: 20 });
  assert.equal(engine.nextState(r, null, 5000, 3, T0).status, 'ok');
  assert.equal(engine.nextState(r, null, 5000, 50, T0).status, 'pending');
});

test('collector silence ignores the sample floor, because silence has no sample', () => {
  // Requiring requests here would mean the alert can only fire while data is
  // arriving — that is, never, since the condition IS that none is.
  const r = rule({ metric: 'agent_silent', threshold: 45, minRequests: 20, forMinutes: 0 });
  const d = engine.nextState(r, null, 90, 1, T0);
  assert.equal(d.status, 'firing');
  assert.equal(d.action, 'fire');
});

test('a "below" rule catches traffic falling off a cliff', () => {
  // No error-rate rule can ever see an upstream that simply stopped calling.
  const r = rule({ metric: 'request_rate', comparison: 'below', threshold: 10, minRequests: 0, forMinutes: 0 });
  assert.equal(engine.nextState(r, null, 2, 20, T0).status, 'firing');
  assert.equal(engine.nextState(r, null, 50, 500, T0).status, 'ok');
});

test('a missing measurement is never treated as a breach', () => {
  // No latency parsed from the logs must not read as "latency is 0ms, which
  // is below your threshold" and fire a below-rule permanently.
  const r = rule({ metric: 'latency_p95', comparison: 'below', threshold: 100, minRequests: 0 });
  assert.equal(engine.nextState(r, null, null, 500, T0).status, 'ok');
  assert.equal(engine.nextState(r, null, undefined, 500, T0).status, 'ok');
  assert.equal(engine.nextState(r, null, NaN, 500, T0).status, 'ok');
});

// --- Quiet hours ----------------------------------------------------------

test('quiet hours spanning midnight are handled', () => {
  const s = { quietHours: { enabled: true, startMinute: 22 * 60, endMinute: 7 * 60, timezone: 'UTC' } };
  const at = (h, m = 0) => new Date(Date.UTC(2026, 8, 25, h, m));
  assert.equal(engine.inQuietHours(s, at(23)), true, '23:00 should be quiet');
  assert.equal(engine.inQuietHours(s, at(3)), true, '03:00 should be quiet');
  assert.equal(engine.inQuietHours(s, at(6, 59)), true);
  assert.equal(engine.inQuietHours(s, at(7)), false, '07:00 is the end, exclusive');
  assert.equal(engine.inQuietHours(s, at(12)), false);
  assert.equal(engine.inQuietHours(s, at(21, 59)), false);
});

test('quiet hours within one day are handled', () => {
  const s = { quietHours: { enabled: true, startMinute: 9 * 60, endMinute: 17 * 60, timezone: 'UTC' } };
  const at = (h) => new Date(Date.UTC(2026, 8, 25, h));
  assert.equal(engine.inQuietHours(s, at(12)), true);
  assert.equal(engine.inQuietHours(s, at(8)), false);
  assert.equal(engine.inQuietHours(s, at(20)), false);
});

test('quiet hours are off unless switched on', () => {
  assert.equal(engine.inQuietHours({ quietHours: { enabled: false, startMinute: 0, endMinute: 1439 } }), false);
  assert.equal(engine.inQuietHours({}), false);
});

test('an unknown timezone silences nothing rather than everything', () => {
  // The dangerous failure: a typo'd zone throwing, being caught, and the
  // catch returning "yes, quiet" — which would mute every alert forever.
  const s = { quietHours: { enabled: true, startMinute: 0, endMinute: 1439, timezone: 'Mars/Olympus' } };
  assert.equal(engine.inQuietHours(s, new Date(T0)), false);
});

// --- Rule validation ------------------------------------------------------

test('an unknown metric is rejected rather than silently never firing', () => {
  const { errors } = engine.validateRule({ name: 'x', metric: 'cpu_usage', threshold: 1 });
  assert.ok(errors.some((e) => /metric must be one of/.test(e)), errors.join('; '));
});

test('a rule must have a name', () => {
  const { errors } = engine.validateRule({ metric: 'error_rate', threshold: 1 });
  assert.ok(errors.some((e) => /name is required/.test(e)));
});

test('collector silence cannot be scoped to a single endpoint', () => {
  // There is no per-endpoint version of "nothing is arriving": an endpoint
  // with no traffic is indistinguishable from one nobody happened to call.
  const { errors } = engine.validateRule({
    name: 'x', metric: 'agent_silent', threshold: 30, scope: 'endpoint',
  });
  assert.ok(errors.some((e) => /can only be scoped to an environment/.test(e)), errors.join('; '));
});

test('windows and cooldowns are clamped to sane ranges', () => {
  const { rule: r } = engine.validateRule({
    name: 'x', metric: 'error_rate', threshold: 5,
    windowMinutes: 99999, forMinutes: -5, cooldownMinutes: 1, minRequests: -3,
  });
  assert.equal(r.windowMinutes, 1440, 'window not clamped to 24h');
  assert.equal(r.forMinutes, 0, 'negative hold time not clamped');
  assert.equal(r.cooldownMinutes, 5, 'cooldown floor not applied');
  assert.equal(r.minRequests, 0);
});

test('a bad environment label is rejected, not stored', () => {
  const { errors } = engine.validateRule({
    name: 'x', metric: 'error_rate', threshold: 5, environment: 'SIT; DROP TABLE',
  });
  assert.ok(errors.some((e) => /environment is not a valid label/.test(e)), errors.join('; '));
});

test('an endpoint id is only kept when the rule is actually endpoint-scoped', () => {
  const { rule: r } = engine.validateRule({
    name: 'x', metric: 'error_rate', threshold: 5, scope: 'environment', endpointId: 'auto-abc1234567',
  });
  assert.equal(r.endpointId, null, 'a stray endpoint id would silently narrow an environment rule');
});

test('the shipped defaults are all valid', () => {
  // They go in through createRule, so an invalid default would fail at
  // seeding time for every new organisation.
  for (const d of engine.DEFAULT_RULES) {
    const { errors } = engine.validateRule(d);
    assert.deepEqual(errors, [], `${d.name}: ${errors.join('; ')}`);
  }
});

test('every default rule has a hold time or a reason not to', () => {
  for (const d of engine.DEFAULT_RULES) {
    const isAbsence = engine.METRICS[d.metric].kind === 'absence';
    assert.ok(d.forMinutes > 0 || isAbsence,
      `${d.name} fires instantly on a threshold metric — a deploy blip would page someone`);
    assert.ok(d.cooldownMinutes >= 30, `${d.name} would re-notify every ${d.cooldownMinutes} minutes`);
  }
});

test('every metric in the catalogue is documented and computable', () => {
  for (const [key, m] of Object.entries(engine.METRICS)) {
    assert.ok(m.label && m.help, `${key} has no description for the rule editor`);
    assert.ok(['ratio', 'gauge', 'absence'].includes(m.kind), `${key} has an unknown kind`);
    if (m.kind !== 'absence') assert.equal(typeof m.compute, 'function', `${key} cannot be computed`);
  }
});

test('values are formatted with their unit, and a missing one reads as a dash', () => {
  assert.equal(engine.formatValue('error_rate', 12.345), '12.3%');
  assert.equal(engine.formatValue('latency_p95', 962.6), '963ms');
  assert.equal(engine.formatValue('request_rate', 4.26), '4.3/min');
  assert.equal(engine.formatValue('error_rate', null), '—');
});

// QA regression (2026-09-26): the Observability console's own copy tells
// the reader unclassified requests (no status code logged) are
// "deliberately NOT part of the error rate" - error_rate/server_error_rate/
// client_error_rate used to divide by the raw total (unclassified
// included), understating the rate among requests whose outcome is
// actually known. A real case from SIT: 3 2xx, 1 4xx, 2 unclassified -
// the page showed 16.7% (1 of 6, wrong) instead of 25% (1 of 4 classified,
// matches the page's own stated policy).
test('error_rate excludes unclassified requests from its denominator', () => {
  const b = { total: 6, s4: 1, s5: 0, unknown: 2 };
  assert.equal(engine.METRICS.error_rate.compute(b), 25, 'should be 1 of 4 classified, not 1 of 6 total');
});

test('server_error_rate and client_error_rate also exclude unclassified', () => {
  const b = { total: 10, s4: 1, s5: 1, unknown: 4 };
  // 6 classified (10 - 4 unknown): 1/6 5xx, 1/6 4xx.
  assert.ok(Math.abs(engine.METRICS.server_error_rate.compute(b) - (100 / 6)) < 0.001);
  assert.ok(Math.abs(engine.METRICS.client_error_rate.compute(b) - (100 / 6)) < 0.001);
});

test('unclassified_rate itself is UNCHANGED - it measures unclassified as a share of ALL requests', () => {
  const b = { total: 10, s4: 0, s5: 0, unknown: 4 };
  assert.equal(engine.METRICS.unclassified_rate.compute(b), 40);
});

test('a request set with EVERY request unclassified has a null error rate, not a divide-by-zero', () => {
  const b = { total: 5, s4: 0, s5: 0, unknown: 5 };
  assert.equal(engine.METRICS.error_rate.compute(b), null);
});

test('a normal, fully-classified request set is unaffected by the fix', () => {
  const b = { total: 100, s4: 5, s5: 5, unknown: 0 };
  assert.equal(engine.METRICS.error_rate.compute(b), 10);
});
