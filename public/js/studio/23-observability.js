/* ==================== SECTION:OBSERVABILITY ==================== */
// Traffic auto-discovered from server logs by ops/sit-doc-agent - hit counts,
// status breakdown, error rate, and source IPs, keyed by "METHOD /path" in
// state.endpointMetrics (org-shared, see loadState() in 06-spec-parse.js).
// Deliberately NOT written into any project's own endpoint data (see the
// server/db.js comment on org_workspace.endpoint_metrics_enc) - this page is
// the only place it's shown, cross-referenced against real endpoints purely
// by matching method+path text, never by mutating a project's stored JSON.
//
// Two views over the exact same real data (no second/fake data source):
//  - Overview: the flat table, every discovered endpoint at once.
//  - Console: the same metrics grouped by project with a drill-down scope
//    panel, KPIs, a status-code breakdown and threshold-based alerts, plus
//    - ONLY when the agent is running with CAPTURE_MODE=full (opt-in, see
//    AGENT_README.md's "Capture mode" section) - a real log explorer,
//    volume-over-time chart and latency KPIs built from real per-request
//    records (state.endpointMetrics.logRecords). In the default
//    CAPTURE_MODE=aggregate, logRecords is empty and those panels don't
//    render - there is no fabricated/sample data standing in for them.
//    Even in full-capture mode, any field named like a credential
//    (password/secret/token/etc.) is always shown as "[redacted - sensitive
//    field name]" - the agent enforces that server-side, not this page.
//
// state.endpointMetrics is pushed whole-blob by the agent as
// {endpoints:{...}, agentHealth:{...}, logRecords:[...]} (see
// build_endpoint_metrics()/build_agent_health()/build_log_records() in
// mule_doc_agent.py). Older pushes (before the agent tracked its own health
// or supported capture mode) sent just the endpoints map directly with no
// wrapper - observabilityData() below normalizes all of these so a server
// that hasn't re-pushed since upgrading the agent doesn't render as broken.
// Which environment this page is showing. Metrics are stored and composed
// per environment on the server (see composeWriterSegments) because the same
// API runs in SIT, UAT and PROD and a pooled request count is a wrong number,
// not a rounder one. There is deliberately no "All environments" option: it
// would be exactly the meaningless sum this separation exists to prevent.
// The environment shown is the one picked in the HEADER (state.env), the
// same control that scopes the rest of the app. An earlier version of this
// page carried its own separate environment buttons, which meant the header
// could read Dev while the dashboard below it showed SIT figures - two
// controls disagreeing about the same question, which is worse than having
// no selector at all.
function obsEnvironmentNames(){
  const raw = state.endpointMetrics;
  const names = raw && Array.isArray(raw.environmentNames) ? raw.environmentNames : [];
  return names.filter(n => typeof n === 'string' && n);
}

// Agents name their environment freely ("SIT"), while state.env is an id
// ("DEV"). Match case-insensitively so "Sit" and "SIT" are one environment,
// but never fall back to a DIFFERENT environment's data - that is exactly
// the cross-environment mixing this whole split exists to prevent.
function obsActiveEnvironment(){
  const want = String(state.env || '').trim().toLowerCase();
  if(!want) return null;
  return obsEnvironmentNames().find(n => n.toLowerCase() === want) || null;
}

function observabilityData(){
  const raw = state.endpointMetrics;
  const env = obsActiveEnvironment();
  const empty = { endpoints: {}, agentHealth: null, logRecords: [], environment: null };
  if(!raw || typeof raw !== 'object') return empty;

  const envs = (raw.environments && typeof raw.environments === 'object') ? raw.environments : null;
  if(envs){
    // Scoped storage. No segment for this environment means no agent is
    // reporting it - show nothing rather than another environment's numbers.
    const src = env ? envs[env] : null;
    if(!src || typeof src !== 'object') return empty;
    return {
      endpoints: (src.endpoints && typeof src.endpoints === 'object') ? src.endpoints : {},
      agentHealth: (src.agentHealth && typeof src.agentHealth === 'object') ? src.agentHealth : null,
      logRecords: Array.isArray(src.logRecords) ? src.logRecords : [],
      environment: env,
    };
  }

  // Unscoped legacy blob, written before metrics carried an environment.
  // Its environment is genuinely unknown, so it is shown whatever the header
  // says, and renderObsEnvironmentBar() says so rather than implying the
  // figures belong to the selected environment.
  if(raw.endpoints && typeof raw.endpoints === 'object'){
    return {
      endpoints: raw.endpoints,
      agentHealth: (raw.agentHealth && typeof raw.agentHealth === 'object') ? raw.agentHealth : null,
      logRecords: Array.isArray(raw.logRecords) ? raw.logRecords : [],
      environment: null,
    };
  }
  return empty;
}

// This page polls every 60s (see startObsAutoRefresh below), but the AGENT
// itself pushes on its own PUSH_INTERVAL_SECONDS - 900s (15 min) by
// default, not 60s. The liveness badge (renderAgentLiveBadge) sizes its
// RUNNING/DELAYED/STALE thresholds off agentHealth.pushIntervalSeconds for
// exactly this reason: badge thresholds hardcoded against a 60s assumption
// would read DELAYED or STALE for most of every 15-minute cycle on an
// agent that is running exactly on schedule.
//
// Only while this page is actually showing, and not while the tab is in the
// background: this re-fetches the whole workspace (there is one GET for it),
// which is not something to do every minute behind someone's back.
let obsRefreshTimer = null;
// What was on screen as of the last render, so a poll can say what's NEW
// instead of just replacing the numbers silently. Reset to null whenever
// Observability is (re)opened, so opening the page never itself announces
// "5 new endpoints" for things that were already there.
let obsKnownKeys = null;
let obsKnownIps = null;

function stopObsAutoRefresh(){
  if(obsRefreshTimer){ clearInterval(obsRefreshTimer); obsRefreshTimer = null; }
}

// Every distinct endpoint key and source IP currently in view, for diffing
// against the previous poll. Cheap: it's the same data the page already
// rendered, just walked once more.
function obsCurrentKeysAndIps(){
  const { endpoints } = observabilityData();
  const keys = new Set(Object.keys(endpoints || {}));
  const ips = new Set();
  Object.values(endpoints || {}).forEach(ep=>{
    (ep.topSourceIps || []).forEach(row=>{ if(row && row.ip) ips.add(row.ip); });
  });
  return { keys, ips };
}

function startObsAutoRefresh(){
  // Idempotent, not "stop then start": renderObservability() runs on every
  // in-page interaction too (changing scope, expanding a project, switching
  // the time window all call the global renderMain()), and those don't
  // touch endpointMetrics at all. Unconditionally restarting here would mean
  // someone actively clicking around never actually gets polled - the timer
  // would keep getting pushed back by their own clicks. The interval's own
  // callback already nulls obsRefreshTimer on navigating away, so a fresh
  // start still re-arms correctly the next time this view is opened.
  if(obsRefreshTimer) return;
  const initial = obsCurrentKeysAndIps();
  obsKnownKeys = initial.keys;
  obsKnownIps = initial.ips;
  obsRefreshTimer = setInterval(async ()=>{
    if(!state.selected || state.selected.type !== 'observability'){ stopObsAutoRefresh(); return; }
    if(document.hidden) return;
    try{
      const ws = await apiGet('');
      state.endpointMetrics = (ws.endpointMetrics && typeof ws.endpointMetrics === 'object') ? ws.endpointMetrics : {};
      // Re-check: the fetch is async, and the user may have navigated away
      // while it was in flight. Rendering then would replace whatever they
      // just opened with this page's content.
      if(!state.selected || state.selected.type !== 'observability') return;

      const now = obsCurrentKeysAndIps();
      const newKeys = obsKnownKeys ? [...now.keys].filter(k=>!obsKnownKeys.has(k)) : [];
      const newIps = obsKnownIps ? [...now.ips].filter(ip=>!obsKnownIps.has(ip)) : [];
      obsKnownKeys = now.keys;
      obsKnownIps = now.ips;

      renderMain();
      // Announced AFTER the render, and only for a poll that found something
      // genuinely new - not the routine 60s refresh, which would otherwise
      // toast every single minute for no reason. One combined toast: the
      // toast overlay is a single element, so two calls back to back would
      // just have the second silently replace the first before anyone
      // could read it.
      const parts = [];
      if(newKeys.length) parts.push(`${newKeys.length} new endpoint${newKeys.length===1?'':'s'} (${newKeys.slice(0,2).join(', ')}${newKeys.length>2?', …':''})`);
      if(newIps.length) parts.push(`${newIps.length} new source IP${newIps.length===1?'':'s'} (${newIps.slice(0,3).join(', ')}${newIps.length>3?', …':''})`);
      if(parts.length) toast(`Discovered: ${parts.join(' · ')}`);
    }catch(e){
      // A failed poll is not worth interrupting anyone over - the badge
      // will age into DELAYED/STALE on its own if this keeps failing.
    }
  }, 60000);
}

// "Is the agent actually alive right now?" - the question you ask first when
// a number looks wrong, and which was previously answerable only by reading
// a timestamp buried in the Agent Health card further down the page.
//
// Liveness is judged from the agent's own last push, not from a health check
// this page performs: the page cannot reach the Mule host, and a server that
// answers is not evidence that the agent on it is still tailing.
function renderAgentLiveBadge(){
  const { agentHealth } = observabilityData();
  const gen = agentHealth && agentHealth.generatedAt;
  if(!gen) return `<span class="obs-live obs-live-none" title="No agent has reported for this environment yet">NO AGENT</span>`;
  const ageMs = Date.now() - new Date(gen).getTime();
  if(!isFinite(ageMs)) return '';
  const mins = Math.round(ageMs / 60000);
  // Thresholds scale to how OFTEN this agent actually pushes
  // (agentHealth.pushIntervalSeconds), not a fixed guess - an agent that
  // pushes every 15 minutes is still healthy 14 minutes after its last
  // push. Falls back to the agent's own PUSH_INTERVAL_SECONDS default
  // (900s) for a payload pushed before this field existed, rather than the
  // old fixed-60s assumption that read most agents as permanently DELAYED.
  const intervalMs = (Number(agentHealth.pushIntervalSeconds) || 900) * 1000;
  if(ageMs < intervalMs * 1.5) return `<span class="obs-live obs-live-ok" title="Last push ${mins} min ago">RUNNING</span>`;
  if(ageMs < intervalMs * 3) return `<span class="obs-live obs-live-warn" title="Last push ${mins} min ago">DELAYED ${mins}m</span>`;
  return `<span class="obs-live obs-live-bad" title="Last push ${mins} min ago - the agent has probably stopped">STALE ${mins}m</span>`;
}

// Names the environment these figures came from, and says plainly when the
// header's environment has no agent reporting it.
function renderObsEnvironmentBar(){
  const names = obsEnvironmentNames();
  const active = obsActiveEnvironment();
  const header = escapeHtml(String(state.env || '—'));
  if(!names.length){
    return `<div class="obs-env-bar obs-env-bar-single">These figures predate per-environment
      recording, so the environment they came from isn't known. The next agent push will label them.</div>`;
  }
  if(active){
    const others = names.filter(n => n !== active);
    return `<div class="obs-env-bar obs-env-bar-single">${renderAgentLiveBadge()}
      Showing <strong>${escapeHtml(active)}</strong>,
      from the environment selected in the header.${others.length
        ? ` Also reporting: ${others.map(n => escapeHtml(n)).join(', ')} — switch environment in the header to see those.`
        : ''}
      <span class="obs-env-note">Figures are never summed across environments.</span></div>`;
  }
  return `<div class="obs-env-bar obs-env-bar-warn">No agent is reporting for <strong>${header}</strong>,
    so there is nothing to show. Reporting environments: ${names.map(n => `<strong>${escapeHtml(n)}</strong>`).join(', ')}
    — switch environment in the header to see them.</div>`;
}

const OBS_OVERFLOW_KEY = '* OVERFLOW - too many distinct endpoints';

// Finds the first real, documented endpoint (across every project this
// viewer can see) whose method+path matches a metrics key, so a row can link
// straight to its documentation. Returns null if nothing matches yet - the
// agent may have discovered traffic for an endpoint nobody's documented.
function findDocumentedEndpointForMetricsKey(key){
  const spaceIdx = key.indexOf(' ');
  if(spaceIdx < 0) return null;
  const method = key.slice(0, spaceIdx).toUpperCase();
  const path = key.slice(spaceIdx + 1);
  for(const proj of Object.values(state.projects || {})){
    const ep = (proj.endpoints || []).find(e => e && (e.method||'').toUpperCase() === method && (e.path||'') === path);
    if(ep) return { proj, ep };
  }
  return null;
}

function errorRateColor(rate){
  if(rate >= 0.25) return 'var(--delete)';
  if(rate >= 0.05) return 'var(--put)';
  return 'var(--post)';
}

// Purely a display heuristic (RFC1918 + loopback/link-local ranges, plus a
// rough IPv6 unique-local check) so a reviewer can tell "our own
// infra/load-balancer" apart from "a real external client" at a glance -
// not a security boundary, and X-Forwarded-For is trivially spoofable
// upstream of Mule anyway (see CLIENT_IP_KEY_PATTERN's note in the agent).
function classifyIp(ip){
  if(!ip) return 'unknown';
  if(/^(10\.|127\.|192\.168\.|169\.254\.|::1$)/.test(ip)) return 'internal';
  const m172 = ip.match(/^172\.(\d{1,3})\./);
  if(m172 && +m172[1] >= 16 && +m172[1] <= 31) return 'internal';
  if(/^f[cd][0-9a-f]{2}:/i.test(ip)) return 'internal';
  return 'external';
}

