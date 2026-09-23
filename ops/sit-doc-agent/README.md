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
- Does not call any LLM or external AI service.
- Does not modify, delete, or truncate the log file it reads.
- Does not touch any of your existing, reviewed DocTracker projects — it
  only ever writes to its own dedicated `sitautodisc1` project.

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
aren't even read. Open the file directly in a browser on the SIT server
(`file://...`) or copy it out through whatever channel your data-handling
rules already allow for that server.

Trade-off: you lose DocTracker's shared/searchable project view, its
history, and its audit trail of who reviewed what — this is purely a local
snapshot, re-generated fresh each push interval. If that trade-off isn't
acceptable either, the fallback is a manual one: run `--sample-lines`/
`--dry-run` to eyeball what the agent *would* discover, then only push data
you've personally reviewed as acceptable to leave the server, rather than
running the agent unattended in its normal push mode.

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

## Rotating the service account credential

The password handed over at account creation is a one-time temporary
password. Change it (via the DocTracker UI, signed in as `svc-doc-agent`,
or have an Admin issue a fresh reset) before or immediately after putting
it into the systemd `EnvironmentFile` above — don't leave the original
temporary password as the long-term credential.
