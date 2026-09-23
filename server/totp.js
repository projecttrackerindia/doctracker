const crypto = require('crypto');

// RFC 6238 (TOTP) / RFC 4226 (HOTP), hand-rolled on Node's built-in crypto
// module only — no otplib/speakeasy/qrcode dependency. This deployment has
// no way to safely regenerate package-lock.json for a new npm dependency
// (no Node/npm available in the environment doing this work), and the
// algorithm itself is small and fully specified, so implementing it
// directly is safer than adding an unverified new dependency blind.
//
// Standard, authenticator-app-compatible parameters: SHA-1, 6 digits, 30s
// step — the same defaults Google Authenticator / Authy / 1Password etc.
// all assume when you type a secret in manually (no QR image is generated
// here for the same no-new-dependency reason; the otpauth:// URI below is
// what a QR code would normally just encode, and every mainstream
// authenticator app also accepts pasting/typing the raw secret).

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // RFC 4648 base32
const STEP_SECONDS = 30;
const DIGITS = 6;
const WINDOW = 1; // accept the previous/current/next 30s step, absorbing normal clock drift

function base32Encode(buf) {
  let bits = 0, value = 0, output = '';
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const bytes = [];
  for (let i = 0; i < clean.length; i++) {
    const idx = ALPHABET.indexOf(clean[i]);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// A fresh random 20-byte (160-bit) secret — the size RFC 4226 recommends
// for HMAC-SHA1 — base32-encoded for display/manual entry.
function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(secretBuf, counter) {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  counterBuf.writeUInt32BE(counter % 2 ** 32, 4);
  const digest = crypto.createHmac('sha1', secretBuf).update(counterBuf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

function currentCounter(atMs = Date.now()) {
  return Math.floor(atMs / 1000 / STEP_SECONDS);
}

// Verifies a user-supplied code against the secret, tolerating +-WINDOW
// steps of clock drift between the server and the user's phone. Returns
// true/false — never throws on a malformed code.
function verifyToken(base32Secret, token) {
  const code = String(token || '').trim().replace(/\s+/g, '');
  if (!/^\d{6}$/.test(code)) return false;
  const secretBuf = base32Decode(base32Secret);
  if (secretBuf.length === 0) return false;
  const counter = currentCounter();
  for (let errorWindow = -WINDOW; errorWindow <= WINDOW; errorWindow++) {
    if (crypto.timingSafeEqual(Buffer.from(hotp(secretBuf, counter + errorWindow)), Buffer.from(code))) {
      return true;
    }
  }
  return false;
}

// otpauth:// URI — what a QR code would normally just encode. Every
// mainstream authenticator app (Google Authenticator, Authy, 1Password,
// Microsoft Authenticator, ...) also accepts pasting this URI directly or
// typing the raw secret by hand, so this covers setup without needing to
// render an actual QR image.
function buildOtpauthUri({ secret, accountLabel, issuer = 'DocTracker' }) {
  const label = encodeURIComponent(`${issuer}:${accountLabel}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

module.exports = { generateSecret, verifyToken, buildOtpauthUri, base32Encode, base32Decode };
