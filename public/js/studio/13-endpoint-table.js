/* ==================== SECTION:ENDPOINT TABLE ==================== */
// Environment / Endpoint / Access / Color / Actions table — lives on the Profile page,
// replacing the old simple "add/remove environment" card grid.
let envRowMenu = { id:null, mode:'menu' };   // which row's ⋮ menu is open, and its sub-view
let envAddFormOpen = false;
let envAddColorChoice = ENV_NAMED_COLORS[0].hex;

function renderEnvTableSection(){
  const container = document.getElementById('envTableSection');
  if(!container) return;
  if(state.envTableStatus === 'error'){
    container.innerHTML = `
      <div class="env-table-error">
        Couldn't load your saved environments — the stored data looks corrupted.
        <br><button type="button" class="primary" id="envTableRetry">Reset to defaults</button>
      </div>`;
    document.getElementById('envTableRetry').addEventListener('click', ()=>{
      state.environments = DEFAULT_ENVIRONMENTS.map(e=>({...e}));
      saveEnvironments();
      state.envTableStatus = 'ready';
      renderEnvTableSection();
    });
    return;
  }
  container.innerHTML = envTableHtml();
  bindEnvTableEvents(container);
  positionOpenRowPanel();
}

// The row-actions panel uses position:fixed (see CSS) so it isn't clipped by the
// .table-scroll container's overflow-x:auto — it's measured against the trigger
// button and clamped to the viewport instead of relying on table layout.
function positionOpenRowPanel(){
  if(!envRowMenu.id) return;
  const btn = document.querySelector(`[data-row-dd-btn="${envRowMenu.id}"]`);
  const panel = document.querySelector(`[data-row-panel="${envRowMenu.id}"]`);
  if(!btn || !panel || !panel.firstElementChild) return;
  const rect = btn.getBoundingClientRect();
  const pw = panel.offsetWidth || 200;
  const ph = panel.offsetHeight || 120;
  let left = rect.right - pw;
  if(left < 8) left = 8;
  if(left + pw > window.innerWidth - 8) left = window.innerWidth - 8 - pw;
  let top = rect.bottom + 4;
  if(top + ph > window.innerHeight - 8) top = rect.top - ph - 4;
  if(top < 8) top = 8;
  panel.style.left = left + 'px';
  panel.style.top = top + 'px';
}

function envTableHtml(){
  const ui = state.envTableUI;
  let list = environments().slice();
  if(ui.search){
    const q = ui.search.toLowerCase();
    list = list.filter(e => e.label.toLowerCase().includes(q) || (e.url||'').toLowerCase().includes(q));
  }
  if(ui.filterAccess) list = list.filter(e=>e.access===ui.filterAccess);
  if(ui.filterColor) list = list.filter(e=>e.color.toLowerCase()===ui.filterColor.toLowerCase());
  const dragEnabled = !ui.search && !ui.filterAccess && !ui.filterColor && !ui.sortBy;
  if(ui.sortBy){
    const dir = ui.sortDir === 'desc' ? -1 : 1;
    list.sort((a,b)=>{
      let av, bv;
      if(ui.sortBy==='label'){ av=a.label.toLowerCase(); bv=b.label.toLowerCase(); }
      else if(ui.sortBy==='url'){ av=(a.url||'').toLowerCase(); bv=(b.url||'').toLowerCase(); }
      else if(ui.sortBy==='access'){ av=accessMeta(a.access).label; bv=accessMeta(b.access).label; }
      else { av=colorName(a.color); bv=colorName(b.color); }
      return av < bv ? -1*dir : av > bv ? 1*dir : 0;
    });
  }
  const sortArrow = (col)=> ui.sortBy===col ? `<span class="sort-arrow">${ui.sortDir==='desc'?'▼':'▲'}</span>` : '';
  const canReveal = canRevealSensitive();
  const isFiltered = !!(ui.search || ui.filterAccess || ui.filterColor);

  const bodyHtml = list.length
    ? list.map(e=>envRowHtml(e, dragEnabled, canReveal)).join('')
    : `<tr><td colspan="7" style="padding:0;border-bottom:none;">
        <div class="env-table-empty">
          ${isFiltered ? 'No environments match your search or filters.' : 'No environments yet — add one to get started.'}
          <br>
          ${isFiltered
            ? '<button type="button" id="envTableClearFilters">Clear filters</button>'
            : '<button type="button" class="primary" id="envTableAddBtnEmpty">Add your first environment</button>'}
        </div>
      </td></tr>`;

  return `
    <div class="env-table-toolbar">
      <div class="env-table-search">
        <span class="env-table-search-ic"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.2" y2="16.2"></line></svg></span>
        <input type="text" id="envTableSearchInput" placeholder="Search environments or endpoints…" value="${escapeHtml(ui.search)}">
      </div>
      <select id="envTableFilterAccess" title="Filter by access">
        <option value="">All access levels</option>
        ${ENV_ACCESS_LEVELS.map(a=>`<option value="${a.id}" ${ui.filterAccess===a.id?'selected':''}>${a.label}</option>`).join('')}
      </select>
      <select id="envTableFilterColor" title="Filter by color">
        <option value="">All colors</option>
        ${ENV_NAMED_COLORS.map(c=>`<option value="${c.hex}" ${ui.filterColor.toLowerCase()===c.hex.toLowerCase()?'selected':''}>${c.name}</option>`).join('')}
      </select>
      <span class="spacer"></span>
      <button type="button" class="primary" id="envTableAddBtn">+ Add environment</button>
    </div>
    ${envAddFormOpen ? envAddFormHtml() : ''}
    <div class="table-scroll">
    <table class="data-table env-data-table">
      <thead><tr>
        <th style="width:24px;"></th>
        <th data-sort="label">Environment ${sortArrow('label')}</th>
        <th data-sort="url">Endpoint ${sortArrow('url')}</th>
        <th data-sort="access">Access ${sortArrow('access')}</th>
        <th data-sort="color">Color ${sortArrow('color')}</th>
        <th title="Whether promoting into this stage in the Release Pipeline needs a second Admin's approval">Approval</th>
        <th style="width:40px;">Actions</th>
      </tr></thead>
      <tbody id="envTableBody">${bodyHtml}</tbody>
    </table>
    </div>
  `;
}

