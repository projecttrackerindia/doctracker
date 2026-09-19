/* ==================== SECTION:METRICS ==================== */
const DOC_CHECKS = [
  { key:'summary',     label:'Summary',           test:(ep)=> !!(ep.summary||'').trim() },
  { key:'description', label:'Description',       test:(ep)=> !!(ep.description||'').trim() },
  { key:'parameters',  label:'Parameters',         test:(ep)=> (ep.parameters||[]).length>0 || !/\{[^}]+\}/.test(ep.path||'') },
  { key:'required',    label:'Required flags',     test:(ep)=> (ep.parameters||[]).length===0 || (ep.parameters||[]).some(p=>p.required) },
  { key:'examples',    label:'Examples',           test:(ep)=> (ep.parameters||[]).some(p=>p.example) || !!(ep.requestBody && ep.requestBody.example) },
  { key:'reqschema',   label:'Request schema',     test:(ep)=> ['GET','HEAD','DELETE'].includes((ep.method||'').toUpperCase()) || !!(ep.requestBody && ep.requestBody.example) },
  { key:'respschema',  label:'Response schema',    test:(ep)=> (ep.responses||[]).some(r=>r.example || (r.fields&&r.fields.length)) },
  { key:'errors',      label:'Error responses',    test:(ep)=> (ep.responses||[]).some(r=>String(r.code)[0] && String(r.code)[0] !== '2') },
  { key:'auth',        label:'Authentication',     test:(ep, proj)=> !!(proj && proj.auth && proj.auth.type) },
  { key:'version',     label:'Version',            test:(ep, proj)=> !!((proj && proj.version) || ep.version || '').trim() },
  { key:'contenttype', label:'Content type',       test:(ep)=> !!(ep.contentType||'').trim() },
];

function computeDocScore(ep, proj){
  const checks = DOC_CHECKS.map(c=>({ label:c.label, pass: !!c.test(ep, proj) }));
  const passed = checks.filter(c=>c.pass).length;
  return { percent: Math.round((passed/checks.length)*100), passed, total: checks.length, checks };
}

function workspaceMetrics(){
  const projects = allProjects();
  let totalEndpoints = 0, scoreSum = 0, wellDocumented = 0, partial = 0, poor = 0;
  let missingAuth = 0, envsFullyConfigured = 0;
  const lifecycleCounts = {};
  LIFECYCLE_STAGES.forEach(s=>lifecycleCounts[s]=0);

  projects.forEach(proj=>{
    lifecycleCounts[proj.lifecycle] = (lifecycleCounts[proj.lifecycle]||0) + 1;
    if(environments().every(e=>proj.environments[e.id])) envsFullyConfigured++;
    if(!(proj.auth && proj.auth.type)) missingAuth++;
    proj.endpoints.forEach(ep=>{
      totalEndpoints++;
      const score = computeDocScore(ep, proj).percent;
      scoreSum += score;
      if(score >= 80) wellDocumented++; else if(score >= 50) partial++; else poor++;
    });
  });

  const avgDoc = totalEndpoints ? Math.round(scoreSum/totalEndpoints) : 0;
  const deprecated = projects.filter(p=>['DEPRECATED','RETIRED'].includes(p.lifecycle)).length;

  return {
    apiCount: projects.length, totalEndpoints, avgDoc,
    wellDocumented, partial, poor,
    missingAuth, envsFullyConfigured, deprecated, lifecycleCounts,
  };
}

