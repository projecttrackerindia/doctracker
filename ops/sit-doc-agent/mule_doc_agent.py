#!/usr/bin/env python3
"""
DocTracker SIT Auto-Discovery Agent
====================================
Tails MuleSoft application logs on this server, infers API endpoint shapes
from what's ALREADY being logged (never captures anything beyond what Mule
itself already wrote to disk), and pushes a structured draft into DocTracker
as a project named "SIT Auto-Discovery - unreviewed".

No LLM, no third-party dependencies - stdlib only, so it has the best chance
of running on a server where you can't freely pip-install. Every field
description is generated from a small naming-heuristic dictionary, not
inferred meaning - review the output before trusting it.

--- IMPORTANT: the log parser below is a BEST-EFFORT GUESS -------------------
No sample log line from this server's actual Mule config was available when
this was written. Before trusting any real output:

    python3 mule_doc_agent.py --sample-lines 50

This prints the first 50 lines it read, split into MATCHED (it found an
HTTP method+path) and UNMATCHED (it didn't), so you can see immediately
whether the parser is actually understanding your log format. If most real
request lines land in UNMATCHED, the LINE_PATTERNS list below needs tuning
to your actual log layout - see the comment above LINE_PATTERNS for how.
-------------------------------------------------------------------------------

Usage:
    python3 mule_doc_agent.py --dry-run              # parse + print, no network calls at all
    python3 mule_doc_agent.py --sample-lines 50       # print first 50 parsed/unparsed lines, then exit
    python3 mule_doc_agent.py --local-html out.html   # tail + aggregate, write a local HTML report only -
                                                       # NO network call to DocTracker at all (see below)
    python3 mule_doc_agent.py                         # real run: tail, aggregate, push to DocTracker

--- Data residency: keeping everything on this server -------------------------
DocTracker (the destination in the default mode above) is hosted on Railway,
outside India. If that's not acceptable for what ends up in the logs on this
SIT server, use --local-html instead of a real run: it tails and aggregates
exactly the same way, but renders a self-contained static HTML report to a
local file path and NEVER makes a network call anywhere - DOCTRACKER_* env
vars are not read at all in this mode. Open the file directly in a browser
(file://) on this server, or copy it wherever your data-handling rules allow.
You lose DocTracker's shared/searchable view and its audit trail, but nothing
discovered from the logs leaves this machine.
-------------------------------------------------------------------------------

Configuration is via environment variables (see CONFIG section below) so no
secrets live in this file or in source control.

--- Capture mode: aggregate (default) vs full ---------------------------------
By default this agent NEVER keeps a real captured field value - only field
names/types and running counts (CAPTURE_MODE=aggregate). Setting
CAPTURE_MODE=full is a separate, explicit opt-in that additionally captures
real per-request records (real timestamps, real latency, real field values)
to power a real log explorer/volume chart/latency KPIs in DocTracker's
Observability Console - fields named like a credential are always redacted
regardless of this setting (see SENSITIVE_FIELD_PATTERN), but every other
field value becomes real production data once this is on. See the "Capture
mode" section of AGENT_README.md before setting this to "full".
-------------------------------------------------------------------------------
"""

import os
import re
import sys
import glob
import json
import time
import platform
import hashlib
import datetime
import argparse
import collections
import http.client
import http.server
import socketserver
import threading
import posixpath
import ssl
from urllib.parse import urlparse, unquote


def stable_id(*parts):
    """Deterministic short id from stable inputs. Python's built-in hash() is
    randomized per-process (PYTHONHASHSEED) - using it here would generate a
    DIFFERENT id for the same endpoint every time the agent restarts,
    silently creating duplicate entries in DocTracker instead of updating the
    same one. md5 is fine here - this is an id, not a security boundary."""
    return hashlib.md5("|".join(parts).encode("utf-8")).hexdigest()[:10]

# ============================================================================
# CONFIG - all via environment variables. Nothing sensitive is hard-coded.
# ============================================================================
# One path, a glob, or a comma-separated list of either. A deployment with
# many Mule apps writes one log per app (jwt-token-api.log, orders-api.log,
# ...); pointing this at a single file means every other app's traffic is
# invisible, with no error to say so - the counters simply never move for
# them. `/opt/mule/logs/*.log` tails all of them in one agent, which is much
# cheaper than one agent process per file and avoids them fighting over the
# same metrics blob.
MULE_LOG_PATH = os.environ.get("MULE_LOG_PATH", "/opt/mule/logs/mule-app.log")
# Re-expanded on this interval so an app deployed (or rotated to a new name)
# after start-up is picked up without restarting the agent.
LOG_GLOB_RESCAN_SECONDS = int(os.environ.get("LOG_GLOB_RESCAN_SECONDS", "300"))
# Safety valve for a glob that matches far more than expected.
MAX_LOG_FILES = int(os.environ.get("MAX_LOG_FILES", "200"))
# A file first seen with an mtime older than this is treated as a rotated
# archive: its existing contents are skipped rather than ingested as if they
# had just happened. See tail_all_logs(). One hour comfortably covers a
# freshly rolled live file even on a quiet app, while excluding yesterday's
# archives. Set to 0 to always read newly discovered files from the top.
NEW_FILE_MAX_AGE_SECONDS = int(os.environ.get("NEW_FILE_MAX_AGE_SECONDS", "3600"))
# Regex of paths to IGNORE entirely, applied after the glob. Compressed and
# date-stamped archives are excluded by default because they are never
# ambiguous. Numeric suffixes (app-1.log) are NOT excluded by default - some
# real Mule apps genuinely end in a digit - so if your rollover uses "%i"
# with a separate unnumbered live file, add it:
#     MULE_LOG_EXCLUDE_PATTERN='-\d+\.log$|\.gz$|\.zip$|\.log\.\d'
# `\.log\.\d` covers BOTH runtime-style rotations (mule_ee.log.9,
# mule_ee.log.10) and date-stamped ones (app.log.2026-09-21). Neither is ever
# a live file, so excluding them by default is safe.
LOG_EXCLUDE_PATTERN = re.compile(
    os.environ.get("MULE_LOG_EXCLUDE_PATTERN", r"\.(gz|zip|bz2|xz|tar)$|\.log\.\d")
)
STATE_FILE = os.environ.get("AGENT_STATE_FILE", "/var/lib/doctracker-agent/state.json")

DOCTRACKER_BASE_URL = os.environ.get("DOCTRACKER_BASE_URL", "https://doctracker-production-7ecc.up.railway.app")
DOCTRACKER_USERNAME = os.environ.get("DOCTRACKER_USERNAME", "svc-doc-agent")
DOCTRACKER_PASSWORD = os.environ.get("DOCTRACKER_PASSWORD")  # required for a real (non-dry-run) push

PROJECT_ID = os.environ.get("DOCTRACKER_PROJECT_ID", "sitautodisc1")
PROJECT_NAME = "SIT Auto-Discovery - unreviewed"

POLL_INTERVAL_SECONDS = int(os.environ.get("POLL_INTERVAL_SECONDS", "60"))
PUSH_INTERVAL_SECONDS = int(os.environ.get("PUSH_INTERVAL_SECONDS", "900"))  # 15 min batches, not per-line

# --- Scale safeguards -------------------------------------------------------
# These two bound the agent's own resource use so it degrades gracefully
# instead of blocking the poll loop or growing memory/state.json without
# bound under high real traffic (e.g. ~55 req/s sustained, ~100k requests
# per 30 min). Neither touches Mule/the JVM itself - this agent only reads
# already-written log files, it never sits in the request path, so it cannot
# slow down or hang the actual API server no matter how much traffic there
# is. What it CAN do under enough traffic is fall behind reading its own
# input or grow unbounded state - these two caps stop both:
MAX_LINES_PER_CYCLE = int(os.environ.get("MAX_LINES_PER_CYCLE", "20000"))
MAX_TRACKED_ENDPOINTS = int(os.environ.get("MAX_TRACKED_ENDPOINTS", "500"))
# Per-endpoint distinct source IPs. The map is allowed to grow to the
# watermark, then pruned back to KEPT by count - see aggregate(). Keeping a
# gap between the two means pruning runs rarely (once per WATERMARK-KEPT new
# IPs) instead of on every insert once full.
MAX_SOURCE_IPS_KEPT = int(os.environ.get("MAX_SOURCE_IPS_KEPT", "50"))
MAX_SOURCE_IPS_WATERMARK = int(os.environ.get("MAX_SOURCE_IPS_WATERMARK", "200"))
# Recently-counted Mule `event:` correlation ids, so the many log lines that
# one request produces are counted as one request. Sized for roughly a
# cycle's worth of traffic plus margin - see aggregate().
MAX_SEEN_EVENTS = int(os.environ.get("MAX_SEEN_EVENTS", "20000"))

# --- Capture mode ------------------------------------------------------------
# "aggregate" (the default, and what every earlier version of this agent
# did) keeps ONLY counts/types - never a real captured value, never a raw
# log line, never a per-request record. "full" additionally builds and
# pushes real per-request log records (real timestamp, real latency, and -
# unless the field's NAME matches SENSITIVE_FIELD_PATTERN, which is always
# redacted regardless of this setting - real request/response field
# VALUES). This is an explicit, informed, opt-in choice: those values get
# written into DocTracker's database and shown in its UI to anyone with
# access to this project. Do not set this to "full" unless that's a
# decision your organisation has actually made, not a default to leave on.
# See the "Capture mode" section of AGENT_README.md before changing this.
CAPTURE_MODE = os.environ.get("CAPTURE_MODE", "aggregate").strip().lower()
if CAPTURE_MODE not in ("aggregate", "full"):
    print(f"[warn] CAPTURE_MODE={CAPTURE_MODE!r} not recognized, falling back to 'aggregate' (the safe default).", file=sys.stderr)
    CAPTURE_MODE = "aggregate"
# Ring-buffer caps for CAPTURE_MODE=full - oldest records are dropped first,
# so this never grows without bound the way MAX_TRACKED_ENDPOINTS prevents
# for the aggregate side.
MAX_LOG_RECORDS_PER_ENDPOINT = int(os.environ.get("MAX_LOG_RECORDS_PER_ENDPOINT", "200"))
MAX_LOG_RECORDS_TOTAL = int(os.environ.get("MAX_LOG_RECORDS_TOTAL", "3000"))

# One sample appended per push (every PUSH_INTERVAL_SECONDS, ~15 min by
# default) rather than per poll cycle - this is what the Observability
# page's "Log volume" chart is built from, and a ~15-min cadence keeps a
# week of real history (700 samples) in a small, cheap-to-push array instead
# of needing per-cycle (60s) resolution nobody's asking to see.
MAX_LOG_VOLUME_SAMPLES = int(os.environ.get("MAX_LOG_VOLUME_SAMPLES", "700"))

# --- Host health sampling ---------------------------------------------------
# Unlike the log-volume samples above, these are taken once per POLL cycle
# (~60s), not once per push. CPU pressure is a spiky, short-lived signal -
# a 15-minute sample would miss the exact spike you're looking for and would
# be up to 15 minutes stale by the time it's read. 720 samples at 60s is
# ~12 hours of real history in a few tens of KB.
#
# These describe THE HOST THE AGENT RUNS ON. That is only the same machine
# as the Mule runtime because this agent is deployed onto the SIT server to
# tail Mule's own log file (see "Where to install it" in AGENT_README.md).
# If you ever run the agent somewhere else - shipping logs to it rather than
# tailing them locally - these numbers describe the wrong machine and you
# should set HOST_METRICS_ENABLED=false.
# Identifies THIS agent's segment of the shared metrics blob, so several
# agents (one per Mule server) can write concurrently without overwriting
# each other - the server replaces only the named segment and composes them
# on read. See "Running more than one agent" in AGENT_README.md.
#
# It MUST be stable across restarts: a value that changes each time would
# leave an orphaned segment behind on every restart and eventually hit the
# server's writer cap. Empty (the default) means whole-blob mode, which is
# correct for a single-agent deployment and is what existing installs keep
# doing after an upgrade.
#
# This is not derived from the hostname on purpose - it ends up in a page
# that gets shared, and a real server hostname doesn't belong there. Set it
# to something meaningful but non-identifying, e.g. "mule-sit-1".
WRITER_ID = os.environ.get("DOCTRACKER_WRITER_ID", "").strip()

# Which environment THIS node serves - "SIT", "UAT", "PROD".
#
# Deliberately has NO default and is NOT inferred from the hostname. The same
# API is deployed to several environments, so a request count that silently
# mixes SIT and PROD is not a smaller truth, it's a wrong number: useless for
# capacity work and misleading for debugging. Worse, pooling would surface
# PROD source IPs and error payloads in a view someone opened for SIT.
#
# Guessing is the failure mode to avoid here, so an unset value is a hard
# error in push mode (see require_environment()) rather than a default that
# quietly lands this node's traffic in the wrong bucket.
ENVIRONMENT = os.environ.get("DOCTRACKER_ENVIRONMENT", "").strip()
# Kept short and non-identifying for the same reason as WRITER_ID: it is
# rendered on a page that gets shared.
ENVIRONMENT_PATTERN = re.compile(r'^[A-Za-z0-9][A-Za-z0-9 _-]{0,31}$')


def require_environment():
    """Called before any real push. Never in dry-run/sample mode, which write
    nothing and so can't mislabel anything."""
    if not ENVIRONMENT:
        raise SystemExit(
            "DOCTRACKER_ENVIRONMENT is not set.\n"
            "  Set it to the environment THIS server serves, e.g. SIT / UAT / PROD.\n"
            "  It has no default on purpose: metrics are stored and displayed per\n"
            "  environment, and an agent that guesses would file this node's traffic\n"
            "  under the wrong one. Nothing has been pushed.")
    if not ENVIRONMENT_PATTERN.match(ENVIRONMENT):
        raise SystemExit(
            "DOCTRACKER_ENVIRONMENT=%r is not a usable environment name.\n"
            "  Use a short label: letters, digits, spaces, '-' or '_', max 32 chars."
            % ENVIRONMENT)
    return ENVIRONMENT


