/* ==================== SECTION:EVENTS ==================== */
document.getElementById('fileInput').addEventListener('change', (e)=>{
  if(e.target.files[0]) handleImportedFile(e.target.files[0]);
  e.target.value = '';
});
document.getElementById('btnAuditLog').addEventListener('click', ()=>{
  closeTopbarMoreMenu();
  openAuditLogTab();
});
document.getElementById('btnSecurityCenter').addEventListener('click', ()=>{
  state.selected = { type:'security' };
  state.securityTab = state.securityTab || (isAdmin() ? 'summary' : 'docaccess');
  renderMain();
});
document.getElementById('btnReleasePipeline').addEventListener('click', ()=>{
  state.selected = { type:'releasepipeline' };
  renderMain();
});
document.getElementById('btnObservability').addEventListener('click', ()=>{
  state.selected = { type:'observability' };
  renderSidebar();
  renderMain();
});
// The FAB used to always call openEditorTab(currentProjectForEnvContext(), null) —
// meaning if you'd last viewed (or were viewing) some project, EVERY field shared
// across that project (name, owner, team, auth type, auth params, everything under
// "Project details"/"Authentication") got silently pre-filled into what you might
// have intended as a brand-new project. There was no explicit way to say "no,
// start fresh" — only retyping the project name and hoping the input listener in
// editor.html (fProject's 'input' handler) cleared everything else in time. Now the
// FAB asks, whenever there's an actual current project to disambiguate against.
document.getElementById('btnFab').addEventListener('click', (e)=>{
  e.stopPropagation();
  if(!canEditHere()){ toast(isViewingDraftEnv() ? `Your role (${roleMeta(state.authorRole).label}) is read-only` : `Switch to ${envMeta(draftEnvId()).label} to make changes`); return; }
  const ctxProj = currentProjectForEnvContext();
  if(!ctxProj){
    // Nothing is currently in view to confuse this with — go straight to blank,
    // same as clicking "New project" below.
    openEditorTab(null, null);
    return;
  }
  const dd = document.getElementById('fabDD');
  const willOpen = !dd.classList.contains('open');
  if(willOpen) document.getElementById('fabAddEndpointSub').textContent = ctxProj.name;
  dd.classList.toggle('open', willOpen);
  document.getElementById('btnFab').setAttribute('aria-expanded', String(willOpen));
});
document.getElementById('fabAddEndpoint').addEventListener('click', ()=>{
  document.getElementById('fabDD').classList.remove('open');
  document.getElementById('btnFab').setAttribute('aria-expanded', 'false');
  openEditorTab(currentProjectForEnvContext(), null);
});
document.getElementById('fabNewProject').addEventListener('click', ()=>{
  document.getElementById('fabDD').classList.remove('open');
  document.getElementById('btnFab').setAttribute('aria-expanded', 'false');
  openEditorTab(null, null);
});
document.getElementById('fabImportProject').addEventListener('click', ()=>{
  document.getElementById('fabDD').classList.remove('open');
  document.getElementById('btnFab').setAttribute('aria-expanded', 'false');
  if(!canEditHere()){ toast(isViewingDraftEnv() ? `Your role (${roleMeta(state.authorRole).label}) is read-only` : `Switch to ${envMeta(draftEnvId()).label} to make changes`); return; }
  document.getElementById('projectImportInput').click();
});
// Primary entry point — always visible in the top bar, unlike the FAB's copy of
// this action, which only appears in the dropdown when a project is currently
// in view (see updateFabIntent/currentProjectForEnvContext in 08-render-chrome.js).
// Import is exactly the action someone reaches for when there's NO relevant
// project open (e.g. right after deleting one, or from a blank Control Center),
// so it can't depend on that context existing.
document.getElementById('btnImportProjectTop').addEventListener('click', ()=>{
  closeTopbarMoreMenu();
  if(!canEditHere()){ toast(isViewingDraftEnv() ? `Your role (${roleMeta(state.authorRole).label}) is read-only` : `Switch to ${envMeta(draftEnvId()).label} to make changes`); return; }
  document.getElementById('projectImportInput').click();
});

