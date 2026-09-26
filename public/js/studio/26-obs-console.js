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
  // Alert RULES live beside the metrics they watch, not under Security: a
  // threshold is observability configuration, not an access-control decision.
  // Everyone can read what is firing — an alert exists to be seen, and an
  // engineer who has to ask an Admin what is wrong is back where this
  // started. Only editing is Admin-only.
  { key: 'alerts',      label: 'Alerts' },
  { key: 'agent',       label: 'Agent & host' },
];

/* --- Loading ------------------------------------------------------------ */

async function obsLoad(opts){
  const quiet = opts && opts.quiet;   // a live-stream refresh must not flash a spinner
  const skipRender = opts && opts.skipRender;  // caller will render once, after its own other fetches
  // NOT the same thing as `quiet`. renderObservability() has its own quiet
  // recheck ("has this org's agent started pushing rollups yet") that must
  // still go through the full renderMain() - it can flip useTimeSeries from
  // false to true, or decide the live stream needs to START for the first
  // time, neither of which the narrow console-only patch below can do. Only
  // the SSE onUpdate callback - which can only ever fire after the stream is
  // already open and rendering the time-series console - sets this.
  const liveUpdate = opts && opts.liveUpdate;
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
    // Remembered so the NEXT page load paints the right console immediately
    // instead of guessing and correcting itself a second later.
    if(typeof obsRememberAvailability === 'function'){
      obsRememberAvailability(state.obsStatus === 'ready');
    }
  }catch(err){
    // A failed refresh must not blank a console that is already showing good
    // data — keep what is on screen and surface the error alongside it.
    state.obsStatus = state.obsData ? 'ready' : 'error';
    state.obsError = err && err.message ? err.message : 'Could not load observability data.';
  }
  if(skipRender) return;
  // A live-stream-driven refresh patches just the console's own content
  // instead of going through renderMain() -> renderObservability(), which
  // tears down and rebuilds the page header/environment-bar/#obsBody wrapper
  // on every call with no in-place-update path. One SSE push while parked on
  // the console used to mean a full page-shell rebuild for what's
  // conceptually "the numbers changed" - see obsRerenderLiveConsole(). Every
  // other quiet caller (renderObservability()'s own availability recheck)
  // still needs the full path, so this checks liveUpdate, not quiet.
  if(liveUpdate && typeof obsRerenderLiveConsole === 'function'){
    obsRerenderLiveConsole();
  }else{
    renderMain();
  }
}

async function obsLoadRecordsPage(opts){
  // Nothing writes records before the upgraded agent, so this would be a round
  // trip that can only come back empty. The Log explorer tab says why instead.
  if(obsIsBridged()) return;
  const liveUpdate = opts && opts.liveUpdate;  // see the note on obsLoad()'s own liveUpdate flag
  const skipRender = opts && opts.skipRender;
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
  if(skipRender) return;
  if(liveUpdate && typeof obsRerenderLiveConsole === 'function'){
    obsRerenderLiveConsole();
  }else{
    renderMain();
  }
}

// The narrow live-update path both functions above use instead of
// renderMain(): re-renders ONLY the console's own content into the #obsBody
// wrapper that's already in the DOM, not the header/live-badge/environment-
// bar around it. Safe to assume the time-series console (not the legacy
// blob-backed one) is what's showing, because a live SSE push can only ever
// arrive after obsStartLive() already ran once from inside that branch (see
// 23-observability.js) - the legacy console never opens the stream at all.
// If #obsBody isn't in the DOM, the viewer has navigated away since the
// fetch started; renderMain() itself now closes the stream on navigation
// (11-render-main.js), so this is a narrow in-flight-request window, not a
// leak - there's simply nothing to patch.
function obsRerenderLiveConsole(){
  const body = document.getElementById('obsBody');
  if(!body) return;
  const { agentHealth } = observabilityData();
  renderObsConsoleV2(body, agentHealth);
}

/* --- Drill-down --------------------------------------------------------- */

/* Every panel that shows a slice of traffic routes through here, so "click a
   thing, see the requests behind it" works the same way everywhere and there
   is exactly one place that knows what the log explorer is filtered by. */
