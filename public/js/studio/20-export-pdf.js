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

// ============================================================================
// Native (non-rasterized) drawing for per-endpoint content — see plan
// "Native (non-rasterized) PDF export for per-endpoint content". Endpoint
// header/description/chips/curl/param-tables/JSON examples/responses are
// drawn directly with jsPDF text/vector primitives instead of being rendered
// to HTML and rasterized by html2canvas — this is what actually fixes render
// time scaling linearly with endpoint count (see generateProjectPdf below).
// The cover page, Overview, Lifecycle wheel, and each endpoint's Request
// Flow diagram stay HTML+html2canvas (Phase 2, deliberately out of scope —
// they render once or a handful of times per project, not per endpoint, so
// they're not the bottleneck; see placeCanvasAtom for that path).
//
// Colors below are pulled 1:1 from .pdf-print-root's CSS in studio.html so
// natively-drawn endpoints match the still-rasterized surrounding pages.
// ============================================================================
const PDF_COLORS = {
  border: '#e2e6ee', body: '#4b5468', heading: '#0f1420', faint: '#8890a3',
  codeBg: '#f6f8fb', codeHeadBg: '#eef1f6', chipBg: '#eef1f6', white: '#ffffff',
};
// fg = pill/badge text color; base+alpha = pill/badge background (CSS rgba,
// flattened onto white below since jsPDF fill colors are opaque);
// borderBase+borderAlpha = pill/badge border.
const PDF_METHOD_STYLE = {
  get:    { fg: '#1f66c9', base: '#4fa3f7', alpha: .16, borderBase: '#2f7fd1', borderAlpha: .35 },
  post:   { fg: '#128058', base: '#35c491', alpha: .16, borderBase: '#1f9d6f', borderAlpha: .35 },
  put:    { fg: '#93611a', base: '#e0a83e', alpha: .18, borderBase: '#b1791f', borderAlpha: .35 },
  patch:  { fg: '#6237a8', base: '#b389f0', alpha: .18, borderBase: '#7a53c9', borderAlpha: .35 },
  delete: { fg: '#a41f33', base: '#ef5c6e', alpha: .16, borderBase: '#c73b4d', borderAlpha: .35 },
};
// Response status-pill tones (st-c2..st-c5 in CSS) reuse the exact same
// method palette — c2=2xx(green/post), c3=3xx(blue/get), c4=4xx(amber/put), c5=5xx(red/delete).
const PDF_STATUS_STYLE = { c2: PDF_METHOD_STYLE.post, c3: PDF_METHOD_STYLE.get, c4: PDF_METHOD_STYLE.put, c5: PDF_METHOD_STYLE.delete };

function pdfHexToRgb(hex){
  const h = String(hex).replace('#','');
  return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
}
function pdfBlendOverWhite(hex, alpha){
  const [r,g,b] = pdfHexToRgb(hex);
  const f = (c)=>Math.round(c*alpha + 255*(1-alpha));
  return [f(r), f(g), f(b)];
}
function pdfSetFill(pdf, hex){ const [r,g,b] = pdfHexToRgb(hex); pdf.setFillColor(r,g,b); }
function pdfSetFillBlend(pdf, hex, alpha){ const [r,g,b] = pdfBlendOverWhite(hex, alpha); pdf.setFillColor(r,g,b); }
function pdfSetText(pdf, hex){ const [r,g,b] = pdfHexToRgb(hex); pdf.setTextColor(r,g,b); }
function pdfSetDraw(pdf, hex){ const [r,g,b] = pdfHexToRgb(hex); pdf.setDrawColor(r,g,b); }
function pdfSetDrawBlend(pdf, hex, alpha){ const [r,g,b] = pdfBlendOverWhite(hex, alpha); pdf.setDrawColor(r,g,b); }

// A "pen": the one shared page/cursor-position tracker threaded through every
// native draw call AND the (still-rasterized) atom placements, so the whole
// document — native and raster content alike — flows through one consistent
// page-break cursor instead of two disagreeing ones.
function createPdfPen(pdf){ return { pdf, y: PDF_MARGIN_TOP_MM, firstContent: true }; }
function pdfPageBottom(){ return PDF_PAGE_HEIGHT_MM - PDF_MARGIN_BOTTOM_MM; }
function pdfNewPage(pen){ pen.pdf.addPage(); pen.y = PDF_MARGIN_TOP_MM; }
// Starts a fresh page only if there's already content on the current one —
// used where an endpoint must always begin at the top of its own page.
function pdfForcePageBreak(pen){
  if(!pen.firstContent && pen.y > PDF_MARGIN_TOP_MM) pdfNewPage(pen);
}
function pdfEnsureSpace(pen, neededMM){
  if(pen.y + neededMM > pdfPageBottom()) pdfNewPage(pen);
}

