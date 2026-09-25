// Minimal structured-log wrapper — one JSON line per call, to stdout/stderr.
// The codebase has stayed deliberately dependency-light (13 runtime deps
// total, no logging library among them), so this is hand-rolled rather than
// pulling in pino/winston: a `console.error('X failed:', err)` call site
// becomes `log.error('X failed', { err, requestId: req.id })` and gains a
// timestamp, level, and correlation id, without adding a dependency for
// something this small.
//
// Deliberately NOT a replacement for every console.* call in the codebase —
// see CONTRIBUTING.md for which call sites were migrated and why.
function write(level, msg, meta) {
  const line = { timestamp: new Date().toISOString(), level, msg };
  if (meta && typeof meta === 'object') {
    for (const [key, value] of Object.entries(meta)) {
      // Error objects stringify to '{}' through JSON.stringify (message/stack
      // are non-enumerable) — pull out the parts worth keeping instead of
      // silently logging an empty object where the failure reason belongs.
      line[key] = value instanceof Error
        ? { message: value.message, stack: value.stack, ...('code' in value ? { code: value.code } : {}) }
        : value;
    }
  }
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  out(JSON.stringify(line));
}

const log = {
  info: (msg, meta) => write('info', msg, meta),
  warn: (msg, meta) => write('warn', msg, meta),
  error: (msg, meta) => write('error', msg, meta),
};

module.exports = { log };
