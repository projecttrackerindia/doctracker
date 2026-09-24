require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const { initDb, pool } = require('./db');
const { runMigrations } = require('./migrations/runner');
const { startRetentionSchedule } = require('./retention');
const dataCrypto = require('./crypto');
const workspaceCache = require('./cache');
const openapiExport = require('./openapiExport');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const workspaceRoutes = require('./routes/workspace');
const auditRoutes = require('./routes/audit');
const piiRoutes = require('./routes/pii');
const securityRoutes = require('./routes/security');
const liveModeRoutes = require('./routes/liveMode');
const docAccessRoutes = require('./routes/docAccess');
const aiRoutes = require('./routes/ai');
const notificationRoutes = require('./routes/notifications');
const { verifySession, IdleTimeoutError } = require('./middleware/authGuard');

const app = express();
const PORT = process.env.PORT || 3000;
const COOKIE_NAME = 'as_session';

if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET is not set. Set it before starting the server.');
  process.exit(1);
}

// SECURITY (Finding F-02 — login rate limiter didn't block 22 consecutive
// failed attempts on production): this was `1`, meaning "trust exactly one
// proxy hop in front of the app." Live evidence (the x-hikari-trace response
// header, consistent across many separate requests) shows Railway's edge
// routes every request through TWO hops — an edge node (e.g. sin1) then an
// internal regional hop (e.g. hnd1) — not one. With trust-proxy set to 1,
// Express derives req.ip from the wrong position in X-Forwarded-For: the
// internal hop's own address, which can rotate across Railway's edge/LB
// machines, instead of the real client IP. Since express-rate-limit's
// default keyGenerator buckets by req.ip, the limiter's counter never
// accumulated against one stable key — each request looked like a
// different client.
//
// Deliberately NOT `true` here: trusting the whole X-Forwarded-For chain
// unconditionally lets a client prepend their own fake entries ahead of
// Railway's real ones, shifting what Express reads as "the client IP" and
// defeating IP-based rate limiting a different way (this is exactly what
// express-rate-limit's own validator warns about). `2` trusts precisely the
// number of real hops measured above — Railway's edge and its internal
// regional hop — so req.ip resolves to the one thing before them that a
// public HTTPS client can't forge past those two trusted hops.
app.set('trust proxy', 2);

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
    // SECURITY (Finding F-05): Helmet's default HSTS omits `preload`, so a
    // browser that has never visited this host before can still be
    // downgraded to plain HTTP by an active network attacker on that first
    // request — every later visit was already protected once the header had
    // been seen once. `preload` closes that first-visit gap (once the
    // domain is submitted to hstspreload.org, browsers enforce HTTPS before
    // ever making a first request to it).
    hsts: { maxAge: 15552000, includeSubDomains: true, preload: true },
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
// AI Studio requests carry pasted drafts / extracted upload text, which can
// run well past the default 20kb cap well before hitting the route's own
// 60,000-character sanity limit — scoped larger the same way workspace is.
app.use('/api/ai', express.json({ limit: '2mb' }));
app.use(express.json({ limit: '20kb' }));

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/workspace', workspaceRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/pii', piiRoutes);
app.use('/api/security', securityRoutes);
app.use('/api/live-mode', liveModeRoutes);
// Mounted under /api/workspace (not its own top-level prefix) purely so the
// client's existing apiGet/apiSend helpers — hard-coded to the
// '/api/workspace' base — can call it with no new fetch wrapper, and so it
// automatically gets the same 25mb JSON body limit set above rather than
// falling back to the tighter 20kb default. It's still its own router/file
// (server/routes/docAccess.js), same separation as liveModeRoutes.
app.use('/api/workspace/doc-access', docAccessRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/notifications', notificationRoutes);

// Previously just `{ ok: true }` unconditionally — a deploy platform's
// health check would keep reporting this instance as healthy even while its
// DB pool was down or exhausted, right up until an actual request failed.
// This now does one cheap round-trip (`SELECT 1`) so a real outage flips the
// status code (503) and body, not just the eventual request that hits it.
// Redis is reported as configured/not-configured rather than pinged here —
// it backs the workspace cache and rate limiting, both of which already
// degrade gracefully to "no cache" / "in-memory limiter" on their own if
// Redis is unreachable, so a failed Redis ping shouldn't flip this endpoint
// unhealthy the way a failed DB ping should.
app.get('/api/health', async (req, res) => {
  const health = {
    ok: true,
    time: new Date().toISOString(),
    db: 'ok',
    redis: workspaceCache.isEnabled() ? 'configured' : 'not configured',
  };
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    health.ok = false;
    health.db = 'unreachable';
    console.error('Health check: DB ping failed:', err.message);
  }
  res.status(health.ok ? 200 : 503).json(health);
});

