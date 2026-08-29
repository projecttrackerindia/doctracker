(function () {
  // ---- Mirrors server/validators.js so feedback is instant; the server re-checks everything. ----
  const FREEMAIL_BLOCKLIST = new Set([
    'yahoo.com', 'yahoo.co.in', 'yahoo.co.uk',
    'hotmail.com', 'outlook.com', 'live.com', 'msn.com',
    'aol.com', 'icloud.com', 'me.com', 'mac.com',
    'protonmail.com', 'proton.me', 'pm.me',
    'mail.com', 'gmx.com', 'gmx.net',
    'rediffmail.com', 'yandex.com', 'zoho.com',
    'inbox.com', 'fastmail.com', 'hushmail.com',
  ]);
  const COMMON_PASSWORDS = new Set([
    'password', 'password1', 'password123', '12345678', '123456789',
    '1234567890', 'qwerty123', 'qwertyuiop', 'letmein123', 'welcome123',
    'admin1234', 'iloveyou1', 'sunshine1', 'princess1', 'football1',
    'monkey123', 'dragon123', 'master123', 'trustno1', 'abc123456',
    'passw0rd', 'p@ssw0rd', 'changeme1', 'starwars1', 'superman1',
  ]);
  const SPECIAL_RE = /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?~`]/;
  const EMAIL_RE = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

  function classifyEmail(email) {
    if (!EMAIL_RE.test(email)) return { valid: false, kind: null, domain: null };
    const domain = email.toLowerCase().split('@')[1] || '';
    if (domain === 'gmail.com' || domain === 'googlemail.com') return { valid: true, kind: 'gmail', domain };
    if (FREEMAIL_BLOCKLIST.has(domain)) return { valid: false, kind: 'blocked-freemail', domain };
    return { valid: true, kind: 'work', domain };
  }

  function evaluatePassword(pw, username, email) {
    const checks = {
      length: pw.length >= 10,
      upper: /[A-Z]/.test(pw),
      lower: /[a-z]/.test(pw),
      digit: /[0-9]/.test(pw),
      special: SPECIAL_RE.test(pw),
      notCommon: !COMMON_PASSWORDS.has(pw.toLowerCase()),
      noRepeats: !/(.)\1{3,}/.test(pw),
      noPersonalInfo: true,
    };
    const localPart = (email.split('@')[0] || '').toLowerCase();
    const uname = username.toLowerCase();
    const lowerPw = pw.toLowerCase();
    if ((uname.length >= 3 && pw && lowerPw.includes(uname)) ||
        (localPart.length >= 3 && pw && lowerPw.includes(localPart))) {
      checks.noPersonalInfo = false;
    }
    let score = 0;
    if (checks.length) score += 1;
    if (pw.length >= 14) score += 1;
    const classes = [checks.upper, checks.lower, checks.digit, checks.special].filter(Boolean).length;
    if (classes >= 3) score += 1;
    if (classes === 4) score += 1;
    if (!checks.notCommon || !checks.noPersonalInfo || pw.length < 10) score = Math.min(score, 1);
    score = Math.max(0, Math.min(4, score));
    const valid = checks.length && checks.upper && checks.lower && checks.digit &&
      checks.special && checks.notCommon && checks.noRepeats && checks.noPersonalInfo && pw.length <= 128;
    return { score, checks, valid };
  }

  // ---- DOM wiring ----
  const usernameInput = document.getElementById('username');
  const emailInput = document.getElementById('email');
  const orgInput = document.getElementById('organisation');
  const passwordInput = document.getElementById('password');
  const confirmInput = document.getElementById('confirmPassword');
  const emailHint = document.getElementById('emailHint');
  const confirmHint = document.getElementById('confirmHint');
  const strengthMeter = document.getElementById('strengthMeter');
  const checklist = document.getElementById('checklist');
  const form = document.getElementById('registerForm');
  const alertBox = document.getElementById('formAlert');
  const submitBtn = document.getElementById('submitBtn');
  const statusPill = document.getElementById('regStatus');
  const consoleBody = document.getElementById('regConsoleBody');

  let selectedRole = null;
  document.querySelectorAll('.role-card').forEach((card) => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.role-card').forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
      card.querySelector('input').checked = true;
      selectedRole = card.dataset.role;
      renderConsole();
    });
  });

  document.querySelectorAll('.pw-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = document.getElementById(btn.dataset.target);
      const showing = target.type === 'text';
      target.type = showing ? 'password' : 'text';
      btn.textContent = showing ? 'Show' : 'Hide';
    });
  });

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Masks the email for display in the decorative JSON preview only — the real
  // input box stays plain text so you can proofread what you typed.
  function maskIdentifier(val) {
    if (!val) return '';
    const at = val.indexOf('@');
    if (at === -1) {
      return val.length <= 1 ? val : val[0] + '•'.repeat(val.length - 1);
    }
    const local = val.slice(0, at);
    const domain = val.slice(at + 1);
    const maskedLocal = local.length <= 2 ? local[0] + '•'.repeat(Math.max(local.length - 1, 1)) : local.slice(0, 2) + '•'.repeat(local.length - 2);
    return `${maskedLocal}@${domain}`;
  }

  function renderConsole() {
    const email = emailInput.value.trim();
    const info = email ? classifyEmail(email) : { valid: null, kind: null };
    const pwEval = evaluatePassword(passwordInput.value, usernameInput.value.trim(), email);
    const strengthLabels = ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'];

    let overall = 'idle';
    if (email || passwordInput.value || orgInput.value) overall = 'warn';
    if (email && info.valid && pwEval.valid && selectedRole && orgInput.value.trim()) overall = 'ok';
    if (email && info.valid === false) overall = 'fail';
    statusPill.dataset.state = overall;
    statusPill.textContent = overall === 'idle' ? 'idle' : overall === 'ok' ? 'ready' : overall === 'fail' ? 'invalid' : 'validating…';

    const checkRows = Object.entries(pwEval.checks).map(([key, ok]) => {
      const cls = ok ? 'pass' : 'pending';
      const mark = ok ? '✓' : '·';
      return `  <div class="console-check ${cls}"><span class="mark">${mark}</span><span>${key}</span></div>`;
    }).join('\n');

    consoleBody.innerHTML =
      '<span class="punct">{</span>\n' +
      `  <span class="k">"email"</span><span class="punct">:</span> <span class="s">"${email ? escapeHtml(maskIdentifier(email)) : '…'}"</span><span class="punct">,</span>\n` +
      `  <span class="k">"domain_type"</span><span class="punct">:</span> <span class="s">"${info.kind || 'unknown'}"</span><span class="punct">,</span>\n` +
      `  <span class="k">"organisation"</span><span class="punct">:</span> <span class="s">"${orgInput.value.trim() ? escapeHtml(orgInput.value.trim()) : '…'}"</span><span class="punct">,</span>\n` +
      `  <span class="k">"role"</span><span class="punct">:</span> <span class="s">"${selectedRole || '…'}"</span><span class="punct">,</span>\n` +
      `  <span class="k">"password_strength"</span><span class="punct">:</span> <span class="b">${pwEval.score}</span> <span class="punct">// ${strengthLabels[pwEval.score]}</span>\n` +
      '<span class="punct">}</span>\n' +
      checkRows;
  }

  function updateEmailHint() {
    const email = emailInput.value.trim();
    emailInput.classList.remove('valid', 'invalid');
    if (!email) { emailHint.textContent = "Use your Gmail address or your organisation's work email."; emailHint.className = 'hint'; return; }
    const info = classifyEmail(email);
    if (!info.valid && info.kind === 'blocked-freemail') {
      emailHint.textContent = `${info.domain} isn't accepted — use Gmail or your work email domain.`;
      emailHint.className = 'hint err';
      emailInput.classList.add('invalid');
    } else if (!info.valid) {
      emailHint.textContent = 'Enter a valid email address.';
      emailHint.className = 'hint err';
      emailInput.classList.add('invalid');
    } else {
      emailHint.textContent = info.kind === 'gmail' ? '✓ Gmail account' : `✓ Work email detected (${info.domain})`;
      emailHint.className = 'hint ok';
      emailInput.classList.add('valid');
    }
  }

  function updatePasswordUI() {
    const pwEval = evaluatePassword(passwordInput.value, usernameInput.value.trim(), emailInput.value.trim());
    strengthMeter.querySelectorAll('i').forEach((bar, idx) => {
      bar.className = idx <= pwEval.score - 1 || (pwEval.score === 0 && passwordInput.value) ? `on-${pwEval.score}` : '';
    });
    checklist.querySelectorAll('li').forEach((li) => {
      const key = li.dataset.check;
      li.classList.toggle('met', !!pwEval.checks[key]);
    });
    updateConfirmHint();
  }

  function updateConfirmHint() {
    if (!confirmInput.value) { confirmHint.textContent = ''; confirmHint.className = 'hint'; return; }
    if (confirmInput.value === passwordInput.value) {
      confirmHint.textContent = '✓ Passwords match';
      confirmHint.className = 'hint ok';
    } else {
      confirmHint.textContent = 'Passwords do not match';
      confirmHint.className = 'hint err';
    }
  }

  [usernameInput, emailInput, orgInput].forEach((el) => el.addEventListener('input', () => { updateEmailHint(); renderConsole(); }));
  passwordInput.addEventListener('input', () => { updatePasswordUI(); renderConsole(); });
  confirmInput.addEventListener('input', updateConfirmHint);

  renderConsole();
  updatePasswordUI();

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

    const username = usernameInput.value.trim();
    const email = emailInput.value.trim();
    const organisation = orgInput.value.trim();
    const password = passwordInput.value;
    const emailInfo = classifyEmail(email);
    const pwEval = evaluatePassword(password, username, email);

    if (username.length < 3) return showAlert('Enter a username of at least 3 characters.');
    if (!emailInfo.valid) return showAlert('Enter a valid Gmail or work email address.');
    if (!organisation) return showAlert('Enter your organisation name.');
    if (!selectedRole) return showAlert('Select a role.');
    if (!pwEval.valid) return showAlert('Your password does not meet the security requirements yet.');
    if (password !== confirmInput.value) return showAlert('Passwords do not match.');

    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating account…';
    statusPill.dataset.state = 'warn';
    statusPill.textContent = 'sending…';

    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username, email, organisation, role: selectedRole, password }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        statusPill.dataset.state = 'fail';
        statusPill.textContent = String(res.status);
        showAlert(data.error || 'Registration failed. Please check your details and try again.');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Create account';
        return;
      }

      statusPill.dataset.state = 'ok';
      statusPill.textContent = '201 Created';
      window.location.href = '/dashboard.html';
    } catch (err) {
      statusPill.dataset.state = 'fail';
      statusPill.textContent = 'network';
      showAlert('Could not reach the server. Check your connection and try again.');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Create account';
    }
  });
})();
