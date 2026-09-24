/* ============================================================================
   Observability console — the tabbed view backed by the time-series API.

   Renders only when obsDataAvailable() is true; until an agent that emits
   rollups has been deployed, renderObservability() keeps using the original
   blob-backed console instead (see 23-observability.js). That fallback is not
   a temporary scaffold — an org running an older agent should keep seeing its
   data, not an empty page explaining that the backend moved on.
   ========================================================================= */

const OBS_TABS = [
  { key: 'overview',    label: 'Overview' },
  { key: 'performance', label: 'Performance' },
  { key: 'errors',      label: 'Errors' },
  { key: 'logs',        label: 'Log explorer' },
  { key: 'agent',       label: 'Agent & host' },
];

/* --- Loading ------------------------------------------------------------ */

async function obsLoad(opts){
  const quiet = opts && opts.quiet;   // a live-stream refresh must not flash a spinner
  if(!quiet){ state.obsStatus = 'loading'; renderMain(); }
  try{
    const [data, envs] = await Promise.all([
      obsLoadAll(),
      state.obsEnvOptions.length ? Promise.resolve(state.obsEnvOptions) : obsLoadEnvironments(),
    ]);
    state.obsData = data;
    state.obsEnvOptions = envs;
    state.obsStatus = data.coverage && data.coverage.buckets > 0 ? 'ready' : 'unavailable';
    state.obsError = '';
  }catch(err){
    // A failed refresh must not blank a console that is already showing good
    // data — keep what is on screen and surface the error alongside it.
    state.obsStatus = state.obsData ? 'ready' : 'error';
    state.obsError = err && err.message ? err.message : 'Could not load observability data.';
  }
  renderMain();
}

async function obsLoadRecordsPage(){
  const filters = state.obsFilters || {};
  const limit = 50;
  try{
    state.obsRecords = await obsLoadRecords({
      statusFamily: filters.statusFamily,
      endpointId: filters.endpointId,
      clientIp: filters.clientIp,
      correlationId: filters.correlationId,
      minLatencyMs: filters.minLatencyMs,
      limit,
      offset: (state.obsRecordsPage - 1) * limit,
    });
  }catch(err){
    state.obsRecords = { records: [], total: 0, limit, offset: 0, error: err.message };
  }
  renderMain();
}

/* --- Drill-down --------------------------------------------------------- */

/* Every panel that shows a slice of traffic routes through here, so "click a
   thing, see the requests behind it" works the same way everywhere and there
   is exactly one place that knows what the log explorer is filtered by. */
function obsDrillTo(filters, opts){
  state.obsFilters = Object.assign({}, state.obsFilters, filters);
  state.obsRecordsPage = 1;
  if(!opts || opts.switchTab !== false) state.obsTab = 'logs';
  state.obsRecords = null;
  renderMain();
  obsLoadRecordsPage();
}

function obsClearFilter(key){
  const next = Object.assign({}, state.obsFilters);
  delete next[key];
  state.obsFilters = next;
  state.obsRecordsPage = 1;
  state.obsRecords = null;
  renderMain();
  obsLoadRecordsPage();
}

function obsClearAllFilters(){
  state.obsFilters = {};
  state.obsRecordsPage = 1;
  state.obsRecords = null;
  renderMain();
  obsLoadRecordsPage();
}

/* Rollup rows carry the endpoint's stable id, never its path — paths live
   only in the (encrypted) project documents. This resolves an id back to
   something a human recognises, falling back to the id when the endpoint
   isn't documented in this workspace. */
function obsEndpointLabel(endpointId){
  if(!state._obsEndpointNames){
    const map = {};
    Object.values(state.projects || {}).forEach(proj=>{
      (proj.endpoints || []).forEach(ep=>{
        if(ep.id) map[ep.id] = `${(ep.method||'').toUpperCase()} ${ep.path||''}`.trim();
      });
    });
    state._obsEndpointNames = map;
  }
  return state._obsEndpointNames[endpointId] || endpointId;
}

/* --- Toolbar ------------------------------------------------------------ */

