/* ==================== SECTION:STATE ==================== */
let state = {
  theme: 'dark',
  env: 'DEV',
  selected: { type:'home' },       // { type:'home' } | { type:'errors' } | { type:'endpoint', id } | { type:'overview', projectId }
  codeLang: 'curl',
  railTab: 'code',                 // 'code' | 'try'
  projects: {},
  requestHistory: {},               // { [endpointId]: [ {method,url,status,statusText,timeMs,sizeBytes,timestamp,error} ] }
  tryitCollections: { variables: [], saved: [] }, // Postman-style Try It collection vars + saved requests — org-shared, see loadState()
  tryitPersonal: { variables: [], saved: [] },      // PER-USER Try It variables + saved requests — never shipped to any other user, see loadState()
  endpointMetrics: {},              // { endpoints: { "METHOD /path": {totalRequests, statusBreakdown, errorRate, lastSeenAt, topSourceIps, sourceLog} }, agentHealth: {...} } — pushed by ops/sit-doc-agent, org-shared, see loadState() and observabilityData() in 23-observability.js (which also tolerates the older flat-map-only shape)
  authorName: '',                   // display name used to attribute added/modified endpoints — from AUTH_USER when signed in
  organisation: '',                 // from AUTH_USER when signed in
  sidebarCollapsed: false,          // desktop sidebar collapse (persisted) — separate from the mobile drawer's .show class
  autoSectionOpen: false,           // sidebar's "Auto-discovered APIs" section — collapsed by default, per-viewer (persisted), see 09-render-sidebar.js
  environments: [],                 // user-configurable environment list — see loadState()
  auditLog: [],                     // who changed what, when — see logAudit()
  customFlowDirections: [],         // legacy org-shared flow-direction presets — kept only for resolveFlowDirection()'s back-compat fallback (public/js/studio/03-notifications.js), no longer written to
  branding: {},                     // org letterhead for PDF exports — { orgDisplayName, logoDataUrl, updatedAt, updatedBy }, see loadState() and Your Profile ▸ Organisation branding
  envUrlRevealed: {},                // { [envId]: true } — session-only, never persisted; Admin-role reveal toggle
  sensitiveRevealed: false,          // session-only Admin-role toggle: reveals real hosts & secret header values
  envTableUI: { search:'', filterAccess:'', filterColor:'', sortBy:null, sortDir:'asc' },
  envTableStatus: 'ready',           // 'ready' | 'loading' | 'error' — see loadState()
  envMetrics: null,                  // GET /environment-metrics response cache — see loadEnvironmentMetrics()
  envMetricsStatus: 'idle',          // 'idle' | 'loading' | 'error' | 'ready'
  liveModeEnvs: [],                  // envIds this user may fire a REAL request against — see 22-init.js / server/routes/liveMode.js
  docBrowseEnvs: [],                 // envIds this user may browse docs for — separate grant from liveModeEnvs, see roleAllowedEnvs()

  // ---- Observability console (time-series API — see 24-obs-api.js) ----
  obsTab: 'overview',               // 'overview' | 'performance' | 'errors' | 'logs' | 'agent'
  obsRange: { key: '24h' },         // { key } for a preset, or { from, to } ISO strings for a custom range
  obsEnvironment: '',               // '' = follow state.env, '__all' = every environment, else a named one
  obsData: null,                    // last obsLoadAll() result — { current, previous, series, endpoints, coverage }
  obsStatus: 'idle',                // 'idle' | 'loading' | 'ready' | 'error' | 'unavailable'
  obsLastCheckedAt: 0,              // last availability probe — see OBS_AVAILABILITY_RECHECK_MS
  obsForcePreview: false,           // show the rebuilt console before any rollup data exists (session-only)
  obsLegacyView: false,             // opt back into the pre-rebuild console (session-only)
  obsError: '',                     // message shown when obsStatus === 'error'
  obsFilters: {},                   // drill-down: { statusFamily, endpointId, clientIp, correlationId, minLatencyMs }
  obsRecords: null,                 // last /records page — { records, total, limit, offset }
  obsRecordsPage: 1,
  obsEndpointPage: 1,             // All endpoints table pager
  obsEndpointSearch: '',          // All endpoints filter box
  obsEnvOptions: [],                // environments that have actually reported — GET /observability/environments
};
