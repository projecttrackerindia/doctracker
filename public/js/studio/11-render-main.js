/* ==================== SECTION:RENDER-MAIN ==================== */
// Keeps the address bar matching whatever's on screen — so copying the URL
// from a normal browsing session (not just a link someone constructs by
// hand) reaches the same project/endpoint. Mirrors the :projectSlug/
// :endpointSlug dashboard.html routes in server.js and INITIAL_PROJECT_SLUG/
// INITIAL_ENDPOINT_SLUG's handling in boot() (22-init.js) — same slugify/
// endpointSlugFor functions, so a URL built here resolves the same way a
// hand-typed one does. replaceState (not pushState): this runs on every
// render, and pushState here would flood browser history with an entry per
// click instead of per actual navigation.
function syncUrlToSelection(){
  if(state.standaloneTryIt) return; // the standalone Try It tab manages its own URL — see boot()
  let path = `/${ORG_TOKEN}/dashboard.html`;
  if(state.selected && state.selected.type === 'overview'){
    const proj = state.projects[state.selected.projectId];
    if(proj) path = `/${ORG_TOKEN}/${slugify(proj.name)}/dashboard.html`;
  } else if(state.selected && state.selected.type === 'endpoint' && !state.selected.tryIt){
    const found = findEndpointForView(state.selected.id);
    if(found) path = `/${ORG_TOKEN}/${slugify(found.proj.name)}/${endpointSlugFor(found.ep)}/dashboard.html`;
  }
  if(location.pathname !== path) history.replaceState(null, '', path + location.search);
}

function renderMain(){
  syncUrlToSelection();
  const main = document.getElementById('main');
  const authorBtn = document.getElementById('btnAuthor');
  if(authorBtn) authorBtn.classList.toggle('active', !!state.selected && state.selected.type === 'profile');

  if(!state.selected){
    main.innerHTML = `<div class="welcome">
      <div class="mark-lg">{ }</div>
      <h1>No endpoint selected</h1>
      <p>Import a MuleSoft OpenAPI/Swagger export (JSON or YAML), or add an endpoint by hand if you don't have a full spec yet. Everything is saved locally in this browser — no server, no account.</p>
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

function kpiCard(label, value, color, sub){
  return `<div class="kpi-card" style="${color?`--kpi-accent:${color};`:''}">
    <div class="kpi-label">${escapeHtml(label)}</div>
    <div class="kpi-value" style="${color?`color:${color};`:''}"><span class="kpi-dot"></span>${value}</div>
    ${sub ? `<div class="kpi-sub">${sub}</div>` : ''}
  </div>`;
}

function renderControlCenter(main){
  const m = workspaceMetrics();
  const projects = allProjects().slice().sort((a,b)=> (b.updatedAt||'').localeCompare(a.updatedAt||''));

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

  const projectRows = projects.length ? projects.map(p=>{
    const stats = p.endpoints.length ? Math.round(p.endpoints.reduce((s,ep)=>s+computeDocScore(ep,p).percent,0)/p.endpoints.length) : 0;
    const pp = perProjectById.get(p.id);
    const envsCell = emLoading ? '<span class="empty-field">…</span>'
      : pp ? `${pp.stagesReached}/${Math.max(pipelineStageCount-1,0)}`
      : `0/${Math.max(pipelineStageCount-1,0)}`;
    const statusTally = {};
    p.endpoints.forEach(ep=>{ const id = DocMeta.endpointStatusOf(ep); statusTally[id] = (statusTally[id]||0)+1; });
    return `<tr class="cc-proj-row" data-cc-proj="${p.id}">
      <td><span class="cc-proj-name">${escapeHtml(p.name)}</span></td>
      <td><span class="lc-badge lc-${p.lifecycle.toLowerCase().replace(/[^a-z]/g,'')}">${p.lifecycle}</span></td>
      <td class="mono">${p.endpoints.length}</td>
      <td style="min-width:120px;">${docScoreBarHtml(stats,'sm')}<span class="mono" style="font-size:10.5px;color:var(--text-faint);">${stats}%</span></td>
      <td class="mono" title="Pipeline stages (past Dev) this API has at least one endpoint promoted to">${envsCell}</td>
      <td><div style="display:flex;gap:4px;flex-wrap:wrap;">${statusCountChipsHtml(statusTally, {hideZero:true}) || '<span class="empty-field">—</span>'}</div></td>
      <td>${p.owner ? escapeHtml(p.owner) : '<span class="empty-field">—</span>'}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="7" class="empty-field" style="padding:16px;">No APIs yet — import a spec or add an endpoint to populate the control center.</td></tr>`;

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
      ${kpiCard('Needs attention', m.partial+m.poor, 'var(--put)', '<80% complete')}
      ${kpiCard('Fully promoted APIs', emLoading ? '…' : fullyPromotedCount, 'var(--get)', 'every draft endpoint reached '+lastStageLabel)}
      ${kpiCard('Missing auth', m.missingAuth, m.missingAuth?'var(--delete)':'var(--post)')}
      ${kpiCard('Deprecated / retired', m.deprecated, m.deprecated?'var(--patch)':'var(--text-dim)')}
    </div>

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
      <div class="section-title">APIs</div>
      <div class="table-scroll">
      <table class="data-table cc-proj-table">
        <thead><tr><th>Name</th><th>Lifecycle</th><th>Endpoints</th><th>Documentation</th><th>Stages reached</th><th>Status mix</th><th>Owner</th></tr></thead>
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
}