HOST_METRICS_ENABLED = os.environ.get("HOST_METRICS_ENABLED", "true").strip().lower() not in ("false", "0", "no")
MAX_HOST_SAMPLES = int(os.environ.get("MAX_HOST_SAMPLES", "720"))

USER_AGENT = "DocTracker-SIT-Agent/1.0 (svc-doc-agent; see AGENT_README.md)"

# ============================================================================
# LOG LINE PATTERNS - BEST-EFFORT, TUNE THESE TO YOUR ACTUAL LOG FORMAT
# ============================================================================
# Each pattern is tried in order; the first one that matches wins. Add your
# own at the top of this list once you've seen real log lines via
# --sample-lines - these are generic guesses covering the two most common
# Mule logging styles (default log4j2 text lines, and a custom JSON Logger
# component), not a guarantee they match YOUR configuration.
LINE_PATTERNS = [
    # Style A: a custom JSON Logger component logging one JSON object per line,
    # e.g. {"correlationId":"...","method":"POST","path":"/api/x","statusCode":200,...}
    # Detected separately below (tried first, before these regexes) since it
    # doesn't need a regex at all - see parse_line().

    # Style B: default Mule/log4j2 text line mentioning an HTTP method + path,
    # e.g. "... HTTP Listener received: POST /api/insurance/premiumCalculator ..."
    re.compile(r'\b(GET|POST|PUT|PATCH|DELETE)\s+(/[^\s"\']+)', re.IGNORECASE),
]

# Correlation ID: MuleSoft's HTTP Listener/Requester logs this by default in
# many configs as X-Correlation-ID; adjust the key name if yours differs.
CORRELATION_ID_PATTERN = re.compile(r'(?:correlationId|X-Correlation-ID|CORRELATION-ID)["\s:=]+([A-Za-z0-9-]{8,})', re.IGNORECASE)
STATUS_CODE_PATTERN = re.compile(r'\b(?:status(?:Code)?)["\s:=]+(\d{3})\b', re.IGNORECASE)

# ============================================================================
# Style C - CONFIRMED against this deployment's real logs on 2026-09-23:
# a request-start line naming the HTTP method (e.g.
# "...[common-jwt-auth].post:\token:application\json:jwt-token-api-config/...")
# followed by a PRETTY-PRINTED multi-line JSON object - one key per physical
# log line, not one JSON object per line like Style A assumed. Reassembled
# below by brace-counting across lines, then the HTTP path/status/correlation
# id/payload-field-names are found by searching the parsed object's keys
# rather than assuming an exact schema, since different apps on this server
# may nest things differently.
# ============================================================================
HEADER_METHOD_PATTERN = re.compile(r'\.(GET|POST|PUT|PATCH|DELETE):', re.IGNORECASE)
# 'endpoint'/'target'/'resource'/'url' are CONFIRMED on this deployment as the
# path-carrying key in some apps' blocks (seen alongside 'method' in
# s-portal-common-api-style blocks). They're looser names than 'requestUri',
# so a value found under them must still LOOK like a path - see _path_like().
REQUEST_URI_KEY_PATTERN = re.compile(
    r'requesturi|^path$|^uri$|^url$|^endpoint$|^target$|^resource$', re.IGNORECASE)
# An explicit HTTP method carried inside a structured JSON log block.
METHOD_KEY_PATTERN = re.compile(r'^method$|httpmethod|requestmethod|^verb$', re.IGNORECASE)
HTTP_METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS")
CORR_ID_KEY_PATTERN = re.compile(r'correlationid', re.IGNORECASE)
STATUS_KEY_PATTERN = re.compile(r'httpstatus|statuscode|^status$', re.IGNORECASE)
REQUEST_PAYLOAD_KEY_PATTERN = re.compile(r'^requestpayload$', re.IGNORECASE)
RESPONSE_PAYLOAD_KEY_PATTERN = re.compile(r'^responsepayload$', re.IGNORECASE)
# X-Forwarded-For is CONFIRMED present in this deployment's own "common" block
# (see jwt-token-api.log). It's the client IP as seen by whatever's in front
# of Mule (a load balancer/proxy) - not raw TCP peer address, but the closest
# thing available from log content alone. A comma-separated chain (multiple
# hops) is possible; only the first (left-most, closest to the real client)
# hop is used - see extract_client_ip().
CLIENT_IP_KEY_PATTERN = re.compile(r'x-forwarded-for|clientip|remoteaddr|^ip$', re.IGNORECASE)
# entry/exit blocks (CONFIRMED in this deployment's real logs) each carry
# their own TimestampIST and FlowName - used for real per-request latency
# (exit minus entry) and for grouping in the log explorer, when
# CAPTURE_MODE=full. Never used in default (aggregate-only) mode.
ENTRY_BLOCK_PATTERN = re.compile(r'^entry$', re.IGNORECASE)
EXIT_BLOCK_PATTERN = re.compile(r'^exit$', re.IGNORECASE)
TIMESTAMP_KEY_PATTERN = re.compile(r'timestamp', re.IGNORECASE)
FLOWNAME_KEY_PATTERN = re.compile(r'flowname', re.IGNORECASE)

# Same pattern DESC_HEURISTICS (below) uses to describe a field as sensitive -
# duplicated here as its own standalone regex because it's used for a
# different purpose: HARD REDACTION of the field's VALUE in CAPTURE_MODE=full
# (see redact_value()), not just a description string. This is a
# non-optional safety net: CONFIRMED necessary against this deployment's own
# real jwt-token-api.log, which contained real user/password field values -
# any field whose NAME matches this is redacted regardless of CAPTURE_MODE.
SENSITIVE_FIELD_PATTERN = re.compile(r'password|passwd|secret|apikey|api_key|token|pin$|^otp', re.IGNORECASE)

# --- Log level classification (best-effort, self-diagnosing) ---------------
# Standard log4j2 output (Mule's default runtime logger) puts the level as a
# standalone word right after the timestamp/thread, near the start of the
# line, e.g. "2024-06-01 10:15:22,123 [thread] INFO  org.mule.Foo - message".
# This deployment's own confirmed format (Style C above) is a CUSTOM
# pretty-printed one, and it isn't confirmed whether its lines carry a level
# token at all, or where. So this is never trusted blindly: only the first
# LOG_LEVEL_SEARCH_PREFIX_CHARS of each line are searched (so a JSON body
# value that happens to spell one of these words deep in a request/response
# payload is never mistaken for the line's own level), and the caller tracks
# matched vs. unmatched line counts - see build_agent_health()'s
# logLevelMatchedTotal/logLevelUnmatchedTotal. The client only renders a "Log
# level distribution" panel once enough real matches exist; otherwise it
# shows an honest "not detected in this log format" state rather than a
# distribution built from too little (or no) real signal.
LOG_LEVEL_PATTERN = re.compile(r'(?<![A-Za-z0-9_])(FATAL|ERROR|WARN|INFO|DEBUG|TRACE)(?![A-Za-z0-9_])')
LOG_LEVEL_SEARCH_PREFIX_CHARS = 200


def classify_log_level(line):
    """Returns one of FATAL/ERROR/WARN/INFO/DEBUG/TRACE, or None if no level
    token was found near the start of the line."""
    m = LOG_LEVEL_PATTERN.search(line[:LOG_LEVEL_SEARCH_PREFIX_CHARS])
    return m.group(1) if m else None


def _parse_timestamp_ms(raw):
    """Best-effort parse of a Mule TimestampIST value into epoch
    milliseconds. Format isn't confirmed for every deployment, so this tries
    a few common shapes and gives up cleanly (returns None) rather than
    guessing wrong - a missing latency number is far better than a wrong
    one."""
    if raw is None:
        return None
    if isinstance(raw, (int, float)):
        # Already epoch millis (or seconds - heuristically disambiguate by
        # magnitude: a seconds value here would be ~10 digits, millis ~13).
        return raw if raw > 10**12 else raw * 1000
    s = str(raw).strip()
    if not s:
        return None
    if s.isdigit():
        n = int(s)
        return n if n > 10**12 else n * 1000
    for fmt in (
        "%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S.%fZ",
        "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M:%SZ",
        "%d/%m/%Y %H:%M:%S.%f", "%d-%m-%Y %H:%M:%S.%f",
    ):
        try:
            dt = datetime.datetime.strptime(s, fmt)
            return dt.timestamp() * 1000
        except ValueError:
            continue
    return None


def redact_value(name, value):
    """The one non-optional safety net in CAPTURE_MODE=full: a field whose
    NAME matches SENSITIVE_FIELD_PATTERN always comes back as a fixed
    placeholder, never its real value, regardless of any other setting.
    Every other value is kept but bounded in size/shape so a single huge or
    deeply-nested field can't blow up the payload: nested objects/arrays
    become a type marker (their structure is already captured separately by
    the aggregate-only field-shape tracking) and long strings are
    truncated."""
    if SENSITIVE_FIELD_PATTERN.search(name):
        return "[redacted - sensitive field name]"
    if isinstance(value, dict):
        return "[object]"
    if isinstance(value, list):
        return "[array]"
    if value is None:
        return None
    s = str(value)
    return s if len(s) <= 300 else s[:300] + "…[truncated]"


# A path segment that looks like a per-request identifier: pure numeric,
# a UUID, or a long hex/token-looking string.
PATH_ID_SEGMENT_PATTERN = re.compile(
    r'^[0-9]+$'
    r'|^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    r'|^[0-9a-fA-F]{16,}$'
)


def templatize_path(path):
    """Collapses path segments that look like per-request identifiers into a
    fixed "{id}" placeholder, so e.g. GET /orders/1001 and GET /orders/1002
    aggregate as ONE tracked endpoint instead of one distinct entry per order
    id. This is the main thing that keeps this agent scalable under high
    real traffic: without it, an endpoint called with a different id on
    every request would make state.json and the endpoint-metrics payload
    grow without bound as request volume grows - not a network/CPU problem
    (parsing a log line is trivial), but a memory/storage one. See
    MAX_TRACKED_ENDPOINTS for the hard backstop on top of this, for traffic
    patterns this heuristic doesn't catch."""
    segments = path.split("/")
    templated = ["{id}" if s and PATH_ID_SEGMENT_PATTERN.match(s) else s for s in segments]
    return "/".join(templated)


def _find_key_dict(obj, pattern):
    """DFS: first dict VALUE whose own key matches `pattern`. Used to locate
    the RequestPayload/ResponsePayload sub-object without assuming exactly
    where it's nested."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if pattern.search(k) and isinstance(v, dict):
                return v
        for v in obj.values():
            found = _find_key_dict(v, pattern)
            if found is not None:
                return found
    elif isinstance(obj, list):
        for item in obj:
            found = _find_key_dict(item, pattern)
            if found is not None:
                return found
    return None


def _find_key_value(obj, pattern):
    """DFS: first SCALAR value whose own key matches `pattern` (e.g. a path,
    a status code, a correlation id). Never returns a dict/list - this is
    only for small identifying values, never for payload content."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if pattern.search(k) and not isinstance(v, (dict, list)):
                return v
        for v in obj.values():
            found = _find_key_value(v, pattern)
            if found is not None:
                return found
    elif isinstance(obj, list):
        for item in obj:
            found = _find_key_value(item, pattern)
            if found is not None:
                return found
    return None


def assemble_multiline_observations(lines, carry):
    """Reconstructs Style C's pretty-printed multi-line JSON blocks into
    single objects, paired with the method parsed off the request-start line
    that precedes each block.

    SECURITY: only field NAMES and inferred TYPES are ever kept from a parsed
    payload (via infer_type() at the call site) - the literal captured
    VALUES (which may be credentials, even ones that look pre-encrypted, as
    seen in this deployment's own jwt-token-api RequestPayload) are discarded
    the moment this function returns. Nothing here stores or prints a real
    field value.

    `carry` is kept IN-MEMORY ONLY by the caller (never written to
    STATE_FILE) so a block split across two poll cycles still reconstructs,
    at the cost of losing one in-flight block if the agent restarts mid-block
    - an acceptable trade-off for a best-effort discovery tool, and it means
    no partially-parsed raw payload ever touches disk.

    CONFIRMED against this deployment's real jwt-token-api.log: the opening
    "{" is NOT on its own line - it's the last character of the same request-
    start line as the method (e.g. "...LoggerMessageProcessor: {"). Only the
    trailing "{" itself is kept as the start of the buffer; the log-prefix
    text before it is never valid JSON and is discarded. A standalone-"{"-
    line style is also still handled, in case a different app on this server
    logs it that way."""
    observations = []
    for line in lines:
        stripped = line.rstrip()

        if not carry["in_json"]:
            m = HEADER_METHOD_PATTERN.search(stripped)
            if m:
                carry["method"] = m.group(1).upper()
            if stripped.endswith("{"):
                # Real format: header text + trailing "{" on the same line -
                # only the brace itself starts the JSON buffer.
                carry["in_json"] = True
                carry["buffer"] = "{"
                carry["depth"] = 1
            elif stripped.lstrip().startswith("{"):
                # Fallback: a "{" alone (or starting) its own line.
                carry["in_json"] = True
                carry["buffer"] = stripped
                carry["depth"] = stripped.count("{") - stripped.count("}")
                if carry["depth"] <= 0 and carry["buffer"].strip() not in ("", "{"):
                    carry["in_json"] = False  # single-line { ... } - handled here too
                    _finish_block(carry, observations)
            continue

        carry["buffer"] += "\n" + stripped
        carry["depth"] += stripped.count("{") - stripped.count("}")
        if carry["depth"] <= 0:
            carry["in_json"] = False
            _finish_block(carry, observations)
    return observations


