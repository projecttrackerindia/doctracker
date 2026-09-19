/* ==================== SECTION:NOTIFICATIONS ====================
   Bell in the topbar + a count badge on Security. See server/notifications.js
   for the write side — this is purely the read/poll/render side. Deliberately
   NOT under WORKSPACE_API (mounted separately at /api/notifications), and NOT
   gated by an access-schedule lock — see server/routes/notifications.js for why. */
const NOTIF_POLL_MS = 25000;
let _notifPanelOpen = false;
let _notifOldestId = null; // cursor for "load more"

async function notifApiGet(path){
  const res = await fetch('/api/notifications' + path, { credentials:'same-origin' });
  if(!res.ok) throw new Error('Request failed: ' + res.status);
  return res.json();
}
async function notifApiPost(path){
  const res = await fetch('/api/notifications' + path, { method:'POST', credentials:'same-origin' });
  if(!res.ok) throw new Error('Request failed: ' + res.status);
  return res.json();
}

function timeAgo(iso){
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if(mins < 1) return 'just now';
  if(mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if(hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

// Routes a notification's `link` (see notifications.js — a small, client-
// interpreted hint, never a raw URL) to the right place in this SPA.
function navigateToNotifLink(link){
  if(!link) return;
  if(link.view === 'security'){
    state.selected = { type:'security' };
    state.securityTab = link.tab || (isAdmin() ? 'summary' : 'docaccess');
    renderMain();
  } else if(link.view === 'endpoint' && link.endpointId){
    state.selected = { type:'endpoint', id: link.endpointId };
    renderMain();
  } else if(link.view === 'project' && link.projectId){
    state.selected = { type:'project', id: link.projectId };
    renderMain();
  } else if(link.view === 'release-pipeline' && link.projectId){
    const p = state.projects[link.projectId];
    if(p) openReleasePipelineTab(p); else toast('That project could not be found.');
  } else if(link.view === 'tryit'){
    // Live Mode access changed — nothing more specific to jump to than the
    // home view; the person can open Try It on whichever endpoint they need.
    state.selected = { type:'home' };
    renderMain();
  }
}

async function refreshNotifBadge(){
  try{
    const { count } = await notifApiGet('/unread-count');
    const el = document.getElementById('notifBadge');
    if(!el) return;
    if(count > 0){ el.textContent = count > 99 ? '99+' : String(count); el.style.display = ''; }
    else el.style.display = 'none';
  }catch(e){ /* best-effort — a poll failing shouldn't surface an error toast */ }
}

async function refreshSecurityBadge(){
  const el = document.getElementById('securityBadge');
  if(!el) return;
  if(!isAdmin() && !ownsAnyProject()){ el.style.display = 'none'; return; }
  try{
    const { count } = await apiGet('/doc-access/pending-count');
    if(count > 0){ el.textContent = count > 99 ? '99+' : String(count); el.style.display = ''; }
    else el.style.display = 'none';
  }catch(e){ /* best-effort */ }
}

function renderNotifList(notifications, { append } = {}){
  const list = document.getElementById('notifList');
  if(!list) return;
  const itemsHtml = notifications.map(n => `
    <button type="button" class="notif-item ${n.read_at ? '' : 'unread'}" data-notif-id="${n.id}" data-notif-link='${n.link ? escapeHtml(JSON.stringify(n.link)) : ''}'>
      <div class="notif-title">${escapeHtml(n.title)}</div>
      ${n.body ? `<div class="notif-body">${escapeHtml(n.body)}</div>` : ''}
      <div class="notif-time">${timeAgo(n.created_at)}</div>
    </button>
  `).join('');
  if(append){
    const loadMoreBtn = list.querySelector('.notif-load-more');
    if(loadMoreBtn) loadMoreBtn.remove();
    list.insertAdjacentHTML('beforeend', itemsHtml);
  } else {
    list.innerHTML = notifications.length ? itemsHtml : `<div class="notif-empty">You're all caught up.</div>`;
  }
}

async function loadNotifPanel(){
  try{
    const { notifications, hasMore } = await notifApiGet('/?limit=20');
    _notifOldestId = notifications.length ? notifications[notifications.length - 1].id : null;
    renderNotifList(notifications);
    if(hasMore) document.getElementById('notifList').insertAdjacentHTML('beforeend', `<button type="button" class="notif-load-more" id="btnNotifLoadMore">Load more</button>`);
  }catch(e){
    document.getElementById('notifList').innerHTML = `<div class="notif-empty">Couldn't load notifications.</div>`;
  }
}

async function loadMoreNotifs(){
  if(!_notifOldestId) return;
  try{
    const { notifications, hasMore } = await notifApiGet(`/?limit=20&beforeId=${_notifOldestId}`);
    _notifOldestId = notifications.length ? notifications[notifications.length - 1].id : _notifOldestId;
    renderNotifList(notifications, { append:true });
    if(hasMore) document.getElementById('notifList').insertAdjacentHTML('beforeend', `<button type="button" class="notif-load-more" id="btnNotifLoadMore">Load more</button>`);
  }catch(e){ /* leave existing list as-is on failure */ }
}

function toggleNotifPanel(force){
  const panel = document.getElementById('notifPanel');
  _notifPanelOpen = force != null ? force : !_notifPanelOpen;
  panel.classList.toggle('open', _notifPanelOpen);
  if(_notifPanelOpen) loadNotifPanel();
}

// Single delegated listener for the panel's dynamic content (items + Load
// more), since items are re-rendered wholesale on every open/poll.
document.getElementById('notifList').addEventListener('click', async (e)=>{
  const loadMoreBtn = e.target.closest('#btnNotifLoadMore');
  if(loadMoreBtn){ loadMoreNotifs(); return; }
  const item = e.target.closest('.notif-item');
  if(!item) return;
  const id = item.getAttribute('data-notif-id');
  item.classList.remove('unread');
  notifApiPost(`/${id}/read`).then(refreshNotifBadge).catch(()=>{});
  const linkRaw = item.getAttribute('data-notif-link');
  let link = null;
  try{ link = linkRaw ? JSON.parse(linkRaw) : null; }catch(e){ link = null; }
  toggleNotifPanel(false);
  if(link) navigateToNotifLink(link);
});
document.getElementById('btnNotifBell').addEventListener('click', (e)=>{
  e.stopPropagation();
  toggleNotifPanel();
});
document.getElementById('btnNotifMarkAllRead').addEventListener('click', async (e)=>{
  e.stopPropagation();
  await notifApiPost('/read-all').catch(()=>{});
  document.querySelectorAll('.notif-item.unread').forEach(el=>el.classList.remove('unread'));
  refreshNotifBadge();
});
document.addEventListener('click', (e)=>{
  if(_notifPanelOpen && !e.target.closest('#notifPanel') && !e.target.closest('#btnNotifBell')) toggleNotifPanel(false);
});

function initNotifications(){
  refreshNotifBadge();
  refreshSecurityBadge();
  setInterval(refreshNotifBadge, NOTIF_POLL_MS);
  setInterval(refreshSecurityBadge, NOTIF_POLL_MS);
}

// One-time: if this browser still has the old localStorage workspace, ship it
// to the server (owned privately by whoever is signed in) and wipe the local
// copy. Safe to call on every load — it no-ops once MIGRATED_FLAG_KEY is set.
async function migrateLocalStorageIfNeeded(){
  if(!AUTH_USER || localStorage.getItem(MIGRATED_FLAG_KEY)) return;
  let payload = null;
  try{
    const raw = localStorage.getItem(NEW_KEY);
    const old = localStorage.getItem(OLD_KEY);
    if(raw){
      const parsed = JSON.parse(raw);
      const projects = {};
      Object.values(parsed.projects || {}).forEach(p=>{ const m = migrateProject(p); projects[m.id] = m; });
      payload = {
        projects,
        requestHistory: parsed.requestHistory || {},
        environments: JSON.parse(localStorage.getItem(ENVIRONMENTS_KEY) || 'null') || [],
        auditLog: JSON.parse(localStorage.getItem(AUDIT_KEY) || 'null') || [],
        customFlowDirections: JSON.parse(localStorage.getItem(CUSTOM_FLOW_DIRECTIONS_KEY) || 'null') || [],
      };
    } else if(old){
      const oldProjects = JSON.parse(old);
      const projects = {};
      Object.values(oldProjects).forEach(p=>{ const m = migrateProject(p); projects[m.id] = m; });
      payload = { projects, requestHistory:{}, environments:[], auditLog:[], customFlowDirections:[] };
    }
  }catch(e){ console.error('Could not read old localStorage workspace', e); }

  if(payload && Object.keys(payload.projects).length){
    try{
      const res = await apiSend('POST', '/migrate', payload);
      toast(`Brought your ${res.imported} existing project${res.imported===1?'':'s'} into the shared workspace`);
    }catch(e){
      console.error('Migration to server failed', e);
      toast('Could not migrate your old local data to the server — will retry next time you load this page.');
      return; // leave the flag unset so we retry on the next load
    }
  }
  localStorage.setItem(MIGRATED_FLAG_KEY, '1');
  [NEW_KEY, OLD_KEY, ENVIRONMENTS_KEY, AUDIT_KEY, CUSTOM_FLOW_DIRECTIONS_KEY].forEach(k=>localStorage.removeItem(k));
}

// Curated avatar palette — deliberately distinct from the HTTP-method / environment
// accent colors used elsewhere, so a profile avatar never looks like a status chip.
const PROFILE_COLORS = ['#5c7cfa','#35b8c9','#8b7cf6','#e0a83e','#c4529a','#4fa3f7','#35c491','#ef5c6e'];
function hashStr(s){ let h = 0; for(let i=0;i<s.length;i++){ h = (h*31 + s.charCodeAt(i)) >>> 0; } return h; }
function profileInitials(name){
  const parts = (name||'').trim().split(/\s+/).filter(Boolean);
  if(!parts.length) return '';
  if(parts.length === 1) return parts[0].slice(0,2).toUpperCase();
  return (parts[0][0] + parts[parts.length-1][0]).toUpperCase();
}
function profileColor(name){
  const stored = localStorage.getItem(PROFILE_COLOR_KEY);
  if(stored) return stored;
  if(!name) return 'var(--text-faint)';
  return PROFILE_COLORS[hashStr(name) % PROFILE_COLORS.length];
}

// Environments used to be a hardcoded list. They're now a user-configurable list
// (add/delete from Your Profile), persisted separately from the rest of the workspace
// so they're available regardless of which project you're looking at. `restricted`
// replaces the old per-role env allowlist — Admin always sees everything, other roles
// are blocked only from environments flagged restricted (Prod/DR by default).
const ENVIRONMENTS_KEY = 'apiStudio_environments';
// `access` is a descriptive label (Admin/User/Read Only/Restricted) shown on the endpoint
// table — independent of `restricted`, which still gates the environment switcher the way
// it always has. `url` is the environment's own endpoint (separate from the per-project base
// URLs configured in Project settings ▸ Environments) and is sensitive: masked by default,
// only an Admin *role* can reveal it, see maskEndpointUrl()/canRevealSensitive().
const DEFAULT_ENVIRONMENTS = [
  { id:'DEV',     label:'Dev',      color:'#ef5c6e', restricted:false, access:'admin',      url:'https://dev.example.com' },
  { id:'SIT',     label:'SIT',      color:'#4fa3f7', restricted:false, access:'user',       url:'https://qa.example.com' },
  { id:'UAT',     label:'UAT',      color:'#8b7cf6', restricted:false, access:'user',       url:'' },
  { id:'PREPROD', label:'Staging',  color:'#35c491', restricted:false, access:'admin',      url:'https://staging.example.com' },
  { id:'PROD',    label:'Production', color:'#c4529a', restricted:true, access:'restricted', url:'https://prod.example.com' },
  { id:'DR',      label:'DR',       color:'#8a97b3', restricted:true,  access:'restricted', url:'' },
];
function environments(){
  return (state.environments && state.environments.length) ? state.environments : DEFAULT_ENVIRONMENTS;
}
function envIds(){ return environments().map(e=>e.id); }
// Migrates envs saved before `access`/`url` existed so old localStorage data keeps working.
function migrateEnvironment(e){
  return {
    ...e,
    access: e.access || (e.restricted ? 'restricted' : 'user'),
    url: e.url || '',
  };
}
// Environments are shared across the whole organisation (see server/routes/workspace.js
// GET/PUT /api/workspace/environments) — populated into state.environments by loadState().
function saveEnvironments(){
  apiSend('PUT', '/environments', { environments: state.environments })
    .catch(e=>{ console.error('Save environments failed', e); toast('Could not save environments to the server.'); });
}
function envIdFromLabel(label){
  return String(label||'').trim().toUpperCase().replace(/[^A-Z0-9]+/g,'_').replace(/^_+|_+$/g,'') || uid().toUpperCase();
}
function addEnvironment(label, color, access, url){
  const trimmed = (label||'').trim();
  if(!trimmed) return { ok:false, error:'Environment name is required.' };
  let id = envIdFromLabel(trimmed);
  if(environments().some(e=>e.id===id)) id = id + '_' + uid().slice(0,4).toUpperCase();
  if(environments().some(e=>e.label.toLowerCase()===trimmed.toLowerCase())) return { ok:false, error:'That environment already exists.' };
  const accessId = ENV_ACCESS_LEVELS.some(a=>a.id===access) ? access : 'user';
  const env = {
    id, label: trimmed,
    color: color || ENV_COLOR_PALETTE[environments().length % ENV_COLOR_PALETTE.length],
    access: accessId,
    restricted: accessId === 'restricted',
    url: (url||'').trim(),
  };
  state.environments = environments().slice();
  state.environments.push(env);
  saveEnvironments();
  logAudit('created', 'environment', env.label, `Added environment "${env.label}" (${accessMeta(accessId).label} access)`);
  return { ok:true, env };
}
function updateEnvironment(id, patch){
  const list = environments();
  const idx = list.findIndex(e=>e.id===id);
  if(idx < 0) return { ok:false, error:'Environment not found.' };
  const next = { ...list[idx], ...patch };
  if(patch.access) next.restricted = patch.access === 'restricted';
  state.environments = list.slice();
  state.environments[idx] = next;
  saveEnvironments();
  logAudit('updated', 'environment', next.label, `Updated "${next.label}" environment`);
  return { ok:true, env: next };
}
function moveEnvironment(id, dir){
  const list = environments().slice();
  const idx = list.findIndex(e=>e.id===id);
  if(idx < 0) return { ok:false };
  const [item] = list.splice(idx, 1);
  if(dir === 'top') list.unshift(item);
  else if(dir === 'bottom') list.push(item);
  else return { ok:false };
  state.environments = list;
  saveEnvironments();
  logAudit('updated', 'environment', item.label, `Moved "${item.label}" to the ${dir}`);
  return { ok:true };
}
function reorderEnvironments(draggedId, targetId, placeAfter){
  const list = environments().slice();
  const fromIdx = list.findIndex(e=>e.id===draggedId);
  if(fromIdx < 0) return { ok:false };
  const [item] = list.splice(fromIdx, 1);
  let toIdx = list.findIndex(e=>e.id===targetId);
  if(toIdx < 0) toIdx = list.length;
  else if(placeAfter) toIdx += 1;
  list.splice(toIdx, 0, item);
  state.environments = list;
  saveEnvironments();
  return { ok:true };
}
function deleteEnvironmentById(id){
  const list = environments();
  if(list.length <= 1) return { ok:false, error:"Can't delete the last remaining environment." };
  const env = list.find(e=>e.id===id);
  if(!env) return { ok:false, error:'Environment not found.' };
  state.environments = list.filter(e=>e.id!==id);
  saveEnvironments();
  if(state.env === id){
    state.env = state.environments[0].id;
    saveEnv();
  }
  logAudit('deleted', 'environment', env.label, `Removed environment "${env.label}"`);
  return { ok:true };
}

/* ---------- Endpoint table support: access levels, named colors, masking ---------- */
const ENV_ACCESS_LEVELS = [
  { id:'admin',      label:'Admin' },
  { id:'user',       label:'User' },
  { id:'readonly',   label:'Read Only' },
  { id:'restricted', label:'Restricted' },
];
function accessMeta(id){ return ENV_ACCESS_LEVELS.find(a=>a.id===id) || ENV_ACCESS_LEVELS[1]; }

const ENV_NAMED_COLORS = [
  { name:'Red',    hex:'#ef5c6e' },
  { name:'Blue',   hex:'#4fa3f7' },
  { name:'Green',  hex:'#35c491' },
  { name:'Yellow', hex:'#e0a83e' },
  { name:'Purple', hex:'#8b7cf6' },
  { name:'Orange', hex:'#f2994a' },
  { name:'Teal',   hex:'#35b8c9' },
  { name:'Gray',   hex:'#8a97b3' },
];
function colorName(hex){
  const found = ENV_NAMED_COLORS.find(c=>c.hex.toLowerCase() === String(hex||'').toLowerCase());
  return found ? found.name : 'Custom';
}
// Only an Admin-role user is ever allowed to reveal a masked value — this mirrors the app's
// existing role system (see ROLES) rather than inventing a second permission model.
function canRevealSensitive(){ return state.authorRole === 'admin'; }
function maskEndpointUrl(url){
  if(!url) return '';
  try{
    const u = new URL(url);
    const parts = u.hostname.split('.');
    let maskedHost;
    if(parts.length >= 3) maskedHost = parts[0] + '.' + '•'.repeat(8) + '.' + parts[parts.length-1];
    else if(parts.length === 2) maskedHost = '•'.repeat(8) + '.' + parts[1];
    else maskedHost = '•'.repeat(8);
    return u.protocol + '//' + maskedHost + (u.pathname && u.pathname !== '/' ? '/••••' : '');
  }catch(e){
    if(url.length <= 6) return '•'.repeat(Math.max(url.length,4));
    return url.slice(0,3) + '•'.repeat(8) + url.slice(-2);
  }
}
// ---------- Generic secret masking (header values: CLIENT-ID, CLIENT-SECRET, Authorization, etc.) ----------
// Distinct from maskEndpointUrl above (which is host/URL-shaped) — this masks arbitrary
// token-like strings while keeping a few characters at each end for recognizability, e.g.
// "GHFJKR*******RHSVJ". Gated by the same Admin-only reveal rule as endpoint URLs.
function isSensitiveHeaderName(name){
  const n = String(name||'').toLowerCase().replace(/[^a-z0-9]/g,'');
  if(!n) return false;
  return /secret|password|passwd|privatekey|apikey|clientid|authorization|token|credential/.test(n);
}
function maskSecretValue(val){
  const s = String(val==null ? '' : val);
  if(!s) return s;
  if(s.length <= 6) return '•'.repeat(Math.max(s.length,4));
  const head = s.slice(0, Math.min(6, Math.ceil(s.length*0.3)));
  const tail = s.slice(-Math.min(5, Math.ceil(s.length*0.25)));
  const midLen = Math.max(5, Math.min(9, s.length - head.length - tail.length));
  return head + '*'.repeat(midLen) + tail;
}

/* ============================================================================
   CENTRALIZED PII MASKING ENGINE
   Single source of truth for "is this field sensitive, and how should its
   example value be shown" — every parameter table (query/path/header/body,
   request AND response) and the PDF/print export route through this, instead
   of each render site rolling its own regex. Previously only header rows were
   masked here (isSensitiveHeaderName/maskSecretValue above); everything else —
   a "mobileNumber" or "aadhaar" body/query param, for instance — rendered its
   example value in plain text. That gap is what this closes.

   Detection = admin-defined rules (from the server, org-wide) ∪ built-in
   field-name rules ∪ value-shape pattern detection ∪ the legacy header-secret
   check. Fails CLOSED: until the org's rule set has loaded from the server,
   the built-ins + patterns still apply, so a slow/broken fetch never means
   raw values get shown by default (spec: never reveal on config failure). */
const PII_BUILTIN_FIELDS = [
  { test:/^(mobile|mobilenumber|mobileno|phone|phonenumber|contactnumber)$/, category:'PII', strategy:'last4' },
  { test:/^(email|emailaddress|emailid)$/, category:'PII', strategy:'email' },
  { test:/^(pan|pannumber)$/, category:'SENSITIVE_PII', strategy:'last2' },
  { test:/^(aadhaar|aadhar|aadhaarnumber|aadharnumber|uidai)$/, category:'SENSITIVE_PII', strategy:'last4' },
  { test:/^(accountnumber|accountno|acctno|bankaccount|bankaccountnumber)$/, category:'FINANCIAL', strategy:'last4' },
  { test:/^(cardnumber|cardno|ccnumber|debitcard|creditcard|creditcardnumber)$/, category:'FINANCIAL', strategy:'last4' },
  { test:/^(customername|fullname|firstname|lastname|contactname|accountholdername)$/, category:'PII', strategy:'partial' },
  { test:/^(dob|dateofbirth|birthdate)$/, category:'PII', strategy:'full' },
  { test:/^(address|addressline1|addressline2|residentialaddress|billingaddress)$/, category:'PII', strategy:'full' },
  { test:/^(passport|passportnumber)$/, category:'SENSITIVE_PII', strategy:'last2' },
  { test:/^(ifsc|ifsccode)$/, category:'FINANCIAL', strategy:'last4' },
  { test:/^(upi|upiid|vpa)$/, category:'FINANCIAL', strategy:'partial' },
];
// Value-shape detection catches sensitive-looking examples even when the field
// name gives no hint at all (spec: "field name + data pattern + rules").
const PII_PATTERNS = [
  { test:v=>/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(v), category:'SENSITIVE_PII', strategy:'last2' },                    // PAN
  { test:v=>/^\d{12}$/.test(v.replace(/\s/g,'')), category:'SENSITIVE_PII', strategy:'last4' },                 // Aadhaar-shaped
  { test:v=>{ const d=v.replace(/\D/g,''); return /^[6-9]\d{9}$/.test(d) && d.length===10; }, category:'PII', strategy:'last4' }, // Indian mobile
  { test:v=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), category:'PII', strategy:'email' },
  { test:v=>/^\d{13,19}$/.test(v.replace(/[\s-]/g,'')), category:'FINANCIAL', strategy:'last4' },               // card/account-shaped
];
const PII_DEFAULT_SETTINGS = { automaticProtection:true, revealTimeoutSeconds:60, environmentPolicy:{}, surfaces:{} };
// Populated by loadPiiConfig() from GET /api/pii. Until that resolves (or if it
// fails), stays at this "protective defaults" shape — see fail-closed note above.
let PII_CONFIG = { rules:[], settings:{ ...PII_DEFAULT_SETTINGS }, loaded:false };

function normFieldKey(name){ return String(name||'').toLowerCase().replace(/[^a-z0-9]/g,''); }

function piiRuleForField(name){
  const raw = String(name||'');
  const key = normFieldKey(raw);
  if(!key) return null;
  const envId = (state.env || 'DEV');
  const custom = (PII_CONFIG.rules||[]).find(r=>{
    if(r.enabled===false) return false;
    if(Array.isArray(r.environments) && r.environments.length && !r.environments.includes(envId)) return false;
    if(r.matchMode==='regex'){ try{ return new RegExp(r.fieldName,'i').test(raw); }catch(e){ return false; } }
    if(r.matchMode==='nested') return normFieldKey(String(r.fieldName||'').split(/[.\[]/).pop()) === key;
    if(r.matchMode==='exact') return r.fieldName === raw;
    return normFieldKey(r.fieldName) === key;
  });
  if(custom) return { category:custom.category, strategy:custom.maskingStrategy, maskChar:custom.maskChar||'*', source:'admin', fieldName:raw };
  const builtin = PII_BUILTIN_FIELDS.find(f=>f.test.test(key));
  if(builtin) return { ...builtin, source:'builtin', fieldName:raw };
  return null;
}
function piiRuleForValue(value){
  const v = String(value==null?'':value).trim();
  if(!v || v.length>40) return null; // long free-text values are never pattern-matched (avoid false positives)
  const hit = PII_PATTERNS.find(p=>{ try{ return p.test(v); }catch(e){ return false; } });
  return hit ? { ...hit, source:'pattern' } : null;
}
// Resolves the rule for a name+value pair, folding in the pre-existing
// header-secret keyword check so callers only need one function.
function piiRuleFor(name, value){
  return piiRuleForField(name) || piiRuleForValue(value) ||
    (isSensitiveHeaderName(name) ? { category:'AUTHENTICATION_SECRET', strategy:'secret', source:'legacy-header' } : null);
}
function isSensitiveField(name, value){ return !!piiRuleFor(name, value); }
function maskByStrategy(value, rule){
  const s = String(value==null?'':value);
  if(!s) return s;
  const mc = (rule && rule.maskChar) || '*';
  switch((rule && rule.strategy) || 'partial'){
    case 'full': return mc.repeat(Math.min(s.length,10));
    case 'last4': { const n=Math.min(4,s.length-1); return n<=0 ? mc.repeat(s.length) : mc.repeat(Math.max(4,s.length-n))+s.slice(-n); }
    case 'last2': { const n=Math.min(2,s.length-1); return n<=0 ? mc.repeat(s.length) : mc.repeat(Math.max(4,s.length-n))+s.slice(-n); }
    case 'first2last2': return s.length<=4 ? mc.repeat(s.length) : s.slice(0,2)+mc.repeat(Math.max(4,s.length-4))+s.slice(-2);
    case 'email': { const at=s.indexOf('@'); if(at<1) return maskSecretValue(s); return s[0]+mc.repeat(6)+s.slice(at); }
    case 'secret': return maskSecretValue(s);
    case 'partial': default: return s.length<=4 ? mc.repeat(s.length) : s[0]+mc.repeat(Math.max(4,s.length-2))+s.slice(-1);
  }
}
// The one function every render path should call for a scalar example value.
function displayValueFor(name, value){
  if(value==null || value==='') return value;
  const rule = piiRuleFor(name, value);
  if(!rule) return value;
  return sensitiveRevealed() ? value : maskByStrategy(value, rule);
}
// Recursively masks a JSON example (request/response body) on a clone —
// never mutates the author's real stored example — honoring the same
// field rules at any nesting depth, including arrays.
function maskJsonExampleDeep(obj){
  if(sensitiveRevealed()) return obj;
  const walk = (node)=>{
    if(Array.isArray(node)) return node.map(walk);
    if(node && typeof node === 'object'){
      const out = {};
      Object.keys(node).forEach(k=>{
        const v = node[k];
        out[k] = (v && typeof v === 'object') ? walk(v) : displayValueFor(k, v);
      });
      return out;
    }
    return node;
  };
  try{ return walk(JSON.parse(JSON.stringify(obj))); }catch(e){ return obj; }
}
// Convenience wrapper for the many places a body example is stored/displayed
// as a raw JSON *string* (the doc viewer's JSON tabs, the render view, the PDF
// export). Parses, masks recursively, re-stringifies with the same 2-space
// indent the app already uses everywhere else. Non-JSON bodies (can't safely
// find field names in free text) are returned unchanged — that's the one
// known gap, called out in the security summary rather than silently assumed away.
function maskedJsonString(rawStr){
  if(rawStr == null || rawStr === '') return rawStr;
  if(sensitiveRevealed()) return rawStr;
  const parsed = tryParseJson(rawStr);
  if(!parsed.ok) return rawStr;
  try{ return JSON.stringify(maskJsonExampleDeep(parsed.value), null, 2); }catch(e){ return rawStr; }
}
async function loadPiiConfig(){
  try{
    const res = await fetch('/api/pii', { credentials:'same-origin' });
    if(!res.ok) throw new Error('status '+res.status);
    const data = await res.json();
    PII_CONFIG = { rules: Array.isArray(data.rules)?data.rules:[], settings: { ...PII_DEFAULT_SETTINGS, ...(data.settings||{}) }, loaded:true };
  }catch(e){
    console.error('PII config fetch failed — continuing with built-in rules only (fail closed).', e);
    PII_CONFIG = { rules:[], settings:{ ...PII_DEFAULT_SETTINGS }, loaded:false };
  }
}
async function piiApi(method, path, body){
  const res = await fetch('/api/pii'+path, {
    method, credentials:'same-origin',
    headers: body ? { 'Content-Type':'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.error || ('Request failed ('+res.status+')'));
  return data;
}

// One env-variable token per environment, e.g. "{{SIT-DNS}}" — shown in place of the
// resolved host wherever a request URL is displayed, so the real host never appears in
// the UI unless the viewer has explicitly revealed it (Admin role only).
function envVarToken(envId){ return `{{${envId}-DNS}}`; }
function sensitiveRevealed(){ return canRevealSensitive() && !!state.sensitiveRevealed; }
// SECURITY (Finding 4.2): the server now masks sensitive example values
// unconditionally in GET /api/workspace — `state.projects` normally only
// ever holds masked data. Revealing calls the audited, Admin-only
// POST /api/pii/reveal/:projectId and swaps the real values into the
// currently-viewed project only, for as long as the reveal stays on;
// toggling off (or the auto-remask timer) restores the masked copy this
// module cached before overwriting it — real values are never left sitting
// in `state` longer than the reveal is actually active.
let _piiRevealBackup = null; // { projectId, endpoints: <masked endpoints this project had before reveal> }
async function fetchRevealedEndpoints(reason){
  const proj = currentProjectForEnvContext();
  if(!proj){ toast('Open a project or endpoint to reveal its sensitive values.'); return false; }
  try{
    const res = await fetch(`/api/pii/reveal/${encodeURIComponent(proj.id)}`, {
      method:'POST', credentials:'same-origin',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ environmentId: state.env, reason }),
    });
    const data = await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(data.error || ('Request failed ('+res.status+')'));
    _piiRevealBackup = { projectId: proj.id, endpoints: state.projects[proj.id].endpoints };
    state.projects[proj.id] = { ...state.projects[proj.id], endpoints: data.endpoints };
    return true;
  }catch(e){
    console.error('PII reveal failed', e);
    toast(e.message || 'Could not reveal sensitive values.');
    return false;
  }
}
function restoreMaskedEndpoints(){
  if(!_piiRevealBackup) return;
  const proj = state.projects[_piiRevealBackup.projectId];
  if(proj) state.projects[_piiRevealBackup.projectId] = { ...proj, endpoints: _piiRevealBackup.endpoints };
  _piiRevealBackup = null;
}
function toggleSensitiveRevealed(){
  if(!canRevealSensitive()){ toast('Only the Admin role can reveal sensitive values'); return; }
  if(state.sensitiveRevealed){
    state.sensitiveRevealed = false;
    if(_piiRemaskTimer){ clearTimeout(_piiRemaskTimer); _piiRemaskTimer = null; }
    restoreMaskedEndpoints();
    renderMain(); renderRail();
    return;
  }
  requestSensitiveReveal('Endpoint doc — sensitive values', async (reason)=>{
    const ok = await fetchRevealedEndpoints(reason);
    if(!ok) return;
    state.sensitiveRevealed = true;
    renderMain(); renderRail();
  }, ()=>{
    state.sensitiveRevealed = false;
    restoreMaskedEndpoints();
    renderMain(); renderRail();
  });
}
const ENV_COLOR_PALETTE = ['#8a97b3','#35b8c9','#8b7cf6','#e0a83e','#ef5c6e','#c4529a','#4fb477','#5c8fef','#d97fb0','#7fae4f'];
function hexToRgb(hex){
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex||'');
  return m ? { r:parseInt(m[1],16), g:parseInt(m[2],16), b:parseInt(m[3],16) } : { r:138, g:151, b:179 };
}
function envAccentColor(envId){
  const env = environments().find(e=>e.id===envId);
  return (env && env.color) || '#8a97b3';
}
function envBgColor(envId){
  const { r, g, b } = hexToRgb(envAccentColor(envId));
  const alpha = state.theme === 'light' ? 0.10 : 0.16;
  return `rgba(${r},${g},${b},${alpha})`;
}

// ---------- Audit log: who changed what, when ----------
// Written server-side only. logAudit()/logSecurityEvent() update the local
// in-memory list optimistically (so the UI reflects the action instantly)
// and POST the event to /api/audit/events, which derives actor identity,
// timestamp, IP, and user-agent from the authenticated session — never from
// this payload. See server/auditService.js.
function postAuditEvent(fields){
  fetch('/api/audit/events', {
    method:'POST', credentials:'same-origin',
    headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify(fields),
  }).catch(e=>console.error('Audit log write failed', e));
}
// action: 'created' | 'updated' | 'deleted' | 'imported' (existing entity-CRUD vocabulary, unchanged)
// entityType: 'endpoint' | 'project' | 'environment' | 'profile' | 'document' | 'workspace'
function logAudit(action, entityType, entityName, details, projectName){
  const entry = {
    id: uid(), ts: new Date().toISOString(),
    actor: (state.authorName || '').trim() || 'Unknown',
    action, entityType,
    entityName: entityName || '', projectName: projectName || '', details: details || '',
    role: state.authorRole || '', severity: 'info', result: 'success',
  };
  state.auditLog = state.auditLog || [];
  state.auditLog.unshift(entry);
  if(state.auditLog.length > AUDIT_LOG_CAP) state.auditLog.length = AUDIT_LOG_CAP;
  postAuditEvent({ action, entityType, entityName, projectName, details });
}
// Security-specific events (spec's uppercase vocabulary: PII_REVEAL, ADMIN_SETTING_CHANGED,
// PII_MASK_RULE_CREATED/UPDATED/DELETED, ...). Same table, same server-side identity — just
// a distinct helper so call sites read clearly and can pass severity/environment/metadata.
// NEVER pass a raw sensitive value in `metadata` — field names and reasons only.
function logSecurityEvent(action, { entityType, entityName, details, environment, severity, metadata } = {}){
  const entry = {
    id: uid(), ts: new Date().toISOString(),
    actor: (state.authorName || '').trim() || 'Unknown',
    action, entityType: entityType || 'security',
    entityName: entityName || '', projectName: '', details: details || '',
    role: state.authorRole || '', severity: severity || 'warning', result: 'success',
  };
  state.auditLog = state.auditLog || [];
  state.auditLog.unshift(entry);
  if(state.auditLog.length > AUDIT_LOG_CAP) state.auditLog.length = AUDIT_LOG_CAP;
  postAuditEvent({ action, entityType: entityType || 'security', entityName, details, environment, severity, metadata });
}

// ---------- Request flow direction ----------
// Used to be a picker over a fixed set of presets plus an org-wide "add custom
// direction" builder (FLOW_DIRECTION_PRESETS / customFlowDirections below) —
// that was a lot of indirection for what's really just a label next to a
// one-way/two-way toggle, and the only way to get your own wording in there
// was a separate multi-step "add custom" flow. Now a project just stores the
// pattern ('1-way'/'2-way', which the request-flow SVG needs to know how to
// draw arrows) plus a free-text label directly — see requestFlowDirection /
// requestFlowLabel in resolveFlowDirection() below.
const CUSTOM_FLOW_DIRECTIONS_KEY = 'apiStudio.customFlowDirections'; // one-time localStorage migration key only — see migrateLocalStorageIfNeeded()
const FLOW_DIRECTION_DEFAULT_LABELS = {
  '1-way': 'One-way — request only (Client → Gateway → Flow → Downstream)',
  '2-way': 'Two-way — request and response (Client ⇄ Gateway ⇄ Flow ⇄ Downstream)',
};
function resolveFlowDirection(proj){
  const pattern = (proj && proj.requestFlowDirection === '2-way') ? '2-way' : '1-way';
  const customLabel = proj && typeof proj.requestFlowLabel === 'string' ? proj.requestFlowLabel.trim() : '';
  if(customLabel) return { pattern, label: customLabel };
  // Back-compat: projects saved before this change may still have
  // requestFlowDirection pointing at an old custom preset's id (e.g.
  // "custom_abc123") instead of a bare pattern — fall back to that preset's
  // own label/pattern once, so existing projects don't silently lose their
  // wording the first time they're opened under the new model.
  const legacyCustom = (state.customFlowDirections || []).find(d => d.id === (proj && proj.requestFlowDirection));
  if(legacyCustom) return { pattern: legacyCustom.pattern === '2-way' ? '2-way' : '1-way', label: legacyCustom.label };
  return { pattern, label: FLOW_DIRECTION_DEFAULT_LABELS[pattern] };
}

// ---------- Request flow STAGES (the actual diagram content) ----------
// Historically the "Request flow" diagram's four boxes (Client → Gateway →
// Flow → Downstream) were hardcoded in every renderer — the only thing a
// project could actually customise was requestFlowLabel above, which is
// just the small caption text next to the section title, not the diagram
// itself. That's confusing: typing a custom flow into that one text field
// looks like it should redraw the boxes, and it silently doesn't. This is
// the real, editable stage list: proj.requestFlowStages, an array of
// { k: 'Role label', systems: ['System A', 'System B', ...], icon, mid }.
// `systems` being an array (not a single string) is what lets a stage
// represent more than one source or target system — see requestFlowSvg's
// handling of multi-line boxes.
// Projects created or edited before this existed have an empty/missing
// requestFlowStages, so this falls back to exactly the old hardcoded
// four-stage template in that case — nothing changes visually until someone
// actually edits the stages in Project settings.
function resolveFlowStages(proj, env){
  const custom = Array.isArray(proj && proj.requestFlowStages) ? proj.requestFlowStages.filter(s => s && (s.k || (s.systems || []).length)) : [];
  if(custom.length){
    return custom.map(s => ({
      k: s.k || 'Stage',
      systems: (Array.isArray(s.systems) && s.systems.length) ? s.systems : ['—'],
      icon: s.icon || 'custom',
      mid: !!s.mid,
    }));
  }
  return [
    { k:'Client', systems:['Consumer app'], icon:'client' },
    { k:`${env.label} · MuleSoft`, systems:['API Gateway'], icon:'gateway', mid:true },
    { k:'Flow', systems:[proj.name], icon:'flow' },
    { k:'Downstream', systems:['Backend system'], icon:'downstream' },
  ];
}


// ---------- Request FLOWS (one or more diagrams) ----------
// A project can describe several separate exchanges instead of one continuous
// chain — e.g. "get token" (about every 30 min), "business request" (every
// call), "get third-party token" (only when its cache is empty). Each is a
// flow: proj.requestFlows = [{ name, when, direction, stages:[{ k, systems,
// icon, mid, next, back }] }] — `next` / `back` label the arrows leaving a
// stage toward the following one (forward / return). Edited through the shared
// builder in public/js/flow-editor.js.
//
// Returns { custom, flows:[{ name, when, pattern, caption, stages }] }.
// `custom` is false when the project has no requestFlows: it then resolves to
// ONE flow built from the legacy requestFlowStages / requestFlowDirection /
// requestFlowLabel (or the default four-box template), so projects saved
// before multi-flow existed render exactly as they did.
function resolveRequestFlows(proj, env){
  const raw = Array.isArray(proj && proj.requestFlows) ? proj.requestFlows : [];
  const flows = raw.map(f => {
    const stages = (Array.isArray(f && f.stages) ? f.stages : [])
      .filter(s => s && (s.k || (s.systems || []).length))
      .map(s => ({
        k: s.k || 'Stage',
        systems: (Array.isArray(s.systems) && s.systems.length) ? s.systems : ['—'],
        icon: s.icon || 'custom',
        mid: !!s.mid,
        next: typeof s.next === 'string' ? s.next.trim() : '',
        back: typeof s.back === 'string' ? s.back.trim() : '',
      }));
    return {
      name: typeof f.name === 'string' ? f.name.trim() : '',
      when: typeof f.when === 'string' ? f.when.trim() : '',
      pattern: f.direction === '2-way' ? '2-way' : '1-way',
      caption: '',
      stages,
    };
  }).filter(f => f.stages.length);
  if(flows.length) return { custom: true, flows };
  const preset = resolveFlowDirection(proj);
  return {
    custom: false,
    flows: [{ name: '', when: '', pattern: preset.pattern, caption: preset.label, stages: resolveFlowStages(proj, env) }],
  };
}

// Roles are a local UI preference (this tool has no login/backend), but they still
// gate what the interface offers: which environments show up in the switcher, and
// whether create/edit/delete affordances render at all.
const ROLES = [
  { id:'admin',  label:'Admin',  seesAll:true,  canEdit:true,
    desc:'Full access to every environment, and can create, edit, or delete endpoints.' },
  { id:'Developer', label:'Developer', seesAll:false, canEdit:true,
    desc:'Can create and edit endpoints, scoped to non-restricted environments.' },
  { id:'viewer', label:'Viewer', seesAll:false, canEdit:false,
    desc:"Read-only — can browse and try endpoints, but can't create, edit, or delete." },
  { id:'custom', label:'Custom', seesAll:false, canEdit:false,
    desc:'Pick exactly which environments they can reach, and whether they can edit.' },
];
function roleMeta(id){ return ROLES.find(r=>r.id===id) || ROLES[1]; }

// The backend stores roles as 'admin' | 'editor' | 'viewer' | 'custom' (matches
// the DB constraint); the UI's local role-preview system predates real accounts
// and uses 'admin' | 'Developer' | 'viewer' | 'custom'. These convert between
// the two so the Team members table can reuse the existing role-pill styling
// and ROLES list ('custom' passes through unchanged on both sides).
function dbRoleToLocalId(dbRole){ return dbRole === 'editor' ? 'Developer' : dbRole; }
function localIdToDbRole(localId){ return localId === 'Developer' ? 'editor' : localId; }

// 'custom' has no fixed permission set — it's per-user, carried on the signed-in
// user's own AUTH_USER.customPermissions — so it's special-cased ahead of the
// generic ROLES lookup rather than living in roleMeta().
function canEdit(){
  if(state.authorRole === 'custom'){
    return !!(AUTH_USER && AUTH_USER.role === 'custom' && AUTH_USER.customPermissions && AUTH_USER.customPermissions.canEdit);
  }
  return roleMeta(state.authorRole).canEdit;
}
// Project settings (name, lifecycle, auth, environments, etc.) are admin-only to edit —
// Developer/Viewer/Custom roles can still browse endpoints and try requests, but the
// project-level configuration surface (and the environment base URLs inside it) is
// gated to Admin the same way sensitive header/secret values already are.
function isAdmin(){ return state.authorRole === 'admin'; }
// Whether the signed-in user owns at least one project in this workspace —
// used to decide whether Security (specifically its Documentation Access
// tab) should be reachable at all for a non-Admin. See requireAdminOrProjectOwner
// in docAccess.js for the server-side rule this mirrors.
function ownsAnyProject(){
  return Object.values(state.projects || {}).some(p => p && p._owned);
}
// Which environments a given role may even see/switch to in the top-right
// switcher. Admins always see everything. Below Admin, this used to just be
// "every env that isn't hard-flagged restricted" — meaning Production/DR
// were locked but Dev/SIT/UAT/Staging were open to any Viewer regardless of
// what an Admin had actually granted them. That's now closed: for every
// non-admin, non-custom role, the switcher is driven by the exact same
// per-user grant matrix an Admin maintains under Security ▸ Live Mode
// Access (state.liveModeEnvs, loaded once at boot from
// /api/live-mode/my-access) — so a Viewer can only browse into an
// environment an Admin has explicitly ticked for them, full stop. A
// `restricted` env (Production/DR) still can't be granted this way; that
// flag is a hard ceiling no grant can lift.
function roleAllowedEnvs(roleId){
  if(roleId === 'custom'){
    if(AUTH_USER && AUTH_USER.role === 'custom' && AUTH_USER.customPermissions){
      const allowed = AUTH_USER.customPermissions.envs || [];
      return environments().filter(e=>allowed.includes(e.id));
    }
    return [];
  }
  const role = roleMeta(roleId);
  if(role.seesAll) return environments();
  const granted = Array.isArray(state.liveModeEnvs) ? state.liveModeEnvs : [];
  return environments().filter(e=>!e.restricted && granted.includes(e.id));
}
function roleAllowsEnv(envId){ return roleAllowedEnvs(state.authorRole).some(e=>e.id===envId); }

const LANGS = [
  { id:'curl',    label:'cURL' },
  { id:'swagger', label:'Swagger (.yaml)' },
];

const LIFECYCLE_STAGES = ['DRAFT','DESIGN','DEVELOPMENT','SIT','UAT','PRE-PROD','PRODUCTION','DEPRECATED','RETIRED'];

const ERROR_CATALOG = [
  { code:400, name:'INVALID_REQUEST', desc:'The request is malformed — missing required fields, bad JSON, or invalid parameter types.' },
  { code:401, name:'UNAUTHORIZED', desc:'No valid credentials were supplied, or the token has expired.' },
  { code:403, name:'FORBIDDEN', desc:'Credentials are valid but the caller lacks permission for this resource or action.' },
  { code:404, name:'RESOURCE_NOT_FOUND', desc:'The requested resource, or a resource referenced by an identifier in the path, does not exist.' },
  { code:409, name:'DUPLICATE_RESOURCE', desc:'The request conflicts with the current state of the resource — e.g. a resource with that key already exists.' },
  { code:422, name:'VALIDATION_ERROR', desc:'The request is well-formed but fails business or schema validation rules.' },
  { code:429, name:'RATE_LIMITED', desc:'Too many requests in a given window — back off and retry after the interval in the response.' },
  { code:500, name:'INTERNAL_ERROR', desc:'An unexpected error occurred in the service itself.' },
  { code:502, name:'DOWNSTREAM_ERROR', desc:'A downstream/backend system returned an invalid or unexpected response.' },
  { code:503, name:'SERVICE_UNAVAILABLE', desc:'The service is temporarily unable to handle the request — maintenance, overload, or a dependency outage.' },
];
