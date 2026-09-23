/* ==================== SECTION:OBSERVABILITY ==================== */
// Traffic auto-discovered from server logs by ops/sit-doc-agent - hit counts,
// status breakdown, error rate, and source IPs, keyed by "METHOD /path" in
// state.endpointMetrics (org-shared, see loadState() in 06-spec-parse.js).
// Deliberately NOT written into any project's own endpoint data (see the
// server/db.js comment on org_workspace.endpoint_metrics_enc) - this page is
// the only place it's shown, cross-referenced against real endpoints purely
// by matching method+path text, never by mutating a project's stored JSON.

// Finds the first real, documented endpoint (across every project this
// viewer can see) whose method+path matches a metrics key, so a row can link
// straight to its documentation. Returns null if nothing matches yet - the
// agent may have discovered traffic for an endpoint nobody's documented.
function findDocumentedEndpointForMetricsKey(key){
  const spaceIdx = key.indexOf(' ');
  if(spaceIdx < 0) return null;
  const method = key.slice(0, spaceIdx).toUpperCase();
  const path = key.slice(spaceIdx + 1);
  for(const proj of Object.values(state.projects || {})){
    const ep = (proj.endpoints || []).find(e => e && (e.method||'').toUpperCase() === method && (e.path||'') === path);
    if(ep) return { proj, ep };
  }
  return null;
}

function errorRateColor(rate){
  if(rate >= 0.25) return 'var(--delete)';
  if(rate >= 0.05) return 'var(--put)';
  return 'var(--post)';
}

function renderObservability(main){
  const metrics = state.endpointMetrics || {};
  const keys = Object.keys(metrics).sort();

  const rows = keys.length ? keys.map(key=>{
    const m = metrics[key] || {};
    const total = m.totalRequests || 0;
    const rate = typeof m.errorRate === 'number' ? m.errorRate : 0;
    const breakdown = m.statusBreakdown || {};
    const breakdownLabel = Object.keys(breakdown).sort().map(fam=>`${fam}: ${breakdown[fam]}`).join(', ') || '—';
    const topIps = Array.isArray(m.topSourceIps) ? m.topSourceIps.slice(0, 3) : [];
    const ipsLabel = topIps.length ? topIps.map(x=>`${escapeHtml(x.ip)} (${x.count})`).join(', ') : '—';
    const found = findDocumentedEndpointForMetricsKey(key);
    const [method, ...pathParts] = key.split(' ');
    const path = pathParts.join(' ');
    const linkAttr = found ? ` data-obs-ep="${found.ep.id}"` : '';
    return `<tr class="cc-proj-row"${linkAttr} style="${found?'':'cursor:default;'}">
      <td><span class="badge badge-lg ${methodClass(method)}">${escapeHtml(method||'')}</span></td>
      <td class="mono">${escapeHtml(path)}</td>
      <td class="mono">${total}</td>
      <td style="color:${errorRateColor(rate)};font-weight:600;">${(rate*100).toFixed(1)}%</td>
      <td class="mono" style="font-size:11px;color:var(--text-faint);">${escapeHtml(breakdownLabel)}</td>
      <td class="mono" style="font-size:11px;color:var(--text-faint);">${ipsLabel}</td>
      <td class="mono" style="font-size:10.5px;color:var(--text-faint);">${m.lastSeenAt ? formatDateTime(m.lastSeenAt) : '—'}</td>
      <td>${found ? '<span style="color:var(--post);">Documented</span>' : '<span class="empty-field">Not yet documented</span>'}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="8" class="empty-field" style="padding:16px;">No traffic discovered yet. This fills in once the SIT log auto-discovery agent (ops/sit-doc-agent) has pushed at least one batch — see AGENT_README.md.</td></tr>`;

  main.innerHTML = `
    <div class="crumb">Observability</div>
    <div class="ctrl-hero" style="--ctrl-glow-bg:var(--accent-soft);">
      <div class="ctrl-hero-icon" style="--ctrl-icon-color:var(--accent);--ctrl-icon-bg:var(--accent-soft);">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 17 9 11 13 15 21 6"></polyline><polyline points="15 6 21 6 21 12"></polyline></svg>
      </div>
      <div class="ctrl-hero-copy">
        <h1>Real traffic, straight from server logs</h1>
        <p>Hit counts, status breakdown, error rate, and source IPs auto-discovered by the SIT log agent — never written into your documented endpoints, only shown here, cross-referenced by method + path. Field <em>values</em> from requests are never captured by the agent, only counts and structure.</p>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Endpoints seen in traffic</div>
      <div class="table-scroll">
      <table class="data-table cc-proj-table">
        <thead><tr>
          <th>Method</th><th>Path</th><th>Total requests</th><th>Error rate</th>
          <th>Status breakdown</th><th>Top source IPs</th><th>Last seen</th><th>Documentation</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      </div>
    </div>
  `;

  main.querySelectorAll('[data-obs-ep]').forEach(row=>{
    row.style.cursor = 'pointer';
    row.addEventListener('click', ()=>{
      const epId = row.getAttribute('data-obs-ep');
      state.selected = { type:'endpoint', id: epId };
      renderMain();
    });
  });
}
