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

print("Block-shape variants found on the production node")
# Each of these was a real [warn] in the sample run against 103 app logs.

# 1. Trailing text after the closing brace. json.loads calls this "Extra data"
#    and rejects the whole record; raw_decode keeps it.
obj, err = agent._decode_json_block('{"RequestUri": "/a", "method": "GET"} trailing mule suffix')
check("a block with trailing text after the closing brace still parses",
      err is None and obj and obj.get("RequestUri") == "/a", "err=%r obj=%r" % (err, obj))
obj, err = agent._decode_json_block('{ this is not json at all')
check("genuinely broken JSON is still reported as broken", obj is None and err is not None)

# 2. 'endpoint' as the path key, seen alongside an explicit 'method'.
ENDPOINT_KEY_BLOCK = {
    "correlationid": "aaaaaaaa-b7d2-11f1-8e71-02783a995911",
    "method": "POST", "endpoint": "/portal/common/lookup", "target": "https://internal.example",
    "message": "calling downstream", "timestampIST": "2026-09-24 10:16:33.311",
}
ek_lines = [
    "INFO  2026-09-24 10:16:33,311 [[MuleRuntime].uber.1: [s-portal-common-api].uber@x] "
    "[processor: x/processors/0; event: aaaaaaaa-b7d2-11f1-8e71-02783a995911] "
    "org.mule.runtime.core.internal.processor.LoggerMessageProcessor: {"
] + json.dumps(ENDPOINT_KEY_BLOCK, indent=2).splitlines()[1:]
ek_carry = {"method": None, "buffer": "", "in_json": False, "depth": 0}
ek_obs = agent.assemble_multiline_observations(ek_lines, ek_carry)
check("a block whose path key is named 'endpoint' is recovered",
      len(ek_obs) == 1 and ek_obs[0]["path"] == "/portal/common/lookup",
      "got %r" % ([o.get("path") for o in ek_obs],))

# 3. The path-likeness guard: those looser key names must not admit a host,
#    a queue name or free text just because the key is called 'target'.
check("a bare hostname under 'target' is rejected as a path",
      agent._path_like("https://internal.example") == "/", agent._path_like("https://internal.example"))
check("a queue/table name is rejected as a path", agent._path_like("LOAN_TXN_QUEUE") is None,
      agent._path_like("LOAN_TXN_QUEUE"))
check("free text is rejected as a path", agent._path_like("calling downstream now") is None,
      agent._path_like("calling downstream now"))
check("an absolute URL keeps only its path",
      agent._path_like("https://host:8443/api/v1/loan?x=1") == "/api/v1/loan",
      agent._path_like("https://host:8443/api/v1/loan?x=1"))
check("a fragment is stripped too", agent._path_like("/api/v1/loan#top") == "/api/v1/loan",
      agent._path_like("/api/v1/loan#top"))

# 4. Several FlowName keys in one block - only a nested one is the APIkit name.
#    This is the s-lms-flexcube-api shape, which was being discarded entirely.
MULTI_FLOW_BLOCK = {
    "ApplicationName": "s-lms-flexcube-api",
    "FlowName": "loan-receipt-business-flow",          # plain name, no method
    "RequestUri": "/api/loan/9931/receipt",
    "statusCode": 200,
    "entry": {"TimestampIST": "2026-09-24 10:16:33.311",
              "FlowName": r"put:\loan\(loanId)\receipt:application\json:s-lms-flexcube-api-config"},
    "exit": {"TimestampIST": "2026-09-24 10:16:33.811", "FlowName": "loan-receipt-business-flow"},
}
mf_lines = [
    "INFO  2026-09-24 10:16:33,311 [[MuleRuntime].uber.1: [s-lms-flexcube-api].uber@x] "
    "[processor: x/processors/0; event: bbbbbbbb-b7d2-11f1-8e71-02783a995911] "
    "org.mule.runtime.core.internal.processor.LoggerMessageProcessor: {"
] + json.dumps(MULTI_FLOW_BLOCK, indent=2).splitlines()[1:]
mf_carry = {"method": None, "buffer": "", "in_json": False, "depth": 0}
mf_obs = agent.assemble_multiline_observations(mf_lines, mf_carry)
check("the APIkit FlowName is found even when it is not the first FlowName key",
      len(mf_obs) == 1 and mf_obs[0]["method"] == "PUT",
      "got %r" % ([o.get("method") for o in mf_obs],))
