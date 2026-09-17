(function () {
  const form = document.getElementById('loginForm');
  const alertBox = document.getElementById('formAlert');
  const submitBtn = document.getElementById('submitBtn');
  const statusPill = document.getElementById('loginStatus');
  const consoleBody = document.getElementById('loginConsoleBody');
  const identifierInput = document.getElementById('identifier');
  const passwordInput = document.getElementById('password');
  const submitBtnLabel = document.getElementById('submitBtnLabel');

  function escapeHtml(str) {
    return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Masks the identifier for display in the decorative JSON preview too — the
  // real input box now hides it by default as well (type="password", with
  // its own Show/Hide toggle exactly like the password field below), so both
  // stay consistent instead of the preview being the only masked copy.
  function maskIdentifier(val) {
    if (!val) return '';
    const at = val.indexOf('@');
    if (at === -1) {
      // Not an email — just show the first character and mask the rest.
      return val.length <= 1 ? val : val[0] + '•'.repeat(val.length - 1);
    }
    const local = val.slice(0, at);
    const domain = val.slice(at + 1);
    const maskedLocal = local.length <= 2 ? local[0] + '•'.repeat(Math.max(local.length - 1, 1)) : local.slice(0, 2) + '•'.repeat(local.length - 2);
    return `${maskedLocal}@${domain}`;
  }

  function renderConsole() {
    const idVal = identifierInput.value.trim();
    const pwLen = passwordInput.value.length;
    consoleBody.innerHTML =
      '<span class="punct">{</span>\n' +
      `  <span class="k">"identifier"</span><span class="punct">:</span> <span class="s">"${idVal ? escapeHtml(maskIdentifier(idVal)) : 'waiting for input…'}"</span><span class="punct">,</span>\n` +
      `  <span class="k">"password"</span><span class="punct">:</span> <span class="s">"${'•'.repeat(Math.min(pwLen, 20)) || '••••••••'}"</span>\n` +
      '<span class="punct">}</span>';
  }
  identifierInput.addEventListener('input', renderConsole);
  passwordInput.addEventListener('input', renderConsole);

  document.querySelectorAll('.pw-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = document.getElementById(btn.dataset.target);
      const showing = target.type === 'text';
      target.type = showing ? 'password' : 'text';
      btn.textContent = showing ? 'Show' : 'Hide';
    });
  });

  function setStatus(state, text) {
    statusPill.dataset.state = state;
    statusPill.textContent = text;
  }

  function showAlert(message) {
    alertBox.textContent = message;
    // Restart the shake animation even if an alert is already showing
    // (e.g. two failed attempts in a row) — removing the class, forcing a
    // reflow, then re-adding it is what makes a CSS animation replay instead
    // of being a no-op the second time the same class is set.
    alertBox.className = 'form-alert error';
    void alertBox.offsetWidth;
    alertBox.classList.add('shake');
  }
  function hideAlert() {
    alertBox.className = 'form-alert';
    alertBox.textContent = '';
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAlert();
    setStatus('warn', 'sending…');
    submitBtn.disabled = true;
    submitBtn.classList.add('is-loading');
    submitBtnLabel.textContent = 'Signing in…';

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          identifier: identifierInput.value.trim(),
          password: passwordInput.value,
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setStatus('fail', String(res.status));
        showAlert(data.error || 'Sign in failed. Please try again.');
        submitBtn.disabled = false;
        submitBtn.classList.remove('is-loading');
        submitBtnLabel.textContent = 'Sign in';
        return;
      }

      setStatus('ok', '200 OK');
      // Brief success flourish (checkmark, green button) before navigating —
      // a beat of positive feedback instead of the page silently jumping the
      // instant the response lands, which read as the click not registering.
      submitBtn.classList.remove('is-loading');
      submitBtn.classList.add('is-success');
      submitBtnLabel.textContent = 'Signed in';
      // The organisation name never appears in the URL in the clear — the
      // server hands back an encrypted token bound to this account's org
      // (see server/crypto.js), and every tenant-scoped page is addressed as
      // /<token>/... instead of /....
      const dest = data.orgToken ? `/${data.orgToken}/dashboard.html` : '/dashboard.html';
      setTimeout(() => { window.location.href = dest; }, 450);
    } catch (err) {
      setStatus('fail', 'network');
      showAlert('Could not reach the server. Check your connection and try again.');
      submitBtn.disabled = false;
      submitBtn.classList.remove('is-loading');
      submitBtnLabel.textContent = 'Sign in';
    }
  });

  // Landed here via an idle-timeout logout (see public/js/idle-session.js
  // and IDLE_TIMEOUT_MS in server/middleware/authGuard.js) rather than a
  // manual "Log out" click — say so, instead of silently dropping them back
  // on a blank login form with no explanation.
  const params = new URLSearchParams(window.location.search);
  if (params.get('reason') === 'idle') {
    showAlert("You've been signed out after 30 minutes of inactivity. Please sign in again.");
    params.delete('reason');
    const cleanUrl = window.location.pathname + (params.toString() ? `?${params.toString()}` : '');
    window.history.replaceState({}, document.title, cleanUrl);
  }
})();