// Structured per-IP breakdown: a small bar per IP (relative to the busiest
// source IN THIS SET), a private/public classification dot, and the exact
// hit count + share of total requests.
function renderIpBreakdown(topIps, totalRequests, rowIdx){
  if(!topIps.length) return '<span class="empty-field">—</span>';
  const max = Math.max(...topIps.map(x=>x.count));
  const visible = topIps.slice(0, 3);
  const rest = topIps.slice(3);
  const rowHtml = (x)=>{
    const cls = classifyIp(x.ip);
    const barPct = max ? Math.round((x.count / max) * 100) : 0;
    const share = totalRequests ? Math.round((x.count / totalRequests) * 100) : 0;
    const dotColor = cls === 'internal' ? 'var(--accent)' : cls === 'external' ? 'var(--put)' : 'var(--text-faint)';
    return `<div class="obs-ip-row">
      <span class="obs-ip-dot" style="background:${dotColor};" title="${cls} address"></span>
      <span class="obs-ip-addr mono" title="${escapeHtml(x.ip)} (${cls})">${escapeHtml(x.ip)}</span>
      <span class="obs-ip-bar-track"><span class="obs-ip-bar" style="width:${barPct}%;background:${dotColor};"></span></span>
      <span class="obs-ip-count mono">${x.count} <span style="opacity:.7;">(${share}%)</span></span>
    </div>`;
  };
  const visibleHtml = visible.map(rowHtml).join('');
  if(!rest.length){
    return `<div class="obs-ip-list">${visibleHtml}</div>`;
  }
  const restId = `obsIpRest${rowIdx}`;
  const moreLabel = `+${rest.length} more IP${rest.length===1?'':'s'}`;
  return `<div class="obs-ip-list">
    ${visibleHtml}
    <button type="button" class="obs-ip-more" data-obs-ip-toggle="${restId}" data-more-label="${moreLabel}">${moreLabel}</button>
    <div class="obs-ip-list" id="${restId}" style="display:none;">${rest.map(rowHtml).join('')}</div>
  </div>`;
}

// One health metric tile, reusing the same .kpi-card/.kpi-grid language as
// Control Center/Security Center so this reads as part of the same design
// system rather than a one-off widget.
function healthKpi(label, value, sub, accentVar){
  return `<div class="kpi-card obs-kpi-card"${accentVar ? ` style="--kpi-accent:var(${accentVar});"` : ''}>
    <div class="kpi-label">${escapeHtml(label)}</div>
    <div class="kpi-value">${accentVar ? `<span class="kpi-dot"></span>` : ''}${value}</div>
    ${sub ? `<div class="kpi-sub">${sub}</div>` : ''}
  </div>`;
}

function formatBytes(n){
  if(n === null || n === undefined) return '—';
  if(n < 1024) return `${n} B`;
  if(n < 1024*1024) return `${(n/1024).toFixed(1)} KB`;
  return `${(n/1024/1024).toFixed(1)} MB`;
}

function formatDuration(seconds){
  if(seconds === null || seconds === undefined) return '—';
  if(seconds < 60) return `${seconds}s`;
  if(seconds < 3600) return `${Math.floor(seconds/60)}m ${seconds%60}s`;
  const hrs = Math.floor(seconds/3600);
  const mins = Math.floor((seconds%3600)/60);
  return `${hrs}h ${mins}m`;
}

