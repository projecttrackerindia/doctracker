#!/usr/bin/env python3
"""Tests for Style D parsing - APIkit flow names in Mule thread names.

    python3 ops/sit-doc-agent/tests/test_apikit_parsing.py

Every line below is VERBATIM from a real production node, unmodified.

Why this style exists: Mule does not log a line per HTTP request by default,
so the "HTTP Listener received: POST /x" pattern the agent originally looked
for simply never appears in most deployments. On a node with 103 apps, 102 of
them parsed at 0%. What IS present on every line a flow logs while handling a
request is the APIkit flow name, inside the thread name:

  [[MuleRuntime].uber.37: [common-jwt-auth].post:\\token:application\\json:
   jwt-token-api-config/processors/2.CPU_INTENSIVE @52800c94]
   [processor: common-logger-flow/processors/0; event: ea4101a1-b7d2-...]

which yields POST /token plus a correlation id.

The dangerous part is counting. One request emits many such lines, all
sharing one `event:` id, so counting lines instead of distinct events
overstates traffic by roughly an order of magnitude - and it would look
entirely plausible on the dashboard.
"""
import os
import sys

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


STARTUP_FLOW = (
    r'INFO  2026-09-24 10:00:06,705 [ArtifactDeployer.start.01] [processor: ; event: ] '
    r'org.mule.runtime.core.internal.construct.FlowConstructLifecycleManager: '
    r'Starting flow: post:\userEncrypt:application\json:jwt-token-api-config'
)
REQ_A1 = (
    r'INFO  2026-09-24 10:16:33,311 [[MuleRuntime].uber.37: [common-jwt-auth].'
    r'post:\token:application\json:jwt-token-api-config/processors/2.CPU_INTENSIVE @52800c94] '
    r'[processor: common-logger-flow/processors/0; event: ea4101a1-b7d2-11f1-8e71-02783a995911] '
    r'org.mule.runtime.core.internal.processor.LoggerMessageProcessor: {'
)
REQ_A2 = (
    r'INFO  2026-09-24 10:16:33,364 [[MuleRuntime].uber.32: [common-jwt-auth].'
    r'post:\token:application\json:jwt-token-api-config.BLOCKING @a124a7a] '
    r'[processor: GoogleSecops-log-flow/processors/1/route/0/processors/0; '
    r'event: ea4101a1-b7d2-11f1-8e71-02783a995911] '
    r'org.mule.runtime.core.internal.processor.LoggerMessageProcessor: before googlesecops call'
)
REQ_B = REQ_A1.replace("ea4101a1-b7d2-11f1-8e71-02783a995911", "ec39c460-b7d2-11f1-8e71-02783a995911")
REQ_C = REQ_A1.replace("ea4101a1-b7d2-11f1-8e71-02783a995911", "ed1afca0-b7d2-11f1-8e71-02783a995911")
ERROR_FLOWSTACK = (
    r'at post:\paymentReceipts:application\json:x-lms-flexcube-api-config'
    r'(post:\paymentReceipts:application\json:x-lms-flexcube-api-config/processors/1 '
    r'@ x-lms-flexcube-api:implementation.xml:402)'
)
NON_APIKIT_FLOW = (
    r'INFO  2026-09-24 10:06:28,144 [ArtifactDeployer.start.01] [processor: ; event: ] '
    r'org.mule.runtime.core.internal.construct.FlowConstructLifecycleManager: '
    r'Starting flow: Credential-request-error-flow'
)
STARTUP_NOISE = (
    r'WARN  2026-09-24 10:09:31,116 [WrapperListener_start_runner] [processor: ; event: ] '
    r'org.mule.runtime.extension.internal.loader.enricher.ConfigRefDeclarationEnricher: something'
)

print("Parsing")
o = agent.parse_line(STARTUP_FLOW)
check("startup flow yields method and path", o and o["method"] == "POST" and o["path"] == "/userEncrypt",
      "got %r" % o)
check("startup flow is marked as inventory, not traffic", o and o.get("isInventory") is True,
      "got %r" % (o or {}).get("isInventory"))

o = agent.parse_line(REQ_A1)
check("request line yields method and path", o and o["method"] == "POST" and o["path"] == "/token",
      "got %r" % o)
check("request line yields the event id as correlation id",
      o and o["correlationId"] == "ea4101a1-b7d2-11f1-8e71-02783a995911", "got %r" % (o or {}).get("correlationId"))
check("request line is not marked as inventory", o and not o.get("isInventory"))

o = agent.parse_line(ERROR_FLOWSTACK)
check("an error FlowStack line yields the endpoint",
      o and o["method"] == "POST" and o["path"] == "/paymentReceipts", "got %r" % o)

check("a non-APIkit flow name is ignored", agent.parse_line(NON_APIKIT_FLOW) is None,
      "got %r" % agent.parse_line(NON_APIKIT_FLOW))
check("ordinary startup noise is ignored", agent.parse_line(STARTUP_NOISE) is None,
      "got %r" % agent.parse_line(STARTUP_NOISE))

print("APIkit path conversion")
check("backslashes become slashes", agent.apikit_path_to_uri(r"\token") == "/token",
      agent.apikit_path_to_uri(r"\token"))
check("(param) becomes {param}",
      agent.apikit_path_to_uri(r"\customers\(customerId)\orders") == "/customers/{customerId}/orders",
      agent.apikit_path_to_uri(r"\customers\(customerId)\orders"))
check("an empty path is the root resource", agent.apikit_path_to_uri("") == "/",
      agent.apikit_path_to_uri(""))

