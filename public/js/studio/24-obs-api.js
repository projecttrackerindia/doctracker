/* ============================================================================
   Observability data layer.

   Talks to the time-series API (server/routes/observability.js) instead of
   reading the endpointMetrics blob out of GET /api/workspace. Two reasons that
   matters beyond speed: the blob only ever held a rolling sample, so it could
   not answer "what happened last Tuesday"; and polling it dragged every
   project, environment and Try It collection down the wire once a minute just
   to refresh a chart.

   FALLBACK IS DELIBERATE AND LOAD-BEARING. The rollup tables only fill once an
   agent build that emits them is deployed. Until then - and for any org whose
   agent is older - obsDataAvailable() is false and the page keeps rendering
   from the blob exactly as before. There is no flag day and no window where
   the console shows zeros because the backend moved on ahead of the collector.
   ========================================================================= */

const OBS_API_BASE = '/api/workspace/observability';

// How often to re-ask "does this org have rollup data yet?" once the answer
// has been no. Matches the fallback console's own refresh cadence, so a page
// open across an agent deploy switches over within about a minute rather than
// waiting for someone to reload it.
const OBS_AVAILABILITY_RECHECK_MS = 60000;

// Presets stay as shortcuts; an explicit from/to always wins. `all` is
// deliberately absent - with real retention "everything" is a year of data and
// nobody means that. The widest preset is 90d, and the date picker covers the
// rest.
const OBS_RANGES = [
  { key: '15m', label: '15 min',  ms: 15 * 60e3 },
  { key: '1h',  label: '1 hour',  ms: 3600e3 },
  { key: '6h',  label: '6 hours', ms: 6 * 3600e3 },
  { key: '24h', label: '24 hours', ms: 86400e3 },
  { key: '7d',  label: '7 days',  ms: 7 * 86400e3 },
  { key: '30d', label: '30 days', ms: 30 * 86400e3 },
  { key: '90d', label: '90 days', ms: 90 * 86400e3 },
];

function obsRangeByKey(key){
  return OBS_RANGES.find(r => r.key === key) || OBS_RANGES[3];
}

/* Resolves whatever the user has selected into concrete ISO bounds. A custom
   range wins over a preset; an unparseable custom range falls back rather than
   sending garbage the server would 400 on. */
function obsResolvedRange(){
  const sel = state.obsRange || { key: '24h' };
  if(sel.from && sel.to){
    const from = Date.parse(sel.from);
    const to = Date.parse(sel.to);
    if(!isNaN(from) && !isNaN(to) && from < to){
      return { from: new Date(from).toISOString(), to: new Date(to).toISOString(), custom: true, label: 'Custom' };
    }
  }
  const preset = obsRangeByKey(sel.key);
  const to = Date.now();
  return {
    from: new Date(to - preset.ms).toISOString(),
    to: new Date(to).toISOString(),
    custom: false,
    label: preset.label,
  };
}

function obsQuery(extra){
  const range = obsResolvedRange();
  const params = new URLSearchParams();
  params.set('from', range.from);
  params.set('to', range.to);
  const env = obsSelectedEnvironment();
  if(env) params.set('environment', env);
  const ids = obsScopeEndpointIds();
  if(ids && ids.length) params.set('endpointIds', ids.join(','));
  Object.entries(extra || {}).forEach(([k, v]) => {
    if(v !== null && v !== undefined && v !== '') params.set(k, String(v));
  });
  return params.toString();
}

/* The environment these figures cover. There is exactly ONE environment
   switcher in this app - the one in the header - and this reads it. The
   console used to carry a second dropdown of its own, which meant the page
   could sit on PROD while the header said SIT, with nothing on screen
   admitting the two disagreed. Environments stay segregated; which one you
   are in is a property of the workspace, not of this page. */
function obsSelectedEnvironment(){
  const envName = (state.env || '').trim();
  return envName || null;
}

/* --- Sidebar scope ---------------------------------------------------------
   Selecting an API or an endpoint in the sidebar narrows this whole page, not
   just the table at the bottom of it. Every panel goes through obsQuery(), so
   scoping is applied once, here, and cannot be half-applied.

   Rollup rows are keyed by the endpoint's stable id, which is exactly the id
   the auto-discovered endpoint document carries - so resolving a scope is a
   lookup, not a re-derivation of the hash. An endpoint with no document has no
   id to filter on and is dropped from the scope; that is visible in the
   toolbar rather than silent, because a scope that quietly matched nothing
   looks identical to an API with no traffic. */
