# DocTracker SIT Auto-Discovery Agent

Reads MuleSoft application logs already being written on this server, infers
API endpoint shapes (method, path, status codes, field names/types from any
request/response bodies already present in the logs), and pushes a **draft,
unreviewed** project into DocTracker. No LLM, no third-party Python packages
— standard library only.

**Nothing here auto-publishes as real documentation.** Everything lands in a
project named "SIT Auto-Discovery — unreviewed", clearly separate from your
reviewed docs, with every generated field description explicitly marked
`[auto-generated ... needs human review]`.

## Before you deploy this — register it with SOC

This process will read log files and make outbound HTTPS calls from a SIT
server. In a monitored environment, an unregistered new process doing that
is exactly what a SOC should flag. Before running this for real:

1. **Log it as a known asset** in whatever change-management/asset register
   your SOC uses — purpose: "automated API documentation discovery, reads
   existing app logs, writes structured drafts to DocTracker."
2. **It authenticates as its own account**, not a personal login — see
   Configuration below. Its actions are attributable in DocTracker's own
   audit trail as `svc-doc-agent`, distinct from any human user.
3. **Its only outbound destination** is your DocTracker URL over HTTPS
   (443). No LLM API calls in this version. Whitelist that one destination
   explicitly rather than leaving it as unexplained egress.
4. **Its traffic self-identifies** — every request carries the User-Agent
   `DocTracker-SIT-Agent/1.0 (svc-doc-agent; see AGENT_README.md)`.

### Whitelisting: use the hostname, not an IP

Whitelist the FQDN, not a resolved IP address:

```
doctracker-production-7ecc.up.railway.app  (HTTPS / 443)
```

DocTracker is hosted on Railway, which sits behind a shared, dynamic edge
network — the IP this hostname resolves to can change at any time, with no
deploy or change on our side. Most enterprise egress firewalls (Palo Alto,
Fortinet, Zscaler, corporate proxies, etc.) support FQDN-based allow rules
for exactly this reason. If your SOC's firewall genuinely only accepts
IP-based rules, treat any IP you whitelist as temporary and re-verify it
periodically (`nslookup doctracker-production-7ecc.up.railway.app`) rather
than assuming it's permanent — pinning to a point-in-time IP on a shared
Railway domain will eventually break silently when it rotates.

## What it does NOT do

- Does not capture anything beyond what Mule **already wrote to its own log
  file**. If your logging config doesn't log request/response bodies (common
  for compliance reasons), this agent won't see them either — it'll still
  discover endpoints/methods/paths/status-codes, just without field-level
  detail.
- In the default `CAPTURE_MODE=aggregate`, never keeps a real captured field
  VALUE anywhere (only field names and inferred types) and never keeps a
  per-request record — only running counts. `CAPTURE_MODE=full` is a
  separate, explicit opt-in that changes this; see "Capture mode" below
  before turning it on.
- Does not call any LLM or external AI service.
- Does not modify, delete, or truncate the log file it reads.
- Does not touch any of your existing, reviewed DocTracker projects — it
  only ever writes to its own dedicated `sitautodisc1` project.

## Capture mode

By default (`CAPTURE_MODE=aggregate`, and every version of this agent before
this option existed) the agent keeps **only counts and field names/types** —
never a captured field value, never an individual log line or per-request
record. This is what makes the earlier security review of this agent hold:
a real login request in this deployment's own `jwt-token-api.log` contained
`user`/`password` field values, and none of that was ever stored anywhere.