// Agent's own throughput/backlog/scale-safeguard status - separate from the
// per-endpoint traffic table below, so "is the agent itself keeping up"
// (never written by anything downstream of the raw log, never blocked by
// documentation review state) is answerable at a glance instead of only
// living in stdout on a server most reviewers aren't logged into.
function renderAgentHealth(health){
  if(!health){
    return `<div class="obs-panel">
      <div class="section-title">Agent health</div>
      <div class="hint" style="margin-top:-4px;">Not available yet - this fills in once the agent has been updated to a version that reports its own throughput/backlog (re-pull ops/sit-doc-agent and restart it). Endpoint traffic below still works either way.</div>
    </div>`;
  }

  const warnings = [];
  if(health.catchingUp) warnings.push(`Currently catching up on a backlog larger than one poll cycle (${health.maxLinesPerCycle} lines) - this is expected under a burst of traffic and resolves on its own; it does not mean anything was dropped.`);
  if(health.overflowObservations) warnings.push(`${health.overflowObservations} observation(s) folded into a shared overflow bucket because more than ${health.maxTrackedEndpoints} distinct endpoints were seen - see the "OVERFLOW" row below. Raise MAX_TRACKED_ENDPOINTS if this keeps growing, or check for path segments (ids) that should be templated out.`);
  if(health.lastPushOk === false) warnings.push(`Last push to DocTracker failed: ${escapeHtml(health.lastError || 'unknown error')}. The agent will retry automatically next cycle - nothing needs to be done on this page.`);

  const rpm = health.requestsPerMinute;
  const rpmDisplay = (rpm === null || rpm === undefined) ? '—' : (rpm >= 1000 ? `${(rpm/1000).toFixed(1)}k` : rpm);
  // At current rate, this is what 100k requests/30min (~55 req/s, the scale
  // the traffic team asked about) would look like on this dashboard - shown
  // so "is this endpoint able to handle that" has a concrete number instead
  // of an abstract reassurance.
  const projectedPer30Min = (rpm !== null && rpm !== undefined) ? Math.round(rpm * 30) : null;

  const kpis = [
    healthKpi('Requests / min', rpmDisplay, projectedPer30Min !== null ? `≈ ${projectedPer30Min.toLocaleString()} per 30 min at this rate` : 'Not enough samples yet'),
    healthKpi('Log backlog unread', formatBytes(health.backlogBytes), health.catchingUp ? 'Catching up now' : 'Fully caught up', health.catchingUp ? '--put' : '--post'),
    healthKpi('Tracked endpoints', `${health.trackedEndpointCount ?? '—'} / ${health.maxTrackedEndpoints ?? '—'}`, 'Distinct method+path keys (ids templated out)'),
    healthKpi('Last cycle', health.lastCycleDurationMs !== null && health.lastCycleDurationMs !== undefined ? `${health.lastCycleDurationMs} ms` : '—', health.lastCycleLinesRead !== null && health.lastCycleLinesRead !== undefined ? `${health.lastCycleLinesRead.toLocaleString()} line(s) read` : ''),
    healthKpi('Logs tailed', health.tailedLogCount ? String(health.tailedLogCount) : '—',
      health.tailedLogCount ? `${health.maxLinesPerCycle ? Math.floor(health.maxLinesPerCycle / health.tailedLogCount).toLocaleString() : '—'} line(s) of budget each per cycle` : 'Single file, or an older agent build'),
    healthKpi('Agent uptime', formatDuration(health.uptimeSeconds), health.cyclesRun ? `${health.cyclesRun.toLocaleString()} poll cycle(s) run` : ''),
    healthKpi('Last push', health.lastPushAt ? formatDateTime(health.lastPushAt) : '—', health.lastPushOk === false ? 'Failed - retrying' : (health.lastPushOk ? 'Succeeded' : ''), health.lastPushOk === false ? '--delete' : (health.lastPushOk ? '--post' : undefined)),
  ];

  return `<div class="obs-panel">
    <div class="section-title">Agent health</div>
    <div class="hint" style="margin-top:-4px;">
      Self-monitoring for the discovery agent itself (${escapeHtml(health.sourceLog || '')}, Python ${escapeHtml(health.pythonVersion || '?')}, polling every ${health.pollIntervalSeconds ?? '?'}s). The agent never sits in the request path - it only tails an already-written log file - so it cannot slow down or hang the real API server regardless of traffic volume; what it CAN do under enough volume is fall behind reading its own input or grow its own memory/storage, which is what this card tracks. Generated ${health.generatedAt ? formatDateTime(health.generatedAt) : '—'}.
    </div>
    ${warnings.length ? `<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px;">${warnings.map(w=>`<div style="font-size:11.5px;color:var(--put);background:var(--put-bg);border:1px solid color-mix(in srgb, var(--put) 35%, transparent);border-radius:8px;padding:8px 12px;">${w}</div>`).join('')}</div>` : ''}
    <div class="kpi-grid">${kpis.join('')}</div>
    ${Array.isArray(health.tailedLogs) && health.tailedLogs.length > 1 ? `
      <div class="hint" style="margin-top:12px;">Tailing ${health.tailedLogs.length} log file(s): ${health.tailedLogs.slice(0, 12).map(n=>`<code>${escapeHtml(n)}</code>`).join(' ')}${health.tailedLogs.length > 12 ? ` <span style="color:var(--text-faint);">+${health.tailedLogs.length - 12} more</span>` : ''}</div>` : ''}
    ${Array.isArray(health.writers) && health.writers.length > 1 ? `
      <div class="hint" style="margin-top:8px;">${health.writers.length} agents reporting: ${health.writers.map(w=>`<code>${escapeHtml(w.writerId || '?')}</code>`).join(' ')} — the figures above are from the most recently reporting one.</div>` : ''}
  </div>`;
}

// Buckets the agent's logVolumeSamples - [epochSeconds, cumulativeLinesProcessed]
// pairs, one per push (~15 min apart by default) - into a fixed number of
// time buckets by taking the delta between consecutive cumulative samples.
// This is raw LOG LINES read by the agent (always available in both capture
// modes), not per-request records. It's the ONE volume-over-time chart on
// this page on purpose - there used to be a second, near-identical
// "Request volume" chart built from per-request records, which read as a
// duplicate of this one; per-request timing now lives in the p50/p95/p99
// KPI at the top instead.
function bucketLogVolumeSamples(samples, buckets){
  if(!samples || samples.length < 2) return null;
  const sorted = samples.slice().sort((a,b)=>a[0]-b[0]);
  const minTs = sorted[0][0]*1000, maxTs = sorted[sorted.length-1][0]*1000;
  const span = Math.max(1, maxTs - minTs);
  const bucketMs = span / buckets;
  const counts = new Array(buckets).fill(0);
  let totalLines = 0;
  for(let i=1;i<sorted.length;i++){
    const [tsSec, cum] = sorted[i];
    const [prevTsSec, prevCum] = sorted[i-1];
    const delta = Math.max(0, cum - prevCum);
    if(!delta) continue;
    totalLines += delta;
    const midTs = ((tsSec + prevTsSec) / 2) * 1000;
    let idx = Math.floor((midTs - minTs) / bucketMs);
    if(idx >= buckets) idx = buckets - 1;
    if(idx < 0) idx = 0;
    counts[idx] += delta;
  }
  return { counts, minTs, maxTs, totalLines };
}

const LOG_LEVEL_META = [
  ['ERROR', '--st-5'], ['FATAL', '--st-5'], ['WARN', '--st-4'],
  ['INFO', '--st-3'], ['DEBUG', '--text-faint'], ['TRACE', '--border'],
];
// Below this many real matched lines, a "distribution" would be built from
// too little (or zero) real signal to mean anything - see
// classify_log_level()'s docstring in mule_doc_agent.py for why matches
// aren't guaranteed for every deployment's log format.
const LOG_LEVEL_MIN_MATCHES = 20;

function renderLogVolumeAndLevelsSection(agentHealth){
  const samples = (agentHealth && agentHealth.logVolumeSamples) || [];
  const bucketed = bucketLogVolumeSamples(samples, 14);

  const volumeHtml = (bucketed && bucketed.totalLines > 0) ? (()=>{
    const max = Math.max(...bucketed.counts, 1);
    const bucketMs = (bucketed.maxTs - bucketed.minTs) / bucketed.counts.length;
    const bars = bucketed.counts.map((c,i)=>{
      const bucketStart = formatDateTime(new Date(bucketed.minTs + i * bucketMs).toISOString());
      const bucketEnd = formatDateTime(new Date(bucketed.minTs + (i + 1) * bucketMs).toISOString());
      return `<div class="obs-vol-bar${i>=bucketed.counts.length-3?' hot':''}" style="height:${Math.max(3, Math.round(c/max*100))}%;" title="${Math.round(c).toLocaleString()} log line(s) — ${bucketStart} to ${bucketEnd}"></div>`;
    }).join('');
    return `<div class="obs-vol-chart">${bars}</div>
      <div class="obs-vol-axis"><span>${formatDateTime(new Date(bucketed.minTs).toISOString())}</span><span>${formatDateTime(new Date(bucketed.maxTs).toISOString())}</span></div>`;
  })() : `<div class="empty-field" style="padding:6px 0;">Not enough samples yet — one is taken per push, so this fills in once the agent has pushed at least twice.</div>`;

  const counts = (agentHealth && agentHealth.logLevelCounts) || {};
  const matchedTotal = (agentHealth && agentHealth.logLevelMatchedTotal) || 0;
  let levelsHtml;
  if(matchedTotal < LOG_LEVEL_MIN_MATCHES){
    levelsHtml = `<div class="empty-field" style="padding:6px 0;">Level tags (ERROR/WARN/INFO/DEBUG) aren't reliably detected in this log file's line format yet — this needs a standard level token near the start of each raw line, which isn't confirmed for this deployment's log format. Shown only once real matches exist, never guessed.</div>`;
  } else {
    const present = LOG_LEVEL_META.filter(([lvl])=>(counts[lvl]||0) > 0);
    const segTotal = present.reduce((sum,[lvl])=>sum+(counts[lvl]||0), 0) || 1;
    levelsHtml = `<div class="obs-statusbar">${present.map(([lvl,cssVar])=>`<span style="width:${((counts[lvl]||0)/segTotal*100)}%;background:var(${cssVar});"></span>`).join('')}</div>
      <div class="obs-status-legend">${present.map(([lvl,cssVar])=>`<span class="k"><i style="background:var(${cssVar});"></i>${lvl} ${(counts[lvl]||0).toLocaleString()}</span>`).join('')}</div>`;
  }

  return `<div class="obs-panel">
    <div class="section-title">Log volume</div>
    <div class="hint" style="margin-top:-4px;">${bucketed && bucketed.totalLines>0 ? Math.round(bucketed.totalLines).toLocaleString()+' raw log line(s) over the sampled range' : 'Raw lines read by the agent, sampled once per push'}</div>
    ${volumeHtml}
    <div class="section-title" style="margin-top:18px;">Log level distribution</div>
    <div class="hint" style="margin-top:-4px;">${matchedTotal>=LOG_LEVEL_MIN_MATCHES ? matchedTotal.toLocaleString()+' log line(s) with a detected level tag' : 'Best-effort — only shown once reliably detected in this log format'}</div>
    ${levelsHtml}
  </div>`;
}

// --- Host health -----------------------------------------------------------
// CPU / memory / disk pressure on the machine the agent runs on, sampled once
// per poll cycle (~60s) by sample_host_metrics() in mule_doc_agent.py.
//
// These are HOST numbers, not per-endpoint ones, and they are only the Mule
// runtime's host because the agent is deployed onto the SIT server to tail
// Mule's log locally. The agent reports hostMetricsEnabled so this panel can
// say so honestly rather than implying an attribution it can't make.
//
// Deliberately NOT shown: JVM heap, GC pressure, or per-endpoint CPU. Nothing
// the agent can read from outside the JVM supports them, and a guessed heap
// number next to real CPU numbers would poison the real ones.
function formatBytes(n){
  if(n === null || n === undefined) return '—';
  const units = ['B','KB','MB','GB','TB'];
  let v = n, i = 0;
  while(v >= 1024 && i < units.length-1){ v /= 1024; i++; }
  return (v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)) + ' ' + units[i];
}

// Thresholds are the conventional ops ones, and are about sustained pressure,
// not a single spiky sample - which is why the gauge reads from the latest
// sample but the panel also shows peak/mean across the retained window.
function pressureVar(pct){
  if(pct === null || pct === undefined) return '--text-faint';
  if(pct >= 90) return '--st-5';
  if(pct >= 75) return '--st-4';
  return '--st-3';
}

function obsGauge(label, pct, detail){
  if(pct === null || pct === undefined){
    return `<div class="obs-gauge"><div class="obs-gauge-head"><span class="l">${label}</span><span class="v">—</span></div>
      <div class="obs-statusbar"><span style="width:100%;background:var(--surface-2);"></span></div>
      <div class="obs-gauge-detail">Not readable on this host</div></div>`;
  }
  const cssVar = pressureVar(pct);
  return `<div class="obs-gauge"><div class="obs-gauge-head"><span class="l">${label}</span><span class="v" style="color:var(${cssVar});">${pct}%</span></div>
    <div class="obs-statusbar"><span style="width:${Math.max(1, Math.min(100, pct))}%;background:var(${cssVar});"></span></div>
    <div class="obs-gauge-detail">${detail || ''}</div></div>`;
}

// Mirrors HOST_SAMPLE_COLUMNS in mule_doc_agent.py - each sample is a
// fixed-position array of only the values that change, so 720 of them cost
// ~40KB on the wire instead of ~210KB as objects. The never-changing values
// (total RAM, disk size, core count) arrive once in agentHealth.hostInfo,
// and used-bytes / free-bytes / load-per-core are derived from the two.
// A null slot means "couldn't be read", never zero.
const HOST_SAMPLE_COLS = ['at','cpuPct','memPct','diskUsedPct','load1','load5','load15','agentRssBytes'];

function hostSampleToObj(arr){
  if(!Array.isArray(arr)) return null;
  const o = {};
  HOST_SAMPLE_COLS.forEach((col, i)=>{
    o[col] = (arr[i] === null || arr[i] === undefined) ? null : arr[i];
  });
  return o;
}

function renderHostHealthSection(agentHealth){
  // Older agent builds sent objects; ignore anything not in the current
  // array form rather than rendering half a panel from a shape we can't
  // read positionally.
  const samples = (((agentHealth && agentHealth.hostSamples) || [])
    .filter(Array.isArray).map(hostSampleToObj));
  const info = (agentHealth && agentHealth.hostInfo) || {};
  const enabled = !agentHealth || agentHealth.hostMetricsEnabled !== false;

  if(!enabled){
    return `<div class="obs-panel">
      <div class="section-title">Host health</div>
      <div class="empty-field" style="padding:6px 0;">Host metrics are switched off for this agent (<code>HOST_METRICS_ENABLED=false</code>). That's the correct setting when the agent doesn't run on the same machine as the Mule runtime — CPU and memory would describe the wrong host.</div>
    </div>`;
  }
  if(!samples.length){
    // Distinguish the two reasons this is empty, because the fix differs and
    // "no data" alone sends someone looking in the wrong place. If the agent
    // is reporting at all but sent no hostSamples key, it's an older build
    // that predates host sampling and needs redeploying on the log server.
    const agentReporting = !!(agentHealth && agentHealth.generatedAt);
    const staleAgent = agentReporting && agentHealth.hostSamples === undefined;
    return `<div class="obs-panel">
      <div class="section-title">Host health</div>
      <div class="empty-field" style="padding:6px 0;">${staleAgent
        ? `The log agent running on the server predates host sampling, so it isn't sending CPU/memory yet. Deploy the current <code>ops/sit-doc-agent/mule_doc_agent.py</code> to the log server and restart it — the first CPU reading needs two poll cycles (CPU is a delta, not a snapshot), and reaches this page on the next push.`
        : `No host samples yet. The agent reads these from <code>/proc</code> and <code>statvfs</code> once per poll cycle, so they appear after its next push — and stay empty on a host without <code>/proc</code> (non-Linux), where they're reported as unavailable rather than guessed.`}</div>
    </div>`;
  }

  const latest = samples[samples.length - 1];
  const intervalSec = (agentHealth && agentHealth.hostSampleIntervalSeconds) || 60;
  // Kept as {cpuPct, at} pairs, not a bare number array, so the sparkline
  // below can show each bar's OWN sample time on hover - a plain
  // samples.map(cpuPct).filter(...) would silently desync value from
  // timestamp the moment the first (nullable) sample gets filtered out.
  const cpuSamples = samples.filter(s=>typeof s.cpuPct === 'number');
  const cpuSeries = cpuSamples.map(s=>s.cpuPct);
  const memSeries = samples.map(s=>s.memPct).filter(v=>typeof v === 'number');

  const peak = arr => arr.length ? Math.max(...arr) : null;
  const mean = arr => arr.length ? Math.round(arr.reduce((a,b)=>a+b,0)/arr.length*10)/10 : null;

  // Used/free bytes are derived from the percentage plus the one-off totals
  // in hostInfo, rather than being repeated in all 720 samples.
  const memDetail = (latest.memPct !== null && info.memTotalBytes)
    ? `${formatBytes(info.memTotalBytes * latest.memPct / 100)} of ${formatBytes(info.memTotalBytes)} in use`
    : '';
  const diskDetail = (latest.diskUsedPct !== null && info.diskTotalBytes)
    ? `${formatBytes(info.diskTotalBytes * (1 - latest.diskUsedPct / 100))} free on the log filesystem`
    : '';
  const cpuDetail = cpuSeries.length > 1
    ? `peak ${peak(cpuSeries)}% · mean ${mean(cpuSeries)}% over ${cpuSeries.length} sample(s)`
    : 'first sample — needs two reads for a rate';

  // Load average is the one number that says whether the CPU figure means
  // "busy and coping" or "saturated and queueing". Normalised per core so it
  // reads the same on a 2-core box and a 32-core one.
  const cores = info.cpuCores || null;
  const loadPerCore = (latest.load1 !== null && cores) ? latest.load1 / cores : null;
  const loadDetail = (latest.load1 !== null)
    ? `${latest.load1} / ${latest.load5} / ${latest.load15}${cores ? ` over ${cores} core(s)` : ''}`
    : '';
  const loadPct = (loadPerCore !== null) ? Math.min(100, Math.round(loadPerCore * 100)) : null;

  // CPU sparkline over the retained window, on the same left-to-right time
  // axis as the Log volume chart below it - that alignment is the point:
  // a 5xx cluster sitting under a CPU plateau is a different diagnosis from
  // one sitting under a flat line.
  const spark = cpuSeries.length > 1 ? (()=>{
    const maxV = Math.max(...cpuSeries, 1);
    const trimmed = cpuSamples.slice(-48);
    const bars = trimmed.map((s,i)=>`<div class="obs-vol-bar${i>=trimmed.length-3?' hot':''}" style="height:${Math.max(3, Math.round(s.cpuPct/maxV*100))}%;background:var(${pressureVar(s.cpuPct)});" title="${s.cpuPct}% CPU — ${formatDateTime(new Date(s.at*1000).toISOString())}"></div>`).join('');
    const firstAt = trimmed[0].at;
    return `<div class="section-title" style="margin-top:18px;">CPU over time</div>
      <div class="hint" style="margin-top:-4px;">One sample per poll cycle (~${intervalSec}s), newest at the right — hover a bar for its exact time</div>
      <div class="obs-vol-chart" style="height:64px;">${bars}</div>
      <div class="obs-vol-axis"><span>${formatDateTime(new Date(firstAt*1000).toISOString())}</span><span>${formatDateTime(new Date(latest.at*1000).toISOString())}</span></div>`;
  })() : '';

  const agentFootprint = (latest.agentRssBytes !== null)
    ? `<div class="hint" style="margin-top:10px;">This agent's own resident memory: <strong>${formatBytes(latest.agentRssBytes)}</strong> — shown so it can be ruled in or out as a cause of the memory figure above it.</div>`
    : '';

  return `<div class="obs-panel">
    <div class="section-title">Host health</div>
    <div class="hint" style="margin-top:-4px;">Machine running the log agent, sampled ${formatDateTime(new Date(latest.at*1000).toISOString())}${memSeries.length>1?` · memory peak ${peak(memSeries)}%`:''}</div>
    <div class="obs-gauge-grid">
      ${obsGauge('CPU', latest.cpuPct, cpuDetail)}
      ${obsGauge('Memory', latest.memPct, memDetail)}
      ${obsGauge('Log disk', latest.diskUsedPct, diskDetail)}
      ${obsGauge('Load per core', loadPct, loadDetail)}
    </div>
    ${spark}
    ${agentFootprint}
  </div>`;
}

// Shared by both views - one row per metrics key. `keys` is whatever subset
// the caller wants shown (all of them for Overview, the current scope's
// subset for Console).
// Sortable columns on the endpoints table. Default is busiest-first, which
// is what someone scanning for "where is the traffic" wants; error rate and
// p95 are the two other orders that actually get used in practice.
const OBS_EP_SORTS = {
  total:     { label:'Requests',   get: r => r.total },
  errorRate: { label:'Error rate', get: r => r.rate },
  p95:       { label:'p95',        get: r => (r.latency ? r.latency.p95 : -1) },
  lastSeen:  { label:'Last seen',  get: r => (r.lastSeenAt ? new Date(r.lastSeenAt).getTime() : -1) },
};

// `basis` mirrors whatever obsComputeStats decided for the page as a whole
// ('aggregate' for the complete all-time counters, 'records' for a bounded
// window) so this table can never disagree with the KPIs above it.
// 50 rows/page keeps a table of hundreds of auto-discovered endpoints
// scannable without an extra network round trip - everything needed is
// already in `keys`, so this is a pure client-side slice, not a fetch.
const OBS_EP_PAGE_SIZE = 50;