const OBS_MAX_SCOPE_ENDPOINTS = 400;   // mirrors the server's own cap

function obsScopeEndpointIds(){
  const scope = state.obsScope;
  if(!scope || scope.type === 'all') return null;
  const keys = scope.type === 'key' ? [scope.key] : (scope.keys || []);
  const ids = [];
  keys.forEach(k => {
    const found = typeof findDocumentedEndpointForMetricsKey === 'function'
      ? findDocumentedEndpointForMetricsKey(k) : null;
    if(found && found.ep && found.ep.id) ids.push(found.ep.id);
  });
  // An unresolvable scope must not fall through to "everything" - that would
  // answer a narrower question with a wider number. A single impossible id
  // returns an honestly empty result instead.
  if(!ids.length) return ['__obs-scope-matches-nothing'];
  return Array.from(new Set(ids)).slice(0, OBS_MAX_SCOPE_ENDPOINTS);
}

/* How much of the selected scope this page can actually filter on, for the
   toolbar note. Returns null when nothing is scoped. */
function obsScopeCoverage(){
  const scope = state.obsScope;
  if(!scope || scope.type === 'all') return null;
  const keys = scope.type === 'key' ? [scope.key] : (scope.keys || []);
  const ids = obsScopeEndpointIds() || [];
  const resolved = ids[0] === '__obs-scope-matches-nothing' ? 0 : ids.length;
  return { selected: keys.length, resolved };
}

