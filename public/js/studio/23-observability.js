/* ==================== SECTION:OBSERVABILITY ==================== */
// Traffic auto-discovered from server logs by ops/sit-doc-agent - hit counts,
// status breakdown, error rate, and source IPs, keyed by "METHOD /path" in
// state.endpointMetrics (org-shared, see loadState() in 06-spec-parse.js).
// Deliberately NOT written into any project's own endpoint data (see the
// server/db.js comment on org_workspace.endpoint_metrics_enc) - this page is
// the only place it's shown, cross-referenced against real endpoints purely
// by matching method+path text, never by mutating a project's stored JSON.
//
// state.endpointMetrics is pushed whole-blob by the agent as
// {endpoints:{...}, agentHealth:{...}} (see build_endpoint_metrics()/
// build_agent_health() in mule_doc_agent.py). Older pushes (before the
// agent tracked its own health) sent just the endpoints map directly with
// no wrapper - observabilityData() below normalizes both so a server that
// hasn't re-pushed since upgrading the agent doesn't render as broken.
function observabilityData(){
  const raw = state.endpointMetrics;
  if(raw && typeof raw === 'object' && raw.endpoints && typeof raw.endpoints === 'object'){
    return { endpoints: raw.endpoints, agentHealth: (raw.agentHealth && typeof raw.agentHealth === 'object') ? raw.agentHealth : null };
  }
  return { endpoints: (raw && typeof raw === 'object') ? raw : {}, agentHealth: null };
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

// Structured per-IP breakdown for one endpoint's traffic: a small bar per
// IP (relative to that endpoint's own busiest source), a private/public
// classification dot, and the exact hit count + share of total requests -
// replacing the old flat "ip (n), ip (n), ip (n)" comma string, which had
// no visual way to compare magnitudes or spot an internal vs external
// source at a glance.
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
  return `<div class="kpi-card"${accentVar ? ` style="--kpi-accent:var(${accentVar});"` : ''}>
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
    return `<div class="section">
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

  return `<div class="section">
    <div class="section-title">Agent health</div>
    <div class="hint" style="margin-top:-4px;">
      Self-monitoring for the discovery agent itself (${escapeHtml(health.sourceLog || '')}, Python ${escapeHtml(health.pythonVersion || '?')}, polling every ${health.pollIntervalSeconds ?? '?'}s). The agent never sits in the request path - it only tails an already-written log file - so it cannot slow down or hang the real API server regardless of traffic volume; what it CAN do under enough volume is fall behind reading its own input or grow its own memory/storage, which is what this card tracks. Generated ${health.generatedAt ? formatDateTime(health.generatedAt) : '—'}.
    </div>
    ${warnings.length ? `<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px;">${warnings.map(w=>`<div style="font-size:11.5px;color:var(--put);background:var(--put-bg);border:1px solid color-mix(in srgb, var(--put) 35%, transparent);border-radius:8px;padding:8px 12px;">${w}</div>`).join('')}</div>` : ''}
    <div class="kpi-grid">${kpis.join('')}</div>
  </div>`;
}

function renderObservability(main){
  const { endpoints: metrics, agentHealth } = observabilityData();
  const keys = Object.keys(metrics).sort((a,b)=> (a===OBS_OVERFLOW_KEY) - (b===OBS_OVERFLOW_KEY) || a.localeCompare(b));

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

  main.innerHTML = `
    <div class="crumb">Observability</div>
    <div class="ctrl-hero" style="--ctrl-glow-bg:var(--accent-soft);">
      <div class="ctrl-hero-icon" style="--ctrl-icon-color:var(--accent);--ctrl-icon-bg:var(--accent-soft);">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 17 9 11 13 15 21 6"></polyline><polyline points="15 6 21 6 21 12"></polyline></svg>
      </div>
      <div class="ctrl-hero-copy">
        <h1>Real traffic, straight from server logs</h1>
        <p>Hit counts, status breakdown, error rate, and source IPs auto-discovered by the SIT log agent — never written into your documented endpoints, only shown here, cross-referenced by method + path. Field <em>values</em> from requests are never captured by the agent, only counts and structure. Path segments that look like per-request ids are templated to <code>{id}</code> so one busy endpoint doesn't fragment into thousands of rows.</p>
      </div>
    </div>

    ${renderAgentHealth(agentHealth)}

    <div class="section">
      <div class="section-title">Endpoints seen in traffic</div>
      <div class="table-scroll">
      <table class="data-table cc-proj-table">
        <thead><tr>
          <th>Method</th><th>Path</th><th>Total requests</th><th>Error rate</th>
          <th>Status breakdown</th><th>Source IPs</th><th>Last seen</th><th>Documentation</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      </div>
    </div>
  `;

  main.querySelectorAll('[data-obs-ep]').forEach(row=>{
    row.style.cursor = 'pointer';
    row.addEventListener('click', (e)=>{
      if(e.target.closest('[data-obs-ip-toggle]')) return;
      const epId = row.getAttribute('data-obs-ep');
      state.selected = { type:'endpoint', id: epId };
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