// jsPDF text sizes are in points; splitTextToSize/getTextWidth return
// measurements in the document's own unit (mm here) once setFont/setFontSize
// have been called — this app's whole native layer relies on that, same as
// stampPdfPage already does for the running header/footer.
function pdfLineHeightMM(fontSizePt, lineFactor){ return fontSizePt * 0.3528 * (lineFactor || 1.15); }

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

// ---------- Native drawing helpers (endpoint content — see plan) ----------
function pdfMeasure(pdf, fontSize, fontStyle, fontFamily){
  pdf.setFont(fontFamily||'helvetica', fontStyle||'normal');
  pdf.setFontSize(fontSize);
}

function drawSectionTitle(pen, text){
  pdfEnsureSpace(pen, 9);
  const pdf = pen.pdf;
  pdfMeasure(pdf, 8.3, 'bold');
  pdfSetText(pdf, PDF_COLORS.faint);
  pdf.text(String(text).toUpperCase(), PDF_MARGIN_X_MM, pen.y + 3, { charSpace: 0.25 });
  pen.y += 9;
  pen.firstContent = false;
}

function drawChipsRow(pen, chips){
  chips = (chips||[]).filter(Boolean);
  if(!chips.length) return;
  const pdf = pen.pdf;
  const fontSize = 7.4, padX = 2.6, h = 5.6, gap = 2.2;
  pdfMeasure(pdf, fontSize, 'bold');
  pdfEnsureSpace(pen, h + 3);
  let x = PDF_MARGIN_X_MM;
  chips.forEach(txt=>{
    const w = pdf.getTextWidth(txt) + padX*2;
    if(x + w > PDF_MARGIN_X_MM + PDF_CONTENT_WIDTH_MM && x > PDF_MARGIN_X_MM){
      x = PDF_MARGIN_X_MM; pen.y += h + 1.6; pdfEnsureSpace(pen, h+3);
    }
    pdfSetFill(pdf, PDF_COLORS.chipBg);
    pdfSetDraw(pdf, PDF_COLORS.border);
    pdf.setLineWidth(0.15);
    pdf.roundedRect(x, pen.y, w, h, h/2, h/2, 'FD');
    pdfSetText(pdf, PDF_COLORS.body);
    pdf.text(txt, x + w/2, pen.y + h/2 + 1.1, { align:'center' });
    x += w + gap;
  });
  pen.y += h + 4;
  pen.firstContent = false;
}

