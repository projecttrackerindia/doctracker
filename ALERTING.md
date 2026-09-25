# Alerting

What DocTracker watches for, who it tells, and every knob you can turn.

Before this existed, alerts were computed **in the browser** and rendered on a
page someone had to be looking at. A 40% error rate at 2am produced nothing at
all; the page simply showed it to whoever opened it next morning. An alert
nobody is told about is a report.

---

## 1. How it works

```
  Mule logs ──► agent ──► PUT /observability/ingest
                               │
                               ├─► rollup tables (the numbers)
                               │
                               └─► alertEngine.evaluateAfterIngest()   ← path A
                                          threshold rules, throttled to
                                          one evaluation per org per 30s

  every 60s ──────────────────► alertEngine.runAlertSweep()            ← path B
                                          absence rules, AND threshold
                                          rules for orgs that went quiet
                                          │
                                          ▼
                                   state machine per (rule, environment, endpoint)
                                          │
                                          ▼
                                   notifications table ──► the bell in the header
```

### Why there are two evaluation paths

Most rules are about something **present** in the data — too many errors, too
much latency. Those are evaluated when data arrives, which is nearly free
because the agent has just handed us the numbers.

But the single most important alert in any collection pipeline is about
something **absent**: *the collector stopped*. That one can never be
event-driven, because the event it would react to is precisely the event that
is no longer happening. Silence has to be noticed by a clock.

Running more than one app instance, each would run this same 60s sweep
independently and could double-notify — so `runAlertSweep()` wraps itself in
a `pg_try_advisory_lock`: whichever instance's tick gets there first evaluates
every organisation; every other instance's tick for that interval finds the
lock held and no-ops rather than waiting for it (a fixed-interval sweep that
blocks defeats the point). Nothing is lost by an instance skipping a tick —
the next tick, 60s later, runs uncontended the same way.

That is the whole reason `runAlertSweep()` exists, and it also handles the
mirror case: an environment whose traffic stops entirely stops producing
ingests, so without the sweep a firing alert could never **resolve**.

### Why every rule is a state machine, not a threshold

A bare comparison produces an alert per evaluation. At one sweep a minute
that is 60 notifications an hour for one incident; everyone mutes the channel
and the system is worse than not having one.

```
  ok ──breach──► pending ──held for `for`──► firing ──recovers──► ok
                    │                           │                  │
                    └──recovers──► ok           └──cooldown──► re-notify
                       (silent: nobody           (at most once
                        was ever told)            per cooldown)
```

A **resolved** notification is sent when a firing alert recovers, so the inbox
tells a whole story instead of an open-ended one. A *pending* alert that clears
says nothing, because nobody was told it started.

### Acknowledging

A firing alert's row carries an **Acknowledge** button. It says "a person has
seen this and is on it" — nothing more. It does **not** silence the alert: it
keeps being evaluated, keeps re-notifying on schedule, and the row keeps
showing exactly where it was, just visually quieter. An acknowledged-but-
still-broken collector disappearing from view would be worse than one nobody
has acknowledged yet, so acknowledging only ever changes one thing: it drops
that alert out of the **Alerts** tab's badge count, so the badge reflects what
still needs someone's attention rather than what is merely still true.

Anyone who can see what is firing can acknowledge it — unlike every other
write in this file, acknowledging is deliberately **not** Admin-only, because
gating it to Admins would mean the engineer actually responding to the
incident cannot mark it as theirs. Only changing what fires is Admin-only.

An acknowledgment belongs to one continuous incident, not to the rule
forever: it clears itself the moment that incident resolves, and clears again
if a fresh breach starts afterward — a later, unrelated incident must never
silently inherit an old "somebody's on it." It survives a re-notify of the
*same* still-firing incident, because that is not a new incident. A pending
alert cannot be acknowledged at all: nobody has been notified about it yet,
so there is nothing to acknowledge.

---

## 2. What you can alert on

Set per rule, in **Observability ▸ Alerts**.

| Measure | Unit | What it is | Typical use |
|---|---|---|---|
| `error_rate` | % | 4xx + 5xx as a share of requests | The broad "something is wrong" signal |
| `server_error_rate` | % | 5xx only | A 4xx is usually the caller's problem; a 5xx is ours |
| `client_error_rate` | % | 4xx only | A caller that has started sending bad requests |
| `unclassified_rate` | % | Requests whose log line carried **no status at all** | A *logging* gap, not a failure. A sustained rise means requests are not being recorded to completion |
| `latency_p95` | ms | Slowest 5% | Degradation the average hides |
| `latency_p99` | ms | Slowest 1% | A hard timeout ceiling |
| `request_rate` | /min | Requests per minute | With **below**, catches traffic falling off a cliff — an upstream that stopped calling you, which no error-rate rule can ever see |
| `agent_silent` | min | Minutes since the agent last **pushed**, at all — not since traffic was last seen (below) | The collector died. Cannot be raised by incoming data; see path B above |

Deliberately *pushed*, not *received traffic*: a healthy agent watching a genuinely quiet environment writes nothing new to the rollup tables either, and measuring against those would make an ordinary quiet hour indistinguishable from a dead collector. The agent's own push — including one with nothing new to report — is recorded separately (`agent_heartbeat` table, touched on every `PUT /observability/ingest` regardless of whether it carried any rollups) precisely so this metric answers "is the process alive," not "was there traffic."

---

## 3. Every setting, and what it actually does

### Per rule

