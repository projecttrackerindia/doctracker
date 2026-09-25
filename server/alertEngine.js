// Server-side alert evaluation for the Observability console.
//
// WHY THIS EXISTS
// Alerts used to be computed in the browser, by 23-observability.js, over
// whatever data the page happened to have loaded. That meant an alert only
// existed while someone had the page open and was looking at it. A 40% error
// rate at 2am produced nothing whatsoever; the page simply showed it to
// whoever opened it the next morning. An alert nobody is told about is a
// report, not an alert.
//
// THE TWO EVALUATION PATHS, AND WHY THERE HAVE TO BE TWO
// Most rules are about something PRESENT in the data - too many errors, too
// much latency - and those can be evaluated when data arrives, which is free
// because the agent has just handed us the numbers.
//
// But the most important alert in any collection pipeline is about something
// ABSENT: the collector stopped. That one can never be event-driven, because
// the event it would react to is precisely the event that is no longer
// happening. Silence has to be noticed by a clock. So:
//
//   evaluateOrganisation()  runs after an ingest. Threshold rules.
//   runAlertSweep()         runs on a timer. Absence rules, AND threshold
//                           rules for organisations that went quiet, so a
//                           firing alert can still RESOLVE after the traffic
//                           that caused it stopped.
//
// WHY EACH RULE HAS A STATE MACHINE RATHER THAN JUST A THRESHOLD
// A bare threshold comparison produces an alert per evaluation - one incident
// becomes several hundred notifications, everyone mutes the channel, and the
// system is worse than not having one. Three mechanisms prevent that, and all
// three are configurable per rule:
//
//   min_requests      a sample floor. "100% error rate" over a single request
//                     at 3am is arithmetic, not an incident.
//   for_minutes       the breach must HOLD this long before anyone is told.
//                     A deploy blip crosses most thresholds for 30 seconds.
//   cooldown_minutes  while still firing, re-notify at most this often.
//
// And a firing alert that recovers sends a RESOLVED notification, so the
// inbox tells a whole story rather than an open-ended one.
const { pool } = require('./db');
const store = require('./observabilityStore');
const { notifyUsers, adminUserIds } = require('./notifications');

// ---------------------------------------------------------------------------
// The metric catalogue. Everything an alert rule can be written about.
//
// `kind` is the thing that matters architecturally:
//   'ratio'    a proportion of requests (0-100%). Needs a sample floor.
//   'gauge'    an absolute measurement (ms, requests/min).
//   'absence'  evaluated from the CLOCK, not from a row of data. These are
//              the ones the sweep exists for; see the note at the top.
// ---------------------------------------------------------------------------
const METRICS = {
  error_rate: {
    kind: 'ratio', unit: '%', label: 'Error rate',
    help: 'Share of requests answered 4xx or 5xx. The broad "something is wrong" signal.',
    compute: (b) => pct(b.s4 + b.s5, b.total),
  },
  server_error_rate: {
    kind: 'ratio', unit: '%', label: '5xx rate',
    help: 'Share answered 5xx only. A 4xx is usually the caller\'s problem; a 5xx is ours.',
    compute: (b) => pct(b.s5, b.total),
  },
  client_error_rate: {
    kind: 'ratio', unit: '%', label: '4xx rate',
    help: 'Share answered 4xx. Worth watching for a caller that has started sending bad requests.',
    compute: (b) => pct(b.s4, b.total),
  },
  unclassified_rate: {
    kind: 'ratio', unit: '%', label: 'Unclassified rate',
    help: 'Share whose log line carried no status at all. This is a LOGGING gap, not a failure '
      + '- a sustained rise means requests are not being recorded to completion.',
    compute: (b) => pct(b.unknown, b.total),
  },
  latency_p95: {
    kind: 'gauge', unit: 'ms', label: 'Latency p95',
    help: 'The slowest 5% of requests. Catches a degradation the average hides.',
    compute: (b) => b.p95,
  },
  latency_p99: {
    kind: 'gauge', unit: 'ms', label: 'Latency p99',
    help: 'The slowest 1%. Use for a hard timeout ceiling rather than general slowness.',
    compute: (b) => b.p99,
  },
  request_rate: {
    kind: 'gauge', unit: '/min', label: 'Request rate',
    help: 'Requests per minute. With comparison "below" this catches traffic falling off a '
      + 'cliff - an upstream that has stopped calling you, which no error-rate rule will ever see.',
    compute: (b, windowMinutes) => b.total / Math.max(1, windowMinutes),
  },
  agent_silent: {
    kind: 'absence', unit: 'min', label: 'Collector silent',
    help: 'Minutes since the agent last PUSHED, at all - including a push with nothing new to '
      + 'report. Deliberately not "minutes since traffic was last seen": an environment can go a '
      + 'genuinely quiet hour with the collector perfectly healthy, and that must read as "ok", not '
      + 'as a dead agent. Set the threshold above the agent\'s own push interval (15 min by default) '
      + 'or it will fire on every quiet spell.',
  },
};

