// Smoke tests for the access-schedule evaluation logic (server/accessSchedule.js).
// Pure function, deterministic given a fixed `now` — no DB/network needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateAccessSchedule, describeAccessSchedule } = require('../server/accessSchedule');

// Wednesday, 10:00 local time.
const WED_10AM = new Date(2024, 0, 3, 10, 0, 0); // Jan 3 2024 was a Wednesday

test('disabled/unset schedule is never locked', () => {
  assert.equal(evaluateAccessSchedule(null, WED_10AM).locked, false);
  assert.equal(evaluateAccessSchedule({ enabled: false }, WED_10AM).locked, false);
});

test('within the allowed window on an allowed day is unlocked', () => {
  const schedule = { enabled: true, days: [3], startTime: '09:00', endTime: '18:00' }; // Wed only
  const result = evaluateAccessSchedule(schedule, WED_10AM);
  assert.equal(result.locked, false);
  assert.ok(result.nextChangeAt instanceof Date); // reports when it locks
});

test('outside the allowed time-of-day window is locked', () => {
  const schedule = { enabled: true, days: [3], startTime: '09:00', endTime: '09:30' }; // window already passed
  const result = evaluateAccessSchedule(schedule, WED_10AM);
  assert.equal(result.locked, true);
});

test('a day not in the allowed set is locked, with a next-unlock date', () => {
  const schedule = { enabled: true, days: [1], startTime: '09:00', endTime: '18:00' }; // Monday only
  const result = evaluateAccessSchedule(schedule, WED_10AM);
  assert.equal(result.locked, true);
  assert.ok(result.nextChangeAt instanceof Date);
});

test('describeAccessSchedule returns null for a disabled schedule', () => {
  assert.equal(describeAccessSchedule(null), null);
  assert.equal(describeAccessSchedule({ enabled: false }), null);
});

test('describeAccessSchedule formats an enabled schedule for display', () => {
  const schedule = { enabled: true, days: [1, 3, 5], startTime: '09:00', endTime: '18:00' };
  const label = describeAccessSchedule(schedule);
  assert.match(label, /Mon/);
  assert.match(label, /9:00 AM/);
  assert.match(label, /6:00 PM/);
});
