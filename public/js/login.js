(function () {
  const form = document.getElementById('loginForm');
  const alertBox = document.getElementById('formAlert');
  const submitBtn = document.getElementById('submitBtn');
  const statusPill = document.getElementById('loginStatus');
  const consoleBody = document.getElementById('loginConsoleBody');
  const identifierInput = document.getElementById('identifier');
  const passwordInput = document.getElementById('password');
  const submitBtnLabel = document.getElementById('submitBtnLabel');

  const mfaForm = document.getElementById('mfaForm');
  const mfaCodeInput = document.getElementById('mfaCode');
  const mfaSubmitBtn = document.getElementById('mfaSubmitBtn');
  const mfaSubmitBtnLabel = document.getElementById('mfaSubmitBtnLabel');
  const mfaBackLink = document.getElementById('mfaBackLink');
  let pendingChallengeToken = null;

  const forgotForm = document.getElementById('forgotForm');
  const forgotPasswordLink = document.getElementById('forgotPasswordLink');
  const forgotIdentifierInput = document.getElementById('forgotIdentifier');
  const forgotSubmitBtn = document.getElementById('forgotSubmitBtn');
  const forgotSubmitBtnLabel = document.getElementById('forgotSubmitBtnLabel');
  const forgotBackLink = document.getElementById('forgotBackLink');

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
        // A 423 (account locked, Finding F-04) carries a friendly `message`
        // alongside a machine-readable `error` code — prefer the message,
        // same as every other error shape falls back to `error` for.
        showAlert(data.message || data.error || 'Sign in failed. Please try again.');
        submitBtn.disabled = false;
        submitBtn.classList.remove('is-loading');
        submitBtnLabel.textContent = 'Sign in';
        return;
      }

      // MFA enabled on this account (Finding F-04) — password was correct,
      // but the session isn't issued yet. Swap to the code-entry step
      // instead of treating this 200 as "signed in."
      if (data.mfaRequired) {
        pendingChallengeToken = data.challengeToken;
        setStatus('warn', 'MFA required');
        submitBtn.disabled = false;
        submitBtn.classList.remove('is-loading');
        submitBtnLabel.textContent = 'Sign in';
        form.hidden = true;
        mfaForm.hidden = false;
        mfaCodeInput.value = '';
        mfaCodeInput.focus();
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

  mfaBackLink.addEventListener('click', (e) => {
    e.preventDefault();
    pendingChallengeToken = null;
    mfaForm.hidden = true;
    form.hidden = false;
    passwordInput.value = '';
    hideAlert();
    setStatus('idle', 'idle');
  });

  mfaForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAlert();
    if (!pendingChallengeToken) {
      showAlert('This sign-in attempt has expired. Please log in again.');
      mfaForm.hidden = true;
      form.hidden = false;
      return;
    }
    setStatus('warn', 'sending…');
    mfaSubmitBtn.disabled = true;
    mfaSubmitBtn.classList.add('is-loading');
    mfaSubmitBtnLabel.textContent = 'Verifying…';

    try {
      const res = await fetch('/api/auth/mfa/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ challengeToken: pendingChallengeToken, code: mfaCodeInput.value.trim() }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setStatus('fail', String(res.status));
        showAlert(data.message || data.error || 'Could not verify that code. Please try again.');
        mfaSubmitBtn.disabled = false;
        mfaSubmitBtn.classList.remove('is-loading');
        mfaSubmitBtnLabel.textContent = 'Verify';
        return;
      }

      setStatus('ok', '200 OK');
      mfaSubmitBtn.classList.remove('is-loading');
      mfaSubmitBtn.classList.add('is-success');
      mfaSubmitBtnLabel.textContent = 'Signed in';
      const dest = data.orgToken ? `/${data.orgToken}/dashboard.html` : '/dashboard.html';
      setTimeout(() => { window.location.href = dest; }, 450);
    } catch (err) {
      setStatus('fail', 'network');
      showAlert('Could not reach the server. Check your connection and try again.');
      mfaSubmitBtn.disabled = false;
      mfaSubmitBtn.classList.remove('is-loading');
      mfaSubmitBtnLabel.textContent = 'Verify';
    }
  });

  forgotPasswordLink.addEventListener('click', (e) => {
    e.preventDefault();
    hideAlert();
    form.hidden = true;
    forgotForm.hidden = false;
    forgotIdentifierInput.value = identifierInput.value.trim();
    forgotIdentifierInput.focus();
  });
  forgotBackLink.addEventListener('click', (e) => {
    e.preventDefault();
    forgotForm.hidden = true;
    form.hidden = false;
    hideAlert();
  });

  forgotForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAlert();
    // QA regression (2026-09-26, bug #8): this used to send the request
    // regardless of whether the field was empty, and since the server's
    // response is deliberately identical either way (anti-enumeration -
    // see request-password-reset in routes/auth.js), an empty submission
    // still showed "Sent". An empty field reveals nothing about whether any
    // account exists, so catching it here first is safe and just saves a
    // pointless request.
    if (!forgotIdentifierInput.value.trim()) {
      showAlert('Enter your email or username first.');
      forgotIdentifierInput.focus();
      return;
    }
    forgotSubmitBtn.disabled = true;
    forgotSubmitBtn.classList.add('is-loading');
    forgotSubmitBtnLabel.textContent = 'Sending…';

    try {
      const res = await fetch('/api/auth/request-password-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: forgotIdentifierInput.value.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      // Response is deliberately identical whether or not the account
      // exists (see server/routes/auth.js) — always show it as success.
      forgotSubmitBtn.classList.remove('is-loading');
      forgotSubmitBtn.classList.add('is-success');
      forgotSubmitBtnLabel.textContent = 'Sent';
      alertBox.className = 'form-alert success';
      alertBox.textContent = data.message || "If that account exists, your organisation's Admin has been notified.";
    } catch (err) {
      forgotSubmitBtn.disabled = false;
      forgotSubmitBtn.classList.remove('is-loading');
      forgotSubmitBtnLabel.textContent = 'Notify Admin';
      showAlert('Could not reach the server. Check your connection and try again.');
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
