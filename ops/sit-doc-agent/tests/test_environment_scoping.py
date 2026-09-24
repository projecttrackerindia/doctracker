#!/usr/bin/env python3
"""Environment scoping - the agent half.

    python3 ops/sit-doc-agent/tests/test_environment_scoping.py

The same API is deployed to SIT, UAT and PROD. If an agent doesn't say which
environment its node serves, the server has to guess or pool, and a pooled
`totalRequests` isn't a rougher truth - it's a wrong number, useless for
capacity work. Pooling also carries a disclosure problem: PROD source IPs
surfacing in a view someone opened for SIT.

So the agent must REFUSE to push without an explicit environment rather than
default to one. These tests pin that refusal, because a well-meaning later
change ("just default it to SIT") would reintroduce exactly the silent
mislabelling this exists to prevent.

The server-side composition rule (never sum across environments) is asserted
separately against composeWriterSegments; this file covers what the agent
sends and when it declines to send at all.
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
AGENT_DIR = os.path.dirname(HERE)
REPO = os.path.dirname(os.path.dirname(AGENT_DIR))
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


print("The agent refuses to guess an environment")
saved = agent.ENVIRONMENT
try:
    agent.ENVIRONMENT = ""
    try:
        agent.require_environment()
        check("an unset environment is a hard error", False, "it returned instead of exiting")
    except SystemExit as e:
        msg = str(e)
        check("an unset environment is a hard error", True)
        check("the error says nothing was pushed", "Nothing has been pushed" in msg, msg[:120])
        check("the error names the variable to set", "DOCTRACKER_ENVIRONMENT" in msg, msg[:120])

    # It must not silently fall back to a hostname, a default, or the project id.
    check("there is no default environment value",
          os.environ.get("DOCTRACKER_ENVIRONMENT") is None or True)
    src = open(os.path.join(AGENT_DIR, "mule_doc_agent.py"), encoding="utf-8").read()
    m = re.search(r'ENVIRONMENT = os\.environ\.get\("DOCTRACKER_ENVIRONMENT"[^)]*\)', src)
    check("the config line supplies no fallback string",
          bool(m) and '""' in m.group(0) and 'SIT' not in m.group(0),
          "got %r" % (m.group(0) if m else None))

    print("Valid and invalid environment labels")
    for good in ("SIT", "UAT", "PROD", "SIT", "pre-prod", "DR_2"):
        agent.ENVIRONMENT = good
        try:
            check("%r is accepted" % good, agent.require_environment() == good)
        except SystemExit as e:
            check("%r is accepted" % good, False, str(e)[:80])

    for bad, why in [
        ("-leading-dash", "must start alphanumeric"),
        ("has/slash", "slash is not allowed"),
        ("<script>", "must not admit markup"),
        ("x" * 33, "longer than 32 chars"),
    ]:
        agent.ENVIRONMENT = bad
        try:
            agent.require_environment()
            check("%s is rejected" % why, False, "%r was accepted" % bad)
        except SystemExit:
            check("%s is rejected" % why, True)
finally:
    agent.ENVIRONMENT = saved

print("A project remembers which environment discovered it")
saved_env = agent.ENVIRONMENT
try:
    agent.ENVIRONMENT = "SIT"
    st = {"endpoints": {}, "health": {}}
    agent.aggregate(st, [{"method": "GET", "path": "/x", "statusCode": 200,
                          "correlationId": "c-1", "body": None, "app": "x-api"}])
    proj = agent.build_project(st)
    check("build_project stamps the project with the agent's environment",
          proj.get("discoveryEnvironment") == "SIT", "got %r" % proj.get("discoveryEnvironment"))
    check("the project name reflects the environment, not a fixed 'SIT' string",
          proj.get("name") == "SIT Auto-Discovery - unreviewed", "got %r" % proj.get("name"))
    check("lifecycle reflects the environment too", proj.get("lifecycle") == "SIT",
          "got %r" % proj.get("lifecycle"))

    agent.ENVIRONMENT = "UAT"
    proj2 = agent.build_project(st)
    check("a different agent's project is named for ITS environment",
          proj2.get("name") == "UAT Auto-Discovery - unreviewed", "got %r" % proj2.get("name"))
finally:
    agent.ENVIRONMENT = saved_env

print("The project push refuses to overwrite a different environment's project")
# PUT /projects is a whole-project overwrite keyed only by
# DOCTRACKER_PROJECT_ID - unlike endpoint-metrics, which segments by
# writerId precisely so agents can't clobber each other. A second agent left
# at the default DOCTRACKER_PROJECT_ID would otherwise silently erase every
# endpoint a first agent had discovered, and the two would alternately wipe
# each other out forever with no error on either side.
check("no existing project is never a conflict",
      agent.project_environment_conflict(None, "SIT") is None)
check("an existing project with no recorded environment is never a conflict "
      "(pre-upgrade projects must not suddenly start refusing to push)",
      agent.project_environment_conflict({"discoveryEnvironment": None}, "SIT") is None)
check("the SAME environment pushing again is never a conflict",
      agent.project_environment_conflict({"discoveryEnvironment": "SIT"}, "SIT") is None)
check("matching is case-insensitive",
      agent.project_environment_conflict({"discoveryEnvironment": "sit"}, "SIT") is None)
check("a DIFFERENT environment's project is a real conflict",
      agent.project_environment_conflict({"discoveryEnvironment": "UAT"}, "SIT") == "UAT",
      "got %r" % agent.project_environment_conflict({"discoveryEnvironment": "UAT"}, "SIT"))
check("no environment declared on this side is never treated as a conflict "
      "(require_environment() is what refuses that case, not this function)",
      agent.project_environment_conflict({"discoveryEnvironment": "UAT"}, "") is None)

print("The server composes per environment and never across")
# Asserted against the real route source rather than a copy of the rule, so
# this fails if someone reverts the composition to a single pooled pass.
ws = open(os.path.join(REPO, "server", "routes", "workspace.js"), encoding="utf-8").read()
check("composeWriterSegments groups writers by environment",
      "segmentEnvironment(seg)" in ws and "byEnv.set(env" in ws)
check("the per-environment composer is a separate function",
      "function composeOneEnvironment(" in ws)
check("the summing of totalRequests happens inside the per-environment composer",
      ws.index("function composeOneEnvironment(") < ws.index("merged.totalRequests =") <
      ws.index("function composeWriterSegments("),
      "the sum is no longer scoped to one environment")
check("a segment with no environment is kept, not dropped", "UNSCOPED_ENVIRONMENT" in ws)
check("the environment label is validated server-side, not trusted as sent",
      "A-Za-z0-9 _-]{0,31}" in ws)
check("GET exposes the environment names for the selector",
      "environmentNames" in ws and "defaultEnvironment" in ws)

print("Auto-discovered endpoints bypass promotion for their OWN environment only")
util = open(os.path.join(REPO, "public", "js", "studio", "05-util.js"), encoding="utf-8").read()
check("viewEndpoints checks discoveryEnvironment before falling back to the snapshot gate",
      "proj.discoveryEnvironment" in util and "toLowerCase() === String(state.env" in util)
seg = util[util.index("function viewEndpoints("):]
seg = seg[:seg.index("\nfunction invalidateSnapshotCache(")]
check("the discoveryEnvironment check runs FIRST, ahead of the draft-env check",
      seg.index("discoveryEnvironment") < seg.index("isViewingDraftEnv()"),
      "an auto-discovered project must not leak into Dev via the draft-env "
      "always-live rule - Dev shows every hand-written project's full "
      "content, but a SIT discovery is SIT data, not draft work sitting in "
      "Dev, and must stay invisible outside the environment it was "
      "actually observed in")
check("the bypass returns the raw endpoint list on a match",
      "return proj.endpoints" in seg)
check("a non-matching environment returns nothing at all - not even in the draft/Dev view",
      "? proj.endpoints : [];" in seg or ": [];" in seg)
check("a project with NO discoveryEnvironment still falls through to the draft/snapshot gate",
      "snapshotEntry(proj.id)" in seg)

print("The page shows which environment a number came from")
obs = open(os.path.join(REPO, "public", "js", "studio", "23-observability.js"), encoding="utf-8").read()
check("the page follows the header environment (state.env), not its own picker",
      "String(state.env" in obs and "obsActiveEnvironment()" in obs)
check("environment names are matched case-insensitively",
      "toLowerCase()" in obs and "obsEnvironmentNames()" in obs)

# The bug this replaced: the header read Dev while the dashboard showed SIT.
# Two controls disagreeing about the same question is worse than one.
events = open(os.path.join(REPO, "public", "js", "studio", "21-events.js"), encoding="utf-8").read()
check("the page no longer has a second, competing environment picker",
      "data-obs-env" not in obs and "data-obs-env" not in events)
check("setObsEnvironment is gone with it", "setObsEnvironment" not in obs and "setObsEnvironment" not in events)

# Most important: an environment with no agent must show NOTHING, never
# another environment's figures.
obs_code = chr(10).join(l for l in obs.splitlines() if not l.strip().startswith("//"))
seg = obs_code[obs_code.index("function observabilityData("):]
seg = seg[:seg.index("function renderObsEnvironmentBar(")]
check("an unreported environment returns empty rather than falling back",
      "if(!src || typeof src !== 'object') return empty;" in seg,
      "a fallback to another environment's data may still exist")
check("no pooled 'all environments' option is offered",
      "All environments" not in obs_code and 'data-obs-env="*"' not in obs_code)
check("the empty state names the environment that has no agent",
      "No agent is reporting for" in obs)
check("a legacy unscoped blob is labelled as unknown, not as the selected environment",
      "predate per-environment" in obs)

print()
if FAILURES:
    print("FAILED (%d): %s" % (len(FAILURES), ", ".join(FAILURES)))
    sys.exit(1)
print("All environment-scoping tests passed.")
