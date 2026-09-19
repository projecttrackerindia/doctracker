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
// ---- Request flows editor ----
// The "Request flows" builder in this modal's Project details section. The UI
// itself lives in public/js/flow-editor.js (shared with the full-page endpoint
// editor, server/views/editor.html, so the two can't drift apart). Read side:
// resolveRequestFlows (03-notifications.js) and requestFlowSectionHtml
// (10-metrics.js) — an empty list falls back to the default Client/Gateway/
// Flow/Downstream template.
const endpointFlowEditor = FlowEditor.create({ root: document.getElementById('mFlowsRoot') });
// Per-endpoint flow diagram — separate instance/mount from the project-wide
// one above. Backed by ep.requestFlows (not proj.requestFlows). Empty means
// "use the project's flows", handled by resolveRequestFlows's ep fallback.
const epFlowEditor = FlowEditor.create({ root: document.getElementById('mEpFlowsRoot') });

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
  endpointFlowEditor.load(proj);

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
  endpointFlowEditor.load({});
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
    epFlowEditor.load(ep);
  } else {
    title.textContent = 'Add endpoint';
    deleteBtn.classList.add('hidden');
    ['mProject','mPath','mTag','mVersion','mContentType','mSummary','mDesc','mBody','mApiDesc'].forEach(id=>document.getElementById(id).value = '');
    document.getElementById('mMethod').value = 'GET';
    document.getElementById('mContentType').value = 'application/json';
    document.getElementById('mVisibility').value = 'private';
    clearEndpointProjectFields();
    epFlowEditor.load({});
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
  // This endpoint's own flow diagram (separate from the project-wide one
  // applied to `proj` below) — empty collect() result means "none set",
  // so resolveRequestFlows falls back to the project's flows for display.
  fields.requestFlows = epFlowEditor.collect();

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
  // Stages that were added and left blank are dropped by collect(), so they
  // never render as empty boxes; an empty list falls back to the default diagram.
  FlowEditor.applyToProject(proj, endpointFlowEditor.collect());
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
   The actual promote/diff/merge-history/rollback UI moved to its own
   full-page tab (server/views/release-pipeline.html, opened via
   openReleasePipelineTab() — same pattern as Architecture Studio). All
   this modal shows now is a one-line status so it's obvious at a glance
   whether anything needs attention before opening that tab. */
async function renderReleaseStatus(proj){
  const el = document.getElementById('projReleaseStatus');
  if(!el) return;
  el.textContent = 'Loading…';
  let data;
  try{ data = await apiGet(`/projects/${encodeURIComponent(proj.id)}/versions`); }
  catch(e){
    el.textContent = 'Could not load release pipeline status.';
    return;
  }
  const stages = data.stages || [];
  const summary = stages.map(s=> s.isDraftStage ? data.draftLabel : (s.versionLabel || 'nothing promoted')).join(' → ');
  const lastPromoted = stages.slice().reverse().find(s=>!s.isDraftStage && s.promotedAt);
  el.textContent = summary + (lastPromoted ? ` · last promotion: ${lastPromoted.label} by ${lastPromoted.promotedBy || 'unknown'}` : '');
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
  renderReleaseStatus(proj);
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