function pct(part, total) {
  return total > 0 ? (part / total) * 100 : null;
}

const RATIO_METRICS = Object.keys(METRICS).filter((k) => METRICS[k].kind === 'ratio');
const ABSENCE_METRICS = Object.keys(METRICS).filter((k) => METRICS[k].kind === 'absence');

// ---------------------------------------------------------------------------
// Defaults. A brand-new organisation gets a working alert set rather than an
// empty page, because "configure your own alerting from scratch" is how
// alerting ends up never being configured at all. Every one of these is
// editable and deletable - they are a starting point, not a policy.
// ---------------------------------------------------------------------------
const DEFAULT_RULES = [
  {
    name: 'Server errors (5xx) across an environment',
    metric: 'server_error_rate', comparison: 'above', threshold: 5,
    windowMinutes: 10, minRequests: 20, forMinutes: 5, cooldownMinutes: 60,
    severity: 'critical', scope: 'environment',
  },
  {
    name: 'A single endpoint failing',
    metric: 'error_rate', comparison: 'above', threshold: 25,
    windowMinutes: 15, minRequests: 10, forMinutes: 10, cooldownMinutes: 120,
    severity: 'warning', scope: 'endpoint',
  },
  {
    name: 'Collector stopped reporting',
    metric: 'agent_silent', comparison: 'above', threshold: 45,
    windowMinutes: 0, minRequests: 0, forMinutes: 0, cooldownMinutes: 180,
    severity: 'critical', scope: 'environment',
  },
  {
    name: 'Requests not being logged to completion',
    metric: 'unclassified_rate', comparison: 'above', threshold: 40,
    windowMinutes: 30, minRequests: 50, forMinutes: 15, cooldownMinutes: 360,
    severity: 'warning', scope: 'environment',
  },
];

// ---------------------------------------------------------------------------
// Settings + rules
// ---------------------------------------------------------------------------
const DEFAULT_SETTINGS = {
  enabled: true,
  notifyAdmins: true,
  extraUserIds: [],
  // Quiet hours suppress NOTIFICATION, never evaluation - state keeps moving
  // so the console still shows what is firing, and a critical alert can be
  // configured to ignore them. Stored as minutes-from-midnight in the
  // organisation's chosen IANA zone.
  quietHours: { enabled: false, startMinute: 22 * 60, endMinute: 7 * 60, timezone: 'Asia/Kolkata', allowCritical: true },
};

async function getSettings(organisation) {
  const { rows } = await pool.query(
    'SELECT alert_settings FROM org_workspace WHERE organisation = $1', [organisation]
  );
  const raw = (rows[0] && rows[0].alert_settings) || {};
  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    quietHours: { ...DEFAULT_SETTINGS.quietHours, ...(raw.quietHours || {}) },
  };
}

async function saveSettings(organisation, patch) {
  const current = await getSettings(organisation);
  const next = {
    enabled: patch.enabled !== undefined ? !!patch.enabled : current.enabled,
    notifyAdmins: patch.notifyAdmins !== undefined ? !!patch.notifyAdmins : current.notifyAdmins,
    extraUserIds: Array.isArray(patch.extraUserIds)
      ? patch.extraUserIds.map((n) => parseInt(n, 10)).filter(Number.isFinite).slice(0, 50)
      : current.extraUserIds,
    quietHours: { ...current.quietHours, ...(patch.quietHours || {}) },
  };
  await pool.query(
    `INSERT INTO org_workspace (organisation, alert_settings) VALUES ($1, $2)
     ON CONFLICT (organisation) DO UPDATE SET alert_settings = $2, updated_at = now()`,
    [organisation, JSON.stringify(next)]
  );
  return next;
}

