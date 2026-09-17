# Contributing / local tooling

## Before pushing

```
npm ci
npm run lint          # must be clean (errors fail CI)
npm test              # must pass (fails CI)
npm run format:check  # currently informational only — see note below
```

CI (`.github/workflows/ci.yml`) runs all of the above on every push/PR to
`main`, plus `npm run audit:check` (fails only on high/critical advisories —
see the comment in the workflow file for why moderate ones don't block).

## Formatting

Prettier is configured (`.prettierrc.json`) but the existing codebase
predates it and hasn't been reformatted yet — `npm run format:check` will
currently report ~55 files as non-conforming, which is expected and *not*
a bug you need to fix as a side effect of an unrelated change. When the team
is ready to take that one-time diff:

```
npm run format
```

Review the diff (it'll be large — mostly whitespace/quote-style, but worth
a skim), commit it on its own with nothing else in the same PR, then remove
`continue-on-error: true` from the "Formatting check" step in the CI
workflow so it actually blocks future PRs.

## Linting

```
npm run lint       # report only
npm run lint:fix   # auto-fix what ESLint can fix safely
```

See the comments in `eslint.config.js` for why `no-undef`/`no-unused-vars`
are turned off for most of `public/js/studio/*.js` specifically (those
files share one global scope across ~20 `<script>` tags by design — see
`public/js/studio/01-constants.js`'s header comment — so most cross-file
references read as false positives to a per-file linter).

## Tests

`test/*.test.js`, run via Node's built-in test runner (`node --test`, no
extra dependency). Currently covers the pure-logic modules
(`server/validators.js`, `server/accessSchedule.js`) — anything with no DB
or network dependency is fair game to add here the same way. Route-level
tests would need a real or mocked Postgres and aren't set up yet.

## Schema changes

See `server/migrations/README.md`.

## Dependency updates

Dependabot (`.github/dependabot.yml`) opens a weekly PR for npm and GitHub
Actions updates, grouped by minor/patch so routine bumps aren't a dozen
separate PRs. `npm run audit:check` (also in CI) is the other half of this —
Dependabot tells you a newer version exists, `npm audit` tells you which
currently-installed version has a known vulnerability, right now.
