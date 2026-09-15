/* ==================== SECTION:CODESAMPLES ==================== */
function pathWithParams(ep){
  let path = ep.path;
  (ep.parameters||[]).filter(p=>p.in==='path').forEach(p=>{
    path = path.replace(new RegExp('\\{'+p.name+'\\}','g'), `{${p.name}}`);
  });
  return path;
}
function buildUrl(proj, ep){
  const base = (proj.environments[state.env] || `https://{${state.env.toLowerCase()}-host}`).replace(/\/$/,'');
  return base + pathWithParams(ep);
}
// Display-only variant of the request URL: the host is replaced with the environment's
// variable token (e.g. "{{SIT-DNS}}") instead of the resolved value, so the real endpoint
// host is never shown in the UI unless an Admin has explicitly revealed it.
function displayUrl(proj, ep){
  if(sensitiveRevealed()) return buildUrl(proj, ep) + queryString(ep);
  return envVarToken(state.env) + pathWithParams(ep) + queryString(ep);
}
// Masked-host variant (kept fully resolvable in shape, e.g. "https://sit******.com/…") for
// contexts like cURL/Swagger and hover tooltips where a variable token would look out of place.
function maskedFullUrl(proj, ep){
  const real = buildUrl(proj, ep) + queryString(ep);
  return sensitiveRevealed() ? real : maskEndpointUrl(real);
}

function queryString(ep){
  const q = (ep.parameters||[]).filter(p=>!p.in || p.in==='query');
  if(!q.length) return '';
  return '?' + q.map(p=>`${encodeURIComponent(p.name)}=${encodeURIComponent(p.example || `{${p.name}}`)}`).join('&');
}

function authHeaderValue(proj){
  const t = ((proj.auth && proj.auth.type) || '').toLowerCase();
  if(t.includes('basic')) return 'Basic <base64(client_id:client_secret)>';
  if(t.includes('bearer') || t.includes('jwt') || t.includes('oauth')) return 'Bearer <token>';
  if(t.includes('api')) return '<api_key>';
  return (proj.auth && proj.auth.headerName)==='Authorization' ? 'Bearer <token>' : '<value>';
}

function headerList(proj, ep){
  const reveal = sensitiveRevealed();
  const headers = [];
  if(ep.requestBody) headers.push(['Content-Type', ep.contentType || 'application/json', '', true]);
  if(proj.auth && proj.auth.headerName){
    headers.push([proj.auth.headerName, authHeaderValue(proj), '', true]);
  }
  const hdrs = ep.headers || (ep.parameters||[]).filter(p=>p.in==='header');
  hdrs.forEach(p=>{
    let val = p.example || `<${p.name}>`;
    const rule = p.example ? piiRuleFor(p.name, p.example) : null;
    if(rule && !reveal) val = maskByStrategy(p.example, rule);
    headers.push([p.name, val, p.description || '', !!p.required]);
  });
  return headers;
}

function curlSample(proj, ep){
  const url = maskedFullUrl(proj, ep);
  const lines = [`# ${ep.summary || ep.method + ' ' + ep.path}`, `curl --location --request ${ep.method} "${url}" \\`];
  const hdrs = headerList(proj, ep);
  hdrs.forEach(([k,v], i)=>{
    const isLast = i === hdrs.length - 1 && !(ep.requestBody && ep.requestBody.example);
    lines.push(`  --header "${k}: ${v}"${isLast ? '' : ' \\'}`);
  });
  if(ep.requestBody && ep.requestBody.example){
    // Body PII is masked exactly like every other render surface (maskedJsonString) —
    // a code sample is still a place raw customer data could otherwise leak.
    lines.push(`  --data-raw '${maskedJsonString(ep.requestBody.example).replace(/'/g, "'\\''")}'`);
  }
  return lines.join('\n');
}

function jsonTypeToSchema(type){
  switch((type||'string').toLowerCase()){
    case 'integer': return 'integer';
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'array': return 'array';
    case 'object': return 'object';
    default: return 'string';
  }
}

function safeJsonParse(str){
  try{ return JSON.parse(str); }catch(e){ return {}; }
}

