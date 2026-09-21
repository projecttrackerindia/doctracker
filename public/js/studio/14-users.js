/* ==================== SECTION:USERS (Admin-only team management) ==================== */
let usersState = { status:'idle', list:[], search:'', rowMenu:{ id:null }, error:'' };

async function ensureUsersLoaded(force){
  if(!AUTH_USER || AUTH_USER.role !== 'admin') return;
  if(!force && (usersState.status === 'ready' || usersState.status === 'loading')) return;
  usersState.status = 'loading';
  renderUsersTableSection();
  try{
    const res = await fetch('/api/users', { credentials:'include' });
    const data = await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(data.error || 'Could not load team members.');
    usersState.list = data.users || [];
    usersState.status = 'ready';
  }catch(e){
    usersState.status = 'error';
    usersState.error = e.message || 'Could not load team members.';
  }
  renderUsersTableSection();
}

function renderUsersTableSection(){
  const container = document.getElementById('usersTableSection');
  if(!container) return;
  container.innerHTML = usersTableHtml();
  bindUsersTableEvents(container);
  positionOpenUserRowPanel();
}

function positionOpenUserRowPanel(){
  if(!usersState.rowMenu.id) return;
  const btn = document.querySelector(`[data-urow-dd-btn="${usersState.rowMenu.id}"]`);
  const panel = document.querySelector(`[data-urow-panel="${usersState.rowMenu.id}"]`);
  if(!btn || !panel || !panel.firstElementChild) return;
  const rect = btn.getBoundingClientRect();
  const pw = panel.offsetWidth || 200;
  const ph = panel.offsetHeight || 140;
  let left = rect.right - pw;
  if(left < 8) left = 8;
  if(left + pw > window.innerWidth - 8) left = window.innerWidth - 8 - pw;
  let top = rect.bottom + 4;
  if(top + ph > window.innerHeight - 8) top = rect.top - ph - 4;
  if(top < 8) top = 8;
  panel.style.left = left + 'px';
  panel.style.top = top + 'px';
}

function usersTableHtml(){
  if(usersState.status === 'error'){
    return `<div class="env-table-error">
      ${escapeHtml(usersState.error || 'Could not load team members.')}
      <br><button type="button" class="primary" id="usersRetry" style="margin-top:8px;">Retry</button>
    </div>`;
  }

  const q = usersState.search.trim().toLowerCase();
  let list = usersState.list.slice();
  if(q) list = list.filter(u => u.username.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));

  const bodyHtml = (usersState.status === 'loading' && !usersState.list.length)
    ? `<tr><td colspan="5" style="padding:24px;text-align:center;color:var(--text-faint);">Loading team members…</td></tr>`
    : (list.length
        ? list.map(u=>userRowHtml(u)).join('')
        : `<tr><td colspan="5" style="padding:0;border-bottom:none;">
            <div class="env-table-empty">${q ? 'No members match your search.' : 'No one invited yet — invite your first teammate.'}</div>
          </td></tr>`);

  return `
    <div class="env-table-toolbar">
      <div class="env-table-search">
        <span class="env-table-search-ic"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.2" y2="16.2"></line></svg></span>
        <input type="text" id="usersSearchInput" placeholder="Search by username or email…" value="${escapeHtml(usersState.search)}">
      </div>
      <span class="spacer"></span>
      <button type="button" id="usersRefreshBtn" title="Refresh list">⟲ Refresh</button>
      <button type="button" class="primary" id="usersAddBtn">+ Invite user</button>
    </div>
    <div class="table-scroll">
    <table class="data-table">
      <thead><tr>
        <th>User</th>
        <th>Role</th>
        <th>Status</th>
        <th>Last login</th>
        <th style="width:40px;"></th>
      </tr></thead>
      <tbody id="usersTableBody">${bodyHtml}</tbody>
    </table>
    </div>
  `;
}

function avatarColorFor(name){
  return PROFILE_COLORS[hashStr(name||'') % PROFILE_COLORS.length];
}

function userRowHtml(u){
  const isSelf = !!(AUTH_USER && u.id === AUTH_USER.id);
  const localRoleId = dbRoleToLocalId(u.role);
  const rMeta = roleMeta(localRoleId);
  const menuOpen = usersState.rowMenu.id === u.id;
  const initials = profileInitials(u.username);
  const customTitle = (rMeta.id === 'custom' && u.custom_permissions)
    ? ` title="${escapeHtml((u.custom_permissions.envs||[]).join(', '))} · ${u.custom_permissions.canEdit ? 'can edit' : 'read-only'}"`
    : '';
  return `
  <tr class="env-row">
    <td>
      <div style="display:flex;align-items:center;gap:8px;">
        <span class="avatar-circle" style="background:${avatarColorFor(u.username)};">${initials}</span>
        <div style="min-width:0;">
          <div style="font-weight:600;font-size:12.5px;white-space:nowrap;">${escapeHtml(u.username)}${isSelf ? ' <span style="color:var(--text-faint);font-weight:500;">(you)</span>' : ''}</div>
          <div class="mono" style="font-size:11px;color:var(--text-faint);">${escapeHtml(u.email)}</div>
        </div>
      </div>
    </td>
    <td>
      <span class="role-pill role-${rMeta.id}"${customTitle}>${rMeta.label}</span>
      ${u.access_schedule && u.access_schedule.enabled ? `<span class="mono" style="display:block;margin-top:4px;font-size:10.5px;color:var(--text-faint);" title="Access restricted to this window">🕒 ${escapeHtml(describeAccessScheduleClient(u.access_schedule))}</span>` : ''}
    </td>
    <td><span class="access-badge access-user">Active</span></td>
    <td class="mono" style="font-size:11px;color:var(--text-faint);">${u.last_login_at ? formatDateTime(u.last_login_at) : 'Never signed in'}</td>
    <td>
      <div class="row-actions-dd${menuOpen?' open':''}" data-urow-dd="${u.id}">
        <button type="button" class="icon-btn row-actions-btn" data-urow-dd-btn="${u.id}" title="More actions">⋮</button>
        <div class="row-actions-panel" data-urow-panel="${u.id}">${menuOpen ? userRowActionsPanelHtml(u, isSelf) : ''}</div>
      </div>
    </td>
  </tr>`;
}

function userRowActionsPanelHtml(u, isSelf){
  return `
    <button type="button" class="row-actions-item" data-uact="role" data-id="${u.id}"${isSelf?' disabled title="Ask another Admin to change your own role"':''}>Change role</button>
    <button type="button" class="row-actions-item" data-uact="reset-password" data-id="${u.id}">Reset password</button>
    <div class="row-actions-divider"></div>
    <button type="button" class="row-actions-item danger" data-uact="delete" data-id="${u.id}"${isSelf?' disabled title="You can’t delete your own account"':''}>Delete user</button>
  `;
}

function bindUsersTableEvents(container){
  const searchInput = document.getElementById('usersSearchInput');
  if(searchInput){
    searchInput.addEventListener('input', ()=>{
      usersState.search = searchInput.value;
      renderUsersTableSection();
      const el = document.getElementById('usersSearchInput');
      if(el){ el.focus(); const v = el.value; el.setSelectionRange(v.length, v.length); }
    });
  }

  const refreshBtn = document.getElementById('usersRefreshBtn');
  if(refreshBtn) refreshBtn.addEventListener('click', ()=>{ ensureUsersLoaded(true); });

  const retryBtn = document.getElementById('usersRetry');
  if(retryBtn) retryBtn.addEventListener('click', ()=>{ ensureUsersLoaded(true); });

  const addBtn = document.getElementById('usersAddBtn');
  if(addBtn) addBtn.addEventListener('click', ()=>{ openUserModal({ mode:'invite' }); });

  container.querySelectorAll('[data-urow-dd-btn]').forEach(btn=>{
    btn.addEventListener('click', (ev)=>{
      ev.stopPropagation();
      const id = parseInt(btn.getAttribute('data-urow-dd-btn'), 10);
      usersState.rowMenu = (usersState.rowMenu.id === id) ? { id:null } : { id };
      renderUsersTableSection();
    });
  });

  container.querySelectorAll('[data-uact]').forEach(el=>{
    el.addEventListener('click', (ev)=>{
      ev.stopPropagation();
      const act = el.getAttribute('data-uact');
      const id = parseInt(el.getAttribute('data-id'), 10);
      handleUserRowAction(act, id, el);
    });
  });
}

async function handleUserRowAction(act, id, el){
  const user = usersState.list.find(u=>u.id===id);

  if(act === 'role'){
    if(!user) return;
    usersState.rowMenu = { id:null };
    renderUsersTableSection();
    openUserModal({ mode:'edit-role', user });
    return;
  }

  if(act === 'reset-password'){
    if(!user) return;
    const ok = await openConfirmModal({
      title: `Reset ${user.username}'s password?`,
      message: "Their current password stops working immediately, and a new temporary one is generated for you to share with them.",
      confirmLabel: 'Reset password',
    });
    if(!ok) return;
    try{
      const res = await fetch(`/api/users/${id}/reset-password`, { method:'POST', credentials:'include' });
      const data = await res.json().catch(()=>({}));
      if(!res.ok){ toast(data.error || 'Could not reset that password.'); return; }
      usersState.rowMenu = { id:null };
      logAudit('updated', 'user', user.username, 'Reset password');
      renderUsersTableSection();
      openCredentialModal({
        title: 'Password reset',
        subtitle: `Share this new password with ${user.username} — it won't be shown again.`,
        username: user.username, password: data.temporaryPassword,
      });
    }catch(e){ toast('Could not reach the server. Check your connection and try again.'); }
    return;
  }

  if(act === 'delete'){
    if(!user) return;
    const ok = await openConfirmModal({
      title: `Delete ${user.username}'s account?`,
      message: `They'll immediately lose access to ${AUTH_USER.organisation}'s workspace. This can't be undone.`,
      confirmLabel: 'Delete user',
    });
    if(!ok) return;
    try{
      const res = await fetch(`/api/users/${id}`, { method:'DELETE', credentials:'include' });
      const data = await res.json().catch(()=>({}));
      if(!res.ok){ toast(data.error || 'Could not delete that user.'); return; }
      usersState.list = usersState.list.filter(u=>u.id!==id);
      usersState.rowMenu = { id:null };
      logAudit('deleted', 'user', user.username, 'Removed from the organisation');
      toast(`Deleted ${user.username}`);
      renderUsersTableSection();
    }catch(e){ toast('Could not reach the server. Check your connection and try again.'); }
    return;
  }
}