function envAddFormHtml(){
  return `
  <div class="row-actions-edit-form" id="envAddForm" style="max-width:360px;margin-bottom:12px;background:var(--surface-2);border:1px solid var(--border-strong);border-radius:10px;padding:12px;">
    <div><label>Environment name</label><input type="text" id="envAddLabelInput" placeholder="e.g. QA" maxlength="40"></div>
    <div><label>Endpoint URL <span style="text-transform:none;font-weight:500;">— optional, sensitive, masked by default</span></label><input type="text" id="envAddUrlInput" placeholder="https://api.example.com"></div>
    <div><label>Access</label><select id="envAddAccessInput">${ENV_ACCESS_LEVELS.map(a=>`<option value="${a.id}"${a.id==='user'?' selected':''}>${a.label}</option>`).join('')}</select></div>
    <div><label>Color</label>
      <div class="row-actions-swatch-grid" id="envAddColorSwatches">
        ${ENV_NAMED_COLORS.map(c=>`<span class="row-actions-swatch${envAddColorChoice.toLowerCase()===c.hex.toLowerCase()?' sel':''}" style="background:${c.hex};" data-add-color="${c.hex}" title="${c.name}"></span>`).join('')}
      </div>
    </div>
    <div class="raf-actions">
      <button type="button" class="row-actions-item" id="envAddCancel">Cancel</button>
      <button type="button" class="primary" id="envAddSave">Add environment</button>
    </div>
  </div>`;
}