function lifecycleWheelSvg(currentStage){
  const idx = LIFECYCLE_STAGES.indexOf(currentStage);
  const total = LIFECYCLE_STAGES.length;
  const cx = 110, cy = 110, rOuter = 92, rInner = 60, gapDeg = 3;
  const segAngle = 360 / total;
  const toRad = deg => (deg - 90) * Math.PI / 180; // 0deg = 12 o'clock, sweeps clockwise
  const polar = (r, deg) => { const rad = toRad(deg); return [cx + r*Math.cos(rad), cy + r*Math.sin(rad)]; };
  const segPath = (startDeg, endDeg, r1, r2) => {
    const [x1,y1] = polar(r2, startDeg), [x2,y2] = polar(r2, endDeg);
    const [x3,y3] = polar(r1, endDeg), [x4,y4] = polar(r1, startDeg);
    const large = (endDeg - startDeg) > 180 ? 1 : 0;
    return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r2} ${r2} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} L ${x3.toFixed(2)} ${y3.toFixed(2)} A ${r1} ${r1} 0 ${large} 0 ${x4.toFixed(2)} ${y4.toFixed(2)} Z`;
  };

  const segments = LIFECYCLE_STAGES.map((stage,i)=>{
    const start = i*segAngle + gapDeg/2, end = (i+1)*segAngle - gapDeg/2;
    const st = i < idx ? 'done' : i === idx ? 'current' : 'upcoming';
    const fill = st==='done' ? 'var(--post)' : st==='current' ? 'var(--accent)' : 'var(--surface-2)';
    return `<path d="${segPath(start,end,rInner,rOuter)}" fill="${fill}" class="lc-wheel-seg lc-wheel-${st}"><title>${escapeHtml(stage)}${st==='current'?' — current stage':st==='done'?' — completed':' — upcoming'}</title></path>`;
  }).join('');

  const stageDisplay = currentStage.charAt(0) + currentStage.slice(1).toLowerCase();

  const legend = LIFECYCLE_STAGES.map((stage,i)=>{
    const st = i < idx ? 'done' : i === idx ? 'current' : 'upcoming';
    const label = stage.charAt(0) + stage.slice(1).toLowerCase();
    return `<span class="lc-wheel-chip lc-wheel-chip-${st}"><span class="dot"></span>${escapeHtml(label)}</span>`;
  }).join('');

  return `
    <div class="lc-wheel-wrap">
      <svg viewBox="0 0 220 220" class="lc-wheel-svg" role="img" aria-label="Lifecycle stage ${idx+1} of ${total}: ${escapeHtml(currentStage)}">
        ${segments}
        <circle cx="110" cy="110" r="57" fill="var(--surface)" stroke="var(--border)"></circle>
        <text x="110" y="102" text-anchor="middle" class="lc-wheel-stage-num">STAGE ${idx+1} / ${total}</text>
        <text x="110" y="124" text-anchor="middle" class="lc-wheel-stage-label">${escapeHtml(stageDisplay)}</text>
      </svg>
      <div class="lc-wheel-legend">${legend}</div>
    </div>`;
}

const RF_ICONS = {
  client: `<rect x="-9" y="-7" width="18" height="12" rx="2"></rect><line x1="-4" y1="8" x2="4" y2="8"></line><line x1="0" y1="5" x2="0" y2="8"></line>`,
  gateway: `<path d="M0 -9l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9v-5l7-3z"></path><path d="M-3 0l2 2 4-4"></path>`,
  flow: `<path d="M2 -9-7 3h5l-1 8 9-12h-5l1-8z"></path>`,
  downstream: `<ellipse cx="0" cy="-6" rx="8" ry="3"></ellipse><path d="M-8 -6v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"></path><path d="M-8 0v6c0 1.7 3.6 3 8 3s8-1.3 8-3V0"></path>`,
  // Generic "system" node — used for any custom stage that isn't specifically
  // the client, the gateway, the flow itself, or the final downstream target
  // (e.g. an intermediate token service, object store, or a second/third
  // source or target system in a fan-in/fan-out flow).
  custom: `<rect x="-7" y="-9" width="14" height="18" rx="2.5"></rect><line x1="-7" y1="-3" x2="7" y2="-3"></line><line x1="-3.5" y1="3" x2="3.5" y2="3"></line>`,
};

// Label on a connector (stage.next / stage.back). Long text is cut with an
// ellipsis so it stays inside the gap; the full text stays in a <title> tooltip.
function rfHopLabel(text, cx, y, kind, pdf){
  if(!text) return '';
  const t = text.length > 24 ? text.slice(0,23) + '…' : text;
  const attrs = pdf
    ? `font-size="10px" font-weight="700" fill="${kind==='ret' ? '#8890a3' : '#4b5468'}"`
    : `class="rf-hop${kind==='ret' ? ' ret' : ''}"`;
  return `<text x="${cx}" y="${y}" text-anchor="middle" ${attrs}>${escapeHtml(t)}${text.length > 24 ? `<title>${escapeHtml(text)}</title>` : ''}</text>`;
}

// Whole "Request flow(s)" section body for the Overview page: title, one
// diagram per flow (each with its name + "when it runs" line when the project
// defines several), and the legend. Projects without requestFlows resolve to a
// single legacy/default flow and look exactly as before.
function requestFlowSectionInnerHtml(proj, env){
  const res = resolveRequestFlows(proj, env);
  const multi = res.flows.length > 1;
  const anyTwoWay = res.flows.some(f => f.pattern === '2-way');
  const sub = res.custom
    ? `${res.flows.length} flow${multi ? 's' : ''}, set from Edit settings`
    : `${res.flows[0].caption}, set from Edit settings`;
  const blocks = res.flows.map((f,i)=>{
    const showHead = res.custom && (multi || f.name || f.when);
    const head = showHead
      ? `<div class="rf-flow-head">${multi ? `<span class="rf-flow-num">${i+1}</span>` : ''}<span class="rf-flow-name">${escapeHtml(f.name || `Flow ${i+1}`)}</span>${f.when ? `<span class="rf-flow-when">${escapeHtml(f.when)}</span>` : ''}</div>`
      : '';
    return `<div class="rf-flow-block">${head}${requestFlowSvg(f.stages, f.pattern)}</div>`;
  }).join('');
  return `<div class="section-title">Request flow${multi ? 's' : ''} <span style="color:var(--text-faint); font-weight:500; text-transform:none;">— ${escapeHtml(sub)}</span></div>
      ${blocks}
      <div class="rf-legend">
        <span><span class="sw"></span>Request</span>
        ${anyTwoWay ? '<span><span class="sw ret"></span>Response</span>' : ''}
      </div>`;
}

// A stage's optional "token" side branch: a small box drawn above the main
// row with a connector down into the stage, for a one-hop side exchange
// (e.g. "this stage also fetches/caches a token") that doesn't need a whole
// separate flow of its own. `pdf` picks print-safe inline styling instead of
// the themed CSS classes used on-screen.
function rfTokenBranchSvg(cx, token, topPad, mainBoxTopY, pdf){
  const boxW = 132, boxH = 48, iconR = 12;
  const boxY = topPad;
  const iconCy = boxY + iconR + 7;
  const systems = Array.isArray(token.systems) ? token.systems : [];
  const icon = RF_ICONS[token.icon] || RF_ICONS.custom;
  const connX = cx, connY1 = boxY + boxH, connY2 = mainBoxTopY;
  const noteY = (connY1 + connY2) / 2;
  const rect = pdf
    ? `<rect x="${cx-boxW/2}" y="${boxY}" width="${boxW}" height="${boxH}" rx="9" fill="#ffffff" stroke="#5c7cfa" stroke-width="1.3"></rect>`
    : `<rect x="${cx-boxW/2}" y="${boxY}" width="${boxW}" height="${boxH}" rx="9" class="rf-token-rect"></rect>`;
  const ring = pdf
    ? `<circle cx="${cx}" cy="${iconCy}" r="${iconR}" fill="#f6f8fb" stroke="#c7ccd8" stroke-width="1.1"></circle>
       <g transform="translate(${cx},${iconCy})" stroke="#4b5468" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round">${icon}</g>`
    : `<circle cx="${cx}" cy="${iconCy}" r="${iconR}" class="rf-icon-ring"></circle>
       <g transform="translate(${cx},${iconCy})" class="rf-icon">${icon}</g>`;
  const kLabel = pdf
    ? `<text x="${cx}" y="${iconCy+iconR+9}" text-anchor="middle" font-size="7.5px" letter-spacing=".5px" font-weight="700" fill="#8890a3">${escapeHtml(String(token.k||'TOKEN').toUpperCase())}</text>`
    : `<text x="${cx}" y="${iconCy+iconR+9}" text-anchor="middle" class="rf-token-k">${escapeHtml(String(token.k||'TOKEN').toUpperCase())}</text>`;
  const valueLine = systems.length
    ? (pdf
      ? `<text x="${cx}" y="${boxY+boxH-6}" text-anchor="middle" font-size="10px" font-weight="700" fill="#0f1420">${escapeHtml(systems[0])}</text>`
      : `<text x="${cx}" y="${boxY+boxH-6}" text-anchor="middle" class="rf-box-v" style="font-size:10px;">${escapeHtml(systems[0])}</text>`)
    : '';
  const line = pdf
    ? `<line x1="${connX}" y1="${connY1}" x2="${connX}" y2="${connY2-8}" stroke="#5c7cfa" stroke-width="1.4" opacity="0.55"></line>`
    : `<line x1="${connX}" y1="${connY1}" x2="${connX}" y2="${connY2-8}" class="rf-line"></line>`;
  const head = pdf
    ? `<polygon points="${connX-4},${connY2-8} ${connX+4},${connY2-8} ${connX},${connY2}" fill="#5c7cfa" opacity="0.7"></polygon>`
    : `<polygon points="${connX-4},${connY2-8} ${connX+4},${connY2-8} ${connX},${connY2}" class="rf-arrowhead"></polygon>`;
  const note = rfHopLabel(token.note, connX - boxW/2 - 6, noteY - 4, 'fwd', pdf)
    .replace('text-anchor="middle"', 'text-anchor="end"');
  return `<g class="rf-token">${rect}${ring}${kLabel}${valueLine}${line}${head}${note}</g>`;
}