/* ---------- Expandable JSON tree viewer (used by the Request/Response inspector) ---------- */
// Distinct from safeJsonParse above (which silently falls back to {} for schema-building
// code that always wants an object) — this reports success/failure so the inspector can
// fall back to a plain "Raw" text view when the stored example isn't valid JSON.
function tryParseJson(str){
  if(str === undefined || str === null || str === '') return { ok:false };
  try{ return { ok:true, value: JSON.parse(str) }; }catch(e){ return { ok:false }; }
}

function jsonToTreeHtml(value, keyLabel, isRoot){
  const keyHtml = keyLabel !== null && keyLabel !== undefined ? `<span class="jt-key">${escapeHtml(keyLabel)}</span>: ` : '';
  if(value === null || value === undefined){
    return `<div class="jt-row">${keyHtml}<span class="jt-val jt-null">null</span></div>`;
  }
  if(Array.isArray(value)){
    if(!value.length) return `<div class="jt-row">${keyHtml}<span class="jt-brack">[ ]</span></div>`;
    const inner = value.map((v,i)=>jsonToTreeHtml(v, String(i), false)).join('');
    return `<details class="jt-node"${isRoot?' open':''}>
      <summary class="jt-summary">${keyHtml}<span class="jt-brack">[</span><span class="jt-count">${value.length} item${value.length===1?'':'s'}</span><span class="jt-brack">]</span></summary>
      <div class="jt-children">${inner}</div>
    </details>`;
  }
  if(typeof value === 'object'){
    const keys = Object.keys(value);
    if(!keys.length) return `<div class="jt-row">${keyHtml}<span class="jt-brack">{ }</span></div>`;
    const inner = keys.map(k=>jsonToTreeHtml(value[k], k, false)).join('');
    return `<details class="jt-node"${isRoot?' open':''}>
      <summary class="jt-summary">${keyHtml}<span class="jt-brack">{</span><span class="jt-count">${keys.length} key${keys.length===1?'':'s'}</span><span class="jt-brack">}</span></summary>
      <div class="jt-children">${inner}</div>
    </details>`;
  }
  let cls = 'jt-str', text = `"${value}"`;
  if(typeof value === 'number'){ cls = 'jt-num'; text = String(value); }
  else if(typeof value === 'boolean'){ cls = 'jt-bool'; text = String(value); }
  return `<div class="jt-row">${keyHtml}<span class="jt-val ${cls}">${escapeHtml(text)}</span></div>`;
}

// Renders the tree-view markup for a raw JSON string, or an empty-state message when the
// string is blank / not valid JSON.
function jsonTreeViewHtml(rawStr){
  const parsed = tryParseJson(rawStr);
  if(!parsed.ok) return `<div class="json-tree-empty">Not valid JSON — showing Raw view instead.</div>`;
  return `<div class="json-tree">${jsonToTreeHtml(parsed.value, null, true)}</div>`;
}

/* ---------- Professional YAML generation helpers ---------- */

// Turns "CORRELATION-ID" / "client_id" / "Authorization" into "CorrelationId" / "ClientId" / "Authorization"
function toPascalCase(name){
  return String(name||'param')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('') || 'Param';
}

// Builds a readable, unique operationId from method + path, e.g. GET /api/v1/create -> getApiV1Create
function toOperationId(method, path){
  const segs = String(path||'/').split('/').filter(Boolean).map(s=>s.replace(/[{}]/g,''));
  const camel = segs.map((s,i)=>{
    const p = toPascalCase(s);
    return i===0 ? (p.charAt(0).toLowerCase()+p.slice(1)) : p;
  }).join('');
  const base = camel || 'root';
  return (method||'get').toLowerCase() + base.charAt(0).toUpperCase() + base.slice(1);
}

