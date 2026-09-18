/* ==================== SECTION:RENDERVIEW ==================== */
const HERO_GRAD = {
  get:'linear-gradient(135deg, var(--get), transparent)',
  post:'linear-gradient(135deg, var(--post), transparent)',
  put:'linear-gradient(135deg, var(--put), transparent)',
  patch:'linear-gradient(135deg, var(--patch), transparent)',
  delete:'linear-gradient(135deg, var(--delete), transparent)',
};

function gatherFormAsEndpoint(){
  const cleanRows = rows => rows.filter(r=>r.name.trim()).map(r=>({ name:r.name.trim(), type:r.type, required:!!r.required, example:r.example||'', description:r.description||'' }));
  const path = document.getElementById('mPath').value.trim() || '/untitled';
  const pathParamNames = new Set([...path.matchAll(/\{([^}]+)\}/g)].map(m=>m[1]));
  return {
    method: document.getElementById('mMethod').value,
    path,
    visibility: document.getElementById('mVisibility').value === 'public' ? 'public' : 'private',
    tag: document.getElementById('mTag').value.trim() || 'General',
    version: document.getElementById('mVersion').value.trim(),
    contentType: document.getElementById('mContentType').value.trim() || 'application/json',
    summary: document.getElementById('mSummary').value.trim(),
    description: document.getElementById('mDesc').value.trim(),
    parameters: cleanRows(builderParams).map(p=>({...p, in: pathParamNames.has(p.name) ? 'path' : 'query'})),
    headers: cleanRows(builderHeaders),
    requestBody: document.getElementById('mBody').value.trim()
      ? {
          example: document.getElementById('mBody').value.trim(),
          fields: cleanRows(builderParams),
          examples: builderReqExamples.filter(ex=>ex.name.trim() && ex.value.trim()).map(ex=>({ name:ex.name.trim(), value:ex.value.trim(), condition: sanitizeCondition(ex.condition) })),
        } : null,
    responses: builderResponses.map(r=>({
      code: parseInt(r.code,10) || 200,
      description: r.description || '',
      fields: cleanRows(r.fields),
      example: r.example || JSON.stringify(buildJsonFromRows(r.fields), null, 2),
      examples: (r.examples||[]).filter(ex=>ex.name.trim() && ex.value.trim()).map(ex=>({ name:ex.name.trim(), value:ex.value.trim() })),
    })),
  };
}

function gatherFormAsProjectStub(){
  const name = document.getElementById('mProject').value.trim() || 'Untitled API';
  const existing = allProjects().find(p=>p.name.toLowerCase() === name.toLowerCase());
  return existing || { name, environments: blankEnvironments(), auth: {type:'',headerName:'',description:''} };
}

/* ---------- Try it: fill in params, simulate a call, show the documented response ---------- */
let tryItContext = null;

// Postman-style Params/Headers/Body tab strip — see the .tryit-tabs markup.
// Body's tab button is hidden entirely (not just an empty panel) when the
// endpoint has no request body at all, same as a real Postman collection
// entry wouldn't show a Body tab for a plain GET.
function activateTryItTab(name){
  document.querySelectorAll('#tryItTabs [data-trytab]').forEach(btn=>{
    btn.classList.toggle('active', btn.getAttribute('data-trytab') === name);
  });
  document.getElementById('tryItParamsPanel').classList.toggle('active', name === 'params');
  document.getElementById('tryItAuthPanel').classList.toggle('active', name === 'auth');
  document.getElementById('tryItHeadersPanel').classList.toggle('active', name === 'headers');
  document.getElementById('tryItBodyPanel').classList.toggle('active', name === 'body');
  document.getElementById('tryItScriptsPanel').classList.toggle('active', name === 'scripts');
  document.getElementById('tryItSettingsPanel').classList.toggle('active', name === 'settings');
}

/* ---------- Try It body editor: line-number gutter ----------
   Keeps a plain <textarea> (so typing/selection/undo all stay native) and
   renders a synced line-number column next to it — same trick Postman's
   raw editor uses under the hood. Called on input and every time the body
   is set programmatically (scenario pick, endpoint open). */
/* ---------- Try It response toolbar: byte-size readout ----------
   Same "only show what's real" rule as everything else in this modal —
   this is the actual byte length of the text just rendered, not an
   estimate. */
function tryItSetRespSize(text){
  const el = document.getElementById('tryItRespSize');
  if(!el) return;
  const bytes = new Blob([text||'']).size;
  el.textContent = bytes < 1024 ? `${bytes} B` : `${(bytes/1024).toFixed(1)} KB`;
}

/* ---------- Response tabs: Body / Headers / Test Results ----------
   Same idea as the request-side tabs, scoped to the result card. Headers
   and Test Results are only ever populated with real data — synthesized
   from what this send actually produced (a real fetch's real headers in
   Live mode, or the one thing we can honestly say about a simulated
   response: what content type its documented body is) — never guessed. */
function activateTryItRespTab(name){
  document.querySelectorAll('#tryItRespTabs [data-resptab]').forEach(btn=>{
    btn.classList.toggle('active', btn.getAttribute('data-resptab') === name);
  });
  document.getElementById('tryItRespBodyPanel').classList.toggle('active', name === 'body');
  document.getElementById('tryItRespHeadersPanel').classList.toggle('active', name === 'headers');
  document.getElementById('tryItRespTestsPanel').classList.toggle('active', name === 'tests');
}
document.getElementById('tryItRespTabs').addEventListener('click', (e)=>{
  const btn = e.target.closest('[data-resptab]');
  if(btn) activateTryItRespTab(btn.getAttribute('data-resptab'));
});

function renderTryItResponseHeaders(headersObj){
  const entries = Object.entries(headersObj||{});
  const countEl = document.getElementById('tryItRespHeadersCount');
  countEl.textContent = String(entries.length);
  countEl.style.display = entries.length ? '' : 'none';
  const tableEl = document.getElementById('tryItRespHeadersTable');
  tableEl.innerHTML = entries.length ? `
    <div class="tryit-headers-table">
      <div class="tryit-headers-thead" style="grid-template-columns:1fr 2fr;"><span>Key</span><span>Value</span></div>
      ${entries.map(([k,v])=>`<div class="tryit-headers-trow" style="grid-template-columns:1fr 2fr;">
        <span class="tryit-headers-tkey"><span class="tryit-headers-tkey-chip">${escapeHtml(k)}</span></span>
        <span class="tryit-headers-tval">${escapeHtml(String(v))}</span>
      </div>`).join('')}
    </div>` : `<div class="hint">No response headers available for this send.</div>`;
}

function renderTryItTestResults(tests){
  const countEl = document.getElementById('tryItRespTestsCount');
  const passCount = tests.filter(t=>t.pass).length;
  countEl.textContent = `${passCount}/${tests.length}`;
  countEl.style.display = tests.length ? '' : 'none';
  const listEl = document.getElementById('tryItRespTestsList');
  const checkIc = '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
  const crossIc = '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
  listEl.innerHTML = tests.map(t=>`
    <div class="tryit-test-row ${t.pass?'pass':'fail'}">
      <span class="tryit-test-ic">${t.pass?checkIc:crossIc}</span>
      <div><div class="tryit-test-name">${escapeHtml(t.name)}</div>${t.detail?`<div class="tryit-test-detail">${escapeHtml(t.detail)}</div>`:''}</div>
    </div>`).join('');
}

// Reset to the Body tab every time a fresh result comes in, same as
// Postman focusing Body after a new send rather than leaving you on
// whatever tab a previous response happened to leave active.
function tryItResetRespTabs(){ activateTryItRespTab('body'); }

function tryItUpdateBodyGutter(){
  const ta = document.getElementById('tryItBodyInput');
  const gutter = document.getElementById('tryItBodyGutter');
  if(!ta || !gutter) return;
  const lineCount = (ta.value.match(/\n/g)||[]).length + 1;
  let out = '';
  for(let i=1;i<=lineCount;i++) out += i + (i<lineCount ? '\n' : '');
  gutter.textContent = out;
  gutter.scrollTop = ta.scrollTop;
}

/* ---------- Try It flow strip state ----------
   Sets one node (and the line leading INTO it) to 'done' | 'pending' | 'error'
   | idle (no class). Never called with a state that didn't really happen —
   e.g. 'token':'done' only fires once a documented auth response example
   actually produced a token, same honesty rule as everything else in Try It. */
function setTryItFlowNode(node, status){
  const el = document.querySelector(`#tryItFlow [data-flow-node="${node}"]`);
  if(!el) return;
  el.classList.remove('done','pending','error');
  if(status) el.classList.add(status);
  const lineMap = { condition:'doc-cond', token:'cond-token', header:'token-header', request:'header-req', response:'req-resp' };
  const lineEl = document.querySelector(`#tryItFlow [data-flow-line="${lineMap[node]}"]`);
  if(lineEl) lineEl.classList.toggle('done', status === 'done');
}
function resetTryItFlow(){
  ['condition','token','header','request','response'].forEach(n=>setTryItFlowNode(n, null));
}

/* ---------- Auth tab: simulated token generation ----------
   State lives on tryItContext so it resets whenever a new endpoint is
   opened. Nothing here ever leaves the browser or invents a token — it
   parses proj.auth.responseExample (the same JSON a person typed into
   Project Settings → Authentication → "Response parameters" preview) and
   reads a token-shaped field out of it, exactly like the response matcher
   reads a documented example instead of guessing one. */
function tryItHasTokenAuth(proj){
  return !!(proj.auth && proj.auth.type && proj.auth.path);
}

function renderTryItAuthPanel(proj, ep){
  const panel = document.getElementById('tryItAuthPanel');
  const tabBtn = document.getElementById('tryItTabBtnAuth');
  if(!tryItHasTokenAuth(proj)){
    tabBtn.style.display = 'none';
    panel.innerHTML = '';
    return;
  }
  tabBtn.style.display = '';
  panel.innerHTML = `
    <div class="tryit-auth-type-row">
      <label>Type</label>
      <button type="button" class="tryit-auth-type-pill" id="tryItAuthTypeInfo" title="Click for why this can't be changed here">
        ${escapeHtml(proj.auth.type)} <span class="tryit-auth-type-caret">▾</span>
      </button>
    </div>
    <div class="tryit-auth-card">
      <div class="tryit-auth-card-label">Configure New Token</div>
      <div class="tryit-auth-head">
        <span class="badge ${methodClass(proj.auth.method||'POST')}">${escapeHtml(proj.auth.method||'POST')}</span>
        <span class="tryit-auth-endpoint">${escapeHtml(proj.auth.path)}</span>
      </div>
      <div class="tryit-auth-desc">${proj.auth.description ? escapeHtml(proj.auth.description) : `This endpoint requires ${escapeHtml(proj.auth.type)}${proj.auth.headerName ? ' via the '+escapeHtml(proj.auth.headerName)+' header' : ''}.`}</div>
      <button type="button" class="tryit-auth-genbtn" id="tryItGenTokenBtn">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"></path></svg>
        Get New Access Token
      </button>
      <div id="tryItAuthWaterfall" class="tryit-waterfall"></div>
    </div>`;
  document.getElementById('tryItGenTokenBtn').addEventListener('click', ()=>generateTryItToken(proj, ep));
  document.getElementById('tryItAuthTypeInfo').addEventListener('click', ()=>{
    toast(`Auth type is fixed to ${proj.auth.type} — set in Project Settings → Authentication for this API, not per-request.`);
  });
}