// Method badge + path + version, on a lightly tinted card with a colored
// left accent bar — a flat approximation of the original's CSS gradient
// banner (jsPDF has no easy gradient fill; a tint reads the same at a
// glance and needs no extra library).
function drawEndpointBanner(pen, proj, ep, index){
  const pdf = pen.pdf;
  const method = String(ep.method||'GET').toLowerCase();
  const style = PDF_METHOD_STYLE[method] || PDF_METHOD_STYLE.get;
  const indexStr = String(index+1).padStart(2,'0');
  const versionStr = (ep.version || proj.version) ? ('v' + String(ep.version||proj.version).replace(/^v/i,'')) : '';

  const badgeFontSize = 9, badgePadX = 3, badgeH = 7.4;
  pdfMeasure(pdf, badgeFontSize, 'bold');
  const methodLabel = String(ep.method||'').toUpperCase();
  const badgeW = Math.max(pdf.getTextWidth(methodLabel) + badgePadX*2, 15);

  pdfMeasure(pdf, 8, 'bold');
  const indexW = pdf.getTextWidth(indexStr);
  const pathFontSize = 12.2;
  pdfMeasure(pdf, pathFontSize, 'bold');
  const pathAvailWidth = PDF_CONTENT_WIDTH_MM - 6 - indexW - 4 - badgeW - 5 - (versionStr ? 22 : 0) - 5;
  const pathLines = pdf.splitTextToSize(ep.path||'', Math.max(pathAvailWidth, 40));

  const bannerPadY = 4.2, bannerPadX = 5;
  const pathBlockH = pathLines.length * pdfLineHeightMM(pathFontSize);
  const rowH = Math.max(badgeH, pathBlockH);
  const bannerH = rowH + bannerPadY*2;

  pdfEnsureSpace(pen, bannerH + 3);
  const x0 = PDF_MARGIN_X_MM, y0 = pen.y;

  pdfSetFillBlend(pdf, style.base, 0.07);
  pdfSetDrawBlend(pdf, style.borderBase, style.borderAlpha);
  pdf.setLineWidth(0.2);
  pdf.roundedRect(x0, y0, PDF_CONTENT_WIDTH_MM, bannerH, 2.4, 2.4, 'FD');
  pdfSetFill(pdf, style.borderBase);
  pdf.roundedRect(x0, y0+1.6, 1.3, bannerH-3.2, 0.6, 0.6, 'F');

  let cx = x0 + bannerPadX + 1.5;
  const midY = y0 + bannerH/2;

  pdfMeasure(pdf, 8, 'bold');
  pdfSetText(pdf, PDF_COLORS.faint);
  pdf.text(indexStr, cx, midY + 1.2);
  cx += indexW + 4;

  pdfSetFillBlend(pdf, style.base, style.alpha);
  pdfSetDrawBlend(pdf, style.borderBase, style.borderAlpha);
  pdf.setLineWidth(0.15);
  pdf.roundedRect(cx, midY - badgeH/2, badgeW, badgeH, 1.6, 1.6, 'FD');
  pdfMeasure(pdf, badgeFontSize, 'bold');
  pdfSetText(pdf, style.fg);
  pdf.text(methodLabel, cx + badgeW/2, midY + 1.4, { align:'center' });
  cx += badgeW + 5;

  pdfMeasure(pdf, pathFontSize, 'bold');
  pdfSetText(pdf, PDF_COLORS.heading);
  const pathStartY = midY - ((pathLines.length-1)*pdfLineHeightMM(pathFontSize))/2 + 1.4;
  pathLines.forEach((line,i)=> pdf.text(line, cx, pathStartY + i*pdfLineHeightMM(pathFontSize)));

  if(versionStr){
    pdfMeasure(pdf, 8, 'normal');
    pdfSetText(pdf, PDF_COLORS.faint);
    pdf.text(versionStr, x0 + PDF_CONTENT_WIDTH_MM - bannerPadX, midY + 1, { align:'right' });
  }

  pen.y = y0 + bannerH + 5;
  pen.firstContent = false;
}

// ---- Native markdown-lite ----
// Mirrors renderMarkdown's actual real feature set (public/js/studio/05-util.js):
// ATX headers, **bold**/*italic*/`code` inline, flat/nested -/*/N. lists,
// paragraphs. No links/images/tables/blockquotes/fenced code — renderMarkdown
// doesn't support those either. Nested lists collapse to one indent level —
// a deliberate v1 simplification, not a bug, for the rare deeply-nested case.
function pdfInlineRuns(text){
  const runs = [];
  let rest = text;
  const re = /(\*\*(.+?)\*\*)|(\*(.+?)\*)|(`(.+?)`)/;
  while(rest.length){
    const m = re.exec(rest);
    if(!m){ runs.push({text: rest, bold:false, italic:false, code:false}); break; }
    if(m.index > 0) runs.push({text: rest.slice(0, m.index), bold:false, italic:false, code:false});
    if(m[1]) runs.push({text: m[2], bold:true, italic:false, code:false});
    else if(m[3]) runs.push({text: m[4], bold:false, italic:true, code:false});
    else if(m[5]) runs.push({text: m[6], bold:false, italic:false, code:true});
    rest = rest.slice(m.index + m[0].length);
  }
  return runs;
}