function renderObsToolbar(){
  const sel = state.obsRange || { key: '24h' };
  const custom = !!(sel.from && sel.to);
  const range = obsResolvedRange();

  const pills = OBS_RANGES.map(r =>
    `<button type="button" class="obs-range-pill${!custom && sel.key === r.key ? ' active' : ''}"
       data-obs-range="${r.key}">${r.label}</button>`).join('');

  const envs = state.obsEnvOptions || [];
  const currentEnv = state.obsEnvironment || '';
  const envOptions = [
    `<option value=""${currentEnv === '' ? ' selected' : ''}>Current environment (${escapeHtml(state.env || '—')})</option>`,
    `<option value="__all"${currentEnv === '__all' ? ' selected' : ''}>All environments</option>`,
  ].concat(envs.map(e =>
    `<option value="${escapeHtml(e)}"${currentEnv === e ? ' selected' : ''}>${escapeHtml(e)}</option>`
  )).join('');

  const coverage = state.obsData && state.obsData.coverage;
  const coverageNote = coverage && coverage.oldest
    ? `Data from ${formatDateTime(coverage.oldest)}`
    : '';

  // datetime-local wants a local, second-less value; the state holds ISO.
  const toLocalInput = (iso)=>{
    if(!iso) return '';
    const d = new Date(iso);
    if(isNaN(d.getTime())) return '';
    const pad = (n)=>String(n).padStart(2,'0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  return `<div class="obs-toolbar">
    <div class="obs-range-pills">${pills}</div>
    <div class="obs-custom-range">
      <input type="datetime-local" id="obsFrom" value="${toLocalInput(custom ? sel.from : range.from)}" aria-label="Range start">
      <span>→</span>
      <input type="datetime-local" id="obsTo" value="${toLocalInput(custom ? sel.to : range.to)}" aria-label="Range end">
      <button type="button" class="obs-range-pill${custom ? ' active' : ''}" id="obsApplyRange">Apply</button>
    </div>
    <select class="obs-env-select" id="obsEnvSelect" aria-label="Environment">${envOptions}</select>
    <span class="obs-toolbar-spacer"></span>
    ${coverageNote ? `<span class="obs-coverage-note">${escapeHtml(coverageNote)}</span>` : ''}
    ${renderObsLiveBadge()}
  </div>`;
}

function renderObsTabs(){
  const d = state.obsData;
  const errCount = d && d.current ? d.current.errCount : 0;
  const counts = {
    errors: errCount ? obsFormatCount(errCount) : '',
  };
  return `<div class="obs-tabs" role="tablist">
    ${OBS_TABS.map(t => `<button type="button" role="tab" class="obs-tab${state.obsTab === t.key ? ' active' : ''}"
      data-obs-tab="${t.key}" aria-selected="${state.obsTab === t.key}">${t.label}${
        counts[t.key] ? `<span class="obs-tab-count${t.key === 'errors' && errCount ? ' crit' : ''}">${counts[t.key]}</span>` : ''
      }</button>`).join('')}
  </div>`;
}

function renderObsActiveFilters(){
  const f = state.obsFilters || {};
  const entries = Object.entries(f).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if(!entries.length) return '';
  const labelFor = {
    statusFamily: 'Status', endpointId: 'Endpoint', clientIp: 'Source IP',
    correlationId: 'Correlation', minLatencyMs: 'Slower than',
  };
  return `<div class="obs-active-filters">
    ${entries.map(([k, v]) => {
      const shown = k === 'endpointId' ? obsEndpointLabel(v) : (k === 'minLatencyMs' ? `${v}ms` : v);
      return `<button type="button" class="obs-filter-chip" data-obs-clear-filter="${k}"
        title="Remove this filter">${labelFor[k] || k}: ${escapeHtml(String(shown))} <span class="x">×</span></button>`;
    }).join('')}
    <button type="button" class="obs-filter-chip" data-obs-clear-filter="__all" title="Clear every filter">Clear all <span class="x">×</span></button>
  </div>`;
}

/* --- KPIs --------------------------------------------------------------- */

/* Four, not six. "Distinct source IPs" is already a panel below and "Last
   seen" is agent liveness, which the live badge and the Agent tab both cover
   — as headline numbers they diluted the ones that matter. */
function renderObsKpis(){
  const d = state.obsData;
  if(!d || !d.current) return '';
  const cur = d.current;
  const prev = d.previous;
  const lat = cur.latency;

  const sparkTotals = (d.series || []).map(p => p.total);
  const sparkErrs = (d.series || []).map(p => {
    const e = (p.statusBreakdown?.['4xx'] || 0) + (p.statusBreakdown?.['5xx'] || 0);
    return p.total ? (e / p.total) * 100 : 0;
  });

  const errPct = (cur.errorRate * 100);
  const errColor = errPct >= 25 ? '--delete' : errPct >= 5 ? '--put' : '--post';

  return `<div class="kpi-grid">
    ${healthKpi('Requests', obsFormatCount(cur.total),
      `${cur.endpointCount} endpoint(s)${prev ? ' · ' + deltaBadge(cur.total, prev.total, 'pct', 'neutral') : ''}`
      + renderKpiSparkline(sparkTotals, '--accent'))}
    ${healthKpi('Error rate', errPct.toFixed(1) + '%',
      `${obsFormatCount(cur.errCount)} error(s)${prev ? ' · ' + deltaBadge(cur.errorRate, prev.errorRate, 'pp', 'down') : ''}`
      + renderKpiSparkline(sparkErrs, errColor), errColor)}
    ${lat ? healthKpi('Latency p95', lat.p95 + 'ms',
      `p50 ${lat.p50}ms · p99 ${lat.p99}ms${prev && prev.latency ? ' · ' + deltaBadge(lat.p95, prev.latency.p95, 'pct', 'down') : ''}`)
      : healthKpi('Latency p95', '—', 'No durations parsed from these log lines')}
    ${healthKpi('Unclassified', obsFormatCount(cur.statusBreakdown.unknown || 0),
      (cur.statusBreakdown.unknown || 0) > 0
        ? 'Requests with no status code logged'
        : 'Every request has a status code',
      (cur.statusBreakdown.unknown || 0) > cur.total * 0.2 ? '--put' : '--post')}
  </div>`;
}

/* --- Tab bodies --------------------------------------------------------- */

function renderObsOverviewTab(){
  const d = state.obsData;
  const cur = d.current;
  return `
    ${renderObsKpis()}
    <div class="obs-panel">
      <div class="section-head">
        <div>
          <div class="section-title">Traffic over time</div>
          <div class="hint" style="margin-top:-4px;">Requests by status family · error rate on the right axis · click a colour to see those requests</div>
        </div>
      </div>
      ${renderTrafficChart(d.series || [])}
    </div>

    <div class="grid2">
      <div class="obs-panel obs-panel-fill">
        <div class="section-title">Status code breakdown</div>
        <div class="hint" style="margin-top:-4px;">${obsFormatCount(cur.total)} response(s) in this range · click a row to drill in</div>
        ${renderObsStatusBreakdown(cur)}
      </div>
      <div class="obs-panel obs-panel-fill">
        <div class="section-title">Top source IPs</div>
        <div class="hint" style="margin-top:-4px;">Ranked by request count · click to filter</div>
        ${renderObsTopIps(cur)}
      </div>
    </div>`;
}

function renderObsStatusBreakdown(cur){
  const fams = ['2xx','3xx','4xx','5xx','unknown'];
  const counts = fams.map(f => cur.statusBreakdown[f] || 0);
  const total = counts.reduce((a,b)=>a+b,0) || 1;
  const present = fams.filter((f,i)=>counts[i] > 0);
  if(!present.length){
    return `<div class="obs-empty"><div class="obs-empty-title">No responses in this range</div>
      <div class="obs-empty-body">Widen the date range, or check that the agent is still pushing.</div></div>`;
  }
  return `<div class="obs-statusbreakdown-body">
    <div class="obs-statusbar">${present.map(f =>
      `<span style="width:${((cur.statusBreakdown[f]||0)/total*100)}%;background:${OBS_STATUS_COLORS[f]};"
        title="${f}: ${(cur.statusBreakdown[f]||0).toLocaleString()}"></span>`).join('')}</div>
    <div class="obs-histo">
      ${fams.map((f,i)=>{
        const c = counts[i];
        if(!c) return '';
        const share = Math.round((c/total)*1000)/10;
        const max = Math.max(...counts, 1);
        return `<div class="obs-histo-row obs-clickable" data-obs-filter-family="${f}" title="Show ${f} requests in the log explorer">
          <span class="obs-histo-label" style="color:${OBS_STATUS_COLORS[f]};font-weight:800;">${f}</span>
          <span class="obs-ip-bar-track"><span class="obs-ip-bar" style="width:${Math.max(Math.round(c/max*100),2)}%;background:${OBS_STATUS_COLORS[f]};"></span></span>
          <span class="obs-ip-count">${obsFormatCount(c)} <span style="opacity:.7;">(${share}%)</span></span>
        </div>`;
      }).join('')}
    </div>
  </div>`;
}

function renderObsTopIps(cur){
  const ips = cur.topIps || [];
  if(!ips.length){
    return `<div class="obs-empty"><div class="obs-empty-title">No source IPs recorded</div>
      <div class="obs-empty-body">The agent records caller addresses when the log line carries one.</div></div>`;
  }
  const max = Math.max(...ips.map(x=>x.count), 1);
  return `<div class="obs-histo" style="margin-top:22px;">
    ${ips.map(x=>{
      const cls = typeof classifyIp === 'function' ? classifyIp(x.ip) : 'unknown';
      const dot = cls === 'internal' ? 'var(--accent)' : cls === 'external' ? 'var(--put)' : 'var(--text-faint)';
      const share = cur.total ? Math.round((x.count/cur.total)*1000)/10 : 0;
      return `<div class="obs-histo-row obs-clickable" data-obs-filter-ip="${escapeHtml(x.ip)}" title="Show requests from ${escapeHtml(x.ip)}">
        <span class="obs-histo-label mono" style="text-align:left;">${escapeHtml(x.ip)}</span>
        <span class="obs-ip-bar-track"><span class="obs-ip-bar" style="width:${Math.max(Math.round(x.count/max*100),2)}%;background:${dot};"></span></span>
        <span class="obs-ip-count">${obsFormatCount(x.count)} <span style="opacity:.7;">(${share}%)</span></span>
      </div>`;
    }).join('')}
  </div>`;
}

function renderObsPerformanceTab(){
  const d = state.obsData;
  const cur = d.current;
  const eps = (d.endpoints || []).filter(e => e.latency).slice();
  eps.sort((a,b)=> (b.latency.p95 || 0) - (a.latency.p95 || 0));
  const slowest = eps.slice(0, 12);

  return `
    <div class="grid2">
      <div class="obs-panel">
        <div class="section-title">Latency distribution</div>
        <div class="hint" style="margin-top:-4px;">Where the time actually goes — a second clump here is invisible in p50/p95/p99 alone</div>
        ${renderLatencyHistogram(cur.latencyBuckets, cur.latency)}
      </div>
      <div class="obs-panel">
        <div class="section-title">Slowest endpoints</div>
        <div class="hint" style="margin-top:-4px;">By p95 in this range · click to filter</div>
        ${slowest.length ? `<div class="obs-histo" style="margin-top:18px;">
          ${(()=>{
            const max = Math.max(...slowest.map(e=>e.latency.p95||0), 1);
            return slowest.map(e=>`
              <div class="obs-histo-row obs-clickable" data-obs-filter-endpoint="${escapeHtml(e.endpointId)}"
                   title="${escapeHtml(obsEndpointLabel(e.endpointId))} — p95 ${e.latency.p95}ms over ${e.total.toLocaleString()} request(s)">
                <span class="obs-histo-label mono" style="text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60px;">${escapeHtml(obsEndpointLabel(e.endpointId))}</span>
                <span class="obs-ip-bar-track"><span class="obs-ip-bar" style="width:${Math.max(Math.round((e.latency.p95||0)/max*100),2)}%;background:${(e.latency.p95||0) >= 1000 ? 'var(--st-4)' : 'var(--accent)'};"></span></span>
                <span class="obs-ip-count">${e.latency.p95}ms</span>
              </div>`).join('');
          })()}
        </div>` : `<div class="obs-empty"><div class="obs-empty-title">No latency recorded</div>
          <div class="obs-empty-body">Durations are read from the log line when it carries one. Nothing in this range did.</div></div>`}
      </div>
    </div>

    <div class="obs-panel">
      <div class="section-title">All endpoints</div>
      <div class="hint" style="margin-top:-4px;">${(d.endpoints||[]).length} endpoint(s) with traffic in this range · click a row to drill in</div>
      ${renderObsEndpointTable(d.endpoints || [])}
    </div>`;
}

function renderObsEndpointTable(endpoints){
  if(!endpoints.length){
    return `<div class="obs-empty"><div class="obs-empty-title">No endpoints reported traffic</div>
      <div class="obs-empty-body">Try a wider date range, or a different environment.</div></div>`;
  }
  return `<div class="obs-table-scroll"><table class="data-table obs-data-table">
    <thead><tr>
      <th>Endpoint</th><th class="num">Requests</th><th class="num">Errors</th>
      <th class="num">Error rate</th><th class="num">p95</th><th>Last seen</th>
    </tr></thead>
    <tbody>
      ${endpoints.map(e=>{
        const rate = e.errorRate * 100;
        const color = rate >= 25 ? 'var(--st-5)' : rate >= 5 ? 'var(--st-4)' : 'var(--text-faint)';
        return `<tr class="obs-clickable" data-obs-filter-endpoint="${escapeHtml(e.endpointId)}">
          <td class="mono">${escapeHtml(obsEndpointLabel(e.endpointId))}</td>
          <td class="num">${obsFormatCount(e.total)}</td>
          <td class="num">${obsFormatCount(e.errCount)}</td>
          <td class="num" style="color:${color};font-weight:700;">${rate.toFixed(1)}%</td>
          <td class="num">${e.latency ? e.latency.p95 + 'ms' : '—'}</td>
          <td>${e.lastSeenAt ? formatDateTime(e.lastSeenAt) : '—'}</td>
        </tr>`;
      }).join('')}
    </tbody>
  </table></div>`;
}

function renderObsErrorsTab(){
  const d = state.obsData;
  const cur = d.current;
  const failing = (d.endpoints || []).filter(e => e.errCount > 0).slice();
  failing.sort((a,b)=> b.errorRate - a.errorRate || b.errCount - a.errCount);

  if(!cur.errCount){
    return `<div class="obs-panel"><div class="obs-empty">
      <div class="obs-empty-title">No errors in this range</div>
      <div class="obs-empty-body">Every classified response was 2xx or 3xx. Widen the range to look further back.</div>
    </div></div>`;
  }

  // Error volume over time, reusing the same chart with only the error
  // families present — same visual language, narrower question.
  const errSeries = (d.series || []).map(p => ({
    ts: p.ts,
    total: (p.statusBreakdown?.['4xx'] || 0) + (p.statusBreakdown?.['5xx'] || 0),
    statusBreakdown: { '4xx': p.statusBreakdown?.['4xx'] || 0, '5xx': p.statusBreakdown?.['5xx'] || 0 },
    meanLatencyMs: p.meanLatencyMs,
  }));

  return `
    <div class="obs-panel">
      <div class="section-title">Errors over time</div>
      <div class="hint" style="margin-top:-4px;">${obsFormatCount(cur.errCount)} error(s) — ${(cur.errorRate*100).toFixed(1)}% of traffic in this range</div>
      ${renderTrafficChart(errSeries, { hideLegend: true })}
    </div>

    <div class="obs-panel">
      <div class="section-head">
        <div>
          <div class="section-title">Endpoints by error rate</div>
          <div class="hint" style="margin-top:-4px;">Worst first · click a row to see the failing requests</div>
        </div>
        <button type="button" class="obs-ip-more" data-obs-filter-family="5xx">Show all 5xx</button>
      </div>
      ${renderObsEndpointTable(failing)}
    </div>`;
}

function renderObsLogsTab(){
  const captureOn = state.obsRecords && state.obsRecords.total > 0;
  const filters = state.obsFilters || {};
  const hasFilter = Object.keys(filters).some(k => filters[k]);

  if(state.obsRecords === null){
    return `<div class="obs-panel"><div class="obs-empty"><div class="obs-empty-title">Loading requests…</div></div></div>`;
  }
  if(state.obsRecords.error){
    return `<div class="obs-panel"><div class="obs-empty">
      <div class="obs-empty-title">Could not load requests</div>
      <div class="obs-empty-body">${escapeHtml(state.obsRecords.error)}</div>
    </div></div>`;
  }
  if(!captureOn && !hasFilter){
    return `<div class="obs-panel"><div class="obs-empty">
      <div class="obs-empty-title">Per-request records aren't being captured</div>
      <div class="obs-empty-body">Charts and totals above come from aggregated counters, which is the default.
        Individual requests — with their real field values — are only stored when the agent runs with
        <code>CAPTURE_MODE=full</code>. Credential-named fields are always redacted, and these records are
        kept for 7 days.</div>
    </div></div>`;
  }

  const r = state.obsRecords;
  const pages = Math.max(1, Math.ceil(r.total / (r.limit || 50)));
  return `
    <div class="obs-panel">
      <div class="section-head">
        <div>
          <div class="section-title">Requests</div>
          <div class="hint" style="margin-top:-4px;">${r.total.toLocaleString()} matching request(s) in this range</div>
        </div>
        <span class="obs-drill-hint">Newest first</span>
      </div>
      ${r.records.length ? `<div class="obs-table-scroll"><table class="data-table obs-data-table">
        <thead><tr><th>When</th><th>Endpoint</th><th class="num">Status</th><th class="num">Latency</th><th>Source</th><th>Correlation</th></tr></thead>
        <tbody>
          ${r.records.map(rec=>{
            const fam = rec.statusCode ? String(rec.statusCode)[0] + 'xx' : 'unknown';
            return `<tr>
              <td class="mono">${formatDateTime(rec.ts)}</td>
              <td class="mono">${escapeHtml(obsEndpointLabel(rec.endpointId))}</td>
              <td class="num mono" style="color:${OBS_STATUS_COLORS[fam]};font-weight:700;">${rec.statusCode || '—'}</td>
              <td class="num mono">${rec.latencyMs === null ? '—' : rec.latencyMs + 'ms'}</td>
              <td class="mono">${escapeHtml(rec.clientIp || '—')}</td>
              <td class="mono" style="opacity:.75;">${escapeHtml((rec.correlationId || '—').slice(0, 18))}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table></div>` : `<div class="obs-empty">
        <div class="obs-empty-title">No requests match these filters</div>
        <div class="obs-empty-body">Try clearing a filter above, or widening the date range.</div>
      </div>`}
      ${pages > 1 ? `<div class="obs-health-pager">
        <button type="button" class="obs-health-pager-page" id="obsRecPrev" ${state.obsRecordsPage <= 1 ? 'disabled' : ''}>Previous</button>
        <span class="obs-health-pager-label">Page ${state.obsRecordsPage} of ${pages}</span>
        <button type="button" class="obs-health-pager-page" id="obsRecNext" ${state.obsRecordsPage >= pages ? 'disabled' : ''}>Next</button>
      </div>` : ''}
    </div>`;
}

function renderObsAgentTab(agentHealth){
  return `
    ${typeof renderHostHealthSection === 'function' ? renderHostHealthSection(agentHealth) : ''}
    ${typeof renderLogVolumeAndLevelsSection === 'function' ? renderLogVolumeAndLevelsSection(agentHealth) : ''}
    ${typeof renderAgentHealth === 'function' ? renderAgentHealth(agentHealth) : ''}`;
}

/* --- Entry point -------------------------------------------------------- */

function renderObsConsoleV2(main, agentHealth){
  const d = state.obsData;
  let body = '';

  if(state.obsStatus === 'loading' && !d){
    body = `<div class="obs-panel"><div class="obs-empty"><div class="obs-empty-title">Loading…</div></div></div>`;
  }else if(state.obsStatus === 'error'){
    body = `<div class="obs-panel"><div class="obs-empty">
      <div class="obs-empty-title">Could not load observability data</div>
      <div class="obs-empty-body">${escapeHtml(state.obsError)}</div>
    </div></div>`;
  }else if(d){
    switch(state.obsTab){
      case 'performance': body = renderObsPerformanceTab(); break;
      case 'errors':      body = renderObsErrorsTab(); break;
      case 'logs':        body = renderObsLogsTab(); break;
      case 'agent':       body = renderObsAgentTab(agentHealth); break;
      default:            body = renderObsOverviewTab();
    }
  }

  main.innerHTML = `
    ${renderObsToolbar()}
    ${renderObsTabs()}
    ${state.obsTab === 'logs' ? renderObsActiveFilters() : ''}
    ${state.obsError && d ? `<div class="obs-win-truncated">${escapeHtml(state.obsError)}</div>` : ''}
    ${body}`;

  wireObsConsoleV2(main);
}

function wireObsConsoleV2(main){
  main.querySelectorAll('[data-obs-tab]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      state.obsTab = btn.getAttribute('data-obs-tab');
      renderMain();
      if(state.obsTab === 'logs' && state.obsRecords === null) obsLoadRecordsPage();
    });
  });

  main.querySelectorAll('[data-obs-range]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      state.obsRange = { key: btn.getAttribute('data-obs-range') };
      obsLoad();
      if(state.obsTab === 'logs') obsLoadRecordsPage();
    });
  });

  const apply = main.querySelector('#obsApplyRange');
  if(apply) apply.addEventListener('click', ()=>{
    const from = main.querySelector('#obsFrom').value;
    const to = main.querySelector('#obsTo').value;
    if(!from || !to){ toast('Pick both a start and an end.'); return; }
    const fromMs = Date.parse(from);
    const toMs = Date.parse(to);
    if(isNaN(fromMs) || isNaN(toMs) || fromMs >= toMs){
      toast('That range runs backwards — the start has to be before the end.');
      return;
    }
    state.obsRange = { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };
    obsLoad();
    if(state.obsTab === 'logs') obsLoadRecordsPage();
  });

  const envSel = main.querySelector('#obsEnvSelect');
  if(envSel) envSel.addEventListener('change', ()=>{
    state.obsEnvironment = envSel.value;
    state.obsRecords = null;
    obsLoad();
  });

  main.querySelectorAll('[data-obs-filter-family]').forEach(el=>{
    el.addEventListener('click', ()=> obsDrillTo({ statusFamily: el.getAttribute('data-obs-filter-family') }));
  });
  main.querySelectorAll('[data-obs-filter-ip]').forEach(el=>{
    el.addEventListener('click', ()=> obsDrillTo({ clientIp: el.getAttribute('data-obs-filter-ip') }));
  });
  main.querySelectorAll('[data-obs-filter-endpoint]').forEach(el=>{
    el.addEventListener('click', ()=> obsDrillTo({ endpointId: el.getAttribute('data-obs-filter-endpoint') }));
  });
  main.querySelectorAll('[data-obs-clear-filter]').forEach(el=>{
    el.addEventListener('click', ()=>{
      const key = el.getAttribute('data-obs-clear-filter');
      if(key === '__all') obsClearAllFilters(); else obsClearFilter(key);
    });
  });

  const prev = main.querySelector('#obsRecPrev');
  if(prev) prev.addEventListener('click', ()=>{
    state.obsRecordsPage = Math.max(1, state.obsRecordsPage - 1);
    obsLoadRecordsPage();
  });
  const next = main.querySelector('#obsRecNext');
  if(next) next.addEventListener('click', ()=>{
    state.obsRecordsPage += 1;
    obsLoadRecordsPage();
  });
}
