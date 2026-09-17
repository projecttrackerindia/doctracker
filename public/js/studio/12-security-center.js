/* ==================== SECTION:SECURITY CENTER (Admin only) ====================
   Three tabs: a computed summary card, admin-managed PII/masking rules, and a
   REAL runtime scan of this browser's own storage — not a hardcoded "all
   clear" dashboard. See scanClientStorage() below: it actually enumerates
   localStorage/sessionStorage/cookies/IndexedDB/Cache API at render time. */

// Known-good keys this app itself writes, with an honest description of what
// each holds — anything NOT in this list gets flagged for investigation
// (and anything with a token/secret/password/session-shaped name gets flagged
// CRITICAL automatically, whether we recognize it or not).
const STORAGE_KEY_KNOWLEDGE = {
  apiStudio_theme: { purpose:'UI theme preference (light/dark) — not app data', classification:'PUBLIC', risk:'Low' },
  apiStudio_env: { purpose:'Last-selected environment tab — not app data', classification:'INTERNAL', risk:'Low' },
  apiStudio_authorName: { purpose:'Legacy pre-login display name (ignored once signed in)', classification:'INTERNAL', risk:'Low' },
  apiStudio_authorRole: { purpose:'Legacy pre-login display role (ignored once signed in — the real role always comes from the server session)', classification:'INTERNAL', risk:'Low' },
  apiStudio_profileColor: { purpose:'Avatar color preference — not app data', classification:'PUBLIC', risk:'Low' },
  apiStudio_sidebarCollapsed: { purpose:'Sidebar collapsed/expanded UI state', classification:'PUBLIC', risk:'Low' },
  apiStudio_migratedToServer_v1: { purpose:'One-time flag: has this browser\'s old local data been migrated to Postgres yet', classification:'INTERNAL', risk:'Low' },
  apiStudio_workspace_v1: { purpose:'Pre-Postgres workspace cache — should be empty post-migration; if present, migration may not have completed for this browser', classification:'CONFIDENTIAL', risk:'Medium' },
  apiStudio_auditLog: { purpose:'Pre-Postgres audit log cache — should be empty post-migration (audit is now server-authoritative)', classification:'CONFIDENTIAL', risk:'Medium' },
};
function classifyStorageKey(mechanism, key, rawValue){
  const known = STORAGE_KEY_KNOWLEDGE[key];
  const looksSensitive = !known && /token|secret|password|passwd|auth|session|credential|apikey/i.test(key||'');
  let sizeBytes = null;
  try{ if(rawValue!=null) sizeBytes = new Blob([String(rawValue)]).size; }catch(e){}
  return {
    mechanism, key,
    purpose: known ? known.purpose : (looksSensitive ? 'Unrecognized key with a sensitive-looking name — investigate' : 'Unrecognized key — not written by this app\'s known code paths'),
    classification: known ? known.classification : (looksSensitive ? 'CRITICAL' : 'UNKNOWN'),
    risk: known ? known.risk : (looksSensitive ? 'Critical' : 'Unknown'),
    sizeBytes,
  };
}
// Actually enumerates this browser's storage right now — nothing here is
// pre-computed or assumed. httpOnly cookies (like the real session cookie)
// are correctly invisible to document.cookie, which is the desired/secure
// outcome, not a scan gap.
async function scanClientStorage(){
  const rows = [];
  try{ for(let i=0;i<localStorage.length;i++){ const k=localStorage.key(i); rows.push(classifyStorageKey('localStorage', k, localStorage.getItem(k))); } }catch(e){}
  try{ for(let i=0;i<sessionStorage.length;i++){ const k=sessionStorage.key(i); rows.push(classifyStorageKey('sessionStorage', k, sessionStorage.getItem(k))); } }catch(e){}
  try{
    document.cookie.split(';').map(s=>s.trim()).filter(Boolean).forEach(pair=>{
      const eq = pair.indexOf('=');
      const k = eq>-1 ? pair.slice(0,eq) : pair;
      rows.push(classifyStorageKey('Cookie', k, eq>-1 ? pair.slice(eq+1) : ''));
    });
  }catch(e){}
  try{ if(window.indexedDB && indexedDB.databases){ (await indexedDB.databases()).forEach(d=> rows.push(classifyStorageKey('IndexedDB', d.name || '(unnamed)', null))); } }catch(e){}
  try{ if(window.caches && caches.keys){ (await caches.keys()).forEach(n=> rows.push(classifyStorageKey('Cache API', n, null))); } }catch(e){}
  return rows;
}

const PII_CATEGORY_OPTIONS = ['PUBLIC','INTERNAL','CONFIDENTIAL','PII','SENSITIVE_PII','FINANCIAL','AUTHENTICATION_SECRET'];
const PII_STRATEGY_OPTIONS = [
  { id:'partial', label:'Partial (first + last char)' }, { id:'last4', label:'Keep last 4' },
  { id:'last2', label:'Keep last 2' }, { id:'first2last2', label:'Keep first 2 + last 2' },
  { id:'email', label:'Email (first char + domain)' }, { id:'full', label:'Full mask' }, { id:'secret', label:'Secret token style' },
];
const PII_SURFACE_OPTIONS = [
  { id:'params', label:'Parameter tables (query/path/body)' }, { id:'headers', label:'Header examples' },
  { id:'body', label:'JSON body examples & code samples' }, { id:'pdfExport', label:'PDF export' },
];

function renderSecurityCenter(main){
  // Defensive clamp: a non-Admin only ever gets the Documentation Access tab
  // (see the tabs filter below) — if state.securityTab was left pointing at
  // something else (e.g. an Admin's session state carried over), don't let
  // Admin-only tab content render for them.
  if(!isAdmin()) state.securityTab = 'docaccess';
  const tab = state.securityTab || 'summary';
  const settings = PII_CONFIG.settings || {};
  const lastScan = state._lastStorageScan;
  const riskyCount = lastScan ? lastScan.filter(r=>r.risk==='Critical'||r.risk==='High').length : null;
  const protectionOn = settings.automaticProtection !== false;
  const shieldState = !protectionOn ? 'off' : (riskyCount ? 'risk' : 'protected');
  const shieldColorVar = shieldState==='off' ? '--put' : shieldState==='risk' ? '--delete' : '--post';
  const shieldBgVar = shieldState==='off' ? '--put-bg' : shieldState==='risk' ? '--delete-bg' : '--post-bg';
  const shieldGlyph = shieldState==='protected'
    ? '<path d="M9 12l2 2 4-4"></path>'
    : shieldState==='risk'
      ? '<path d="M12 8v4.5"></path><circle cx="12" cy="15.5" r="0.9" fill="currentColor" stroke="none"></circle>'
      : '<path d="M9 9l6 6M15 9l-6 6"></path>';
  const activeRules = (PII_CONFIG.rules||[]).filter(r=>r.enabled!==false).length;
  // A project owner who isn't an Admin can only reach here at all to review
  // documentation-access requests for their own project (see requireAdminOrProjectOwner
  // server-side) — every other tab (PII rules, encryption, storage, Live Mode,
  // AI Studio) is genuinely org-wide Admin configuration, not something owning
  // one project should unlock.
  const allTabs = [
    { id:'summary', label:'Summary', icon:SEC_TAB_ICON.summary },
    { id:'pii', label:'PII & Data Masking', icon:SEC_TAB_ICON.pii, count:activeRules },
    { id:'encryption', label:'Encryption Keys', icon:SEC_TAB_ICON.encryption },
    { id:'storage', label:'Data Storage', icon:SEC_TAB_ICON.storage, count:(riskyCount||null) },
    { id:'livemode', label:'Live Mode Access', icon:SEC_TAB_ICON.livemode },
    { id:'docaccess', label:'Documentation Access', icon:SEC_TAB_ICON.docaccess },
    { id:'ai', label:'AI Studio', icon:SEC_TAB_ICON.ai },
  ];
  const tabs = isAdmin() ? allTabs : allTabs.filter(t=>t.id==='docaccess');

  main.innerHTML = `
    <div class="crumb">Security</div>
    <div class="sec-hero" style="--sec-shield-color:var(${shieldColorVar});--sec-shield-bg:var(${shieldBgVar});--sec-glow-bg:var(${shieldBgVar});">
      <div class="sec-shield${shieldState==='protected'?' live':''}" style="--sec-pulse-color:var(${shieldBgVar});">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2l8 4v6c0 5-3.4 8.4-8 10-4.6-1.6-8-5-8-10V6l8-4z"></path>${shieldGlyph}
        </svg>
      </div>
      <div class="sec-hero-copy">
        <h1>Security &amp; data protection</h1>
        <p>PII masking rules, authorized-reveal auditing, and what this app actually persists in your browser.</p>
      </div>
      <div class="sec-hero-stat">
        <div class="n">${activeRules}</div>
        <div class="l">active masking rule${activeRules===1?'':'s'}</div>
      </div>
    </div>
    <div class="sec-tabs" id="secTabs">
      <div class="sec-tab-indicator"></div>
      ${tabs.map(t=>`<button type="button" class="sec-tab ${t.id===tab?'active':''}" data-sec-tab="${t.id}">${t.icon}<span>${t.label}</span>${t.count!=null?`<span class="sec-tab-count">${t.count}</span>`:''}</button>`).join('')}
    </div>
    <div id="secTabBody"></div>
  `;
  const tabsEl = document.getElementById('secTabs');
  main.querySelectorAll('[data-sec-tab]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      if(btn.getAttribute('data-sec-tab') === state.securityTab) return;
      if(state.securityTab === 'livemode' && typeof _liveModeGrantsDirty !== 'undefined' && _liveModeGrantsDirty){
        const ok = await openConfirmModal({ title:'Discard unsaved changes?', message:"You've checked or unchecked access boxes here that haven't been saved yet. Leaving this tab now will lose them.", confirmLabel:'Discard changes' });
        if(!ok) return;
        _liveModeGrantsDirty = false;
      }
      state.securityTab = btn.getAttribute('data-sec-tab');
      renderSecurityCenter(main);
    });
  });
  // Position the sliding indicator from the ACTUAL rendered width of the
  // active button rather than an assumed equal 1/N split — labels of very
  // different lengths ("Summary" vs "PII & Data Masking") otherwise cause
  // the indicator (and the highlighted-text region) to miss the button's
  // real bounds, clipping/overlapping the first or last character.
  positionSecTabIndicator(tabsEl);
  if(!window._secTabsResizeBound){
    window._secTabsResizeBound = true;
    window.addEventListener('resize', ()=>{
      const el = document.getElementById('secTabs');
      if(el) positionSecTabIndicator(el, true);
    });
  }
  const body = document.getElementById('secTabBody');
  if(tab === 'summary') renderSecuritySummaryTab(body);
  else if(tab === 'pii') renderPiiRulesTab(body);
  else if(tab === 'encryption') renderEncryptionKeysTab(body);
  else if(tab === 'livemode') renderLiveModeAccessTab(body);
  else if(tab === 'docaccess') renderDocAccessTab(body);
  else if(tab === 'ai') renderAiSettingsTab(body);
  else renderStorageScanTab(body);
}
function positionSecTabIndicator(tabsEl, noAnim){
  if(!tabsEl) return;
  const active = tabsEl.querySelector('.sec-tab.active');
  const indicator = tabsEl.querySelector('.sec-tab-indicator');
  if(!active || !indicator) return;
  if(noAnim) tabsEl.classList.add('no-anim');
  indicator.style.width = active.offsetWidth + 'px';
  indicator.style.transform = `translateX(${active.offsetLeft}px)`;
  if(noAnim) requestAnimationFrame(()=> tabsEl.classList.remove('no-anim'));
}
const SEC_TAB_ICON = {
  summary: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l8 4v6c0 5-3.4 8.4-8 10-4.6-1.6-8-5-8-10V6l8-4z"></path></svg>',
  pii: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-11-7-11-7a19.9 19.9 0 0 1 4.22-5.06M9.9 4.24A10.4 10.4 0 0 1 12 5c7 0 11 7 11 7a19.86 19.86 0 0 1-2.34 3.36"></path><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>',
  storage: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="8" ry="3"></ellipse><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"></path><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"></path></svg>',
  encryption: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>',
  livemode: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8"></path></svg>',
  docaccess: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="11" rx="2"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3"></path></svg>',
  ai: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z"></path><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z"></path></svg>',
};

