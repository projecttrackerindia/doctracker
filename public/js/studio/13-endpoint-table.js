/* ==================== SECTION:ENDPOINT TABLE ==================== */
// Single-environment settings panel — lives on the Profile page. Used to be
// a full CRUD table over a user-configurable LIST of environments (search/
// filter/sort columns, add/delete, drag-to-reorder, a per-stage "2nd
// approval" flag for the now-removed Release Pipeline). Collapsed down to
// editing the one implicit environment's own settings (environment collapse
// cluster) rather than deleted outright — "base URL / access level / color
// for the one environment" is still a real, useful settings surface, it
// just isn't a list any more.
let envRowMenu = { id:null, mode:'menu' };   // which row's ⋮ menu is open, and its sub-view ('menu'|'edit'|'color'|'access')

function renderEnvTableSection(){
  const container = document.getElementById('envTableSection');
  if(!container) return;
  if(state.envTableStatus === 'error'){
    container.innerHTML = `
      <div class="env-table-error">
        Couldn't load your saved environment settings — the stored data looks corrupted.
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
  const e = environments()[0] || DEFAULT_ENVIRONMENTS[0];
  const canReveal = canRevealSensitive();
  return `
    <div class="table-scroll">
    <table class="data-table env-data-table">
      <thead><tr>
        <th>Environment</th>
        <th>Endpoint</th>
        <th title="${escapeHtml(ENV_HOST_IPS_NOTE)}">Host IPs</th>
        <th>Access</th>
        <th>Color</th>
        <th style="width:40px;">Actions</th>
      </tr></thead>
      <tbody id="envTableBody">${envRowHtml(e, canReveal)}</tbody>
    </table>
    </div>
  `;
}

// Which server(s) an admin has told DocTracker belong to this environment.
// Purely a lookup aid - see ENV_HOST_IPS_NOTE (03-notifications.js) for why
// this never drives which environment a push of live data is filed under.
function envHostIpsCellHtml(e){
  const ips = e.hostIps || [];
  if(!ips.length) return `<span class="empty-field" style="font-size:11px;">—</span>`;
  const shown = ips.slice(0, 2);
  const rest = ips.length - shown.length;
  return `<span class="env-ip-list" title="${escapeHtml(ips.join(', '))}">
    ${shown.map(ip=>`<code class="env-ip-chip">${escapeHtml(ip)}</code>`).join('')}
    ${rest > 0 ? `<span class="env-ip-more">+${rest} more</span>` : ''}
  </span>`;
}

function envRowHtml(e, canReveal){
  const revealed = !!state.envUrlRevealed[e.id];
  const hasUrl = !!e.url;
  const displayUrl = hasUrl ? (revealed ? e.url : maskEndpointUrl(e.url)) : 'Not set';
  const menuOpen = envRowMenu.id === e.id;
  return `
  <tr class="env-row" data-env-row="${e.id}">
    <td><span class="env-pill" style="--pill-c:${e.color};"><span class="env-pill-dot"></span>${escapeHtml(e.label)}</span></td>
    <td>
      <div class="env-url-cell">
        <span class="env-url-value${hasUrl?(revealed?'':' masked'):' empty'}">${escapeHtml(displayUrl)}</span>
        ${hasUrl ? `<button type="button" class="icon-btn env-reveal-btn${canReveal?'':' locked'}" data-env-reveal="${e.id}" title="${canReveal ? (revealed?'Hide value':'Reveal value') : 'Only the Admin role can reveal this value'}">${canReveal ? (revealed?ICON_EYE_OFF:ICON_EYE) : ICON_LOCK}</button>` : ''}
      </div>
    </td>
    <td>${envHostIpsCellHtml(e)}</td>
    <td><span class="access-badge access-${e.access}">${accessMeta(e.access).label}</span></td>
    <td><span class="env-color-dot" style="background:${e.color};" title="${colorName(e.color)}"></span></td>
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
      <div><label>Host IPs <span style="text-transform:none;font-weight:500;">— optional, comma-separated</span></label>
        <input type="text" id="rafHostIps" value="${escapeHtml((e.hostIps||[]).join(', '))}" placeholder="10.2.7.209, 10.2.7.211">
        <div class="raf-hint">${escapeHtml(ENV_HOST_IPS_NOTE)}</div>
      </div>
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
  return `
    <button type="button" class="row-actions-item" data-act="edit" data-id="${e.id}">Edit</button>
    <button type="button" class="row-actions-item" data-act="color" data-id="${e.id}">Change Color</button>
    <button type="button" class="row-actions-item" data-act="access" data-id="${e.id}">Change Access</button>
  `;
}

function bindEnvTableEvents(container){
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
}

function handleEnvRowAction(act, id, el){
  if(act==='edit' || act==='color' || act==='access'){ envRowMenu = { id, mode:act }; renderEnvTableSection(); return; }
  if(act==='cancel'){ envRowMenu = { id, mode:'menu' }; renderEnvTableSection(); return; }
  if(act==='save-edit'){
    const label = document.getElementById('rafLabel').value.trim();
    const url = document.getElementById('rafUrl').value.trim();
    if(!label){ toast('Environment name is required'); return; }
    if(url){ try{ new URL(url); }catch(e){ toast('Enter a valid URL, e.g. https://api.example.com'); return; } }
    const ipCheck = sanitizeHostIpsInput(document.getElementById('rafHostIps').value);
    if(!ipCheck.ok){ toast(ipCheck.error); return; }
    updateDefaultEnvironment({ label, url, hostIps: ipCheck.ips });
    envRowMenu = { id:null, mode:'menu' };
    toast('Environment updated');
    renderEnvTableSection();
    return;
  }
  if(act==='pick-color'){
    updateDefaultEnvironment({ color: el.getAttribute('data-color') });
    envRowMenu = { id:null, mode:'menu' };
    applyEnvAccent();
    renderEnvTableSection();
    toast('Color updated');
    return;
  }
  if(act==='pick-access'){
    const access = el.getAttribute('data-access');
    updateDefaultEnvironment({ access });
    envRowMenu = { id:null, mode:'menu' };
    renderEnvTableSection();
    toast(`Access set to ${accessMeta(access).label}`);
    return;
  }
}
