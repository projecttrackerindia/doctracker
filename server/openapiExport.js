const yaml = require('js-yaml');

// Server-side port of the relevant pieces of the client-side YAML generator
// (see swaggerSample() in server/views/studio.html). That version renders ONE
// endpoint at a time and is allowed to show real, unmasked values once an
// Admin has "revealed" sensitive data in their own session — it's rendered
// into a page only the signed-in user ever sees.
//
// This version is different on purpose: it builds ALL of a project's
// endpoints into a single combined spec, and it is served from a public,
// unauthenticated URL (see the "Open in Swagger Editor" share-link feature —
// server/routes/workspace.js mints the token, server/server.js serves it).
// Because of that, masking here is NOT conditional on any "revealed" state —
// it is always on. There is no viewer identity to gate against on a request
// that could come from anywhere.

const AUTH_HEADER_RE = /^(authorization|x-api-key|api-key)$/i;

function isSensitiveHeaderName(name) {
  const n = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!n) return false;
  return /secret|password|passwd|privatekey|apikey|clientid|authorization|token|credential/.test(n);
}

function maskSecretValue(val) {
  const s = String(val == null ? '' : val);
  if (!s) return s;
  if (s.length <= 6) return '\u2022'.repeat(Math.max(s.length, 4));
  const head = s.slice(0, Math.min(6, Math.ceil(s.length * 0.3)));
  const tail = s.slice(-Math.min(5, Math.ceil(s.length * 0.25)));
  const midLen = Math.max(5, Math.min(9, s.length - head.length - tail.length));
  return head + '*'.repeat(midLen) + tail;
}

function envVarToken(envId) {
  return `{{${envId}-DNS}}`;
}

function jsonTypeToSchema(type) {
  switch (String(type || 'string').toLowerCase()) {
    case 'integer': return 'integer';
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'array': return 'array';
    case 'object': return 'object';
    default: return 'string';
  }
}

function safeJsonParse(str) {
  try { return JSON.parse(str); } catch (e) { return {}; }
}

function toPascalCase(name) {
  return String(name || 'param')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('') || 'Param';
}

function toOperationId(method, path) {
  const segs = String(path || '/').split('/').filter(Boolean).map((s) => s.replace(/[{}]/g, ''));
  const camel = segs.map((s, i) => {
    const p = toPascalCase(s);
    return i === 0 ? p.charAt(0).toLowerCase() + p.slice(1) : p;
  }).join('');
  const base = camel || 'root';
  return (method || 'get').toLowerCase() + base.charAt(0).toUpperCase() + base.slice(1);
}

function inferSchemaFromExample(value) {
  if (value === null || value === undefined) return { type: 'string', nullable: true };
  if (Array.isArray(value)) {
    return { type: 'array', items: value.length ? inferSchemaFromExample(value[0]) : { type: 'string' } };
  }
  const t = typeof value;
  if (t === 'object') {
    const keys = Object.keys(value);
    const properties = {};
    keys.forEach((k) => { properties[k] = inferSchemaFromExample(value[k]); });
    return { type: 'object', properties, ...(keys.length ? { required: keys } : {}) };
  }
  if (t === 'number') return { type: Number.isInteger(value) ? 'integer' : 'number' };
  if (t === 'boolean') return { type: 'boolean' };
  return { type: 'string' };
}

const HTTP_STATUS_TEXT = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
  405: 'Method Not Allowed', 409: 'Conflict', 422: 'Unprocessable Entity',
  429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway',
  503: 'Service Unavailable', 504: 'Gateway Timeout',
};