// Recursively infers a JSON Schema (types, nested objects/arrays) from a real example value —
// this is what turns a flat "example" blob into proper request/response schemas.
function inferSchemaFromExample(value){
  if(value === null || value === undefined) return { type: 'string', nullable: true };
  if(Array.isArray(value)){
    return { type: 'array', items: value.length ? inferSchemaFromExample(value[0]) : { type: 'string' } };
  }
  const t = typeof value;
  if(t === 'object'){
    const keys = Object.keys(value);
    const properties = {};
    keys.forEach(k=>{ properties[k] = inferSchemaFromExample(value[k]); });
    return { type:'object', properties, ...(keys.length ? { required: keys } : {}) };
  }
  if(t === 'number') return { type: Number.isInteger(value) ? 'integer' : 'number' };
  if(t === 'boolean') return { type:'boolean' };
  return { type:'string' };
}

// Turns a display name like "Subscription renewal order" into a short camelCase
// key suitable for use under OpenAPI's `examples:` map.
function slugifyExampleKey(name, fallback){
  const camel = String(name||'').trim().split(/[^a-zA-Z0-9]+/).filter(Boolean)
    .map((w,i)=> i===0 ? w.charAt(0).toLowerCase()+w.slice(1) : w.charAt(0).toUpperCase()+w.slice(1).toLowerCase())
    .join('');
  return camel || fallback;
}

// Builds the `content` value (schema + example, or schema + examples map) for a
// request/response body. defaultValueStr is the always-present default JSON
// string; extraExamples is the optional array of {name, value} named variants
// collected from the "Additional examples" builder. When there are no named
// variants this stays as a simple singular `example:` (cleanest for the common
// single-example case); once the user adds variants it switches to a proper
// `examples:` map so tools like Swagger UI render a picker dropdown.
function buildExampleContent(defaultValueStr, extraExamples, defaultLabel){
  const defaultParsed = safeJsonParse(defaultValueStr);
  const extras = (extraExamples||[]).map(ex=>({ ...ex, parsed: safeJsonParse(ex.value) }));
  if(!extras.length){
    return { example: defaultParsed };
  }
  const examples = {};
  const usedKeys = new Set();
  const addEntry = (key, summary, value)=>{
    let k = key, n = 2;
    while(usedKeys.has(k)){ k = key + n; n++; }
    usedKeys.add(k);
    examples[k] = { summary, value };
  };
  addEntry(slugifyExampleKey(defaultLabel, 'default'), defaultLabel, defaultParsed);
  extras.forEach(ex=> addEntry(slugifyExampleKey(ex.name, 'example'), ex.name || 'Example', ex.parsed));
  return { examples };
}

// Maps a numeric HTTP status to its standard reason phrase, used to keep response
// descriptions consistent even if the user only typed a short note.
const HTTP_STATUS_TEXT = {
  200:'OK', 201:'Created', 202:'Accepted', 204:'No Content',
  400:'Bad Request', 401:'Unauthorized', 403:'Forbidden', 404:'Not Found',
  405:'Method Not Allowed', 409:'Conflict', 422:'Unprocessable Entity',
  429:'Too Many Requests', 500:'Internal Server Error', 502:'Bad Gateway',
  503:'Service Unavailable', 504:'Gateway Timeout',
};

