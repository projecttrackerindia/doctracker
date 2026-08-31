(function () {
  const form = document.getElementById('loginForm');
  const alertBox = document.getElementById('formAlert');
  const submitBtn = document.getElementById('submitBtn');
  const statusPill = document.getElementById('loginStatus');
  const consoleBody = document.getElementById('loginConsoleBody');
  const identifierInput = document.getElementById('identifier');
  const passwordInput = document.getElementById('password');

  function escapeHtml(str) {
    return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Masks the identifier for display in the decorative JSON preview only — the
  // real input box stays plain text so you can proofread what you typed.
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
    alertBox.className = 'form-alert error';
  }
  function hideAlert() {
    alertBox.className = 'form-alert error';
    alertBox.textContent = '';
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAlert();
    setStatus('warn', 'sending…');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Signing in…';

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
        submitBtn.textContent = 'Sign in';
        return;
      }

      setStatus('ok', '200 OK');
      // The organisation name never appears in the URL in the clear — the
      // server hands back an encrypted token bound to this account's org
      // (see server/crypto.js), and every tenant-scoped page is addressed as
      // /<token>/... instead of /....
      window.location.href = data.orgToken ? `/${data.orgToken}/dashboard.html` : '/dashboard.html';
    } catch (err) {
      setStatus('fail', 'network');
      showAlert('Could not reach the server. Check your connection and try again.');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Sign in';
    }
  });
})();