/* ---- Shared invite / change-role modal ---- */
let userModalState = { mode:'invite', user:null, role:'viewer', envs:[], canEditFlag:false, scheduleEnabled:false, scheduleDays:[], scheduleStart:'09:00', scheduleEnd:'18:00' };

// Mirrors server/accessSchedule.js's describeAccessSchedule() — see the note
// there about why this logic is duplicated instead of shared: this app ships
// plain <script> tags with no bundler, so the browser gets its own small copy.
const SCHEDULE_DAY_LABELS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
function formatHHMMClient(hhmm){
  const [h,m] = String(hhmm||'00:00').split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2,'0')} ${period}`;
}
function describeAccessScheduleClient(schedule){
  if(!schedule || !schedule.enabled) return null;
  const days = (schedule.days||[]).slice().sort();
  const dayLabel = days.length === 7 ? 'Every day' : days.map(d=>SCHEDULE_DAY_LABELS[d]).join(', ');
  return `${dayLabel} \u00b7 ${formatHHMMClient(schedule.startTime)}\u2013${formatHHMMClient(schedule.endTime)}`;
}
// Same same-day-window logic as evaluateAccessSchedule() on the server —
// used only to drive the live banner/countdown; the server is still what
// actually enforces the lock (every workspace API call re-checks it fresh,
// see blockIfScheduleLocked). If this drifts out of sync with the server by
// a few seconds, the worst case is the banner briefly disagrees with an API
// response, which self-corrects on the next 423.
function evaluateAccessScheduleClient(schedule, now){
  now = now || new Date();
  if(!schedule || !schedule.enabled) return { locked:false, nextChangeAt:null };
  const toMins = (hhmm)=>{ const [h,m] = String(hhmm||'00:00').split(':').map(Number); return h*60+m; };
  const day = now.getDay();
  const mins = now.getHours()*60 + now.getMinutes();
  const start = toMins(schedule.startTime), end = toMins(schedule.endTime);
  const days = schedule.days || [];
  const withinTimeOfDay = start < end ? (mins >= start && mins < end) : false;
  if(days.includes(day) && withinTimeOfDay){
    const nextChangeAt = new Date(now); nextChangeAt.setHours(0,0,0,0); nextChangeAt.setMinutes(end);
    return { locked:false, nextChangeAt };
  }
  for(let offset=0; offset<=7; offset++){
    const d = new Date(now); d.setDate(d.getDate()+offset);
    if(!days.includes(d.getDay())) continue;
    const candidateStart = new Date(d); candidateStart.setHours(0,0,0,0); candidateStart.setMinutes(start);
    if(candidateStart > now) return { locked:true, nextChangeAt: candidateStart };
  }
  return { locked:true, nextChangeAt:null };
}

function openUserModal({ mode, user }){
  const existingPerms = (user && user.custom_permissions) || null;
  const existingSchedule = (user && user.access_schedule) || null;
  userModalState = {
    mode,
    user: user || null,
    role: user ? user.role : 'viewer',
    envs: existingPerms ? (existingPerms.envs || []).slice() : [],
    canEditFlag: existingPerms ? !!existingPerms.canEdit : false,
    scheduleEnabled: existingSchedule ? !!existingSchedule.enabled : false,
    scheduleDays: existingSchedule ? (existingSchedule.days || []).slice() : [1,2,3,4,5],
    scheduleStart: (existingSchedule && existingSchedule.startTime) || '09:00',
    scheduleEnd: (existingSchedule && existingSchedule.endTime) || '18:00',
  };
  document.getElementById('userModalTitle').textContent = mode === 'invite' ? 'Invite user' : `Change ${user.username}'s role`;
  document.getElementById('userModalSubtitle').textContent = mode === 'invite'
    ? "There's no email service hooked up, so this creates the account directly and gives you a one-time temporary password to share with them yourself."
    : "Takes effect the next time they load the app.";
  document.getElementById('userModalUsernameField').style.display = mode === 'invite' ? '' : 'none';
  document.getElementById('userModalEmailField').style.display = mode === 'invite' ? '' : 'none';
  if(mode === 'invite'){
    document.getElementById('userModalUsername').value = '';
    document.getElementById('userModalEmail').value = '';
  }
  document.getElementById('userModalSave').textContent = mode === 'invite' ? 'Send invite' : 'Save role';
  renderUserModalBody();
  document.getElementById('userModal').classList.add('show');
  if(mode === 'invite') setTimeout(()=>{ const el = document.getElementById('userModalUsername'); if(el) el.focus(); }, 0);
}

function closeUserModal(){
  document.getElementById('userModal').classList.remove('show');
}

function renderUserModalBody(){
  const grid = document.getElementById('userModalRoleGrid');
  grid.innerHTML = ROLES.map(r=>{
    const dbRole = localIdToDbRole(r.id);
    const sel = dbRole === userModalState.role;
    return `<div class="role-card${sel?' sel':''}" data-role-card="${dbRole}">
      <div class="rc-title">${r.label}</div>
      <div class="rc-desc">${r.desc}</div>
    </div>`;
  }).join('');
  grid.querySelectorAll('[data-role-card]').forEach(card=>{
    card.addEventListener('click', ()=>{
      userModalState.role = card.getAttribute('data-role-card');
      renderUserModalBody();
    });
  });

  const isCustom = userModalState.role === 'custom';
  document.getElementById('userModalCustomSection').style.display = isCustom ? '' : 'none';

  if(isCustom){
    const chipsWrap = document.getElementById('userModalEnvChips');
    chipsWrap.innerHTML = environments().map(e=>{
      const sel = userModalState.envs.includes(e.id);
      const style = sel ? ` style="--env-accent:${envAccentColor(e.id)};--env-accent-bg:${envBgColor(e.id)};"` : '';
      return `<span class="env-chip-opt${sel?' sel':''}" data-env-chip="${e.id}"${style}>${e.label}</span>`;
    }).join('');
    chipsWrap.querySelectorAll('[data-env-chip]').forEach(chip=>{
      chip.addEventListener('click', ()=>{
        const id = chip.getAttribute('data-env-chip');
        const idx = userModalState.envs.indexOf(id);
        if(idx === -1) userModalState.envs.push(id); else userModalState.envs.splice(idx,1);
        renderUserModalBody();
      });
    });
    const toggle = document.getElementById('userModalEditToggle');
    toggle.className = 'toggle-switch' + (userModalState.canEditFlag ? ' on' : '');
    toggle.setAttribute('aria-checked', String(userModalState.canEditFlag));
    toggle.onclick = ()=>{ userModalState.canEditFlag = !userModalState.canEditFlag; renderUserModalBody(); };
  }

  const hintEl = document.getElementById('userModalHint');
  if(isCustom){
    const envList = environments().filter(e=>userModalState.envs.includes(e.id)).map(e=>e.label).join(', ');
    hintEl.textContent = `Access to ${envList || 'no environments yet'} — ${userModalState.canEditFlag ? 'can create and edit endpoints.' : 'read-only.'}`;
  } else {
    hintEl.textContent = roleHintText(dbRoleToLocalId(userModalState.role));
  }

  // ---- Access schedule (any role — independent of the custom-role section above) ----
  const schedToggle = document.getElementById('userModalScheduleToggle');
  schedToggle.className = 'toggle-switch' + (userModalState.scheduleEnabled ? ' on' : '');
  schedToggle.setAttribute('aria-checked', String(userModalState.scheduleEnabled));
  schedToggle.onclick = ()=>{ userModalState.scheduleEnabled = !userModalState.scheduleEnabled; renderUserModalBody(); };

  const schedSection = document.getElementById('userModalScheduleSection');
  schedSection.style.display = userModalState.scheduleEnabled ? '' : 'none';

  if(userModalState.scheduleEnabled){
    const daysWrap = document.getElementById('userModalScheduleDays');
    daysWrap.innerHTML = SCHEDULE_DAY_LABELS.map((label, idx)=>{
      const sel = userModalState.scheduleDays.includes(idx);
      return `<span class="env-chip-opt${sel?' sel':''}" data-sched-day="${idx}">${label}</span>`;
    }).join('');
    daysWrap.querySelectorAll('[data-sched-day]').forEach(chip=>{
      chip.addEventListener('click', ()=>{
        const idx = parseInt(chip.getAttribute('data-sched-day'), 10);
        const at = userModalState.scheduleDays.indexOf(idx);
        if(at === -1) userModalState.scheduleDays.push(idx); else userModalState.scheduleDays.splice(at,1);
        renderUserModalBody();
      });
    });
    const startEl = document.getElementById('userModalScheduleStart');
    const endEl = document.getElementById('userModalScheduleEnd');
    startEl.value = userModalState.scheduleStart;
    endEl.value = userModalState.scheduleEnd;
    startEl.onchange = ()=>{ userModalState.scheduleStart = startEl.value; renderScheduleHint(); };
    endEl.onchange = ()=>{ userModalState.scheduleEnd = endEl.value; renderScheduleHint(); };
    renderScheduleHint();
  }
}

function renderScheduleHint(){
  const hintEl = document.getElementById('userModalScheduleHint');
  if(!hintEl) return;
  if(!userModalState.scheduleDays.length){
    hintEl.textContent = 'Pick at least one day.';
    return;
  }
  const preview = describeAccessScheduleClient({
    enabled: true, days: userModalState.scheduleDays, startTime: userModalState.scheduleStart, endTime: userModalState.scheduleEnd,
  });
  hintEl.textContent = `Outside ${preview}, this account is locked out until you widen or turn off this window.`;
}