function renderEndpointsTable(keys, metrics, records, basis){
  if(!state.obsEpSort) state.obsEpSort = { col:'total', dir:'desc' };
  if(typeof state.obsEpFilter !== 'string') state.obsEpFilter = '';
  if(!state.obsEpPage) state.obsEpPage = 1;
  const sort = state.obsEpSort;

  // Search narrows BEFORE sort/paging, on method+path text - the same two
  // things every row visibly shows, so what someone types always explains
  // what disappeared.
  const q = state.obsEpFilter.trim().toLowerCase();
  const allKeys = keys;
  keys = q ? keys.filter(k=>k.toLowerCase().includes(q)) : keys;

  // Per-endpoint stats follow the same rule as the rest of the page: when
  // windowed per-request records exist for a key, everything about that row
  // (count, error rate, latency, last seen) is computed from them. Keys with
  // no records keep their cumulative aggregate and are tagged "all-time", so
  // a table mixing the two bases says which rows are which instead of
  // quietly presenting all-time counts under a windowed heading.
  const recordsByKey = new Map();
  (records || []).forEach(r=>{
    if(!recordsByKey.has(r.key)) recordsByKey.set(r.key, []);
    recordsByKey.get(r.key).push(r);
  });

  const rowData = keys.map(key=>{
    const keyRecords = recordsByKey.get(key) || [];
    const s = keyRecords.length ? statsFromRecords(keyRecords) : null;
    if(basis === 'records' && s){
      return {
        key,
        total: s.total,
        rate: s.errorRate,
        breakdown: s.statusBreakdown,
        topIps: s.topIps,
        lastSeenAt: s.lastSeenAt,
        latency: s.latency,
        windowed: true,
      };
    }
    // Aggregate basis (or no records for this key): the complete counters,
    // with latency filled in from records where they happen to exist since
    // aggregates can't express it at all.
    const m = metrics[key] || {};
    return {
      key,
      total: m.totalRequests || 0,
      rate: typeof m.errorRate === 'number' ? m.errorRate : 0,
      breakdown: m.statusBreakdown || {},
      topIps: Array.isArray(m.topSourceIps) ? m.topSourceIps : [],
      lastSeenAt: m.lastSeenAt || null,
      latency: s ? s.latency : null,
      windowed: false,
    };
  });
  // Only worth tagging rows when the table is actually mixing bases.
  const anyWindowed = basis === 'records' && rowData.some(r => r.windowed);

  const sorter = OBS_EP_SORTS[sort.col] || OBS_EP_SORTS.total;
  rowData.sort((a,b)=>{
    const d = sorter.get(a) - sorter.get(b);
    return sort.dir === 'asc' ? d : -d;
  });

  const totalPages = Math.max(1, Math.ceil(rowData.length / OBS_EP_PAGE_SIZE));
  // Clamped rather than reset here: a filter/scope change can shrink the
  // result set out from under whatever page someone was on, and landing on
  // the nearest valid page beats silently showing an empty table.
  if(state.obsEpPage > totalPages) state.obsEpPage = totalPages;
  if(state.obsEpPage < 1) state.obsEpPage = 1;
  const pageStart = (state.obsEpPage - 1) * OBS_EP_PAGE_SIZE;
  const pageRows = rowData.slice(pageStart, pageStart + OBS_EP_PAGE_SIZE);

  const rows = pageRows.length ? pageRows.map((r, idx)=>{
    const breakdownLabel = Object.keys(r.breakdown).sort().map(fam=>`${fam}: ${r.breakdown[fam]}`).join(', ') || '—';
    const isOverflow = r.key === OBS_OVERFLOW_KEY;
    const found = isOverflow ? null : findDocumentedEndpointForMetricsKey(r.key);
    const [method, ...pathParts] = r.key.split(' ');
    const path = pathParts.join(' ');
    const linkAttr = found ? ` data-obs-ep="${found.ep.id}"` : '';
    const methodCell = isOverflow
      ? `<span class="badge badge-lg" style="background:var(--put-bg);color:var(--put);">OVERFLOW</span>`
      : `<span class="badge badge-lg ${methodClass(method)}">${escapeHtml(method||'')}</span>`;
    const basisTag = (anyWindowed && !r.windowed)
      ? ` <span class="obs-basis-tag" title="No per-request records for this endpoint — showing its cumulative total, not the selected window">all-time</span>`
      : '';
    return `<tr class="cc-proj-row"${linkAttr} style="${found?'':'cursor:default;'}">
      <td>${methodCell}</td>
      <td class="mono">${escapeHtml(path)}${basisTag}</td>
      <td class="mono">${r.total.toLocaleString()}</td>
      <td style="color:${errorRateColor(r.rate)};font-weight:600;">${(r.rate*100).toFixed(1)}%</td>
      <td class="mono">${r.latency ? `${r.latency.p95}ms <span style="color:var(--text-faint);font-size:10px;">/ p50 ${r.latency.p50}ms</span>` : '<span class="empty-field">—</span>'}</td>
      <td class="mono" style="font-size:11px;color:var(--text-faint);">${escapeHtml(breakdownLabel)}</td>
      <td>${renderIpBreakdown(r.topIps, r.total, idx)}</td>
      <td class="mono" style="font-size:10.5px;color:var(--text-faint);">${r.lastSeenAt ? formatDateTime(r.lastSeenAt) : '—'}</td>
      <td>${isOverflow ? '<span class="empty-field">Not an endpoint</span>' : (found ? '<span style="color:var(--post);">Documented</span>' : '<span class="empty-field">Not yet documented</span>')}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="9" class="empty-field" style="padding:16px;">${
    allKeys.length && q
      ? `No endpoint matches "${escapeHtml(state.obsEpFilter.trim())}".`
      : `No traffic discovered yet. This fills in once the SIT log auto-discovery agent (ops/sit-doc-agent) has pushed at least one batch — see AGENT_README.md.`
  }</td></tr>`;

  const sortableTh = (col, label)=>{
    const active = sort.col === col;
    const arrow = active ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
    return `<th class="obs-sort-th${active?' active':''}" data-obs-sort="${col}" title="Sort by ${escapeHtml(label)}">${escapeHtml(label)}${arrow}</th>`;
  };

  const countLabel = q ? `${rowData.length} of ${allKeys.length}` : `${allKeys.length}`;
  const pagerLabel = rowData.length
    ? `${(pageStart+1).toLocaleString()}–${Math.min(pageStart+OBS_EP_PAGE_SIZE, rowData.length).toLocaleString()} of ${rowData.length.toLocaleString()}`
    : '0 of 0';

  return `<div class="obs-panel">
    <div class="section-title">Endpoints${allKeys.length ? ` (${countLabel})` : ''}</div>
    <div class="hint" style="margin-top:-4px;">Every discovered method + path in the current scope — click a sortable column to reorder, or a documented row to open its docs.</div>
    <div class="env-table-toolbar obs-ep-toolbar">
      <div class="env-table-search obs-ep-search">
        <span class="env-table-search-ic"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.2" y2="16.2"></line></svg></span>
        <input type="text" id="obsEpSearchInput" placeholder="Search method or path…" value="${escapeHtml(state.obsEpFilter)}">
      </div>
      <div class="obs-ep-pager">
        <span class="obs-ep-pager-label">${pagerLabel}</span>
        <button type="button" class="icon-btn" id="obsEpPagePrev" ${state.obsEpPage<=1?'disabled':''} title="Previous page">‹</button>
        <span class="obs-ep-pager-page">Page ${state.obsEpPage} of ${totalPages}</span>
        <button type="button" class="icon-btn" id="obsEpPageNext" ${state.obsEpPage>=totalPages?'disabled':''} title="Next page">›</button>
      </div>
    </div>
    <div class="table-scroll">
    <table class="data-table cc-proj-table">
      <thead><tr>
        <th>Method</th><th>Path</th>
        ${sortableTh('total','Requests')}
        ${sortableTh('errorRate','Error rate')}
        ${sortableTh('p95','p95 latency')}
        <th>Status breakdown</th><th>Source IPs</th>
        ${sortableTh('lastSeen','Last seen')}
        <th>Documentation</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    </div>
  </div>`;
}

function wireEndpointsTable(main){
  main.querySelectorAll('[data-obs-sort]').forEach(th=>{
    th.addEventListener('click', ()=>{
      const col = th.getAttribute('data-obs-sort');
      const cur = state.obsEpSort || { col:'total', dir:'desc' };
      // Same column toggles direction; a new column starts descending,
      // which is the useful default for every one of these (busiest,
      // worst error rate, slowest, most recent).
      state.obsEpSort = (cur.col === col)
        ? { col, dir: cur.dir === 'desc' ? 'asc' : 'desc' }
        : { col, dir: 'desc' };
      state.obsEpPage = 1; // a re-sort re-orders everything, so "page 3" means something different now
      renderMain();
    });
  });
  const epSearch = main.querySelector('#obsEpSearchInput');
  if(epSearch){
    epSearch.addEventListener('input', ()=>{
      state.obsEpFilter = epSearch.value;
      state.obsEpPage = 1; // a new filter is a new result set - stay on page 1 of it
      renderMain();
      // renderMain() rebuilds this input from scratch, so focus/cursor
      // position are gone unless restored - same pattern as the env table's
      // own search box (13-endpoint-table.js).
      const el = document.getElementById('obsEpSearchInput');
      if(el){ el.focus(); const v = el.value; el.setSelectionRange(v.length, v.length); }
    });
  }
  const epPrev = main.querySelector('#obsEpPagePrev');
  if(epPrev) epPrev.addEventListener('click', ()=>{ state.obsEpPage = Math.max(1, state.obsEpPage - 1); renderMain(); });
  const epNext = main.querySelector('#obsEpPageNext');
  if(epNext) epNext.addEventListener('click', ()=>{ state.obsEpPage += 1; renderMain(); });
  main.querySelectorAll('[data-obs-ep]').forEach(row=>{
    row.style.cursor = 'pointer';
    row.addEventListener('click', (e)=>{
      if(e.target.closest('[data-obs-ip-toggle]')) return;
      const epId = row.getAttribute('data-obs-ep');
      state.selected = { type:'endpoint', id: epId };
      renderSidebar();
      renderMain();
    });
  });
  main.querySelectorAll('[data-obs-ip-toggle]').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      e.stopPropagation();
      const target = document.getElementById(btn.getAttribute('data-obs-ip-toggle'));
      if(!target) return;
      const showing = target.style.display !== 'none';
      target.style.display = showing ? 'none' : 'flex';
      btn.textContent = showing ? btn.getAttribute('data-more-label') : 'Hide';
    });
  });
}

/* ==================== Console mode ==================== */

// Groups metrics keys by the real project they belong to (via the same
// method+path match the table uses for its "Documentation" column), so the
// scope panel mirrors the app's own project structure instead of a flat
// key list. Keys with no documented match land in one "Undocumented
// traffic" bucket rather than being hidden.
function groupMetricsByProject(metrics){
  const groups = new Map(); // projectId -> {name, keys:[]}
  const undocumented = [];
  Object.keys(metrics).forEach(key=>{
    if(key === OBS_OVERFLOW_KEY){ undocumented.push(key); return; }
    const found = findDocumentedEndpointForMetricsKey(key);
    if(found){
      // Group by the Mule APPLICATION where we know it, not by the
      // DocTracker project. Auto-discovery puts every endpoint it finds
      // into one project, so grouping by project produced a single
      // undifferentiated list of ~380 - no way to find an API by name.
      // The agent tags each endpoint with the app that serves it, and that
      // tag is the name people actually recognise. Hand-documented projects
      // keep their project name, since their tags mean something else.
      const tag = found.ep && typeof found.ep.tag === 'string' ? found.ep.tag.trim() : '';
      const useTag = tag && tag !== 'Auto-discovered';
      const id = useTag ? `app:${tag}` : found.proj.id;
      const name = useTag ? tag : found.proj.name;
      if(!groups.has(id)) groups.set(id, { id, name, keys: [] });
      groups.get(id).keys.push(key);
    } else {
      undocumented.push(key);
    }
  });
  const list = Array.from(groups.values()).sort((a,b)=> a.name.localeCompare(b.name));
  if(undocumented.length) list.push({ id:'__undocumented', name:'Undocumented traffic', keys: undocumented });
  return list;
}

function aggregateKeys(keys, metrics){
  let total = 0, errCount = 0, lastSeenAt = null;
  const statusBreakdown = {};
  const ipCounts = {};
  keys.forEach(key=>{
    const m = metrics[key] || {};
    const t = m.totalRequests || 0;
    total += t;
    Object.entries(m.statusBreakdown || {}).forEach(([fam, c])=>{
      statusBreakdown[fam] = (statusBreakdown[fam] || 0) + c;
      if(fam === '4xx' || fam === '5xx') errCount += c;
    });
    (m.topSourceIps || []).forEach(({ip, count})=>{ ipCounts[ip] = (ipCounts[ip] || 0) + count; });
    if(m.lastSeenAt && (!lastSeenAt || m.lastSeenAt > lastSeenAt)) lastSeenAt = m.lastSeenAt;
  });
  const topIps = Object.entries(ipCounts).map(([ip,count])=>({ip,count})).sort((a,b)=>b.count-a.count).slice(0,10);
  return { total, errCount, errorRate: total ? errCount/total : 0, statusBreakdown, topIps, lastSeenAt, endpointCount: keys.length };
}

/* --- Blob -> time-series bridge -----------------------------------------
   The rebuilt console reads the time-series API. An org whose agent has not
   started pushing rollups has nothing there yet - but it DOES have the blob
   this page has always drawn from. Mapping the blob into the shape the API
   returns means the new layout shows REAL numbers on day one instead of
   sitting behind an agent deploy, which is the difference between a console
   someone can use today and a promise they have to take on trust.

   What the blob genuinely cannot supply - a time dimension, latency
   percentiles, per-request rows - is marked, not faked: `source: 'blob'` is
   what every panel keys off to say so in its own words rather than drawing an
   empty chart that reads as "no traffic".

   coverage.buckets stays 0 on purpose, so obsDataAvailable() is still false
   and a real rollup load overwrites this the moment one lands. */
function obsBridgeFromBlob(metrics, logRecords){
  const keys = Object.keys(metrics || {}).filter(k => k !== OBS_OVERFLOW_KEY);
  if(!keys.length) return null;

  const agg = aggregateKeys(keys, metrics);
  const endpoints = keys.map(key=>{
    const m = metrics[key] || {};
    const total = m.totalRequests || 0;
    const b = m.statusBreakdown || {};
    const errCount = (b['4xx'] || 0) + (b['5xx'] || 0);
    return {
      endpointId: key,            // a blob key is already "METHOD /path"; obsEndpointLabel() passes it through
      total,
      errCount,
      errorRate: total ? errCount / total : 0,
      statusBreakdown: {
        '2xx': b['2xx'] || 0, '3xx': b['3xx'] || 0, '4xx': b['4xx'] || 0,
        '5xx': b['5xx'] || 0, unknown: b.unknown || 0,
      },
      lastSeenAt: m.lastSeenAt || null,
      latency: null,
    };
  }).sort((a, b)=> b.total - a.total);

  return {
    source: 'blob',
    recordCount: Array.isArray(logRecords) ? logRecords.length : 0,
    range: null,
    current: {
      total: agg.total,
      errCount: agg.errCount,
      errorRate: agg.errorRate,
      statusBreakdown: Object.assign({ '2xx':0, '3xx':0, '4xx':0, '5xx':0, unknown:0 }, agg.statusBreakdown),
      topIps: agg.topIps,
      endpointCount: agg.endpointCount,
      lastSeenAt: agg.lastSeenAt,
      latency: null,
      latencyBuckets: {},
    },
    previous: null,                              // no prior window to compare against, so no delta badges
    coverage: { oldest: null, newest: agg.lastSeenAt, buckets: 0 },
    series: [],
    endpoints,
    loadedAt: Date.now(),
  };
}

