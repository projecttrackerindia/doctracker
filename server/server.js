require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const { initDb } = require('./db');
const dataCrypto = require('./crypto');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const workspaceRoutes = require('./routes/workspace');
const auditRoutes = require('./routes/audit');
const piiRoutes = require('./routes/pii');
const securityRoutes = require('./routes/security');
const { verifySession } = require('./middleware/authGuard');

const app = express();
const PORT = process.env.PORT || 3000;
const COOKIE_NAME = 'as_session';

if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET is not set. Set it before starting the server.');
  process.exit(1);
}

app.set('trust proxy', 1); // Railway sits behind a proxy — needed for secure cookies + rate limiting

// The studio page (server/views/studio.html) ships one inline <script> and one
// script loaded from cdnjs. Everything else in that file is wired up with
// addEventListener, not inline handlers, so we don't need 'unsafe-inline' —
// a per-request nonce covers the inline block, and cdnjs is explicitly allowed.
app.use((req, res, next) => {
  res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
  next();
});

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        scriptSrc: ["'self'", 'https://cdnjs.cloudflare.com', (req, res) => `'nonce-${res.locals.cspNonce}'`],
        // 'blob:' is needed alongside 'data:': the custom-icon uploader reads
        // files as data: URLs, but PNG export (exportPng in
        // architecture-studio.html) renders the diagram SVG through a
        // blob: URL Image before rasterizing it to canvas. Without 'blob:'
        // here that <img>'s src is silently blocked and PNG export fails
        // with "Could not render export — try SVG instead."
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
      },
    },
  })
);
// CORS: previously `origin: true` reflected whatever Origin header a request
// sent, and combined with `credentials: true` that meant ANY website could
// make a credentialed (cookie-bearing) request to this API from a visitor's
// browser. Restrict it to an explicit allow-list instead — set
// ALLOWED_ORIGINS (comma-separated) if this API is ever called cross-origin
// (e.g. a separate marketing site, a local dev frontend on another port).
// Requests with no Origin header at all (same-origin page loads, curl,
// server-to-server) are always allowed through, same as before.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      callback(null, false);
    },
    credentials: true,
  })
);
app.use(cookieParser());

// Workspace payloads carry base64-encoded document attachments, so they need a
// much larger body limit than auth/user requests — scoped to this path only,
// mounted ahead of the tighter global limit below.
app.use('/api/workspace', express.json({ limit: '25mb' }));
app.use(express.json({ limit: '20kb' }));

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/workspace', workspaceRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/pii', piiRoutes);
app.use('/api/security', securityRoutes);

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ---- Auth guard for the studio app ----
// Same DB-backed check as the API's authenticate() middleware (see
// middleware/authGuard.js) — a page load re-validates the account/role/
// tokenVersion fresh from the database instead of trusting the JWT payload
// verbatim, so a revoked session (role change, password reset, deleted
// account) bounces to the login page immediately instead of on next expiry.
async function requireAuth(req, res, next) {
  try {
    const authUser = await verifySession(req.cookies?.[COOKIE_NAME]);
    if (!authUser) return res.redirect('/login.html');
    req.user = authUser;
    next();
  } catch (err) {
    console.error('requireAuth() failed:', err);
    res.redirect('/login.html');
  }
}

const studioTemplate = fs.readFileSync(path.join(__dirname, 'views', 'studio.html'), 'utf8');
const auditLogTemplate = fs.readFileSync(path.join(__dirname, 'views', 'auditlog.html'), 'utf8');
const editorTemplate = fs.readFileSync(path.join(__dirname, 'views', 'editor.html'), 'utf8');
const architectureStudioTemplate = fs.readFileSync(path.join(__dirname, 'views', 'architecture-studio.html'), 'utf8');

// The organisation name never appears in a URL in the clear — every tenant-
// scoped page is addressed as /<encrypted-org-token>/whatever instead of
// /whatever. The token is produced by dataCrypto.encryptOrgToken() (AES-256-GCM,
// same envelope-encryption keys used for data at rest — see server/crypto.js)
// and is meaningless without this server's keys. It is NOT itself an access
// control mechanism (the session cookie is); it exists so organisation names
// aren't sitting in browser history, referrer headers, shared screenshots, or
// access logs. Every route below re-derives the *correct* token for the
// signed-in user from their session rather than trusting the one in the URL,
// so a stale, forged, or someone-else's-org token can never grant access —
// worst case it just bounces the request back to the caller's own URL.
function tokenForUser(user) {
  return dataCrypto.encryptOrgToken(user.organisation);
}

// This is the real API Studio workspace (documentation builder). It's rendered
// per-request (not served as a static file) so we can inject the signed-in
// user's identity and a fresh CSP nonce — that's also what keeps it gated by
// requireAuth instead of being publicly reachable like the rest of /public.
function renderDashboard(req, res) {
  const authUser = {
    id: req.user.sub,
    username: req.user.username,
    organisation: req.user.organisation,
    role: req.user.role,
    ...(req.user.role === 'custom' ? { customPermissions: req.user.customPermissions || null } : {}),
  };
  const html = studioTemplate
    .replace(/__CSP_NONCE__/g, res.locals.cspNonce)
    .replace('__AUTH_USER_JSON__', JSON.stringify(authUser))
    .replace(/__ORG_TOKEN__/g, tokenForUser(req.user));
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}

