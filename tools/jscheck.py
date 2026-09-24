#!/usr/bin/env python3
"""Parse-check the browser JS modules in public/js/studio/.

    python3 tools/jscheck.py                      # all studio modules
    python3 tools/jscheck.py path/to/one.js ...   # specific files

Why this exists: these files are plain <script> includes with no build step,
so a syntax error doesn't surface until the page is loaded in a browser and
the whole module silently fails to define its functions. Node's own
`node --check` is the obvious tool but treats these as CommonJS modules and
is unhappy with browser globals in some configurations, and hand-rolled
brace-counters are worse than useless here: they mis-parse quotes inside
regex character classes (`/[",\n]/`) and nested template literals, and will
report a confident, wrong answer on a perfectly valid file.

Requires esprima (`pip install esprima`). esprima's grammar predates ES2020,
so `??` and `?.` are rewritten to grammatically-equivalent older forms BEFORE
parsing. That changes runtime semantics, which is irrelevant here - the point
is to validate STRUCTURE: braces, brackets, template literals (including
nested ones), regex literals and strings. Replacements keep the same
character count so reported line/column numbers stay accurate.

Exit code 0 = all files parsed, 1 = at least one failed.
"""
import glob
import os
import re
import sys

try:
    import esprima
except ImportError:
    print("jscheck: esprima is not installed. Run: pip install esprima", file=sys.stderr)
    sys.exit(2)

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def normalize(src):
    src = src.replace('??=', '||=')
    src = src.replace('??', '||')
    # Optional chaining. Member access keeps its dot (`a?.b` -> `a .b`) because
    # dropping it entirely produces `a  b`, which is a REAL syntax error and
    # would report a false failure. Call and index forms drop it (`a?.(x)` ->
    # `a  (x)`). Both stay two characters wide so columns don't shift.
    src = re.sub(r'\?\.(?=[A-Za-z_$])', ' .', src)
    src = re.sub(r'\?\.(?=[(\[])', '  ', src)
    return src


def main(argv):
    files = argv[1:]
    if not files:
        files = sorted(glob.glob(os.path.join(REPO_ROOT, 'public', 'js', 'studio', '*.js')))
    if not files:
        print("jscheck: no files to check", file=sys.stderr)
        return 2

    failed = []
    for path in files:
        try:
            with open(path, encoding='utf-8') as fh:
                src = fh.read()
        except OSError as e:
            print("READ  %s: %s" % (path, e))
            failed.append(path)
            continue
        rel = os.path.relpath(path, REPO_ROOT)
        try:
            esprima.parseScript(normalize(src), {'tolerant': False})
            print("OK    %s" % rel)
        except Exception as e:
            print("FAIL  %s: %s" % (rel, e))
            failed.append(path)

    print()
    if failed:
        print("%d of %d file(s) FAILED to parse." % (len(failed), len(files)))
        return 1
    print("All %d file(s) parsed cleanly." % len(files))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