// Builds one OpenAPI `operation` object (+ any schemas/parameters it needs
// registered in components) for a single endpoint. Always masks sensitive
// header examples — there's no "revealed" branch here, unlike the client
// version, because this spec can leave the building.
function buildOperation(ep, schemas, componentParams) {
  const methodLower = (ep.method || 'get').toLowerCase();
  const opId = toOperationId(ep.method, ep.path);
  const opTitle = opId.charAt(0).toUpperCase() + opId.slice(1);

  const rawHeaders = ep.headers || [];
  const authHeader = rawHeaders.find((h) => AUTH_HEADER_RE.test((h.name || '').trim()));
  const normalHeaders = rawHeaders.filter((h) => !AUTH_HEADER_RE.test((h.name || '').trim()));

  const pathParams = (ep.parameters || []).filter((p) => p.in === 'path');
  const queryParams = (ep.parameters || []).filter((p) => !p.in || p.in === 'query');

  const headerParamRefs = normalHeaders.map((h) => {
    const compName = toPascalCase(h.name) + 'Header';
    const maskThis = h.example && isSensitiveHeaderName(h.name);
    componentParams[compName] = {
      name: h.name, in: 'header', required: !!h.required,
      description: h.description || undefined,
      schema: { type: jsonTypeToSchema(h.type) },
      example: maskThis ? maskSecretValue(h.example) : (h.example || undefined),
    };
    return { $ref: `#/components/parameters/${compName}` };
  });

  const inlineParams = [
    ...pathParams.map((p) => ({
      name: p.name, in: 'path', required: true,
      description: p.description || undefined,
      schema: { type: jsonTypeToSchema(p.type) },
      example: p.example || undefined,
    })),
    ...queryParams.map((p) => ({
      name: p.name, in: 'query', required: !!p.required,
      description: p.description || undefined,
      schema: { type: jsonTypeToSchema(p.type) },
      example: p.example || undefined,
    })),
  ];

  const bodyAllowed = methodLower !== 'head';
  let requestBodySpec;
  if (bodyAllowed && ep.requestBody && ep.requestBody.example) {
    const parsed = safeJsonParse(ep.requestBody.example);
    const schemaName = `${opTitle}Request`;
    schemas[schemaName] = inferSchemaFromExample(parsed);
    requestBodySpec = {
      required: true,
      description: 'Request payload for this operation.',
      content: {
        [ep.contentType || 'application/json']: {
          schema: { $ref: `#/components/schemas/${schemaName}` },
          example: parsed,
        },
      },
    };
  }

  const responses = (ep.responses && ep.responses.length) ? ep.responses.reduce((acc, r) => {
    const code = String(r.code);
    const parsed = r.example ? safeJsonParse(r.example) : null;
    const statusText = HTTP_STATUS_TEXT[Number(code)] || '';
    const description = (r.description && r.description.trim()) || statusText || `Response ${code}`;
    const entry = { description };
    if (parsed && Object.keys(parsed).length) {
      const schemaName = `${opTitle}${code}Response`;
      schemas[schemaName] = inferSchemaFromExample(parsed);
      entry.content = {
        'application/json': {
          schema: { $ref: `#/components/schemas/${schemaName}` },
          example: parsed,
        },
      };
    }
    acc[code] = entry;
    return acc;
  }, {}) : { 200: { description: 'OK' } };

  return {
    hasAuthHeader: !!authHeader,
    operation: {
      tags: [ep.tag || 'General'],
      operationId: opId,
      summary: ep.summary || '',
      description: ep.description || undefined,
      parameters: [...headerParamRefs, ...inlineParams],
      ...(requestBodySpec ? { requestBody: requestBodySpec } : {}),
      responses,
    },
    methodLower,
  };
}

