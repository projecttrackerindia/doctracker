// composeOneEnvironment()/composeWriterSegments() - the multi-writer merge
// for PUT/GET /api/workspace/endpoint-metrics (server/routes/workspace.js).
//
// Two agents on different hosts (or the same host tailing genuinely
// different apps) are a supported deployment and their counters are meant
// to sum. Two agents that end up with the SAME sourceFingerprint (hostname +
// exact set of tailed files - see source_fingerprint() in
// mule_doc_agent.py) are reading the identical files, so every sum above
// just silently doubled real traffic. The fingerprint has been computed and
// sent by the agent since an earlier fix, but nothing ever consumed it until
// now - this pins that consumer: duplicate fingerprints across different
// writerIds must surface as agentHealth.duplicateWriterGroups, and
// legitimately distinct agents must never be flagged.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.MASTER_KEY = process.env.MASTER_KEY || Buffer.alloc(32, 9).toString('base64');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused@127.0.0.1:1/none';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unused-test-secret';
const { composeOneEnvironment, composeWriterSegments } = require('../server/routes/workspace');

function segment(over = {}) {
  return {
    environment: 'DEV',
    endpoints: {},
    agentHealth: { generatedAt: '2024-01-01T00:00:00.000Z', sourceFingerprint: 'fp-A' },
    logRecords: [],
    ...over,
  };
}

test('two writers with the SAME sourceFingerprint are flagged as duplicates', () => {
  const entries = [
    ['writer-1', segment({ agentHealth: { generatedAt: '2024-01-01T00:00:01.000Z', sourceFingerprint: 'fp-A' } })],
    ['writer-2', segment({ agentHealth: { generatedAt: '2024-01-01T00:00:02.000Z', sourceFingerprint: 'fp-A' } })],
  ];
  const { agentHealth } = composeOneEnvironment(entries);
  assert.ok(Array.isArray(agentHealth.duplicateWriterGroups), 'duplicateWriterGroups must be present');
  assert.equal(agentHealth.duplicateWriterGroups.length, 1);
  assert.deepEqual([...agentHealth.duplicateWriterGroups[0]].sort(), ['writer-1', 'writer-2']);
});

test('two writers with DIFFERENT sourceFingerprints are never flagged', () => {
  const entries = [
    ['writer-1', segment({ agentHealth: { generatedAt: '2024-01-01T00:00:01.000Z', sourceFingerprint: 'fp-A' } })],
    ['writer-2', segment({ agentHealth: { generatedAt: '2024-01-01T00:00:02.000Z', sourceFingerprint: 'fp-B' } })],
  ];
  const { agentHealth } = composeOneEnvironment(entries);
  assert.equal(agentHealth.duplicateWriterGroups, undefined, 'legitimately distinct agents must not be flagged');
});

test('a single writer is never flagged, regardless of fingerprint', () => {
  const entries = [['writer-1', segment()]];
  const { agentHealth } = composeOneEnvironment(entries);
  assert.equal(agentHealth.duplicateWriterGroups, undefined);
});

test('a writer with no sourceFingerprint at all (older agent build) is ignored, not treated as a match with another missing one', () => {
  const entries = [
    ['writer-1', segment({ agentHealth: { generatedAt: '2024-01-01T00:00:01.000Z' } })],
    ['writer-2', segment({ agentHealth: { generatedAt: '2024-01-01T00:00:02.000Z' } })],
  ];
  const { agentHealth } = composeOneEnvironment(entries);
  assert.equal(agentHealth.duplicateWriterGroups, undefined,
    'two writers both lacking a fingerprint must not be grouped together as if they matched');
});

test('three or more duplicate writers land in ONE group, not pairwise groups', () => {
  const entries = [
    ['writer-1', segment({ agentHealth: { generatedAt: '2024-01-01T00:00:01.000Z', sourceFingerprint: 'fp-A' } })],
    ['writer-2', segment({ agentHealth: { generatedAt: '2024-01-01T00:00:02.000Z', sourceFingerprint: 'fp-A' } })],
    ['writer-3', segment({ agentHealth: { generatedAt: '2024-01-01T00:00:03.000Z', sourceFingerprint: 'fp-A' } })],
  ];
  const { agentHealth } = composeOneEnvironment(entries);
  assert.equal(agentHealth.duplicateWriterGroups.length, 1);
  assert.equal(agentHealth.duplicateWriterGroups[0].length, 3);
});

test('a duplicate-writer group in one environment does not leak into a genuinely separate environment', () => {
  const stored = {
    writers: {
      'writer-1': segment({ environment: 'DEV', agentHealth: { generatedAt: '2024-01-01T00:00:01.000Z', sourceFingerprint: 'fp-A' } }),
      'writer-2': segment({ environment: 'DEV', agentHealth: { generatedAt: '2024-01-01T00:00:02.000Z', sourceFingerprint: 'fp-A' } }),
      'writer-3': segment({ environment: 'UAT', agentHealth: { generatedAt: '2024-01-01T00:00:03.000Z', sourceFingerprint: 'fp-A' } }),
    },
  };
  const composed = composeWriterSegments(stored);
  assert.equal(composed.environments.DEV.agentHealth.duplicateWriterGroups.length, 1,
    'the two genuinely-duplicate DEV writers are flagged');
  assert.equal(composed.environments.UAT.agentHealth.duplicateWriterGroups, undefined,
    'the lone UAT writer sharing the same fingerprint string is a different environment, not a duplicate of it');
});

test('composeOneEnvironment still sums counters correctly alongside the new duplicate check (no regression)', () => {
  const entries = [
    ['writer-1', segment({
      endpoints: { 'GET /x': { totalRequests: 10, statusBreakdown: { '2xx': 10 } } },
      agentHealth: { generatedAt: '2024-01-01T00:00:01.000Z', sourceFingerprint: 'fp-A' },
    })],
    ['writer-2', segment({
      endpoints: { 'GET /x': { totalRequests: 5, statusBreakdown: { '2xx': 5 } } },
      agentHealth: { generatedAt: '2024-01-01T00:00:02.000Z', sourceFingerprint: 'fp-B' },
    })],
  ];
  const { endpoints } = composeOneEnvironment(entries);
  assert.equal(endpoints['GET /x'].totalRequests, 15, 'two DIFFERENT agents still sum normally');
});
