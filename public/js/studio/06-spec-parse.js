/* ==================== SECTION:SPEC-PARSE ==================== */

/* ---------- Persistence + migration from the old single-project-basePath format ---------- */
function blankEnvironments(){
  const envs = {};
  envIds().forEach(id=>envs[id]='');
  return envs;
}

async function loadState(){
  // One-time: bring any pre-Postgres localStorage workspace over to the server.
  await migrateLocalStorageIfNeeded();

  try{
    const ws = await apiGet('');
    state.projects = ws.projects || {};
    Object.values(state.projects).forEach(ensureProjectDefaults);
    state.requestHistory = ws.requestHistory || {};
    state.tryitCollections = (ws.tryitCollections && typeof ws.tryitCollections === 'object')
      ? { variables: Array.isArray(ws.tryitCollections.variables) ? ws.tryitCollections.variables : [], saved: Array.isArray(ws.tryitCollections.saved) ? ws.tryitCollections.saved : [] }
      : { variables: [], saved: [] };
    state.tryitPersonal = (ws.tryitPersonal && typeof ws.tryitPersonal === 'object')
      ? { variables: Array.isArray(ws.tryitPersonal.variables) ? ws.tryitPersonal.variables : [], saved: Array.isArray(ws.tryitPersonal.saved) ? ws.tryitPersonal.saved : [] }
      : { variables: [], saved: [] };
    state.endpointMetrics = (ws.endpointMetrics && typeof ws.endpointMetrics === 'object') ? ws.endpointMetrics : {};
    state.environments = (Array.isArray(ws.environments) && ws.environments.length) ? ws.environments.map(migrateEnvironment) : [];
    state.customFlowDirections = Array.isArray(ws.customFlowDirections) ? ws.customFlowDirections : [];
    state.branding = ws.branding && typeof ws.branding === 'object' ? ws.branding : {};
    state.envTableStatus = 'ready';
  }catch(e){
    console.error('Failed to load workspace from server', e);
    state.projects = {};
    state.requestHistory = {};
    state.tryitCollections = { variables: [], saved: [] };
    state.tryitPersonal = { variables: [], saved: [] };
    state.endpointMetrics = {};
    state.environments = [];
    state.customFlowDirections = [];
    state.branding = {};
    state.envTableStatus = 'error';
    toast('Could not load your workspace from the server — check your connection and reload.');
  }

  // Audit log now comes from the authoritative audit_logs table (GET /api/audit/events),
  // not the old client-writable workspace blob. This view only ever shows the
  // single latest page (see AUDIT_LOG_CAP) — walking further back via the
  // `before` cursor is the standalone /auditlog page's job (server/views/auditlog.html),
  // which has the "Load older events" control. limit=AUDIT_LOG_CAP keeps this
  // widget's page size matching what it always showed before pagination existed.
  try{
    const res = await fetch('/api/audit/events?limit=' + AUDIT_LOG_CAP, { credentials:'same-origin' });
    const data = await res.json();
    state.auditLog = Array.isArray(data.entries) ? data.entries : [];
  }catch(e){
    console.error('Failed to load audit log from server', e);
    state.auditLog = [];
  }

  // PII masking config — fails closed (see loadPiiConfig) so a failed fetch
  // still leaves built-in field/pattern rules in effect.
  await loadPiiConfig();

  const theme = localStorage.getItem(THEME_KEY);
  state.theme = theme === 'light' ? 'light' : 'dark';
  const env = localStorage.getItem(ENV_KEY);
  state.env = envIds().includes(env) ? env : envIds()[0];
  const role = localStorage.getItem(ROLE_KEY);
  state.authorRole = ROLES.some(r=>r.id===role) ? role : 'Developer';
  state.sidebarCollapsed = localStorage.getItem(SIDEBAR_KEY) === '1';
  state.autoSectionOpen = localStorage.getItem(AUTO_SECTION_KEY) === '1';

  if(AUTH_USER){
    // Signed in via the real auth service — identity comes from the session, not localStorage.
    state.authorName = AUTH_USER.username;
    state.organisation = AUTH_USER.organisation;
    const roleMap = { admin:'admin', editor:'Developer', viewer:'viewer', custom:'custom' };
    state.authorRole = roleMap[AUTH_USER.role] || (ROLES.some(r=>r.id===role) ? role : 'Developer');
  } else {
    state.authorName = localStorage.getItem(AUTHOR_KEY) || '';
    state.organisation = '';
  }
}