check("_find_all_key_values returns every match, not just the first",
      len(agent._find_all_key_values(MULTI_FLOW_BLOCK, agent.FLOWNAME_KEY_PATTERN)) == 3,
      "got %d" % len(agent._find_all_key_values(MULTI_FLOW_BLOCK, agent.FLOWNAME_KEY_PATTERN)))

# 5. Correlation-id method memory: the method came from an earlier APIkit
#    thread-name line, NOT from a guess about the payload.
agent._CORRID_METHOD.clear()
CORR = "cccccccc-b7d2-11f1-8e71-02783a995911"
NO_METHOD_BLOCK = {"RequestUri": "/api/employee/77/photo", "statusCode": 204,
                   "correlationId": CORR, "FlowName": "photo-business-flow"}
nm_lines = [
    "INFO  2026-09-24 10:16:33,311 [[MuleRuntime].uber.1: [s-portal-employee-api].uber@x] "
    "[processor: x/processors/0; event: %s] "
    "org.mule.runtime.core.internal.processor.LoggerMessageProcessor: {" % CORR
] + json.dumps(NO_METHOD_BLOCK, indent=2).splitlines()[1:]

nm_carry = {"method": None, "buffer": "", "in_json": False, "depth": 0}
check("with nothing remembered, a method-less block is still not invented",
      len(agent.assemble_multiline_observations(nm_lines, nm_carry)) == 0,
      "an observation was fabricated without a method")

# Now the APIkit line for that same request is seen first, as it is in a real log.
agent.parse_line(
    r'INFO  2026-09-24 10:16:30,000 [[MuleRuntime].uber.9: [s-portal-employee-api].'
    r'delete:\employee\(employeeId)\photo:application\json:s-portal-employee-api-config.BLOCKING @x] '
    r'[processor: p/processors/0; event: %s] '
    r'org.mule.runtime.core.internal.processor.LoggerMessageProcessor: start' % CORR)
check("an APIkit line records its correlation id -> method",
      agent._CORRID_METHOD.get(CORR, (None,))[0] == "DELETE",
      "got %r" % (agent._CORRID_METHOD.get(CORR),))
nm_carry = {"method": None, "buffer": "", "in_json": False, "depth": 0}
nm_obs = agent.assemble_multiline_observations(nm_lines, nm_carry)
check("the method-less block now recovers its method from that correlation id",
      len(nm_obs) == 1 and nm_obs[0]["method"] == "DELETE" and nm_obs[0]["statusCode"] == 204,
      "got %r" % ([(o.get("method"), o.get("statusCode")) for o in nm_obs],))

# A startup "Starting flow:" line proves an endpoint exists but is NOT a
# request, so it must not seed the map and let an unrelated later block
# inherit its method.
agent._CORRID_METHOD.clear()
agent.parse_line(STARTUP_FLOW)
check("a startup inventory line does not seed the correlation-id map",
      len(agent._CORRID_METHOD) == 0, "map=%r" % (list(agent._CORRID_METHOD),))

check("the correlation-id map is bounded", agent.MAX_CORRID_METHODS <= 50000)
for i in range(agent.MAX_CORRID_METHODS + 50):
    agent.remember_corrid_method("id-%d" % i, "GET", "/x")
check("the map evicts oldest once full", len(agent._CORRID_METHOD) == agent.MAX_CORRID_METHODS,
      "grew to %d" % len(agent._CORRID_METHOD))
agent._CORRID_METHOD.clear()

print()
if FAILURES:
    print("FAILED (%d): %s" % (len(FAILURES), ", ".join(FAILURES)))
    sys.exit(1)
print("All APIkit parsing tests passed.")
