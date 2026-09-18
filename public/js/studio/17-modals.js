/* ==================== SECTION:MODALS ==================== */

/* ---------- Add / edit endpoint modal ---------- */
/* ---------- Dynamic builder: request/header parameters, responses, architecture ---------- */
const PARAM_TYPES = ['String','Integer','Number','Boolean','Object','Array'];
let builderParams = [];
let builderHeaders = [];
let builderResponses = [];
let builderReqExamples = [];

function newParamRow(){ return { id:uid(), name:'', type:'String', required:false, example:'', description:'' }; }
function newResponseBlock(code){ return { id:uid(), code: code || 200, description:'', fields:[], example:'', examples:[] }; }
function newExampleRow(){ return { id:uid(), name:'', value:'', condition:null }; }

/* ---------- Condition-based scenario matching ----------
   A named request scenario can optionally carry a `condition` instead of (or
   in addition to) relying on its `value` for exact-match. condition shape:
     { field: "amount", op: "lt"|"lte"|"gt"|"gte"|"eq"|"neq"|"between", value: 100 }
   or, for "between": { field, op:"between", min, max }.
   `field` is a dot-path into the submitted JSON body ("amount",
   "customer.amount"). Numeric comparisons coerce both sides with Number();
   eq/neq fall back to string comparison when either side isn't numeric, so a
   condition on a non-numeric field (e.g. currency === "INR") still works. */
const CONDITION_OPS = [
  { id:'lt',      label:'<' },
  { id:'lte',     label:'<=' },
  { id:'gt',      label:'>' },
  { id:'gte',     label:'>=' },
  { id:'eq',      label:'==' },
  { id:'neq',     label:'!=' },
  { id:'between', label:'between' },
];
function conditionOpLabel(op){ const m = CONDITION_OPS.find(o=>o.id===op); return m ? m.label : op; }

function getByPath(obj, path){
  if(obj == null || !path) return undefined;
  return path.split('.').reduce((acc,key)=> (acc && typeof acc === 'object') ? acc[key] : undefined, obj);
}

// Human-readable summary for scenario pills / match notes / the checklist —
// e.g. "amount < 100" or "amount between 100 and 500".
function describeCondition(cond){
  if(!cond || !cond.field || !cond.op) return '';
  if(cond.op === 'between') return `${cond.field} between ${cond.min} and ${cond.max}`;
  return `${cond.field} ${conditionOpLabel(cond.op)} ${cond.value}`;
}

// Returns true/false, or null when the field is missing from the submitted
// body (treated as "condition not applicable", never as a false-positive match).
function evaluateCondition(cond, body){
  if(!cond || !cond.field || !cond.op || body == null || typeof body !== 'object') return null;
  const raw = getByPath(body, cond.field);
  if(raw === undefined) return null;
  const num = Number(raw);
  const isNum = raw !== '' && raw !== null && !Number.isNaN(num);
  if(cond.op === 'between'){
    const min = Number(cond.min), max = Number(cond.max);
    if(!isNum || Number.isNaN(min) || Number.isNaN(max)) return null;
    return num >= min && num <= max;
  }
  const target = cond.value;
  const targetNum = Number(target);
  const bothNumeric = isNum && target !== '' && target != null && !Number.isNaN(targetNum);
  switch(cond.op){
    case 'lt':  return bothNumeric ? num < targetNum : null;
    case 'lte': return bothNumeric ? num <= targetNum : null;
    case 'gt':  return bothNumeric ? num > targetNum : null;
    case 'gte': return bothNumeric ? num >= targetNum : null;
    case 'eq':  return bothNumeric ? num === targetNum : String(raw) === String(target);
    case 'neq': return bothNumeric ? num !== targetNum : String(raw) !== String(target);
    default: return null;
  }
}

// Finds every documented request scenario whose condition evaluates true
// against `body`. Used by the Try It matcher (narrowest-range wins on
// overlap) and by the doc-side scenario picker to explain a match.
function matchConditionScenarios(requestScenarios, body){
  return requestScenarios.filter(s => s.condition && evaluateCondition(s.condition, body) === true);
}

// When more than one condition matches (overlapping ranges — a documentation
// gap), prefer the one with the tightest bound so results stay deterministic
// instead of "whichever was declared first". Falls back to declaration order.
// Drops a condition that's incomplete (no field, or no comparison value(s))
// so a half-filled form never gets saved as a silently-broken rule that
// matches nothing. Coerces the numeric-looking value fields to Number so
// evaluateCondition doesn't have to re-parse strings from storage.
function sanitizeCondition(cond){
  if(!cond || !cond.field || !String(cond.field).trim() || !cond.op) return undefined;
  const field = String(cond.field).trim();
  if(cond.op === 'between'){
    if(cond.min === '' || cond.min === undefined || cond.max === '' || cond.max === undefined) return undefined;
    return { field, op:'between', min:Number(cond.min), max:Number(cond.max) };
  }
  if(cond.value === '' || cond.value === undefined) return undefined;
  const n = Number(cond.value);
  return { field, op:cond.op, value: Number.isNaN(n) ? cond.value : n };
}

function narrowestConditionMatch(matches){
  if(matches.length <= 1) return matches[0] || null;
  const width = s=>{
    const c = s.condition;
    if(c.op === 'between') return Number(c.max) - Number(c.min);
    if(c.op === 'eq') return 0;
    return Infinity; // open-ended (<, <=, >, >=) is the least specific
  };
  return matches.slice().sort((a,b)=> width(a) - width(b))[0];
}

/* ---------- Named example variants (request body & per-response) ---------- */
// Renders a compact list of "name + JSON" cards into containerEl for the given
// examples array, wiring input/delete handlers. onChange() fires after any edit
// or deletion so the caller can refresh dependent previews if needed.
function renderExampleCards(containerEl, examples, onChange){
  if(!examples.length){
    containerEl.innerHTML = `<div class="example-empty-hint">No additional examples yet.</div>`;
    return;
  }
  containerEl.innerHTML = examples.map((ex,i)=>{
    const cond = ex.condition || null;
    const hasCond = !!cond;
    return `
    <div class="example-card" data-ex-id="${ex.id}">
      <div class="example-card-head">
        <span class="ex-index">#${i+2}</span>
        <input type="text" data-exf="name" value="${escapeHtml(ex.name)}" placeholder="e.g. Minimum Payment Amount">
        <button type="button" class="dyn-del-btn icon" data-del-ex="${ex.id}">✕</button>
      </div>
      <div class="example-card-body">
        <textarea data-exf="value" class="mono" placeholder='{ "amount": 49900 }'>${escapeHtml(ex.value)}</textarea>
      </div>
      <div class="example-condition-row" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 12px;border-top:1px solid var(--border);">
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-dim);white-space:nowrap;">
          <input type="checkbox" data-cond-toggle ${hasCond?'checked':''}> Match by condition
        </label>
        <div class="example-condition-fields" style="display:${hasCond?'flex':'none'};align-items:center;gap:6px;flex-wrap:wrap;">
          <input type="text" data-condf="field" value="${cond?escapeHtml(cond.field||''):''}" placeholder="field, e.g. amount" style="width:130px;">
          <select data-condf="op" style="width:auto;">
            ${CONDITION_OPS.map(o=>`<option value="${o.id}" ${cond&&cond.op===o.id?'selected':''}>${o.label}</option>`).join('')}
          </select>
          <span data-cond-single style="display:${cond&&cond.op==='between'?'none':'inline-flex'};">
            <input type="text" data-condf="value" value="${cond&&cond.value!==undefined?escapeHtml(String(cond.value)):''}" placeholder="value, e.g. 100" style="width:100px;">
          </span>
          <span data-cond-between style="display:${cond&&cond.op==='between'?'inline-flex':'none'};gap:6px;">
            <input type="text" data-condf="min" value="${cond&&cond.min!==undefined?escapeHtml(String(cond.min)):''}" placeholder="min" style="width:70px;">
            <input type="text" data-condf="max" value="${cond&&cond.max!==undefined?escapeHtml(String(cond.max)):''}" placeholder="max" style="width:70px;">
          </span>
        </div>
      </div>
      <div class="example-condition-hint" style="padding:0 12px 8px;font-size:11px;color:var(--text-faint);display:${hasCond?'block':'none'};">
        Try It selects this scenario whenever the submitted request's <b data-cond-summary-field>${cond?escapeHtml(cond.field||''):''}</b> satisfies this rule — the JSON above is still shown as the documented example, but no longer needs to match byte-for-byte.
      </div>
    </div>`;}).join('');

  containerEl.querySelectorAll('[data-exf]').forEach(inp=>{
    inp.addEventListener('input', ()=>{
      const ex = examples.find(e=>e.id===inp.closest('[data-ex-id]').getAttribute('data-ex-id'));
      if(!ex) return;
      ex[inp.getAttribute('data-exf')] = inp.value;
      if(onChange) onChange();
    });
  });
  containerEl.querySelectorAll('[data-del-ex]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const id = btn.getAttribute('data-del-ex');
      const idx = examples.findIndex(e=>e.id===id);
      if(idx > -1) examples.splice(idx, 1);
      renderExampleCards(containerEl, examples, onChange);
      if(onChange) onChange();
    });
  });
  containerEl.querySelectorAll('[data-cond-toggle]').forEach(cb=>{
    cb.addEventListener('change', ()=>{
      const card = cb.closest('[data-ex-id]');
      const ex = examples.find(e=>e.id===card.getAttribute('data-ex-id'));
      if(!ex) return;
      if(cb.checked){ ex.condition = ex.condition || { field:'', op:'lt', value:'' }; }
      else { ex.condition = null; }
      renderExampleCards(containerEl, examples, onChange);
      if(onChange) onChange();
    });
  });
  containerEl.querySelectorAll('[data-condf]').forEach(inp=>{
    inp.addEventListener('input', ()=>{
      const card = inp.closest('[data-ex-id]');
      const ex = examples.find(e=>e.id===card.getAttribute('data-ex-id'));
      if(!ex || !ex.condition) return;
      const f = inp.getAttribute('data-condf');
      ex.condition[f] = inp.value;
      if(f === 'op'){
        const isBetween = inp.value === 'between';
        card.querySelector('[data-cond-single]').style.display = isBetween ? 'none' : 'inline-flex';
        card.querySelector('[data-cond-between]').style.display = isBetween ? 'inline-flex' : 'none';
      }
      if(f === 'field'){
        const summaryEl = card.querySelector('[data-cond-summary-field]');
        if(summaryEl) summaryEl.textContent = inp.value;
      }
      if(onChange) onChange();
    });
  });
}