print("Counting (the part that would silently inflate traffic)")
lines = [STARTUP_FLOW, REQ_A1, REQ_A2, REQ_B, REQ_C, ERROR_FLOWSTACK, NON_APIKIT_FLOW, STARTUP_NOISE]
obs = [x for x in (agent.parse_line(l) for l in lines) if x]
state = {"endpoints": {}, "health": {}}
agent.aggregate(state, obs)

tok = state["endpoints"].get("POST /token")
check("5 lines sharing 3 event ids count as 3 requests", tok and tok["totalRequests"] == 3,
      "counted %r" % (tok or {}).get("totalRequests"))

inv = state["endpoints"].get("POST /userEncrypt")
check("a startup-only endpoint is discovered with zero requests",
      inv and inv["totalRequests"] == 0 and inv.get("discoveredOnly", 0) >= 1,
      "got %r" % inv)

err = state["endpoints"].get("POST /paymentReceipts")
check("an endpoint seen only in an error trace is not counted as traffic",
      err and err["totalRequests"] == 0, "got %r" % err)

agent.aggregate(state, obs)   # same lines again, as if straddling a cycle boundary
check("re-reading the same lines does not double count",
      state["endpoints"]["POST /token"]["totalRequests"] == 3,
      "counted %r" % state["endpoints"]["POST /token"]["totalRequests"])

# A genuinely new request for the same endpoint must still increment.
agent.aggregate(state, [x for x in [agent.parse_line(
    REQ_A1.replace("ea4101a1-b7d2-11f1-8e71-02783a995911", "ffffffff-b7d2-11f1-8e71-02783a995911"))] if x])
check("a new event id does increment the count",
      state["endpoints"]["POST /token"]["totalRequests"] == 4,
      "counted %r" % state["endpoints"]["POST /token"]["totalRequests"])

print("Structured JSON log blocks (RequestUri / FlowName / statusCode)")
# Found on the production node: a JSON logger emitting a complete per-request
# record. The agent parsed the block fine and then discarded it because the
# HTTP method was not on the preceding line - it is implied by the APIkit
# FlowName INSIDE the block. A full record with a real status code, client IP
# and latency was being thrown away for want of one field.
import json  # noqa: E402

BLOCK = {
    "ApplicationName": "s-portal-employee-api",
    "FlowName": r"post:\employee\(employeeId)\receipt:application\json:s-portal-employee-api-config",
    "RequestUri": "/api/employee/9931/receipt?trace=1",
    "correlationId": "ea4101a1-b7d2-11f1-8e71-02783a995911",
    "statusCode": 200,
    "X-Forwarded-For": "10.2.7.55",
    "entry": {"TimestampIST": "2026-09-24 10:16:33.311", "FlowName": "employee-receipt-flow"},
    "exit": {"TimestampIST": "2026-09-24 10:16:33.964", "FlowName": "employee-receipt-flow"},
    "RequestPayload": {"amount": 1200, "password": "hunter2", "userId": "u-1"},
}
block_lines = [
    "INFO  2026-09-24 10:16:33,311 [[MuleRuntime].uber.37: [s-portal-employee-api].uber@x] "
    "[processor: common-logger-flow/processors/0; event: ea4101a1-b7d2-11f1-8e71-02783a995911] "
    "org.mule.runtime.core.internal.processor.LoggerMessageProcessor: {"
] + json.dumps(BLOCK, indent=2).splitlines()[1:]

carry = {"method": None, "buffer": "", "in_json": False, "depth": 0}
block_obs = agent.assemble_multiline_observations(block_lines, carry)
check("a JSON block with no method on the preceding line is still recovered",
      len(block_obs) == 1, "got %d observation(s)" % len(block_obs))
if block_obs:
    b = block_obs[0]
    check("method is taken from the APIkit FlowName in the block", b["method"] == "POST",
          "got %r" % b["method"])
    check("path comes from RequestUri, query string stripped",
          b["path"] == "/api/employee/9931/receipt", "got %r" % b["path"])
    check("status code is captured", b["statusCode"] == 200, "got %r" % b["statusCode"])
    check("client IP comes from X-Forwarded-For", b.get("clientIp") == "10.2.7.55",
          "got %r" % b.get("clientIp"))
    check("latency is derived from entry/exit timestamps", b.get("latencyMs") == 653,
          "got %r" % b.get("latencyMs"))

# The security posture this unlocks has to hold, since these blocks carry real
# request payloads.
saved_mode = agent.CAPTURE_MODE
try:
    agent.CAPTURE_MODE = "aggregate"
    st_agg = {"endpoints": {}, "health": {}}
    agent.aggregate(st_agg, block_obs)
    agg_blob = json.dumps(st_agg)
    shapes = list(st_agg["endpoints"].values())[0]["fieldShapes"]
    check("aggregate mode keeps field names and types only",
          shapes.get("password") == "String" and "hunter2" not in agg_blob,
          "shapes=%r leaked=%s" % (shapes, "hunter2" in agg_blob))
    check("aggregate mode keeps no per-request records", not st_agg.get("logRecords"),
          "got %r" % st_agg.get("logRecords"))

    agent.CAPTURE_MODE = "full"
    st_full = {"endpoints": {}, "health": {}}
    agent.aggregate(st_full, block_obs)
    full_blob = json.dumps(st_full)
    check("full mode redacts a credential-named field", "hunter2" not in full_blob,
          "the raw password value reached stored state")
    recs = st_full.get("logRecords") or []
    check("full mode templates ids out of the stored path",
          bool(recs) and "{" in recs[0].get("path", ""), "got %r" % (recs[0].get("path") if recs else None))
finally:
    agent.CAPTURE_MODE = saved_mode

print()
if FAILURES:
    print("FAILED (%d): %s" % (len(FAILURES), ", ".join(FAILURES)))
    sys.exit(1)
print("All APIkit parsing tests passed.")