function requestFlowSvg(stages, direction){
  // stages: [{k, systems:[...], icon, mid, token}, ...] left-to-right. `systems`
  // is ALWAYS an array now — a stage with more than one entry (e.g. two source
  // systems feeding the same gateway, or two downstream targets) renders
  // them stacked as separate lines in the same box rather than needing a
  // separate box per system, which keeps the diagram a simple straight
  // chain regardless of how many systems sit at any one stage. `token` is an
  // optional side branch (see rfTokenBranchSvg) — a small box drawn above the
  // stage for a one-hop side exchange that doesn't need a whole separate flow.
  // direction: '1-way' (forward arrows only) or '2-way' (forward + return arrows).
  const n = stages.length;
  // Arrow labels (stage.next / stage.back) need room to sit above/below the
  // connector, so the gap between boxes widens when any hop is labelled.
  const hasHops = stages.slice(0,-1).some(s => s.next || (direction==='2-way' && s.back));
  const boxW = 152, gap = hasHops ? 150 : 68, padX = 22;
  const iconR = 16;
  const hasTokens = stages.some(s => s.token);
  const tokenBoxH = 48, tokenConnLen = 20, tokenTopPad = 8;
  const topPad = hasTokens ? (tokenTopPad + tokenBoxH + tokenConnLen) : 8;
  const iconCy = topPad + iconR;
  const boxY = iconCy + iconR + 12;
  const baseBoxH = 62, lineH = 15, maxShown = 3;
  const normalized = stages.map(s=>{
    const systems = (Array.isArray(s.systems) && s.systems.length) ? s.systems : ['—'];
    const shown = systems.slice(0, maxShown);
    const extraCount = systems.length - shown.length;
    const h = baseBoxH + Math.max(0, shown.length - 1) * lineH;
    return { ...s, systems, shown, extraCount, boxH: h };
  });
  const maxBoxH = Math.max(baseBoxH, ...normalized.map(s=>s.boxH));
  const totalW = padX*2 + n*boxW + (n-1)*gap;
  const totalH = boxY + maxBoxH + (direction==='2-way' ? 30 : 16);
  // Connectors always sit at the single-line reference height, regardless of
  // how tall any individual box grows — keeps the arrow row straight even
  // when adjacent stages have different numbers of systems.
  const midY = boxY + baseBoxH/2;

  const boxes = normalized.map((s,i)=>{
    const x = padX + i*(boxW+gap);
    const cx = x + boxW/2;
    const mid = !!s.mid;
    const icon = RF_ICONS[s.icon] || RF_ICONS.custom;
    const valueLines = s.shown.map((sys,li)=>
      `<text x="${cx}" y="${boxY+42+li*lineH}" text-anchor="middle" class="rf-box-v">${escapeHtml(sys)}</text>`
    ).join('') + (s.extraCount>0
      ? `<text x="${cx}" y="${boxY+42+s.shown.length*lineH}" text-anchor="middle" class="rf-box-v rf-box-more">+${s.extraCount} more</text>`
      : '');
    const fullList = s.systems.join(', ');
    const tokenBranch = s.token ? rfTokenBranchSvg(cx, s.token, tokenTopPad, boxY, false) : '';
    return `<g class="rf-box${mid?' rf-box-mid':''}">
      <circle cx="${cx}" cy="${iconCy}" r="${iconR+7}" class="rf-icon-glow${mid?' mid-glow':''}"></circle>
      <rect x="${x}" y="${boxY}" width="${boxW}" height="${s.boxH}" rx="10" class="rf-box-rect${mid?' mid':''}"></rect>
      <circle cx="${cx}" cy="${iconCy}" r="${iconR}" class="rf-icon-ring${mid?' mid-ring':''}"></circle>
      <g transform="translate(${cx},${iconCy})" class="rf-icon${mid?' mid-icon':''}">${icon}</g>
      <text x="${cx}" y="${boxY+22}" text-anchor="middle" class="rf-box-k${mid?' mid-k':''}">${escapeHtml(String(s.k).toUpperCase())}</text>
      ${valueLines}
      ${(s.systems.length > 1) ? `<title>${escapeHtml(fullList)}</title>` : ''}
      ${tokenBranch}
    </g>`;
  }).join('');

  const connectors = stages.slice(0,-1).map((s,i)=>{
    const x1 = padX + i*(boxW+gap) + boxW;
    const x2 = x1 + gap;
    const fwdY = direction==='2-way' ? midY - 9 : midY;
    const retY = midY + 11;
    const delay = (i*0.35).toFixed(2);
    let out = `<line x1="${x1}" y1="${fwdY}" x2="${x2-9}" y2="${fwdY}" class="rf-line"></line>
      <polygon points="${x2-9},${fwdY-4} ${x2-9},${fwdY+4} ${x2},${fwdY}" class="rf-arrowhead"></polygon>
      <circle r="3" class="rf-flow-dot">
        <animateMotion dur="2s" begin="${delay}s" repeatCount="indefinite" path="M${x1},${fwdY} L${x2-9},${fwdY}"></animateMotion>
      </circle>` + rfHopLabel(s.next, (x1+x2)/2, fwdY-7, 'fwd', false);
    if(direction==='2-way'){
      out += `<line x1="${x2-9}" y1="${retY}" x2="${x1}" y2="${retY}" class="rf-line rf-line-return"></line>
      <polygon points="${x1+9},${retY-4} ${x1+9},${retY+4} ${x1},${retY}" class="rf-arrowhead-return"></polygon>
      <circle r="2.6" class="rf-flow-dot-ret">
        <animateMotion dur="2.2s" begin="${delay}s" repeatCount="indefinite" path="M${x2-9},${retY} L${x1+9},${retY}"></animateMotion>
      </circle>` + rfHopLabel(s.back, (x1+x2)/2, retY+15, 'ret', false);
    }
    return out;
  }).join('');

  return `<div class="rf-svg-wrap">
    <svg viewBox="0 0 ${totalW} ${totalH}" class="rf-svg" preserveAspectRatio="xMinYMid meet" role="img" aria-label="Request flow diagram, ${direction === '2-way' ? 'two-way' : 'one-way'}">
      ${connectors}
      ${boxes}
    </svg>
  </div>`;
}