async function obsApiGet(path, query){
  const res = await fetch(`${OBS_API_BASE}${path}${query ? '?' + query : ''}`, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  if(!res.ok){
    let detail = '';
    try { detail = (await res.json()).error || ''; } catch(e){ /* non-JSON error body */ }
    const err = new Error(detail || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/* A chart must cover the range that was ASKED for, not the range that
   happens to hold data.

   The series endpoint returns only buckets that exist. Ask for 24 hours while
   holding 13 minutes of traffic and it returns two points - and a chart drawn
   from those two points silently re-scopes its own x-axis to 13 minutes while
   the toolbar above it still says "24 hours". The picture and the label
   disagree, and the picture is the one people believe.

   Filling the grid here rather than in SQL keeps one definition of "the
   window" on the client that already resolved it, and costs nothing: every
   range the picker offers lands between 15 and a few hundred slots, because
   the interval is chosen to target ~200 points in the first place. */
const OBS_MAX_SERIES_POINTS = 2000;

function obsFillSeries(series, fromIso, toIso, intervalSeconds){
  const step = Math.max(60, Number(intervalSeconds) || 300) * 1000;
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if(!isFinite(from) || !isFinite(to) || to <= from) return series || [];

  // The same grid the server floors onto - multiples of the interval since
  // the epoch - so a filled slot lines up exactly with a returned bucket
  // instead of sitting one slot beside it.
  const first = Math.floor(from / step) * step;
  const last = Math.floor(to / step) * step;
  const count = Math.floor((last - first) / step) + 1;
  if(count < 1 || count > OBS_MAX_SERIES_POINTS) return series || [];

  const bySlot = new Map();
  (series || []).forEach(p =>{
    const t = Date.parse(p.ts);
    if(isFinite(t)) bySlot.set(Math.floor(t / step) * step, p);
  });

  const out = [];
  for(let i = 0; i < count; i++){
    const t = first + i * step;
    out.push(bySlot.get(t) || {
      ts: new Date(t).toISOString(),
      total: 0,
      statusBreakdown: { '2xx':0, '3xx':0, '4xx':0, '5xx':0, unknown:0 },
      meanLatencyMs: null,
    });
  }
  return out;
}

/* One round trip per panel group, in parallel. Kept as a single entry point so
   the page has exactly one place that knows what a "refresh" means - the SSE
   handler, the range picker and the manual reload all call this. */
async function obsLoadAll(){
  const [summary, series, endpoints] = await Promise.all([
    obsApiGet('/summary', obsQuery()),
    obsApiGet('/series', obsQuery()),
    obsApiGet('/endpoints', obsQuery({ limit: 500 })),
  ]);
  const range = series.range || summary.range || {};
  return {
    range: summary.range,
    current: summary.current,
    previous: summary.previous,
    coverage: summary.coverage,
    series: obsFillSeries(series.series || [], range.from, range.to, series.intervalSeconds),
    intervalSeconds: series.intervalSeconds,
    endpoints: endpoints.endpoints || [],
    loadedAt: Date.now(),
  };
}

async function obsLoadRecords(opts){
  return obsApiGet('/records', obsQuery(opts || {}));
}

async function obsLoadEnvironments(){
  const data = await obsApiGet('/environments');
  return data.environments || [];
}

/* True once this org has ANY rollup data. Drives the fallback: false means the
   agent hasn't been upgraded yet and the page should keep using the blob. */
function obsDataAvailable(){
  return !!(state.obsData && state.obsData.coverage && state.obsData.coverage.buckets > 0);
}

/* --- What to paint before the first probe answers -------------------------
   A reload starts with no data and an unanswered question, and rendering the
   wrong answer for the ~1s the probe takes is a visible flash of a different
   console. Remembering the last answer per viewer makes the first paint
   almost always correct, and it is a display hint only: the probe still runs
   and still decides. Wrapped because storage throws in private windows. */
const OBS_SEEN_KEY = 'doctracker.obsHadData';

function obsRememberAvailability(has){
  try{ localStorage.setItem(OBS_SEEN_KEY, has ? '1' : '0'); }catch(e){ /* storage unavailable */ }
}

function obsRememberedAvailability(){
  try{ return localStorage.getItem(OBS_SEEN_KEY); }catch(e){ return null; }
}

/* --- Remembering where you were --------------------------------------------
   A reload used to drop you back on Overview at 24 hours no matter which tab
   and range you were reading, which makes refreshing to check a live number
   cost two clicks every time. Kept per viewer alongside the theme and the
   selected environment, which this app already persists the same way.

   Only a PRESET range is restored. Restoring an absolute custom window would
   silently reopen a stale one - come back tomorrow and you would be looking
   at yesterday while the page insists it is current. */
const OBS_VIEW_KEY = 'doctracker.obsView';

function obsSaveView(){
  try{
    const sel = state.obsRange || {};
    localStorage.setItem(OBS_VIEW_KEY, JSON.stringify({
      tab: state.obsTab,
      rangeKey: sel.from && sel.to ? null : (sel.key || null),
    }));
  }catch(e){ /* storage unavailable */ }
}

function obsRestoreView(){
  let saved = null;
  try{ saved = JSON.parse(localStorage.getItem(OBS_VIEW_KEY) || 'null'); }catch(e){ return; }
  if(!saved || typeof saved !== 'object') return;
  // Validated against the current lists, so a tab or preset removed in a
  // later build cannot leave someone on a view that no longer renders.
  if(typeof OBS_TABS !== 'undefined' && OBS_TABS.some(t => t.key === saved.tab)){
    state.obsTab = saved.tab;
  }
  if(saved.rangeKey && OBS_RANGES.some(r => r.key === saved.rangeKey)){
    state.obsRange = { key: saved.rangeKey };
  }
}

/* --- Live updates (SSE) ---------------------------------------------------
   Replaces the 60s poll. The server pushes an event the moment an agent
   ingests, so the console updates in step with collection instead of on a
   timer that is wrong in both directions - stale right after a push, wasteful
   when nothing has changed.

   EventSource reconnects on its own, so there is no retry loop here. What
   there IS: a guard against a burst of pushes (several agents, or one catching
   up on a backlog) triggering a refetch per event. */
let obsEventSource = null;
let obsRefetchTimer = null;
let obsLiveState = 'idle'; // idle | connecting | live | error
// When the stream was last actually open, and when the current outage began.
// A dropped stream is not one condition but two: the second or two a deploy
// takes, and DocTracker being down. They need different words, and the only
// thing that separates them is how long it has been going on.
let obsLastConnectedAt = 0;
let obsDownSince = 0;

/* The badge lives in the page header, outside the body the console re-renders,
   so a state change repaints just this element rather than the page. */
function obsRefreshLiveBadge(){
  const badge = document.getElementById('obsLiveBadge');
  if(badge) badge.outerHTML = renderObsLiveBadge();
}

/* The badge ages. Everything else on this page repaints when a push arrives -
   which is exactly the event that stops happening when the collector dies, so
   an agent that went down at 11:02 would still be reading "agent 1m ago" at
   four in the afternoon. This is the one thing on the console that has to keep
   its own clock. Cheap: it rewrites one element, and only while that element
   is on screen and the tab is visible. */
let obsBadgeClock = null;
// Slow while everything is fine; quick while something is wrong, so a dropped
// stream escalates from "retrying" to "server down" while you are still
// looking at it rather than half a minute later. EventSource fires an error
// per failed retry and usually repaints sooner than either of these - this is
// the floor, for when the browser's backoff stretches out or it gives up.
const OBS_BADGE_CLOCK_OK_MS = 30000;
const OBS_BADGE_CLOCK_DOWN_MS = 5000;

function obsStartBadgeClock(){
  if(obsBadgeClock) return;
  const tick = ()=>{
    if(!document.getElementById('obsLiveBadge')){ obsStopBadgeClock(); return; }
    if(!document.hidden) obsRefreshLiveBadge();
    obsBadgeClock = setTimeout(tick, obsLiveState === 'live' || obsLiveState === 'idle'
      ? OBS_BADGE_CLOCK_OK_MS : OBS_BADGE_CLOCK_DOWN_MS);
  };
  obsBadgeClock = setTimeout(tick, OBS_BADGE_CLOCK_DOWN_MS);
}

function obsStopBadgeClock(){
  if(obsBadgeClock){ clearTimeout(obsBadgeClock); obsBadgeClock = null; }
}

function obsStartLive(onUpdate){
  if(obsEventSource) return;
  if(typeof EventSource === 'undefined') return; // no SSE support: poll path stays
  obsLiveState = 'connecting';
  // Repainted here too, not only on 'open'. The badge is rendered before this
  // runs, so without it the page sits on OFFLINE for the length of the
  // handshake — and it is now large enough in the corner to be read and
  // believed in that window.
  obsRefreshLiveBadge();
  obsStartBadgeClock();
  try{
    obsEventSource = new EventSource(`${OBS_API_BASE}/stream`, { withCredentials: true });
  }catch(e){
    obsLiveState = 'error';
    obsDownSince = obsDownSince || Date.now();
    obsRefreshLiveBadge();
    return;
  }
  obsEventSource.addEventListener('open', ()=>{
    obsLiveState = 'live';
    obsLastConnectedAt = Date.now();
    obsDownSince = 0;
    obsRefreshLiveBadge();
  });
  obsEventSource.addEventListener('metrics', (ev)=>{
    let payload = null;
    try { payload = JSON.parse(ev.data); } catch(e){ return; }
    const env = obsSelectedEnvironment();
    // An event for an environment the user isn't looking at is not a reason to
    // refetch - a busy PROD agent would otherwise keep reloading a SIT view.
    if(env && payload.environment && payload.environment !== env) return;
    // Coalesce: several agents pushing at once should cost one refetch.
    clearTimeout(obsRefetchTimer);
    obsRefetchTimer = setTimeout(()=>{ onUpdate(payload); }, 400);
  });
  obsEventSource.addEventListener('error', ()=>{
    // EventSource retries by itself; reflect the interruption without tearing
    // the connection down, or the browser's own backoff is lost. It fires this
    // on every failed retry, which is what escalates RECONNECTING into
    // DISCONNECTED without needing a timer of its own.
    const open = obsEventSource && obsEventSource.readyState === 1;
    obsLiveState = open ? 'live' : 'error';
    if(open){ obsLastConnectedAt = Date.now(); obsDownSince = 0; }
    else if(!obsDownSince){ obsDownSince = Date.now(); }
    obsRefreshLiveBadge();
  });
}

function obsStopLive(){
  if(obsEventSource){ obsEventSource.close(); obsEventSource = null; }
  clearTimeout(obsRefetchTimer);
  obsStopBadgeClock();
  obsLiveState = 'idle';
  obsDownSince = 0;
}

/* How long the stream has been down, and whether this browser has any network
   at all. A page that blames the server for the viewer's own dropped wifi
   sends someone to check the wrong thing. */
const OBS_RECONNECT_GRACE_MS = 20000;

function obsStreamOutage(){
  if(obsLiveState !== 'error') return null;
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  const since = obsDownSince || obsLastConnectedAt || Date.now();
  const downMs = Math.max(0, Date.now() - since);
  return { offline, downMs, since };
}

/* --- "Is anything actually feeding this page?" -----------------------------
   Two different things can be down and the answer matters, so the badge
   reports both rather than averaging them into one green light:

     the STREAM  - this browser's connection to DocTracker. Green means a push
                   lands on screen without a reload.
     the AGENT   - the collector on the Mule host. The stream can be perfectly
                   healthy and carrying nothing because the agent stopped.

   Liveness of the agent is judged from its own last push rather than from a
   health check this page performs: the browser cannot reach the Mule host, and
   a DocTracker server that answers is not evidence that anything is tailing. */
function obsAgentFreshness(){
  const health = (typeof observabilityData === 'function'
    ? (observabilityData().agentHealth || null) : null);
  const stamp = (health && health.generatedAt)
    || (state.obsData && state.obsData.coverage && state.obsData.coverage.newest)
    || null;
  if(!stamp) return { level:'none', label:'no agent', title:'No agent has reported for this environment yet' };
  const ageMs = Date.now() - new Date(stamp).getTime();
  if(!isFinite(ageMs)) return null;
  // Floor, not round: 30 seconds ago is "just now", not "1m ago". Rounding up
  // makes a perfectly current agent look a minute behind.
  const mins = Math.max(0, Math.floor(ageMs / 60000));
  const ago = mins < 1 ? 'just now' : `${mins}m ago`;
  // Scaled to how often this agent actually pushes, not a fixed guess: an
  // agent on a 15-minute cycle is still healthy 14 minutes after its last one.
  const intervalMs = (Number(health && health.pushIntervalSeconds) || 900) * 1000;
  if(ageMs < intervalMs * 1.5) return { level:'ok',   label:`agent ${ago}`, title:`The collector last pushed ${ago}` };
  if(ageMs < intervalMs * 3)   return { level:'warn', label:`agent ${ago}`, title:`The collector last pushed ${ago} — later than its ${Math.round(intervalMs/60000)}-minute cycle` };
  return { level:'bad', label:`agent ${ago}`, title:`The collector last pushed ${ago} — it has probably stopped` };
}

function renderObsLiveBadge(){
  const map = {
    live:       ['--post',   'LIVE',         'Connected — pushes appear here without a reload'],
    connecting: ['--put',    'CONNECTING',   'Opening the live update stream'],
    idle:       ['--text-faint', 'OFFLINE',  'Live updates are not running'],
  };
  let [colorVar, label, title] = map[obsLiveState] || map.idle;
  // What the second line says. Normally it is the collector's freshness; while
  // the stream is down it is the outage, because the collector's state is
  // something this page LEARNS FROM THE SERVER - with the server unreachable,
  // "agent 2m ago" is not a reading, it is the last thing we happened to hear,
  // and it would keep ageing into a red warning about the wrong machine.
  let feed = obsAgentFreshness();

  const outage = obsStreamOutage();
  if(outage){
    const secs = Math.round(outage.downMs / 1000);
    const forHow = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m`;
    if(outage.offline){
      // Not the server's fault, and saying otherwise sends someone to check
      // the wrong machine.
      colorVar = '--delete';
      label = 'NO NETWORK';
      title = 'This browser is offline, so nothing can reach DocTracker';
      feed = { level:'bad', label:'check your connection', title:'' };
    }else if(outage.downMs < OBS_RECONNECT_GRACE_MS){
      // A restart or a deploy takes a second or two. Shouting DISCONNECTED
      // every time DocTracker ships would teach people to ignore the badge.
      colorVar = '--put';
      label = 'RECONNECTING';
      title = 'The live stream dropped; the browser is retrying';
      // "retrying 0s" is what a counter reads at the instant it starts, and it
      // looks like a stuck clock rather than a fresh event.
      feed = { level:'warn', label: secs < 3 ? 'retrying…' : `retrying ${forHow}`, title:'' };
    }else{
      colorVar = '--delete';
      label = 'DISCONNECTED';
      title = `DocTracker has been unreachable for ${forHow}. The figures on this page are `
        + 'frozen at the moment the stream dropped and are not updating';
      feed = { level:'bad', label:`server down ${forHow}`, title:'' };
    }
  }

  const stateClass = outage
    ? (outage.offline ? 'nonetwork' : (outage.downMs < OBS_RECONNECT_GRACE_MS ? 'retrying' : 'down'))
    : obsLiveState;
  const full = feed && feed.title ? `${title}. ${feed.title}.` : `${title}.`;
  return `<span class="obs-live-badge obs-live-${stateClass}${feed ? ' obs-live-feed-' + feed.level : ''}"
      id="obsLiveBadge" style="--obs-live: var(${colorVar});" title="${escapeHtml(full)}">
    <span class="obs-live-dot${obsLiveState === 'live' ? ' pulsing' : ''}"></span>
    <span class="obs-live-stack">
      <span class="obs-live-label">${label}</span>
      ${feed ? `<span class="obs-live-sub">${escapeHtml(feed.label)}</span>` : ''}
    </span>
  </span>`;
}