// GET /public/openapi/:token.yaml — the one deliberately unauthenticated
// route in this app. Backs the "Open in Swagger Editor" project action:
// editor.swagger.io fetches this URL directly from the visitor's browser, so
// it can never carry our session cookie — the signed, 10-minute token
// (minted by POST /api/workspace/projects/:id/openapi-link, see
// routes/workspace.js) is what stands in for auth here instead. No other
// route in this app works this way; this one exists precisely because a
// meaningful chunk of the value of "open in Swagger Editor" is "don't require
// the third party to be logged in as you." The spec it serves is always the
// masked one from openapiExport.js — real environment URLs and secret
// values never appear here, no matter who minted the link or what their
// admin "reveal" state was at the time.
app.get('/public/openapi/:token', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*'); // must be fetchable cross-origin by editor.swagger.io
  try {
    const rawToken = String(req.params.token || '').replace(/\.ya?ml$/i, '');
    const payload = dataCrypto.decryptShareToken(rawToken);
    if (!payload || !payload.pid || !payload.exp) {
      return res.status(404).type('text/plain').send('This link is invalid.');
    }
    if (Date.now() > payload.exp) {
      return res.status(410).type('text/plain').send('This link has expired — generate a new one from Project actions > Open in Swagger Editor.');
    }
    const { rows } = await pool.query(
      `SELECT id, organisation, data, data_enc FROM projects WHERE id = $1`,
      [payload.pid]
    );
    if (!rows.length || rows[0].organisation !== payload.org) {
      return res.status(404).type('text/plain').send('This project could no longer be found.');
    }
    const project = workspaceRoutes.decryptProjectData(rows[0]);
    const envList = await workspaceRoutes.getOrgEnvironments(rows[0].organisation);
    const specYaml = openapiExport.buildProjectOpenApiSpecYaml(project, envList);
    res.set('Content-Type', 'text/yaml; charset=utf-8');
    res.send(specYaml);
  } catch (err) {
    console.error('GET /public/openapi failed:', err);
    res.status(500).type('text/plain').send('Could not generate this spec.');
  }
});

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
    if (err instanceof IdleTimeoutError) {
      // Not a real failure — an expected, common outcome — so this doesn't
      // go through console.error like the catch-all below.
      res.clearCookie(COOKIE_NAME, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' });
      return res.redirect('/login.html?reason=idle');
    }
    console.error('requireAuth() failed:', err);
    res.redirect('/login.html');
  }
}

const studioTemplate = fs.readFileSync(path.join(__dirname, 'views', 'studio.html'), 'utf8');
const auditLogTemplate = fs.readFileSync(path.join(__dirname, 'views', 'auditlog.html'), 'utf8');
const editorTemplate = fs.readFileSync(path.join(__dirname, 'views', 'editor.html'), 'utf8');
const architectureStudioTemplate = fs.readFileSync(path.join(__dirname, 'views', 'architecture-studio.html'), 'utf8');
const releasePipelineTemplate = fs.readFileSync(path.join(__dirname, 'views', 'release-pipeline.html'), 'utf8');