/* ---------- Topbar "More" overflow menu (Audit Log, Import project) ---------- */
function closeTopbarMoreMenu(){
  document.getElementById('topbarMoreMenu').classList.remove('open');
  document.getElementById('btnTopbarMore').setAttribute('aria-expanded', 'false');
}
document.getElementById('btnTopbarMore').addEventListener('click', (e)=>{
  e.stopPropagation();
  const menu = document.getElementById('topbarMoreMenu');
  const willOpen = !menu.classList.contains('open');
  menu.classList.toggle('open', willOpen);
  document.getElementById('btnTopbarMore').setAttribute('aria-expanded', String(willOpen));
});
document.addEventListener('click', (e)=>{
  if(!e.target.closest('#topbarMoreMenu') && !e.target.closest('#btnTopbarMore')) closeTopbarMoreMenu();
});
document.getElementById('projectImportInput').addEventListener('change', (e)=>{
  if(e.target.files[0]) importProjectFromJsonFile(e.target.files[0]);
  e.target.value = '';
});

// When adding a NEW endpoint and the typed project name matches an existing
// project, pull that project's API-level description in automatically —
// otherwise it's easy to never see it and assume the tool "lost" it.
document.getElementById('mProject').addEventListener('input', (e)=>{
  if(editingEndpointId) return; // don't clobber an existing endpoint's loaded data
  const match = allProjects().find(p=>p.name.toLowerCase() === e.target.value.trim().toLowerCase());
  const apiDescEl = document.getElementById('mApiDesc');
  if(match && !apiDescEl.value.trim()){
    apiDescEl.value = match.description || '';
  }
  // Version is a project-wide value (see saveManualEndpoint) — pull it in too
  // when the typed name matches an existing project, same as the description.
  const versionEl = document.getElementById('mVersion');
  if(match && !versionEl.value.trim()){
    versionEl.value = match.version || '';
  }
  // Pull in that project's real "Project details" / "Authentication" fields
  // too, so typing an existing project's name shows its actual shared
  // settings instead of leaving stale/blank values that would overwrite them
  // on save.
  if(match) hydrateEndpointProjectFields(match);
  else clearEndpointProjectFields();
});
document.getElementById('mCancel').addEventListener('click', closeManualModal);
document.getElementById('mSave').addEventListener('click', saveManualEndpoint);
document.getElementById('mDelete').addEventListener('click', deleteEndpointFromModal);
document.getElementById('mRender').addEventListener('click', ()=>openRenderView());
document.getElementById('manualModal').addEventListener('click', (e)=>{ if(e.target.id === 'manualModal') closeManualModal(); });

document.getElementById('renderClose').addEventListener('click', closeRenderView);
document.getElementById('renderOverlay').addEventListener('click', (e)=>{ if(e.target.id === 'renderOverlay') closeRenderView(); });

document.getElementById('pdfEpSearch').addEventListener('input', (e)=>filterPdfEpList(e.target.value));
document.getElementById('pdfSelectAll').addEventListener('click', ()=>{
  document.querySelectorAll('.pdf-ep-check').forEach(c=>{ if(c.closest('[data-pdf-row]').style.display !== 'none') c.checked = true; });
  updatePdfSelectedCount();
});
document.getElementById('pdfSelectNone').addEventListener('click', ()=>{
  document.querySelectorAll('.pdf-ep-check').forEach(c=>{ if(c.closest('[data-pdf-row]').style.display !== 'none') c.checked = false; });
  updatePdfSelectedCount();
});
document.getElementById('pdfEpList').addEventListener('change', (e)=>{ if(e.target.classList.contains('pdf-ep-check')) updatePdfSelectedCount(); });
document.getElementById('pdfExportCancel').addEventListener('click', closeExportPdfModal);
document.getElementById('pdfExportGenerate').addEventListener('click', generateProjectPdf);
document.getElementById('pdfExportModal').addEventListener('click', (e)=>{ if(e.target.id === 'pdfExportModal') closeExportPdfModal(); });

document.getElementById('pgCancel').addEventListener('click', closeProjectModal);
document.getElementById('btnOpenArchStudioSettings').addEventListener('click', ()=>{
  if(editingProjectId && state.projects[editingProjectId]) openArchitectureStudioTab(state.projects[editingProjectId]);
});
document.getElementById('btnOpenReleasePipelineSettings').addEventListener('click', ()=>{
  if(editingProjectId && state.projects[editingProjectId]) openReleasePipelineTab(state.projects[editingProjectId]);
});

/* Request flows (one or more diagrams per project) are edited by the shared
   FlowEditor (public/js/flow-editor.js) mounted on #mFlowsRoot in the endpoint
   modal's "Project details" section — populated by hydrateEndpointProjectFields
   / clearEndpointProjectFields and read in saveManualEndpoint, so no extra
   wiring is needed here. */

/* Environments tab (live status + copy-to-clipboard) was removed along with
   Project settings ▸ Environments — see the note near renderEnvSettingsCards'
   old location for what still reads proj.environments elsewhere. */