Setting `CAPTURE_MODE=full` changes that. In this mode the agent additionally
builds and pushes real **per-request log records** — real timestamp, real
latency (computed from Mule's own `entry`/`exit` `TimestampIST` fields),
status code, correlation id, source IP, flow name, and **real
request/response field values** — to power a proper log explorer, a
request-volume-over-time chart, and real p50/p95/p99 latency in DocTracker's
Observability Console. These records are written to DocTracker's database
and shown in its UI to anyone with access to the project.

**The one thing that does NOT change, in either mode:** any field whose
*name* matches a credential-shaped pattern (`password`, `passwd`, `secret`,
`apikey`, `api_key`, anything containing `token`, a name ending in `pin`, or
starting with `otp` — see `SENSITIVE_FIELD_PATTERN` in
`mule_doc_agent.py`) is always replaced with
`"[redacted - sensitive field name]"` before it leaves this server, even in
full-capture mode. This is enforced in the agent itself, not in DocTracker —
by the time a record reaches the DocTracker UI, a matching field's real value
was never in the payload to begin with. This is a name-based heuristic, not
a guarantee — a credential logged under an unrelated field name (e.g. a raw
token logged as `value` or `data`) would NOT be caught by it. Don't turn on
`CAPTURE_MODE=full` on a log stream you haven't reviewed for that.

**Turn this on only as a deliberate, informed decision** — not a default to
leave on because it unlocks a nicer dashboard. Two more caps apply only in
this mode: `MAX_LOG_RECORDS_PER_ENDPOINT` (default `200`) and
`MAX_LOG_RECORDS_TOTAL` (default `3000`) bound how many per-request records
are kept at once (oldest dropped first, per endpoint and then globally) —
raise them if you need a longer window, at the cost of a larger push payload.
The agent prints a loud `[warn]` banner on every start while this mode is on,
so it's visible in this server's own logs, not just in DocTracker.

## Data residency: an offline mode that never contacts DocTracker

DocTracker is hosted on Railway, **outside India**. If nothing discovered
from this SIT server's logs should cross that boundary, don't run the agent
in its default mode at all — use `--local-html` instead:

```bash
python3 mule_doc_agent.py --local-html /path/to/report.html
```

This tails and aggregates the log exactly the same way, but instead of
pushing to DocTracker it renders a single self-contained HTML file (inline
CSS only, no external fonts/scripts/CDN — works with no internet access)
and writes it to the path you give it. **No network call is made at all in
this mode** — `DOCTRACKER_BASE_URL`/`DOCTRACKER_USERNAME`/`DOCTRACKER_PASSWORD`
aren't even read.

**To get an actual URL instead of a `file://` path**, add `--serve-port`:

```bash
python3 mule_doc_agent.py --local-html /opt/doctracker-agent/report.html --serve-port 8877
```

This starts a tiny built-in HTTP server bound **only to `127.0.0.1`** — never
`0.0.0.0` — so the report is reachable at `http://127.0.0.1:8877/report.html`
from a browser running *on the SIT server itself*, and nowhere else on the
network. If you want to view it from your own laptop instead of RDP/console
on the server, don't open the port up — use an SSH tunnel, which never
exposes it externally either:

```bash
ssh -L 8877:127.0.0.1:8877 youruser@sit-server
# then open http://127.0.0.1:8877/report.html in your own browser
```

Trade-off: you lose DocTracker's shared/searchable project view, its
history, and its audit trail of who reviewed what — this is purely a local
snapshot, re-generated fresh each push interval. If that trade-off isn't
acceptable either, the fallback is a manual one: run `--sample-lines`/
`--dry-run` to eyeball what the agent *would* discover, then only push data
you've personally reviewed as acceptable to leave the server, rather than
running the agent unattended in its normal push mode.

## Where to install it

Anywhere you control on the SIT server that has read access to the Mule
logs — following the systemd layout used later in this doc:

| What | Path |
|---|---|
| The script itself | `/opt/doctracker-agent/mule_doc_agent.py` |
| Its env/config file | `/etc/doctracker-agent/env` (`chmod 600`) |
| Its state file (read position, discovered data) | `/var/lib/doctracker-agent/state.json` |
| Local HTML report (if using `--local-html`) | `/opt/doctracker-agent/report.html` |

Run it as its own dedicated OS user (`doctracker-agent`), never as root and
never as the Mule runtime's own user — it only ever needs **read-only**
access to the log directory.

## Requirements

- Python 3.6+ (standard library only — nothing to `pip install`)
- Read access to the Mule application's log file
- Outbound HTTPS access to your DocTracker instance

## Configuration (environment variables)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `MULE_LOG_PATH` | No | `/opt/mule/logs/mule-app.log` | Set to your actual log file path |
| `AGENT_STATE_FILE` | No | `/var/lib/doctracker-agent/state.json` | Where it remembers read position + discovered endpoints across restarts |
| `DOCTRACKER_BASE_URL` | No | `https://doctracker-production-7ecc.up.railway.app` | |
| `DOCTRACKER_USERNAME` | No | `svc-doc-agent` | The dedicated service account already created (role: editor) |
| `DOCTRACKER_PASSWORD` | **Yes** (for real runs) | — | The temporary password from account creation — **rotate this before or immediately after first deployment** |
| `DOCTRACKER_PROJECT_ID` | No | `sitautodisc1` | |
| `POLL_INTERVAL_SECONDS` | No | `60` | How often it checks the log file for new lines |
| `PUSH_INTERVAL_SECONDS` | No | `900` (15 min) | How often it batches everything discovered and pushes to DocTracker — deliberately NOT per-line, to keep write volume low |
| `MAX_LINES_PER_CYCLE` | No | `20000` | Caps how many new log lines one poll cycle reads. If a backlog is bigger than this, the agent processes it in back-to-back bounded chunks (no sleep between them) instead of one unbounded blocking read — see "Scaling to high traffic volumes" below |
| `MAX_TRACKED_ENDPOINTS` | No | `500` | Caps how many distinct method+path combinations are tracked. Past this cap, further new combinations are folded into one shared "OVERFLOW" bucket (still counted, just not broken out individually) instead of growing memory/state.json without bound |
| `CAPTURE_MODE` | No | `aggregate` | `aggregate` (default): counts/types only, never a real field value. `full`: also captures real per-request records including real field values (credential-named fields always redacted) — see "Capture mode" below, this is a deliberate opt-in, not a default to leave on |
| `MAX_LOG_RECORDS_PER_ENDPOINT` | No | `200` | Only applies when `CAPTURE_MODE=full`. Per-endpoint ring-buffer cap on stored per-request records, oldest dropped first |
| `MAX_LOG_RECORDS_TOTAL` | No | `3000` | Only applies when `CAPTURE_MODE=full`. Global ring-buffer cap across all endpoints, oldest dropped first |
| `MAX_LOG_VOLUME_SAMPLES` | No | `700` | Caps how many "log volume" samples (one per push, so ~700 ≈ a week at the default 15-min push interval) are kept for the Observability page's Log volume chart |
| `HOST_METRICS_ENABLED` | No | `true` | Sample host CPU/memory/disk (see "Host health"). Set to `false` if the agent does **not** run on the same machine as the Mule runtime — otherwise it reports the wrong host's numbers |
| `MAX_HOST_SAMPLES` | No | `720` | Caps retained host-health samples (one per **poll** cycle, so ~720 ≈ 12 hours at the default 60s poll interval) |

## Log volume & level distribution

Independent of `CAPTURE_MODE`, every cycle the agent also does a best-effort
per-line scan for a standard log4j-style level token (`FATAL`/`ERROR`/`WARN`/
`INFO`/`DEBUG`/`TRACE`) near the start of each raw line, and once per push it
records a `(timestamp, cumulative lines processed)` sample. Together these
power the Observability page's "Log volume" chart (raw log lines over time)
and "Log level distribution" bar — real counts, not derived from the
HTTP-request parsing above.

This deployment's confirmed log format (see "Style C" in
`mule_doc_agent.py`) is a custom pretty-printed one, and whether its lines
carry a level token at all — or where — isn't confirmed. So the level
distribution is self-diagnosing: DocTracker only renders it once at least 20
lines have actually matched a level token; below that, it shows an honest
"not detected in this log format" message instead of a distribution built
from too little (or no) real signal. The Log volume chart itself (raw line
count) doesn't depend on level detection and works regardless.