function migrateProject(p){
  const envs = blankEnvironments();
  envIds().forEach(id=>envs[id] = p.basePath || '');
  const now = new Date().toISOString();
  return ensureProjectDefaults({
    id: p.id, name: p.name || 'Untitled API', description:'',
    visibility: p.visibility === 'public' ? 'public' : 'private',
    environments: envs,
    auth: { type:'', headerName:'', description:'' },
    notes: '',
    lifecycle: p.lifecycle || 'PRODUCTION',
    owner: p.owner || '', team: p.team || '',
    createdAt: p.createdAt || now, updatedAt: p.updatedAt || now,
    endpoints: (p.endpoints||[]).map(migrateEndpoint),
    _open: true,
  });
}
function migrateEndpoint(ep){
  return {
    id: ep.id || uid(), method: ep.method || 'GET', path: ep.path || '/',
    visibility: ep.visibility === 'public' ? 'public' : 'private',
    tag: ep.tag || 'General', summary: ep.summary || '', description: ep.description || '',
    version: ep.version || '', contentType: ep.contentType || 'application/json',
    parameters: (ep.parameters||[]).filter(p=>p.in!=='header').map(p=>({ name:p.name||'', in:p.in||'query', type:p.type||'string', required:!!p.required, example:p.example||'', description:p.description||'' })),
    headers: (ep.headers||(ep.parameters||[]).filter(p=>p.in==='header')).map(p=>({ name:p.name||'', type:p.type||'String', required:!!p.required, example:p.example||'', description:p.description||'' })),
    requestBody: ep.bodyExample ? { example: ep.bodyExample, fields: [], examples: [] } : (ep.requestBody ? { ...ep.requestBody, examples: ep.requestBody.examples || [] } : null),
    responses: (ep.responses||[]).map(r=>({ code:r.code, description:r.description||'', example:r.example||'', fields: r.fields||[], examples: r.examples||[] })),
    architecture: ep.architecture || null,
  };
}

// Debounced so rapid edits (typing, drag-reordering) don't fire a network
// request per keystroke — trailing call wins, same as the old localStorage
// write but batched. Callers that used the boolean return value to detect a
// full local disk are kept working by always returning true optimistically;
// a real failure surfaces via toast once the request actually completes.
let _saveStateTimer = null;
function saveState(){
  clearTimeout(_saveStateTimer);
  _saveStateTimer = setTimeout(()=>{
    apiSend('PUT', '/projects', { projects: state.projects }).then(async res=>{
      if(res && res.skipped && res.skipped.length){
        toast("Some changes couldn't be saved — you're not the owner of that project.");
      }
      // Keep each saved project's `_rev` current so the NEXT save's conflict
      // check compares against what the server actually has now, not what
      // was loaded at page-open — otherwise every save after the first would
      // spuriously conflict with itself.
      if(res && res.revs){
        Object.entries(res.revs).forEach(([id, rev])=>{
          if(state.projects[id]) state.projects[id]._rev = rev;
        });
      }
      // A conflict means someone else (or another tab) saved this project
      // after we loaded our copy — our edit was NOT written, to avoid
      // silently discarding theirs (see the server-side comment in
      // PUT /projects). Pull the current server copy back in so this tab
      // stops re-offering a save that will just conflict again, and tell
      // the user their most recent change here didn't go through.
      if(res && res.conflicts && res.conflicts.length){
        try{
          const fresh = await apiGet('');
          res.conflicts.forEach(id=>{
            if(fresh.projects && fresh.projects[id]) state.projects[id] = ensureProjectDefaults(fresh.projects[id]);
          });
          renderAll();
        }catch(e){ console.error('Could not reload conflicted project', e); }
        toast('Someone else just updated ' + (res.conflicts.length===1 ? 'a project' : res.conflicts.length + ' projects') + " you had open — your last change there wasn't saved. Reloaded the latest version.");
      }
    }).catch(e=>{
      console.error('Save failed', e);
      toast('Could not save to the server — check your connection.');
    });
    apiSend('PUT', '/request-history', { requestHistory: state.requestHistory }).catch(e=>{
      console.error('Save request history failed', e);
    });
    apiSend('PUT', '/tryit-collections', { tryitCollections: state.tryitCollections }).catch(e=>{
      console.error('Save Try It collections failed', e);
    });
    apiSend('PUT', '/tryit-personal', { tryitPersonal: state.tryitPersonal }).catch(e=>{
      console.error('Save personal Try It data failed', e);
    });
  }, 300);
  return true;
}
function saveTheme(){ localStorage.setItem(THEME_KEY, state.theme); }
function saveEnv(){ localStorage.setItem(ENV_KEY, state.env); }

function isMobileLayout(){ return window.matchMedia('(max-width:820px)').matches; }

function applySidebarCollapsed(){
  const app = document.getElementById('app');
  const btn = document.getElementById('btnSidebarToggle');
  const edgeBtn = document.getElementById('btnSidebarEdgeToggle');
  const collapsed = !!state.sidebarCollapsed;
  app.classList.toggle('sb-collapsed', collapsed);
  btn.setAttribute('aria-expanded', String(!collapsed));
  btn.title = collapsed ? 'Show sidebar (Ctrl/Cmd+B)' : 'Hide sidebar (Ctrl/Cmd+B)';
  if(edgeBtn){
    edgeBtn.setAttribute('aria-expanded', String(!collapsed));
    edgeBtn.title = collapsed ? 'Expand sidebar (Ctrl/Cmd+B)' : 'Collapse sidebar (Ctrl/Cmd+B)';
    edgeBtn.querySelector('svg').style.transform = collapsed ? 'rotate(180deg)' : 'rotate(0deg)';
  }
}

function toggleSidebar(){
  if(isMobileLayout()){
    document.getElementById('sidebar').classList.toggle('show');
    return;
  }
  state.sidebarCollapsed = !state.sidebarCollapsed;
  localStorage.setItem(SIDEBAR_KEY, state.sidebarCollapsed ? '1' : '0');
  applySidebarCollapsed();
}

function expandSidebarThen(focusSearch){
  if(!state.sidebarCollapsed) { if(focusSearch) document.getElementById('searchBox').focus(); return; }
  state.sidebarCollapsed = false;
  localStorage.setItem(SIDEBAR_KEY, '0');
  applySidebarCollapsed();
  if(focusSearch) setTimeout(()=>document.getElementById('searchBox').focus(), 180);
}

