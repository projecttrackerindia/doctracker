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
function observabilityData(){
  const raw = state.endpointMetrics;
  if(raw && typeof raw === 'object' && raw.endpoints && typeof raw.endpoints === 'object'){
    return {
      endpoints: raw.endpoints,
      agentHealth: (raw.agentHealth && typeof raw.agentHealth === 'object') ? raw.agentHealth : null,
      logRecords: Array.isArray(raw.logRecords) ? raw.logRecords : [],
    };
  }
  return { endpoints: (raw && typeof raw === 'object') ? raw : {}, agentHealth: null, logRecords: [] };
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
  </div>`;
}

// Buckets the agent's logVolumeSamples - [epochSeconds, cumulativeLinesProcessed]
// pairs, one per push (~15 min apart by default) - into a fixed number of
// time buckets by taking the delta between consecutive cumulative samples.
// This is raw LOG LINES read by the agent (always available, both capture
// modes), not real per-request records - a different, always-on source from
// renderVolumeChart() above, which needs CAPTURE_MODE=full.
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
    const bars = bucketed.counts.map((c,i)=>`<div class="obs-vol-bar${i>=bucketed.counts.length-3?' hot':''}" style="height:${Math.max(3, Math.round(c/max*100))}%;" title="${Math.round(c).toLocaleString()} log line(s)"></div>`).join('');
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

// Shared by both views - one row per metrics key. `keys` is whatever subset
// the caller wants shown (all of them for Overview, the current scope's
// subset for Console).
function renderEndpointsTable(keys, metrics){
  const rows = keys.length ? keys.map((key, idx)=>{
    const m = metrics[key] || {};
    const total = m.totalRequests || 0;
    const rate = typeof m.errorRate === 'number' ? m.errorRate : 0;
    const breakdown = m.statusBreakdown || {};
    const breakdownLabel = Object.keys(breakdown).sort().map(fam=>`${fam}: ${breakdown[fam]}`).join(', ') || '—';
    const topIps = Array.isArray(m.topSourceIps) ? m.topSourceIps : [];
    const isOverflow = key === OBS_OVERFLOW_KEY;
    const found = isOverflow ? null : findDocumentedEndpointForMetricsKey(key);
    const [method, ...pathParts] = key.split(' ');
    const path = pathParts.join(' ');
    const linkAttr = found ? ` data-obs-ep="${found.ep.id}"` : '';
    const methodCell = isOverflow
      ? `<span class="badge badge-lg" style="background:var(--put-bg);color:var(--put);">OVERFLOW</span>`
      : `<span class="badge badge-lg ${methodClass(method)}">${escapeHtml(method||'')}</span>`;
    return `<tr class="cc-proj-row"${linkAttr} style="${found?'':'cursor:default;'}">
      <td>${methodCell}</td>
      <td class="mono">${escapeHtml(path)}</td>
      <td class="mono">${total.toLocaleString()}</td>
      <td style="color:${errorRateColor(rate)};font-weight:600;">${(rate*100).toFixed(1)}%</td>
      <td class="mono" style="font-size:11px;color:var(--text-faint);">${escapeHtml(breakdownLabel)}</td>
      <td>${renderIpBreakdown(topIps, total, idx)}</td>
      <td class="mono" style="font-size:10.5px;color:var(--text-faint);">${m.lastSeenAt ? formatDateTime(m.lastSeenAt) : '—'}</td>
      <td>${isOverflow ? '<span class="empty-field">Not an endpoint</span>' : (found ? '<span style="color:var(--post);">Documented</span>' : '<span class="empty-field">Not yet documented</span>')}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="8" class="empty-field" style="padding:16px;">No traffic discovered yet. This fills in once the SIT log auto-discovery agent (ops/sit-doc-agent) has pushed at least one batch — see AGENT_README.md.</td></tr>`;

  return `<div class="obs-panel">
    <div class="section-title">Endpoints${keys.length ? ` (${keys.length})` : ''}</div>
    <div class="table-scroll">
    <table class="data-table cc-proj-table">
      <thead><tr>
        <th>Method</th><th>Path</th><th>Total requests</th><th>Error rate</th>
        <th>Status breakdown</th><th>Source IPs</th><th>Last seen</th><th>Documentation</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    </div>
  </div>`;
}

function wireEndpointsTable(main){
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
      if(!groups.has(found.proj.id)) groups.set(found.proj.id, { id: found.proj.id, name: found.proj.name, keys: [] });
      groups.get(found.proj.id).keys.push(key);
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

function renderStatusBreakdown(breakdown, total){
  const t = total || 1;
  const fams = ['2xx','3xx','4xx','5xx'];
  const colorFor = { '2xx':'var(--st-2)', '3xx':'var(--st-3)', '4xx':'var(--st-4)', '5xx':'var(--st-5)' };
  return `<div class="obs-panel">
    <div class="section-title">Status code breakdown</div>
    <div class="obs-statusbar">${fams.map(f=>`<span style="width:${((breakdown[f]||0)/t*100)}%;background:${colorFor[f]};"></span>`).join('')}</div>
    <div class="obs-status-legend">${fams.map(f=>`<span class="k"><i style="background:${colorFor[f]};"></i>${f} ${(breakdown[f]||0).toLocaleString()}</span>`).join('')}</div>
  </div>`;
}

// Per-project ranked-by-error-rate list, org-wide - only shown at "All
// traffic" scope (once you've scoped into one project/endpoint, its own
// stats are already the KPI row above, this list would be redundant).
function renderServiceHealth(groups, metrics){
  const rows = groups.map(g=>{
    const agg = aggregateKeys(g.keys, metrics);
    return { id: g.id, name: g.name, agg };
  }).sort((a,b)=> b.agg.errorRate - a.agg.errorRate);

  const body = rows.length ? rows.map(r=>{
    const dot = r.agg.errorRate>=0.25 ? 'var(--delete)' : r.agg.errorRate>=0.05 ? 'var(--put)' : 'var(--post)';
    return `<div class="obs-health-row" data-obs-jump-proj="${r.id}">
      <span class="obs-health-dot" style="background:${dot};"></span>
      <span class="obs-health-name">${escapeHtml(r.name)}</span>
      <span class="obs-health-meta">${(r.agg.errorRate*100).toFixed(1)}% err · ${r.agg.total.toLocaleString()} req · ${r.agg.endpointCount} endpoint(s)</span>
    </div>`;
  }).join('') : `<div class="empty-field" style="padding:6px 0;">No traffic discovered yet.</div>`;

  return `<div class="obs-panel">
    <div class="section-title">Service health — API status</div>
    <div class="hint" style="margin-top:-4px;">Sorted by error rate, current time range — click to drill in</div>
    ${body}
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

function computeLatencyStats(records){
  const nums = records.map(r=>r.latencyMs).filter(n=>typeof n === 'number').sort((a,b)=>a-b);
  if(!nums.length) return null;
  return { p50: percentile(nums, 0.50), p95: percentile(nums, 0.95), p99: percentile(nums, 0.99), count: nums.length };
}

function renderVolumeChart(records){
  if(!records.length) return '';
  const buckets = 14;
  const times = records.map(r=>new Date(r.ts).getTime()).filter(t=>!isNaN(t));
  if(!times.length) return '';
  const minTs = Math.min(...times), maxTs = Math.max(...times);
  const span = Math.max(1, maxTs - minTs);
  const bucketMs = span / buckets;
  const counts = new Array(buckets).fill(0);
  times.forEach(t=>{
    let idx = Math.floor((t - minTs) / bucketMs);
    if(idx >= buckets) idx = buckets - 1;
    if(idx < 0) idx = 0;
    counts[idx]++;
  });
  const max = Math.max(...counts, 1);
  const bars = counts.map((c, i)=> `<div class="obs-vol-bar${i>=buckets-3?' hot':''}" style="height:${Math.max(3, Math.round(c/max*100))}%;" title="${c.toLocaleString()} request(s)"></div>`).join('');
  return `<div class="obs-panel">
    <div class="section-title">Request volume</div>
    <div class="hint" style="margin-top:-4px;">${records.length.toLocaleString()} real per-request record(s) in scope, bucketed across the range captured so far</div>
    <div class="obs-vol-chart">${bars}</div>
    <div class="obs-vol-axis"><span>${formatDateTime(new Date(minTs).toISOString())}</span><span>${formatDateTime(new Date(maxTs).toISOString())}</span></div>
  </div>`;
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

function renderLogExplorerSection(records){
  if(!records.length){
    return `<div class="obs-panel">
      <div class="section-title">Log explorer</div>
      <div class="hint" style="margin-top:-4px;">Real per-request records aren't available yet. This requires the agent running with <code>CAPTURE_MODE=full</code> (opt-in - captures real field values, with credential-named fields always redacted; see the "Capture mode" section of AGENT_README.md before turning it on). In the default aggregate mode, this section stays empty by design - nothing here is sample data.</div>
    </div>`;
  }

  if(!state.obsLogExplorer) state.obsLogExplorer = { from:'', to:'', page:1 };
  const ex = state.obsLogExplorer;
  const fromMs = fromDatetimeLocalValue(ex.from);
  const toMs = fromDatetimeLocalValue(ex.to);

  const sorted = records.slice().sort((a,b)=> new Date(b.ts) - new Date(a.ts));
  const filtered = (fromMs === null && toMs === null) ? sorted : sorted.filter(r=>{
    const t = new Date(r.ts).getTime();
    if(fromMs !== null && t < fromMs) return false;
    if(toMs !== null && t > toMs) return false;
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / OBS_LOG_PAGE_SIZE));
  if(ex.page > totalPages) ex.page = totalPages;
  if(ex.page < 1) ex.page = 1;
  const startIdx = (ex.page - 1) * OBS_LOG_PAGE_SIZE;
  const pageRows = filtered.slice(startIdx, startIdx + OBS_LOG_PAGE_SIZE);

  const rows = pageRows.map((r, i)=>{
    const sc = r.statusCode || 0;
    const lvl = sc >= 500 ? 'err' : sc >= 400 ? 'warn' : 'ok';
    const lvlLabel = sc >= 500 ? 'ERROR' : sc >= 400 ? 'WARN' : 'OK';
    const hasFields = (r.requestFields && Object.keys(r.requestFields).length) || (r.responseFields && Object.keys(r.responseFields).length);
    const ipCls = classifyIp(r.clientIp);
    const ipColor = ipCls === 'internal' ? 'var(--accent)' : 'var(--put)';
    return `<tr class="obs-log-row" data-obs-log-toggle="obsLogFields${i}">
        <td class="mono" style="font-size:10.5px;color:var(--text-faint);">${formatDateTime(r.ts)}</td>
        <td><span class="obs-lvl-pill ${lvl}">${lvlLabel}</span></td>
        <td><span class="badge" style="font-size:9px;padding:1.5px 5px;">${escapeHtml(r.method||'')}</span></td>
        <td class="mono" style="font-size:11px;">${escapeHtml(r.path||'')}</td>
        <td class="mono">${sc || '—'}</td>
        <td class="mono">${typeof r.latencyMs === 'number' ? r.latencyMs + 'ms' : '—'}</td>
        <td class="mono" style="font-size:10.5px;"><span style="display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:5px;background:${ipColor};"></span>${escapeHtml(r.clientIp||'—')}</td>
        <td class="mono" style="font-size:10.5px;color:var(--text-faint);">${escapeHtml(r.flowName||'—')}</td>
        <td>${hasFields ? '<span style="color:var(--accent);">View fields</span>' : '<span class="empty-field">—</span>'}</td>
      </tr>
      <tr class="obs-log-fields" id="obsLogFields${i}"><td colspan="9">
        <div class="obs-log-fields-inner">
          <div style="font-weight:700;font-size:11px;margin-bottom:6px;">Request fields</div>
          ${fieldKvHtml(r.requestFields)}
          <div style="font-weight:700;font-size:11px;margin:10px 0 6px;">Response fields</div>
          ${fieldKvHtml(r.responseFields)}
          <div class="hint" style="margin-top:8px;">Correlation ID: <span class="mono">${escapeHtml(r.correlationId||'—')}</span></div>
        </div>
      </td></tr>`;
  }).join('');

  const rangeNote = (fromMs !== null || toMs !== null) ? ' in the selected range' : '';
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
      <label>From<input type="datetime-local" id="obsLogFrom" value="${escapeHtml(ex.from)}" min="${oldestVal}" max="${newestVal}"></label>
      <label>To<input type="datetime-local" id="obsLogTo" value="${escapeHtml(ex.to)}" min="${oldestVal}" max="${newestVal}"></label>
      ${(ex.from || ex.to) ? `<button type="button" class="obs-log-btn" id="obsLogClearRange" style="align-self:flex-end;">Clear range</button>` : ''}
    </div>
    <div class="table-scroll"><table class="data-table cc-proj-table">
      <thead><tr><th>Time</th><th>Level</th><th>Method</th><th>Path</th><th>Status</th><th>Latency</th><th>Source IP</th><th>Flow</th><th>Fields</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="9"><div class="empty-field" style="padding:10px 0;">No records in the selected range.</div></td></tr>`}</tbody>
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

  const agg = aggregateKeys(scopedKeys, metrics);
  const alerts = computeConsoleAlerts(metrics).filter(a => scopedKeys.includes(a.key));
  const info = obsScopeInfo(state.obsScope, metrics);
  const scopedRecords = (logRecords || []).filter(r => scopedKeys.includes(r.key));
  const latency = computeLatencyStats(scopedRecords);

  main.innerHTML = `
    <div class="crumb">Observability / Console${state.obsScope.type!=='all' ? ' / ' + escapeHtml(info.title) : ''}</div>
    <div class="section-head" style="margin-bottom:14px;">
      <div>
        <div style="font-size:18px;font-weight:800;letter-spacing:-.2px;">${escapeHtml(info.title)}</div>
        <div class="hint" style="margin:2px 0 0;">${escapeHtml(info.sub)}</div>
      </div>
      ${state.obsScope.type!=='all' ? `<button type="button" class="obs-ip-more" id="obsClearScope">Clear scope</button>` : ''}
    </div>

    <div class="kpi-grid">
      ${healthKpi('Total requests', agg.total.toLocaleString(), `${agg.endpointCount} endpoint(s) in scope`)}
      ${healthKpi('Error rate', (agg.errorRate*100).toFixed(1)+'%', agg.errCount.toLocaleString()+' error(s)', agg.errorRate>=0.25?'--delete':agg.errorRate>=0.05?'--put':'--post')}
      ${healthKpi('Alerts', String(alerts.length), alerts.filter(a=>a.sev==='crit').length + ' critical', alerts.length ? (alerts.some(a=>a.sev==='crit')?'--delete':'--put') : '--post')}
      ${healthKpi('Distinct source IPs', String(agg.topIps.length) + (agg.topIps.length>=10?'+':''), 'top 10 shown below')}
      ${healthKpi('Last seen', agg.lastSeenAt ? formatDateTime(agg.lastSeenAt) : '—', '')}
      ${latency ? healthKpi('Latency p95 (real)', latency.p95 + 'ms', `p50 ${latency.p50}ms · p99 ${latency.p99}ms · from ${latency.count.toLocaleString()} record(s)`) : ''}
    </div>

    ${state.obsScope.type === 'all' ? `<div class="grid2">
      ${renderServiceHealth(groups, metrics)}
      ${renderStatusBreakdown(agg.statusBreakdown, agg.total)}
    </div>` : renderStatusBreakdown(agg.statusBreakdown, agg.total)}

    <div class="grid2">
      <div class="obs-panel"><div class="section-title">Top source IPs</div><div class="hint" style="margin-top:-4px;">Current scope, ranked by request count</div>${renderIpBreakdown(agg.topIps, agg.total, 'console')}</div>
      ${renderAlertsSection(alerts)}
    </div>

    <div class="grid2">
      ${renderAgentHealth(agentHealth)}
      ${renderLogVolumeAndLevelsSection(agentHealth)}
    </div>

    ${renderVolumeChart(scopedRecords)}

    <div class="grid2">
      ${renderLogExplorerSection(scopedRecords)}
      ${renderClusteringSection(scopedRecords)}
    </div>

    ${renderEndpointsTable(scopedKeys, metrics)}
  `;

  main.querySelectorAll('[data-obs-log-toggle]').forEach(row=>{
    row.addEventListener('click', ()=>{
      const target = document.getElementById(row.getAttribute('data-obs-log-toggle'));
      if(target) target.classList.toggle('open');
    });
  });

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
  const logClearRange = main.querySelector('#obsLogClearRange');
  if(logClearRange) logClearRange.addEventListener('click', ()=>{
    state.obsLogExplorer.from = '';
    state.obsLogExplorer.to = '';
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

  wireEndpointsTable(main);
}

// Renders into the app's OWN left sidebar (#projectList) instead of the
// normal project tree, while state.selected.type === 'observability' - see
// 09-render-sidebar.js's branch at the top of renderSidebar(). This is the
// only scope picker now (no second nested one inside the page content);
// the sidebar's existing #searchBox filters it the same way it filters the
// normal project tree.
function renderObservabilitySidebar(list, filter){
  const { endpoints: metrics } = observabilityData();
  if(!state.obsScope) state.obsScope = { type:'all' };
  if(!state.obsOpenProjects) state.obsOpenProjects = {};

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
    const agg = aggregateKeys(g.keys, metrics);
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

  const heroDesc = fullCapture
    ? `Real per-request records, auto-discovered from server logs — never written into documented endpoints. Credential-named fields always redacted.`
    : `Auto-discovered from server logs, never written into documented endpoints. Field values aren't captured in this mode — only counts and structure.`;

  main.innerHTML = `
    <div class="obs-header">
      <h1>Observability</h1>
      <p>${heroDesc}</p>
    </div>
    <div id="obsBody"></div>
  `;

  renderConsole(document.getElementById('obsBody'), metrics, agentHealth, logRecords);
}