def _find_all_key_values(obj, pattern, out=None):
    """Every SCALAR value whose key matches `pattern`, not just the first.

    Needed because a single block can carry several FlowName keys - a
    top-level one plus one inside each of entry/exit - and only ONE of them
    is the APIkit name that encodes the HTTP method. Taking only the first
    (as _find_key_value does) threw away complete per-request records from
    s-lms-flexcube-api, whose top-level FlowName is a plain business flow
    name while the method lives on a sibling."""
    if out is None:
        out = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            if pattern.search(k) and not isinstance(v, (dict, list)):
                out.append(v)
            else:
                _find_all_key_values(v, pattern, out)
    elif isinstance(obj, list):
        for item in obj:
            _find_all_key_values(item, pattern, out)
    return out


def _path_like(value):
    """True if `value` could be an HTTP path. Guards the looser key names
    ('endpoint', 'target', 'url') against matching a hostname, a queue name
    or a free-text label. Returns the normalised path, or None."""
    if not value or isinstance(value, (dict, list, bool)):
        return None
    s = str(value).strip()
    if not s or len(s) > 2048 or " " in s:
        return None
    m = re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*://[^/]+(/.*)?$', s)
    if m:                       # absolute URL - keep only the path part
        s = m.group(1) or "/"
    if not s.startswith("/"):
        return None
    return s.split("?")[0].split("#")[0] or "/"


def _all_keys(obj, depth=0, out=None):
    """Collects every key name (not value) up to a bounded depth, for safe
    diagnostic printing - never includes a value, only structure."""
    if out is None:
        out = []
    if depth > 4 or len(out) > 60:
        return out
    if isinstance(obj, dict):
        for k, v in obj.items():
            out.append(k)
            _all_keys(v, depth + 1, out)
    elif isinstance(obj, list):
        for item in obj[:3]:
            _all_keys(item, depth + 1, out)
    return out


def extract_client_ip(obj):
    """Client IP is an identifying value, not payload content, so unlike
    request/response field VALUES it's fine to extract and keep (it's what's
    needed for the "where are hits coming from" observability view) - see
    CLIENT_IP_KEY_PATTERN's note on why X-Forwarded-For specifically."""
    raw = _find_key_value(obj, CLIENT_IP_KEY_PATTERN)
    if not raw:
        return None
    return str(raw).split(",")[0].strip() or None


def _decode_json_block(buffer):
    """json.loads, then a raw_decode retry.

    A real log line often ends with trailing text after the closing brace
    (a Mule suffix, a second object, a stack fragment), which json.loads
    rejects outright as "Extra data: line N column M". raw_decode parses the
    leading JSON value and reports where it stopped, so the record is kept
    instead of discarded over trailing noise. CONFIRMED against this
    deployment: several blocks failed only on "Extra data"."""
    try:
        return json.loads(buffer), None
    except (ValueError, TypeError) as first:
        try:
            obj, _end = json.JSONDecoder().raw_decode(buffer.lstrip())
            return obj, None
        except (ValueError, TypeError):
            return None, first


# A correlation id seen on an APIkit thread-name line carries the HTTP method.
# The SAME correlation id then appears inside that request's structured JSON
# block, which may have no method of its own. Remembering the mapping briefly
# recovers the method for those blocks WITHOUT guessing it from the payload.
# Bounded so a long-running agent can't grow this without limit.
MAX_CORRID_METHODS = int(os.environ.get("MAX_CORRID_METHODS", "5000"))
_CORRID_METHOD = collections.OrderedDict()


def remember_corrid_method(corr_id, method, path=None):
    if not corr_id or not method:
        return
    _CORRID_METHOD[corr_id] = (method, path)
    while len(_CORRID_METHOD) > MAX_CORRID_METHODS:
        _CORRID_METHOD.popitem(last=False)


def _finish_block(carry, observations):
    obj, err = _decode_json_block(carry["buffer"])
    if err is not None:
        e = err
        # Diagnostic only - never prints buffer CONTENT (it may hold real
        # captured field values), only the parse error and buffer length.
        print(f"[warn] found what looked like a JSON block (method={carry['method']}) but it failed to parse: "
              f"{e} (buffer length {len(carry['buffer'])} chars) - not counted as a match.", file=sys.stderr)
    carry["buffer"] = ""
    if isinstance(obj, dict) and not carry["method"]:
        # The method isn't always on the preceding line. A structured JSON
        # logger - confirmed on this deployment, with keys like RequestUri /
        # FlowName / statusCode / X-Forwarded-For / TimestampIST - carries it
        # INSIDE the block instead, either as an explicit method key or
        # implied by an APIkit FlowName ("post:\token:application\json:...").
        # Without this, a complete per-request record with a real status code
        # and client IP was being parsed and then thrown away for want of one
        # field.
        explicit = _find_key_value(obj, METHOD_KEY_PATTERN)
        if explicit and str(explicit).upper() in HTTP_METHODS:
            carry["method"] = str(explicit).upper()
        else:
            # EVERY FlowName in the block, not just the first - a block can
            # carry a plain business flow name at the top and the APIkit name
            # on a nested entry/exit sibling.
            for flow_any in _find_all_key_values(obj, FLOWNAME_KEY_PATTERN):
                m = APIKIT_FLOW_PATTERN.search(str(flow_any))
                if m:
                    carry["method"] = m.group(1).upper()
                    break

    if isinstance(obj, dict) and not carry["method"]:
        # Last resort, and the only one that needs no guessing: this block's
        # own correlation id was already seen on an APIkit thread-name line.
        seen = _CORRID_METHOD.get(str(_find_key_value(obj, CORR_ID_KEY_PATTERN) or ""))
        if seen:
            carry["method"] = seen[0]

    if isinstance(obj, dict) and not carry["method"]:
        print(f"[warn] parsed a JSON block successfully but no HTTP method was captured - not counted as a "
              f"match. Looked on the preceding line (HEADER_METHOD_PATTERN), for a method-like key, and for "
              f"an APIkit FlowName inside the block. Key names seen: "
              f"{sorted(set(_all_keys(obj)))}", file=sys.stderr)
    if isinstance(obj, dict) and carry["method"]:
        path = None
        for cand in _find_all_key_values(obj, REQUEST_URI_KEY_PATTERN):
            path = _path_like(cand)
            if path:
                break
        if not path:
            print(f"[warn] parsed a JSON block (method={carry['method']}) but found no path-like key "
                  f"(looked for a name matching 'requesturi'/'path'/'uri'). Top-level/nested key names seen: "
                  f"{sorted(set(_all_keys(obj)))} - adjust REQUEST_URI_KEY_PATTERN if your real key is named "
                  f"differently.", file=sys.stderr)
        if path:
            req_payload = _find_key_dict(obj, REQUEST_PAYLOAD_KEY_PATTERN)
            resp_payload = _find_key_dict(obj, RESPONSE_PAYLOAD_KEY_PATTERN)
            entry_block = _find_key_dict(obj, ENTRY_BLOCK_PATTERN)
            exit_block = _find_key_dict(obj, EXIT_BLOCK_PATTERN)
            entry_ts = _parse_timestamp_ms(_find_key_value(entry_block, TIMESTAMP_KEY_PATTERN)) if entry_block else None
            exit_ts = _parse_timestamp_ms(_find_key_value(exit_block, TIMESTAMP_KEY_PATTERN)) if exit_block else None
            latency_ms = round(exit_ts - entry_ts) if (entry_ts is not None and exit_ts is not None and exit_ts >= entry_ts) else None
            flow_name = (exit_block and _find_key_value(exit_block, FLOWNAME_KEY_PATTERN)) or \
                        (entry_block and _find_key_value(entry_block, FLOWNAME_KEY_PATTERN))
            observations.append({
                "method": carry["method"],
                "path": path,
                "statusCode": _find_key_value(obj, STATUS_KEY_PATTERN),
                "correlationId": _find_key_value(obj, CORR_ID_KEY_PATTERN),
                "body": req_payload if isinstance(req_payload, dict) else None,
                "responseBody": resp_payload if isinstance(resp_payload, dict) else None,
                "clientIp": extract_client_ip(obj),
                "latencyMs": latency_ms,
                "flowName": str(flow_name) if flow_name else None,
                "exitTsMs": exit_ts,
            })
    carry["method"] = None

# ============================================================================
# Naming-heuristic description generator - same approach used to backfill
# field descriptions in DocTracker earlier in this engagement. No LLM: a
# small dictionary of regexes matched against the field's own name.
# ============================================================================
DESC_HEURISTICS = [
    (re.compile(r'password|passwd|secret|apikey|api_key|token|pin$|^otp', re.I),
     "Sensitive credential/secret field. This agent never captures or stores the actual value - field name and type only."),
    (re.compile(r'statuscode|statusCode$', re.I), "Status code."),
    (re.compile(r'errortype', re.I), "Machine-readable error category."),
    (re.compile(r'errorcode', re.I), "Machine-readable error code."),
    (re.compile(r'errormessage|^error$', re.I), "Error description."),
    (re.compile(r'description', re.I), "Human-readable detail."),
    (re.compile(r'^message$', re.I), "Human-readable message."),
    (re.compile(r'^(id|.*id)$', re.I), "Identifier."),
    (re.compile(r'(date|_at)$', re.I), "Timestamp."),
    (re.compile(r'^is[A-Z_]|^has[A-Z_]', re.I), "Boolean flag."),
    (re.compile(r'email', re.I), "Email address."),
    (re.compile(r'phone|mobile', re.I), "Phone number."),
    (re.compile(r'amount|amt', re.I), "Monetary amount."),
    (re.compile(r'name$', re.I), "Name."),
]


def guess_description(field_name):
    for rx, desc in DESC_HEURISTICS:
        if rx.search(field_name):
            return desc + " [auto-generated from field name - needs human review]"
    return "[auto-discovered field - description needs human review]"


def infer_type(value):
    if isinstance(value, bool):
        return "Boolean"
    if isinstance(value, int):
        return "Integer"
    if isinstance(value, float):
        return "Number"
    if value is None:
        return "String"
    if isinstance(value, list):
        return "Array"
    if isinstance(value, dict):
        return "Object"
    return "String"


# ============================================================================
# Log tailing (restart-safe: remembers byte offset across runs/log rotation)
# ============================================================================
def load_state():
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"offset": 0, "inode": None, "endpoints": {}, "last_push": 0}


def save_state(state):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f)
    os.replace(tmp, STATE_FILE)


def tail_new_lines(path, state, max_lines=None):
    """Reads any lines appended since the last recorded offset. Detects log
    rotation (inode change or file shrank) and restarts from the top of the
    new file rather than crashing or silently missing the rotated-out tail.

    `max_lines` bounds how much a SINGLE call reads (default: unbounded).
    This is what stops a large backlog (e.g. the agent falling behind
    briefly, or a burst of ~100k requests in a short window) from turning
    one poll cycle into one huge blocking read-and-process pass - see
    MAX_LINES_PER_CYCLE and run()'s catch-up loop, which calls this
    repeatedly in bounded chunks instead of once unbounded.

    CONFIRMED bug found against the real, actively-growing jwt-token-api.log:
    the original version used `for line in f: ...` then `f.tell()` at the
    end, which happily returns a LAST "line" that has no trailing newline
    yet (the writer hasn't finished it at the moment we read), then advances
    the offset PAST that partial content. The next poll cycle then only sees
    the REMAINDER of that line once it's completed - which looks like a
    brand new, out-of-context line (e.g. just `"RequestPayload": {` on its
    own), desyncing the multi-line JSON brace counter for every block after
    it. Fixed by reading line-by-line via readline() and only ever
    committing the offset past a line that actually ends in "\\n" - an
    incomplete trailing line is left unread and picked up whole next cycle."""
    try:
        st = os.stat(path)
    except (FileNotFoundError, PermissionError) as e:
        # A glob can match a file that disappears between expansion and read
        # (rotation), or one this unprivileged user can't open. Neither is
        # fatal - skip it this cycle.
        print(f"[warn] cannot read log file {path}: {e.__class__.__name__}", file=sys.stderr)
        return []

    inode = getattr(st, "st_ino", None)
    if state.get("inode") is not None and inode != state.get("inode"):
        state["offset"] = 0  # rotated - a new file, start from its beginning
    elif st.st_size < state.get("offset", 0):
        state["offset"] = 0  # truncated/rotated in place

    state["inode"] = inode
    # setdefault, not state["offset"]: callers legitimately pass a fresh dict
    # for a file they've never read (--sample-lines does, per file), and
    # indexing directly raised KeyError for them.
    state.setdefault("offset", 0)
    lines = []
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        f.seek(state["offset"])
        while True:
            if max_lines is not None and len(lines) >= max_lines:
                break  # bounded chunk full - remainder stays for the next call, offset only advances past what we took
            pos_before = f.tell()
            line = f.readline()
            if not line:
                break  # EOF - nothing more written yet
            if line.endswith("\n"):
                lines.append(line.rstrip("\n"))
            else:
                # Partial line - writer hasn't finished it. Don't consume it;
                # rewind so the WHOLE line is re-read next cycle.
                f.seek(pos_before)
                break
        state["offset"] = f.tell()
    return lines