function renderReqExamples(){
  renderExampleCards(document.getElementById('reqExampleRows'), builderReqExamples, null);
}

function renderDynRows(containerId, rows, isHeader){
  const tbody = document.getElementById(containerId);
  if(!rows.length){
    tbody.innerHTML = `<tr><td colspan="6" class="dyn-empty-row">No ${isHeader?'headers':'parameters'} yet — click "+ Add" to define one.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(r=>`
    <tr class="dyn-row${isHeader?' header-row':''}" data-row-id="${r.id}">
      <td class="col-name"><input type="text" class="dyn-name" data-f="name" value="${escapeHtml(r.name)}" placeholder="${isHeader?'Authorization':'customerId'}"></td>
      <td class="col-type"><select data-f="type">${PARAM_TYPES.map(t=>`<option value="${t}" ${r.type===t?'selected':''}>${t}</option>`).join('')}</select></td>
      <td class="col-req"><input type="checkbox" data-f="required" ${r.required?'checked':''}></td>
      <td class="col-example"><input type="text" data-f="example" value="${escapeHtml(r.example)}" placeholder="${isHeader?'Bearer xxx':'e.g. 12345'}"></td>
      <td class="col-desc"><input type="text" data-f="description" value="${escapeHtml(r.description)}" placeholder="Description"></td>
      <td class="col-del"><button type="button" class="dyn-del-btn icon" data-del="${r.id}">✕</button></td>
    </tr>`).join('');

  tbody.querySelectorAll('input,select').forEach(inp=>{
    inp.addEventListener('input', ()=>{
      const row = rows.find(r=>r.id===inp.closest('tr').getAttribute('data-row-id'));
      if(!row) return;
      const f = inp.getAttribute('data-f');
      row[f] = inp.type === 'checkbox' ? inp.checked : inp.value;
      regenerateRequestJson();
    });
  });
  tbody.querySelectorAll('[data-del]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const id = btn.getAttribute('data-del');
      if(containerId==='paramRows') builderParams = builderParams.filter(r=>r.id!==id);
      else builderHeaders = builderHeaders.filter(r=>r.id!==id);
      renderDynRows(containerId, containerId==='paramRows'?builderParams:builderHeaders, isHeader);
      regenerateRequestJson();
    });
  });
}

function exampleValueFor(type, example){
  if(example !== undefined && example !== '' && example !== null) return coerceByType(type, example);
  switch((type||'String').toLowerCase()){
    case 'integer': return 0;
    case 'number': return 0.0;
    case 'boolean': return true;
    case 'object': return {};
    case 'array': return [];
    default: return 'string';
  }
}
function coerceByType(type, val){
  switch((type||'String').toLowerCase()){
    case 'integer': { const n = parseInt(val,10); return isNaN(n) ? 0 : n; }
    case 'number': { const n = parseFloat(val); return isNaN(n) ? 0 : n; }
    case 'boolean': return val === true || val === 'true';
    case 'object': try{ return JSON.parse(val); }catch(e){ return {}; }
    case 'array': try{ const p = JSON.parse(val); return Array.isArray(p)?p:[val]; }catch(e){ return [val]; }
    default: return String(val);
  }
}

function buildJsonFromRows(rows){
  const obj = {};
  rows.filter(r=>r.name.trim()).forEach(r=>{ obj[r.name.trim()] = exampleValueFor(r.type, r.example); });
  return obj;
}

function regenerateRequestJson(){
  const ta = document.getElementById('mBody');
  if(!ta) return;
  const json = buildJsonFromRows(builderParams);
  ta.value = JSON.stringify(json, null, 2);
}

/* ---------- Response blocks ---------- */
const STATUS_CODES = [200,201,202,204,400,401,403,404,409,422,500,502,503];
function renderResponseBlocks(){
  const wrap = document.getElementById('responseBlocks');
  if(!builderResponses.length){
    wrap.innerHTML = `<div class="dyn-empty-row">No responses yet — click "+ Add response" to define one (200 OK is the default).</div>`;
    return;
  }
  wrap.innerHTML = builderResponses.map((rb,i)=>{
    const cls = respClass(rb.code);
    const colorVar = cls==='c2' ? '--st-2' : cls==='c3' ? '--st-3' : cls==='c4' ? '--st-4' : '--st-5';
    const bgVar = cls==='c2' ? '--post-bg' : cls==='c3' ? '--get-bg' : cls==='c4' ? '--put-bg' : '--delete-bg';
    return `
    <div class="resp-block" data-resp-id="${rb.id}" style="border-left-color:var(${colorVar}); --resp-accent:var(${colorVar}); --resp-bg:var(${bgVar});">
      <div class="resp-block-head">
        <span class="rb-index">Response ${i+1}</span>
        <select data-rf="code">${STATUS_CODES.map(c=>`<option value="${c}" ${rb.code==c?'selected':''}>${c}</option>`).join('')}</select>
        <input type="text" data-rf="description" value="${escapeHtml(rb.description)}" placeholder="Description, e.g. Payment successful">
        <button type="button" class="builder-add resp-add-field" data-add-field="${rb.id}">+ Field</button>
        <button type="button" class="dyn-del-btn icon" data-del-resp="${rb.id}">✕</button>
      </div>
      <div class="resp-block-body">
        <div class="builder-title" style="margin-bottom:6px;">Response fields</div>
        <table class="dyn-table">
          <thead><tr><th class="col-name">Field</th><th class="col-type">Type</th><th class="col-req">Required</th><th class="col-example">Example</th><th class="col-desc">Description</th><th class="col-del"></th></tr></thead>
          <tbody data-resp-fields="${rb.id}"></tbody>
        </table>
        <div class="json-preview-wrap">
          <div class="json-preview-label"><span>Response JSON (default example)</span></div>
          <pre class="json-preview" data-resp-json="${rb.id}"></pre>
        </div>
        <div class="json-preview-wrap">
          <div class="json-preview-label">
            <span>Additional named examples</span>
            <button type="button" class="builder-add" data-add-example="${rb.id}">+ Add example</button>
          </div>
          <div data-resp-examples="${rb.id}"></div>
        </div>
      </div>
    </div>`;
  }).join('');

  builderResponses.forEach(rb=>{
    const tbody = wrap.querySelector(`[data-resp-fields="${rb.id}"]`);
    if(!rb.fields.length){
      tbody.innerHTML = `<tr><td colspan="6" class="dyn-empty-row">No fields yet.</td></tr>`;
    } else {
      tbody.innerHTML = rb.fields.map(f=>`
        <tr class="dyn-row" data-field-id="${f.id}">
          <td class="col-name"><input type="text" data-f="name" value="${escapeHtml(f.name)}" placeholder="transactionId"></td>
          <td class="col-type"><select data-f="type">${PARAM_TYPES.map(t=>`<option value="${t}" ${f.type===t?'selected':''}>${t}</option>`).join('')}</select></td>
          <td class="col-req"><input type="checkbox" data-f="required" ${f.required?'checked':''}></td>
          <td class="col-example"><input type="text" data-f="example" value="${escapeHtml(f.example)}" placeholder="e.g. TXN12345"></td>
          <td class="col-desc"><input type="text" data-f="description" value="${escapeHtml(f.description)}" placeholder="Description"></td>
          <td class="col-del"><button type="button" class="dyn-del-btn icon" data-del-field="${f.id}">✕</button></td>
        </tr>`).join('');
    }
    tbody.querySelectorAll('input,select').forEach(inp=>{
      inp.addEventListener('input', ()=>{
        const field = rb.fields.find(f=>f.id===inp.closest('tr').getAttribute('data-field-id'));
        if(!field) return;
        const f = inp.getAttribute('data-f');
        field[f] = inp.type === 'checkbox' ? inp.checked : inp.value;
        updateResponseJsonPreview(rb);
      });
    });
    tbody.querySelectorAll('[data-del-field]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        rb.fields = rb.fields.filter(f=>f.id!==btn.getAttribute('data-del-field'));
        renderResponseBlocks();
      });
    });
    updateResponseJsonPreview(rb);

    const exContainer = wrap.querySelector(`[data-resp-examples="${rb.id}"]`);
    if(!rb.examples) rb.examples = [];
    renderExampleCards(exContainer, rb.examples, null);
  });

  wrap.querySelectorAll('[data-add-example]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const rb = builderResponses.find(r=>r.id===btn.getAttribute('data-add-example'));
      if(!rb) return;
      if(!rb.examples) rb.examples = [];
      rb.examples.push(newExampleRow());
      renderExampleCards(wrap.querySelector(`[data-resp-examples="${rb.id}"]`), rb.examples, null);
    });
  });

  wrap.querySelectorAll('[data-rf]').forEach(inp=>{
    inp.addEventListener('input', ()=>{
      const rb = builderResponses.find(r=>r.id===inp.closest('.resp-block').getAttribute('data-resp-id'));
      if(!rb) return;
      rb[inp.getAttribute('data-rf')] = inp.value;
    });
  });
  wrap.querySelectorAll('[data-add-field]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const rb = builderResponses.find(r=>r.id===btn.getAttribute('data-add-field'));
      if(rb){ rb.fields.push({id:uid(),name:'',type:'String',required:false,example:'',description:''}); renderResponseBlocks(); }
    });
  });
  wrap.querySelectorAll('[data-del-resp]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      builderResponses = builderResponses.filter(r=>r.id!==btn.getAttribute('data-del-resp'));
      renderResponseBlocks();
    });
  });
}
function updateResponseJsonPreview(rb){
  const pre = document.querySelector(`[data-resp-json="${rb.id}"]`);
  if(!pre) return;
  const obj = buildJsonFromRows(rb.fields);
  rb.example = JSON.stringify(obj, null, 2);
  pre.textContent = rb.example;
}

document.getElementById('addParamRow').addEventListener('click', ()=>{ builderParams.push(newParamRow()); renderDynRows('paramRows', builderParams, false); regenerateRequestJson(); });
document.getElementById('addHeaderRow').addEventListener('click', ()=>{ builderHeaders.push(newParamRow()); renderDynRows('headerRows', builderHeaders, true); });
document.getElementById('addResponseBlock').addEventListener('click', ()=>{
  const used = builderResponses.map(r=>r.code);
  const nextCode = STATUS_CODES.find(c=>!used.includes(c)) || 200;
  builderResponses.push(newResponseBlock(nextCode));
  renderResponseBlocks();
});
document.getElementById('mBodyRegen').addEventListener('click', regenerateRequestJson);
document.getElementById('addReqExample').addEventListener('click', ()=>{
  builderReqExamples.push(newExampleRow());
  renderReqExamples();
});

let editingEndpointId = null;
// The project record currently backing the endpoint modal's "Project details"
// fields (set whenever they're hydrated from a real project, cleared for a
// brand-new one). Not currently read elsewhere, but kept around since other
// code in this section may want to know which project is backing the modal.
let currentEndpointProject = null;

// Populates the endpoint modal's "Project details" and "Authentication"
// sections from a real project record — used both when editing an existing
// endpoint and when the typed project name in "Add endpoint" matches one.
// This modal is now the only place these shared project fields are edited.
function hydrateEndpointProjectFields(proj){
  currentEndpointProject = proj;
  document.getElementById('mLifecycle').innerHTML = LIFECYCLE_STAGES.map(s=>`<option value="${s}">${s}</option>`).join('');
  document.getElementById('mLifecycle').value = proj.lifecycle || 'PRODUCTION';
  document.getElementById('mOwner').value = proj.owner || '';
  document.getElementById('mTeam').value = proj.team || '';
  document.getElementById('mTerms').value = proj.termsOfService || '';
  document.getElementById('mContactName').value = (proj.contact && proj.contact.name) || '';
  document.getElementById('mContactEmail').value = (proj.contact && proj.contact.email) || '';
  document.getElementById('mLicenseName').value = (proj.license && proj.license.name) || '';
  document.getElementById('mLicenseUrl').value = (proj.license && proj.license.url) || '';
  document.getElementById('mFlowPattern').value = proj.requestFlowDirection === '2-way' ? '2-way' : '1-way';
  document.getElementById('mFlowLabel').value = proj.requestFlowLabel || '';

  document.getElementById('mAuthType').value = (proj.auth && proj.auth.type) || '';
  document.getElementById('mAuthMethod').value = (proj.auth && proj.auth.method) || 'POST';
  document.getElementById('mAuthPath').value = (proj.auth && proj.auth.path) || '';
  document.getElementById('mAuthHeader').value = (proj.auth && proj.auth.headerName) || '';
  document.getElementById('mAuthDesc').value = (proj.auth && proj.auth.description) || '';
  document.getElementById('mAuthIncludeDocs').checked = !!(proj.auth && proj.auth.includeInDocs);
  document.getElementById('mAuthIncludeSwagger').checked = !!(proj.auth && proj.auth.includeInSwagger);
  authParamsStore.endpoint.req = cloneAuthParams(proj.auth && proj.auth.requestParams);
  authParamsStore.endpoint.resp = cloneAuthParams(proj.auth && proj.auth.responseParams);
  renderAuthParamRows('endpoint', 'req');
  renderAuthParamRows('endpoint', 'resp');
  ['req','resp'].forEach(kind=>{
    const saved = kind === 'req' ? (proj.auth && proj.auth.requestExample) : (proj.auth && proj.auth.responseExample);
    const ta = document.getElementById(kind === 'req' ? 'mAuthReqJsonPreview' : 'mAuthRespJsonPreview');
    if(ta) ta.value = saved || ta.value;
  });
}

// Blank-slate version for "Add endpoint" when no matching project exists yet.
function clearEndpointProjectFields(){
  currentEndpointProject = null;
  document.getElementById('mLifecycle').innerHTML = LIFECYCLE_STAGES.map(s=>`<option value="${s}">${s}</option>`).join('');
  document.getElementById('mLifecycle').value = 'PRODUCTION';
  ['mOwner','mTeam','mTerms','mContactName','mContactEmail','mLicenseName','mLicenseUrl',
   'mAuthType','mAuthPath','mAuthHeader','mAuthDesc'].forEach(id=>document.getElementById(id).value = '');
  document.getElementById('mAuthMethod').value = 'POST';
  document.getElementById('mAuthIncludeDocs').checked = false;
  document.getElementById('mAuthIncludeSwagger').checked = false;
  document.getElementById('mFlowPattern').value = '1-way';
  document.getElementById('mFlowLabel').value = '';
  authParamsStore.endpoint.req = [];
  authParamsStore.endpoint.resp = [];
  renderAuthParamRows('endpoint', 'req');
  renderAuthParamRows('endpoint', 'resp');
}

function openManualModal(epId){
  if(!canEditHere()){ toast(isViewingDraftEnv() ? `Your role (${roleMeta(state.authorRole).label}) is read-only` : `Switch to ${envMeta(draftEnvId()).label} to make changes`); return; }
  editingEndpointId = epId || null;
  const title = document.getElementById('epModalTitle');
  const deleteBtn = document.getElementById('mDelete');

  if(editingEndpointId){
    const found = findEndpoint(editingEndpointId);
    if(!found) return;
    const { proj, ep } = found;
    title.textContent = 'Edit endpoint';
    deleteBtn.classList.remove('hidden');
    document.getElementById('mProject').value = proj.name;
    document.getElementById('mMethod').value = ep.method;
    document.getElementById('mPath').value = ep.path;
    document.getElementById('mTag').value = ep.tag;
    document.getElementById('mVersion').value = proj.version || ep.version || '';
    document.getElementById('mContentType').value = ep.contentType || 'application/json';
    document.getElementById('mSummary').value = ep.summary || '';
    document.getElementById('mDesc').value = ep.description || '';
    document.getElementById('mApiDesc').value = proj.description || '';
    document.getElementById('mVisibility').value = ep.visibility === 'public' ? 'public' : 'private';
    hydrateEndpointProjectFields(proj);

    builderParams = (ep.parameters||[]).map(p=>({ id:uid(), name:p.name||'', type:normalizeTypeLabel(p.type), required:!!p.required, example: p.example!==undefined?String(p.example):'', description:p.description||'' }));
    builderHeaders = (ep.headers||[]).map(p=>({ id:uid(), name:p.name||'', type:normalizeTypeLabel(p.type), required:!!p.required, example: p.example!==undefined?String(p.example):'', description:p.description||'' }));
    builderResponses = (ep.responses||[]).map(r=>({
      id:uid(), code:r.code||200, description:r.description||'', example:r.example||'',
      fields:(r.fields||[]).map(f=>({id:uid(), name:f.name||'', type:normalizeTypeLabel(f.type), required:!!f.required, example: f.example!==undefined?String(f.example):'', description:f.description||''})),
      examples:(r.examples||[]).map(ex=>({id:uid(), name:ex.name||'', value:ex.value||''})),
    }));
    builderReqExamples = (ep.requestBody && ep.requestBody.examples || []).map(ex=>({id:uid(), name:ex.name||'', value:ex.value||'', condition: ex.condition ? {...ex.condition} : null}));

    document.getElementById('mBody').value = (ep.requestBody && ep.requestBody.example) || '';
  } else {
    title.textContent = 'Add endpoint';
    deleteBtn.classList.add('hidden');
    ['mProject','mPath','mTag','mVersion','mContentType','mSummary','mDesc','mBody','mApiDesc'].forEach(id=>document.getElementById(id).value = '');
    document.getElementById('mMethod').value = 'GET';
    document.getElementById('mContentType').value = 'application/json';
    document.getElementById('mVisibility').value = 'private';
    clearEndpointProjectFields();
    if(state.selected && state.selected.type==='overview'){
      const proj = state.projects[state.selected.projectId];
      if(proj){
        document.getElementById('mProject').value = proj.name;
        document.getElementById('mApiDesc').value = proj.description || '';
        // Version is a project-wide value (see saveManualEndpoint) — prefill
        // from the project so a new endpoint starts on the same version
        // instead of blank.
        document.getElementById('mVersion').value = proj.version || '';
        hydrateEndpointProjectFields(proj);
      }
    }
    builderParams = [];
    builderHeaders = [];
    builderResponses = [newResponseBlock(200)];
    builderReqExamples = [];
  }
  renderDynRows('paramRows', builderParams, false);
  renderDynRows('headerRows', builderHeaders, true);
  renderResponseBlocks();
  renderReqExamples();
  document.getElementById('mApiDesc').classList.remove('hidden-src');
  document.getElementById('mApiDescPreview').classList.remove('show');
  document.getElementById('mApiDescPreviewToggle').textContent = 'Preview';
  document.getElementById('manualModal').classList.add('show');
  document.getElementById('mProject').focus();
}

function normalizeTypeLabel(t){
  const known = PARAM_TYPES.find(pt=>pt.toLowerCase() === String(t||'').toLowerCase());
  return known || 'String';
}

function closeManualModal(){
  document.getElementById('manualModal').classList.remove('show');
  editingEndpointId = null;
}

function saveManualEndpoint(){
  const projectName = document.getElementById('mProject').value.trim();
  const path = document.getElementById('mPath').value.trim();
  if(!projectName || !path){ toast('Project name and path are required.'); return; }

  const proj = findOrCreateProjectByName(projectName);
  if(proj._readonly){ toast("You can only view this project — it's public content from someone else in your organisation."); return; }
  const fields = gatherFormAsEndpoint();
  fields.path = path;

  // The API-level description and all "Project details" / "Authentication"
  // fields below live on the project, not the endpoint — persisting them
  // here means this modal is the one and only place these shared project
  // fields are created or edited (Project settings only covers Release
  // Pipeline, Documents and Architecture now).
  const apiDesc = document.getElementById('mApiDesc').value.trim();
  if(apiDesc) proj.description = apiDesc;

  if(LIFECYCLE_STAGES.includes(document.getElementById('mLifecycle').value)){
    proj.lifecycle = document.getElementById('mLifecycle').value;
  }
  proj.owner = document.getElementById('mOwner').value.trim();
  proj.team = document.getElementById('mTeam').value.trim();
  proj.termsOfService = document.getElementById('mTerms').value.trim();
  proj.contact = {
    name: document.getElementById('mContactName').value.trim(),
    email: document.getElementById('mContactEmail').value.trim(),
  };
  proj.license = {
    name: document.getElementById('mLicenseName').value.trim(),
    url: document.getElementById('mLicenseUrl').value.trim(),
  };
  proj.requestFlowDirection = document.getElementById('mFlowPattern').value === '2-way' ? '2-way' : '1-way';
  proj.requestFlowLabel = document.getElementById('mFlowLabel').value.trim();
  // Version reads as a per-endpoint field in this modal, but it's really one
  // value per project — every endpoint should show the same version, so
  // saving here writes it onto the project (source of truth for Overview/PDF
  // display) as well as onto this endpoint (via gatherFormAsEndpoint below,
  // kept for backward compatibility with existing per-endpoint data).
  proj.version = document.getElementById('mVersion').value.trim();
  const cleanMAuthParams = (list)=> list.filter(r=>r.name.trim()).map(r=>(
    { name:r.name.trim(), type:r.type, required:!!r.required, example:r.example.trim(), description:r.description.trim() }
  ));
  proj.auth = {
    type: document.getElementById('mAuthType').value.trim(),
    method: document.getElementById('mAuthMethod').value,
    path: document.getElementById('mAuthPath').value.trim(),
    headerName: document.getElementById('mAuthHeader').value.trim(),
    description: document.getElementById('mAuthDesc').value.trim(),
    requestParams: cleanMAuthParams(authParamsStore.endpoint.req),
    responseParams: cleanMAuthParams(authParamsStore.endpoint.resp),
    requestExample: (document.getElementById('mAuthReqJsonPreview').value || '').trim(),
    responseExample: (document.getElementById('mAuthRespJsonPreview').value || '').trim(),
    includeInDocs: document.getElementById('mAuthIncludeDocs').checked,
    includeInSwagger: document.getElementById('mAuthIncludeSwagger').checked,
  };

  const authorName = ensureAuthorName(true) || 'Unknown';
  const now = new Date().toISOString();

  if(editingEndpointId){
    const found = findEndpoint(editingEndpointId);
    if(found){
      Object.assign(found.ep, fields);
      if(!found.ep.createdAt){ found.ep.createdAt = now; found.ep.createdBy = authorName; }
      found.ep.updatedAt = now;
      found.ep.updatedBy = authorName;
      // moved to a different project by name?
      if(found.proj.id !== proj.id){
        found.proj.endpoints = found.proj.endpoints.filter(e=>e.id!==editingEndpointId);
        found.ep.id = editingEndpointId;
        proj.endpoints.push(found.ep);
      }
    }
    state.selected = { type:'endpoint', id: editingEndpointId };
    logAudit('updated', 'endpoint', `${fields.method} ${fields.path}`, `Edited endpoint ${fields.method} ${fields.path}`, proj.name);
  } else {
    const ep = { id: uid(), ...fields, createdAt: now, createdBy: authorName, updatedAt: now, updatedBy: authorName };
    proj.endpoints.push(ep);
    state.selected = { type:'endpoint', id: ep.id };
    logAudit('created', 'endpoint', `${fields.method} ${fields.path}`, `Added endpoint ${fields.method} ${fields.path}`, proj.name);
  }

  proj.updatedAt = new Date().toISOString();
  saveState();
  closeManualModal();
  renderAll();
  toast('Endpoint saved');
}

// Shared by: the sidebar's per-endpoint delete icon, the endpoint page's
// Actions ▾ dropdown, and the edit modal's own "Delete endpoint" button.
async function deleteEndpointById(epId){
  if(!epId) return false;
  const found = findEndpoint(epId);
  if(!found) return false;
  if(found.proj._readonly){ toast("You can only view this project — it's public content from someone else in your organisation."); return false; }
  const ok = await openConfirmModal({
    title: 'Delete this endpoint?',
    message: `${found.ep.method} ${found.ep.path} and its documentation will be permanently removed.`,
    confirmLabel: 'Delete endpoint',
  });
  if(!ok) return false;
  found.proj.endpoints = found.proj.endpoints.filter(e=>e.id!==epId);
  found.proj.updatedAt = new Date().toISOString();
  if(state.selected && state.selected.type==='endpoint' && state.selected.id===epId){
    state.selected = { type:'overview', projectId: found.proj.id };
  }
  logAudit('deleted', 'endpoint', `${found.ep.method} ${found.ep.path}`, `Deleted endpoint ${found.ep.method} ${found.ep.path}`, found.proj.name);
  saveState();
  renderAll();
  toast('Endpoint deleted');
  return true;
}

async function deleteEndpointFromModal(){
  if(!editingEndpointId) return;
  const deleted = await deleteEndpointById(editingEndpointId);
  if(deleted) closeManualModal();
}

/* ---------- Project settings modal ---------- */
let editingProjectId = null;

// Quick-insert Markdown scaffolds so "Overview / Flow / Authentication" don't
// have to be typed from memory — matches the sections shown on the rendered
// project overview page.
const MD_TEMPLATES = {
  overview: `## Overview\n\nThis API enables merchants to initiate payment orders and generate the order details required for seamless and secure payment processing.\n\nThe **Create Order** endpoint is the first step in the payment flow. It creates an order on the server side, which is then used by the client (web / mobile checkout) to collect payment from the customer.\n`,
  flow: `## Flow\n\n1. Merchant backend calls \`Create Order\` with amount, currency and receipt.\n2. The API returns an \`order_id\` and order metadata.\n3. \`order_id\` is passed to the checkout on the client side.\n4. Customer completes the payment.\n5. Merchant verifies the payment signature on the backend (separate API).\n`,
  auth: `## Authentication\n\nAll requests must include \`CLIENT-ID\` / \`CLIENT-SECRET\` as well as the \`Authorization\` header. Never expose \`CLIENT-SECRET\` in client-side code, logs, or public documentation.\n`,
};

function insertAtCursor(textarea, text){
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  const before = textarea.value.slice(0, start);
  const after = textarea.value.slice(end);
  const needsLeadingBreak = before.length && !before.endsWith('\n\n') ? (before.endsWith('\n') ? '\n' : '\n\n') : '';
  const insert = needsLeadingBreak + text;
  textarea.value = before + insert + after;
  const pos = (before + insert).length;
  textarea.setSelectionRange(pos, pos);
  textarea.focus();
}

/* NOTE: the per-project "Environments" base-URL editor (settings-tab cards +
   summary bar) was removed along with the Project settings ▸ Environments
   tab. proj.environments is still read elsewhere (code samples, request
   URLs, the read-only cards on the Overview page) — it's just no longer
   editable from this modal. */

/* ---------- Release Pipeline (Project settings ▸ Release Pipeline) ----------
   Server-authoritative: the pipeline order and the "DR mirrors the last
   stage" behavior are computed on the server from this org's own environment
   list (see GET/POST /api/workspace/projects/:id/versions|promote in
   server/routes/workspace.js) — the client only renders what it's told and
   never invents a target stage to promote into. Promotion is Admin-only;
   this whole modal is already gated to Admins via openProjectModal(), so no
   extra role check is needed here. */
async function renderReleasePipeline(proj){
  const body = document.getElementById('releasePipelineBody');
  body.innerHTML = `<div class="al-loading" style="padding:30px 0;text-align:center;color:var(--text-faint);font-size:13px;">Loading pipeline status…</div>`;
  let data;
  try{ data = await apiGet(`/projects/${encodeURIComponent(proj.id)}/versions`); }
  catch(e){
    body.innerHTML = `<div class="al-loading" style="padding:30px 0;text-align:center;color:var(--text-faint);font-size:13px;">Could not load release pipeline status.</div>`;
    return;
  }

  const stages = data.stages;

  // Slim read-only strip across the top, purely for orientation — the from/to
  // diff panel below is where promotion actually happens now.
  const stripHtml = stages.map((s, idx)=>{
    const isDraft = s.isDraftStage;
    const versionLabel = isDraft ? data.draftLabel : (s.versionLabel || 'Nothing promoted');
    return `
      <div class="rp-strip-chip" style="--rp-accent:${escapeHtml(s.color || 'var(--accent)')};">
        <span class="rp-strip-chip-label">${escapeHtml(s.label)}${isDraft ? ' <span class="rp-draft-pill">draft</span>' : ''}</span>
        <span class="rp-strip-chip-version mono${(!isDraft && !s.versionLabel) ? ' empty' : ''}">${escapeHtml(versionLabel)}</span>
        ${!isDraft ? `<button type="button" class="rp-history-toggle" data-history-env="${escapeHtml(s.environmentId)}" data-history-label="${escapeHtml(s.label)}" title="Version history / rollback">History</button>` : ''}
      </div>
      ${idx < stages.length - 1 ? `<span class="rp-strip-arrow"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg></span>` : ''}
    `;
  }).join('');
  const mirrorHtml = data.mirrors.map(m=>
    `<span class="rp-mirror-inline">${escapeHtml(m.label)} auto-mirrors the last stage: <b>${escapeHtml(m.versionLabel || 'not mirrored yet')}</b></span>`
  ).join('');

  const optionLabel = (s)=> `${s.label} — ${s.isDraftStage ? data.draftLabel : (s.versionLabel || 'nothing promoted yet')}`;
  const optHtml = (selectedId)=> stages.map(s=>
    `<option value="${escapeHtml(s.environmentId)}" ${s.environmentId === selectedId ? 'selected' : ''}>${escapeHtml(optionLabel(s))}</option>`
  ).join('');

  // Default From/To: the furthest-along stage that already has content,
  // promoting into whatever comes right after it — i.e. "what's next to ship".
  let defaultFromIdx = 0;
  for(let i = stages.length - 2; i >= 0; i--){
    if(stages[i].isDraftStage || stages[i].version != null){ defaultFromIdx = i; break; }
  }
  const fromId = stages[defaultFromIdx].environmentId;
  const toId = stages[Math.min(defaultFromIdx + 1, stages.length - 1)].environmentId;

  body.innerHTML = `
    <div class="rp-strip">${stripHtml}${mirrorHtml}</div>
    <div id="rpHistoryPanel"></div>
    <div class="rp-diffbar">
      <div class="field">
        <label>From</label>
        <select id="rpFromSelect">${optHtml(fromId)}</select>
      </div>
      <button type="button" class="rp-diffbar-swap" id="rpSwapBtn" title="Swap From and To">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path></svg>
      </button>
      <div class="field">
        <label>To</label>
        <select id="rpToSelect">${optHtml(toId)}</select>
      </div>
    </div>
    <div id="rpDiffPanel"><div class="al-loading" style="padding:30px 0;text-align:center;color:var(--text-faint);font-size:13px;">Loading diff…</div></div>
  `;

  // ---- Version history / rollback (item #6) ----
  // "Keep the last N project_env_versions rows queryable for one-click
  // rollback instead of only forward promotion." One toggle-able panel,
  // reused for whichever stage's "History" chip was last clicked.
  body.querySelectorAll('[data-history-env]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const envId = btn.getAttribute('data-history-env');
      const label = btn.getAttribute('data-history-label');
      const panel = document.getElementById('rpHistoryPanel');
      if(panel.getAttribute('data-open-env') === envId){
        panel.innerHTML = ''; panel.removeAttribute('data-open-env');
        return;
      }
      panel.setAttribute('data-open-env', envId);
      panel.innerHTML = `<div class="al-loading" style="padding:16px 0;text-align:center;color:var(--text-faint);font-size:12.5px;">Loading history for ${escapeHtml(label)}…</div>`;
      let history;
      try{
        ({ history } = await apiGet(`/projects/${encodeURIComponent(proj.id)}/versions/${encodeURIComponent(envId)}/history`));
      }catch(e){
        panel.innerHTML = `<div class="rp-diff-nochanges">Could not load history for ${escapeHtml(label)}.</div>`;
        return;
      }
      if(!history.length){
        panel.innerHTML = `<div class="rp-history-list"><div class="rp-history-empty">Nothing has been promoted into ${escapeHtml(label)} yet.</div></div>`;
        return;
      }
      const rowsHtml = history.map((h, idx)=>{
        const isCurrent = idx === 0;
        const when = new Date(h.promoted_at).toLocaleString();
        const actionLabel = h.action === 'rollback' ? 'Rolled back' : (h.auto_mirrored ? 'Auto-mirrored' : 'Promoted');
        return `
          <div class="rp-history-row${isCurrent ? ' current' : ''}">
            <div class="rp-history-row-main">
              <span class="mono">v1.0.${h.version}</span>
              <span class="hint" style="margin:0;">${actionLabel}${h.source_environment_id ? ' from ' + escapeHtml(h.source_environment_id) : ''} by ${escapeHtml(h.promoted_by_username || 'unknown')} · ${escapeHtml(when)}</span>
            </div>
            ${isCurrent
              ? `<span class="hint" style="margin:0;">Currently live</span>`
              : (isAdmin() ? `<button type="button" class="ghost" data-rollback-history-id="${h.id}">Roll back to this</button>` : '')}
          </div>`;
      }).join('');
      panel.innerHTML = `<div class="rp-history-list"><div class="rp-history-title">Version history — ${escapeHtml(label)}</div>${rowsHtml}</div>`;
      panel.querySelectorAll('[data-rollback-history-id]').forEach(rbBtn=>{
        rbBtn.addEventListener('click', async ()=>{
          const historyId = rbBtn.getAttribute('data-rollback-history-id');
          const ok = await openConfirmModal({
            title: `Roll back ${label}?`,
            message: `This replaces what's currently live in ${label} with this earlier version. It's recorded as a new history entry — nothing is deleted, and you can roll forward again afterward.`,
            confirmLabel: 'Roll back',
          });
          if(!ok) return;
          rbBtn.disabled = true; rbBtn.textContent = 'Rolling back…';
          try{
            const result = await apiSend('POST', `/projects/${encodeURIComponent(proj.id)}/rollback`, { environmentId: envId, historyId });
            invalidateSnapshotCache(proj.id);
            toast(`${label} rolled back to ${result.versionLabel}`);
            logAudit('updated', 'project', proj.name, `Rolled ${label} back to ${result.versionLabel}`);
            renderReleasePipeline(proj);
          }catch(e){
            toast(e.message || 'Could not roll back.');
            rbBtn.disabled = false; rbBtn.textContent = 'Roll back to this';
          }
        });
      });
    });
  });

  const fromSel = document.getElementById('rpFromSelect');
  const toSel = document.getElementById('rpToSelect');

  async function loadDiff(){
    const from = fromSel.value, to = toSel.value;
    const panel = document.getElementById('rpDiffPanel');
    if(from === to){
      panel.innerHTML = `<div class="rp-diff-nochanges">Pick two different stages to compare.</div>`;
      return;
    }
    panel.innerHTML = `<div class="al-loading" style="padding:30px 0;text-align:center;color:var(--text-faint);font-size:13px;">Comparing…</div>`;
    let diff;
    try{
      diff = await apiGet(`/projects/${encodeURIComponent(proj.id)}/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    }catch(e){
      panel.innerHTML = `<div class="rp-diff-nochanges">Could not load diff.</div>`;
      return;
    }
    renderReleaseDiffPanel(panel, proj, diff);
  }

  fromSel.addEventListener('change', loadDiff);
  toSel.addEventListener('change', loadDiff);
  document.getElementById('rpSwapBtn').addEventListener('click', ()=>{
    const f = fromSel.value, t = toSel.value;
    fromSel.value = t; toSel.value = f;
    loadDiff();
  });

  loadDiff();
}

// Renders the git-diff-style body of the release pipeline's from/to panel:
// a summary count, then one row per added/removed/modified endpoint —
// modified rows expand to show the exact field-level before/after — and the
// Merge button, gated on the pair being an adjacent pipeline stage (the same
// adjacency POST /promote enforces server-side).
function renderReleaseDiffPanel(panel, proj, diff){
  const total = diff.summary.added + diff.summary.removed + diff.summary.modified;
  const summaryHtml = `
    <div class="rp-diff-summary">
      <span class="rp-diff-count added"><span class="swatch"></span>${diff.summary.added} added</span>
      <span class="rp-diff-count removed"><span class="swatch"></span>${diff.summary.removed} removed</span>
      <span class="rp-diff-count modified"><span class="swatch"></span>${diff.summary.modified} modified</span>
    </div>`;

  const breakingChanges = Array.isArray(diff.breakingChanges) ? diff.breakingChanges : [];
  const hasBreaking = breakingChanges.length > 0;
  // Deliberately its own callout above the endpoint-by-endpoint list, not
  // folded into the per-endpoint rows — these are specifically the subset
  // of changes that would break an existing caller of the API (see
  // server/breakingChangeDetector.js), which is a different question from
  // "what changed" and deserves to be seen before scrolling the full diff.
  const breakingHtml = hasBreaking ? `
    <div class="rp-breaking-callout">
      <div class="rp-breaking-head">
        <span class="rp-breaking-icon">⚠</span>
        ${breakingChanges.length} breaking change${breakingChanges.length === 1 ? '' : 's'} in this promotion
      </div>
      <ul class="rp-breaking-list">
        ${breakingChanges.map(b => `<li>${escapeHtml(b.message)}</li>`).join('')}
      </ul>
      <label class="rp-breaking-ack">
        <input type="checkbox" id="rpAckBreaking" />
        I've reviewed these breaking changes and want to proceed anyway.
      </label>
    </div>` : '';

  const epRow = (kind, ep, marker)=>{
    const changeCount = kind === 'modified' ? ep.changes.length : 0;
    return `
      <div class="rp-diff-ep ${kind}" data-ep-id="${escapeHtml(ep.id)}">
        <div class="rp-diff-ep-head">
          <span class="rp-diff-marker">${marker}</span>
          <span class="rp-diff-ep-method">${escapeHtml(ep.method || '')}</span>
          <span class="rp-diff-ep-path mono">${escapeHtml(ep.path || '(no path)')}</span>
          <span class="rp-diff-ep-summary">${escapeHtml(ep.summary || '')}</span>
          ${changeCount ? `<span class="rp-diff-ep-count">${changeCount} field${changeCount === 1 ? '' : 's'} changed</span>` : ''}
          ${kind === 'modified' ? `<span class="rp-diff-ep-caret">▸</span>` : ''}
        </div>
        ${kind === 'modified' ? `<div class="rp-diff-ep-body">${ep.changes.map(renderReleaseDiffField).join('')}</div>` : ''}
      </div>`;
  };

  const rows = [
    ...diff.added.map(ep => epRow('added', ep, '+')),
    ...diff.removed.map(ep => epRow('removed', ep, '−')),
    ...diff.modified.map(ep => epRow('modified', ep, '~')),
  ];

  panel.innerHTML = `
    ${summaryHtml}
    ${breakingHtml}
    ${total
      ? `<div class="rp-diff-list">${rows.join('')}</div>`
      : `<div class="rp-diff-nochanges">No differences between ${escapeHtml(diff.from.label)} and ${escapeHtml(diff.to.label)} — they're already in sync.</div>`}
    <div class="rp-mergebar">
      <div class="rp-mergebar-note">${diff.canMerge
        ? `Merging freezes ${escapeHtml(diff.from.label)}'s current content and makes it live in ${escapeHtml(diff.to.label)}.`
        : `${escapeHtml(diff.to.label)} isn't the next stage after ${escapeHtml(diff.from.label)} — promote through each stage in order.`}</div>
      <button type="button" class="rp-merge-btn" id="rpMergeBtn" ${(diff.canMerge && total) ? '' : 'disabled'}>Merge into ${escapeHtml(diff.to.label)}</button>
    </div>
  `;

  panel.querySelectorAll('.rp-diff-ep.modified .rp-diff-ep-head').forEach(head=>{
    head.addEventListener('click', ()=> head.closest('.rp-diff-ep').classList.toggle('open'));
  });

  const mergeBtn = document.getElementById('rpMergeBtn');
  const ackBox = document.getElementById('rpAckBreaking');
  // Capture whether merging is fundamentally possible (adjacent stages +
  // actual changes) BEFORE the breaking-change gate below mutates
  // mergeBtn.disabled — otherwise the disabled state gets checked again a
  // few lines down to decide whether to attach the click listener at all,
  // and since we just set it to true, the listener would never get
  // attached whenever there are breaking changes (which is exactly when
  // the button also needs to work once the ack box is checked).
  const mergeFundamentallyAllowed = mergeBtn && !mergeBtn.disabled;
  // Merge stays disabled until a required breaking-change ack is checked —
  // the server enforces this too (POST /promote 409s without it), this is
  // just so the person doesn't click Merge, wait for a round-trip, and get
  // told to go check a box they hadn't seen yet.
  if(mergeFundamentallyAllowed && hasBreaking){
    mergeBtn.disabled = true;
    ackBox.addEventListener('change', ()=>{ mergeBtn.disabled = !ackBox.checked; });
  }
  if(mergeFundamentallyAllowed){
    mergeBtn.addEventListener('click', async ()=>{
      const ok = await openConfirmModal({
        title: `Merge into ${diff.to.label}?`,
        message: hasBreaking
          ? `This freezes ${diff.from.label}'s current content and makes it live in ${diff.to.label}, including ${breakingChanges.length} breaking change${breakingChanges.length === 1 ? '' : 's'} you've acknowledged. Anyone viewing ${diff.to.label} will see this exact version until it's promoted again.`
          : `This freezes ${diff.from.label}'s current content and makes it live in ${diff.to.label}. Anyone viewing ${diff.to.label} will see this exact version until it's promoted again.`,
        confirmLabel: 'Merge',
      });
      if(!ok) return;
      mergeBtn.disabled = true; mergeBtn.textContent = 'Merging…';
      try{
        const result = await apiSend('POST', `/projects/${encodeURIComponent(proj.id)}/promote`, {
          fromEnvironmentId: diff.from.environmentId,
          diffToken: diff.diffToken,
          ackBreakingChanges: hasBreaking ? !!(ackBox && ackBox.checked) : undefined,
        });
        invalidateSnapshotCache(proj.id);
        toast(`Merged into ${result.toEnvironmentLabel} — ${result.versionLabel}`
          + (result.mirrored ? ` · ${result.mirrored.label} auto-mirrored` : '')
          + (result.breakingChangesCount ? ` · ${result.breakingChangesCount} breaking change${result.breakingChangesCount === 1 ? '' : 's'} included` : ''));
        logAudit('updated', 'project', proj.name, `Promoted to ${result.toEnvironmentLabel} (${result.versionLabel})`);
        renderReleasePipeline(proj);
        renderRail();
      }catch(e){
        toast(e.message || 'Could not merge.');
        renderReleasePipeline(proj);
      }
    });
  }
}

