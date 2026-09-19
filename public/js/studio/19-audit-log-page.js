/* ==================== SECTION:AUDIT-LOG-PAGE ====================
   NOTE: buildAuditLogHtml()/auditActionMeta() below are no longer called —
   the audit log now lives at the real, bookmarkable /<orgToken>/auditlog
   route (server/views/auditlog.html), which fetches /api/audit/events itself.
   Kept here only as a reference for that page's markup/styling; safe to
   delete once the two are confirmed to have fully diverged. */
// Renders the audit trail as a fully standalone HTML document (its own <style>, its own
// search/filter script) so it can be opened in a separate browser tab via window.open(),
// independent of the main app's DOM and state.
function auditActionMeta(action){
  if(action === 'created')  return { label:'Created',  color:'#35c491', bg:'rgba(53,196,145,.14)'  };
  if(action === 'updated')  return { label:'Updated',  color:'#e0a83e', bg:'rgba(224,168,62,.14)'  };
  if(action === 'deleted')  return { label:'Deleted',  color:'#ef5c6e', bg:'rgba(239,92,110,.14)'  };
  if(action === 'imported') return { label:'Imported', color:'#4fa3f7', bg:'rgba(79,163,247,.14)'  };
  if(action === 'PII_REVEAL') return { label:'PII Reveal', color:'#ef5c6e', bg:'rgba(239,92,110,.14)' };
  if(action.startsWith('PII_MASK_RULE_')) return { label: action.replace('PII_MASK_RULE_','Rule ').replace('_',' ').toLowerCase().replace(/^\w/,c=>c.toUpperCase()), color:'#b389f0', bg:'rgba(179,137,240,.14)' };
  if(action === 'ADMIN_SETTING_CHANGED') return { label:'Admin Setting', color:'#b389f0', bg:'rgba(179,137,240,.14)' };
  if(action === 'LEGACY_AUDIT_IMPORTED') return { label:'Legacy Import', color:'#8a97b3', bg:'rgba(138,151,179,.14)' };
  if(action.startsWith('LOGIN')) return { label:'Login', color:'#35c491', bg:'rgba(53,196,145,.14)' };
  if(action.startsWith('LOGOUT')) return { label:'Logout', color:'#8a97b3', bg:'rgba(138,151,179,.14)' };
  return { label: action, color:'#8a97b3', bg:'rgba(138,151,179,.14)' };
}
function buildAuditLogHtml(){
  const entries = (state.auditLog || []).slice();
  const actors = Array.from(new Set(entries.map(e=>e.actor))).sort();
  const entityTypes = Array.from(new Set(entries.map(e=>e.entityType))).sort();
  const rows = entries.map(e=>{
    const meta = auditActionMeta(e.action);
    const dt = new Date(e.ts);
    const when = isNaN(dt.getTime()) ? '' : dt.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}) + ', ' + dt.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit',second:'2-digit'});
    const tsMs = isNaN(dt.getTime()) ? '' : dt.getTime();
    return `<tr data-search="${escapeHtml((e.actor+' '+e.entityType+' '+e.entityName+' '+e.projectName+' '+e.details+' '+meta.label+' '+(e.role||'')+' '+(e.severity||'')).toLowerCase())}" data-action="${escapeHtml(e.action)}" data-entity="${escapeHtml(e.entityType)}" data-actor="${escapeHtml(e.actor)}" data-ts="${tsMs}">
      <td class="al-when"><span class="al-when-main">${when.split(',')[0]}</span><span class="al-when-sub">${when.split(',').slice(1).join(',').trim()}</span></td>
      <td><span class="al-actor"><span class="al-avatar">${escapeHtml((e.actor||'?').slice(0,1).toUpperCase())}</span>${escapeHtml(e.actor)}${e.role ? `<span style="margin-left:6px;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--text-faint);background:var(--surface-2);padding:2px 6px;border-radius:5px;">${escapeHtml(e.role)}</span>` : ''}</span></td>
      <td><span class="al-badge" style="color:${meta.color};background:${meta.bg};">${e.severity==='critical'?'⛔ ':e.severity==='warning'?'⚠ ':''}${meta.label}</span></td>
      <td><span class="al-entity-type">${escapeHtml(e.entityType)}</span></td>
      <td class="al-entity-name">${escapeHtml(e.entityName || '—')}</td>
      <td class="al-project">${escapeHtml(e.projectName || '—')}</td>
      <td class="al-details">${escapeHtml(e.details || '')}</td>
    </tr>`;
  }).join('');

  const totalChanges = entries.length;
  const uniqueActors = actors.length;
  const created = entries.filter(e=>e.action==='created').length;
  const updated = entries.filter(e=>e.action==='updated').length;
  const deleted = entries.filter(e=>e.action==='deleted').length;
  const lastTs = entries[0] ? entries[0].ts : null;
  const lastWhen = lastTs ? new Date(lastTs).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) : '—';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Audit Log — DocTracker</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap');