// Breaking-changes-per-release sparkline for the Overview page (Release
// Pipeline v2 — turns severity tagging that's otherwise only visible mid-
// promotion into an at-a-glance release-health signal). One bar per release
// that reached the pipeline's last stage, oldest to newest, bar height by
// breaking-change count so a run of clean releases is visually obvious
// against a stretch of churn.
function releaseHealthSparklineSvg(points){
  const n = points.length;
  const barW = 20, gap = 10, padX = 4, chartH = 46, padTop = 6;
  const totalW = padX*2 + n*barW + (n-1)*gap;
  const totalH = chartH + padTop + 14;
  const maxCount = Math.max(1, ...points.map(p=>p.breakingChangesCount));
  const bars = points.map((p,i)=>{
    const x = padX + i*(barW+gap);
    const h = p.breakingChangesCount === 0 ? 4 : Math.max(6, Math.round((p.breakingChangesCount / maxCount) * chartH));
    const y = padTop + (chartH - h);
    const color = p.breakingChangesCount === 0 ? 'var(--get)' : (p.breakingChangesCount >= 3 ? 'var(--danger)' : 'var(--patch)');
    const title = `${escapeHtml(p.versionLabel)} — ${p.breakingChangesCount} breaking change${p.breakingChangesCount===1?'':'s'}`;
    return `<g>
      <title>${title}</title>
      <rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="3" fill="${color}" opacity="${p.breakingChangesCount===0 ? 0.55 : 0.92}"></rect>
      <text x="${x+barW/2}" y="${totalH-2}" text-anchor="middle" font-size="8" fill="var(--text-faint)">${escapeHtml(p.versionLabel.split('.').pop())}</text>
    </g>`;
  }).join('');
  return `<svg viewBox="0 0 ${totalW} ${totalH}" width="${totalW}" height="${totalH}" role="img" aria-label="Breaking changes per release">${bars}</svg>`;
}