function drawRunsWrapped(pen, runs, opts){
  opts = opts || {};
  const pdf = pen.pdf;
  const fontSize = opts.fontSize || 10.5;
  const x0 = opts.x != null ? opts.x : PDF_MARGIN_X_MM;
  const maxWidth = opts.maxWidth != null ? opts.maxWidth : PDF_CONTENT_WIDTH_MM;
  const lh = pdfLineHeightMM(fontSize, opts.lineGapFactor || 1.5);
  const color = opts.color || PDF_COLORS.body;

  const words = [];
  runs.forEach(r=>{
    const style = r.code ? 'code' : (r.bold ? 'bold' : (r.italic ? 'italic' : 'normal'));
    String(r.text).split(/(\s+)/).forEach(tok=>{ if(tok!=='') words.push({tok, style}); });
  });

  let line = [];
  let lineW = 0;
  const flushLine = ()=>{
    if(!line.length) return;
    pdfEnsureSpace(pen, lh);
    let cx = x0;
    line.forEach(w=>{
      pdfMeasure(pdf, fontSize, w.style==='bold'?'bold':(w.style==='italic'?'italic':'normal'), w.style==='code'?'courier':'helvetica');
      pdfSetText(pdf, w.style==='code' ? PDF_COLORS.heading : color);
      pdf.text(w.tok, cx, pen.y + fontSize*0.3528*0.78);
      cx += pdf.getTextWidth(w.tok);
    });
    pen.y += lh;
    line = []; lineW = 0;
  };

  words.forEach(w=>{
    pdfMeasure(pdf, fontSize, w.style==='bold'?'bold':(w.style==='italic'?'italic':'normal'), w.style==='code'?'courier':'helvetica');
    const ww = pdf.getTextWidth(w.tok);
    if(/^\s+$/.test(w.tok) && line.length===0) return;
    if(lineW + ww > maxWidth && line.length){ flushLine(); }
    line.push(w); lineW += ww;
  });
  flushLine();
  pen.firstContent = false;
}

function drawMarkdownLite(pen, markdown){
  if(!markdown) return;
  const lines = String(markdown).replace(/\r\n/g,'\n').split('\n');
  let i = 0;
  const paraBuf = [];
  const flushPara = ()=>{
    if(!paraBuf.length) return;
    drawRunsWrapped(pen, pdfInlineRuns(paraBuf.join(' ')), { fontSize: 10.5, color: PDF_COLORS.body });
    pen.y += 2.2;
    paraBuf.length = 0;
  };
  while(i < lines.length){
    const line = lines[i].trim();
    if(line === ''){ flushPara(); i++; continue; }
    const hMatch = /^(#{1,4})\s+(.*)$/.exec(line);
    if(hMatch){
      flushPara();
      const level = hMatch[1].length;
      const fontSize = level<=2 ? 12.5 : (level===3 ? 11.3 : 10.3);
      drawRunsWrapped(pen, [{text: hMatch[2], bold:true}], { fontSize, color: PDF_COLORS.heading });
      pen.y += 1.6;
      i++; continue;
    }
    const listMatch = /^([-*]|\d+[.)])\s+(.*)$/.exec(line);
    if(listMatch){
      flushPara();
      const bullet = /\d/.test(listMatch[1]) ? listMatch[1] : '•';
      pdfEnsureSpace(pen, pdfLineHeightMM(10.5));
      const pdf = pen.pdf;
      pdfMeasure(pdf, 10.5, 'normal');
      pdfSetText(pdf, PDF_COLORS.body);
      pdf.text(bullet, PDF_MARGIN_X_MM + 1, pen.y + 3.7);
      drawRunsWrapped(pen, pdfInlineRuns(listMatch[2]), { fontSize: 10.5, color: PDF_COLORS.body, x: PDF_MARGIN_X_MM + 6, maxWidth: PDF_CONTENT_WIDTH_MM - 6 });
      pen.y += 0.8;
      i++; continue;
    }
    paraBuf.push(line);
    i++;
  }
  flushPara();
}