function renderReleaseDiffField(c){
  const fmt = (v)=> (v === null || v === undefined) ? '(empty)' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
  let lines;
  if(c.kind === 'added') lines = `<div class="rp-diff-line add">${escapeHtml(fmt(c.after))}</div>`;
  else if(c.kind === 'removed') lines = `<div class="rp-diff-line rm">${escapeHtml(fmt(c.before))}</div>`;
  else lines = `<div class="rp-diff-line rm">${escapeHtml(fmt(c.before))}</div><div class="rp-diff-line add">${escapeHtml(fmt(c.after))}</div>`;
  return `<div class="rp-diff-field"><div class="rp-diff-field-path mono">${escapeHtml(c.path || '(root)')}</div>${lines}</div>`;
}

/* ---------- Auth tab: request/response parameters (table view only) ---------- */
// Auth's request/response parameter tables are edited from two surfaces now
// — Project settings ▸ Auth, and the new Authentication section inside the
// Add/Edit endpoint modal — both of which read from and write to the same
// underlying `proj.auth`. Everything below is scope-aware ('settings' or
// 'endpoint') so the two surfaces can each keep their own in-memory rows and
// DOM elements without colliding, while still saving to the one shared field.
const authParamsStore = { settings: { req: [], resp: [] }, endpoint: { req: [], resp: [] } };
// Tracks the last auto-generated JSON string per (scope, box), so we only
// overwrite the editable textarea when the user hasn't typed their own
// custom example — the same "auto-generated but you can hand-edit it"
// behavior as the endpoint's Request JSON box (regenerateRequestJson), just
// tracked explicitly here since these boxes don't regenerate on every
// keystroke.
const authJsonAutoValue = { settings: { req: '', resp: '' }, endpoint: { req: '', resp: '' } };

