/* ==================== SECTION:INIT ==================== */
(async function boot(){
  await loadState();
  renderAuthorLabel();

  // Landed here via a /:orgToken/:projectSlug[/:endpointSlug]/dashboard.html
  // deep link (see server.js) — jump straight to that project's Overview, or
  // that endpoint's doc page, instead of the default view. slugify/
  // endpointSlugFor are the same functions buildEditorUrl uses (19-audit-log-page.js),
  // so a slug built anywhere in the app resolves the same way everywhere.
  // A stale/renamed/deleted slug just falls through to the default view
  // rather than erroring.
  if(INITIAL_PROJECT_SLUG){
    const proj = allProjects().find(p => slugify(p.name) === INITIAL_PROJECT_SLUG);
    if(proj){
      const ep = INITIAL_ENDPOINT_SLUG
        ? (proj.endpoints||[]).find(e => endpointSlugFor(e) === INITIAL_ENDPOINT_SLUG)
        : null;
      state.selected = ep ? { type:'endpoint', id: ep.id } : { type:'overview', projectId: proj.id };
    }
  }
  // A non-Admin still needs to reach Security if they own at least one
  // project (see requireAdminOrProjectOwner server-side) — otherwise they'd
  // have no way to act on a documentation-access request for their own
  // project short of an Admin doing it for them, which is exactly the
  // bottleneck item #2 removes.
  document.getElementById('btnSecurityCenter').style.display = (isAdmin() || ownsAnyProject()) ? '' : 'none';
  // Release Pipeline overview surfaces org-wide pending promotion requests
  // (approve/cancel authority is Admin-only server-side — see the
  // /promotion-requests org-wide route) — same visibility gate as Security.
  document.getElementById('btnReleasePipeline').style.display = (isAdmin() || ownsAnyProject()) ? '' : 'none';

  // Access-schedule banner/lock state — rendered immediately from the
  // server-injected AUTH_USER (so it's correct on first paint, before any
  // API call has round-tripped), then re-evaluated every 30s so a window
  // opening or closing while the tab is left open doesn't need a reload.
  // The 30s cadence is a display refresh only; see apiSend()'s 423 handling
  // for the case that actually matters (a real API call being rejected).
  renderScheduleState();
  setInterval(renderScheduleState, 30000);

  // Which environments (if any) this signed-in user may fire a REAL request
  // against from Try It — see /api/live-mode and openTryItModal(). Failure
  // here just means Live mode stays hidden (fails closed), never blocks boot.
  try{
    const res = await fetch('/api/live-mode/my-access', { credentials:'same-origin' });
    state.liveModeEnvs = res.ok ? (await res.json()).environments || [] : [];
  }catch(e){ state.liveModeEnvs = []; }
  // Separate from the above — "may browse this environment's docs" is its
  // own grant, independent of "may fire a real request against it" (see
  // server/routes/liveMode.js's loadBrowseGrants). roleAllowedEnvs()
  // (03-notifications.js) unions both, so either grant is enough to browse.
  try{
    const res = await fetch('/api/live-mode/my-browse-access', { credentials:'same-origin' });
    state.docBrowseEnvs = res.ok ? (await res.json()).environments || [] : [];
  }catch(e){ state.docBrowseEnvs = []; }

  // Landed here via a "Try it" new-tab link (see openTryItTab/buildTryItUrl) —
  // jump straight to that endpoint's docs with Try It already open, in
  // whichever environment the link carried, without touching this browser's
  // saved env preference (no saveEnv() call — see renderMain()'s handling of
  // state.selected.tryIt for where the modal actually gets opened).
  const deepLinkParams = new URLSearchParams(location.search);
  const tryItEpId = deepLinkParams.get('tryit');
  if(tryItEpId){
    const envParam = deepLinkParams.get('env');
    if(envParam && envIds().includes(envParam) && roleAllowsEnv(envParam)) state.env = envParam;
    state.selected = { type:'endpoint', id: tryItEpId, tryIt:true };
    // Drives renderMain()'s decision to skip the full endpoint-doc render
    // entirely (not just hide it under the overlay) — see the comment there.
    state.standaloneTryIt = true;
    // Re-skins #tryItModal from a floating dialog into this tab's actual full
    // page — see the `body.tryit-standalone` CSS above. Added before renderAll()
    // so the layout is correct on first paint, not applied after a flash of
    // the normal sidebar+modal layout.
    document.body.classList.add('tryit-standalone');
  }

  initNotifications();

  renderAll();
})();
