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

  function renderConsole() {
    const idVal = identifierInput.value.trim();
    const pwLen = passwordInput.value.length;
    consoleBody.innerHTML =
      '<span class="punct">{</span>\n' +
      `  <span class="k">"identifier"</span><span class="punct">:</span> <span class="s">"${idVal ? escapeHtml(idVal) : 'waiting for input…'}"</span><span class="punct">,</span>\n` +
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
      window.location.href = '/dashboard.html';
    } catch (err) {
      setStatus('fail', 'network');
      showAlert('Could not reach the server. Check your connection and try again.');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Sign in';
    }
  });
})();