app.get('/:orgToken/dashboard.html', requireAuth, (req, res) => {
  const org = dataCrypto.decryptOrgToken(req.params.orgToken);
  if (org !== req.user.organisation) {
    // Wrong, stale (pre-rotation), forged, or someone-else's-org token — never
    // error out on this, just land them on their own correct URL.
    return res.redirect(`/${tokenForUser(req.user)}/dashboard.html`);
  }
  renderDashboard(req, res);
});

// Back-compat for old bookmarks/links to the un-tokenized URL.
app.get('/dashboard.html', requireAuth, (req, res) => {
  res.redirect(`/${tokenForUser(req.user)}/dashboard.html`);
});

app.get('/:orgToken/auditlog', requireAuth, (req, res) => {
  const org = dataCrypto.decryptOrgToken(req.params.orgToken);
  if (org !== req.user.organisation) {
    return res.redirect(`/${tokenForUser(req.user)}/auditlog`);
  }
  const html = auditLogTemplate.replace(/__CSP_NONCE__/g, res.locals.cspNonce);
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// The blank-canvas endpoint editor (server/views/editor.html) — opens in its
// own tab from studio.html, authenticated by the same session cookie (cookies
// aren't tab-scoped, so no extra login step is needed). It never decodes the
// project/endpoint slugs server-side: like the rest of this app, project and
// endpoint data is an opaque encrypted blob per-organisation, so resolving a
// slug to an actual project/endpoint happens client-side against the same
// GET /api/workspace payload the main studio page already uses. The slugs in
// the URL are for readability/bookmarking only — never trusted for access;
// the session cookie is what actually gates what the editor can load or save.
function renderEditor(req, res, { projectSlug = '', endpointSlug = '' } = {}) {
  const authUser = {
    id: req.user.sub,
    username: req.user.username,
    organisation: req.user.organisation,
    role: req.user.role,
    ...(req.user.role === 'custom' ? { customPermissions: req.user.customPermissions || null } : {}),
  };
  const html = editorTemplate
    .replace(/__CSP_NONCE__/g, res.locals.cspNonce)
    .replace('__AUTH_USER_JSON__', JSON.stringify(authUser))
    .replace(/__ORG_TOKEN__/g, tokenForUser(req.user))
    .replace('__PROJECT_SLUG__', JSON.stringify(projectSlug))
    .replace('__ENDPOINT_SLUG__', JSON.stringify(endpointSlug));
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}

// The draw.io-style architecture diagram editor (server/views/architecture-studio.html)
// — opens in its own tab from a project's Overview page or Project settings,
// authenticated by the same session cookie. Like edit.studio, it never
// decodes the project slug server-side: it re-resolves it client-side
// against the same GET /api/workspace payload, and the diagram itself is
// just another field on that project's opaque encrypted blob
// (`architectureDiagram`), saved through the existing PUT /api/workspace/projects
// endpoint — no new API routes needed for it.
function renderArchitectureStudio(req, res, { projectSlug = '' } = {}) {
  const authUser = {
    id: req.user.sub,
    username: req.user.username,
    organisation: req.user.organisation,
    role: req.user.role,
    ...(req.user.role === 'custom' ? { customPermissions: req.user.customPermissions || null } : {}),
  };
  const html = architectureStudioTemplate
    .replace(/__CSP_NONCE__/g, res.locals.cspNonce)
    .replace('__AUTH_USER_JSON__', JSON.stringify(authUser))
    .replace(/__ORG_TOKEN__/g, tokenForUser(req.user))
    .replace('__PROJECT_SLUG__', JSON.stringify(projectSlug));
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}

app.get('/:orgToken/:projectSlug/architecture.studio', requireAuth, (req, res) => {
  const org = dataCrypto.decryptOrgToken(req.params.orgToken);
  if (org !== req.user.organisation) {
    return res.redirect(`/${tokenForUser(req.user)}/${req.params.projectSlug}/architecture.studio`);
  }
  renderArchitectureStudio(req, res, { projectSlug: req.params.projectSlug });
});

// Brand new endpoint, brand new project: /{orgToken}/edit.studio
app.get('/:orgToken/edit.studio', requireAuth, (req, res) => {
  const org = dataCrypto.decryptOrgToken(req.params.orgToken);
  if (org !== req.user.organisation) return res.redirect(`/${tokenForUser(req.user)}/edit.studio`);
  renderEditor(req, res, {});
});

// New endpoint inside an existing project: /{orgToken}/{projectSlug}/edit.studio
app.get('/:orgToken/:projectSlug/edit.studio', requireAuth, (req, res) => {
  const org = dataCrypto.decryptOrgToken(req.params.orgToken);
  if (org !== req.user.organisation) {
    return res.redirect(`/${tokenForUser(req.user)}/${req.params.projectSlug}/edit.studio`);
  }
  renderEditor(req, res, { projectSlug: req.params.projectSlug });
});

// Editing an existing endpoint: /{orgToken}/{projectSlug}/{endpointSlug}/edit.studio
app.get('/:orgToken/:projectSlug/:endpointSlug/edit.studio', requireAuth, (req, res) => {
  const org = dataCrypto.decryptOrgToken(req.params.orgToken);
  if (org !== req.user.organisation) {
    return res.redirect(`/${tokenForUser(req.user)}/${req.params.projectSlug}/${req.params.endpointSlug}/edit.studio`);
  }
  renderEditor(req, res, { projectSlug: req.params.projectSlug, endpointSlug: req.params.endpointSlug });
});

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/', (req, res) => res.redirect('/login.html'));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

initDb()
  .then(() => dataCrypto.init())
  .then(() => {
    app.listen(PORT, () => console.log(`API Studio auth service listening on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to initialize database or encryption keys:', err);
    process.exit(1);
  });