function authRowsElId(scope, kind){
  if(scope === 'endpoint') return kind === 'req' ? 'mAuthReqRows' : 'mAuthRespRows';
  return kind === 'req' ? 'authReqRows' : 'authRespRows';
}
function authJsonElId(scope, kind){
  if(scope === 'endpoint') return kind === 'req' ? 'mAuthReqJsonPreview' : 'mAuthRespJsonPreview';
  return kind === 'req' ? 'authReqJsonPreview' : 'authRespJsonPreview';
}

function newAuthParamRow(){ return { id:uid(), name:'', type:'String', required:false, example:'', description:'' }; }

function cloneAuthParams(list){
  return (Array.isArray(list) ? list : []).map(p=>({
    id: uid(), name: p.name || '', type: PARAM_TYPES.includes(p.type) ? p.type : 'String',
    required: !!p.required, example: p.example || '', description: p.description || '',
  }));
}

function renderAuthParamRows(scope, kind){
  const rows = authParamsStore[scope][kind];
  const tbody = document.getElementById(authRowsElId(scope, kind));
  if(!tbody) return;
  if(!rows.length){
    tbody.innerHTML = `<tr><td colspan="6" class="dyn-empty-row">No ${kind==='req'?'request':'response'} parameters yet — click "+ Add parameter" to define one.</td></tr>`;
  } else {
    tbody.innerHTML = rows.map(r=>`
      <tr class="dyn-row" data-row-id="${r.id}">
        <td class="col-name"><input type="text" data-f="name" value="${escapeHtml(r.name)}" placeholder="${kind==='req'?'apiKey':'access_token'}"></td>
        <td class="col-type"><select data-f="type">${PARAM_TYPES.map(t=>`<option value="${t}" ${r.type===t?'selected':''}>${t}</option>`).join('')}</select></td>
        <td class="col-req"><input type="checkbox" data-f="required" ${r.required?'checked':''}></td>
        <td class="col-example"><input type="text" data-f="example" value="${escapeHtml(r.example)}" placeholder="e.g. xxxxx"></td>
        <td class="col-desc"><input type="text" data-f="description" value="${escapeHtml(r.description)}" placeholder="Description"></td>
        <td class="col-del"><button type="button" class="dyn-del-btn icon" data-del="${r.id}">✕</button></td>
      </tr>`).join('');
  }
  tbody.querySelectorAll('input,select').forEach(inp=>{
    inp.addEventListener('input', ()=>{
      const row = rows.find(r=>r.id===inp.closest('tr').getAttribute('data-row-id'));
      if(!row) return;
      row[inp.getAttribute('data-f')] = inp.type === 'checkbox' ? inp.checked : inp.value;
      updateAuthJsonPreview(scope, kind);
    });
  });
  tbody.querySelectorAll('[data-del]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const id = btn.getAttribute('data-del');
      authParamsStore[scope][kind] = authParamsStore[scope][kind].filter(r=>r.id!==id);
      renderAuthParamRows(scope, kind);
    });
  });
  updateAuthJsonPreview(scope, kind);
}