// ---- Native table (params / headers / response fields) ----
// Mirrors paramSection()'s exact masking behavior (public/js/studio/14-users.js:825)
// so the PDF never shows more than the exporting user's role can currently
// see — same piiRuleFor/maskByStrategy/sensitiveRevealed() calls, same rule.
function drawNativeParamsTable(pen, title, params){
  if(!params || !params.length) return;
  drawSectionTitle(pen, title);
  const pdf = pen.pdf;
  const revealed = sensitiveRevealed();
  const rules = params.map(p=> p.example ? piiRuleFor(p.name, p.example) : null);
  const widths = [0.22, 0.15, 0.28, 0.35].map(f=>f*PDF_CONTENT_WIDTH_MM);
  const colX = [PDF_MARGIN_X_MM];
  for(let i=1;i<widths.length;i++) colX.push(colX[i-1]+widths[i-1]);
  const padX = 2.2, padY = 1.8;
  const fontSize = 8.6;

  const rows = params.map((p,i)=>{
    const rule = rules[i];
    const masked = !!rule && !revealed;
    const exampleVal = p.example ? (masked ? maskByStrategy(p.example, rule) : p.example) : '—';
    return [ p.name + (p.required ? ' *' : ''), p.type||'', exampleVal, p.description || '—' ];
  });

  const drawHeaderRow = ()=>{
    pdfEnsureSpace(pen, 6.6);
    pdfSetFillBlend(pdf, '#4a5fe0', .08);
    pdf.rect(PDF_MARGIN_X_MM, pen.y, PDF_CONTENT_WIDTH_MM, 6.6, 'F');
    pdfMeasure(pdf, 7.6, 'bold');
    pdfSetText(pdf, '#4a5fe0');
    ['Name','Type','Example','Description'].forEach((h,i)=> pdf.text(h.toUpperCase(), colX[i]+padX, pen.y+4.4, { charSpace: 0.15 }));
    pen.y += 6.6;
  };
  drawHeaderRow();

  rows.forEach((cells)=>{
    pdfMeasure(pdf, fontSize, 'normal');
    const wrapped = cells.map((c,i)=> pdf.splitTextToSize(String(c), widths[i]-padX*2));
    const lineCount = Math.max.apply(null, wrapped.map(w=>w.length).concat([1]));
    const lh = pdfLineHeightMM(fontSize, 1.3);
    const rowH = lineCount * lh + padY*2;

    if(pen.y + rowH > pdfPageBottom()){
      pdfNewPage(pen);
      drawHeaderRow();
    }

    pdfSetFill(pdf, PDF_COLORS.white);
    pdf.rect(PDF_MARGIN_X_MM, pen.y, PDF_CONTENT_WIDTH_MM, rowH, 'F');
    pdfSetDraw(pdf, PDF_COLORS.border);
    pdf.setLineWidth(0.12);
    pdf.line(PDF_MARGIN_X_MM, pen.y+rowH, PDF_MARGIN_X_MM+PDF_CONTENT_WIDTH_MM, pen.y+rowH);

    wrapped.forEach((cellLines, ci)=>{
      pdfMeasure(pdf, fontSize, ci===0 ? 'bold' : 'normal');
      pdfSetText(pdf, ci===0 ? PDF_COLORS.heading : (cellLines[0]==='—' ? PDF_COLORS.faint : PDF_COLORS.body));
      cellLines.forEach((ln,li)=> pdf.text(ln, colX[ci]+padX, pen.y+padY+(li+0.8)*lh));
    });
    pen.y += rowH;
  });

  pdfSetDraw(pdf, PDF_COLORS.border);
  pdf.setLineWidth(0.2);
  pen.y += 5;
  pen.firstContent = false;
}