function renderSecuritySummaryTab(body){
  const settings = PII_CONFIG.settings || {};
  const lastScan = state._lastStorageScan;
  const riskyCount = lastScan ? lastScan.filter(r=>r.risk==='Critical' || r.risk==='High').length : null;
  const protectionOn = settings.automaticProtection !== false;
  const policy = settings.environmentPolicy || {};
  const policyLabel = { strict:'Strict', mask:'Masked', configurable:'Configurable' };

  const envStrip = environments().map(e=>{
    const lv = (policy[e.id] || 'mask');
    return `<span class="sec-env-pill" style="--se-bg:${envBgColor(e.id)};--se-color:${envAccentColor(e.id)};">${e.label}<span class="lv">${policyLabel[lv]||lv}</span></span>`;
  }).join('');

  body.innerHTML = `
    <div class="sec-grid">
      <div class="sec-card" style="--sc-accent:var(${protectionOn?'--post':'--put'});">
        <div class="k">PII protection</div>
        <div class="v"><span class="dot"></span>${protectionOn?'Enabled':'Disabled'}</div>
        <div class="s">Automatic field-name &amp; pattern detection is ${protectionOn?'on':'off'} — admin rules ${protectionOn?'still apply either way':'are the only active check'}.</div>
      </div>
      <div class="sec-card" style="--sc-accent:var(--accent);">
        <div class="k">Audit trail</div>
        <div class="v"><span class="dot"></span>PostgreSQL</div>
        <div class="s">Append-only, server-authoritative — identity and timestamps come from the session, never the browser.</div>
      </div>
      <div class="sec-card" style="--sc-accent:var(${riskyCount===null?'--text-faint':riskyCount===0?'--post':'--delete'});">
        <div class="k">Browser storage</div>
        <div class="v"><span class="dot"></span>${riskyCount===null ? 'Not scanned' : riskyCount+' risk'+(riskyCount===1?'':'s')}</div>
        <div class="s">${state._lastStorageScanAt ? 'Last scan: '+new Date(state._lastStorageScanAt).toLocaleString() : "Live scan of this browser's own storage."} <button type="button" class="linklike" id="btnRunScanFromSummary">Run scan</button></div>
      </div>
    </div>
    <div class="section">
      <div class="section-title">Environment masking policy</div>
      <div class="sec-env-strip">${envStrip}</div>
    </div>
    <div class="section" style="max-width:520px;">
      <div class="section-title">PII reveal</div>
      <div class="sec-card" style="--sc-accent:var(--accent);">
        <div class="v" style="font-size:14px;"><span class="dot"></span>Reason required, auto-remasks after ${settings.revealTimeoutSeconds||60}s</div>
        <div class="s">Every reveal is Admin-only and recorded as a <span class="sec-field-name" style="font-size:11px;">PII_REVEAL</span> audit event with the reason given.</div>
      </div>
    </div>`;
  document.getElementById('btnRunScanFromSummary').addEventListener('click', async (e)=>{
    e.currentTarget.textContent = 'Scanning…';
    state._lastStorageScan = await scanClientStorage();
    state._lastStorageScanAt = new Date().toISOString();
    renderSecuritySummaryTab(body);
  });
}

function renderStorageScanTab(body){
  body.innerHTML = `<div class="section"><div class="section-title">Data storage inventory</div>
    <div style="font-size:12px;color:var(--text-faint);margin-bottom:14px;max-width:64ch;">Scans this browser's actual localStorage, sessionStorage, cookies, IndexedDB, and Cache API right now — this is a live read, not a hardcoded list.</div>
    <div id="storageScanBody">
      <button type="button" class="primary sec-scan-btn" id="btnRunScan">
        <svg class="radar" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9" opacity=".35"></circle><path d="M12 12L12 4"></path></svg>
        Run security scan
      </button>
    </div>
  </div>`;
  const scanBody = document.getElementById('storageScanBody');
  const riskColor = r=> r==='Critical'?'var(--delete)': r==='High'?'var(--put)': r==='Medium'?'#e0a83e': r==='Unknown'?'var(--text-faint)':'var(--post)';
  const renderRows = (rows)=>{
    const counts = rows.reduce((a,r)=>{ a[r.risk]=(a[r.risk]||0)+1; return a; }, {});
    const summary = ['Critical','High','Medium','Low','Unknown'].filter(k=>counts[k]).map(k=>
      `<span class="sec-status-dot"><span class="dot" style="background:${riskColor(k)};"></span>${counts[k]} ${k}</span>`
    ).join('');
    scanBody.innerHTML = !rows.length ? `<div class="empty-field">No client-side storage detected.</div>` : `
      ${summary ? `<div style="display:flex;gap:16px;margin-bottom:14px;flex-wrap:wrap;">${summary}</div>` : ''}
      <table class="data-table"><thead><tr><th>Storage</th><th>Key / Name</th><th>Purpose</th><th>Classification</th><th>Risk</th></tr></thead>
      <tbody>${rows.map(r=>`<tr>
        <td><span class="al-entity-type">${escapeHtml(r.mechanism)}</span></td>
        <td class="mono">${escapeHtml(r.key)}</td>
        <td style="color:var(--text-dim);">${escapeHtml(r.purpose)}</td>
        <td class="mono" style="font-size:10.5px;color:var(--text-faint);">${escapeHtml(r.classification)}</td>
        <td><span class="sec-status-dot"><span class="dot" style="background:${riskColor(r.risk)};"></span><span style="color:${riskColor(r.risk)};">${escapeHtml(r.risk)}</span></span></td>
      </tr>`).join('')}</tbody></table>
      <div style="margin-top:12px;"><button type="button" class="sec-scan-btn" id="btnRescan"><svg class="radar" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9" opacity=".35"></circle><path d="M12 12L12 4"></path></svg>Re-run scan</button></div>`;
    const rescan = document.getElementById('btnRescan');
    if(rescan) rescan.addEventListener('click', runScan);
  };
  async function runScan(){
    const btn = document.getElementById('btnRunScan') || document.getElementById('btnRescan');
    if(btn) btn.classList.add('scanning');
    const rows = await scanClientStorage();
    state._lastStorageScan = rows;
    state._lastStorageScanAt = new Date().toISOString();
    renderRows(rows);
  }
  document.getElementById('btnRunScan') && document.getElementById('btnRunScan').addEventListener('click', runScan);
  if(state._lastStorageScan) renderRows(state._lastStorageScan);
}

const PII_CATEGORY_COLOR_VAR = {
  PUBLIC:'--text-faint', INTERNAL:'--get', CONFIDENTIAL:'--patch',
  PII:'--put', FINANCIAL:'--put', SENSITIVE_PII:'--delete', AUTHENTICATION_SECRET:'--delete',
};
const PII_SAMPLE_VALUES = {
  PII:'9876543210', SENSITIVE_PII:'ABCDE1234F', FINANCIAL:'4111111111111111',
  AUTHENTICATION_SECRET:'sk_live_51H8xJ2KZq', CONFIDENTIAL:'ProjectFalcon',
  INTERNAL:'internal-doc-42', PUBLIC:'PublicValue123',
};
// A real, computed preview (runs the same maskByStrategy() every render path
// uses) so an admin can see exactly what a rule will do before saving it —
// not a static screenshot-style example.
function piiMaskPreview(category, strategy, maskChar){
  const sample = PII_SAMPLE_VALUES[category] || 'ExampleValue123';
  return { sample, masked: maskByStrategy(sample, { strategy, maskChar: maskChar||'*' }) };
}

// Local UI state for the sensitive-fields search/filter — kept outside the
// render function (not re-created per render) so it survives re-renders
// triggered by toggling/editing a rule elsewhere in the tab.
let PII_FIELDS_FILTER = { q:'', category:'all' };
const ICON_SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>';
const ICON_SHIELD_SM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l8 4v6c0 5-3.4 8.4-8 10-4.6-1.6-8-5-8-10V6l8-4z"></path></svg>';
const ICON_TIMER_SM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"></circle><path d="M12 9v4l2.5 1.5"></path><path d="M9 2h6"></path></svg>';
const ICON_TARGET_SM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><circle cx="12" cy="12" r="5"></circle><circle cx="12" cy="12" r="1" fill="currentColor"></circle></svg>';
const ICON_LAYERS_SM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l9 5-9 5-9-5 9-5z"></path><path d="M3 12l9 5 9-5"></path><path d="M3 17l9 5 9-5"></path></svg>';
const ICON_INBOX_SM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"></path><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path></svg>';