function tryItWaterfallStepHtml(id, status, label, meta, detail){
  return `<div class="tryit-waterfall-step ${status}" data-wf-step="${id}">
    <div class="tryit-waterfall-row" data-wf-toggle="${id}">
      <span class="tryit-waterfall-ic"></span>
      <span class="tryit-waterfall-label">${escapeHtml(label)}</span>
      <span class="tryit-waterfall-meta">${escapeHtml(meta||'')}</span>
    </div>
    <div class="tryit-waterfall-detail">${detail||''}</div>
  </div>`;
}

function generateTryItToken(proj, ep){
  const waterfallEl = document.getElementById('tryItAuthWaterfall');
  const btn = document.getElementById('tryItGenTokenBtn');
  btn.disabled = true;
  setTryItFlowNode('token', 'pending');
  waterfallEl.innerHTML = tryItWaterfallStepHtml('token', 'pending',
    `${(proj.auth.method||'POST')} ${proj.auth.path}`, 'Sending…');

  setTimeout(()=>{
    const parsed = proj.auth.responseExample ? tryParseJson(proj.auth.responseExample) : { ok:false };
    const body = parsed.ok ? parsed.value : null;
    const tokenField = body && typeof body === 'object'
      ? (body.token || body.access_token || body.accessToken || null) : null;

    btn.disabled = false;
    if(!tokenField){
      setTryItFlowNode('token', 'error');
      waterfallEl.innerHTML = tryItWaterfallStepHtml('token', 'error',
        `${(proj.auth.method||'POST')} ${proj.auth.path}`, 'No token in doc',
        `<pre class="code-block" style="margin:8px 0 0;">This auth endpoint has no documented response example with a token/access_token field yet — add one under Project Settings → Authentication → Response parameters.</pre>`);
      return;
    }

    tryItContext.generatedToken = String(tokenField);
    setTryItFlowNode('token', 'done');
    setTryItFlowNode('header', 'done');
    const masked = maskSecretValue(tryItContext.generatedToken);
    waterfallEl.innerHTML = tryItWaterfallStepHtml('token', 'done',
      `${(proj.auth.method||'POST')} ${proj.auth.path}`, '200 · simulated',
      `<div class="hint" style="margin:0 0 4px;">Response (from documented example)</div><pre class="code-block">${escapeHtml(JSON.stringify(body, null, 2))}</pre>`)
      + `<div class="tryit-token-chip"><span>${(proj.auth.headerName||'Authorization')}: ${escapeHtml(maskSecretValue((proj.auth.headerName||'').toLowerCase()==='authorization' || !proj.auth.headerName ? 'Bearer '+tryItContext.generatedToken : tryItContext.generatedToken))}</span><button type="button" class="tryit-copy-btn" onclick="navigator.clipboard&&navigator.clipboard.writeText('${escapeHtml(tryItContext.generatedToken)}')">Copy</button></div>`;
    document.querySelectorAll('[data-wf-toggle]').forEach(row=>{
      row.addEventListener('click', ()=> row.closest('.tryit-waterfall-step').classList.toggle('open'));
    });
    renderTryItHeadersTable();
  }, 500);
}
document.getElementById('tryItTabs').addEventListener('click', (e)=>{
  const btn = e.target.closest('[data-trytab]');
  if(btn) activateTryItTab(btn.getAttribute('data-trytab'));
});

/* ---------- Standalone Try It collection sidebar ----------
   Postman-style: one collapsible group per project ("collection"), one row
   per endpoint. Only ever visible in the standalone Try It tab (see the
   body.tryit-standalone CSS) — built from the same allProjects()/
   viewEndpoints() data the real docs sidebar uses, so it's never a second
   source of truth for what endpoints exist. Clicking a row swaps
   tryItContext in place via openTryItModal() instead of navigating, so nothing
   about the tab (scroll position, the rest of the sidebar) resets. */
let tryItSidebarCollapsed = new Set();

function renderTryItSidebar(filterText){
  const listEl = document.getElementById('tryItSidebarList');
  if(!listEl) return;
  const q = (filterText||'').trim().toLowerCase();
  const activeEpId = tryItContext ? tryItContext.ep.id : null;

  const html = allProjects().map(proj=>{
    const eps = viewEndpoints(proj).filter(ep=>{
      if(!q) return true;
      return (ep.path||'').toLowerCase().includes(q) || (ep.name||'').toLowerCase().includes(q) || proj.name.toLowerCase().includes(q);
    });
    if(!eps.length) return '';
    const collapsed = tryItSidebarCollapsed.has(proj.id);
    return `<div class="tryit-sidebar-proj${collapsed?' collapsed':''}" data-proj-id="${escapeHtml(proj.id)}">
      <div class="tryit-sidebar-proj-head" data-toggle-proj="${escapeHtml(proj.id)}">
        <span class="tryit-sidebar-proj-caret">▾</span><span>${escapeHtml(proj.name)}</span>
      </div>
      <div class="tryit-sidebar-eps">
        ${eps.map(ep=>`<div class="tryit-sidebar-ep${ep.id===activeEpId?' active':''}" data-ep-id="${escapeHtml(ep.id)}" data-proj-id="${escapeHtml(proj.id)}">
          <span class="tryit-sidebar-ep-method" style="color:var(--${methodClass(ep.method)});">${escapeHtml((ep.method||'').toUpperCase())}</span>
          <span class="tryit-sidebar-ep-name">${escapeHtml(ep.name || ep.path)}</span>
        </div>`).join('')}
      </div>
    </div>`;
  }).join('');

  listEl.innerHTML = html || `<div class="tryit-sidebar-empty">No endpoints match "${escapeHtml(filterText||'')}"</div>`;
}

document.getElementById('tryItSidebarSearch').addEventListener('input', (e)=>{
  renderTryItSidebar(e.target.value);
});

document.getElementById('tryItSidebarList').addEventListener('click', (e)=>{
  const toggleHead = e.target.closest('[data-toggle-proj]');
  if(toggleHead){
    const pid = toggleHead.getAttribute('data-toggle-proj');
    if(tryItSidebarCollapsed.has(pid)) tryItSidebarCollapsed.delete(pid); else tryItSidebarCollapsed.add(pid);
    renderTryItSidebar(document.getElementById('tryItSidebarSearch').value);
    return;
  }
  const epRow = e.target.closest('[data-ep-id]');
  if(epRow){
    const proj = state.projects[epRow.getAttribute('data-proj-id')];
    const ep = proj && viewEndpoints(proj).find(e2=>e2.id===epRow.getAttribute('data-ep-id'));
    if(!proj || !ep || ep.id === (tryItContext && tryItContext.ep.id)) return;
    state.selected = { type:'endpoint', id: ep.id, tryIt:false };
    history.replaceState(null, '', buildTryItUrl(ep));
    openTryItModal(proj, ep);
    document.getElementById('tryItModal').scrollTop = 0;
  }
});

function openTryItModal(proj, ep){
  tryItContext = { proj, ep, generatedToken: null, pathRows: [], queryRows: [], headerRows: [] };
  resetTryItFlow();
  renderTryItAuthPanel(proj, ep);

  // Keep the collection sidebar's active row in sync, whether this call came
  // from a deep link's auto-open or from clicking a different endpoint in
  // the sidebar itself.
  if(document.body.classList.contains('tryit-standalone')){
    const searchEl = document.getElementById('tryItSidebarSearch');
    renderTryItSidebar(searchEl ? searchEl.value : '');
  }

  document.getElementById('tryItMethodBadge').className = 'badge badge-lg ' + methodClass(ep.method);
  document.getElementById('tryItMethodBadge').textContent = ep.method;
  document.getElementById('tryItPath').textContent = ep.path;

  // Same masked-host convention as everywhere else in the app (see displayUrl) —
  // Try It shouldn't be the one place that leaks the real environment host to
  // a non-Admin viewer just because they opened the tester.
  document.getElementById('tryItUrlPreview').textContent =
    `${envMeta(state.env).label} → ${envVarToken(state.env)}${pathWithParams(ep)}${queryString(ep)}`;

  const pathParamDefs = (ep.parameters||[]).filter(p=>p.in==='path');
  const queryParamDefs = (ep.parameters||[]).filter(p=>!p.in || p.in==='query');

  tryItContext.pathRows = pathParamDefs.map(p=>({
    key: p.name, value: String(exampleValueFor(p.type, p.example)), description: p.description||'', type: p.type||'string',
  }));
  tryItContext.queryRows = queryParamDefs.map(p=>({
    key: p.name, value: String(exampleValueFor(p.type, p.example)), description: p.description||'',
    type: p.type||'string', enabled:true, required: !!p.required, deletable:false,
  }));
  tryItContext.queryRows.push(makeEmptyParamRow());

  document.getElementById('tryItNoParams').style.display = (pathParamDefs.length || queryParamDefs.length) ? 'none' : '';
  renderTryItParamsPanel();

  /* ---- Request body + scenario picker ----
     ep.requestBody.example is the "Default" scenario; ep.requestBody.examples
     is a list of named alternates (e.g. "Amount too low"). Each response can
     carry the same names in its own .examples list — that's how a request
     scenario gets paired to the response it should produce. */
  const bodyInputEl = document.getElementById('tryItBodyInput');
  const bodyErrEl = document.getElementById('tryItBodyErr');
  const scenarioPickerEl = document.getElementById('tryItScenarioPicker');
  bodyErrEl.style.display = 'none';

  const namedRequestExamples = tryItRequestScenarios(ep);
  const responseScenariosForPicker = tryItResponseScenarios(ep);
  document.getElementById('tryItTabBtnBody').style.display = namedRequestExamples.length ? '' : 'none';
  if(namedRequestExamples.length){
    // Pills instead of a plain <select> — same control language as the doc
    // viewer's own scenario picker, each dot/border coloured off the status
    // code that scenario actually resolves to (see respColorVar below).
    scenarioPickerEl.innerHTML = namedRequestExamples.map((s,i)=>{
      const matchedResp = responseScenariosForPicker.find(rs=>rs.name.trim().toLowerCase()===s.name.trim().toLowerCase());
      const accentVar = matchedResp ? respColorVar(matchedResp.code) : '--accent';
      const condLabel = s.condition ? describeCondition(s.condition) : '';
      return `<div class="resp-pill${i===0?' active':''}" data-scenario-name="${escapeHtml(s.name)}" style="--pill-accent:var(${accentVar});" ${condLabel?`title="Condition: ${escapeHtml(condLabel)}"`:''}><span class="dot" style="background:var(${accentVar});"></span><span class="mono" style="font-weight:700;">${escapeHtml(s.name)}</span>${condLabel?`<span class="mono" style="font-size:10px;color:var(--text-faint);margin-left:6px;">${escapeHtml(condLabel)}</span>`:''}</div>`;
    }).join('');
    scenarioPickerEl.style.display = namedRequestExamples.length > 1 ? '' : 'none';
    bodyInputEl.value = namedRequestExamples[0].value;
  } else {
    scenarioPickerEl.innerHTML = '';
    bodyInputEl.value = '';
  }
  tryItUpdateBodyGutter();

  document.getElementById('tryItRunAll').style.display = namedRequestExamples.length > 1 ? '' : 'none';
  document.getElementById('tryItRunAllResults').style.display = 'none';
  document.getElementById('tryItRunAllResults').innerHTML = '';

  document.getElementById('tryItResult').style.display = 'none';
  document.getElementById('tryItEmptyState').style.display = '';
  tryItResetRespTabs();
  const sendBtnInit = document.getElementById('tryItSend');
  sendBtnInit.disabled = false;
  sendBtnInit.classList.remove('loading');
  document.getElementById('tryItSendLabel').textContent = 'Send';

  // Default tab: Body when there's a request body to fill in (the common,
  // Razorpay-style POST case this whole redesign is about), otherwise
  // Params, matching what a person actually needs to look at first.
  activateTryItTab(namedRequestExamples.length ? 'body' : 'params');

  // Live mode: only offered at all when an Admin has granted THIS user
  // access to THIS environment (see /api/live-mode/my-access, loaded once at
  // boot into state.liveModeEnvs) — never shown as a dead/disabled control
  // to someone who couldn't use it anyway.
  const liveWrap = document.getElementById('tryItLiveWrap');
  const liveToggle = document.getElementById('tryItLiveToggle');
  const canGoLive = Array.isArray(state.liveModeEnvs) && state.liveModeEnvs.includes(state.env);
  liveWrap.style.display = canGoLive ? 'flex' : 'none';
  liveToggle.checked = false; // always opens back to simulated — never remembers "live" as a default
  tryItContext.headerRows = buildInitialHeaderRows(proj, ep);
  renderTryItHeadersTable();
  closeTryItHistoryPanel();
  renderTryItHistoryBadge();
  liveToggle.onchange = () => {
    // Flipping the toggle either way clears any typed value for the secret
    // (auth) row — this app never carries a real credential across modes,
    // so re-entering Live always starts that field blank again.
    tryItContext.headerRows.forEach(r=>{ if(r.isSecret) r.value = ''; });
    renderTryItHeadersTable();
    // Turning Live on means the very next thing this person needs to do is
    // fill in a real credential — jump them straight to where that input
    // lives instead of leaving them on whichever tab they happened to be on.
    if(liveToggle.checked) activateTryItTab('headers');
  };

  document.getElementById('tryItModal').classList.add('show');
}

