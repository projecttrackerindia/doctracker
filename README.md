# API Studio — Auth Service

Login + registration for API Studio: Express/PostgreSQL backend, plain HTML/CSS/JS frontend (no framework, no single-file bundle). Split into separate files so it's a normal app to work on and deploy.

```
api-studio-auth/
├── server/
│   ├── server.js        # Express app, security middleware, boots DB
│   ├── db.js             # Postgres pool + schema
│   ├── validators.js     # Email/password/role/org validation rules
│   └── routes/auth.js    # /register /login /logout /me
├── public/
│   ├── login.html
│   ├── register.html
│   ├── dashboard.html    # placeholder post-login page
│   ├── css/auth.css
│   └── js/{theme,login,register}.js
├── package.json
├── Procfile
├── railway.json
└── .env.example
```

## What's enforced

**Email:** must be a valid address, and the domain must be either `gmail.com` or a non-freemail "work" domain (Yahoo, Outlook, Hotmail, iCloud, ProtonMail, etc. are rejected — edit `FREEMAIL_BLOCKLIST` in `server/validators.js` and `public/js/register.js` to adjust).

**Password:** 10+ characters, upper + lower + number + special character, not a common password, no 4+ repeated characters in a row, and can't contain the username or email. Enforced both client-side (instant feedback) and server-side (source of truth — never trust the client alone).

**Role:** one of `admin`, `editor`, `viewer`, chosen at registration and stored per user.

**Sessions:** bcrypt-hashed passwords (12 salt rounds), JWT stored in an httpOnly, sameSite cookie — not localStorage, so it isn't reachable from JS/XSS.

## Run it locally

```bash
cd api-studio-auth
npm install
cp .env.example .env
# edit .env: point DATABASE_URL at a Postgres instance you have, set JWT_SECRET
npm run dev
```

Visit `http://localhost:3000/login.html`.

## Push to GitHub

```bash
cd api-studio-auth
git init
git add .
git commit -m "Initial commit: API Studio auth service"
git branch -M main
git remote add origin https://github.com/<your-username>/<repo-name>.git
git push -u origin main
```

(Create the empty repo on GitHub first — github.com → New repository — then use the URL it gives you above.)

## Deploy on Railway

1. **New Project → Deploy from GitHub repo** — pick the repo you just pushed. Railway detects Node automatically via `package.json`.
2. **Add a database:** in the same project, click **+ New → Database → PostgreSQL**. Railway creates it and injects `DATABASE_URL` into your service automatically — you don't set it by hand.
3. **Set variables** on your web service (Settings → Variables):
   - `JWT_SECRET` — generate one locally with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` and paste the output.
   - `NODE_ENV` — `production`
4. **Generate a domain:** Settings → Networking → Generate Domain. Railway gives you a `*.up.railway.app` URL — that's `/login.html` etc.
5. Every push to `main` redeploys automatically. The app creates its own `users` table on first boot (`initDb()` in `server.js`), so there's no manual migration step.

## Next step (not built yet)

`dashboard.html` is a thin placeholder that just proves the session works (`GET /api/auth/me`) and lets you log out. The next piece of work is putting the real API Studio workspace behind that route so a login redirects into the actual projects/environments UI instead of the stub.