// Local "identity" for attribution only — there's no login system, just a name
// the person picks so endpoints they add/edit can say who touched them.
function ensureAuthorName(promptIfMissing){
  if(AUTH_USER) return state.authorName;
  if(!state.authorName && promptIfMissing){
    const val = (window.prompt('Name to credit as "added by / last modified by" on endpoints you save:', '') || '').trim();
    if(val){
      state.authorName = val;
      localStorage.setItem(AUTHOR_KEY, val);
      renderAuthorLabel();
    }
  }
  return state.authorName;
}
function renderAuthorLabel(){
  const el = document.getElementById('authorNameLabel');
  const av = document.getElementById('authorAvatar');
  if(el) el.textContent = state.organisation ? `${state.authorName} · ${state.organisation}` : (state.authorName || 'Set up profile');
  const logoutBtn = document.getElementById('btnLogout');
  if(logoutBtn) logoutBtn.style.display = AUTH_USER ? '' : 'none';
  if(av){
    const initials = profileInitials(state.authorName);
    av.style.background = state.authorName ? profileColor(state.authorName) : 'var(--surface-hover)';
    av.innerHTML = initials
      ? initials
      : '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text-faint);"><circle cx="12" cy="8" r="3.4"></circle><path d="M5 20c0-3.6 3.1-6.5 7-6.5s7 2.9 7 6.5"></path></svg>';
  }
  const pill = document.getElementById('authorRolePill');
  if(pill){
    const role = roleMeta(state.authorRole);
    pill.textContent = role.label;
    pill.className = 'role-pill role-' + role.id;
  }
  const authorBtn = document.getElementById('btnAuthor');
  if(authorBtn){
    const role = roleMeta(state.authorRole);
    authorBtn.title = state.authorName
      ? `${state.authorName} · ${role.label} — click to view your profile`
      : 'Set up your profile';
  }
  applyRoleGatedUI();
}

function setAuthorRole(roleId){
  if(!ROLES.some(r=>r.id===roleId)) return;
  state.authorRole = roleId;
  localStorage.setItem(ROLE_KEY, roleId);
  if(roleId !== 'admin'){ state.sensitiveRevealed = false; state.envUrlRevealed = {}; restoreMaskedEndpoints(); }
  if(!roleAllowsEnv(state.env)){
    state.env = roleAllowedEnvs(roleId)[0].id;
    saveEnv();
  }
  renderAuthorLabel();
  renderEnvSwitcher();
  renderMain();
  renderRail();
  toast(`Role set to ${roleMeta(roleId).label}`);
}

// Gated by role AND by which environment is selected — hide the create FAB
// outside the draft stage the same way Edit/Duplicate are hidden on an
// endpoint's own page, since non-draft stages are frozen promoted snapshots.
// This is a UI convenience, not a security boundary (there's no backend here
// to enforce it against).
function applyRoleGatedUI(){
  const fab = document.getElementById('btnFab');
  if(fab) fab.style.display = canEditHere() ? '' : 'none';
}

function ensureEndpointDefaults(ep){
  const now = new Date().toISOString();
  if(ep.visibility !== 'public' && ep.visibility !== 'private') ep.visibility = 'private';
  if(!ep.createdAt) ep.createdAt = now;
  if(!ep.updatedAt) ep.updatedAt = ep.createdAt;
  if(typeof ep.createdBy !== 'string') ep.createdBy = '';
  if(typeof ep.updatedBy !== 'string') ep.updatedBy = '';
  return ep;
}

function ensureProjectDefaults(proj){
  const now = new Date().toISOString();
  if(proj.visibility !== 'public' && proj.visibility !== 'private') proj.visibility = 'private';
  if(!LIFECYCLE_STAGES.includes(proj.lifecycle)) proj.lifecycle = 'PRODUCTION';
  if(typeof proj.owner !== 'string') proj.owner = '';
  if(typeof proj.team !== 'string') proj.team = '';
  if(typeof proj.termsOfService !== 'string') proj.termsOfService = '';
  if(!proj.contact || typeof proj.contact !== 'object') proj.contact = { name:'', email:'' };
  if(!proj.license || typeof proj.license !== 'object') proj.license = { name:'', url:'' };
  if(typeof proj.requestFlowDirection !== 'string' || !proj.requestFlowDirection) proj.requestFlowDirection = '1-way';
  if(typeof proj.requestFlowLabel !== 'string') proj.requestFlowLabel = '';
  if(!Array.isArray(proj.requestFlowStages)) proj.requestFlowStages = [];
  if(!Array.isArray(proj.requestFlows)) proj.requestFlows = [];
  if(!proj.createdAt) proj.createdAt = now;
  if(!proj.updatedAt) proj.updatedAt = proj.createdAt;
  if(!Array.isArray(proj.attachments)) proj.attachments = [];
  (proj.endpoints||[]).forEach(ensureEndpointDefaults);
  return proj;
}

