/* ==================== SECTION:RENDER-MAIN ==================== */
// Keeps the address bar matching whatever's on screen — so copying the URL
// from a normal browsing session (not just a link someone constructs by
// hand) reaches the same project/endpoint/view. Mirrors the :projectSlug/
// :endpointSlug and observability dashboard.html routes in server.js and
// INITIAL_PROJECT_SLUG/INITIAL_ENDPOINT_SLUG/INITIAL_VIEW's handling in
// boot() (22-init.js) — same slugify/endpointSlugFor functions, so a URL
// built here resolves the same way a hand-typed one does. replaceState (not
// pushState): this runs on every render, and pushState here would flood
// browser history with an entry per click instead of per actual navigation.
// Every non-project page gets its own bookmarkable URL. This list MUST match
// SPECIAL_VIEW_ROUTES in server/server.js - the server registers these exact
// literal segments ahead of its generic :projectSlug route, so they're
// reserved words in the URL space.
const SPECIAL_VIEW_SLUGS = {
  observability: 'observability',
  security: 'security',
  releasepipeline: 'release-pipeline',
  errors: 'errors',
  profile: 'profile',
};
const RESERVED_PROJECT_SLUGS = new Set(Object.values(SPECIAL_VIEW_SLUGS));

function syncUrlToSelection(){
  if(state.standaloneTryIt) return; // the standalone Try It tab manages its own URL — see boot()
  let path = `/${ORG_TOKEN}/dashboard.html`;
  if(state.selected && state.selected.type === 'overview'){
    const proj = state.projects[state.selected.projectId];
    // A project named e.g. "Security" slugifies onto a reserved segment; that
    // URL would load the Security page instead of the project, so don't mint
    // it - leave this project on the bare dashboard URL.
    if(proj && !RESERVED_PROJECT_SLUGS.has(slugify(proj.name))) path = `/${ORG_TOKEN}/${slugify(proj.name)}/dashboard.html`;
  } else if(state.selected && state.selected.type === 'endpoint' && !state.selected.tryIt){
    const found = findEndpointForView(state.selected.id);
    // Same reservation applies to the project segment of an endpoint URL.
    if(found && !RESERVED_PROJECT_SLUGS.has(slugify(found.proj.name))) path = `/${ORG_TOKEN}/${slugify(found.proj.name)}/${endpointSlugFor(found.ep)}/dashboard.html`;
  } else if(state.selected && SPECIAL_VIEW_SLUGS[state.selected.type]){
    path = `/${ORG_TOKEN}/${SPECIAL_VIEW_SLUGS[state.selected.type]}/dashboard.html`;
  }
  if(location.pathname !== path) history.replaceState(null, '', path + location.search);
}

function renderMain(){
  syncUrlToSelection();
  // Observability opens a live SSE stream (obsStartLive(), called every time
  // renderObservability() runs - see 23-observability.js). Nothing ever
  // closed it on navigating away: obsStopLive() existed but had no call
  // site anywhere in the app, so leaving the page left the stream open,
  // still calling renderMain() (force-re-rendering whatever page is
  // currently on screen) and firing background refetches, for the rest of
  // the session - only a full page reload actually stopped it. This is the
  // one place every navigation path funnels through regardless of which of
  // the ~30 call sites set state.selected, so it's the one place that can
  // reliably catch "we just left Observability" without hooking each of
  // them individually.
  const nowType = state.selected && state.selected.type;
  if(state._obsStreamOpen && nowType !== 'observability' && typeof obsStopLive === 'function'){
    obsStopLive();
  }
  state._obsStreamOpen = nowType === 'observability';
  // Home's "new changes — refresh" banner (see wsEventsStartLive() in
  // 03-notifications.js): the underlying flag is data-truth and persists
  // across navigation, but the banner itself should only be visible while
  // Home is actually on screen — show it immediately on arriving at Home if
  // the update happened while looking at something else, hide it (without
  // clearing the flag) the moment the visitor navigates away.
  if(nowType === 'home'){
    if(state._homeUpdatePending && typeof showHomeUpdateBanner === 'function') showHomeUpdateBanner();
  } else if(typeof hideHomeUpdateBanner === 'function'){
    hideHomeUpdateBanner();
  }
  const main = document.getElementById('main');
  const authorBtn = document.getElementById('btnAuthor');
  if(authorBtn) authorBtn.classList.toggle('active', !!state.selected && state.selected.type === 'profile');

  if(!state.selected){
    main.innerHTML = `<div class="welcome">
      <div class="mark-lg">{ }</div>
      <h1>No endpoint selected</h1>
      <p>Import a MuleSoft OpenAPI/Swagger export (JSON or YAML), or add an endpoint by hand if you don't have a full spec yet. If you switched environments, this can also just mean nothing has been promoted here yet.</p>
      <div class="actions">
        <button class="primary" id="btnImport2">Import spec file</button>
        <button id="btnAddManual2">Add endpoint manually</button>
      </div>
    </div>`;
    document.getElementById('btnImport2').addEventListener('click', ()=>document.getElementById('fileInput').click());
    document.getElementById('btnAddManual2').addEventListener('click', ()=>{
      if(!canEditHere()){ toast(isViewingDraftEnv() ? `Your role (${roleMeta(state.authorRole).label}) is read-only` : `Switch to ${envMeta(draftEnvId()).label} to make changes`); return; }
      openEditorTab(null, null);
    });
    return;
  }

  if(state.selected.type === 'home'){
    renderControlCenter(main);
    return;
  }

  if(state.selected.type === 'errors'){
    renderErrorCatalog(main);
    return;
  }

  if(state.selected.type === 'profile'){
    renderProfilePage(main);
    return;
  }

  if(state.selected.type === 'security'){
    // A project owner (not just an Admin) can land here now — see
    // requireAdminOrProjectOwner server-side and the tab filter inside
    // renderSecurityCenter, which limits them to Documentation Access only.
    if(!isAdmin() && !ownsAnyProject()){ state.selected = { type:'home' }; renderControlCenter(main); return; }
    renderSecurityCenter(main);
    return;
  }

  if(state.selected.type === 'releasepipeline'){
    if(!isAdmin() && !ownsAnyProject()){ state.selected = { type:'home' }; renderControlCenter(main); return; }
    renderReleasePipelineOverview(main);
    return;
  }

  if(state.selected.type === 'observability'){
    if(!isAdmin() && !ownsAnyProject()){ state.selected = { type:'home' }; renderControlCenter(main); return; }
    renderObservability(main);
    return;
  }

  if(state.selected.type === 'overview'){
    renderProjectOverview(main, state.selected.projectId);
    return;
  }

  const found = findEndpointForView(state.selected.id);
  if(!found){
    // A Try It deep link into a non-draft environment depends on that
    // environment's release-pipeline snapshot, which loads asynchronously
    // (see snapshotEntry) — give it a few renders to arrive before giving up.
    if(state.selected.tryIt){
      state.selected._tryItAttempts = (state.selected._tryItAttempts || 0) + 1;
      if(state.selected._tryItAttempts > 6){
        toast(`This endpoint isn't available in ${envMeta(state.env).label}.`);
        state.selected = { type:'home' };
        renderMain();
        return;
      }
      main.innerHTML = `<div class="welcome"><div class="mark-lg">{ }</div><h1>Loading endpoint…</h1><p>Fetching the ${escapeHtml(envMeta(state.env).label)} snapshot for this API.</p></div>`;
      return;
    }
    state.selected = null; renderMain(); return;
  }
  // A standalone Try It tab (see boot()'s tryit deep-link handling) should be
  // strictly a Try It page — nothing else. Previously this still rendered the
  // full endpoint doc (summary, auth, headers, Edit/Duplicate/Delete actions…)
  // into #main and relied purely on the Try It panel's CSS overlay to cover
  // it, which meant the doc page really was sitting in the DOM the whole
  // time — one CSS/z-index edge case (or the panel not covering the full
  // scroll height once the response section grows after Send) away from
  // showing through. Skipping the doc render entirely means there's nothing
  // to leak, regardless of how the overlay is styled.
  if(state.standaloneTryIt){
    main.innerHTML = '';
  } else {
    renderEndpointDoc(main, found.proj, found.ep);
  }
  if(state.selected.tryIt){
    state.selected.tryIt = false; // auto-open once per deep link, not on every re-render
    // A locked endpoint's documented headers/parameters/samples were never
    // sent down in the first place (see applyDocLock in workspace.js), so
    // there's nothing sensitive Try It could leak here either way — but
    // opening it would just show a confusing, empty request/response panel
    // instead of the "request access" page already rendered above.
    if(!found.ep._docLocked) openTryItModal(found.proj, found.ep);
  }
}

