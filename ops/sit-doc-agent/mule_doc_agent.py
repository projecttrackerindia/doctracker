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
    python3 mule_doc_agent.py --dry-run          # parse + print, no network calls at all
    python3 mule_doc_agent.py --sample-lines 50   # print first 50 parsed/unparsed lines, then exit
    python3 mule_doc_agent.py                     # real run: tail, aggregate, push to DocTracker

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
import ssl
from urllib.parse import urlparse


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
MAX_EXAMPLES_PER_STATUS = 3

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
# Naming-heuristic description generator - same approach used to backfill
# field descriptions in DocTracker earlier in this engagement. No LLM: a
# small dictionary of regexes matched against the field's own name.
# ============================================================================
DESC_HEURISTICS = [
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
    new file rather than crashing or silently missing the rotated-out tail."""
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
        for line in f:
            lines.append(line.rstrip("\n"))
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
# ============================================================================
def aggregate(state, observations):
    endpoints = state.setdefault("endpoints", {})
    for obs in observations:
        key = f"{obs['method']} {obs['path']}"
        ep = endpoints.setdefault(key, {
            "method": obs["method"], "path": obs["path"],
            "statusCodes": {}, "correlationIds": [], "fieldShapes": {},
        })
        if obs.get("statusCode"):
            sc = str(obs["statusCode"])
            examples = ep["statusCodes"].setdefault(sc, [])
            if obs.get("body") and len(examples) < MAX_EXAMPLES_PER_STATUS:
                examples.append(obs["body"])
        if obs.get("correlationId") and obs["correlationId"] not in ep["correlationIds"]:
            if len(ep["correlationIds"]) < 20:  # cap - this is just a discovery sample, not an audit trail
                ep["correlationIds"].append(obs["correlationId"])
        if isinstance(obs.get("body"), dict):
            shapes = ep["fieldShapes"]
            for k, v in obs["body"].items():
                shapes[k] = infer_type(v)


# ============================================================================
# Anomaly flags - mechanical only, no semantic guessing
# ============================================================================
def anomaly_notes(ep):
    notes = []
    codes = list(ep["statusCodes"].keys())
    if "200" in ep["statusCodes"]:
        for body in ep["statusCodes"]["200"]:
            if isinstance(body, dict) and any(k in body for k in ("error", "errorCode", "errorMessage")):
                notes.append("A 200 response was observed containing an error/errorCode/errorMessage key - "
                              "possible business-error-returned-as-200 pattern (see this engagement's earlier "
                              "F-04-style findings). Needs human review, not auto-flagged as broken.")
                break
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
        responses = [
            {"code": int(sc) if sc.isdigit() else 0, "description": f"Observed {len(examples)} time(s) in SIT logs.",
             "fields": [], "example": json.dumps(examples[0]) if examples else "", "examples": []}
            for sc, examples in ep["statusCodes"].items()
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
# Main loop
# ============================================================================
def run(dry_run=False, sample_lines=None):
    state = load_state()

    if sample_lines:
        print(f"[info] sample mode: reading up to {sample_lines} NEW lines from {MULE_LOG_PATH}\n")
        lines = tail_new_lines(MULE_LOG_PATH, dict(state))[:sample_lines]
        matched, unmatched = 0, 0
        for line in lines:
            obs = parse_line(line)
            if obs:
                matched += 1
                print(f"MATCHED   {obs['method']} {obs['path']}  status={obs.get('statusCode')}  corr={obs.get('correlationId')}")
            else:
                unmatched += 1
                print(f"UNMATCHED {line[:160]}")
        print(f"\n[info] {matched} matched, {unmatched} unmatched out of {len(lines)} lines.")
        if matched == 0 and lines:
            print("[warn] Nothing matched at all - LINE_PATTERNS almost certainly needs tuning to your real log "
                  "format. Paste a few real (redacted) log lines and adjust the regex/JSON-key list at the top "
                  "of this file before relying on this for real.")
        return

    client = None
    if not dry_run:
        if not DOCTRACKER_PASSWORD:
            print("[error] DOCTRACKER_PASSWORD is not set. Set it (or run with --dry-run) before running for real.", file=sys.stderr)
            sys.exit(1)
        client = DocTrackerClient(DOCTRACKER_BASE_URL, DOCTRACKER_USERNAME, DOCTRACKER_PASSWORD)
        client.login()

    print(f"[info] tailing {MULE_LOG_PATH} every {POLL_INTERVAL_SECONDS}s, "
          f"pushing every {PUSH_INTERVAL_SECONDS}s{' (DRY RUN - no network writes)' if dry_run else ''}")

    while True:
        lines = tail_new_lines(MULE_LOG_PATH, state)
        observations = [o for o in (parse_line(l) for l in lines) if o]
        if observations:
            aggregate(state, observations)
            print(f"[info] parsed {len(observations)} HTTP-shaped line(s) this cycle "
                  f"({len(state['endpoints'])} distinct endpoint(s) known so far)")
        save_state(state)

        if time.time() - state.get("last_push", 0) >= PUSH_INTERVAL_SECONDS and state.get("endpoints"):
            project = build_project(state)
            if dry_run:
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
    args = ap.parse_args()
    run(dry_run=args.dry_run, sample_lines=args.sample_lines)
