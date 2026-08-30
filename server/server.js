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
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');

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
app.use(express.json({ limit: '20kb' }));
app.use(cookieParser());

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);

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

// This is the real API Studio workspace (documentation builder). It's rendered
// per-request (not served as a static file) so we can inject the signed-in
// user's identity and a fresh CSP nonce — that's also what keeps it gated by
// requireAuth instead of being publicly reachable like the rest of /public.
app.get('/dashboard.html', requireAuth, (req, res) => {
  const authUser = {
    id: req.user.sub,
    username: req.user.username,
    organisation: req.user.organisation,
    role: req.user.role,
    ...(req.user.role === 'custom' ? { customPermissions: req.user.customPermissions || null } : {}),
  };
  const html = studioTemplate
    .replace(/__CSP_NONCE__/g, res.locals.cspNonce)
    .replace('__AUTH_USER_JSON__', JSON.stringify(authUser));
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/', (req, res) => res.redirect('/login.html'));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`API Studio auth service listening on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