async function saveUserModal(){
  const role = userModalState.role;
  let customPermissions;
  if(role === 'custom'){
    if(!userModalState.envs.length){ toast('Pick at least one environment for a custom role.'); return; }
    customPermissions = { envs: userModalState.envs.slice(), canEdit: userModalState.canEditFlag };
  }

  let accessSchedule = null;
  if(userModalState.scheduleEnabled){
    if(!userModalState.scheduleDays.length){ toast('Pick at least one day for the access window.'); return; }
    if(userModalState.scheduleStart === userModalState.scheduleEnd){ toast('Start and end time can\u2019t be the same.'); return; }
    accessSchedule = {
      enabled: true,
      days: userModalState.scheduleDays.slice(),
      startTime: userModalState.scheduleStart,
      endTime: userModalState.scheduleEnd,
    };
  }

  let url, method, body;
  if(userModalState.mode === 'invite'){
    const username = document.getElementById('userModalUsername').value.trim();
    const email = document.getElementById('userModalEmail').value.trim();
    body = { username, email, role, customPermissions, accessSchedule };
    url = '/api/users/invite'; method = 'POST';
  } else {
    body = { role, customPermissions };
    url = `/api/users/${userModalState.user.id}/role`; method = 'PATCH';
  }

  const saveBtn = document.getElementById('userModalSave');
  saveBtn.disabled = true;
  const origLabel = saveBtn.textContent;
  saveBtn.textContent = userModalState.mode === 'invite' ? 'Sending…' : 'Saving…';
  try{
    const res = await fetch(url, { method, headers:{'Content-Type':'application/json'}, credentials:'include', body: JSON.stringify(body) });
    const data = await res.json().catch(()=>({}));
    if(!res.ok){ toast(data.error || 'Could not save that.'); return; }

    // The access schedule is its own endpoint (see PATCH /api/users/:id/access-schedule)
    // so that changing just a role or invite doesn't silently touch someone's
    // window, and vice versa. For an invite it already went out on the same
    // request above (routes/users.js accepts it on POST /invite directly);
    // for edit-role it's a second call against the account that call just returned.
    let finalUser = data.user;
    if(userModalState.mode !== 'invite'){
      const schedRes = await fetch(`/api/users/${userModalState.user.id}/access-schedule`, {
        method:'PATCH', headers:{'Content-Type':'application/json'}, credentials:'include',
        body: JSON.stringify({ accessSchedule }),
      });
      const schedData = await schedRes.json().catch(()=>({}));
      if(!schedRes.ok){ toast(schedData.error || 'Role saved, but the access window could not be updated.'); }
      else finalUser = schedData.user;
    }

    if(userModalState.mode === 'invite'){
      usersState.list.push(finalUser);
      logAudit('created', 'user', body.username, `Invited ${body.username} (${body.email}) as ${roleMeta(dbRoleToLocalId(role)).label}`);
      closeUserModal();
      renderUsersTableSection();
      openCredentialModal({
        title: 'Account created',
        subtitle: `Share these sign-in details with ${body.username} — the password won't be shown again.`,
        username: body.username, password: data.temporaryPassword,
      });
    } else {
      const idx = usersState.list.findIndex(u=>u.id===userModalState.user.id);
      if(idx !== -1) usersState.list[idx] = finalUser;
      logAudit('updated', 'user', userModalState.user.username, `Changed role to ${roleMeta(dbRoleToLocalId(role)).label}`);
      toast(`Role updated to ${roleMeta(dbRoleToLocalId(role)).label}`);
      closeUserModal();
      renderUsersTableSection();
    }
  }catch(e){
    toast('Could not reach the server. Check your connection and try again.');
  }finally{
    saveBtn.disabled = false;
    saveBtn.textContent = origLabel;
  }
}

function openCredentialModal({ title, subtitle, username, password }){
  document.getElementById('credentialModalTitle').textContent = title || 'Credentials';
  document.getElementById('credentialModalSubtitle').textContent = subtitle || '';
  document.getElementById('credentialModalUsername').textContent = username || '';
  document.getElementById('credentialModalPassword').textContent = password || '';
  document.getElementById('credentialModal').classList.add('show');
}
function closeCredentialModal(){
  document.getElementById('credentialModal').classList.remove('show');
}

function roleHintText(roleId){
  const envList = roleAllowedEnvs(roleId).map(e=>e.label).join(', ');
  if(roleId==='admin')  return `Full access. Can reach every environment (${envList}) and create, edit, or delete endpoints.`;
  if(roleId==='Developer') return `Can create and edit endpoints, scoped to ${envList}. Prod and DR stay read-only from another role.`;
  if(roleId==='custom'){
    const editPart = canEdit() ? 'create, edit, or delete endpoints' : "browse and try endpoints, but can't create, edit, or delete anything";
    return `Custom access, set by an Admin. Can reach ${envList || 'no environments yet'} and ${editPart}.`;
  }
  return `Read-only. Can browse and try endpoints in ${envList}, but can't create, edit, or delete anything.`;
}

// Release health section — breaking-changes-per-release sparkline (see
// releaseHealthSparklineSvg in 10-metrics.js and releaseHealthEntry's fetch
// in 05-util.js). Renders nothing but a loading placeholder until the fetch
// resolves; renderAll() re-runs once it does.
function releaseHealthSectionHtml(projId){
  const entry = releaseHealthEntry(projId);
  let body;
  if(entry.status === 'loading'){
    body = `<div class="empty-field">Loading release history…</div>`;
  } else if(entry.status === 'error'){
    body = `<div class="empty-field">Could not load release health.</div>`;
  } else if(!entry.points || entry.points.length < 2){
    body = `<div class="empty-field">Not enough release history yet — this fills in once a few releases have reached ${escapeHtml(entry.lastStageLabel || 'the last stage')}.</div>`;
  } else {
    const totalBreaking = entry.points.reduce((sum,p)=>sum+p.breakingChangesCount, 0);
    body = `
      <div style="display:flex; align-items:flex-end; gap:16px; flex-wrap:wrap;">
        ${releaseHealthSparklineSvg(entry.points)}
        <div class="hint" style="margin:0;">${totalBreaking
          ? `${totalBreaking} breaking change${totalBreaking===1?'':'s'} across the last ${entry.points.length} releases into ${escapeHtml(entry.lastStageLabel)}.`
          : `No breaking changes across the last ${entry.points.length} releases into ${escapeHtml(entry.lastStageLabel)} — clean run.`}</div>
      </div>`;
  }
  return `
    <div class="section">
      <div class="section-title">Release health <span style="color:var(--text-faint); font-weight:500; text-transform:none;">— breaking changes per release into production</span></div>
      ${body}
    </div>`;
}

