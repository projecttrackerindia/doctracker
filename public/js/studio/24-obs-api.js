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
  Object.entries(extra || {}).forEach(([k, v]) => {
    if(v !== null && v !== undefined && v !== '') params.set(k, String(v));
  });
  return params.toString();
}

/* The console's environment selector. Falls back to the workspace's current
   environment so opening the page lands on the environment being worked in,
   rather than pooling every environment's traffic into one number - the same
   segregation rule the rest of the app follows. */
function obsSelectedEnvironment(){
  if(state.obsEnvironment === '__all') return null;
  if(state.obsEnvironment) return state.obsEnvironment;
  const envName = (state.env || '').trim();
  return envName || null;
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

/* One round trip per panel group, in parallel. Kept as a single entry point so
   the page has exactly one place that knows what a "refresh" means - the SSE
   handler, the range picker and the manual reload all call this. */
async function obsLoadAll(){
  const [summary, series, endpoints] = await Promise.all([
    obsApiGet('/summary', obsQuery()),
    obsApiGet('/series', obsQuery()),
    obsApiGet('/endpoints', obsQuery({ limit: 500 })),
  ]);
  return {
    range: summary.range,
    current: summary.current,
    previous: summary.previous,
    coverage: summary.coverage,
    series: series.series || [],
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

function obsStartLive(onUpdate){
  if(obsEventSource) return;
  if(typeof EventSource === 'undefined') return; // no SSE support: poll path stays
  obsLiveState = 'connecting';
  try{
    obsEventSource = new EventSource(`${OBS_API_BASE}/stream`, { withCredentials: true });
  }catch(e){
    obsLiveState = 'error';
    return;
  }
  obsEventSource.addEventListener('open', ()=>{
    obsLiveState = 'live';
    const badge = document.getElementById('obsLiveBadge');
    if(badge) badge.outerHTML = renderObsLiveBadge();
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
    // the connection down, or the browser's own backoff is lost.
    obsLiveState = obsEventSource && obsEventSource.readyState === 1 ? 'live' : 'error';
    const badge = document.getElementById('obsLiveBadge');
    if(badge) badge.outerHTML = renderObsLiveBadge();
  });
}

function obsStopLive(){
  if(obsEventSource){ obsEventSource.close(); obsEventSource = null; }
  clearTimeout(obsRefetchTimer);
  obsLiveState = 'idle';
}

function renderObsLiveBadge(){
  const map = {
    live:       ['--post',   'LIVE',        'Streaming updates as the agent pushes them'],
    connecting: ['--put',    'CONNECTING',  'Opening the live update stream'],
    error:      ['--delete', 'RECONNECTING','The live stream dropped; retrying automatically'],
    idle:       ['--text-faint', 'OFFLINE',  'Live updates are not running'],
  };
  const [colorVar, label, title] = map[obsLiveState] || map.idle;
  return `<span class="obs-live-badge" id="obsLiveBadge" title="${title}">
    <span class="obs-live-dot${obsLiveState === 'live' ? ' pulsing' : ''}" style="background:var(${colorVar});"></span>${label}
  </span>`;
}