// Same anomaly thresholds anomaly_notes() in mule_doc_agent.py already
// flags server-side (>=25% over >=5 requests) plus a lower "watch" tier -
// not a new definition of "alert," the same one the agent's own notes use.
function computeConsoleAlerts(metrics){
  const alerts = [];
  Object.keys(metrics).forEach(key=>{
    if(key === OBS_OVERFLOW_KEY) return;
    const m = metrics[key] || {};
    const total = m.totalRequests || 0;
    const rate = typeof m.errorRate === 'number' ? m.errorRate : 0;
    if(total < 5) return;
    if(rate >= 0.25) alerts.push({ key, sev:'crit', rate, total, title:`${key} — error rate ${(rate*100).toFixed(1)}%`, meta:`${total.toLocaleString()} request(s) observed` });
    else if(rate >= 0.05) alerts.push({ key, sev:'warn', rate, total, title:`${key} — error rate ${(rate*100).toFixed(1)}%`, meta:`${total.toLocaleString()} request(s) observed` });
  });
  return alerts.sort((a,b)=> (a.sev==='crit'?0:1) - (b.sev==='crit'?0:1) || b.rate - a.rate);
}

/* ==================== Analysis window ====================
   The page used to silently mix two incompatible bases: cumulative
   aggregate counters (metrics[key].totalRequests - no time dimension at
   all, they only ever grow since the agent started) and real per-request
   records (which DO carry timestamps). Service health even claimed
   "current time range" while showing all-time counters.

   Everything below is built on one honest rule: if real per-request
   records exist for the current scope, every number on the page is
   recomputed from the records inside the selected window, and a
   period-over-period delta is computed against the immediately preceding
   window of equal length. If they don't (CAPTURE_MODE=aggregate), the
   page falls back to the cumulative aggregates and SAYS SO - the window
   selector is disabled with a note, rather than relabelling all-time
   counters as if they were windowed. */
const OBS_WINDOWS = [
  { key:'1h',  label:'Last hour',     ms: 3600e3 },
  { key:'24h', label:'Last 24 hours', ms: 86400e3 },
  { key:'7d',  label:'Last 7 days',   ms: 7 * 86400e3 },
  { key:'30d', label:'Last 30 days',  ms: 30 * 86400e3 },
  { key:'all', label:'All time',      ms: null },
];

function obsActiveWindow(){
  const key = state.obsWindow || 'all';
  return OBS_WINDOWS.find(w => w.key === key) || OBS_WINDOWS[OBS_WINDOWS.length - 1];
}

function statusFamily(code){
  const c = Number(code) || 0;
  return c ? `${String(c)[0]}xx` : 'unknown';
}

// Everything the page needs, derived from one set of real records.
function statsFromRecords(records){
  const statusBreakdown = {};
  const ipCounts = {};
  let errCount = 0, lastSeenAt = null;
  const latencies = [];
  records.forEach(r=>{
    const fam = statusFamily(r.statusCode);
    statusBreakdown[fam] = (statusBreakdown[fam] || 0) + 1;
    if(fam === '4xx' || fam === '5xx') errCount++;
    if(r.clientIp) ipCounts[r.clientIp] = (ipCounts[r.clientIp] || 0) + 1;
    if(r.ts && (!lastSeenAt || r.ts > lastSeenAt)) lastSeenAt = r.ts;
    if(typeof r.latencyMs === 'number') latencies.push(r.latencyMs);
  });
  latencies.sort((a,b)=>a-b);
  const topIps = Object.entries(ipCounts).map(([ip,count])=>({ip,count})).sort((a,b)=>b.count-a.count).slice(0,10);
  return {
    total: records.length,
    errCount,
    errorRate: records.length ? errCount / records.length : 0,
    statusBreakdown,
    topIps,
    lastSeenAt,
    endpointCount: new Set(records.map(r=>r.key)).size,
    latency: latencies.length
      ? { p50: percentile(latencies, 0.50), p95: percentile(latencies, 0.95), p99: percentile(latencies, 0.99), count: latencies.length }
      : null,
  };
}

function recordsInWindow(records, win, now){
  if(!win.ms) return records;
  return records.filter(r=>{
    const t = new Date(r.ts).getTime();
    return !isNaN(t) && (now - t) <= win.ms;
  });
}

// The previous window of equal length, immediately before the current one -
// what the KPI deltas compare against.
function recordsInPreviousWindow(records, win, now){
  if(!win.ms) return [];
  return records.filter(r=>{
    const t = new Date(r.ts).getTime();
    if(isNaN(t)) return false;
    const age = now - t;
    return age > win.ms && age <= win.ms * 2;
  });
}

function obsComputeStats(keys, metrics, allRecords, win){
  const scoped = (allRecords || []).filter(r => keys.includes(r.key));

  // "All time" ALWAYS uses the aggregate counters, even when records exist.
  // logRecords is a capped ring buffer (MAX_LOG_RECORDS_TOTAL /
  // MAX_LOG_RECORDS_PER_ENDPOINT in mule_doc_agent.py) - oldest dropped
  // first - so it is deliberately NOT a complete history. Totalling it
  // would undercount any endpoint busy enough to have rolled its buffer,
  // and would drop endpoints with no records at all. The aggregate
  // counters are the only complete source, so they own the all-time view.
  // Records still supply latency, which aggregates can't express.
  if(!win.ms || !scoped.length){
    const agg = aggregateKeys(keys, metrics);
    agg.source = 'aggregate';
    agg.latency = scoped.length ? statsFromRecords(scoped).latency : null;
    agg.prev = null;
    agg.records = scoped;
    agg.canWindow = scoped.length > 0;
    return agg;
  }

  // A bounded window can only be answered by records - aggregates have no
  // time dimension at all. This covers just the endpoints that have
  // records, which the UI marks per row rather than hiding.
  const now = Date.now();
  const cur = recordsInWindow(scoped, win, now);
  const prevRecords = recordsInPreviousWindow(scoped, win, now);
  const stats = statsFromRecords(cur);
  stats.source = 'records';
  stats.records = cur;
  stats.prev = prevRecords.length ? statsFromRecords(prevRecords) : null;
  stats.canWindow = true;
  return stats;
}

// Period-over-period change badge. `mode` decides how the change reads:
// 'pp' for rates (percentage POINTS, so 4% -> 6% is "+2.0pp", not "+50%"),
// 'pct' for counts/latency. `goodDirection` flips the colour so a drop in
// error rate is green and a drop in traffic is merely neutral-informative.
function deltaBadge(curr, prev, mode, goodDirection){
  if(prev === null || prev === undefined || !isFinite(prev)) return '';
  let diff, text;
  if(mode === 'pp'){
    diff = (curr - prev) * 100;
    if(Math.abs(diff) < 0.05) return `<span class="obs-delta flat">no change</span>`;
    text = `${diff > 0 ? '+' : ''}${diff.toFixed(1)}pp`;
  } else {
    if(prev === 0) return '';
    diff = ((curr - prev) / prev) * 100;
    if(Math.abs(diff) < 0.5) return `<span class="obs-delta flat">no change</span>`;
    text = `${diff > 0 ? '+' : ''}${diff.toFixed(0)}%`;
  }
  let tone = 'flat';
  if(goodDirection === 'down') tone = diff > 0 ? 'bad' : 'good';
  else if(goodDirection === 'up') tone = diff > 0 ? 'good' : 'bad';
  return `<span class="obs-delta ${tone}">${diff > 0 ? '▲' : '▼'} ${text}</span>`;
}

// Alerts computed on whichever basis the page is actually showing, so a
// windowed view doesn't raise an alert from traffic outside the window.
function computeAlertsFromRecords(records){
  const byKey = new Map();
  records.forEach(r=>{
    if(!byKey.has(r.key)) byKey.set(r.key, { total:0, err:0 });
    const e = byKey.get(r.key);
    e.total++;
    const fam = statusFamily(r.statusCode);
    if(fam === '4xx' || fam === '5xx') e.err++;
  });
  const alerts = [];
  byKey.forEach((v, key)=>{
    if(v.total < 5) return;
    const rate = v.err / v.total;
    if(rate >= 0.25) alerts.push({ key, sev:'crit', rate, total:v.total, title:`${key} — error rate ${(rate*100).toFixed(1)}%`, meta:`${v.total.toLocaleString()} request(s) in window` });
    else if(rate >= 0.05) alerts.push({ key, sev:'warn', rate, total:v.total, title:`${key} — error rate ${(rate*100).toFixed(1)}%`, meta:`${v.total.toLocaleString()} request(s) in window` });
  });
  return alerts.sort((a,b)=> (a.sev==='crit'?0:1) - (b.sev==='crit'?0:1) || b.rate - a.rate);
}

