
(function(){
  const search = document.getElementById('alSearch');
  const actionSel = document.getElementById('alActionFilter');
  const entitySel = document.getElementById('alEntityFilter');
  const actorSel = document.getElementById('alActorFilter');
  const fromDate = document.getElementById('alFromDate');
  const toDate = document.getElementById('alToDate');
  const dateClear = document.getElementById('alDateClear');
  const pageSizeSel = document.getElementById('alPageSize');
  const prevBtn = document.getElementById('alPrevPage');
  const nextBtn = document.getElementById('alNextPage');
  const pageIndicator = document.getElementById('alPageIndicator');
  const rows = Array.from(document.querySelectorAll('#alBody tr'));
  const countEl = document.getElementById('alCount');
  let currentPage = 1;

  function rowMatches(r){
    const q = search.value.trim().toLowerCase();
    const action = actionSel.value;
    const entity = entitySel.value;
    const actor = actorSel.value;
    const tsAttr = r.getAttribute('data-ts');
    const ts = tsAttr ? Number(tsAttr) : NaN;
    const from = fromDate.value ? new Date(fromDate.value + 'T00:00:00').getTime() : null;
    const to = toDate.value ? new Date(toDate.value + 'T23:59:59.999').getTime() : null;
    const matchesSearch = !q || (r.getAttribute('data-search')||'').includes(q);
    const matchesAction = !action || r.getAttribute('data-action') === action;
    const matchesEntity = !entity || r.getAttribute('data-entity') === entity;
    const matchesActor = !actor || r.getAttribute('data-actor') === actor;
    const matchesFrom = from === null || (!isNaN(ts) && ts >= from);
    const matchesTo = to === null || (!isNaN(ts) && ts <= to);
    return matchesSearch && matchesAction && matchesEntity && matchesActor && matchesFrom && matchesTo;
  }

  function applyFilters(resetPage){
    if(resetPage) currentPage = 1;
    const matched = rows.filter(rowMatches);
    const pageSize = parseInt((pageSizeSel && pageSizeSel.value) || '50', 10) || 50;
    const totalPages = Math.max(1, Math.ceil(matched.length / pageSize));
    if(currentPage > totalPages) currentPage = totalPages;
    if(currentPage < 1) currentPage = 1;
    const start = (currentPage - 1) * pageSize;
    const end = start + pageSize;
    const matchedSet = new Set(matched);
    rows.forEach(r=>{
      const idx = matched.indexOf(r);
      const inPage = matchedSet.has(r) && idx >= start && idx < end;
      r.classList.toggle('al-hidden', !inPage);
    });
    countEl.textContent = matched.length + ' of ' + rows.length + ' change' + (rows.length===1?'':'s');
    if(pageIndicator) pageIndicator.textContent = 'Page ' + currentPage + ' of ' + totalPages;
    if(prevBtn) prevBtn.disabled = currentPage <= 1;
    if(nextBtn) nextBtn.disabled = currentPage >= totalPages;
  }

  [search].forEach(el=>el.addEventListener('input', ()=>applyFilters(true)));
  [actionSel, entitySel, actorSel, fromDate, toDate].forEach(el=>el.addEventListener('change', ()=>applyFilters(true)));
  if(pageSizeSel) pageSizeSel.addEventListener('change', ()=>applyFilters(true));
  if(dateClear) dateClear.addEventListener('click', ()=>{ fromDate.value=''; toDate.value=''; applyFilters(true); });
  if(prevBtn) prevBtn.addEventListener('click', ()=>{ if(currentPage>1){ currentPage--; applyFilters(false); } });
  if(nextBtn) nextBtn.addEventListener('click', ()=>{ currentPage++; applyFilters(false); });

  applyFilters(true);
})();
<\/script>
</body>
</html>`;
}
function openAuditLogTab(){
  const w = window.open('', '_blank');
  if(!w){ toast('Please allow popups to open the audit log in a new tab.'); return; }
  w.document.open();
  w.document.write(buildAuditLogHtml());
  w.document.close();
}

/* ==================== SECTION:EXPORT-AS-PDF ====================
   Two-step flow: (1) pdfExportModal lets the person pick which endpoints to
   include, (2) buildExportPdfContentHtml() renders those endpoints into an
   offscreen light-theme container, which html2canvas rasterizes and jsPDF
   assembles into a downloadable multi-page PDF (pdf.save() triggers a real
   file download — no popups, no manual "print to PDF" step). Masking reuses
   the app's real rules — maskedFullUrl()/curlSample()/paramSection() already
   gate on sensitiveRevealed(), so an export never shows more than the
   exporting user's role can currently see. */
let pdfExportProjectId = null;

function openExportPdfModal(projectId){
  const proj = state.projects[projectId];
  if(!proj) return;
  pdfExportProjectId = projectId;
  document.getElementById('projActionsDD') && document.getElementById('projActionsDD').classList.remove('open');

  const groups = groupByTag(proj.endpoints);
  const listEl = document.getElementById('pdfEpList');
  if(!proj.endpoints.length){
    listEl.innerHTML = `<div class="pdf-ep-empty">This project has no endpoints yet — add one before exporting.</div>`;
  } else {
    listEl.innerHTML = Object.keys(groups).map(tag=>`
      <div class="pdf-ep-group" data-pdf-group="${escapeHtml(tag)}">
        <div class="pdf-ep-group-label">${escapeHtml(tag)}</div>
        ${groups[tag].map(ep=>`
          <label class="pdf-ep-row" data-pdf-row data-search="${escapeHtml((ep.method+' '+ep.path+' '+(ep.summary||'')).toLowerCase())}">
            <input type="checkbox" class="pdf-ep-check" value="${ep.id}" checked>
            <span class="badge ${methodClass(ep.method)}" style="flex-shrink:0;">${escapeHtml(ep.method)}</span>
            <span class="path">${escapeHtml(ep.path)}</span>
            ${ep.summary ? `<span class="summary">${escapeHtml(ep.summary)}</span>` : ''}
          </label>`).join('')}
      </div>`).join('');
  }

  const envLabel = envMeta(state.env).label;
  document.getElementById('pdfExportSubtitle').textContent = `${proj.endpoints.length} endpoint${proj.endpoints.length===1?'':'s'} in ${proj.name} — everything renders exactly as it looks in the ${envLabel} environment.`;
  document.getElementById('pdfEnvHint').textContent = `Exporting from the ${envLabel} environment as ${state.authorName || 'you'}.`;
  document.getElementById('pdfMaskHint').innerHTML = canRevealSensitive()
    ? `${ICON_LOCK} Secure values follow your current reveal setting — ${sensitiveRevealed() ? 'currently shown' : 'currently masked'} in the PDF too.`
    : `${ICON_LOCK} Secure URLs and secrets stay masked in the PDF — only an Admin can reveal them.`;
  updatePdfSelectedCount();

  document.getElementById('pdfExportModal').classList.add('show');
}
function closeExportPdfModal(){
  document.getElementById('pdfExportModal').classList.remove('show');
  const gen = document.getElementById('pdfExportGenerate');
  gen.classList.remove('loading');
  gen.querySelector('.pdf-generate-label').textContent = 'Generate PDF';
}
function updatePdfSelectedCount(){
  const n = document.querySelectorAll('.pdf-ep-check:checked').length;
  document.getElementById('pdfSelectedCount').textContent = `${n} selected`;
}
function filterPdfEpList(q){
  const query = (q||'').trim().toLowerCase();
  document.querySelectorAll('#pdfEpList [data-pdf-row]').forEach(row=>{
    row.style.display = !query || row.getAttribute('data-search').includes(query) ? '' : 'none';
  });
  document.querySelectorAll('#pdfEpList [data-pdf-group]').forEach(group=>{
    const anyVisible = Array.from(group.querySelectorAll('[data-pdf-row]')).some(r=>r.style.display !== 'none');
    group.style.display = anyVisible ? '' : 'none';
  });
}

// Staged, fake-but-honest progress copy — the actual render is near-instant, but a single
// abrupt jump cut feels broken for a "document generation" action, so it steps through
// what's genuinely happening (gather → mask → render → rasterize → save).
//
// Each "atom" (an endpoint header, one table, one code block, one response) is captured as
// its own image and placed as a whole unit — if it doesn't fit on the current page, the
// whole atom moves to the next page instead of being cut mid-row/mid-line. Only if a single
// atom is taller than a full page (a huge JSON example, say) does it get sliced, and only
// at that point — never a normal table or paragraph.
async function generateProjectPdf(){
  const proj = state.projects[pdfExportProjectId];
  if(!proj) return;
  const selectedIds = Array.from(document.querySelectorAll('.pdf-ep-check:checked')).map(c=>c.value);
  if(!selectedIds.length){ toast('Select at least one endpoint to export.'); return; }
  const endpoints = proj.endpoints.filter(ep=>selectedIds.includes(ep.id));
  const opts = {
    includeOverview: document.getElementById('pdfIncludeOverview').checked,
    includeNotes: document.getElementById('pdfIncludeNotes').checked,
  };

  if(typeof html2canvas === 'undefined' || !window.jspdf){
    toast('PDF engine failed to load — check your connection and try again.');
    return;
  }

  const gen = document.getElementById('pdfExportGenerate');
  const label = gen.querySelector('.pdf-generate-label');
  gen.classList.add('loading');
  const setStage = (text)=>{ label.textContent = text; };
  const wait = (ms)=>new Promise(r=>setTimeout(r, ms));

  let container = null;
  try{
    setStage('Gathering endpoints…');
    await wait(200);
    setStage('Applying access rules…');
    await wait(200);
    setStage('Rendering document…');
    container = document.createElement('div');
    container.className = 'pdf-print-root';
    container.innerHTML = buildExportPdfContentHtml(proj, endpoints, opts);
    document.body.appendChild(container);
    if(document.fonts && document.fonts.ready) await document.fonts.ready;
    await wait(60); // let layout settle before rasterizing

    const atoms = Array.from(container.querySelectorAll('.pdf-atom'));

    // html2canvas clones the *whole* document to compute a render tree, not just the
    // element you pass it — so anything else on the page still gets walked. This app's
    // own UI (env pill, escalation dots, etc.) uses CSS color-mix(), which html2canvas's
    // renderer can't parse, and it throws the moment it reaches one. Since none of that
    // is needed for the export, skip it entirely and only let our own container through.
    const ignoreForCanvas = (el)=>{
      if(el === container || container.contains(el)) return false;
      if(el.id === 'app') return true;
      if(el.classList && (el.classList.contains('modal-overlay') || el.classList.contains('palette-overlay') || el.classList.contains('render-overlay'))) return true;
      return false;
    };

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF('p', 'mm', 'a4');
    const marginX = 12, marginTop = 14, marginBottom = 14;
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const contentWidth = pageWidth - marginX * 2;
    const contentBottom = pageHeight - marginBottom;
    const gapMM = 3;
    let cursorY = marginTop;
    let firstAtom = true;

    for(let idx = 0; idx < atoms.length; idx++){
      setStage(`Rendering section ${idx + 1} of ${atoms.length}…`);
      const atomEl = atoms[idx];
      const canvas = await html2canvas(atomEl, { scale:2, backgroundColor:'#ffffff', useCORS:true, ignoreElements: ignoreForCanvas });
      const imgWidth = contentWidth;
      const imgHeight = (canvas.height * imgWidth) / canvas.width;
      const imgData = canvas.toDataURL('image/jpeg', 0.95);

      if(!firstAtom && cursorY + imgHeight > contentBottom){
        pdf.addPage();
        cursorY = marginTop;
      }
      firstAtom = false;

      if(imgHeight > (contentBottom - marginTop)){
        // Rare: a single atom (e.g. a very long example) is taller than one page —
        // slice just this atom across as many pages as it needs, using the page
        // boundary itself as a clip: draw the same image shifted upward on each
        // subsequent page so only the un-shown remainder falls within the page.
        let heightLeft = imgHeight;
        let position = cursorY;
        pdf.addImage(imgData, 'JPEG', marginX, position, imgWidth, imgHeight);
        heightLeft -= (contentBottom - cursorY);
        while(heightLeft > 0){
          pdf.addPage();
          position = marginTop - (imgHeight - heightLeft);
          pdf.addImage(imgData, 'JPEG', marginX, position, imgWidth, imgHeight);
          heightLeft -= (contentBottom - marginTop);
        }
        const usable = contentBottom - marginTop;
        cursorY = marginTop + (usable + heightLeft) + gapMM;
      } else {
        pdf.addImage(imgData, 'JPEG', marginX, cursorY, imgWidth, imgHeight);
        cursorY += imgHeight + gapMM;
      }
    }

    setStage('Saving file…');
    const filename = `${(proj.name||'api-docs').replace(/[^a-z0-9]+/gi,'-').replace(/^-+|-+$/g,'').toLowerCase() || 'api-docs'}.pdf`;
    pdf.save(filename);

    logAudit('exported', 'project', proj.name, `Exported ${endpoints.length} endpoint${endpoints.length===1?'':'s'} as PDF`, proj.name);
    closeExportPdfModal();
    toast(`Downloaded ${filename}`);
  }catch(err){
    console.error('PDF export failed', err);
    toast(`Couldn't generate the PDF${err && err.message ? ': ' + err.message : ''} — please try again.`);
  }finally{
    if(container && container.parentNode) container.parentNode.removeChild(container);
    gen.classList.remove('loading');
    label.textContent = 'Generate PDF';
  }
}