// ---- Native monospace code block (curl / JSON examples) ----
// Text is already fully masked by the caller (curlSample()/maskedJsonString())
// before reaching here — this only wraps and paginates it. This replaces the
// old "chunk into page-sized HTML cards, then crop-to-pixel-strips as a
// fallback" approach: native text just continues on a fresh page like a
// word processor would, which is actually more correct (a line is never
// split mid-character) as well as far cheaper than rasterizing.
function drawNativeCodeBlock(pen, label, sub, text){
  const pdf = pen.pdf;
  const fontSize = 8.2;
  const padX = 4, padY = 3.2;
  const headH = 7.2;
  const lh = pdfLineHeightMM(fontSize, 1.35);
  const innerWidth = PDF_CONTENT_WIDTH_MM - padX*2;

  pdfMeasure(pdf, fontSize, 'normal', 'courier');
  const rawLines = String(text||'').replace(/\r\n/g,'\n').split('\n');
  const wrapped = [];
  rawLines.forEach(l=>{
    const w = pdf.splitTextToSize(l === '' ? ' ' : l, innerWidth);
    (w.length ? w : ['']).forEach(x=>wrapped.push(x));
  });

  pdfEnsureSpace(pen, headH + lh + padY*2 + 2);
  pdfSetFill(pdf, PDF_COLORS.codeHeadBg);
  pdf.rect(PDF_MARGIN_X_MM, pen.y, PDF_CONTENT_WIDTH_MM, headH, 'F');
  pdfMeasure(pdf, 8.3, 'bold');
  pdfSetText(pdf, PDF_COLORS.body);
  pdf.text(label, PDF_MARGIN_X_MM + padX, pen.y + 4.8);
  if(sub){
    const labelW = pdf.getTextWidth(label);
    pdfMeasure(pdf, 7.6, 'normal');
    pdfSetText(pdf, PDF_COLORS.faint);
    pdf.text(sub, PDF_MARGIN_X_MM + padX + labelW + 6, pen.y + 4.8);
  }
  pen.y += headH;

  let chunkStartY = pen.y;
  let chunkLines = [];
  const flushChunk = ()=>{
    if(!chunkLines.length) return;
    const chunkH = chunkLines.length * lh + padY*2;
    pdfSetFill(pdf, PDF_COLORS.codeBg);
    pdf.rect(PDF_MARGIN_X_MM, chunkStartY, PDF_CONTENT_WIDTH_MM, chunkH, 'F');
    pdfSetDraw(pdf, PDF_COLORS.border);
    pdf.setLineWidth(0.15);
    pdf.rect(PDF_MARGIN_X_MM, chunkStartY, PDF_CONTENT_WIDTH_MM, chunkH, 'S');
    pdfMeasure(pdf, fontSize, 'normal', 'courier');
    pdfSetText(pdf, PDF_COLORS.heading);
    chunkLines.forEach((ln,i)=> pdf.text(ln, PDF_MARGIN_X_MM + padX, chunkStartY + padY + (i+0.8)*lh));
  };

  wrapped.forEach(line=>{
    const wouldBeH = (chunkLines.length+1) * lh + padY*2;
    if(chunkStartY + wouldBeH > pdfPageBottom()){
      flushChunk();
      pdfNewPage(pen);
      chunkStartY = pen.y;
      chunkLines = [];
    }
    chunkLines.push(line);
  });
  flushChunk();
  pen.y = chunkStartY + chunkLines.length * lh + padY*2 + 5;
  pen.firstContent = false;
}

// ---- Responses ----
function drawResponsesSection(pen, ep){
  drawSectionTitle(pen, 'Responses');
  const responses = ep.responses || [];
  const pdf = pen.pdf;
  if(!responses.length){
    pdfEnsureSpace(pen, 8);
    pdfMeasure(pdf, 9.5, 'italic');
    pdfSetText(pdf, PDF_COLORS.faint);
    pdf.text('No responses documented.', PDF_MARGIN_X_MM, pen.y + 4);
    pen.y += 10;
    return;
  }
  responses.forEach(r=>{
    const cls = respClass(r.code);
    const style = PDF_STATUS_STYLE[cls] || PDF_METHOD_STYLE.get;
    pdfEnsureSpace(pen, 10);
    const codeStr = String(r.code);
    pdfMeasure(pdf, 9.5, 'bold');
    const pillW = Math.max(pdf.getTextWidth(codeStr) + 5, 12);
    pdfSetFillBlend(pdf, style.base, style.alpha);
    pdfSetDrawBlend(pdf, style.borderBase, style.borderAlpha);
    pdf.setLineWidth(0.15);
    pdf.roundedRect(PDF_MARGIN_X_MM, pen.y, pillW, 6.6, 3.3, 3.3, 'FD');
    pdfSetText(pdf, style.fg);
    pdf.text(codeStr, PDF_MARGIN_X_MM + pillW/2, pen.y + 4.5, { align:'center' });

    if(r.description){
      pdfMeasure(pdf, 9.5, 'normal');
      pdfSetText(pdf, PDF_COLORS.body);
      const descLines = pdf.splitTextToSize(r.description, PDF_CONTENT_WIDTH_MM - pillW - 6);
      descLines.forEach((l,i)=> pdf.text(l, PDF_MARGIN_X_MM + pillW + 5, pen.y + 4.5 + i*pdfLineHeightMM(9.5)));
      pen.y += Math.max(6.6, descLines.length*pdfLineHeightMM(9.5)) + 4;
    } else {
      pen.y += 6.6 + 4;
    }
    pen.firstContent = false;

    if(r.fields && r.fields.length) drawNativeParamsTable(pen, 'Response fields', r.fields);
    if(r.example) drawNativeCodeBlock(pen, 'Example response', `status ${codeStr}`, maskedJsonString(r.example));
  });
}