function blankProject(name){
  const now = new Date().toISOString();
  return {
    id: uid(), name: name || 'Untitled API', description:'',
    visibility: 'private', // private to me until I choose to make it public — see project settings
    environments: blankEnvironments(),
    auth: { type:'', headerName:'', description:'' },
    notes:'',
    lifecycle: 'DEVELOPMENT',
    owner:'', team:'', version:'',
    requestFlowDirection: '1-way', requestFlowLabel: '', requestFlowStages: [], requestFlows: [],
    termsOfService:'', contact:{ name:'', email:'' }, license:{ name:'', url:'' },
    createdAt: now, updatedAt: now,
    endpoints: [],
    attachments: [],
    _open: true,
  };
}

function toggleProjectVisibility(projId){
  const proj = state.projects[projId];
  if(!proj || proj._readonly) return;
  proj.visibility = proj.visibility === 'public' ? 'private' : 'public';
  proj.updatedAt = new Date().toISOString();
  logAudit('updated', 'project', proj.name, `Made project ${proj.visibility}`, proj.name);
  saveState();
  renderAll();
  toast(proj.visibility === 'public' ? 'Project is now public to your organisation' : 'Project is now private');
}

function toggleEndpointVisibility(epId){
  if(!canEditHere()){ toast(isViewingDraftEnv() ? `Your role (${roleMeta(state.authorRole).label}) is read-only` : `Switch to ${envMeta(draftEnvId()).label} to make changes`); return; }
  const found = findEndpoint(epId);
  if(!found || found.proj._readonly) return;
  const { proj, ep } = found;
  ep.visibility = ep.visibility === 'public' ? 'private' : 'public';
  ep.updatedAt = new Date().toISOString();
  ep.updatedBy = state.authorName || ep.updatedBy;
  logAudit('updated', 'endpoint', `${ep.method} ${ep.path}`, `Made endpoint ${ep.visibility}`, proj.name);
  saveState();
  renderAll();
  toast(ep.visibility === 'public' ? 'Endpoint is now public to your organisation' : 'Endpoint is now private');
}

function findOrCreateProjectByName(name){
  let proj = allProjects().find(p=>p.name.toLowerCase() === name.toLowerCase());
  if(!proj){
    proj = blankProject(name);
    state.projects[proj.id] = proj;
  }
  return proj;
}