| Setting | Default | What it does | Get it wrong and… |
|---|---|---|---|
| **Name** | — | What appears in the notification title | — |
| **Measure** | `error_rate` | From the table above | — |
| **When it goes** | `above` | `above` or `below` | `below` on a metric that can be absent needs care — a missing measurement is never treated as a breach, by design |
| **Threshold** | — | The number to cross, in the measure's unit | Too tight and it cries wolf; too loose and it never speaks |
| **Measured over** | 10 min | How far back each evaluation looks | Too short is noisy; too long is slow to notice |
| **Ignore below** | 20 requests | Sample floor. Applies to latency as well as ratios | Set to 0 and one failed request at 3am is a 100% error rate |
| **Must hold for** | 5 min | The breach must persist this long before anyone is told | Set to 0 on a threshold metric and every deploy blip pages someone |
| **Re-notify every** | 60 min | While still firing (minimum 5) | Too low and one incident floods the inbox |
| **Severity** | Warning | `Warning` or `Critical`. Critical can be set to ignore quiet hours | — |
| **Environment** | Every | Restrict to one environment | — |
| **Applies to** | The environment as a whole | Or **each endpoint separately** — one rule, one independent alert per endpoint, so a second endpoint going bad is not masked by the first | Per-endpoint on a busy estate is a lot of alerts; raise the sample floor |
| **Enabled** | on | — | A disabled rule and a healthy system look identical. Disabling is audited for exactly this reason |

`agent_silent` ignores *Measured over*, *Ignore below* and *Must hold for* —
it measures elapsed time, not a population, and is already late by the time it
crosses. It can only be scoped to an environment: an endpoint with no traffic
is indistinguishable from one nobody called.

### Organisation-wide (Admin only)

| Setting | Default | What it does |
|---|---|---|
| **Alerting is on** | on | Master switch. Off means nothing is evaluated and nothing is ever raised |
| **Notify every Admin** | on | The default recipient set. Rules can add specific people on top |
| **Quiet hours** | off | Suppresses **notification only**. Rules keep being evaluated and the console still shows what is firing — nothing is lost, it is just not announced |
| **From / Until** | 22:00–07:00 | Wraps midnight correctly |
| **Time zone** | `Asia/Kolkata` | An IANA zone. An unrecognised one **disables** quiet hours rather than silencing everything |
| **Critical ignores quiet hours** | on | Leave on unless you genuinely want a 5xx storm to wait until morning |

A suppressed notification deliberately does **not** start the cooldown —
otherwise an alert would go quiet for an hour having never spoken.

### Environment variables (deployment)

| Variable | Default | What it does |
|---|---|---|
| `ALERT_SWEEP_INTERVAL_MS` | `60000` | How often the sweep runs. This is the resolution of every absence alert |
| `ALERT_MIN_EVAL_INTERVAL_MS` | `30000` | Floor between ingest-triggered evaluations per org+environment. An agent pushing every 5s must not mean an evaluation every 5s |

The sweep waits 90 seconds after boot before its first run, so a redeploy does
not briefly look like a silent collector.

---

## 4. What ships by default

A new organisation is seeded on its first visit to the Alerts tab. All four
are editable and deletable — a starting point, not a policy. Deleting them all
does **not** bring them back.

| Rule | Fires when | Hold | Re-notify |
|---|---|---|---|
| Server errors (5xx) across an environment | 5xx rate > 5% over 10 min, min 20 req | 5 min | 60 min |
| A single endpoint failing | error rate > 25% over 15 min per endpoint, min 10 req | 10 min | 120 min |
| Collector stopped reporting | no push at all for 45 min | — | 180 min |
| Requests not being logged to completion | unclassified > 40% over 30 min, min 50 req | 15 min | 360 min |

The collector threshold is 45 minutes because the agent's own heartbeat is
`PUSH_INTERVAL_SECONDS` (15 min by default). Set it below that and it fires on
every quiet spell.

---

## 5. Who can do what

| | Read what is firing | Read the rules | Acknowledge | Change rules & settings |
|---|---|---|---|---|
| Admin | yes | yes | yes | yes |
| Everyone else | yes | yes | yes | no |

Rules are readable by everyone deliberately. A threshold you cannot see is
indistinguishable from no threshold, and *"why didn't we get alerted?"* should
not be a question that requires an Admin to answer. Acknowledging is open to
everyone for the same reason attention-tracking always should be: the person
actually responding is often not an Admin.

Every change is written to the audit log: `ALERT_RULE_CREATED`,
`ALERT_RULE_UPDATED`, `ALERT_RULE_DELETED`, `ADMIN_SETTING_CHANGED`,
`ALERT_ACKNOWLEDGED`. Disabling or deleting a rule is recorded at `critical`
severity, because that is how a system silently stops watching for
something.

---

## 6. Where it lives

| File | What |
|---|---|
| `server/alertEngine.js` | Metric catalogue, state machine, evaluation, sweep |
| `server/routes/alerts.js` | `/api/workspace/alerts` — read, CRUD, "evaluate now" |
| `server/db.js` | `alert_rule`, `alert_state`, `org_workspace.alert_settings`, `agent_heartbeat` |
| `server/observabilityStore.js` | `touchHeartbeat()` / `getHeartbeat()` — the collector's own liveness signal, separate from traffic coverage |
| `public/js/studio/26-obs-console.js` | The Alerts tab |
| `test/alerting.test.js` | State machine, quiet hours, validation |

`alert_rule` and `alert_state` are separate tables on purpose. Configuration
is edited by people, rarely; state is written by the engine many times a
minute. One row for both would mean an Admin's edit contending with the
engine's writes, and a rule's audit trail churning every few seconds.

---

## 7. Known limits

- **In-app notifications only.** There is no email or webhook channel — this
  deployment has no SMTP configuration and no outbound-webhook story. Adding
  one means a delivery abstraction plus SSRF controls on the webhook URL;
  `emitNotification()` in `alertEngine.js` is the single place it would hook in.
- **No alert history.** `alert_state` holds *current* state; the notification
  rows are the record of what fired. There is no "incidents over time" view.
