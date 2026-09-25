// Integrity of the inline stylesheets in server/views/*.html.
//
// These files carry thousands of lines of CSS heavily interleaved with prose
// comments, and CSS has a failure mode that review does not catch: a comment
// that closes early. Writing a class pattern like ".obs-proj-*" immediately
// before a "/" produces "*/" inside the prose, which ENDS the comment there.
// Everything after it is then parsed as CSS, so the parser is still
// accumulating a selector when it reaches the next real rule - and silently
// drops that rule as invalid.
//
// Nothing about this is visible. The file looks right, the braces balance, the
// page loads, and every rule AFTER the casualty still applies because the
// parser recovers at the closing brace. Exactly one rule disappears.
//
// That happened to .obs-header: it held only a margin for months, so losing it
// cost nothing anyone noticed, and the day it was given a flex layout the
// layout simply never arrived - while the .obs-header h1 and .obs-header p
// rules underneath it kept working, which made it look like anything BUT a
// parse error.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const VIEWS = path.join(__dirname, '..', 'server', 'views');
const files = fs.readdirSync(VIEWS).filter((f) => f.endsWith('.html'));

// Every <style> block in a view, with enough position information to report a
// failure as a line number in the original file.
function styleBlocks(file) {
  const html = fs.readFileSync(path.join(VIEWS, file), 'utf8');
  return [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => ({
    css: m[1],
    lineAt: (idx) => html.slice(0, m.index + m[0].indexOf(m[1]) + idx).split('\n').length,
  }));
}

// Walk the way a CSS parser does: /* opens a comment, the very next */ closes
// it, and comments do not nest.
function scanComments(css) {
  const opens = [];
  const closes = [];
  let i = 0;
  let inComment = false;
  while (i < css.length - 1) {
    if (!inComment && css[i] === '/' && css[i + 1] === '*') { inComment = true; opens.push(i); i += 2; continue; }
    if (inComment && css[i] === '*' && css[i + 1] === '/') { inComment = false; closes.push(i); i += 2; continue; }
    i += 1;
  }
  const legit = new Set(closes);
  const stray = [];
  let idx = css.indexOf('*/');
  while (idx !== -1) {
    if (!legit.has(idx)) stray.push(idx);
    idx = css.indexOf('*/', idx + 1);
  }
  return { opens, closes, stray, unterminated: inComment };
}

for (const file of files) {
  const blocks = styleBlocks(file);
  if (!blocks.length) continue;

  test(`${file}: no comment closes early or runs off the end`, () => {
    blocks.forEach((b) => {
      const s = scanComments(b.css);
      assert.equal(s.unterminated, false,
        `unterminated /* at line ${s.opens.length ? b.lineAt(s.opens[s.opens.length - 1]) : '?'}`);
      // A */ found while NOT inside a comment is the signature: either a
      // duplicated terminator, or - far more likely - a real comment above it
      // was cut short by a "*/" hiding in its prose.
      assert.deepEqual(s.stray.map(b.lineAt), [],
        'stray */ (a comment above it closed early) at the listed line(s)');
    });
  });

  test(`${file}: braces balance inside every style block`, () => {
    blocks.forEach((b) => {
      const css = b.css.replace(/\/\*[\s\S]*?\*\//g, '');
      assert.equal(css.split('{').length - css.split('}').length, 0, 'unbalanced braces');
    });
  });

  test(`${file}: no rule selector has swallowed prose`, () => {
    // The consequence rather than the cause, so a future variant of the same
    // mistake is caught even if it is not a comment at fault. A selector is
    // made of names, combinators and punctuation - never sentences.
    blocks.forEach((b) => {
      const css = b.css.replace(/\/\*[\s\S]*?\*\//g, '');
      let depth = 0;
      let selector = '';
      let start = 0;
      for (let i = 0; i < css.length; i += 1) {
        const ch = css[i];
        if (ch === '{') {
          if (depth === 0) {
            // Quoted strings can hold anything, so they are not evidence.
            const sel = selector.trim().replace(/"[^"]*"|'[^']*'/g, '""');
            // A period followed by whitespace ends a sentence and cannot occur
            // in a selector - a class name's dot is always followed by its
            // name. Same for ? and !. Kept this narrow on purpose: a heuristic
            // that also flags .ai-not-configured for containing "not" teaches
            // people to skip the test.
            assert.ok(!/\.\s|[?!]/.test(sel),
              `line ${b.lineAt(start)} in ${file}: selector contains prose — `
              + `a comment above it probably closed early:\n  ${sel.slice(0, 200)}`);
            assert.ok(sel.length < 300,
              `line ${b.lineAt(start)} in ${file}: selector is ${sel.length} characters long, `
              + 'which means it has absorbed something that is not a selector');
          }
          depth += 1;
          selector = '';
        } else if (ch === '}') {
          depth = Math.max(0, depth - 1);
          selector = '';
          start = i + 1;
        } else if (ch === ';' && depth === 0) {
          // A statement at-rule (@import, @charset) ends here rather than
          // opening a block; without this its text runs into the next rule's
          // selector and looks exactly like the bug being hunted.
          selector = '';
          start = i + 1;
        } else if (depth === 0) {
          if (!selector.trim()) start = i;
          selector += ch;
        }
      }
    });
  });
}

// The specific rule the bug above destroyed. Worth naming: it is the one that
// puts the live-stream badge in the header's top-right corner, and when it
// vanished the badge dropped to the left margin with nothing to explain it.
test('studio.html: .obs-header is a real, standalone flex rule', () => {
  const css = styleBlocks('studio.html')
    .map((b) => b.css).join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const m = css.match(/([^{};]*)\.obs-header\s*\{([^}]*)\}/);
  assert.ok(m, '.obs-header has no rule at all');
  assert.equal(`${m[1]}.obs-header`.trim(), '.obs-header', 'the selector picked up preceding text');
  assert.match(m[2], /display\s*:\s*flex/, 'the header is not a flex row');
});
