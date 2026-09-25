// Alert webhook delivery. The one place ALERTING.md's "no email/webhook
// channel" limitation hooks in — see emitNotification() in alertEngine.js,
// which calls deliverAlertWebhook() as a sibling to its existing
// notifyUsers() call once an org has a webhook configured.
//
// Every delivery: SSRF-validated (server/outboundHttp.js, itself built on
// server/urlSafety.js) immediately before sending, HMAC-SHA256 signed with
// the org's own secret (same shape as Stripe/GitHub webhook signing) so a
// receiver can verify the payload actually came from this server, and
// audited (server/auditService.js's recordSystemAuditEvent — this runs from
// the sweep timer or the ingest path, never inside an Express request, so
// there's no req to attribute a normal audit event to).
const crypto = require('crypto');
const { sendValidatedRequest } = require('./outboundHttp');
const { recordSystemAuditEvent } = require('./auditService');
const dataCrypto = require('./crypto');

function signPayload(secret, rawBody) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

// `webhookConfig` is org_workspace.alert_settings.webhook — { url, secretEnc,
// secretKeyVersion, enabled }. `alertPayload` is a plain object built from
// the same fields currentAlerts() already exposes (see alertEngine.js).
async function deliverAlertWebhook(organisation, webhookConfig, alertPayload) {
  if (!webhookConfig || !webhookConfig.enabled || !webhookConfig.url) return { skipped: 'not configured' };

  const rawBody = JSON.stringify(alertPayload);
  let secret = '';
  if (webhookConfig.secretEnc) {
    try {
      secret = dataCrypto.decryptField(webhookConfig.secretEnc, `org:${organisation}:alert-webhook`);
    } catch (err) {
      // A secret that fails to decrypt (wrong org, tampered, key rotated out)
      // should not silently drop the delivery — it should send unsigned
      // rather than never fire, since a receiver's HMAC check failing is a
      // more visible, debuggable failure mode than a webhook that just never
      // arrives. Logged, not thrown.
      console.error('Alert webhook: could not decrypt secret, sending unsigned:', err.message);
    }
  }

  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'DocTracker-AlertWebhook/1.0' };
  if (secret) headers['X-DocTracker-Signature'] = `sha256=${signPayload(secret, rawBody)}`;

  try {
    const result = await sendValidatedRequest(webhookConfig.url, {
      method: 'POST',
      headers,
      body: rawBody,
      timeoutMs: 10000,
    });
    if (result.blocked) {
      await auditQuiet(organisation, {
        action: 'ALERT_WEBHOOK_BLOCKED',
        result: 'failure',
        severity: 'critical',
        details: `Blocked an alert webhook delivery: ${result.reason}`,
      });
      return result;
    }
    const ok = result.status >= 200 && result.status < 300;
    await auditQuiet(organisation, {
      action: ok ? 'ALERT_WEBHOOK_DELIVERED' : 'ALERT_WEBHOOK_FAILED',
      result: ok ? 'success' : 'failure',
      severity: ok ? 'info' : 'warning',
      details: `Alert webhook responded ${result.status} ${result.statusText || ''}`.trim(),
    });
    return result;
  } catch (err) {
    const isAbort = err && err.name === 'AbortError';
    await auditQuiet(organisation, {
      action: 'ALERT_WEBHOOK_FAILED',
      result: 'failure',
      severity: 'warning',
      details: isAbort ? 'Alert webhook timed out after 10s.' : `Alert webhook failed: ${err.message}`,
    });
    return { failed: true, error: err.message };
  }
}

// This function is itself called fire-and-forget from emitNotification(), so
// an audit-write failure here must never throw back into the alert
// evaluation loop.
async function auditQuiet(organisation, fields) {
  try {
    await recordSystemAuditEvent(organisation, { resourceType: 'alert_webhook', ...fields });
  } catch (err) {
    console.error('Alert webhook: failed to record audit event:', err.message);
  }
}

module.exports = { deliverAlertWebhook };