function buildExportPdfEndpointSection(proj, ep, index){
  const mClass = methodClass(ep.method);
  const pathParams = (ep.parameters||[]).filter(p=>p.in==='path');
  const queryParams = (ep.parameters||[]).filter(p=>!p.in || p.in==='query');
  const headerParams = ep.headers || (ep.parameters||[]).filter(p=>p.in==='header');
  const allParams = [...pathParams.map(p=>({...p, in:'path'})), ...queryParams.map(p=>({...p, in:'query'}))];

  const hasReqBody = !!(ep.requestBody && ep.requestBody.example);
  const responses = ep.responses || [];

  return `
  <section class="pdf-endpoint" id="ep-${escapeHtml(ep.id)}">
    <div class="pdf-atom pdf-atom-header">
      <div class="pdf-ep-banner grad-${mClass}">
        <span class="pdf-ep-index">${String(index+1).padStart(2,'0')}</span>
        <span class="badge-lg ${mClass}">${escapeHtml(ep.method)}</span>
        <span class="pdf-ep-path">${escapeHtml(ep.path)}</span>
        ${ep.version ? `<span class="pdf-ep-version">v${escapeHtml(ep.version)}</span>` : ''}
      </div>
      ${ep.summary ? `<div class="pdf-ep-summary">${escapeHtml(ep.summary)}</div>` : ''}
      ${ep.description ? `<div class="pdf-ep-desc">${renderMarkdown(ep.description)}</div>` : ''}
      <div class="pdf-ep-chips">
        <span class="pdf-chip">${escapeHtml(ep.tag || 'General')}</span>
        <span class="pdf-chip">${escapeHtml(ep.contentType || 'application/json')}</span>
        <span class="pdf-chip">${escapeHtml(envMeta(state.env).label)} environment</span>
      </div>
    </div>

    <div class="pdf-atom">
      <div class="pdf-code-card">
        <div class="pdf-code-head">Request<span class="pdf-code-head-sub">host masked unless revealed by an Admin</span></div>
        <pre class="pdf-code">${escapeHtml(curlSample(proj, ep))}</pre>
      </div>
    </div>

    ${allParams.length ? `<div class="pdf-atom">${paramSection('Path &amp; query parameters', allParams)}</div>` : ''}
    ${headerParams.length ? `<div class="pdf-atom">${paramSection('Headers', headerParams, 'header')}</div>` : ''}
    ${hasReqBody ? `<div class="pdf-atom"><div class="pdf-code-card"><div class="pdf-code-head">Example request body</div><pre class="pdf-code">${escapeHtml(maskedJsonString(ep.requestBody.example))}</pre></div></div>` : ''}

    <div class="pdf-atom pdf-atom-tight"><div class="pdf-section-title">Responses</div></div>
    ${responses.length ? responses.map(r=>{
      const cls = respClass(r.code);
      return `<div class="pdf-atom">
        <div class="pdf-resp">
          <div class="pdf-resp-head">
            <span class="pdf-status-pill st-${cls}">${escapeHtml(String(r.code))}</span>
            <span class="pdf-resp-desc">${escapeHtml(r.description || '')}</span>
          </div>
          ${r.fields && r.fields.length ? paramSection('Response fields', r.fields, r.code) : ''}
          ${r.example ? `<div class="pdf-code-card"><div class="pdf-code-head">Example response</div><pre class="pdf-code">${escapeHtml(maskedJsonString(r.example))}</pre></div>` : ''}
        </div>
      </div>`;
    }).join('') : '<div class="pdf-atom pdf-atom-tight"><div class="pdf-empty">No responses documented.</div></div>'}
  </section>`;
}