// The Request/Response JSON boxes are editable textareas that auto-fill from the
// parameter table — but only while the box still holds what we last generated.
// The moment someone types their own example in, further row edits stop
// clobbering it (same idea as the endpoint's "auto-generated — editable" body,
// minus the intentional every-keystroke overwrite, since these two textareas
// don't have a form field driving them the way mBody drives request params).
function updateAuthJsonPreview(scope, kind){
  const ta = document.getElementById(authJsonElId(scope, kind));
  if(!ta) return;
  const rows = authParamsStore[scope][kind];
  const generated = JSON.stringify(buildJsonFromRows(rows), null, 2);
  if(ta.value === '' || ta.value === authJsonAutoValue[scope][kind]){
    ta.value = generated;
  }
  authJsonAutoValue[scope][kind] = generated;
}

// Explicit "↻ Regenerate" button — force the box back to what the table says,
// discarding any manual edits (same escape hatch as the endpoint's Request JSON).
document.querySelectorAll('[data-auth-json-regen]').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    const kind = btn.getAttribute('data-auth-json-regen');
    const scope = btn.getAttribute('data-auth-scope') || 'settings';
    const rows = authParamsStore[scope][kind];
    const ta = document.getElementById(authJsonElId(scope, kind));
    const generated = JSON.stringify(buildJsonFromRows(rows), null, 2);
    if(ta) ta.value = generated;
    authJsonAutoValue[scope][kind] = generated;
  });
});