:root{
  --bg:#0a0e15; --bg-elevated:#0d1219; --surface:#121822; --surface-2:#171f2b; --surface-hover:#1c2531;
  --border:#212a38; --border-strong:#2c3648; --text:#e9edf5; --text-dim:#909cb0; --text-faint:#576277;
  --accent:#5c7cfa; --accent-soft:rgba(92,124,250,.14);
  --get:#4fa3f7; --post:#35c491; --put:#e0a83e; --patch:#b389f0; --delete:#ef5c6e;
  --sans:'Inter', system-ui, sans-serif; --mono:'JetBrains Mono', ui-monospace, monospace;
}
*{ box-sizing:border-box; }
body{ margin:0; background:var(--bg); color:var(--text); font-family:var(--sans); -webkit-font-smoothing:antialiased; }
.al-wrap{ max-width:1280px; margin:0 auto; padding:28px 28px 60px; }
.al-header{ display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:22px; flex-wrap:wrap; }
.al-title{ display:flex; align-items:center; gap:12px; }
.al-title .mark{ width:38px; height:38px; border-radius:10px; background:var(--accent-soft); color:var(--accent); display:flex; align-items:center; justify-content:center; font-weight:800; font-family:var(--mono); font-size:15px; }
.al-title h1{ margin:0; font-size:19px; font-weight:800; letter-spacing:-.2px; }
.al-title .sub{ margin-top:2px; font-size:11.5px; color:var(--text-faint); }
.al-kpis{ display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:12px; margin-bottom:22px; }
.al-kpi{ background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:14px 16px; }
.al-kpi .n{ font-family:var(--mono); font-size:22px; font-weight:800; }
.al-kpi .l{ font-size:10px; color:var(--text-faint); text-transform:uppercase; letter-spacing:.5px; margin-top:3px; }
.al-toolbar{ display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:16px; background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:10px 12px; }
.al-search{ flex:1; min-width:220px; display:flex; align-items:center; gap:8px; background:var(--bg-elevated); border:1px solid var(--border); border-radius:8px; padding:8px 12px; }
.al-search svg{ color:var(--text-faint); flex-shrink:0; }
.al-search input{ flex:1; background:none; border:none; outline:none; color:var(--text); font-size:13px; font-family:var(--sans); }
.al-toolbar select{ background:var(--bg-elevated); border:1px solid var(--border); color:var(--text); font-size:12.5px; padding:8px 10px; border-radius:8px; font-family:var(--sans); cursor:pointer; }
.al-toolbar .al-count{ font-size:11.5px; color:var(--text-faint); white-space:nowrap; margin-left:auto; }
.al-date-range{ display:flex; align-items:center; gap:6px; }
.al-date-range .al-date-label{ font-size:10.5px; color:var(--text-faint); text-transform:uppercase; letter-spacing:.4px; white-space:nowrap; }
.al-date-range input[type="date"]{
  background:var(--bg-elevated); border:1px solid var(--border); color:var(--text); font-size:12px;
  padding:7px 9px; border-radius:8px; font-family:var(--sans); color-scheme:dark;
}
.al-date-range input[type="date"]:focus{ outline:none; border-color:var(--accent); }
.al-date-sep{ color:var(--text-faint); font-size:11px; }
.al-date-clear{
  background:var(--bg-elevated); border:1px solid var(--border); color:var(--text-faint); border-radius:8px;
  padding:7px 10px; cursor:pointer; font-size:11px; line-height:1;
}
.al-date-clear:hover{ color:var(--text); border-color:var(--border-strong); }
.al-pagination{ display:flex; align-items:center; justify-content:space-between; gap:12px; margin-top:14px; flex-wrap:wrap; }
.al-page-size{ display:flex; align-items:center; gap:8px; font-size:11.5px; color:var(--text-faint); }
.al-page-size select{ background:var(--surface); border:1px solid var(--border); color:var(--text); font-size:12px; padding:6px 8px; border-radius:7px; font-family:var(--sans); cursor:pointer; }
.al-page-nav{ display:flex; align-items:center; gap:10px; }
.al-page-nav button{ background:var(--surface); border:1px solid var(--border); color:var(--text); font-size:12px; font-weight:600; padding:7px 13px; border-radius:8px; cursor:pointer; font-family:var(--sans); }
.al-page-nav button:hover:not(:disabled){ background:var(--surface-hover); }
.al-page-nav button:disabled{ opacity:.4; cursor:not-allowed; }
.al-page-indicator{ font-size:11.5px; color:var(--text-faint); font-family:var(--mono); min-width:96px; text-align:center; }
.al-table-wrap{ background:var(--surface); border:1px solid var(--border); border-radius:12px; overflow:hidden; }
table{ width:100%; border-collapse:collapse; font-size:12.5px; }
thead th{ text-align:left; font-size:10px; text-transform:uppercase; letter-spacing:.5px; color:var(--text-faint); font-weight:700; padding:12px 14px; border-bottom:1px solid var(--border); background:var(--surface-2); position:sticky; top:0; }
tbody td{ padding:11px 14px; border-bottom:1px solid var(--border); vertical-align:top; }
tbody tr:last-child td{ border-bottom:none; }
tbody tr:hover{ background:var(--surface-hover); }
tbody tr.al-hidden{ display:none; }
.al-when{ white-space:nowrap; }
.al-when-main{ display:block; font-weight:600; }
.al-when-sub{ display:block; font-size:10.5px; color:var(--text-faint); font-family:var(--mono); }
.al-actor{ display:flex; align-items:center; gap:8px; white-space:nowrap; font-weight:600; }
.al-avatar{ width:22px; height:22px; border-radius:50%; background:var(--accent-soft); color:var(--accent); font-size:10.5px; font-weight:800; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
.al-badge{ font-size:9.5px; font-weight:800; text-transform:uppercase; letter-spacing:.5px; padding:4px 9px; border-radius:999px; white-space:nowrap; }
.al-entity-type{ font-family:var(--mono); font-size:10.5px; text-transform:uppercase; letter-spacing:.4px; color:var(--text-dim); background:var(--surface-2); padding:3px 7px; border-radius:5px; }
.al-entity-name{ font-family:var(--mono); font-size:12px; color:var(--text); max-width:220px; }
.al-project{ color:var(--text-dim); max-width:150px; }
.al-details{ color:var(--text-dim); max-width:320px; }
.al-empty{ padding:60px 20px; text-align:center; color:var(--text-faint); font-size:13px; }
::selection{ background:var(--accent-soft); }
@media (max-width:900px){
  .al-details, .al-project{ display:none; }
}
</style>
</head>
<body>
<div class="al-wrap">
  <div class="al-header">
    <div class="al-title">
      <div class="mark">{ }</div>
      <div>
        <h1>Audit Log</h1>
        <div class="sub">DocTracker · every create, edit, and delete — who did it, and when · last activity ${escapeHtml(lastWhen)}</div>
      </div>
    </div>
  </div>

  <div class="al-kpis">
    <div class="al-kpi"><div class="n">${totalChanges}</div><div class="l">Total changes</div></div>
    <div class="al-kpi"><div class="n">${uniqueActors}</div><div class="l">Contributors</div></div>
    <div class="al-kpi"><div class="n" style="color:var(--post);">${created}</div><div class="l">Created</div></div>
    <div class="al-kpi"><div class="n" style="color:var(--put);">${updated}</div><div class="l">Updated</div></div>
    <div class="al-kpi"><div class="n" style="color:var(--delete);">${deleted}</div><div class="l">Deleted</div></div>
  </div>

  <div class="al-toolbar">
    <div class="al-search">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.2" y2="16.2"></line></svg>
      <input type="text" id="alSearch" placeholder="Search by actor, entity, project, or details…">
    </div>
    <select id="alActionFilter">
      <option value="">All actions</option>
      <option value="created">Created</option>
      <option value="updated">Updated</option>
      <option value="deleted">Deleted</option>
      <option value="imported">Imported</option>
    </select>
    <select id="alEntityFilter">
      <option value="">All entity types</option>
      ${entityTypes.map(t=>`<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('')}
    </select>
    <select id="alActorFilter">
      <option value="">All contributors</option>
      ${actors.map(a=>`<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join('')}
    </select>
    <div class="al-date-range">
      <span class="al-date-label">From</span>
      <input type="date" id="alFromDate">
      <span class="al-date-sep">–</span>
      <span class="al-date-label">To</span>
      <input type="date" id="alToDate">
      <button type="button" class="al-date-clear" id="alDateClear" title="Clear date range">✕</button>
    </div>
    <span class="al-count" id="alCount"></span>
  </div>

  <div class="al-table-wrap">
    <table>
      <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Type</th><th>Entity</th><th>Project</th><th>Details</th></tr></thead>
      <tbody id="alBody">
        ${rows || ''}
      </tbody>
    </table>
    ${entries.length ? '' : '<div class="al-empty">No changes recorded yet — this log fills in as endpoints, projects, environments, and documents are created, edited, or deleted.</div>'}
  </div>

  ${entries.length ? `
  <div class="al-pagination">
    <div class="al-page-size">
      <label for="alPageSize">Rows per page</label>
      <select id="alPageSize">
        <option value="25">25</option>
        <option value="50" selected>50</option>
        <option value="100">100</option>
        <option value="200">200</option>
      </select>
    </div>
    <div class="al-page-nav">
      <button type="button" id="alPrevPage">‹ Prev</button>
      <span class="al-page-indicator" id="alPageIndicator">Page 1 of 1</span>
      <button type="button" id="alNextPage">Next ›</button>
    </div>
  </div>` : ''}
</div>
<script>
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
  // Real, bookmarkable, shareable URL now — /<orgToken>/auditlog — instead of
  // an about:blank popup built from document.write(). Still gated by
  // requireAuth + the org-token check server-side (see server.js), so opening
  // it in a new tab is safe: the session cookie travels with it.
  const w = window.open('/' + ORG_TOKEN + '/auditlog', '_blank');
  if(!w){ toast('Please allow popups to open the audit log in a new tab.'); }
}

/* ---------- Endpoint editor: opens as its own tab (server/views/editor.html) ----------
   Same session cookie, same org-token URL scheme as the audit log above — see
   server.js. Slugs identify the project/endpoint for readability/bookmarking
   only; the editor re-resolves them against /api/workspace itself. */
function slugify(str){
  return String(str||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'') || 'x';
}
function endpointSlugFor(ep){ return slugify((ep.method||'get') + '-' + (ep.path||'')); }
function buildEditorUrl(proj, ep){
  if(!proj) return `/${ORG_TOKEN}/edit.studio`;
  if(!ep) return `/${ORG_TOKEN}/${slugify(proj.name)}/edit.studio`;
  return `/${ORG_TOKEN}/${slugify(proj.name)}/${endpointSlugFor(ep)}/edit.studio`;
}
function openEditorTab(proj, ep){
  const w = window.open(buildEditorUrl(proj, ep), '_blank');
  if(!w){ toast('Please allow popups to open the endpoint editor in a new tab.'); }
}
/* ---------- Try it: opens in its own tab, same session cookie as the above ----------
   Rather than a separate page, this reuses the exact page it was launched from — the
   new tab lands on this endpoint's full docs (same crumb, same profile chip and theme
   toggle in the topbar) with the Try It panel already open on top, which is also how
   it always inherits the currently active light/dark theme (it's the same page reading
   the same localStorage key, not a copy that could drift out of sync). See the
   `tryit`/`env` query-param handling in boot() and renderMain(). The environment carries
   over from whichever was active when "Try it" was clicked, but only for this tab —
   it's never written back to this browser's saved env preference. */
function buildTryItUrl(ep){
  const url = new URL(location.href);
  url.search = '';
  url.searchParams.set('tryit', ep.id);
  url.searchParams.set('env', state.env);
  return url.pathname + url.search;
}
function openTryItTab(ep){
  const w = window.open(buildTryItUrl(ep), '_blank');
  if(!w){ toast('Please allow popups to open Try it in a new tab.'); }
}
// The draw.io-style diagram editor (server/views/architecture-studio.html) —
// opens in its own tab the same way edit.studio does, authenticated by the
// same session cookie. It re-resolves the project slug against
// /api/workspace itself, and its "Publish" button writes straight back to
// this project's `architectureDiagram` field via the normal PUT
// /api/workspace/projects call — no separate API route needed.
function buildArchitectureStudioUrl(proj){
  return `/${ORG_TOKEN}/${slugify(proj.name)}/architecture.studio`;
}
function openArchitectureStudioTab(proj){
  const w = window.open(buildArchitectureStudioUrl(proj), '_blank');
  if(!w){ toast('Please allow popups to open Architecture Studio in a new tab.'); }
}
// Release Pipeline v2 (server/views/release-pipeline.html) — opens in its
// own tab the same way, from Project settings ▸ Release Pipeline. All the
// actual promote/rollback/diff/history reads and writes go through the
// existing /api/workspace/projects/:id/* routes; this is just the shell.
function buildReleasePipelineUrl(proj){
  return `/${ORG_TOKEN}/${slugify(proj.name)}/release.pipeline`;
}
function openReleasePipelineTab(proj){
  const w = window.open(buildReleasePipelineUrl(proj), '_blank');
  if(!w){ toast('Please allow popups to open the Release Pipeline in a new tab.'); }
}
// "Open in Swagger Editor" — mints a signed, 10-minute public link to this
// project's combined OpenAPI spec (POST /projects/:id/openapi-link, see
// routes/workspace.js) and hands it to editor.swagger.io via its `?url=`
// param. editor.swagger.io fetches that URL itself, from the visitor's own
// browser — it never sees our session cookie, which is exactly why the link
// has to be a signed token instead of a normal authenticated request. The
// spec it renders is always the masked version (fake {{ENV-DNS}} hosts, no
// real secrets) — see openapiExport.js on the server.
//
// The blank tab is opened FIRST, synchronously, inside the click handler —
// not after the await below — because most browsers only allow window.open
// to succeed without being flagged as a popup when it happens directly
// inside a user gesture's call stack. Opening it early and redirecting it
// once the link is ready keeps that guarantee instead of racing against
// popup blockers.
async function openInSwaggerEditor(projectId){
  const w = window.open('', '_blank');
  if(w && w.document){
    w.document.title = 'Opening Swagger Editor…';
    w.document.body.style.cssText = 'font:14px -apple-system,sans-serif;color:#666;padding:32px;';
    w.document.body.textContent = 'Preparing your Swagger spec…';
  }
  try{
    const { url } = await apiSend('POST', `/projects/${projectId}/openapi-link`, {});
    const target = `https://editor.swagger.io/?url=${encodeURIComponent(url)}`;
    if(w && !w.closed) w.location.href = target;
    else {
      const w2 = window.open(target, '_blank');
      if(!w2) toast('Please allow popups to open Swagger Editor.');
    }
  }catch(e){
    if(w && !w.closed) w.close();
    toast('Could not generate a Swagger Editor link — try again.');
  }
}
// Renders a compact read-only preview of a published architecture diagram
// for the project overview page (the full icon library only lives in
// architecture-studio.html — this is just boxes, labels and connector lines,
// enough to recognise the shape of the diagram before opening the real editor).
// Greedily wraps `text` into lines that fit `maxWidth` px at roughly `fontSize`px
// (using a monospace-ish average-character-width estimate — good enough for a
// preview, not a real text-metrics measurement), capped at `maxLines` with an
// ellipsis on the last line if it overflows. Mirrors the editor's own text
// nodes wrapping to fit their box instead of this preview's old single
// truncated line, which is what made long connector notes unreadable here.
function wrapPreviewText(text, maxWidth, fontSize, maxLines){
  const avgCharW = fontSize * 0.56;
  const perLine = Math.max(4, Math.floor(maxWidth / avgCharW));
  const words = String(text||'').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for(const w of words){
    const next = cur ? cur + ' ' + w : w;
    if(next.length > perLine && cur){ lines.push(cur); cur = w; }
    else cur = next;
    if(lines.length === maxLines) break;
  }
  if(lines.length < maxLines && cur) lines.push(cur);
  if(lines.length === maxLines){
    const last = lines[maxLines-1];
    if(words.join(' ').length > lines.join(' ').length || last.length > perLine){
      lines[maxLines-1] = last.length > perLine - 1 ? last.slice(0, perLine-1).trimEnd() + '…' : last + '…';
    }
  }
  return lines;
}

// ---- Edge path routing, ported from architecture-studio.html so the
// preview draws the same right-angle elbow / curved / straight connectors
// (with rounded corners and arrowheads) as the actual editor, instead of a
// plain diagonal line between box centers — that mismatch was the biggest
// reason this preview looked rougher than the diagram it's previewing.
function pvSideIsHoriz(side){ return side==='left' || side==='right'; }
function pvPointTowards(from, to, dist){
  const dx=to.x-from.x, dy=to.y-from.y; const len=Math.hypot(dx,dy)||1;
  return { x: from.x + dx/len*dist, y: from.y + dy/len*dist };
}
function pvRoundedPolylinePath(pts, r){
  pts = pts.filter((p,i)=> i===0 || Math.hypot(p.x-pts[i-1].x, p.y-pts[i-1].y) > 0.5);
  if(pts.length < 2) return '';
  let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)} `;
  for(let i=1;i<pts.length-1;i++){
    const prev=pts[i-1], cur=pts[i], next=pts[i+1];
    const d1 = Math.hypot(cur.x-prev.x, cur.y-prev.y);
    const d2 = Math.hypot(next.x-cur.x, next.y-cur.y);
    const rr = Math.min(r, d1/2, d2/2);
    const p1 = pvPointTowards(cur, prev, rr);
    const p2 = pvPointTowards(cur, next, rr);
    d += `L ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} Q ${cur.x.toFixed(1)} ${cur.y.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)} `;
  }
  const last = pts[pts.length-1];
  d += `L ${last.x.toFixed(1)} ${last.y.toFixed(1)}`;
  return d;
}
function pvElbowPath(p1, side1, p2, side2, wp){
  let midX = (p1.x+p2.x)/2, midY = (p1.y+p2.y)/2;
  const h1 = pvSideIsHoriz(side1), h2 = pvSideIsHoriz(side2);
  if(wp){
    if(wp.axis === 'x' && h1 && h2) midX = wp.value;
    else if(wp.axis === 'y' && !h1 && !h2) midY = wp.value;
  }
  let pts;
  if(h1 && h2) pts = [p1, {x:midX,y:p1.y}, {x:midX,y:p2.y}, p2];
  else if(!h1 && !h2) pts = [p1, {x:p1.x,y:midY}, {x:p2.x,y:midY}, p2];
  else if(h1 && !h2) pts = [p1, {x:p2.x,y:p1.y}, p2];
  else pts = [p1, {x:p1.x,y:p2.y}, p2];
  return pvRoundedPolylinePath(pts, 12);
}
function pvStraightPath(p1, p2){
  return `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} L ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
}
const PV_SIDE_DIR = { top:{x:0,y:-1}, bottom:{x:0,y:1}, left:{x:-1,y:0}, right:{x:1,y:0} };
function pvCurvedPath(p1, side1, p2, side2){
  const pull = Math.max(40, Math.hypot(p2.x-p1.x, p2.y-p1.y) * 0.45);
  const d1 = PV_SIDE_DIR[side1] || PV_SIDE_DIR.right, d2 = PV_SIDE_DIR[side2] || PV_SIDE_DIR.left;
  const c1 = { x: p1.x + d1.x*pull, y: p1.y + d1.y*pull };
  const c2 = { x: p2.x + d2.x*pull, y: p2.y + d2.y*pull };
  return `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} C ${c1.x.toFixed(1)} ${c1.y.toFixed(1)} ${c2.x.toFixed(1)} ${c2.y.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
}
function pvEdgePathFor(edge, p1, side1, p2, side2){
  if(edge.shape === 'straight') return pvStraightPath(p1, p2);
  if(edge.shape === 'curved') return pvCurvedPath(p1, side1, p2, side2);
  const wp = (edge.waypoint != null && edge.waypointAxis) ? { axis: edge.waypointAxis, value: edge.waypoint } : null;
  return pvElbowPath(p1, side1, p2, side2, wp);
}
function pvPathMidpoint(edge, p1, side1, p2, side2){
  if(edge.shape === 'straight' || edge.shape === 'curved') return { x:(p1.x+p2.x)/2, y:(p1.y+p2.y)/2 };
  const h1 = pvSideIsHoriz(side1), h2 = pvSideIsHoriz(side2);
  if(h1 && h2) return { x:(p1.x+p2.x)/2, y:(p1.y+p2.y)/2 };
  if(!h1 && !h2) return { x:(p1.x+p2.x)/2, y:(p1.y+p2.y)/2 };
  if(h1 && !h2) return { x:p2.x, y:p1.y };
  return { x:p1.x, y:p2.y };
}

function architectureDiagramPreviewSvg(diagram){
  const nodes = (diagram && diagram.nodes) || [];
  const edges = (diagram && diagram.edges) || [];
  if(!nodes.length) return '';
  const pad = 26;
  const minX = Math.min(...nodes.map(n=>n.x)) - pad, minY = Math.min(...nodes.map(n=>n.y)) - pad;
  const maxX = Math.max(...nodes.map(n=>n.x+n.w)) + pad, maxY = Math.max(...nodes.map(n=>n.y+n.h)) + pad;
  const byId = {}; nodes.forEach(n=>byId[n.id]=n);
  const anchor = (n, side)=>{
    switch(side){
      case 'top': return { x:n.x+n.w/2, y:n.y };
      case 'bottom': return { x:n.x+n.w/2, y:n.y+n.h };
      case 'left': return { x:n.x, y:n.y+n.h/2 };
      default: return { x:n.x+n.w, y:n.y+n.h/2 };
    }
  };
  // Custom-colored arrowheads need their own <marker>, one per color, built
  // on demand and collected into <defs> — mirrors ensureArrowMarker() in
  // the editor (minus the alternate arrow shapes, which this preview
  // doesn't otherwise support).
  const markerDefs = {};
  const markerIdFor = (color)=>{
    const id = 'ad-prev-arrow-' + color.replace(/[^a-zA-Z0-9]/g, '');
    if(!markerDefs[id]) markerDefs[id] = `<marker id="${id}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${color}"></path></marker>`;
    return id;
  };
  const edgesSvg = edges.map(e=>{
    const a = byId[e.from], b = byId[e.to];
    if(!a || !b) return '';
    const fromSide = e.fromSide || 'right', toSide = e.toSide || 'left';
    const p1 = anchor(a, fromSide), p2 = anchor(b, toSide);
    const d = pvEdgePathFor(e, p1, fromSide, p2, toSide);
    // Match the editor's own logic (architecture-studio.html buildEdgeAttrs):
    // `lineStyle` replaces the old `dashed` boolean, and edges animate by
    // default (`animated !== false`) with the same dash pattern used there.
    const lineStyle = e.lineStyle || (e.dashed ? 'dashed' : 'solid');
    const isAnimated = e.animated !== false;
    const dashArray = lineStyle === 'dotted' ? '2 5' : lineStyle === 'dashed' ? '9 6' : (isAnimated ? '5 5' : 'none');
    const flowClass = isAnimated && lineStyle === 'solid' ? ' flow' : '';
    const showEndArrow = e.arrowEnd !== false;
    const showStartArrow = !!e.arrowStart;
    let markerAttrs = '', styleStr = '';
    if(e.color){
      const markerId = markerIdFor(e.color);
      styleStr = ` style="stroke:${e.color};"`;
      if(showEndArrow) markerAttrs += ` marker-end="url(#${markerId})"`;
      if(showStartArrow) markerAttrs += ` marker-start="url(#${markerId})"`;
    } else {
      if(showEndArrow) markerAttrs += ` marker-end="url(#ad-prev-arrowhead)"`;
      if(showStartArrow) markerAttrs += ` marker-start="url(#ad-prev-arrowhead)"`;
    }
    const pathSvg = `<path d="${d}" class="ad-prev-line${flowClass}"${dashArray!=='none' ? ` stroke-dasharray="${dashArray}"` : ''}${styleStr}${markerAttrs} fill="none"></path>`;
    // Edge's own short label (e.g. "HTTPS") — a small pill at the route's
    // midpoint, same treatment as the editor's .edge-label / .edge-label-bg.
    let labelSvg = '';
    if(e.label){
      const mid = pvPathMidpoint(e, p1, fromSide, p2, toSide);
      const w = Math.max(30, e.label.length*6.4 + 14);
      labelSvg = `<g><rect x="${mid.x-w/2}" y="${mid.y-10}" width="${w}" height="20" rx="6" class="ad-prev-edge-label-bg"></rect><text x="${mid.x}" y="${mid.y+4}" text-anchor="middle" class="ad-prev-edge-label">${escapeHtml(e.label)}</text></g>`;
    }
    return pathSvg + labelSvg;
  }).join('');
  const nodesSvg = nodes.map(n=>{
    if(n.kind === 'frame'){
      return `<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="10" class="ad-prev-frame"></rect>`;
    }
    if(n.kind === 'text'){
      const fontSize = 11.5;
      const lineH = fontSize * 1.35;
      const lines = wrapPreviewText(n.label, n.w, fontSize, 4);
      const startY = n.y + n.h/2 - ((lines.length-1) * lineH)/2 + fontSize*0.36;
      const tspans = lines.map((line,i)=>`<tspan x="${n.x+n.w/2}" y="${startY + i*lineH}">${escapeHtml(line)}</tspan>`).join('');
      return `<text text-anchor="middle" class="ad-prev-text" style="font-size:${fontSize}px;">${tspans}</text>`;
    }
    // Icon nodes carry a rendered badge (iconSvg/iconColor) snapshotted at
    // publish time — use it so this preview matches the editor's colors and
    // icons instead of falling back to a plain grey box. Older diagrams
    // published before that snapshot existed won't have it, hence the
    // fallback path below.
    if(n.kind === 'icon' && n.iconSvg){
      const badgeSize = Math.min(n.w, n.h) * 0.42;
      // A node's own explicit color override (set via the inspector) always
      // wins over the icon's default brand tint — matches the editor, where
      // node.color is an intentional highlight (e.g. a red-bordered gateway)
      // and shouldn't be masked by whatever color the icon normally is.
      const borderColor = n.color || n.iconColor || 'var(--border-strong)';
      return `<g>
        <rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="12" class="ad-prev-card" stroke="${borderColor}"></rect>
        <foreignObject x="${n.x + n.w/2 - badgeSize/2}" y="${n.y + n.h*0.16}" width="${badgeSize}" height="${badgeSize}">
          <div xmlns="http://www.w3.org/1999/xhtml" style="width:100%;height:100%;">${n.iconSvg}</div>
        </foreignObject>
        <text x="${n.x+n.w/2}" y="${n.y+n.h - 10}" text-anchor="middle" class="ad-prev-label">${escapeHtml((n.label||'').slice(0,22))}</text>
      </g>`;
    }
    return `<g>
      <rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="12" class="ad-prev-card"${n.color ? ` stroke="${n.color}"` : ''}></rect>
      <text x="${n.x+n.w/2}" y="${n.y+n.h/2+4}" text-anchor="middle" class="ad-prev-label">${escapeHtml((n.label||'').slice(0,22))}</text>
    </g>`;
  }).join('');
  return `<svg viewBox="${minX} ${minY} ${maxX-minX} ${maxY-minY}" class="ad-preview-svg" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Architecture diagram preview"><defs><marker id="ad-prev-arrowhead" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="ad-prev-arrow"></path></marker>${Object.values(markerDefs).join('')}</defs>${edgesSvg}${nodesSvg}</svg>`;
}
// Both the editor tab and the architecture studio tab broadcast on save so
// this tab can pick up the change without a manual refresh.
if('BroadcastChannel' in window){
  const editorSyncChannel = new BroadcastChannel('doctracker-sync');
  editorSyncChannel.addEventListener('message', (e)=>{
    if(!e.data || !['endpoint-saved','architecture-diagram-saved'].includes(e.data.type)) return;
    loadState().then(()=>{
      renderAll();
      toast(e.data.type === 'architecture-diagram-saved' ? 'Architecture diagram updated in another tab — refreshed.' : 'Endpoint updated in another tab — refreshed.');
    });
  });
}
