const crypto = require('crypto');

// Consumer webmail domains we don't treat as a "work" email.
// Gmail is explicitly allowed as a personal-email exception (per product requirement);
// every other freemail domain below is rejected so registration effectively requires
// a Gmail address OR a real organisation/work domain.
const FREEMAIL_BLOCKLIST = new Set([
  'yahoo.com', 'yahoo.co.in', 'yahoo.co.uk',
  'hotmail.com', 'outlook.com', 'live.com', 'msn.com',
  'aol.com', 'icloud.com', 'me.com', 'mac.com',
  'protonmail.com', 'proton.me', 'pm.me',
  'mail.com', 'gmx.com', 'gmx.net',
  'rediffmail.com', 'yandex.com', 'zoho.com',
  'inbox.com', 'fastmail.com', 'hushmail.com',
]);

const EMAIL_RE = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

// A short, well-known list of the most commonly breached passwords.
// Checked case-insensitively against the raw password.
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '12345678', '123456789',
  '1234567890', 'qwerty123', 'qwertyuiop', 'letmein123', 'welcome123',
  'admin1234', 'iloveyou1', 'sunshine1', 'princess1', 'football1',
  'monkey123', 'dragon123', 'master123', 'trustno1', 'abc123456',
  'passw0rd', 'p@ssw0rd', 'changeme1', 'starwars1', 'superman1',
]);

const SPECIAL_CHARS_RE = /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?~`]/;

function isValidEmailFormat(email) {
  return typeof email === 'string' && email.length <= 254 && EMAIL_RE.test(email.trim());
}

function classifyEmailDomain(email) {
  const domain = email.trim().toLowerCase().split('@')[1] || '';
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    return { kind: 'gmail', domain };
  }
  if (FREEMAIL_BLOCKLIST.has(domain)) {
    return { kind: 'blocked-freemail', domain };
  }
  return { kind: 'work', domain };
}

function validateEmail(email) {
  if (!isValidEmailFormat(email)) {
    return { valid: false, reason: 'Enter a valid email address.' };
  }
  const { kind, domain } = classifyEmailDomain(email);
  if (kind === 'blocked-freemail') {
    return {
      valid: false,
      reason: `${domain} isn't accepted — sign up with a Gmail address or your work email domain.`,
    };
  }
  return { valid: true, kind, domain };
}

function validateUsername(username) {
  if (typeof username !== 'string') return { valid: false, reason: 'Username is required.' };
  const value = username.trim();
  if (value.length < 3 || value.length > 30) {
    return { valid: false, reason: 'Username must be 3–30 characters.' };
  }
  if (!/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(value)) {
    return { valid: false, reason: 'Username must start with a letter and use only letters, numbers, ., _ or -.' };
  }
  return { valid: true, value };
}

function validateOrganisation(name) {
  if (typeof name !== 'string') return { valid: false, reason: 'Organisation name is required.' };
  const value = name.trim();
  if (value.length < 2 || value.length > 100) {
    return { valid: false, reason: 'Organisation name must be 2–100 characters.' };
  }
  return { valid: true, value };
}

const VALID_ROLES = new Set(['admin', 'editor', 'viewer']);
function validateRole(role) {
  if (!VALID_ROLES.has(role)) {
    return { valid: false, reason: 'Select a valid role.' };
  }
  return { valid: true, value: role };
}

// Generates a random password that always satisfies evaluatePassword()'s
// requirements, for admin-provisioned accounts (invite / reset). Avoids
// visually ambiguous characters (0/O, 1/l/I) since these get read aloud or
// copy-pasted by a human.
function generateTemporaryPassword() {
  const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const LOWER = 'abcdefghijkmnopqrstuvwxyz';
  const DIGITS = '23456789';
  const SPECIAL = '!@#$%^&*';
  const ALL = UPPER + LOWER + DIGITS + SPECIAL;
  const pick = (set) => set[crypto.randomInt(set.length)];

  const chars = [pick(UPPER), pick(LOWER), pick(DIGITS), pick(SPECIAL)];
  for (let i = 0; i < 8; i++) chars.push(pick(ALL));

  // Fisher–Yates shuffle so the guaranteed classes aren't always in the same
  // positions.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

// Returns { score: 0-4, label, checks: {...}, valid, reasons: [] }
function evaluatePassword(password, { username = '', email = '' } = {}) {
  const reasons = [];
  const pw = typeof password === 'string' ? password : '';

  const checks = {
    length: pw.length >= 10,
    upper: /[A-Z]/.test(pw),
    lower: /[a-z]/.test(pw),
    digit: /[0-9]/.test(pw),
    special: SPECIAL_CHARS_RE.test(pw),
    notCommon: !COMMON_PASSWORDS.has(pw.toLowerCase()),
    noRepeats: !/(.)\1{3,}/.test(pw), // blocks e.g. "aaaa" or "1111"
    noPersonalInfo: true,
  };

  const localPart = (email.split('@')[0] || '').toLowerCase();
  const uname = username.toLowerCase();
  const lowerPw = pw.toLowerCase();
  if ((uname.length >= 3 && lowerPw.includes(uname)) ||
      (localPart.length >= 3 && lowerPw.includes(localPart))) {
    checks.noPersonalInfo = false;
  }

  if (pw.length > 128) reasons.push('Password must be under 128 characters.');
  if (!checks.length) reasons.push('At least 10 characters.');
  if (!checks.upper) reasons.push('At least one uppercase letter.');
  if (!checks.lower) reasons.push('At least one lowercase letter.');
  if (!checks.digit) reasons.push('At least one number.');
  if (!checks.special) reasons.push('At least one special character.');
  if (!checks.notCommon) reasons.push('This password is too common.');
  if (!checks.noRepeats) reasons.push("Don't repeat the same character 4+ times in a row.");
  if (!checks.noPersonalInfo) reasons.push("Password can't contain your username or email.");

  // Scoring: start from character-class variety + length, then penalize.
  let score = 0;
  if (checks.length) score += 1;
  if (pw.length >= 14) score += 1;
  const classes = [checks.upper, checks.lower, checks.digit, checks.special].filter(Boolean).length;
  if (classes >= 3) score += 1;
  if (classes === 4) score += 1;
  if (!checks.notCommon || !checks.noPersonalInfo || pw.length < 10) score = Math.min(score, 1);
  score = Math.max(0, Math.min(4, score));

  const labels = ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'];
  const requiredOk = checks.length && checks.upper && checks.lower && checks.digit &&
    checks.special && checks.notCommon && checks.noRepeats && checks.noPersonalInfo &&
    pw.length <= 128;

  return {
    score,
    label: labels[score],
    checks,
    reasons,
    valid: requiredOk,
  };
}

module.exports = {
  validateEmail,
  validateUsername,
  validateOrganisation,
  validateRole,
  evaluatePassword,
  generateTemporaryPassword,
  VALID_ROLES,
};
