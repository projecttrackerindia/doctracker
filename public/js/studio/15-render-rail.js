/* ==================== SECTION:RENDER-RAIL ==================== */
function renderRail(){
  const inner = document.getElementById('railInner');

  if(!state.selected || state.selected.type !== 'endpoint'){
    inner.innerHTML = `
      <div class="rail-title">Code samples</div>
      <div class="rail-note">Select an endpoint to see a live request URL and ready-to-run code samples for the ${escapeHtml(envMeta(state.env).label)} environment.</div>`;
    return;
  }

  const found = findEndpointForView(state.selected.id);
  if(!found){ inner.innerHTML = ''; return; }
  const { proj, ep } = found;
  const hasBaseUrl = !!proj.environments[state.env];
  const revealed = sensitiveRevealed();
  if(!LANGS.some(l=>l.id===state.codeLang)) state.codeLang = 'curl';

  inner.innerHTML = `
    <div class="rail-title">Code samples — ${escapeHtml(envMeta(state.env).label)}</div>
    <div class="lang-tabs">
      ${LANGS.map(l=>`<div class="lang-tab ${state.codeLang===l.id?'active':''}" data-lang="${l.id}">${l.label}</div>`).join('')}
    </div>
    <div class="rail-url">
      <span class="m">${ep.method}</span>
      <span class="u" title="${escapeHtml(maskedFullUrl(proj, ep))}">${escapeHtml(displayUrl(proj, ep))}</span>
      <button type="button" class="icon-btn rail-reveal-btn${canRevealSensitive()?'':' locked'}" id="railRevealBtn" title="${canRevealSensitive() ? (revealed?'Hide real host & secret values':'Reveal real host & secret values') : 'Only the Admin role can reveal sensitive values'}">${canRevealSensitive() ? (revealed?ICON_EYE_OFF:ICON_EYE) : ICON_LOCK}</button>
    </div>
    <div class="code-wrap">
      <pre class="code-block" id="railCode">${escapeHtml(codeSample(state.codeLang, proj, ep))}</pre>
      <button class="copy-btn" id="railCopy">Copy</button>
    </div>
    ${!hasBaseUrl ? `<div class="rail-note">No base URL set for ${escapeHtml(envMeta(state.env).label)} yet. Add one in project settings to get a real request URL.</div>` : ''}
    ${proj.auth && proj.auth.type ? `<div class="rail-note">Requires ${escapeHtml(proj.auth.type)}${proj.auth.headerName ? ' via the '+escapeHtml(proj.auth.headerName)+' header' : ''}.${proj.auth.path ? ` Obtain via <span class="badge ${methodClass(proj.auth.method||'POST')}" style="margin:0 4px;">${escapeHtml(proj.auth.method||'POST')}</span><span class="mono" style="font-size:11px;">${escapeHtml(proj.auth.path)}</span>` : ''}</div>` : ''}
    <div class="rail-note">The host and secret header values shown here are masked${canRevealSensitive() ? ' — use the eye icon above to reveal them' : '; only the Admin role can reveal them'}.</div>
  `;

  inner.querySelectorAll('[data-lang]').forEach(el=>{
    el.addEventListener('click', ()=>{
      state.codeLang = el.getAttribute('data-lang');
      renderRail();
    });
  });
  document.getElementById('railRevealBtn').addEventListener('click', ()=> toggleSensitiveRevealed());
  document.getElementById('railCopy').addEventListener('click', (e)=>{
    copyToClipboard(codeSample(state.codeLang, proj, ep), e.currentTarget);
  });
}