def read_last_lines(path, max_lines, max_bytes=2 * 1024 * 1024):
    """Read up to `max_lines` from the END of a file.

    --sample-lines used to read from offset 0, which on a long-lived log
    shows the first lines ever written to it - on a real deployment that is
    the Mule startup banner from whenever the app was last deployed, possibly
    months ago, and contains no HTTP traffic at all. Every file then reports
    a 0% parse rate and the diagnostic says "your format is unsupported" when
    the truth is "you looked at the wrong end of the file".

    Reads the trailing `max_bytes` in binary and decodes, rather than seeking
    in text mode (a text-mode seek to an arbitrary byte offset is not
    supported and can raise). The first line of the window is dropped when
    the window doesn't start at byte 0, since it is almost certainly a
    partial line."""
    try:
        size = os.path.getsize(path)
    except OSError:
        return []
    start = max(0, size - max_bytes)
    try:
        with open(path, "rb") as f:
            f.seek(start)
            data = f.read()
    except OSError as e:
        print("[warn] cannot read %s: %s" % (path, e.__class__.__name__), file=sys.stderr)
        return []
    lines = data.decode("utf-8", "replace").splitlines()
    if start and lines:
        lines = lines[1:]
    return lines[-max_lines:] if max_lines else lines


def resolve_log_paths(spec):
    """Expand MULE_LOG_PATH into the concrete files to tail.

    Accepts a plain path, a glob, or a comma-separated list of either.
    Already-rotated files (`.1`, `.gz`, dated suffixes) are deliberately NOT
    excluded here - if a glob matches them the offsets simply start at their
    end, because this agent only ever reads what is APPENDED after it first
    sees a file. Reading a rotated file from the top would re-count history
    that is already in the counters."""
    paths = []
    for part in str(spec).split(","):
        part = part.strip()
        if not part:
            continue
        if any(ch in part for ch in "*?["):
            paths.extend(glob.glob(part))
        else:
            paths.append(part)
    # Stable order so round-robin fairness below is deterministic, and
    # de-duplicated in case two patterns overlap.
    unique = sorted(set(os.path.abspath(p) for p in paths))
    excluded = [p for p in unique if LOG_EXCLUDE_PATTERN.search(p)]
    if excluded:
        unique = [p for p in unique if p not in set(excluded)]
    unique = [p for p in unique if os.path.isfile(p)]
    if len(unique) > MAX_LOG_FILES:
        # Keep the MOST RECENTLY WRITTEN files, not the alphabetically first.
        # A real Mule log directory is overwhelmingly rotated archives - one
        # production node here has 676 files for ~70 apps - and truncating
        # alphabetically would keep `app-1.log ... app-10.log` (all dead
        # archives) and silently drop the live `app.log` that is the only
        # one still being written to.
        by_mtime = []
        for p in unique:
            try:
                by_mtime.append((os.stat(p).st_mtime, p))
            except OSError:
                continue
        by_mtime.sort(reverse=True)
        kept = sorted(p for _, p in by_mtime[:MAX_LOG_FILES])
        print(f"[warn] {len(unique)} files matched {spec!r}, which is over MAX_LOG_FILES="
              f"{MAX_LOG_FILES}. Tailing the {len(kept)} most recently written and IGNORING the rest. "
              f"This usually means the pattern is matching rotated archives as well as live logs - "
              f"set MULE_LOG_EXCLUDE_PATTERN (see AGENT_README.md) rather than just raising the cap.",
              file=sys.stderr)
        unique = kept
    return unique