// ---------- Print-safe variants for PDF export ----------
// The on-screen versions above (lifecycleWheelSvg, requestFlowSvg) color themselves with
// CSS custom properties (var(--accent), var(--surface-2), etc.) that resolve against the
// app's current theme. That's fine live, but the PDF is always rendered on a fixed white
// page — reusing the themed versions meant colors could vanish or invert depending on
// light/dark mode. These two build the same diagrams with fixed, print-safe hex colors
// matching the rest of the PDF's palette, so the Lifecycle and Request flow sections
// actually show up in exported PDFs.
function pdfLifecycleBadgeStyle(stage){
  const s = (stage||'').toUpperCase();
  if(s==='DEVELOPMENT') return 'background:rgba(79,163,247,.14);color:#2f7fd1;';
  if(s==='SIT' || s==='UAT') return 'background:rgba(224,168,62,.14);color:#b1791f;';
  if(s==='PRE-PROD') return 'background:rgba(179,137,240,.14);color:#7a53c9;';
  if(s==='PRODUCTION') return 'background:rgba(53,196,145,.14);color:#1f9d6f;';
  if(s==='DEPRECATED') return 'background:rgba(239,92,110,.14);color:#c73b4d;';
  return 'background:#eef1f6;color:#8890a3;'; // DRAFT, DESIGN, RETIRED
}