function renderProjectOverview(main, projectId){
  const proj = state.projects[projectId];
  if(!proj){ state.selected = null; renderMain(); return; }
  const env = envMeta(state.env);
  const baseUrl = proj.environments[state.env];
  const viewingDraft = isViewingDraftEnv();
  const epsForView = viewEndpoints(proj);
  const snap = viewingDraft ? null : snapshotEntry(proj.id);

  const totalEndpoints = epsForView.length;
  const envsConfigured = environments().filter(e=>proj.environments[e.id]).length;
  const tagCount = new Set(epsForView.map(e=>e.tag || 'General')).size;

  const docs = (proj.attachments || []).slice().sort((a,b)=> new Date(b.uploadedAt) - new Date(a.uploadedAt));
  const docsHtml = docs.length
    ? `<div class="doc-grid">${docs.map(d=>{
        const meta = docTypeMeta(d.name);
        // `d.dataUrl` only exists for an attachment that hasn't been
        // offloaded to object storage yet (see offloadAttachments() in
        // server/routes/workspace.js) — once storage is configured, every
        // attachment gets its inline dataUrl stripped on save and a
        // storageKey recorded instead, so linking straight to `d.dataUrl`
        // silently becomes `href="undefined"` for any attachment saved
        // after storage was turned on. The streaming route below handles
        // both cases (storageKey or a still-inline dataUrl) correctly.
        const href = d.dataUrl || `/api/workspace/projects/${encodeURIComponent(proj.id)}/attachments/${encodeURIComponent(d.id)}`;
        return `<a class="doc-card" style="--doc-accent:var(${meta.accent});--doc-accent-bg:var(${meta.bg});" href="${href}" download="${escapeHtml(d.name)}" title="Download ${escapeHtml(d.name)}">
          <div class="doc-card-ic">${meta.label}</div>
          <div class="doc-card-main">
            <div class="doc-card-name">${escapeHtml(d.name)}</div>
            <div class="doc-card-meta">${formatFileSize(d.size)} · ${formatDateTime(d.uploadedAt)}</div>
          </div>
          <div class="doc-card-dl">${ICON_DOWNLOAD}</div>
        </a>`;
      }).join('')}</div>`
    : `<div class="empty-field">No documents uploaded yet — add some from Manage documents above.</div>`;

  const archDiagram = proj.architectureDiagram;
  const hasArchDiagram = !!(archDiagram && Array.isArray(archDiagram.nodes) && archDiagram.nodes.length);
  const adHtml = hasArchDiagram
    ? `<div class="ad-preview-wrap">
        ${architectureDiagramPreviewSvg(archDiagram)}
        <div class="ad-preview-meta">
          <span>Published ${archDiagram.updatedBy ? `by <b>${escapeHtml(archDiagram.updatedBy)}</b> ` : ''}${archDiagram.updatedAt ? '· ' + escapeHtml(formatDateTime(archDiagram.updatedAt)) : ''}</span>
          <div class="spacer"></div>
          <button type="button" class="ghost" id="btnOpenArchStudio" style="text-transform:none; letter-spacing:0; font-weight:600; font-size:11px; padding:5px 10px;">Open Architecture Studio</button>
        </div>
      </div>`
    : `<div class="ad-empty">
        <div class="ic"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.4"></rect><rect x="14" y="3" width="7" height="7" rx="1.4"></rect><rect x="14" y="14" width="7" height="7" rx="1.4"></rect><rect x="3" y="14" width="7" height="7" rx="1.4"></rect><path d="M10 6.5h4M17.5 10v4M14 17.5h-4M6.5 14v-4"></path></svg></div>
        <div class="t">No architecture diagram yet</div>
        <div class="s">Design a drag-and-drop system diagram — AWS, Salesforce, MuleSoft flows and more — in Architecture Studio, then publish it here.</div>
        <button type="button" class="ghost" id="btnOpenArchStudio" style="text-transform:none; letter-spacing:0; font-weight:600; font-size:11.5px; padding:7px 14px; margin-top:2px;">Open Architecture Studio</button>
      </div>`;

  main.innerHTML = `
    <div class="crumb">${escapeHtml(proj.name)} <span class="sep">/</span> Overview</div>

    ${!viewingDraft ? `
    <div class="rp-envbanner">
      <span class="rp-envbanner-ic">👁</span>
      <span class="rp-envbanner-txt">
        ${snap && snap.status==='ready'
          ? `Viewing ${escapeHtml(env.label)} — read-only<span class="rp-envbanner-v">${escapeHtml(snap.versionLabel || 'nothing promoted yet')}</span>${snap.promotedBy ? ` · promoted by ${escapeHtml(snap.promotedBy)}` : ''}${snap.promotedAt ? ` · ${escapeHtml(new Date(snap.promotedAt).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}))}` : ''}`
          : (snap && snap.status==='error' ? `Could not load the ${escapeHtml(env.label)} snapshot.` : `Loading ${escapeHtml(env.label)} snapshot…`)}
      </span>
      <span class="rp-envbanner-hint">Switch to ${escapeHtml(envMeta(draftEnvId()).label)} to make changes</span>
    </div>` : ''}

    <div class="overview-hero">
      <div class="overview-hero-badge"><span class="dot"></span>DocTracker · ${escapeHtml(env.label)} environment${proj.version ? ` · v${escapeHtml(proj.version)}` : ''}</div>
      <h1>${escapeHtml(proj.name)}</h1>
      ${proj._readonly
        ? `<div class="empty-field" style="margin:8px 0 0;">Shared publicly by someone else in your organisation — view only.</div>`
        : `<span class="badge" style="margin-top:8px;">${proj.visibility==='public' ? '🌐 Public — visible to your organisation' : '🔒 Private — only visible to you'}</span>`}
      <div class="overview-hero-sub">${proj.description ? renderMarkdown(proj.description) : 'No description yet — add one in project settings.'}</div>
      <div class="overview-stats">
        <div class="overview-stat"><div class="n" style="color:var(--accent);">${totalEndpoints}</div><div class="l">Endpoints</div></div>
        <div class="overview-stat"><div class="n" style="color:var(--get);">${envsConfigured}/${environments().length}</div><div class="l">Environments</div></div>
        <div class="overview-stat"><div class="n" style="color:var(--patch);">${proj.auth && proj.auth.type ? escapeHtml(proj.auth.type) : 'None'}</div><div class="l">Auth</div></div>
        <div class="overview-stat"><div class="n" style="color:var(--put);">${tagCount}</div><div class="l">Tags</div></div>
        <div class="overview-stat" title="Goes up automatically each time anything in this project is saved from the editor"><div class="n" style="color:var(--accent);">${proj.version ? 'v' + escapeHtml(String(proj.version).replace(/^v/i, '')) : '—'}</div><div class="l">Version</div></div>
      </div>
    </div>

    <div class="doc-header">
      <div class="path-row">
        <span class="path" style="font-size:18px;">Project settings</span>
        <div class="path-actions">
          <div class="ep-actions-dd" id="projActionsDD">
            <button type="button" class="ep-actions-btn" id="projActionsBtn" aria-haspopup="true" aria-expanded="false" aria-controls="projActionsPanel" title="Project actions">
              Project actions <span class="dd-chev">▾</span>
            </button>
            <div class="ep-actions-panel proj-actions-panel" id="projActionsPanel" role="menu">
              <button type="button" class="ep-actions-item proj-actions-item${isAdmin() ? '' : ' locked'}" id="btnEditProject" role="menuitem" title="${isAdmin() ? '' : 'Only the Admin role can edit project settings'}">
                <span class="item-label">
                  <span class="item-ic">${isAdmin() ? '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"></path></svg>' : ICON_LOCK}</span>
                  <span>Edit project settings</span>
                </span>
                ${isAdmin() ? '' : '<span class="item-sub">Admin only</span>'}
              </button>
              ${proj._readonly ? '' : `
              <div class="ep-actions-divider"></div>
              <button type="button" class="ep-actions-item proj-actions-item" data-toggle-proj-visibility="${proj.id}" role="menuitem">
                <span class="item-label">
                  <span class="item-ic">${proj.visibility==='public'
                    ? '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 9.9-1"></path></svg>'
                    : '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>'}</span>
                  <span>${proj.visibility==='public' ? 'Make private' : 'Make public'}</span>
                </span>
                <span class="item-sub">${proj.visibility==='public' ? 'Only you' : 'Your organisation'}</span>
              </button>`}
              <div class="ep-actions-divider"></div>
              <button type="button" class="ep-actions-item proj-actions-item" id="btnOpenArchStudioMenu" role="menuitem">
                <span class="item-label">
                  <span class="item-ic"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.4"></rect><rect x="14" y="3" width="7" height="7" rx="1.4"></rect><rect x="14" y="14" width="7" height="7" rx="1.4"></rect><rect x="3" y="14" width="7" height="7" rx="1.4"></rect><path d="M10 6.5h4M17.5 10v4M14 17.5h-4M6.5 14v-4"></path></svg></span>
                  <span>Open Architecture Studio</span>
                </span>
              </button>
              <button type="button" class="ep-actions-item proj-actions-item" id="btnOpenReleasePipelineMenu" role="menuitem">
                <span class="item-label">
                  <span class="item-ic"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg></span>
                  <span>Open Release Pipeline</span>
                </span>
              </button>
              <div class="ep-actions-divider"></div>
              <button type="button" class="ep-actions-item proj-actions-item" id="btnExportPdf" role="menuitem">
                <span class="item-label">
                  <span class="item-ic"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><path d="M14 2v6h6"></path><path d="M9 15l3 3 3-3"></path><path d="M12 11v7"></path></svg></span>
                  <span>Export as PDF</span>
                </span>
              </button>
              ${proj._readonly ? '' : `
              <button type="button" class="ep-actions-item proj-actions-item" id="btnExportProjectJson" role="menuitem">
                <span class="item-label">
                  <span class="item-ic"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg></span>
                  <span>Export project (JSON)</span>
                </span>
                <span class="item-sub">Full backup — everything, unmasked</span>
              </button>`}
              <button type="button" class="ep-actions-item proj-actions-item" id="btnOpenSwaggerEditor" role="menuitem">
                <span class="item-label">
                  <span class="item-ic"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg></span>
                  <span>Open in Swagger Editor</span>
                </span>
                <span class="item-sub">10-min link, masked</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Lifecycle</div>
      <div class="lc-card">
        <div class="lc-card-top">
          <div class="lc-meta">
            <span class="lc-badge lc-${proj.lifecycle.toLowerCase().replace(/[^a-z]/g,'')}">${proj.lifecycle}</span>
            <span class="lc-meta-chip"><span class="k">Owner</span><span class="v">${proj.owner ? escapeHtml(proj.owner) : 'Not set'}</span></span>
            <span class="lc-meta-chip"><span class="k">Team</span><span class="v">${proj.team ? escapeHtml(proj.team) : 'Not set'}</span></span>
          </div>
        </div>
        ${lifecycleWheelSvg(proj.lifecycle)}
      </div>
    </div>

    ${releaseHealthSectionHtml(proj.id)}

    <div class="section">
      <div class="section-title">
        <span style="flex:1;">Architecture diagram <span style="color:var(--text-faint); font-weight:500; text-transform:none;">— drag-and-drop system diagram for ${escapeHtml(proj.name)}</span></span>
      </div>
      ${adHtml}
    </div>

    <div class="section">
      <div class="section-title">
        <span style="flex:1;">Documents <span style="color:var(--text-faint); font-weight:500; text-transform:none;">— shared files for ${escapeHtml(proj.name)}</span></span>
        <button type="button" class="ghost" id="btnManageDocs" ${isAdmin() ? '' : 'disabled title="Only the Admin role can manage documents"'} style="text-transform:none; letter-spacing:0; font-weight:600; font-size:11px; padding:5px 10px;${isAdmin() ? '' : ' opacity:.45; cursor:not-allowed;'}">Manage documents</button>
      </div>
      ${docsHtml}
    </div>

    <div class="section">
      <div class="section-title">Endpoints <span style="color:var(--text-faint); font-weight:500; text-transform:none;">— added &amp; last-modified history</span></div>
      ${epsForView.length ? `
      <div class="table-scroll">
      <table class="data-table">
        <thead><tr><th>Endpoint</th><th title="Goes up automatically each time this endpoint is saved">Version</th><th>Source → Target</th><th>Status</th><th>Added</th><th>Last modified</th><th title="Google SecOps review status">SecOps</th><th title="VAPT review status">VAPT</th><th title="Common Log Management review status">Log Mgmt</th></tr></thead>
        <tbody>
          ${epsForView.map(ep=>`
            <tr class="ep-history-row" data-open-ep="${ep.id}" style="cursor:pointer;">
              <td>
                <span class="badge ${methodClass(ep.method)}" style="margin-right:8px;">${escapeHtml(ep.method)}</span>
                <span class="mono" style="font-size:12px;">${escapeHtml(ep.path)}</span>
              </td>
              <td>${DocMeta.versionPillHtml(DocMeta.currentVersion(ep, proj))}</td>
              <td>${DocMeta.systemFlowHtml(ep) || '<span class="empty-field">—</span>'}</td>
              <td>${DocMeta.endpointStatusChipHtml(ep)}</td>
              <td>
                <div>${ep.createdAt ? escapeHtml(formatDateTime(ep.createdAt)) : '<span class="empty-field">Unknown</span>'}</div>
                <div style="color:var(--text-faint); font-size:11.5px;">${ep.createdBy ? 'by ' + escapeHtml(ep.createdBy) : 'by Unknown'}</div>
              </td>
              <td>
                <div>${ep.updatedAt ? escapeHtml(formatDateTime(ep.updatedAt)) : '<span class="empty-field">Unknown</span>'}</div>
                <div style="color:var(--text-faint); font-size:11.5px;">${ep.updatedBy ? 'by ' + escapeHtml(ep.updatedBy) : 'by Unknown'}</div>
              </td>
              <td>${DocMeta.reviewChipHtml(ep, 'secOps')}</td>
              <td>${DocMeta.reviewChipHtml(ep, 'vapt')}</td>
              <td>${DocMeta.reviewChipHtml(ep, 'logMgmt')}</td>
            </tr>`).join('')}
        </tbody>
      </table>
      </div>` : `<div class="empty-field">${viewingDraft ? 'No endpoints in this project yet.' : `Nothing promoted to ${escapeHtml(env.label)} yet.`}</div>`}
    </div>

    <div class="section">
      <div class="section-title">Integration notes</div>
      <div class="notes-box">
        <textarea id="projNotes" placeholder="Architecture notes, DataWeave gotchas, downstream contacts, known limitations…">${escapeHtml(proj.notes||'')}</textarea>
      </div>
    </div>
  `;

  document.getElementById('btnEditProject').addEventListener('click', ()=>{
    document.getElementById('projActionsDD').classList.remove('open');
    openProjectModal(proj.id);
  });
  document.getElementById('btnManageDocs').addEventListener('click', ()=>openProjectModal(proj.id, 'docs'));
  document.getElementById('projActionsBtn').addEventListener('click', (e)=>{
    e.stopPropagation();
    document.getElementById('projActionsDD').classList.toggle('open');
  });
  document.getElementById('btnExportPdf').addEventListener('click', ()=>{
    document.getElementById('projActionsDD').classList.remove('open');
    openExportPdfModal(proj.id);
  });
  const btnExportProjectJson = document.getElementById('btnExportProjectJson');
  if(btnExportProjectJson) btnExportProjectJson.addEventListener('click', ()=>{
    document.getElementById('projActionsDD').classList.remove('open');
    exportProjectAsJson(proj.id);
  });
  document.getElementById('btnOpenArchStudioMenu').addEventListener('click', ()=>{
    document.getElementById('projActionsDD').classList.remove('open');
    openArchitectureStudioTab(proj);
  });
  document.getElementById('btnOpenReleasePipelineMenu').addEventListener('click', ()=>{
    document.getElementById('projActionsDD').classList.remove('open');
    openReleasePipelineTab(proj);
  });
  document.getElementById('btnOpenSwaggerEditor').addEventListener('click', ()=>{
    document.getElementById('projActionsDD').classList.remove('open');
    openInSwaggerEditor(proj.id);
  });
  const btnOpenArchStudio = document.getElementById('btnOpenArchStudio');
  if(btnOpenArchStudio) btnOpenArchStudio.addEventListener('click', ()=>openArchitectureStudioTab(proj));
  main.querySelectorAll('[data-open-ep]').forEach(row=>{
    row.addEventListener('click', ()=>{
      state.selected = { type:'endpoint', id: row.getAttribute('data-open-ep') };
      renderAll();
    });
  });
  // Auth request/response parameter tables on this page go through the same
  // centralized PII engine as the endpoint doc page (paramSection() renders the
  // eye icon whenever a row is sensitive) — but this page never wired the click
  // through, so the button rendered but did nothing. Bind it the same way
  // renderEndpointDoc() does, so reveal + the 60s auto-remask timeout work here too.
  main.querySelectorAll('[data-header-reveal]').forEach(btn=>{
    btn.addEventListener('click', ()=> toggleSensitiveRevealed());
  });
  const notesArea = document.getElementById('projNotes');
  notesArea.addEventListener('blur', ()=>{
    proj.notes = notesArea.value;
    saveState();
  });
}

