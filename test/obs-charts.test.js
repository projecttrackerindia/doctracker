// Chart GEOMETRY tests for the observability console.
//
// The console's charts are hand-drawn SVG, and the failure mode they have is
// not an exception — it is valid markup that draws nothing. A stacked-area
// polygon built from a single data point gets two coordinates: a legal
// polygon, enclosing no area, rendering as an empty plot on a page that is at
// the same moment reporting the traffic. No assertion about "does it return
// HTML" catches that, so these tests parse the emitted SVG and measure it.
//
// That is a real bug this file was written for: a 24-hour range auto-selects
// 15-minute buckets, so ten requests a minute apart are ONE point, and the
// first thing a newly deployed agent produces is exactly that.
//
// Runs on plain Node with no DOM: the chart module is pure string-building,
// so it is evaluated in a vm context with the two helpers it expects.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CHARTS = path.join(__dirname, '..', 'public', 'js', 'studio', '25-obs-charts.js');

const sandbox = {
  Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Set, Map,
  parseInt, parseFloat, isNaN, isFinite, Intl,
  escapeHtml: (s) => String(s === null || s === undefined ? '' : s)
    .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
  formatDateTime: (iso) => String(iso),
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(CHARTS, 'utf8'), sandbox, { filename: '25-obs-charts.js' });
const fn = (name) => vm.runInContext(name, sandbox);

// --- minimal SVG readers ----------------------------------------------------
function shapes(svg, tag) {
  return (svg.match(new RegExp(`<${tag}[^>]*>`, 'g')) || []);
}
function points(svg, tag) {
  return shapes(svg, tag).map((m) => {
    const p = (m.match(/points="([^"]*)"/) || [, ''])[1].trim();
    return p ? p.split(/\s+/).map((c) => c.split(',').map(Number)) : [];
  });
}
function attr(el, name) {
  const m = el.match(new RegExp(`${name}="([^"]*)"`));
  return m ? Number(m[1]) : NaN;
}
// Shoelace: a polygon enclosing no area is invisible however valid it is.
function area(poly) {
  if (poly.length < 3) return 0;
  let a = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a / 2);
}
// Everything the viewer can actually see: filled polygons plus filled bars.
function visibleMarks(svg) {
  const polys = points(svg, 'polygon').filter((p) => area(p) > 1).length;
  const bars = shapes(svg, 'rect')
    .filter((r) => /obs-chart-bar/.test(r))
    .filter((r) => attr(r, 'width') > 0 && attr(r, 'height') > 0).length;
  return polys + bars;
}