/* ---------- $ref resolution ---------- */
function resolveRef(spec, ref){
  if(!ref || typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  const parts = ref.slice(2).split('/');
  let node = spec;
  for(const raw of parts){
    if(node == null) return null;
    const key = decodeURIComponent(raw.replace(/~1/g,'/').replace(/~0/g,'~'));
    node = node[key];
  }
  return node || null;
}

function resolveSchema(spec, schema, seen){
  seen = seen || new Set();
  if(!schema || typeof schema !== 'object') return schema;
  if(schema.$ref){
    if(seen.has(schema.$ref)) return { type:'object', description:'(circular reference)' };
    const next = new Set(seen); next.add(schema.$ref);
    const resolved = resolveRef(spec, schema.$ref);
    return resolved ? resolveSchema(spec, resolved, next) : schema;
  }
  // allOf: merge properties shallowly — common in OpenAPI for extending base schemas
  if(Array.isArray(schema.allOf)){
    const merged = { type:'object', properties:{}, required:[] };
    schema.allOf.forEach(sub=>{
      const rs = resolveSchema(spec, sub, seen);
      if(rs && rs.properties) Object.assign(merged.properties, rs.properties);
      if(rs && Array.isArray(rs.required)) merged.required.push(...rs.required);
    });
    if(schema.description) merged.description = schema.description;
    return merged;
  }
  return schema;
}

function schemaTypeLabel(schema){
  if(!schema) return 'any';
  if(schema.$ref) return String(schema.$ref).split('/').pop();
  if(schema.type === 'array'){
    const inner = schema.items ? schemaTypeLabel(schema.items) : 'any';
    return inner + '[]';
  }
  if(schema.enum) return 'enum';
  return schema.type || 'object';
}

function schemaToFields(spec, schema, seen, prefix){
  seen = seen || new Set();
  const resolved = resolveSchema(spec, schema, seen);
  if(!resolved) return [];
  const fields = [];
  if(resolved.type === 'array' && resolved.items){
    return schemaToFields(spec, resolved.items, seen, prefix ? prefix+'[]' : '[]');
  }
  if(resolved.properties){
    const required = new Set(resolved.required || []);
    Object.entries(resolved.properties).forEach(([key, val])=>{
      const rv = resolveSchema(spec, val, seen);
      fields.push({
        name: prefix ? prefix+'.'+key : key,
        type: schemaTypeLabel(rv || val),
        required: required.has(key),
        description: (rv && rv.description) || val.description || ''
      });
      // one level of nested object expansion keeps the table readable without exploding depth
      if(rv && rv.type === 'object' && rv.properties && (prefix || '').split('.').length < 2){
        fields.push(...schemaToFields(spec, rv, seen, prefix ? prefix+'.'+key : key));
      }
    });
  }
  return fields;
}

function schemaToExample(spec, schema, depth, seen){
  depth = depth || 0;
  seen = seen || new Set();
  const resolved = resolveSchema(spec, schema, seen);
  if(!resolved || depth > 6) return null;
  if(resolved.example !== undefined) return resolved.example;
  if(resolved.default !== undefined) return resolved.default;
  if(Array.isArray(resolved.enum) && resolved.enum.length) return resolved.enum[0];

  switch(resolved.type){
    case 'object': {
      const out = {};
      Object.entries(resolved.properties || {}).forEach(([k,v])=>{
        out[k] = schemaToExample(spec, v, depth+1, new Set(seen));
      });
      return out;
    }
    case 'array':
      return [ schemaToExample(spec, resolved.items || {type:'string'}, depth+1, new Set(seen)) ];
    case 'integer': return 0;
    case 'number': return 0;
    case 'boolean': return true;
    case 'string':
      if(resolved.format === 'date-time') return new Date().toISOString();
      if(resolved.format === 'date') return new Date().toISOString().slice(0,10);
      if(resolved.format === 'email') return 'user@example.com';
      if(resolved.format === 'uuid') return '00000000-0000-0000-0000-000000000000';
      return 'string';
    default:
      if(resolved.properties) return schemaToExample(spec, {...resolved, type:'object'}, depth, seen);
      return null;
  }
}

/* ---------- Environment auto-mapping from OpenAPI `servers` ---------- */
function mapServersToEnvironments(spec){
  const envs = blankEnvironments();
  if(!Array.isArray(spec.servers) || !spec.servers.length) return envs;

  const keywords = {
    DEV: ['dev'], SIT: ['sit', 'system integration'], UAT: ['uat', 'acceptance'],
    PREPROD: ['preprod', 'pre-prod', 'pre prod', 'staging', 'stage'],
    PROD: ['prod', 'production'], DR: ['dr', 'disaster'],
  };
  spec.servers.forEach(s=>{
    const text = ((s.description||'') + ' ' + (s.url||'')).toLowerCase();
    const match = envIds().find(id => (keywords[id]||[]).some(kw => text.includes(kw)));
    if(match && !envs[match]) envs[match] = s.url;
  });
  const fallback = spec.servers[0].url || '';
  envIds().forEach(id=>{ if(!envs[id]) envs[id] = fallback; });
  return envs;
}

/* ---------- Full spec -> project ---------- */
function parseSpecToProject(spec){
  const title = (spec.info && spec.info.title) || 'Untitled API';
  const description = (spec.info && spec.info.description) || '';
  const environments = mapServersToEnvironments(spec);

  let auth = { type:'', headerName:'', description:'' };
  const secSchemes = (spec.components && spec.components.securitySchemes) || spec.securityDefinitions || {};
  const firstSec = Object.values(secSchemes)[0];
  if(firstSec){
    auth = {
      type: firstSec.type || firstSec.scheme || '',
      headerName: firstSec.name || (String(firstSec.scheme||'').toLowerCase()==='bearer' ? 'Authorization' : ''),
      description: firstSec.description || '',
    };
  }

  const endpoints = [];
  const paths = spec.paths || {};
  Object.keys(paths).forEach(path=>{
    const item = paths[path] || {};
    const pathLevelParams = item.parameters || [];
    ['get','post','put','patch','delete'].forEach(method=>{
      if(!item[method]) return;
      const op = item[method];

      const rawParams = [...pathLevelParams, ...(op.parameters||[])];
      const parameters = rawParams.map(p=>{
        const resolved = p.$ref ? resolveRef(spec, p.$ref) : p;
        if(!resolved) return null;
        const schema = resolved.schema ? resolveSchema(spec, resolved.schema) : null;
        // Prefer an example declared directly on the parameter; fall back to one
        // declared on its schema (both are valid places for OpenAPI to put it).
        // Previously neither was carried over, so imported parameters always lost
        // their example values on re-export.
        const rawExample = resolved.example !== undefined ? resolved.example
          : (schema && schema.example !== undefined ? schema.example : undefined);
        return {
          name: resolved.name || '',
          in: resolved.in || 'query',
          type: schema ? schemaTypeLabel(schema) : (resolved.type || 'string'),
          required: !!resolved.required,
          description: resolved.description || '',
          example: rawExample !== undefined ? String(rawExample) : '',
        };
      }).filter(Boolean);

      let requestBody = null;
      if(op.requestBody){
        const rb = op.requestBody.$ref ? resolveRef(spec, op.requestBody.$ref) : op.requestBody;
        const content = (rb && rb.content) || {};
        const ct = Object.keys(content)[0];
        if(ct && content[ct].schema){
          const resolvedSchema = resolveSchema(spec, content[ct].schema);
          const exampleVal = content[ct].example !== undefined
            ? content[ct].example
            : schemaToExample(spec, resolvedSchema);
          requestBody = {
            example: (exampleVal !== undefined && exampleVal !== null) ? JSON.stringify(exampleVal, null, 2) : '',
            fields: schemaToFields(spec, resolvedSchema),
          };
        }
      }

      const responses = Object.keys(op.responses || {}).map(code=>{
        const r = op.responses[code];
        const resolvedR = r.$ref ? resolveRef(spec, r.$ref) : r;
        let example = '';
        try{
          const content = (resolvedR && resolvedR.content) || {};
          const ct = Object.keys(content)[0];
          if(ct){
            const contentObj = content[ct] || {};
            // Read the example directly whenever it's present, regardless of whether
            // a schema is also defined. Previously this only ran inside the schema
            // check, so a response with just an example JSON and no formal schema
            // (a very common way to write specs) was silently dropped on import.
            let ex = contentObj.example;
            if(ex === undefined && contentObj.schema){
              const s = resolveSchema(spec, contentObj.schema);
              ex = schemaToExample(spec, s);
            }
            if(ex !== undefined && ex !== null) example = JSON.stringify(ex, null, 2);
          }
        }catch(e){}
        return { code, description: (resolvedR && resolvedR.description) || '', example };
      });

      endpoints.push({
        id: uid(), method: method.toUpperCase(), path,
        tag: (op.tags && op.tags[0]) || 'General',
        summary: op.summary || item.summary || '', description: op.description || item.description || '',
        parameters, requestBody, responses,
      });
    });
  });

  const now = new Date().toISOString();
  return {
    id: uid(), name: title, description, environments, auth, notes:'',
    lifecycle: 'DEVELOPMENT', owner:'', team:'', requestFlowDirection: '1-way', requestFlowLabel: '', requestFlowStages: [], requestFlows: [], createdAt: now, updatedAt: now,
    endpoints, _open: true,
  };
}

// True for a real Postman Collection export (v2.0/v2.1) — detected the same
// way Postman itself stamps its files, via info.schema, rather than by file
// extension (both this and an OpenAPI spec are plain .json).
function isPostmanCollectionJson(spec){
  return !!(spec && spec.info && typeof spec.info.schema === 'string' && spec.info.schema.includes('collection.postman.com'));
}

// Postman's request.body can be a string in some exports and an object in
// others (older Postman Legacy format) — always resolves to plain text.
function postmanRawBody(body){
  if(!body) return '';
  if(body.mode === 'raw' && typeof body.raw === 'string') return body.raw;
  if(typeof body === 'string') return body;
  return '';
}

// Postman's url field is either a plain string or a structured object with
// its own path[]/query[]/variable[] — normalizes both into what
// parsePostmanItem needs, converting Postman's :param path-variable syntax
// back into our {param} convention.
function postmanUrlParts(url){
  if(!url) return { path:'/', query:[], pathVars:[] };
  if(typeof url === 'string'){
    // Strip a leading {{host}}-style token or scheme+host, keep from the
    // first '/' onward; query string (if any) is parsed off separately.
    const withoutHost = url.replace(/^\{\{[^}]+\}\}/, '').replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '');
    const [pathPart, qs] = withoutHost.split('?');
    const query = (qs||'').split('&').filter(Boolean).map(pair=>{
      const [k,v] = pair.split('=');
      return { key: decodeURIComponent(k||''), value: decodeURIComponent(v||'') };
    });
    return { path: (pathPart||'/').replace(/:([A-Za-z0-9_]+)/g, '{$1}'), query, pathVars: [] };
  }
  const segments = Array.isArray(url.path) ? url.path : [];
  const path = '/' + segments.map(s=>String(s).replace(/^:(.+)/, '{$1}')).join('/');
  const query = (Array.isArray(url.query) ? url.query : []).filter(q=>!q.disabled).map(q=>({ key:q.key||'', value:q.value||'' }));
  const pathVars = Array.isArray(url.variable) ? url.variable : [];
  return { path: path === '/' ? (url.raw ? postmanUrlParts(url.raw).path : '/') : path, query, pathVars };
}