// Cache-busting for every /js/... <script> tag in the templates above (see
// __ASSET_VERSION__ in each view). None of those tags carried a version
// query string before this, so a browser could keep serving a stale cached
// copy of e.g. public/js/studio/10-metrics.js indefinitely after a deploy —
// no explicit Cache-Control header was set, so it fell to each browser's own
// caching heuristics rather than anything actually invalidating on change.
// Process boot time is enough: Railway restarts the process on every deploy,
// so this value - and therefore every script URL - changes on every deploy
// without needing a git hash or build step.
const ASSET_VERSION = String(Date.now());

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

// Organisation names are free text (2–100 chars, no character restrictions —
// see validateOrganisation in validators.js), so unlike the JSON.stringify()
// above, injecting one into raw HTML (the topbar's org-name lockup below)
// needs escaping — otherwise a company name containing e.g. "<script>" would
// execute for every user who ever loads their own workspace.
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// This is the real DocTracker workspace (documentation builder). It's rendered
// per-request (not served as a static file) so we can inject the signed-in
// user's identity and a fresh CSP nonce — that's also what keeps it gated by
// requireAuth instead of being publicly reachable like the rest of /public.
// projectSlug/endpointSlug: same "readability/bookmarking only, resolved
// client-side" pattern edit.studio already uses (see renderEditor below) —
// deep-links a project's Overview or one endpoint's doc page instead of
// always landing on the default view. Never trusted for access; the
// session cookie is what actually gates what loads.
function renderDashboard(req, res, { projectSlug = '', endpointSlug = '', initialView = '' } = {}) {
  const authUser = {
    id: req.user.sub,
    username: req.user.username,
    organisation: req.user.organisation,
    role: req.user.role,
    accessSchedule: req.user.accessSchedule || null,
    scheduleLocked: !!req.user.scheduleLocked,
    ...(req.user.role === 'custom' ? { customPermissions: req.user.customPermissions || null } : {}),
  };
  const html = studioTemplate
    .replace(/__CSP_NONCE__/g, res.locals.cspNonce)
    .replace(/__ASSET_VERSION__/g, ASSET_VERSION)
    .replace('__AUTH_USER_JSON__', JSON.stringify(authUser))
    .replace(/__ORG_TOKEN__/g, tokenForUser(req.user))
    // Topbar brand lockup shows the signed-in user's own organisation name
    // instead of the static "DocTracker" — see server/views/studio.html.
    .replace(/__ORG_NAME__/g, escapeHtml(req.user.organisation))
    .replace('__PROJECT_SLUG__', JSON.stringify(projectSlug))
    .replace('__ENDPOINT_SLUG__', JSON.stringify(endpointSlug))
    .replace('__INITIAL_VIEW__', JSON.stringify(initialView));
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

// The app's non-project pages, each with its own bookmarkable/refreshable
// URL. These used to share the bare /:orgToken/dashboard.html, so refreshing
// or sharing a link to any of them dropped you back on the Control Center.
//
// Registered BEFORE the generic :projectSlug route below so these literal
// segments win - Express matches route patterns in registration order, and
// :projectSlug matches any single segment, so it would otherwise swallow
// them all.
//
// RESERVED: because these literals shadow :projectSlug, a project whose name
// slugifies to one of them would become unreachable by URL. The client half
// (SPECIAL_VIEW_SLUGS in 11-render-main.js) mirrors this list and keeps such
// a project on the bare dashboard URL rather than minting a link that would
// route here instead.
const SPECIAL_VIEW_ROUTES = {
  'observability': 'observability',
  'security': 'security',
  'release-pipeline': 'releasepipeline',
  'errors': 'errors',
  'profile': 'profile',
};
Object.entries(SPECIAL_VIEW_ROUTES).forEach(([slug, initialView]) => {
  app.get(`/:orgToken/${slug}/dashboard.html`, requireAuth, (req, res) => {
    const org = dataCrypto.decryptOrgToken(req.params.orgToken);
    if (org !== req.user.organisation) {
      return res.redirect(`/${tokenForUser(req.user)}/${slug}/dashboard.html`);
    }
    // Permission is enforced at render time by the client's own guard (and
    // server-side by each feature's own API routes) - landing here only
    // chooses the initial view, it grants nothing.
    renderDashboard(req, res, { initialView });
  });
});

app.get('/:orgToken/:projectSlug/dashboard.html', requireAuth, (req, res) => {
  const org = dataCrypto.decryptOrgToken(req.params.orgToken);
  if (org !== req.user.organisation) {
    return res.redirect(`/${tokenForUser(req.user)}/${req.params.projectSlug}/dashboard.html`);
  }
  renderDashboard(req, res, { projectSlug: req.params.projectSlug });
});

app.get('/:orgToken/:projectSlug/:endpointSlug/dashboard.html', requireAuth, (req, res) => {
  const org = dataCrypto.decryptOrgToken(req.params.orgToken);
  if (org !== req.user.organisation) {
    return res.redirect(`/${tokenForUser(req.user)}/${req.params.projectSlug}/${req.params.endpointSlug}/dashboard.html`);
  }
  renderDashboard(req, res, { projectSlug: req.params.projectSlug, endpointSlug: req.params.endpointSlug });
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
  const html = auditLogTemplate
    .replace(/__CSP_NONCE__/g, res.locals.cspNonce)
    .replace(/__ASSET_VERSION__/g, ASSET_VERSION);
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
    accessSchedule: req.user.accessSchedule || null,
    scheduleLocked: !!req.user.scheduleLocked,
    ...(req.user.role === 'custom' ? { customPermissions: req.user.customPermissions || null } : {}),
  };
  const html = editorTemplate
    .replace(/__CSP_NONCE__/g, res.locals.cspNonce)
    .replace(/__ASSET_VERSION__/g, ASSET_VERSION)
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
    accessSchedule: req.user.accessSchedule || null,
    scheduleLocked: !!req.user.scheduleLocked,
    ...(req.user.role === 'custom' ? { customPermissions: req.user.customPermissions || null } : {}),
  };
  const html = architectureStudioTemplate
    .replace(/__CSP_NONCE__/g, res.locals.cspNonce)
    .replace(/__ASSET_VERSION__/g, ASSET_VERSION)
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

// Release Pipeline v2 (server/views/release-pipeline.html) — the full-page,
// GitHub-style promote/merge-history tool. Opens in its own tab from a
// project's Project Settings, same session-cookie auth and same
// never-decode-the-slug-server-side pattern as architecture.studio above:
// the project is re-resolved client-side against GET /api/workspace, and
// every actual read/write (versions, diff, promote, rollback, history) goes
// through the existing Admin-gated /api/workspace/projects/:id/* routes —
// this route only serves the shell.
function renderReleasePipelinePage(req, res, { projectSlug = '' } = {}) {
  const authUser = {
    id: req.user.sub,
    username: req.user.username,
    organisation: req.user.organisation,
    role: req.user.role,
    accessSchedule: req.user.accessSchedule || null,
    scheduleLocked: !!req.user.scheduleLocked,
    ...(req.user.role === 'custom' ? { customPermissions: req.user.customPermissions || null } : {}),
  };
  const html = releasePipelineTemplate
    .replace(/__CSP_NONCE__/g, res.locals.cspNonce)
    .replace(/__ASSET_VERSION__/g, ASSET_VERSION)
    .replace('__AUTH_USER_JSON__', JSON.stringify(authUser))
    .replace(/__ORG_TOKEN__/g, tokenForUser(req.user))
    .replace('__PROJECT_SLUG__', JSON.stringify(projectSlug));
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}

app.get('/:orgToken/:projectSlug/release.pipeline', requireAuth, (req, res) => {
  const org = dataCrypto.decryptOrgToken(req.params.orgToken);
  if (org !== req.user.organisation) {
    return res.redirect(`/${tokenForUser(req.user)}/${req.params.projectSlug}/release.pipeline`);
  }
  renderReleasePipelinePage(req, res, { projectSlug: req.params.projectSlug });
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
  .then(() => runMigrations(pool))
  .then(() => dataCrypto.init())
  .then(() => {
    app.listen(PORT, () => {
      console.log(`DocTracker auth service listening on port ${PORT}`);
      startRetentionSchedule();
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database, run migrations, or set up encryption keys:', err);
    process.exit(1);
  });
