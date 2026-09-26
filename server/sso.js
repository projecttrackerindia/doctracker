// Per-org SSO/OIDC configuration and the OIDC client helper — additive to
// password login, never a replacement for it. An org with SSO disabled (the
// default) behaves exactly as it always has; enabling it just adds a second
// door in, gated on a verified email from a real IdP.
//
// Storage mirrors alertEngine.js's webhook settings exactly: one JSONB
// column (org_workspace.sso_config) rather than a dedicated table, since
// this is the same shape as every other per-org config in that table — a
// handful of settings plus one secret, encrypted the same way MFA secrets
// and the alert webhook secret already are (dataCrypto.encryptField, never
// re-exposed once saved).
const { pool } = require('./db');
const dataCrypto = require('./crypto');
const { validateOutboundUrlSync } = require('./urlSafety');

const DEFAULT_CONFIG = {
  enabled: false,
  issuer: '',
  clientId: '',
  clientSecretEnc: null,
  clientSecretKeyVersion: null,
  // Empty means "any verified email in the token is accepted" — an org with
  // one email domain will almost always want this set, but it's optional
  // since not every IdP/org maps cleanly to a single domain (e.g. an IdP
  // federating several acquired companies' domains).
  allowedEmailDomain: '',
};

async function getSsoConfig(organisation) {
  const { rows } = await pool.query(
    'SELECT sso_config FROM org_workspace WHERE organisation = $1', [organisation]
  );
  const raw = (rows[0] && rows[0].sso_config) || {};
  return { ...DEFAULT_CONFIG, ...raw };
}

// Never the encrypted secret — only whether one is set, same convention
// alertEngine.js's toClientSettings() uses for the webhook secret.
function toClientSsoConfig(config) {
  const { clientSecretEnc, clientSecretKeyVersion, ...rest } = config;
  return { ...rest, hasClientSecret: !!clientSecretEnc };
}

// `patch.clientSecret`: a non-empty string replaces the stored secret
// (encrypted here, never persisted plaintext); an empty string clears it;
// omitted keeps whatever secret is already stored — same convention as
// alertEngine.js's buildWebhookPatch, so re-saving the issuer/client id or
// toggling `enabled` doesn't force re-entering the secret every time.
async function saveSsoConfig(organisation, patch) {
  const current = await getSsoConfig(organisation);
  const issuer = typeof patch.issuer === 'string' ? patch.issuer.trim().slice(0, 2048) : current.issuer;
  const clientId = typeof patch.clientId === 'string' ? patch.clientId.trim().slice(0, 512) : current.clientId;
  const allowedEmailDomain = typeof patch.allowedEmailDomain === 'string'
    ? patch.allowedEmailDomain.trim().toLowerCase().slice(0, 255)
    : current.allowedEmailDomain;

  let clientSecretEnc = current.clientSecretEnc;
  let clientSecretKeyVersion = current.clientSecretKeyVersion;
  if (typeof patch.clientSecret === 'string') {
    if (patch.clientSecret === '') {
      clientSecretEnc = null;
      clientSecretKeyVersion = null;
    } else {
      clientSecretEnc = dataCrypto.encryptField(patch.clientSecret, `org:${organisation}:sso-client-secret`);
      clientSecretKeyVersion = dataCrypto.currentKeyVersion();
    }
  }

  const enabled = patch.enabled !== undefined ? !!patch.enabled : current.enabled;

  if (enabled) {
    if (!issuer || !clientId || !clientSecretEnc) {
      const e = new Error('Enabling SSO requires an issuer URL, a client id, and a client secret.');
      e.status = 400;
      throw e;
    }
    const check = validateOutboundUrlSync(issuer);
    if (!check.valid) {
      const e = new Error(`Issuer URL: ${check.reason}`);
      e.status = 400;
      throw e;
    }
  }

  const next = { enabled, issuer, clientId, clientSecretEnc, clientSecretKeyVersion, allowedEmailDomain };
  await pool.query(
    `INSERT INTO org_workspace (organisation, sso_config) VALUES ($1, $2)
     ON CONFLICT (organisation) DO UPDATE SET sso_config = $2, updated_at = now()`,
    [organisation, JSON.stringify(next)]
  );
  return next;
}

// Discovers the IdP's metadata and builds a client for it. Re-discovers on
// every call rather than caching the Issuer — SSO login is a rare-per-session
// operation (once per browser session, not once per request), so the extra
// round trip costs nothing worth optimizing away, and it means a changed
// issuer/client id takes effect immediately with no cache to invalidate.
async function buildOidcClient(organisation, config, redirectUri) {
  const { Issuer } = require('openid-client');
  const clientSecret = config.clientSecretEnc
    ? dataCrypto.decryptField(config.clientSecretEnc, `org:${organisation}:sso-client-secret`)
    : null;
  const issuer = await Issuer.discover(config.issuer);
  return new issuer.Client({
    client_id: config.clientId,
    client_secret: clientSecret,
    redirect_uris: [redirectUri],
    response_types: ['code'],
  });
}

module.exports = { getSsoConfig, saveSsoConfig, toClientSsoConfig, buildOidcClient, DEFAULT_CONFIG };
