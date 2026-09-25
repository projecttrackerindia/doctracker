/* ==================== SECTION:RENDER-CHROME ==================== */
function applyTheme(){
  document.documentElement.setAttribute('data-theme', state.theme);
  document.getElementById('btnTheme').textContent = state.theme === 'dark' ? '◐' : '◑';
  document.getElementById('btnTheme').title = state.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
}

function applyEnvAccent(){
  const root = document.documentElement;
  const accentVal = envAccentColor(state.env);
  const bgVal = envBgColor(state.env);
  root.style.setProperty('--env-accent', accentVal);
  root.style.setProperty('--env-accent-bg', bgVal);
  document.getElementById('envRail').style.background =
    `linear-gradient(90deg, ${accentVal}, transparent 160%)`;
}

// The env switcher lives in the topbar and is global (it doesn't belong to any one
// project) but when the person is currently looking at a project's overview or one of
// its endpoints, we can still show that project's per-environment base URL inline in the
// dropdown — makes the switcher actually show environment *values*, not just labels.
function currentProjectForEnvContext(){
  if(!state.selected) return null;
  if(state.selected.type === 'overview') return state.projects[state.selected.projectId] || null;
  if(state.selected.type === 'endpoint'){
    const found = findEndpoint(state.selected.id);
    return found ? found.proj : null;
  }
  return null;
}

// Makes the FAB's own label say what a click will actually do on THIS page,
// instead of always reading "New endpoint" regardless of context. On a
// project overview or endpoint page there's a project to disambiguate
// against, so it reads "New endpoint" and opens the small menu (add here /
// start a new project instead). Everywhere else — API Control Center,
// Security, Error catalog, Profile — there's no project in view, a click
// goes straight to a blank project (see the FAB click handler below), so the
// label reads "New project" instead of promising something it won't do.
function updateFabIntent(ctxProj){
  const btn = document.getElementById('btnFab');
  const label = btn && btn.querySelector('.fab-label');
  if(!btn || !label) return;
  if(ctxProj){
    label.textContent = 'New endpoint';
    btn.title = `New endpoint in ${ctxProj.name}`;
    btn.setAttribute('aria-haspopup', 'true');
  } else {
    label.textContent = 'New project';
    btn.title = 'New project — starts blank';
    btn.setAttribute('aria-haspopup', 'false');
  }
}