/* ---------- Headers tab: a single Postman-style editable table ----------
   One table, always. Rows seed from the SAME headerList(proj, ep) used for
   the cURL/code samples elsewhere in the app, so "documented headers" is
   never a second, drifting source of truth — but from there every cell
   (key/value/description), the checkbox, and an add/delete row are fully
   live-editable, exactly like a real Postman request.
     - simulated (Live off): values start as the documented example, masked
       the same way as the rest of the app; editing them only changes what
       the "Request sent" preview below shows.
     - live (toggle on): the exact same table IS the outbound request. The
       one row tied to this project's auth header is always blanked out
       when Live turns on — this app never stores a real credential, so
       that field is supplied fresh for this one send only. */
function makeEmptyHeaderRow(){ return { key:'', value:'', description:'', enabled:true, deletable:true, isSecret:false, required:false, error:false, ghost:true }; }

function buildInitialHeaderRows(proj, ep){
  const rows = headerList(proj, ep).map(([k,v,desc,required])=>({
    key:k, value:v, description:desc||'', enabled:true, deletable:true, required:!!required, error:false,
    isSecret: !!(proj.auth && proj.auth.headerName && k === proj.auth.headerName),
  }));
  rows.push(makeEmptyHeaderRow());
  return rows;
}

function renderTryItHeadersTable(){
  if(!tryItContext) return;
  const rows = tryItContext.headerRows;
  const tableEl = document.getElementById('tryItHeadersReadonly');
  const liveOn = document.getElementById('tryItLiveToggle').checked;
  const genTok = tryItContext.generatedToken;
  const proj = tryItContext.proj;
  const realCount = rows.filter(r=>!r.ghost && r.key).length;

  const countBadge = document.getElementById('tryItHeadersCount');
  countBadge.textContent = String(realCount);
  countBadge.style.display = realCount ? '' : 'none';

  tableEl.innerHTML = `
    <div class="tryit-headers-table">
      <div class="tryit-headers-thead"><span></span><span>Key</span><span>Value</span><span>Description</span><span></span></div>
      ${rows.map((r,i)=>{
        const isGhost = !!r.ghost;
        let shownVal = r.value;
        if(!isGhost && r.isSecret && !liveOn && genTok){
          shownVal = maskSecretValue(r.value.toLowerCase().startsWith('bearer') ? `Bearer ${genTok}` : genTok);
        }
        return `<div class="tryit-headers-trow${(!isGhost && !r.enabled)?' disabled':''}${isGhost?' ghost':''}${r.error?' error':''}" data-row-idx="${i}">
          ${isGhost ? '<span></span>' : `<input type="checkbox" class="tryit-headers-check" data-hdr-field="enabled" ${r.enabled?'checked':''}>`}
          <div class="tryit-headers-keycell">
            <input type="text" class="tryit-table-input mono" data-hdr-field="key" placeholder="${isGhost?'Key':''}" value="${escapeHtml(r.key)}">
            ${(!isGhost && r.required) ? '<span class="req-star" title="This header is documented as required for this endpoint">*</span>' : ''}
          </div>
          <input type="text" class="tryit-table-input mono" data-hdr-field="value" placeholder="${isGhost?'Value':(!isGhost && r.isSecret && liveOn ? authHeaderValue(proj) : '')}" value="${escapeHtml(shownVal)}">
          <input type="text" class="tryit-table-input" data-hdr-field="description" placeholder="${isGhost?'Description':''}" value="${escapeHtml(r.description)}">
          ${isGhost ? '<span></span>' : '<button type="button" class="tryit-row-delete" data-hdr-del title="Delete header">✕</button>'}
        </div>`;
      }).join('')}
    </div>
    ${(proj.auth && proj.auth.headerName && liveOn) ? `<div class="tryit-live-banner">This app never stores real credentials — the <span class="mono">${escapeHtml(proj.auth.headerName)}</span> value you type above is used for this one send only, never saved.</div>` : ''}
  `;
}

// Collects the headers Try It will actually send: every non-ghost, enabled
// row with a key, in table order. Used by both the simulated preview and
// the live-mode send, so there is exactly one place that decides "what
// headers go out", not three copies of the same filter.
function collectTryItHeaders(){
  if(!tryItContext) return [];
  return tryItContext.headerRows.filter(r=>!r.ghost && r.enabled && r.key.trim());
}

// Event delegation on the Headers table container: plain edits update state
// in place (no re-render, so focus/caret position survives typing); adding
// text to the trailing ghost row promotes it and appends a fresh ghost;
// the delete button splices a row out entirely.
document.getElementById('tryItHeadersReadonly').addEventListener('input', (e)=>{
  const input = e.target.closest('[data-hdr-field]');
  if(!input || !tryItContext) return;
  const rowEl = input.closest('[data-row-idx]');
  const idx = Number(rowEl.getAttribute('data-row-idx'));
  const field = input.getAttribute('data-hdr-field');
  const row = tryItContext.headerRows[idx];
  if(!row) return;
  const wasGhost = !!row.ghost;
  row[field] = input.value;
  if(field === 'value' && row.error && input.value.trim()) row.error = false;
  if(wasGhost && field === 'key' && input.value.trim()){
    row.ghost = false;
    row.deletable = true;
    if(idx === tryItContext.headerRows.length - 1) tryItContext.headerRows.push(makeEmptyHeaderRow());
    renderTryItHeadersTable();
    const fresh = tableRowInput('tryItHeadersReadonly', idx, 'key');
    if(fresh){ fresh.focus(); fresh.setSelectionRange(fresh.value.length, fresh.value.length); }
  }
});
document.getElementById('tryItHeadersReadonly').addEventListener('change', (e)=>{
  const cb = e.target.closest('[data-hdr-field="enabled"]');
  if(!cb || !tryItContext) return;
  const idx = Number(cb.closest('[data-row-idx]').getAttribute('data-row-idx'));
  if(tryItContext.headerRows[idx]){
    tryItContext.headerRows[idx].enabled = cb.checked;
    if(cb.checked) tryItContext.headerRows[idx].error = false;
  }
  renderTryItHeadersTable();
});
document.getElementById('tryItHeadersReadonly').addEventListener('click', (e)=>{
  const del = e.target.closest('[data-hdr-del]');
  if(!del || !tryItContext) return;
  const idx = Number(del.closest('[data-row-idx]').getAttribute('data-row-idx'));
  tryItContext.headerRows.splice(idx, 1);
  renderTryItHeadersTable();
});

// Small helper: after a re-render inside a table container, grab the input
// for a given row index + field so focus can be restored (e.g. right after
// a ghost row is promoted and a new one appended below it).
function tableRowInput(containerId, idx, field){
  const row = document.querySelector(`#${containerId} [data-row-idx="${idx}"]`);
  return row ? row.querySelector(`[data-hdr-field="${field}"], [data-param-field="${field}"]`) : null;
}

/* ---------- Params tab: Path Variables + Query Params, Postman-style ----------
   Two tables, matching how Postman itself splits these: Path Variables are
   fixed by the endpoint's own {placeholders} (no checkbox, no delete — you
   can't "turn off" part of the URL), Query Params are a fully editable,
   addable/removable, checkbox-toggleable table, same pattern as Headers. */
function makeEmptyParamRow(){ return { key:'', value:'', description:'', enabled:true, deletable:true, required:false, ghost:true }; }

