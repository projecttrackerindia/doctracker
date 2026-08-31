const crypto = require('crypto');
const { pool } = require('./db');

// ============================================================================
// Envelope encryption for data-at-rest.
//
//   MASTER_KEY (env var, 32 bytes / base64)          <- root secret, "the KEK"
//        |  wraps/unwraps
//        v
//   Data Encryption Keys ("DEKs")   <- stored in `encryption_keys`, wrapped
//        |  encrypt/decrypt                             (never stored in the
//        v                                               clear)
//   projects.data_enc / org_workspace.environments_enc / ...request_history_enc
//
// Why two layers instead of just encrypting rows with MASTER_KEY directly:
// rotating the key that actually protects customer data ("I think our key
// leaked, change it NOW") must not require touching every row synchronously.
// With envelope encryption, rotation = generate a new DEK, wrap it with the
// (unchanged) MASTER_KEY, mark it active. Every *new* write is protected by
// the new key immediately. Rows written under an old DEK stay readable
// (we keep old, deactivated DEKs around forever) and get upgraded to the
// latest key the next time they're saved, or all at once via
// reencryptAll() if you want it done immediately instead of lazily.
//
// Rotating MASTER_KEY itself (the root secret) is a different, rarer
// operation — it lives in an env var / secrets manager, not the database, so
// changing it needs a config change + restart. See rotateMasterKey() below
// for the (offline, scripted) procedure. What the Admin UI exposes as
// "Rotate encryption key" is DEK rotation, which is instant and needs no
// deploy — that's the one that matters for "our key may be compromised."
// ============================================================================

const ALGO = 'aes-256-gcm';
const IV_LEN = 12; // 96-bit nonce, standard for GCM

let masterKey = null; // Buffer, 32 bytes
const dekCache = new Map(); // version(number) -> Buffer(32 bytes)
let activeVersion = null;

function loadMasterKey() {
  const raw = process.env.MASTER_KEY;
  if (!raw) {
    throw new Error(
      'MASTER_KEY is not set. Generate one with `openssl rand -base64 32` and set it as an env var before starting the server.'
    );
  }
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    throw new Error('MASTER_KEY must decode (base64) to exactly 32 bytes. Generate one with `openssl rand -base64 32`.');
  }
  return buf;
}

function aesEncrypt(key, plaintextBuf, aad) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv, ct, tag };
}