document.getElementById('addMAuthReqRow').addEventListener('click', ()=>{ authParamsStore.endpoint.req.push(newAuthParamRow()); renderAuthParamRows('endpoint','req'); });
document.getElementById('addMAuthRespRow').addEventListener('click', ()=>{ authParamsStore.endpoint.resp.push(newAuthParamRow()); renderAuthParamRows('endpoint','resp'); });

function openProjectModal(projectId, initialTab){
  if(!isAdmin()){
    toast(`Only the Admin role can edit project settings (your role: ${roleMeta(state.authorRole).label})`);
    return;
  }
  editingProjectId = projectId;
  const proj = state.projects[projectId];
  if(!proj) return;

  document.getElementById('projSubtitle').textContent = proj.name;

  renderProjectDocsList(proj);
  renderReleasePipeline(proj);
  renderProjectEnvUrls(proj);

  const archStatusEl = document.getElementById('projArchStatus');
  if(archStatusEl){
    archStatusEl.textContent = proj.architectureDiagram
      ? `Last published${proj.architectureDiagram.updatedBy ? ' by ' + proj.architectureDiagram.updatedBy : ''}${proj.architectureDiagram.updatedAt ? ' · ' + formatDateTime(proj.architectureDiagram.updatedAt) : ''}.`
      : 'Not published yet.';
  }
  const tab = initialTab || 'release';
  document.querySelectorAll('.modal-tab').forEach(t=>t.classList.remove('active'));
  document.querySelector(`.modal-tab[data-mtab="${tab}"]`).classList.add('active');
  document.querySelectorAll('.modal-pane').forEach(p=>p.classList.remove('active'));
  document.querySelector(`.modal-pane[data-mpane="${tab}"]`).classList.add('active');

  document.getElementById('projectModal').classList.add('show');
}