document.querySelectorAll('[data-md-insert]').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    const tpl = MD_TEMPLATES[btn.getAttribute('data-md-insert')];
    const targetId = btn.getAttribute('data-md-target') || 'mApiDesc';
    if(tpl) insertAtCursor(document.getElementById(targetId), tpl);
  });
});
function wireMdPreviewToggle(toggleId, textareaId, previewId){
  const toggleEl = document.getElementById(toggleId);
  if(!toggleEl) return;
  toggleEl.addEventListener('click', (e)=>{
    const ta = document.getElementById(textareaId);
    const pane = document.getElementById(previewId);
    const showing = pane.classList.toggle('show');
    e.currentTarget.textContent = showing ? 'Edit' : 'Preview';
    if(showing){
      pane.innerHTML = ta.value.trim() ? renderMarkdown(ta.value) : '<span style="color:var(--text-faint);">Nothing to preview yet.</span>';
      ta.classList.add('hidden-src');
    } else {
      ta.classList.remove('hidden-src');
    }
  });
}
wireMdPreviewToggle('mApiDescPreviewToggle', 'mApiDesc', 'mApiDescPreview');
document.getElementById('projectModal').addEventListener('click', (e)=>{ if(e.target.id === 'projectModal') closeProjectModal(); });
document.querySelectorAll('.modal-tab').forEach(tab=>{
  tab.addEventListener('click', ()=>{
    document.querySelectorAll('.modal-tab').forEach(t=>t.classList.remove('active'));
    tab.classList.add('active');
    const name = tab.getAttribute('data-mtab');
    document.querySelectorAll('.modal-pane').forEach(p=>p.classList.remove('active'));
    document.querySelector(`.modal-pane[data-mpane="${name}"]`).classList.add('active');
  });
});

document.getElementById('importClose').addEventListener('click', ()=>document.getElementById('importModal').classList.remove('show'));
document.getElementById('importModal').addEventListener('click', (e)=>{ if(e.target.id === 'importModal') document.getElementById('importModal').classList.remove('show'); });

document.querySelectorAll('.pinned-row').forEach(row=>{
  row.addEventListener('click', ()=>{
    state.selected = { type: row.getAttribute('data-nav') };
    renderEnvSwitcher(); renderSidebar(); renderMain(); renderRail();
    closeMobileSidebar();
  });
});

document.getElementById('searchBox').addEventListener('input', renderSidebar);

document.getElementById('btnTheme').addEventListener('click', ()=>{
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  saveTheme();
  applyTheme();
});

document.getElementById('btnAuthor').addEventListener('click', ()=>{
  state.selected = { type: 'profile' };
  renderEnvSwitcher(); renderSidebar(); renderMain(); renderRail();
  closeMobileSidebar();
});

document.getElementById('btnLogout').addEventListener('click', async ()=>{
  try{ await fetch('/api/auth/logout', { method:'POST', credentials:'include' }); }
  catch(e){ /* ignore — redirect to login regardless */ }
  window.location.href = '/login.html';
});

document.getElementById('btnCommandPalette').addEventListener('click', openPalette);
// The stored ⌘K hint only makes sense on macOS — everywhere else the actual
// shortcut is Ctrl+K (see the keydown handler below), so the visible hint
// should match what the person's hand is actually pressing.
if(!/Mac|iPod|iPhone|iPad/.test(navigator.platform)){
  document.querySelector('#btnCommandPalette .kbd-hint').innerHTML = '<kbd>Ctrl</kbd><kbd>K</kbd>';
}

/* ---------- Command palette wiring ---------- */
document.getElementById('paletteOverlay').addEventListener('click', (e)=>{ if(e.target.id === 'paletteOverlay') closePalette(); });
document.getElementById('paletteInput').addEventListener('input', (e)=>renderPaletteResults(e.target.value));
document.getElementById('paletteInput').addEventListener('keydown', (e)=>{
  if(e.key === 'ArrowDown'){ e.preventDefault(); paletteSelIndex = Math.min(paletteSelIndex+1, paletteItems.length-1); updatePaletteSelection(); }
  else if(e.key === 'ArrowUp'){ e.preventDefault(); paletteSelIndex = Math.max(paletteSelIndex-1, 0); updatePaletteSelection(); }
  else if(e.key === 'Enter'){ e.preventDefault(); selectPaletteItem(paletteSelIndex); }
  else if(e.key === 'Escape'){ closePalette(); }
});