const bucket = (ts, breakdown, meanLatencyMs = null) => ({
  ts,
  total: Object.values(breakdown).reduce((a, b) => a + b, 0),
  statusBreakdown: Object.assign({ '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, unknown: 0 }, breakdown),
  meanLatencyMs,
});

test('a single-bucket series draws visible marks, not an empty plot', () => {
  const svg = fn('renderTrafficChart')([bucket('2026-09-25T04:30:00.000Z', { '2xx': 5, unknown: 5 })]);
  assert.match(svg, /<svg/);
  assert.ok(visibleMarks(svg) >= 2,
    'one bucket must still draw a mark per status family — an area chart cannot draw one point');
});

test('the error-rate line survives a single bucket', () => {
  const svg = fn('renderTrafficChart')([bucket('2026-09-25T04:30:00.000Z', { '2xx': 8, '5xx': 2 })]);
  const lines = points(svg, 'polyline').filter((p) => p.length >= 2);
  assert.ok(lines.length >= 1, 'a one-point polyline renders nothing');
});

test('multi-bucket series draw stacked areas and stay inside the viewBox', () => {
  const series = Array.from({ length: 96 }, (_, i) => bucket(
    new Date(Date.parse('2026-09-24T10:00:00.000Z') + i * 900e3).toISOString(),
    { '2xx': 18 + (i % 7) * 5, '4xx': i % 5, '5xx': i % 11 === 0 ? 3 : 0 },
    30 + (i % 13),
  ));
  const svg = fn('renderTrafficChart')(series);
  assert.ok(visibleMarks(svg) >= 3, 'expected a band per present family');
  assert.equal(svg.match(/NaN|Infinity|undefined/), null);
  points(svg, 'polygon').flat().concat(points(svg, 'polyline').flat()).forEach(([x, y]) => {
    assert.ok(x >= 0 && x <= 1000, `x outside the viewBox: ${x}`);
    assert.ok(y >= 0 && y <= 260, `y outside the viewBox: ${y}`);
  });
});

test('an empty series says so instead of drawing an empty chart', () => {
  assert.match(fn('renderTrafficChart')([]), /obs-chart-empty/);
});

test('y-axis ticks are evenly spaced whole numbers', () => {
  // yMax 10 cut into quarters gave 2.5 and 7.5, printed as 3 and 8: ticks
  // that look evenly spaced but are not, on a chart counting whole requests.
  [1, 2, 5, 10, 20, 50, 100, 1000].forEach((max) => {
    const fractions = fn('obsGridFractions')(max);
    const ticks = fractions.map((f) => max * f);
    ticks.forEach((t) => assert.ok(Number.isInteger(t), `tick ${t} is not whole for max ${max}`));
    const gaps = ticks.slice(1).map((t, i) => t - ticks[i]);
    gaps.forEach((g) => assert.ok(Math.abs(g - gaps[0]) < 1e-9, `uneven ticks for max ${max}`));
  });
});

test('the x-axis never prints the same label at both ends', () => {
  const single = fn('renderTrafficChart')([bucket('2026-09-25T04:30:00.000Z', { '2xx': 10 })]);
  const axis = (single.split('obs-chart-axis')[1] || '');
  const labels = (axis.match(/<span>([^<]*)<\/span>/g) || []).map((s) => s.replace(/<\/?span>/g, ''));
  assert.equal(new Set(labels).size, labels.length, `axis repeats a label: ${labels.join(' | ')}`);

  // Two buckets inside one label's resolution must fall back to a finer format.
  const twoClose = fn('renderTrafficChart')([
    bucket('2026-09-25T04:30:00.000Z', { '2xx': 1 }),
    bucket('2026-09-25T04:45:00.000Z', { '2xx': 1 }),
  ]);
  const axis2 = (twoClose.split('obs-chart-axis')[1] || '');
  const labels2 = (axis2.match(/<span>([^<]*)<\/span>/g) || []).map((s) => s.replace(/<\/?span>/g, ''));
  assert.equal(new Set(labels2).size, labels2.length, `axis repeats a label: ${labels2.join(' | ')}`);
});

test('every point gets a hover target with a readable tooltip', () => {
  const svg = fn('renderTrafficChart')([
    bucket('2026-09-25T04:30:00.000Z', { '2xx': 4 }),
    bucket('2026-09-25T04:45:00.000Z', { '2xx': 3, '5xx': 1 }),
  ]);
  const hov = shapes(svg, 'rect').filter((r) => /obs-chart-hover/.test(r));
  assert.equal(hov.length, 2);
  hov.forEach((r) => {
    assert.ok(attr(r, 'width') > 0 && attr(r, 'height') > 0, 'zero-size hover target');
  });
  assert.match(svg, /<title>/);
});

test('the latency histogram draws real bands and explains an empty one', () => {
  const drawn = fn('renderLatencyHistogram')(
    { 10: 5, 50: 40, 250: 12, 1000: 2 },
    { count: 59, mean: 70, p50: 45, p95: 300, p99: 900 },
  );
  assert.doesNotMatch(drawn, /obs-chart-empty/);
  assert.equal(drawn.match(/NaN|Infinity|undefined/), null);

  assert.match(fn('renderLatencyHistogram')({}, null), /obs-chart-empty/);
  // A single populated band is still a chart, not an empty state.
  assert.doesNotMatch(
    fn('renderLatencyHistogram')({ 100: 7 }, { count: 7, mean: 80, p50: 80, p95: 95, p99: 99 }),
    /obs-chart-empty/,
  );
});

test('sparklines handle the degenerate series a new agent produces', () => {
  assert.equal(fn('renderKpiSparkline')([5], '--accent'), '', 'one point is not a line');
  assert.match(fn('renderKpiSparkline')([3, 3, 3], '--accent'), /<polyline/);
  assert.equal(fn('renderKpiSparkline')([0, 0, 0], '--accent').match(/NaN/), null,
    'a zero maximum must not divide by zero');
});

// --- The window the chart draws vs. the window that was asked for ----------
//
// getSeries returns only buckets that EXIST. Ask for 24 hours while holding
// 13 minutes of traffic and it returns two points, and a chart drawn from
// those two silently re-scopes its x-axis to 13 minutes while the toolbar
// above it still claims 24 hours. obsFillSeries() is what keeps the picture
// and its label telling the same story, so these pin its grid.
const API = path.join(__dirname, '..', 'public', 'js', 'studio', '24-obs-api.js');
const apiBox = {
  Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Set, Map,
  parseInt, parseFloat, isNaN, isFinite, Intl, URLSearchParams,
  state: {}, document: { getElementById: () => null },
  localStorage: { getItem: () => null, setItem() {} },
  fetch: () => Promise.reject(new Error('no network in this test')),
  EventSource: function EventSourceStub() {},
};
apiBox.globalThis = apiBox;
vm.createContext(apiBox);
vm.runInContext(fs.readFileSync(API, 'utf8'), apiBox, { filename: '24-obs-api.js' });
const fillSeries = vm.runInContext('obsFillSeries', apiBox);

const SPARSE_FROM = '2026-09-24T05:02:00.000Z';
const SPARSE_TO = '2026-09-25T05:02:00.000Z';
const SPARSE = [
  bucket('2026-09-25T04:30:00.000Z', { '2xx': 6, unknown: 6 }),
  bucket('2026-09-25T04:45:00.000Z', { '2xx': 6, unknown: 6 }),
];

test('a sparse series is filled across the whole requested window', () => {
  const filled = fillSeries(SPARSE, SPARSE_FROM, SPARSE_TO, 900);
  assert.ok(filled.length >= 95 && filled.length <= 97,
    `24h at 15-minute buckets should be ~96 slots, got ${filled.length}`);
  const span = Date.parse(filled[filled.length - 1].ts) - Date.parse(filled[0].ts);
  assert.ok(span >= 86400e3 - 900e3, 'the filled grid is narrower than the window');
});

test('filling neither loses nor duplicates real buckets', () => {
  const filled = fillSeries(SPARSE, SPARSE_FROM, SPARSE_TO, 900);
  assert.equal(filled.reduce((a, p) => a + p.total, 0), 24);
  assert.equal(filled.filter((p) => p.total > 0).length, 2);
  filled.forEach((p) => {
    assert.ok(!Number.isNaN(Date.parse(p.ts)), `bad timestamp ${p.ts}`);
    ['2xx', '3xx', '4xx', '5xx', 'unknown'].forEach((f) => {
      assert.equal(typeof p.statusBreakdown[f], 'number', `${f} missing from a filled slot`);
    });
  });
});

test('filling refuses to generate an unbounded grid', () => {
  // Six years at one-minute buckets is over three million slots. Returning
  // the series untouched beats locking the tab.
  const filled = fillSeries(SPARSE, '2020-01-01T00:00:00.000Z', SPARSE_TO, 60);
  assert.equal(filled.length, SPARSE.length);
  assert.equal(fillSeries(SPARSE, SPARSE_TO, SPARSE_FROM, 900).length, SPARSE.length,
    'a backwards range should be left alone');
  assert.equal(fillSeries(SPARSE, 'not a date', SPARSE_TO, 900).length, SPARSE.length);
});

test('"not collected yet" is drawn differently from "no traffic"', () => {
  // A zero-filled grid renders both as a flat line on the axis. They are not
  // the same claim: one is an observation, the other is its absence.
  const filled = fillSeries(SPARSE, SPARSE_FROM, SPARSE_TO, 900);
  const svg = fn('renderTrafficChart')(filled, { coverageStart: '2026-09-25T04:30:00.000Z' });
  assert.match(svg, /obs-chart-uncollected/, 'no uncollected region drawn');
  assert.match(svg, /obsHatch/, 'the hatch is referenced but never defined');
  assert.match(svg, /Not collected/, 'pre-recording slots do not say so on hover');
  assert.match(svg, /No requests/, 'observed-zero slots do not say so on hover');
  assert.equal(svg.match(/NaN|Infinity|undefined/), null);

  const covered = fn('renderTrafficChart')(filled, { coverageStart: '2026-09-20T00:00:00.000Z' });
  assert.doesNotMatch(covered, /obs-chart-uncollected/,
    'shaded a region although recording predates the whole window');
  assert.doesNotMatch(covered, /<defs>/, 'emitted a paint server nothing uses');
});
