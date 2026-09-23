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
"""

import os
import re
import sys
import json
import time
import hashlib
import argparse
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
MULE_LOG_PATH = os.environ.get("MULE_LOG_PATH", "/opt/mule/logs/mule-app.log")
STATE_FILE = os.environ.get("AGENT_STATE_FILE", "/var/lib/doctracker-agent/state.json")

DOCTRACKER_BASE_URL = os.environ.get("DOCTRACKER_BASE_URL", "https://doctracker-production-7ecc.up.railway.app")
DOCTRACKER_USERNAME = os.environ.get("DOCTRACKER_USERNAME", "svc-doc-agent")
DOCTRACKER_PASSWORD = os.environ.get("DOCTRACKER_PASSWORD")  # required for a real (non-dry-run) push

PROJECT_ID = os.environ.get("DOCTRACKER_PROJECT_ID", "sitautodisc1")
PROJECT_NAME = "SIT Auto-Discovery - unreviewed"

POLL_INTERVAL_SECONDS = int(os.environ.get("POLL_INTERVAL_SECONDS", "60"))
PUSH_INTERVAL_SECONDS = int(os.environ.get("PUSH_INTERVAL_SECONDS", "900"))  # 15 min batches, not per-line

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
REQUEST_URI_KEY_PATTERN = re.compile(r'requesturi|^path$|^uri$', re.IGNORECASE)
CORR_ID_KEY_PATTERN = re.compile(r'correlationid', re.IGNORECASE)
STATUS_KEY_PATTERN = re.compile(r'httpstatus|statuscode|^status$', re.IGNORECASE)
REQUEST_PAYLOAD_KEY_PATTERN = re.compile(r'^requestpayload$', re.IGNORECASE)
RESPONSE_PAYLOAD_KEY_PATTERN = re.compile(r'^responsepayload$', re.IGNORECASE)


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


def _finish_block(carry, observations):
    try:
        obj = json.loads(carry["buffer"])
    except (ValueError, TypeError) as e:
        # Diagnostic only - never prints buffer CONTENT (it may hold real
        # captured field values), only the parse error and buffer length.
        print(f"[warn] found what looked like a JSON block (method={carry['method']}) but it failed to parse: "
              f"{e} (buffer length {len(carry['buffer'])} chars) - not counted as a match.", file=sys.stderr)
        obj = None
    carry["buffer"] = ""
    if isinstance(obj, dict) and not carry["method"]:
        print(f"[warn] parsed a JSON block successfully but no HTTP method was captured off the preceding "
              f"request-start line (HEADER_METHOD_PATTERN found no match) - not counted as a match. Key names "
              f"seen in the block: {sorted(set(_all_keys(obj)))}", file=sys.stderr)
    if isinstance(obj, dict) and carry["method"]:
        path = _find_key_value(obj, REQUEST_URI_KEY_PATTERN)
        if not path:
            print(f"[warn] parsed a JSON block (method={carry['method']}) but found no path-like key "
                  f"(looked for a name matching 'requesturi'/'path'/'uri'). Top-level/nested key names seen: "
                  f"{sorted(set(_all_keys(obj)))} - adjust REQUEST_URI_KEY_PATTERN if your real key is named "
                  f"differently.", file=sys.stderr)
        if path:
            req_payload = _find_key_dict(obj, REQUEST_PAYLOAD_KEY_PATTERN)
            resp_payload = _find_key_dict(obj, RESPONSE_PAYLOAD_KEY_PATTERN)
            observations.append({
                "method": carry["method"],
                "path": str(path).split("?")[0],
                "statusCode": _find_key_value(obj, STATUS_KEY_PATTERN),
                "correlationId": _find_key_value(obj, CORR_ID_KEY_PATTERN),
                "body": req_payload if isinstance(req_payload, dict) else None,
                "responseBody": resp_payload if isinstance(resp_payload, dict) else None,
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


def tail_new_lines(path, state):
    """Reads any lines appended since the last recorded offset. Detects log
    rotation (inode change or file shrank) and restarts from the top of the
    new file rather than crashing or silently missing the rotated-out tail.

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
    except FileNotFoundError:
        print(f"[warn] log file not found: {path}", file=sys.stderr)
        return []

    inode = getattr(st, "st_ino", None)
    if state.get("inode") is not None and inode != state.get("inode"):
        state["offset"] = 0  # rotated - a new file, start from its beginning
    elif st.st_size < state.get("offset", 0):
        state["offset"] = 0  # truncated/rotated in place

    state["inode"] = inode
    lines = []
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        f.seek(state["offset"])
        while True:
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


# ============================================================================
# Line parsing
# ============================================================================
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
    return None


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
def aggregate(state, observations):
    endpoints = state.setdefault("endpoints", {})
    for obs in observations:
        key = f"{obs['method']} {obs['path']}"
        ep = endpoints.setdefault(key, {
            "method": obs["method"], "path": obs["path"],
            "statusCodes": {}, "correlationIds": [], "fieldShapes": {},
            "responseFieldShapes": {}, "statusesWithErrorLikeFields": [],
        })
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