function renderTryItParamsPanel(){
  if(!tryItContext) return;
  const wrap = document.getElementById('tryItParams');
  const pathRows = tryItContext.pathRows || [];
  const queryRows = tryItContext.queryRows || [];
  const enabledCount = pathRows.length + queryRows.filter(r=>!r.ghost && r.enabled && r.key.trim()).length;

  const countBadge = document.getElementById('tryItParamsCount');
  countBadge.textContent = String(enabledCount);
  countBadge.style.display = enabledCount ? '' : 'none';

  const pathTableHtml = pathRows.length ? `
    <div class="tryit-table-section-label">Path Variables</div>
    <div class="tryit-headers-table">
      <div class="tryit-headers-thead"><span></span><span>Key</span><span>Value</span><span>Description</span><span></span></div>
      ${pathRows.map((r,i)=>`
        <div class="tryit-headers-trow" data-path-idx="${i}">
          <span class="tryit-row-lock" title="Fixed by the URL">🔒</span>
          <input type="text" class="tryit-table-input mono" readonly value="${escapeHtml(r.key)}">
          <input type="text" class="tryit-table-input mono" data-path-field="value" value="${escapeHtml(r.value)}">
          <input type="text" class="tryit-table-input" data-path-field="description" readonly value="${escapeHtml(r.description)}">
          <span></span>
        </div>`).join('')}
    </div>` : '';

  const queryTableHtml = `
    <div class="tryit-table-section-label">Query Params</div>
    <div class="tryit-headers-table">
      <div class="tryit-headers-thead"><span></span><span>Key</span><span>Value</span><span>Description</span><span></span></div>
      ${queryRows.length ? queryRows.map((r,i)=>{
        const isGhost = !!r.ghost;
        return `<div class="tryit-headers-trow${(!isGhost && !r.enabled)?' disabled':''}${isGhost?' ghost':''}${r.error?' error':''}" data-row-idx="${i}">
          ${isGhost ? '<span></span>' : `<input type="checkbox" class="tryit-headers-check" data-param-field="enabled" ${r.enabled?'checked':''}>`}
          <div class="tryit-headers-keycell">
            <input type="text" class="tryit-table-input mono" data-param-field="key" placeholder="${isGhost?'Key':''}" value="${escapeHtml(r.key)}">
            ${(!isGhost && r.required) ? '<span class="req-star" title="Documented as a required query parameter">*</span>' : ''}
          </div>
          <input type="text" class="tryit-table-input mono" data-param-field="value" placeholder="${isGhost?'Value':''}" value="${escapeHtml(r.value)}">
          <input type="text" class="tryit-table-input" data-param-field="description" placeholder="${isGhost?'Description':''}" value="${escapeHtml(r.description)}">
          ${isGhost ? '<span></span>' : '<button type="button" class="tryit-row-delete" data-param-del title="Delete param">✕</button>'}
        </div>`;
      }).join('') : ''}
    </div>`;

  wrap.innerHTML = pathTableHtml + queryTableHtml;
}

// Collects what Try It will actually resolve into the URL: path
// substitutions plus enabled, non-empty query params, in table order.
function collectTryItParams(){
  if(!tryItContext) return { pathParams:{}, queryParams:[] };
  const pathParams = {};
  (tryItContext.pathRows||[]).forEach(r=>{ pathParams[r.key] = r.value; });
  const queryParams = (tryItContext.queryRows||[]).filter(r=>!r.ghost && r.enabled && r.key.trim()).map(r=>[r.key, r.value]);
  return { pathParams, queryParams };
}

document.getElementById('tryItParams').addEventListener('input', (e)=>{
  const pathInput = e.target.closest('[data-path-field]');
  if(pathInput && tryItContext){
    const idx = Number(pathInput.closest('[data-path-idx]').getAttribute('data-path-idx'));
    if(tryItContext.pathRows[idx]) tryItContext.pathRows[idx][pathInput.getAttribute('data-path-field')] = pathInput.value;
    return;
  }
  const input = e.target.closest('[data-param-field]');
  if(!input || !tryItContext) return;
  const idx = Number(input.closest('[data-row-idx]').getAttribute('data-row-idx'));
  const field = input.getAttribute('data-param-field');
  const row = tryItContext.queryRows[idx];
  if(!row) return;
  const wasGhost = !!row.ghost;
  row[field] = input.value;
  row.error = false;
  if(wasGhost && field === 'key' && input.value.trim()){
    row.ghost = false;
    row.deletable = true;
    if(idx === tryItContext.queryRows.length - 1) tryItContext.queryRows.push(makeEmptyParamRow());
    renderTryItParamsPanel();
    const fresh = tableRowInput('tryItParams', idx, 'key');
    if(fresh){ fresh.focus(); fresh.setSelectionRange(fresh.value.length, fresh.value.length); }
  }
});
document.getElementById('tryItParams').addEventListener('change', (e)=>{
  const cb = e.target.closest('[data-param-field="enabled"]');
  if(!cb || !tryItContext) return;
  const idx = Number(cb.closest('[data-row-idx]').getAttribute('data-row-idx'));
  if(tryItContext.queryRows[idx]) tryItContext.queryRows[idx].enabled = cb.checked;
  renderTryItParamsPanel();
});
document.getElementById('tryItParams').addEventListener('click', (e)=>{
  const del = e.target.closest('[data-param-del]');
  if(!del || !tryItContext) return;
  const idx = Number(del.closest('[data-row-idx]').getAttribute('data-row-idx'));
  tryItContext.queryRows.splice(idx, 1);
  renderTryItParamsPanel();
});

/* Named request-body scenarios for an endpoint: "Default" (the main example)
   plus any named alternates. Skips "Default" if there's no main example but
   named ones exist, so the picker never opens on an empty body. */
function tryItRequestScenarios(ep){
  const rb = ep.requestBody;
  if(!rb) return [];
  const list = [];
  if(rb.example && rb.example.trim()) list.push({ name:'Default', value:rb.example });
  (rb.examples||[]).forEach(ex=>{ if(ex.name && ex.value) list.push({ name:ex.name, value:ex.value, condition: ex.condition||null }); });
  return list;
}

// Returns the name of whichever scenario pill is currently active, or ''
// when there's no scenario picker for this endpoint (single/no named
// request examples) — used both when sending and when re-colouring the
// result card border.
function tryItSelectedScenarioName(){
  const active = document.querySelector('#tryItScenarioPicker .resp-pill.active');
  return active ? active.getAttribute('data-scenario-name') : '';
}

// Event delegation (not one listener per pill) since the pill row is
// rebuilt from scratch every time the modal opens for a different endpoint.
document.getElementById('tryItScenarioPicker').addEventListener('click', (e)=>{
  const pill = e.target.closest('.resp-pill');
  if(!pill) return;
  document.querySelectorAll('#tryItScenarioPicker .resp-pill').forEach(p=>p.classList.remove('active'));
  pill.classList.add('active');
  const scenarios = tryItRequestScenarios(tryItContext ? tryItContext.ep : {});
  const match = scenarios.find(s=>s.name===pill.getAttribute('data-scenario-name'));
  if(match) document.getElementById('tryItBodyInput').value = match.value;
  tryItUpdateBodyGutter();
  // Switching scenarios invalidates whatever was previously sent — hide it
  // rather than leave a stale response sitting under the newly-picked one.
  document.getElementById('tryItResult').style.display = 'none';
  document.getElementById('tryItRunAllResults').style.display = 'none';
  document.getElementById('tryItEmptyState').style.display = '';
});

function closeTryItModal(){
  // In the standalone Try It tab, #tryItModal IS the tab's entire content
  // (sidebar hidden, no docs page underneath) — hiding it here would leave
  // nothing but the topbar. Closing only makes sense for the floating
  // dialog opened from inside the docs page, so it's a no-op in standalone
  // mode; the Close button is hidden there too for the same reason (see
  // the body.tryit-standalone CSS block).
  if(document.body.classList.contains('tryit-standalone')) return;
  document.getElementById('tryItModal').classList.remove('show');
  tryItContext = null;
}

/* Deep-equality on parsed JSON — order-independent for object keys, so
   scenario matching isn't thrown off by re-ordering fields while editing. */
function deepEqualJson(a, b){
  if(a === b) return true;
  if(typeof a !== typeof b || a === null || b === null) return a === b;
  if(Array.isArray(a) || Array.isArray(b)){
    if(!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v,i)=>deepEqualJson(v, b[i]));
  }
  if(typeof a === 'object'){
    const ka = Object.keys(a), kb = Object.keys(b);
    if(ka.length !== kb.length) return false;
    return ka.every(k=>Object.prototype.hasOwnProperty.call(b,k) && deepEqualJson(a[k], b[k]));
  }
  return a === b;
}

/* Rough "how different are these two JSON values" score — counts keys that
   are missing, added, or hold a different value, recursing into nested
   objects. Used only as a tiebreaker when nothing matches exactly. Lower
   is closer; 0 means identical (deepEqualJson would already have caught that). */
function jsonDiffScore(a, b){
  if(deepEqualJson(a,b)) return 0;
  if(typeof a !== 'object' || typeof b !== 'object' || a===null || b===null || Array.isArray(a) !== Array.isArray(b)) return 1;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let score = 0;
  keys.forEach(k=>{
    if(!(k in a) || !(k in b)) { score += 1; return; }
    if(typeof a[k]==='object' && typeof b[k]==='object' && a[k] && b[k]) score += jsonDiffScore(a[k], b[k]);
    else if(a[k] !== b[k]) score += 1;
  });
  return score;
}

/* Every response tagged with a scenario name: the response's own "Default"
   (its main code/description/example) plus any named alternates in
   response.examples. A named example can carry its own status code and
   description now — falls back to the parent response block's when it
   doesn't, so older/simpler endpoints still work unchanged. */
function tryItResponseScenarios(ep){
  const out = [];
  (ep.responses||[]).forEach(r=>{
    if(r.example && r.example.trim()) out.push({ name:'Default', code:r.code, description:r.description, value:r.example, response:r });
    (r.examples||[]).forEach(ex=>{
      if(!ex.name || !ex.value) return;
      out.push({ name:ex.name, code: ex.statusCode || r.code, description: ex.description || r.description, value:ex.value, response:r });
    });
  });
  return out;
}

/* ---------- Response History (Postman-style, per endpoint) ----------
   Backed by state.requestHistory[endpointId] — already declared, persisted
   (PUT /request-history), and loaded on boot; this is the first thing that
   actually writes and reads it. Newest entry first, capped so it can't grow
   forever across a long session. */
const TRYIT_HISTORY_MAX = 10;

