const express = require('express');
const { createRateLimiter } = require('../rateLimitStore');
const { authenticate, requireAdmin } = require('../middleware/authGuard');
const { recordAuditEvent } = require('../auditService');
const dataCrypto = require('../crypto');
const { reencryptOrganisation } = require('./workspace');

const router = express.Router();
router.use(authenticate);
router.use(requireAdmin); // everything under /api/security is Admin-only

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
router.post('/encryption/rotate', rotateLimiter, async (req, res) => {
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