function paramSection(title, params, variant){
  // variant: 'header' -> blue tint for Header parameters; 'auth' -> purple tint for
  // Authentication's request/response parameter tables; 'request' -> green tint for
  // the Request accordion's path/query parameter tables; a status code (e.g. 200/404) ->
  // tints the table to match that response's status color; undefined/omitted -> plain gray.
  if(!params.length) return '';
  const boldNames = variant === 'header';
  let tintStyle = '';
  if(variant === 'header'){
    tintStyle = ` style="--pt-accent:var(--get); --pt-bg:var(--get-bg);"`;
  } else if(variant === 'auth'){
    tintStyle = ` style="--pt-accent:var(--patch); --pt-bg:var(--patch-bg);"`;
  } else if(variant === 'request'){
    tintStyle = ` style="--pt-accent:var(--post); --pt-bg:var(--post-bg);"`;
  } else if(variant !== undefined && variant !== null){
    const cls = respClass(variant);
    const colorVar = cls==='c2' ? '--st-2' : cls==='c3' ? '--st-3' : cls==='c4' ? '--st-4' : '--st-5';
    const bgVar = cls==='c2' ? '--post-bg' : cls==='c3' ? '--get-bg' : cls==='c4' ? '--put-bg' : '--delete-bg';
    tintStyle = ` style="--pt-accent:var(${colorVar}); --pt-bg:var(${bgVar});"`;
  }
  const revealed = sensitiveRevealed();
  // Every row goes through the centralized PII engine now — field name +
  // value pattern + admin-defined rules — not just header rows against a
  // fixed secret-keyword list. A "mobileNumber" query/body param is caught
  // here exactly the same way a CLIENT-SECRET header is.
  const rules = params.map(p=> p.example ? piiRuleFor(p.name, p.example) : null);
  const anySensitive = rules.some(Boolean);
  const rows = params.map((p,i)=>{
    const rule = rules[i];
    const masked = !!rule && !revealed;
    const displayVal = p.example ? (masked ? maskByStrategy(p.example, rule) : p.example) : '';
    return `<tr>
    <td><span class="pname" style="${boldNames?'font-weight:800;color:var(--text);':''}">${escapeHtml(p.name)}</span>${p.required?'<span class="req-star">*</span>':''}</td>
    <td><span class="ptype">${escapeHtml(p.type)}</span></td>
    <td>${p.example ? `<span class="pexample" title="${masked ? 'Masked — only the Admin role can reveal sensitive values' : escapeHtml(p.example)}">${escapeHtml(displayVal)}</span>` : '<span class="empty-field">—</span>'}</td>
    <td>${p.description ? escapeHtml(p.description) : '<span class="empty-field">—</span>'}</td>
  </tr>`;}).join('');
  const revealBtnHtml = anySensitive
    ? `<button type="button" class="icon-btn header-reveal-btn${canRevealSensitive()?'':' locked'}" data-header-reveal title="${canRevealSensitive() ? (revealed?'Hide sensitive values':'Reveal sensitive values') : 'Only the Admin role can reveal sensitive values'}">${canRevealSensitive() ? (revealed?ICON_EYE_OFF:ICON_EYE) : ICON_LOCK}</button>`
    : '';
  return `
    <div class="section-sub" style="${boldNames?'font-weight:800;color:var(--text);':''}display:flex;align-items:center;gap:6px;">${title}${revealBtnHtml}</div>
    <table class="data-table params-table${variant!==undefined&&variant!==null?' data-table-tinted':''}"${tintStyle}>
      <colgroup><col class="col-name"><col class="col-type"><col class="col-example"><col class="col-desc"></colgroup>
      <thead><tr><th>Name</th><th>Type</th><th>Example</th><th>Description</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ---- Documentation access lock ----
// Rendered instead of the real doc page whenever GET /api/workspace sent
// down a redacted stub (ep._docLocked — see applyDocLock in
// server/routes/workspace.js). The real headers/parameters/request/response
// content was never sent to this browser at all for a locked endpoint, so
// there's nothing this function could show even if it wanted to — the only
// job here is to explain why, show the status of any existing request, and
// offer to make a new one.
function renderLockedEndpointDoc(main, proj, ep){
  const status = ep._docAccessStatus; // null | 'pending' | 'denied' | 'expired'
  let heading, body, metaHtml = '', noteHtml = '', actionsHtml = '', iconClass = '';

  if(status === 'pending'){
    heading = 'Access request pending';
    body = `Your request to view this endpoint's documentation is waiting on an Admin's approval.`;
    metaHtml = `<div class="doc-lock-meta">${ICON_LOCK} Requested window: ${escapeHtml(ep._docAccessStartDate||'')} → ${escapeHtml(ep._docAccessEndDate||'')}</div>`;
  } else if(status === 'denied'){
    iconClass = 'denied';
    heading = 'Access request denied';
    body = `An Admin reviewed your request for this endpoint's documentation and didn't approve it.`;
    if(ep._docAccessDecisionNote) noteHtml = `<div class="doc-lock-note"><strong>Admin's note:</strong> ${escapeHtml(ep._docAccessDecisionNote)}</div>`;
    actionsHtml = `<button type="button" class="primary" id="docLockRequestBtn">Request again</button>`;
  } else if(status === 'expired'){
    heading = 'Access has expired';
    body = `Your documentation access for this endpoint ran out on ${escapeHtml(ep._docAccessEndDate||'')}. Request a new window to view it again.`;
    actionsHtml = `<button type="button" class="primary" id="docLockRequestBtn">Request access</button>`;
  } else {
    heading = 'Documentation access required';
    body = `This organisation keeps full endpoint documentation — headers, parameters, and sample requests/responses — behind an approval step. Your role can see that this endpoint exists, but needs time-boxed access from an Admin to view the details.`;
    actionsHtml = `<button type="button" class="primary" id="docLockRequestBtn">Request access</button>`;
  }

  main.innerHTML = `
    <div class="crumb">${escapeHtml(proj.name)}</div>
    <div class="doc-lock-panel">
      <div class="doc-lock-icon ${iconClass}">${ICON_LOCK}</div>
      <span class="badge ${methodClass(ep.method)}" style="margin-bottom:12px;">${escapeHtml(ep.method)}</span>
      <div class="mono" style="font-size:13px;color:var(--text-dim);margin-bottom:14px;">${escapeHtml(ep.path)}</div>
      <h1>${escapeHtml(heading)}</h1>
      ${ep.summary ? `<p>${escapeHtml(ep.summary)}</p>` : ''}
      <p>${body}</p>
      ${metaHtml}
      ${noteHtml}
      <div class="doc-lock-actions">${actionsHtml}</div>
    </div>
  `;
  const btn = document.getElementById('docLockRequestBtn');
  if(btn) btn.addEventListener('click', ()=> openDocAccessRequestModal(proj, ep));
}