function buildExportPdfContentHtml(proj, endpoints, opts){
  const groups = groupByTag(endpoints);
  const generatedAt = new Date();
  const generatedAtStr = generatedAt.toLocaleDateString(undefined,{month:'long', day:'numeric', year:'numeric'}) + ' at ' + generatedAt.toLocaleTimeString(undefined,{hour:'numeric', minute:'2-digit'});
  const env = envMeta(state.env);
  const envLabel = env.label;

  const flowPreset = resolveFlowDirection(proj);
  const direction = flowPreset.pattern;
  const isCustomFlowPreset = flowPreset.id !== '1-way' && flowPreset.id !== '2-way';
  const flowStages = [
    { k:'Client', v:'Consumer app', icon:'client' },
    { k:`${env.label} · MuleSoft`, v:'API Gateway', icon:'gateway' },
    { k:'Flow', v: proj.name, icon:'flow' },
    { k:'Downstream', v:'Backend system', icon:'downstream' },
  ];

  const lifecycleHtml = proj.lifecycle ? `
    <div class="pdf-atom">
    <section>
      <div class="pdf-section-title">Lifecycle</div>
      <div class="pdf-lc-card">
        <div class="pdf-lc-top">
          <span class="pdf-lc-badge" style="${pdfLifecycleBadgeStyle(proj.lifecycle)}">${escapeHtml(proj.lifecycle)}</span>
          <span class="pdf-lc-chip"><span class="k">Owner</span>${proj.owner ? escapeHtml(proj.owner) : 'Not set'}</span>
          <span class="pdf-lc-chip"><span class="k">Team</span>${proj.team ? escapeHtml(proj.team) : 'Not set'}</span>
        </div>
        ${pdfLifecycleWheelSvg(proj.lifecycle)}
      </div>
    </section>
    </div>` : '';

  const requestFlowHtml = `
    <div class="pdf-atom">
    <section>
      <div class="pdf-section-title">Request flow <span style="text-transform:none; letter-spacing:0; font-weight:500; color:#8890a3;">— ${isCustomFlowPreset ? escapeHtml(flowPreset.label) : (direction==='2-way' ? 'two-way (request &amp; response)' : 'one-way (request only)')}</span></div>
      ${pdfRequestFlowSvg(flowStages, direction)}
      <div class="pdf-rf-legend">
        <span><span class="sw"></span>Request</span>
        ${direction==='2-way' ? '<span><span class="sw ret"></span>Response</span>' : ''}
      </div>
    </section>
    </div>`;

  const endpointsHistoryHtml = endpoints.length ? `
    <div class="pdf-atom">
    <section>
      <div class="pdf-section-title">Endpoints <span style="text-transform:none; letter-spacing:0; font-weight:500; color:#8890a3;">— added &amp; last-modified history</span></div>
      <table class="data-table">
        <thead><tr><th>Endpoint</th><th>Added</th><th>Last modified</th></tr></thead>
        <tbody>
          ${endpoints.map(ep=>`
            <tr>
              <td><span class="badge ${methodClass(ep.method)}" style="margin-right:8px;">${escapeHtml(ep.method)}</span><span class="pexample">${escapeHtml(ep.path)}</span></td>
              <td>${ep.createdAt ? escapeHtml(formatDateTime(ep.createdAt)) : '<span class="empty-field">Unknown</span>'}${ep.createdBy ? ' by ' + escapeHtml(ep.createdBy) : ''}</td>
              <td>${ep.updatedAt ? escapeHtml(formatDateTime(ep.updatedAt)) : '<span class="empty-field">Unknown</span>'}${ep.updatedBy ? ' by ' + escapeHtml(ep.updatedBy) : ''}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </section>
    </div>` : '';

  const tocHtml = Object.keys(groups).map(tag=>`
    <div class="pdf-toc-group">
      <div class="pdf-toc-tag">${escapeHtml(tag)}</div>
      ${groups[tag].map(ep=>`<a class="pdf-toc-row" href="#ep-${escapeHtml(ep.id)}"><span class="badge ${methodClass(ep.method)}">${escapeHtml(ep.method)}</span><span class="pdf-toc-path">${escapeHtml(ep.path)}</span></a>`).join('')}
    </div>`).join('');

  const coverHtml = opts.includeOverview ? `
    <div class="pdf-atom">
    <section class="pdf-cover">
      <div class="pdf-cover-badge"><span class="dot"></span>API Studio · ${escapeHtml(envLabel)} environment</div>
      <h1>${escapeHtml(proj.name)}</h1>
      <div class="pdf-cover-sub">${proj.description ? renderMarkdown(proj.description) : 'API documentation export.'}</div>
      <div class="pdf-cover-stats">
        <div class="pdf-cover-stat"><div class="n">${endpoints.length}</div><div class="l">Endpoints in this export</div></div>
        <div class="pdf-cover-stat"><div class="n">${Object.keys(groups).length}</div><div class="l">Tag${Object.keys(groups).length===1?'':'s'}</div></div>
        <div class="pdf-cover-stat"><div class="n">${proj.auth && proj.auth.type ? escapeHtml(proj.auth.type) : 'None'}</div><div class="l">Authentication</div></div>
        <div class="pdf-cover-stat"><div class="n">${proj.lifecycle ? escapeHtml(proj.lifecycle) : '—'}</div><div class="l">Lifecycle</div></div>
      </div>
      ${proj.auth && proj.auth.type ? `<div class="pdf-auth-card"><div class="ic">🔑</div><div><div class="h">${escapeHtml(proj.auth.type)}${proj.auth.headerName ? ' · '+escapeHtml(proj.auth.headerName)+' header' : ''}</div>${proj.auth.path ? `<div class="d" style="margin-top:4px;"><span class="badge ${methodClass(proj.auth.method||'POST')}" style="margin-right:8px;">${escapeHtml(proj.auth.method||'POST')}</span><span style="font-family:var(--mono);">${escapeHtml(proj.auth.path)}</span></div>` : ''}<div class="d">${proj.auth.description ? escapeHtml(proj.auth.description) : 'No further notes.'}</div></div></div>` : ''}
      ${proj.auth && proj.auth.includeInDocs && ((proj.auth.requestParams||[]).length || (proj.auth.responseParams||[]).length) ? `
      <div style="text-align:left; max-width:640px; margin:14px auto 0;">
        ${paramSection('Auth request parameters', proj.auth.requestParams||[])}
        ${paramSection('Auth response parameters', proj.auth.responseParams||[])}
      </div>` : ''}
      ${opts.includeNotes && proj.notes ? `<div class="pdf-notes-card"><div class="pdf-notes-title">Integration notes</div><div class="pdf-notes-body">${escapeHtml(proj.notes)}</div></div>` : ''}
    </section>
    </div>
    ${lifecycleHtml}
    ${requestFlowHtml}
    ${endpointsHistoryHtml}
    <div class="pdf-atom">
    <section class="pdf-toc">
      <div class="pdf-section-title">Contents</div>
      ${tocHtml}
    </section>
    </div>` : '';

  const endpointsHtml = endpoints.map((ep,i)=>buildExportPdfEndpointSection(proj, ep, i)).join('');

  return `
    ${coverHtml}
    ${endpointsHtml}
    <div class="pdf-atom pdf-atom-tight"><div class="pdf-footer">${escapeHtml(proj.name)} · Generated by API Studio · ${escapeHtml(generatedAtStr)} · by ${escapeHtml(state.authorName || 'Unknown')}</div></div>
  `;
}

/* ==================== SECTION:EVENTS ==================== */
document.getElementById('fileInput').addEventListener('change', (e)=>{
  if(e.target.files[0]) handleImportedFile(e.target.files[0]);
  e.target.value = '';
});
document.getElementById('btnAuditLog').addEventListener('click', openAuditLogTab);
document.getElementById('btnSecurityCenter').addEventListener('click', ()=>{
  state.selected = { type:'security' };
  state.securityTab = state.securityTab || 'summary';
  renderMain();
});
document.getElementById('btnFab').addEventListener('click', ()=>{
  if(!canEdit()){ toast(`Your role (${roleMeta(state.authorRole).label}) is read-only`); return; }
  openManualModal();
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
document.getElementById('pgSave').addEventListener('click', saveProjectSettings);

/* ---------- Request flow direction: custom preset builder wiring ---------- */
document.getElementById('pgFlowDirection').addEventListener('change', (e)=>{
  const builder = document.getElementById('flowCustomBuilder');
  if(e.target.value === '__add_custom__'){
    builder.style.display = 'block';
    document.getElementById('flowCustomLabel').focus();
  } else {
    builder.style.display = 'none';
  }
});
document.getElementById('flowCustomCancel').addEventListener('click', ()=>{
  document.getElementById('flowCustomBuilder').style.display = 'none';
  const proj = state.projects[editingProjectId];
  populateFlowDirectionSelect(proj ? (proj.requestFlowDirection || '1-way') : '1-way');
});
document.getElementById('flowCustomAdd').addEventListener('click', ()=>{
  const label = document.getElementById('flowCustomLabel').value.trim();
  if(!label){ toast('Enter a label for the custom direction'); return; }
  const pattern = document.getElementById('flowCustomPattern').value === '2-way' ? '2-way' : '1-way';
  const id = 'custom_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const list = (state.customFlowDirections || []).slice();
  list.push({ id, label, pattern });
  saveCustomFlowDirections(list);
  document.getElementById('flowCustomBuilder').style.display = 'none';
  document.getElementById('flowCustomLabel').value = '';
  populateFlowDirectionSelect(id);
  toast('Custom flow direction added');
});

/* ---------- Environments tab: live status + copy-to-clipboard ---------- */
document.getElementById('envInputs').addEventListener('input', (e)=>{
  const inp = e.target.closest('[data-env-input]');
  if(!inp) return;
  const card = inp.closest('.env-settings-card');
  const status = card && card.querySelector('[data-esc-status]');
  const has = !!inp.value.trim();
  if(status){
    status.textContent = has ? 'Configured' : 'Not set';
    status.classList.toggle('set', has);
    status.classList.toggle('unset', !has);
  }
  updateEnvSettingsSummary();
});
document.getElementById('envInputs').addEventListener('click', (e)=>{
  const btn = e.target.closest('[data-env-copy]');
  if(!btn) return;
  const id = btn.getAttribute('data-env-copy');
  const inp = document.querySelector(`[data-env-input="${id}"]`);
  if(inp && inp.value.trim() && navigator.clipboard){
    navigator.clipboard.writeText(inp.value.trim()).then(()=> toast('Base URL copied')).catch(()=>{});
  }
});

document.querySelectorAll('[data-md-insert]').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    const tpl = MD_TEMPLATES[btn.getAttribute('data-md-insert')];
    const targetId = btn.getAttribute('data-md-target') || 'pgDesc';
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
wireMdPreviewToggle('pgDescPreviewToggle', 'pgDesc', 'pgDescPreview');
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
  }
});

/* ---------- Sidebar / rail chrome toggles ---------- */
document.getElementById('btnSidebarToggle').addEventListener('click', toggleSidebar);
document.getElementById('btnSidebarEdgeToggle').addEventListener('click', toggleSidebar);

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
  if(envRowMenu.id !== null){
    const openDD = document.querySelector(`.row-actions-dd[data-row-dd="${envRowMenu.id}"]`);
    if(openDD && !openDD.contains(e.target)){ envRowMenu = { id:null, mode:'menu' }; renderEnvTableSection(); }
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
document.addEventListener('scroll', (e)=>{
  if(envRowMenu.id !== null){ envRowMenu = { id:null, mode:'menu' }; renderEnvTableSection(); }
}, true);
function openCodeSamplesRail(){
  document.getElementById('rail').classList.add('show');
  document.getElementById('railScrim').classList.add('show');
}
document.getElementById('railScrim').addEventListener('click', ()=>{
  document.getElementById('rail').classList.remove('show');
  document.getElementById('railScrim').classList.remove('show');
});
/* ==================== SECTION:INIT ==================== */
(async function boot(){
  await loadState();
  renderAuthorLabel();
  document.getElementById('btnSecurityCenter').style.display = isAdmin() ? '' : 'none';
  renderAll();
})();

;
