// Idle-timeout auto-logout, shared by every authenticated page (studio,
// editor, architecture studio, audit log, the placeholder dashboard).
//
// This is a UX convenience layer, NOT the security boundary — the real
// enforcement is server-side (see IDLE_TIMEOUT_MS in
// server/middleware/authGuard.js), which rejects any request from a session
// that's been untouched for 30+ minutes regardless of what this script does.
// What this file adds on top:
//   1. Logs the user out proactively, client-side, the moment 30 idle
//      minutes pass — instead of waiting for their next action to fail with
//      a 401 they'd have to puzzle over.
//   2. A visible warning before that happens, so someone who's mid-thought
//      but not touching the keyboard/mouse gets a chance to stay signed in.
//   3. Cross-tab sync via localStorage, so activity in one tab keeps every
//      other open tab alive, and an idle-logout in one closes them all.
//
// The timer resets ONLY on real user activity (mouse, keyboard, touch,
// scroll) — never on a fixed clock, and never just because a background
// fetch happened to succeed. A tab left open and untouched WILL log out
// after 30 minutes even if e.g. a periodic poll is quietly succeeding
// in the background.
(function () {
  var IDLE_TIMEOUT_MS = 30 * 60 * 1000; // keep in sync with server/middleware/authGuard.js
  var WARNING_BEFORE_MS = 60 * 1000; // show the countdown warning 1 minute out
  var STORAGE_KEY = 'as_last_activity';
  var LOGOUT_KEY = 'as_idle_logout';
  var CHECK_INTERVAL_MS = 5 * 1000;

  var warningEl = null;
  var countdownEl = null;
  var loggingOut = false;

  function now() { return Date.now(); }

  function getLastActivity() {
    var v = parseInt(localStorage.getItem(STORAGE_KEY), 10);
    return isNaN(v) ? now() : v;
  }

  function recordActivity() {
    // Only relevant while the warning banner ISN'T showing — once it's up,
    // activity is handled by the banner's own "Stay signed in" button so a
    // stray mouse twitch while reading the warning doesn't silently dismiss
    // it without the person noticing they were ever close to being logged out.
    if (warningEl) return;
    localStorage.setItem(STORAGE_KEY, String(now()));
  }

  function ensureWarningEl() {
    if (warningEl) return warningEl;
    warningEl = document.createElement('div');
    warningEl.setAttribute('role', 'alertdialog');
    warningEl.setAttribute('aria-live', 'assertive');
    warningEl.style.cssText = [
      'position:fixed', 'top:16px', 'right:16px', 'z-index:2147483647',
      'max-width:340px', 'padding:16px 18px', 'border-radius:12px',
      'background:#1c1f26', 'color:#f2f3f5', 'font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
      'box-shadow:0 8px 28px rgba(0,0,0,.35)', 'border:1px solid rgba(255,255,255,.08)',
    ].join(';');
    warningEl.innerHTML =
      '<div style="font-weight:600;margin-bottom:4px;">Still there?</div>' +
      '<div style="opacity:.85;margin-bottom:12px;">' +
      'You\'ll be signed out in <span id="asIdleCountdown">60</span>s due to inactivity.</div>' +
      '<button id="asIdleStayBtn" style="all:unset;cursor:pointer;background:#3b82f6;color:#fff;' +
      'padding:7px 14px;border-radius:8px;font-weight:600;font-size:13px;">Stay signed in</button>';
    document.body.appendChild(warningEl);
    countdownEl = warningEl.querySelector('#asIdleCountdown');
    warningEl.querySelector('#asIdleStayBtn').addEventListener('click', function () {
      dismissWarning();
      localStorage.setItem(STORAGE_KEY, String(now()));
      // Touch the server too, not just the local timer, so the DB-side
      // last_activity_at actually moves — otherwise the very next real API
      // call would land right back at (or past) the server's own 30-minute
      // mark. Any lightweight authenticated GET does this; /api/auth/me is
      // the cheapest one available on every page.
      fetch('/api/auth/me', { credentials: 'include' }).catch(function () {});
    });
    return warningEl;
  }

  function dismissWarning() {
    if (warningEl && warningEl.parentNode) warningEl.parentNode.removeChild(warningEl);
    warningEl = null;
    countdownEl = null;
  }

  function showWarning(msRemaining) {
    ensureWarningEl();
    if (countdownEl) countdownEl.textContent = String(Math.max(0, Math.ceil(msRemaining / 1000)));
  }

  async function doLogout(reason) {
    if (loggingOut) return;
    loggingOut = true;
    try { localStorage.setItem(LOGOUT_KEY, String(now())); } catch (e) { /* ignore */ }
    try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }); } catch (e) { /* ignore — redirect regardless */ }
    window.location.href = '/login.html?reason=' + encodeURIComponent(reason || 'idle');
  }

  function tick() {
    if (loggingOut) return;
    var idleFor = now() - getLastActivity();
    var remaining = IDLE_TIMEOUT_MS - idleFor;
    if (remaining <= 0) {
      dismissWarning();
      doLogout('idle');
      return;
    }
    if (remaining <= WARNING_BEFORE_MS) {
      showWarning(remaining);
    } else if (warningEl) {
      dismissWarning();
    }
  }

  // Cross-tab: another tab's activity keeps this tab alive too, and another
  // tab's idle-logout logs this one out immediately rather than each tab
  // running its own independent 30-minute clock.
  window.addEventListener('storage', function (e) {
    if (e.key === LOGOUT_KEY) {
      loggingOut = true;
      window.location.href = '/login.html?reason=idle';
    }
  });

  ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'wheel'].forEach(function (evt) {
    window.addEventListener(evt, recordActivity, { passive: true, capture: true });
  });

  // A user typing/clicking counts even if they haven't triggered a mousemove
  // recently (e.g. dense keyboard use in a form).
  recordActivity();
  setInterval(tick, CHECK_INTERVAL_MS);

  // If the SERVER rejects a request with the idle-timeout error (the real,
  // authoritative check), honor it immediately instead of waiting for this
  // tab's own client-side timer to catch up — covers the case where the
  // client-side timer drifted, the machine slept, or this script wasn't
  // loaded on some other tab that made the request.
  var nativeFetch = window.fetch;
  window.fetch = function () {
    return nativeFetch.apply(this, arguments).then(function (res) {
      if (res && res.status === 401) {
        res
          .clone()
          .json()
          .then(function (body) {
            if (body && body.error === 'idle_timeout') doLogout('idle');
          })
          .catch(function () {});
      }
      return res;
    });
  };
})();