def tail_all_logs(paths, state, total_budget):
    """Read new lines from EVERY tailed file, sharing one line budget.

    Returns {path: [lines]} so the caller can keep each file's multi-line
    JSON assembly separate - a JSON block spans lines within ONE file, and
    interleaving two files' lines into a single stream would corrupt the
    brace counter for both.

    The budget is divided evenly rather than spent first-come-first-served,
    so one very busy log can't starve the other 69. Any budget the quiet
    files don't use is handed to the remaining ones in a second pass, so a
    single busy file still gets the full budget when it's the only one with
    a backlog."""
    files_state = state.setdefault("files", {})
    if not paths:
        return {}

    # Rolled-over archives are the hazard here, not live logs. A typical Mule
    # log directory is mostly 10MB archives (app-1.log, app-2.log, ... or
    # app.log.2026-09-21) that will never be appended to again. Starting a
    # newly-DISCOVERED file at offset 0 would ingest all of them from the top
    # on first start - gigabytes of historical traffic counted as if it had
    # just happened - and, under a %i scheme where rollover RENAMES files, it
    # would re-ingest the same content every time it shifted index.
    #
    # So discovery is decided by mtime, which handles both schemes:
    #   * an archive has an old mtime (a rename preserves it) -> skip its
    #     history by starting at its current end; it never grows again, so
    #     nothing is lost;
    #   * a freshly rolled LIVE file has a recent mtime -> start at 0 and
    #     read it whole, so nothing written between rollover and discovery
    #     is missed.
    for path in paths:
        if path in files_state:
            continue
        try:
            st = os.stat(path)
        except OSError:
            continue
        stale = (time.time() - st.st_mtime) > NEW_FILE_MAX_AGE_SECONDS
        files_state[path] = {
            "offset": st.st_size if stale else 0,
            "inode": getattr(st, "st_ino", None),
        }
        if stale:
            # Says "not recently written" rather than "rotated archive": a
            # file untouched for an hour is usually just an idle app, and
            # calling that an archive misreads a normal quiet period as a
            # rotation. The HANDLING is the same either way - start at the
            # end - so only the wording was wrong.
            print(f"[info] {os.path.basename(path)}: not written for "
                  f"{int((time.time() - st.st_mtime) / 60)} min (idle app or rotated archive) - "
                  f"starting at the end, skipping its {st.st_size / 1048576:.1f} MB of history. "
                  f"Anything appended from now on is read.")

    per_file = max(1, total_budget // len(paths))
    out = {}
    used = 0
    # Pass 1: fair share.
    for path in paths:
        fstate = files_state.setdefault(path, {"offset": 0, "inode": None})
        lines = tail_new_lines(path, fstate, max_lines=per_file)
        if lines:
            out[path] = lines
            used += len(lines)

    # Pass 2: redistribute whatever pass 1 left unspent to files that filled
    # their share (i.e. still have a backlog).
    leftover = total_budget - used
    if leftover > 0:
        hungry = [p for p in paths if len(out.get(p, [])) >= per_file]
        if hungry:
            extra = max(1, leftover // len(hungry))
            for path in hungry:
                if leftover <= 0:
                    break
                fstate = files_state[path]
                more = tail_new_lines(path, fstate, max_lines=min(extra, leftover))
                if more:
                    out.setdefault(path, []).extend(more)
                    leftover -= len(more)

    # Drop state for files that no longer exist, so state.json can't grow
    # forever as dated log names come and go.
    for gone in [p for p in files_state if p not in paths]:
        del files_state[gone]
    return out


def migrate_single_file_state(state, paths):
    """Move a pre-multi-file state.json onto the per-file model.

    Older builds kept one top-level `offset`/`inode` for the single
    MULE_LOG_PATH. Dropping those would make the agent re-read that file
    from its current end (losing nothing) or from the top (double-counting),
    so they're carried onto the matching path instead."""
    if "offset" not in state and "inode" not in state:
        return
    files_state = state.setdefault("files", {})
    legacy_path = os.path.abspath(MULE_LOG_PATH) if not any(ch in MULE_LOG_PATH for ch in "*?[,") else None
    if legacy_path and legacy_path in paths and legacy_path not in files_state:
        files_state[legacy_path] = {"offset": state.get("offset", 0), "inode": state.get("inode")}
        print(f"[info] migrated existing read position for {os.path.basename(legacy_path)} "
              f"to the multi-file state model")
    state.pop("offset", None)
    state.pop("inode", None)


# ============================================================================
# Line parsing
# ============================================================================
# --- Style D: APIkit flow names -------------------------------------------
# Mule does NOT log a line per HTTP request by default, so "HTTP Listener
# received: POST /x" (Style B) simply never appears in most deployments.
# What DOES appear, on EVERY line a flow logs while handling a request, is
# the APIkit flow name inside the thread name:
#
#   [[MuleRuntime].uber.37: [common-jwt-auth].post:\token:application\json:
#    jwt-token-api-config/processors/2.CPU_INTENSIVE @52800c94]
#    [processor: common-logger-flow/processors/0; event: ea4101a1-b7d2-...]
#
# That gives method (post), path (\token) and, from `event:`, a correlation
# id. The same name also appears at startup as
# "Starting flow: post:\userEncrypt:application\json:jwt-token-api-config",
# which enumerates an app's whole API surface before it serves any traffic.
#
# APIkit writes paths with backslashes and (param) placeholders:
#   post:\customers\(customerId)\orders  ->  POST /customers/{customerId}/orders
APIKIT_FLOW_PATTERN = re.compile(
    r'(?<![A-Za-z0-9_])(get|post|put|patch|delete|head|options):\\([^\s:\]/]*)',
    re.IGNORECASE,
)
# The `event:` field is Mule's own correlation id. It is the ONLY reliable way
# to tell how many REQUESTS produced a set of lines - one request commonly
# logs a dozen lines, all sharing this id, so counting lines would overcount
# traffic by an order of magnitude.
MULE_EVENT_PATTERN = re.compile(r'event:\s*([0-9a-fA-F][0-9a-fA-F-]{7,})')
# Startup inventory line.
STARTING_FLOW_PATTERN = re.compile(r'Starting flow:\s*(\S+)')


def apikit_path_to_uri(raw):
    """`\\customers\\(customerId)\\orders` -> `/customers/{customerId}/orders`."""
    if not raw:
        return "/"
    path = raw.replace("\\", "/")
    path = re.sub(r'\(([^)]+)\)', r'{\1}', path)
    if not path.startswith("/"):
        path = "/" + path
    return path


def parse_apikit_line(stripped):
    """Style D - see APIKIT_FLOW_PATTERN. Returns an observation, or None.

    `isInventory` marks a startup "Starting flow:" line: it proves the
    endpoint EXISTS but represents no traffic, so aggregate() must not count
    it as a request."""
    m = APIKIT_FLOW_PATTERN.search(stripped)
    if not m:
        return None
    # The flow name can appear with the path segment empty (`post:\`), which
    # is APIkit's own root resource.
    method = m.group(1).upper()
    path = apikit_path_to_uri(m.group(2))
    is_inventory = bool(STARTING_FLOW_PATTERN.search(stripped))
    event_m = MULE_EVENT_PATTERN.search(stripped)
    status_m = STATUS_CODE_PATTERN.search(stripped)
    if event_m and not is_inventory:
        # So a structured JSON block logged later under this same correlation
        # id can recover the method without guessing it (see _finish_block).
        remember_corrid_method(event_m.group(1), method, path)
    return {
        "method": method,
        "path": path,
        "statusCode": int(status_m.group(1)) if status_m else None,
        "correlationId": event_m.group(1) if event_m else None,
        "body": None,
        "isInventory": is_inventory,
        "style": "apikit",
    }


def parse_line(line):
    """Returns a dict {method, path, statusCode, correlationId, body} or None
    if this line doesn't look like an HTTP call at all. `body` is only
    populated if the line ITSELF already contains a JSON payload - this
    never reaches into anything beyond what's already in the log line."""
    stripped = line.strip()

    # Style A: whole line (or a JSON object embedded in it) is JSON.
    json_start = stripped.find("{")
    if json_start != -1:
        candidate = stripped[json_start:]
        try:
            obj = json.loads(candidate)
            if isinstance(obj, dict):
                method = obj.get("method") or obj.get("httpMethod")
                path = obj.get("path") or obj.get("uri") or obj.get("url")
                if method and path:
                    return {
                        "method": str(method).upper(),
                        "path": str(path).split("?")[0],
                        "statusCode": obj.get("statusCode") or obj.get("status"),
                        "correlationId": obj.get("correlationId") or obj.get("correlationID"),
                        "body": obj.get("body") or obj.get("payload") or obj.get("requestBody") or obj.get("responseBody"),
                    }
        except (ValueError, TypeError):
            pass  # not actually JSON, or not the shape we expect - fall through

    # Style B: regex over a plain text log line.
    for pattern in LINE_PATTERNS:
        m = pattern.search(stripped)
        if m and len(m.groups()) >= 2:
            method, path = m.group(1).upper(), m.group(2).split("?")[0]
            corr_m = CORRELATION_ID_PATTERN.search(stripped)
            status_m = STATUS_CODE_PATTERN.search(stripped)
            return {
                "method": method,
                "path": path,
                "statusCode": int(status_m.group(1)) if status_m else None,
                "correlationId": corr_m.group(1) if corr_m else None,
                "body": None,  # plain-text lines essentially never carry a parseable body
            }

    # Style D last: it matches a substring of the thread name, so it must not
    # pre-empt an explicit "HTTP Listener received:" line that carries a real
    # status code and a fuller path.
    return parse_apikit_line(stripped)


# ============================================================================
# Aggregation - builds up one record per distinct (method, path)
#
# SECURITY: only field NAMES and inferred TYPES are ever retained here, via
# infer_type() - never a literal captured value. Confirmed necessary against
# this deployment's own real logs: a jwt-token-api request body included
# `user`/`password` fields, which must never be echoed anywhere this agent
# writes (local HTML report or a DocTracker push), even though they looked
# pre-encrypted - the agent has no way to know that's true for every field
# on every endpoint, so field values are dropped unconditionally.
# ============================================================================
OVERFLOW_KEY = "* OVERFLOW - too many distinct endpoints"


def aggregate(state, observations):
    endpoints = state.setdefault("endpoints", {})
    health = state.setdefault("health", {})
    now_iso = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
    # Style D (APIkit thread names) matches EVERY line a flow logs while
    # handling one request - commonly a dozen or more, all carrying the same
    # `event:` id. Counting each as a request would inflate traffic by an
    # order of magnitude, so each event id is counted once. The seen-list is
    # persisted in state because a single request's lines routinely straddle
    # two poll cycles, and it is capped so it can't grow without bound.
    seen_events = state.setdefault("seenEvents", [])
    seen_lookup = set(seen_events)
    for obs in observations:
        counts_as_request = True
        if obs.get("style") == "apikit":
            if obs.get("isInventory"):
                # A startup "Starting flow:" line proves the endpoint exists
                # but represents no traffic whatsoever.
                counts_as_request = False
            else:
                event_id = obs.get("correlationId")
                if not event_id:
                    # No event id means no way to tell this line apart from
                    # the other lines of the same request. Register the
                    # endpoint, but don't guess at a count.
                    counts_as_request = False
                else:
                    dedup_key = "%s %s %s" % (obs["method"], obs["path"], event_id)
                    if dedup_key in seen_lookup:
                        counts_as_request = False
                    else:
                        seen_lookup.add(dedup_key)
                        seen_events.append(dedup_key)
                        if len(seen_events) > MAX_SEEN_EVENTS:
                            dropped = seen_events[:len(seen_events) - MAX_SEEN_EVENTS]
                            del seen_events[:len(seen_events) - MAX_SEEN_EVENTS]
                            seen_lookup.difference_update(dropped)
        templated_path = templatize_path(obs["path"])
        key = f"{obs['method']} {templated_path}"
        if key not in endpoints and len(endpoints) >= MAX_TRACKED_ENDPOINTS:
            # Hard backstop on top of templatize_path(): whatever traffic
            # pattern is still producing new distinct keys past the cap
            # (MAX_TRACKED_ENDPOINTS, default 500) gets folded into one
            # shared bucket instead of growing state.json/the metrics push
            # forever. Counted in health so it's visible on the
            # Observability page rather than silently dropped.
            key = OVERFLOW_KEY
            health["overflowObservations"] = health.get("overflowObservations", 0) + 1
            ep = endpoints.setdefault(key, {
                "method": "*", "path": "(too many distinct endpoints to track individually - see Agent Health)",
                "statusCodes": {}, "correlationIds": [], "fieldShapes": {},
                "responseFieldShapes": {}, "statusesWithErrorLikeFields": [],
                "totalRequests": 0, "sourceIps": {}, "lastSeenAt": None,
            })
        else:
            ep = endpoints.setdefault(key, {
                "method": obs["method"], "path": templated_path,
                "statusCodes": {}, "correlationIds": [], "fieldShapes": {},
                "responseFieldShapes": {}, "statusesWithErrorLikeFields": [],
                "totalRequests": 0, "sourceIps": {}, "lastSeenAt": None,
            })
        if counts_as_request:
            ep["totalRequests"] += 1
        else:
            # Seen but not counted: a startup inventory line, or another line
            # belonging to a request already counted. Tracked so the Agent
            # Health card can show discovery is working even where traffic
            # counts stay at zero.
            ep["discoveredOnly"] = ep.get("discoveredOnly", 0) + 1
        # `now_iso` is formatted ONCE per aggregate() call, not once per
        # observation. At 800+ requests/sec that strftime+gmtime pair was one
        # of the hottest things in the whole agent, and every observation in
        # a batch lands within the same cycle anyway.
        ep["lastSeenAt"] = now_iso
        if obs.get("clientIp"):
            ips = ep["sourceIps"]
            ip = obs["clientIp"]
            if ip in ips:
                ips[ip] += 1
            else:
                # Previously: `elif len(ips) < 50`, which meant that once 50
                # distinct IPs had been seen, every NEW IP was dropped
                # forever - so "Top source IPs" silently became "the first 50
                # IPs seen since the last restart". At low volume that's
                # harmless; with many clients a genuinely dominant new caller
                # could never appear, which is worse than incomplete - it's
                # misleading.
                #
                # Now every IP is admitted and the map is pruned back to the
                # heaviest MAX_SOURCE_IPS_KEPT once it grows past the
                # watermark. Counts of survivors are preserved, so a heavy
                # hitter that appears late still climbs. This is lossy
                # (a long tail of one-hit IPs is discarded, and an IP pruned
                # and later re-seen restarts its count), which is the right
                # trade for an observability sample rather than an access log.
                ips[ip] = 1
                if len(ips) > MAX_SOURCE_IPS_WATERMARK:
                    for dead in sorted(ips, key=ips.get)[:len(ips) - MAX_SOURCE_IPS_KEPT]:
                        del ips[dead]
        if obs.get("statusCode"):
            sc = str(obs["statusCode"])
            ep["statusCodes"][sc] = ep["statusCodes"].get(sc, 0) + 1
            resp_body = obs.get("responseBody")
            if isinstance(resp_body, dict):
                for k, v in resp_body.items():
                    ep["responseFieldShapes"][k] = infer_type(v)
                if any(re.search(r'^error|errorcode|errormessage', k, re.I) for k in resp_body) \
                        and sc == "200" and sc not in ep["statusesWithErrorLikeFields"]:
                    ep["statusesWithErrorLikeFields"].append(sc)
        if obs.get("correlationId") and obs["correlationId"] not in ep["correlationIds"]:
            if len(ep["correlationIds"]) < 20:  # cap - this is just a discovery sample, not an audit trail
                ep["correlationIds"].append(obs["correlationId"])
        if isinstance(obs.get("body"), dict):
            shapes = ep["fieldShapes"]
            for k, v in obs["body"].items():
                shapes[k] = infer_type(v)

        if CAPTURE_MODE == "full" and key != OVERFLOW_KEY:
            capture_log_record(state, key, obs)


# ============================================================================
# CAPTURE_MODE=full only: real per-request records (real timestamp, real
# latency where entry/exit timestamps parsed, real field VALUES except for
# anything SENSITIVE_FIELD_PATTERN matches by name, which is ALWAYS
# redacted - see redact_value()). Two ring-buffer caps (per-endpoint and
# global) keep this bounded; oldest records are dropped first, same
# trade-off the aggregate side already makes for correlationIds/sourceIps.
# ============================================================================
def capture_log_record(state, key, obs):
    records = state.setdefault("logRecords", [])
    record = {
        "key": key,
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(obs["exitTsMs"] / 1000)) if obs.get("exitTsMs") else time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
        "method": obs["method"], "path": templatize_path(obs["path"]),
        "statusCode": obs.get("statusCode"),
        "correlationId": obs.get("correlationId"),
        "clientIp": obs.get("clientIp"),
        "latencyMs": obs.get("latencyMs"),
        "flowName": obs.get("flowName"),
    }
    if isinstance(obs.get("body"), dict):
        record["requestFields"] = {k: redact_value(k, v) for k, v in obs["body"].items()}
    if isinstance(obs.get("responseBody"), dict):
        record["responseFields"] = {k: redact_value(k, v) for k, v in obs["responseBody"].items()}
    records.append(record)

    # Per-endpoint cap: drop the oldest record for THIS key once it's over
    # the limit, rather than letting one busy endpoint crowd out every
    # other endpoint's records from the global list.
    same_key_indices = [i for i, r in enumerate(records) if r["key"] == key]
    if len(same_key_indices) > MAX_LOG_RECORDS_PER_ENDPOINT:
        del records[same_key_indices[0]]
    # Global cap, oldest-first, applied last so it's the final backstop.
    if len(records) > MAX_LOG_RECORDS_TOTAL:
        del records[0: len(records) - MAX_LOG_RECORDS_TOTAL]


def build_log_records(state):
    return state.get("logRecords", []) if CAPTURE_MODE == "full" else []


# ============================================================================
# Anomaly flags - mechanical only, no semantic guessing. Works off field
# NAMES observed in response shapes, never captured values (see note above).
# ============================================================================
def anomaly_notes(ep):
    notes = []
    codes = list(ep["statusCodes"].keys())
    if ep.get("statusesWithErrorLikeFields"):
        notes.append("A 200 response was observed with a field named error/errorCode/errorMessage - "
                      "possible business-error-returned-as-200 pattern (see this engagement's earlier "
                      "F-04-style findings). Needs human review, not auto-flagged as broken.")
    if len(codes) >= 4:
        notes.append(f"{len(codes)} distinct status codes observed ({', '.join(sorted(codes))}) - "
                      "worth confirming which are documented, expected outcomes vs. undocumented edge cases.")
    total = sum(ep["statusCodes"].values())
    errors = sum(c for sc, c in ep["statusCodes"].items() if sc and sc[0] in ("4", "5"))
    if total >= 5 and errors / total >= 0.25:
        notes.append(f"High error rate: {errors}/{total} ({errors/total:.0%}) of observed responses were 4xx/5xx - "
                      "see the Observability page for the full breakdown and source IPs.")
    return notes


# ============================================================================
# DocTracker API client - stdlib http.client only, mirrors the same
# login -> PUT /api/workspace/projects flow used manually throughout this
# engagement.
# ============================================================================
class DocTrackerClient:
    def __init__(self, base_url, username, password):
        self.base = urlparse(base_url)
        self.username = username
        self.password = password
        self.cookie = None

    def _conn(self):
        ctx = ssl.create_default_context()
        return http.client.HTTPSConnection(self.base.hostname, self.base.port or 443, context=ctx, timeout=30)

    def _request(self, method, path, body=None, auth=True):
        conn = self._conn()
        headers = {"Content-Type": "application/json", "User-Agent": USER_AGENT}
        if auth and self.cookie:
            headers["Cookie"] = self.cookie
        payload = json.dumps(body).encode("utf-8") if body is not None else None
        conn.request(method, path, body=payload, headers=headers)
        resp = conn.getresponse()
        data = resp.read()
        conn.close()
        try:
            parsed = json.loads(data) if data else {}
        except ValueError:
            parsed = {"raw": data.decode("utf-8", "replace")}
        return resp.status, parsed, resp.getheader("Set-Cookie")

    def login(self):
        status, data, set_cookie = self._request(
            "POST", "/api/auth/login",
            {"identifier": self.username, "password": self.password}, auth=False,
        )
        if status != 200:
            raise RuntimeError(f"DocTracker login failed ({status}): {data}")
        # Keep only the as_session cookie's name=value, drop attributes.
        self.cookie = set_cookie.split(";")[0] if set_cookie else None
        print(f"[info] logged in to DocTracker as {self.username}")

    def get_workspace(self):
        status, data, _ = self._request("GET", "/api/workspace")
        if status != 200:
            raise RuntimeError(f"GET /api/workspace failed ({status}): {data}")
        return data

    def push_project(self, project):
        status, data, _ = self._request("PUT", "/api/workspace/projects", {"projects": {PROJECT_ID: project}})
        if status != 200 or not data.get("ok"):
            raise RuntimeError(f"PUT /api/workspace/projects failed ({status}): {data}")
        if PROJECT_ID in data.get("conflicts", []):
            raise RuntimeError("Write conflict - project was modified elsewhere since last fetch; will retry next cycle.")
        print(f"[info] pushed {PROJECT_ID}: {data}")

    def push_endpoint_metrics(self, payload, if_match_rev=None):
        # `payload` is {"endpoints": {...}, "agentHealth": {...}, ...} - a
        # WHOLE-BLOB overwrite, so if a second agent is running (a stale
        # systemd unit, a manual debug run alongside the service, another
        # server) whichever pushes last silently erases the other's entire
        # history.
        #
        # `if_match_rev` is the revision this agent last read via
        # get_workspace(). The server rejects the write with 409 if the blob
        # has changed since - see PUT /endpoint-metrics in
        # server/routes/workspace.js. Passing None keeps the old
        # unconditional behaviour, which is what --dry-run and a first-ever
        # push (no existing blob) use.
        body = {"endpointMetrics": payload}
        if WRITER_ID:
            # Merge mode: claim only this agent's segment. Conflicts are
            # impossible by construction, so no ifMatchRev is sent.
            body["writerId"] = WRITER_ID
        elif if_match_rev is not None:
            body["ifMatchRev"] = if_match_rev
        status, data, _ = self._request("PUT", "/api/workspace/endpoint-metrics", body)
        if status == 409:
            # Deliberately NOT retried by force. Another writer is active and
            # forcing this payload through is exactly the data loss the check
            # exists to prevent. Next cycle re-reads and pushes cleanly; if
            # this repeats, there are genuinely two agents running.
            raise RuntimeError(
                "Write conflict on endpoint metrics - the stored data changed since this agent "
                "last read it, which usually means a SECOND agent is running against the same "
                "organisation. Skipping this push rather than overwriting the other writer's "
                "data. If this repeats every cycle, check for a duplicate service "
                "(systemctl list-units '*doctracker*') or a manual run. Server said: "
                f"{data.get('error')}"
            )
        if status != 200 or not data.get("ok"):
            raise RuntimeError(f"PUT /api/workspace/endpoint-metrics failed ({status}): {data}")
        print(f"[info] pushed endpoint metrics for {len(payload.get('endpoints', {}))} endpoint(s) "
              f"+ agent health: {data}")


# ============================================================================
# Build the endpoint-metrics payload (hits, error rate, source IPs) - a
# SEPARATE store from the doc-discovery project above, pushed to its own
# endpoint (PUT /api/workspace/endpoint-metrics), never merged into project
# data. See CLIENT_IP_KEY_PATTERN's note: IPs are identifying values kept
# on purpose (this is what the observability view is for), unlike request/
# response field VALUES, which are never kept anywhere in this agent.
# ============================================================================
def _read_proc_stat_cpu():
    """Cumulative (total, idle) CPU jiffies from /proc/stat's aggregate line.

    These are counters since boot, so a single read says nothing about
    current load - utilisation is only meaningful as a delta between two
    reads. Returns None on any platform that isn't Linux-like."""
    try:
        with open("/proc/stat", "r") as fh:
            parts = fh.readline().split()
    except OSError:
        return None
    if not parts or parts[0] != "cpu":
        return None
    try:
        values = [int(v) for v in parts[1:]]
    except ValueError:
        return None
    if len(values) < 5:
        return None
    # Fields: user nice system idle iowait irq softirq steal guest guest_nice
    # iowait counts as idle here: the CPU genuinely had nothing to run, it
    # was waiting on disk. Counting it as busy would make a slow disk look
    # like a CPU shortage and send you after the wrong bottleneck.
    idle = values[3] + values[4]
    return sum(values), idle


def _read_meminfo():
    """(total_bytes, available_bytes) from /proc/meminfo, or None."""
    try:
        with open("/proc/meminfo", "r") as fh:
            fields = {}
            for line in fh:
                key, _, rest = line.partition(":")
                value = rest.strip().split(" ")[0]
                if value.isdigit():
                    fields[key] = int(value) * 1024  # kB -> bytes
    except OSError:
        return None
    total = fields.get("MemTotal")
    if not total:
        return None
    # MemAvailable is the kernel's own estimate of what a new workload could
    # actually claim, and is the only honest "free memory" number on Linux -
    # MemFree alone looks alarmingly low on every healthy box because the
    # page cache is doing its job. Fall back only on kernels < 3.14.
    available = fields.get("MemAvailable")
    if available is None:
        available = fields.get("MemFree", 0) + fields.get("Buffers", 0) + fields.get("Cached", 0)
    return total, available


def _read_self_rss():
    """The agent's own resident memory in bytes, so a reviewer can rule the
    agent itself out as the cause of memory pressure it is reporting."""
    try:
        with open("/proc/self/status", "r") as fh:
            for line in fh:
                if line.startswith("VmRSS:"):
                    value = line.split()[1]
                    return int(value) * 1024
    except (OSError, ValueError, IndexError):
        return None
    return None


def _read_log_disk():
    """(total_bytes, free_bytes) for the filesystem holding the Mule log.

    Arguably the most operationally important number here: a full log
    partition takes the Mule runtime down and stops this agent dead, and
    unlike CPU or memory it fails hard rather than degrading."""
    try:
        target = os.path.dirname(MULE_LOG_PATH) or "/"
        st = os.statvfs(target)
    except (OSError, AttributeError):
        return None
    return st.f_blocks * st.f_frsize, st.f_bavail * st.f_frsize


# Each host sample is a fixed-position ARRAY, not an object, and carries only
# the values that actually change. Repeating eleven JSON keys plus three
# never-changing values (total RAM, disk size, core count) across 720 samples
# cost ~210 KB on every push; this form is ~5x smaller for the same
# information. Anything that couldn't be read is null in its slot rather than
# 0 - the client renders "not readable on this host", never a flat line that
# looks like a real measurement.
#
# The static three live in build_agent_health()'s "hostInfo" instead, and the
# client derives used-bytes / free-bytes / load-per-core from the two together.
# Same trade already made by logVolumeSamples' [epochSeconds, cumulativeLines].
#
# APPEND-ONLY: adding a column is safe, reordering or removing one silently
# misreads every retained sample. The client mirrors this list in
# HOST_SAMPLE_COLS (23-observability.js) and must be changed with it.
HOST_SAMPLE_COLUMNS = ["at", "cpuPct", "memPct", "diskUsedPct", "load1", "load5", "load15", "agentRssBytes"]


def sample_host_metrics(health, now):
    """One host-pressure sample, from stdlib only.

    This agent is deliberately dependency-free (see the module docstring) so
    psutil is not an option; everything here comes from /proc and os.statvfs,
    all world-readable, so it still works as the unprivileged
    `doctracker-agent` user with read-only access.

    Returns (sample_array, static_info) - see HOST_SAMPLE_COLUMNS - or
    (None, None) when nothing at all could be read (e.g. no /proc)."""
    cpu_pct = None
    cpu_now = _read_proc_stat_cpu()
    if cpu_now:
        prev = health.get("cpuPrevSample")
        # Only trust a delta against a recent read. State survives restarts,
        # so a stale previous sample would otherwise average CPU across the
        # entire downtime and report it as "current".
        if prev and len(prev) == 3 and (now - prev[2]) <= POLL_INTERVAL_SECONDS * 5:
            total_delta = cpu_now[0] - prev[0]
            idle_delta = cpu_now[1] - prev[1]
            if total_delta > 0 and idle_delta >= 0:
                cpu_pct = round(max(0.0, min(100.0, (1 - idle_delta / total_delta) * 100)), 1)
        health["cpuPrevSample"] = [cpu_now[0], cpu_now[1], now]

    static = {}
    mem_pct = None
    mem = _read_meminfo()
    if mem:
        total, available = mem
        static["memTotalBytes"] = total
        mem_pct = round((total - available) / total * 100, 1)

    load1 = load5 = load15 = None
    try:
        load1, load5, load15 = os.getloadavg()
        load1, load5, load15 = round(load1, 2), round(load5, 2), round(load15, 2)
        static["cpuCores"] = os.cpu_count() or 1
    except (OSError, AttributeError):
        pass

    disk_used_pct = None
    disk = _read_log_disk()
    if disk:
        total, free = disk
        if total:
            static["diskTotalBytes"] = total
            disk_used_pct = round((total - free) / total * 100, 1)

    rss = _read_self_rss()

    values = [cpu_pct, mem_pct, disk_used_pct, load1, load5, load15, rss]
    if all(v is None for v in values):
        return None, None
    return [round(now)] + values, static


def build_agent_health(state):
    """Self-monitoring for the agent itself - throughput, backlog, and how
    close it is to the scale safeguards' caps. This is what answers "is this
    keeping up, or quietly falling behind / dropping things" - shown as its
    own card on the Observability page rather than only being visible in
    stdout logs on a server the reviewer isn't logged into."""
    health = state.get("health", {})
    now = time.time()
    started_at = health.get("startedAtEpoch") or now
    samples = health.get("throughputSamples", [])
    requests_per_minute = None
    if len(samples) >= 2:
        (t0, c0), (t1, c1) = samples[0], samples[-1]
        elapsed = t1 - t0
        if elapsed > 0:
            requests_per_minute = round((c1 - c0) / elapsed * 60, 1)

    # Summed across every tailed file, so "am I falling behind" stays
    # answerable when one agent follows 70 logs.
    tailed = state.get("files") or {}
    backlog_bytes = 0
    for path, fstate in tailed.items():
        try:
            backlog_bytes += max(0, os.stat(path).st_size - fstate.get("offset", 0))
        except OSError:
            continue

    endpoints = state.get("endpoints", {})
    return {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
        "startedAt": health.get("startedAt"),
        "uptimeSeconds": round(now - started_at),
        "pythonVersion": platform.python_version(),
        "sourceLog": os.path.basename(MULE_LOG_PATH),
        # Basenames only - never the full paths, which would leak the
        # server's directory layout into a page that gets shared.
        "tailedLogs": sorted(os.path.basename(p) for p in tailed),
        "tailedLogCount": len(tailed),
        "pollIntervalSeconds": POLL_INTERVAL_SECONDS,
        "cyclesRun": health.get("cyclesRun", 0),
        "linesProcessedTotal": health.get("linesProcessedTotal", 0),
        "requestsProcessedTotal": health.get("requestsProcessedTotal", 0),
        "requestsPerMinute": requests_per_minute,
        # Real per-line log-level tally + the samples the "Log volume" chart
        # is bucketed from - see classify_log_level()'s docstring for why
        # matched/unmatched are kept separate (self-diagnosing: the client
        # only renders a level-distribution panel once real matches exist).
        "logLevelCounts": health.get("logLevelCounts", {}),
        "logLevelMatchedTotal": health.get("logLevelMatchedTotal", 0),
        "logLevelUnmatchedTotal": health.get("logLevelUnmatchedTotal", 0),
        "logVolumeSamples": health.get("logVolumeSamples", []),
        # Host CPU/memory/disk pressure on the machine tailing the log. See
        # sample_host_metrics() for why absent keys are left absent rather
        # than zeroed, and HOST_METRICS_ENABLED for when these describe the
        # wrong machine.
        "hostMetricsEnabled": HOST_METRICS_ENABLED,
        "hostSampleColumns": HOST_SAMPLE_COLUMNS,
        "hostSamples": health.get("hostSamples", []),
        "hostInfo": health.get("hostInfo", {}),
        "hostSampleIntervalSeconds": POLL_INTERVAL_SECONDS,
        "lastCycleAt": health.get("lastCycleAt"),
        "lastCycleDurationMs": health.get("lastCycleDurationMs"),
        "lastCycleLinesRead": health.get("lastCycleLinesRead"),
        "catchingUp": health.get("catchingUp", False),
        "backlogBytes": backlog_bytes,
        "trackedEndpointCount": len([k for k in endpoints if k != OVERFLOW_KEY]),
        "maxTrackedEndpoints": MAX_TRACKED_ENDPOINTS,
        "overflowObservations": health.get("overflowObservations", 0),
        "maxLinesPerCycle": MAX_LINES_PER_CYCLE,
        "lastPushAt": health.get("lastPushAt"),
        "lastPushOk": health.get("lastPushOk"),
        "lastError": health.get("lastError"),
    }


def build_endpoint_metrics(state):
    metrics = {}
    for key, ep in state.get("endpoints", {}).items():
        status_codes = ep.get("statusCodes", {})
        breakdown = {}
        error_count = 0
        total_with_status = 0
        for sc, count in status_codes.items():
            family = f"{sc[0]}xx" if sc and sc[0].isdigit() else "unknown"
            breakdown[family] = breakdown.get(family, 0) + count
            total_with_status += count
            if family in ("4xx", "5xx"):
                error_count += count
        error_rate = round(error_count / total_with_status, 4) if total_with_status else 0.0
        top_ips = sorted(ep.get("sourceIps", {}).items(), key=lambda kv: -kv[1])[:10]
        metrics[key] = {
            "totalRequests": ep.get("totalRequests", 0),
            "statusBreakdown": breakdown,
            "errorRate": error_rate,
            "lastSeenAt": ep.get("lastSeenAt"),
            "topSourceIps": [{"ip": ip, "count": count} for ip, count in top_ips],
            "sourceLog": os.path.basename(MULE_LOG_PATH),
        }
    return metrics


# ============================================================================
# Build the DocTracker project payload from aggregated endpoint data
# ============================================================================
def build_project(state, existing_project=None):
    now_iso = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
    endpoints = []
    for key, ep in state.get("endpoints", {}).items():
        if key == OVERFLOW_KEY:
            continue  # not a real endpoint - only ever shown on the Observability page, never documented
        fields = [
            {
                "id": f"auto-{stable_id(key, k)}",
                "name": k, "type": t, "required": False,
                "example": "", "description": guess_description(k),
                "encrypted": False, "encryptionNote": "",
            }
            for k, t in ep["fieldShapes"].items()
        ]
        response_fields = [
            {
                "id": f"auto-{stable_id(key, 'resp', k)}",
                "name": k, "type": t, "description": guess_description(k),
            }
            for k, t in ep.get("responseFieldShapes", {}).items()
        ]
        responses = [
            # No "example" is ever populated here - only counts and field
            # names/types. A captured field value could be a real credential
            # (see the aggregate() docstring), so it is never copied into a
            # response example, in local reports or DocTracker pushes alike.
            {"code": int(sc) if sc.isdigit() else 0, "description": f"Observed {count} time(s) in SIT logs. "
             "No response body content is captured - field names/types only, see below.",
             "fields": response_fields, "example": "", "examples": []}
            for sc, count in ep["statusCodes"].items()
        ]
        notes = anomaly_notes(ep)
        endpoints.append({
            "id": f"auto-{stable_id(key)}",
            "method": ep["method"], "path": ep["path"],
            "name": f"{ep['method']} {ep['path']} (auto-discovered)",
            # "public" here means "visible to other users in this organisation" (see
            # server/routes/workspace.js) - NOT internet-exposed. Needed so a human
            # reviewer (who isn't svc-doc-agent) can actually see this in DocTracker;
            # a project the agent's own account marks "private" is invisible to
            # everyone else, including Admins, without an explicit share grant.
            "visibility": "public", "tag": "Auto-discovered", "sourceSystem": "", "targetSystem": "",
            "version": "0.0.1-draft", "contentType": "application/json",
            "summary": "Auto-discovered from SIT logs - unreviewed.",
            "description": ("Discovered automatically from SIT server logs by the DocTracker SIT Auto-Discovery "
                             "Agent (no LLM - naming-heuristic descriptions only). Every field description, "
                             "requirement flag, and note below needs a human review pass before this is trusted "
                             "as real documentation.\n\n" + ("\n".join("- " + n for n in notes) if notes else "")),
            "parameters": [], "headers": [], "requestBody": {"example": "", "fields": fields, "examples": []},
            "responses": responses, "customSections": [],
            "createdAt": now_iso, "createdBy": "svc-doc-agent", "updatedAt": now_iso, "updatedBy": "svc-doc-agent",
            "status": "in_development",
            "secOpsStatus": "none", "secOpsStatusBy": "", "secOpsStatusAt": "",
            "vaptStatus": "none", "vaptStatusBy": "", "vaptStatusAt": "",
            "logMgmtStatus": "none", "logMgmtStatusBy": "", "logMgmtStatusAt": "",
        })

    project = dict(existing_project or {})
    project.update({
        "id": PROJECT_ID, "name": PROJECT_NAME,
        "description": ("Auto-discovered from SIT server logs by an unattended agent (server/totp-style zero-LLM "
                         "design - see AGENT_README.md). Nothing here is reviewed. Treat every field/description/"
                         "requirement as a draft only, and promote individual endpoints into a real project once "
                         "confirmed."),
        "visibility": "public",  # org-visible, not internet-exposed - see note on endpoint visibility above
        "environments": project.get("environments") or {"SIT": "https://{{SIT-DNS}}"},
        "auth": project.get("auth") or {"type": "Unknown - auto-discovered", "method": "", "path": "", "headerName": "",
                                          "description": "Not yet determined by the auto-discovery agent.",
                                          "requestParams": [], "responseParams": [], "requestExample": "",
                                          "responseExample": "", "includeInDocs": True, "includeInSwagger": False},
        "notes": f"Last updated by svc-doc-agent at {now_iso}. {len(endpoints)} endpoint(s) discovered so far.",
        "lifecycle": "SIT", "owner": "svc-doc-agent", "team": "MULESOFT",
        "requestFlowDirection": "2-way", "requestFlowLabel": "", "version": "0.0.1-draft",
        "termsOfService": "", "contact": {"name": "", "email": ""}, "license": {"name": "", "url": ""},
        "createdAt": project.get("createdAt") or now_iso, "updatedAt": now_iso,
        "endpoints": endpoints,
        "attachments": project.get("attachments") or [],
        "requestFlowStages": [], "requestFlows": [],
        "_closedTags": {}, "_open": False,
    })
    for junk in ("_owned", "_readonly", "_rev"):
        project.pop(junk, None)
    return project


# ============================================================================
# Local HTML report - fully offline, no network call, no DocTracker involved.
# Renders the same aggregated data build_project() would send, as a single
# self-contained HTML file (inline CSS only, no external fonts/CDN/scripts -
# this needs to work on a server that may have no internet access at all).
# ============================================================================
def _esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;"))


def render_html(project):
    now_iso = project.get("updatedAt", "")
    rows = []
    for ep in project.get("endpoints", []):
        fields_html = "".join(
            f"<tr><td><code>{_esc(f['name'])}</code></td><td>{_esc(f['type'])}</td>"
            f"<td>{_esc(f['description'])}</td></tr>"
            for f in ep["requestBody"]["fields"]
        ) or "<tr><td colspan='3'><em>No request-body fields observed in logs.</em></td></tr>"

        resp_html = "".join(
            f"<tr><td>{_esc(r['code'])}</td><td>{_esc(r['description'])}</td></tr>"
            for r in ep["responses"]
        ) or "<tr><td colspan='2'><em>No responses observed.</em></td></tr>"

        resp_fields_html = "".join(
            f"<tr><td><code>{_esc(f['name'])}</code></td><td>{_esc(f['type'])}</td>"
            f"<td>{_esc(f['description'])}</td></tr>"
            for f in (ep["responses"][0]["fields"] if ep["responses"] else [])
        ) or "<tr><td colspan='3'><em>No response-body fields observed in logs.</em></td></tr>"

        rows.append(f"""
        <section class="ep">
          <h2><span class="method {_esc(ep['method'].lower())}">{_esc(ep['method'])}</span>
              <code>{_esc(ep['path'])}</code></h2>
          <p class="desc">{_esc(ep['description']).replace(chr(10), '<br>')}</p>
          <h3>Request body fields (observed)</h3>
          <p class="fieldnote">Field names and types only - no captured values are ever stored or shown, since a
          field (even one that looks pre-encrypted) could be a real credential.</p>
          <table><thead><tr><th>Field</th><th>Type</th><th>Description</th></tr></thead>
          <tbody>{fields_html}</tbody></table>
          <h3>Responses (observed)</h3>
          <table><thead><tr><th>Status</th><th>Notes</th></tr></thead>
          <tbody>{resp_html}</tbody></table>
          <h3>Response body fields (observed, all statuses combined)</h3>
          <table><thead><tr><th>Field</th><th>Type</th><th>Description</th></tr></thead>
          <tbody>{resp_fields_html}</tbody></table>
        </section>""")

    endpoints_html = "".join(rows) or "<p><em>No endpoints discovered yet - keep the agent running and re-check.</em></p>"

    return f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>{_esc(project['name'])} (local, offline report)</title>
<style>
  :root {{ color-scheme: light dark; }}
  body {{ font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 960px; margin: 32px auto;
          padding: 0 16px; line-height: 1.5; }}
  h1 {{ font-size: 1.4rem; }}
  .banner {{ background: #fff3cd; border: 1px solid #ffe69c; padding: 10px 14px; border-radius: 6px;
             font-size: 0.9rem; margin-bottom: 20px; }}
  .ep {{ border: 1px solid #d0d7de; border-radius: 8px; padding: 14px 18px; margin-bottom: 18px; }}
  .ep h2 {{ font-size: 1.05rem; margin: 0 0 6px; }}
  .desc {{ color: #57606a; font-size: 0.88rem; }}
  .fieldnote {{ color: #57606a; font-size: 0.8rem; font-style: italic; margin: 0 0 4px; }}
  .method {{ display: inline-block; font-weight: 700; font-size: 0.75rem; padding: 2px 8px; border-radius: 4px;
             color: #fff; margin-right: 6px; }}
  .method.get {{ background: #0969da; }} .method.post {{ background: #1a7f37; }}
  .method.put {{ background: #9a6700; }} .method.patch {{ background: #8250df; }}
  .method.delete {{ background: #cf222e; }}
  table {{ width: 100%; border-collapse: collapse; font-size: 0.85rem; margin: 6px 0 14px; }}
  th, td {{ text-align: left; padding: 5px 8px; border-bottom: 1px solid #eaeef2; vertical-align: top; }}
  code {{ background: #f6f8fa; padding: 1px 4px; border-radius: 3px; }}
</style></head>
<body>
<h1>{_esc(project['name'])}</h1>
<p class="banner">
  Rendered locally by the DocTracker SIT Auto-Discovery Agent in <code>--local-html</code> mode.
  <b>No network call was made to render this file</b> - nothing discovered from this server's logs
  was sent anywhere, including DocTracker. Every field description is auto-generated from the field's
  own name and needs human review before being trusted. Generated at {_esc(now_iso)}.
</p>
{endpoints_html}
</body></html>"""


def write_local_html(state, path):
    project = build_project(state)
    html = render_html(project)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(html)
    os.replace(tmp, path)
    print(f"[info] wrote local HTML report to {path} ({len(project.get('endpoints', []))} endpoint(s)) - "
          f"no network call was made")


def start_local_server(html_path, port):
    """Serves ONLY the directory containing html_path, bound to 127.0.0.1 -
    never 0.0.0.0. This keeps the offline mode's guarantee intact: the
    report is reachable from a browser ON THIS SERVER ONLY, not the network.
    If you need to view it from your own laptop, use an SSH tunnel
    (ssh -L 8877:127.0.0.1:8877 user@sit-server) rather than opening this
    port up - don't change the bind address to make it reachable directly.

    Deliberately does NOT use http.server.ThreadingHTTPServer or
    SimpleHTTPRequestHandler's `directory=` kwarg - both were only added in
    Python 3.7, and this needs to run on Python 3.6 (confirmed present on
    the target SIT server). ThreadingMixIn + a hand-rolled translate_path
    override work identically back to 3.6's stdlib."""
    directory = os.path.dirname(os.path.abspath(html_path)) or "."

    class Handler(http.server.SimpleHTTPRequestHandler):
        def translate_path(self, path):
            path = path.split("?", 1)[0].split("#", 1)[0]
            path = posixpath.normpath(unquote(path))
            words = [w for w in path.split("/") if w and w not in (os.curdir, os.pardir)]
            result = directory
            for w in words:
                result = os.path.join(result, w)
            return result

        def log_message(self, fmt, *args):
            pass  # keep stdout to this agent's own [info]/[warn]/[error] lines

    class ThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
        daemon_threads = True

    httpd = ThreadingServer(("127.0.0.1", port), Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{port}/{os.path.basename(html_path)}"
    print(f"[info] serving local report at {url} (bound to 127.0.0.1 only - not reachable off this server)")
    return httpd


# ============================================================================
# Main loop
# ============================================================================
def seed_state_from_history(state, log_paths, max_lines):
    """One-time backfill of the endpoint INVENTORY from existing log history.

    Tailing starts at end-of-file, which is right for counting traffic - it
    is the only way to avoid re-ingesting gigabytes on every restart. But it
    means a fresh agent knows about no endpoints at all and only learns one
    when it next sees live traffic for it. On this deployment that is a real
    loss rather than a brief warm-up: most of the inventory comes from
    "Starting flow:" lines, which Mule emits only at application startup, so
    an endpoint belonging to an app that is deployed but momentarily idle
    would stay invisible until the next restart - potentially weeks.

    So this reads the LAST `max_lines` lines of each file once, feeding them
    through the same parse/aggregate path as live tailing. Requests seen here
    are real and counted (event-id dedup in aggregate() stops a later live
    read of the same lines from double-counting). It runs only when the state
    file has no `seededFromHistory` marker, so a restart never repeats it.
    """
    if not log_paths:
        return
    per_file = max(1, max_lines // max(1, len(log_paths)))
    print(f"[info] seeding inventory from history: up to {per_file} line(s) from the END of each of "
          f"{len(log_paths)} file(s). One time only - subsequent restarts resume from where this left off.")
    total_lines = 0
    total_obs = 0
    failed = 0
    for path in log_paths:
        try:
            lines = read_last_lines(path, per_file)
        except Exception as e:
            failed += 1
            print(f"[warn] could not seed from {os.path.basename(path)}: {e}", file=sys.stderr)
            continue
        if not lines:
            continue
        # A fresh carry per file, exactly as the live tailer keeps one per
        # file - a JSON block must never be assembled across two apps' logs.
        carry = {"method": None, "buffer": "", "in_json": False, "depth": 0}
        observations = assemble_multiline_observations(lines, carry)
        for raw in lines:
            obs = parse_line(raw.strip())
            if obs:
                observations.append(obs)
        aggregate(state, observations)
        total_lines += len(lines)
        total_obs += len(observations)
    eps = len(state.get("endpoints") or {})
    print(f"[info] seeded from {total_lines} historical line(s): {total_obs} observation(s), "
          f"{eps} endpoint(s) now known."
          + (f" {failed} file(s) unreadable." if failed else ""))


def run(dry_run=False, sample_lines=None, local_html=None, serve_port=None, seed_from_history=None):
    state = load_state()

    if sample_lines:
        sample_paths = resolve_log_paths(MULE_LOG_PATH)
        print(f"[info] sample mode: reading up to {sample_lines} NEW lines from "
              f"{len(sample_paths)} file(s): "
              f"{', '.join(os.path.basename(p) for p in sample_paths[:8])}"
              f"{' …' if len(sample_paths) > 8 else ''}\n")
        # Sampled PER FILE, not from one merged stream. With 70 apps in a log
        # directory, taking the first N lines overall would only ever show the
        # alphabetically-first app and say nothing about the other 69 - and
        # "which of my apps does the parser actually understand" is the whole
        # question this mode exists to answer.
        #
        # Each file also gets its OWN multi-line carry, for the same reason the
        # main loop does: a JSON block spans lines within one file.
        per_file = max(1, sample_lines // max(1, len(sample_paths)))
        print(f"[info] budget is split across the files: ~{per_file} line(s) sampled per file, "
              f"taken from the END of each file (most recent traffic).")
        if per_file < 10 and len(sample_paths) > 1:
            print(f"[warn] that is too few lines per file to judge a parse rate. For {len(sample_paths)} "
                  f"file(s), use --sample-lines {len(sample_paths) * 50} or more.", file=sys.stderr)
        print()
        totals = {"matched": 0, "unmatched": 0, "lines": 0}
        per_file_report = []

        for _p in sample_paths:
            # From the END of the file, not the start - see read_last_lines().
            # Reads nothing into the real state, so offsets are untouched.
            flines = read_last_lines(_p, per_file)
            if not flines:
                per_file_report.append((os.path.basename(_p), 0, 0, 0, set(), set()))
                continue
            carry = {"method": None, "buffer": "", "in_json": False, "depth": 0}
            fmulti = assemble_multiline_observations(flines, carry)
            fmatched, funmatched = 0, 0
            shown = 0
            # The line match RATE is a poor headline: one request logs many
            # lines, and a startup "Starting flow:" line matches without
            # representing any traffic at all. What actually matters is how
            # many distinct ENDPOINTS were discovered and how many distinct
            # REQUESTS (event ids) were seen.
            fendpoints, fevents = set(), set()
            finventory = 0
            print(f"--- {os.path.basename(_p)} ({len(flines)} line(s) sampled) ---")
            for line in flines:
                obs = parse_line(line)
                if obs:
                    fmatched += 1
                    fendpoints.add("%s %s" % (obs["method"], templatize_path(obs["path"])))
                    if obs.get("isInventory"):
                        finventory += 1
                    elif obs.get("correlationId"):
                        fevents.add(obs["correlationId"])
                    if shown < 3:
                        kind = "startup inventory" if obs.get("isInventory") else "request"
                        print(f"  MATCHED ({kind})   {obs['method']} {obs['path']}  status={obs.get('statusCode')}")
                        shown += 1
                else:
                    funmatched += 1
                    if shown < 3:
                        print(f"  UNMATCHED {line[:150]}")
                        shown += 1
            for obs in fmulti:
                req_fields = sorted(obs["body"].keys()) if isinstance(obs.get("body"), dict) else []
                fendpoints.add("%s %s" % (obs["method"], templatize_path(obs["path"])))
                print(f"  MATCHED (multi-line JSON block)   {obs['method']} {obs['path']}  "
                      f"status={obs.get('statusCode')}  request-field-names={req_fields}   [values never captured]")
            total_f = fmatched + len(fmulti)
            per_file_report.append((os.path.basename(_p), len(flines), total_f, funmatched,
                                    fendpoints, fevents))
            totals["matched"] += total_f
            totals["unmatched"] += funmatched
            totals["lines"] += len(flines)
            totals.setdefault("endpoints", set()).update(fendpoints)
            totals.setdefault("events", set()).update(fevents)
            totals["inventory"] = totals.get("inventory", 0) + finventory
            print()

        print("=" * 78)
        print("WHAT THE AGENT WOULD ACTUALLY RECORD")
        print("=" * 78)
        print("  'endpoints' = distinct method+path discovered. 'requests' = distinct")
        print("  Mule event ids, i.e. REAL request count - many log lines share one.")
        print()
        print("  %-42s %7s %7s %9s %8s" % ("log file", "sampled", "matched", "endpoints", "requests"))
        silent = []
        for name, nlines, nmatched, _unm, feps, fevs in sorted(
                per_file_report, key=lambda r: (len(r[4]), r[2])):
            print("  %-42s %7d %7d %9d %8d" % (name[:42], nlines, nmatched, len(feps), len(fevs)))
            if nlines and nmatched == 0:
                silent.append(name)

        all_eps = totals.get("endpoints", set())
        all_evs = totals.get("events", set())
        print()
        print("=" * 78)
        print("  ENDPOINTS DISCOVERED : %d   across %d app log(s)"
              % (len(all_eps), sum(1 for r in per_file_report if r[4])))
        print("  REQUESTS OBSERVED    : %d   (distinct event ids in this sample)" % len(all_evs))
        print("  startup inventory lines (prove an endpoint exists, not traffic): %d"
              % totals.get("inventory", 0))
        print("=" * 78)
        if all_eps and not all_evs:
            print("  -> Endpoint DISCOVERY works; no request traffic in the sampled window.")
            print("     That is expected shortly after a runtime restart, or for apps whose")
            print("     flows contain no Logger component - Mule does not log a line per")
            print("     request by default.")
        print()
        print(f"[info] {totals['matched']} matched, {totals['unmatched']} lines not matched by the "
              f"single-line patterns, out of {totals['lines']} lines sampled across "
              f"{len(sample_paths)} file(s).")
        print("[info] note: lines that are PART OF a successfully reconstructed multi-line JSON block still "
              "show as UNMATCHED individually - that's expected, they aren't meant to match on their own.")
        if silent:
            print(f"\n[warn] {len(silent)} file(s) produced NO matches at all. Traffic in these apps is "
                  f"invisible to the agent - their counters will never move:")
            for name in silent[:20]:
                print(f"          {name}")
            if len(silent) > 20:
                print(f"          ... and {len(silent) - 20} more")
            print("       If these apps genuinely serve HTTP traffic, LINE_PATTERNS needs tuning to their "
                  "log format. Paste a few real (redacted) lines from one of them.")
        if totals["matched"] == 0 and totals["lines"]:
            print("[warn] NOTHING matched in any file - LINE_PATTERNS/HEADER_METHOD_PATTERN almost certainly "
                  "need tuning to your real log format before relying on any of this.")
        return

    client = None
    if local_html:
        print(f"[info] --local-html mode: DOCTRACKER_* settings are ignored - no network call will ever be made")
    elif not dry_run:
        if not DOCTRACKER_PASSWORD:
            print("[error] DOCTRACKER_PASSWORD is not set. Set it (or run with --dry-run / --local-html) before running for real.", file=sys.stderr)
            sys.exit(1)
        client = DocTrackerClient(DOCTRACKER_BASE_URL, DOCTRACKER_USERNAME, DOCTRACKER_PASSWORD)
        client.login()

    mode = f"writing local HTML to {local_html} (offline, no network)" if local_html else \
           ("DRY RUN - no network writes" if dry_run else "pushing to DocTracker")
    print(f"[info] tailing {MULE_LOG_PATH} every {POLL_INTERVAL_SECONDS}s, {mode}")

    if CAPTURE_MODE == "full":
        print("[warn] CAPTURE_MODE=full is ON: this agent will capture real per-request log records, "
              "including real request/response field VALUES (except fields whose name matches "
              f"{SENSITIVE_FIELD_PATTERN.pattern!r}, which are always redacted). These are written to "
              "DocTracker's database and shown in its UI to anyone with access to this project's "
              "Observability Console. This should only be on because your organisation made that "
              "decision deliberately - see the Capture mode section of AGENT_README.md.", file=sys.stderr)

    if serve_port:
        if not local_html:
            print("[error] --serve-port requires --local-html (nothing to serve otherwise).", file=sys.stderr)
            sys.exit(1)
        if not os.path.exists(local_html):
            write_local_html(state, local_html)  # so the URL is live immediately, not 404 until the first push
        start_local_server(local_html, serve_port)

    # In-memory only (never persisted to STATE_FILE) - see assemble_multiline_observations()'s
    # docstring for why a partially-read JSON block should never touch disk.
    # Keyed by file path: one carry per tailed log, never shared.
    multiline_carry = {}

    log_paths = resolve_log_paths(MULE_LOG_PATH)
    last_glob_scan = time.time()
    migrate_single_file_state(state, log_paths)
    if not log_paths:
        print(f"[warn] nothing matched MULE_LOG_PATH={MULE_LOG_PATH!r} yet - will re-check every "
              f"{LOG_GLOB_RESCAN_SECONDS}s", file=sys.stderr)
    else:
        print(f"[info] tailing {len(log_paths)} file(s): "
              f"{', '.join(os.path.basename(p) for p in log_paths[:8])}"
              f"{' …' if len(log_paths) > 8 else ''}")

    health = state.setdefault("health", {})
    health.setdefault("startedAt", time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()))
    health.setdefault("startedAtEpoch", time.time())

    if seed_from_history and not state.get("seededFromHistory"):
        seed_state_from_history(state, log_paths, seed_from_history)
        state["seededFromHistory"] = True
        save_state(state)

    while True:
        cycle_start = time.time()
        # Bounded read: at most MAX_LINES_PER_CYCLE lines per call, so one
        # poll cycle can never block for an unbounded amount of time no
        # matter how large the backlog is (a burst of traffic, or the agent
        # having been stopped for a while). If the backlog is bigger than
        # one chunk, `caught_up` is False below and the next cycle starts
        # immediately (no sleep) instead of waiting POLL_INTERVAL_SECONDS -
        # this is how the agent catches back up without ever doing all of
        # it in one giant blocking pass.
        if time.time() - last_glob_scan >= LOG_GLOB_RESCAN_SECONDS:
            new_paths = resolve_log_paths(MULE_LOG_PATH)
            if new_paths != log_paths:
                added = [p for p in new_paths if p not in log_paths]
                dropped = [p for p in log_paths if p not in new_paths]
                if added:
                    print(f"[info] now also tailing: {', '.join(os.path.basename(p) for p in added)}")
                if dropped:
                    print(f"[info] no longer present: {', '.join(os.path.basename(p) for p in dropped)}")
                log_paths = new_paths
            last_glob_scan = time.time()

        by_file = tail_all_logs(log_paths, state, MAX_LINES_PER_CYCLE)
        lines = [l for file_lines in by_file.values() for l in file_lines]
        caught_up = len(lines) < MAX_LINES_PER_CYCLE
        observations = [o for o in (parse_line(l) for l in lines) if o]
        # Multi-line JSON blocks are assembled PER FILE. Each file gets its
        # own carry, because a block spans consecutive lines within one file
        # and interleaving two files' lines would desync both brace counters.
        for path, file_lines in by_file.items():
            carry = multiline_carry.setdefault(path, {"method": None, "buffer": "", "in_json": False, "depth": 0})
            observations += assemble_multiline_observations(file_lines, carry)
        for gone in [p for p in multiline_carry if p not in log_paths]:
            del multiline_carry[gone]
        if observations:
            aggregate(state, observations)
            print(f"[info] parsed {len(observations)} HTTP-shaped line(s) this cycle from "
                  f"{len(by_file)} file(s) "
                  f"({len([k for k in state['endpoints'] if k != OVERFLOW_KEY])} distinct endpoint(s) known so far)")

        # Best-effort log-level tally, independent of the HTTP-request
        # parsing above - see classify_log_level()'s docstring for why
        # matched/unmatched are tracked separately rather than assumed.
        if lines:
            level_counts = health.setdefault("logLevelCounts", {})
            matched_this_cycle = 0
            for raw_line in lines:
                level = classify_log_level(raw_line)
                if level:
                    level_counts[level] = level_counts.get(level, 0) + 1
                    matched_this_cycle += 1
            health["logLevelMatchedTotal"] = health.get("logLevelMatchedTotal", 0) + matched_this_cycle
            health["logLevelUnmatchedTotal"] = health.get("logLevelUnmatchedTotal", 0) + (len(lines) - matched_this_cycle)

        cycle_duration_ms = round((time.time() - cycle_start) * 1000, 1)
        health["cyclesRun"] = health.get("cyclesRun", 0) + 1
        health["linesProcessedTotal"] = health.get("linesProcessedTotal", 0) + len(lines)
        health["requestsProcessedTotal"] = health.get("requestsProcessedTotal", 0) + len(observations)
        health["lastCycleAt"] = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
        health["lastCycleDurationMs"] = cycle_duration_ms
        health["lastCycleLinesRead"] = len(lines)
        health["catchingUp"] = not caught_up
        # Rolling throughput samples: (epoch time, cumulative requests seen)
        # capped to the last 30 - build_agent_health() derives requests/min
        # from the oldest and newest sample still kept, so this is a moving
        # window, not a since-startup average that goes stale over days.
        samples = health.setdefault("throughputSamples", [])
        samples.append([time.time(), health["requestsProcessedTotal"]])
        if len(samples) > 30:
            del samples[0]
        # Host pressure, sampled per cycle rather than per push - see
        # MAX_HOST_SAMPLES for why CPU needs the finer cadence. Kept even
        # when a cycle read no lines at all: "the box was pegged while
        # nothing was being logged" is itself a finding.
        if HOST_METRICS_ENABLED:
            host_sample, host_static = sample_host_metrics(health, time.time())
            if host_sample:
                host_samples = health.setdefault("hostSamples", [])
                # Discard anything not in the current fixed-position array
                # form (e.g. a state.json written by an older build) rather
                # than feeding mixed shapes to the client.
                if host_samples and not isinstance(host_samples[0], list):
                    del host_samples[:]
                host_samples.append(host_sample)
                if len(host_samples) > MAX_HOST_SAMPLES:
                    del host_samples[0:len(host_samples) - MAX_HOST_SAMPLES]
                if host_static:
                    health["hostInfo"] = host_static
        if not caught_up:
            print(f"[warn] backlog: read the full {MAX_LINES_PER_CYCLE}-line chunk this cycle "
                  f"({cycle_duration_ms}ms) and more remains - continuing immediately without sleeping "
                  f"to catch up, see Agent Health on the Observability page")
        save_state(state)

        if time.time() - state.get("last_push", 0) >= PUSH_INTERVAL_SECONDS and state.get("endpoints"):
            # One "Log volume" sample per push (see MAX_LOG_VOLUME_SAMPLES) -
            # cumulative lines-processed-so-far, same shape as
            # throughputSamples above; the client derives a per-interval
            # count from consecutive samples' deltas.
            volume_samples = health.setdefault("logVolumeSamples", [])
            volume_samples.append([time.time(), health.get("linesProcessedTotal", 0)])
            if len(volume_samples) > MAX_LOG_VOLUME_SAMPLES:
                del volume_samples[0]

            metrics_payload = {
                "environment": ENVIRONMENT or None,
                "endpoints": build_endpoint_metrics(state),
                "agentHealth": build_agent_health(state),
                "logRecords": build_log_records(state),
            }
            if local_html:
                try:
                    write_local_html(state, local_html)
                except Exception as e:
                    print(f"[error] writing local HTML report failed, will retry next cycle: {e}", file=sys.stderr)
            elif dry_run:
                project = build_project(state)
                print("[dry-run] would push project:")
                print(json.dumps(project, indent=2)[:4000])
                print("[dry-run] would push endpoint metrics + agent health:")
                print(json.dumps(metrics_payload, indent=2)[:2500])
            else:
                try:
                    require_environment()
                    existing = client.get_workspace()
                    existing_project = existing.get("projects", {}).get(PROJECT_ID)
                    project = build_project(state, existing_project)
                    if existing_project:
                        project["_rev"] = existing_project.get("_rev")
                    client.push_project(project)
                    # The revision read in the SAME get_workspace() call above,
                    # so the server can tell whether anything changed the blob
                    # between that read and this write.
                    client.push_endpoint_metrics(metrics_payload, existing.get("endpointMetricsRev"))
                    health["lastPushOk"] = True
                    health["lastError"] = None
                except Exception as e:
                    print(f"[error] push failed, will retry next cycle: {e}", file=sys.stderr)
                    health["lastPushOk"] = False
                    health["lastError"] = str(e)[:500]
            state["last_push"] = time.time()
            health["lastPushAt"] = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
            save_state(state)

        if not caught_up:
            continue  # skip the sleep - go straight into the next bounded chunk
        time.sleep(POLL_INTERVAL_SECONDS)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="Parse and aggregate, but never call DocTracker.")
    ap.add_argument("--sample-lines", type=int, default=None, help="Print N parsed lines and exit (for validating the log parser).")
    ap.add_argument("--seed-from-history", type=int, default=None, metavar="N",
                    help="On first start only, backfill the endpoint inventory by reading the last N "
                         "lines (total, split across files) of existing logs before tailing. Without "
                         "this the agent starts at end-of-file and only learns an endpoint when it "
                         "next sees live traffic for it.")
    ap.add_argument("--local-html", metavar="PATH", default=None,
                     help="Write a self-contained local HTML report to PATH instead of pushing to DocTracker. "
                          "No network call is ever made in this mode - see the data-residency note at the top of this file.")
    ap.add_argument("--serve-port", type=int, default=None,
                     help="With --local-html, also serve the report over http://127.0.0.1:PORT (localhost-only, "
                          "never externally reachable). View from your own machine via an SSH tunnel.")
    args = ap.parse_args()
    run(dry_run=args.dry_run, sample_lines=args.sample_lines, local_html=args.local_html,
        serve_port=args.serve_port, seed_from_history=args.seed_from_history)
