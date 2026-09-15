/* ==================== SECTION:PALETTE ==================== */
let paletteSelIndex = 0;
let paletteItems = [];

function buildPaletteIndex(){
  const items = [
    { kind:'home', label:'API Control Center', sub:'Workspace health & rollup' },
  ];
  allProjects().forEach(proj=>{
    items.push({ kind:'overview', projectId: proj.id, label: proj.name, sub: 'Overview' });
    proj.endpoints.forEach(ep=>{
      items.push({ kind:'endpoint', id: ep.id, label: ep.path, method: ep.method, sub: `${proj.name} · ${ep.tag}${ep.summary ? ' · '+ep.summary : ''}` });
    });
  });
  return items;
}

// ---------- Generic styled confirmation modal (replaces native confirm() for destructive actions) ----------
let _confirmModalResolve = null;
function openConfirmModal({ title, message, confirmLabel }){
  return new Promise(resolve=>{
    _confirmModalResolve = resolve;
    document.getElementById('confirmModalTitle').textContent = title || 'Are you sure?';
    document.getElementById('confirmModalMsg').textContent = message || '';
    document.getElementById('confirmModalOk').textContent = confirmLabel || 'Delete';
    document.getElementById('confirmModal').classList.add('show');
  });
}
function closeConfirmModal(result){
  document.getElementById('confirmModal').classList.remove('show');
  if(_confirmModalResolve){ _confirmModalResolve(result); _confirmModalResolve = null; }
}
document.getElementById('confirmModalCancel').addEventListener('click', ()=> closeConfirmModal(false));
document.getElementById('confirmModalOk').addEventListener('click', ()=> closeConfirmModal(true));
document.getElementById('confirmModal').addEventListener('click', (e)=>{
  if(e.target.id === 'confirmModal') closeConfirmModal(false);
});

// ---------- Authorized reveal: reason prompt + audit event + auto-remask ----------
// Every "eye" toggle in the app (env URLs, header secrets, code-sample rail)
// funnels through this so revealing is never a silent client-side flip: it's
// gated on the Admin role (canRevealSensitive), requires a reason, is written
// to the server-authoritative audit log, and auto-remasks after the org's
// configured timeout rather than staying revealed indefinitely.
let _piiRevealResolve = null;
function openPiiRevealModal(){
  const secs = (PII_CONFIG.settings && PII_CONFIG.settings.revealTimeoutSeconds) || 60;
  document.getElementById('piiRevealReason').value = '';
  document.getElementById('piiRevealTimeoutNote').textContent = `Value will automatically re-mask after ${secs} seconds.`;
  document.getElementById('piiRevealModal').classList.add('show');
  setTimeout(()=> document.getElementById('piiRevealReason').focus(), 30);
  return new Promise(resolve=>{ _piiRevealResolve = resolve; });
}
function closePiiRevealModal(reason){
  document.getElementById('piiRevealModal').classList.remove('show');
  if(_piiRevealResolve){ _piiRevealResolve(reason); _piiRevealResolve = null; }
}
document.getElementById('piiRevealCancel').addEventListener('click', ()=> closePiiRevealModal(null));
document.getElementById('piiRevealOk').addEventListener('click', ()=>{
  closePiiRevealModal(document.getElementById('piiRevealReason').value.trim() || '(no reason given)');
});
document.getElementById('piiRevealModal').addEventListener('click', (e)=>{
  if(e.target.id === 'piiRevealModal') closePiiRevealModal(null);
});
let _piiRemaskTimer = null;
// context: short human label of what's being revealed, e.g. "CLIENT-SECRET header"
// onGranted(reason) / onAutoRemask() — onGranted receives the typed reason so
// the caller can pass it through to the server-side reveal call (see
// toggleSensitiveRevealed in 03-notifications.js), which is now the only
// place PII_REVEAL is actually recorded — see server/routes/pii.js.
async function requestSensitiveReveal(context, onGranted, onAutoRemask){
  if(!canRevealSensitive()){ toast('Only the Admin role can reveal sensitive values'); return; }
  const reason = await openPiiRevealModal();
  if(reason === null) return; // cancelled
  await onGranted(reason);
  if(_piiRemaskTimer) clearTimeout(_piiRemaskTimer);
  const secs = (PII_CONFIG.settings && PII_CONFIG.settings.revealTimeoutSeconds) || 60;
  _piiRemaskTimer = setTimeout(()=>{ if(onAutoRemask) onAutoRemask(); }, secs*1000);
}