let _docAccessModalCtx = null;
function toDateInputValue(d){ return d.toISOString().slice(0,10); }
function applyDocAccessPreset(days){
  const start = new Date();
  const end = new Date(start.getTime() + days*86400000);
  document.getElementById('docAccessStart').value = toDateInputValue(start);
  document.getElementById('docAccessEnd').value = toDateInputValue(end);
  document.querySelectorAll('#docAccessPresets .duration-preset').forEach(b=>{
    b.classList.toggle('active', b.getAttribute('data-preset') === String(days));
  });
}
function docAccessEnvStatusLabel(status, endDate){
  if(status === 'active') return `Already have access${endDate ? ' until '+endDate : ''}`;
  if(status === 'pending') return 'Request pending';
  if(status === 'denied') return 'Previously denied';
  if(status === 'expired' || status === 'revoked') return 'Previously expired';
  return '';
}
async function openDocAccessRequestModal(proj, ep){
  _docAccessModalCtx = { projectId: proj.id, endpointId: ep.id };
  document.getElementById('docAccessModalSubtitle').textContent = `${ep.method} ${ep.path}${ep.summary ? ' — '+ep.summary : ''}`;
  document.getElementById('docAccessReason').value = '';
  document.getElementById('docAccessModalError').style.display = 'none';
  const listEl = document.getElementById('docAccessEnvironmentList');
  listEl.innerHTML = `<div class="hint" style="margin:8px;">Loading environments…</div>`;
  applyDocAccessPreset(30); // a sensible default window — still fully editable before sending
  document.getElementById('docAccessRequestModal').classList.add('show');

  // Fetched fresh every time the modal opens (rather than reusing whatever's
  // in state) so a grant approved five minutes ago already shows as
  // "Already have access" instead of letting the person re-request it.
  let envStatuses = [];
  try{
    const data = await apiGet(`/doc-access/endpoint-status?projectId=${encodeURIComponent(proj.id)}&endpointId=${encodeURIComponent(ep.id)}`);
    envStatuses = data.environments || [];
  }catch(e){
    listEl.innerHTML = `<div class="hint" style="margin:8px;color:var(--delete);">Could not load environment status — you can still pick below.</div>`;
    envStatuses = environments().filter(e=>String(e.label||'').trim().toUpperCase()!=='DR').map(e=>({id:e.id, label:e.label, status:'none'}));
  }
  if(_docAccessModalCtx?.projectId !== proj.id || _docAccessModalCtx?.endpointId !== ep.id) return; // modal moved on while this was in flight

  listEl.innerHTML = envStatuses.map(e=>{
    const locked = e.status === 'active' || e.status === 'pending';
    const checked = !locked && e.id === state.env; // default to whatever they were looking at when they hit the lock
    const statusText = docAccessEnvStatusLabel(e.status, e.endDate);
    return `<label class="doc-access-env-row status-${e.status}${locked?' disabled':''}">
      <input type="checkbox" value="${escapeHtml(e.id)}" ${checked?'checked':''} ${locked?'disabled':''}>
      <span class="env-label">${escapeHtml(e.label)}</span>
      ${statusText ? `<span class="env-status">${escapeHtml(statusText)}</span>` : ''}
    </label>`;
  }).join('');
}
function closeDocAccessRequestModal(){
  document.getElementById('docAccessRequestModal').classList.remove('show');
  _docAccessModalCtx = null;
}
document.getElementById('docAccessModalCancel').addEventListener('click', closeDocAccessRequestModal);
document.getElementById('docAccessRequestModal').addEventListener('click', (e)=>{
  if(e.target.id === 'docAccessRequestModal') closeDocAccessRequestModal();
});
document.querySelectorAll('#docAccessPresets .duration-preset').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    const preset = btn.getAttribute('data-preset');
    if(preset === 'custom'){
      document.querySelectorAll('#docAccessPresets .duration-preset').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      return; // leave whatever dates are already in the fields for manual editing
    }
    applyDocAccessPreset(parseInt(preset,10));
  });
});
// Hand-editing either date should fall back to "Custom dates" as the active
// preset, so the pills never keep claiming e.g. "30 days" once the person
// has edited away from that exact window.
['docAccessStart','docAccessEnd'].forEach(id=>{
  document.getElementById(id).addEventListener('input', ()=>{
    document.querySelectorAll('#docAccessPresets .duration-preset').forEach(b=>b.classList.remove('active'));
    const customBtn = document.querySelector('#docAccessPresets [data-preset="custom"]');
    if(customBtn) customBtn.classList.add('active');
  });
});
document.getElementById('docAccessModalSubmit').addEventListener('click', async ()=>{
  if(!_docAccessModalCtx) return;
  const btn = document.getElementById('docAccessModalSubmit');
  const errEl = document.getElementById('docAccessModalError');
  errEl.style.display = 'none';
  const environmentIds = Array.from(document.querySelectorAll('#docAccessEnvironmentList input[type="checkbox"]:checked:not(:disabled)')).map(cb=>cb.value);
  const startDate = document.getElementById('docAccessStart').value;
  const endDate = document.getElementById('docAccessEnd').value;
  const reason = document.getElementById('docAccessReason').value.trim();
  if(!environmentIds.length){
    errEl.textContent = 'Pick at least one environment you need access for.';
    errEl.style.display = 'block';
    return;
  }
  if(!startDate || !endDate){
    errEl.textContent = 'Pick both a start and end date.';
    errEl.style.display = 'block';
    return;
  }
  const ctx = _docAccessModalCtx;
  btn.disabled = true; btn.textContent = 'Sending…';
  try{
    const result = await apiSend('POST', '/doc-access/requests', { projectId: ctx.projectId, endpointId: ctx.endpointId, environmentIds, startDate, endDate, reason: reason || undefined });
    const createdLabels = (result.created||[]).map(r=>r.environment_label);
    const skippedLabels = (result.skipped||[]).map(s=>s.environmentLabel);
    if(createdLabels.length && !skippedLabels.length){
      toast(`Request sent for ${createdLabels.join(', ')} — an Admin will review it`);
    } else if(createdLabels.length && skippedLabels.length){
      toast(`Request sent for ${createdLabels.join(', ')}. Skipped ${skippedLabels.join(', ')} — already covered.`);
    } else {
      toast(`Nothing new to send — you already have or are waiting on ${skippedLabels.join(', ')}.`);
    }
    closeDocAccessRequestModal();
    await loadState(); // pulls this endpoint's fresh "_docAccessStatus: pending" from the server
    renderMain();
  }catch(e){
    errEl.textContent = e.message || 'Could not submit the request.';
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false; btn.textContent = 'Send request';
  }
});