// Builds the full multi-endpoint spec for one project and returns it as a
// YAML string, ready to serve as a static file. `envList` is the org's
// environment list (id/label pairs) — hosts are always shown as
// {{ENV-ID-DNS}} tokens, never resolved to a real URL.
function buildProjectOpenApiSpecYaml(proj, envList) {
  const endpoints = Array.isArray(proj.endpoints) ? proj.endpoints : [];
  const schemas = {};
  const componentParams = {};
  const paths = {};
  const tagNames = new Set();
  let anyAuthHeader = false;

  for (const ep of endpoints) {
    if (!ep || !ep.path) continue;
    const { operation, methodLower, hasAuthHeader } = buildOperation(ep, schemas, componentParams);
    if (hasAuthHeader) anyAuthHeader = true;
    tagNames.add(ep.tag || 'General');
    if (!paths[ep.path]) paths[ep.path] = {};
    paths[ep.path][methodLower] = operation;
  }

  const schemeName = 'ApiAuth';
  const authTypeText = ((proj.auth && proj.auth.type) || '').toLowerCase();
  let securityScheme = null;
  if (anyAuthHeader) {
    if (authTypeText.includes('basic')) {
      securityScheme = { type: 'http', scheme: 'basic', description: (proj.auth && proj.auth.description) || 'HTTP Basic authentication credentials.' };
    } else if (authTypeText.includes('bearer') || authTypeText.includes('jwt') || authTypeText.includes('oauth')) {
      securityScheme = { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: (proj.auth && proj.auth.description) || 'Bearer token authentication.' };
    } else {
      securityScheme = { type: 'apiKey', in: 'header', name: (proj.auth && proj.auth.headerName) || 'Authorization', description: (proj.auth && proj.auth.description) || undefined };
    }
    // Apply the shared security requirement to every operation that had an
    // auth-shaped header — same rule the client-side generator uses per endpoint.
    for (const ep of endpoints) {
      if (!ep || !ep.path) continue;
      const rawHeaders = ep.headers || [];
      const hasAuth = rawHeaders.some((h) => AUTH_HEADER_RE.test((h.name || '').trim()));
      if (hasAuth) {
        const methodLower = (ep.method || 'get').toLowerCase();
        if (paths[ep.path] && paths[ep.path][methodLower]) {
          paths[ep.path][methodLower].security = [{ [schemeName]: [] }];
        }
      }
    }
    if (proj.auth && proj.auth.includeInSwagger) {
      const swaggerAuthParam = (p) => ({
        name: p.name, type: p.type || 'String', required: !!p.required,
        ...(p.example ? { example: p.example } : {}),
        ...(p.description ? { description: p.description } : {}),
      });
      const authReqP = ((proj.auth.requestParams) || []).filter((p) => p.name);
      const authRespP = ((proj.auth.responseParams) || []).filter((p) => p.name);
      if (authReqP.length) securityScheme['x-request-parameters'] = authReqP.map(swaggerAuthParam);
      if (authRespP.length) securityScheme['x-response-parameters'] = authRespP.map(swaggerAuthParam);
    }
  }

  const servers = (Array.isArray(envList) && envList.length)
    ? envList
        .filter((e) => proj.environments && proj.environments[e.id])
        .map((e) => ({ url: envVarToken(e.id), description: `${e.label} environment` }))
    : [];
  if (!servers.length) servers.push({ url: 'https://api.example.com', description: 'Default environment' });

  const doc = {
    openapi: '3.0.3',
    info: {
      title: proj.name || 'Untitled API',
      description: proj.description || undefined,
      version: '1.0.0',
      ...(proj.termsOfService ? { termsOfService: proj.termsOfService } : {}),
      ...((proj.contact && (proj.contact.name || proj.contact.email)) ? {
        contact: {
          ...(proj.contact.name ? { name: proj.contact.name } : {}),
          ...(proj.contact.email ? { email: proj.contact.email } : {}),
        },
      } : {}),
      ...((proj.license && proj.license.name) ? {
        license: { name: proj.license.name, ...(proj.license.url ? { url: proj.license.url } : {}) },
      } : {}),
      ...(proj.owner ? { 'x-owner': proj.owner } : {}),
      ...(proj.team ? { 'x-team': proj.team } : {}),
      ...(proj.lifecycle ? { 'x-lifecycle': proj.lifecycle } : {}),
    },
    servers,
    tags: Array.from(tagNames).map((t) => ({ name: t, description: `Operations related to ${t}.` })),
    paths,
    components: {
      ...(Object.keys(componentParams).length ? { parameters: componentParams } : {}),
      ...(Object.keys(schemas).length ? { schemas } : {}),
      ...(securityScheme ? { securitySchemes: { [schemeName]: securityScheme } } : {}),
    },
  };

  const banner = `# ${proj.name || 'Untitled API'} — full project spec\n`
    + `# Generated by API Studio — shared link, hosts and secrets are always masked.\n\n`;
  try {
    return banner + yaml.dump(doc, { noRefs: true, skipInvalid: true, lineWidth: -1 });
  } catch (e) {
    return `${banner}# Could not generate this project's OpenAPI spec.\n`;
  }
}

module.exports = { buildProjectOpenApiSpecYaml };