// Recursively walks Postman's item[] tree (folders nest arbitrarily deep)
// and flattens every leaf request into one of our endpoint objects, tagged
// with the name of the top-level folder it was found under (or 'General'
// for a request sitting directly on the collection root) — same one-level
// "tag" concept our own model uses, even though Postman folders can nest.
function parsePostmanItems(items, topFolder, out){
  (items||[]).forEach(node=>{
    if(Array.isArray(node.item)){
      parsePostmanItems(node.item, topFolder || node.name, out);
      return;
    }
    const req = node.request;
    if(!req || !req.method) return;
    const { path, query, pathVars } = postmanUrlParts(req.url);
    const headers = (Array.isArray(req.header) ? req.header : []).filter(h=>!h.disabled).map(h=>({
      name: h.key || '', type:'String', required:false, example: h.value || '', description: h.description || '',
    }));
    const queryParams = query.map(q=>({ name:q.key, in:'query', type:'string', required:false, example:q.value||'', description:'' }));
    const pathParamNames = [...path.matchAll(/\{([^}]+)\}/g)].map(m=>m[1]);
    const pathParams = pathParamNames.map(name=>{
      const v = pathVars.find(pv=>pv.key===name);
      return { name, in:'path', type:'string', required:true, example: (v && v.value) || '', description: (v && v.description) || '' };
    });
    const rawBody = postmanRawBody(req.body);
    const requestBody = rawBody.trim() ? { example: rawBody, fields: [] } : null;
    const responses = (Array.isArray(node.response) ? node.response : []).map(r=>({
      code: r.code || 200, description: r.name || '', example: postmanRawBody(r.body) || (typeof r.body === 'string' ? r.body : ''),
    }));
    out.push({
      id: uid(), method: String(req.method).toUpperCase(), path,
      tag: topFolder || 'General',
      summary: node.name || `${req.method} ${path}`, description: (typeof req.description === 'string' ? req.description : (req.description && req.description.content) || ''),
      parameters: [...pathParams, ...queryParams], headers, requestBody, responses,
    });
  });
}

