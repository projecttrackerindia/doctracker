/* ==================== SECTION:RENDER-SIDEBAR ==================== */
// One project's full tree (header + Overview row + tag groups), shared by
// the hand-authored list and the auto-discovered section below — the two
// groups render identically, they just sit under a different heading.
// Returns '' if `proj` has no endpoints matching `filter`.
function renderProjectNode(proj, filter, coverage){
  let epsForView = viewEndpoints(proj);
  // An auto-discovered project reconciled against the documentation (see
  // reconcileDiscovery() in 05-util.js): with "New only" on, the endpoints
  // somebody has already written up are dropped here, so the sidebar shows
  // each endpoint once — in the curated project, where it belongs — and this
  // section is left showing only what is genuinely undocumented.
  if(coverage && state.discoveryNewOnly){
    epsForView = epsForView.filter(ep => coverage.novelIds.has(ep.id));
  }
  // Preserve the order endpoints were added in (like a real API collection)
  // — only the tag/category labels below are alphabetized, not the endpoints
  // inside them, so "Endpoint 1, Endpoint 2…" doesn't get silently reshuffled.
  const orderIndex = new Map(epsForView.map((ep,i)=>[ep.id,i]));
  const groups = {};
  epsForView.forEach(ep=>{
    const hay = (ep.path + ' ' + (ep.name||'') + ' ' + (ep.summary||'') + ' ' + ep.method).toLowerCase();
    if(filter && !hay.includes(filter)) return;
    (groups[ep.tag] = groups[ep.tag] || []).push(ep);
  });
  const projMatches = !filter || proj.name.toLowerCase().includes(filter);
  const hasEpMatches = Object.keys(groups).length > 0;
  if(filter && !hasEpMatches && !projMatches) return '';

  const groupsToShow = (filter && !hasEpMatches && projMatches) ? groupByTag(epsForView) : groups;
  const isOpen = proj._open !== false;
  const canDeleteHere = canEditHere();

  const overviewActive = state.selected && state.selected.type==='overview' && state.selected.projectId===proj.id;
  const closedTags = proj._closedTags || {};
  const tagsHtml = Object.keys(groupsToShow).sort().map(tag=>{
    const eps = groupsToShow[tag].slice().sort((a,b)=>(orderIndex.get(a.id)??0)-(orderIndex.get(b.id)??0));
    const tagOpen = filter ? true : !closedTags[tag]; // search always shows matches, regardless of collapsed state
    return `<div class="tag-group ${tagOpen?'open':''}" data-tag-name="${escapeHtml(tag)}">
      <div class="tag-head" data-tag-toggle="${proj.id}" data-tag-name="${escapeHtml(tag)}">
        <span class="tag-caret">▶</span>
        <span class="tag-label">${escapeHtml(tag)}</span>
        <span class="tag-count">${eps.length}</span>
      </div>
      <div class="tag-body">
        ${eps.map(ep=>{
          const dup = coverage ? coverage.matches.get(ep.id) : null;
          return `
          <div class="ep ${dup ? 'ep-dup' : ''} ${state.selected && state.selected.type==='endpoint' && state.selected.id===ep.id ? 'active':''}" data-ep="${ep.id}">
            <span class="badge ${methodClass(ep.method)}">${ep.method}</span>
            ${!ep._docLocked ? `<span class="dm-dot dm-t-${DocMeta.endpointStatusMeta(ep).tone}" style="flex-shrink:0;" title="${escapeHtml(DocMeta.endpointStatusMeta(ep).label)}"></span>` : ''}
            <span class="ep-path" title="${escapeHtml(ep.name ? `${ep.name} — ${ep.path}` : ep.path)}">${escapeHtml(ep.name || ep.path)}</span>
            ${dup ? `<span class="ep-dup-tag" title="Already documented as ${escapeHtml(dup.ep.method + ' ' + dup.ep.path)} in ${escapeHtml(dup.proj.name)}${dup.confidence === 'path' ? ' — matched on path shape, the base path differs' : ''}">documented</span>` : ''}
            ${ep._docLocked ? `<span class="icon-btn" title="Documentation access required" style="margin-left:auto;flex-shrink:0;color:var(--text-faint);pointer-events:none;">${ICON_LOCK}</span>` : ''}
            ${canDeleteHere ? `<span class="icon-btn ep-del" data-ep-del="${ep.id}" title="Delete endpoint" role="button" tabindex="0"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg></span>` : ''}
          </div>`;}).join('')}
      </div>
    </div>`;
  }).join('') || (coverage
    ? `<div class="tag-group open"><div class="empty-sidebar" style="padding:10px 8px;font-size:11.5px;">${
        coverage.total ? 'Every endpoint here is already documented.' : 'No endpoints discovered yet.'}</div></div>`
    : (!isViewingDraftEnv() && !filter ? `<div class="tag-group open"><div class="empty-sidebar" style="padding:10px 8px;font-size:11.5px;">${snapshotEntry(proj.id).status==='loading' ? 'Loading…' : `Nothing promoted to ${escapeHtml(envMeta(state.env).label)} yet.`}</div></div>` : ''));

  const initials = (proj.name||'?').trim().split(/\s+/).slice(0,2).map(w=>w[0]).join('').toUpperCase() || '?';
  // A random hash-derived color per project reads fine across a handful of
  // hand-authored, visually-distinct projects, but across ~100 near-
  // identical auto-discovered app rows it's a wall of unrelated colour
  // that reads as noise rather than signal. Those rows get one flat
  // neutral tone instead - still an avatar to anchor the row, just not
  // pretending each app is meaningfully color-coded.
  const accent = proj.discoveryEnvironment ? '#8a93a6' : PROFILE_COLORS[hashStr(proj.name||'') % PROFILE_COLORS.length];
  const { r:ar, g:ag, b:ab } = hexToRgb(accent);
  const accentBg = `rgba(${ar},${ag},${ab},${state.theme==='light'?0.12:0.18})`;

  // A duplicate of something already in the Control Center announces itself on
  // the row, with the count reading "n new" instead of a total that overlaps a
  // curated project's — two rows both saying "14" for the same 14 endpoints is
  // exactly the double-count this reconciliation exists to stop.
  const dupTag = coverage && coverage.documented
    ? `<span class="proj-dup-tag" title="Already in the API Control Center as &quot;${escapeHtml(coverage.documented.name)}&quot; — ${coverage.covered} of ${coverage.total} endpoint(s) documented. Open this project's Overview to reconcile.">documented</span>`
    : '';
  const countLabel = coverage && state.discoveryNewOnly && coverage.total
    ? `${epsForView.length} new`
    : String(epsForView.length);

  return `<div class="project ${isOpen?'open':''}" data-proj="${proj.id}">
    <div class="project-head" data-toggle="${proj.id}" style="--proj-accent:${accent};--proj-accent-bg:${accentBg};">
      <div class="project-name">
        <span class="project-caret">▶</span>
        <span class="project-avatar" style="background:${accent};">${escapeHtml(initials)}</span>
        <span class="txt" title="${escapeHtml(proj.name)}">${escapeHtml(proj.name)}</span>
        ${dupTag}
      </div>
      <div class="project-actions">
        <span class="project-count" title="${coverage ? `${coverage.novel} not documented · ${coverage.covered} already documented` : ''}">${escapeHtml(countLabel)}</span>
        <span class="icon-btn" data-settings="${proj.id}" title="Project settings"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="6" x2="20" y2="6"></line><line x1="4" y1="12" x2="20" y2="12"></line><line x1="4" y1="18" x2="20" y2="18"></line><circle cx="9" cy="6" r="1.8" fill="var(--surface)"></circle><circle cx="16" cy="12" r="1.8" fill="var(--surface)"></circle><circle cx="9" cy="18" r="1.8" fill="var(--surface)"></circle></svg></span>
        <span class="icon-btn del" data-del="${proj.id}" title="Delete API"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg></span>
      </div>
    </div>
    <div class="tag-group" style="display:${isOpen?'block':'none'};">
      <div class="overview-row ${overviewActive?'active':''}" data-overview="${proj.id}">▸ Overview</div>
    </div>
    ${tagsHtml}
  </div>`;
}

