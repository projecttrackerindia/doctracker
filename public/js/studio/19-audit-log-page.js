/* ==================== SECTION:TAB-LINKS ====================
   "Open in a new tab" URL-builders/launchers for the editor, Try It,
   Architecture Studio, Release Pipeline, and the audit log — all sharing
   the signed-in session cookie, authenticated the same way the main tab is
   (server.js), just addressed via a bookmarkable /<orgToken>/... URL
   instead of routed through this page's own SPA state. Renamed from
   SECTION:AUDIT-LOG-PAGE — this file used to also build the audit log's
   entire standalone HTML document by hand (buildAuditLogHtml/
   auditActionMeta); that's now server/views/auditlog.html instead, so the
   dead client-side generator was removed and only the actual "open it in a
   new tab" launcher below remains. */
function openAuditLogTab(searchQuery){
  // Real, bookmarkable, shareable URL now — /<orgToken>/auditlog — instead of
  // an about:blank popup built from document.write(). Still gated by
  // requireAuth + the org-token check server-side (see server.js), so opening
  // it in a new tab is safe: the session cookie travels with it.
  // Optional `searchQuery` pre-fills the audit log's own search box (see the
  // ?q= deep-link handling in auditlog.html) — used by Security Center's
  // "Audit trail" card to jump straight to the reveal/key-rotation events it
  // describes instead of an unfiltered log the visitor has to filter by hand.
  const url = '/' + ORG_TOKEN + '/auditlog' + (searchQuery ? '?q=' + encodeURIComponent(searchQuery) : '');
  const w = window.open(url, '_blank');
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
      const blockH = lines.length * lineH;
      const startY = n.y + n.h/2 - ((lines.length-1) * lineH)/2 + fontSize*0.36;
      const tspans = lines.map((line,i)=>`<tspan x="${n.x+n.w/2}" y="${startY + i*lineH}">${escapeHtml(line)}</tspan>`).join('');
      // A translucent backing chip behind the text — without it, a note that
      // happens to sit over a connector line or another box (routing is
      // user-placed, so this isn't rare) becomes unreadable; the editor
      // itself avoids this by leaving canvas empty behind text, but this
      // preview can't guarantee that same empty space around every note.
      const chipPad = 6;
      const chipY = n.y + n.h/2 - blockH/2 - chipPad;
      const chipH = blockH + chipPad*2;
      const bg = `<rect x="${n.x - chipPad}" y="${chipY}" width="${n.w + chipPad*2}" height="${chipH}" rx="6" class="ad-prev-text-bg"></rect>`;
      return `<g>${bg}<text text-anchor="middle" class="ad-prev-text" style="font-size:${fontSize}px;">${tspans}</text></g>`;
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
