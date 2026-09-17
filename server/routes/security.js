const express = require('express');
const { createRateLimiter } = require('../rateLimitStore');
const { authenticate, requireAdmin } = require('../middleware/authGuard');
const { recordAuditEvent } = require('../auditService');
const dataCrypto = require('../crypto');
const { reencryptOrganisation } = require('./workspace');

const router = express.Router();
router.use(authenticate);
router.use(requireAdmin); // everything under /api/security is Admin-only

// SECURITY (Finding 4.4 — encryption key rotation is a global action gated
// by a per-tenant role): `encryption_keys` is a single, application-wide
// singleton (see server/db.js) — rotating it flips which key EVERY
// organisation's future writes are encrypted under, immediately, org-wide.
// But `requireAdmin` above only checks the caller's role within their OWN
// organisation, so any organisation's Admin could unilaterally trigger a
// platform-wide re-key event, with an audit trail visible only inside their
// own org's audit log — other tenants got no signal their key had changed.
//
// Rescoping `encryption_keys` to be per-organisation (matching the tenancy
// model everywhere else) is the more complete fix but is a real schema
// migration — new column, backfill, and updating every place crypto.js
// selects "the" active key — and isn't something to do speculatively
// without a live database to migrate and test against. The contained fix
// applied here instead: gate the mutating rotate action behind a genuine
// platform-operator allowlist, distinct from any tenant's 'admin' role, so
// an ordinary tenant Admin can no longer single-handedly force a global
// re-key. Configure via the PLATFORM_OPERATORS env var (comma-separated
// usernames, case-insensitive) — same style as ALLOWED_ORIGINS in
// server/server.js. GET /encryption (read-only key version metadata, no key
// material) is left open to any tenant Admin, same as before — the gap this
// closes is specifically the ability to MUTATE shared, cross-tenant state.
const PLATFORM_OPERATORS = new Set(
  (process.env.PLATFORM_OPERATORS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);
function requirePlatformOperator(req, res, next) {
  if (PLATFORM_OPERATORS.size === 0) {
    // Fail closed rather than silently falling back to "any tenant Admin" —
    // an unconfigured deployment should have to opt in to who may trigger a
    // platform-wide re-key, not default to the pre-fix, unrestricted behavior.
    return res.status(403).json({
      error: 'Encryption key rotation requires a configured platform operator. Set PLATFORM_OPERATORS (comma-separated usernames) in the environment.',
    });
  }
  if (!PLATFORM_OPERATORS.has(String(req.authUser.username || '').toLowerCase())) {
    return res.status(403).json({ error: 'Encryption key rotation is restricted to platform operators.' });
  }
  next();
}

// Rotation is rare and deliberate — this just guards against mis-clicks/abuse,
// not against a legitimate "we think it's compromised, rotate now" moment.
const rotateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many rotation attempts — please wait a moment.' },
});

// GET /api/security/encryption — key version history (metadata only; never
// the key material itself, wrapped or otherwise).
router.get('/encryption', async (req, res) => {
  try {
    const keys = await dataCrypto.listKeyVersions();
    res.json({ keys, activeVersion: dataCrypto.currentKeyVersion() });
  } catch (err) {
    console.error('GET /api/security/encryption failed:', err);
    res.status(500).json({ error: 'Could not load encryption key status.' });
  }
});

// POST /api/security/encryption/rotate — generate + activate a new data key
// immediately (no redeploy: MASTER_KEY is unchanged, only the DEK it wraps is
// new). Existing encrypted rows remain readable via their recorded key
// version. Pass { reencryptNow: true } to also walk this organisation's rows
// and re-encrypt them under the new key right away instead of lazily on next
// save — useful when you want a suspected-compromised key fully retired from
// active use, not just stopped from being used for new writes.
router.post('/encryption/rotate', rotateLimiter, requirePlatformOperator, async (req, res) => {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 300) : null;
  const reencryptNow = req.body?.reencryptNow === true;
  try {
    const newVersion = await dataCrypto.rotateDataKey({ actorId: req.authUser.sub, reason });
    await recordAuditEvent(req.authUser, req, {
      action: 'ENCRYPTION_KEY_ROTATED',
      resourceType: 'encryption_key',
      resourceId: String(newVersion),
      details: reason ? `Rotated data encryption key. Reason: ${reason}` : 'Rotated data encryption key.',
      severity: 'critical',
      metadata: { newVersion },
    });

    // Re-encryption of a whole organisation's projects can take a while for a
    // large org — previously this was awaited here, inside the request, which
    // held the HTTP connection open for the full duration and risked hitting
    // a proxy/client timeout. It's now fired in the background: the response
    // goes back immediately with reencrypting:true, and a follow-up audit
    // entry records completion (or failure) once the walk actually finishes.
    if (reencryptNow) {
      reencryptOrganisation(req.authUser.organisation)
        .then((result) =>
          recordAuditEvent(req.authUser, req, {
            action: 'ENCRYPTION_REENCRYPT_RUN',
            resourceType: 'encryption_key',
            resourceId: String(newVersion),
            details: `Re-encrypted ${result.projects} project(s) and org workspace data under key v${newVersion}.`,
            severity: 'warning',
            metadata: result,
          })
        )
        .catch((err) => {
          console.error(`Background re-encryption for ${req.authUser.organisation} failed:`, err);
          return recordAuditEvent(req.authUser, req, {
            action: 'ENCRYPTION_REENCRYPT_RUN',
            resourceType: 'encryption_key',
            resourceId: String(newVersion),
            details: `Re-encryption under key v${newVersion} failed and did not complete: ${err.message}`,
            severity: 'critical',
            result: 'failure',
          });
        });
    }

    res.json({ ok: true, activeVersion: newVersion, reencrypting: reencryptNow });
  } catch (err) {
    console.error('POST /api/security/encryption/rotate failed:', err);
    res.status(500).json({ error: 'Could not rotate encryption key.' });
  }
});

module.exports = router;