function renderEnvSwitcher(){
  const el = document.getElementById('envSwitcher');
  const current = envMeta(state.env);
  const ctxProj = currentProjectForEnvContext();
  updateFabIntent(ctxProj);
  el.innerHTML = `
    <div class="env-dd" id="envDD">
      <button type="button" class="env-dd-btn" id="envDDBtn" aria-haspopup="listbox" aria-expanded="false" aria-controls="envDDPanel" title="Switch environment">
        <span class="env-dd-dot"></span>
        <span class="env-dd-label">${escapeHtml(current.label)}</span>
        <span class="env-dd-chev">▾</span>
      </button>
      <div class="env-dd-panel" id="envDDPanel" role="listbox" aria-label="Environment" tabindex="-1">
        ${environments().map(e=>{
          // The environment's actual base URL is sensitive and is intentionally never printed
          // in this switcher — only the env variable token (e.g. "{{SIT-DNS}}") is shown, with
          // a masked hint on hover. The real value only ever appears in Profile ▸ Environments,
          // and only for the Admin role after an explicit reveal.
          const url = ctxProj ? ctxProj.environments[e.id] : '';
          const locked = !roleAllowsEnv(e.id);
          const hoverHint = locked
            ? (e.restricted
                ? `${e.label} is restricted to Admins`
                : `An Admin hasn't granted you access to ${e.label} yet (Security ▸ Live Mode Access)`)
            : (url ? `Endpoint: ${maskEndpointUrl(url)}` : '');
          return `
          <div class="env-dd-opt${e.id===state.env?' sel':''}${locked?' locked':''}" role="option" aria-selected="${e.id===state.env}" aria-disabled="${locked}" data-env="${e.id}"
               title="${escapeHtml(hoverHint)}"
               style="--opt-accent:${envAccentColor(e.id)};--opt-accent-bg:${envBgColor(e.id)};${locked?'opacity:.45;cursor:not-allowed;':''}">
            <span class="env-dd-opt-dot"></span>
            <span class="env-dd-opt-main">
              <span class="env-dd-opt-label">${escapeHtml(e.label)}</span>
              ${url ? `<span class="env-dd-opt-url">${escapeHtml(envVarToken(e.id))}</span>` : ''}
            </span>
            ${locked ? '<span class="env-dd-check" title="Restricted by role">🔒</span>' : (e.id===state.env?'<span class="env-dd-check">✓</span>':'')}
          </div>`;
        }).join('')}
      </div>
    </div>`;
}

function closeEnvDropdown(){
  const dd = document.getElementById('envDD');
  if(!dd) return;
  dd.classList.remove('open');
  const btn = document.getElementById('envDDBtn');
  if(btn) btn.setAttribute('aria-expanded','false');
}
function openEnvDropdown(){
  const dd = document.getElementById('envDD');
  if(!dd) return;
  dd.classList.add('open');
  const btn = document.getElementById('envDDBtn');
  if(btn) btn.setAttribute('aria-expanded','true');
  dd.querySelectorAll('.env-dd-opt').forEach(o=>o.classList.remove('kbd-focus'));
  const sel = dd.querySelector('.env-dd-opt.sel') || dd.querySelector('.env-dd-opt');
  if(sel) sel.classList.add('kbd-focus');
}
function selectEnvironment(envId){
  if(!envIds().includes(envId)) return;
  if(!roleAllowsEnv(envId)){
    const meta = envMeta(envId);
    toast(meta.restricted ? `${meta.label} is restricted to Admins` : `An Admin hasn't granted you access to ${meta.label} yet`);
    return;
  }
  state.env = envId;
  saveEnv();
  applyEnvAccent();
  applyRoleGatedUI();
  renderEnvSwitcher();
  // Alerts are fetched once, lazily, on first visit to the tab and then
  // cached for the rest of the session (see wireObsAlerts) — correct within
  // one environment, but without this reset a switch would keep showing the
  // PREVIOUS environment's alert rules and active alerts under the new
  // environment's badge indefinitely, not just until the next fetch resolves.
  state.obsAlerts = null;
  state.obsAlertsStatus = 'idle';
  state.obsAlertHistory = null;
  state.obsAlertHistoryStatus = 'idle';
  state.obsAlertHistoryOldestId = null;
  // renderSidebar() was missing here, so the endpoint tree kept showing
  // whichever environment was rendered last (e.g. SIT's promoted endpoints)
  // until something else happened to trigger a full renderAll() — like a
  // manual page reload. renderSidebar() calls viewEndpoints() per project,
  // which is already environment-aware (draft vs. snapshotEntry(proj.id) for
  // state.env), so calling it here is enough to make the switch immediate:
  // it shows "Loading…" / "Nothing promoted" right away instead of stale
  // endpoints from the previous environment, then fills in once the new
  // environment's snapshot resolves.
  renderSidebar();
  renderMain();
  renderRail();
  // Observability is now scoped by this switcher alone — it used to carry a
  // second environment dropdown of its own, which could disagree with the
  // header. Its panels are server queries, so switching here has to re-ask for
  // the new environment's data rather than just repaint the old answer.
  if(state.selected && state.selected.type === 'observability' && typeof obsLoad === 'function'){
    state.obsRecords = null;
    state.obsRecordsPage = 1;
    // NOT { quiet: true } — quiet exists so the live-stream auto-refresh
    // doesn't flicker while re-asking about the SAME environment. This is an
    // environment CHANGE: obsLoad's own (non-quiet) loading-state render
    // happens synchronously, in the same tick as the renderMain() above, so
    // it's what the browser actually paints — the previous environment's
    // numbers are never shown under the new badge, not even briefly.
    obsLoad();
    if(state.obsTab === 'logs' && typeof obsLoadRecordsPage === 'function') obsLoadRecordsPage();
  }
}

function renderAll(){
  applyTheme();
  applyEnvAccent();
  applySidebarCollapsed();
  renderAuthorLabel();
  renderEnvSwitcher();
  renderSidebar();
  renderMain();
  renderRail();
}
