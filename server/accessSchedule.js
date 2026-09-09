// Shared "is this account inside its allowed access window right now"
// logic. Kept as one small pure function so authGuard.js (enforcement) and
// routes/users.js (surfacing the current state back to the admin) agree —
// there used to be a temptation to inline this check in two places and let
// them drift. There's a second, browser-side copy of this same logic inline
// in server/views/studio.html (evaluateAccessScheduleClient) purely so the
// UI can show a live "locks in 2h 14m" countdown without polling the server
// every few seconds — that copy must stay in sync with this one by hand,
// since this app ships plain <script> tags with no bundler to share code
// through. This module is the source of truth; the client copy is a display
// convenience only — the server never trusts the client's own idea of
// whether it's locked (see blockIfScheduleLocked in middleware/authGuard.js).
//
// `now` is always in the server's local time zone (Railway container clock).
// There's no per-organisation time zone setting yet — days/times are
// whatever the server considers "now", not the admin's or the end user's.

function minutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

function parseHHMM(hhmm) {
  const [h, m] = String(hhmm || '00:00').split(':').map(Number);
  return h * 60 + m;
}

// Returns { locked, nextChangeAt } where nextChangeAt is a Date the UI can
// count down to — either "unlocks at" (currently locked) or "locks at"
// (currently open), or null if the schedule doesn't apply (disabled/unset).
function evaluateAccessSchedule(schedule, now = new Date()) {
  if (!schedule || !schedule.enabled) return { locked: false, nextChangeAt: null };

  const day = now.getDay();
  const mins = minutesSinceMidnight(now);
  const start = parseHHMM(schedule.startTime);
  const end = parseHHMM(schedule.endTime);
  const days = schedule.days || [];

  // Same-day window only (e.g. 09:00–18:00). An overnight window like
  // 22:00–06:00 isn't supported yet — startTime is always assumed to be
  // earlier in the day than endTime.
  const withinTimeOfDay = start < end ? (mins >= start && mins < end) : false;
  const openToday = days.includes(day) && withinTimeOfDay;

  if (openToday) {
    const unlocksNever = false;
    const nextChangeAt = new Date(now);
    nextChangeAt.setHours(0, 0, 0, 0);
    nextChangeAt.setMinutes(end);
    return { locked: false, nextChangeAt: unlocksNever ? null : nextChangeAt };
  }

  // Locked — find the next day (today included, if the window is still ahead
  // of us today) that's in the allowed set, and report that as the unlock time.
  for (let offset = 0; offset <= 7; offset++) {
    const d = new Date(now);
    d.setDate(d.getDate() + offset);
    const dow = d.getDay();
    if (!days.includes(dow)) continue;
    const candidateStart = new Date(d);
    candidateStart.setHours(0, 0, 0, 0);
    candidateStart.setMinutes(start);
    if (candidateStart > now) return { locked: true, nextChangeAt: candidateStart };
  }
  return { locked: true, nextChangeAt: null }; // e.g. `days` somehow ended up empty
}

// Human-readable summary for the admin panel and the project-level banner —
// "Mon, Wed, Fri · 9:00 AM–6:00 PM".
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function formatHHMM(hhmm) {
  const [h, m] = String(hhmm || '00:00').split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}
function describeAccessSchedule(schedule) {
  if (!schedule || !schedule.enabled) return null;
  const days = (schedule.days || []).slice().sort();
  const dayLabel = days.length === 7 ? 'Every day' : days.map((d) => DAY_LABELS[d]).join(', ');
  return `${dayLabel} \u00b7 ${formatHHMM(schedule.startTime)}\u2013${formatHHMM(schedule.endTime)}`;
}

module.exports = { evaluateAccessSchedule, describeAccessSchedule };