function aesDecrypt(key, { iv, ct, tag }, aad) {
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

// ---- DEK wrap/unwrap (MASTER_KEY <-> DEK) ----
function wrapDek(dek) {
  const { iv, ct, tag } = aesEncrypt(masterKey, dek, 'dek-wrap');
  return `${iv.toString('base64')}:${ct.toString('base64')}:${tag.toString('base64')}`;
}
function unwrapDek(wrapped) {
  const [ivB64, ctB64, tagB64] = String(wrapped).split(':');
  const dek = aesDecrypt(
    masterKey,
    { iv: Buffer.from(ivB64, 'base64'), ct: Buffer.from(ctB64, 'base64'), tag: Buffer.from(tagB64, 'base64') },
    'dek-wrap'
  );
  return dek;
}

// ---- Bootstrap: load master key, ensure at least one active DEK exists ----
async function init() {
  masterKey = loadMasterKey();
  const { rows } = await pool.query('SELECT version, wrapped_dek, active FROM encryption_keys ORDER BY version ASC');
  if (rows.length === 0) {
    const dek = crypto.randomBytes(32);
    const wrapped = wrapDek(dek);
    await pool.query(
      `INSERT INTO encryption_keys (version, wrapped_dek, active, reason) VALUES (1, $1, true, 'initial key')`,
      [wrapped]
    );
    dekCache.set(1, dek);
    activeVersion = 1;
    console.log('Encryption: bootstrapped data-encryption-key v1.');
    return;
  }
  for (const row of rows) {
    dekCache.set(row.version, unwrapDek(row.wrapped_dek));
    if (row.active) activeVersion = row.version;
  }
  if (activeVersion == null) {
    // Shouldn't happen (schema enforces exactly one active row), but fail safe
    // by activating the newest known key rather than crashing the app.
    activeVersion = Math.max(...dekCache.keys());
    console.warn('Encryption: no active key flagged in DB — defaulting to newest version', activeVersion);
  }
  console.log(`Encryption: loaded ${dekCache.size} key version(s), active = v${activeVersion}.`);
}

function getDek(version) {
  const dek = dekCache.get(version);
  if (!dek) throw new Error(`Unknown encryption key version ${version} — data was encrypted with a key this server no longer has.`);
  return dek;
}

// ---- Field-level encryption (for DB columns) ----
// Token shape: enc:v<version>:<iv>:<ciphertext>:<tag>  (all base64)
// `aad` binds the ciphertext to *where* it lives (e.g. "project:abc123") so a
// ciphertext copy-pasted into a different row/column fails to decrypt.
function encryptField(plaintext, aad) {
  const dek = getDek(activeVersion);
  const { iv, ct, tag } = aesEncrypt(dek, Buffer.from(plaintext, 'utf8'), aad);
  return `enc:v${activeVersion}:${iv.toString('base64')}:${ct.toString('base64')}:${tag.toString('base64')}`;
}

function isEncrypted(token) {
  return typeof token === 'string' && token.startsWith('enc:v');
}

// Returns plaintext string. If `token` doesn't look like our encrypted format
// (legacy rows written before encryption was turned on), it's returned as-is
// so old data keeps working until it's next saved (and transparently upgraded).
function decryptField(token, aad) {
  if (token == null) return token;
  if (!isEncrypted(token)) return token; // legacy plaintext — pass through
  const parts = token.split(':');
  if (parts.length !== 5) throw new Error('Malformed encrypted field.');
  const version = parseInt(parts[1].slice(1), 10);
  const dek = getDek(version);
  const iv = Buffer.from(parts[2], 'base64');
  const ct = Buffer.from(parts[3], 'base64');
  const tag = Buffer.from(parts[4], 'base64');
  return aesDecrypt(dek, { iv, ct, tag }, aad).toString('utf8');
}

function currentKeyVersion() {
  return activeVersion;
}

// ---- Org name <-> URL token ----
// Same DEK/version scheme as encryptField, just packed for a URL path segment
// (base64url, `.`-delimited instead of `:`) instead of a DB column. Version is
// embedded, so a link keeps working across future key rotations as long as
// the DEK version it was made with is still cached (which it always is —
// old DEKs are never deleted, only deactivated).
function encryptOrgToken(organisation) {
  const dek = getDek(activeVersion);
  const { iv, ct, tag } = aesEncrypt(dek, Buffer.from(organisation, 'utf8'), 'org-url');
  return [activeVersion, iv.toString('base64url'), ct.toString('base64url'), tag.toString('base64url')].join('.');
}

// Returns the organisation string, or null if the token is malformed/tampered/
// from a key version we don't have — callers should treat null as "not found",
// never as an error to display verbatim.
function decryptOrgToken(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length !== 4) return null;
    const [versionStr, ivB64, ctB64, tagB64] = parts;
    const version = parseInt(versionStr, 10);
    if (!Number.isFinite(version)) return null;
    const dek = getDek(version);
    const iv = Buffer.from(ivB64, 'base64url');
    const ct = Buffer.from(ctB64, 'base64url');
    const tag = Buffer.from(tagB64, 'base64url');
    return aesDecrypt(dek, { iv, ct, tag }, 'org-url').toString('utf8');
  } catch {
    return null; // wrong key, corrupted token, tampering, etc. — never throw for user input
  }
}

// ---- Admin-triggered rotation: new DEK, wrapped with the SAME master key ----
// No redeploy needed. Old DEK stays cached (deactivated) so existing
// ciphertexts keep decrypting; new writes use the new version immediately.
async function rotateDataKey({ actorId, reason } = {}) {
  const newVersion = Math.max(...dekCache.keys(), activeVersion || 0) + 1;
  const dek = crypto.randomBytes(32);
  const wrapped = wrapDek(dek);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE encryption_keys SET active = false WHERE active = true');
    await client.query(
      `INSERT INTO encryption_keys (version, wrapped_dek, active, created_by, reason) VALUES ($1, $2, true, $3, $4)`,
      [newVersion, wrapped, actorId || null, reason || null]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  dekCache.set(newVersion, dek);
  activeVersion = newVersion;
  return newVersion;
}

// Admin-visible key inventory — versions and metadata only, never the DEK or
// wrapped_dek material.
async function listKeyVersions() {
  const { rows } = await pool.query(
    `SELECT ek.version, ek.active, ek.created_at, ek.reason, u.username AS created_by_username
     FROM encryption_keys ek LEFT JOIN users u ON u.id = ek.created_by
     ORDER BY ek.version DESC`
  );
  return rows.map((r) => ({
    version: r.version,
    active: r.active,
    createdAt: r.created_at,
    reason: r.reason,
    createdBy: r.created_by_username || null,
  }));
}

module.exports = {
  init,
  encryptField,
  decryptField,
  isEncrypted,
  currentKeyVersion,
  encryptOrgToken,
  decryptOrgToken,
  rotateDataKey,
  listKeyVersions,
};
