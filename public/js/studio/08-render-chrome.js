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

// renderEnvSwitcher()/openEnvDropdown()/closeEnvDropdown()/selectEnvironment()
// used to live here (the topbar environment switcher). Removed as part of
// the environment-collapse cluster: there is now exactly one implicit
// environment, so there's nothing left to switch between. The FAB-label
// side effect renderEnvSwitcher() used to carry (updateFabIntent) now runs
// from renderMain() instead (see 11-render-main.js).

function renderAll(){
  applyTheme();
  applyEnvAccent();
  applySidebarCollapsed();
  renderAuthorLabel();
  renderSidebar();
  renderMain();
  renderRail();
}