## Host health (CPU, memory, disk)

Once per **poll** cycle (`POLL_INTERVAL_SECONDS`, ~60s — not once per push,
because CPU spikes are short-lived and a 15-minute sample would miss them),
the agent records a host-pressure sample that drives the "Host health" panel
on the Observability page:

| Metric | Source | Why it's here |
|---|---|---|
| CPU % | `/proc/stat` delta between consecutive reads | Saturation that shows up as latency before it shows up as 5xx |
| Memory % | `/proc/meminfo` `MemTotal` / `MemAvailable` | The usual cause of a JVM getting OOM-killed |
| Log disk % used | `os.statvfs()` on the log directory | A full log partition stops Mule *and* this agent dead — it fails hard, not gracefully |
| Load average (1/5/15, per core) | `os.getloadavg()` | Distinguishes "busy and coping" from "saturated and queueing" |
| Agent's own RSS | `/proc/self/status` | So the agent can be ruled in or out as the cause of the memory figure it's reporting |

Everything above is standard library only and world-readable, so this still
works as the unprivileged `doctracker-agent` user with read-only access —
consistent with the no-`pip install` constraint in **Requirements**. Nothing
here needs root and nothing new is read from Mule's own files.

**These describe the host the *agent* runs on.** That is the Mule runtime's
host only because this agent is deployed onto the SIT server to tail Mule's
log locally (see "Where to install it"). If you ever run it elsewhere and
ship logs to it instead, set `HOST_METRICS_ENABLED=false` — the panel then
says so explicitly rather than reporting the wrong machine's CPU.

