// Generic SSRF-safe outbound HTTP sender.
//
// Mirrors, rather than shares code with, the pattern already proven in
// server/routes/liveMode.js's POST /send (Finding 4.3): validate immediately
// before sending, follow redirects MANUALLY with a fresh re-validation
// (including a DNS lookup) before each hop, and a hard timeout via
// AbortController. Deliberately a fresh, standalone module rather than a
// refactor of liveMode.js itself — that route is an already-audited,
// security-critical path, and duplicating ~30 lines of proven logic here is
// a smaller risk than modifying it for the sake of one shared helper.
//
// Used by server/webhookDelivery.js. Never throws for an SSRF-blocked or
// non-2xx response — those come back as a normal return value (`blocked` /
// `status`); it only throws on an actual network failure or timeout
// (AbortError), same as fetch() itself would, so callers can distinguish
// "the request completed" from "the request could not be made."
const { validateOutboundUrlAsync } = require('./urlSafety');

const REDIRECT_STATUSES = [301, 302, 303, 307, 308];
const MAX_REDIRECTS = 5;

async function sendValidatedRequest(url, { method = 'POST', headers = {}, body, timeoutMs = 10000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const firstCheck = await validateOutboundUrlAsync(url);
    if (!firstCheck.valid) return { blocked: true, reason: firstCheck.reason };

    let response = await fetch(url, { method, headers, body, signal: controller.signal, redirect: 'manual' });
    let currentUrl = url;
    let redirectHops = 0;
    while (REDIRECT_STATUSES.includes(response.status) && redirectHops < MAX_REDIRECTS) {
      const location = response.headers.get('location');
      if (!location) break;
      const nextUrl = new URL(location, response.url || currentUrl).toString();
      const nextCheck = await validateOutboundUrlAsync(nextUrl);
      if (!nextCheck.valid) return { blocked: true, reason: nextCheck.reason };
      redirectHops += 1;
      currentUrl = nextUrl;
      response = await fetch(nextUrl, {
        method: response.status === 303 ? 'GET' : method,
        headers,
        body: response.status === 303 ? undefined : body,
        signal: controller.signal,
        redirect: 'manual',
      });
    }
    const text = await response.text();
    return { blocked: false, status: response.status, statusText: response.statusText, body: text };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { sendValidatedRequest };