document.addEventListener('keydown', (e)=>{
  const cmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k';
  if(cmdK){
    e.preventDefault();
    const overlay = document.getElementById('paletteOverlay');
    overlay.classList.contains('show') ? closePalette() : openPalette();
    return;
  }
  const cmdB = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b';
  if(cmdB){
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    const editing = ['INPUT','TEXTAREA','SELECT'].includes(tag) || (document.activeElement && document.activeElement.isContentEditable);
    if(!editing){
      e.preventDefault();
      toggleSidebar();
      return;
    }
  }
  if(e.key === 'Escape'){
    if(document.getElementById('inspFullscreen').classList.contains('show')){
      closeInspectorFullscreen();
      return;
    }
    document.querySelectorAll('.modal-overlay.show').forEach(m=>m.classList.remove('show'));
    closeRenderView();
    closePalette();
    closeTopbarMoreMenu();
  }
});

/* ---------- Sidebar / rail chrome toggles ---------- */
document.getElementById('btnSidebarToggle').addEventListener('click', toggleSidebar);
document.getElementById('btnSidebarEdgeToggle').addEventListener('click', toggleSidebar);

/* ---------- Sidebar drag-to-resize ---------- */
(function(){
  const SB_WIDTH_KEY = 'sbWidth';
  const MIN_W = 220, MAX_W = 520;
  const app = document.getElementById('app');
  const handle = document.getElementById('sidebarResizeHandle');
  if(!handle) return;

  const savedWidth = parseInt(localStorage.getItem(SB_WIDTH_KEY), 10);
  if(savedWidth && savedWidth >= MIN_W && savedWidth <= MAX_W){
    app.style.setProperty('--sb-w', savedWidth + 'px');
  }

  let dragging = false, startX = 0, startW = 0;
  handle.addEventListener('pointerdown', (e)=>{
    if(state.sidebarCollapsed) return;
    dragging = true;
    startX = e.clientX;
    startW = document.getElementById('sidebar').getBoundingClientRect().width;
    app.classList.add('sb-resizing');
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  handle.addEventListener('pointermove', (e)=>{
    if(!dragging) return;
    const w = Math.min(MAX_W, Math.max(MIN_W, startW + (e.clientX - startX)));
    app.style.setProperty('--sb-w', w + 'px');
  });
  function endDrag(e){
    if(!dragging) return;
    dragging = false;
    app.classList.remove('sb-resizing');
    const w = document.getElementById('sidebar').getBoundingClientRect().width;
    localStorage.setItem(SB_WIDTH_KEY, String(Math.round(w)));
  }
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);
  handle.addEventListener('dblclick', ()=>{
    app.style.removeProperty('--sb-w');
    localStorage.removeItem(SB_WIDTH_KEY);
  });
})();
// When collapsed to the icon rail, clicking the search icon or the home icon
// re-expands the sidebar (rather than doing nothing, or requiring the person
// to find the edge handle) — search additionally focuses the input.
document.querySelector('.sidebar-search-wrap').addEventListener('click', ()=>{
  if(state.sidebarCollapsed) expandSidebarThen(true);
});
document.querySelector('[data-nav="home"]').addEventListener('click', ()=>{
  if(state.sidebarCollapsed) expandSidebarThen(false);
});

/* ---------- Environment dropdown (delegated — #envSwitcher itself persists across re-renders) ---------- */
document.getElementById('envSwitcher').addEventListener('click', (e)=>{
  if(e.target.closest('#envDDBtn')){
    const dd = document.getElementById('envDD');
    dd.classList.contains('open') ? closeEnvDropdown() : openEnvDropdown();
    return;
  }
  const opt = e.target.closest('.env-dd-opt');
  if(opt){
    selectEnvironment(opt.getAttribute('data-env'));
    closeEnvDropdown();
    document.getElementById('envDDBtn').focus();
  }
});
document.getElementById('envSwitcher').addEventListener('keydown', (e)=>{
  const dd = document.getElementById('envDD');
  if(!dd) return;
  const isOpen = dd.classList.contains('open');
  const opts = Array.from(dd.querySelectorAll('.env-dd-opt'));
  const focusedIdx = opts.findIndex(o=>o.classList.contains('kbd-focus'));
  if(e.key === 'Enter' || e.key === ' '){
    e.preventDefault();
    if(!isOpen){ openEnvDropdown(); return; }
    const target = opts[focusedIdx] || opts.find(o=>o.classList.contains('sel'));
    if(target){ selectEnvironment(target.getAttribute('data-env')); closeEnvDropdown(); document.getElementById('envDDBtn').focus(); }
    return;
  }
  if(e.key === 'Escape' && isOpen){
    e.preventDefault(); closeEnvDropdown(); document.getElementById('envDDBtn').focus(); return;
  }
  if(e.key === 'ArrowDown' || e.key === 'ArrowUp'){
    e.preventDefault();
    if(!isOpen){ openEnvDropdown(); return; }
    let next = focusedIdx;
    if(e.key === 'ArrowDown') next = focusedIdx < 0 ? 0 : Math.min(opts.length-1, focusedIdx+1);
    else next = focusedIdx < 0 ? opts.length-1 : Math.max(0, focusedIdx-1);
    opts.forEach(o=>o.classList.remove('kbd-focus'));
    if(opts[next]) opts[next].classList.add('kbd-focus');
  }
});
document.addEventListener('click', (e)=>{
  const dd = document.getElementById('envDD');
  if(dd && dd.classList.contains('open') && !dd.contains(e.target)) closeEnvDropdown();
  const epDD = document.getElementById('epActionsDD');
  if(epDD && epDD.classList.contains('open') && !epDD.contains(e.target)) epDD.classList.remove('open');
  const projDD = document.getElementById('projActionsDD');
  if(projDD && projDD.classList.contains('open') && !projDD.contains(e.target)) projDD.classList.remove('open');
  const fabDD = document.getElementById('fabDD');
  if(fabDD && fabDD.classList.contains('open') && !fabDD.contains(e.target)){
    fabDD.classList.remove('open');
    document.getElementById('btnFab').setAttribute('aria-expanded', 'false');
  }
  if(envRowMenu.id !== null){
    const openDD = document.querySelector(`.row-actions-dd[data-row-dd="${envRowMenu.id}"]`);
    if(openDD && !openDD.contains(e.target)){ envRowMenu = { id:null, mode:'menu' }; renderEnvTableSection(); }
  }
  if(usersState.rowMenu.id !== null){
    const openUserDD = document.querySelector(`.row-actions-dd[data-urow-dd="${usersState.rowMenu.id}"]`);
    if(openUserDD && !openUserDD.contains(e.target)){ usersState.rowMenu = { id:null }; renderUsersTableSection(); }
  }
  const envAddForm = document.getElementById('envAddForm');
  const envAddBtnEl = document.getElementById('envTableAddBtn');
  const envAddBtnEmptyEl = document.getElementById('envTableAddBtnEmpty');
  if(envAddFormOpen && envAddForm && !envAddForm.contains(e.target) && e.target!==envAddBtnEl && e.target!==envAddBtnEmptyEl){
    envAddFormOpen = false; renderEnvTableSection();
  }
  const toggleProjVisBtn = e.target.closest('[data-toggle-proj-visibility]');
  if(toggleProjVisBtn){ toggleProjectVisibility(toggleProjVisBtn.getAttribute('data-toggle-proj-visibility')); }
  const toggleEpVisBtn = e.target.closest('[data-toggle-ep-visibility]');
  if(toggleEpVisBtn){ toggleEndpointVisibility(toggleEpVisBtn.getAttribute('data-toggle-ep-visibility')); }
  const ovCopyBtn = e.target.closest('[data-ov-env-copy]');
  if(ovCopyBtn){
    const url = ovCopyBtn.getAttribute('data-ov-env-copy');
    if(url && navigator.clipboard){
      navigator.clipboard.writeText(url).then(()=> toast('Base URL copied')).catch(()=>{});
    }
  }
});
// The row-actions panel is position:fixed (see CSS) so it doesn't get clipped by
// .table-scroll, but that also means it won't track the button if the page or the
// table scrolls underneath it — close it on any scroll instead of letting it drift.
// Covers BOTH row-menu panels that use this position:fixed pattern: the
// environments table (envRowMenu) and the Members table (usersState.rowMenu).
// Only the former was wired in here before, which is exactly why the Members
// "⋮" menu kept floating away from its button on scroll while the
// Environments one closed cleanly.
document.addEventListener('scroll', (e)=>{
  if(envRowMenu.id !== null){ envRowMenu = { id:null, mode:'menu' }; renderEnvTableSection(); }
  if(usersState.rowMenu.id !== null){ usersState.rowMenu = { id:null }; renderUsersTableSection(); }
}, true);
function openCodeSamplesRail(){
  document.getElementById('rail').classList.add('show');
  document.getElementById('railScrim').classList.add('show');
}
document.getElementById('railScrim').addEventListener('click', ()=>{
  document.getElementById('rail').classList.remove('show');
  document.getElementById('railScrim').classList.remove('show');
});
