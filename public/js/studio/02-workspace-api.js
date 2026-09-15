/* ==================== SECTION:WORKSPACE API ====================
   Projects/endpoints/attachments/environments/audit-log/request-history/flow
   presets all live in Postgres now (server/routes/workspace.js) — nothing
   workspace-related is read from or written to localStorage any more.
   localStorage is still used for pure per-browser UI prefs (theme, sidebar
   collapsed, which environment tab is selected) — those aren't shared data. */
const WORKSPACE_API = '/api/workspace';
async function apiGet(path){
  const res = await fetch(WORKSPACE_API + path, { credentials:'same-origin' });
  if(!res.ok) throw new Error('Request failed: ' + res.status);
  return res.json();
}
// Backs the Control Center's "Environment configuration" table — how many
// endpoints actually exist in each pipeline stage (Dev/SIT/UAT/Staging/
// Production/...), not whether a project has a base URL saved for it. See
// GET /api/workspace/environment-metrics. Cached on `state` and re-fetched
// on demand; renderControlCenter() kicks this off and re-renders once it
// lands, same "Loading…" -> fill-in pattern used by the release pipeline panel.
async function loadEnvironmentMetrics(){
  state.envMetricsStatus = 'loading';
  try{
    state.envMetrics = await apiGet('/environment-metrics');
    state.envMetricsStatus = 'ready';
  }catch(err){
    console.error('Failed to load environment metrics:', err);
    state.envMetricsStatus = 'error';
  }
  if(state.selected.type === 'home'){
    renderMain();
  }
}
async function apiSend(method, path, body){
  const res = await fetch(WORKSPACE_API + path, {
    method,
    credentials:'same-origin',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify(body),
  });
  if(res.status === 423){
    // Locked out by an access schedule (see blockIfScheduleLocked in
    // middleware/authGuard.js) — refresh AUTH_USER's copy of the schedule
    // from the response (an admin may have just changed it) and flip
    // straight to the full lock screen instead of a generic error toast.
    const err = await res.json().catch(()=>({}));
    if(err.accessSchedule) AUTH_USER.accessSchedule = err.accessSchedule;
    renderScheduleState();
    throw new Error(err.message || 'Your access is currently locked.');
  }
  if(!res.ok){
    const err = await res.json().catch(()=>({}));
    throw new Error(err.error || ('Request failed: ' + res.status));
  }
  return res.json();
}
