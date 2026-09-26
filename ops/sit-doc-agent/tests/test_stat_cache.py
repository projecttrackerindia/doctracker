#!/usr/bin/env python3
"""Tests for the per-cycle stat_cache shared between tail_all_logs() and
build_agent_health() (see run()'s main loop).

    python3 ops/sit-doc-agent/tests/test_stat_cache.py

No framework, no dependencies - same constraint as the agent itself. Exit
code 0 = pass.

Why this exists: tail_all_logs() used to call os.stat() on every tailed file
in its fair-share pass, AGAIN in its hungry-files redistribution pass under
sustained load, and build_agent_health() took a THIRD independent os.stat()
pass over the same files moments later for its backlog estimate - up to 3x
the syscalls per file per cycle for data that mostly hadn't changed between
them. The fix shares one dict across all three, but ONLY where reusing a
stale stat is actually safe: tail_new_lines() uses st.st_size to decide
whether a file was TRUNCATED (relative to the offset it's about to read
from), and the real read loop inside it can advance that offset past
whatever st.st_size said, if the writer appended between the stat and the
read - so reusing a cached stat across TWO reads of the same file (pass 1's
first read, then pass 2's second) can make a file that's simply still
growing look like it shrank, wrongly resetting the offset to 0 and
double-counting everything already read this cycle. This file proves both
sides: the shared cache actually cuts real os.stat() calls, AND the specific
reuse the fix deliberately avoids (pass 2 reusing pass 1's stat) really
would corrupt state if it were wired up.
"""
import os
import shutil
import sys
import tempfile

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
    tmpdir = tempfile.mkdtemp(prefix="doctracker_statcache_test_")
    try:
        fn(tmpdir)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


print("Shared stat_cache produces identical results to no caching")


def _t_equivalence(tmpdir):
    paths = []
    for i in range(6):
        p = os.path.join(tmpdir, "app%d.log" % i)
        with open(p, "w", encoding="utf-8") as f:
            for n in range(20):
                f.write("line %d from file %d\n" % (n, i))
        paths.append(p)

    # A tiny total_budget forces most files to fill their per-file share and
    # become "hungry" - exactly the condition that reaches pass 2.
    state_cached = {"files": {}}
    out_cached = agent.tail_all_logs(paths, state_cached, total_budget=12, stat_cache={})
    health_cached = agent.build_agent_health(state_cached, stat_cache={})

    state_plain = {"files": {}}
    out_plain = agent.tail_all_logs(paths, state_plain, total_budget=12, stat_cache=None)
    health_plain = agent.build_agent_health(state_plain, stat_cache=None)

    check("tail_all_logs returns the same lines with or without a stat_cache",
          out_cached == out_plain, "cached=%r plain=%r" % (out_cached, out_plain))
    check("resulting file offsets are identical with or without a stat_cache",
          {p: s["offset"] for p, s in state_cached["files"].items()}
          == {p: s["offset"] for p, s in state_plain["files"].items()})
    check("build_agent_health backlog is identical with or without a stat_cache",
          health_cached["backlogBytes"] == health_plain["backlogBytes"],
          "cached=%s plain=%s" % (health_cached["backlogBytes"], health_plain["backlogBytes"]))


with_tmpdir(_t_equivalence)

print("\nA shared stat_cache actually reduces real os.stat() calls")


def _t_call_count(tmpdir):
    paths = []
    for i in range(10):
        p = os.path.join(tmpdir, "busy%d.log" % i)
        with open(p, "w", encoding="utf-8") as f:
            for n in range(30):
                f.write("line %d\n" % n)
        paths.append(p)

    real_stat = os.stat
    calls = {"n": 0}

    def counting_stat(path, *a, **kw):
        if path in paths:
            calls["n"] += 1
        return real_stat(path, *a, **kw)

    os.stat = counting_stat
    try:
        calls["n"] = 0
        state_plain = {"files": {}}
        agent.tail_all_logs(paths, state_plain, total_budget=15, stat_cache=None)
        agent.build_agent_health(state_plain, stat_cache=None)
        without_cache = calls["n"]

        calls["n"] = 0
        state_cached = {"files": {}}
        cache = {}
        agent.tail_all_logs(paths, state_cached, total_budget=15, stat_cache=cache)
        agent.build_agent_health(state_cached, stat_cache=cache)
        with_cache = calls["n"]
    finally:
        os.stat = real_stat

    check("caching strictly reduces stat() calls across tail_all_logs + build_agent_health",
          with_cache < without_cache, "without_cache=%d with_cache=%d" % (without_cache, with_cache))
    print("    (without cache: %d real stat() calls; with cache: %d, for %d files)"
          % (without_cache, with_cache, len(paths)))