function envRowHtml(e, dragEnabled, canReveal){
  const revealed = !!state.envUrlRevealed[e.id];
  const hasUrl = !!e.url;
  const displayUrl = hasUrl ? (revealed ? e.url : maskEndpointUrl(e.url)) : 'Not set';
  const isRestricted = e.access === 'restricted';
  const menuOpen = envRowMenu.id === e.id;
  return `
  <tr class="env-row${isRestricted?' env-row-prod':''}" data-env-row="${e.id}" ${dragEnabled?'draggable="true"':''}>
    <td class="env-drag-handle-cell"><span class="env-drag-handle${dragEnabled?'':' disabled'}" title="${dragEnabled?'Drag to reorder':'Clear search, filters &amp; sort to reorder'}">${ICON_DRAG}</span></td>
    <td><span class="env-pill" style="--pill-c:${e.color};"><span class="env-pill-dot"></span>${escapeHtml(e.label)}</span></td>
    <td>
      <div class="env-url-cell">
        <span class="env-url-value${hasUrl?(revealed?'':' masked'):' empty'}">${escapeHtml(displayUrl)}</span>
        ${hasUrl ? `<button type="button" class="icon-btn env-reveal-btn${canReveal?'':' locked'}" data-env-reveal="${e.id}" title="${canReveal ? (revealed?'Hide value':'Reveal value') : 'Only the Admin role can reveal this value'}">${canReveal ? (revealed?ICON_EYE_OFF:ICON_EYE) : ICON_LOCK}</button>` : ''}
      </div>
    </td>
    <td><span class="access-badge access-${e.access}">${accessMeta(e.access).label}</span></td>
    <td><span class="env-color-dot" style="background:${e.color};" title="${colorName(e.color)}"></span></td>
    <td>${e.requiresApproval
      ? `<span class="approval-badge" title="A second Admin must approve every promotion into ${escapeHtml(e.label)} in the Release Pipeline">🛡 2nd approval</span>`
      : `<span class="empty-field" style="font-size:11px;">—</span>`}</td>
    <td>
      <div class="row-actions-dd${menuOpen?' open':''}" data-row-dd="${e.id}">
        <button type="button" class="icon-btn row-actions-btn" data-row-dd-btn="${e.id}" title="More actions">⋮</button>
        <div class="row-actions-panel" data-row-panel="${e.id}">${menuOpen ? rowActionsPanelHtml(e, envRowMenu.mode) : ''}</div>
      </div>
    </td>
  </tr>`;
}

function rowActionsPanelHtml(e, mode){
  if(mode==='edit'){
    return `<div class="row-actions-edit-form">
      <div><label>Label</label><input type="text" id="rafLabel" value="${escapeHtml(e.label)}" maxlength="40"></div>
      <div><label>Endpoint URL</label><input type="text" id="rafUrl" value="${escapeHtml(e.url)}" placeholder="https://api.example.com"></div>
      <div class="raf-actions">
        <button type="button" class="row-actions-item" data-act="cancel" data-id="${e.id}">Cancel</button>
        <button type="button" class="row-actions-item" style="color:var(--accent);" data-act="save-edit" data-id="${e.id}">Save</button>
      </div>
    </div>`;
  }
  if(mode==='color'){
    return `<div class="row-actions-swatch-grid">
      ${ENV_NAMED_COLORS.map(c=>`<span class="row-actions-swatch${e.color.toLowerCase()===c.hex.toLowerCase()?' sel':''}" style="background:${c.hex};" title="${c.name}" data-act="pick-color" data-color="${c.hex}" data-id="${e.id}"></span>`).join('')}
    </div>`;
  }
  if(mode==='access'){
    return ENV_ACCESS_LEVELS.map(a=>`<button type="button" class="row-actions-item" data-act="pick-access" data-access="${a.id}" data-id="${e.id}">${a.label}${e.access===a.id?' ✓':''}</button>`).join('');
  }
  const isOnly = environments().length <= 1;
  return `
    <button type="button" class="row-actions-item" data-act="edit" data-id="${e.id}">Edit</button>
    <button type="button" class="row-actions-item" data-act="color" data-id="${e.id}">Change Color</button>
    <button type="button" class="row-actions-item" data-act="access" data-id="${e.id}">Change Access</button>
    <button type="button" class="row-actions-item" data-act="toggle-approval" data-id="${e.id}" title="GitHub-style branch protection: require a second Admin's approval before anyone can promote into this stage in the Release Pipeline">${e.requiresApproval ? 'Remove approval requirement' : 'Require 2nd approval to promote'}</button>
    <div class="row-actions-divider"></div>
    <button type="button" class="row-actions-item" data-act="top" data-id="${e.id}">Move to Top</button>
    <button type="button" class="row-actions-item" data-act="bottom" data-id="${e.id}">Move to Bottom</button>
    <div class="row-actions-divider"></div>
    <button type="button" class="row-actions-item danger" data-act="delete" data-id="${e.id}"${isOnly?' disabled title="At least one environment is required"':''}>Delete</button>
  `;
}

