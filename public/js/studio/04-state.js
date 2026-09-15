/* ==================== SECTION:STATE ==================== */
let state = {
  theme: 'dark',
  env: 'DEV',
  selected: { type:'home' },       // { type:'home' } | { type:'errors' } | { type:'endpoint', id } | { type:'overview', projectId }
  codeLang: 'curl',
  railTab: 'code',                 // 'code' | 'try'
  projects: {},
  requestHistory: {},               // { [endpointId]: [ {method,url,status,statusText,timeMs,sizeBytes,timestamp,error} ] }
  authorName: '',                   // display name used to attribute added/modified endpoints — from AUTH_USER when signed in
  organisation: '',                 // from AUTH_USER when signed in
  sidebarCollapsed: false,          // desktop sidebar collapse (persisted) — separate from the mobile drawer's .show class
  environments: [],                 // user-configurable environment list — see loadState()
  auditLog: [],                     // who changed what, when — see logAudit()
  customFlowDirections: [],         // org-shared custom flow direction presets — see saveCustomFlowDirections()
  envUrlRevealed: {},                // { [envId]: true } — session-only, never persisted; Admin-role reveal toggle
  sensitiveRevealed: false,          // session-only Admin-role toggle: reveals real hosts & secret header values
  envTableUI: { search:'', filterAccess:'', filterColor:'', sortBy:null, sortDir:'asc' },
  envTableStatus: 'ready',           // 'ready' | 'loading' | 'error' — see loadState()
  envMetrics: null,                  // GET /environment-metrics response cache — see loadEnvironmentMetrics()
  envMetricsStatus: 'idle',          // 'idle' | 'loading' | 'ready' | 'error'
};