// Cross-project Release Pipeline overview — a real top-level nav destination
// instead of the old "Open Release Pipeline" being buried in each project's
// "…" actions menu (see openReleasePipelineTab). Shows every API's current
// furthest stage plus every org-wide pending Production request in one
// place; approving/cancelling/rolling back still happens on the existing
// per-project pipeline page (openReleasePipelineTab) — this is the missing
// map of "what needs my attention across all of them," not a rebuild of the
// per-project page itself.
async function loadReleasePipelineRequests(){
  if(!isAdmin()){ state.rpRequestsStatus = 'not-admin'; return; }
  state.rpRequestsStatus = 'loading';
  try{
    const res = await apiGet('/promotion-requests?status=pending');
    state.rpRequests = res.requests || [];
    state.rpRequestsStatus = 'ready';
  }catch(err){
    console.error('Failed to load org-wide promotion requests:', err);
    state.rpRequestsStatus = 'error';
  }
  if(state.selected && state.selected.type === 'releasepipeline') renderMain();
}

function renderReleasePipelineOverview(main){
  if(state.envMetricsStatus === 'idle') loadEnvironmentMetrics();
  if(!state.rpRequestsStatus) loadReleasePipelineRequests();

  const em = state.envMetrics;
  const emLoading = state.envMetricsStatus === 'loading' && !em;
  const perProjectById = new Map((em && em.perProject || []).map(p=>[p.projectId, p]));
  const lastStage = em && em.stages && em.stages.length ? em.stages[em.stages.length-1] : null;
  const projects = allProjects().slice().sort((a,b)=> (a.name||'').localeCompare(b.name||''));

  const pendingCount = state.rpRequestsStatus === 'ready' ? state.rpRequests.length : 0;

  const projRows = projects.length ? projects.map(p=>{
    const pp = perProjectById.get(p.id);
    const readyTotal = pp ? pp.readyTotal : 0;
    const inLastStage = pp && lastStage ? (pp.byEnvironment[lastStage.id]||0) : 0;
    const fullyPromoted = pp && pp.fullyPromoted;
    let stageLabel, stageColor;
    if(emLoading){ stageLabel = 'Loading…'; stageColor = 'var(--text-faint)'; }
    else if(!readyTotal){ stageLabel = 'Nothing release-ready yet'; stageColor = 'var(--text-faint)'; }
    else if(fullyPromoted){ stageLabel = `All ${readyTotal} ready endpoint${readyTotal===1?'':'s'} in ${lastStage.label}`; stageColor = 'var(--post)'; }
    else if(inLastStage){ stageLabel = `${inLastStage}/${readyTotal} ready endpoints in ${lastStage.label}`; stageColor = 'var(--put)'; }
    else { stageLabel = `${readyTotal} endpoint${readyTotal===1?'':'s'} ready, none in ${lastStage?lastStage.label:'the last stage'} yet`; stageColor = 'var(--put)'; }
    return `<tr class="cc-proj-row" data-rp-proj="${p.id}">
      <td><span class="cc-proj-name">${escapeHtml(p.name)}</span></td>
      <td><span class="lc-badge lc-${p.lifecycle.toLowerCase().replace(/[^a-z]/g,'')}">${p.lifecycle}</span></td>
      <td style="color:${stageColor};">${stageLabel}</td>
      <td class="mono">${p.owner ? escapeHtml(p.owner) : '<span class="empty-field">—</span>'}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="4" class="empty-field" style="padding:16px;">No APIs yet.</td></tr>`;

  let reqRows;
  if(state.rpRequestsStatus === 'not-admin'){
    reqRows = `<tr><td colspan="6" class="empty-field" style="padding:16px;">Only Admins can see pending requests across every API — you can still see requests for projects you own from that project's own Release Pipeline.</td></tr>`;
  } else if(state.rpRequestsStatus === 'loading' || !state.rpRequestsStatus){
    reqRows = `<tr><td colspan="6" class="empty-field" style="padding:16px;">Loading pending requests…</td></tr>`;
  } else if(state.rpRequestsStatus === 'error'){
    reqRows = `<tr><td colspan="6" class="empty-field" style="padding:16px;">Couldn't load pending requests. <button type="button" id="rpRequestsRetry" style="background:none;border:none;color:var(--accent);cursor:pointer;text-decoration:underline;padding:0;font:inherit;">Retry</button></td></tr>`;
  } else if(!state.rpRequests.length){
    reqRows = `<tr><td colspan="6" class="empty-field" style="padding:16px;">No pending promotion requests right now.</td></tr>`;
  } else {
    reqRows = state.rpRequests.map(r=>`
      <tr class="cc-proj-row" data-rp-proj="${r.projectId}">
        <td><span class="cc-proj-name">${escapeHtml(r.projectName)}</span></td>
        <td>${escapeHtml(r.fromEnvironmentLabel)} → ${escapeHtml(r.toEnvironmentLabel)}</td>
        <td>${escapeHtml(r.requestedByUsername||'—')}</td>
        <td class="mono" style="font-size:10.5px;color:var(--text-faint);">${formatDateTime(r.createdAt)}</td>
        <td>${r.breakingChanges && r.breakingChanges.length ? `<span style="color:var(--delete);">${r.breakingChanges.length} breaking</span>` : '<span class="empty-field">—</span>'}</td>
        <td>${r.canApprove ? '<span style="color:var(--post);">You can approve this</span>' : '<span class="empty-field">Requested by you — needs another Admin</span>'}</td>
      </tr>`).join('');
  }

  main.innerHTML = `
    <div class="crumb">Release Pipeline</div>
    <div class="ctrl-hero" style="--ctrl-glow-bg:var(${pendingCount?'--put-bg':'--post-bg'});">
      <div class="ctrl-hero-icon" style="--ctrl-icon-color:var(${pendingCount?'--put':'--post'});--ctrl-icon-bg:var(${pendingCount?'--put-bg':'--post-bg'});">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="6" r="2.5"></circle><circle cx="5" cy="18" r="2.5"></circle><circle cx="19" cy="12" r="2.5"></circle><path d="M5 8.5v7M7.2 6.8L16.8 10.8M7.2 17.2L16.8 13.2"></path></svg>
      </div>
      <div class="ctrl-hero-copy">
        <h1>Where every API stands in the pipeline</h1>
        <p>A cross-project view of stage progress and pending Production requests. Approving, cancelling, or rolling back still happens on each API's own Release Pipeline — click any row to open it.</p>
      </div>
      <div class="ctrl-hero-stat">
        <div class="n">${state.rpRequestsStatus==='ready' ? pendingCount : '…'}</div>
        <div class="l">pending requests</div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Pending promotion requests</div>
      <div class="table-scroll">
      <table class="data-table">
        <thead><tr><th>API</th><th>Stage move</th><th>Requested by</th><th>Opened</th><th>Breaking changes</th><th>Approval</th></tr></thead>
        <tbody>${reqRows}</tbody>
      </table>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Stage status by API</div>
      <div class="hint" style="margin-top:-4px;">"Ready" endpoints are the ones that pass the Production gate (SecOps + VAPT + Log Mgmt signed off) — see each API's Review sign-off status for what's holding the rest back.</div>
      <div class="table-scroll">
      <table class="data-table cc-proj-table">
        <thead><tr><th>Name</th><th>Lifecycle</th><th>Current stage</th><th>Owner</th></tr></thead>
        <tbody>${projRows}</tbody>
      </table>
      </div>
    </div>
  `;

  const retryBtn = document.getElementById('rpRequestsRetry');
  if(retryBtn) retryBtn.addEventListener('click', ()=>{ state.rpRequestsStatus = null; renderMain(); });

  main.querySelectorAll('[data-rp-proj]').forEach(row=>{
    row.addEventListener('click', ()=>{
      const proj = state.projects[row.getAttribute('data-rp-proj')];
      if(proj) openReleasePipelineTab(proj);
    });
  });
}

// `filterId` (Control Center only — see CC_KPI_FILTERS) makes the card a
// real button that narrows the APIs table to exactly what it's counting,
// instead of just being a static number with no next step.
function kpiCard(label, value, color, sub, filterId){
  const clickable = filterId ? ` data-cc-kpi-filter="${filterId}" tabindex="0" role="button"` : '';
  return `<div class="kpi-card${filterId?' kpi-card-link':''}" style="${color?`--kpi-accent:${color};`:''}"${clickable}>
    <div class="kpi-label">${escapeHtml(label)}</div>
    <div class="kpi-value" style="${color?`color:${color};`:''}"><span class="kpi-dot"></span>${value}</div>
    ${sub ? `<div class="kpi-sub">${sub}</div>` : ''}
  </div>`;
}

// Roughly-human "how long ago" for the APIs table's freshness column —
// staleness matters here (an API nobody's touched in months while its
// upstream systems moved on is a real signal), so this also hands back a
// color tier the caller can use, not just a label.
function timeAgoLabel(iso){
  if(!iso) return { label:'—', tier:'unknown' };
  const ms = Date.now() - new Date(iso).getTime();
  if(!Number.isFinite(ms) || ms < 0) return { label:'—', tier:'unknown' };
  const days = Math.floor(ms / 86400000);
  const label = days < 1 ? 'Today' : days === 1 ? '1 day ago' : days < 30 ? `${days} days ago`
    : days < 365 ? `${Math.round(days/30)} mo ago` : `${Math.round(days/365)}y ago`;
  const tier = days > 90 ? 'stale' : days > 30 ? 'aging' : 'fresh';
  return { label, tier };
}

// Predicates behind each clickable KPI card — kept in one place so the
// count shown in the card and the rows a click actually filters to can
// never silently disagree. Only KPIs with a real per-project meaning are
// wired up (see the callers below) — "Endpoints" or "Well documented" are
// genuinely endpoint-level totals spread across projects, and forcing them
// into a project filter would show a number that doesn't match what's
// literally on the card.
const CC_KPI_FILTERS = {
  missingAuth: { label:'Missing auth', test:(p)=> !(p.auth && p.auth.type) },
  deprecated: { label:'Deprecated / retired', test:(p)=> ['DEPRECATED','RETIRED'].includes(p.lifecycle) },
  fullyPromoted: { label:'Fully promoted APIs', test:(p, ctx)=> !!(ctx.perProjectById.get(p.id) && ctx.perProjectById.get(p.id).fullyPromoted) },
  needsAttention: { label:'Needs attention', test:(p)=> p.endpoints.some(ep=> computeDocScore(ep,p).percent < 80) },
};

const CC_SORT_COLS = {
  name: { label:'Name', get:(p)=> (p.name||'').toLowerCase() },
  lifecycle: { label:'Lifecycle', get:(p)=> p.lifecycle||'' },
  endpoints: { label:'Endpoints', get:(p)=> p.endpoints.length },
  doc: { label:'Documentation', get:(p)=> p.endpoints.length ? p.endpoints.reduce((s,ep)=>s+computeDocScore(ep,p).percent,0)/p.endpoints.length : 0 },
  stages: { label:'Stages reached', get:(p, ctx)=> (ctx.perProjectById.get(p.id) || {}).stagesReached || 0 },
  owner: { label:'Owner', get:(p)=> (p.owner||'').toLowerCase() },
  updated: { label:'Last updated', get:(p)=> p.updatedAt||'' },
};

function renderControlCenter(main){
  const m = workspaceMetrics();
  const allProjectsSorted = allProjects().slice().sort((a,b)=> (b.updatedAt||'').localeCompare(a.updatedAt||''));

  const healthTotal = m.totalEndpoints || 1;
  const wellPct = Math.round((m.wellDocumented/healthTotal)*100);
  const partialPct = Math.round((m.partial/healthTotal)*100);
  const poorPct = 100 - wellPct - partialPct;

  // Environment configuration + each API's "Environments" column both come
  // from GET /environment-metrics — endpoints actually promoted into each
  // pipeline stage, not whether a base URL happens to be set. See
  // loadEnvironmentMetrics(). Kick off a (re)fetch the first time we land
  // here or after a promotion may have changed things; render a lightweight
  // loading state in the meantime rather than blocking the rest of the page.
  if(state.envMetricsStatus === 'idle') loadEnvironmentMetrics();
  const em = state.envMetrics;
  const emLoading = state.envMetricsStatus === 'loading' && !em;
  const emError = state.envMetricsStatus === 'error' && !em;

  const perProjectById = new Map((em && em.perProject || []).map(p=>[p.projectId, p]));
  const pipelineStageCount = em ? (em.stages || []).length : 0;

  let envRows;
  if(emLoading){
    envRows = `<tr><td colspan="4" class="empty-field" style="padding:16px;">Loading endpoint counts per environment…</td></tr>`;
  } else if(emError){
    envRows = `<tr><td colspan="4" class="empty-field" style="padding:16px;">Couldn't load environment metrics. <button type="button" id="ccEnvMetricsRetry" style="background:none;border:none;color:var(--accent);cursor:pointer;text-decoration:underline;padding:0;font:inherit;">Retry</button></td></tr>`;
  } else if(em && (em.stages||[]).length){
    envRows = em.stages.map(s=>{
      return `<tr>
        <td><span class="env-chip" style="--env-accent:${envAccentColor(s.environmentId)};--env-accent-bg:${envBgColor(s.environmentId)};">${escapeHtml(s.label)}${s.isDraftStage ? ' <span style="opacity:.6;font-weight:500;">(draft)</span>' : ''}</span></td>
        <td class="mono">${s.totalEndpoints}</td>
        <td class="mono">${s.percentOfBaseline}%</td>
        <td class="mono" style="color:${s.totalEndpoints===0?'var(--text-faint)':s.isDraftStage||s.percentOfBaseline===100?'var(--post)':'var(--put)'};">${s.projectsWithEndpoints}/${s.totalProjects} APIs</td>
      </tr>`;
    }).join('') + (em.mirrors||[]).map(s=>`<tr>
        <td><span class="env-chip" style="--env-accent:${envAccentColor(s.environmentId)};--env-accent-bg:${envBgColor(s.environmentId)};">${escapeHtml(s.label)} <span style="opacity:.6;font-weight:500;">(mirrors last stage)</span></span></td>
        <td class="mono">${s.totalEndpoints}</td>
        <td class="mono">${s.percentOfBaseline}%</td>
        <td class="mono" style="color:${s.totalEndpoints===0?'var(--text-faint)':'var(--post)'};">${s.projectsWithEndpoints}/${s.totalProjects} APIs</td>
      </tr>`).join('');
  } else {
    envRows = `<tr><td colspan="4" class="empty-field" style="padding:16px;">No pipeline environments configured yet — add one from Your Profile first.</td></tr>`;
  }

  // Search box + clickable KPI filter + sortable columns all narrow/order
  // the SAME filteredProjects list that feeds the APIs table — kept as one
  // pipeline so there's never a mismatch between what a KPI card claims and
  // what clicking it actually shows.
  const ccCtx = { perProjectById };
  const kpiFilterId = state.ccKpiFilter && CC_KPI_FILTERS[state.ccKpiFilter] ? state.ccKpiFilter : null;
  const searchQ = (state.ccSearch || '').trim().toLowerCase();
  const sortKey = state.ccSort && CC_SORT_COLS[state.ccSort.key] ? state.ccSort.key : null;
  const sortDir = state.ccSort && state.ccSort.dir === 'asc' ? 'asc' : 'desc';

  let filteredProjects = allProjectsSorted.filter(p=>{
    if(kpiFilterId && !CC_KPI_FILTERS[kpiFilterId].test(p, ccCtx)) return false;
    if(searchQ && !`${p.name} ${p.owner||''}`.toLowerCase().includes(searchQ)) return false;
    return true;
  });
  if(sortKey){
    const getter = CC_SORT_COLS[sortKey].get;
    filteredProjects = filteredProjects.slice().sort((a,b)=>{
      const av = getter(a, ccCtx), bv = getter(b, ccCtx);
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }

  const ccColHeader = (key, label, extra)=>{
    const active = sortKey === key;
    const arrow = active ? (sortDir==='asc' ? '↑' : '↓') : '';
    return `<th class="cc-sortable${active?' active':''}" data-cc-sort-key="${key}">${escapeHtml(label)}${extra||''} <span class="cc-sort-arrow">${arrow}</span></th>`;
  };

  const projectRows = filteredProjects.length ? filteredProjects.map(p=>{
    const stats = p.endpoints.length ? Math.round(p.endpoints.reduce((s,ep)=>s+computeDocScore(ep,p).percent,0)/p.endpoints.length) : 0;
    const pp = perProjectById.get(p.id);
    const stagesTotal = Math.max(pipelineStageCount-1,0);
    const stagesReached = emLoading ? null : (pp ? pp.stagesReached : 0);
    const stagesPct = stagesTotal ? Math.round(((stagesReached||0)/stagesTotal)*100) : 0;
    const statusTally = {};
    p.endpoints.forEach(ep=>{ const id = DocMeta.endpointStatusOf(ep); statusTally[id] = (statusTally[id]||0)+1; });
    const fresh = timeAgoLabel(p.updatedAt);
    const freshColor = fresh.tier==='stale' ? 'var(--put)' : fresh.tier==='aging' ? 'var(--text-dim)' : 'var(--text-faint)';
    return `<tr class="cc-proj-row" data-cc-proj="${p.id}">
      <td><span class="cc-proj-name">${escapeHtml(p.name)}</span></td>
      <td><span class="lc-badge lc-${p.lifecycle.toLowerCase().replace(/[^a-z]/g,'')}">${p.lifecycle}</span></td>
      <td class="mono">${p.endpoints.length}</td>
      <td style="min-width:120px;">${docScoreBarHtml(stats,'sm')}<span class="mono" style="font-size:10.5px;color:var(--text-faint);">${stats}%</span></td>
      <td style="min-width:100px;" title="Pipeline stages (past Dev) this API has at least one endpoint promoted to">${emLoading ? '<span class="empty-field">…</span>' : `${docScoreBarHtml(stagesPct,'sm')}<span class="mono" style="font-size:10.5px;color:var(--text-faint);">${stagesReached}/${stagesTotal}</span>`}</td>
      <td><div style="display:flex;gap:4px;flex-wrap:wrap;">${statusCountChipsHtml(statusTally, {hideZero:true}) || '<span class="empty-field">—</span>'}</div></td>
      <td>${p.owner ? escapeHtml(p.owner) : '<span class="empty-field">—</span>'}</td>
      <td class="mono" style="font-size:10.5px;color:${freshColor};" title="${p.updatedAt ? formatDateTime(p.updatedAt) : ''}">${fresh.label}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="8" class="empty-field" style="padding:16px;">${allProjectsSorted.length ? 'No APIs match the current search/filter.' : 'No APIs yet — import a spec or add an endpoint to populate the control center.'}</td></tr>`;

  // Environment-level status breakdown — one column per pipeline stage (plus
  // any DR mirrors), one row per lifecycle status, straight from each
  // stage's byStatus (GET /environment-metrics — see buildStageMetric
  // server-side, which tallies ep.status across every promoted snapshot).
  const statusEnvStages = em ? [...(em.stages||[]), ...(em.mirrors||[])] : [];
  let statusEnvRows;
  if(emLoading){
    statusEnvRows = `<tr><td colspan="${statusEnvStages.length+1}" class="empty-field" style="padding:16px;">Loading…</td></tr>`;
  } else if(emError){
    statusEnvRows = `<tr><td colspan="2" class="empty-field" style="padding:16px;">Couldn't load environment metrics.</td></tr>`;
  } else if(!statusEnvStages.length){
    statusEnvRows = `<tr><td colspan="2" class="empty-field" style="padding:16px;">No pipeline environments configured yet.</td></tr>`;
  } else {
    statusEnvRows = DocMeta.ENDPOINT_STATUSES.map(s=>{
      const cells = statusEnvStages.map(stage=>{
        const n = (stage.byStatus && stage.byStatus[s.id]) || 0;
        return `<td class="mono"${!n?' style="color:var(--text-faint);"':''}>${n}</td>`;
      }).join('');
      return `<tr><td><span class="dm-chip dm-t-${s.tone}"><span class="dm-dot dm-t-${s.tone}"></span>${escapeHtml(s.label)}</span></td>${cells}</tr>`;
    }).join('');
  }
  const statusEnvHead = statusEnvStages.map(stage=>`<th>${escapeHtml(stage.label)}${stage.isDraftStage?' <span style="opacity:.6;font-weight:500;">(draft)</span>':''}</th>`).join('');

  const fullyPromotedCount = em ? (em.perProject||[]).filter(p=>p.fullyPromoted).length : 0;
  const lastStageLabel = em && em.stages && em.stages.length ? em.stages[em.stages.length-1].label : 'the last stage';

  // Same "good/needs attention/problem" tiering the Documentation coverage
  // KPI card below already uses — reused here to color the hero's glow and
  // icon so the very first thing on the page reads as good news or not,
  // the same way Security Center's shield does for protection status.
  const healthTier = m.avgDoc>=80 ? 'good' : m.avgDoc>=50 ? 'warn' : 'bad';
  const ctrlColorVar = healthTier==='good' ? '--post' : healthTier==='warn' ? '--put' : '--delete';
  const ctrlBgVar = healthTier==='good' ? '--post-bg' : healthTier==='warn' ? '--put-bg' : '--delete-bg';
  const ctrlIcon = healthTier==='good'
    ? '<path d="M9 12l2 2 4-4"></path><circle cx="12" cy="12" r="9"></circle>'
    : healthTier==='warn'
      ? '<path d="M12 8v4.5"></path><circle cx="12" cy="15.5" r="0.9" fill="currentColor" stroke="none"></circle><circle cx="12" cy="12" r="9"></circle>'
      : '<path d="M3 12h4l2-7 4 14 2-7h6"></path>';

  // Same SecOps/VAPT/Log Mgmt gate as Security Center's Summary tab (see
  // computeReviewReadinessRollup in 12-security-center.js) — surfaced here
  // too since "what's happening with your APIs" is exactly what release
  // readiness is, and this is the page people actually land on first.
  const ccRollup = computeReviewReadinessRollup();
  const ccReadiness = {
    rollup: ccRollup,
    notReadyCount: ccRollup.totalEndpoints - ccRollup.fullyReady,
    chips: ccRollup.KINDS.map(k=>{
      const n = ccRollup.pendingByKind[k.id];
      return `<span class="sec-status-dot"><span class="dot" style="background:${n?'var(--delete)':'var(--post)'};"></span>${n} ${k.label} pending</span>`;
    }).join(''),
  };

  // Needs-attention digest — the worst 5 endpoints org-wide by doc score, so
  // there's a concrete starting point ("go fix these 5") instead of just a
  // count. Opens straight into the endpoint editor, same as every other
  // "jump to this endpoint" affordance in the app.
  const ccWorstEndpoints = [];
  allProjectsSorted.forEach(p=> p.endpoints.forEach(ep=>{
    ccWorstEndpoints.push({ proj:p, ep, score: computeDocScore(ep, p).percent });
  }));
  ccWorstEndpoints.sort((a,b)=> a.score - b.score);
  const ccWorst5 = ccWorstEndpoints.slice(0, 5);
  const ccDigestHtml = ccWorst5.length ? `
    <div class="section">
      <div class="section-title">Needs attention first <span style="color:var(--text-faint); font-weight:500; text-transform:none;">— the lowest-scoring endpoints org-wide</span></div>
      <div class="cc-digest">
        ${ccWorst5.map(({proj,ep,score})=>`
          <div class="cc-digest-row" data-cc-digest-proj="${proj.id}" data-cc-digest-ep="${ep.id}">
            <span class="badge ${methodClass(ep.method)}">${ep.method}</span>
            <span class="cc-digest-path mono">${escapeHtml(ep.path)}</span>
            <span class="cc-digest-proj">${escapeHtml(proj.name)}</span>
            ${docScoreBarHtml(score,'sm')}
            <span class="mono cc-digest-pct" style="color:${score>=50?'var(--put)':'var(--delete)'};">${score}%</span>
          </div>`).join('')}
      </div>
    </div>` : '';

  // Discovery coverage — the one number this page could not answer before:
  // of everything the log agent watched running, how much is actually written
  // up here. Both sides are in state.projects; reconcileDiscovery() matches
  // them (see 05-util.js). Hidden entirely when no agent is reporting.
  const ccRecon = reconcileDiscovery();
  // Scoped to the currently selected environment, same as reconcileDiscovery()
  // itself (see discoveryMatchesCurrentEnv() in 05-util.js) — otherwise this
  // count pooled every environment's discovery projects even though ccRecon's
  // OWN numbers were already correctly scoped, e.g. "75 app(s) discovered"
  // staying identical and wrong after ccGaps below had already been filtered
  // down to just the current environment's gaps.
  const ccAutoProjects = allProjectsSorted.filter(p => !!p.discoveryEnvironment && discoveryMatchesCurrentEnv(p));
  const ccGaps = ccAutoProjects
    .map(p => ccRecon.byAutoId[p.id])
    .filter(c => c && c.novel > 0)
    .sort((a, b) => b.novel - a.novel);
  const ccDiscoveredEndpoints = ccRecon.duplicateEndpoints + ccRecon.novelEndpoints;
  const ccCoveredPct = ccDiscoveredEndpoints
    ? Math.round((ccRecon.duplicateEndpoints / ccDiscoveredEndpoints) * 100) : 0;
  const ccDiscoveryHtml = ccAutoProjects.length ? `
    <div class="section">
      <div class="section-title">Discovery coverage <span style="color:var(--text-faint); font-weight:500; text-transform:none;">— what is running versus what is documented</span></div>
      <div class="hint" style="margin-top:-4px;">The log agent reports every Mule app it sees serving traffic, with no
        knowledge of what anyone has documented. These are the two lists compared: an app already in the Control
        Center is not a second API, and the sidebar no longer lists it as one.</div>
      <div class="sec-card" style="--sc-accent:var(${ccGaps.length ? '--put' : '--post'});margin-top:10px;">
        <div class="v" style="font-size:14px;"><span class="dot"></span>${ccRecon.duplicateEndpoints} of
          ${ccDiscoveredEndpoints} discovered endpoint${ccDiscoveredEndpoints === 1 ? '' : 's'} (${ccCoveredPct}%) are documented</div>
        <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:10px;">
          <span class="sec-status-dot"><span class="dot" style="background:var(--get);"></span>${ccAutoProjects.length} app(s) discovered</span>
          <span class="sec-status-dot"><span class="dot" style="background:var(--post);"></span>${ccRecon.duplicateProjects} already in the Control Center</span>
          <span class="sec-status-dot"><span class="dot" style="background:${ccRecon.novelEndpoints ? 'var(--put)' : 'var(--post)'};"></span>${ccRecon.novelEndpoints} endpoint(s) running but undocumented</span>
        </div>
        ${ccGaps.length ? `<div class="cc-digest" style="margin-top:12px;">
          ${ccGaps.slice(0, 5).map(c => `
            <div class="cc-digest-row" data-cc-discovery-proj="${escapeHtml(c.autoProj.id)}">
              <span class="cc-digest-path mono">${escapeHtml(c.autoProj.name)}</span>
              <span class="cc-digest-proj">${c.documented ? 'documented as ' + escapeHtml(c.documented.name) : 'no matching API'}</span>
              <span class="mono cc-digest-pct cc-digest-new" style="color:var(--put);">${c.novel} new</span>
            </div>`).join('')}
        </div>
        ${ccGaps.length > 5 ? `<div class="s" style="margin-top:8px;">…and ${ccGaps.length - 5} more app(s) with undocumented endpoints.</div>` : ''}`
        : `<div class="s" style="margin-top:8px;">Everything the agent has seen running is documented.</div>`}
      </div>
    </div>` : '';

  main.innerHTML = `
    <div class="crumb">API Control Center</div>
    <div class="ctrl-hero" style="--ctrl-glow-bg:var(${ctrlBgVar});">
      <div class="ctrl-hero-icon" style="--ctrl-icon-color:var(${ctrlColorVar});--ctrl-icon-bg:var(${ctrlBgVar});">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ctrlIcon}</svg>
      </div>
      <div class="ctrl-hero-copy">
        <h1>What's happening with your APIs</h1>
        <p>${isAdmin() ? 'A live rollup of every API in this workspace — no external monitoring involved.' : 'A live rollup of the APIs and endpoints visible to you — no external monitoring involved.'}</p>
      </div>
      <div class="ctrl-hero-stat">
        <div class="n">${m.avgDoc}%</div>
        <div class="l">documentation coverage</div>
      </div>
    </div>

    <div class="kpi-grid">
      ${kpiCard('APIs', m.apiCount)}
      ${kpiCard('Endpoints', m.totalEndpoints)}
      ${kpiCard('Documentation coverage', m.avgDoc+'%', m.avgDoc>=80?'var(--post)':m.avgDoc>=50?'var(--put)':'var(--delete)')}
      ${kpiCard('Well documented', m.wellDocumented, 'var(--post)', '≥80% complete')}
      ${kpiCard('Needs attention', m.partial+m.poor, 'var(--put)', '<80% complete — click to filter', 'needsAttention')}
      ${kpiCard('Fully promoted APIs', emLoading ? '…' : fullyPromotedCount, 'var(--get)', 'reached '+lastStageLabel+' — click to filter', 'fullyPromoted')}
      ${kpiCard('Missing auth', m.missingAuth, m.missingAuth?'var(--delete)':'var(--post)', m.missingAuth?'click to filter':'', 'missingAuth')}
      ${kpiCard('Deprecated / retired', m.deprecated, m.deprecated?'var(--patch)':'var(--text-dim)', m.deprecated?'click to filter':'', 'deprecated')}
    </div>
    ${kpiFilterId ? `<div class="cc-active-filter">Filtered to: <strong>${escapeHtml(CC_KPI_FILTERS[kpiFilterId].label)}</strong> (${filteredProjects.length} API${filteredProjects.length===1?'':'s'}) <button type="button" id="ccClearKpiFilter" class="linklike">Clear filter</button></div>` : ''}

    <div class="section">
      <div class="section-title">Review sign-off status <span style="color:var(--text-faint); font-weight:500; text-transform:none;">— documentation review approvals, not what's actually deployed</span></div>
      <div class="sec-card" style="--sc-accent:var(${ccReadiness.notReadyCount?'--put':'--post'});">
        <div class="v" style="font-size:14px;"><span class="dot"></span>${ccReadiness.rollup.fullyReady} of ${ccReadiness.rollup.totalEndpoints} endpoint${ccReadiness.rollup.totalEndpoints===1?'':'s'} have SecOps + VAPT + Log Mgmt all signed off</div>
        <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:10px;">${ccReadiness.chips}</div>
        <div class="s" style="margin-top:8px;">${ccReadiness.notReadyCount
          ? `${ccReadiness.notReadyCount} endpoint${ccReadiness.notReadyCount===1?'':'s'} still need a review marked approved in their own documentation — this number only moves when someone updates THAT, not when a promotion request is approved. Endpoints that already have sign-off may still be waiting on a separate Production promotion request (see each project's Release Pipeline).`
          : 'Every documented endpoint has SecOps, VAPT, and Log Mgmt all signed off. Whether they\'re actually live in Production is a separate question — check each project\'s Release Pipeline.'}</div>
      </div>
    </div>

    ${ccDiscoveryHtml}

    ${ccDigestHtml}

    <div class="section">
      <div class="section-title">Endpoints by status — API level</div>
      <div class="hint" style="margin-top:-4px;">Every endpoint's current lifecycle status (Active / Under development / Under review / No consumers yet / Deprecated), summed across all APIs' live draft docs.</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;">${statusCountChipsHtml(m.statusCounts)}</div>
    </div>

    <div class="section">
      <div class="section-title">Endpoints by status — environment level</div>
      <div class="hint" style="margin-top:-4px;">Status mix of the endpoints actually present in each promoted environment snapshot (Dev shows the live draft).</div>
      <div class="table-scroll">
      <table class="data-table">
        <thead><tr><th>Status</th>${statusEnvHead}</tr></thead>
        <tbody>${statusEnvRows}</tbody>
      </table>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Documentation health</div>
      <div class="health-bars">
        <div class="health-row"><span class="health-label">Well documented</span><div class="health-track"><div class="health-fill" style="width:${wellPct}%;background:var(--post);"></div></div><span class="health-pct">${wellPct}%</span></div>
        <div class="health-row"><span class="health-label">Partially documented</span><div class="health-track"><div class="health-fill" style="width:${partialPct}%;background:var(--put);"></div></div><span class="health-pct">${partialPct}%</span></div>
        <div class="health-row"><span class="health-label">Poorly documented</span><div class="health-track"><div class="health-fill" style="width:${poorPct}%;background:var(--delete);"></div></div><span class="health-pct">${poorPct}%</span></div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Environment configuration</div>
      <div class="hint" style="margin-top:-4px;">Endpoints actually promoted into each environment — not just whether a base URL is set. It's normal for later stages to be lower than Dev while work is still in progress.</div>
      <table class="data-table">
        <thead><tr><th>Environment</th><th>Endpoints</th><th>% of Dev</th><th>Coverage</th></tr></thead>
        <tbody>${envRows}</tbody>
      </table>
    </div>

    <div class="section">
      <div class="section-title" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
        <span>APIs</span>
        <span class="cc-search-wrap" style="max-width:240px;width:100%;">
          <span class="cc-search-ic">${ICON_SEARCH}</span>
          <input type="text" id="ccProjSearch" placeholder="Search by name or owner…" value="${escapeHtml(state.ccSearch||'')}" autocomplete="off">
        </span>
      </div>
      <div class="table-scroll">
      <table class="data-table cc-proj-table">
        <thead><tr>
          ${ccColHeader('name','Name')}
          ${ccColHeader('lifecycle','Lifecycle')}
          ${ccColHeader('endpoints','Endpoints')}
          ${ccColHeader('doc','Documentation')}
          ${ccColHeader('stages','Stages reached')}
          <th>Status mix</th>
          ${ccColHeader('owner','Owner')}
          ${ccColHeader('updated','Last updated')}
        </tr></thead>
        <tbody>${projectRows}</tbody>
      </table>
      </div>
    </div>
  `;

  const emRetryBtn = document.getElementById('ccEnvMetricsRetry');
  if(emRetryBtn) emRetryBtn.addEventListener('click', ()=>{ state.envMetricsStatus = 'idle'; renderMain(); });

  main.querySelectorAll('[data-cc-proj]').forEach(row=>{
    row.addEventListener('click', ()=>{
      state.selected = { type:'overview', projectId: row.getAttribute('data-cc-proj') };
      renderEnvSwitcher(); renderSidebar(); renderMain(); renderRail();
    });
  });

  main.querySelectorAll('[data-cc-kpi-filter]').forEach(card=>{
    const filterId = card.getAttribute('data-cc-kpi-filter');
    const activate = ()=>{
      state.ccKpiFilter = state.ccKpiFilter === filterId ? null : filterId;
      renderControlCenter(main);
    };
    card.addEventListener('click', activate);
    card.addEventListener('keydown', (e)=>{ if(e.key==='Enter' || e.key===' '){ e.preventDefault(); activate(); } });
  });
  const clearBtn = document.getElementById('ccClearKpiFilter');
  if(clearBtn) clearBtn.addEventListener('click', ()=>{ state.ccKpiFilter = null; renderControlCenter(main); });

  const searchInput = document.getElementById('ccProjSearch');
  if(searchInput){
    searchInput.addEventListener('input', ()=>{
      state.ccSearch = searchInput.value;
      renderControlCenter(main);
      const el = document.getElementById('ccProjSearch');
      if(el){ el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    });
  }

  main.querySelectorAll('[data-cc-sort-key]').forEach(th=>{
    th.addEventListener('click', ()=>{
      const key = th.getAttribute('data-cc-sort-key');
      const current = state.ccSort;
      state.ccSort = (current && current.key===key) ? { key, dir: current.dir==='asc'?'desc':'asc' } : { key, dir:'asc' };
      renderControlCenter(main);
    });
  });

  main.querySelectorAll('[data-cc-digest-proj]').forEach(row=>{
    row.addEventListener('click', ()=>{
      const proj = state.projects[row.getAttribute('data-cc-digest-proj')];
      const ep = proj && proj.endpoints.find(e=>e.id===row.getAttribute('data-cc-digest-ep'));
      if(proj && ep) openEditorTab(proj, ep);
    });
  });

  // A discovery gap opens that app's Overview, where the reconciliation panel
  // lives (renderDiscoveryReconcilePanel in 14-users.js) — the place the gap
  // is actually resolved, rather than a read-only number on this page.
  main.querySelectorAll('[data-cc-discovery-proj]').forEach(row=>{
    row.addEventListener('click', ()=>{
      const id = row.getAttribute('data-cc-discovery-proj');
      const proj = state.projects[id];
      if(!proj) return;
      // The panel only renders in the environment the traffic was observed in.
      if(proj.discoveryEnvironment && envIds().includes(proj.discoveryEnvironment) && state.env !== proj.discoveryEnvironment){
        state.env = proj.discoveryEnvironment;
        saveEnv();
      }
      state.selected = { type:'overview', projectId: id };
      renderAll();
    });
  });
}