Memory uses `MemAvailable`, not `MemFree`. On Linux `MemFree` looks
alarmingly low on every healthy machine because the page cache is doing its
job; `MemAvailable` is the kernel's own estimate of what a new workload
could actually claim. Likewise `iowait` is counted as **idle** in the CPU
figure — the CPU genuinely had nothing to run, it was waiting on disk, and
counting it as busy would make a slow disk look like a CPU shortage.

Anything unreadable (a non-Linux host has no `/proc`) is reported as "not
readable on this host" rather than defaulted to zero — a reassuring flat
line that means nothing is worse than no line.

**Not included, deliberately:** JVM heap, GC pressure, and per-endpoint CPU
attribution. The agent sits outside the JVM and outside the request path, so
it cannot measure any of them; a guessed heap number displayed next to real
CPU numbers would undermine the real ones.

## Scaling to high traffic volumes

The agent never sits in the request path — it only tails a log file Mule has
already written — so no amount of real API traffic can make it slow down or
hang the actual server. What high volume *can* do to the agent itself:

- **Fall behind reading its own input.** `MAX_LINES_PER_CYCLE` bounds each
  poll to a fixed chunk, so a big backlog (e.g. the agent having been
  stopped for a while, or a genuine burst of ~100k requests in 30 minutes)
  is caught up over several fast, bounded cycles rather than one long
  blocking pass. You'll see `[warn] backlog: ...` in the logs while it's
  catching up — that's expected, not an error.
- **Grow its tracked-endpoint count without bound.** Path segments that look
  like per-request ids (numeric ids, UUIDs, long hex/token-looking strings)
  are automatically templated to `{id}` before aggregation, so
  `GET /orders/1001` and `GET /orders/1002` count as the same endpoint. Past
  `MAX_TRACKED_ENDPOINTS` distinct combinations, anything further is folded
  into one shared overflow bucket rather than growing forever.

The agent reports its own throughput, backlog, and how close it is to these
caps as **Agent Health** on DocTracker's Observability page (see "Reviewing
what it found" below) — that's the place to check whether it's actually
keeping up under real load, rather than guessing from stdout on a server
you may not be logged into at the time.

