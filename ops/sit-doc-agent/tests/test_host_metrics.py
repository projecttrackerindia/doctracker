#!/usr/bin/env python3
"""Tests for the agent's host-health sampling.

Run from anywhere:

    python3 ops/sit-doc-agent/tests/test_host_metrics.py

No test framework and no dependencies, matching the agent itself - these have
to be runnable on the SIT server, where you may not be able to pip-install
pytest. Exit code 0 = pass, 1 = fail.

These cover the cases that are easy to get wrong and impossible to notice
once wrong, because a bad host metric looks exactly like a real one:

  * CPU is a DELTA between two /proc/stat reads, so the first read after a
    start has no rate to report. Reporting 0 there would look like an idle
    server.
  * State survives restarts, so the "previous" read can be hours old. A delta
    against it averages CPU across the downtime and calls it current.
  * iowait must count as idle, or a slow disk reads as a CPU shortage.
  * The client decodes samples POSITIONALLY, so the column order is duplicated
    between Python and JS. If those drift, every retained sample is silently
    misread - no error, just wrong numbers. That one is checked against the
    real .js file rather than a copy of the list.
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
AGENT_DIR = os.path.dirname(HERE)
REPO_ROOT = os.path.dirname(os.path.dirname(AGENT_DIR))
sys.path.insert(0, AGENT_DIR)
os.environ.setdefault("MULE_LOG_PATH", "/opt/mule/logs/mule-app.log")

import mule_doc_agent as agent  # noqa: E402

COLS = agent.HOST_SAMPLE_COLUMNS
FAILURES = []


def check(name, condition, detail=""):
    if condition:
        print("  PASS  %s" % name)
    else:
        print("  FAIL  %s %s" % (name, detail))
        FAILURES.append(name)


def col(sample, name):
    return sample[COLS.index(name)]


def stub_readers(total=1_000_000, idle=900_000, mem=True, disk=True, load=True, rss=True):
    """Replace the /proc readers so these tests run anywhere, including the
    Windows and macOS machines this repo is edited on."""
    agent._read_proc_stat_cpu = (lambda: (total, idle)) if total is not None else (lambda: None)
    agent._read_meminfo = (lambda: (8 * 1024 ** 3, int(4.4 * 1024 ** 3))) if mem else (lambda: None)
    agent._read_log_disk = (lambda: (100 * 1024 ** 3, 40 * 1024 ** 3)) if disk else (lambda: None)
    agent._read_self_rss = (lambda: 21_500_000) if rss else (lambda: None)
    if load:
        agent.os.getloadavg = lambda: (0.81, 0.55, 0.40)
        agent.os.cpu_count = lambda: 4
    else:
        def _boom():
            raise OSError("no getloadavg")
        agent.os.getloadavg = _boom


print("Host sampling")
stub_readers()

health = {}
s1, static = agent.sample_host_metrics(health, 1_750_000_000)
check("first sample reports no CPU rate", col(s1, "cpuPct") is None,
      "got %r - a first read has no delta to measure against" % col(s1, "cpuPct"))
check("first sample still reports memory", col(s1, "memPct") == 45.0, "got %r" % col(s1, "memPct"))
check("static info carries the unchanging values",
      static.get("cpuCores") == 4 and "memTotalBytes" in static and "diskTotalBytes" in static,
      "got %r" % static)

stub_readers(total=1_010_000, idle=902_000)  # 8000 busy of 10000 elapsed
s2, _ = agent.sample_host_metrics(health, 1_750_000_060)
check("second sample computes the CPU delta", col(s2, "cpuPct") == 80.0, "got %r" % col(s2, "cpuPct"))

stub_readers(total=51_010_000, idle=25_902_000)
s3, _ = agent.sample_host_metrics(health, 1_750_000_060 + 7200)
check("stale previous sample is discarded, not averaged", col(s3, "cpuPct") is None,
      "got %r - would be CPU averaged across a 2h restart gap" % col(s3, "cpuPct"))

stub_readers(total=2_000_000, idle=1_000_000)
s4, _ = agent.sample_host_metrics({"cpuPrevSample": [1_990_000, 995_000, 1_750_000_000]}, 1_750_000_060)
check("iowait counts as idle", col(s4, "cpuPct") == 50.0,
      "got %r - counting iowait as busy makes a slow disk look like a CPU shortage" % col(s4, "cpuPct"))

print("Partial and total unreadability")
stub_readers(total=3_000_000, idle=2_000_000, mem=False)
s5, static5 = agent.sample_host_metrics({"cpuPrevSample": [2_990_000, 1_995_000, 1_750_000_000]}, 1_750_000_060)
check("unreadable meminfo yields null, not 0", col(s5, "memPct") is None, "got %r" % col(s5, "memPct"))
check("unreadable meminfo omits memTotalBytes", "memTotalBytes" not in static5, "got %r" % static5)
check("other metrics survive a partial read", col(s5, "diskUsedPct") == 60.0, "got %r" % col(s5, "diskUsedPct"))

stub_readers(total=None, mem=False, disk=False, load=False, rss=False)
s6, static6 = agent.sample_host_metrics({}, 1_750_000_060)
check("nothing readable returns (None, None)", s6 is None and static6 is None, "got %r" % ((s6, static6),))

print("Wire format")
stub_readers()
h2 = {}
agent.sample_host_metrics(h2, 1_750_000_000)
s7, _ = agent.sample_host_metrics(h2, 1_750_000_060)
check("sample is a list", isinstance(s7, list), "got %r" % type(s7))
check("sample width matches the column list", len(s7) == len(COLS),
      "%d values vs %d columns" % (len(s7), len(COLS)))
check("every value is JSON-serialisable", json.dumps(s7) is not None)

# The guard that matters most: the client indexes these positionally.
js_path = os.path.join(REPO_ROOT, "public", "js", "studio", "23-observability.js")
try:
    js_src = open(js_path, encoding="utf-8").read()
    m = re.search(r"const HOST_SAMPLE_COLS\s*=\s*\[(.*?)\]", js_src, re.S)
    js_cols = [c.strip().strip("'\"") for c in m.group(1).split(",") if c.strip()] if m else None
except OSError as e:
    js_cols = None
    print("  (could not read %s: %s)" % (js_path, e))

check("client HOST_SAMPLE_COLS matches the agent's column order",
      js_cols == COLS,
      "\n        agent : %r\n        client: %r\n        Changing one without the other silently misreads every sample."
      % (COLS, js_cols))

print()
if FAILURES:
    print("FAILED (%d): %s" % (len(FAILURES), ", ".join(FAILURES)))
    sys.exit(1)
print("All host-metric tests passed.")