// How much wall-clock time the retained records actually span. Used to tell
// the difference between "this window is quiet" and "this window is longer
// than anything the agent still holds".
function obsRetainedSpanMs(records){
  if(!records || records.length < 2) return null;
  let min = Infinity, max = -Infinity;
  for(const r of records){
    const t = new Date(r.ts).getTime();
    if(!Number.isFinite(t)) continue;
    if(t < min) min = t;
    if(t > max) max = t;
  }
  if(!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null;
  return max - min;
}

function renderWindowSelector(stats){
  const active = obsActiveWindow();
  const locked = !stats.canWindow;
  const pills = OBS_WINDOWS.map(w=>`
    <button type="button" class="obs-win-pill${w.key===active.key?' active':''}" data-obs-window="${w.key}"${locked && w.key!=='all' ? ' disabled' : ''} title="${locked && w.key!=='all' ? 'Needs per-request records (CAPTURE_MODE=full) to filter by time' : escapeHtml(w.label)}">${escapeHtml(w.label)}</button>
  `).join('');
  let note;
  let truncationWarning = '';
  if(locked){
    note = 'Cumulative totals since the agent started — time filtering needs per-request records (CAPTURE_MODE=full)';
  } else if(stats.source === 'aggregate'){
    note = 'Complete cumulative totals from the agent’s counters — pick a window above to analyse recent per-request records instead';
  } else {
    note = `Computed from ${stats.total.toLocaleString()} per-request record(s) in this window — covers endpoints that have records, as far back as the agent retains them`;

    // logRecords is a CAPPED ring buffer. On a busy deployment it can hold
    // far less than the selected window - 3,000 records at 800 req/sec is
    // under four seconds - and without this the page would answer "Last 24
    // hours" from a few seconds of data, confidently and wrongly. Compare
    // the window against the span actually retained and say so.
    const span = obsRetainedSpanMs(stats.records);
    if(active.ms && span !== null && span < active.ms * 0.9){
      truncationWarning = `Only the last ${formatDuration(Math.round(span / 1000))} of records are retained (the agent keeps a capped ring buffer), so this is <strong>${escapeHtml(active.label.toLowerCase())}</strong> in name only — it covers that shorter span. Use All time for complete totals, or reduce traffic per agent / raise MAX_LOG_RECORDS_TOTAL for a longer window.`;
    }
  }
  return `<div class="obs-window-bar">
    <div class="obs-win-pills">${pills}</div>
    <span class="obs-win-note">${note}</span>
    ${truncationWarning ? `<div class="obs-win-truncated">${truncationWarning}</div>` : ''}
  </div>`;
}

function renderStatusBreakdown(breakdown, total){
  const fams = ['2xx','3xx','4xx','5xx'];
  const colorFor = { '2xx':'var(--st-2)', '3xx':'var(--st-3)', '4xx':'var(--st-4)', '5xx':'var(--st-5)' };
  const counts = fams.map(f => breakdown[f] || 0);
  // `total` (requests overall) can run ahead of the classified counts below -
  // some requests never got a status code logged (dropped connection, agent
  // sampling gap, etc). The subtitle and bar use the classified sum so they
  // always foot to 100%, instead of silently implying an unaccounted gap is
  // "0%" of something bigger.
  const classifiedTotal = counts.reduce((a,b)=>a+b, 0);
  const t = classifiedTotal || 1;
  const unclassified = Math.max(0, (total || 0) - classifiedTotal);
  const present = fams.filter((f,i)=>counts[i] > 0);

  // Same single-stacked-bar-plus-legend language as Log level distribution
  // (renderLogVolumeAndLevelsSection) - one continuous bar segmented by
  // share of the classified total, with a legend chip per family below it.
  return `<div class="obs-panel obs-panel-fill">
    <div class="section-title">Status code breakdown</div>
    <div class="hint" style="margin-top:-4px;">${classifiedTotal>0 ? classifiedTotal.toLocaleString()+' response(s) over the sampled range' + (unclassified>0 ? ` · ${unclassified.toLocaleString()} without a recorded status code` : '') : 'Responses observed by the agent, sampled once per push'}</div>
    <div class="obs-statusbreakdown-body">
      <div class="obs-statusbar">${present.map(f=>`<span style="width:${((breakdown[f]||0)/t*100)}%;background:${colorFor[f]};"></span>`).join('')}</div>
      <div class="obs-status-legend">${fams.map(f=>`<span class="k"><i style="background:${colorFor[f]};"></i>${f} ${(breakdown[f]||0).toLocaleString()}</span>`).join('')}</div>
    </div>
  </div>`;
}

const OBS_HEALTH_PAGE_SIZE = 8;

// Per-project ranked-by-error-rate list, org-wide - only shown at "All
// traffic" scope (once you've scoped into one project/endpoint, its own
// stats are already the KPI row above, this list would be redundant).
function renderServiceHealth(groups, metrics, allRecords, win){
  const rows = groups.map(g=>({
    id: g.id,
    name: g.name,
    agg: obsComputeStats(g.keys, metrics, allRecords, win),
  })).filter(r => r.agg.total > 0)
     .sort((a,b)=> b.agg.errorRate - a.agg.errorRate || b.agg.total - a.agg.total);

  if(!state.obsHealthPage) state.obsHealthPage = 1;
  const totalPages = Math.max(1, Math.ceil(rows.length / OBS_HEALTH_PAGE_SIZE));
  if(state.obsHealthPage > totalPages) state.obsHealthPage = totalPages;
  if(state.obsHealthPage < 1) state.obsHealthPage = 1;
  const pageStart = (state.obsHealthPage - 1) * OBS_HEALTH_PAGE_SIZE;
  const pageRows = rows.slice(pageStart, pageStart + OBS_HEALTH_PAGE_SIZE);

  // A project with no per-request records falls back to its cumulative
  // aggregate, so in a mixed workspace one row can be windowed and the next
  // all-time. That's worth showing rather than hiding - the marker says
  // which rows the window didn't apply to.
  const anyWindowed = rows.some(r => r.agg.source === 'records');
  const body = pageRows.length ? pageRows.map(r=>{
    const dot = r.agg.errorRate>=0.25 ? 'var(--delete)' : r.agg.errorRate>=0.05 ? 'var(--put)' : 'var(--post)';
    const p95 = r.agg.latency ? ` · p95 ${r.agg.latency.p95}ms` : '';
    const basisTag = (anyWindowed && r.agg.source !== 'records')
      ? ` <span class="obs-basis-tag" title="No per-request records for this API — showing its cumulative total, not the selected window">all-time</span>`
      : '';
    return `<div class="obs-health-row" data-obs-jump-proj="${r.id}">
      <span class="obs-health-dot" style="background:${dot};"></span>
      <span class="obs-health-name">${escapeHtml(r.name)}${basisTag}</span>
      <span class="obs-health-meta">${(r.agg.errorRate*100).toFixed(1)}% err · ${r.agg.total.toLocaleString()} req${p95} · ${r.agg.endpointCount} endpoint(s)</span>
    </div>`;
  }).join('') : `<div class="empty-field" style="padding:6px 0;">No traffic in the selected window.</div>`;

  // A fixed page size (rather than letting this list grow to however many
  // APIs have traffic) is also what keeps this panel from towering over its
  // "Status code breakdown" neighbour in the grid2 row it shares - see
  // .grid2-top for the other half of that fix.
  const pagerHtml = rows.length > OBS_HEALTH_PAGE_SIZE ? `
    <div class="obs-health-pager">
      <span class="obs-health-pager-label">${pageStart+1}–${Math.min(pageStart+OBS_HEALTH_PAGE_SIZE, rows.length)} of ${rows.length}</span>
      <button type="button" class="icon-btn" id="obsHealthPagePrev" ${state.obsHealthPage<=1?'disabled':''} title="Previous page">‹</button>
      <span class="obs-health-pager-page">Page ${state.obsHealthPage} of ${totalPages}</span>
      <button type="button" class="icon-btn" id="obsHealthPageNext" ${state.obsHealthPage>=totalPages?'disabled':''} title="Next page">›</button>
    </div>` : '';

  const basis = (allRecords && allRecords.length) ? obsActiveWindow().label.toLowerCase() : 'all time (cumulative)';
  return `<div class="obs-panel">
    <div class="section-title">Service health — API status</div>
    <div class="hint" style="margin-top:-4px;">Ranked by error rate, ${escapeHtml(basis)} — click to drill in</div>
    ${body}
    ${pagerHtml}
  </div>`;
}

function renderAlertsSection(alerts){
  const rows = alerts.length ? alerts.map(a=>`
    <div class="obs-alert-row" data-obs-alert-key="${escapeHtml(a.key)}">
      <span class="obs-sev-bar ${a.sev}"></span>
      <div><div class="obs-alert-title">${escapeHtml(a.title)}</div><div class="obs-alert-meta">${escapeHtml(a.meta)}</div></div>
    </div>`).join('') : `<div class="empty-field" style="padding:6px 0;">No endpoints above the error-rate threshold right now.</div>`;
  return `<div class="obs-panel">
    <div class="section-title">Alerts</div>
    <div class="hint" style="margin-top:-4px;">Endpoints with ≥5 observed requests and an error rate of 5% (warn) or 25% (critical) or higher — the same threshold ops/sit-doc-agent's own anomaly notes use.</div>
    ${rows}
  </div>`;
}

/* ---- Real per-request panels (CAPTURE_MODE=full only) ---- */

function percentile(sortedNums, p){
  if(!sortedNums.length) return null;
  const idx = Math.min(sortedNums.length - 1, Math.floor(p * sortedNums.length));
  return sortedNums[idx];
}

function fieldKvHtml(fields){
  if(!fields || !Object.keys(fields).length) return '<div class="empty-field">None observed.</div>';
  return Object.entries(fields).map(([k,v])=>{
    const isRedacted = typeof v === 'string' && v.startsWith('[redacted');
    return `<div class="obs-field-kv"><span class="k mono">${escapeHtml(k)}</span><span class="v mono${isRedacted?' redacted':''}">${v===null?'<span class="empty-field">null</span>':escapeHtml(String(v))}</span></div>`;
  }).join('');
}

const OBS_LOG_PAGE_SIZE = 50;

// datetime-local inputs want/give "YYYY-MM-DDTHH:mm" in the viewer's own
// local time (no timezone suffix) - these two convert to/from that, kept
// next to the explorer function since nothing else in this file needs them.
function toDatetimeLocalValue(ts){
  const d = new Date(ts);
  if(isNaN(d.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromDatetimeLocalValue(str){
  if(!str) return null;
  const ms = new Date(str).getTime();
  return isNaN(ms) ? null : ms;
}

/* ---- Log explorer query language ----
   `field:value` terms AND together, bare words are free-text across every
   searchable field. Supported fields mirror what a record actually carries
   (there's no message field in this log format - see renderClusteringSection),
   so the syntax can't promise something the data can't answer:
     status:500   status:5xx   method:POST   path:/orders
     ip:192.0.2   trace:abc123  flow:my-flow  level:error|warn|ok
   Unknown field names fall back to free-text rather than erroring, the same
   forgiving behaviour the rest of the app's filters use. */
const OBS_QUERY_FIELDS = ['status','method','path','ip','trace','flow','level'];

// The full filtered set from the last log-explorer render (every match, not
// just the visible page) - what "Export CSV" writes out. Kept here rather
// than re-deriving it in the click handler so the file can never disagree
// with what the table was showing.
let obsLastFilteredRecords = [];

function parseLogQuery(raw){
  const terms = [];
  const free = [];
  (raw || '').split(/\s+/).filter(Boolean).forEach(tok=>{
    const idx = tok.indexOf(':');
    if(idx > 0){
      const field = tok.slice(0, idx).toLowerCase();
      const value = tok.slice(idx + 1).toLowerCase();
      if(value && OBS_QUERY_FIELDS.includes(field)){ terms.push({ field, value }); return; }
    }
    free.push(tok.toLowerCase());
  });
  return { terms, free };
}

function recordMatchesQuery(r, query){
  const haystack = `${r.method||''} ${r.path||''} ${r.clientIp||''} ${r.correlationId||''} ${r.flowName||''} ${r.statusCode||''}`.toLowerCase();
  for(const word of query.free){
    if(!haystack.includes(word)) return false;
  }
  for(const { field, value } of query.terms){
    let hay;
    switch(field){
      case 'status': {
        const code = String(r.statusCode || '');
        // status:5xx matches a whole family, status:500 an exact code.
        if(/^\dxx$/.test(value)){ if(statusFamily(r.statusCode) !== value) return false; continue; }
        hay = code; break;
      }
      case 'method': hay = String(r.method || ''); break;
      case 'path':   hay = String(r.path || ''); break;
      case 'ip':     hay = String(r.clientIp || ''); break;
      case 'trace':  hay = String(r.correlationId || ''); break;
      case 'flow':   hay = String(r.flowName || ''); break;
      case 'level': {
        const lvlName = r._lvl === 'err' ? 'error' : r._lvl === 'warn' ? 'warn' : 'ok';
        if(lvlName !== value) return false;
        continue;
      }
      default: hay = haystack;
    }
    if(!hay.toLowerCase().includes(value)) return false;
  }
  return true;
}

// CSV of exactly what's currently filtered in (not just the visible page) -
// the usual reason to want this is attaching evidence to a ticket.
function exportLogRecordsCsv(records){
  const cols = ['ts','method','path','statusCode','latencyMs','clientIp','correlationId','flowName'];
  const esc = (v)=>{
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
  };
  const lines = [cols.join(',')].concat(records.map(r => cols.map(c => esc(r[c])).join(',')));
  const blob = new Blob([lines.join('\n')], { type:'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `observability-logs-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast(`Exported ${records.length.toLocaleString()} record(s) to CSV`);
}

function renderLogExplorerSection(records){
  if(!records.length){
    return `<div class="obs-panel">
      <div class="section-title">Log explorer</div>
      <div class="hint" style="margin-top:-4px;">Real per-request records aren't available yet. This requires the agent running with <code>CAPTURE_MODE=full</code> (opt-in - captures real field values, with credential-named fields always redacted; see the "Capture mode" section of AGENT_README.md before turning it on). In the default aggregate mode, this section stays empty by design - nothing here is sample data.</div>
    </div>`;
  }

  if(!state.obsLogExplorer) state.obsLogExplorer = { from:'', to:'', page:1, level:'all', q:'' };
  const ex = state.obsLogExplorer;
  const fromMs = fromDatetimeLocalValue(ex.from);
  const toMs = fromDatetimeLocalValue(ex.to);
  const q = (ex.q || '').trim().toLowerCase();

  // Level here is derived from the real HTTP status code (500+/400+/else),
  // not a captured raw log-level tag - individual per-request records don't
  // carry one (see mule_doc_agent.py's classify_log_level(), which tallies
  // levels per LINE for the Log volume panel, never tied back to a specific
  // request). Deriving from status is the honest per-request equivalent.
  const withLevel = records.map(r=>{
    const sc = r.statusCode || 0;
    const lvl = sc >= 500 ? 'err' : sc >= 400 ? 'warn' : 'ok';
    return Object.assign({ _lvl: lvl }, r);
  });

  const sorted = withLevel.sort((a,b)=> new Date(b.ts) - new Date(a.ts));
  const query = parseLogQuery(q);
  const filtered = sorted.filter(r=>{
    const t = new Date(r.ts).getTime();
    if(fromMs !== null && t < fromMs) return false;
    if(toMs !== null && t > toMs) return false;
    if(ex.level !== 'all' && r._lvl !== ex.level) return false;
    return recordMatchesQuery(r, query);
  });

  obsLastFilteredRecords = filtered;

  const totalPages = Math.max(1, Math.ceil(filtered.length / OBS_LOG_PAGE_SIZE));
  if(ex.page > totalPages) ex.page = totalPages;
  if(ex.page < 1) ex.page = 1;
  const startIdx = (ex.page - 1) * OBS_LOG_PAGE_SIZE;
  const pageRows = filtered.slice(startIdx, startIdx + OBS_LOG_PAGE_SIZE);

  const rows = pageRows.map((r, i)=>{
    const lvl = r._lvl;
    const lvlLabel = lvl === 'err' ? 'ERROR' : lvl === 'warn' ? 'WARN' : 'OK';
    const hasFields = (r.requestFields && Object.keys(r.requestFields).length) || (r.responseFields && Object.keys(r.responseFields).length);
    const ipCls = classifyIp(r.clientIp);
    const ipColor = ipCls === 'internal' ? 'var(--accent)' : 'var(--put)';
    return `<tr class="obs-log-row" data-obs-log-toggle="obsLogFields${i}">
        <td class="mono" style="font-size:10.5px;color:var(--text-faint);">${formatDateTime(r.ts)}</td>
        <td><span class="obs-lvl-pill ${lvl}">${lvlLabel}</span></td>
        <td><span class="badge" style="font-size:9px;padding:1.5px 5px;">${escapeHtml(r.method||'')}</span></td>
        <td class="mono" style="font-size:11px;">${escapeHtml(r.path||'')}</td>
        <td class="mono">${r.statusCode || '—'}</td>
        <td class="mono">${typeof r.latencyMs === 'number' ? r.latencyMs + 'ms' : '—'}</td>
        <td class="mono" style="font-size:10.5px;"><span style="display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:5px;background:${ipColor};"></span>${escapeHtml(r.clientIp||'—')}</td>
        <td class="mono" style="font-size:10.5px;color:var(--text-faint);">${escapeHtml(r.flowName||'—')}</td>
        <td class="mono" style="font-size:10px;">${r.correlationId
          ? `<button type="button" class="obs-trace-link" data-obs-trace="${escapeHtml(r.correlationId)}" title="Show every record sharing this trace id">${escapeHtml(r.correlationId)}</button>`
          : '<span class="empty-field">—</span>'}</td>
        <td>${hasFields ? '<span style="color:var(--accent);">View fields</span>' : '<span class="empty-field">—</span>'}</td>
      </tr>
      <tr class="obs-log-fields" id="obsLogFields${i}"><td colspan="10">
        <div class="obs-log-fields-inner">
          <div style="font-weight:700;font-size:11px;margin-bottom:6px;">Request fields</div>
          ${fieldKvHtml(r.requestFields)}
          <div style="font-weight:700;font-size:11px;margin:10px 0 6px;">Response fields</div>
          ${fieldKvHtml(r.responseFields)}
        </div>
      </td></tr>`;
  }).join('');

  const filtersActive = fromMs !== null || toMs !== null || ex.level !== 'all' || !!q;
  const rangeNote = filtersActive ? ' matching the current filters' : '';
  const rangeSummary = filtered.length
    ? `${(startIdx+1).toLocaleString()}–${(startIdx+pageRows.length).toLocaleString()} of ${filtered.length.toLocaleString()}${rangeNote}`
    : `0 matching record(s)${rangeNote}`;
  // sorted[0] is the newest record (see the sort above), sorted[last] the
  // oldest - used as the pickers' min/max so the range they offer matches
  // what's actually available instead of an unbounded native picker.
  const oldestVal = toDatetimeLocalValue(sorted[sorted.length-1].ts);
  const newestVal = toDatetimeLocalValue(sorted[0].ts);

  return `<div class="obs-panel">
    <div class="section-title">Log explorer</div>
    <div class="hint" style="margin-top:-4px;">Real per-request records, most recent first — click a row to view its captured fields. Any field named like a credential is always shown redacted, enforced by the agent before this ever reaches DocTracker.</div>
    <div class="obs-log-filters">
      <label>Level
        <select id="obsLogLevel">
          <option value="all"${ex.level==='all'?' selected':''}>All</option>
          <option value="ok"${ex.level==='ok'?' selected':''}>OK</option>
          <option value="warn"${ex.level==='warn'?' selected':''}>WARN</option>
          <option value="err"${ex.level==='err'?' selected':''}>ERROR</option>
        </select>
      </label>
      <label style="flex:1;min-width:230px;">Query<input type="text" id="obsLogSearch" value="${escapeHtml(ex.q)}" placeholder="status:5xx  path:/orders  ip:192.0.2  trace:…  or free text"></label>
      <label>From<input type="datetime-local" id="obsLogFrom" value="${escapeHtml(ex.from)}" min="${oldestVal}" max="${newestVal}"></label>
      <label>To<input type="datetime-local" id="obsLogTo" value="${escapeHtml(ex.to)}" min="${oldestVal}" max="${newestVal}"></label>
      ${filtersActive ? `<button type="button" class="obs-log-btn" id="obsLogClearRange" style="align-self:flex-end;">Clear filters</button>` : ''}
      <button type="button" class="obs-log-btn" id="obsLogExportCsv" style="align-self:flex-end;" ${filtered.length?'':'disabled'} title="Download every record matching the current filters (not just this page)">Export CSV</button>
    </div>
    <div class="table-scroll"><table class="data-table cc-proj-table">
      <thead><tr><th>Time</th><th>Level</th><th>Method</th><th>Path</th><th>Status</th><th>Latency</th><th>Source IP</th><th>Flow</th><th>Trace</th><th>Fields</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="10"><div class="empty-field" style="padding:10px 0;">No records${rangeNote}.</div></td></tr>`}</tbody>
    </table></div>
    <div class="obs-log-pagination">
      <span>Showing ${rangeSummary}</span>
      <div class="obs-log-page-controls">
        <button type="button" class="obs-log-btn" id="obsLogPrevPage" ${ex.page<=1?'disabled':''}>← Prev</button>
        <span>Page ${ex.page} of ${totalPages}</span>
        <button type="button" class="obs-log-btn" id="obsLogNextPage" ${ex.page>=totalPages?'disabled':''}>Next →</button>
      </div>
    </div>
  </div>`;
}

// Real clustering by (method, path, status, flow) signature - never by
// fabricated message text, since the log format this agent parses has no
// free-text "message" field to cluster on (see mule_doc_agent.py's real,
// confirmed JSON schema).
function renderClusteringSection(records){
  if(!records.length) return '';
  const errRecords = records.filter(r => (r.statusCode||0) >= 400);
  if(!errRecords.length){
    return `<div class="obs-panel"><div class="section-title">Error clustering</div><div class="empty-field" style="padding:6px 0;">No 4xx/5xx records in the current scope.</div></div>`;
  }
  const map = new Map();
  errRecords.forEach(r=>{
    const sig = `${r.method} ${r.path} → ${r.statusCode}${r.flowName ? ' (' + r.flowName + ')' : ''}`;
    if(!map.has(sig)) map.set(sig, { count:0, last:r.ts });
    const e = map.get(sig);
    e.count++;
    if(r.ts > e.last) e.last = r.ts;
  });
  const list = Array.from(map.entries()).sort((a,b)=>b[1].count-a[1].count).slice(0,8);
  const rows = list.map(([sig, d])=>`
    <div class="obs-cluster-row">
      <div><div>${escapeHtml(sig)}</div><div class="obs-cluster-meta">last seen ${formatDateTime(d.last)}</div></div>
      <span class="obs-cluster-count">${d.count.toLocaleString()}</span>
    </div>`).join('');
  return `<div class="obs-panel">
    <div class="section-title">Error clustering</div>
    <div class="hint" style="margin-top:-4px;">4xx/5xx records grouped by method + path + status + flow (real values, not a fabricated message)</div>
    ${rows}
  </div>`;
}

function obsScopeInfo(scope, metrics){
  if(scope.type === 'project'){
    return { title: scope.name, sub: `${scope.keys.length} endpoint(s) in traffic` };
  }
  if(scope.type === 'key'){
    const found = findDocumentedEndpointForMetricsKey(scope.key);
    return { title: scope.key, sub: found ? `Documented in ${found.proj.name}` : 'Not yet documented', badge: scope.key.split(' ')[0] };
  }
  return { title:'All traffic', sub: `${Object.keys(metrics).filter(k=>k!==OBS_OVERFLOW_KEY).length} endpoint(s) tracked` };
}

// Changes the current drill-down scope and re-renders BOTH the sidebar
// (so the active row/expansion state stays in sync) and the main content -
// the single entry point every scope-changing control in this page goes
// through, whether the control lives in the sidebar tree or here in the
// content (Service health row, an alert, "Clear scope").
function obsSetScope(scope, openProjectId){
  state.obsScope = scope;
  if(openProjectId){
    state.obsOpenProjects = state.obsOpenProjects || {};
    state.obsOpenProjects[openProjectId] = true;
  }
  renderSidebar();
  renderMain();
}

function renderConsole(main, metrics, agentHealth, logRecords){
  if(!state.obsScope) state.obsScope = { type:'all' };

  const groups = groupMetricsByProject(metrics);

  let scopedKeys;
  if(state.obsScope.type === 'project'){
    const g = groups.find(g => g.id === state.obsScope.id);
    scopedKeys = g ? g.keys : [];
    state.obsScope.keys = scopedKeys; // used by obsScopeInfo()
  } else if(state.obsScope.type === 'key'){
    scopedKeys = metrics[state.obsScope.key] ? [state.obsScope.key] : [];
  } else {
    scopedKeys = Object.keys(metrics);
  }

  const win = obsActiveWindow();
  const agg = obsComputeStats(scopedKeys, metrics, logRecords, win);
  const alerts = agg.source === 'records'
    ? computeAlertsFromRecords(agg.records)
    : computeConsoleAlerts(metrics).filter(a => scopedKeys.includes(a.key));
  const info = obsScopeInfo(state.obsScope, metrics);
  const scopedRecords = agg.records;
  const latency = agg.latency;
  const prev = agg.prev;

  main.innerHTML = `
    <div class="crumb">Observability / Console${state.obsScope.type!=='all' ? ' / ' + escapeHtml(info.title) : ''}</div>
    <div class="section-head" style="margin-bottom:14px;">
      <div>
        <div style="font-size:18px;font-weight:800;letter-spacing:-.2px;">${escapeHtml(info.title)}</div>
        <div class="hint" style="margin:2px 0 0;">${escapeHtml(info.sub)}</div>
      </div>
      ${state.obsScope.type!=='all' ? `<button type="button" class="obs-ip-more" id="obsClearScope">Clear scope</button>` : ''}
    </div>

    ${renderWindowSelector(agg)}

    <div class="kpi-grid">
      ${healthKpi('Requests', agg.total.toLocaleString(),
        `${agg.endpointCount} endpoint(s)${prev ? ' · ' + deltaBadge(agg.total, prev.total, 'pct', 'neutral') : ''}`)}
      ${healthKpi('Error rate', (agg.errorRate*100).toFixed(1)+'%',
        `${agg.errCount.toLocaleString()} error(s)${prev ? ' · ' + deltaBadge(agg.errorRate, prev.errorRate, 'pp', 'down') : ''}`,
        agg.errorRate>=0.25?'--delete':agg.errorRate>=0.05?'--put':'--post')}
      ${healthKpi('Alerts', String(alerts.length), alerts.filter(a=>a.sev==='crit').length + ' critical', alerts.length ? (alerts.some(a=>a.sev==='crit')?'--delete':'--put') : '--post')}
      ${latency ? healthKpi('Latency p95', latency.p95 + 'ms',
        `p50 ${latency.p50}ms · p99 ${latency.p99}ms${prev && prev.latency ? ' · ' + deltaBadge(latency.p95, prev.latency.p95, 'pct', 'down') : ''}`)
        : healthKpi('Latency p95', '—', 'Needs per-request records')}
      ${healthKpi('Distinct source IPs', String(agg.topIps.length) + (agg.topIps.length>=10?'+':''), 'top 10 shown below')}
      ${healthKpi('Last seen', agg.lastSeenAt ? formatDateTime(agg.lastSeenAt) : '—', '')}
    </div>

    ${renderHostHealthSection(agentHealth)}

    ${state.obsScope.type === 'all' ? renderServiceHealth(groups, metrics, logRecords, win) : ''}

    <div class="grid2">
      ${renderStatusBreakdown(agg.statusBreakdown, agg.total)}
      <div class="obs-panel"><div class="section-title">Top source IPs</div><div class="hint" style="margin-top:-4px;">Current scope, ranked by request count</div>${renderIpBreakdown(agg.topIps, agg.total, 'console')}</div>
    </div>

    ${(()=>{
      // Alerts and error clustering are both "what's going wrong" - paired
      // when both have something to show, full-width when clustering is
      // empty (aggregate mode) so Alerts isn't left at half width beside
      // dead space.
      const clustering = renderClusteringSection(scopedRecords);
      return clustering
        ? `<div class="grid2">${renderAlertsSection(alerts)}${clustering}</div>`
        : renderAlertsSection(alerts);
    })()}

    ${renderLogVolumeAndLevelsSection(agentHealth)}

    ${renderLogExplorerSection(scopedRecords)}

    ${renderEndpointsTable(scopedKeys, metrics, scopedRecords, agg.source)}

    ${renderAgentHealth(agentHealth)}
  `;

  main.querySelectorAll('[data-obs-window]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      state.obsWindow = btn.getAttribute('data-obs-window');
      if(state.obsLogExplorer) state.obsLogExplorer.page = 1;
      // Sidebar too - its per-project dots are computed over the same
      // window (see renderObservabilitySidebar).
      renderSidebar();
      renderMain();
    });
  });

  main.querySelectorAll('[data-obs-log-toggle]').forEach(row=>{
    row.addEventListener('click', ()=>{
      const target = document.getElementById(row.getAttribute('data-obs-log-toggle'));
      if(target) target.classList.toggle('open');
    });
  });

  // Clicking a trace id pivots the explorer to every record sharing it -
  // the closest thing to a distributed-trace view this data supports.
  main.querySelectorAll('[data-obs-trace]').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      e.stopPropagation();
      state.obsLogExplorer = state.obsLogExplorer || { from:'', to:'', page:1, level:'all', q:'' };
      state.obsLogExplorer.q = `trace:${btn.getAttribute('data-obs-trace')}`;
      state.obsLogExplorer.level = 'all';
      state.obsLogExplorer.page = 1;
      renderMain();
    });
  });

  const logExport = main.querySelector('#obsLogExportCsv');
  if(logExport) logExport.addEventListener('click', ()=> exportLogRecordsCsv(obsLastFilteredRecords));

  const logFrom = main.querySelector('#obsLogFrom');
  const logTo = main.querySelector('#obsLogTo');
  if(logFrom) logFrom.addEventListener('change', ()=>{
    state.obsLogExplorer.from = logFrom.value;
    state.obsLogExplorer.page = 1;
    renderMain();
  });
  if(logTo) logTo.addEventListener('change', ()=>{
    state.obsLogExplorer.to = logTo.value;
    state.obsLogExplorer.page = 1;
    renderMain();
  });
  const logLevel = main.querySelector('#obsLogLevel');
  if(logLevel) logLevel.addEventListener('change', ()=>{
    state.obsLogExplorer.level = logLevel.value;
    state.obsLogExplorer.page = 1;
    renderMain();
  });
  const logSearch = main.querySelector('#obsLogSearch');
  if(logSearch){
    // 'change'/Enter, not 'input' - a per-keystroke re-render would replace
    // this input's own DOM node (it lives inside the innerHTML this
    // function rebuilds) and drop focus after the very first character.
    const applySearch = ()=>{
      state.obsLogExplorer.q = logSearch.value;
      state.obsLogExplorer.page = 1;
      renderMain();
    };
    logSearch.addEventListener('change', applySearch);
    logSearch.addEventListener('keydown', (e)=>{ if(e.key === 'Enter') applySearch(); });
  }
  const logClearRange = main.querySelector('#obsLogClearRange');
  if(logClearRange) logClearRange.addEventListener('click', ()=>{
    state.obsLogExplorer.from = '';
    state.obsLogExplorer.to = '';
    state.obsLogExplorer.level = 'all';
    state.obsLogExplorer.q = '';
    state.obsLogExplorer.page = 1;
    renderMain();
  });
  const logPrev = main.querySelector('#obsLogPrevPage');
  if(logPrev) logPrev.addEventListener('click', ()=>{
    state.obsLogExplorer.page = Math.max(1, state.obsLogExplorer.page - 1);
    renderMain();
  });
  const logNext = main.querySelector('#obsLogNextPage');
  if(logNext) logNext.addEventListener('click', ()=>{
    state.obsLogExplorer.page = state.obsLogExplorer.page + 1;
    renderMain();
  });

  const clearBtn = main.querySelector('#obsClearScope');
  if(clearBtn) clearBtn.addEventListener('click', ()=> obsSetScope({ type:'all' }));
  main.querySelectorAll('[data-obs-alert-key]').forEach(el=>{
    el.addEventListener('click', ()=> obsSetScope({ type:'key', key: el.getAttribute('data-obs-alert-key') }));
  });
  main.querySelectorAll('[data-obs-jump-proj]').forEach(el=>{
    el.addEventListener('click', ()=>{
      const id = el.getAttribute('data-obs-jump-proj');
      const g = groups.find(g => g.id === id);
      if(!g) return;
      obsSetScope({ type:'project', id, name: g.name, keys: g.keys }, id);
    });
  });

  const healthPrev = main.querySelector('#obsHealthPagePrev');
  if(healthPrev) healthPrev.addEventListener('click', ()=>{
    state.obsHealthPage = Math.max(1, (state.obsHealthPage||1) - 1);
    renderMain();
  });
  const healthNext = main.querySelector('#obsHealthPageNext');
  if(healthNext) healthNext.addEventListener('click', ()=>{
    state.obsHealthPage = (state.obsHealthPage||1) + 1;
    renderMain();
  });

  wireEndpointsTable(main);
}

// Renders into the app's OWN left sidebar (#projectList) instead of the
// normal project tree, while state.selected.type === 'observability' - see
// 09-render-sidebar.js's branch at the top of renderSidebar(). This is the
// only scope picker now (no second nested one inside the page content);
// the sidebar's existing #searchBox filters it the same way it filters the
// normal project tree.
function renderObservabilitySidebar(list, filter){
  const { endpoints: metrics, logRecords } = observabilityData();
  if(!state.obsScope) state.obsScope = { type:'all' };
  if(!state.obsOpenProjects) state.obsOpenProjects = {};
  // Same window the Console is showing, so a project's dot here can't say
  // "healthy" while the page next to it reports a red error rate for the
  // same project over the same period.
  const win = obsActiveWindow();

  const groups = groupMetricsByProject(metrics);
  const q = filter.trim().toLowerCase();

  // "All traffic" itself is the pinned "API Control Center" row up top
  // (relabeled by renderSidebar() while on this page) - this tree starts
  // straight at the per-project breakdown instead of repeating it here.
  let html = `<div style="padding:8px;">`;

  const visibleGroups = groups.filter(g=>{
    if(!q) return true;
    return g.name.toLowerCase().includes(q) || g.keys.some(k=>k.toLowerCase().includes(q));
  });
  if(!groups.length){
    html += `<div class="obs-scope-empty">No traffic discovered yet — this fills in once ops/sit-doc-agent has pushed at least one batch.</div>`;
  } else if(!visibleGroups.length){
    html += `<div class="obs-scope-empty">No projects match "${escapeHtml(q)}".</div>`;
  }
  visibleGroups.forEach(g=>{
    const isOpen = state.obsOpenProjects[g.id] || (q && g.keys.length);
    const agg = obsComputeStats(g.keys, metrics, logRecords, win);
    const dotColor = agg.errorRate>=0.25?'var(--delete)':agg.errorRate>=0.05?'var(--put)':'var(--post)';
    const groupActive = state.obsScope.type==='project' && state.obsScope.id===g.id;
    const visKeys = q ? g.keys.filter(k=>k.toLowerCase().includes(q) || g.name.toLowerCase().includes(q)) : g.keys;
    html += `<div class="obs-proj-group${isOpen?' open':''}" data-obs-proj-group="${g.id}">
      <div class="obs-proj-row${groupActive?' active':''}" data-obs-proj="${g.id}">
        <svg class="obs-proj-caret" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5l8 7-8 7z"></path></svg>
        <span class="obs-proj-dot" style="background:${dotColor};"></span>
        <span class="obs-proj-name">${escapeHtml(g.name)}</span>
        <span class="obs-proj-count mono">${g.keys.length}</span>
      </div>
      <div class="obs-ep-list">
        ${visKeys.map(k=>{
          const [method, ...pathParts] = k.split(' ');
          const active = state.obsScope.type==='key' && state.obsScope.key===k;
          return `<div class="obs-scope-ep-row${active?' active':''}" data-obs-key="${escapeHtml(k)}">
            <span class="badge ${methodClass(method)}" style="font-size:8.5px;padding:1.5px 5px;">${escapeHtml(method)}</span>
            <span class="obs-scope-ep-path">${escapeHtml(pathParts.join(' '))}</span>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  });
  html += `</div>`;

  list.innerHTML = html;

  list.querySelectorAll('[data-obs-proj]').forEach(el=>{
    el.addEventListener('click', ()=>{
      const id = el.getAttribute('data-obs-proj');
      const g = groups.find(g => g.id === id);
      if(!g) return;
      state.obsOpenProjects[id] = !state.obsOpenProjects[id];
      obsSetScope({ type:'project', id, name: g.name, keys: g.keys });
    });
  });
  list.querySelectorAll('[data-obs-key]').forEach(el=>{
    el.addEventListener('click', (e)=>{
      e.stopPropagation();
      obsSetScope({ type:'key', key: el.getAttribute('data-obs-key') });
    });
  });
}

/* ==================== Page entry point ==================== */
// One view, not a toggle a viewer has to discover - the drill-down
// dashboard (scope panel, KPIs, service health, status breakdown, source
// IPs, alerts, agent health, and - once the agent's CAPTURE_MODE=full -
// the log explorer/volume chart/clustering) is now the only Observability
// page. Everything on it is still real data from state.endpointMetrics;
// nothing here is sample/placeholder.
function renderObservability(main){
  const { endpoints: metrics, agentHealth, logRecords } = observabilityData();
  const fullCapture = logRecords && logRecords.length > 0;

  // First visit to this page in a session kicks off the time-series load. It
  // resolves into state.obsData and re-renders; until then (and permanently,
  // for an org whose agent predates the rollup push) the original blob-backed
  // console below is what renders. Deliberately not a flag day: the console
  // must never show an empty page just because the backend moved ahead of the
  // collector.
  // Re-checked, not checked once. The first load settles on 'unavailable'
  // for an org whose agent has not started pushing rollups yet - and if that
  // were the end of it, deploying the agent would light nothing up until
  // someone happened to hard-refresh. A console left open through a deploy
  // should notice on its own.
  if(typeof obsLoad === 'function'){
    const stale = state.obsStatus === 'unavailable'
      && (Date.now() - (state.obsLastCheckedAt || 0)) > OBS_AVAILABILITY_RECHECK_MS;
    if(state.obsStatus === 'idle' || stale){
      state.obsLastCheckedAt = Date.now();
      obsLoad({ quiet: state.obsStatus !== 'idle' });
    }
  }

  // `obsForcePreview` lets someone look at the new console before their agent
  // has pushed anything. It exists because the automatic switch is invisible
  // until that happens: there was no way to tell "the new console has not
  // shipped" apart from "the new console is waiting for data", and the page
  // said nothing either way. A preview with honest zeros beats a page that
  // gives you nothing to go on.
  const dataReady = typeof obsDataAvailable === 'function' && obsDataAvailable();

  // No rollups yet is no longer a reason to withhold the rebuilt console: the
  // blob is mapped into the same shape so the new layout renders this org's
  // actual traffic today. The panels the blob can't fill say why. `obsLegacyView`
  // is the way back for anyone who wants the old page.
  let bridged = false;
  if(!dataReady && !state.obsLegacyView){
    const bridge = obsBridgeFromBlob(metrics, logRecords);
    if(bridge){ state.obsData = bridge; bridged = true; }
  }
  const useTimeSeries = !state.obsLegacyView
    && (dataReady || bridged || state.obsForcePreview === true);

  const heroDesc = fullCapture
    ? `Real per-request records, auto-discovered from server logs — never written into documented endpoints. Credential-named fields always redacted.`
    : `Auto-discovered from server logs, never written into documented endpoints. Field values aren't captured in this mode — only counts and structure.`;

  // Shown on the OLD console so nobody has to wonder whether the new one
  // exists, and on the PREVIEW so nobody mistakes empty charts for broken
  // ones.
  let handoffNotice = '';
  if(state.obsLegacyView){
    handoffNotice = `<div class="obs-handoff">
      <div>
        <b>You're on the previous layout.</b>
        The rebuilt console has the same numbers with tabs, click-through filtering and a
        date-range picker.
      </div>
      <button type="button" class="obs-handoff-btn" id="obsNewView">Back to the new console</button>
    </div>`;
  }else if(bridged){
    handoffNotice = `<div class="obs-handoff obs-handoff-bridged">
      <div>
        <b>Showing your real traffic from the current agent.</b>
        These are the same cumulative counters the previous layout showed — totals, error rates,
        status families, source IPs and every endpoint, all exact. Three things need the upgraded
        agent and are labelled wherever they appear: <b>traffic over time</b>, <b>latency
        percentiles</b> and <b>per-request rows</b>. They fill in by themselves within a minute of
        its first push, along with date filtering.
      </div>
      <button type="button" class="obs-handoff-btn" id="obsLegacyOn">Previous layout</button>
    </div>`;
  }else if(!dataReady && !state.obsForcePreview){
    handoffNotice = `<div class="obs-handoff">
      <div>
        <b>A rebuilt console is ready and waiting for data.</b>
        It adds traffic-over-time charts, a date-range picker, tabs and click-through filtering.
        It switches on by itself, within a minute of this environment's agent pushing its first
        rollup — no reload needed. Until then this view stays, because it has your real history and
        the new one would read zero.
      </div>
      <button type="button" class="obs-handoff-btn" id="obsPreviewOn">Preview it now</button>
    </div>`;
  }else if(!dataReady && state.obsForcePreview){
    handoffNotice = `<div class="obs-handoff obs-handoff-preview">
      <div>
        <b>Preview — no data yet.</b>
        Every figure below reads zero because this environment's agent hasn't pushed a rollup.
        This is the layout, not your traffic. Your real numbers are still on the current console.
      </div>
      <button type="button" class="obs-handoff-btn" id="obsPreviewOff">Back to current console</button>
    </div>`;
  }

  main.innerHTML = `
    <div class="obs-header">
      <h1>Observability</h1>
      <p>${heroDesc}</p>
    </div>
    ${handoffNotice}
    ${useTimeSeries && !bridged ? '' : renderObsEnvironmentBar()}
    <div id="obsBody"></div>
  `;

  const previewOn = document.getElementById('obsPreviewOn');
  if(previewOn) previewOn.addEventListener('click', ()=>{
    state.obsForcePreview = true;
    if(state.obsStatus === 'unavailable' && !state.obsData){
      // Nothing was loaded, so give the preview an empty-but-valid shape
      // rather than letting every panel hit undefined.
      state.obsData = {
        range: obsResolvedRange(),
        current: { total:0, errCount:0, errorRate:0,
          statusBreakdown:{'2xx':0,'3xx':0,'4xx':0,'5xx':0,unknown:0},
          topIps:[], endpointCount:0, lastSeenAt:null, latency:null, latencyBuckets:{} },
        previous: null, coverage:{ oldest:null, newest:null, buckets:0 },
        series: [], endpoints: [], loadedAt: Date.now(),
      };
    }
    renderMain();
  });
  const previewOff = document.getElementById('obsPreviewOff');
  if(previewOff) previewOff.addEventListener('click', ()=>{
    state.obsForcePreview = false;
    renderMain();
  });
  const legacyOn = document.getElementById('obsLegacyOn');
  if(legacyOn) legacyOn.addEventListener('click', ()=>{
    state.obsLegacyView = true;
    state.obsForcePreview = false;
    renderMain();
  });
  const newView = document.getElementById('obsNewView');
  if(newView) newView.addEventListener('click', ()=>{
    state.obsLegacyView = false;
    renderMain();
  });

  const body = document.getElementById('obsBody');
  if(useTimeSeries){
    renderObsConsoleV2(body, agentHealth);
    // The stream replaces the 60s poll entirely; stop it so a page that is
    // already live-updating is not also refetching the whole workspace.
    stopObsAutoRefresh();
    obsStartLive(()=> obsLoad({ quiet: true }));
  }else{
    renderConsole(body, metrics, agentHealth, logRecords);
    startObsAutoRefresh();
  }
}