function obsDrillTo(filters, opts){
  // Drilling in means "show me the requests behind this number", and behind a
  // blob counter there are none. Sending someone to an empty log explorer
  // would read as a broken click; saying why costs one toast.
  if(obsIsBridged()){
    toast('Drilling into individual requests needs the upgraded agent — these totals are counters, not stored requests.');
    return;
  }
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
/* A log row's own name beats resolving its id. The id is a hash, and it
   resolves only for endpoints already in this viewer's project list - which
   a just-discovered one is not, so the row rendered as "auto-ad0a5a390a"
   exactly when it was most interesting. */
function obsRecordLabel(rec){
  if(rec && rec.method && rec.path) return `${rec.method} ${rec.path}`;
  return obsEndpointLabel(rec ? rec.endpointId : '');
}

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

/* --- Bridged (pre-rollup) mode -----------------------------------------
   True while the console is drawing this org's blob counters because no
   rollups exist yet (see obsBridgeFromBlob in 23-observability.js). The
   numbers are real; what's missing is the time dimension. Every panel that
   needs one checks this and says so in its own words, because an empty chart
   captioned "no traffic in this range" would be a lie on a page that is at
   the same moment reporting hundreds of requests. */
function obsIsBridged(){
  return !!(state.obsData && state.obsData.source === 'blob');
}

/* When this environment's time-series record actually begins. Everything
   before it is unobserved, not quiet - a distinction the charts draw and the
   empty states have to make too, because "no errors in this range" is a very
   different claim when most of the range predates collection. */
function obsCoverageStart(){
  const c = state.obsData && state.obsData.coverage;
  return (c && c.oldest) || null;
}

/* True when the selected range starts before this environment was being
   recorded — i.e. an empty panel may only mean "we weren't looking". */
function obsRangeOutrunsCoverage(){
  const start = obsCoverageStart();
  if(!start) return false;
  const from = state.obsData && state.obsData.range && state.obsData.range.from;
  if(!from) return false;
  const startMs = Date.parse(start);
  const fromMs = Date.parse(from);
  if(!isFinite(startMs) || !isFinite(fromMs)) return false;
  // A minute of slack: a bucket boundary is not a gap worth mentioning.
  return startMs - fromMs > 60e3;
}

/* The honest second line under an empty panel. Telling someone to widen a
   range that already extends past the start of collection sends them looking
   for data that cannot exist. */
function obsEmptyRangeHint(){
  return obsRangeOutrunsCoverage()
    ? `Recording for this environment starts ${escapeHtml(formatDateTime(obsCoverageStart()))}. Nothing before that was captured, so widening the range will not reach further back.`
    : 'Widen the date range to look further back.';
}

/* One shape for "this panel is real, it just needs the upgraded agent" — so
   the three places it appears read as the same deliberate state rather than
   three different kinds of blank. */
function obsPendingPanel(title, body){
  return `<div class="obs-chart-empty obs-chart-pending">
    <div class="obs-pending-title">${escapeHtml(title)}</div>
    <div class="obs-pending-body">${body}</div>
  </div>`;
}

/* --- Toolbar ------------------------------------------------------------ */

function renderObsToolbar(){
  const sel = state.obsRange || { key: '24h' };
  const custom = !!(sel.from && sel.to);
  const range = obsResolvedRange();
  const bridged = obsIsBridged();

  // Removing this page's own environment dropdown removed the only place the
  // OTHER environments were visible, and with them the explanation for an
  // empty page: you are in an environment no agent reports. Said outright
  // instead, still leaving the header switcher as the one way to change it.
  const reported = state.obsEnvOptions || [];
  const here = (state.env || '').trim();
  const envGap = here && reported.length && !reported.includes(here)
    ? `No agent reports ${here}. Reporting: ${reported.slice(0, 4).join(', ')}${reported.length > 4 ? '…' : ''}`
    : '';

  // Agent & host isn't queried by range at all — it renders whatever window
  // the agent itself retained (see renderHostHealthSection / agentHealth
  // above). A picker that visibly sits above the tab but changes nothing in
  // it is worse than no picker, so it's hidden here rather than disabled —
  // "disabled" would still imply it applies once some condition is met, and
  // none ever will be for this tab.
  if(state.obsTab === 'agent'){
    return `<div class="obs-toolbar obs-toolbar-agent">
      <span class="obs-toolbar-agent-note">Host health and log volume below reflect the agent's own retained window, not a selectable date range.</span>
      ${envGap ? `<span class="obs-env-gap">${escapeHtml(envGap)}</span>` : ''}
    </div>`;
  }

  // Disabled rather than hidden: the control is real and about to work, and
  // hiding it would make the upgrade look like a different page. A pill that
  // silently re-queried and returned the same cumulative number either way
  // would be worse than either.
  const pills = OBS_RANGES.map(r =>
    `<button type="button" class="obs-range-pill${!custom && !bridged && sel.key === r.key ? ' active' : ''}"
       data-obs-range="${r.key}"${bridged ? ' disabled title="Date filtering needs the upgraded agent — these totals are cumulative"' : ''}>${r.label}</button>`).join('');

  const coverage = state.obsData && state.obsData.coverage;
  // Said plainly when it matters: a range reaching past the start of
  // recording will show flat zero for the part nobody was watching, and
  // "Data from ..." is too quiet a way to explain an empty chart.
  const coverageNote = bridged
    ? 'Cumulative since the agent started'
    : obsRangeOutrunsCoverage()
      ? `Recording starts ${formatDateTime(coverage.oldest)} — earlier is not in view`
      : (coverage && coverage.oldest ? `Data from ${formatDateTime(coverage.oldest)}` : '');

  // datetime-local wants a local, second-less value; the state holds ISO.
  const toLocalInput = (iso)=>{
    if(!iso) return '';
    const d = new Date(iso);
    if(isNaN(d.getTime())) return '';
    const pad = (n)=>String(n).padStart(2,'0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const dis = bridged ? ' disabled' : '';
  return `<div class="obs-toolbar${bridged ? ' obs-toolbar-bridged' : ''}">
    <div class="obs-range-pills">${pills}</div>
    <div class="obs-custom-range">
      <input type="datetime-local" id="obsFrom" value="${toLocalInput(custom ? sel.from : range.from)}" aria-label="Range start"${dis}>
      <span>→</span>
      <input type="datetime-local" id="obsTo" value="${toLocalInput(custom ? sel.to : range.to)}" aria-label="Range end"${dis}>
      <button type="button" class="obs-range-pill${custom && !bridged ? ' active' : ''}" id="obsApplyRange"${dis}>Apply</button>
    </div>
    <span class="obs-toolbar-spacer"></span>
    ${envGap ? `<span class="obs-env-gap">${escapeHtml(envGap)}</span>` : ''}
    ${renderObsDuplicateWarning()}
    ${coverageNote ? `<span class="obs-coverage-note">${escapeHtml(coverageNote)}</span>` : ''}
  </div>`;
}

/* Buckets written before the agent stopped counting one request several times
   keep their inflated numbers, because a rollup row is immutable by design -
   the whole tier works by summing on conflict, so there is no "correct it
   later" operation and adding one would break the property that makes ingest
   lock-free.

   They also outlive the fix by more than a year: minute rollups are folded
   into HOURLY rollups at 30 days, and those are kept for 400.

   Retroactively halving them was considered and rejected. The duplication
   factor was not constant - two log lines for most requests, nine for one
   observed case - so any arithmetic correction would be a guess presented as
   data, which is worse than an inflated number that says it is inflated. */
const OBS_DUP_FIX_ISO = '2026-09-25T08:00:00.000Z';

function obsRangeReachesDuplicates(){
  if(typeof obsResolvedRange !== 'function') return false;
  const r = obsResolvedRange();
  const from = Date.parse(r.from);
  return isFinite(from) && from < Date.parse(OBS_DUP_FIX_ISO);
}

function renderObsDuplicateWarning(){
  if(obsIsBridged() || !obsRangeReachesDuplicates()) return '';
  return `<span class="obs-dup-note" title="The collector used to count each request once per log line it produced, and this deployment logs most requests at least twice. Counts, error rates and source-IP totals from before ${formatDateTime(OBS_DUP_FIX_ISO)} are inflated by roughly that factor. Rollup rows are immutable, so they cannot be corrected in place — and the duplication factor varied per request, so estimating a correction would be a guess presented as data.">Includes pre-${formatDateTime(OBS_DUP_FIX_ISO)} counts, which are inflated by duplicate log lines</span>`;
}

/* The API or endpoint the sidebar has selected, stated on the page itself.
   A scope you set on the left and cannot see on the right is a scope you
   forget you set - and then every number on the page is quietly answering a
   narrower question than the one being asked of it. */
function renderObsScopeBar(){
  const scope = state.obsScope;
  if(!scope || scope.type === 'all') return '';
  const cov = typeof obsScopeCoverage === 'function' ? obsScopeCoverage() : null;
  const title = scope.type === 'key'
    ? scope.key
    : (scope.name || 'Selected API');
  const unresolved = cov ? cov.selected - cov.resolved : 0;
  return `<div class="obs-scope-bar">
    <span class="obs-scope-bar-label">Showing</span>
    <span class="obs-scope-bar-name mono">${escapeHtml(title)}</span>
    ${cov && scope.type !== 'key'
      ? `<span class="obs-scope-bar-count">${cov.resolved} of ${cov.selected} endpoint(s)</span>` : ''}
    ${unresolved > 0
      ? `<span class="obs-scope-bar-warn" title="These endpoints have traffic but no document in this workspace, so there is no id to filter their rollups by.">${unresolved} not filterable</span>`
      : ''}
    <button type="button" class="obs-scope-bar-clear" id="obsClearScopeNew">Show all traffic</button>
  </div>`;
}

function renderObsTabs(){
  const d = state.obsData;
  const errCount = d && d.current ? d.current.errCount : 0;
  // Only FIRING alerts get a badge. A pending one has notified nobody, and a
  // count that included them would claim an incident that may never happen.
  // Acknowledged ones are excluded too - acknowledging says "someone is on
  // this", and the badge exists to draw attention to what nobody has picked
  // up yet, not to nag about something already being worked.
  const allFiring = ((state.obsAlerts && state.obsAlerts.active) || []).filter(a => a.status === 'firing');
  const firing = allFiring.filter(a => !a.acknowledgedAt).length;
  const acked = allFiring.length - firing;
  const counts = {
    errors: errCount ? obsFormatCount(errCount) : '',
    alerts: firing ? String(firing) : '',
  };
  // The figure is how many errors fall in the SELECTED RANGE, not how many
  // are unread — it does not clear by visiting the tab, it clears when the
  // range holds no errors. Said in the tooltip because the shape of a
  // number beside a tab name implies otherwise.
  const countTitle = `${errCount.toLocaleString()} error(s) in the selected range`;
  const titles = {
    errors: countTitle,
    alerts: `${firing} unacknowledged alert(s) firing right now — independent of the range above`
      + (acked ? ` (${acked} more firing but already acknowledged)` : ''),
  };
  return `<div class="obs-tabs" role="tablist">
    ${OBS_TABS.map(t => `<button type="button" role="tab" class="obs-tab${state.obsTab === t.key ? ' active' : ''}"
      data-obs-tab="${t.key}" aria-selected="${state.obsTab === t.key}">${t.label}${
        counts[t.key] ? `<span class="obs-tab-count${
          (t.key === 'errors' && errCount) || t.key === 'alerts' ? ' crit' : ''}"
          title="${escapeHtml(titles[t.key] || '')}">${counts[t.key]}</span>` : ''
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
      const shown = k === 'endpointId' ? obsEndpointLabel(v) : (k === 'minLatencyMs' ? `${v}ms`
        : (k === 'statusFamily' && v === 'known' ? 'has a status' : v));
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

  /* deltaBadge() returns an empty string when there is nothing to compare
     against - most visibly when the previous window held zero requests,
     which is every window right after an agent starts. Joining the parts
     rather than concatenating a separator is what stops that becoming a
     subtitle that trails off in a bare "·". */
  const sub = (...parts)=> parts.filter(p => p !== null && p !== undefined && p !== '').join(' · ');

  return `<div class="kpi-grid">
    ${healthKpi('Requests', obsFormatCount(cur.total),
      sub(`${cur.endpointCount} endpoint(s)`,
          prev ? deltaBadge(cur.total, prev.total, 'pct', 'neutral') : '')
      + renderKpiSparkline(sparkTotals, '--accent'))}
    ${healthKpi('Error rate', errPct.toFixed(1) + '%',
      sub(`${obsFormatCount(cur.errCount)} error(s)`,
          prev ? deltaBadge(cur.errorRate, prev.errorRate, 'pp', 'down') : '')
      + renderKpiSparkline(sparkErrs, errColor), errColor)}
    ${lat ? healthKpi('Latency p95', lat.p95 + 'ms',
      sub(`p50 ${lat.p50}ms`, `p99 ${lat.p99}ms`,
          prev && prev.latency ? deltaBadge(lat.p95, prev.latency.p95, 'pct', 'down') : ''))
      : healthKpi('Latency p95', '—', obsIsBridged()
          ? 'Recorded by the upgraded agent'
          : 'No durations parsed from these log lines')}
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
  const bridged = obsIsBridged();
  return `
    ${renderObsKpis()}
    <div class="obs-panel">
      <div class="section-head">
        <div>
          <div class="section-title">Traffic over time</div>
          <div class="hint" style="margin-top:-4px;">${bridged
            ? 'Needs the upgraded agent — the counters below have no time dimension'
            : 'Requests by status family · error rate on the right axis · click a colour to see those requests'}</div>
        </div>
      </div>
      ${bridged
        ? obsPendingPanel('Traffic over time starts the moment the agent pushes',

            `The current agent reports one running total per endpoint, so there is nothing to plot against a clock — `
            + `the ${obsFormatCount(cur.total)} requests below are real, but they're a sum, not a history. `
            + `The upgraded agent writes one bucket per minute, and this becomes a stacked chart by status family `
            + `with error rate on the right axis.`)
        : renderTrafficChart(d.series || [], { coverageStart: obsCoverageStart() })}
    </div>

    <div class="grid2">
      <div class="obs-panel obs-panel-fill">
        <div class="section-title">Status code breakdown</div>
        <div class="hint" style="margin-top:-4px;">${obsFormatCount(cur.total)} response(s) ${bridged ? 'in total' : 'in this range'} · click a row to drill in</div>
        ${(cur.statusBreakdown.unknown || 0) > 0 ? `<div class="hint" style="margin-top:6px;">
          Every status from 400–499 is counted as <b>4xx</b> and every status from 500–599 as
          <b>5xx</b>, whatever the code — a 504 is a 5xx here, the same as a 500.
          <b>Unclassified</b> is what is left: a request whose log line carried <i>no status at
          all</i>, so its outcome was never written down. It is counted separately and is
          deliberately <b>not</b> part of the error rate. Click the row to list those exact requests.
          <br>
          One case worth knowing: these figures come from the <b>Mule application log</b>, so a
          response produced <i>in front of</i> Mule — a gateway or load balancer returning 504
          because it gave up waiting — is not in that log. What lands here is Mule's own eventual
          outcome, or nothing at all if the flow never finished.
        </div>` : ''}
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
      <div class="obs-empty-body">${obsEmptyRangeHint()}</div></div>`;
  }
  return `<div class="obs-statusbreakdown-body">
    <div class="obs-statusbar">${present.map(f =>
      `<span style="width:${((cur.statusBreakdown[f]||0)/total*100)}%;background:${OBS_STATUS_COLORS[f]};"
        title="${f}: ${(cur.statusBreakdown[f]||0).toLocaleString()}"></span>`).join('')}</div>
    <div class="obs-histo">
      ${fams.map((f,i)=>{
        const c = counts[i];
        if(!c) return '';
        // Bar width = the share printed next to it. Scaling to the largest
        // family instead made the biggest one always look like 100%.
        const share = Math.round((c/total)*1000)/10;
        return `<div class="obs-histo-row obs-clickable" data-obs-filter-family="${f}" title="${f}: ${c.toLocaleString()} of ${total.toLocaleString()} response(s) — ${share}%">
          <span class="obs-histo-label" style="color:${OBS_STATUS_COLORS[f]};font-weight:800;">${f}</span>
          <span class="obs-ip-bar-track"><span class="obs-ip-bar" style="width:${Math.max(share,1.5)}%;background:${OBS_STATUS_COLORS[f]};"></span></span>
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
  return `<div class="obs-histo obs-histo-wide" style="margin-top:22px;">
    ${ips.map(x=>{
      const cls = typeof classifyIp === 'function' ? classifyIp(x.ip) : 'unknown';
      const dot = cls === 'internal' ? 'var(--accent)' : cls === 'external' ? 'var(--put)' : 'var(--text-faint)';
      // Share of all traffic, matching the number printed beside it. Drawn
      // relative to the busiest IP instead, the top row was always a full
      // bar whether it carried 90% of traffic or 9%.
      const share = cur.total ? Math.round((x.count/cur.total)*1000)/10 : 0;
      return `<div class="obs-histo-row obs-clickable" data-obs-filter-ip="${escapeHtml(x.ip)}" title="${escapeHtml(x.ip)} — ${x.count.toLocaleString()} of ${cur.total.toLocaleString()} request(s), ${share}%">
        <span class="obs-histo-label mono">${escapeHtml(x.ip)}</span>
        <span class="obs-ip-bar-track"><span class="obs-ip-bar" style="width:${Math.max(share,1.5)}%;background:${dot};"></span></span>
        <span class="obs-ip-count">${obsFormatCount(x.count)} <span style="opacity:.7;">(${share}%)</span></span>
      </div>`;
    }).join('')}
  </div>`;
}

function renderObsPerformanceTab(){
  const d = state.obsData;
  const cur = d.current;
  const bridged = obsIsBridged();
  const eps = (d.endpoints || []).filter(e => e.latency).slice();
  eps.sort((a,b)=> (b.latency.p95 || 0) - (a.latency.p95 || 0));
  const slowest = eps.slice(0, 12);

  const latencyPending = obsPendingPanel('Latency needs the upgraded agent',
    `Durations are in the log lines already — the current agent doesn't keep them. The upgraded one `
    + `records a latency histogram per minute, which is what makes a p95 over any range a real number `
    + `rather than an average of averages.`);

  return `
    <div class="grid2">
      <div class="obs-panel">
        <div class="section-title">Latency distribution</div>
        <div class="hint" style="margin-top:-4px;">Where the time actually goes — a second clump here is invisible in p50/p95/p99 alone</div>
        ${bridged ? latencyPending : renderLatencyHistogram(cur.latencyBuckets, cur.latency)}
      </div>
      <div class="obs-panel">
        <div class="section-title">Slowest endpoints</div>
        <div class="hint" style="margin-top:-4px;">By p95 ${bridged ? '— not available yet' : 'in this range · click to filter'}</div>
        ${bridged ? latencyPending : slowest.length ? `<div class="obs-histo obs-histo-wide" style="margin-top:18px;">
          ${(()=>{
            const max = Math.max(...slowest.map(e=>e.latency.p95||0), 1);
            return slowest.map(e=>`
              <div class="obs-histo-row obs-clickable" data-obs-filter-endpoint="${escapeHtml(e.endpointId)}"
                   title="${escapeHtml(obsEndpointLabel(e.endpointId))} — p95 ${e.latency.p95}ms over ${e.total.toLocaleString()} request(s)">
                <span class="obs-histo-label mono">${escapeHtml(obsEndpointLabel(e.endpointId))}</span>
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
      <div class="hint" style="margin-top:-4px;">${(d.endpoints||[]).length} endpoint(s) with traffic ${bridged ? 'since the agent started' : 'in this range'} · click a row to drill in</div>
      ${renderObsEndpointTable(d.endpoints || [], { paged: true })}
    </div>`;
}

const OBS_ENDPOINT_PAGE_SIZE = 25;

/* Paged and searchable. 382 endpoints in one unbroken table is not a table
   anyone reads - and rendering every row on every re-render, several times a
   minute under the live stream, is work nobody asked for. `opts.paged` is
   false for the Errors tab, which is already a short filtered list. */
function renderObsEndpointTable(endpoints, opts){
  const o = opts || {};
  if(!endpoints.length){
    return `<div class="obs-empty"><div class="obs-empty-title">No endpoints reported traffic</div>
      <div class="obs-empty-body">${obsEmptyRangeHint()}</div></div>`;
  }

  let rows = endpoints;
  let pager = '';
  let search = '';
  if(o.paged){
    const q = (state.obsEndpointSearch || '').trim().toLowerCase();
    if(q) rows = rows.filter(e => obsEndpointLabel(e.endpointId).toLowerCase().includes(q));
    const pages = Math.max(1, Math.ceil(rows.length / OBS_ENDPOINT_PAGE_SIZE));
    // A filter that shrinks the list below the current page would otherwise
    // leave someone staring at an empty table on page 7 of 1.
    const page = Math.min(Math.max(1, state.obsEndpointPage || 1), pages);
    state.obsEndpointPage = page;
    const start = (page - 1) * OBS_ENDPOINT_PAGE_SIZE;
    search = `<input type="search" id="obsEndpointSearch" class="obs-table-search"
      placeholder="Filter by method or path…" value="${escapeHtml(state.obsEndpointSearch || '')}"
      aria-label="Filter endpoints">`;
    pager = `<div class="obs-health-pager">
      <button type="button" class="obs-health-pager-page" id="obsEpPrev" ${page <= 1 ? 'disabled' : ''}>Previous</button>
      <span class="obs-health-pager-label">${rows.length
        ? `${(start + 1).toLocaleString()}–${Math.min(start + OBS_ENDPOINT_PAGE_SIZE, rows.length).toLocaleString()} of ${rows.length.toLocaleString()}`
        : 'No matches'}${q ? ` (filtered from ${endpoints.length.toLocaleString()})` : ''} · page ${page} of ${pages}</span>
      <button type="button" class="obs-health-pager-page" id="obsEpNext" ${page >= pages ? 'disabled' : ''}>Next</button>
    </div>`;
    rows = rows.slice(start, start + OBS_ENDPOINT_PAGE_SIZE);
  }

  if(!rows.length){
    return `${search}<div class="obs-empty"><div class="obs-empty-title">No endpoint matches that filter</div>
      <div class="obs-empty-body">Clear the filter to see all ${endpoints.length.toLocaleString()} endpoint(s).</div></div>${pager}`;
  }
  endpoints = rows;
  /* 4xx, 5xx and unclassified each get their own column rather than being
     folded into one "Errors" number. They are not interchangeable: a 4xx is
     usually the caller's problem, a 5xx is ours, and an unclassified
     response is neither - it is a request whose outcome was never logged,
     which is a gap in the logging rather than a failure. Summing them into
     one figure hid exactly the distinction worth acting on. */
  const cell = (n, colorVar)=> n
    ? `<td class="num" style="color:var(${colorVar});font-weight:700;">${obsFormatCount(n)}</td>`
    : `<td class="num" style="color:var(--text-faint);opacity:.45;">0</td>`;

  return `${search}<div class="obs-table-scroll"><table class="data-table obs-data-table">
    <thead><tr>
      <th>Endpoint</th><th class="num">Requests</th>
      <th class="num" title="Successful responses">2xx</th>
      <th class="num" title="Client errors — counted in the error rate">4xx</th>
      <th class="num" title="Server errors — counted in the error rate">5xx</th>
      <th class="num" title="No status code was logged for these requests — NOT counted as errors">Unclassified</th>
      <th class="num">Error rate</th><th class="num">p95</th><th>Last seen</th>
    </tr></thead>
    <tbody>
      ${endpoints.map(e=>{
        const rate = e.errorRate * 100;
        const b = e.statusBreakdown || {};
        const color = rate >= 25 ? 'var(--st-5)' : rate >= 5 ? 'var(--st-4)' : 'var(--text-faint)';
        const unknown = b.unknown || 0;
        return `<tr class="obs-clickable" data-obs-filter-endpoint="${escapeHtml(e.endpointId)}">
          <td class="mono">${escapeHtml(obsEndpointLabel(e.endpointId))}</td>
          <td class="num">${obsFormatCount(e.total)}</td>
          ${cell(b['2xx'] || 0, '--st-2')}
          ${cell(b['4xx'] || 0, '--st-4')}
          ${cell(b['5xx'] || 0, '--st-5')}
          ${unknown
            ? `<td class="num" style="color:var(--text-faint);font-weight:700;"
                   title="${unknown.toLocaleString()} request(s) with no status code in the log line">${obsFormatCount(unknown)}</td>`
            : `<td class="num" style="color:var(--text-faint);opacity:.45;">0</td>`}
          <td class="num" style="color:${color};font-weight:700;">${rate.toFixed(1)}%</td>
          <td class="num">${e.latency ? e.latency.p95 + 'ms' : '—'}</td>
          <td>${e.lastSeenAt ? formatDateTime(e.lastSeenAt) : '—'}</td>
        </tr>`;
      }).join('')}
    </tbody>
  </table></div>${pager}`;
}

function renderObsErrorsTab(){
  const d = state.obsData;
  const cur = d.current;
  const bridged = obsIsBridged();
  const failing = (d.endpoints || []).filter(e => e.errCount > 0).slice();
  failing.sort((a,b)=> b.errorRate - a.errorRate || b.errCount - a.errCount);

  if(!cur.errCount){
    return `<div class="obs-panel"><div class="obs-empty">
      <div class="obs-empty-title">No errors ${bridged ? 'recorded' : 'in this range'}</div>
      <div class="obs-empty-body">Every classified response was 2xx or 3xx.${bridged ? '' : ' ' + obsEmptyRangeHint()}</div>
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
      <div class="hint" style="margin-top:-4px;">${obsFormatCount(cur.errCount)} error(s) — ${(cur.errorRate*100).toFixed(1)}% of ${bridged ? 'all traffic so far' : 'traffic in this range'}</div>
      ${bridged
        ? obsPendingPanel('Error history starts with the upgraded agent',
            `The ${obsFormatCount(cur.errCount)} errors below are real and attributed to the right endpoints. `
            + `What a running total can't answer is <i>when</i> — whether this is a steady trickle or one bad `
            + `ten minutes. That's the question the upgraded agent's per-minute buckets answer.`)
        : renderTrafficChart(errSeries, { hideLegend: true, coverageStart: obsCoverageStart() })}
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

  // Before the upgraded agent exists, the reason this tab is empty is not
  // capture mode — it's that nothing is writing records at all. Saying
  // "turn on CAPTURE_MODE=full" here would send someone to change a setting
  // that would not help yet.
  if(obsIsBridged()){
    const kept = state.obsData.recordCount || 0;
    return `<div class="obs-panel"><div class="obs-empty">
      <div class="obs-empty-title">Per-request rows start with the upgraded agent</div>
      <div class="obs-empty-body">
        This tab lists individual requests — timestamp, endpoint, status, latency, source IP and
        correlation id — and is what every "click a number to see the requests behind it" action
        opens. The current agent only reports counters, so there is nothing to list.
        Once the upgraded agent is running, set <code>CAPTURE_MODE=full</code> to fill this in;
        credential-named fields are always redacted and rows are kept for 7 days.
        ${kept ? `<br><br>The previous layout still has ${kept.toLocaleString()} record(s) this agent captured earlier.` : ''}
      </div>
    </div></div>`;
  }

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

  // If the agent is sampling successes, say so here rather than letting
  // someone count these rows and draw a conclusion from a number that was
  // never meant to be the total. Errors are never sampled and the counters
  // above are exact, so the caveat belongs on this panel only.
  const health = (state.endpointMetrics && state.endpointMetrics.agentHealth) || {};
  const sampleRate = Number(health.captureSuccessSampleRate) || 1;
  const samplingNote = sampleRate > 1
    ? `<div class="obs-win-truncated">Showing <b>1 in ${sampleRate}</b> successful requests — every 4xx and 5xx is kept in full.
       Totals, error rates and latency percentiles above are exact and unaffected by this.</div>`
    : '';

  return `
    <div class="obs-panel">
      <div class="section-head">
        <div>
          <div class="section-title">Requests</div>
          <div class="hint" style="margin-top:-4px;">${r.total.toLocaleString()} matching request(s) in this range</div>
        </div>
        <div style="display:flex;align-items:center;gap:12px;">
          ${filters.statusFamily === 'known'
            ? `<button type="button" class="obs-ip-more" data-obs-clear-filter="statusFamily">Show all requests</button>`
            : `<button type="button" class="obs-ip-more" data-obs-filter-family="known"
                 title="Hide rows with no status, latency or source — these carry no diagnostic value on their own, whether they're a duplicate or a genuinely partial observation">Hide requests with no status</button>`}
          <span class="obs-drill-hint">Newest first</span>
        </div>
      </div>
      ${samplingNote}
      ${r.records.length ? `<div class="obs-table-scroll"><table class="data-table obs-data-table">
        <thead><tr><th>When</th><th>Endpoint</th><th class="num">Status</th><th class="num">Latency</th><th>Source</th><th>Correlation</th></tr></thead>
        <tbody>
          ${r.records.map(rec=>{
            const fam = rec.statusCode ? String(rec.statusCode)[0] + 'xx' : 'unknown';
            return `<tr>
              <td class="mono">${formatDateTime(rec.ts)}</td>
              <td class="mono">${escapeHtml(obsRecordLabel(rec))}</td>
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
      ${r.records.length ? `<div class="obs-health-pager">
        <button type="button" class="obs-health-pager-page" id="obsRecPrev" ${state.obsRecordsPage <= 1 ? 'disabled' : ''}>Previous</button>
        <span class="obs-health-pager-label">${(r.offset + 1).toLocaleString()}–${(r.offset + r.records.length).toLocaleString()} of ${r.total.toLocaleString()} · page ${state.obsRecordsPage} of ${pages}</span>
        <button type="button" class="obs-health-pager-page" id="obsRecNext" ${state.obsRecordsPage >= pages ? 'disabled' : ''}>Next</button>
      </div>` : ''}
    </div>`;
}

/* --- Alerts ---------------------------------------------------------------
   Three panels, in the order the questions get asked:

     1. What is wrong RIGHT NOW          (everyone)
     2. What are we watching for         (everyone reads, Admin edits)
     3. Who hears about it, and when     (Admin only)

   Rules are shown to non-Admins deliberately. A threshold you cannot see is
   indistinguishable from no threshold, and "why didn't we get alerted?" is
   not a question that should require an Admin to answer. */

const OBS_ALERT_SEV = { critical: '--delete', warning: '--put' };

function obsAlertMetricMeta(key){
  const list = (state.obsAlerts && state.obsAlerts.metrics) || [];
  return list.find(m => m.key === key) || { key, label: key, unit: '', kind: 'gauge', help: '' };
}

// Which console tab actually shows the thing this alert is about. An
// absence measure (agent_silent) has no rate or latency to chart — the tab
// that answers it is the one with the agent's own last-seen timestamp.
// Everything else maps to whichever tab already charts that measure, so a
// click lands somewhere that explains the number rather than a generic
// "here's the app" landing page.
function obsAlertDrillDownTab(metric){
  if(obsAlertMetricMeta(metric).kind === 'absence') return 'agent';
  if(metric === 'latency_p95' || metric === 'latency_p99') return 'performance';
  if(metric === 'request_rate') return 'overview';
  return 'errors'; // error_rate, server_error_rate, client_error_rate, unclassified_rate
}

// The single entry point for "an alert row was clicked" — sets the header
// environment to where the alert actually fired (an alert about SIT means
// nothing while looking at UAT), scopes the console to the one endpoint if
// the rule is endpoint-scoped, and opens the tab that explains the number.
// Environment-restricted the same way the header's own switcher is, so this
// never lands a viewer on data their role can't see.
function obsGoToAlert(env, metric, endpointId){
  if(!isAdmin() && !ownsAnyProject()){
    toast("You don't have access to Observability.");
    return;
  }
  if(env && !roleAllowsEnv(env)){
    const meta = envMeta(env);
    toast(meta.restricted ? `${meta.label} is restricted to Admins` : `An Admin hasn't granted you access to ${meta.label} yet`);
    return;
  }
  if(env && env !== state.env){ state.env = env; saveEnv(); applyEnvAccent(); applyRoleGatedUI(); }
  state.selected = { type: 'observability' };
  state.obsTab = obsAlertDrillDownTab(metric);
  state.obsScope = endpointId ? { type: 'key', key: obsEndpointLabel(endpointId) } : { type: 'all' };
  state.obsRecords = null;
  state.obsRecordsPage = 1;
  state.obsEndpointPage = 1;
  renderEnvSwitcher(); renderSidebar(); renderMain(); renderRail();
  if(typeof obsLoad === 'function') obsLoad({ quiet: true });
  if(state.obsTab === 'logs' && typeof obsLoadRecordsPage === 'function') obsLoadRecordsPage();
}

function obsAlertRuleSummary(r){
  const m = obsAlertMetricMeta(r.metric);
  const where = r.scope === 'endpoint'
    ? (r.endpointId ? obsEndpointLabel(r.endpointId) : 'any endpoint')
    : (r.environment || 'every environment');
  if(m.kind === 'absence'){
    return `${m.label} ${r.comparison} ${r.threshold}${m.unit} · ${where}`;
  }
  return `${m.label} ${r.comparison} ${r.threshold}${m.unit} for ${r.forMinutes}m `
    + `· ${r.windowMinutes}m window · min ${r.minRequests} req · ${where}`;
}

function renderObsAlertsTab(){
  const d = state.obsAlerts;
  if(state.obsAlertsStatus === 'idle' || (state.obsAlertsStatus === 'loading' && !d)){
    return `<div class="obs-panel"><span class="obs-skeleton-line short"></span>
      <div class="obs-skeleton-chart"></div></div>`;
  }
  if(state.obsAlertsStatus === 'error' && !d){
    return `<div class="obs-panel"><div class="obs-empty">
      <div class="obs-empty-title">Could not load alert configuration</div>
      <div class="obs-empty-body">${escapeHtml(state.obsAlertsError)}</div>
    </div></div>`;
  }
  if(!d) return '';
  return renderObsActiveAlerts(d)
    + renderObsAlertRules(d)
    + (d.canEdit ? renderObsAlertSettings(d) : '')
    + renderObsAlertHistory();
}

function renderObsActiveAlerts(d){
  const active = d.active || [];
  const firing = active.filter(a => a.status === 'firing');
  const pending = active.filter(a => a.status === 'pending');

  if(!active.length){
    return `<div class="obs-panel">
      <div class="section-title">Currently firing</div>
      <div class="hint" style="margin-top:-4px;">Evaluated on the server every minute, whether or not this page is open</div>
      <div class="obs-alert-clear">
        <span class="obs-alert-clear-dot"></span>
        <div>
          <b>Nothing is firing.</b>
          ${d.settings && d.settings.enabled === false
            ? '<span class="obs-alert-off"> — but alerting is switched OFF, so nothing would fire either way.</span>'
            : ` ${(d.rules || []).filter(r => r.enabled).length} rule(s) are being evaluated.`}
        </div>
      </div>
    </div>`;
  }

  const row = (a)=>{
    const m = obsAlertMetricMeta(a.metric);
    const color = OBS_ALERT_SEV[a.severity] || '--put';
    const where = [a.environment, a.endpointId ? obsEndpointLabel(a.endpointId) : null].filter(Boolean).join(' · ');
    // Where clicking this row actually takes you — said out loud on the row
    // itself, not left to a bare cursor change, since a row that merely
    // LOOKED clickable and did nothing is exactly the complaint this fixes.
    const destTab = OBS_TABS.find(t => t.key === obsAlertDrillDownTab(a.metric));
    const acked = a.status === 'firing' && !!a.acknowledgedAt;
    // Acknowledging is its own click target inside a row that is otherwise
    // one big click target (the drill-down) - it stops that click from also
    // propagating up and navigating away, see wireObsAlerts() below.
    const ackControl = a.status !== 'firing' ? ''
      : acked
        ? `<div class="obs-alert-acked" title="Acknowledged ${escapeHtml(formatDateTime(a.acknowledgedAt))}">
             <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
             Acknowledged by ${escapeHtml(a.acknowledgedBy || 'someone')}
           </div>`
        : `<button type="button" class="obs-alert-ack-btn" data-obs-alert-ack
             data-obs-alert-ack-rule="${escapeHtml(a.ruleId)}" data-obs-alert-ack-env="${escapeHtml(a.environment || '')}"
             data-obs-alert-ack-epid="${escapeHtml(a.endpointId || '')}"
             title="Mark that someone has seen this and is on it. Does not silence it — it keeps being evaluated and re-notifying, this only clears the tab badge.">Acknowledge</button>`;
    // NOT .obs-alert-row — that class name is already used by 23-observability.js's
    // unrelated legacy anomaly digest and carries its own conflicting :hover rule
    // (different padding/margin/radius), which would fight this row's layout on
    // hover. .obs-alert-live-row is this panel's own, so the two never collide.
    return `<div class="obs-alert-live-row obs-alert-${a.status}${acked ? ' obs-alert-acked-row' : ''}" style="--obs-alert-color:var(${color});"
      role="button" tabindex="0"
      data-obs-alert-goto data-obs-alert-env="${escapeHtml(a.environment || '')}"
      data-obs-alert-metric="${escapeHtml(a.metric)}" data-obs-alert-epid="${escapeHtml(a.endpointId || '')}"
      title="Open ${escapeHtml(destTab ? destTab.label : 'Observability')}${a.environment ? ' for ' + escapeHtml(a.environment) : ''}">
      <span class="obs-alert-pip"></span>
      <div class="obs-alert-main">
        <div class="obs-alert-name">${escapeHtml(a.name)}</div>
        <div class="obs-alert-where mono">${escapeHtml(where)}</div>
      </div>
      <div class="obs-alert-value">
        <div class="obs-alert-now mono">${escapeHtml(a.display)}</div>
        <div class="obs-alert-thresh">${escapeHtml(a.comparison)} ${escapeHtml(String(a.threshold))}${escapeHtml(m.unit)}</div>
      </div>
      <div class="obs-alert-since">
        ${a.status === 'pending'
          // Said plainly: a pending alert has NOT notified anyone, and a row
          // that looked identical to a firing one would imply it had.
          ? `<span class="obs-alert-tag">waiting to confirm</span><div class="hint">nobody notified yet</div>`
          : `<span class="obs-alert-tag crit">firing</span><div class="hint">since ${escapeHtml(formatDateTime(a.since))}${
              a.notifyCount ? ` · ${a.notifyCount} notification(s)` : ''}</div>`}
      </div>
      ${ackControl}
      <span class="obs-alert-goto-ic" aria-hidden="true">${destTab ? escapeHtml(destTab.label) : 'Investigate'} →</span>
    </div>`;
  };

  return `<div class="obs-panel">
    <div class="section-head">
      <div>
        <div class="section-title">Currently firing</div>
        <div class="hint" style="margin-top:-4px;">Evaluated on the server every minute, whether or not this page is open</div>
      </div>
      ${d.canEdit ? `<button type="button" class="obs-ip-more" id="obsAlertEvalNow">Evaluate now</button>` : ''}
    </div>
    ${firing.map(row).join('')}
    ${pending.length ? `<div class="obs-alert-sub">Breaching, but not yet held long enough to notify</div>` : ''}
    ${pending.map(row).join('')}
  </div>`;
}

function renderObsAlertRules(d){
  const rules = d.rules || [];
  const editing = state.obsAlertDraft;
  return `<div class="obs-panel">
    <div class="section-head">
      <div>
        <div class="section-title">Alert rules</div>
        <div class="hint" style="margin-top:-4px;">What the server watches for${
          d.canEdit ? '' : ' · only an Admin can change these'}</div>
      </div>
      ${d.canEdit ? `<button type="button" class="obs-ip-more" id="obsAlertNew">+ New rule</button>` : ''}
    </div>
    ${editing ? renderObsAlertEditor(d, editing) : ''}
    ${!rules.length ? `<div class="obs-empty"><div class="obs-empty-title">No rules yet</div>
      <div class="obs-empty-body">Nothing is being watched for. Add a rule to start.</div></div>` : ''}
    <div class="obs-alert-rules">
      ${rules.map(r => `<div class="obs-alert-rule${r.enabled ? '' : ' off'}">
        <span class="obs-alert-sev" style="background:var(${OBS_ALERT_SEV[r.severity] || '--put'});"
              title="${r.severity === 'critical' ? 'Critical' : 'Warning'}"></span>
        <div class="obs-alert-rule-main">
          <div class="obs-alert-rule-name">${escapeHtml(r.name)}${
            r.enabled ? '' : ' <span class="obs-alert-off-tag">disabled</span>'}</div>
          <div class="obs-alert-rule-def mono">${escapeHtml(obsAlertRuleSummary(r))}</div>
        </div>
        <div class="obs-alert-rule-cool hint">re-notify every ${r.cooldownMinutes}m</div>
        ${d.canEdit ? `<div class="obs-alert-rule-actions">
          <button type="button" class="obs-ip-more" data-obs-alert-edit="${escapeHtml(r.id)}">Edit</button>
          <button type="button" class="obs-ip-more danger" data-obs-alert-del="${escapeHtml(r.id)}">Delete</button>
        </div>` : ''}
      </div>`).join('')}
    </div>
  </div>`;
}

function renderObsAlertEditor(d, r){
  const metrics = d.metrics || [];
  const meta = obsAlertMetricMeta(r.metric);
  const isAbsence = meta.kind === 'absence';
  const envs = state.obsEnvOptions || [];
  const num = (id, label, value, help)=>`<label class="obs-alert-field">
    <span>${escapeHtml(label)}</span>
    <input type="number" id="${id}" value="${value === null || value === undefined ? '' : escapeHtml(String(value))}" min="0">
    ${help ? `<em>${escapeHtml(help)}</em>` : ''}
  </label>`;
  return `<div class="obs-alert-editor">
    <div class="obs-alert-editor-head">${r.id ? 'Edit rule' : 'New rule'}</div>
    <label class="obs-alert-field wide">
      <span>Name</span>
      <input type="text" id="obsAlertName" value="${escapeHtml(r.name || '')}" placeholder="What is this watching for?">
    </label>
    <label class="obs-alert-field wide">
      <span>Measure</span>
      <select id="obsAlertMetric">${metrics.map(m =>
        `<option value="${escapeHtml(m.key)}"${m.key === r.metric ? ' selected' : ''}>${escapeHtml(m.label)} (${escapeHtml(m.unit)})</option>`).join('')}</select>
      <em>${escapeHtml(meta.help || '')}</em>
    </label>
    <label class="obs-alert-field">
      <span>When it goes</span>
      <select id="obsAlertComparison">
        <option value="above"${r.comparison !== 'below' ? ' selected' : ''}>above</option>
        <option value="below"${r.comparison === 'below' ? ' selected' : ''}>below</option>
      </select>
    </label>
    ${num('obsAlertThreshold', `Threshold (${meta.unit})`, r.threshold)}
    ${isAbsence ? '' : num('obsAlertWindow', 'Measured over (min)', r.windowMinutes,
      'How far back each evaluation looks')}
    ${isAbsence ? '' : num('obsAlertMinReq', 'Ignore below (requests)', r.minRequests,
      'A sample floor. Without it, one failed request at 3am is a 100% error rate.')}
    ${isAbsence ? '' : num('obsAlertFor', 'Must hold for (min)', r.forMinutes,
      'A deploy crosses most thresholds for a few seconds. This is what stops that waking anyone.')}
    ${num('obsAlertCooldown', 'Re-notify every (min)', r.cooldownMinutes,
      'While still firing. One incident should not be one notification per evaluation.')}
    <label class="obs-alert-field">
      <span>Severity</span>
      <select id="obsAlertSeverity">
        <option value="warning"${r.severity !== 'critical' ? ' selected' : ''}>Warning</option>
        <option value="critical"${r.severity === 'critical' ? ' selected' : ''}>Critical</option>
      </select>
      <em>Critical can be set to ignore quiet hours.</em>
    </label>
    <label class="obs-alert-field">
      <span>Environment</span>
      <select id="obsAlertEnv">
        <option value=""${!r.environment ? ' selected' : ''}>Every environment</option>
        ${envs.map(e => `<option value="${escapeHtml(e)}"${r.environment === e ? ' selected' : ''}>${escapeHtml(e)}</option>`).join('')}
      </select>
    </label>
    <label class="obs-alert-field">
      <span>Applies to</span>
      <select id="obsAlertScope"${isAbsence ? ' disabled title="Collector silence is a property of an environment, not of one endpoint"' : ''}>
        <option value="environment"${r.scope !== 'endpoint' ? ' selected' : ''}>The environment as a whole</option>
        <option value="endpoint"${r.scope === 'endpoint' ? ' selected' : ''}>Each endpoint separately</option>
      </select>
      <em>${isAbsence
        ? 'Fixed for this measure.'
        : 'Per endpoint means one rule and one independent alert per endpoint.'}</em>
    </label>
    <label class="obs-alert-field check">
      <input type="checkbox" id="obsAlertEnabled"${r.enabled !== false ? ' checked' : ''}>
      <span>Enabled</span>
    </label>
    <div class="obs-alert-editor-actions">
      <button type="button" class="obs-ip-more" id="obsAlertSave">${r.id ? 'Save changes' : 'Create rule'}</button>
      <button type="button" class="obs-ip-more" id="obsAlertCancel">Cancel</button>
    </div>
  </div>`;
}

function renderObsAlertSettings(d){
  const s = d.settings || {};
  const q = s.quietHours || {};
  const w = s.webhook || {};
  const hhmm = (mins)=>{
    const m = Math.max(0, Math.min(1439, Number(mins) || 0));
    return `${String(Math.floor(m / 60)).padStart(2,'0')}:${String(m % 60).padStart(2,'0')}`;
  };
  return `<div class="obs-panel">
    <div class="section-title">Notification settings</div>
    <div class="hint" style="margin-top:-4px;">Who hears about an alert, and when · organisation-wide</div>
    <div class="obs-alert-settings">
      <label class="obs-alert-field check">
        <input type="checkbox" id="obsAlertEnabledAll"${s.enabled !== false ? ' checked' : ''}>
        <span>Alerting is on</span>
        <em>The master switch. Off means no rule is evaluated and nothing is ever raised.</em>
      </label>
      <label class="obs-alert-field check">
        <input type="checkbox" id="obsAlertNotifyAdmins"${s.notifyAdmins !== false ? ' checked' : ''}>
        <span>Notify every Admin</span>
        <em>The default recipient set. Individual rules can add specific people on top.</em>
      </label>
      <label class="obs-alert-field check">
        <input type="checkbox" id="obsAlertQuiet"${q.enabled ? ' checked' : ''}>
        <span>Quiet hours</span>
        <em>Suppresses notifications only — rules keep being evaluated, so this page still
            shows what is firing. Nothing is lost, it is just not announced.</em>
      </label>
      <label class="obs-alert-field">
        <span>From</span>
        <input type="time" id="obsAlertQuietFrom" value="${hhmm(q.startMinute)}">
      </label>
      <label class="obs-alert-field">
        <span>Until</span>
        <input type="time" id="obsAlertQuietTo" value="${hhmm(q.endMinute)}">
      </label>
      <label class="obs-alert-field">
        <span>Time zone</span>
        <input type="text" id="obsAlertQuietTz" value="${escapeHtml(q.timezone || 'Asia/Kolkata')}"
               placeholder="Asia/Kolkata">
        <em>An IANA zone. An unrecognised one disables quiet hours rather than silencing everything.</em>
      </label>
      <label class="obs-alert-field check">
        <input type="checkbox" id="obsAlertQuietCrit"${q.allowCritical !== false ? ' checked' : ''}>
        <span>Critical alerts ignore quiet hours</span>
        <em>Leave on unless you genuinely want a 5xx storm to wait until morning.</em>
      </label>
      <label class="obs-alert-field check">
        <input type="checkbox" id="obsAlertWebhookEnabled"${w.enabled ? ' checked' : ''}>
        <span>Webhook</span>
        <em>POSTs a signed JSON payload on every fire/resolve — independent of who is
            subscribed to in-app notifications above. See ALERTING.md § Webhook delivery.</em>
      </label>
      <label class="obs-alert-field wide">
        <span>Webhook URL</span>
        <input type="url" id="obsAlertWebhookUrl" value="${escapeHtml(w.url || '')}"
               placeholder="https://example.com/hooks/doctracker">
      </label>
      <label class="obs-alert-field wide">
        <span>Webhook secret</span>
        <input type="password" id="obsAlertWebhookSecret" autocomplete="new-password"
               placeholder="${w.hasSecret ? 'Set — leave blank to keep it' : 'Not set — leave blank to send unsigned'}">
        <em>Signs each delivery (X-DocTracker-Signature). Write-only — never shown again once saved.</em>
      </label>
    </div>
    <div class="obs-alert-editor-actions">
      <button type="button" class="obs-ip-more" id="obsAlertSaveSettings">Save settings</button>
      <button type="button" class="obs-ip-more" id="obsAlertWebhookTest"${w.url ? '' : ' disabled title="Save a webhook URL first"'}>Send test webhook</button>
    </div>
  </div>`;
}

// The "incidents over time" view — alert_state only ever holds CURRENT
// state, so without this a resolved incident left no trace once the next
// evaluation overwrote its row. Readable by everyone, same as the active-
// alerts panel above (see ALERTING.md § Who can do what) — not gated by
// d.canEdit. Reuses .obs-alert-rule's row styling from renderObsAlertRules()
// rather than inventing new markup for what is visually the same kind of row.
function renderObsAlertHistory(){
  const h = state.obsAlertHistory;
  if(state.obsAlertHistoryStatus === 'idle'){
    return `<div class="obs-panel">
      <div class="section-head">
        <div>
          <div class="section-title">Incident history</div>
          <div class="hint" style="margin-top:-4px;">Past incidents, most recent first</div>
        </div>
        <button type="button" class="obs-ip-more" id="obsAlertHistoryLoad">Load history</button>
      </div>
    </div>`;
  }
  if(state.obsAlertHistoryStatus === 'loading' && !h){
    return `<div class="obs-panel"><span class="obs-skeleton-line short"></span></div>`;
  }
  if(state.obsAlertHistoryStatus === 'error' && !h){
    return `<div class="obs-panel"><div class="obs-empty">
      <div class="obs-empty-title">Could not load history</div>
      <div class="obs-empty-body">${escapeHtml(state.obsAlertHistoryError)}</div>
    </div></div>`;
  }
  const incidents = (h && h.incidents) || [];
  return `<div class="obs-panel">
    <div class="section-title">Incident history</div>
    <div class="hint" style="margin-top:-4px;">Past incidents, most recent first — resolved and still-open</div>
    ${!incidents.length ? `<div class="obs-empty"><div class="obs-empty-title">No incidents yet</div></div>` : `
    <div class="obs-alert-rules">
      ${incidents.map(i => `<div class="obs-alert-rule">
        <span class="obs-alert-sev" style="background:var(${OBS_ALERT_SEV[i.severity] || '--put'});"
              title="${i.severity === 'critical' ? 'Critical' : 'Warning'}"></span>
        <div class="obs-alert-rule-main">
          <div class="obs-alert-rule-name">${escapeHtml(i.ruleName)}${
            i.resolvedAt ? '' : ' <span class="obs-alert-off-tag">still open</span>'}</div>
          <div class="obs-alert-rule-def mono">${escapeHtml([i.environment, i.endpointId ? obsEndpointLabel(i.endpointId) : null].filter(Boolean).join(' · '))} · ${escapeHtml(i.display)}</div>
        </div>
        <div class="obs-alert-rule-cool hint">${escapeHtml(formatDateTime(i.startedAt))}${
          i.resolvedAt ? ` → ${escapeHtml(formatDateTime(i.resolvedAt))}` : ''}</div>
      </div>`).join('')}
    </div>`}
    ${h && h.hasMore ? `<div class="obs-alert-editor-actions"><button type="button" class="obs-ip-more" id="obsAlertHistoryLoad">Load more</button></div>` : ''}
  </div>`;
}

function obsAlertBlankRule(){
  return {
    id: null, name: '', metric: 'error_rate', comparison: 'above', threshold: 10,
    windowMinutes: 10, minRequests: 20, forMinutes: 5, cooldownMinutes: 60,
    severity: 'warning', environment: null, scope: 'environment', endpointId: null,
    enabled: true, notifyAdmins: true, notifyUserIds: [],
  };
}

function obsAlertReadEditor(main){
  const val = (id)=>{ const el = main.querySelector('#' + id); return el ? el.value : null; };
  const num = (id, dflt)=>{ const v = val(id); const n = parseInt(v, 10); return Number.isFinite(n) ? n : dflt; };
  const on = (id)=>{ const el = main.querySelector('#' + id); return el ? el.checked : false; };
  const draft = state.obsAlertDraft || obsAlertBlankRule();
  return {
    id: draft.id,
    name: val('obsAlertName') || '',
    metric: val('obsAlertMetric') || draft.metric,
    comparison: val('obsAlertComparison') || 'above',
    threshold: Number(val('obsAlertThreshold')),
    windowMinutes: num('obsAlertWindow', draft.windowMinutes),
    minRequests: num('obsAlertMinReq', draft.minRequests),
    forMinutes: num('obsAlertFor', draft.forMinutes),
    cooldownMinutes: num('obsAlertCooldown', draft.cooldownMinutes),
    severity: val('obsAlertSeverity') || 'warning',
    environment: val('obsAlertEnv') || null,
    scope: val('obsAlertScope') || 'environment',
    endpointId: draft.endpointId,
    enabled: on('obsAlertEnabled'),
    notifyAdmins: true,
    notifyUserIds: draft.notifyUserIds || [],
  };
}

function wireObsAlerts(main){
  if(state.obsTab !== 'alerts') return;
  // Loaded on first visit to the tab rather than with the console, so four
  // extra queries are not on the path of every page load for people who
  // never open it.
  if(state.obsAlertsStatus === 'idle' && typeof obsLoadAlerts === 'function'){
    state.obsAlertsStatus = 'loading';
    obsLoadAlerts();
    return;
  }

  main.querySelectorAll('[data-obs-alert-goto]').forEach(row=>{
    const go = ()=> obsGoToAlert(
      row.getAttribute('data-obs-alert-env') || null,
      row.getAttribute('data-obs-alert-metric'),
      row.getAttribute('data-obs-alert-epid') || null,
    );
    row.addEventListener('click', go);
    row.addEventListener('keydown', (e)=>{ if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); go(); } });
  });

  main.querySelectorAll('[data-obs-alert-ack]').forEach(btn=>{
    btn.addEventListener('click', async (e)=>{
      // The button sits inside the row's own click target (the drill-down
      // navigation) - without this, acknowledging would also navigate away
      // from the tab you're looking at.
      e.stopPropagation();
      btn.disabled = true; btn.textContent = 'Acknowledging…';
      try{
        const active = await obsAlertApi('POST', '/active/acknowledge', {
          ruleId: btn.getAttribute('data-obs-alert-ack-rule'),
          environment: btn.getAttribute('data-obs-alert-ack-env') || null,
          endpointId: btn.getAttribute('data-obs-alert-ack-epid') || null,
        });
        state.obsAlerts = { ...state.obsAlerts, active: active.active };
        renderMain();
      }catch(err){
        toast(err.message || 'Could not acknowledge the alert.');
        btn.disabled = false; btn.textContent = 'Acknowledge';
      }
    });
  });

  const evalNow = main.querySelector('#obsAlertEvalNow');
  if(evalNow) evalNow.addEventListener('click', async ()=>{
    evalNow.disabled = true; evalNow.textContent = 'Evaluating…';
    try{
      await obsAlertApi('POST', '/evaluate');
      toast('Rules evaluated against current data.');
    }catch(err){ toast(err.message || 'Could not evaluate.'); }
    obsLoadAlerts();
  });

  const newBtn = main.querySelector('#obsAlertNew');
  if(newBtn) newBtn.addEventListener('click', ()=>{
    state.obsAlertDraft = obsAlertBlankRule();
    renderMain();
  });

  main.querySelectorAll('[data-obs-alert-edit]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const id = btn.getAttribute('data-obs-alert-edit');
      const r = ((state.obsAlerts && state.obsAlerts.rules) || []).find(x => x.id === id);
      if(r){ state.obsAlertDraft = { ...r }; renderMain(); }
    });
  });

  main.querySelectorAll('[data-obs-alert-del]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const id = btn.getAttribute('data-obs-alert-del');
      const r = ((state.obsAlerts && state.obsAlerts.rules) || []).find(x => x.id === id);
      // Deleting a rule is how a system silently stops watching for something,
      // so it asks first and the deletion is audited server-side.
      if(!confirm(`Delete "${r ? r.name : 'this rule'}"? Nothing will watch for this any more.`)) return;
      try{
        await obsAlertApi('DELETE', `/rules/${encodeURIComponent(id)}`);
        toast('Rule deleted.');
      }catch(err){ toast(err.message || 'Could not delete the rule.'); }
      obsLoadAlerts();
    });
  });

  // Changing the measure re-renders the editor: the unit, the help text and
  // whether the window/sample fields apply at all depend on it.
  const metricSel = main.querySelector('#obsAlertMetric');
  if(metricSel) metricSel.addEventListener('change', ()=>{
    state.obsAlertDraft = obsAlertReadEditor(main);
    renderMain();
  });

  const cancel = main.querySelector('#obsAlertCancel');
  if(cancel) cancel.addEventListener('click', ()=>{ state.obsAlertDraft = null; renderMain(); });

  const save = main.querySelector('#obsAlertSave');
  if(save) save.addEventListener('click', async ()=>{
    const body = obsAlertReadEditor(main);
    save.disabled = true;
    try{
      if(body.id) await obsAlertApi('PUT', `/rules/${encodeURIComponent(body.id)}`, body);
      else await obsAlertApi('POST', '/rules', body);
      state.obsAlertDraft = null;
      toast(body.id ? 'Rule saved.' : 'Rule created.');
      obsLoadAlerts();
    }catch(err){
      save.disabled = false;
      toast(err.message || 'Could not save the rule.');
    }
  });

  const saveSettings = main.querySelector('#obsAlertSaveSettings');
  if(saveSettings) saveSettings.addEventListener('click', async ()=>{
    const toMinutes = (id)=>{
      const el = main.querySelector('#' + id);
      if(!el || !el.value) return 0;
      const [h, m] = el.value.split(':').map(Number);
      return (h || 0) * 60 + (m || 0);
    };
    const on = (id)=>{ const el = main.querySelector('#' + id); return el ? el.checked : false; };
    const val = (id)=>{ const el = main.querySelector('#' + id); return el ? el.value : ''; };
    saveSettings.disabled = true;
    try{
      // The secret field is write-only and starts blank every render (see
      // renderObsAlertSettings) whether or not one is already saved, so a
      // blank field here means "leave it as-is", not "clear it" — only send
      // `secret` at all when the admin actually typed something. See
      // buildWebhookPatch() in alertEngine.js for the server-side contract.
      const webhookSecret = val('obsAlertWebhookSecret');
      const webhook = { url: val('obsAlertWebhookUrl'), enabled: on('obsAlertWebhookEnabled') };
      if(webhookSecret) webhook.secret = webhookSecret;
      await obsAlertApi('PUT', '/settings', {
        enabled: on('obsAlertEnabledAll'),
        notifyAdmins: on('obsAlertNotifyAdmins'),
        quietHours: {
          enabled: on('obsAlertQuiet'),
          startMinute: toMinutes('obsAlertQuietFrom'),
          endMinute: toMinutes('obsAlertQuietTo'),
          timezone: (main.querySelector('#obsAlertQuietTz') || {}).value || 'Asia/Kolkata',
          allowCritical: on('obsAlertQuietCrit'),
        },
        webhook,
      });
      toast('Notification settings saved.');
    }catch(err){ toast(err.message || 'Could not save settings.'); }
    saveSettings.disabled = false;
    obsLoadAlerts();
  });

  const webhookTest = main.querySelector('#obsAlertWebhookTest');
  if(webhookTest) webhookTest.addEventListener('click', async ()=>{
    webhookTest.disabled = true;
    const original = webhookTest.textContent;
    webhookTest.textContent = 'Sending…';
    try{
      const result = await obsAlertApi('POST', '/webhook/test');
      toast(result.ok ? `Test delivered — the target responded ${result.status}.` : `Target responded ${result.status} (not 2xx).`);
    }catch(err){ toast(err.message || 'Could not send the test webhook.'); }
    webhookTest.disabled = false;
    webhookTest.textContent = original;
  });

  const historyLoad = main.querySelector('#obsAlertHistoryLoad');
  if(historyLoad) historyLoad.addEventListener('click', ()=>{
    obsLoadAlertHistory(state.obsAlertHistoryStatus === 'idle');
  });
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

  if(!d && state.obsStatus !== 'error'){
    // A skeleton in the SHAPE of the real thing, not a spinner. The first
    // paint after a reload happens before the probe answers, and a body that
    // changes height when data lands is the jump this replaces.
    body = `<div class="kpi-grid">${[0,1,2,3].map(()=>
      `<div class="kpi-card obs-skeleton-card"><span class="obs-skeleton-line short"></span>
       <span class="obs-skeleton-line tall"></span><span class="obs-skeleton-line"></span></div>`).join('')}</div>
      <div class="obs-panel"><span class="obs-skeleton-line short"></span>
        <div class="obs-skeleton-chart"></div></div>`;
  }else if(state.obsStatus === 'error' && !obsIsBridged()){
    // A failed time-series probe is not a reason to hide blob-backed numbers
    // that rendered fine — the error still shows, as a strip above them.
    body = `<div class="obs-panel"><div class="obs-empty">
      <div class="obs-empty-title">Could not load observability data</div>
      <div class="obs-empty-body">${escapeHtml(state.obsError)}</div>
    </div></div>`;
  }else if(d){
    switch(state.obsTab){
      case 'performance': body = renderObsPerformanceTab(); break;
      case 'errors':      body = renderObsErrorsTab(); break;
      case 'logs':        body = renderObsLogsTab(); break;
      case 'alerts':      body = renderObsAlertsTab(); break;
      case 'agent':       body = renderObsAgentTab(agentHealth); break;
      default:            body = renderObsOverviewTab();
    }
  }

  main.innerHTML = `
    ${renderObsToolbar()}
    ${renderObsScopeBar()}
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
      obsSaveView();
      renderMain();
      if(state.obsTab === 'logs' && state.obsRecords === null) obsLoadRecordsPage();
    });
  });

  main.querySelectorAll('[data-obs-range]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      state.obsRange = { key: btn.getAttribute('data-obs-range') };
      obsSaveView();
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

  const epPrev = main.querySelector('#obsEpPrev');
  if(epPrev) epPrev.addEventListener('click', ()=>{
    state.obsEndpointPage = Math.max(1, (state.obsEndpointPage || 1) - 1);
    renderMain();
  });
  const epNext = main.querySelector('#obsEpNext');
  if(epNext) epNext.addEventListener('click', ()=>{
    state.obsEndpointPage = (state.obsEndpointPage || 1) + 1;
    renderMain();
  });
  const epSearch = main.querySelector('#obsEndpointSearch');
  if(epSearch) epSearch.addEventListener('input', ()=>{
    state.obsEndpointSearch = epSearch.value;
    state.obsEndpointPage = 1;
    renderMain();
    // The re-render replaces the input, so put the caret back where it was
    // or typing a second character loses focus.
    const again = document.getElementById('obsEndpointSearch');
    if(again){ again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
  });

  const clearScope = main.querySelector('#obsClearScopeNew');
  if(clearScope) clearScope.addEventListener('click', ()=> obsSetScope({ type:'all' }));

  wireObsAlerts(main);

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
