/* ==================== SECTION:RENDER-SIDEBAR ==================== */
function updatePinnedNavActive(){
  document.querySelectorAll('.pinned-row').forEach(row=>{
    row.classList.toggle('active', !!state.selected && state.selected.type === row.getAttribute('data-nav'));
  });
}

function renderSidebar(){
  updatePinnedNavActive();
  const list = document.getElementById('projectList');
  const projects = allProjects();
  const filter = document.getElementById('searchBox').value.trim().toLowerCase();

  const dl = document.getElementById('projectNames');
  dl.innerHTML = projects.map(p=>`<option value="${escapeHtml(p.name)}">`).join('');

  if(!projects.length){
    list.innerHTML = `<div class="empty-sidebar">
      No APIs documented yet. Import an OpenAPI/Swagger export, or add an endpoint by hand to get started.
    </div>`;
    return;
  }

  list.innerHTML = projects.map(proj=>{
    const epsForView = viewEndpoints(proj);
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
          ${eps.map(ep=>`
            <div class="ep ${state.selected && state.selected.type==='endpoint' && state.selected.id===ep.id ? 'active':''}" data-ep="${ep.id}">
              <span class="badge ${methodClass(ep.method)}">${ep.method}</span>
              ${(!ep._docLocked && DocMeta.endpointStatusOf(ep) !== 'active') ? `<span class="dm-dot dm-t-${DocMeta.endpointStatusMeta(ep).tone}" style="flex-shrink:0;" title="${escapeHtml(DocMeta.endpointStatusMeta(ep).label)}"></span>` : ''}
              <span class="ep-path" title="${escapeHtml(ep.name ? `${ep.name} — ${ep.path}` : ep.path)}">${escapeHtml(ep.name || ep.path)}</span>
              ${ep._docLocked ? `<span class="icon-btn" title="Documentation access required" style="margin-left:auto;flex-shrink:0;color:var(--text-faint);pointer-events:none;">${ICON_LOCK}</span>` : ''}
              ${canDeleteHere ? `<span class="icon-btn ep-del" data-ep-del="${ep.id}" title="Delete endpoint" role="button" tabindex="0"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg></span>` : ''}
            </div>`).join('')}
        </div>
      </div>`;
    }).join('') || (!isViewingDraftEnv() && !filter ? `<div class="tag-group open"><div class="empty-sidebar" style="padding:10px 8px;font-size:11.5px;">${snapshotEntry(proj.id).status==='loading' ? 'Loading…' : `Nothing promoted to ${escapeHtml(envMeta(state.env).label)} yet.`}</div></div>` : '');

    const initials = (proj.name||'?').trim().split(/\s+/).slice(0,2).map(w=>w[0]).join('').toUpperCase() || '?';
    const accent = PROFILE_COLORS[hashStr(proj.name||'') % PROFILE_COLORS.length];
    const { r:ar, g:ag, b:ab } = hexToRgb(accent);
    const accentBg = `rgba(${ar},${ag},${ab},${state.theme==='light'?0.12:0.18})`;

    return `<div class="project ${isOpen?'open':''}" data-proj="${proj.id}">
      <div class="project-head" data-toggle="${proj.id}" style="--proj-accent:${accent};--proj-accent-bg:${accentBg};">
        <div class="project-name">
          <span class="project-caret">▶</span>
          <span class="project-avatar" style="background:${accent};">${escapeHtml(initials)}</span>
          <span class="txt">${escapeHtml(proj.name)}</span>
        </div>
        <div class="project-actions">
          <span class="project-count">${epsForView.length}</span>
          <span class="icon-btn" data-settings="${proj.id}" title="Project settings"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="6" x2="20" y2="6"></line><line x1="4" y1="12" x2="20" y2="12"></line><line x1="4" y1="18" x2="20" y2="18"></line><circle cx="9" cy="6" r="1.8" fill="var(--surface)"></circle><circle cx="16" cy="12" r="1.8" fill="var(--surface)"></circle><circle cx="9" cy="18" r="1.8" fill="var(--surface)"></circle></svg></span>
          <span class="icon-btn del" data-del="${proj.id}" title="Delete API"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg></span>
        </div>
      </div>
      <div class="tag-group" style="display:${isOpen?'block':'none'};">
        <div class="overview-row ${overviewActive?'active':''}" data-overview="${proj.id}">▸ Overview</div>
      </div>
      ${tagsHtml}
    </div>`;
  }).join('');

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
