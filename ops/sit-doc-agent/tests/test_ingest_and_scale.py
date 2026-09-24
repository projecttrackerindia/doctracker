#!/usr/bin/env python3
"""Tests for multi-file ingest and the bounded source-IP tracking.

    python3 ops/sit-doc-agent/tests/test_ingest_and_scale.py

No framework, no dependencies - same constraint as the agent itself. Exit
code 0 = pass.

These exist because both behaviours fail SILENTLY when they regress: a file
that stops being tailed just stops contributing counts, and a source-IP map
that drops new entries still renders a confident-looking "Top source IPs"
panel. Neither raises anything.
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


def req_line(i, path):
    return ("2026-09-24 09:%02d:%02d,%03d INFO  [http.listener.%02d] org.mule.extension.http: "
            "HTTP Listener received: GET %s - correlationId=%032x statusCode=200 duration=%dms"
            % (i % 60, (i * 7) % 60, i % 1000, i % 16, path, i * 7919, 10 + i % 400))


def obs(ip, path="/api/orders"):
    return {"method": "GET", "path": path, "statusCode": 200, "clientIp": ip,
            "correlationId": None, "body": None}


print("Multi-file ingest")
tmp = tempfile.mkdtemp(prefix="doctracker-agent-test-")
try:
    paths = []
    for n in range(5):
        p = os.path.join(tmp, "app%d.log" % n)
        with open(p, "w", encoding="utf-8") as fh:
            fh.write("\n".join(req_line(i, "/api/app%d/op" % n) for i in range(100)) + "\n")
        paths.append(os.path.abspath(p))

    agent.MULE_LOG_PATH = os.path.join(tmp, "*.log")
    resolved = agent.resolve_log_paths(agent.MULE_LOG_PATH)
    check("glob expands to every matching file", len(resolved) == 5, "got %d" % len(resolved))

    state = {"endpoints": {}, "health": {}, "files": {}}
    first = agent.tail_all_logs(resolved, state, 20000)
    check("first pass reads all five files", len(first) == 5 and all(len(v) == 100 for v in first.values()),
          "got %s" % {os.path.basename(k): len(v) for k, v in first.items()})
    check("a per-file offset is kept for each", len(state["files"]) == 5, "got %d" % len(state["files"]))

    second = agent.tail_all_logs(resolved, state, 20000)
    check("second pass re-reads nothing", second == {}, "got %s" % second)

    with open(paths[2], "a", encoding="utf-8") as fh:
        fh.write("\n".join(req_line(i, "/api/app2/op") for i in range(37)) + "\n")
    third = agent.tail_all_logs(resolved, state, 20000)
    check("only the appended-to file yields new lines",
          list(third) == [paths[2]] and len(third[paths[2]]) == 37,
          "got %s" % {os.path.basename(k): len(v) for k, v in third.items()})

    # A partial trailing line must not be consumed - the writer hasn't
    # finished it, and committing the offset past it desyncs everything after.
    with open(paths[0], "a", encoding="utf-8") as fh:
        fh.write("2026-09-24 09:00:00,000 INFO partial line with no newline yet")
    fourth = agent.tail_all_logs(resolved, state, 20000)
    check("an unterminated trailing line is left unread", paths[0] not in fourth,
          "got %s" % {os.path.basename(k): len(v) for k, v in fourth.items()})
    with open(paths[0], "a", encoding="utf-8") as fh:
        fh.write("\n")
    fifth = agent.tail_all_logs(resolved, state, 20000)
    check("...and is picked up whole once completed",
          paths[0] in fifth and len(fifth[paths[0]]) == 1,
          "got %s" % {os.path.basename(k): len(v) for k, v in fifth.items()})

    # Rotation: replacing the file must restart from its top, not resume at a
    # stale offset that is now past the new file's end.
    with open(paths[1], "w", encoding="utf-8") as fh:
        fh.write("\n".join(req_line(i, "/api/app1/op") for i in range(12)) + "\n")
    sixth = agent.tail_all_logs(resolved, state, 20000)
    check("a truncated/rotated file restarts from the top",
          paths[1] in sixth and len(sixth[paths[1]]) == 12,
          "got %s" % {os.path.basename(k): len(v) for k, v in sixth.items()})

    # Fairness: one very busy log must not consume the whole budget.
    state2 = {"endpoints": {}, "health": {}, "files": {}}
    with open(paths[0], "w", encoding="utf-8") as fh:
        fh.write("\n".join(req_line(i, "/api/app0/op") for i in range(9000)) + "\n")
    for p in paths[1:]:
        with open(p, "w", encoding="utf-8") as fh:
            fh.write("\n".join(req_line(i, "/api/other/op") for i in range(50)) + "\n")
    shared = agent.tail_all_logs(resolved, state2, 1000)
    got = {os.path.basename(k): len(v) for k, v in shared.items()}
    check("a busy log does not starve the quiet ones",
          all(got.get("app%d.log" % n) == 50 for n in range(1, 5)), "got %s" % got)
    check("the line budget is respected", sum(got.values()) <= 1000, "read %d" % sum(got.values()))

    # State for a file that disappears must not accumulate forever.
    os.remove(paths[4])
    remaining = agent.resolve_log_paths(agent.MULE_LOG_PATH)
    agent.tail_all_logs(remaining, state2, 100)
    check("state for a vanished file is dropped", paths[4] not in state2["files"],
          "still tracking %d file(s)" % len(state2["files"]))
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print("Rotated archives vs live logs")
# Mirrors the real FSBL layout: each app rolls at 10MB into app-N.log, so the
# directory is mostly stale archives that must NEVER be ingested as current
# traffic, plus one recently-written live file per app that must be read whole.
tmp2 = tempfile.mkdtemp(prefix="doctracker-rotation-test-")
try:
    now = __import__("time").time()
    apps = ["s-portal-customer-api", "s-insurance-api", "s-genai-api"]
    archive_lines = live_lines = 0
    for app in apps:
        for idx in (1, 2, 3):                       # stale archives, rolled yesterday
            p = os.path.join(tmp2, "%s-%d.log" % (app, idx))
            with open(p, "w", encoding="utf-8") as fh:
                fh.write("\n".join(req_line(i, "/api/%s/op" % app) for i in range(500)) + "\n")
            archive_lines += 500
            old = now - 86400 - idx * 3600
            os.utime(p, (old, old))
        p = os.path.join(tmp2, "%s-4.log" % app)     # live, rolled 2 minutes ago
        with open(p, "w", encoding="utf-8") as fh:
            fh.write("\n".join(req_line(i, "/api/%s/op" % app) for i in range(120)) + "\n")
        live_lines += 120
        os.utime(p, (now - 120, now - 120))
    for name in ("s-genai-api-0.log.gz", "mule-app-s-rezolv-api.log.2026-09-20"):
        with open(os.path.join(tmp2, name), "w", encoding="utf-8") as fh:
            fh.write("x")

    agent.MULE_LOG_PATH = os.path.join(tmp2, "*")
    resolved = agent.resolve_log_paths(agent.MULE_LOG_PATH)
    check("compressed and date-stamped archives are excluded",
          not any(p.endswith(".gz") or ".log.2026-" in p for p in resolved),
          "got %s" % [os.path.basename(p) for p in resolved])

    st2 = {"endpoints": {}, "health": {}, "files": {}}
    out = agent.tail_all_logs(resolved, st2, 100000)
    read = sum(len(v) for v in out.values())
    check("stale archives are NOT ingested as current traffic", read == live_lines,
          "read %d lines, expected %d live (%d archive lines on disk)" % (read, live_lines, archive_lines))

    # A rollover creates a brand-new live file; its content is real and new.
    with open(os.path.join(tmp2, "%s-5.log" % apps[0]), "w", encoding="utf-8") as fh:
        fh.write("\n".join(req_line(i, "/api/%s/op" % apps[0]) for i in range(77)) + "\n")
    out2 = agent.tail_all_logs(agent.resolve_log_paths(agent.MULE_LOG_PATH), st2, 100000)
    check("a freshly rolled live file is read from the top",
          sum(len(v) for v in out2.values()) == 77,
          "got %s" % {os.path.basename(k): len(v) for k, v in out2.items()})

    # A "%i" rollover RENAMES archives up an index. mtime is preserved, so the
    # renamed file must still be recognised as an archive, not re-counted.
    os.rename(os.path.join(tmp2, "%s-3.log" % apps[1]),
              os.path.join(tmp2, "%s-9.log" % apps[1]))
    out3 = agent.tail_all_logs(agent.resolve_log_paths(agent.MULE_LOG_PATH), st2, 100000)
    check("an archive renamed to a new index is not re-counted",
          sum(len(v) for v in out3.values()) == 0,
          "re-ingested %d line(s)" % sum(len(v) for v in out3.values()))
finally:
    shutil.rmtree(tmp2, ignore_errors=True)

print("Bounded source-IP tracking")
st = {"endpoints": {}, "health": {}}
agent.aggregate(st, [obs("203.0.113.%d" % (i % 254) if i < 254 else "198.51.100.%d" % (i % 254))
                     for i in range(600)])
key = [k for k in st["endpoints"] if k != agent.OVERFLOW_KEY][0]
ips = st["endpoints"][key]["sourceIps"]
check("the map stays under the watermark", len(ips) <= agent.MAX_SOURCE_IPS_WATERMARK,
      "%d entries" % len(ips))

# The regression this replaced: with `elif len(ips) < 50`, an IP first seen
# after the map filled could NEVER be recorded, however dominant it became.
agent.aggregate(st, [obs("198.51.100.250") for _ in range(500)])
ips = st["endpoints"][key]["sourceIps"]
top = sorted(ips.items(), key=lambda kv: -kv[1])
check("a heavy hitter first seen after the map filled becomes #1",
      top[0][0] == "198.51.100.250", "top was %s" % top[:3])

for _ in range(5):
    agent.aggregate(st, [obs("192.0.2.%d" % (i % 254)) for i in range(300)])
ips = st["endpoints"][key]["sourceIps"]
check("it survives repeated pruning by a churning tail", "198.51.100.250" in ips,
      "evicted; kept %d entries" % len(ips))
check("the map is still bounded after churn", len(ips) <= agent.MAX_SOURCE_IPS_WATERMARK,
      "%d entries" % len(ips))

print()
if FAILURES:
    print("FAILED (%d): %s" % (len(FAILURES), ", ".join(FAILURES)))
    sys.exit(1)
print("All ingest/scale tests passed.")