async function listRules(organisation, { enabledOnly = false } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM alert_rule WHERE organisation = $1 ${enabledOnly ? 'AND enabled' : ''}
     ORDER BY severity = 'critical' DESC, id ASC`,
    [organisation]
  );
  return rows.map(toRule);
}

function toRule(r) {
  return {
    id: String(r.id),
    name: r.name,
    metric: r.metric,
    comparison: r.comparison,
    threshold: Number(r.threshold),
    windowMinutes: r.window_minutes,
    minRequests: r.min_requests,
    forMinutes: r.for_minutes,
    cooldownMinutes: r.cooldown_minutes,
    severity: r.severity,
    environment: r.environment,
    scope: r.scope,
    endpointId: r.endpoint_id,
    enabled: r.enabled,
    notifyAdmins: r.notify_admins,
    notifyUserIds: Array.isArray(r.notify_user_ids) ? r.notify_user_ids : [],
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

// Validation lives here rather than in the route so the seeding path and the
// HTTP path cannot drift into accepting different things.
function validateRule(input) {
  const errors = [];
  const metric = String(input.metric || '');
  if (!METRICS[metric]) errors.push(`metric must be one of: ${Object.keys(METRICS).join(', ')}`);
  const comparison = input.comparison === 'below' ? 'below' : 'above';
  const threshold = Number(input.threshold);
  if (!Number.isFinite(threshold)) errors.push('threshold must be a number');
  const severity = input.severity === 'critical' ? 'critical' : 'warning';
  const scope = input.scope === 'endpoint' ? 'endpoint' : 'environment';
  const name = String(input.name || '').trim().slice(0, 120);
  if (!name) errors.push('name is required');
  if (metric && METRICS[metric] && METRICS[metric].kind === 'absence' && scope !== 'environment') {
    // "The collector is silent" is a property of an environment. There is no
    // per-endpoint version of it, because an endpoint with no traffic is
    // indistinguishable from one nobody called.
    errors.push('the collector-silence metric can only be scoped to an environment');
  }
  const env = input.environment ? String(input.environment).trim().slice(0, 32) : null;
  if (env && !/^[A-Za-z0-9][A-Za-z0-9 _-]{0,31}$/.test(env)) errors.push('environment is not a valid label');
  const endpointId = input.endpointId ? String(input.endpointId).trim().slice(0, 64) : null;
  if (endpointId && !/^[A-Za-z0-9_-]{1,64}$/.test(endpointId)) errors.push('endpointId is not a valid id');

  const clamp = (v, lo, hi, dflt) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  };
  return {
    errors,
    rule: {
      name,
      metric,
      comparison,
      threshold,
      severity,
      scope,
      environment: env,
      endpointId: scope === 'endpoint' ? endpointId : null,
      enabled: input.enabled !== false,
      notifyAdmins: input.notifyAdmins !== false,
      notifyUserIds: Array.isArray(input.notifyUserIds)
        ? input.notifyUserIds.map((n) => parseInt(n, 10)).filter(Number.isFinite).slice(0, 50) : [],
      // Ceilings, not arbitrary limits: a 24-hour evaluation window over
      // minute rollups is already a wide read, and a hold time longer than
      // the window it is measured over can never be satisfied.
      windowMinutes: clamp(input.windowMinutes, 0, 1440, 10),
      minRequests: clamp(input.minRequests, 0, 1000000, 20),
      forMinutes: clamp(input.forMinutes, 0, 1440, 5),
      cooldownMinutes: clamp(input.cooldownMinutes, 5, 10080, 60),
    },
  };
}

async function createRule(organisation, input, actor) {
  const { errors, rule } = validateRule(input);
  if (errors.length) { const e = new Error(errors.join('; ')); e.status = 400; throw e; }
  const { rows } = await pool.query(
    `INSERT INTO alert_rule (organisation, name, metric, comparison, threshold, window_minutes,
       min_requests, for_minutes, cooldown_minutes, severity, environment, scope, endpoint_id,
       enabled, notify_admins, notify_user_ids, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17) RETURNING *`,
    [organisation, rule.name, rule.metric, rule.comparison, rule.threshold, rule.windowMinutes,
      rule.minRequests, rule.forMinutes, rule.cooldownMinutes, rule.severity, rule.environment,
      rule.scope, rule.endpointId, rule.enabled, rule.notifyAdmins,
      JSON.stringify(rule.notifyUserIds), actor || null]
  );
  return toRule(rows[0]);
}

async function updateRule(organisation, id, input, actor) {
  const { errors, rule } = validateRule(input);
  if (errors.length) { const e = new Error(errors.join('; ')); e.status = 400; throw e; }
  const { rows } = await pool.query(
    `UPDATE alert_rule SET name=$3, metric=$4, comparison=$5, threshold=$6, window_minutes=$7,
       min_requests=$8, for_minutes=$9, cooldown_minutes=$10, severity=$11, environment=$12,
       scope=$13, endpoint_id=$14, enabled=$15, notify_admins=$16, notify_user_ids=$17,
       updated_at=now(), updated_by=$18
     WHERE organisation=$1 AND id=$2 RETURNING *`,
    [organisation, id, rule.name, rule.metric, rule.comparison, rule.threshold, rule.windowMinutes,
      rule.minRequests, rule.forMinutes, rule.cooldownMinutes, rule.severity, rule.environment,
      rule.scope, rule.endpointId, rule.enabled, rule.notifyAdmins,
      JSON.stringify(rule.notifyUserIds), actor || null]
  );
  if (!rows.length) { const e = new Error('No such alert rule.'); e.status = 404; throw e; }
  // Editing the definition invalidates the state it was measured against: a
  // rule still "firing" under a threshold that no longer exists would keep
  // re-notifying about a condition nobody configured.
  await pool.query('DELETE FROM alert_state WHERE rule_id = $1', [id]);
  return toRule(rows[0]);
}

async function deleteRule(organisation, id) {
  const { rowCount } = await pool.query('DELETE FROM alert_rule WHERE organisation=$1 AND id=$2', [organisation, id]);
  return rowCount > 0;
}

// Seeded once, on the organisation's first visit to the Alerts tab. Guarded by
// "has this org ever had a rule" rather than "does it have one now", so an
// Admin who deliberately deletes everything does not get the defaults back on
// their next page load.
async function seedDefaultRules(organisation, actor) {
  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM alert_rule WHERE organisation = $1', [organisation]
  );
  if (rows[0].n > 0) return { seeded: 0 };
  const settings = await getSettings(organisation);
  if (settings.seeded) return { seeded: 0 };
  for (const r of DEFAULT_RULES) await createRule(organisation, r, actor || 'system');
  await pool.query(
    `INSERT INTO org_workspace (organisation, alert_settings)
     VALUES ($1, jsonb_build_object('seeded', true))
     ON CONFLICT (organisation) DO UPDATE
       SET alert_settings = org_workspace.alert_settings || jsonb_build_object('seeded', true)`,
    [organisation]
  );
  return { seeded: DEFAULT_RULES.length };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

// One aggregate read per (rule window, environment), shared by every rule that
// uses the same window - a dozen rules on a 10-minute window cost one query,
// not a dozen. This is the whole reason evaluation is affordable on every
// ingest.
// Both store reads are normalised to ONE shape here, so a metric's compute()
// never has to know whether it is looking at an environment total or one
// endpoint's row. The store already derives percentiles from the histogram on
// the endpoint path, so this reads them rather than asking it to ship the raw
// buckets to every caller that does not want them.
function normalise(endpointId, total, breakdown, latency) {
  return {
    endpointId,
    total,
    s4: breakdown['4xx'] || 0,
    s5: breakdown['5xx'] || 0,
    unknown: breakdown.unknown || 0,
    latencyCount: latency ? latency.count : 0,
    p95: latency ? latency.p95 : null,
    p99: latency ? latency.p99 : null,
  };
}

async function windowTotals(organisation, environment, windowMinutes, byEndpoint) {
  const from = new Date(Date.now() - windowMinutes * 60000).toISOString();
  if (byEndpoint) {
    const rows = await store.getEndpointBreakdown(organisation, { environment, from, to: null, limit: 2000 });
    return rows.map((r) => normalise(r.endpointId, r.total, r.statusBreakdown, r.latency));
  }
  const s = await store.getSummary(organisation, { environment, from, to: null });
  return [normalise('', s.total, s.statusBreakdown, s.latency)];
}

function breaches(rule, value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return false;
  return rule.comparison === 'below' ? value < rule.threshold : value > rule.threshold;
}

function formatValue(metric, value) {
  const m = METRICS[metric];
  if (value === null || value === undefined) return '—';
  const n = m && m.unit === '%' ? value.toFixed(1)
    : m && m.unit === '/min' ? value.toFixed(1)
      : Math.round(value);
  return `${n}${m ? m.unit : ''}`;
}

// The state machine. Returns what should happen, and is deliberately pure so
// its behaviour is testable without a database or a clock.
//
//   ok      -> breach observed        -> pending (breached_since = now)
//   pending -> held for for_minutes   -> firing  (notify)
//   pending -> recovered              -> ok      (silent: nobody was told)
//   firing  -> still breaching        -> firing  (re-notify after cooldown)
//   firing  -> recovered              -> ok      (notify RESOLVED)
function nextState(rule, prev, value, sample, now) {
  // The sample floor applies to gauges as well as ratios: a p95 computed from
  // three requests is as meaningless as a 100% error rate from one. Absence
  // metrics are exempt because they measure elapsed time, not a population -
  // requiring a sample there would mean never alerting on silence, which is
  // the exact condition being watched for.
  const kind = METRICS[rule.metric].kind;
  const enoughSample = kind === 'absence' || sample >= rule.minRequests;
  const isBreaching = breaches(rule, value) && enoughSample;
  const status = prev ? prev.status : 'ok';

  if (!isBreaching) {
    if (status === 'firing') return { status: 'ok', action: 'resolve' };
    return { status: 'ok', action: 'none' };
  }
  if (status === 'ok') {
    // A zero hold time means "tell me the moment it happens", which is the
    // right default for collector silence - that has already been quiet for
    // the whole threshold by the time it is noticed.
    if (rule.forMinutes <= 0) return { status: 'firing', action: 'fire', firingSince: now };
    return { status: 'pending', action: 'none', breachedSince: now };
  }
  if (status === 'pending') {
    const heldMs = now - new Date(prev.breached_since || now).getTime();
    if (heldMs >= rule.forMinutes * 60000) return { status: 'firing', action: 'fire', firingSince: now };
    return { status: 'pending', action: 'none' };
  }
  // Already firing: re-notify only once the cooldown has elapsed.
  const sinceNotify = prev.last_notified_at ? now - new Date(prev.last_notified_at).getTime() : Infinity;
  if (sinceNotify >= rule.cooldownMinutes * 60000) return { status: 'firing', action: 'renotify' };
  return { status: 'firing', action: 'none' };
}

function inQuietHours(settings, now = new Date()) {
  const q = settings.quietHours || {};
  if (!q.enabled) return false;
  let minutes;
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: q.timezone || 'UTC', hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const [h, m] = fmt.format(now).split(':').map(Number);
    minutes = h * 60 + m;
  } catch (err) {
    return false; // an unknown timezone must not silence every alert
  }
  const { startMinute: s, endMinute: e } = q;
  // Wraps midnight when start > end, which is the normal case for "22:00-07:00".
  return s <= e ? (minutes >= s && minutes < e) : (minutes >= s || minutes < e);
}

async function emitNotification(organisation, rule, ctx, kind, settings) {
  if (inQuietHours(settings) && !(rule.severity === 'critical' && settings.quietHours.allowCritical)) {
    return { suppressed: 'quiet-hours' };
  }
  const recipients = new Set();
  if (rule.notifyAdmins && settings.notifyAdmins) (await adminUserIds(organisation)).forEach((id) => recipients.add(id));
  (rule.notifyUserIds || []).forEach((id) => recipients.add(id));
  (settings.extraUserIds || []).forEach((id) => recipients.add(id));
  if (!recipients.size) return { suppressed: 'no-recipients' };

  const m = METRICS[rule.metric];
  const where = [ctx.environment, ctx.endpointLabel].filter(Boolean).join(' · ');
  const resolved = kind === 'resolve';
  const title = resolved
    ? `Resolved: ${rule.name}`
    : `${rule.severity === 'critical' ? 'Critical' : 'Warning'}: ${rule.name}`;
  const body = resolved
    ? `${where} — ${m.label} is back within ${rule.comparison} ${formatValue(rule.metric, rule.threshold)} `
      + `(now ${formatValue(rule.metric, ctx.value)}).`
    : `${where} — ${m.label} is ${formatValue(rule.metric, ctx.value)}, ${rule.comparison} the `
      + `${formatValue(rule.metric, rule.threshold)} threshold`
      + (m.kind === 'absence' ? '.' : ` over the last ${rule.windowMinutes} minutes (${ctx.sample.toLocaleString()} requests).`);

  await notifyUsers([...recipients], {
    organisation,
    type: resolved ? 'alert_resolved' : 'alert_firing',
    title,
    body,
    // A routing hint, not a URL - matching the convention in
    // server/notifications.js. Opens the console already scoped to the thing
    // that fired, so the click lands on evidence rather than a home page.
    link: {
      view: 'observability',
      tab: 'alerts',
      environment: ctx.environment,
      endpointId: ctx.endpointId || null,
      ruleId: rule.id,
    },
  });
  return { notified: recipients.size };
}

// Evaluates every enabled rule for one organisation. `environments` limits the
// work to what just changed; omit it for the sweep, which covers everything.
async function evaluateOrganisation(organisation, { environments = null, includeAbsence = false } = {}) {
  const settings = await getSettings(organisation);
  if (!settings.enabled) return { evaluated: 0, skipped: 'disabled' };

  const rules = await listRules(organisation, { enabledOnly: true });
  if (!rules.length) return { evaluated: 0 };

  const envs = environments && environments.length
    ? environments
    : await store.getEnvironments(organisation);
  if (!envs.length) return { evaluated: 0 };

  // Cache per (environment, window, byEndpoint) so rules sharing a shape
  // share a query.
  const cache = new Map();
  const totalsFor = async (env, windowMinutes, byEndpoint) => {
    const key = `${env}|${windowMinutes}|${byEndpoint ? 1 : 0}`;
    if (!cache.has(key)) cache.set(key, await windowTotals(organisation, env, windowMinutes, byEndpoint));
    return cache.get(key);
  };

  const now = Date.now();
  let evaluated = 0;
  const fired = [];

  for (const rule of rules) {
    const isAbsence = METRICS[rule.metric].kind === 'absence';
    if (isAbsence && !includeAbsence) continue;      // only the sweep raises silence
    const targets = rule.environment ? envs.filter((e) => e === rule.environment) : envs;

    for (const env of targets) {
      let rows;
      if (isAbsence) {
        // Deliberately the agent's HEARTBEAT (did it push at all), not
        // getCoverage()'s rollup freshness (did any TRAFFIC arrive). Those
        // are different questions: a healthy collector watching a
        // genuinely quiet environment writes no rollup rows either, which
        // made a quiet API indistinguishable from a dead agent under the
        // old signal - this alert fired on ordinary silence, not just a
        // dead process. See touchHeartbeat()'s comment in
        // observabilityStore.js.
        const heartbeat = await store.getHeartbeat(organisation, env);
        const newest = heartbeat.lastSeenAt ? new Date(heartbeat.lastSeenAt).getTime() : null;
        const silentMinutes = newest === null ? null : (now - newest) / 60000;
        rows = [{ endpointId: '', value: silentMinutes, sample: 1 }];
      } else {
        const totals = await totalsFor(env, rule.windowMinutes, rule.scope === 'endpoint');
        rows = totals
          .filter((t) => !rule.endpointId || t.endpointId === rule.endpointId)
          .map((t) => ({
            endpointId: t.endpointId,
            value: METRICS[rule.metric].compute(t, rule.windowMinutes),
            sample: t.total,
          }));
      }

      for (const row of rows) {
        evaluated += 1;
        const outcome = await applyState(organisation, rule, env, row, now, settings);
        if (outcome && outcome.action !== 'none') fired.push(outcome);
      }
    }
  }
  return { evaluated, changed: fired };
}

async function applyState(organisation, rule, environment, row, now, settings) {
  const key = row.endpointId || '';
  const { rows: prevRows } = await pool.query(
    'SELECT * FROM alert_state WHERE rule_id=$1 AND environment=$2 AND endpoint_id=$3',
    [rule.id, environment, key]
  );
  const prev = prevRows[0] || null;
  const decision = nextState(rule, prev, row.value, row.sample, now);

  // Nothing has ever happened for this target and nothing is happening now -
  // do not write a row. Otherwise one 'every endpoint' rule creates a state
  // row per endpoint per environment on the first evaluation, for no reason.
  if (!prev && decision.status === 'ok' && decision.action === 'none') return null;

  const notified = decision.action === 'fire' || decision.action === 'renotify' || decision.action === 'resolve';
  let notifyResult = null;
  if (notified) {
    notifyResult = await emitNotification(organisation, rule, {
      environment,
      endpointId: key || null,
      endpointLabel: key ? `endpoint ${key}` : null,
      value: row.value,
      sample: row.sample,
    }, decision.action === 'resolve' ? 'resolve' : 'fire', settings);
  }

  // A brand-new incident (action 'fire') or a recovery (action 'resolve')
  // starts a new chapter this row's history: any earlier acknowledgment was
  // about a DIFFERENT breach (the previous one, now over) and must not
  // silently cover this one. A re-notify of the SAME still-firing incident,
  // or no change at all, leaves it exactly as it was.
  const clearAck = decision.action === 'fire' || decision.action === 'resolve';

  await pool.query(
    `INSERT INTO alert_state (rule_id, organisation, environment, endpoint_id, status,
        breached_since, firing_since, last_value, last_sample, last_notified_at, notify_count,
        acknowledged_at, acknowledged_by, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
     ON CONFLICT (rule_id, environment, endpoint_id) DO UPDATE SET
       status=$5, breached_since=$6, firing_since=$7, last_value=$8, last_sample=$9,
       last_notified_at=$10, notify_count=$11, acknowledged_at=$12, acknowledged_by=$13, updated_at=now()`,
    [
      rule.id, organisation, environment, key, decision.status,
      decision.status === 'pending' ? (decision.breachedSince ? new Date(decision.breachedSince) : (prev && prev.breached_since) || new Date(now)) : null,
      decision.status === 'firing' ? (decision.firingSince ? new Date(decision.firingSince) : (prev && prev.firing_since) || new Date(now)) : null,
      Number.isFinite(row.value) ? row.value : null,
      Number.isFinite(row.sample) ? row.sample : null,
      // A suppressed notification must NOT stamp last_notified_at, or the
      // cooldown would start ticking on a message nobody received and the
      // alert would go quiet for an hour having never spoken.
      notified && notifyResult && notifyResult.notified ? new Date(now) : (prev && prev.last_notified_at) || null,
      (prev ? prev.notify_count : 0) + (notified && notifyResult && notifyResult.notified ? 1 : 0),
      clearAck ? null : (prev && prev.acknowledged_at) || null,
      clearAck ? null : (prev && prev.acknowledged_by) || null,
    ]
  );
  return { rule: rule.name, environment, endpointId: key, action: decision.action, value: row.value, notifyResult };
}

// What the console shows: every rule's current state, joined to the rule.
async function currentAlerts(organisation) {
  const { rows } = await pool.query(
    `SELECT s.*, r.name, r.metric, r.severity, r.threshold, r.comparison, r.scope, r.window_minutes
     FROM alert_state s JOIN alert_rule r ON r.id = s.rule_id
     WHERE s.organisation = $1 AND s.status <> 'ok'
     ORDER BY r.severity = 'critical' DESC, s.firing_since ASC NULLS LAST`,
    [organisation]
  );
  return rows.map((r) => ({
    ruleId: String(r.rule_id),
    name: r.name,
    metric: r.metric,
    severity: r.severity,
    status: r.status,
    environment: r.environment,
    endpointId: r.endpoint_id || null,
    value: r.last_value === null ? null : Number(r.last_value),
    sample: r.last_sample,
    threshold: Number(r.threshold),
    comparison: r.comparison,
    windowMinutes: r.window_minutes,
    since: r.firing_since || r.breached_since,
    notifyCount: r.notify_count,
    display: formatValue(r.metric, r.last_value === null ? null : Number(r.last_value)),
    acknowledgedAt: r.acknowledged_at,
    acknowledgedBy: r.acknowledged_by || null,
  }));
}

// Records that a person has seen this incident and is on it. Anyone who can
// SEE what is firing may acknowledge it - the same "everyone reads, only
// editing rules is Admin-only" split the rest of this file uses, because an
// acknowledgment is a statement about attention, not a configuration change,
// and gating it to Admins would mean the engineer actually responding
// cannot mark it as theirs. Only applies to a FIRING row - a pending one has
// notified nobody yet, so there is nothing to acknowledge.
async function acknowledgeAlert(organisation, ruleId, environment, endpointId, actor) {
  const key = endpointId || '';
  const { rows } = await pool.query(
    `UPDATE alert_state SET acknowledged_at = now(), acknowledged_by = $4, updated_at = now()
     WHERE rule_id = $1 AND organisation = $2 AND environment = $3 AND endpoint_id = $5 AND status = 'firing'
     RETURNING rule_id`,
    [ruleId, organisation, environment, actor || 'unknown', key]
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// The sweep. See the note at the top: absence is not an event, so it needs a
// clock. It also re-evaluates threshold rules, which matters for the mirror
// case - an environment whose traffic stopped entirely stops producing
// ingests, so without this a firing alert could never RESOLVE.
// ---------------------------------------------------------------------------
const SWEEP_INTERVAL_MS = parseInt(process.env.ALERT_SWEEP_INTERVAL_MS || String(60 * 1000), 10);
let sweepTimer = null;

// A fixed, single global key: the sweep already loops every organisation
// sequentially within one tick, so a per-organisation lock would add
// complexity for no benefit — the unit of "should this run at all right
// now" is one process, not one org.
const SWEEP_LOCK_KEY = "hashtext('doctracker:alert-sweep')";

// Runs on a `setInterval` (see startAlertSchedule below) with no other
// coordination between processes. Two app instances would otherwise each
// run this and could double-notify — a `pg_try_advisory_lock` skip-if-busy
// lock (not the blocking `pg_advisory_xact_lock` server/routes/auth.js uses
// for registration, since a sweep tick that has to WAIT for another
// instance defeats the point of a fixed-interval sweep) makes at most one
// instance actually evaluate per tick; the others no-op and try again next
// interval.
async function runAlertSweep() {
  const client = await pool.connect();
  try {
    const { rows: lockRows } = await client.query(`SELECT pg_try_advisory_lock(${SWEEP_LOCK_KEY}) AS acquired`);
    if (!lockRows[0].acquired) {
      return { organisations: 0, skipped: 'another instance holds the sweep lock' };
    }
    try {
      const { rows } = await pool.query('SELECT DISTINCT organisation FROM alert_rule WHERE enabled');
      for (const row of rows) {
        try {
          await evaluateOrganisation(row.organisation, { includeAbsence: true });
        } catch (err) {
          console.error(`Alert sweep failed for ${row.organisation}:`, err.message);
        }
      }
      return { organisations: rows.length };
    } finally {
      await client.query(`SELECT pg_advisory_unlock(${SWEEP_LOCK_KEY})`);
    }
  } finally {
    client.release();
  }
}

function startAlertSchedule() {
  if (sweepTimer) return;
  // Offset from boot so a redeploy does not evaluate before the first agent
  // push has had a chance to land - otherwise every restart briefly looks
  // like a silent collector.
  setTimeout(() => runAlertSweep().catch((e) => console.error('Initial alert sweep failed:', e.message)), 90 * 1000);
  sweepTimer = setInterval(
    () => runAlertSweep().catch((e) => console.error('Scheduled alert sweep failed:', e.message)),
    SWEEP_INTERVAL_MS
  );
}

// Called from the ingest route. Deliberately fire-and-forget and throttled:
// an agent pushing every 5 seconds must not mean a full evaluation every 5
// seconds, and a slow evaluation must never delay the agent's push.
const lastEvaluated = new Map();
const MIN_EVAL_INTERVAL_MS = parseInt(process.env.ALERT_MIN_EVAL_INTERVAL_MS || '30000', 10);

function evaluateAfterIngest(organisation, environment) {
  const key = `${organisation}|${environment}`;
  const last = lastEvaluated.get(key) || 0;
  if (Date.now() - last < MIN_EVAL_INTERVAL_MS) return;
  lastEvaluated.set(key, Date.now());
  evaluateOrganisation(organisation, { environments: [environment] })
    .catch((err) => console.error('Alert evaluation after ingest failed:', err.message));
}

module.exports = {
  METRICS,
  DEFAULT_RULES,
  DEFAULT_SETTINGS,
  RATIO_METRICS,
  ABSENCE_METRICS,
  getSettings,
  saveSettings,
  listRules,
  createRule,
  updateRule,
  deleteRule,
  seedDefaultRules,
  validateRule,
  nextState,
  inQuietHours,
  formatValue,
  evaluateOrganisation,
  currentAlerts,
  acknowledgeAlert,
  runAlertSweep,
  startAlertSchedule,
  evaluateAfterIngest,
};