with_tmpdir(_t_call_count)

print("\nWhy pass 2 must never reuse pass 1's cached stat")


def _t_pass2_danger(tmpdir):
    p = os.path.join(tmpdir, "growing.log")
    with open(p, "w", encoding="utf-8") as f:
        f.write("line 0\n")

    fstate = {"offset": 0, "inode": None}
    stale_cache = {}
    # Simulates pass 1's stat, captured BEFORE the writer appends anything
    # else - deliberately taken before any read, same as tail_all_logs()
    # does for a brand-new file.
    stale_cache[p] = os.stat(p)

    # The writer appends a lot more between this stat and the NEXT read -
    # exactly what "hungry" means: there's more backlog by the time pass 2
    # gets to it. The read inside tail_new_lines() consumes all of this
    # (real read, not bounded by the stale stat), advancing the offset well
    # past what the stale cached size claims exists.
    with open(p, "a", encoding="utf-8") as f:
        for n in range(1, 200):
            f.write("line %d\n" % n)

    agent.tail_new_lines(p, fstate, max_lines=None, stat_cache=stale_cache)
    offset_after_growth_read = fstate["offset"]
    check("the growth read actually advanced well past the stale cached size",
          offset_after_growth_read > stale_cache[p].st_size,
          "offset=%d stale_size=%d" % (offset_after_growth_read, stale_cache[p].st_size))

    # Now the DANGEROUS pattern: reuse that SAME stale cache entry for a
    # second read of the same path, same as a hypothetical buggy pass 2
    # would. This must incorrectly detect "truncation", reset the offset to
    # 0, and RE-READ EVERYTHING already read a moment ago - proving the bug
    # this fix specifically avoids is real, not theoretical. Note the final
    # offset alone doesn't reveal this: after the erroneous reset, the read
    # loop immediately re-reads straight back up to the same real EOF, so
    # the offset ends up looking almost identical to the correct value - the
    # actual symptom is the *lines returned* being a full duplicate of what
    # call 1 already returned, which is exactly how this class of bug stays
    # invisible in offset-only monitoring.
    with open(p, "a", encoding="utf-8") as f:
        f.write("one more line\n")
    second_read = agent.tail_new_lines(p, fstate, max_lines=None, stat_cache=stale_cache)
    check("reusing a stale cached stat across a second read RE-RETURNS lines already counted in call 1",
          len(second_read) > 5,  # only 1 genuinely new line was appended - anything past that is a re-read
          "expected ~200 duplicated lines back, got %d - the bug did not reproduce" % len(second_read))

    # And the control: the SAME scenario with a fresh stat each time (what
    # the real pass 2 code path actually does) must NOT trigger this.
    fstate2 = {"offset": 0, "inode": None}
    with open(p + ".control", "w", encoding="utf-8") as f:
        f.write("line 0\n")
    agent.tail_new_lines(p + ".control", fstate2, max_lines=None, stat_cache=None)
    with open(p + ".control", "a", encoding="utf-8") as f:
        f.write("one more line\n")
    second_read_control = agent.tail_new_lines(p + ".control", fstate2, max_lines=None, stat_cache=None)
    check("a FRESH stat on every read (the real pass 2 path) returns only the genuinely new line(s)",
          second_read_control == ["one more line"],
          "expected exactly 1 new line, got %r" % (second_read_control,))


with_tmpdir(_t_pass2_danger)

if FAILURES:
    print("\n%d check(s) failed: %s" % (len(FAILURES), ", ".join(FAILURES)))
    sys.exit(1)
print("\nAll stat_cache tests passed.")