function renderPiiRulesTab(body){
  const s = PII_CONFIG.settings || {};
  const rules = PII_CONFIG.rules || [];
  const activeCount = rules.filter(r=>r.enabled!==false).length;
  const categoryCount = new Set(rules.map(r=>r.category)).size;
  body.innerHTML = `
    <div class="sec-grid" style="margin-bottom:26px;">
      <div class="sec-card" style="--sc-accent:var(${s.automaticProtection!==false?'--post':'--put'});">
        <div class="k">Automatic detection</div>
        <div class="v"><span class="dot"></span>${s.automaticProtection!==false?'On':'Off'}</div>
        <div class="s">Scans field names &amp; value patterns (mobile, email, PAN, Aadhaar, card numbers…) on every render surface.</div>
      </div>
      <div class="sec-card" style="--sc-accent:var(--accent);">
        <div class="k">Admin-defined rules</div>
        <div class="v"><span class="dot"></span>${activeCount} active${rules.length!==activeCount?` / ${rules.length} total`:''}</div>
        <div class="s">${categoryCount ? `Spanning ${categoryCount} classification categor${categoryCount===1?'y':'ies'}.` : 'No custom rules yet — built-in detection still applies.'}</div>
      </div>
      <div class="sec-card" style="--sc-accent:var(--accent);">
        <div class="k">Reveal timeout</div>
        <div class="v"><span class="dot"></span>${s.revealTimeoutSeconds||60}s auto-remask</div>
        <div class="s">Every reveal needs a reason and is logged as a <span class="sec-field-name" style="font-size:11px;">PII_REVEAL</span> audit event.</div>
      </div>
    </div>

    <div class="section" style="margin-bottom:26px;max-width:640px;">
      <div class="section-title">Protection settings</div>
      <div class="sec-card" style="--sc-accent:var(${s.automaticProtection!==false?'--post':'--put'});">
        <label class="sec-switch">
          <input type="checkbox" id="piiAutoToggle" ${s.automaticProtection!==false?'checked':''}>
          <span class="track"></span>
          <span class="lbl">Automatically detect &amp; mask PII by field name and value pattern</span>
        </label>
        <div class="s" style="margin-top:8px;margin-left:48px;">Admin-defined rules below always apply, on top of this.</div>
        <div style="display:flex;align-items:flex-end;gap:14px;flex-wrap:wrap;margin-top:18px;padding-top:16px;border-top:1px solid var(--border);">
          <div>
            <label class="sec-field-label" style="margin-top:0;">Reveal auto-remask timeout (seconds)</label>
            <input type="number" id="piiTimeoutInput" value="${s.revealTimeoutSeconds||60}" min="10" max="3600" style="width:110px;">
          </div>
          <button type="button" class="primary" id="btnSavePiiSettings">Save settings</button>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
        <span>Sensitive fields</span>
        <button type="button" class="primary" id="btnAddRule">+ Add sensitive field</button>
      </div>
      <div class="sec-field-toolbar">
        <div class="sec-search">${ICON_SEARCH}<input type="text" id="piiFieldSearch" placeholder="Search field name…" value="${escapeHtml(PII_FIELDS_FILTER.q)}"></div>
        <div id="piiCategoryChips" style="display:flex;gap:8px;flex-wrap:wrap;"></div>
      </div>
      <div id="piiFieldsBody"></div>
    </div>
  `;
  document.getElementById('btnSavePiiSettings').addEventListener('click', async ()=>{
    try{
      const next = await piiApi('PUT','/settings', {
        automaticProtection: document.getElementById('piiAutoToggle').checked,
        revealTimeoutSeconds: parseInt(document.getElementById('piiTimeoutInput').value,10) || 60,
        environmentPolicy: s.environmentPolicy, surfaces: s.surfaces,
      });
      PII_CONFIG.settings = next.settings;
      logSecurityEvent('ADMIN_SETTING_CHANGED', { entityType:'pii_settings', details:'Updated PII & data masking settings', severity:'warning' });
      toast('Settings saved');
      renderPiiRulesTab(body);
    }catch(e){ toast(e.message || 'Could not save settings'); }
  });
  document.getElementById('btnAddRule').addEventListener('click', ()=> openPiiRuleDrawer(body, null));
  const searchInput = document.getElementById('piiFieldSearch');
  searchInput.addEventListener('input', ()=>{
    PII_FIELDS_FILTER.q = searchInput.value;
    renderPiiFieldsList(body);
  });
  renderPiiCategoryChips(body);
  renderPiiFieldsList(body);
}

function renderPiiCategoryChips(body){
  const rules = PII_CONFIG.rules || [];
  const present = Array.from(new Set(rules.map(r=>r.category))).sort();
  const chipsEl = document.getElementById('piiCategoryChips');
  if(!chipsEl) return;
  if(!present.length){ chipsEl.innerHTML = ''; return; }
  const chips = ['all', ...present];
  chipsEl.innerHTML = chips.map(c=>`<button type="button" class="sec-filter-chip ${PII_FIELDS_FILTER.category===c?'active':''}" data-pii-chip="${c}">${c==='all'?'All':escapeHtml(c)}</button>`).join('');
  chipsEl.querySelectorAll('[data-pii-chip]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      PII_FIELDS_FILTER.category = btn.getAttribute('data-pii-chip');
      renderPiiCategoryChips(body);
      renderPiiFieldsList(body);
    });
  });
}