function bindEnvTableEvents(container){
  const searchInput = document.getElementById('envTableSearchInput');
  if(searchInput){
    searchInput.addEventListener('input', ()=>{
      state.envTableUI.search = searchInput.value;
      renderEnvTableSection();
      const el = document.getElementById('envTableSearchInput');
      if(el){ el.focus(); const v = el.value; el.setSelectionRange(v.length, v.length); }
    });
  }
  const filterAccess = document.getElementById('envTableFilterAccess');
  if(filterAccess) filterAccess.addEventListener('change', ()=>{ state.envTableUI.filterAccess = filterAccess.value; renderEnvTableSection(); });
  const filterColor = document.getElementById('envTableFilterColor');
  if(filterColor) filterColor.addEventListener('change', ()=>{ state.envTableUI.filterColor = filterColor.value; renderEnvTableSection(); });

  container.querySelectorAll('th[data-sort]').forEach(th=>{
    th.addEventListener('click', ()=>{
      const col = th.getAttribute('data-sort');
      const ui = state.envTableUI;
      if(ui.sortBy === col) ui.sortDir = ui.sortDir==='asc' ? 'desc' : 'asc';
      else { ui.sortBy = col; ui.sortDir = 'asc'; }
      renderEnvTableSection();
    });
  });

  const addBtn = document.getElementById('envTableAddBtn');
  const addBtnEmpty = document.getElementById('envTableAddBtnEmpty');
  [addBtn, addBtnEmpty].forEach(b=>{
    if(!b) return;
    b.addEventListener('click', ()=>{
      envAddFormOpen = true;
      envAddColorChoice = ENV_NAMED_COLORS[0].hex;
      renderEnvTableSection();
      const el = document.getElementById('envAddLabelInput');
      if(el) el.focus();
    });
  });

  const clearFilters = document.getElementById('envTableClearFilters');
  if(clearFilters) clearFilters.addEventListener('click', ()=>{
    state.envTableUI = { search:'', filterAccess:'', filterColor:'', sortBy:null, sortDir:'asc' };
    renderEnvTableSection();
  });

  const addCancel = document.getElementById('envAddCancel');
  if(addCancel) addCancel.addEventListener('click', ()=>{ envAddFormOpen = false; renderEnvTableSection(); });
  const addSave = document.getElementById('envAddSave');
  if(addSave) addSave.addEventListener('click', ()=>{
    const label = document.getElementById('envAddLabelInput').value.trim();
    const url = document.getElementById('envAddUrlInput').value.trim();
    const access = document.getElementById('envAddAccessInput').value;
    if(url){ try{ new URL(url); }catch(e){ toast('Enter a valid URL, e.g. https://api.example.com'); return; } }
    const result = addEnvironment(label, envAddColorChoice, access, url);
    if(!result.ok){ toast(result.error); return; }
    envAddFormOpen = false;
    toast(`Added "${result.env.label}" environment`);
    renderEnvSwitcher();
    renderEnvTableSection();
  });
  const addSwatches = document.getElementById('envAddColorSwatches');
  if(addSwatches){
    addSwatches.querySelectorAll('[data-add-color]').forEach(sw=>{
      sw.addEventListener('click', ()=>{
        envAddColorChoice = sw.getAttribute('data-add-color');
        addSwatches.querySelectorAll('[data-add-color]').forEach(s=>s.classList.toggle('sel', s===sw));
      });
    });
  }

  container.querySelectorAll('[data-env-reveal]').forEach(btn=>{
    btn.addEventListener('click', (ev)=>{
      ev.stopPropagation();
      const id = btn.getAttribute('data-env-reveal');
      if(!canRevealSensitive()){ toast('Only the Admin role can reveal endpoint values'); return; }
      if(state.envUrlRevealed[id]){ delete state.envUrlRevealed[id]; renderEnvTableSection(); return; }
      requestSensitiveReveal(`Environment URL — ${id}`, ()=>{
        state.envUrlRevealed[id] = true;
        renderEnvTableSection();
      }, ()=>{
        delete state.envUrlRevealed[id];
        renderEnvTableSection();
      });
    });
  });

  container.querySelectorAll('[data-row-dd-btn]').forEach(btn=>{
    btn.addEventListener('click', (ev)=>{
      ev.stopPropagation();
      const id = btn.getAttribute('data-row-dd-btn');
      envRowMenu = (envRowMenu.id === id) ? { id:null, mode:'menu' } : { id, mode:'menu' };
      renderEnvTableSection();
    });
  });

  container.querySelectorAll('[data-act]').forEach(el=>{
    el.addEventListener('click', (ev)=>{
      ev.stopPropagation();
      handleEnvRowAction(el.getAttribute('data-act'), el.getAttribute('data-id'), el);
    });
  });

  let draggedId = null;
  container.querySelectorAll('.env-row[draggable="true"]').forEach(row=>{
    row.addEventListener('dragstart', ()=>{
      draggedId = row.getAttribute('data-env-row');
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', ()=>{
      row.classList.remove('dragging');
      container.querySelectorAll('.env-row').forEach(r=>r.classList.remove('drag-over-top','drag-over-bottom'));
      draggedId = null;
    });
    row.addEventListener('dragover', (ev)=>{
      if(!draggedId) return;
      ev.preventDefault();
      const targetId = row.getAttribute('data-env-row');
      if(targetId === draggedId) return;
      const rect = row.getBoundingClientRect();
      const before = (ev.clientY - rect.top) < rect.height/2;
      row.classList.toggle('drag-over-top', before);
      row.classList.toggle('drag-over-bottom', !before);
    });
    row.addEventListener('dragleave', ()=> row.classList.remove('drag-over-top','drag-over-bottom'));
    row.addEventListener('drop', (ev)=>{
      ev.preventDefault();
      const targetId = row.getAttribute('data-env-row');
      const placeAfter = row.classList.contains('drag-over-bottom');
      row.classList.remove('drag-over-top','drag-over-bottom');
      if(!draggedId || draggedId===targetId){ draggedId = null; return; }
      reorderEnvironments(draggedId, targetId, placeAfter);
      draggedId = null;
      toast('Environment order updated');
      renderEnvSwitcher();
      renderEnvTableSection();
    });
  });
}

