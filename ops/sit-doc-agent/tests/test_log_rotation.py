#!/usr/bin/env python3
"""Tests for %i-rollover rotation handling in tail_all_logs().

    python3 ops/sit-doc-agent/tests/test_log_rotation.py

No framework, no dependencies - same constraint as the agent itself. Exit
code 0 = pass.

Why this exists: for the common log4j2 %i rollover style (fileName=app.log,
filePattern=app-%i.log), rotation RENAMES app.log to app-1.log. A rename
preserves the ORIGINAL mtime - the instant of its last write, "just now" for
a file that was live seconds before rotation. If the periodic re-glob
discovers app-1.log within NEW_FILE_MAX_AGE_SECONDS of that rename (the
common case - one hour is far longer than the default rescan interval), the
mtime-alone heuristic reads it as a fresh live file and starts it at offset
0, RE-INGESTING bytes already counted under the old path - silently
inflating request/error counts, with no warning printed. This fails just as
silently as the bugs test_ingest_and_scale.py exists to catch: the dashboard
still renders a confident-looking, simply wrong number.

The fix reads a rename's preserved inode as the signal it is: before
trusting mtime for a newly-discovered path, check whether its inode matches
one this agent already has an offset for under a path that has since
vanished (or been replaced by a different file). If so, carry the existing
offset forward instead of re-reading anything.
"""
import os
import shutil
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
AGENT_DIR = os.path.dirname(HERE)
sys.path.insert(0, AGENT_DIR)
os.environ.setdefault("MULE_LOG_PATH", "/opt/mule/logs/mule-app.log")

import mule_doc_agent as agent  # noqa: E402

FAILURES = []


def check(name, condition, detail=""):
    if condition:
        print("  PASS  %s" % name)
    else:
        print("  FAIL  %s %s" % (name, detail))
        FAILURES.append(name)


def with_tmpdir(fn):
    tmpdir = tempfile.mkdtemp(prefix="doctracker_rotation_test_")
    try:
        fn(tmpdir)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


print("%i rollover (rename) does not double-count")


def _i_rollover(tmpdir):
    live = os.path.join(tmpdir, "app.log")
    with open(live, "w") as f:
        f.write("line1\nline2\nline3\n")

    state = {}
    out1 = agent.tail_all_logs([live], state, total_budget=1000)
    check("first cycle reads the file's existing content", out1.get(live) == ["line1", "line2", "line3"],
          "got %r" % out1.get(live))

    # A real %i rollover: rename (preserves inode/mtime), then a fresh file
    # takes the old path.
    rotated = os.path.join(tmpdir, "app-1.log")
    os.rename(live, rotated)
    with open(live, "w") as f:
        f.write("line4\n")

    out2 = agent.tail_all_logs([live, rotated], state, total_budget=1000)
    check("the live path picks up only its new content after rollover",
          out2.get(live) == ["line4"], "got %r" % out2.get(live))
    check("the renamed archive is NOT re-ingested (this is the bug)",
          not out2.get(rotated), "got %r" % out2.get(rotated))


with_tmpdir(_i_rollover)


print("\nadjacent cases the fix must not break")


def _genuinely_new_file(tmpdir):
    p = os.path.join(tmpdir, "brand-new.log")
    with open(p, "w") as f:
        f.write("a\nb\n")
    state = {}
    out = agent.tail_all_logs([p], state, total_budget=1000)
    check("a genuinely new file with no relation to anything still starts at 0",
          out.get(p) == ["a", "b"], "got %r" % out.get(p))


with_tmpdir(_genuinely_new_file)


def _genuinely_stale_archive(tmpdir):
    p = os.path.join(tmpdir, "old-archive.log")
    with open(p, "w") as f:
        f.write("historical line 1\nhistorical line 2\n")
    old_time = time.time() - 7200  # 2h old, past the 1h default threshold
    os.utime(p, (old_time, old_time))
    state = {}
    out = agent.tail_all_logs([p], state, total_budget=1000)
    check("a genuinely stale archive skips its history on first discovery",
          not out.get(p), "got %r" % out.get(p))

    with open(p, "a") as f:
        f.write("new line after discovery\n")
    out2 = agent.tail_all_logs([p], state, total_budget=1000)
    check("...but still picks up anything appended after that",
          out2.get(p) == ["new line after discovery"], "got %r" % out2.get(p))


with_tmpdir(_genuinely_stale_archive)


def _copy_based_rotation_unaffected(tmpdir):
    # Copytruncate-style rotation: the archive is a COPY (a NEW inode), the
    # live file is truncated in place (SAME inode, same path). Inode
    # matching must not fire here - this is exactly the case the existing
    # mtime-staleness logic already handled correctly, and it must keep
    # working unmodified by this fix.
    live = os.path.join(tmpdir, "app.log")
    with open(live, "w") as f:
        f.write("line1\nline2\nline3\n")
    state = {}
    agent.tail_all_logs([live], state, total_budget=1000)

    archive = os.path.join(tmpdir, "app.log.1")
    shutil.copyfile(live, archive)
    old_time = time.time() - 7200
    os.utime(archive, (old_time, old_time))
    with open(live, "w") as f:
        f.write("line4\n")

    out = agent.tail_all_logs([live, archive], state, total_budget=1000)
    check("the live file (same inode, shrunk) is detected and re-read from 0",
          out.get(live) == ["line4"], "got %r" % out.get(live))
    check("the copied archive (different inode, old mtime) is not re-ingested",
          not out.get(archive), "got %r" % out.get(archive))


with_tmpdir(_copy_based_rotation_unaffected)


print()
if FAILURES:
    print("FAILED (%d): %s" % (len(FAILURES), ", ".join(FAILURES)))
    sys.exit(1)
print("All log rotation tests passed.")
