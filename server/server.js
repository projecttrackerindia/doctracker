require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

const { initDb } = require('./db');
const dataCrypto = require('./crypto');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const workspaceRoutes = require('./routes/workspace');
const auditRoutes = require('./routes/audit');
const piiRoutes = require('./routes/pii');
const securityRoutes = require('./routes/security');

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
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
      },
    },
  })
);
app.use(cors({ origin: true, credentials: true }));
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
function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.redirect('/login.html');
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.redirect('/login.html');
  }
}

const studioTemplate = fs.readFileSync(path.join(__dirname, 'views', 'studio.html'), 'utf8');
const auditLogTemplate = fs.readFileSync(path.join(__dirname, 'views', 'auditlog.html'), 'utf8');
const editorTemplate = fs.readFileSync(path.join(__dirname, 'views', 'editor.html'), 'utf8');

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