// ---- Place an already-rasterized html2canvas atom (cover page content, and
// each endpoint's Request Flow diagram — see plan for why those stay images) ----
function placeCanvasAtom(pen, canvas){
  const pdf = pen.pdf;
  const imgWidth = PDF_CONTENT_WIDTH_MM;
  const imgHeight = (canvas.height * imgWidth) / canvas.width;
  const contentBottom = pdfPageBottom();

  if(!pen.firstContent && pen.y + imgHeight > contentBottom){
    pdfNewPage(pen);
  }
  pen.firstContent = false;

  if(imgHeight > (contentBottom - PDF_MARGIN_TOP_MM)){
    const pxPerMM = canvas.width / imgWidth;
    const pageSlicePx = Math.floor((contentBottom - PDF_MARGIN_TOP_MM) * pxPerMM);
    let renderedPx = 0;
    let firstSlice = true;
    while(renderedPx < canvas.height){
      if(!firstSlice){ pdfNewPage(pen); }
      firstSlice = false;
      const sliceHeightPx = Math.min(pageSlicePx, canvas.height - renderedPx);
      const sliceCanvas = document.createElement('canvas');
      sliceCanvas.width = canvas.width;
      sliceCanvas.height = sliceHeightPx;
      sliceCanvas.getContext('2d').drawImage(canvas, 0, renderedPx, canvas.width, sliceHeightPx, 0, 0, canvas.width, sliceHeightPx);
      const sliceImgHeight = sliceHeightPx / pxPerMM;
      pdf.addImage(sliceCanvas.toDataURL('image/jpeg', 0.95), 'JPEG', PDF_MARGIN_X_MM, pen.y, imgWidth, sliceImgHeight);
      pen.y += sliceImgHeight;
      renderedPx += sliceHeightPx;
    }
    pen.y += 3;
  } else {
    const imgData = canvas.toDataURL('image/jpeg', 0.95);
    pdf.addImage(imgData, 'JPEG', PDF_MARGIN_X_MM, pen.y, imgWidth, imgHeight);
    pen.y += imgHeight + 3;
  }
}