// Collection-level auth -> our simple {type, headerName, description} shape.
function postmanCollectionAuth(spec){
  const a = spec.auth;
  if(!a || !a.type) return { type:'', headerName:'', description:'' };
  if(a.type === 'bearer') return { type:'bearer', headerName:'Authorization', description:'' };
  if(a.type === 'basic') return { type:'basic', headerName:'Authorization', description:'' };
  if(a.type === 'apikey'){
    const kv = Array.isArray(a.apikey) ? a.apikey : [];
    const keyName = (kv.find(x=>x.key==='key')||{}).value || 'Authorization';
    return { type:'apiKey', headerName: keyName, description:'' };
  }
  return { type: a.type, headerName:'', description:'' };
}

// Collection variable[] entries named like our own export's convention
// (<ENVID>-DNS, e.g. "SIT-DNS") seed proj.environments directly; anything
// else is a request-level or auth-token variable, not an environment host,
// so it's left alone here (Try It's own Collection Variables tab is where
// those belong once the project's been imported).
function postmanVariablesToEnvironments(spec){
  const envs = blankEnvironments();
  (Array.isArray(spec.variable) ? spec.variable : []).forEach(v=>{
    const m = /^([A-Za-z0-9_-]+)-DNS$/.exec(v.key||'');
    if(m && envIds().includes(m[1]) && v.value) envs[m[1]] = v.value;
  });
  return envs;
}

function parsePostmanCollectionToProject(spec){
  const endpoints = [];
  parsePostmanItems(spec.item, null, endpoints);
  const now = new Date().toISOString();
  return {
    id: uid(), name: (spec.info && spec.info.name) || 'Imported Postman collection',
    description: (spec.info && spec.info.description) || '',
    environments: postmanVariablesToEnvironments(spec),
    auth: postmanCollectionAuth(spec),
    notes:'', lifecycle:'DEVELOPMENT', owner:'', team:'',
    requestFlowDirection:'1-way', requestFlowLabel:'', requestFlowStages:[], requestFlows:[],
    createdAt: now, updatedAt: now, endpoints, _open: true,
  };
}

function handleImportedFile(file){
  const reader = new FileReader();
  reader.onload = (e)=>{
    const text = e.target.result;
    let spec;
    try{
      spec = file.name.endsWith('.json') ? JSON.parse(text) : jsyaml.load(text);
    }catch(err){
      toast('Could not parse file — check it is valid OpenAPI JSON/YAML.');
      return;
    }
    const project = isPostmanCollectionJson(spec) ? parsePostmanCollectionToProject(spec) : parseSpecToProject(spec);
    if(!project.endpoints.length){
      toast('No endpoints found in that spec.');
      return;
    }
    state.projects[project.id] = project;
    saveState();
    state.selected = { type:'overview', projectId: project.id };
    renderAll();
    logAudit('imported', 'project', project.name, `Imported spec — ${project.endpoints.length} endpoint${project.endpoints.length===1?'':'s'}`, project.name);
    const mappedEnvs = envIds().filter(id=>project.environments[id]).length;
    document.getElementById('importSummary').textContent =
      `"${project.name}" — ${project.endpoints.length} endpoint${project.endpoints.length===1?'':'s'} imported across ${Object.keys(groupByTag(project.endpoints)).length} group(s).`;
    document.getElementById('importModal').classList.add('show');
  };
  reader.readAsText(file);
}

function groupByTag(endpoints){
  const groups = {};
  endpoints.forEach(ep=>{ (groups[ep.tag] = groups[ep.tag] || []).push(ep); });
  return groups;
}

