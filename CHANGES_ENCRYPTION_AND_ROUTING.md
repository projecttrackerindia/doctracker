# What changed, and what you need to do to deploy it

## 1. One new required setting: `MASTER_KEY`

Generate it once, on your machine:

```
openssl rand -base64 32
```

Set the result as an env var (Railway → your service → Variables, or `.env` locally):

```
MASTER_KEY=<the output above>
```

The server won't boot without it (fails fast with a clear error, same as your
existing `JWT_SECRET` check) — see `server/crypto.js`.

**Keep this value safe and back it up outside the app** (a password manager or
your infra secrets store). It's the root key that protects every Data
Encryption Key (DEK) in the `encryption_keys` table. Losing it means losing
access to all encrypted data. Rotating *it* (as opposed to the DEK — see
below) means re-wrapping every row in `encryption_keys` with the new value and
is a scripted, offline operation, not a button in the app — that's normal for
a KEK/root-secret and is not what "rotate now" in the Security Center does.

## 2. What gets encrypted, and what doesn't

| Data | Encrypted? | Why |
|---|---|---|
| Endpoint definitions, sample params/headers/bodies, attachments (`projects.data`) | ✅ | The actual sensitive content in the app |
| Environments (hosts, tokens) and captured request/response history | ✅ | Can contain real secrets |
| `organisation`, `username`, `email` | ❌ (plaintext) | The app has to query/index/login on these directly in SQL — encrypting them would need a whole separate "blind index" scheme, which is a bigger, riskier change than what was asked for here |
| Passwords | Already hashed (bcrypt) | Unrelated to this change, already correct |

Schema migration is automatic — `initDb()` adds the new columns/tables with
`IF NOT EXISTS` on boot, nothing to run by hand. Existing rows keep working:
old plaintext JSONB is read as a fallback until a row is next saved (or you
use the "re-encrypt now" option below), at which point it's written encrypted.

## 3. Admin → Security Center → **Encryption Keys** tab

- Shows the active key version and full version history (never the key
  material itself).
- **Rotate key now**: generates a brand-new key and activates it immediately —
  no redeploy, no downtime. Every new save is protected by it right away.
- Optional checkbox: **re-encrypt this organisation's existing data now**,
  instead of waiting for it to be upgraded the next time each row is saved.
- Every rotation is written to the audit log as a `critical`-severity event.

This is the "if the key's compromised, change it right now" control you
asked for. It rotates the DEK (see the table above) — the thing that
protects your data day to day — not `MASTER_KEY` itself.

## 4. URLs no longer contain the organisation name

- After login/registration: `/{encryptedToken}/dashboard.html` instead of
  `/dashboard.html`.
- Audit log: `/{encryptedToken}/auditlog` — a real, bookmarkable page. It used
  to open as an `about:blank` popup (built with `document.write`); that's
  gone. Same styling/filters/search, now server-routed.
- The token is AES-256-GCM ciphertext of the organisation name, produced by
  the same key infrastructure above (`encryptOrgToken`/`decryptOrgToken` in
  `server/crypto.js`) — meaningless without this server's keys.
- **It is not itself an access-control check** — your session cookie is what
  actually gates access. Every tokenized route re-derives the *correct*
  token from the signed-in user's session and compares it to the one in the
  URL; a forged, stale (pre-rotation), or someone-else's-org token just
  bounces you to your own correct URL rather than ever granting access to
  the wrong tenant.
- Old bare `/dashboard.html` links still work — they redirect to the
  tokenized URL.

## 5. Sidebar

Collapsed state is now a 64px icon rail (search, home, "new endpoint" as
centered icon buttons with tooltips) instead of a near-invisible 14px sliver
with everything just faded out. Clicking any of those icons while collapsed
re-expands the sidebar. The edge-toggle handle is a small floating
chevron-in-a-circle now instead of a rectangle glued to the border.