## Step 1 — validate the log parser BEFORE running for real

**The included parser is a best-effort guess** — no real sample log line
from this server was available when it was written. Run this first:

```bash
python3 mule_doc_agent.py --sample-lines 50
```

This reads up to 50 lines and prints each as `MATCHED` (it found an HTTP
method + path) or `UNMATCHED`. If most real request lines land in
`UNMATCHED`, open `mule_doc_agent.py` and look at the `LINE_PATTERNS` list
near the top — add a regex matching your actual log layout. The script
already handles two common styles out of the box:

- A JSON object per line (e.g. a custom Logger component logging
  `{"method":"POST","path":"/api/x","statusCode":200,...}`)
- Plain-text lines containing an HTTP method + path (e.g. the default
  Mule/log4j2 style)

## Step 2 — dry run (no network calls at all)

```bash
export MULE_LOG_PATH=/opt/mule/logs/mule-app.log
python3 mule_doc_agent.py --dry-run
```

Lets it tail the real log and print what it *would* push to DocTracker,
without ever calling the API. Confirm the discovered endpoints and field
shapes look reasonable before moving on.

**If cross-border data transfer to Railway isn't acceptable, stop here** and
use `--local-html /path/to/report.html` instead of Step 3 below — see
"Data residency" above. It's the same tail-and-aggregate logic, just with a
local HTML file as the only output and no network call ever made.

## Step 3 — run for real

```bash
export MULE_LOG_PATH=/opt/mule/logs/mule-app.log
export DOCTRACKER_PASSWORD='<the service account password — rotate it first>'
python3 mule_doc_agent.py
```

## Running as a service (systemd example)

```ini
# /etc/systemd/system/doctracker-sit-agent.service
[Unit]
Description=DocTracker SIT Auto-Discovery Agent
After=network.target

[Service]
Type=simple
User=doctracker-agent
EnvironmentFile=/etc/doctracker-agent/env
ExecStart=/usr/bin/python3 /opt/doctracker-agent/mule_doc_agent.py
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
```

For the offline/local-URL mode instead, replace the `ExecStart` line with:

```ini
ExecStart=/usr/bin/python3 /opt/doctracker-agent/mule_doc_agent.py --local-html /opt/doctracker-agent/report.html --serve-port 8877
```

No `DOCTRACKER_PASSWORD` is needed in `/etc/doctracker-agent/env` in this
mode — just `MULE_LOG_PATH`.

```bash
# /etc/doctracker-agent/env  (chmod 600, owned by doctracker-agent)
MULE_LOG_PATH=/opt/mule/logs/mule-app.log
DOCTRACKER_PASSWORD=<rotated password>
```

Run it as its own dedicated OS user (`doctracker-agent`) with **read-only**
access to the log directory — it never needs write access to Mule's own
files.

## Reviewing what it found

Log in to DocTracker as an Admin/Editor and open the project named
**"SIT Auto-Discovery — unreviewed"**. Every endpoint, field, and note it
generated is marked as needing review. Promote confirmed endpoints into
your real project(s) manually (or copy/adapt them) — this project is a
staging area, not a destination.

For real traffic (hit counts, error rate, source IPs, and the agent's own
throughput/backlog health) rather than field-shape documentation, use the
**Observability** page in the top bar instead — it's kept separate from the
project above on purpose (see the top of `mule_doc_agent.py`'s
`build_endpoint_metrics()`), so this traffic data is never written into, or
mixed up with, documentation a human has reviewed and signed off on.

## Rotating the service account credential

The password handed over at account creation is a one-time temporary
password. Change it (via the DocTracker UI, signed in as `svc-doc-agent`,
or have an Admin issue a fresh reset) before or immediately after putting
it into the systemd `EnvironmentFile` above — don't leave the original
temporary password as the long-term credential.