function pdfLifecycleWheelSvg(currentStage){
  const idx = LIFECYCLE_STAGES.indexOf(currentStage);
  const total = LIFECYCLE_STAGES.length;
  const cx = 90, cy = 90, rOuter = 76, rInner = 50, gapDeg = 3;
  const segAngle = 360 / total;
  const toRad = deg => (deg - 90) * Math.PI / 180;
  const polar = (r, deg) => { const rad = toRad(deg); return [cx + r*Math.cos(rad), cy + r*Math.sin(rad)]; };
  const segPath = (startDeg, endDeg, r1, r2) => {
    const [x1,y1] = polar(r2, startDeg), [x2,y2] = polar(r2, endDeg);
    const [x3,y3] = polar(r1, endDeg), [x4,y4] = polar(r1, startDeg);
    const large = (endDeg - startDeg) > 180 ? 1 : 0;
    return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r2} ${r2} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} L ${x3.toFixed(2)} ${y3.toFixed(2)} A ${r1} ${r1} 0 ${large} 0 ${x4.toFixed(2)} ${y4.toFixed(2)} Z`;
  };

  const segments = LIFECYCLE_STAGES.map((stage,i)=>{
    const start = i*segAngle + gapDeg/2, end = (i+1)*segAngle - gapDeg/2;
    const st = i < idx ? 'done' : i === idx ? 'current' : 'upcoming';
    const fill = st==='done' ? '#1f9d6f' : st==='current' ? '#5c7cfa' : '#eef1f6';
    const opacity = st==='upcoming' ? '0.8' : '1';
    return `<path d="${segPath(start,end,rInner,rOuter)}" fill="${fill}" opacity="${opacity}"><title>${escapeHtml(stage)}${st==='current'?' — current stage':st==='done'?' — completed':' — upcoming'}</title></path>`;
  }).join('');

  const stageDisplay = currentStage.charAt(0) + currentStage.slice(1).toLowerCase();

  const legend = LIFECYCLE_STAGES.map((stage,i)=>{
    const st = i < idx ? 'done' : i === idx ? 'current' : 'upcoming';
    const label = stage.charAt(0) + stage.slice(1).toLowerCase();
    const c = st==='done' ? {bg:'rgba(53,196,145,.14)', fg:'#1f9d6f'} : st==='current' ? {bg:'rgba(92,124,250,.16)', fg:'#5c7cfa'} : {bg:'#eef1f6', fg:'#8890a3'};
    return `<span class="pdf-lc-legend-chip" style="background:${c.bg};color:${c.fg};"><span class="dot" style="background:${c.fg};"></span>${escapeHtml(label)}</span>`;
  }).join('');

  return `
    <div class="pdf-lc-wheel-wrap">
      <svg viewBox="0 0 180 180" class="pdf-lc-wheel-svg" role="img" aria-label="Lifecycle stage ${idx+1} of ${total}: ${escapeHtml(currentStage)}">
        ${segments}
        <circle cx="90" cy="90" r="47" fill="#ffffff" stroke="#e2e6ee"></circle>
        <text x="90" y="84" text-anchor="middle" font-family="var(--mono)" font-size="9px" letter-spacing=".4px" font-weight="700" fill="#8890a3">STAGE ${idx+1} / ${total}</text>
        <text x="90" y="103" text-anchor="middle" font-size="13px" font-weight="800" fill="#0f1420">${escapeHtml(stageDisplay)}</text>
      </svg>
      <div class="pdf-lc-legend">${legend}</div>
    </div>`;
}

// PDF counterpart of requestFlowSectionInnerHtml (print-safe colors).
function pdfRequestFlowSectionInnerHtml(proj, env){
  const res = resolveRequestFlows(proj, env);
  const multi = res.flows.length > 1;
  const anyTwoWay = res.flows.some(f => f.pattern === '2-way');
  const sub = res.custom ? `${res.flows.length} flow${multi ? 's' : ''}` : res.flows[0].caption;
  const blocks = res.flows.map((f,i)=>{
    const showHead = res.custom && (multi || f.name || f.when);
    const head = showHead
      ? `<div class="pdf-rf-flow-head">${multi ? `<span class="pdf-rf-flow-num">${i+1}</span>` : ''}<span class="pdf-rf-flow-name">${escapeHtml(f.name || `Flow ${i+1}`)}</span>${f.when ? `<span class="pdf-rf-flow-when">${escapeHtml(f.when)}</span>` : ''}</div>`
      : '';
    return `${head}${pdfRequestFlowSvg(f.stages, f.pattern)}`;
  }).join('');
  return `<div class="pdf-section-title">Request flow${multi ? 's' : ''} <span style="text-transform:none; letter-spacing:0; font-weight:500; color:#8890a3;">— ${escapeHtml(sub)}</span></div>
      ${blocks}
      <div class="pdf-rf-legend">
        <span><span class="sw"></span>Request</span>
        ${anyTwoWay ? '<span><span class="sw ret"></span>Response</span>' : ''}
      </div>`;
}

function pdfRequestFlowSvg(stages, direction){
  const n = stages.length;
  // Arrow labels (stage.next / stage.back) need room to sit above/below the
  // connector, so the gap between boxes widens when any hop is labelled.
  const hasHops = stages.slice(0,-1).some(s => s.next || (direction==='2-way' && s.back));
  const boxW = 152, gap = hasHops ? 150 : 68, padX = 22;
  const iconR = 16;
  const hasTokens = stages.some(s => s.token);
  const tokenBoxH = 48, tokenConnLen = 20, tokenTopPad = 8;
  const topPad = hasTokens ? (tokenTopPad + tokenBoxH + tokenConnLen) : 8;
  const iconCy = topPad + iconR;
  const boxY = iconCy + iconR + 12;
  const baseBoxH = 62, lineH = 15, maxShown = 3;
  const accent = '#5c7cfa';
  const normalized = stages.map(s=>{
    const systems = (Array.isArray(s.systems) && s.systems.length) ? s.systems : ['—'];
    const shown = systems.slice(0, maxShown);
    const extraCount = systems.length - shown.length;
    const h = baseBoxH + Math.max(0, shown.length - 1) * lineH;
    return { ...s, systems, shown, extraCount, boxH: h };
  });
  const maxBoxH = Math.max(baseBoxH, ...normalized.map(s=>s.boxH));
  const totalW = padX*2 + n*boxW + (n-1)*gap;
  const totalH = boxY + maxBoxH + (direction==='2-way' ? 30 : 16);
  const midY = boxY + baseBoxH/2;

  const boxes = normalized.map((s,i)=>{
    const x = padX + i*(boxW+gap);
    const cx = x + boxW/2;
    const mid = !!s.mid;
    const icon = RF_ICONS[s.icon] || RF_ICONS.custom;
    const valueLines = s.shown.map((sys,li)=>
      `<text x="${cx}" y="${boxY+42+li*lineH}" text-anchor="middle" font-size="12px" font-weight="700" fill="#0f1420">${escapeHtml(sys)}</text>`
    ).join('') + (s.extraCount>0
      ? `<text x="${cx}" y="${boxY+42+s.shown.length*lineH}" text-anchor="middle" font-size="10.5px" font-weight="600" fill="#8890a3">+${s.extraCount} more</text>`
      : '');
    const tokenBranch = s.token ? rfTokenBranchSvg(cx, s.token, tokenTopPad, boxY, true) : '';
    return `<g>
      <circle cx="${cx}" cy="${iconCy}" r="${iconR+7}" fill="${mid?'rgba(92,124,250,.14)':'#eef1f6'}"></circle>
      <rect x="${x}" y="${boxY}" width="${boxW}" height="${s.boxH}" rx="10" fill="#ffffff" stroke="${mid?accent:'#e2e6ee'}" stroke-width="${mid?1.6:1.2}"></rect>
      <circle cx="${cx}" cy="${iconCy}" r="${iconR}" fill="#f6f8fb" stroke="${mid?accent:'#c7ccd8'}" stroke-width="1.2"></circle>
      <g transform="translate(${cx},${iconCy})" stroke="${mid?accent:'#4b5468'}" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round">${icon}</g>
      <text x="${cx}" y="${boxY+22}" text-anchor="middle" font-size="8.5px" letter-spacing=".6px" font-weight="700" fill="${mid?accent:'#8890a3'}">${escapeHtml(String(s.k).toUpperCase())}</text>
      ${valueLines}
      ${tokenBranch}
    </g>`;
  }).join('');

  const connectors = stages.slice(0,-1).map((s,i)=>{
    const x1 = padX + i*(boxW+gap) + boxW;
    const x2 = x1 + gap;
    const fwdY = direction==='2-way' ? midY - 9 : midY;
    const retY = midY + 11;
    let out = `<line x1="${x1}" y1="${fwdY}" x2="${x2-9}" y2="${fwdY}" stroke="${accent}" stroke-width="1.5" opacity="0.6"></line>
      <polygon points="${x2-9},${fwdY-4} ${x2-9},${fwdY+4} ${x2},${fwdY}" fill="${accent}" opacity="0.8"></polygon>` + rfHopLabel(s.next, (x1+x2)/2, fwdY-7, 'fwd', true);
    if(direction==='2-way'){
      out += `<line x1="${x2-9}" y1="${retY}" x2="${x1}" y2="${retY}" stroke="#8890a3" stroke-dasharray="3 3" stroke-width="1.5" opacity="0.7"></line>
      <polygon points="${x1+9},${retY-4} ${x1+9},${retY+4} ${x1},${retY}" fill="#8890a3" opacity="0.8"></polygon>` + rfHopLabel(s.back, (x1+x2)/2, retY+15, 'ret', true);
    }
    return out;
  }).join('');

  return `<div class="pdf-rf-svg-wrap">
    <svg viewBox="0 0 ${totalW} ${totalH}" class="pdf-rf-svg" style="width:${Math.min(100, (totalW/856)*100).toFixed(1)}%" preserveAspectRatio="xMinYMid meet" role="img" aria-label="Request flow diagram, ${direction === '2-way' ? 'two-way' : 'one-way'}">
      ${connectors}
      ${boxes}
    </svg>
  </div>`;
}

function docScoreBarHtml(percent, size){
  const color = percent >= 80 ? 'var(--post)' : percent >= 50 ? 'var(--put)' : 'var(--delete)';
  return `<div class="doc-score-bar${size==='sm'?' sm':''}">
    <div class="doc-score-fill" style="width:${percent}%;background:${color};"></div>
  </div>`;
}