/* ---------- Full backup export ---------- */
function exportBackup(){
  const data = JSON.stringify({ projects: state.projects, exportedAt: new Date().toISOString() }, null, 2);
  const blob = new Blob([data], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `doctracker-backup-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Backup downloaded');
}

/* ---------- Single-project export / import (full backup & restore, unmasked) ----------
   Different from the OpenAPI/Swagger "Import spec file" flow above: that one only
   understands endpoints and rebuilds a project from scratch. This round-trips a
   *complete* DocTracker project — every endpoint, environment URL, auth doc, note,
   and attachment — so it can be pulled out of the workspace entirely and put back
   later exactly as it was. */
const DOCTRACKER_EXPORT_FORMAT_VERSION = 1;

// Attachments large enough to have been offloaded to object storage (see
// MAX_PROJECT_ATTACHMENT_BYTES / doc.storageKey in routes/workspace.js) only carry
// a storage reference client-side, not their actual bytes — fetch the real content
// and inline it as a data: URL so the exported file is genuinely self-contained
// instead of silently dropping large documents.
async function inlineAttachmentForExport(projectId, att){
  if(att.dataUrl || !att.storageKey) return att; // already inline, or nothing to fetch
  try{
    const res = await fetch(`/api/workspace/projects/${projectId}/attachments/${att.id}`, { credentials:'same-origin' });
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const dataUrl = await new Promise((resolve, reject)=>{
      const reader = new FileReader();
      reader.onload = ()=>resolve(reader.result);
      reader.onerror = ()=>reject(reader.error);
      reader.readAsDataURL(blob);
    });
    const { storageKey, ...rest } = att;
    return { ...rest, dataUrl };
  }catch(e){
    console.error('Could not inline attachment for export:', att.name, e);
    return { ...att, exportWarning: "Could not fetch this attachment's content — it was skipped in this export." };
  }
}

// Exports one project as a single JSON file. Deliberately unmasked (unlike the PDF
// export): this is for backing your own project up and restoring it exactly, not
// for handing to someone whose role shouldn't see secrets — it always uses the
// real environment URLs and auth values regardless of the current reveal setting.
async function exportProjectAsJson(projectId){
  const proj = state.projects[projectId];
  if(!proj){ toast('Project not found.'); return; }

  const hasOffloaded = (proj.attachments||[]).some(a=>a.storageKey && !a.dataUrl);
  if(hasOffloaded) toast('Preparing export — fetching attachment content…');

  const cloned = JSON.parse(JSON.stringify(proj));
  cloned.attachments = await Promise.all((cloned.attachments||[]).map(att=>inlineAttachmentForExport(proj.id, att)));
  // View-only flags are computed per-viewer by the server (see resolveAccess() in
  // routes/workspace.js) and never belong in the exported file — whoever imports
  // this owns the result.
  delete cloned._readonly;
  delete cloned._owned;

  const envelope = {
    docTrackerExport: true,
    formatVersion: DOCTRACKER_EXPORT_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    exportedBy: state.authorName || 'Unknown',
    project: cloned,
  };

  const data = JSON.stringify(envelope, null, 2);
  const blob = new Blob([data], { type:'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${slugify(proj.name)}-export-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);

  logAudit('exported', 'project', proj.name, `Exported project "${proj.name}" as a JSON file`, proj.name);
  toast('Project exported');
}

// Downloads a real .postman_collection.json for the WHOLE project (every
// endpoint, grouped into folders by tag) — buildPostmanCollection() does
// the actual schema translation (07-codesamples.js); this is just the file-
// save glue, same pattern as exportProjectAsJson() above. Uses whichever
// environment/endpoints are currently in view (state.env, viewEndpoints),
// so exporting from a promoted environment exports what's actually live
// there, not necessarily the draft.
function exportProjectAsPostmanCollection(projectId){
  const proj = state.projects[projectId];
  if(!proj){ toast('Project not found.'); return; }
  const endpoints = viewEndpoints(proj);
  if(!endpoints.length){ toast('This project has no endpoints to export.'); return; }
  const collection = buildPostmanCollection(proj, endpoints);
  const data = JSON.stringify(collection, null, 2);
  const blob = new Blob([data], { type:'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${slugify(proj.name)}.postman_collection.json`;
  a.click();
  URL.revokeObjectURL(url);
  logAudit('exported', 'project', proj.name, `Exported project "${proj.name}" as a Postman Collection`, proj.name);
  toast('Postman Collection downloaded');
}

// Deep-regenerates every id in an imported project (the project itself and every
// endpoint) so it can never collide with anything already in the workspace — used
// for the "import as a new project" conflict choice.
function regenerateProjectIds(proj){
  proj.id = uid();
  (proj.endpoints||[]).forEach(ep=>{ ep.id = uid(); });
  return proj;
}

function readFileAsText(file){
  return new Promise((resolve, reject)=>{
    const reader = new FileReader();
    reader.onload = ()=>resolve(reader.result);
    reader.onerror = ()=>reject(reader.error);
    reader.readAsText(file);
  });
}

// Counterpart to exportProjectAsJson(). Validates the envelope, then either imports
// straight away — the common "I deleted this and want it back exactly" case, where
// nothing in the workspace collides with it — or asks the person to choose when it
// would clash with a project that's already there.
async function importProjectFromJsonFile(file){
  let envelope;
  try{
    envelope = JSON.parse(await readFileAsText(file));
  }catch(e){
    toast('That file is not valid JSON.');
    return;
  }
  if(!envelope || envelope.docTrackerExport !== true || !envelope.project || typeof envelope.project !== 'object'){
    toast("That file doesn't look like a DocTracker project export.");
    return;
  }
  if(envelope.formatVersion && envelope.formatVersion > DOCTRACKER_EXPORT_FORMAT_VERSION){
    toast('This file was exported from a newer version of DocTracker — importing it here, but some fields may not carry over.');
  }

  let incoming = envelope.project;
  delete incoming._readonly;
  delete incoming._owned;
  if(!incoming.id) incoming.id = uid();
  if(!incoming.name || !incoming.name.trim()) incoming.name = 'Imported project';

  const existingById = state.projects[incoming.id];
  const existingByName = Object.values(state.projects).find(p=>p.name.toLowerCase() === (incoming.name||'').toLowerCase());
  const conflict = existingById || existingByName;

  let choice = null;
  if(conflict){
    choice = await openImportConflictModal(conflict.name);
    if(!choice || choice === 'cancel') return;
    if(choice === 'new'){
      incoming = regenerateProjectIds(incoming);
      if(existingByName) incoming.name = `${incoming.name} (imported)`;
    } else if(choice === 'overwrite'){
      incoming.id = conflict.id; // land in whichever slot the existing project occupies
    }
  }

  ensureProjectDefaults(incoming);
  state.projects[incoming.id] = incoming;
  await apiSend('PUT', '/projects', { projects: { [incoming.id]: incoming } });
  state.selected = { type:'overview', projectId: incoming.id };
  renderAll();
  logAudit('imported', 'project', incoming.name,
    conflict ? `Imported project "${incoming.name}" (${choice==='overwrite' ? 'overwrote existing' : 'as a new project'})` : `Imported project "${incoming.name}"`,
    incoming.name);
  toast(`"${incoming.name}" imported — ${(incoming.endpoints||[]).length} endpoint${(incoming.endpoints||[]).length===1?'':'s'}.`);
}