document.getElementById('credentialModalDone').addEventListener('click', closeCredentialModal);
document.getElementById('credentialModalCopy').addEventListener('click', (e)=>{
  copyToClipboard(document.getElementById('credentialModalPassword').textContent, e.currentTarget);
});
document.getElementById('credentialModal').addEventListener('click', (e)=>{
  if(e.target.id === 'credentialModal') closeCredentialModal();
});

document.getElementById('userModalCancel').addEventListener('click', closeUserModal);
document.getElementById('userModalSave').addEventListener('click', saveUserModal);
document.getElementById('userModal').addEventListener('click', (e)=>{
  if(e.target.id === 'userModal') closeUserModal();
});

function openPalette(){
  const overlay = document.getElementById('paletteOverlay');
  overlay.classList.add('show');
  const input = document.getElementById('paletteInput');
  input.value = '';
  paletteSelIndex = 0;
  renderPaletteResults('');
  setTimeout(()=>input.focus(), 30);
}
function closePalette(){
  document.getElementById('paletteOverlay').classList.remove('show');
}

function renderPaletteResults(query){
  const all = buildPaletteIndex();
  const q = query.trim().toLowerCase();
  paletteItems = !q ? all.slice(0, 40) : all.filter(it=>
    it.label.toLowerCase().includes(q) || (it.sub||'').toLowerCase().includes(q)
  ).slice(0, 40);
  paletteSelIndex = 0;

  const el = document.getElementById('paletteResults');
  if(!paletteItems.length){
    el.innerHTML = `<div class="palette-empty">No matching endpoints.</div>`;
    return;
  }
  el.innerHTML = paletteItems.map((it,i)=>`
    <div class="palette-item ${i===0?'sel':''}" data-idx="${i}">
      ${it.kind==='endpoint' ? `<span class="badge ${methodClass(it.method)}">${it.method}</span>` : `<span class="badge" style="background:var(--accent-soft);color:var(--accent);">${it.kind==='home'?'◈':it.kind==='errors'?'⚠':'API'}</span>`}
      <div class="pi-meta">
        <div class="pi-path">${escapeHtml(it.label)}</div>
        <div class="pi-proj">${escapeHtml(it.sub)}</div>
      </div>
    </div>`).join('');

  el.querySelectorAll('[data-idx]').forEach(row=>{
    row.addEventListener('click', ()=> selectPaletteItem(parseInt(row.getAttribute('data-idx'),10)));
    row.addEventListener('mouseenter', ()=>{
      paletteSelIndex = parseInt(row.getAttribute('data-idx'),10);
      updatePaletteSelection();
    });
  });
}

function updatePaletteSelection(){
  document.querySelectorAll('.palette-item').forEach((row,i)=>{
    row.classList.toggle('sel', i===paletteSelIndex);
  });
  const selEl = document.querySelector('.palette-item.sel');
  if(selEl) selEl.scrollIntoView({block:'nearest'});
}

function selectPaletteItem(i){
  const it = paletteItems[i];
  if(!it) return;
  state.selected = it.kind==='endpoint' ? { type:'endpoint', id: it.id }
    : it.kind==='overview' ? { type:'overview', projectId: it.projectId }
    : { type: it.kind };
  closePalette();
  renderEnvSwitcher(); renderSidebar(); renderMain(); renderRail();
}