// ---- One endpoint, drawn natively except its Request Flow diagram ----
async function drawEndpointNative(pen, proj, ep, index, env, flowContainer, ignoreForCanvas){
  pdfForcePageBreak(pen);

  drawEndpointBanner(pen, proj, ep, index);

  if(ep.summary){
    drawRunsWrapped(pen, [{text: ep.summary, bold:true}], { fontSize: 11.5, color: PDF_COLORS.heading });
    pen.y += 1;
  }
  if(ep.description) drawMarkdownLite(pen, ep.description);

  drawChipsRow(pen, [ep.tag || 'General', ep.contentType || 'application/json', `${env.label} environment`]);

  flowContainer.innerHTML = `<section>${pdfRequestFlowSectionInnerHtml(proj, env, ep)}</section>`;
  if(document.fonts && document.fonts.ready) await document.fonts.ready;
  const flowCanvas = await html2canvas(flowContainer, { scale:1.5, backgroundColor:'#ffffff', useCORS:true, ignoreElements: ignoreForCanvas });
  placeCanvasAtom(pen, flowCanvas);

  drawNativeCodeBlock(pen, 'Request', 'host masked unless revealed by an Admin', curlSample(proj, ep));

  const pathParams = (ep.parameters||[]).filter(p=>p.in==='path');
  const queryParams = (ep.parameters||[]).filter(p=>!p.in || p.in==='query');
  const allParams = [...pathParams.map(p=>({...p, in:'path'})), ...queryParams.map(p=>({...p, in:'query'}))];
  const headerParams = ep.headers || (ep.parameters||[]).filter(p=>p.in==='header');

  if(allParams.length) drawNativeParamsTable(pen, 'Path & query parameters', allParams);
  if(headerParams.length) drawNativeParamsTable(pen, 'Headers', headerParams);
  if(ep.requestBody && ep.requestBody.example) drawNativeCodeBlock(pen, 'Example request body', '', maskedJsonString(ep.requestBody.example));

  drawResponsesSection(pen, ep);
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
  const env = envMeta(state.env);
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
  let flowContainer = null;
  try{
    setStage('Gathering endpoints…');
    await wait(200);
    setStage('Applying access rules…');
    await wait(200);
    setStage('Rendering cover…');
    // Only the cover/Overview/Lifecycle/TOC content is built as HTML now —
    // endpoints are drawn natively below (see drawEndpointNative), not
    // rasterized. See the "Native (non-rasterized) PDF export" plan.
    container = document.createElement('div');
    container.className = 'pdf-print-root';
    container.innerHTML = buildExportPdfContentHtml(proj, endpoints, opts);
    document.body.appendChild(container);
    // A second, separate offscreen container just for each endpoint's
    // Request Flow diagram (still HTML+html2canvas, one call per endpoint —
    // see plan for why that piece alone stays rasterized) — reused across
    // endpoints rather than rebuilding the whole document's HTML per one.
    flowContainer = document.createElement('div');
    flowContainer.className = 'pdf-print-root';
    document.body.appendChild(flowContainer);
    if(document.fonts && document.fonts.ready) await document.fonts.ready;
    await wait(60); // let layout settle before rasterizing

    splitTallCodeAtomsForPdf(container);

    const atoms = Array.from(container.querySelectorAll('.pdf-atom'));

    // html2canvas clones the *whole* document to compute a render tree, not just the
    // element you pass it — so anything else on the page still gets walked. This app's
    // own UI (env pill, escalation dots, etc.) uses CSS color-mix(), which html2canvas's
    // renderer can't parse, and it throws the moment it reaches one. Since none of that
    // is needed for the export, skip it entirely and only let our own containers through.
    const ignoreForCanvas = (el)=>{
      if(el === container || container.contains(el)) return false;
      if(el === flowContainer || flowContainer.contains(el)) return false;
      if(el.id === 'app') return true;
      if(el.classList && (el.classList.contains('modal-overlay') || el.classList.contains('palette-overlay') || el.classList.contains('render-overlay'))) return true;
      return false;
    };

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF('p', 'mm', 'a4');
    const pen = createPdfPen(pdf);

    for(let idx = 0; idx < atoms.length; idx++){
      setStage(`Rendering cover ${idx + 1} of ${atoms.length}…`);
      const atomEl = atoms[idx];

      // Each atom flagged force-page-break-before/after keeps that exact
      // behavior from the old loop (e.g. the cover page standing alone).
      if(atomEl.hasAttribute('data-pdf-force-page-break-before')) pdfForcePageBreak(pen);

      const canvas = await html2canvas(atomEl, { scale:1.5, backgroundColor:'#ffffff', useCORS:true, ignoreElements: ignoreForCanvas });
      placeCanvasAtom(pen, canvas);

      if(atomEl.hasAttribute('data-pdf-force-page-break-after') && idx < atoms.length - 1) pdfNewPage(pen);
    }

    // Endpoints: natively drawn (see drawEndpointNative) — this is the part
    // that scales with endpoint count, and is why this is fast at 50+ where
    // rasterizing every atom of every endpoint was not.
    for(let i = 0; i < endpoints.length; i++){
      setStage(`Rendering endpoint ${i + 1} of ${endpoints.length}…`);
      await drawEndpointNative(pen, proj, endpoints[i], i, env, flowContainer, ignoreForCanvas);
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
    if(flowContainer && flowContainer.parentNode) flowContainer.parentNode.removeChild(flowContainer);
    gen.classList.remove('loading');
    label.textContent = 'Generate PDF';
  }
}

// Endpoints are now drawn natively (see drawEndpointNative above) instead of
// being built as HTML here and rasterized — this function's job is gone.

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

  // Endpoints are no longer part of this HTML — they're drawn natively in
  // generateProjectPdf() (see drawEndpointNative), not rasterized. Only the
  // cover/Overview/Lifecycle/TOC content above still goes through HTML +
  // html2canvas (Phase 2, deliberately out of scope — see plan).
  //
  // No trailing "pdf-footer" HTML atom here anymore — the native per-page footer
  // stamped in stampPdfPage() (see generateProjectPdf()) now carries this same
  // "project · Generated by DocTracker · date · by author" line, plus a page
  // number, on every single page instead of only appearing once at the very end.
  return coverHtml;
}