function swaggerSample(proj, ep){
  const methodLower = (ep.method||'get').toLowerCase();
  const opId = toOperationId(ep.method, ep.path);
  const opTitle = opId.charAt(0).toUpperCase() + opId.slice(1);

  // Auth headers (e.g. Authorization / X-API-Key) aren't valid as plain OpenAPI header
  // parameters — tooling like Swagger Editor silently ignores them and warns. They
  // belong in components.securitySchemes + a security requirement instead.
  const AUTH_HEADER_RE = /^(authorization|x-api-key|api-key)$/i;
  const rawHeaders = ep.headers || [];
  const authHeader = rawHeaders.find(h => AUTH_HEADER_RE.test((h.name||'').trim()));
  const normalHeaders = rawHeaders.filter(h => !AUTH_HEADER_RE.test((h.name||'').trim()));

  const pathParams = (ep.parameters||[]).filter(p=>p.in==='path');
  const queryParams = (ep.parameters||[]).filter(p=>!p.in || p.in==='query');

  // Reusable header parameters — defined once under components.parameters and
  // referenced with $ref, instead of being repeated inline (what a hand-written
  // professional spec looks like once you have more than one endpoint sharing headers).
  const swaggerRevealed = sensitiveRevealed();
  const componentParams = {};
  const headerParamRefs = normalHeaders.map(h=>{
    const compName = toPascalCase(h.name) + 'Header';
    const maskThis = h.example && isSensitiveHeaderName(h.name) && !swaggerRevealed;
    componentParams[compName] = {
      name: h.name, in: 'header', required: !!h.required,
      description: h.description || undefined,
      schema: { type: jsonTypeToSchema(h.type) },
      example: maskThis ? maskSecretValue(h.example) : (h.example || undefined),
    };
    return { $ref: `#/components/parameters/${compName}` };
  });

  const inlineParams = [
    ...pathParams.map(p=>({
      name: p.name, in: 'path', required: true,
      description: p.description || undefined,
      schema: { type: jsonTypeToSchema(p.type) },
      example: p.example || undefined,
    })),
    ...queryParams.map(p=>({
      name: p.name, in: 'query', required: !!p.required,
      description: p.description || undefined,
      schema: { type: jsonTypeToSchema(p.type) },
      example: p.example || undefined,
    })),
  ];

  // OpenAPI 3.0 technically allows a requestBody on any method, including GET —
  // some real-world APIs (Razorpay's Create Order included) document a GET
  // endpoint that takes a JSON body. We used to strip the body on GET/HEAD/DELETE,
  // which silently dropped data the user had typed into "Request JSON structure."
  // Trust what's in the form instead of second-guessing the method.
  const bodyAllowed = methodLower !== 'head';

  // Security scheme — inferred from the project's configured auth type so a
  // "Basic auth" project produces `type: http, scheme: basic` instead of the
  // generic (and technically wrong) apiKey-in-header shape.
  const schemeName = 'ApiAuth';
  const authTypeText = ((proj.auth && proj.auth.type) || '').toLowerCase();
  let securityScheme = null;
  if(authHeader){
    if(authTypeText.includes('basic')){
      securityScheme = { type:'http', scheme:'basic', description: authHeader.description || 'HTTP Basic authentication credentials.' };
    } else if(authTypeText.includes('bearer') || authTypeText.includes('jwt') || authTypeText.includes('oauth')){
      securityScheme = { type:'http', scheme:'bearer', bearerFormat:'JWT', description: authHeader.description || 'Bearer token authentication.' };
    } else {
      securityScheme = { type:'apiKey', in:'header', name: authHeader.name || 'Authorization', description: authHeader.description || undefined };
    }
  }

  // Auth request/response parameters — documented in Project settings ▸ Auth and
  // opted into the exported spec via "Include in Swagger / OpenAPI". Carried as
  // x- extensions on the security scheme since OpenAPI has no native slot for
  // "what the token endpoint needs" / "what it returns".
  if(securityScheme && proj.auth && proj.auth.includeInSwagger){
    const swaggerAuthParam = (p)=>({
      name: p.name, type: p.type || 'String', required: !!p.required,
      ...(p.example ? { example: p.example } : {}),
      ...(p.description ? { description: p.description } : {}),
    });
    const authReqP = (proj.auth.requestParams || []).filter(p=>p.name);
    const authRespP = (proj.auth.responseParams || []).filter(p=>p.name);
    if(authReqP.length) securityScheme['x-request-parameters'] = authReqP.map(swaggerAuthParam);
    if(authRespP.length) securityScheme['x-response-parameters'] = authRespP.map(swaggerAuthParam);
  }

  // Named, reusable schemas — inferred from the real request/response examples —
  // instead of a bare `type: object` with only an inline example.
  const schemas = {};
  let requestBodySpec;
  if(bodyAllowed && ep.requestBody && ep.requestBody.example){
    const parsed = safeJsonParse(ep.requestBody.example);
    const schemaName = `${opTitle}Request`;
    schemas[schemaName] = inferSchemaFromExample(parsed);
    const exampleContent = buildExampleContent(ep.requestBody.example, ep.requestBody.examples, 'Default');
    requestBodySpec = {
      required: true,
      description: 'Request payload for this operation.',
      content: {
        [ep.contentType || 'application/json']: {
          schema: { $ref: `#/components/schemas/${schemaName}` },
          ...exampleContent,
        }
      }
    };
  }

  const responses = (ep.responses && ep.responses.length) ? ep.responses.reduce((acc, r)=>{
    const code = String(r.code);
    const parsed = r.example ? safeJsonParse(r.example) : null;
    const statusText = HTTP_STATUS_TEXT[Number(code)] || '';
    const description = (r.description && r.description.trim()) || statusText || `Response ${code}`;
    const entry = { description };
    if(parsed && Object.keys(parsed).length){
      const schemaName = `${opTitle}${code}Response`;
      schemas[schemaName] = inferSchemaFromExample(parsed);
      const exampleContent = buildExampleContent(r.example, r.examples, statusText || 'Default');
      entry.content = {
        'application/json': {
          schema: { $ref: `#/components/schemas/${schemaName}` },
          ...exampleContent,
        }
      };
    }
    acc[code] = entry;
    return acc;
  }, {}) : { '200': { description: 'OK' } };

  // Servers — every environment the project has a URL configured for, not just
  // whichever one happens to be selected right now. Hosts are shown as environment
  // variable tokens (e.g. "{{SIT-DNS}}") unless an Admin has revealed real values —
  // the resolved host is sensitive and shouldn't leak through an exported spec.
  const envList = environments();
  let servers = envList
    .filter(e => proj.environments && proj.environments[e.id])
    .map(e => ({ url: swaggerRevealed ? proj.environments[e.id].replace(/\/$/,'') : envVarToken(e.id), description: `${e.label} environment` }));
  if(!servers.length){
    servers = [{ url: swaggerRevealed ? ((proj.environments && proj.environments[state.env]) || 'https://api.example.com') : envVarToken(state.env), description: `${state.env} environment` }];
  }

  const doc = {
    openapi: '3.0.3',
    info: {
      title: proj.name || 'Untitled API',
      description: proj.description || undefined,
      version: ep.version || '1.0.0',
      ...(proj.termsOfService ? { termsOfService: proj.termsOfService } : {}),
      ...((proj.contact && (proj.contact.name || proj.contact.email)) ? {
        contact: {
          ...(proj.contact.name ? { name: proj.contact.name } : {}),
          ...(proj.contact.email ? { email: proj.contact.email } : {}),
        }
      } : {}),
      ...((proj.license && proj.license.name) ? {
        license: {
          name: proj.license.name,
          ...(proj.license.url ? { url: proj.license.url } : {}),
        }
      } : {}),
      ...(proj.owner ? { 'x-owner': proj.owner } : {}),
      ...(proj.team ? { 'x-team': proj.team } : {}),
      ...(proj.lifecycle ? { 'x-lifecycle': proj.lifecycle } : {}),
    },
    servers,
    tags: [{ name: ep.tag || 'General', description: `Operations related to ${ep.tag || 'General'}.` }],
    paths: {
      [ep.path]: {
        [methodLower]: {
          tags: [ep.tag || 'General'],
          operationId: opId,
          summary: ep.summary || '',
          description: ep.description || undefined,
          ...(securityScheme ? { security: [{ [schemeName]: [] }] } : {}),
          parameters: [...headerParamRefs, ...inlineParams],
          ...(requestBodySpec ? { requestBody: requestBodySpec } : {}),
          responses,
        }
      }
    },
    components: {
      ...(Object.keys(componentParams).length ? { parameters: componentParams } : {}),
      ...(Object.keys(schemas).length ? { schemas } : {}),
      ...(securityScheme ? { securitySchemes: { [schemeName]: securityScheme } } : {}),
    },
  };

  try{
    const banner = `# ${proj.name || 'Untitled API'} — ${ep.method} ${ep.path}\n# Generated by DocTracker\n\n`;
    return banner + jsyaml.dump(doc, { noRefs:true, skipInvalid:true, lineWidth:-1 });
  }catch(e){
    return '# Could not generate YAML for this endpoint';
  }
}

function codeSample(lang, proj, ep){
  if(lang === 'curl') return curlSample(proj, ep);
  if(lang === 'swagger') return swaggerSample(proj, ep);
  return '';
}
