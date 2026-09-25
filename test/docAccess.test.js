// Doc-access request permission/status rules — the class of regression the
// README's "Test coverage is partial" gap specifically calls out ("the kind
// #6 and #7 were"). These are pure decision functions extracted from
// server/routes/docAccess.js (requireAdminOrProjectOwner and the
// approve/deny/revoke/delete/endpoint-status routes) precisely so they can
// be exercised here without a database — same zero-DB, node:test style as
// every other file in this directory.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused@127.0.0.1:1/none';
process.env.MASTER_KEY = process.env.MASTER_KEY || Buffer.alloc(32, 9).toString('base64');

const test = require('node:test');
const assert = require('node:assert/strict');
const docAccess = require('../server/routes/docAccess');

const {
  canActOnDocAccessRequest, canRevokeDocAccessRequest, canDeleteDocAccessRequest, deriveDocAccessDisplayStatus,
  parsePageParams, parseCursorPending,
} = docAccess;

function row(over = {}) {
  return { project_owner_id: 1, requested_by: 2, ...over };
}
function authUser(over = {}) {
  return { role: 'viewer', sub: 3, ...over };
}

/* ---------- canActOnDocAccessRequest ---------- */

test('an Admin may act on any project\'s request', () => {
  const d = canActOnDocAccessRequest(row({ project_owner_id: 99 }), authUser({ role: 'admin', sub: 3 }));
  assert.equal(d.allowed, true);
});

test('the project owner may act on their own project\'s request', () => {
  const d = canActOnDocAccessRequest(row({ project_owner_id: 5 }), authUser({ role: 'editor', sub: 5 }));
  assert.equal(d.allowed, true);
});