# ============================================================================
# Build the DocTracker project payload from aggregated endpoint data
# ============================================================================
def build_project(state, existing_project=None):
    now_iso = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
    endpoints = []
    for key, ep in state.get("endpoints", {}).items():
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
            "visibility": "private", "tag": "Auto-discovered", "sourceSystem": "", "targetSystem": "",
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
        "visibility": "private",
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
def run(dry_run=False, sample_lines=None, local_html=None, serve_port=None):
    state = load_state()

    if sample_lines:
        print(f"[info] sample mode: reading up to {sample_lines} NEW lines from {MULE_LOG_PATH}\n")
        lines = tail_new_lines(MULE_LOG_PATH, dict(state))[:sample_lines]
        carry = {"method": None, "buffer": "", "in_json": False, "depth": 0}
        multi_obs = assemble_multiline_observations(lines, carry)

        matched_single, unmatched = 0, 0
        for line in lines:
            obs = parse_line(line)
            if obs:
                matched_single += 1
                print(f"MATCHED (single-line)   {obs['method']} {obs['path']}  status={obs.get('statusCode')}  corr={obs.get('correlationId')}")
            else:
                unmatched += 1
                print(f"UNMATCHED {line[:160]}")

        for obs in multi_obs:
            req_fields = sorted(obs["body"].keys()) if isinstance(obs.get("body"), dict) else []
            print(f"MATCHED (multi-line JSON block)   {obs['method']} {obs['path']}  status={obs.get('statusCode')}  "
                  f"corr={obs.get('correlationId')}  request-field-names={req_fields}   [values never captured]")

        total_matched = matched_single + len(multi_obs)
        print(f"\n[info] {total_matched} matched ({matched_single} single-line style, {len(multi_obs)} reconstructed "
              f"multi-line JSON block(s)), {unmatched} lines not matched by the single-line patterns, "
              f"out of {len(lines)} lines total.")
        print("[info] note: lines that are PART OF a successfully reconstructed multi-line JSON block will still "
              "show as UNMATCHED above one-by-one - that's expected, they're not meant to match individually.")
        if total_matched == 0 and lines:
            print("[warn] Nothing matched at all - LINE_PATTERNS/HEADER_METHOD_PATTERN almost certainly need "
                  "tuning to your real log format. Paste a few real (redacted) log lines here so they can be "
                  "adjusted before relying on this for real.")
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

    if serve_port:
        if not local_html:
            print("[error] --serve-port requires --local-html (nothing to serve otherwise).", file=sys.stderr)
            sys.exit(1)
        if not os.path.exists(local_html):
            write_local_html(state, local_html)  # so the URL is live immediately, not 404 until the first push
        start_local_server(local_html, serve_port)

    # In-memory only (never persisted to STATE_FILE) - see assemble_multiline_observations()'s
    # docstring for why a partially-read JSON block should never touch disk.
    multiline_carry = {"method": None, "buffer": "", "in_json": False, "depth": 0}

    while True:
        lines = tail_new_lines(MULE_LOG_PATH, state)
        observations = [o for o in (parse_line(l) for l in lines) if o]
        observations += assemble_multiline_observations(lines, multiline_carry)
        if observations:
            aggregate(state, observations)
            print(f"[info] parsed {len(observations)} HTTP-shaped line(s) this cycle "
                  f"({len(state['endpoints'])} distinct endpoint(s) known so far)")
        save_state(state)

        if time.time() - state.get("last_push", 0) >= PUSH_INTERVAL_SECONDS and state.get("endpoints"):
            if local_html:
                try:
                    write_local_html(state, local_html)
                except Exception as e:
                    print(f"[error] writing local HTML report failed, will retry next cycle: {e}", file=sys.stderr)
            elif dry_run:
                project = build_project(state)
                print("[dry-run] would push project:")
                print(json.dumps(project, indent=2)[:4000])
            else:
                try:
                    existing = client.get_workspace()
                    existing_project = existing.get("projects", {}).get(PROJECT_ID)
                    project = build_project(state, existing_project)
                    if existing_project:
                        project["_rev"] = existing_project.get("_rev")
                    client.push_project(project)
                except Exception as e:
                    print(f"[error] push failed, will retry next cycle: {e}", file=sys.stderr)
            state["last_push"] = time.time()
            save_state(state)

        time.sleep(POLL_INTERVAL_SECONDS)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="Parse and aggregate, but never call DocTracker.")
    ap.add_argument("--sample-lines", type=int, default=None, help="Print N parsed lines and exit (for validating the log parser).")
    ap.add_argument("--local-html", metavar="PATH", default=None,
                     help="Write a self-contained local HTML report to PATH instead of pushing to DocTracker. "
                          "No network call is ever made in this mode - see the data-residency note at the top of this file.")
    ap.add_argument("--serve-port", type=int, default=None,
                     help="With --local-html, also serve the report over http://127.0.0.1:PORT (localhost-only, "
                          "never externally reachable). View from your own machine via an SSH tunnel.")
    args = ap.parse_args()
    run(dry_run=args.dry_run, sample_lines=args.sample_lines, local_html=args.local_html, serve_port=args.serve_port)