// Project settings ▸ Environments — per-project base URL for each org
// environment (proj.environments[envId]). This is the field Try It, the
// OpenAPI export's server list, and the Control Center's per-project
// environment metrics all read (see server/routes/workspace.js
// GET /environment-metrics, GET /projects/:id/snapshot's server list, etc.).
// It was previously edited here too, then the tab was removed while the
// underlying field stayed load-bearing elsewhere — this restores the editor.
function renderProjectEnvUrls(proj){
  const list = document.getElementById('projEnvUrlList');
  if(!list) return;
  const envs = environments();
  if(!envs.length){
    list.innerHTML = `<div class="empty-field">No environments are configured for this organisation yet — add one from Your Profile first.</div>`;
    return;
  }
  const canEdit = isAdmin();
  list.innerHTML = envs.map(e=>{
    const val = (proj.environments && proj.environments[e.id]) || '';
    return `<div class="field" style="margin:0;">
      <label style="display:flex;align-items:center;gap:8px;">
        <span class="env-chip" style="--env-accent:${envAccentColor(e.id)};--env-accent-bg:${envBgColor(e.id)};">${escapeHtml(e.label)}</span>
      </label>
      <input type="text" data-proj-env-url="${e.id}" value="${escapeHtml(val)}" placeholder="https://${e.id.toLowerCase()}.example.com" ${canEdit?'':'disabled'}>
    </div>`;
  }).join('');

  list.querySelectorAll('[data-proj-env-url]').forEach(input=>{
    input.addEventListener('change', ()=>{
      const envId = input.getAttribute('data-proj-env-url');
      const p = state.projects[editingProjectId];
      if(!p) return;
      p.environments = p.environments || {};
      const val = input.value.trim();
      if(val) p.environments[envId] = val; else delete p.environments[envId];
      p.updatedAt = new Date().toISOString();
      saveState();
      state.envMetricsStatus = 'idle'; // base URLs don't feed the metric directly, but keep things fresh
      renderSidebar();
    });
  });
}