function renderEndpointDoc(main, proj, ep){
  if(ep._docLocked){ renderLockedEndpointDoc(main, proj, ep); return; }
  const pathParams = (ep.parameters||[]).filter(p=>p.in==='path');
  const queryParams = (ep.parameters||[]).filter(p=>!p.in || p.in==='query');
  const headerParams = ep.headers || (ep.parameters||[]).filter(p=>p.in==='header');

  // Body fields (e.g. from "Infer fields from JSON" on the Request body
  // block) used to live only in ep.requestBody.fields and never made it into
  // this panel — the Request parameters tab only ever looked at path/query
  // params, so an endpoint documented purely via a JSON body example showed
  // "No parameters documented" even though fields existed. Folded in here as
  // its own section so all three parameter sources show up in one place.
  const bodyFields = (ep.requestBody && ep.requestBody.fields) || [];
  const hasAnyParams = pathParams.length || queryParams.length || bodyFields.length;
  const paramsHtml = hasAnyParams ? [
    paramSection('Path parameters', pathParams, 'request'),
    paramSection('Query parameters', queryParams, 'request'),
    paramSection('Body parameters', bodyFields, 'request'),
  ].join('') : `<div class="empty-field">No parameters documented.</div>`;

  const headersHtml = headerParams.length
    ? `<div class="doc-section-card" style="--sec-accent:var(--get);">${paramSection('Header parameters', headerParams, 'header')}</div>`
    : '';
  const hasReqJson = !!(ep.requestBody && (ep.requestBody.example || (ep.requestBody.examples||[]).length));

  // Unified "Scenario" selector. Request JSON examples and response JSON
  // examples are pairable by sharing the same name (see "Named examples" in
  // the editor, and tryItRequestScenarios/tryItResponseScenarios below,
  // which already do this pairing for the "Try it" panel). Picking a
  // scenario here drives both the Request panel and whichever Response
  // documents that same scenario — no separate per-panel "pick an example"
  // dropdown needed, so those have been removed from both JSON views.
  const requestScenarios = tryItRequestScenarios(ep);
  const responseScenarios = tryItResponseScenarios(ep);
  const scenarioNames = [];
  requestScenarios.forEach(s=>{ if(!scenarioNames.includes(s.name)) scenarioNames.push(s.name); });
  responseScenarios.forEach(s=>{ if(!scenarioNames.includes(s.name)) scenarioNames.push(s.name); });
  const scenarioPickerHtml = scenarioNames.length > 1 ? `
    <div class="resp-pill-row" id="docScenarioPicker" style="margin-bottom:16px;">
      ${scenarioNames.map((name,i)=>{
        // Colour each scenario pill the same way a Response accordion item is
        // coloured — off the status code that scenario actually resolves to
        // (2xx green / 3xx blue / 4xx amber / 5xx red) — instead of every
        // pill showing the same flat accent dot regardless of what it documents.
        const matched = responseScenarios.find(s=>s.name===name);
        const accentVar = matched ? respColorVar(matched.code) : '--accent';
        const reqScenario = requestScenarios.find(s=>s.name===name);
        const condLabel = reqScenario && reqScenario.condition ? describeCondition(reqScenario.condition) : '';
        return `<div class="resp-pill${i===0?' active':''}" data-scenario-pick="${escapeHtml(name)}" style="--pill-accent:var(${accentVar});" ${condLabel?`title="Condition: ${escapeHtml(condLabel)}"`:''}><span class="dot" style="background:var(${accentVar});"></span><span class="mono" style="font-weight:700;">${escapeHtml(name)}</span>${condLabel?`<span class="mono" style="font-size:10px;color:var(--text-faint);margin-left:6px;">${escapeHtml(condLabel)}</span>`:''}</div>`;
      }).join('')}
    </div>` : '';

  // A single Parameters/JSON toggle now drives BOTH the Request panel and
  // every Response panel together, instead of each accordion item carrying
  // its own independent pair of tabs. `activeTab`/`activeScenario` are local
  // render state — reset to the defaults every time this doc is (re)opened.
  let activeTab = 'params';
  let activeScenario = scenarioNames[0] || 'Default';

  function requestJsonValue(){
    const s = requestScenarios.find(s=>s.name===activeScenario);
    if(s) return s.value;
    return (requestScenarios[0] && requestScenarios[0].value) || '';
  }
  function requestPanelContent(){
    if(activeTab === 'json'){
      if(!hasReqJson) return `<div class="empty-field">No request JSON documented.</div>`;
      const value = requestJsonValue();
      const matched = requestScenarios.some(s=>s.name===activeScenario);
      return `
        <div class="json-preview-label"><span>Request JSON${matched && activeScenario!=='Default' ? ` — ${escapeHtml(activeScenario)}` : ''}</span></div>
        <div class="code-wrap"><pre class="code-block" data-req-json>${escapeHtml(maskedJsonString(value))}</pre><button class="copy-btn" data-copy-block="reqbody">Copy</button></div>`;
    }
    return paramsHtml;
  }
  function buildRequestItemHtml(){
    return `
      <div class="resp-item open" data-request-item style="--item-accent:var(--post);">
        <div class="resp-row" data-request-toggle>
          <span class="resp-code" style="background:var(--post-bg);color:var(--post);">REQ</span>
          <span class="resp-desc">Path, query &amp; body parameters for this request</span>
          <span class="resp-caret">▶</span>
        </div>
        <div class="resp-body" data-request-panel><div class="doc-panel-fade">${requestPanelContent()}</div></div>
      </div>`;
  }

  // Effective status for response i under the current scenario: a scenario
  // can override the code/description/body for one specific named example
  // (e.g. the same 201 response block also documents a 400 "Minimum Payment
  // Amount" example) — previously the accordion header kept showing the
  // response block's own default code/colour no matter which example was
  // selected, so a documented 400 still displayed green "201". This now
  // resolves + colours the header from whichever example is actually active.
  function effectiveFor(i){
    const r = ep.responses[i];
    const s = responseScenarios.find(s=>s.name===activeScenario && s.response===r);
    return {
      r,
      code: s ? s.code : r.code,
      description: s ? s.description : r.description,
      value: s ? s.value : r.example,
      matchedScenario: s,
    };
  }
  function responsePanelContent(i){
    const { r, code, value, matchedScenario } = effectiveFor(i);
    if(activeTab === 'json'){
      if(!value) return `<div class="empty-field">No example body${matchedScenario ? '' : ' for this response'}.</div>`;
      // NOTE: the accordion row directly above (buildResponseItemHtml) already
      // shows this response's code pill + description via the same
      // effectiveFor(i) call — repeating both here as a second heading was
      // pure duplication (see: status code and description showing twice).
      // Only surface new info: which named example/scenario this JSON is for.
      return `
        <div class="json-preview-label"><span>Response JSON${matchedScenario && matchedScenario.name !== 'Default' ? ` — ${escapeHtml(matchedScenario.name)}` : ''}</span></div>
        <div class="code-wrap"><pre class="code-block" data-resp-json="${i}">${escapeHtml(maskedJsonString(value))}</pre><button class="copy-btn" data-copy-resp="${i}">Copy</button></div>`;
    }
    return r.fields && r.fields.length
      ? paramSection('Response parameters', r.fields, code)
      : `<div class="empty-field">No response parameters documented.</div>`;
  }
  function buildResponseItemHtml(i, isOpen){
    const { code, description } = effectiveFor(i);
    return `
      <div class="resp-item${isOpen?' open':''}" data-resp="${i}" style="--item-accent:var(${respColorVar(code)});">
        <div class="resp-row" data-resp-toggle="${i}">
          <span class="resp-code ${respClass(code)}">${escapeHtml(String(code))}</span>
          <span class="resp-desc">${description ? escapeHtml(description) : '<span class="empty-field">No description</span>'}</span>
          <span class="resp-caret">▶</span>
        </div>
        <div class="resp-body" data-resp-panel="${i}"><div class="doc-panel-fade">${responsePanelContent(i)}</div></div>
      </div>`;
  }
  function buildResponsesHtml(openSet){
    return ep.responses && ep.responses.length
      ? ep.responses.map((r,i)=>buildResponseItemHtml(i, openSet.has(i))).join('')
      : `<div class="empty-field">No responses documented.</div>`;
  }


  const metaChipsHtml = `
    <div class="endpoint-meta-chips">
      <span class="meta-chip"><span class="meta-chip-dot" style="background:${ep.visibility==='public' ? 'var(--get)' : 'var(--text-faint)'};"></span><span class="k">Visibility</span><span class="v">${ep.visibility==='public' ? 'Public' : 'Private'}</span></span>
      <span class="meta-chip"><span class="meta-chip-dot" style="background:var(--accent);"></span><span class="k">Version</span><span class="v">${escapeHtml(DocMeta.currentVersion(ep, proj))}</span></span>
      <span class="meta-chip"><span class="meta-chip-dot" style="background:var(--text-faint);"></span><span class="k">Project version</span><span class="v">${escapeHtml(DocMeta.currentVersion(null, proj))}</span></span>
      <span class="meta-chip"><span class="meta-chip-dot" style="background:var(--patch);"></span><span class="k">Content type</span><span class="v">${escapeHtml(ep.contentType||'application/json')}</span></span>
      <span class="meta-chip"><span class="meta-chip-dot" style="background:var(--post);"></span><span class="k">Added</span><span class="v">${ep.createdAt ? escapeHtml(formatDateTime(ep.createdAt)) : 'Unknown'}${ep.createdBy ? ' · ' + escapeHtml(ep.createdBy) : ''}</span></span>
      <span class="meta-chip"><span class="meta-chip-dot" style="background:var(--put);"></span><span class="k">Modified</span><span class="v">${ep.updatedAt ? escapeHtml(formatDateTime(ep.updatedAt)) : 'Unknown'}${ep.updatedBy ? ' · ' + escapeHtml(ep.updatedBy) : ''}</span></span>
    </div>`;

  const endpointMetaBoxHtml = (ep.summary || ep.description)
    ? `<div class="endpoint-meta-box">
        ${ep.summary ? `<div class="endpoint-meta-summary">${escapeHtml(ep.summary)}</div>` : ''}
        ${ep.description ? `<div class="endpoint-meta-desc">${renderMarkdown(ep.description)}</div>` : ''}
        ${metaChipsHtml}
      </div>`
    : `<div class="endpoint-meta-box">${metaChipsHtml}</div>`;

  const apiOverviewHtml = proj.description
    ? `<div class="section"><div class="section-title">API overview <span style="color:var(--text-faint); font-weight:500; text-transform:none;">— applies to every endpoint in ${escapeHtml(proj.name)}</span></div><div class="api-overview-box">${renderMarkdown(proj.description)}</div></div>`
    : `<div class="section"><div class="section-title">API overview</div><div class="empty-field">No API-level description yet — add one from Edit ▸ API-level description, or in Project settings.</div></div>`;

  // Same Authentication block as the project Overview page (auth-card +
  // Auth request/response parameter tables) — shown here too since auth is
  // shared across every endpoint in the project and shouldn't require a trip
  // back to Overview to see the JWT/token details. Folded into a single
  // colored .doc-section-card (purple accent) instead of three separate-
  // looking pieces, matching the API overview card treatment.
  const authSectionHtml = `
    <div class="section">
      <div class="section-title">Authentication <span style="color:var(--text-faint); font-weight:500; text-transform:none;">— applies to every endpoint in ${escapeHtml(proj.name)}</span></div>
      <div class="doc-section-card" style="--sec-accent:var(--patch);">
      ${proj.auth && proj.auth.type ? `
        <div class="auth-card">
          <div class="ic">🔑</div>
          <div>
            <div class="h">${escapeHtml(proj.auth.type)}${proj.auth.headerName ? ' · '+escapeHtml(proj.auth.headerName)+' header' : ''}</div>
            ${proj.auth.path ? `<div class="d" style="margin-top:4px;"><span class="badge ${methodClass(proj.auth.method||'POST')}" style="margin-right:8px;">${escapeHtml(proj.auth.method||'POST')}</span><span class="mono" style="font-size:12px;">${escapeHtml(proj.auth.path)}</span></div>` : ''}
            <div class="d">${proj.auth.description ? escapeHtml(proj.auth.description) : 'No further notes.'}</div>
          </div>
        </div>
        ${proj.auth.includeInDocs ? paramSection('Auth request parameters', proj.auth.requestParams||[], 'auth') : ''}
        ${proj.auth.includeInDocs ? paramSection('Auth response parameters', proj.auth.responseParams||[], 'auth') : ''}` : `<div class="auth-card"><div class="ic">🔓</div><div><div class="h">No auth configured</div><div class="d">Add authentication details in project settings.</div></div></div>`}
      </div>
    </div>`;

  const epRequestFlowHtml = `
    <div class="section">
      ${requestFlowSectionInnerHtml(proj, envMeta(state.env), ep)}
    </div>`;

  main.innerHTML = `
    <div class="crumb">${escapeHtml(proj.name)} <span class="sep">/</span> ${escapeHtml(ep.tag)} <span class="env-chip">${envMeta(state.env).label}</span></div>
    ${!isViewingDraftEnv() ? `
    <div class="rp-envbanner">
      <span class="rp-envbanner-ic">👁</span>
      <span class="rp-envbanner-txt">Viewing ${escapeHtml(envMeta(state.env).label)} — read-only</span>
      <span class="rp-envbanner-hint">Switch to ${escapeHtml(envMeta(draftEnvId()).label)} to make changes</span>
    </div>` : ''}
    <div class="doc-header">
      <div class="path-row">
        <span class="badge badge-lg ${methodClass(ep.method)}">${ep.method}</span>
        <span class="path" title="${escapeHtml(maskedFullUrl(proj, ep))}"><span style="color:var(--text-faint);font-weight:500;">${escapeHtml(envVarToken(state.env))}</span>${escapeHtml(pathWithParams(ep))}</span>
        <div class="path-actions">
          <button class="primary" id="btnTryIt">Try it</button>
          <div class="ep-actions-dd" id="epActionsDD">
            <button type="button" class="ep-actions-btn" id="epActionsBtn" aria-haspopup="true" aria-expanded="false" aria-controls="epActionsPanel" title="More actions">
              Actions <span class="dd-chev">▾</span>
            </button>
            <div class="ep-actions-panel" id="epActionsPanel" role="menu">
              <button type="button" class="ep-actions-item" id="btnViewCode" role="menuitem"><span class="item-label">View</span><span class="item-sub">cURL &amp; Swagger</span></button>
              <div class="ep-actions-divider"></div>
              <button type="button" class="ep-actions-item" id="btnEditEp" role="menuitem"${canEditHere()?'':` disabled title="${canEdit() ? `Switch to ${escapeHtml(envMeta(draftEnvId()).label)} to edit` : 'Your role is read-only'}"`}>Edit</button>
              <button type="button" class="ep-actions-item" id="btnDuplicateEp" role="menuitem"${canEditHere()?'':` disabled title="${canEdit() ? `Switch to ${escapeHtml(envMeta(draftEnvId()).label)} to edit` : 'Your role is read-only'}"`}>Duplicate</button>
              <div class="ep-actions-divider"></div>
              <button type="button" class="ep-actions-item danger" id="btnDeleteEp" role="menuitem"${canEditHere()?'':` disabled title="${canEdit() ? `Switch to ${escapeHtml(envMeta(draftEnvId()).label)} to edit` : 'Your role is read-only'}"`}>Delete endpoint</button>
              ${proj._readonly || !isViewingDraftEnv() ? '' : `
              <div class="ep-actions-divider"></div>
              <button type="button" class="ep-actions-item" data-toggle-ep-visibility="${ep.id}" role="menuitem">
                <span class="item-label">
                  <span class="item-ic">${ep.visibility==='public'
                    ? '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 9.9-1"></path></svg>'
                    : '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>'}</span>
                  <span>${ep.visibility==='public' ? 'Make private' : 'Make public'}</span>
                </span>
                <span class="item-sub">${ep.visibility==='public' ? 'Only you' : 'Your organisation'}</span>
              </button>`}
            </div>
          </div>
        </div>
      </div>
      ${endpointMetaBoxHtml}
    </div>

    ${apiOverviewHtml}

    ${authSectionHtml}

    ${epRequestFlowHtml}

    ${headersHtml ? `<div class="section"><div class="section-title">Headers</div>${headersHtml}</div>` : ''}

    <div class="section">
      <div class="section-title-row">
        <div class="section-title">Request &amp; Response</div>
        <div class="resp-tabs" id="docViewTabs">
          <button type="button" class="resp-tab active" data-view-tab="params">Parameters</button>
          <button type="button" class="resp-tab" data-view-tab="json">JSON</button>
        </div>
      </div>
      ${scenarioPickerHtml}
      <div class="section-sub">Request</div>
      <div data-request-wrap>${buildRequestItemHtml()}</div>
      <div class="section-sub" style="margin-top:18px;">Responses</div>
      <div data-responses-wrap>${buildResponsesHtml(new Set())}</div>
    </div>
  `;

  document.getElementById('btnTryIt').addEventListener('click', ()=>openTryItTab(ep));
  document.getElementById('epActionsBtn').addEventListener('click', (e)=>{
    e.stopPropagation();
    document.getElementById('epActionsDD').classList.toggle('open');
  });
  document.getElementById('btnViewCode').addEventListener('click', ()=>{
    document.getElementById('epActionsDD').classList.remove('open');
    openCodeSamplesRail();
  });
  document.getElementById('btnEditEp').addEventListener('click', ()=>{
    document.getElementById('epActionsDD').classList.remove('open');
    if(canEditHere()) openEditorTab(proj, ep);
  });
  document.getElementById('btnDuplicateEp').addEventListener('click', ()=>{
    document.getElementById('epActionsDD').classList.remove('open');
    if(canEditHere()) duplicateEndpoint(ep.id);
  });
  document.getElementById('btnDeleteEp').addEventListener('click', ()=>{
    document.getElementById('epActionsDD').classList.remove('open');
    if(canEditHere()) deleteEndpointById(ep.id);
  });
  main.querySelectorAll('[data-header-reveal]').forEach(btn=>{
    btn.addEventListener('click', ()=> toggleSensitiveRevealed());
  });

  // Re-renders the Request panel + all Response panels from current
  // activeTab/activeScenario, preserving which response items were already
  // expanded/collapsed by the person. Re-binding toggle/copy listeners after
  // each pass is safe (and matches the rest of this file's convention)
  // because innerHTML replacement discards the old nodes — nothing to leak.
  function rerenderReqResp(){
    const openSet = new Set();
    main.querySelectorAll('[data-resp].open').forEach(el=> openSet.add(parseInt(el.getAttribute('data-resp'),10)));
    const reqWrap = main.querySelector('[data-request-wrap]');
    if(reqWrap) reqWrap.innerHTML = buildRequestItemHtml();
    const respWrap = main.querySelector('[data-responses-wrap]');
    if(respWrap) respWrap.innerHTML = buildResponsesHtml(openSet);
    wireReqRespPanels();
  }

  function wireReqRespPanels(){
    const reqToggle = main.querySelector('[data-request-toggle]');
    if(reqToggle) reqToggle.addEventListener('click', ()=>{ reqToggle.closest('.resp-item').classList.toggle('open'); });
    main.querySelectorAll('[data-resp-toggle]').forEach(el=>{
      el.addEventListener('click', ()=>{ el.closest('.resp-item').classList.toggle('open'); });
    });
    const reqCopy = main.querySelector('[data-copy-block="reqbody"]');
    if(reqCopy) reqCopy.addEventListener('click', (ev)=>{
      const pre = main.querySelector('[data-req-json]');
      if(pre) copyToClipboard(pre.textContent, ev.currentTarget);
    });
    main.querySelectorAll('[data-copy-resp]').forEach(btn=>{
      btn.addEventListener('click', (ev)=>{
        const idx = btn.getAttribute('data-copy-resp');
        const pre = main.querySelector(`[data-resp-json="${idx}"]`);
        if(pre) copyToClipboard(pre.textContent, ev.currentTarget);
      });
    });
  }
  wireReqRespPanels();

  // The single Parameters/JSON toggle drives both panels at once — no more
  // hunting for the right tab in two separate places to see a request body
  // next to its response body.
  main.querySelectorAll('[data-view-tab]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const tab = btn.getAttribute('data-view-tab');
      if(tab === activeTab) return;
      activeTab = tab;
      main.querySelectorAll('[data-view-tab]').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      rerenderReqResp();
    });
  });

  // Picking a scenario re-renders both panels together: the Request side
  // shows that scenario's JSON (Parameters view is schema-level and doesn't
  // change per example), and whichever Response documents that same
  // scenario name gets its header code/colour + body updated to match and
  // is scrolled into view — this is what actually fixes a scenario's
  // overridden status code (e.g. 400) showing up instead of the response
  // block's own default code always winning.
  main.querySelectorAll('[data-scenario-pick]').forEach(pill=>{
    pill.addEventListener('click', ()=>{
      const name = pill.getAttribute('data-scenario-pick');
      if(name === activeScenario) return;
      activeScenario = name;
      main.querySelectorAll('[data-scenario-pick]').forEach(p=>p.classList.remove('active'));
      pill.classList.add('active');
      rerenderReqResp();
      const respScenario = responseScenarios.find(s=>s.name===name);
      if(respScenario){
        const item = main.querySelector(`[data-resp="${ep.responses.indexOf(respScenario.response)}"]`);
        if(item) item.scrollIntoView({ behavior:'smooth', block:'nearest' });
      }
    });
  });
}

function duplicateEndpoint(epId){
  if(!canEditHere()){ toast(isViewingDraftEnv() ? `Your role (${roleMeta(state.authorRole).label}) is read-only` : `Switch to ${envMeta(draftEnvId()).label} to make changes`); return; }
  const found = findEndpoint(epId);
  if(!found) return;
  const copy = JSON.parse(JSON.stringify(found.ep));
  copy.id = uid();
  copy.path = copy.path + '-copy';
  found.proj.endpoints.push(copy);
  saveState();
  state.selected = { type:'endpoint', id: copy.id };
  renderAll();
  toast('Endpoint duplicated');
}