function tryItRelativeTime(ts){
  const diffSec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if(diffSec < 5) return 'just now';
  if(diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if(diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if(diffHr < 24) return `${diffHr}h ago`;
  const d = new Date(ts);
  return d.toLocaleString(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
}

function pushTryItHistory(ep, entry){
  if(!state.requestHistory[ep.id]) state.requestHistory[ep.id] = [];
  state.requestHistory[ep.id].unshift(entry);
  if(state.requestHistory[ep.id].length > TRYIT_HISTORY_MAX){
    state.requestHistory[ep.id].length = TRYIT_HISTORY_MAX;
  }
  saveState();
  renderTryItHistoryBadge();
  if(document.getElementById('tryItHistoryPanel').style.display !== 'none') renderTryItHistoryPanel();
}

function renderTryItHistoryBadge(){
  if(!tryItContext) return;
  const entries = state.requestHistory[tryItContext.ep.id] || [];
  const badge = document.getElementById('tryItHistoryCount');
  badge.textContent = String(entries.length);
  badge.style.display = entries.length ? '' : 'none';
}

function renderTryItHistoryPanel(){
  if(!tryItContext) return;
  const entries = state.requestHistory[tryItContext.ep.id] || [];
  const panel = document.getElementById('tryItHistoryPanel');
  if(!entries.length){
    panel.innerHTML = `<div class="tryit-history-empty">No requests sent yet for this endpoint this session.<br>Hit Send to build up history here.</div>`;
    return;
  }
  panel.innerHTML = entries.map((h,i)=>{
    const codeLabel = h.status ? String(h.status) : '—';
    const accentVar = h.status ? respColorVar(h.status) : '--text-faint';
    return `<div class="tryit-history-item" data-hist-idx="${i}">
      <span class="tryit-history-item-code" style="color:var(${accentVar});background:color-mix(in srgb, var(${accentVar}) 16%, transparent);">${escapeHtml(codeLabel)}</span>
      <div class="tryit-history-item-main">
        <div class="tryit-history-item-note"><span class="tryit-history-item-method" style="color:var(--${methodClass(h.method)});">${escapeHtml(h.method)}</span>${escapeHtml(h.note || h.path || '')}</div>
      </div>
      <span class="tryit-history-item-time">${escapeHtml(tryItRelativeTime(h.timestamp))}</span>
    </div>`;
  }).join('') + `<div class="tryit-history-panel-foot"><button type="button" class="tryit-history-clear" id="tryItHistoryClear">Clear history</button></div>`;
}

function closeTryItHistoryPanel(){
  document.getElementById('tryItHistoryPanel').style.display = 'none';
  document.getElementById('tryItRespHistory').classList.remove('active');
}

document.getElementById('tryItRespHistory').addEventListener('click', (e)=>{
  e.stopPropagation();
  const panel = document.getElementById('tryItHistoryPanel');
  const willOpen = panel.style.display === 'none';
  if(willOpen){
    renderTryItHistoryPanel();
    panel.style.display = '';
    document.getElementById('tryItRespHistory').classList.add('active');
  } else {
    closeTryItHistoryPanel();
  }
});

document.getElementById('tryItHistoryPanel').addEventListener('click', (e)=>{
  e.stopPropagation();
  if(e.target.id === 'tryItHistoryClear'){
    if(tryItContext) delete state.requestHistory[tryItContext.ep.id];
    saveState();
    renderTryItHistoryBadge();
    renderTryItHistoryPanel();
    return;
  }
  const item = e.target.closest('[data-hist-idx]');
  if(!item || !tryItContext) return;
  const entry = (state.requestHistory[tryItContext.ep.id] || [])[Number(item.getAttribute('data-hist-idx'))];
  if(!entry) return;
  restoreTryItHistoryEntry(entry);
  closeTryItHistoryPanel();
});

document.addEventListener('click', (e)=>{
  const wrap = document.getElementById('tryItHistoryWrap');
  if(wrap && !wrap.contains(e.target)) closeTryItHistoryPanel();
});

// Re-renders the response card from a stored history entry — read-only
// playback, not a re-send. Clearly labelled as history so it's never
// mistaken for a fresh Send.
function restoreTryItHistoryEntry(entry){
  const resultEl = document.getElementById('tryItResult');
  const resultCardEl = document.getElementById('tryItResultCard');
  const notDocCardEl = document.getElementById('tryItNotDocCard');
  const codeEl = document.getElementById('tryItStatusCode');
  const bodyEl = document.getElementById('tryItResponseBody');
  const latencyEl = document.getElementById('tryItLatency');
  const matchNoteEl = document.getElementById('tryItMatchNote');

  document.getElementById('tryItEmptyState').style.display = 'none';
  resultEl.style.display = '';
  document.getElementById('tryItRequestPreview').textContent = entry.requestPreview || '';

  if(!entry.status){
    resultCardEl.style.display = 'none';
    notDocCardEl.style.display = '';
    document.getElementById('tryItNotDocBody').textContent = entry.note || 'No documented response matched this request.';
    return;
  }
  notDocCardEl.style.display = 'none';
  resultCardEl.style.display = '';
  codeEl.textContent = String(entry.status);
  codeEl.className = 'code-pill ' + respClass(entry.status);
  resultCardEl.style.setProperty('--item-accent', `var(${respColorVar(entry.status)})`);
  bodyEl.textContent = entry.bodyText || '';
  tryItSetRespSize(bodyEl.textContent);
  tryItResetRespTabs();
  renderTryItResponseHeaders(entry.bodyText ? { 'Content-Type': 'application/json' } : {});
  renderTryItTestResults([
    { name: `Status code is ${entry.status}`, pass: true, detail: 'From history — replayed, not re-sent.' },
  ]);
  matchNoteEl.textContent = `Viewing history · sent ${tryItRelativeTime(entry.timestamp)}`;
  matchNoteEl.title = matchNoteEl.textContent;
  latencyEl.textContent = entry.timeMs ? `Simulated from documented example · ${entry.timeMs} ms` : '';
}

function sendTryIt(){
  if(!tryItContext) return;
  const { proj, ep } = tryItContext;
  const sendBtn = document.getElementById('tryItSend');
  const bodyErrEl = document.getElementById('tryItBodyErr');
  bodyErrEl.style.display = 'none';
  setTryItFlowNode('request', 'pending');
  setTryItFlowNode('response', null);
  if(tryItHasTokenAuth(proj) && !tryItContext.generatedToken) setTryItFlowNode('header', null);

  // Basic required-field validation before "sending" — every path variable
  // is implicitly required (it's part of the URL), plus any query param
  // documented as required that's still enabled.
  for(const row of (tryItContext.pathRows||[])){
    if(!row.value.trim()){ toast(`${row.key} is required`); return; }
  }
  for(const row of (tryItContext.queryRows||[])){
    if(!row.ghost && row.enabled && row.required && !row.value.trim()){
      row.error = true;
      renderTryItParamsPanel();
      toast(`${row.key} is required`);
      return;
    }
  }
  // Same rule for headers: a header documented as required (including the
  // structural Content-Type/Auth rows) has to be enabled with a value, or
  // this send is refused before anything is "sent" — same as unchecking a
  // required header in Postman would earn you a 4xx from the real API, this
  // tool refuses up front instead of silently returning the success example.
  for(const row of (tryItContext.headerRows||[])){
    row.error = false;
  }
  for(const row of (tryItContext.headerRows||[])){
    if(!row.ghost && row.required && (!row.enabled || !row.value.trim())){
      row.error = true;
      renderTryItHeadersTable();
      activateTryItTab('headers');
      toast(`${row.key} is required`);
      return;
    }
  }

  // Parse the request body, if this endpoint documents one
  const requestScenarios = tryItRequestScenarios(ep);
  let typedBody = null;
  if(requestScenarios.length){
    const raw = document.getElementById('tryItBodyInput').value;
    if(raw.trim()){
      const parsed = tryParseJson(raw);
      if(!parsed.ok){
        bodyErrEl.textContent = "Request body isn't valid JSON — check for a missing comma or quote.";
        bodyErrEl.style.display = '';
        return;
      }
      typedBody = parsed.value;
    }
  }

  // Live mode takes a completely separate path — no scenario matching, no
  // simulated latency, a real outbound call via the server-side proxy. See
  // sendTryItLive(). Only reachable at all when the toggle is visible, which
  // only happens when this user has a Live mode grant for this environment.
  if(document.getElementById('tryItLiveToggle').checked){
    sendTryItLive(proj, ep, typedBody);
    return;
  }

  sendBtn.disabled = true;
  sendBtn.classList.add('loading');
  document.getElementById('tryItSendLabel').textContent = 'Sending…';

  setTimeout(()=>{
    const resultEl = document.getElementById('tryItResult');
    const resultCardEl = document.getElementById('tryItResultCard');
    const bodyEl = document.getElementById('tryItResponseBody');
    const codeEl = document.getElementById('tryItStatusCode');
    const latencyEl = document.getElementById('tryItLatency');
    const matchNoteEl = document.getElementById('tryItMatchNote');
    matchNoteEl.textContent = '';

    const notDocCardEl = document.getElementById('tryItNotDocCard');
    const notDocBodyEl = document.getElementById('tryItNotDocBody');

    const responseScenarios = tryItResponseScenarios(ep);
    let matched = null;
    let matchKind = null; // 'picked' | 'condition' | 'exact' | 'documented' — every one of these means the response shown is real documentation, never a guess.

    // Closest documented request scenario by field diff — no longer used to
    // pick a response (see below), only kept to explain, in the "Not
    // documented" state, which documented scenario this request is nearest
    // to and exactly how it differs. Purely informational.
    let closestRequestScenario = null, closestRequestScore = Infinity;
    if(typedBody !== null && requestScenarios.length){
      requestScenarios.forEach(s=>{
        const p = tryParseJson(s.value);
        if(!p.ok) return;
        const score = jsonDiffScore(p.value, typedBody);
        if(score < closestRequestScore){ closestRequestScore = score; closestRequestScenario = s; }
      });
    }

    // 1) Whichever scenario pill is actively selected wins outright, BUT
    //    only while the body still matches that pill's own documented
    //    example. The moment someone hand-edits the body away from it (e.g.
    //    typing 10 under the "Default" pill to probe the ₹100 minimum),
    //    the pick is stale and step 2's condition check below should decide
    //    instead — otherwise a highlighted pill can silently override
    //    whatever the person actually typed, which is what made editing the
    //    amount look like it did nothing to the status code shown below.
    const pickerName = tryItSelectedScenarioName().trim().toLowerCase();
    if(pickerName){
      const pickedReq = requestScenarios.find(s=>s.name.trim().toLowerCase() === pickerName);
      const pickedReqParsed = pickedReq ? tryParseJson(pickedReq.value) : { ok:false };
      const bodyStillMatchesPick = typedBody === null
        ? !pickedReq // no body at all only "matches" a pick that has no example either
        : (pickedReqParsed.ok && deepEqualJson(pickedReqParsed.value, typedBody));
      if(bodyStillMatchesPick){
        const picked = responseScenarios.find(rs=>rs.name.trim().toLowerCase() === pickerName);
        if(picked){ matched = picked; matchKind = 'picked'; }
      }
    }

    // 2) Otherwise, check every documented scenario that carries a condition
    //    (e.g. "amount < 100") against the actual submitted body. This is
    //    what makes the match dynamic instead of requiring the typed body to
    //    be byte-for-byte identical to a stored example — changing the
    //    amount now changes which scenario applies, per the documented rule,
    //    not per a fixed JSON blob. Overlapping conditions (a doc gap) are
    //    resolved deterministically by picking the narrowest range.
    let conditionMatch = null;
    if(!matched && typedBody !== null){
      const condMatches = matchConditionScenarios(requestScenarios, typedBody);
      conditionMatch = narrowestConditionMatch(condMatches);
      if(conditionMatch){
        const condResp = responseScenarios.find(rs=>rs.name.trim().toLowerCase() === conditionMatch.name.trim().toLowerCase());
        if(condResp){ matched = condResp; matchKind = 'condition'; }
      }
    }

    // 3) Otherwise, an exact match against a named request example → use the
    //    response scenario that shares that name, if one's documented.
    if(!matched && typedBody !== null){
      const exactReq = requestScenarios.find(s=>{ const p = tryParseJson(s.value); return p.ok && deepEqualJson(p.value, typedBody); });
      if(exactReq){
        const exactResp = responseScenarios.find(rs=>rs.name.trim().toLowerCase() === exactReq.name.trim().toLowerCase());
        if(exactResp){ matched = exactResp; matchKind = 'exact'; }
      }
    }

    // 4) An endpoint with NO request-body scenarios documented at all (e.g. a
    //    plain GET) has nothing for a request to be checked against — its one
    //    documented response IS the documentation, not a guess among options.
    //    This is the ONLY remaining fallback; it deliberately does not apply
    //    once requestScenarios.length > 0, because at that point a real
    //    request/response pairing exists and "close enough" is exactly the
    //    silent-guessing behaviour this was rebuilt to remove.
    if(!matched && requestScenarios.length === 0){
      const onlyDocumented = responseScenarios.find(rs=>String(rs.code)[0]==='2') || responseScenarios[0];
      if(onlyDocumented){ matched = onlyDocumented; matchKind = 'documented'; }
    }

    document.getElementById('tryItRequestPreview').textContent = buildTryItResolvedRequestPreview(proj, ep, typedBody);
    setTryItFlowNode('request', 'done');
    setTryItFlowNode('condition', matchKind === 'condition' ? 'done' : (matchKind ? 'done' : null));

    if(matched){
      resultCardEl.style.display = '';
      notDocCardEl.style.display = 'none';
      setTryItFlowNode('response', 'done');
      codeEl.textContent = String(matched.code);
      codeEl.className = 'code-pill ' + respClass(matched.code);
      resultCardEl.style.setProperty('--item-accent', `var(${respColorVar(matched.code)})`);
      const parsed = matched.value ? tryParseJson(matched.value) : { ok:false };
      bodyEl.textContent = parsed.ok ? JSON.stringify(parsed.value, null, 2) : (matched.value || 'No example body documented for this response.');
      tryItSetRespSize(bodyEl.textContent);
      tryItResetRespTabs();
      // The only response header this app can honestly claim without a real
      // network call: the content type implied by the documented body being
      // JSON. Everything else about a simulated response is intentionally
      // left unshown rather than invented.
      renderTryItResponseHeaders(parsed.ok ? { 'Content-Type': 'application/json' } : {});
      renderTryItTestResults([
        { name: `Status code is ${matched.code}`, pass: true, detail: 'From the documented example for this scenario.' },
        { name: 'Response has a body', pass: !!(bodyEl.textContent && bodyEl.textContent.trim()), detail: null },
      ]);
      if(matchKind === 'picked') matchNoteEl.textContent = `Matched scenario: ${matched.name}`;
      else if(matchKind === 'condition') matchNoteEl.textContent = `Matched scenario: ${matched.name} — condition ${describeCondition(conditionMatch.condition)} was true for this request`;
      else if(matchKind === 'exact' && matched.name !== 'Default') matchNoteEl.textContent = `Matched scenario: ${matched.name}`;
      else matchNoteEl.textContent = '';
      matchNoteEl.title = matchNoteEl.textContent;
      const simulatedMs = Math.round(180 + Math.random()*140);
      latencyEl.textContent = `Simulated from documented example · ${simulatedMs} ms`;
      // Force the fade/slide-in to replay on every send, not just the first —
      // the animation class never toggles off/on by itself once the element's
      // already visible, so without this a "Send again" click would just
      // update the numbers in place with no visual confirmation anything happened.
      resultCardEl.style.animation = 'none';
      void resultCardEl.offsetWidth;
      resultCardEl.style.animation = '';
      pushTryItHistory(ep, {
        method: ep.method, path: ep.path, status: matched.code, timeMs: simulatedMs,
        note: matched.name && matched.name !== 'Default' ? `${ep.path} — ${matched.name}` : ep.path,
        bodyText: bodyEl.textContent, requestPreview: document.getElementById('tryItRequestPreview').textContent,
        timestamp: Date.now(),
      });
    } else {
      // Nothing documented matches this exact request — show NO response at
      // all (never a guess), just a clear empty state and a way to fix it.
      resultCardEl.style.display = 'none';
      notDocCardEl.style.display = '';
      setTryItFlowNode('response', 'error');
      if(requestScenarios.length === 0){
        notDocBodyEl.textContent = `This endpoint doesn't have a documented response yet.`;
      } else if(typedBody === null){
        notDocBodyEl.textContent = `This endpoint documents ${requestScenarios.length} request scenario${requestScenarios.length===1?'':'s'} with a body — send one of them, or a request that matches one exactly, to see its documented response.`;
      } else if(closestRequestScenario){
        const p = tryParseJson(closestRequestScenario.value);
        const diffs = p.ok ? describeJsonDiff(p.value, typedBody) : [];
        notDocBodyEl.innerHTML = diffs.length ? `This exact request hasn't been documented. The closest documented scenario is <span class="mono">"${escapeHtml(closestRequestScenario.name)}"</span> — it differs in:
          <ul style="margin:6px 0 0; padding-left:18px;">
            ${diffs.map(d=>`<li><span class="mono">${escapeHtml(d.path)}</span> — documented: <span class="mono">${escapeHtml(d.docLabel)}</span>, you sent: <span class="mono">${escapeHtml(d.sentLabel)}</span></li>`).join('')}
          </ul>` : `This exact request hasn't been documented yet for this endpoint.`;
      } else {
        notDocBodyEl.textContent = `This exact request doesn't match any documented scenario for this endpoint.`;
      }
      document.getElementById('tryItEditInStudio').onclick = ()=>editInStudioFromTryIt(proj, ep, typedBody, closestRequestScenario);
      pushTryItHistory(ep, {
        method: ep.method, path: ep.path, status: null, timeMs: null,
        note: `${ep.path} — not documented`, bodyText: '', requestPreview: document.getElementById('tryItRequestPreview').textContent,
        timestamp: Date.now(),
      });
    }

    resultEl.style.display = '';
    document.getElementById('tryItEmptyState').style.display = 'none';
    sendBtn.disabled = false;
    sendBtn.classList.remove('loading');
    document.getElementById('tryItSendLabel').textContent = 'Send again';
  }, 450);
}

/* One-level field diff for the Try It "Not documented" empty state —
   deliberately shallow (nested objects/arrays are compared as whole values,
   not key-by-key) since this drives a human-readable summary, not a merge. */
/* Live mode: an actual outbound HTTP call via the server-side proxy
   (POST /api/live-mode/send), gated entirely server-side by that user's
   grant for this environment — the toggle is only ever visible client-side
   when state.liveModeEnvs already says they have one, but the server checks
   again regardless. Deliberately its own code path rather than a branch
   inside the simulate flow below: no scenario matching, no simulated
   latency, and a visually distinct "not simulated" result so it can never
   be mistaken for a documented example. */
async function sendTryItLive(proj, ep, typedBody){
  const sendBtn = document.getElementById('tryItSend');

  // The auth header is never pre-filled with a real value (this app doesn't
  // store one) — block before even asking for confirmation if it's still empty.
  const headerRowsForSend = collectTryItHeaders();
  const headersObj = {};
  const secretHeaderNames = new Set();
  let missingAuth = false;
  headerRowsForSend.forEach(r=>{
    if(r.isSecret) secretHeaderNames.add(r.key);
    if(r.isSecret && !r.value.trim()) missingAuth = true;
    else headersObj[r.key] = r.value;
  });
  if(missingAuth){ toast('Enter your real credential before sending live.'); renderTryItHeadersTable(); return; }

  if(!state._liveModeConfirmedOnce){
    const ok = await openConfirmModal({
      title: `Send a REAL request to ${envMeta(state.env).label}?`,
      message: `This leaves the simulator and hits the actual ${envMeta(state.env).label} endpoint — it can have real side effects (e.g. creating a real order). Every other Try It response is simulated; this one won't be.`,
      confirmLabel: 'Send for real',
    });
    if(!ok) return;
    state._liveModeConfirmedOnce = true;
  }

  sendBtn.disabled = true;
  sendBtn.classList.add('loading');
  document.getElementById('tryItSendLabel').textContent = 'Sending…';
  const { pathParams, queryParams: queryParamPairs } = collectTryItParams();
  const queryParams = {};
  queryParamPairs.forEach(([k,v])=>{ queryParams[k] = v; });

  const resultEl = document.getElementById('tryItResult');
  const resultCardEl = document.getElementById('tryItResultCard');
  const bodyEl = document.getElementById('tryItResponseBody');
  const codeEl = document.getElementById('tryItStatusCode');
  const latencyEl = document.getElementById('tryItLatency');
  document.getElementById('tryItMatchNote').textContent = '';
  document.getElementById('tryItNotDocCard').style.display = 'none';
  resultCardEl.style.display = '';

  // Never echo real credential values back onto the screen, even though they
  // were just sent — same secret-masking strategy used everywhere else.
  const previewHeaderLines = Object.entries(headersObj).map(([k,v])=>
    `${k}: ${secretHeaderNames.has(k) ? maskSecretValue(v) : v}`
  );
  document.getElementById('tryItRequestPreview').textContent =
    [`${ep.method} ${envVarToken(state.env)}${pathWithParams(ep)}`, ...previewHeaderLines, ...(typedBody!==null ? ['', JSON.stringify(typedBody, null, 2)] : [])].join('\n');

  try{
    const res = await fetch('/api/live-mode/send', {
      method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ projectId: proj.id, endpointId: ep.id, environmentId: state.env, pathParams, queryParams, headers: headersObj, body: typedBody }),
    });
    const data = await res.json().catch(()=>({}));
    tryItResetRespTabs();
    if(!res.ok){
      codeEl.textContent = String(res.status);
      codeEl.className = 'code-pill ' + respClass(res.status);
      resultCardEl.style.setProperty('--item-accent', `var(${respColorVar(res.status)})`);
      bodyEl.textContent = data.error || 'The live request failed.';
      latencyEl.textContent = '';
      tryItSetRespSize(bodyEl.textContent);
      renderTryItResponseHeaders(data.headers || {});
      renderTryItTestResults([
        { name: 'Status code is 2xx', pass: false, detail: `Actually received ${res.status}.` },
      ]);
    } else {
      codeEl.textContent = String(data.status);
      codeEl.className = 'code-pill ' + respClass(data.status);
      resultCardEl.style.setProperty('--item-accent', `var(${respColorVar(data.status)})`);
      bodyEl.textContent = typeof data.body === 'string' ? data.body : JSON.stringify(data.body, null, 2);
      tryItSetRespSize(bodyEl.textContent);
      latencyEl.textContent = `🔴 Live response from ${envMeta(state.env).label} · ${data.latencyMs} ms — not simulated`;
      renderTryItResponseHeaders(data.headers || {});
      renderTryItTestResults([
        { name: 'Status code is 2xx', pass: data.status >= 200 && data.status < 300, detail: `Received ${data.status}.` },
        { name: 'Response time is below 1000ms', pass: data.latencyMs < 1000, detail: `Actual: ${data.latencyMs} ms.` },
        { name: 'Response has a body', pass: !!(bodyEl.textContent && bodyEl.textContent.trim()), detail: null },
      ]);
    }
    resultEl.style.display = '';
    document.getElementById('tryItEmptyState').style.display = 'none';
  }catch(e){
    toast('The live request failed — ' + (e.message || 'network error'));
  } finally {
    sendBtn.disabled = false;
    sendBtn.classList.remove('loading');
    document.getElementById('tryItSendLabel').textContent = 'Send';
  }
}

function describeJsonDiff(documented, sent){
  if(typeof documented !== 'object' || documented === null || typeof sent !== 'object' || sent === null) return [];
  const labelFor = v => v === undefined ? '(missing)' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
  const keys = new Set([...Object.keys(documented), ...Object.keys(sent)]);
  const diffs = [];
  keys.forEach(k=>{
    if(!deepEqualJson(documented[k], sent[k])) diffs.push({ path:k, docLabel:labelFor(documented[k]), sentLabel:labelFor(sent[k]) });
  });
  return diffs;
}

/* Postman-style "what actually got sent" preview shown above the simulated
   response — resolves path/query params from the live input fields and pulls
   headers from the same headerList() used everywhere else, so it's masked
   exactly the same way (no leaking real hosts/secrets just because a request
   was 'sent'). */
function buildTryItResolvedRequestPreview(proj, ep, typedBody){
  const { pathParams, queryParams } = collectTryItParams();
  let path = pathWithParams(ep);
  Object.keys(pathParams).forEach(name=>{ path = path.replace(`{${name}}`, encodeURIComponent(pathParams[name] || `{${name}}`)); });
  const qs = queryParams.filter(([,v])=>v).map(([k,v])=>`${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const url = `${envVarToken(state.env)}${path}${qs ? '?'+qs : ''}`;
  // Same substitution as the Headers tab: once a token's been generated on
  // the Auth tab, the preview shows what will actually go out (masked), not
  // the generic placeholder. Reads the SAME editable header rows the
  // Headers tab shows — this preview is never a second, drifting source of
  // truth for "what headers go out".
  const genTok = tryItContext && tryItContext.generatedToken;
  const liveOn = document.getElementById('tryItLiveToggle').checked;
  const lines = [`${ep.method} ${url}`, ...collectTryItHeaders().map(r=>{
    const shown = (r.isSecret && !liveOn && genTok)
      ? maskSecretValue(r.value.toLowerCase().startsWith('bearer') ? `Bearer ${genTok}` : genTok)
      : r.value;
    return `${r.key}: ${shown}`;
  })];
  if(typedBody !== null) lines.push('', JSON.stringify(typedBody, null, 2));
  return lines.join('\n');
}

/* "Edit in Studio" — the destination for every "Not documented" state in Try
   It. Stashes the request the person actually tried as a one-shot prefill
   for the endpoint editor (read once and deleted there — see
   applyTryItPrefillIfAny in editor.html), then opens the editor in its own
   tab, same as every other edit action in this app. Deliberately never
   guesses or saves a response: only someone who knows what the real API
   actually returns for this case can document that correctly, which is the
   whole reason this scenario wasn't already covered.
   closestScenario (optional) is whatever the "Not documented" panel found as
   the nearest existing scenario — when its diff points at a single changed
   field (e.g. amount), that field drives the prefilled name (e.g.
   "amount: 10") instead of a generic placeholder, so the new scenario is
   easy to tell apart in the picker right away. */
function editInStudioFromTryIt(proj, ep, typedBody, closestScenario){
  try{
    let name = 'New scenario from Try It';
    if(closestScenario){
      const p = tryParseJson(closestScenario.value);
      const diffs = p.ok ? describeJsonDiff(p.value, typedBody) : [];
      if(diffs.length === 1) name = `${diffs[0].path}: ${diffs[0].sentLabel}`;
    }
    if(name === 'New scenario from Try It' && typedBody && typeof typedBody === 'object' && typedBody.currency){
      name = `Currency ${typedBody.currency}`;
    }
    localStorage.setItem(`apiStudio_tryitPrefill_${ep.id}`, JSON.stringify({
      name,
      requestJson: JSON.stringify(typedBody, null, 2),
      ts: Date.now(),
    }));
  }catch(e){ /* localStorage full/unavailable — editor still opens, just without the prefill */ }
  openEditorTab(proj, ep);
}

document.getElementById('tryItSend').addEventListener('click', sendTryIt);
document.getElementById('tryItClose').addEventListener('click', closeTryItModal);
document.getElementById('tryItModal').addEventListener('click', (e)=>{ if(e.target.id === 'tryItModal') closeTryItModal(); });

// Line-number gutter: stay in sync with typing and with scrolling.
document.getElementById('tryItBodyInput').addEventListener('input', tryItUpdateBodyGutter);
document.getElementById('tryItBodyInput').addEventListener('scroll', tryItUpdateBodyGutter);

// Response toolbar: copy response JSON, toggle no-wrap for long lines.
document.getElementById('tryItRespCopy').addEventListener('click', ()=>{
  const body = document.getElementById('tryItResponseBody');
  navigator.clipboard.writeText(body.textContent||'').then(()=>{
    const btn = document.getElementById('tryItRespCopy');
    const prev = btn.textContent;
    btn.textContent = '✓';
    setTimeout(()=>{ btn.textContent = prev; }, 1100);
  });
});
document.getElementById('tryItRespWrap').addEventListener('click', ()=>{
  const body = document.getElementById('tryItResponseBody');
  const btn = document.getElementById('tryItRespWrap');
  body.classList.toggle('tryit-nowrap');
  btn.classList.toggle('active', body.classList.contains('tryit-nowrap'));
});
document.getElementById('tryItEmptyGetSuccess').addEventListener('click', ()=>{
  document.getElementById('tryItSend').click();
});
document.getElementById('tryItBeautifyBtn').addEventListener('click', ()=>{
  const ta = document.getElementById('tryItBodyInput');
  const bodyErrEl = document.getElementById('tryItBodyErr');
  const parsed = tryParseJson(ta.value);
  if(!parsed.ok){
    bodyErrEl.textContent = "Can't beautify — this isn't valid JSON.";
    bodyErrEl.style.display = '';
    return;
  }
  bodyErrEl.style.display = 'none';
  ta.value = JSON.stringify(parsed.value, null, 2);
  tryItUpdateBodyGutter();
});
['tryItBodyRawPill','tryItBodyJsonPill'].forEach(id=>{
  document.getElementById(id).addEventListener('click', ()=>{
    const ep = tryItContext && tryItContext.ep;
    const ct = (ep && ep.contentType) || 'application/json';
    toast(`Body format is fixed to raw/${ct.split('/').pop().toUpperCase()} — set by this endpoint's documented request body, not switchable here.`);
  });
});