function renderPiiFieldsList(body){
  const allRules = PII_CONFIG.rules || [];
  const q = PII_FIELDS_FILTER.q.trim().toLowerCase();
  const rules = allRules.filter(r=>{
    if(PII_FIELDS_FILTER.category!=='all' && r.category!==PII_FIELDS_FILTER.category) return false;
    if(q && !r.fieldName.toLowerCase().includes(q)) return false;
    return true;
  });
  const target = document.getElementById('piiFieldsBody');
  if(!target) return;
  if(!allRules.length){
    target.innerHTML = `<div class="sec-empty-state">${ICON_INBOX_SM}<div class="t">No admin-defined rules yet — built-in detection (mobile, email, PAN, Aadhaar, account/card numbers, etc.) still applies. Add a rule to enforce a specific field, category, or masking strategy.</div></div>`;
  } else if(!rules.length){
    target.innerHTML = `<div class="sec-empty-state">${ICON_SEARCH}<div class="t">No sensitive fields match "${escapeHtml(PII_FIELDS_FILTER.q)}"${PII_FIELDS_FILTER.category!=='all'?` in ${escapeHtml(PII_FIELDS_FILTER.category)}`:''}.</div></div>`;
  } else {
    target.innerHTML = `<div class="sec-field-table-wrap"><table class="sec-field-table">
      <thead><tr><th>Field</th><th>Category</th><th>Preview</th><th>Environments</th><th>Active</th><th></th></tr></thead>
      <tbody>${rules.map(r=>{
        const colorVar = PII_CATEGORY_COLOR_VAR[r.category] || '--text-faint';
        const preview = piiMaskPreview(r.category, r.maskingStrategy, r.maskChar);
        const envIds = r.environments || [];
        const envDots = envIds.slice(0,4).map(id=>`<span title="${escapeHtml(id)}" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${envAccentColor(id)};"></span>`).join('');
        const envLabel = envIds.length ? `<span style="display:inline-flex;align-items:center;gap:4px;">${envDots}${envIds.length>4?`<span style="font-size:10px;color:var(--text-faint);">+${envIds.length-4}</span>`:''}</span>` : `<span class="sec-field-meta">All envs</span>`;
        return `<tr class="sec-field-row" style="--sf-accent:var(${colorVar});">
          <td>
            <div class="sec-field-name">${escapeHtml(r.fieldName)}</div>
            <div class="sec-field-meta">${r.matchMode==='regex'?'Regex match':r.matchMode==='exact'?'Exact match':r.matchMode==='nested'?'Nested path':'Case insensitive'}</div>
          </td>
          <td><span class="sec-cat-tag">${escapeHtml(r.category)}</span></td>
          <td><span class="sec-mask-preview">${escapeHtml(preview.sample)} → <b>${escapeHtml(preview.masked)}</b></span></td>
          <td>${envLabel}</td>
          <td>
            <label class="sec-switch" style="gap:8px;">
              <input type="checkbox" data-toggle-rule="${r.id}" ${r.enabled?'checked':''}>
              <span class="track"></span>
            </label>
          </td>
          <td style="text-align:right;white-space:nowrap;">
            <button type="button" class="icon-btn" data-edit-rule="${r.id}" title="Edit">✎</button>
            <button type="button" class="icon-btn del" data-delete-rule="${r.id}" title="Delete">${ICON_TRASH}</button>
          </td>
        </tr>`;
      }).join('')}</tbody></table></div>`;
  }
  target.querySelectorAll('[data-edit-rule]').forEach(btn=>{
    btn.addEventListener('click', ()=> openPiiRuleDrawer(body, allRules.find(r=>String(r.id)===btn.getAttribute('data-edit-rule'))));
  });
  target.querySelectorAll('[data-toggle-rule]').forEach(input=>{
    input.addEventListener('change', async ()=>{
      const rule = allRules.find(r=>String(r.id)===input.getAttribute('data-toggle-rule'));
      if(!rule) return;
      try{
        const result = await piiApi('PUT', '/rules/'+rule.id, { ...rule, enabled: input.checked });
        PII_CONFIG.rules = PII_CONFIG.rules.map(r=> r.id===rule.id ? result.rule : r);
        toast(input.checked ? 'Rule enabled' : 'Rule disabled');
        renderPiiFieldsList(body);
      }catch(e){ input.checked = !input.checked; toast(e.message || 'Could not update rule'); }
    });
  });
  target.querySelectorAll('[data-delete-rule]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const id = btn.getAttribute('data-delete-rule');
      const ok = await openConfirmModal({ title:'Delete this rule?', message:'This sensitive-field rule will stop being masked by admin configuration (built-in detection may still catch it).', confirmLabel:'Delete' });
      if(!ok) return;
      try{
        await piiApi('DELETE', '/rules/'+id);
        PII_CONFIG.rules = PII_CONFIG.rules.filter(r=>String(r.id)!==id);
        toast('Rule deleted');
        renderPiiRulesTab(body);
      }catch(e){ toast(e.message || 'Could not delete rule'); }
    });
  });
}

function openPiiRuleDrawer(body, existing){
  document.getElementById('secRuleDrawerScrim')?.remove();
  const envOpts = environments();
  const scrim = document.createElement('div');
  scrim.className = 'sec-drawer-scrim';
  scrim.id = 'secRuleDrawerScrim';
  scrim.innerHTML = `
    <div class="sec-drawer" role="dialog" aria-label="${existing?'Edit sensitive field':'Add sensitive field'}">
      <div class="sec-drawer-head">
        <h3>${existing ? 'Edit sensitive field' : 'Add sensitive field'}</h3>
        <button type="button" class="icon-btn" id="rfClose" title="Close">✕</button>
      </div>
      <div class="sec-drawer-body">
        <div class="sec-drawer-section">
          <div class="sec-drawer-section-title">${ICON_TARGET_SM}Match</div>
          <label class="sec-field-label" style="margin-top:10px;">Field name</label>
          <input type="text" id="rfName" class="sec-field-input" value="${existing ? escapeHtml(existing.fieldName) : ''}" placeholder="e.g. mobileNumber" style="width:100%;">
          <div class="sec-drawer-hint" id="rfNameError" style="display:none;color:var(--delete);">Field name is required.</div>
          <label class="sec-field-label">Matching</label>
          <select id="rfMatch" style="width:100%;">
            ${['case_insensitive','exact','nested','regex'].map(m=>`<option value="${m}" ${existing&&existing.matchMode===m?'selected':''}>${m==='case_insensitive'?'Case insensitive':m==='exact'?'Exact':m==='nested'?'Nested JSON path (a.b.c)':'Regex'}</option>`).join('')}
          </select>
          <div class="sec-drawer-hint" id="rfMatchHint"></div>
        </div>

        <div class="sec-drawer-section">
          <div class="sec-drawer-section-title">${ICON_SHIELD_SM}Classify &amp; mask</div>
          <label class="sec-field-label" style="margin-top:10px;">Category</label>
          <select id="rfCategory" style="width:100%;">${PII_CATEGORY_OPTIONS.map(c=>`<option value="${c}" ${existing&&existing.category===c?'selected':''}>${c}</option>`).join('')}</select>
          <label class="sec-field-label">Masking strategy</label>
          <select id="rfStrategy" style="width:100%;">${PII_STRATEGY_OPTIONS.map(o=>`<option value="${o.id}" ${existing&&existing.maskingStrategy===o.id?'selected':''}>${o.label}</option>`).join('')}</select>
          <div id="rfPreview" class="sec-preview-box"></div>
        </div>

        <div class="sec-drawer-section">
          <div class="sec-drawer-section-title">${ICON_LAYERS_SM}Scope</div>
          <label class="sec-field-label" style="margin-top:10px;">Apply to</label>
          <div class="sec-chip-group">
            ${PII_SURFACE_OPTIONS.map(o=>`<label class="sec-chip"><input type="checkbox" data-rf-apply="${o.id}" ${(!existing || (existing.applyTo||[]).includes(o.id))?'checked':''}>${o.label}</label>`).join('')}
          </div>
          <label class="sec-field-label">Environments</label>
          <div class="sec-chip-group">
            ${envOpts.map(e=>`<label class="sec-chip env" style="--sec-chip-bg:${envBgColor(e.id)};--sec-chip-color:${envAccentColor(e.id)};"><input type="checkbox" data-rf-env="${e.id}" ${(!existing || (existing.environments||[]).includes(e.id))?'checked':''}>${e.label}</label>`).join('')}
          </div>
          <label class="sec-switch" style="margin-top:18px;">
            <input type="checkbox" id="rfEnabled" ${!existing || existing.enabled ? 'checked' : ''}>
            <span class="track"></span>
            <span class="lbl">Enabled</span>
          </label>
        </div>
      </div>
      <div class="sec-drawer-foot">
        <button type="button" id="rfCancel">Cancel</button>
        <button type="button" class="primary" id="rfSave">${existing?'Save changes':'Save rule'}</button>
      </div>
    </div>`;
  document.body.appendChild(scrim);
  requestAnimationFrame(()=> scrim.classList.add('show'));
  const close = ()=>{ scrim.classList.remove('show'); setTimeout(()=>scrim.remove(), 260); };
  scrim.addEventListener('click', (e)=>{ if(e.target === scrim) close(); });
  document.getElementById('rfClose').addEventListener('click', close);
  document.getElementById('rfCancel').addEventListener('click', close);
  const updatePreview = ()=>{
    const p = piiMaskPreview(document.getElementById('rfCategory').value, document.getElementById('rfStrategy').value, '*');
    document.getElementById('rfPreview').innerHTML = `<span class="from">${escapeHtml(p.sample)}</span><span class="arrow">→</span><span class="to">${escapeHtml(p.masked)}</span>`;
  };
  const MATCH_HINTS = {
    case_insensitive: 'Matches this field name anywhere, regardless of letter casing.',
    exact: 'Matches this field name exactly, including letter casing.',
    nested: 'Use dot notation for a nested JSON path, e.g. customer.contact.mobile.',
    regex: 'Field name above is treated as a regular expression pattern.',
  };
  const updateMatchHint = ()=>{
    document.getElementById('rfMatchHint').textContent = MATCH_HINTS[document.getElementById('rfMatch').value] || '';
  };
  const rfNameInput = document.getElementById('rfName');
  rfNameInput.addEventListener('input', ()=>{
    rfNameInput.classList.remove('invalid');
    document.getElementById('rfNameError').style.display = 'none';
  });
  document.getElementById('rfCategory').addEventListener('change', updatePreview);
  document.getElementById('rfStrategy').addEventListener('change', updatePreview);
  document.getElementById('rfMatch').addEventListener('change', updateMatchHint);
  updatePreview();
  updateMatchHint();
  document.getElementById('rfSave').addEventListener('click', async ()=>{
    const fieldName = document.getElementById('rfName').value.trim();
    if(!fieldName){
      rfNameInput.classList.add('invalid');
      document.getElementById('rfNameError').style.display = 'block';
      rfNameInput.focus();
      toast('Field name is required');
      return;
    }
    const payload = {
      fieldName,
      matchMode: document.getElementById('rfMatch').value,
      category: document.getElementById('rfCategory').value,
      maskingStrategy: document.getElementById('rfStrategy').value,
      applyTo: Array.from(scrim.querySelectorAll('[data-rf-apply]:checked')).map(el=>el.getAttribute('data-rf-apply')),
      environments: Array.from(scrim.querySelectorAll('[data-rf-env]:checked')).map(el=>el.getAttribute('data-rf-env')),
      enabled: document.getElementById('rfEnabled').checked,
      charsToKeep: 4,
    };
    try{
      let result;
      if(existing) result = await piiApi('PUT', '/rules/'+existing.id, payload);
      else result = await piiApi('POST', '/rules', payload);
      if(existing) PII_CONFIG.rules = PII_CONFIG.rules.map(r=> r.id===existing.id ? result.rule : r);
      else PII_CONFIG.rules = [...PII_CONFIG.rules, result.rule];
      toast(existing ? 'Rule updated' : 'Rule added');
      close();
      renderPiiRulesTab(document.getElementById('secTabBody'));
    }catch(e){ toast(e.message || 'Could not save rule'); }
  });
}

function renderErrorCatalog(main){
  main.innerHTML = `
    <div class="cc-hero">
      <h1>Standard error codes</h1>
      <div class="cc-hero-sub">A shared reference so every API in this workspace returns consistent, predictable error codes.</div>
    </div>
    <div class="section">
      <div class="table-scroll">
      <table class="data-table error-catalog-table">
        <thead><tr><th>Code</th><th>Error key</th><th>Meaning</th></tr></thead>
        <tbody>
          ${ERROR_CATALOG.map(e=>`<tr>
            <td><span class="resp-code ${respClass(e.code)}" style="width:auto;padding:2px 8px;">${e.code}</span></td>
            <td class="mono" style="font-weight:700;">${e.name}</td>
            <td>${escapeHtml(e.desc)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      </div>
    </div>
    <div class="section">
      <div class="section-title">Usage guidance</div>
      <div class="auth-card">
        <div class="ic">ⓘ</div>
        <div>
          <div class="h">Keep error shapes consistent</div>
          <div class="d">When documenting a new endpoint's error responses, reuse these codes and keys instead of inventing new ones. It keeps client-side error handling generic across every API in the estate.</div>
        </div>
      </div>
    </div>
  `;
}

function renderProfilePage(main){
  const name = state.authorName || '';
  const initials = profileInitials(name);
  const color = name ? profileColor(name) : 'var(--surface-hover)';

  const allEps = [];
  allProjects().forEach(p=>p.endpoints.forEach(ep=>allEps.push({ ep, proj:p })));
  const touched = name ? allEps.filter(x=> x.ep.createdBy===name || x.ep.updatedBy===name) : [];
  const authored = name ? allEps.filter(x=> x.ep.createdBy===name) : [];
  const apisTouched = new Set(touched.map(x=>x.proj.id)).size;
  const lastActive = touched.reduce((max,x)=> (x.ep.updatedAt||'') > max ? (x.ep.updatedAt||'') : max, '');

  const recent = touched.slice().sort((a,b)=>(b.ep.updatedAt||'').localeCompare(a.ep.updatedAt||'')).slice(0,6);
  const recentRows = recent.length ? recent.map(({ep,proj})=>{
    const action = ep.updatedAt !== ep.createdAt && ep.updatedBy===name ? 'Updated' : 'Created';
    return `<tr>
      <td><span class="badge ${methodClass(ep.method)}">${ep.method}</span></td>
      <td class="mono" style="font-size:11.5px;">${escapeHtml(ep.path)}</td>
      <td>${escapeHtml(proj.name)}</td>
      <td>${action}</td>
      <td class="mono" style="font-size:11px;color:var(--text-faint);">${formatDateTime(ep.updatedAt)}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="5" class="empty-field" style="padding:16px;">${name ? 'Nothing attributed to you yet — it shows up here once you add or edit an endpoint.' : 'Set a display name above to start tracking your activity.'}</td></tr>`;

  const swatches = PROFILE_COLORS.map(c=>{
    const sel = name && profileColor(name) === c;
    return `<span class="profile-swatch ${sel?'sel':''}" data-swatch="${c}" style="background:${c};"></span>`;
  }).join('');

  main.innerHTML = `
    <div class="crumb">Your Profile</div>
    <div class="cc-hero">
      <h1>Your profile</h1>
      <div class="cc-hero-sub">${AUTH_USER
        ? `Signed in as <strong>${escapeHtml(AUTH_USER.username)}</strong> · ${escapeHtml(AUTH_USER.organisation)}. Your name and organisation come from your account; avatar color and role below are local display preferences.`
        : `Local to this browser only — there's no login system. This name and color are just used to attribute endpoints you add or edit, and to personalize your avatar.`}</div>
    </div>

    <div class="profile-card">
      <span class="avatar-circle lg" id="profileAvatarLg" style="background:${color};">${initials || '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text-faint);"><circle cx="12" cy="8" r="3.6"></circle><path d="M5 20c0-3.8 3.1-6.8 7-6.8s7 3 7 6.8"></path></svg>'}</span>
      <div class="profile-card-main">
        ${AUTH_USER ? `
        <div class="profile-name-row">
          <input type="text" id="profileNameInput" value="${escapeHtml(name)}" maxlength="60" disabled title="Managed by your account">
        </div>
        <div class="profile-sub">Endpoints you add or edit are credited to ${escapeHtml(name)} (${escapeHtml(AUTH_USER.organisation)}).</div>
        ` : `
        <div class="profile-name-row">
          <input type="text" id="profileNameInput" placeholder="Your name" value="${escapeHtml(name)}" maxlength="60">
          <button class="profile-save" id="profileSaveBtn">Save</button>
        </div>
        <div class="profile-sub">${name ? 'Endpoints you add or edit from now on will credit this name.' : 'No name set yet — endpoints you save will be attributed once you add one.'}</div>
        `}
        <div class="profile-swatch-row">
          <span class="profile-swatch-label">Avatar color</span>
          ${swatches}
        </div>
        ${AUTH_USER ? `
        <div class="role-select-row">
          <span class="profile-swatch-label">Role</span>
          <span class="role-pill role-${roleMeta(state.authorRole).id}">${roleMeta(state.authorRole).label}</span>
        </div>
        <div class="role-hint">${roleHintText(state.authorRole)} Set by an Admin — see Team members below to change it.</div>
        ` : `
        <div class="role-select-row">
          <span class="profile-swatch-label">Role</span>
          ${ROLES.filter(r=>r.id!=='custom').map(r=>`<span class="role-opt${state.authorRole===r.id?' sel':''}" data-role="${r.id}">${r.label}</span>`).join('')}
        </div>
        <div class="role-hint">${roleHintText(state.authorRole)}</div>
        `}
      </div>
    </div>

    <div class="kpi-grid">
      ${kpiCard('Endpoints authored', authored.length)}
      ${kpiCard('Endpoints touched', touched.length, null, 'created or last edited by you')}
      ${kpiCard('APIs touched', apisTouched)}
      ${kpiCard('Last activity', lastActive ? formatDateTime(lastActive).split(',')[0] : '—')}
    </div>

    <div class="section">
      <div class="section-title">Recent activity</div>
      <div class="table-scroll">
      <table class="data-table">
        <thead><tr><th>Method</th><th>Endpoint</th><th>API</th><th>Action</th><th>When</th></tr></thead>
        <tbody>${recentRows}</tbody>
      </table>
      </div>
    </div>

    ${isAdmin() ? `
    <div class="section">
      <div class="section-title">
        <span style="flex:1;">Endpoint table <span style="color:var(--text-faint); font-weight:500; text-transform:none;">— the environment list used across every project; endpoint URLs are sensitive and only reveal for the Admin role</span></span>
      </div>
      <div id="envTableSection"></div>
    </div>
    ` : `
    <div class="section">
      <div class="section-title">Endpoint table</div>
      <div class="empty-field" style="padding:16px 0; display:flex; align-items:center; gap:7px;"><span style="display:inline-flex;">${ICON_LOCK}</span> Environment details are visible to Admins only.</div>
    </div>
    `}

    ${AUTH_USER && AUTH_USER.role === 'admin' ? `
    <div class="section">
      <div class="section-title">
        <span style="flex:1;">Team members <span style="color:var(--text-faint); font-weight:500; text-transform:none;">— invite people into ${escapeHtml(AUTH_USER.organisation)}, change their role, reset a password, or remove access. Visible to Admins only.</span></span>
      </div>
      <div id="usersTableSection"></div>
    </div>
    ` : ''}

    ${AUTH_USER && AUTH_USER.role === 'admin' ? renderBrandingSectionHtml() : ''}
  `;
  if(isAdmin()) renderEnvTableSection();

  if(AUTH_USER && AUTH_USER.role === 'admin'){
    renderUsersTableSection(); // paint from whatever we already have (loading/ready/error)
    ensureUsersLoaded(); // fetches only if not already loaded; re-renders when it resolves
    wireBrandingSection(main);
  }

  if(!AUTH_USER){
    const nameInput = document.getElementById('profileNameInput');
    const saveProfileName = ()=>{
      const val = nameInput.value.trim();
      const prev = state.authorName || '';
      state.authorName = val;
      if(val) localStorage.setItem(AUTHOR_KEY, val); else localStorage.removeItem(AUTHOR_KEY);
      if(val && val !== prev) logAudit('updated', 'profile', val, prev ? `Renamed profile from "${prev}" to "${val}"` : `Set profile name to "${val}"`);
      renderAuthorLabel();
      renderProfilePage(main);
      if(val) toast('Profile saved');
    };
    document.getElementById('profileSaveBtn').addEventListener('click', saveProfileName);
    nameInput.addEventListener('keydown', e=>{ if(e.key==='Enter') saveProfileName(); });
  }
  main.querySelectorAll('[data-swatch]').forEach(sw=>{
    sw.addEventListener('click', ()=>{
      localStorage.setItem(PROFILE_COLOR_KEY, sw.getAttribute('data-swatch'));
      logAudit('updated', 'profile', state.authorName || 'Unknown', 'Changed avatar color');
      renderAuthorLabel();
      renderProfilePage(main);
    });
  });
  main.querySelectorAll('[data-role]').forEach(opt=>{
    opt.addEventListener('click', ()=>{
      const roleId = opt.getAttribute('data-role');
      if(roleId !== state.authorRole){
        logAudit('updated', 'profile', state.authorName || 'Unknown', `Changed role to ${roleMeta(roleId).label}`);
      }
      setAuthorRole(roleId);
      renderProfilePage(main);
    });
  });

}

/* ---------- Organisation branding (Your Profile ▸ Admin-only) ----------
   One logo + display label per organisation, saved to Postgres (org_workspace.branding
   via PUT /api/workspace/branding — see server/routes/workspace.js) so it survives a
   server restart/redeploy rather than living only in this browser. It's picked up by
   every PDF export (public/js/studio/20-export-pdf.js) — stamped as a letterhead on
   the cover page and, natively via jsPDF, on every single page of the document. */
const BRAND_LOGO_TARGET_PX = 240;       // rendered small (cover + a ~8mm page-header mark) — no need to carry a huge source photo through
const MAX_BRAND_LOGO_BYTES_CLIENT = 250 * 1024; // mirrors MAX_BRAND_LOGO_BYTES in server/routes/workspace.js
let brandPendingLogoDataUrl; // undefined = no change since last save; null = explicit "remove logo"; string = a newly-picked file, pre-compression-checked

function renderBrandingSectionHtml(){
  const b = state.branding || {};
  return `
    <div class="section">
      <div class="section-title">
        <span style="flex:1;">Organisation branding <span style="color:var(--text-faint); font-weight:500; text-transform:none;">— the logo and name stamped on every page of a PDF export, plus its cover. Saved once for ${escapeHtml(AUTH_USER.organisation)} and used by everyone exporting from it. Visible to Admins only to change.</span></span>
      </div>
      <div class="brand-card">
        <div class="brand-logo-zone" id="brandLogoZone" title="Click or drop an image to upload">
          <img id="brandLogoPreviewImg" class="brand-logo-img" style="${b.logoDataUrl ? '' : 'display:none;'}" src="${b.logoDataUrl ? b.logoDataUrl : ''}" alt="">
          <div id="brandLogoPlaceholder" class="brand-logo-placeholder" style="${b.logoDataUrl ? 'display:none;' : ''}">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M12 4l-4 4M12 4l4 4"></path><path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"></path></svg>
            <span>Drop logo</span>
          </div>
        </div>
        <div class="brand-card-main">
          <label class="profile-swatch-label" style="display:block; margin-bottom:6px;">Display name on exports</label>
          <input type="text" id="brandNameInput" placeholder="${escapeHtml(AUTH_USER.organisation)}" value="${escapeHtml(b.orgDisplayName || '')}" maxlength="80">
          <div class="profile-sub" style="margin-top:8px;">PNG, JPEG, or WebP, under ${Math.floor(MAX_BRAND_LOGO_BYTES_CLIENT/1024)}KB — it renders small (page header + cover), so a simple mark works best.</div>
          <div class="brand-error" id="brandError" style="display:none;"></div>
          <div style="display:flex; gap:8px; margin-top:12px; flex-wrap:wrap;">
            <button class="profile-save" id="brandSaveBtn">Save branding</button>
            ${b.logoDataUrl ? `<button class="profile-save brand-remove-btn" id="brandRemoveBtn">Remove logo</button>` : ''}
          </div>
          ${b.updatedAt ? `<div class="profile-sub" style="margin-top:8px;">Last updated ${escapeHtml(formatDateTime(b.updatedAt))}${b.updatedBy ? ' by ' + escapeHtml(b.updatedBy) : ''}.</div>` : ''}
        </div>
        <input type="file" id="brandLogoInput" accept="image/png,image/jpeg,image/webp" style="display:none;">
      </div>
    </div>
  `;
}

// Downscales to a small square on a canvas and re-encodes as PNG before it's
// ever turned into a dataUrl (same reasoning as Architecture Studio's custom-icon
// uploader) — plus jsPDF's addImage (used for the native per-page header) only
// accepts raster PNG/JPEG/WebP, never SVG, so this deliberately always normalizes
// to PNG rather than passing the source file's own format through untouched.
function brandFileToProcessedDataUrl(file){
  return new Promise((resolve, reject)=>{
    if(file.size > 5 * 1024 * 1024) return reject(new Error('That file is too large to read in (max 5MB before compression).'));
    const reader = new FileReader();
    reader.onerror = ()=>reject(new Error('Could not read that file.'));
    reader.onload = ()=>{
      const img = new Image();
      img.onload = ()=>{
        const scale = Math.min(1, BRAND_LOGO_TARGET_PX / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/png', 0.92)); // PNG keeps transparency — most logos need it
      };
      img.onerror = ()=>reject(new Error('Could not read that image.'));
      img.src = reader.result; // data: URL — always allowed by this app's CSP
    };
    reader.readAsDataURL(file);
  });
}

function wireBrandingSection(main){
  const zone = document.getElementById('brandLogoZone');
  if(!zone) return; // not rendered (non-admin) — nothing to wire
  brandPendingLogoDataUrl = undefined;
  const input = document.getElementById('brandLogoInput');
  const errEl = document.getElementById('brandError');
  const showBrandError = (msg)=>{ errEl.textContent = msg; errEl.style.display = 'block'; };

  async function handleBrandFile(file){
    errEl.style.display = 'none';
    if(!file) return;
    if(!['image/png','image/jpeg','image/webp'].includes(file.type)){ showBrandError('Please choose a PNG, JPEG, or WebP file.'); return; }
    try{
      const dataUrl = await brandFileToProcessedDataUrl(file);
      if(dataUrl.length > MAX_BRAND_LOGO_BYTES_CLIENT){ showBrandError('That image is still too large after compression — try a simpler source image.'); return; }
      brandPendingLogoDataUrl = dataUrl;
      const img = document.getElementById('brandLogoPreviewImg');
      img.src = dataUrl; img.style.display = '';
      document.getElementById('brandLogoPlaceholder').style.display = 'none';
    }catch(e){
      showBrandError(e.message || 'Could not process that image.');
    }
  }

  zone.addEventListener('click', ()=>input.click());
  zone.addEventListener('dragover', e=>e.preventDefault());
  zone.addEventListener('drop', e=>{ e.preventDefault(); handleBrandFile(e.dataTransfer.files[0]); });
  input.addEventListener('change', e=>handleBrandFile(e.target.files[0]));

  const removeBtn = document.getElementById('brandRemoveBtn');
  if(removeBtn) removeBtn.addEventListener('click', ()=>{
    brandPendingLogoDataUrl = null;
    document.getElementById('brandLogoPreviewImg').style.display = 'none';
    document.getElementById('brandLogoPlaceholder').style.display = '';
  });

  document.getElementById('brandSaveBtn').addEventListener('click', async ()=>{
    const btn = document.getElementById('brandSaveBtn');
    const nameVal = document.getElementById('brandNameInput').value.trim();
    const body = { orgDisplayName: nameVal };
    if(brandPendingLogoDataUrl !== undefined) body.logoDataUrl = brandPendingLogoDataUrl;
    const prevLabel = btn.textContent;
    btn.disabled = true; btn.textContent = 'Saving…';
    try{
      const res = await apiSend('PUT', '/branding', body);
      state.branding = res.branding || { ...state.branding, orgDisplayName: nameVal };
      logAudit('updated', 'branding', AUTH_USER.organisation, 'Updated organisation branding for PDF exports');
      toast('Branding saved');
      renderProfilePage(main);
    }catch(e){
      console.error(e);
      showBrandError((e && e.message) || 'Could not save — check your connection and try again.');
      btn.disabled = false; btn.textContent = prevLabel;
    }
  });
}

/* ---------- Encryption Keys tab (Admin only): view + rotate the data-encryption-key ----------
   This is the "if the key is ever compromised, change it immediately" control.
   Rotating creates a brand-new Data Encryption Key (DEK), wrapped by the
   server's MASTER_KEY, and makes it active for all *new* writes right away —
   no redeploy needed. Existing encrypted rows stay readable (each remembers
   which key version protected it) and get upgraded to the new key the next
   time they're saved, or immediately if "Re-encrypt existing data now" is
   checked. See server/crypto.js + server/routes/security.js. */
async function securityApi(method, path, body){
  const res = await fetch('/api/security'+path, {
    method, credentials:'same-origin',
    headers: body ? { 'Content-Type':'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.error || ('Request failed ('+res.status+')'));
  return data;
}
function renderEncryptionKeysTab(body){
  body.innerHTML = `<div class="al-loading" style="padding:40px 0;text-align:center;color:var(--text-faint);font-size:13px;">Loading key status…</div>`;
  securityApi('GET', '/encryption').then(({ keys, activeVersion })=>{
    const active = keys.find(k=>k.version===activeVersion) || keys[0];
    body.innerHTML = `
      <div class="sec-grid" style="margin-bottom:26px;">
        <div class="sec-card" style="--sc-accent:var(--post);">
          <div class="k">Active key version</div>
          <div class="v"><span class="dot"></span>v${activeVersion}</div>
          <div class="s">${active ? 'In use since ' + new Date(active.createdAt).toLocaleString(undefined,{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'}) : ''}</div>
        </div>
        <div class="sec-card" style="--sc-accent:var(--accent);">
          <div class="k">Key versions on file</div>
          <div class="v"><span class="dot"></span>${keys.length}</div>
          <div class="s">Older versions are kept (never deleted) so previously encrypted data stays readable.</div>
        </div>
        <div class="sec-card" style="--sc-accent:var(--put);">
          <div class="k">What's encrypted</div>
          <div class="v" style="font-size:13px;">Endpoint data, environments, request history</div>
          <div class="s">Organisation/username/email stay plaintext — the app has to query/index on those to sign you in and route requests.</div>
        </div>
      </div>

      <div class="section" style="margin-bottom:26px;max-width:640px;">
        <div class="section-title">Rotate encryption key</div>
        <div class="sec-card" style="--sc-accent:var(--delete);">
          <div class="s" style="margin-bottom:14px;line-height:1.6;">
            If you believe the encryption key may have been exposed, rotate it now. A brand-new key is generated and activated immediately — every new save is protected by it right away. This does <strong>not</strong> require a deploy or restart.
          </div>
          <label class="sec-switch" style="margin-bottom:14px;">
            <input type="checkbox" id="reencryptNowToggle">
            <span class="track"></span>
            <span class="lbl">Also re-encrypt this organisation's existing data under the new key right now (recommended after a suspected compromise)</span>
          </label>
          <input type="text" id="rotateReason" placeholder="Reason (optional, goes in the audit log)" style="width:100%;margin-bottom:14px;">
          <button type="button" class="danger" id="btnRotateKey">Rotate key now</button>
        </div>
      </div>

      <div class="section">
        <div class="section-title">Key version history</div>
        <div class="al-table-wrap" style="background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden;">
          <table style="width:100%;border-collapse:collapse;font-size:12.5px;">
            <thead><tr>
              <th style="text-align:left;padding:10px 14px;border-bottom:1px solid var(--border);color:var(--text-faint);font-size:10px;text-transform:uppercase;">Version</th>
              <th style="text-align:left;padding:10px 14px;border-bottom:1px solid var(--border);color:var(--text-faint);font-size:10px;text-transform:uppercase;">Status</th>
              <th style="text-align:left;padding:10px 14px;border-bottom:1px solid var(--border);color:var(--text-faint);font-size:10px;text-transform:uppercase;">Created</th>
              <th style="text-align:left;padding:10px 14px;border-bottom:1px solid var(--border);color:var(--text-faint);font-size:10px;text-transform:uppercase;">By</th>
              <th style="text-align:left;padding:10px 14px;border-bottom:1px solid var(--border);color:var(--text-faint);font-size:10px;text-transform:uppercase;">Reason</th>
            </tr></thead>
            <tbody>
              ${keys.map(k=>`<tr>
                <td style="padding:10px 14px;border-bottom:1px solid var(--border);font-family:var(--mono);">v${k.version}</td>
                <td style="padding:10px 14px;border-bottom:1px solid var(--border);">${k.active ? '<span class="al-badge" style="color:#35c491;background:rgba(53,196,145,.14);">Active</span>' : '<span class="al-badge" style="color:#8a97b3;background:rgba(138,151,179,.14);">Retired</span>'}</td>
                <td style="padding:10px 14px;border-bottom:1px solid var(--border);color:var(--text-dim);">${new Date(k.createdAt).toLocaleString(undefined,{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'})}</td>
                <td style="padding:10px 14px;border-bottom:1px solid var(--border);color:var(--text-dim);">${escapeHtml(k.createdBy || '—')}</td>
                <td style="padding:10px 14px;border-bottom:1px solid var(--border);color:var(--text-dim);">${escapeHtml(k.reason || '—')}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
    document.getElementById('btnRotateKey').addEventListener('click', async ()=>{
      const ok = await openConfirmModal({
        title: 'Rotate encryption key?',
        message: 'This immediately activates a new encryption key for all new data. ' + (document.getElementById('reencryptNowToggle').checked ? 'Existing data for your organisation will also be re-encrypted right now.' : 'Existing data stays on its current key until it is next saved.'),
        confirmLabel: 'Rotate key',
      });
      if(!ok) return;
      const btn = document.getElementById('btnRotateKey');
      btn.disabled = true; btn.textContent = 'Rotating…';
      try{
        const result = await securityApi('POST', '/encryption/rotate', {
          reason: document.getElementById('rotateReason').value.trim() || undefined,
          reencryptNow: document.getElementById('reencryptNowToggle').checked,
        });
        // Re-encryption of existing data (when requested) now runs in the
        // background on the server rather than blocking this request — the
        // response confirms it started, not that it's finished. Completion
        // shows up as its own audit log entry a moment later.
        toast(`Key rotated — now on v${result.activeVersion}` + (result.reencrypting ? ' · re-encrypting your organisation\'s existing data in the background' : ''));
        renderEncryptionKeysTab(body);
      }catch(e){
        toast(e.message || 'Could not rotate the key');
        btn.disabled = false; btn.textContent = 'Rotate key now';
      }
    });
  }).catch(e=>{
    body.innerHTML = `<div class="al-loading" style="padding:40px 0;text-align:center;color:var(--text-faint);font-size:13px;">Could not load encryption key status. ${escapeHtml(e.message||'')}</div>`;
  });
}

async function liveModeApi(method, path, body){
  const res = await fetch('/api/live-mode'+path, {
    method, credentials:'same-origin',
    headers: body ? { 'Content-Type':'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.error || ('Request failed ('+res.status+')'));
  return data;
}

/* Admin-only grid: which org members may fire a REAL request from Try It,
   and against which environments. Independent of role — a Viewer can be
   granted DEV, an Editor withheld from PROD — see server/routes/liveMode.js. */
let _liveModeGrantsDirty = false;
if(!window._liveModeUnloadGuardBound){
  window._liveModeUnloadGuardBound = true;
  window.addEventListener('beforeunload', (e)=>{
    if(!_liveModeGrantsDirty) return;
    e.preventDefault();
    e.returnValue = '';
  });
}
function liveModeMatchesQuery(u, q){
  if(!q) return true;
  return `${u.username} ${u.role}`.toLowerCase().includes(q);
}
function renderLiveModeTableRows(users, environments, grants, q){
  const filtered = users.filter(u=>liveModeMatchesQuery(u, q));
  if(!filtered.length){
    return `<tr><td colspan="${environments.length+1}" style="text-align:center;padding:28px 16px;color:var(--text-faint);">No users match "${escapeHtml(q)}"</td></tr>`;
  }
  return filtered.map(u=>{
    const isFullAccess = u.role === 'admin';
    return `<tr data-live-row="${u.id}" data-live-role="${escapeHtml(u.role)}">
      <td style="padding:12px 20px;border-bottom:1px solid var(--border);white-space:nowrap;position:sticky;left:0;background:var(--surface);">${escapeHtml(u.username)} <span class="hint" style="margin:0;">${escapeHtml(u.role)}</span></td>
      ${environments.map(e=>{
        if(isFullAccess){
          return `<td style="text-align:center;padding:12px 20px;border-bottom:1px solid var(--border);" title="Admins always have full environment access">
            <input type="checkbox" checked disabled style="opacity:.4;">
          </td>`;
        }
        const restricted = !!e.restricted;
        return `<td style="text-align:center;padding:12px 20px;border-bottom:1px solid var(--border);">
          <input type="checkbox" data-live-grant-user="${u.id}" data-live-grant-env="${escapeHtml(e.id)}"
            ${((grants[String(u.id)]||[]).includes(e.id)) ? 'checked' : ''}
            ${restricted ? 'disabled title="'+escapeHtml(e.label||e.id)+' is restricted to Admins — grant it from that role instead"' : ''}>
        </td>`;
      }).join('')}
    </tr>`;
  }).join('');
}
function renderLiveModeAccessTab(body){
  body.innerHTML = `<div class="al-loading" style="padding:40px 0;text-align:center;color:var(--text-faint);font-size:13px;">Loading Live mode access…</div>`;
  _liveModeGrantsDirty = false;
  liveModeApi('GET', '/grants').then(({ grants, users, environments })=>{
    if(!environments.length){
      body.innerHTML = `<div class="sec-card"><div class="s">No environments are configured for this organisation yet — add one from Your Profile first.</div></div>`;
      return;
    }
    body.innerHTML = `
      <div class="section" style="margin-bottom:18px;max-width:760px;">
        <div class="sec-card" style="--sc-accent:var(--delete);">
          <div class="s" style="line-height:1.6;">
            Checking a box here does two things for that person: it lets them <strong>see and switch to</strong> that environment at all in the top-right switcher, and it lets them send <strong>real</strong> requests from Try It against it — not simulated ones. This app never stores real credentials, so they'll still need to enter their own at send time. Production and DR stay Admin-only no matter what's checked here.</div>
        </div>
      </div>
      <div class="section" style="margin-bottom:18px;max-width:760px;">
        <div class="sec-card" style="--sc-accent:var(--accent);">
          <div class="s" style="line-height:1.6;">
            This is the single source of truth for non-admin environment access — a Viewer or Editor can only browse an environment's docs if it's checked here for them.
          </div>
        </div>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px;flex-wrap:wrap;">
        <input type="text" id="liveModeSearch" placeholder="Search by user or role…" autocomplete="off"
          style="width:100%;max-width:320px;background:var(--bg-elevated);border:1px solid var(--border);color:var(--text);font-size:12.5px;padding:9px 13px;border-radius:10px;font-family:var(--sans);">
        <span id="liveModeDirtyBadge" class="hint" style="margin:0;color:var(--put);display:none;">● Unsaved changes</span>
      </div>
      <div class="al-table-wrap" style="background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:auto;width:100%;">
        <table style="width:100%;border-collapse:collapse;font-size:12.5px;">
          <thead>
            <tr>
              <th style="text-align:left;padding:12px 20px;border-bottom:1px solid var(--border);color:var(--text-faint);font-size:10px;text-transform:uppercase;position:sticky;left:0;background:var(--surface);">User</th>
              ${environments.map(e=>`<th style="text-align:center;padding:12px 20px;border-bottom:1px solid var(--border);color:var(--text-faint);font-size:10px;text-transform:uppercase;white-space:nowrap;">${escapeHtml(e.label||e.id)}</th>`).join('')}
            </tr>
            <tr>
              <th style="padding:6px 20px 10px;border-bottom:1px solid var(--border);position:sticky;left:0;background:var(--surface);font-weight:400;color:var(--text-faint);font-size:10px;">Select all</th>
              ${environments.map(e=>`<th style="text-align:center;padding:6px 20px 10px;border-bottom:1px solid var(--border);">
                <input type="checkbox" data-live-grant-col="${escapeHtml(e.id)}" ${e.restricted?'disabled title="Restricted to Admins"':''}>
              </th>`).join('')}
            </tr>
          </thead>
          <tbody id="liveModeTableBody">${renderLiveModeTableRows(users, environments, grants, '')}</tbody>
        </table>
      </div>
      <button type="button" class="primary" id="btnSaveLiveModeGrants" style="margin-top:16px;">Save access</button>
    `;

    const dirtyBadge = document.getElementById('liveModeDirtyBadge');
    const markDirty = ()=>{ _liveModeGrantsDirty = true; dirtyBadge.style.display = ''; };
    const wireRowCheckboxes = ()=>{
      body.querySelectorAll('[data-live-grant-user]').forEach(cb=>{
        cb.addEventListener('change', markDirty);
      });
    };
    wireRowCheckboxes();

    // Column "select all" — only ever touches the currently-visible (search-
    // filtered), non-admin, non-restricted checkboxes in that column, so it
    // can't silently grant an environment to someone hidden by the filter.
    body.querySelectorAll('[data-live-grant-col]').forEach(colCb=>{
      colCb.addEventListener('change', ()=>{
        const envId = colCb.getAttribute('data-live-grant-col');
        body.querySelectorAll(`[data-live-grant-env="${envId}"]`).forEach(cb=>{
          if(cb.disabled) return;
          cb.checked = colCb.checked;
        });
        markDirty();
      });
    });

    const searchInput = document.getElementById('liveModeSearch');
    searchInput.addEventListener('input', ()=>{
      // Collect in-progress (unsaved) checkbox state before re-rendering
      // rows, so filtering never discards a change the admin just made.
      const draft = {};
      body.querySelectorAll('[data-live-grant-user]').forEach(cb=>{
        if(!cb.checked) return;
        const uid = cb.getAttribute('data-live-grant-user');
        const envId = cb.getAttribute('data-live-grant-env');
        (draft[uid] = draft[uid] || []).push(envId);
      });
      const q = searchInput.value.trim().toLowerCase();
      document.getElementById('liveModeTableBody').innerHTML = renderLiveModeTableRows(users, environments, draft, q);
      wireRowCheckboxes();
    });

    document.getElementById('btnSaveLiveModeGrants').addEventListener('click', async ()=>{
      const btn = document.getElementById('btnSaveLiveModeGrants');
      const next = {};
      body.querySelectorAll('[data-live-grant-user]').forEach(cb=>{
        if(!cb.checked) return;
        const uid = cb.getAttribute('data-live-grant-user');
        const envId = cb.getAttribute('data-live-grant-env');
        (next[uid] = next[uid] || []).push(envId);
      });
      btn.disabled = true; btn.textContent = 'Saving…';
      try{
        await liveModeApi('PUT', '/grants', { grants: next });
        toast('Live mode access updated');
        _liveModeGrantsDirty = false;
        dirtyBadge.style.display = 'none';
      }catch(e){
        toast(e.message || 'Could not save Live mode access');
      } finally {
        btn.disabled = false; btn.textContent = 'Save access';
      }
    });
  }).catch(e=>{
    body.innerHTML = `<div class="al-loading" style="padding:40px 0;text-align:center;color:var(--text-faint);font-size:13px;">Could not load Live mode access. ${escapeHtml(e.message||'')}</div>`;
  });
}

// ==================== Security ▸ Documentation Access tab (Admin only) ====================
// Review queue for the self-service request flow: a Viewer clicks a locked
// endpoint in the public catalog (renderLockedEndpointDoc), asks for a
// time-boxed window, and it lands here for approve/deny/revoke. See
// server/routes/docAccess.js for the API and applyDocLock in workspace.js
// for how "locked" is actually enforced (server-side redaction, not a UI
// overlay).
function docAccessStatusMeta(row){
  if(row.status === 'approved' && row.is_active) return { label:'Active', colorVar:'--post', bgVar:'--post-bg', rowStatus:'active', pulse:true };
  if(row.status === 'approved') return { label:'Expired', colorVar:'--text-faint', bgVar:'--surface-2', rowStatus:'expired' };
  if(row.status === 'pending') return { label:'Pending', colorVar:'--put', bgVar:'--put-bg', rowStatus:'pending' };
  if(row.status === 'denied') return { label:'Denied', colorVar:'--delete', bgVar:'--delete-bg', rowStatus:'denied' };
  if(row.status === 'revoked') return { label:'Revoked', colorVar:'--delete', bgVar:'--delete-bg', rowStatus:'revoked' };
  return { label: row.status, colorVar:'--text-faint', bgVar:'--surface-2', rowStatus:'other' };
}
// Small "N days" / "N days left" readout under the date range — genuinely
// useful at a glance (is this a week-long or a year-long grant? how much
// runway is left on an active one?), not decoration.
function docAccessDurationLabel(r, meta){
  const start = new Date(`${r.start_date}T00:00:00Z`);
  const end = new Date(`${r.end_date}T00:00:00Z`);
  const totalDays = Math.round((end - start) / 86400000) + 1;
  if(meta.rowStatus === 'active'){
    const today = new Date(); today.setUTCHours(0,0,0,0);
    const left = Math.round((end - today) / 86400000);
    return left <= 0 ? 'Ends today' : `${left} day${left===1?'':'s'} left`;
  }
  return `${totalDays} day${totalDays===1?'':'s'} window`;
}
function renderDocAccessRow(r){
  const meta = docAccessStatusMeta(r);
  const methodMatch = (r.endpoint_label||'').match(/^(\S+)\s+(.*)$/);
  const method = methodMatch ? methodMatch[1] : '';
  const path = methodMatch ? methodMatch[2] : (r.endpoint_label||'');
  let actionsHtml = '';
  if(r.status === 'pending'){
    actionsHtml = `
      <div class="doc-access-row-controls">
        <div class="doc-access-inline-dates">
          <input type="date" data-daa-start="${r.id}" value="${escapeHtml(r.start_date)}">
          <span style="color:var(--text-faint);">→</span>
          <input type="date" data-daa-end="${r.id}" value="${escapeHtml(r.end_date)}">
        </div>
        <div class="doc-access-actions">
          <button type="button" class="primary" data-daa-approve="${r.id}">Approve</button>
          <button type="button" class="danger" data-daa-deny="${r.id}">Deny</button>
        </div>
      </div>
      <input type="text" class="doc-access-deny-note" data-daa-note="${r.id}" placeholder="Note if denying (optional)">`;
  } else if(r.status === 'approved' && r.is_active){
    actionsHtml = `<button type="button" class="danger" data-daa-revoke="${r.id}">Revoke</button>`;
  } else if(r.status === 'denied' && r.decision_note){
    actionsHtml = `<div class="doc-access-row-controls"><span class="hint" style="margin:0;" title="${escapeHtml(r.decision_note)}">Note left for requester</span><button type="button" class="danger" data-daa-delete="${r.id}">Delete</button></div>`;
  }
  if(meta.rowStatus === 'denied' || meta.rowStatus === 'revoked' || meta.rowStatus === 'expired'){
    if(!actionsHtml.includes('data-daa-delete')){
      actionsHtml += `<div class="doc-access-row-controls" style="margin-top:6px;"><button type="button" class="danger" data-daa-delete="${r.id}">Delete</button></div>`;
    }
  }
  return `<tr data-daa-row="${r.id}" data-status="${meta.rowStatus}">
    <td>${escapeHtml(r.requested_by_username)}</td>
    <td>
      <div class="doc-access-endpoint">
        ${method ? `<span class="badge ${methodClass(method)}">${escapeHtml(method)}</span>` : ''}
        <span>
          <div class="mono" style="font-size:12px;">${escapeHtml(path)}</div>
          <div class="hint" style="margin:0;">${escapeHtml(r.project_name||'')}</div>
        </span>
      </div>
    </td>
    <td><span class="badge" style="background:var(--surface-2);">${escapeHtml(r.environment_label || 'All environments')}</span></td>
    <td class="doc-access-window">${escapeHtml(r.start_date)} → ${escapeHtml(r.end_date)}<span class="days">${docAccessDurationLabel(r, meta)}</span></td>
    <td class="doc-access-reason" title="${escapeHtml(r.reason||'')}">${escapeHtml(r.reason || '—')}</td>
    <td><span class="status-pill${meta.pulse?' pulse':''}" style="color:var(${meta.colorVar});background:var(${meta.bgVar});"><span class="dot"></span>${meta.label}</span></td>
    <td>${actionsHtml}</td>
  </tr>`;
}
function wireDocAccessRowActions(body){
  body.querySelectorAll('[data-daa-approve]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const id = btn.getAttribute('data-daa-approve');
      const startInput = body.querySelector(`[data-daa-start="${id}"]`);
      const endInput = body.querySelector(`[data-daa-end="${id}"]`);
      btn.disabled = true; btn.textContent = 'Approving…';
      try{
        await apiSend('POST', `/doc-access/${id}/approve`, { startDate: startInput.value, endDate: endInput.value });
        toast('Access approved');
        renderDocAccessTab(body);
      }catch(e){
        toast(e.message || 'Could not approve the request');
        btn.disabled = false; btn.textContent = 'Approve';
      }
    });
  });
  body.querySelectorAll('[data-daa-deny]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const id = btn.getAttribute('data-daa-deny');
      const noteInput = body.querySelector(`[data-daa-note="${id}"]`);
      btn.disabled = true; btn.textContent = 'Denying…';
      try{
        await apiSend('POST', `/doc-access/${id}/deny`, { note: (noteInput && noteInput.value.trim()) || undefined });
        toast('Request denied');
        renderDocAccessTab(body);
      }catch(e){
        toast(e.message || 'Could not deny the request');
        btn.disabled = false; btn.textContent = 'Deny';
      }
    });
  });
  body.querySelectorAll('[data-daa-delete]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const id = btn.getAttribute('data-daa-delete');
      const ok = await openConfirmModal({ title:'Delete this request?', message:'This permanently removes it from the list. This can\'t be undone.', confirmLabel:'Delete' });
      if(!ok) return;
      btn.disabled = true; btn.textContent = 'Deleting…';
      try{
        await apiSend('DELETE', `/doc-access/${id}`, {});
        toast('Request deleted');
        renderDocAccessTab(body);
      }catch(e){
        toast(e.message || 'Could not delete the request');
        btn.disabled = false; btn.textContent = 'Delete';
      }
    });
  });
  body.querySelectorAll('[data-daa-revoke]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const id = btn.getAttribute('data-daa-revoke');
      const ok = await openConfirmModal({ title:'Revoke this access?', message:"The person will immediately lose access to this endpoint's documentation.", confirmLabel:'Revoke' });
      if(!ok) return;
      btn.disabled = true; btn.textContent = 'Revoking…';
      try{
        await apiSend('POST', `/doc-access/${id}/revoke`, {});
        toast('Access revoked');
        renderDocAccessTab(body);
      }catch(e){
        toast(e.message || 'Could not revoke access');
        btn.disabled = false; btn.textContent = 'Revoke';
      }
    });
  });
}
function docAccessMatchesQuery(r, q){
  if(!q) return true;
  const haystack = [r.requested_by_username, r.endpoint_label, r.project_name, r.reason, r.status]
    .filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(q);
}
function renderDocAccessTableBody(requests, q){
  const filtered = requests.filter(r=>docAccessMatchesQuery(r, q));
  if(!filtered.length){
    return `<tr><td colspan="6" style="text-align:center;padding:32px 16px;color:var(--text-faint);">No requests match "${escapeHtml(q)}"</td></tr>`;
  }
  return filtered.map(r=>renderDocAccessRow(r)).join('');
}
function renderDocAccessTab(body){
  body.innerHTML = `<div class="al-loading" style="padding:40px 0;text-align:center;color:var(--text-faint);font-size:13px;">Loading documentation access requests…</div>`;
  // Paginated (see docAccess.js's cursor pagination) — accumulated here as
  // "Load more" is clicked rather than fetched all at once. Previously this
  // pulled a flat LIMIT 500 with no way to see anything past it and no
  // indication anything was missing; the footer below now says exactly how
  // many are loaded and whether there's more.
  let all = [];
  let hasMore = false;
  let cursorId = null;
  let pendingTotal = null; // from the dedicated pending-count endpoint — accurate regardless of how many pages are loaded, since pending rows always sort first

  function currentQuery(){
    const input = body.querySelector('#docAccessSearch');
    return input ? input.value.trim().toLowerCase() : '';
  }

  function renderTableAndFooter(){
    const activeCount = all.filter(r=>r.status==='approved' && r.is_active).length;
    const closedCount = all.filter(r=>r.status==='denied' || r.status==='revoked').length;
    const wrap = body.querySelector('.doc-access-wrap');
    if(!wrap) return;
    const statsEl = body.querySelector('.doc-access-stats');
    if(statsEl){
      statsEl.innerHTML = `
        <div class="da-stat" style="--da-color:var(--put);"><div class="n">${pendingTotal != null ? pendingTotal : all.filter(r=>r.status==='pending').length}</div><div class="l">Awaiting review</div></div>
        <div class="da-stat" style="--da-color:var(--post);"><div class="n">${activeCount}</div><div class="l">Active grants${hasMore?' (loaded)':''}</div></div>
        <div class="da-stat" style="--da-color:var(--delete);"><div class="n">${closedCount}</div><div class="l">Denied / revoked${hasMore?' (loaded)':''}</div></div>
        <div class="da-stat"><div class="n">${all.length}${hasMore?'+':''}</div><div class="l">Total loaded</div></div>
      `;
    }
    const tbody = body.querySelector('#docAccessTableBody');
    if(tbody) tbody.innerHTML = renderDocAccessTableBody(all, currentQuery());
    let footer = body.querySelector('#docAccessLoadMoreFooter');
    if(!footer){
      footer = document.createElement('div');
      footer.id = 'docAccessLoadMoreFooter';
      footer.style.cssText = 'padding:14px;text-align:center;';
      wrap.querySelector('.doc-access-table-wrap').after(footer);
    }
    footer.innerHTML = hasMore
      ? `<button type="button" class="ghost" id="btnDocAccessLoadMore">Load more (${all.length} shown)</button>`
      : (all.length > 0 ? `<span class="hint" style="margin:0;">All ${all.length} request${all.length===1?'':'s'} loaded.</span>` : '');
    const loadMoreBtn = body.querySelector('#btnDocAccessLoadMore');
    if(loadMoreBtn) loadMoreBtn.addEventListener('click', async ()=>{
      loadMoreBtn.disabled = true; loadMoreBtn.textContent = 'Loading…';
      try{
        const page = await apiGet(`/doc-access/admin?limit=50&cursorId=${cursorId}`);
        all = all.concat(page.requests);
        hasMore = page.hasMore;
        cursorId = page.requests.length ? page.requests[page.requests.length - 1].id : cursorId;
        renderTableAndFooter();
        wireDocAccessRowActions(body);
      }catch(e){
        toast(e.message || 'Could not load more requests');
        loadMoreBtn.disabled = false; loadMoreBtn.textContent = 'Load more';
      }
    });
  }

  Promise.all([
    apiGet('/doc-access/admin?limit=50'),
    apiGet('/doc-access/pending-count').catch(()=>null),
  ]).then(([firstPage, pendingRes])=>{
    all = firstPage.requests;
    hasMore = firstPage.hasMore;
    cursorId = all.length ? all[all.length - 1].id : null;
    pendingTotal = pendingRes ? pendingRes.count : null;

    if(!all.length && !hasMore){
      body.innerHTML = `
        <div class="doc-access-wrap">
          <div class="doc-access-ambient"></div>
          <div class="doc-access-empty">
            <div class="icon">${ICON_LOCK}</div>
            <h3>No requests yet</h3>
            <p>When someone with read-only access opens a locked endpoint in the public catalog, a "Request access" button gets them here — this queue will fill in as they come.</p>
          </div>
        </div>`;
      return;
    }
    body.innerHTML = `
      <div class="doc-access-wrap">
        <div class="doc-access-ambient"></div>
        <div class="doc-access-stats"></div>
        <div class="doc-access-search-row">
          <input type="text" id="docAccessSearch" placeholder="Search by requester, endpoint, or reason…" autocomplete="off">
        </div>
        <div class="doc-access-table-wrap">
          <table class="doc-access-table">
            <thead><tr>
              <th>Requested by</th>
              <th>Endpoint</th>
              <th>Environment</th>
              <th>Window</th>
              <th>Reason</th>
              <th>Status</th>
              <th>Actions</th>
            </tr></thead>
            <tbody id="docAccessTableBody"></tbody>
          </table>
        </div>
      </div>
    `;
    renderTableAndFooter();
    wireDocAccessRowActions(body);
    const searchInput = body.querySelector('#docAccessSearch');
    searchInput.addEventListener('input', ()=>{
      body.querySelector('#docAccessTableBody').innerHTML = renderDocAccessTableBody(all, currentQuery());
      wireDocAccessRowActions(body);
    });
  }).catch(e=>{
    body.innerHTML = `<div class="al-loading" style="padding:40px 0;text-align:center;color:var(--text-faint);font-size:13px;">Could not load documentation access requests. ${escapeHtml(e.message||'')}</div>`;
  });
}

/* ==================== Security ▸ AI Studio tab (Admin only) ====================
   Org-wide LLM configuration that powers the Editor's "AI Studio" panel
   (draft → docs, upload → docs). The key itself is
   never sent back down once saved — only whether one is configured and its
   last 4 characters, same masking convention as everything else sensitive
   in this app. */
async function aiApi(method, path, body){
  const res = await fetch('/api/ai'+path, {
    method, credentials:'same-origin',
    headers: body ? { 'Content-Type':'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.error || ('Request failed ('+res.status+')'));
  return data;
}
function renderAiSettingsTab(body){
  body.innerHTML = `<div class="al-loading" style="padding:40px 0;text-align:center;color:var(--text-faint);font-size:13px;">Loading AI configuration…</div>`;
  aiApi('GET', '/config').then(cfg=>{
    const providerOptions = cfg.providers.map(p=>`<option value="${p.id}" data-default-model="${escapeHtml(p.defaultModel)}" ${p.id===cfg.provider?'selected':''}>${escapeHtml(p.label)}</option>`).join('');
    const knownDefaults = cfg.providers.map(p=>p.defaultModel);
    body.innerHTML = `
      <div class="section" style="margin-bottom:18px;max-width:760px;">
        <div class="sec-card" style="--sc-accent:${cfg.configured?'var(--post)':'var(--put)'};">
          <div class="s" style="line-height:1.6;">
            ${cfg.configured
              ? `AI is configured for this organisation using <strong>${escapeHtml(cfg.provider)}</strong> (model: ${escapeHtml(cfg.model)}). Key on file: <code>${escapeHtml(cfg.keyPreview||'')}</code>. Everyone in the org can use AI Studio in the Endpoint Editor; only Admins can change or remove this key.`
              : `AI Studio (draft → docs, document upload) is <strong>not set up yet</strong>. Add an API key below to turn it on for the whole organisation.`}
          </div>
        </div>
      </div>
      ${cfg.canManage ? `
      <div class="al-table-wrap" style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:18px;max-width:560px;">
        <div class="field" style="margin-bottom:14px;">
          <label>Provider</label>
          <select id="aiProviderSelect">${providerOptions}</select>
        </div>
        <div class="field" style="margin-bottom:14px;">
          <label>Model</label>
          <input type="text" id="aiModelInput" value="${escapeHtml(cfg.model||'')}" placeholder="e.g. claude-sonnet-4-6">
          <span class="hint" style="margin-top:4px;">Switching Provider resets this to that provider's default model — clear it and try Save again if you've customized it and hit a mismatch error.</span>
        </div>
        <div class="field" style="margin-bottom:14px;">
          <label>API key ${cfg.configured ? '<span class="hint" style="margin:0;">— leave blank to keep the current key</span>' : ''}</label>
          <input type="password" id="aiKeyInput" placeholder="${cfg.configured ? '••••••••••••' : 'sk-…'}" autocomplete="off">
        </div>
        <div style="display:flex; gap:10px; justify-content:flex-end;">
          ${cfg.configured ? '<button type="button" class="ghost" id="btnAiRemoveKey">Remove key</button>' : ''}
          <button type="button" class="primary" id="btnAiSaveConfig">Save</button>
        </div>
      </div>` : `<div class="hint">Only an organisation Admin can add or change the AI key.</div>`}
    `;
    if(!cfg.canManage) return;
    // Switching Provider is exactly what caused the original bug — the Model
    // field kept whatever text it had, which could belong to the OTHER
    // provider (e.g. "claude-sonnet-4-6" left in place after picking OpenAI).
    // Auto-resetting Model to the newly-picked provider's default whenever
    // the field still holds ANY known default (i.e. hasn't been deliberately
    // customized) prevents that mismatch from happening silently again.
    document.getElementById('aiProviderSelect').addEventListener('change', (e)=>{
      const modelInput = document.getElementById('aiModelInput');
      const opt = e.target.selectedOptions[0];
      if(knownDefaults.includes(modelInput.value.trim()) || !modelInput.value.trim()){
        modelInput.value = opt.getAttribute('data-default-model');
      }
    });
    document.getElementById('btnAiSaveConfig').addEventListener('click', async ()=>{
      const btn = document.getElementById('btnAiSaveConfig');
      const provider = document.getElementById('aiProviderSelect').value;
      const model = document.getElementById('aiModelInput').value.trim();
      const apiKey = document.getElementById('aiKeyInput').value;
      btn.disabled = true; btn.textContent = 'Saving…';
      try{
        await aiApi('PUT', '/config', { provider, model, apiKey });
        toast('AI configuration saved');
        renderAiSettingsTab(body);
      }catch(e){
        toast(e.message || 'Could not save AI configuration');
      }finally{
        btn.disabled = false; btn.textContent = 'Save';
      }
    });
    const removeBtn = document.getElementById('btnAiRemoveKey');
    if(removeBtn){
      removeBtn.addEventListener('click', async ()=>{
        if(!confirm('Remove the AI key for this organisation? AI Studio will stop working until a new key is added.')) return;
        removeBtn.disabled = true;
        try{
          await aiApi('DELETE', '/config');
          toast('AI key removed');
          renderAiSettingsTab(body);
        }catch(e){
          toast(e.message || 'Could not remove the AI key');
          removeBtn.disabled = false;
        }
      });
    }
  }).catch(e=>{
    body.innerHTML = `<div class="al-loading" style="padding:40px 0;text-align:center;color:var(--text-faint);font-size:13px;">Could not load AI configuration. ${escapeHtml(e.message||'')}</div>`;
  });
}
