// ESLint v9 flat config. Two environments in this repo, linted differently:
//   - server/**       → Node, CommonJS (require/module.exports)
//   - public/**        → browser, plain <script> files (no bundler, no
//                         modules — see index.html's <script src> tags),
//                         so `sourceType: 'script'` and browser globals.
const js = require('@eslint/js');
const globals = require('globals');
const eslintConfigPrettier = require('eslint-config-prettier');

module.exports = [
  {
    ignores: ['node_modules/**'],
  },
  // This config file itself runs under Node/CommonJS.
  {
    files: ['eslint.config.js'],
    languageOptions: { globals: { ...globals.node } },
  },
  js.configs.recommended,
  eslintConfigPrettier, // turns off stylistic rules that would conflict with Prettier's formatting

  // ---- Server (Node / CommonJS) ----
  {
    files: ['server/**/*.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off', // this app logs operationally (startup, retention sweeps, migration status) — that's intentional, not debug leftovers
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // ---- Browser (plain scripts, no bundler) ----
  {
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.browser },
    },
    rules: {
      // These files are split across many <script> tags that all share one
      // global scope by design (see public/js/studio/01-constants.js through
      // 22-init.js) — flagging every cross-file reference as "undefined"
      // would be hundreds of false positives, not real bugs. Turned back on
      // per-file below where it's actually useful (e.g. a self-contained
      // page like login.js).
      'no-undef': 'off',
      'no-unused-vars': 'off', // see comment above no-undef — same reason: a function used only from a different <script> file reads as "unused" from any single file's perspective
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Several files intentionally write `<\/script>` inside generated
      // HTML/code-sample strings (code-sample generation, export previews)
      // to stop a browser's HTML parser from treating a literal
      // "</script>" inside the string as closing the real enclosing
      // <script> tag. ESLint's no-useless-escape doesn't know about that
      // HTML-parsing context and reports it as a no-op JS string escape —
      // technically true for the JS string value, but removing it would
      // reintroduce the exact bug the escape exists to prevent.
      'no-useless-escape': 'off',
    },
  },

  // Self-contained page scripts (not part of the studio/* shared-global
  // split above) — safe to check for real undefined-reference bugs.
  {
    files: ['public/js/login.js', 'public/js/register.js', 'public/js/idle-session.js', 'public/js/theme.js'],
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      'no-undef': 'error',
    },
  },
];