/* Resolves the response a given (named) request scenario would produce: a
   documented response scenario with that exact same name, and nothing else.
   No closest/fallback guessing here either — a request scenario that was
   documented without a matching response scenario IS "not documented" (it's
   the whole point of "Run all scenarios" as a documentation-completeness
   check), not something to paper over with a guess. Factored out here so
   "Run all scenarios" and a normal single Send stay in agreement about what
   a scenario "resolves to". */
function resolveTryItScenarioResponse(ep, scenarioName){
  const responseScenarios = tryItResponseScenarios(ep);
  const matched = responseScenarios.find(rs=>rs.name.trim().toLowerCase() === scenarioName.trim().toLowerCase());
  return { matched, matchKind: matched ? 'picked' : null };
}

/* "Run all scenarios" — sends every documented request scenario for this
   endpoint back-to-back (simulated, same as a single Send) and lays the
   resolved status/verification out as a checklist, so a whole endpoint can
   be spot-checked in one click instead of picking, sending, and reading
   each scenario one at a time. */
async function runAllTryItScenarios(){
  if(!tryItContext) return;
  const { proj, ep } = tryItContext;
  const requestScenarios = tryItRequestScenarios(ep);
  if(!requestScenarios.length) return;

  const runBtn = document.getElementById('tryItRunAll');
  const resultsEl = document.getElementById('tryItRunAllResults');
  document.getElementById('tryItResult').style.display = 'none';
  document.getElementById('tryItEmptyState').style.display = 'none';
  runBtn.disabled = true;
  runBtn.classList.add('loading');
  resultsEl.style.display = '';
  resultsEl.innerHTML = requestScenarios.map(s=>`
    <div class="tryit-run-all-row" data-run-row="${escapeHtml(s.name)}" style="--item-accent:var(--border-strong);">
      <span class="tryit-run-all-name">${escapeHtml(s.name)}${s.condition?`<span class="mono" style="font-size:10px;color:var(--text-faint);margin-left:6px;">${escapeHtml(describeCondition(s.condition))}</span>`:''}</span>
      <span class="tryit-run-all-status"><span class="env-skel-bar" style="width:60px; height:9px;"></span></span>
    </div>`).join('');

  // Staggered, not simultaneous — resolving + rendering each row with a
  // small delay reads as the endpoint actually being exercised scenario by
  // scenario, rather than a table that just materializes all at once.
  for(const s of requestScenarios){
    await new Promise(r=>setTimeout(r, 220));
    const { matched } = resolveTryItScenarioResponse(ep, s.name);
    const row = resultsEl.querySelector(`[data-run-row="${CSS.escape(s.name)}"]`);
    if(!row) continue;
    if(!matched){
      // A documented request scenario with no matching-named response —
      // exactly the gap this checklist exists to surface. No guessed status
      // code here; just the gap and a one-click way to close it.
      const statusEl = row.querySelector('.tryit-run-all-status');
      statusEl.innerHTML = `<span class="guess">✕ Not documented</span> <button type="button" class="tryit-inline-edit">Edit →</button>`;
      statusEl.querySelector('.tryit-inline-edit').onclick = ()=>editInStudioFromTryIt(proj, ep, tryParseJson(s.value).value, null);
      continue;
    }
    const accentVar = respColorVar(matched.code);
    row.style.setProperty('--item-accent', `var(${accentVar})`);
    row.querySelector('.tryit-run-all-status').innerHTML = `
      <span class="code-pill ${respClass(matched.code)}" style="font-size:10.5px; padding:2px 8px;">${escapeHtml(String(matched.code))}</span>
      <span class="verified">✓ Documented</span>`;
  }

  runBtn.disabled = false;
  runBtn.classList.remove('loading');
}
document.getElementById('tryItRunAll').addEventListener('click', runAllTryItScenarios);