async function handleEnvRowAction(act, id, el){
  const env = environments().find(e=>e.id===id);
  if(act==='edit' || act==='color' || act==='access'){ envRowMenu = { id, mode:act }; renderEnvTableSection(); return; }
  if(act==='cancel'){ envRowMenu = { id, mode:'menu' }; renderEnvTableSection(); return; }
  if(act==='save-edit'){
    const label = document.getElementById('rafLabel').value.trim();
    const url = document.getElementById('rafUrl').value.trim();
    if(!label){ toast('Environment name is required'); return; }
    if(url){ try{ new URL(url); }catch(e){ toast('Enter a valid URL, e.g. https://api.example.com'); return; } }
    const result = updateEnvironment(id, { label, url });
    if(!result.ok){ toast(result.error); return; }
    envRowMenu = { id:null, mode:'menu' };
    toast('Environment updated');
    renderEnvSwitcher();
    renderEnvTableSection();
    return;
  }
  if(act==='pick-color'){
    updateEnvironment(id, { color: el.getAttribute('data-color') });
    envRowMenu = { id:null, mode:'menu' };
    applyEnvAccent();
    renderEnvSwitcher();
    renderEnvTableSection();
    toast('Color updated');
    return;
  }
  if(act==='pick-access'){
    const access = el.getAttribute('data-access');
    updateEnvironment(id, { access });
    envRowMenu = { id:null, mode:'menu' };
    renderEnvSwitcher();
    renderEnvTableSection();
    toast(`Access set to ${accessMeta(access).label}`);
    return;
  }
  if(act==='toggle-approval'){
    if(!env) return;
    const next = !env.requiresApproval;
    updateEnvironment(id, { requiresApproval: next });
    envRowMenu = { id:null, mode:'menu' };
    renderEnvTableSection();
    toast(next ? `Promoting into "${env.label}" now needs a second Admin's approval` : `Removed the approval requirement for "${env.label}"`);
    return;
  }
  if(act==='top' || act==='bottom'){
    moveEnvironment(id, act);
    envRowMenu = { id:null, mode:'menu' };
    renderEnvSwitcher();
    renderEnvTableSection();
    toast(`Moved "${env ? env.label : ''}" to the ${act}`);
    return;
  }
  if(act==='delete'){
    if(!env) return;
    if(environments().length <= 1){ toast("Can't delete the last remaining environment."); return; }
    const ok = await openConfirmModal({
      title: `Delete "${env.label}" environment?`,
      message: 'Any base URLs configured for it across projects will no longer be shown.',
      confirmLabel: 'Delete environment',
    });
    if(!ok) return;
    const result = deleteEnvironmentById(id);
    if(!result.ok){ toast(result.error); return; }
    envRowMenu = { id:null, mode:'menu' };
    toast(`Deleted "${env.label}" environment`);
    applyEnvAccent();
    renderEnvSwitcher();
    renderEnvTableSection();
    return;
  }
}
