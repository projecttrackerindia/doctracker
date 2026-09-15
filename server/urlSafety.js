// server/urlSafety.js
//
// SECURITY FIX (Finding 4.3 — SSRF via Live Mode base URLs): a project's
// per-environment base URL is a plain string field inside the project's JSON
// blob, settable by anyone with edit rights on that project (including their
// own private project). Nothing previously validated what it could contain —
// no scheme restriction, no private-IP/localhost/link-local/metadata
// blocklist — and Live Mode's outbound fetch() followed redirects, so a
// user with an Admin-granted Live Mode permission for an environment id
// (a shared, org-wide label) could fire the server's outbound request at
// whatever URL *any* project's entry for that environment id happened to
// contain, including one they set up themselves.
//
// This module is used in two places:
//   1. server/routes/workspace.js (PUT /projects) — validated at the point a
//      project's environment URLs are SAVED, so an obviously-dangerous URL
//      (localhost, an RFC1918 address, the cloud metadata address, a
//      non-http(s) scheme) can never be stored in the first place.
//   2. server/routes/liveMode.js (POST /send) — re-validated, including a
//      fresh DNS lookup, immediately before the outbound fetch() fires. This
//      narrows (but, being a check-then-connect, does not perfectly
//      eliminate) the DNS-rebinding window where a hostname that resolved to
//      a public IP at save time could later be repointed at a private one.
//      Full protection would require pinning the connection to the exact
//      resolved IP (a custom fetch dispatcher/agent) rather than re-lookup —
//      noted here as a residual gap rather than silently assumed away.
const dns = require('dns').promises;
const net = require('net');

// IPv4 CIDR ranges that should never be a legitimate Live Mode / environment
// target from this server: loopback, RFC1918 private space, link-local
// (includes the 169.254.169.254 cloud metadata address), CGNAT, "this
// network", and multicast/reserved.
const BLOCKED_IPV4_RANGES = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function isBlockedIPv4(ip) {
  const ipInt = ipv4ToInt(ip);
  return BLOCKED_IPV4_RANGES.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (ipInt & mask) === (ipv4ToInt(base) & mask);
  });
}

// IPv6: loopback (::1), unspecified (::), unique-local (fc00::/7),
// link-local (fe80::/10, also where the metadata address is reachable via
// IPv6 on some clouds), and IPv4-mapped addresses (::ffff:a.b.c.d) — those
// are unwrapped and checked against the IPv4 list above.
function isBlockedIPv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIPv4(mapped[1]);
  const firstGroup = lower.split(':')[0];
  const first16 = parseInt(firstGroup || '0', 16);
  if ((first16 & 0xfe00) === 0xfc00) return true; // fc00::/7 (ULA)
  if ((first16 & 0xffc0) === 0xfe80) return true; // fe80::/10 (link-local)
  return false;
}

function isBlockedIp(ip) {
  if (net.isIPv4(ip)) return isBlockedIPv4(ip);
  if (net.isIPv6(ip)) return isBlockedIPv6(ip);
  return true; // not a recognizable IP at all — fail closed
}

// Synchronous, save-time check: rejects a bad scheme, a missing host, or a
// hostname that's already a literal blocked IP/loopback name. Doesn't
// resolve DNS (callers doing that get an async, more thorough check via
// validateOutboundUrlAsync below) — this is the cheap gate every save goes
// through regardless of whether the URL is ever actually called.
function validateOutboundUrlSync(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch (e) {
    return { valid: false, reason: 'Not a valid URL.' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { valid: false, reason: 'Only http:// and https:// URLs are allowed.' };
  }
  const hostname = u.hostname.toLowerCase();
  if (!hostname) return { valid: false, reason: 'URL has no host.' };
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return { valid: false, reason: 'localhost addresses are not allowed.' };
  }
  // Node's URL.hostname keeps the [brackets] for IPv6 literals — strip them
  // before handing to net.isIP/isBlockedIp, which expect the bare address.
  const bareHost = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (net.isIP(bareHost) && isBlockedIp(bareHost)) {
    return { valid: false, reason: 'Private, loopback, link-local, and cloud-metadata addresses are not allowed.' };
  }
  return { valid: true, url: u };
}

// Full check, including a DNS lookup of every address the hostname resolves
// to (a hostname can resolve to multiple A/AAAA records; ANY of them being
// internal is enough to reject it — an attacker only needs one to succeed).
// Use this immediately before actually making the outbound request.
async function validateOutboundUrlAsync(rawUrl) {
  const syncResult = validateOutboundUrlSync(rawUrl);
  if (!syncResult.valid) return syncResult;
  const { url } = syncResult;
  const hostname = url.hostname;
  const bareHost = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;

  if (net.isIP(bareHost)) return { valid: true, url }; // already checked above

  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (e) {
    return { valid: false, reason: 'Could not resolve host.' };
  }
  if (!addresses.length) return { valid: false, reason: 'Could not resolve host.' };
  if (addresses.some((a) => isBlockedIp(a.address))) {
    return { valid: false, reason: 'This host resolves to a private, loopback, link-local, or cloud-metadata address.' };
  }
  return { valid: true, url };
}

module.exports = { validateOutboundUrlSync, validateOutboundUrlAsync };