function openRenderView(source){
  let proj, ep;
  if(source && source.ep){ proj = source.proj; ep = source.ep; }
  else { proj = gatherFormAsProjectStub(); ep = gatherFormAsEndpoint(); }
  document.getElementById('renderSheet').innerHTML = buildRenderSheetHtml(proj, ep);
  document.getElementById('renderOverlay').classList.add('show');
  wireRenderSheet(proj, ep);
}
function closeRenderView(){
  document.getElementById('renderOverlay').classList.remove('show');
}

function buildRenderSheetHtml(proj, ep){
  const mClass = methodClass(ep.method);
  const pathParams = (ep.parameters||[]).filter(p=>p.in==='path');
  const queryParams = (ep.parameters||[]).filter(p=>!p.in || p.in==='query');
  const headerParams = ep.headers || (ep.parameters||[]).filter(p=>p.in==='header');
  const allParams = [
    ...pathParams.map(p=>({...p, in:'path'})),
    ...queryParams.map(p=>({...p, in:'query'})),
  ];
  const headerCards = headerParams.map(p=>({...p, in:'header'}));

  const cardHtml = p=>`
    <div class="param-card${p.in==='header'?' is-header':''}">
      <div class="pc-top">
        <span class="pc-name">${escapeHtml(p.name)}${p.required?'<span class="pc-req">*</span>':''}</span>
        <span class="param-chip in-${p.in}">${p.in}</span>
      </div>
      <div class="pc-type">${escapeHtml(p.type||'string')}</div>
      ${p.example ? `<div class="pc-desc mono" style="margin-top:6px;color:var(--text-dim);">${escapeHtml(p.example)}</div>` : ''}
      ${p.description ? `<div class="pc-desc" style="margin-top:6px;">${escapeHtml(p.description)}</div>` : ''}
    </div>`;
  const paramCards = allParams.map(cardHtml).join('');
  const headerParamCards = headerCards.map(cardHtml).join('');

  const responses = ep.responses || [];
  const respPills = responses.map((r,i)=>{
    const cls = respClass(r.code);
    const colorVar = cls==='c2' ? '--st-2' : cls==='c3' ? '--st-3' : cls==='c4' ? '--st-4' : '--st-5';
    return `<div class="resp-pill ${i===0?'active':''}" data-rp="${i}" style="color:var(${colorVar});">
      <span class="dot" style="background:var(${colorVar});"></span>
      <span class="mono" style="font-weight:700;">${escapeHtml(String(r.code))}</span>
    </div>`;
  }).join('');

  return `
    <div class="render-hero" style="--hero-color:var(--${mClass}); --hero-grad:${HERO_GRAD[mClass]};">
      <div class="render-hero-inner">
        <div class="render-kicker">
          <span class="render-method-pill">${ep.method}</span>
          <span class="render-env-pill">${envMeta(state.env).label}</span>
        </div>
        <div class="render-path">${escapeHtml(ep.path)}</div>
        ${ep.summary ? `<div class="render-summary">${escapeHtml(ep.summary)}</div>` : ''}
        ${ep.description ? `<div class="render-desc">${renderMarkdown(ep.description)}</div>` : ''}
        <div class="render-crumb">${escapeHtml(proj.name||'Untitled API')} · ${escapeHtml(ep.tag||'General')}${(proj.version||ep.version)?` · v${escapeHtml(proj.version||ep.version)}`:''} · ${escapeHtml(ep.contentType||'application/json')}</div>
      </div>
    </div>
    <div class="render-body">
      ${headerCards.length ? `
      <div class="render-section">
        <div class="render-section-head"><span class="render-section-ic">▥</span><span class="render-section-title">Headers</span></div>
        <div class="render-grid">${headerParamCards}</div>
      </div>` : ''}

      <div class="render-section">
        <div class="render-section-head"><span class="render-section-ic">◈</span><span class="render-section-title">Request</span></div>
        <div class="resp-pill-row">
          <div class="resp-pill active" data-req-tab="params" style="color:var(--accent);"><span class="dot" style="background:var(--accent);"></span><span class="mono" style="font-weight:700;">Parameters</span></div>
          <div class="resp-pill" data-req-tab="json" style="color:var(--accent);"><span class="dot" style="background:var(--accent);"></span><span class="mono" style="font-weight:700;">JSON</span></div>
        </div>
        <div class="resp-pill-panel" id="renderReqPanel"></div>
      </div>

      <div class="render-section">
        <div class="render-section-head"><span class="render-section-ic">◧</span><span class="render-section-title">Responses</span></div>
        ${responses.length ? `
          <div class="resp-pill-row">${respPills}</div>
          <div class="resp-pill-panel" id="renderRespPanel"></div>
        ` : `<div class="render-empty">No responses documented.</div>`}
      </div>
    </div>
    <div class="render-footer">
      <button id="renderCloseFoot">Close</button>
    </div>
  `;
}

