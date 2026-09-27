/* ==================== SECTION:UTIL ==================== */
function uid(){ return Math.random().toString(36).slice(2,10); }

function escapeHtml(str){
  if(str === undefined || str === null) return '';
  return String(str).replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

/* Lightweight markdown renderer for description/notes text pulled in from OpenAPI specs
   (headings, numbered/bulleted lists — including nested ones, bold, italics, inline code,
   paragraphs). Input is escaped first so this never introduces raw HTML — only the
   whitelisted tags below are emitted. */
function renderMarkdown(str){
  if(!str) return '';
  const src = String(str).replace(/\r\n?/g, '\n');
  const rawLines = escapeHtml(src).split('\n');
  const inline = s => s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?:^|\s)\*([^*\s][^*]*)\*(?=\s|$)/g, (m,g)=>m.replace('*'+g+'*','<em>'+g+'</em>'))
    // QA regression (2026-09-26, bug #11): standard markdown italics can be
    // written with either *asterisks* or _underscores_ - only the asterisk
    // form was ever handled, so _italic_ rendered as the literal characters.
    // Same whitespace-boundary requirement as the asterisk version above,
    // for the same reason: without it, every snake_case identifier
    // (my_variable_name) would get partially italicized, since an
    // unqualified /_(.+?)_/ would match the first two underscores in it.
    // Requiring the opening _ to be preceded by whitespace/start-of-line
    // means a word-internal underscore is never mistaken for emphasis.
    .replace(/(?:^|\s)_([^_\s][^_]*)_(?=\s|$)/g, (m,g)=>m.replace('_'+g+'_','<em>'+g+'</em>'));

  const listItemRe = /^(\s*)([-*]|\d+[.)])\s+(.*)$/;

  // Collects a run of list-item lines starting at `start` into a flat array of
  // {indent, type, text}. A blank line does NOT end the block by itself — real
  // markdown allows "loose" lists with blank lines between items — it only ends
  // the block if the next non-blank line isn't also a list item. This is what
  // lets a category bullet, a blank line, then its indented sub-bullets all stay
  // part of the same list instead of splitting into separate flat lists.
  function collectListBlock(lines, start){
    const items = [];
    let i = start;
    while(i < lines.length){
      const line = lines[i];
      if(!line.trim()){
        let j = i + 1;
        while(j < lines.length && !lines[j].trim()) j++;
        if(j < lines.length && listItemRe.test(lines[j])){ i++; continue; }
        break;
      }
      const m = line.match(listItemRe);
      if(!m) break;
      const indent = m[1].replace(/\t/g, '  ').length;
      const type = /\d/.test(m[2]) ? 'ol' : 'ul';
      items.push({ indent, type, text: m[3] });
      i++;
    }
    return { items, next: i };
  }

  // Turns the flat {indent, type, text} list into a tree by comparing each
  // item's indentation against the current stack — deeper indent nests under
  // the previous item, shallower/equal indent pops back up to that level.
  function buildTree(items){
    const root = [];
    const stack = [{ indent: -1, children: root }];
    items.forEach(item => {
      while(stack.length > 1 && item.indent <= stack[stack.length - 1].indent) stack.pop();
      const node = { type: item.type, text: item.text, children: [] };
      stack[stack.length - 1].children.push(node);
      stack.push({ indent: item.indent, children: node.children });
    });
    return root;
  }

  // Renders the tree, grouping consecutive siblings by list type so mixed
  // ul/ol runs at the same level still produce separate, valid <ul>/<ol> tags.
  function renderNodes(nodes){
    if(!nodes.length) return '';
    let html = '', i = 0;
    while(i < nodes.length){
      const t = nodes[i].type;
      const group = [];
      while(i < nodes.length && nodes[i].type === t){ group.push(nodes[i]); i++; }
      html += `<${t} class="md-list">${group.map(n => `<li>${inline(n.text)}${renderNodes(n.children)}</li>`).join('')}</${t}>`;
    }
    return html;
  }

  const out = [];
  let i = 0;
  while(i < rawLines.length){
    const raw = rawLines[i];
    const line = raw.trim();
    if(!line){ i++; continue; }
    let m;
    if(listItemRe.test(raw)){
      const { items, next } = collectListBlock(rawLines, i);
      out.push(renderNodes(buildTree(items)));
      i = next;
    } else if((m = line.match(/^(#{1,4})\s+(.*)$/))){
      out.push(`<div class="md-h md-h${m[1].length}">${inline(m[2])}</div>`);
      i++;
    } else {
      out.push(`<p class="md-p">${inline(line)}</p>`);
      i++;
    }
  }
  return out.join('');
}

// Splits raw (unescaped) markdown into sections at each heading line (#..####),
// so the project Overview page can render "Overview" / "Flow" / "Authentication"
// as their own cards instead of one long flowing block of text.
function splitMarkdownSections(str){
  if(!str) return [];
  const lines = String(str).replace(/\r\n?/g, '\n').split('\n');
  const sections = [];
  let current = { title: null, lines: [] };
  const hasContent = s => s.title || s.lines.some(l=>l.trim());
  lines.forEach(raw=>{
    const m = raw.trim().match(/^#{1,4}\s+(.*)$/);
    if(m){
      if(hasContent(current)) sections.push(current);
      current = { title: m[1].trim(), lines: [] };
    } else {
      current.lines.push(raw);
    }
  });
  if(hasContent(current)) sections.push(current);
  return sections.map(s=>({ title: s.title, body: s.lines.join('\n').trim() }));
}

function overviewSectionIcon(title){
  const t = (title||'').toLowerCase();
  if(t.includes('auth')) return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="9" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path></svg>';
  if(t.includes('flow')) return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="6" r="2.5"></circle><circle cx="19" cy="18" r="2.5"></circle><path d="M7.2 7.2C10 10 14 10 16.8 16.8"></path></svg>';
  if(t.includes('overview')) return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 8h.01M11 12h1v5h1"></path></svg>';
  return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h9l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"></path><path d="M15 3v5h5"></path></svg>';
}

/* ---------- Project documents / attachments ---------- */
const ICON_DOWNLOAD = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"></path><path d="M7 10l5 5 5-5"></path><path d="M4 21h16"></path></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"></path><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"></path><path d="M7 7l1 13a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2l1-13"></path></svg>';
const ICON_EYE = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
const ICON_EYE_OFF = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-11-7-11-7a19.9 19.9 0 0 1 4.22-5.06M9.9 4.24A10.4 10.4 0 0 1 12 5c7 0 11 7 11 7a19.86 19.86 0 0 1-2.34 3.36"></path><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>';
const ICON_LOCK = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="11" rx="2"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3"></path></svg>';
const ICON_DRAG = '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><circle cx="8" cy="6" r="1.6"></circle><circle cx="8" cy="12" r="1.6"></circle><circle cx="8" cy="18" r="1.6"></circle><circle cx="16" cy="6" r="1.6"></circle><circle cx="16" cy="12" r="1.6"></circle><circle cx="16" cy="18" r="1.6"></circle></svg>';

// Extension -> { label, accent CSS var, accent-bg CSS var } used for both the
// Project settings document list and the overview-page document cards. Reuses
// the same method-color palette as the rest of the app so a new visual
// language doesn't have to be invented just for file types.
const DOC_TYPE_META = {
  pdf:  { label:'PDF',  accent:'--delete', bg:'--delete-bg' },
  doc:  { label:'DOC',  accent:'--get',    bg:'--get-bg' },
  docx: { label:'DOC',  accent:'--get',    bg:'--get-bg' },
  rtf:  { label:'DOC',  accent:'--get',    bg:'--get-bg' },
  xls:  { label:'XLS',  accent:'--post',   bg:'--post-bg' },
  xlsx: { label:'XLS',  accent:'--post',   bg:'--post-bg' },
  csv:  { label:'CSV',  accent:'--post',   bg:'--post-bg' },
  ppt:  { label:'PPT',  accent:'--put',    bg:'--put-bg' },
  pptx: { label:'PPT',  accent:'--put',    bg:'--put-bg' },
  png:  { label:'IMG',  accent:'--patch',  bg:'--patch-bg' },
  jpg:  { label:'IMG',  accent:'--patch',  bg:'--patch-bg' },
  jpeg: { label:'IMG',  accent:'--patch',  bg:'--patch-bg' },
  gif:  { label:'IMG',  accent:'--patch',  bg:'--patch-bg' },
  svg:  { label:'IMG',  accent:'--patch',  bg:'--patch-bg' },
  webp: { label:'IMG',  accent:'--patch',  bg:'--patch-bg' },
  zip:  { label:'ZIP',  accent:'--accent', bg:'--accent-soft' },
  rar:  { label:'ZIP',  accent:'--accent', bg:'--accent-soft' },
  '7z': { label:'ZIP',  accent:'--accent', bg:'--accent-soft' },
  json: { label:'JSON', accent:'--accent', bg:'--accent-soft' },
  xml:  { label:'XML',  accent:'--accent', bg:'--accent-soft' },
  yaml: { label:'YAML', accent:'--accent', bg:'--accent-soft' },
  yml:  { label:'YAML', accent:'--accent', bg:'--accent-soft' },
  txt:  { label:'TXT',  accent:'--text-faint', bg:'--surface-2' },
  md:   { label:'MD',   accent:'--text-faint', bg:'--surface-2' },
};
function docTypeMeta(name){
  const ext = ((name||'').split('.').pop() || '').toLowerCase();
  return DOC_TYPE_META[ext] || { label: ext ? ext.slice(0,4).toUpperCase() : 'FILE', accent:'--text-faint', bg:'--surface-2' };
}
function formatFileSize(bytes){
  if(bytes === undefined || bytes === null || isNaN(bytes)) return '';
  if(bytes < 1024) return bytes + ' B';
  if(bytes < 1024*1024) return (bytes/1024).toFixed(1) + ' KB';
  return (bytes/(1024*1024)).toFixed(1) + ' MB';
}
// Soft warning threshold (characters of base64 ≈ bytes) for the storage meter —
// localStorage is shared by every project in the browser, typically capped
// around 5–10MB total, so this nudges people toward smaller reference files
// well before a save actually fails.
const DOC_STORAGE_SOFT_CAP = 4.5 * 1024 * 1024;
function totalDocStorageBytes(){
  return allProjects().reduce((sum,p)=> sum + (p.attachments||[]).reduce((s,a)=> s + (a.dataUrl ? a.dataUrl.length : 0), 0), 0);
}

// Short, readable "Aug 20, 2026, 3:04 PM" style stamp used for endpoint
// added-by / last-modified-by attribution.
function formatDateTime(iso){
  if(!iso) return '';
  const d = new Date(iso);
  if(isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' }) +
    ', ' + d.toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit' });
}

function methodClass(m){ return (m||'get').toLowerCase(); }

function respClass(code){
  const c = String(code)[0];
  return 'c'+(['2','3','4','5'].includes(c) ? c : '2');
}
function respColorVar(code){
  const cls = respClass(code);
  return cls==='c2' ? '--st-2' : cls==='c3' ? '--st-3' : cls==='c4' ? '--st-4' : '--st-5';
}

function envMeta(envId){
  return environments().find(e=>e.id===envId) || environments()[0];
}

function copyToClipboard(text, btn){
  navigator.clipboard.writeText(text).then(()=>{
    if(btn){
      const orig = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(()=>{ btn.textContent = orig; }, 1400);
    } else {
      toast('Copied to clipboard');
    }
  }).catch(()=>toast('Could not copy — clipboard blocked'));
}

function allProjects(){ return Object.values(state.projects); }

function findEndpoint(epId){
  for(const proj of allProjects()){
    const ep = proj.endpoints.find(e=>e.id===epId);
    if(ep) return { proj, ep };
  }
  return null;
}

function projectHasEndpoint(epId){
  return allProjects().some(p=>p.endpoints.some(e=>e.id===epId));
}

// ----------------------------------------------------------------------------
// Environment-scoped viewing. `proj.endpoints` is always the LIVE DRAFT —
// editing (openManualModal/saveManualEndpoint/duplicate/delete/etc.) reads
// and writes it directly, regardless of which environment is selected in the
// topbar. But *browsing* (sidebar list, overview, endpoint detail, PDF/doc
// export) needs to reflect whichever environment is actually selected: an
// endpoint added in Dev shouldn't show up in SIT/UAT/Production until it's
// been promoted through the Release Pipeline. viewEndpoints()/findEndpointForView()
// below are what every read/render path should call instead of proj.endpoints
// directly; snapshots are fetched from GET /projects/:id/snapshot and cached
// per project+environment for the life of the page.
// ----------------------------------------------------------------------------
function draftEnvId(){
  const stages = environments().filter(e=>String(e.label||'').trim().toUpperCase()!=='DR');
  return stages.length ? stages[0].id : null;
}
function isViewingDraftEnv(){ return state.env === draftEnvId(); }

const _snapshotCache = {}; // `${projId}::${envId}` -> { status:'loading'|'ready'|'error', endpoints, versionLabel, promotedAt, promotedBy, isDraft }
function snapshotEntry(projId){
  const key = projId + '::' + state.env;
  const entry = _snapshotCache[key];
  if(entry) return entry;
  _snapshotCache[key] = { status:'loading' };
  apiGet(`/projects/${encodeURIComponent(projId)}/snapshot?environmentId=${encodeURIComponent(state.env)}`)
    .then(res=>{
      _snapshotCache[key] = { status:'ready', ...res };
      renderAll();
      // If the PDF export modal is open for this project waiting on this same
      // snapshot, refresh its endpoint list now that it's arrived.
      if(projId === pdfExportProjectId && document.getElementById('pdfExportModal')?.classList.contains('show')){
        openExportPdfModal(projId);
      }
    })
    .catch(()=>{ _snapshotCache[key] = { status:'error' }; renderAll(); });
  return _snapshotCache[key];
}
// The list of endpoints to actually render for `proj` given the currently
// selected environment — the live draft when Dev is selected, otherwise
// whatever's frozen in that stage's snapshot (empty array while it loads).
function viewEndpoints(proj){
  // Auto-discovery bypass: a discovery agent's endpoints are an observed
  // fact about what's running in an environment, not a documentation draft
  // awaiting Release Pipeline sign-off - requiring promotion before
  // DocTracker will even ADMIT an endpoint exists in SIT is backwards for
  // something a log agent watched happen in SIT. proj.discoveryEnvironment
  // is set by the agent itself (mule_doc_agent.py's build_project) to
  // whichever DOCTRACKER_ENVIRONMENT it declared. Checked BEFORE the draft
  // check below (not after) and unconditionally on a mismatch: the normal
  // draft environment (commonly "Dev") shows every hand-written project's
  // full unpromoted content because draft work has nowhere else to live -
  // but a SIT discovery is not draft work sitting in Dev, it is SIT data,
  // and must stay invisible outside the one environment it was actually
  // observed in, Dev included. Without this an auto-discovered project
  // still leaked into every viewer's Dev tab regardless of state.env.
  if(proj.discoveryEnvironment){
    return String(proj.discoveryEnvironment).trim().toLowerCase() === String(state.env||'').trim().toLowerCase()
      ? proj.endpoints : [];
  }
  if(isViewingDraftEnv()) return proj.endpoints;
  const entry = snapshotEntry(proj.id);
  return entry.status === 'ready' ? (entry.endpoints || []) : [];
}
function invalidateSnapshotCache(projId){
  Object.keys(_snapshotCache).forEach(key=>{
    if(key.startsWith(projId + '::')) delete _snapshotCache[key];
  });
}
function findEndpointForView(epId){
  if(isViewingDraftEnv()) return findEndpoint(epId);
  for(const proj of allProjects()){
    const ep = viewEndpoints(proj).find(e=>e.id===epId);
    if(ep) return { proj, ep };
  }
  return null;
}
// Endpoint mutation is only ever meaningful against the live draft — gate
// every create/edit/duplicate/delete entry point on this alongside canEdit().
function canEditHere(){ return canEdit() && isViewingDraftEnv(); }

// ----------------------------------------------------------------------------
// Discovery reconciliation — "is this auto-discovered thing already documented?"
//
// The log agent has no idea what anybody has documented by hand. It groups the
// traffic it sees by Mule app and pushes one project per app (see
// build_app_projects() / project_id_for_app() in ops/sit-doc-agent), with an id
// derived from the app name and the agent's own PROJECT_ID. A hand-authored
// project covering that same app has an unrelated id, so the two sit side by
// side in the sidebar as two entries with the same name — which reads as "we
// have this twice" when the truth is "we have this once, and the agent also
// found it running."
//
// Rather than have the agent guess (it cannot see the curated docs, and writing
// unreviewed discovery INTO a reviewed project would be worse than the
// duplicate), the reconciliation happens here, at render time, where both sides
// are in hand. Nothing is mutated: discovery stays a separate, unreviewed
// record of what is actually running, and the sidebar simply stops showing the
// half of it that is already written up.
//
// Matching is deliberately conservative and explainable — a wrong match hides a
// real, undocumented endpoint, which is the one failure that matters here.
// ----------------------------------------------------------------------------

// A path with its per-request variation removed, so two spellings of the same
// endpoint compare equal: the agent templatises identifier segments to "{id}"
// (templatize_path) while a human writes "{loanId}", and a trailing slash or a
// query string is not a different endpoint.
function discoveryPathShape(path){
  let p = String(path || '').trim();
  const q = p.indexOf('?');
  if(q >= 0) p = p.slice(0, q);
  p = p.replace(/\{[^}]*\}/g, '{}').replace(/\/+$/, '');
  if(!p.startsWith('/')) p = '/' + p;
  return p || '/';
}

function discoveryEndpointKey(method, path){
  return String(method || '').trim().toUpperCase() + ' ' + discoveryPathShape(path);
}

// Mule's APIkit logs the router flow with the listener's base path stripped, so
// the agent can observe "/loan/dpd" for an endpoint documented as
// "/api/v1/loan/dpd". Because every shape starts with "/", endsWith() already
// guarantees the overlap begins on a segment boundary — "/dpd" can never match
// "/loandpd". Used ONLY inside an already-matched project (see below), where a
// loose suffix cannot pull in an unrelated API.
function discoveryPathIsSuffix(shortPath, longPath){
  return shortPath !== longPath && shortPath.length > 1 && longPath.endsWith(shortPath);
}

// Project names compare on letters and digits only: "Razor pay", "razor-pay"
// and "razorpay" are the same app written three ways.
function discoveryNameKey(name){
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// A human's verdict on one auto project, stored on the DOCUMENTED project
// (which the agent never rewrites) as { [autoProjectId]: 'linked' | 'separate' }.
// 'linked' forces a match the name heuristic missed; 'separate' dismisses one it
// got wrong. Nothing else in the app reads these, so an agent push cannot
// clobber them.
function discoveryLinkVerdict(docProj, autoProjId){
  const links = docProj && docProj.discoveryLinks;
  return (links && links[autoProjId]) || null;
}

// Every hand-documented endpoint, indexed by shape. Built from proj.endpoints
// (the live draft) rather than viewEndpoints(): "have we documented this?" is a
// question about the documentation, not about what has been promoted into the
// environment you happen to be looking at — an endpoint documented but not yet
// promoted to SIT is still documented, and should not be offered as new.
function documentedEndpointIndex(){
  const exact = new Map();  // "GET /a/{}/b" -> [{ proj, ep }]
  const byProject = new Map();  // projId -> [{ proj, ep, shape }]
  for(const proj of allProjects()){
    if(proj.discoveryEnvironment) continue;
    const rows = [];
    for(const ep of (proj.endpoints || [])){
      if(!ep || !ep.path) continue;
      const shape = discoveryPathShape(ep.path);
      const key = String(ep.method || '').trim().toUpperCase() + ' ' + shape;
      if(!exact.has(key)) exact.set(key, []);
      exact.get(key).push({ proj, ep });
      rows.push({ proj, ep, shape, method: String(ep.method || '').trim().toUpperCase() });
    }
    byProject.set(proj.id, rows);
  }
  return { exact, byProject };
}

// Which documented project, if any, this auto-discovered one is a second copy
// of — and why, so the UI can say so rather than asserting it.
function discoveryCounterpart(autoProj, index){
  const docProjects = allProjects().filter(p => !p.discoveryEnvironment);
  for(const docProj of docProjects){
    if(discoveryLinkVerdict(docProj, autoProj.id) === 'linked'){
      return { proj: docProj, reason: 'linked' };
    }
  }
  const autoKey = discoveryNameKey(autoProj.name);
  if(autoKey){
    for(const docProj of docProjects){
      if(discoveryLinkVerdict(docProj, autoProj.id) === 'separate') continue;
      if(discoveryNameKey(docProj.name) === autoKey) return { proj: docProj, reason: 'name' };
    }
  }
  // No name match: fall back to whichever documented project already covers the
  // most of these endpoints. An app renamed between the docs and the deployment
  // is still the same app, and its endpoints say so.
  const tally = new Map();
  for(const ep of (autoProj.endpoints || [])){
    const hits = index.exact.get(discoveryEndpointKey(ep.method, ep.path)) || [];
    for(const hit of hits){
      if(discoveryLinkVerdict(hit.proj, autoProj.id) === 'separate') continue;
      tally.set(hit.proj.id, (tally.get(hit.proj.id) || 0) + 1);
    }
  }
  let bestId = null, bestCount = 0;
  for(const [projId, count] of tally){
    if(count > bestCount){ bestId = projId; bestCount = count; }
  }
  if(bestId && bestCount > 0) return { proj: state.projects[bestId], reason: 'endpoints' };
  return null;
}

// One auto-discovered project reconciled against the documentation.
//   documented  the project this duplicates, or null
//   reason      'linked' | 'name' | 'endpoints' — why we think so
//   matches     epId -> { proj, ep, confidence: 'exact' | 'path' }
//   novelIds    Set of this project's endpoint ids that nothing documents
function discoveryCoverage(autoProj, index){
  index = index || documentedEndpointIndex();
  const counterpart = discoveryCounterpart(autoProj, index);
  const matches = new Map();
  const novelIds = new Set();
  const siblings = counterpart ? (index.byProject.get(counterpart.proj.id) || []) : [];

  for(const ep of (autoProj.endpoints || [])){
    if(!ep || !ep.path){ continue; }
    const exact = index.exact.get(discoveryEndpointKey(ep.method, ep.path)) || [];
    // Prefer a hit inside the counterpart project — the same path documented in
    // two projects should resolve to the one this app actually belongs to.
    let hit = counterpart ? exact.find(h => h.proj.id === counterpart.proj.id) : null;
    if(hit){ matches.set(ep.id, { ...hit, confidence: 'exact' }); continue; }
    if(exact.length){ matches.set(ep.id, { ...exact[0], confidence: 'exact' }); continue; }

    // Base-path drift, only ever within the counterpart project.
    const method = String(ep.method || '').trim().toUpperCase();
    const shape = discoveryPathShape(ep.path);
    const loose = siblings.find(row => row.method === method
      && (discoveryPathIsSuffix(shape, row.shape) || discoveryPathIsSuffix(row.shape, shape)));
    if(loose){ matches.set(ep.id, { proj: loose.proj, ep: loose.ep, confidence: 'path' }); continue; }

    novelIds.add(ep.id);
  }

  const total = (autoProj.endpoints || []).filter(ep => ep && ep.path).length;
  return {
    autoProj,
    documented: counterpart ? counterpart.proj : null,
    reason: counterpart ? counterpart.reason : null,
    matches, novelIds,
    total,
    covered: matches.size,
    novel: novelIds.size,
  };
}

// Same comparison viewEndpoints() already uses to keep an auto-discovered
// project invisible outside the one environment it was actually observed in.
// reconcileDiscovery() needs its own copy of that check: without it, the
// sidebar's "Auto-discovered APIs" count and the Control Center's Discovery
// Coverage panel pooled every environment's discovery projects together —
// switching the header from SIT to Dev showed the exact same numbers, and a
// Dev-only app like x-mobile-common-api appeared in the list while looking
// at SIT.
function discoveryMatchesCurrentEnv(proj){
  return String(proj.discoveryEnvironment || '').trim().toLowerCase() === String(state.env || '').trim().toLowerCase();
}

// Every auto-discovered project reconciled in one pass, plus the two headline
// numbers the sidebar and Control Center report. Scoped to the CURRENTLY
// SELECTED environment — see discoveryMatchesCurrentEnv() above.
function reconcileDiscovery(){
  const index = documentedEndpointIndex();
  const byAutoId = {};
  let duplicateProjects = 0, duplicateEndpoints = 0, novelEndpoints = 0;
  for(const proj of allProjects()){
    if(!proj.discoveryEnvironment || !discoveryMatchesCurrentEnv(proj)) continue;
    const cov = discoveryCoverage(proj, index);
    byAutoId[proj.id] = cov;
    if(cov.documented) duplicateProjects += 1;
    duplicateEndpoints += cov.covered;
    novelEndpoints += cov.novel;
  }
  return { byAutoId, duplicateProjects, duplicateEndpoints, novelEndpoints };
}

// ----------------------------------------------------------------------------
// Release health (breaking-changes-per-release trend for the Overview page's
// sparkline — Release Pipeline v2 item "a signal, not just something you see
// mid-promotion"). Same lazy-fetch-and-cache shape as snapshotEntry above:
// fetched once per project for the life of the page, re-rendered when it
// arrives rather than blocking the Overview render on it.
// ----------------------------------------------------------------------------
const _releaseHealthCache = {}; // projId -> { status:'loading'|'ready'|'error', points, lastStageLabel }
function releaseHealthEntry(projId){
  const entry = _releaseHealthCache[projId];
  if(entry) return entry;
  _releaseHealthCache[projId] = { status:'loading' };
  apiGet(`/projects/${encodeURIComponent(projId)}/release-health`)
    .then(res=>{ _releaseHealthCache[projId] = { status:'ready', ...res }; renderAll(); })
    .catch(()=>{ _releaseHealthCache[projId] = { status:'error' }; });
  return _releaseHealthCache[projId];
}