/* ---------- Project documents / attachments — settings-tab list + upload ---------- */
function renderProjectDocsList(proj){
  const meterEl = document.getElementById('projDocsStorageMeter');
  const listEl = document.getElementById('projDocsList');
  if(!meterEl || !listEl) return;

  const totalBytes = totalDocStorageBytes();
  const pct = Math.min(100, Math.round((totalBytes / DOC_STORAGE_SOFT_CAP) * 100));
  const meterCls = pct >= 90 ? 'danger' : pct >= 65 ? 'warn' : '';
  meterEl.innerHTML = `
    <span>${formatFileSize(totalBytes)} used across all projects</span>
    <span class="bar"><span class="bar-fill ${meterCls}" style="width:${pct}%;"></span></span>`;

  const docs = (proj.attachments || []).slice().sort((a,b)=> new Date(b.uploadedAt) - new Date(a.uploadedAt));
  if(!docs.length){
    listEl.innerHTML = `<div class="empty-field">No documents uploaded yet.</div>`;
    return;
  }
  listEl.innerHTML = docs.map(d=>{
    const meta = docTypeMeta(d.name);
    return `
    <div class="doc-row">
      <div class="doc-row-ic" style="background:var(${meta.bg});color:var(${meta.accent});">${meta.label}</div>
      <div class="doc-row-main">
        <div class="doc-row-name" title="${escapeHtml(d.name)}">${escapeHtml(d.name)}</div>
        <div class="doc-row-meta">${formatFileSize(d.size)} · Uploaded ${formatDateTime(d.uploadedAt)}${d.uploadedBy ? ' by ' + escapeHtml(d.uploadedBy) : ''}</div>
      </div>
      <div class="doc-row-actions">
        <a class="icon-btn" href="${d.dataUrl ? d.dataUrl : `/api/workspace/projects/${proj.id}/attachments/${d.id}`}" download="${escapeHtml(d.name)}" title="Download">${ICON_DOWNLOAD}</a>
        <span class="icon-btn del" data-del-doc="${d.id}" title="Delete">${ICON_TRASH}</span>
      </div>
    </div>`;
  }).join('');

  listEl.querySelectorAll('[data-del-doc]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const docId = btn.getAttribute('data-del-doc');
      const doc = (proj.attachments||[]).find(a=>a.id===docId);
      proj.attachments = (proj.attachments||[]).filter(a=>a.id !== docId);
      if(doc) logAudit('deleted', 'document', doc.name, `Removed document "${doc.name}"`, proj.name);
      saveState();
      renderProjectDocsList(proj);
      if(state.selected && state.selected.type==='overview' && state.selected.projectId===proj.id) renderAll();
      toast(doc ? `Deleted ${doc.name}` : 'Document removed');
    });
  });
}

function handleProjectDocFiles(proj, fileList){
  const files = Array.from(fileList || []);
  if(!files.length || !proj) return;
  if(proj._readonly){ toast("You can only view this project — it's public content from someone else in your organisation."); return; }
  let remaining = files.length, added = 0, failed = 0;
  const finish = ()=>{
    renderProjectDocsList(proj);
    if(state.selected && state.selected.type==='overview' && state.selected.projectId===proj.id) renderAll();
    if(added) toast(`${added} document${added>1?'s':''} uploaded`);
    if(failed) toast(added ? `${failed} file${failed>1?'s':''} could not be saved — storage may be full` : 'Storage full — could not save the file(s). Try smaller files.');
  };
  files.forEach(file=>{
    const reader = new FileReader();
    reader.onload = ()=>{
      const doc = {
        id: uid(), name: file.name, size: file.size, type: file.type || '',
        dataUrl: reader.result, uploadedAt: new Date().toISOString(), uploadedBy: state.authorName || '',
      };
      const prevAttachments = proj.attachments.slice();
      proj.attachments.push(doc);
      if(saveState()){ added++; logAudit('created', 'document', doc.name, `Added document "${doc.name}"`, proj.name); } else { proj.attachments = prevAttachments; failed++; }
      remaining--;
      if(remaining === 0) finish();
    };
    reader.onerror = ()=>{ failed++; remaining--; if(remaining===0) finish(); };
    reader.readAsDataURL(file);
  });
}

document.getElementById('projDocsZone').addEventListener('click', ()=>document.getElementById('projDocsInput').click());
document.getElementById('projDocsInput').addEventListener('change', (e)=>{
  const proj = state.projects[editingProjectId];
  handleProjectDocFiles(proj, e.target.files);
  e.target.value = '';
});
['dragover','dragleave','drop'].forEach(evt=>{
  document.getElementById('projDocsZone').addEventListener(evt, (e)=>{
    e.preventDefault();
    e.stopPropagation();
    document.getElementById('projDocsZone').classList.toggle('drag', evt==='dragover');
    if(evt==='drop'){
      const proj = state.projects[editingProjectId];
      handleProjectDocFiles(proj, e.dataTransfer.files);
    }
  });
});

function closeProjectModal(){
  document.getElementById('projectModal').classList.remove('show');
  editingProjectId = null;
}

/* saveProjectSettings() was removed along with the General and Auth tabs —
   Release Pipeline, Documents and Architecture (the only tabs left) all
   already save immediately on their own (promote/merge, per-file upload,
   and the separate Architecture Studio tab, respectively), so this modal
   no longer needs an explicit "Save settings" step. Project name,
   description, lifecycle, owner, team, terms, contact, license, request
   flow direction and auth config are now edited from the Add/Edit endpoint
   modal's "Project details" and "Authentication" sections instead — see
   saveManualEndpoint(). */