function wireRenderSheet(proj, ep){
  const pathParams = (ep.parameters||[]).filter(p=>p.in==='path');
  const queryParams = (ep.parameters||[]).filter(p=>!p.in || p.in==='query');
  // Same fix as renderEndpointDoc: body fields (from the Request body block,
  // including anything from "Infer fields from JSON") belong in this list
  // too, not just path/query params — otherwise this preview disagrees with
  // what "Infer fields from JSON" just did.
  const bodyFieldParams = ((ep.requestBody && ep.requestBody.fields) || []).map(p=>({...p, in:'body'}));
  const allParams = [...pathParams.map(p=>({...p, in:'path'})), ...queryParams.map(p=>({...p, in:'query'})), ...bodyFieldParams];
  const cardHtml = p=>`
    <div class="param-card${p.in==='header'?' is-header':''}">
      <div class="pc-top">
        <span class="pc-name">${escapeHtml(p.name)}${p.required?'<span class="pc-req">*</span>':''}</span>
        <span class="param-chip in-${p.in}">${p.in}</span>
      </div>
      <div class="pc-type">${escapeHtml(p.type||'string')}</div>
      ${p.example ? `<div class="pc-desc mono" style="margin-top:6px;color:var(--text-dim);">${escapeHtml(p.example)}</div>` : ''}
      ${p.description ? `<div class="pc-desc" style="margin-top:6px;">${escapeHtml(p.description)}</div>` : ''}
    </div>`;
  const hasReqJson = !!(ep.requestBody && ep.requestBody.example);
  const reqPanel = document.getElementById('renderReqPanel');
  function showReq(tab){
    if(tab === 'json'){
      const list = [{ label:'Default', value: (ep.requestBody && ep.requestBody.example) || '' },
        ...((ep.requestBody && ep.requestBody.examples) || []).map(ex=>({ label: ex.name || 'Example', value: ex.value }))];
      reqPanel.innerHTML = hasReqJson
        ? `<div class="render-code-card">
             <div class="render-code-head">
               <span>Request JSON</span>
               <div style="display:flex;gap:8px;align-items:center;">
                 ${list.length>1 ? `<select class="render-example-select" id="reqExampleSelect">${list.map((e,i)=>`<option value="${i}">${escapeHtml(e.label)}</option>`).join('')}</select>` : ''}
                 <button class="copy-btn" style="position:static;" id="renderCopyBody">Copy</button>
               </div>
             </div>
             <pre class="code-block" id="reqJsonBlock">${escapeHtml(maskedJsonString(list[0].value))}</pre>
           </div>`
        : `<div class="render-empty">No request JSON documented.</div>`;
      let current = list[0] ? maskedJsonString(list[0].value) : '';
      const cp = document.getElementById('renderCopyBody');
      if(cp) cp.addEventListener('click', (e)=>copyToClipboard(current, e.currentTarget));
      const sel = document.getElementById('reqExampleSelect');
      if(sel) sel.addEventListener('change', ()=>{
        current = maskedJsonString(list[parseInt(sel.value,10)].value);
        document.getElementById('reqJsonBlock').textContent = current;
      });
    } else {
      reqPanel.innerHTML = allParams.length ? `<div class="render-grid">${allParams.map(cardHtml).join('')}</div>` : `<div class="render-empty">No parameters documented.</div>`;
    }
  }
  showReq('params');
  document.querySelectorAll('[data-req-tab]').forEach(pill=>{
    pill.addEventListener('click', ()=>{
      document.querySelectorAll('[data-req-tab]').forEach(p=>p.classList.remove('active'));
      pill.classList.add('active');
      showReq(pill.getAttribute('data-req-tab'));
    });
  });

  const responses = ep.responses || [];
  const panel = document.getElementById('renderRespPanel');
  function showResp(i){
    const r = responses[i];
    if(!r) return;
    let activeTab = 'params';
    function renderTab(){
      panel.innerHTML = `
        <div class="resp-tabs">
          <button type="button" class="resp-tab ${activeTab==='params'?'active':''}" data-rtab="params">Response parameters</button>
          <button type="button" class="resp-tab ${activeTab==='json'?'active':''}" data-rtab="json">Response JSON</button>
        </div>
        ${activeTab==='params'
          ? (r.fields && r.fields.length ? paramSection('Response parameters', r.fields, r.code) : '<div class="render-empty">No response parameters documented.</div>')
          : (()=>{
              const list = [{ label:'Default', value: r.example || '' }, ...((r.examples)||[]).map(ex=>({ label: ex.name || 'Example', value: ex.value }))];
              return `<div class="render-code-card">
                <div class="render-code-head">
                  <span>${escapeHtml(r.description || 'Response '+r.code)}</span>
                  <div style="display:flex;gap:8px;align-items:center;">
                    ${(r.example && list.length>1) ? `<select class="render-example-select" id="respExampleSelect">${list.map((e,i)=>`<option value="${i}">${escapeHtml(e.label)}</option>`).join('')}</select>` : ''}
                    ${r.example ? '<button class="copy-btn" style="position:static;" id="renderCopyResp">Copy</button>' : ''}
                  </div>
                </div>
                <pre class="code-block" id="respJsonBlock">${r.example ? escapeHtml(maskedJsonString(list[0].value)) : '<span class="render-empty">No example body.</span>'}</pre>
              </div>`;
            })()}`;
      panel.querySelectorAll('[data-rtab]').forEach(b=>{
        b.addEventListener('click', ()=>{ activeTab = b.getAttribute('data-rtab'); renderTab(); });
      });
      const respList = [{ value: r.example || '' }, ...((r.examples)||[]).map(ex=>({ value: ex.value }))];
      let currentResp = respList[0] ? maskedJsonString(respList[0].value) : '';
      const cp = document.getElementById('renderCopyResp');
      if(cp) cp.addEventListener('click', (e)=>copyToClipboard(currentResp, e.currentTarget));
      const respSel = document.getElementById('respExampleSelect');
      if(respSel) respSel.addEventListener('change', ()=>{
        currentResp = maskedJsonString(respList[parseInt(respSel.value,10)].value);
        document.getElementById('respJsonBlock').textContent = currentResp;
      });
    }
    renderTab();
  }
  if(responses.length) showResp(0);
  document.querySelectorAll('[data-rp]').forEach(pill=>{
    pill.addEventListener('click', ()=>{
      document.querySelectorAll('[data-rp]').forEach(p=>p.classList.remove('active'));
      pill.classList.add('active');
      showResp(parseInt(pill.getAttribute('data-rp'),10));
    });
  });
  const footClose = document.getElementById('renderCloseFoot');
  if(footClose) footClose.addEventListener('click', closeRenderView);
}
