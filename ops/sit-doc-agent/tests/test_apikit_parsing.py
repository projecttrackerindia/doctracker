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

print()
if FAILURES:
    print("FAILED (%d): %s" % (len(FAILURES), ", ".join(FAILURES)))
    sys.exit(1)
print("All APIkit parsing tests passed.")
