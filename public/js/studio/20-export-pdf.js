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

  const epsForExport = viewEndpoints(proj);
  const groups = groupByTag(epsForExport);
  const listEl = document.getElementById('pdfEpList');
  if(!epsForExport.length){
    listEl.innerHTML = `<div class="pdf-ep-empty">${isViewingDraftEnv() ? 'This project has no endpoints yet — add one before exporting.' : `Nothing's been promoted to ${escapeHtml(envMeta(state.env).label)} yet — switch environments or promote endpoints first.`}</div>`;
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
  document.getElementById('pdfExportSubtitle').textContent = `${epsForExport.length} endpoint${epsForExport.length===1?'':'s'} in ${proj.name} — everything renders exactly as it looks in the ${envLabel} environment.`;
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

// These mirror the page/margin numbers used inside generateProjectPdf() below. They're
// pulled out as constants so the code-chunking pass here and the live pagination loop
// there can never quietly disagree about how much vertical space a page actually has —
// that kind of drift is exactly what caused the duplicated-text page-split bug.
const PDF_PAGE_WIDTH_MM = 210;   // A4 portrait
const PDF_PAGE_HEIGHT_MM = 297;  // A4 portrait
const PDF_MARGIN_X_MM = 12;
const PDF_FRAME_INSET_MM = 5;        // outer bordered frame, inset from the physical page edge — sits entirely outside PDF_MARGIN_X_MM, so it never touches content
const PDF_LETTERHEAD_HEIGHT_MM = 11; // reserved band at the top of every page for the org logo/slug letterhead + its rule line — kept small/quiet since page 1 already carries the full-size branding moment
const PDF_FOOTER_BAND_HEIGHT_MM = 10; // reserved band at the bottom of every page for the footer rule + page number
// The letterhead and footer are drawn natively with jsPDF (see stampPdfPage below), stamped
// once per finished physical page, well after every content "atom" has already been placed —
// never as part of a rasterized atom. That's what guarantees they can't be sliced, overlapped,
// or dropped by the atom-pagination logic below: reserving their height in the margins here
// keeps content atoms out of that space in the first place, and the final stamping pass just
// fills it in once the real page count is known.
const PDF_MARGIN_TOP_MM = 6 + PDF_LETTERHEAD_HEIGHT_MM;
const PDF_MARGIN_BOTTOM_MM = 6 + PDF_FOOTER_BAND_HEIGHT_MM;
const PDF_CONTENT_WIDTH_MM = PDF_PAGE_WIDTH_MM - PDF_MARGIN_X_MM * 2;
const PDF_PAGE_CONTENT_HEIGHT_MM = PDF_PAGE_HEIGHT_MM - PDF_MARGIN_TOP_MM - PDF_MARGIN_BOTTOM_MM;

// Long JSON/curl examples (marked with data-pdf-code-chunkable) are the main reason an
// atom would ever end up taller than a page. Rather than let that happen and rely on the
// slice-across-pages fallback further down, split them into several page-sized code-card
// atoms *before* rasterizing, at real line boundaries — so ordinary pagination just moves
// whole chunks to the next page, the same as everything else, and a JSON example never
// gets cut mid-line.
function splitTallCodeAtomsForPdf(container){
  const candidates = Array.from(container.querySelectorAll('[data-pdf-code-chunkable]'));
  candidates.forEach(atomEl=>{
    const pre = atomEl.querySelector('pre.pdf-code');
    const card = atomEl.querySelector('.pdf-code-card');
    if(!pre || !card) return;

    const atomWidthPx = atomEl.getBoundingClientRect().width;
    if(!atomWidthPx) return;
    const mmPerPx = PDF_CONTENT_WIDTH_MM / atomWidthPx;
    const fullPagePx = PDF_PAGE_CONTENT_HEIGHT_MM / mmPerPx;
    // Target well under a full page, since a chunk usually won't start at the very
    // top of a page — this keeps it landing cleanly wherever it falls.
    const targetChunkPx = fullPagePx * 0.55;

    const atomHeightPx = atomEl.getBoundingClientRect().height;
    if(atomHeightPx <= targetChunkPx) return; // already comfortably fits on a page

    const lines = pre.textContent.split('\n');
    if(lines.length <= 1) return; // nothing to split on — leave it to the fallback slicer

    const preHeightPx = pre.getBoundingClientRect().height;
    const chromePx = card.getBoundingClientRect().height - preHeightPx; // header + padding/borders, repeated on every chunk
    const pxPerLine = preHeightPx / lines.length;
    const usablePerChunkPx = Math.max(targetChunkPx - chromePx, pxPerLine * 4);
    const linesPerChunk = Math.max(1, Math.floor(usablePerChunkPx / pxPerLine));
    if(linesPerChunk >= lines.length) return; // wouldn't actually split anything

    const label = atomEl.dataset.pdfChunkLabel || 'Code';
    const sub = atomEl.dataset.pdfChunkSub || '';
    const chunks = [];
    for(let i = 0; i < lines.length; i += linesPerChunk) chunks.push(lines.slice(i, i + linesPerChunk).join('\n'));

    const frag = document.createDocumentFragment();
    chunks.forEach((chunkText, i)=>{
      const wrap = document.createElement('div');
      wrap.className = 'pdf-atom';
      const partSuffix = chunks.length > 1 ? ` <span class="pdf-code-head-sub">(part ${i+1} of ${chunks.length})</span>` : '';
      const subSpan = (i === 0 && sub) ? `<span class="pdf-code-head-sub">${escapeHtml(sub)}</span>` : '';
      wrap.innerHTML = `<div class="pdf-code-card"><div class="pdf-code-head">${escapeHtml(label)}${partSuffix}${subSpan}</div><pre class="pdf-code"></pre></div>`;
      wrap.querySelector('pre.pdf-code').textContent = chunkText; // textContent re-escapes for us — chunkText is already the decoded original
      frag.appendChild(wrap);
    });
    atomEl.replaceWith(frag);
  });
}

// ---------- Native per-page letterhead, footer, and border ----------
// Everything above is rasterized HTML placed as "atoms". This is deliberately
// the opposite: plain jsPDF vector/text primitives, stamped directly onto
// each finished page in one pass at the very end of generateProjectPdf(), once
// pdf.internal.getNumberOfPages() gives a real total. Two consequences of
// that: (1) it stays pixel-crisp at any zoom instead of being a raster image,
// and (2) it is structurally impossible for it to be cut off, duplicated, or
// overlapped by the atom-pagination logic — it only ever touches the margin
// band that logic was told (via PDF_MARGIN_TOP_MM/PDF_MARGIN_BOTTOM_MM above)
// to leave empty.
function pdfImageFormatFromDataUrl(dataUrl){
  if(/^data:image\/webp/i.test(dataUrl)) return 'WEBP';
  if(/^data:image\/jpe?g/i.test(dataUrl)) return 'JPEG';
  return 'PNG'; // the branding upload (12-security-center.js) always normalizes to PNG
}
const PDF_LOGO_MAX_W_MM = 20, PDF_LOGO_MAX_H_MM = 5.5; // the running header's logo box — small and quiet; the cover page carries the large version
// Resolves the logo's draw size in mm, preserving its real aspect ratio so a wide
// banner-shaped logo doesn't get squashed into a square. Prefers branding.logoWidth/
// logoHeight (captured at upload time — see 12-security-center.js); falls back to a
// one-time async decode for logos saved before that existed, so older uploads don't
// need to be re-uploaded to render correctly. Computed ONCE before the per-page
// stamping loop in generateProjectPdf() — never per-page — since it never changes
// across pages of the same export.
function resolvePdfLogoBox(logoDataUrl, storedWidth, storedHeight){
  return new Promise((resolve)=>{
    const fit = (w, h)=>{
      const aspect = (w > 0 && h > 0) ? (w / h) : 1;
      return aspect >= (PDF_LOGO_MAX_W_MM / PDF_LOGO_MAX_H_MM)
        ? { w: PDF_LOGO_MAX_W_MM, h: PDF_LOGO_MAX_W_MM / aspect }
        : { h: PDF_LOGO_MAX_H_MM, w: PDF_LOGO_MAX_H_MM * aspect };
    };
    if(!logoDataUrl){ resolve(null); return; }
    if(storedWidth > 0 && storedHeight > 0){ resolve(fit(storedWidth, storedHeight)); return; }
    const img = new Image();
    img.onload = ()=>resolve(fit(img.naturalWidth, img.naturalHeight));
    img.onerror = ()=>resolve(fit(1, 1)); // couldn't decode it — fall back to a square rather than failing the export
    img.src = logoDataUrl;
  });
}
function stampPdfPage(pdf, { pageNum, totalPages, proj, generatedAtStr, author, orgLabel, logo, logoBox, skipLetterhead }){
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const marginX = PDF_MARGIN_X_MM;

  // Outer page frame — a thin, professional border on every page, cover included.
  // Inset far enough from the edge (PDF_FRAME_INSET_MM) that it can never collide
  // with content, which never draws closer to the edge than marginX.
  pdf.setDrawColor(226, 230, 238); // #e2e6ee — this doc's own border color
  pdf.setLineWidth(0.4);
  pdf.roundedRect(PDF_FRAME_INSET_MM, PDF_FRAME_INSET_MM, pageWidth - PDF_FRAME_INSET_MM * 2, pageHeight - PDF_FRAME_INSET_MM * 2, 2, 2, 'S');

  // Running letterhead: logo (real aspect ratio) + org name top-left; project name
  // top-right. Skipped on the cover page — it already carries its own, much larger
  // branding moment, so repeating a second (smaller) logo+org row right above it
  // would just be visual noise. Starts from page 2 instead, small and quiet: 8.5pt,
  // subtle letter-spacing, a running header rather than a second title.
  if(!skipLetterhead){
    const bandTop = 6;
    const headBaselineY = bandTop + PDF_LETTERHEAD_HEIGHT_MM / 2 + 1;
    let textStartX = marginX;
    if(logo && logoBox){
      try{
        pdf.addImage(logo, pdfImageFormatFromDataUrl(logo), marginX, bandTop + (PDF_LETTERHEAD_HEIGHT_MM - logoBox.h) / 2, logoBox.w, logoBox.h);
        textStartX = marginX + logoBox.w + 2.5;
      }catch(e){
        // A malformed/unsupported dataUrl shouldn't take the whole export down — fall back to text-only.
        console.warn('Could not draw org logo on PDF page', e);
      }
    }
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(8.5);
    pdf.setTextColor(15, 20, 32); // #0f1420
    pdf.text(orgLabel, textStartX, headBaselineY, { charSpace: 0.04 });
    pdf.setFontSize(8);
    pdf.setTextColor(140, 146, 160);
    pdf.text(proj.name || '', pageWidth - marginX, headBaselineY, { align:'right' });

    pdf.setDrawColor(226, 230, 238);
    pdf.setLineWidth(0.3);
    pdf.line(marginX, bandTop + PDF_LETTERHEAD_HEIGHT_MM - 1, pageWidth - marginX, bandTop + PDF_LETTERHEAD_HEIGHT_MM - 1);
  }

  // Footer: rule line, generated-by/date/author on the left, page count on the right.
  // Present on every page including the cover, so a loose page always identifies itself.
  const footerRuleY = pageHeight - PDF_FOOTER_BAND_HEIGHT_MM - 4;
  pdf.setDrawColor(226, 230, 238);
  pdf.setLineWidth(0.3);
  pdf.line(marginX, footerRuleY, pageWidth - marginX, footerRuleY);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(7.8);
  pdf.setTextColor(150, 155, 168);
  pdf.text(`${proj.name || ''} \u00b7 Generated by DocTracker \u00b7 ${generatedAtStr} \u00b7 by ${author}`, marginX, footerRuleY + 4.5, { charSpace: 0.03 });
  pdf.text(`Page ${pageNum} of ${totalPages}`, pageWidth - marginX, footerRuleY + 4.5, { align:'right' });
}

async function generateProjectPdf(){
  const proj = state.projects[pdfExportProjectId];
  if(!proj) return;
  const selectedIds = Array.from(document.querySelectorAll('.pdf-ep-check:checked')).map(c=>c.value);
  if(!selectedIds.length){ toast('Select at least one endpoint to export.'); return; }
  const endpoints = viewEndpoints(proj).filter(ep=>selectedIds.includes(ep.id));
  const generatedAt = new Date();
  const generatedAtStr = generatedAt.toLocaleDateString(undefined,{month:'long', day:'numeric', year:'numeric'}) + ' at ' + generatedAt.toLocaleTimeString(undefined,{hour:'numeric', minute:'2-digit'});
  const author = state.authorName || 'Unknown';
  const opts = {
    includeOverview: document.getElementById('pdfIncludeOverview').checked,
    includeNotes: document.getElementById('pdfIncludeNotes').checked,
    generatedAtStr,
    author,
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

    splitTallCodeAtomsForPdf(container); // break up any long JSON/curl examples into page-sized chunks first

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
    const marginX = PDF_MARGIN_X_MM, marginTop = PDF_MARGIN_TOP_MM, marginBottom = PDF_MARGIN_BOTTOM_MM;
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

      // Each endpoint's header atom carries this — guarantees an endpoint
      // always starts at the top of a fresh page instead of sometimes being
      // squeezed onto whatever little space is left at the bottom of the
      // previous page (which also meant its own later sections routinely
      // split awkwardly onto the page after that, with a big dead gap left
      // behind on the page where it started).
      if(atomEl.hasAttribute('data-pdf-force-page-break-before') && !firstAtom && cursorY > marginTop){
        pdf.addPage();
        cursorY = marginTop;
      }

      const canvas = await html2canvas(atomEl, { scale:2, backgroundColor:'#ffffff', useCORS:true, ignoreElements: ignoreForCanvas });
      const imgWidth = contentWidth;
      const imgHeight = (canvas.height * imgWidth) / canvas.width;

      if(!firstAtom && cursorY + imgHeight > contentBottom){
        pdf.addPage();
        cursorY = marginTop;
      }
      firstAtom = false;

      if(imgHeight > (contentBottom - marginTop)){
        // Rare even after the code-chunking pass above (e.g. one unbroken line too long
        // to split, or a very tall diagram): crop the *source canvas* into exact
        // page-sized pixel strips and place each as its own image, so every page shows
        // a precise, non-overlapping portion.
        //
        // The previous approach drew the same full image on each page, shifted upward,
        // and relied on the page boundary to clip whatever didn't belong on that page —
        // but a PDF page only clips at its physical edge, not at the bottom-margin line
        // the math here assumed. That margin strip actually got drawn (bleeding past
        // where the margin should start), and the same rows were then drawn again at the
        // top of the next page — a visible band of duplicated text at every seam.
        // Cropping the pixels themselves up front removes the ambiguity entirely.
        const pxPerMM = canvas.width / imgWidth;
        const pageSlicePx = Math.floor((contentBottom - marginTop) * pxPerMM);
        let renderedPx = 0;
        let firstSlice = true;
        while(renderedPx < canvas.height){
          if(!firstSlice){ pdf.addPage(); cursorY = marginTop; }
          firstSlice = false;
          const sliceHeightPx = Math.min(pageSlicePx, canvas.height - renderedPx);
          const sliceCanvas = document.createElement('canvas');
          sliceCanvas.width = canvas.width;
          sliceCanvas.height = sliceHeightPx;
          sliceCanvas.getContext('2d').drawImage(canvas, 0, renderedPx, canvas.width, sliceHeightPx, 0, 0, canvas.width, sliceHeightPx);
          const sliceImgHeight = sliceHeightPx / pxPerMM;
          pdf.addImage(sliceCanvas.toDataURL('image/jpeg', 0.95), 'JPEG', marginX, cursorY, imgWidth, sliceImgHeight);
          cursorY += sliceImgHeight;
          renderedPx += sliceHeightPx;
        }
        cursorY += gapMM;
      } else {
        const imgData = canvas.toDataURL('image/jpeg', 0.95);
        pdf.addImage(imgData, 'JPEG', marginX, cursorY, imgWidth, imgHeight);
        cursorY += imgHeight + gapMM;
      }

      // The cover page opts out of the normal "keep packing atoms onto this page
      // until they stop fitting" flow: it's meant to stand alone (large logo, lots
      // of quiet whitespace), never sharing a page with Overview/Stats/etc. just
      // because there happened to be room left over. data-pdf-force-page-break-after
      // forces the next atom onto a fresh page unconditionally, regardless of how
      // little vertical space this one actually used.
      if(atomEl.hasAttribute('data-pdf-force-page-break-after') && idx < atoms.length - 1){
        pdf.addPage();
        cursorY = marginTop;
      }
    }
    // Every atom is placed now, and the page count is final — stamp the letterhead,
    // border, and page-numbered footer onto every page in one pass. See the "Native
    // per-page letterhead, footer, and border" comment above for why this happens
    // here rather than inline with atom placement. The logo's fitted box is resolved
    // once (not per page) since it's identical on every page of this export.
    setStage('Adding letterhead…');
    const brand = state.branding || {};
    const orgLabel = (brand.orgDisplayName && brand.orgDisplayName.trim()) || state.organisation || 'DocTracker';
    const logo = brand.logoDataUrl || null;
    const logoBox = await resolvePdfLogoBox(logo, brand.logoWidth, brand.logoHeight);
    const totalPages = pdf.internal.getNumberOfPages();
    for(let p = 1; p <= totalPages; p++){
      pdf.setPage(p);
      stampPdfPage(pdf, { pageNum:p, totalPages, proj, generatedAtStr, author, orgLabel, logo, logoBox, skipLetterhead: p === 1 && opts.includeOverview });
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

function buildExportPdfEndpointSection(proj, ep, index, env){
  const mClass = methodClass(ep.method);
  const pathParams = (ep.parameters||[]).filter(p=>p.in==='path');
  const queryParams = (ep.parameters||[]).filter(p=>!p.in || p.in==='query');
  const headerParams = ep.headers || (ep.parameters||[]).filter(p=>p.in==='header');
  const allParams = [...pathParams.map(p=>({...p, in:'path'})), ...queryParams.map(p=>({...p, in:'query'}))];

  const hasReqBody = !!(ep.requestBody && ep.requestBody.example);
  const responses = ep.responses || [];

  // Each endpoint gets its own Request flow section — its own flows if it
  // has any, otherwise it falls back to the project's (see
  // resolveRequestFlows's ep parameter), same as the on-screen doc page.
  const epRequestFlowHtml = `
    <div class="pdf-atom">
    <section>
      ${pdfRequestFlowSectionInnerHtml(proj, env, ep)}
    </section>
    </div>`;

  return `
  <section class="pdf-endpoint" id="ep-${escapeHtml(ep.id)}">
    <div class="pdf-atom pdf-atom-header" data-pdf-force-page-break-before>
      <div class="pdf-ep-banner grad-${mClass}">
        <span class="pdf-ep-index">${String(index+1).padStart(2,'0')}</span>
        <span class="badge-lg ${mClass}">${escapeHtml(ep.method)}</span>
        <span class="pdf-ep-path">${escapeHtml(ep.path)}</span>
        ${(proj.version || ep.version) ? `<span class="pdf-ep-version">v${escapeHtml(proj.version || ep.version)}</span>` : ''}
      </div>
      ${ep.summary ? `<div class="pdf-ep-summary">${escapeHtml(ep.summary)}</div>` : ''}
      ${ep.description ? `<div class="pdf-ep-desc">${renderMarkdown(ep.description)}</div>` : ''}
      <div class="pdf-ep-chips">
        <span class="pdf-chip">${escapeHtml(ep.tag || 'General')}</span>
        <span class="pdf-chip">${escapeHtml(ep.contentType || 'application/json')}</span>
        <span class="pdf-chip">${escapeHtml(envMeta(state.env).label)} environment</span>
      </div>
    </div>

    ${epRequestFlowHtml}

    <div class="pdf-atom" data-pdf-code-chunkable data-pdf-chunk-label="Request" data-pdf-chunk-sub="host masked unless revealed by an Admin">
      <div class="pdf-code-card">
        <div class="pdf-code-head">Request<span class="pdf-code-head-sub">host masked unless revealed by an Admin</span></div>
        <pre class="pdf-code">${escapeHtml(curlSample(proj, ep))}</pre>
      </div>
    </div>

    ${allParams.length ? `<div class="pdf-atom">${paramSection('Path &amp; query parameters', allParams)}</div>` : ''}
    ${headerParams.length ? `<div class="pdf-atom">${paramSection('Headers', headerParams, 'header')}</div>` : ''}
    ${hasReqBody ? `<div class="pdf-atom" data-pdf-code-chunkable data-pdf-chunk-label="Example request body"><div class="pdf-code-card"><div class="pdf-code-head">Example request body</div><pre class="pdf-code">${escapeHtml(maskedJsonString(ep.requestBody.example))}</pre></div></div>` : ''}

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
        </div>
      </div>
      ${r.example ? `<div class="pdf-atom" data-pdf-code-chunkable data-pdf-chunk-label="Example response" data-pdf-chunk-sub="status ${escapeHtml(String(r.code))}"><div class="pdf-code-card"><div class="pdf-code-head">Example response<span class="pdf-code-head-sub">status ${escapeHtml(String(r.code))}</span></div><pre class="pdf-code">${escapeHtml(maskedJsonString(r.example))}</pre></div></div>` : ''}`;
    }).join('') : '<div class="pdf-atom pdf-atom-tight"><div class="pdf-empty">No responses documented.</div></div>'}
  </section>`;
}

function buildExportPdfContentHtml(proj, endpoints, opts){
  const groups = groupByTag(endpoints);
  const generatedAtStr = opts.generatedAtStr || (()=>{
    const d = new Date();
    return d.toLocaleDateString(undefined,{month:'long', day:'numeric', year:'numeric'}) + ' at ' + d.toLocaleTimeString(undefined,{hour:'numeric', minute:'2-digit'});
  })();
  const author = opts.author || state.authorName || 'Unknown';
  const lastModifiedStr = proj.updatedAt ? formatDateTime(proj.updatedAt) : '—';
  const env = envMeta(state.env);
  const envLabel = env.label;

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

  const coverLogoDataUrl = (state.branding && state.branding.logoDataUrl) || null;
  const coverOrgLabel = (state.branding && state.branding.orgDisplayName && state.branding.orgDisplayName.trim()) || state.organisation || '';
  // Sized to the page's real usable content height (not just this block's own natural
  // height) so justify-content:center in the CSS has genuine full-page room to center
  // the (now much shorter) logo/org/meta group within — otherwise it would just hug
  // the top of the page. 860 is this container's fixed pixel width (see .pdf-print-root),
  // so this converts the page's mm aspect ratio into px at that same scale. Kept at 90%
  // of the page's usable height (not a full 100%) as deliberate slack against real-world
  // font-metric/content-length variance pushing the block onto a second page.
  //
  // Page 1 now carries only the logo/org identity and the created/modified/generated
  // meta block, vertically centered as a group — the badge + project title have moved
  // to the top of page 2, right above "Overview". data-pdf-force-page-break-after still
  // guarantees page 1 stands alone even though its content no longer fills the page.
  //
  // Kept well under a full page (0.72, not the ~0.90 this used to be) — real logo
  // aspect ratios and font-metric variance can push the *actual* rendered height
  // a little past whatever this formula predicts, and if that happens the atom
  // silently falls into the "crop into page-sized slices" fallback further up,
  // which produces a nearly-empty second page (all the real content fit in the
  // first slice; the fallback still emits a second one for the sliver left over).
  // More slack here costs nothing but a bit of extra whitespace on an
  // intentionally spare page, and removes that failure mode entirely.
  const coverBlankHeightPx = Math.floor(0.72 * (PDF_PAGE_CONTENT_HEIGHT_MM / PDF_CONTENT_WIDTH_MM) * 860);
  const coverBlankHtml = opts.includeOverview ? `
    <div class="pdf-atom" data-pdf-force-page-break-after>
    <section class="pdf-cover-blank" style="min-height:${coverBlankHeightPx}px;">
      <div class="pdf-cover-blank-top">
        ${coverLogoDataUrl ? `<img class="pdf-cover-blank-logo" src="${coverLogoDataUrl}" alt="">` : ''}
        ${coverOrgLabel ? `<div class="pdf-cover-blank-org">${escapeHtml(coverOrgLabel)}</div>` : ''}
        <div class="pdf-cover-blank-projtag">${escapeHtml(proj.name)}</div>
      </div>
      <div class="pdf-cover-blank-divider"></div>
      <div class="pdf-cover-blank-meta">
        <div class="row"><span class="k">Created By</span><span class="v">${escapeHtml(author)}</span></div>
        <div class="row"><span class="k">Last Modified</span><span class="v">${escapeHtml(lastModifiedStr)}</span></div>
        <div class="row"><span class="k">Generated On</span><span class="v">${escapeHtml(generatedAtStr)}</span></div>
      </div>
      <div class="pdf-cover-blank-confidential">Confidential — Internal Use Only</div>
    </section>
    </div>` : '';

  // Everything that used to live inside the cover atom itself (description, stats,
  // the auth card, auth params, integration notes) now starts page 2 as an ordinary
  // "Overview" section — same visual language as Lifecycle/Request flow below it —
  // instead of being squeezed onto the now-deliberately-spare cover page. The badge
  // + project title (formerly the cover's "mid" block) now sit here too, directly
  // above the "Overview" heading.
  const overviewHtml = opts.includeOverview ? `
    <div class="pdf-atom">
    <section>
      <div class="pdf-cover-badge-row">
        <div class="pdf-cover-badge"><span class="dot"></span>DocTracker · ${escapeHtml(envLabel)} environment</div>
        <h1 class="pdf-cover-title">${escapeHtml(proj.name)}</h1>
      </div>
      <div class="pdf-section-title">Overview</div>
      <div class="pdf-cover-sub">${proj.description ? renderMarkdown(proj.description) : 'API documentation export.'}</div>
      <div class="pdf-cover-stats">
        <div class="pdf-cover-stat"><div class="n">${endpoints.length}</div><div class="l">Endpoints in this export</div></div>
        <div class="pdf-cover-stat"><div class="n">${Object.keys(groups).length}</div><div class="l">Tag${Object.keys(groups).length===1?'':'s'}</div></div>
        <div class="pdf-cover-stat"><div class="n">${proj.auth && proj.auth.type ? escapeHtml(proj.auth.type) : 'None'}</div><div class="l">Authentication</div></div>
        <div class="pdf-cover-stat"><div class="n">${proj.lifecycle ? escapeHtml(proj.lifecycle) : '—'}</div><div class="l">Lifecycle</div></div>
        <div class="pdf-cover-stat"><div class="n">${proj.version ? 'v'+escapeHtml(proj.version) : '—'}</div><div class="l">Version</div></div>
      </div>
    </section>
    </div>
    ${proj.auth && proj.auth.type ? `<div class="pdf-atom"><div class="pdf-auth-card"><div class="ic">🔑</div><div><div class="h">${escapeHtml(proj.auth.type)}${proj.auth.headerName ? ' · '+escapeHtml(proj.auth.headerName)+' header' : ''}</div>${proj.auth.path ? `<div class="d" style="margin-top:4px;"><span class="badge ${methodClass(proj.auth.method||'POST')}" style="margin-right:8px;">${escapeHtml(proj.auth.method||'POST')}</span><span style="font-family:var(--mono);">${escapeHtml(proj.auth.path)}</span></div>` : ''}<div class="d">${proj.auth.description ? escapeHtml(proj.auth.description) : 'No further notes.'}</div></div></div></div>` : ''}
    ${proj.auth && proj.auth.includeInDocs && ((proj.auth.requestParams||[]).length || (proj.auth.responseParams||[]).length) ? `
    <div class="pdf-atom">
    <div style="text-align:left; max-width:640px; margin:0 auto;">
      ${paramSection('Auth request parameters', proj.auth.requestParams||[])}
      ${paramSection('Auth response parameters', proj.auth.responseParams||[])}
    </div>
    </div>` : ''}
    ${opts.includeNotes && proj.notes ? `<div class="pdf-atom"><div class="pdf-notes-card"><div class="pdf-notes-title">Integration notes</div><div class="pdf-notes-body">${escapeHtml(proj.notes)}</div></div></div>` : ''}
  ` : '';

  const coverHtml = opts.includeOverview ? `
    ${coverBlankHtml}
    ${overviewHtml}
    ${lifecycleHtml}
    ${endpointsHistoryHtml}
    <div class="pdf-atom">
    <section class="pdf-toc">
      <div class="pdf-section-title">Contents</div>
      ${tocHtml}
    </section>
    </div>` : '';

  const endpointsHtml = endpoints.map((ep,i)=>buildExportPdfEndpointSection(proj, ep, i, env)).join('');

  // No trailing "pdf-footer" HTML atom here anymore — the native per-page footer
  // stamped in stampPdfPage() (see generateProjectPdf()) now carries this same
  // "project · Generated by DocTracker · date · by author" line, plus a page
  // number, on every single page instead of only appearing once at the very end.
  return `
    ${coverHtml}
    ${endpointsHtml}
  `;
}
