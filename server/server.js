require('dotenv').config();
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const { initDb } = require('./db');
const authRoutes = require('./routes/auth');

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET is not set. Set it before starting the server.');
  process.exit(1);
}

app.set('trust proxy', 1); // Railway sits behind a proxy — needed for secure cookies + rate limiting

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
    },
  },
}));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '20kb' }));
app.use(cookieParser());

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/auth', authRoutes);

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

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