function updatePinnedNavActive(){
  const onObservability = !!state.selected && state.selected.type === 'observability';
  // The header toggle button, not just the sidebar rows - so it visibly
  // shows which side of the toggle you're on, the same way #btnAuthor
  // shows an active state while its own panel is open.
  const obsBtn = document.getElementById('btnObservability');
  if(obsBtn) obsBtn.classList.toggle('active', onObservability);
  document.querySelectorAll('.pinned-row').forEach(row=>{
    const nav = row.getAttribute('data-nav');
    // On Observability, the "API Control Center" row doubles as "All
    // traffic" (see renderSidebar() below) - it's active there whenever
    // the observability scope is 'all', not the normal home-tab check.
    const active = (nav === 'home' && onObservability)
      ? !!(state.obsScope && state.obsScope.type === 'all')
      : !!state.selected && state.selected.type === nav;
    row.classList.toggle('active', active);
  });
}

function renderSidebar(){
  updatePinnedNavActive();
  const list = document.getElementById('projectList');
  const filter = document.getElementById('searchBox').value.trim().toLowerCase();
  const homeRow = document.querySelector('.pinned-row[data-nav="home"]');
  const homeLabel = homeRow ? homeRow.querySelector('.pinned-label') : null;

  // Observability takes over this same sidebar slot with its own API/
  // endpoint drill-down tree (see 23-observability.js) instead of the
  // normal project list - one sidebar, contextual to the page you're on,
  // rather than the app's project navigator PLUS a second nested picker
  // inside the page content. The search box above is reused as-is (same
  // #searchBox, same input listener) - typing into it filters whichever
  // tree is currently showing. The pinned "API Control Center" row itself
  // relabels to "All traffic" and becomes the top of that tree, instead of
  // the tree repeating an "All traffic" row of its own right underneath it.
  // Getting back out is the header's Observability button, now a toggle
  // (see 21-events.js) - no separate exit row needed here any more.
  if(state.selected && state.selected.type === 'observability'){
    document.getElementById('searchBox').placeholder = 'Filter APIs / endpoints…';
    if(homeLabel){ homeLabel.textContent = 'All traffic'; homeRow.title = 'All traffic — every endpoint DocTracker has seen hits for'; }
    renderObservabilitySidebar(list, filter);
    return;
  }
  if(homeLabel){ homeLabel.textContent = 'API Control Center'; homeRow.title = 'API Control Center'; }
  document.getElementById('searchBox').placeholder = 'Filter endpoints…';

  const projects = allProjects();

  const dl = document.getElementById('projectNames');
  dl.innerHTML = projects.map(p=>`<option value="${escapeHtml(p.name)}">`).join('');

  if(!projects.length){
    list.innerHTML = `<div class="empty-sidebar">
      No APIs documented yet. Import an OpenAPI/Swagger export, or add an endpoint by hand to get started.
    </div>`;
    return;
  }

  // Auto-discovered projects (one per Mule app - see mule_doc_agent.py's
  // build_app_projects()) get their own collapsed-by-default section below
  // the hand-authored ones, instead of being mixed straight into the same
  // flat list: on a busy node that's ~100 extra rows burying the handful
  // of projects someone actually curated. Collapse state is a per-viewer
  // convenience (localStorage, like the sidebar's own collapse toggle),
  // not project data, so it isn't pushed to the server via saveState().
  const manualProjects = projects.filter(p=>!p.discoveryEnvironment);
  const autoProjects = projects.filter(p=>!!p.discoveryEnvironment);
  const manualHtml = manualProjects.map(proj=>renderProjectNode(proj, filter)).join('');

  // Reconcile discovery against the documentation before rendering it, so an
  // app somebody has already documented by hand doesn't appear a second time
  // down here as though it were a separate API (see reconcileDiscovery()).
  const recon = autoProjects.length ? reconcileDiscovery() : { byAutoId:{}, duplicateProjects:0, duplicateEndpoints:0, novelEndpoints:0 };
  const newOnly = !!state.discoveryNewOnly;
  const autoToShow = newOnly
    ? autoProjects.filter(p => (recon.byAutoId[p.id] || {}).novel > 0)
    : autoProjects;
  const hiddenCount = autoProjects.length - autoToShow.length;
  const autoNodesHtml = autoToShow.map(proj=>renderProjectNode(proj, filter, recon.byAutoId[proj.id])).join('');
  const autoSectionOpen = filter ? true : !!state.autoSectionOpen; // search always shows matches, regardless of collapsed state
  const autoSectionHtml = autoProjects.length ? `<div class="auto-section ${autoSectionOpen?'open':''}">
      <div class="auto-section-head" data-auto-toggle>
        <span class="auto-caret">▶</span>
        <span class="auto-section-label">Auto-discovered APIs</span>
        <span class="project-count" title="${newOnly
          ? `${autoToShow.length} app(s) with undocumented endpoints · ${hiddenCount} fully documented already`
          : `${autoProjects.length} app(s) discovered · ${recon.duplicateProjects} already in the Control Center`}">${
          newOnly ? `${autoToShow.length} new` : autoProjects.length}</span>
      </div>
      <div class="auto-section-body" style="display:${autoSectionOpen?'block':'none'};">
        <div class="auto-filter-row">
          <label class="auto-filter" title="Discovery finds everything that is running, documented or not. With this on, anything already written up in the API Control Center is left out, so each API appears once.">
            <input type="checkbox" id="discoveryNewOnly" ${newOnly?'checked':''}>
            <span>Hide what's already documented</span>
          </label>
          ${recon.duplicateEndpoints ? `<div class="auto-filter-note">${recon.duplicateEndpoints} discovered endpoint(s) match documented ones${hiddenCount ? ` · ${hiddenCount} app(s) fully covered${newOnly ? ' and hidden' : ''}` : ''}.</div>` : ''}
        </div>
        ${autoNodesHtml || `<div class="empty-sidebar" style="padding:10px 12px;font-size:11.5px;">${
          filter ? 'No matches.'
          : (newOnly && autoProjects.length ? 'Everything discovered is already documented. Nothing new to review.' : 'No matches.')}</div>`}
      </div>
    </div>` : '';

  list.innerHTML = manualHtml + autoSectionHtml;

  list.querySelectorAll('[data-auto-toggle]').forEach(el=>{
    el.addEventListener('click', ()=>{
      state.autoSectionOpen = !state.autoSectionOpen;
      localStorage.setItem(AUTO_SECTION_KEY, state.autoSectionOpen ? '1' : '0');
      renderSidebar();
    });
  });
  const newOnlyBox = list.querySelector('#discoveryNewOnly');
  if(newOnlyBox){
    newOnlyBox.addEventListener('change', ()=>{
      state.discoveryNewOnly = newOnlyBox.checked;
      localStorage.setItem(DISCOVERY_NEW_ONLY_KEY, state.discoveryNewOnly ? '1' : '0');
      renderSidebar();
    });
  }
  list.querySelectorAll('[data-toggle]').forEach(el=>{
    el.addEventListener('click', ()=>{
      const id = el.getAttribute('data-toggle');
      state.projects[id]._open = !(state.projects[id]._open !== false);
      saveState();
      renderSidebar();
    });
  });
  list.querySelectorAll('[data-tag-toggle]').forEach(el=>{
    el.addEventListener('click', (e)=>{
      e.stopPropagation();
      const projId = el.getAttribute('data-tag-toggle');
      const tag = el.getAttribute('data-tag-name');
      const proj = state.projects[projId];
      if(!proj) return;
      proj._closedTags = proj._closedTags || {};
      if(proj._closedTags[tag]) delete proj._closedTags[tag]; else proj._closedTags[tag] = true;
      saveState();
      renderSidebar();
    });
  });
  list.querySelectorAll('[data-overview]').forEach(el=>{
    el.addEventListener('click', (e)=>{
      e.stopPropagation();
      state.selected = { type:'overview', projectId: el.getAttribute('data-overview') };
      renderEnvSwitcher(); renderSidebar(); renderMain(); renderRail();
      closeMobileSidebar();
    });
  });
  list.querySelectorAll('[data-settings]').forEach(el=>{
    el.addEventListener('click', (e)=>{
      e.stopPropagation();
      openProjectModal(el.getAttribute('data-settings'));
    });
  });
  list.querySelectorAll('[data-del]').forEach(el=>{
    el.addEventListener('click', async (e)=>{
      e.stopPropagation();
      const id = el.getAttribute('data-del');
      const projName = state.projects[id].name;
      const epCount = state.projects[id].endpoints.length;
      const ok = await openConfirmModal({
        title: `Delete "${projName}"?`,
        message: `This removes ${epCount} endpoint${epCount===1?'':'s'} and all of its documentation. This can't be undone.`,
        confirmLabel: 'Delete API',
      });
      if(ok){
        // Deleting a project is NOT covered by the debounced saveState()
        // PUT — that endpoint only ever upserts the ids you send it, it
        // never removes one just because it's now missing from the
        // payload (a stale tab with an out-of-date project list would
        // otherwise be able to silently wipe out projects it doesn't even
        // know exist). So this has to go through the dedicated DELETE
        // route first; only drop it from local state once the server has
        // actually confirmed it's gone — otherwise a failed/unauthorized
        // delete would look successful here and then reappear on the next
        // refresh, with no indication anything went wrong.
        try{
          await apiSend('DELETE', '/projects/'+id);
        }catch(err){
          console.error('Delete project failed:', err);
          toast(err.message || 'Could not delete the project on the server — it has not been removed.');
          return;
        }
        delete state.projects[id];
        if(state.selected && state.selected.type==='endpoint' && !projectHasEndpoint(state.selected.id)) state.selected = null;
        if(state.selected && state.selected.type==='overview' && state.selected.projectId===id) state.selected = null;
        logAudit('deleted', 'project', projName, `Deleted project "${projName}" and its ${epCount} endpoint${epCount===1?'':'s'}`, projName);
        renderAll();
      }
    });
  });
  list.querySelectorAll('[data-ep]').forEach(el=>{
    el.addEventListener('click', ()=>{
      state.selected = { type:'endpoint', id: el.getAttribute('data-ep') };
      renderEnvSwitcher(); renderSidebar(); renderMain(); renderRail();
      closeMobileSidebar();
    });
  });
  list.querySelectorAll('[data-ep-del]').forEach(el=>{
    el.addEventListener('click', (e)=>{
      e.stopPropagation();
      deleteEndpointById(el.getAttribute('data-ep-del'));
    });
    el.addEventListener('keydown', (e)=>{
      if(e.key==='Enter' || e.key===' '){ e.preventDefault(); e.stopPropagation(); deleteEndpointById(el.getAttribute('data-ep-del')); }
    });
  });
}

function closeMobileSidebar(){
  document.getElementById('sidebar').classList.remove('show');
}