test('a non-Admin who does not own the project is rejected', () => {
  const d = canActOnDocAccessRequest(row({ project_owner_id: 5 }), authUser({ role: 'editor', sub: 6 }));
  assert.equal(d.allowed, false);
  assert.match(d.reason, /Admin or this project's owner/);
});

test('nobody may act on their own request — not even an Admin', () => {
  const d = canActOnDocAccessRequest(row({ project_owner_id: 1, requested_by: 3 }), authUser({ role: 'admin', sub: 3 }));
  assert.equal(d.allowed, false);
  assert.match(d.reason, /your own documentation access request/);
});

test('nobody may act on their own request — not even the project owner', () => {
  const d = canActOnDocAccessRequest(row({ project_owner_id: 3, requested_by: 3 }), authUser({ role: 'editor', sub: 3 }));
  assert.equal(d.allowed, false);
  assert.match(d.reason, /your own documentation access request/);
});

test('the own-request check is evaluated even for an Admin who also owns the project', () => {
  // Regression guard: an earlier ordering could let "is Admin" short-circuit
  // past the self-action check entirely.
  const d = canActOnDocAccessRequest(row({ project_owner_id: 3, requested_by: 3 }), authUser({ role: 'admin', sub: 3 }));
  assert.equal(d.allowed, false);
});

/* ---------- canRevokeDocAccessRequest ---------- */

test('only an approved grant can be revoked', () => {
  assert.equal(canRevokeDocAccessRequest('approved'), true);
  for (const status of ['pending', 'denied', 'revoked']) {
    assert.equal(canRevokeDocAccessRequest(status), false, `status ${status} should not be revocable`);
  }
});

/* ---------- canDeleteDocAccessRequest ---------- */

test('a pending request cannot be deleted — deny it first', () => {
  assert.equal(canDeleteDocAccessRequest({ status: 'pending', is_active: false }), false);
});

test('a currently-active approved grant cannot be deleted — revoke it first', () => {
  assert.equal(canDeleteDocAccessRequest({ status: 'approved', is_active: true }), false);
});

test('an approved grant outside its date range (not active) can be deleted', () => {
  assert.equal(canDeleteDocAccessRequest({ status: 'approved', is_active: false }), true);
});

test('a denied or revoked request can always be deleted', () => {
  assert.equal(canDeleteDocAccessRequest({ status: 'denied', is_active: false }), true);
  assert.equal(canDeleteDocAccessRequest({ status: 'revoked', is_active: false }), true);
});

/* ---------- deriveDocAccessDisplayStatus ---------- */

test('no row at all displays as none', () => {
  assert.deepEqual(deriveDocAccessDisplayStatus(null), { status: 'none', endDate: null });
});

test('is_active wins over the underlying status', () => {
  const d = deriveDocAccessDisplayStatus({ is_active: true, status: 'approved', end_date: '2026-01-01' });
  assert.deepEqual(d, { status: 'active', endDate: '2026-01-01' });
});

test('an approved grant OUTSIDE its date range displays as expired, not approved', () => {
  const d = deriveDocAccessDisplayStatus({ is_active: false, status: 'approved', end_date: '2020-01-01' });
  assert.equal(d.status, 'expired');
});

test('pending, denied, and revoked pass through directly when not active', () => {
  for (const status of ['pending', 'denied', 'revoked']) {
    const d = deriveDocAccessDisplayStatus({ is_active: false, status });
    assert.equal(d.status, status);
  }
});

test('an unrecognized status falls back to none rather than throwing', () => {
  const d = deriveDocAccessDisplayStatus({ is_active: false, status: 'some-future-status' });
  assert.equal(d.status, 'none');
});

/* ---------- parsePageParams / parseCursorPending (GET /my-requests, /admin) ---------- */
// The /admin queue's cursor is a PAIR (id + pending-rank of the last row
// shown) rather than a bare id, because the primary sort is a computed
// boolean (pending-first) that a plain `id < cursor` cursor would silently
// break — worth its own coverage since that's exactly the "cursor logic"
// shape of bug the README calls out.

test('parsePageParams defaults to 50 with no limit given', () => {
  assert.deepEqual(parsePageParams({}), { limit: 50, cursorId: null });
});

test('parsePageParams clamps a limit above the 200 ceiling', () => {
  assert.equal(parsePageParams({ limit: '5000' }).limit, 200);
});

test('parsePageParams clamps a negative limit up to 1, not down to 0', () => {
  assert.equal(parsePageParams({ limit: '-10' }).limit, 1);
});

test('parsePageParams falls back to the default for a limit of exactly 0', () => {
  // parseInt('0', 10) || PAGE_SIZE_DEFAULT: 0 is falsy in JS, so this takes
  // the same "not a real number" fallback path as an unparseable string,
  // rather than clamping 0 up to 1. Documented here so this stays a known,
  // deliberate quirk rather than being "fixed" into a behavior change later.
  assert.equal(parsePageParams({ limit: '0' }).limit, 50);
});

test('parsePageParams falls back to the default on a non-numeric limit', () => {
  assert.equal(parsePageParams({ limit: 'not-a-number' }).limit, 50);
});

test('parsePageParams passes through a valid integer cursorId', () => {
  assert.equal(parsePageParams({ cursorId: '4321' }).cursorId, 4321);
});

test('parsePageParams rejects a non-integer cursorId rather than passing it to SQL', () => {
  assert.equal(parsePageParams({ cursorId: 'abc' }).cursorId, null);
  assert.equal(parsePageParams({ cursorId: '12.5' }).cursorId, null);
});

test('parsePageParams treats a missing cursorId as "from the start"', () => {
  assert.equal(parsePageParams({}).cursorId, null);
});

test('parseCursorPending reads the literal strings the client sends', () => {
  assert.equal(parseCursorPending({ cursorPending: 'true' }), true);
  assert.equal(parseCursorPending({ cursorPending: 'false' }), false);
});

test('parseCursorPending treats anything else (including absent) as unknown, not false', () => {
  // Distinguishing "unknown" from "false" matters: /admin's route handler
  // does an extra lookup only when this is null, rather than silently
  // assuming the last row wasn't pending.
  assert.equal(parseCursorPending({}), null);
  assert.equal(parseCursorPending({ cursorPending: 'TRUE' }), null);
  assert.equal(parseCursorPending({ cursorPending: '' }), null);
});
