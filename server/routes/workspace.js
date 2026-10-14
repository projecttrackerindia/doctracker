const express = require('express');
const { pool } = require('../db');
const { authenticate, requireAdmin, blockIfScheduleLocked } = require('../middleware/authGuard');
const { recordAuditEvent } = require('../auditService');
const dataCrypto = require('../crypto');
const storage = require('../storage');
const cache = require('../cache');
const { resolveAccessById, environmentAllowed, grantCoversEnvironment } = require('../projectAccess');
const { notifyUser } = require('../notifications');
const piiMasking = require('../piiMasking');
const { validateOutboundUrlSync } = require('../urlSafety');

const router = express.Router();
router.use(authenticate);
router.use(blockIfScheduleLocked); // outside your admin-set hours/days, the whole workspace API is locked

const MAX_PROJECTS_PER_SAVE = 200;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024; // hard server-side cap per file (base64 dataUrl length)
const MAX_PROJECT_ATTACHMENT_BYTES = 40 * 1024 * 1024; // hard server-side cap for a project's attachments combined
const MAX_CUSTOM_ICON_BYTES = 300 * 1024; // per-icon logo cap — these render inline at badge size, no need for 8MB attachments
const MAX_CUSTOM_ICONS = 60; // per organisation
const MAX_BRAND_LOGO_BYTES = 250 * 1024; // org letterhead logo — mirrors the client-side cap in 12-security-center.js

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

// SECURITY (Finding 4.2): server-side counterpart of the org's admin-defined
// PII rules, used to mask example values before they're ever sent to the
// browser — see server/piiMasking.js. Read fresh per-request rather than
// cached in-process; this is an Admin-editable security control, and every
// read path that shows example values needs to reflect a rule change
// immediately, not after some arbitrary TTL.
async function getOrgPiiRules(org) {
  const { rows } = await pool.query(
    `SELECT field_name AS "fieldName", match_mode AS "matchMode", masking_strategy AS "maskingStrategy",
            mask_char AS "maskChar", enabled
     FROM pii_field_rules WHERE organisation = $1`,
    [org]
  );
  return rows;
}

// MAX_ATTACHMENT_BYTES was previously defined but never actually checked
// anywhere — the only real limit in force was the 25mb express.json() body
// cap on the whole request. This enforces both the per-file and
// per-project totals server-side. Returns an error string, or null if the
// project's attachments are within bounds.
// SECURITY (Finding 4.3 — SSRF): a project's `environments` map (env id ->
// base URL) previously had no validation at all anywhere in this file.
// Rejects a URL only if it's clearly dangerous (bad scheme, localhost, a
// literal private/loopback/link-local/metadata IP) — this is the cheap,
// synchronous, save-time gate. Returns an error string, or null if every
// entry is fine.
function environmentUrlError(projectData) {
  const envs = projectData && projectData.environments;
  if (!envs || typeof envs !== 'object') return null;
  for (const [envId, url] of Object.entries(envs)) {
    if (!url) continue; // empty/unset is fine — nothing to validate
    const result = validateOutboundUrlSync(url);
    if (!result.valid) {
      return `Environment "${envId}" has an invalid base URL: ${result.reason}`;
    }
  }
  return null;
}

function attachmentSizeError(projectData) {
  const attachments = Array.isArray(projectData && projectData.attachments) ? projectData.attachments : [];
  let total = 0;
  for (const att of attachments) {
    // Inline (not-yet-offloaded) attachments are measured by their raw
    // dataUrl length; already-offloaded ones (storageKey, no dataUrl) are
    // measured by their recorded `size` so the per-project quota still
    // means something once object storage is in use.
    const len = att && typeof att.dataUrl === 'string' ? att.dataUrl.length : (att && Number(att.size)) || 0;
    if (att && typeof att.dataUrl === 'string' && len > MAX_ATTACHMENT_BYTES) {
      return `Attachment "${(att && att.name) || 'file'}" is too large (max ${Math.floor(MAX_ATTACHMENT_BYTES / (1024 * 1024))}MB per file).`;
    }
    total += len;
  }
  if (total > MAX_PROJECT_ATTACHMENT_BYTES) {
    return `This project's attachments total ${Math.round(total / (1024 * 1024))}MB, over the ${Math.floor(MAX_PROJECT_ATTACHMENT_BYTES / (1024 * 1024))}MB per-project limit.`;
  }
  return null;
}

// An endpoint's identity in the editor's URL (edit.studio) and everywhere
// else it's looked up by "slug" is derived purely from method+path (see
// endpointSlug() in editor.html) — endpoints don't carry a human-visible
// identity of their own. Two endpoints sharing a method+path within the
// same project therefore become indistinguishable by that lookup: whichever
// one a client-side `.find()` happens to hit first silently wins, and the
// other becomes an orphaned duplicate that's only reachable by scrolling to
// it in the endpoint list — never by the URL its own "Edit" button would
// build. This is the server-side guard against creating that collision in
// the first place (the editor also checks client-side, for faster
// feedback, but this is the one enforced everywhere, since PUT /projects is
// also used by imports, promotions, and the quick "Add endpoint" modal).
// Returns an error string, or null if every method+path in this project is
// unique.
// QA regression (2026-09-26, bug #1, High): matched exact method+path only,
// so a trailing slash (or a case difference) slipped past this check as a
// "different" endpoint. That matters beyond cosmetics: the editor's own
// endpointSlugFor()/slugify() (19-audit-log-page.js) lowercases the path and
// collapses a trailing slash into nothing when building that endpoint's URL
// - so /qa/test-endpoint and /qa/test-endpoint/ (or a differently-cased
// path) already resolve to the SAME page address on the client, even though
// the server just accepted them as two distinct endpoints. Whichever one
// happened to render there "won"; the other became permanently unreachable
// by its own link. Normalizing the same way the slug generator effectively
// does (case-insensitive, trailing slash ignored) before comparing closes
// this at the source: two paths that would collide on a URL are now
// rejected as the duplicate they actually are, so the collision can never
// be saved in the first place.
function normalizedEndpointPathKey(path) {
  let p = String(path).trim().toLowerCase();
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

function duplicateEndpointError(projectData) {
  const endpoints = Array.isArray(projectData && projectData.endpoints) ? projectData.endpoints : [];
  const seen = new Set();
  for (const ep of endpoints) {
    if (!ep || !ep.method || !ep.path) continue;
    const method = String(ep.method).toUpperCase();
    const key = `${method} ${normalizedEndpointPathKey(ep.path)}`;
    if (seen.has(key)) {
      return `This project already has two endpoints for ${method} ${String(ep.path).trim()} (a trailing slash or letter case doesn't make it a different endpoint) — give one a different path, or delete the duplicate before saving.`;
    }
    seen.add(key);
  }
  return null;
}

const MAX_ENDPOINT_NAME_LENGTH = 150;

// QA regression (2026-09-26, bugs #3/#4/#5/#13): the editor's own client-side
// checks (server/views/editor.html's performSave()) only ever confirmed the
// path field wasn't EMPTY — nothing there enforced a leading slash, rejected
// whitespace inside the path, capped the endpoint name's length, or
// constrained a response's status code to a real HTTP status range. All four
// saved successfully because nothing server-side checked them either. Client
// -side validation is UX, not a gate — it can always be bypassed by calling
// the API directly — so this is the one place that actually has to enforce
// it.
function endpointFieldsError(projectData) {
  const endpoints = Array.isArray(projectData && projectData.endpoints) ? projectData.endpoints : [];
  for (const ep of endpoints) {
    if (!ep) continue;
    if (typeof ep.path === 'string' && ep.path.trim()) {
      const path = ep.path.trim();
      if (!path.startsWith('/')) return `Path "${path}" must start with /.`;
      if (/\s/.test(path)) return `Path "${path}" can't contain spaces or other whitespace.`;
    }
    if (typeof ep.name === 'string' && ep.name.length > MAX_ENDPOINT_NAME_LENGTH) {
      return `Endpoint name is too long (${ep.name.length} characters, max ${MAX_ENDPOINT_NAME_LENGTH}).`;
    }
    const responses = Array.isArray(ep.responses) ? ep.responses : [];
    for (const r of responses) {
      if (!r || r.code === undefined || r.code === null || r.code === '') continue;
      const n = Number(r.code);
      if (!Number.isInteger(n) || n < 100 || n > 599) {
        return `Response status code "${r.code}" on ${String(ep.method || '').toUpperCase()} ${ep.path || ''} must be a whole number from 100 to 599.`;
      }
    }
  }
  return null;
}

// Kept in sync with `projects.has_public_endpoint` on every write, so
// GET /api/workspace can filter fully-private projects out in SQL instead of
// fetching + decrypting every project in the organisation. See db.js for the
// column/index and the comment on the GET /api/workspace query below.
function computeHasPublicEndpoint(projectData) {
  return Array.isArray(projectData && projectData.endpoints)
    && projectData.endpoints.some((ep) => ep && ep.visibility === 'public');
}

// Moves any newly-uploaded attachment (still carrying its raw base64
// `dataUrl` from the browser) out of the project blob and into S3-compatible
// object storage — see storage.js for why. Attachments already offloaded on
// a previous save (no `dataUrl`, just a `storageKey`) are left untouched. If
// object storage isn't configured (storage.isEnabled() === false), this is a
// no-op and attachments keep working exactly as before, inline.
async function offloadAttachments(projectData, projectId) {
  if (!storage.isEnabled()) return;
  const attachments = Array.isArray(projectData.attachments) ? projectData.attachments : [];
  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i];
    if (!att || typeof att.dataUrl !== 'string') continue; // already offloaded, or malformed — leave alone
    const match = /^data:([^;]+);base64,(.+)$/s.exec(att.dataUrl);
    const buffer = Buffer.from(match ? match[2] : att.dataUrl, 'base64');
    const uploaded = await storage.uploadAttachment({
      projectId,
      name: att.name,
      contentType: att.type || (match ? match[1] : 'application/octet-stream'),
      buffer,
    });
    attachments[i] = {
      id: att.id, name: att.name, size: att.size, type: att.type,
      uploadedAt: att.uploadedAt, uploadedBy: att.uploadedBy,
      storageKey: uploaded.storageKey,
    };
  }
}

// ----------------------------------------------------------------------------
// Encryption-at-rest helpers.
//
// `projects.data` (endpoint definitions, sample params/headers/bodies,
// attachments) and `org_workspace.environments` / `.request_history` (hosts,
// tokens, captured "Try it" requests) are the columns that can carry real
// customer secrets, so — unlike `organisation`/`username`/`email`, which stay
// plaintext because the app has to query/index on them — these are encrypted
// before they ever reach Postgres and decrypted only in server memory, per
// request, for the authenticated caller. See server/crypto.js for the key
// management underneath this (envelope encryption, Admin-rotatable DEK).
//
// Each row remembers which key version protected it (`*_key_version`) so
// rotating the active key never breaks reading older rows. The legacy JSONB
// columns (`data`, `environments`, `request_history`) are left in place only
// so pre-encryption rows already on disk keep working; a small placeholder is
// written there going forward instead of real content.
function encryptProjectData(obj, projectId) {
  const enc = dataCrypto.encryptField(JSON.stringify(obj), `project:${projectId}`);
  return { legacyPlaceholder: JSON.stringify({ _encrypted: true }), enc, version: dataCrypto.currentKeyVersion() };
}
function decryptProjectData(row) {
  if (row.data_enc) {
    const json = dataCrypto.decryptField(row.data_enc, `project:${row.id}`);
    return JSON.parse(json);
  }
  return row.data || {}; // pre-encryption legacy row
}
function encryptOrgBlob(obj, org, purpose) {
  const enc = dataCrypto.encryptField(JSON.stringify(obj), `org:${org}:${purpose}`);
  return { enc, version: dataCrypto.currentKeyVersion() };
}
function decryptOrgBlob(encValue, legacyValue, org, purpose, fallback) {
  if (encValue) {
    try {
      return JSON.parse(dataCrypto.decryptField(encValue, `org:${org}:${purpose}`));
    } catch (err) {
      console.error(`Failed to decrypt org_workspace.${purpose} for ${org}:`, err);
      return fallback;
    }
  }
  return legacyValue != null ? legacyValue : fallback; // pre-encryption legacy row
}

// Re-encrypts every project + the org_workspace row for one organisation under
// whatever the CURRENT active key is. Used right after an Admin rotates the
// key and wants existing data moved off the old key immediately rather than
// waiting for it to be upgraded lazily on next save (see routes/security.js).
//
// Previously this ran as ONE transaction holding `FOR UPDATE` locks across
// every project row in the organisation for the whole duration, and
// routes/security.js awaited it synchronously inside the HTTP request —
// for an organisation with a lot of projects this could block every other
// save to that org for a long time and risk the request itself timing out.
// Now each row is re-encrypted in its own single-statement update (so a
// lock is only ever held for that one row, for that one statement), and
// the WHERE clause only applies the update if the row's key version hasn't
// already moved on since we read it — if a normal save (or a concurrent
// call to this same function) touched the row in between, we just skip it
// rather than clobber a newer write with stale re-encrypted content.
// security.js now calls this in the background instead of awaiting it.
async function reencryptOrganisation(organisation) {
  let projectsTouched = 0;
  const { rows: projectRows } = await pool.query(
    `SELECT id, data, data_enc, data_key_version FROM projects WHERE organisation = $1`,
    [organisation]
  );
  for (const row of projectRows) {
    const plain = decryptProjectData(row);
    const { legacyPlaceholder, enc, version } = encryptProjectData(plain, row.id);
    const result = await pool.query(
      `UPDATE projects SET data = $1::jsonb, data_enc = $2, data_key_version = $3
       WHERE id = $4 AND data_key_version IS NOT DISTINCT FROM $5`,
      [legacyPlaceholder, enc, version, row.id, row.data_key_version]
    );
    if (result.rowCount) projectsTouched++;
  }

  const { rows: wsRows } = await pool.query(
    `SELECT environments, environments_enc, request_history, request_history_enc,
            tryit_collections_enc, environments_key_version,
            request_history_key_version, tryit_collections_key_version
     FROM org_workspace WHERE organisation = $1`,
    [organisation]
  );
  if (wsRows.length) {
    const ws = wsRows[0];
    const envPlain = decryptOrgBlob(ws.environments_enc, ws.environments, organisation, 'environments', []);
    const histPlain = decryptOrgBlob(ws.request_history_enc, ws.request_history, organisation, 'request_history', {});
    const tryitPlain = decryptOrgBlob(ws.tryit_collections_enc, null, organisation, 'tryit_collections', { variables: [], saved: [] });
    const envEnc = encryptOrgBlob(envPlain, organisation, 'environments');
    const histEnc = encryptOrgBlob(histPlain, organisation, 'request_history');
    const tryitEnc = encryptOrgBlob(tryitPlain, organisation, 'tryit_collections');
    await pool.query(
      `UPDATE org_workspace SET
         environments = '[]'::jsonb, environments_enc = $1, environments_key_version = $2,
         request_history = '{}'::jsonb, request_history_enc = $3, request_history_key_version = $4,
         tryit_collections_enc = $5, tryit_collections_key_version = $6
       WHERE organisation = $7
         AND environments_key_version IS NOT DISTINCT FROM $8
         AND request_history_key_version IS NOT DISTINCT FROM $9
         AND tryit_collections_key_version IS NOT DISTINCT FROM $10`,
      [envEnc.enc, envEnc.version, histEnc.enc, histEnc.version, tryitEnc.enc, tryitEnc.version,
        organisation, ws.environments_key_version, ws.request_history_key_version, ws.tryit_collections_key_version]
    );
  }
  return { projects: projectsTouched, orgWorkspace: true };
}

// A project is visible in full only to its owner, OR to someone holding a
// named project_access grant (see server/projectAccess.js) — a grant means
// "share the whole project with this person," same as an owner would see it,
// gated only by `_readonly` (view-only grants can't be saved back) and
// `_grantedEnvironments` (which of the project's environments this person may
// actually use in Try It — enforced at THOSE call sites, not here, since
// endpoints themselves aren't per-environment).
// Everyone else in the same organisation gets the old stripped-down view:
// only `public` endpoints survive, and attachments/diagram (project-level,
// not per-endpoint) only survive if the whole project is public. Different
// organisation => caller never sees the row at all (filtered out in SQL).
function projectForViewer(row, viewerId, data, grant) {
  data = data || {};
  // Server-authoritative save version, stamped fresh on every write (see the
  // ON CONFLICT ... updated_at = now() in PUT /projects below) and always
  // recomputed here regardless of whatever a client last echoed back in its
  // own payload — see the PUT handler's conflict check for what this guards
  // against (two tabs/edits racing on the same project).
  const rev = row.updated_at ? new Date(row.updated_at).toISOString() : null;
  const isOwner = row.owner_id === viewerId;
  if (isOwner) {
    return { ...data, id: row.id, visibility: row.visibility, _owned: true, _rev: rev };
  }
  if (grant) {
    const envs = Array.isArray(grant.environments) ? grant.environments : [];
    return {
      ...data,
      id: row.id,
      visibility: row.visibility,
      _owned: false,
      _readonly: grant.permission !== 'edit',
      _grantedEnvironments: envs.includes('*') ? 'all' : envs,
      _rev: rev,
    };
  }
  const endpoints = Array.isArray(data.endpoints)
    ? data.endpoints.filter((ep) => ep && ep.visibility === 'public')
    : [];
  const attachments = row.visibility === 'public' && Array.isArray(data.attachments) ? data.attachments : [];
  // Same rule as attachments: the architecture diagram is project-level (not
  // per-endpoint), so it only follows a project into a viewer's workspace
  // when the whole project is public — never via the has_public_endpoint
  // loophole that lets an otherwise-private project's public endpoints show up here.
  const architectureDiagram = row.visibility === 'public' ? data.architectureDiagram : undefined;
  // SECURITY: `environments` (real DEV/UAT/PROD base URLs) was missing from
  // this list entirely — the `...data` spread below let it straight through
  // to ANY org member who can see this project via the public catalog, even
  // one with zero endpoints unlocked yet, completely bypassing the per-
  // endpoint doc-access-request system this whole branch exists to enforce.
  // Same "only if the whole project is public" rule as attachments/diagram;
  // real hosts otherwise never belong in a payload sent to someone who
  // isn't the owner or an explicit project_access grantee.
  const environments = row.visibility === 'public' ? data.environments : {};
  return { ...data, id: row.id, visibility: row.visibility, endpoints, attachments, architectureDiagram, environments, _owned: false, _readonly: true };
}

// ---- Per-endpoint documentation access locking ----
// Applies ONLY to the "sees it purely because it's public in the org"
// branch of projectForViewer above — ownership and an explicit
// project_access share are already a deliberate, one-time grant from an
// owner/Admin and are never gated further here. This is the self-service
// side: browsing the org-wide public catalog shows every endpoint exists
// (method/path/tag/summary), but the full documentation (headers,
// parameters, request/response bodies, custom sections) of any one endpoint
// stays redacted until the viewer has an active, time-boxed grant. See
// server/routes/docAccess.js for the request/approve/deny/revoke API this
// backs, and db.js for the doc_access_requests table itself.
//
// Deliberately enforced HERE, server-side, rather than left to the frontend
// to hide — the frontend never receives the locked fields at all, so there's
// nothing for a browser's network tab or dev console to expose regardless
// of how the UI renders it.
function userHasFullDocAccess(authUser) {
  if (authUser.role === 'admin' || authUser.role === 'editor') return true;
  if (authUser.role === 'custom') return !!(authUser.customPermissions && authUser.customPermissions.canEdit);
  return false; // 'viewer'
}

// Returns a Map<endpointId, row> of each endpoint's most relevant doc-access
// request from this specific user FOR ONE ENVIRONMENT, with `is_active`
// computed in SQL (never in JS) so "is this grant currently in its date
// window" can't drift from however Postgres itself defines CURRENT_DATE.
//
// A request is only a candidate here if it was made for this exact
// environment, OR it has no environment recorded at all (a legacy row from
// before per-environment requests existed — see db.js — which grandfathers
// in as "applies everywhere" rather than quietly losing access on upgrade).
// When both exist for the same endpoint, the exact-environment row wins.
async function getDocAccessMap(org, userId, projectId, endpointIds, environmentId) {
  if (!endpointIds || !endpointIds.length) return new Map();
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (endpoint_id)
       endpoint_id, id, status, environment_id, environment_label,
       to_char(start_date, 'YYYY-MM-DD') AS start_date,
       to_char(end_date, 'YYYY-MM-DD') AS end_date,
       decision_note,
       (status = 'approved' AND start_date <= CURRENT_DATE AND end_date >= CURRENT_DATE) AS is_active
     FROM doc_access_requests
     WHERE organisation = $1 AND requested_by = $2 AND project_id = $3 AND endpoint_id = ANY($4)
       AND (environment_id = $5 OR environment_id IS NULL)
     ORDER BY endpoint_id, (environment_id = $5) DESC, created_at DESC`,
    [org, userId, projectId, endpointIds, environmentId || null]
  );
  return new Map(rows.map((r) => [r.endpoint_id, r]));
}

// Strips an endpoint down to the catalog-level fields (enough to browse and
// decide whether to request access) and attaches the current request
// status, if any, so the UI can render "Request access" / "Pending" /
// "Denied" / "Expired" without a separate round trip. An active grant
// instead returns the endpoint untouched, annotated with when it expires.
function applyDocLock(ep, accessRow) {
  if (accessRow && accessRow.is_active) {
    return { ...ep, _docAccessEndDate: accessRow.end_date };
  }
  const status = accessRow ? (accessRow.status === 'approved' ? 'expired' : accessRow.status) : null;
  return {
    id: ep.id,
    method: ep.method,
    path: ep.path,
    tag: ep.tag,
    version: ep.version,
    visibility: ep.visibility,
    summary: ep.summary || '',
    createdAt: ep.createdAt,
    createdBy: ep.createdBy,
    updatedAt: ep.updatedAt,
    updatedBy: ep.updatedBy,
    _docLocked: true,
    _docAccessStatus: status,
    _docAccessRequestId: accessRow ? accessRow.id : null,
    _docAccessStartDate: accessRow ? accessRow.start_date : null,
    _docAccessEndDate: accessRow ? accessRow.end_date : null,
    _docAccessDecisionNote: status === 'denied' ? accessRow.decision_note : null,
  };
}

// GET /api/workspace — everything the signed-in user should see: their own
// projects (untouched), any project from their organisation that has public
// content, plus any project shared with them directly via project_access,
// plus the shared org-level environments/audit log/history/presets.
router.get('/', async (req, res) => {
  try {
    const userId = req.authUser.sub;
    const org = req.authUser.organisation;

    // Short-TTL cache (see cache.js) — GET /api/workspace is called on every
    // dashboard load and usually returns the same thing it did moments ago.
    // A cache miss (including when Redis isn't configured at all) falls
    // straight through to the same query that always ran here.
    const cached = await cache.getWorkspace(org, userId);
    if (cached) return res.json(cached);

    // `data` is encrypted, so we can't ask Postgres to peek inside it with a
    // jsonb path EXISTS check — but `has_public_endpoint` is a plaintext
    // column kept in sync on every write (see computeHasPublicEndpoint()),
    // so the WHERE clause itself excludes every fully-private, non-granted
    // project that isn't the caller's own, instead of fetching and decrypting
    // all of them just to discard most in projectForViewer() afterwards.
    // The LEFT JOIN both pulls in this user's own grants (pa.user_id = $1 in
    // the WHERE) AND carries the grant's environments/permission along for
    // projectForViewer to apply — one query instead of an N+1 per project.
    const { rows } = await pool.query(
      `SELECT p.id, p.owner_id, p.organisation, p.visibility, p.name, p.data, p.data_enc, p.updated_at,
              pa.environments AS grant_environments, pa.permission AS grant_permission
       FROM projects p
       LEFT JOIN project_access pa ON pa.project_id = p.id AND pa.user_id = $1
       WHERE p.owner_id = $1
          OR pa.user_id = $1
          OR (p.organisation = $2 AND (p.visibility = 'public' OR p.has_public_endpoint))`,
      [userId, org]
    );

    // SECURITY (Finding 4.2): mask sensitive example values here, before the
    // payload is built/cached, rather than leaving it to the browser. See
    // server/piiMasking.js — unmasked data is only ever returned by the
    // audited POST /api/pii/reveal/:projectId (Admin-only).
    const orgRules = await getOrgPiiRules(org);

    const projects = {};
    const publicViewProjectIds = []; // ids seen only via the org-wide public catalog — the one branch doc-locking applies to
    rows.forEach((row) => {
      const data = decryptProjectData(row);
      const grant = row.grant_permission ? { environments: row.grant_environments, permission: row.grant_permission } : null;
      const viewed = projectForViewer(row, userId, data, grant);
      // Admin-only (2026-09-27, requested explicitly): raw auto-discovered
      // projects (mule_doc_agent.py's build_app_projects(), tagged
      // discoveryEnvironment) reach every org member here whenever they're
      // public/has_public_endpoint, same as any other project - hiding the
      // sidebar section alone (09-render-sidebar.js) left the data itself
      // still reachable in a non-admin's own state.projects. Excluded here
      // unless it's this user's own (viewed._owned) or explicitly shared
      // with them (grant) - an admin, or the agent account itself reading
      // its own projects, is unaffected.
      if (data.discoveryEnvironment && req.authUser.role !== 'admin' && !viewed._owned && !grant) return;
      projects[row.id] = piiMasking.maskProjectData(viewed, orgRules);
      if (!viewed._owned && !grant) publicViewProjectIds.push(row.id);
    });

    // See userHasFullDocAccess/getDocAccessMap/applyDocLock above — an
    // edit-capable role never needs to request anything, and this only ever
    // touches the public-catalog projects gathered just above (ownership
    // and an explicit project_access share are untouched).
    if (publicViewProjectIds.length && !userHasFullDocAccess(req.authUser)) {
      // This payload's endpoints are the live draft (stage 0 of the
      // pipeline) — a doc-access grant only unlocks the environment it was
      // requested for, so resolve that stage's id once and check against it.
      const draftStages = pipelineStages(await getOrgEnvironments(org));
      const draftEnvId = draftStages.length ? draftStages[0].id : null;
      await Promise.all(publicViewProjectIds.map(async (pid) => {
        const proj = projects[pid];
        if (!proj.endpoints || !proj.endpoints.length) return;
        const accessMap = await getDocAccessMap(org, userId, pid, proj.endpoints.map((e) => e.id), draftEnvId);
        proj.endpoints = proj.endpoints.map((ep) => applyDocLock(ep, accessMap.get(ep.id)));
      }));
    }

    const [wsResult, userRow] = await Promise.all([
      pool.query(
        `SELECT environments, environments_enc, request_history, request_history_enc, tryit_collections_enc, custom_flow_directions, custom_icons, branding
         FROM org_workspace WHERE organisation = $1`,
        [org]
      ),
      pool.query(`SELECT tryit_personal_enc FROM users WHERE id = $1`, [userId]),
    ]);
    const ws = wsResult.rows[0] || {};
    const tryitPersonalEnc = userRow.rows[0]?.tryit_personal_enc;

    // Audit log is no longer part of this payload — it's fetched separately
    // from GET /api/audit/events, which returns server-authoritative entries
    // from the audit_logs table instead of a client-writable JSONB blob.
    const payload = {
      projects,
      environments: decryptOrgBlob(ws.environments_enc, ws.environments, org, 'environments', []),
      requestHistory: decryptOrgBlob(ws.request_history_enc, ws.request_history, org, 'request_history', {}),
      tryitCollections: decryptOrgBlob(ws.tryit_collections_enc, null, org, 'tryit_collections', { variables: [], saved: [] }),
      // PER-USER, not org-shared — see the users.tryit_personal_enc comment
      // in server/db.js. Safe to fold into this same cached payload because
      // the cache itself is already keyed per (org, userId) — see cache.js.
      tryitPersonal: tryitPersonalEnc
        ? (() => { try { return JSON.parse(dataCrypto.decryptField(tryitPersonalEnc, `user:${userId}:tryit_personal`)); } catch (e) { console.error(`Failed to decrypt tryit_personal for user ${userId}:`, e); return { variables: [], saved: [] }; } })()
        : { variables: [], saved: [] },
      customFlowDirections: ws.custom_flow_directions || [],
      customIcons: ws.custom_icons || [],
      branding: ws.branding || {},
    };
    await cache.setWorkspace(org, userId, payload);
    res.json(payload);
  } catch (err) {
    console.error('GET /api/workspace failed:', err);
    res.status(500).json({ error: 'Could not load workspace.' });
  }
});

// PUT /api/workspace/projects — bulk upsert, same shape the client used to
// write to localStorage in one shot: { projects: { [id]: projectObject } }.
// Projects the caller doesn't own are silently skipped (never overwritten).
router.put('/projects', async (req, res) => {
  const userId = req.authUser.sub;
  const org = req.authUser.organisation;
  const incoming = req.body && req.body.projects;
  if (!isPlainObject(incoming)) {
    return res.status(400).json({ error: 'Expected { projects: { ... } }.' });
  }
  const ids = Object.keys(incoming);
  if (ids.length === 0) return res.json({ ok: true, saved: [], skipped: [] });
  if (ids.length > MAX_PROJECTS_PER_SAVE) {
    return res.status(400).json({ error: `Too many projects in one save (max ${MAX_PROJECTS_PER_SAVE}).` });
  }

  const client = await pool.connect();
  const saved = [];
  const skipped = [];
  const conflicts = [];
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT id, owner_id, updated_at FROM projects WHERE id = ANY($1)', [ids]);
    const ownerById = new Map(existing.rows.map((r) => [r.id, r.owner_id]));
    const updatedAtById = new Map(existing.rows.map((r) => [r.id, r.updated_at]));

    for (const id of ids) {
      if (ownerById.has(id) && ownerById.get(id) !== userId) {
        skipped.push(id); // exists and belongs to someone else — never touch it
        continue;
      }
      const proj = incoming[id] || {};

      // Optimistic-locking guard: `_rev` is the `_rev` this client last read
      // via GET /api/workspace (see projectForViewer), i.e. the project's
      // updated_at as of when it loaded. If the row has since been saved by
      // anyone else — another tab, another user with edit access — its
      // updated_at has moved on, and blindly writing this client's payload
      // would silently discard whatever that other save changed (this is
      // exactly what happened with the Architecture Studio diagram getting
      // clobbered by a stale tab). A client that omits `_rev` entirely (an
      // older cached page, or a brand-new project) is never blocked by this —
      // only a client that HAS a rev is held to it.
      const existingUpdatedAt = updatedAtById.get(id);
      if (existingUpdatedAt && typeof proj._rev === 'string') {
        const knownRev = new Date(proj._rev).getTime();
        const actualRev = new Date(existingUpdatedAt).getTime();
        if (Number.isFinite(knownRev) && knownRev !== actualRev) {
          conflicts.push(id);
          continue;
        }
      }

      const visibility = proj.visibility === 'public' ? 'public' : 'private';
      const name = typeof proj.name === 'string' && proj.name.trim() ? proj.name.trim() : 'Untitled API';
      const dataToStore = { ...proj, id };
      delete dataToStore._rev; // server-computed on read — never trust a stored copy

      const sizeError = attachmentSizeError(dataToStore);
      if (sizeError) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: sizeError, projectId: id });
      }
      const urlError = environmentUrlError(dataToStore);
      if (urlError) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: urlError, projectId: id });
      }
      const dupError = duplicateEndpointError(dataToStore);
      if (dupError) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: dupError, projectId: id });
      }
      const fieldsError = endpointFieldsError(dataToStore);
      if (fieldsError) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: fieldsError, projectId: id });
      }
      await offloadAttachments(dataToStore, id);

      const hasPublicEndpoint = computeHasPublicEndpoint(dataToStore);
      const { legacyPlaceholder, enc, version } = encryptProjectData(dataToStore, id);
      await client.query(
        `INSERT INTO projects (id, owner_id, organisation, visibility, name, data, data_enc, data_key_version, has_public_endpoint, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, now())
         ON CONFLICT (id) DO UPDATE SET
           visibility = EXCLUDED.visibility,
           name = EXCLUDED.name,
           data = EXCLUDED.data,
           data_enc = EXCLUDED.data_enc,
           data_key_version = EXCLUDED.data_key_version,
           has_public_endpoint = EXCLUDED.has_public_endpoint,
           updated_at = now()
         WHERE projects.owner_id = $2`,
        [id, userId, org, visibility, name, legacyPlaceholder, enc, version, hasPublicEndpoint]
      );
      saved.push(id);
    }
    await client.query('COMMIT');
    await cache.invalidateOrg(org);
    // Hand back each saved project's new rev so the client can update its
    // local copy in place (see saveState() in 06-spec-parse.js) instead of
    // re-fetching the whole workspace just to learn its own save's timestamp.
    let revs = {};
    if (saved.length) {
      const { rows: revRows } = await pool.query(
        'SELECT id, updated_at FROM projects WHERE id = ANY($1)',
        [saved]
      );
      revs = Object.fromEntries(revRows.map((r) => [r.id, new Date(r.updated_at).toISOString()]));
    }
    res.json({ ok: true, saved, skipped, conflicts, revs });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PUT /api/workspace/projects failed:', err);
    res.status(500).json({ error: 'Could not save projects.' });
  } finally {
    client.release();
  }
});

// PATCH /api/workspace/projects/:id/visibility — { visibility: 'private'|'public' }
router.patch('/projects/:id/visibility', async (req, res) => {
  const userId = req.authUser.sub;
  const { visibility } = req.body || {};
  if (visibility !== 'private' && visibility !== 'public') {
    return res.status(400).json({ error: "visibility must be 'private' or 'public'." });
  }
  try {
    // `data` is ciphertext now, so we can't jsonb_set into it in SQL — decrypt,
    // flip the field, re-encrypt (under whatever the CURRENT active key is,
    // which naturally upgrades older rows a little at a time as they're touched).
    const { rows: existing } = await pool.query(
      `SELECT id, data, data_enc FROM projects WHERE id = $1 AND owner_id = $2`,
      [req.params.id, userId]
    );
    if (!existing.length) return res.status(404).json({ error: 'Project not found, or you are not the owner.' });
    const plain = decryptProjectData(existing[0]);
    plain.visibility = visibility;
    const { legacyPlaceholder, enc, version } = encryptProjectData(plain, req.params.id);
    await pool.query(
      `UPDATE projects SET visibility = $1, data = $2::jsonb, data_enc = $3, data_key_version = $4, updated_at = now()
       WHERE id = $5 AND owner_id = $6`,
      [visibility, legacyPlaceholder, enc, version, req.params.id, userId]
    );
    await cache.invalidateOrg(req.authUser.organisation);
    res.json({ ok: true });
  } catch (err) {
    console.error('PATCH visibility failed:', err);
    res.status(500).json({ error: 'Could not update visibility.' });
  }
});

// ---- Per-project, per-environment sharing (project_access) ----
// Lets an owner (or Admin) share ONE private project with a NAMED org member,
// optionally scoped to specific environments — independent of that member's
// global role and without exposing the project to the whole organisation the
// way `visibility: 'public'` does. See server/projectAccess.js for how these
// grants are consulted on read.

// Only the owner or an Admin may view/manage a project's grant list.
async function requireOwnerOrAdmin(req, res, projectId) {
  const { rows } = await pool.query('SELECT id, owner_id, organisation, name FROM projects WHERE id = $1', [projectId]);
  if (!rows.length) {
    res.status(404).json({ error: 'Project not found.' });
    return null;
  }
  const project = rows[0];
  if (project.organisation !== req.authUser.organisation) {
    res.status(404).json({ error: 'Project not found.' });
    return null;
  }
  if (project.owner_id !== req.authUser.sub && req.authUser.role !== 'admin') {
    res.status(403).json({ error: 'Only the project owner or an Admin can manage access to this project.' });
    return null;
  }
  return project;
}

// GET /api/workspace/projects/:id/access — current grants + org roster/env
// catalog, everything the "Share" UI needs in one call.
router.get('/projects/:id/access', async (req, res) => {
  try {
    const project = await requireOwnerOrAdmin(req, res, req.params.id);
    if (!project) return;

    const [grantsResult, usersResult, environments] = await Promise.all([
      pool.query(
        `SELECT pa.user_id, u.username, u.role, pa.environments, pa.permission, pa.granted_at,
                gb.username AS granted_by_username
         FROM project_access pa
         JOIN users u ON u.id = pa.user_id
         LEFT JOIN users gb ON gb.id = pa.granted_by
         WHERE pa.project_id = $1
         ORDER BY pa.granted_at ASC`,
        [req.params.id]
      ),
      pool.query(
        `SELECT id, username, role FROM users WHERE organisation = $1 AND id != $2 ORDER BY username ASC`,
        [req.authUser.organisation, project.owner_id]
      ),
      getOrgEnvironments(req.authUser.organisation),
    ]);

    res.json({
      projectId: req.params.id,
      projectName: project.name,
      grants: grantsResult.rows,
      shareableUsers: usersResult.rows,
      environments,
    });
  } catch (err) {
    console.error('GET project access failed:', err);
    res.status(500).json({ error: 'Could not load project access.' });
  }
});

// POST /api/workspace/projects/:id/access — create or update one user's grant.
// Body: { userId, environments: ["DEV","SIT"] | ["*"], permission: 'view'|'edit' }
router.post('/projects/:id/access', async (req, res) => {
  try {
    const project = await requireOwnerOrAdmin(req, res, req.params.id);
    if (!project) return;

    const { userId, environments, permission } = req.body || {};
    const targetUserId = Number(userId);
    if (!Number.isInteger(targetUserId)) {
      return res.status(400).json({ error: 'userId is required.' });
    }
    if (targetUserId === project.owner_id) {
      return res.status(400).json({ error: 'The owner already has full access — no grant needed.' });
    }
    if (permission !== 'view' && permission !== 'edit') {
      return res.status(400).json({ error: "permission must be 'view' or 'edit'." });
    }
    if (!Array.isArray(environments) || environments.length === 0) {
      return res.status(400).json({ error: 'Pick at least one environment, or ["*"] for all.' });
    }

    // Silently drop anything invalid rather than failing the whole save over
    // one stale entry.
    const wildcard = environments.includes('*');
    let cleanEnvs = ['*'];
    if (!wildcard) {
      const validEnvIds = new Set((await getOrgEnvironments(req.authUser.organisation)).map((e) => e.id));
      cleanEnvs = [...new Set(environments.filter((e) => typeof e === 'string' && validEnvIds.has(e)))];
      if (!cleanEnvs.length) return res.status(400).json({ error: 'None of the given environments exist for this organisation.' });
    }

    // Confirm the target user is actually in the same organisation before
    // granting — the FK alone would let you reference any user id in the DB.
    const { rows: targetRows } = await pool.query(
      'SELECT id, username FROM users WHERE id = $1 AND organisation = $2',
      [targetUserId, req.authUser.organisation]
    );
    if (!targetRows.length) return res.status(404).json({ error: 'That user was not found in your organisation.' });

    const { rows } = await pool.query(
      `INSERT INTO project_access (project_id, user_id, environments, permission, granted_by)
       VALUES ($1, $2, $3::jsonb, $4, $5)
       ON CONFLICT (project_id, user_id)
       DO UPDATE SET environments = EXCLUDED.environments, permission = EXCLUDED.permission,
                      granted_by = EXCLUDED.granted_by, granted_at = now()
       RETURNING user_id, environments, permission, granted_at`,
      [req.params.id, targetUserId, JSON.stringify(cleanEnvs), permission, req.authUser.sub]
    );

    await cache.invalidateOrg(req.authUser.organisation);
    await recordAuditEvent(req.authUser, req, {
      action: 'PROJECT_ACCESS_GRANTED',
      resourceType: 'project',
      resourceId: req.params.id,
      projectName: project.name,
      details: `Granted ${targetRows[0].username} ${permission} access (${cleanEnvs.join(', ')})`,
      severity: 'warning',
      metadata: { targetUserId, environments: cleanEnvs, permission },
    });
    // Same blind spot as doc-access requests: the person who was just given
    // (or had regranted) access to someone else's project had no way to
    // discover it short of noticing a new project appear in their workspace.
    await notifyUser(targetUserId, {
      organisation: req.authUser.organisation,
      type: 'PROJECT_ACCESS_GRANTED',
      title: `You were given ${permission} access to ${project.name}`,
      body: cleanEnvs.includes('*') ? 'All environments' : cleanEnvs.join(', '),
      link: { view: 'project', projectId: req.params.id },
    });

    res.json({ grant: rows[0] });
  } catch (err) {
    console.error('POST project access failed:', err);
    res.status(500).json({ error: 'Could not save project access.' });
  }
});

// DELETE /api/workspace/projects/:id/access/:userId — revoke one user's grant.
router.delete('/projects/:id/access/:userId', async (req, res) => {
  try {
    const project = await requireOwnerOrAdmin(req, res, req.params.id);
    if (!project) return;

    const targetUserId = Number(req.params.userId);
    const { rows } = await pool.query(
      `DELETE FROM project_access WHERE project_id = $1 AND user_id = $2 RETURNING user_id`,
      [req.params.id, targetUserId]
    );
    if (!rows.length) return res.status(404).json({ error: 'No grant found for that user on this project.' });

    await cache.invalidateOrg(req.authUser.organisation);
    await recordAuditEvent(req.authUser, req, {
      action: 'PROJECT_ACCESS_REVOKED',
      resourceType: 'project',
      resourceId: req.params.id,
      projectName: project.name,
      severity: 'warning',
      metadata: { targetUserId },
    });
    await notifyUser(targetUserId, {
      organisation: req.authUser.organisation,
      type: 'PROJECT_ACCESS_REVOKED',
      title: `Your access to ${project.name} was revoked`,
      link: null,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE project access failed:', err);
    res.status(500).json({ error: 'Could not revoke project access.' });
  }
});

// DELETE /api/workspace/projects/:id — owner only.
router.delete('/projects/:id', async (req, res) => {
  try {
    // Ownership alone (the old check: owner_id = the deleting user) leaves
    // no human able to delete a project a SERVICE ACCOUNT created - the SIT
    // auto-discovery agent's projects are all owned by svc-doc-agent, so no
    // admin could ever clean one up. Same owner-or-admin rule
    // requireOwnerOrAdmin() above already applies to managing a project's
    // access grants; deleting is at least as sensitive, so it gets the same
    // bar rather than a stricter one that would strand these permanently.
    const { rows: existingRows } = await pool.query(
      'SELECT id, owner_id, organisation FROM projects WHERE id = $1', [req.params.id]
    );
    if (!existingRows.length || existingRows[0].organisation !== req.authUser.organisation) {
      return res.status(404).json({ error: 'Project not found, or you are not the owner.' });
    }
    const project = existingRows[0];
    if (project.owner_id !== req.authUser.sub && req.authUser.role !== 'admin') {
      return res.status(403).json({ error: 'Only the project owner or an Admin can delete this project.' });
    }
    const { rows } = await pool.query('DELETE FROM projects WHERE id = $1 RETURNING id', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Project not found, or you are not the owner.' });
    await cache.invalidateOrg(req.authUser.organisation);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE project failed:', err);
    res.status(500).json({ error: 'Could not delete project.' });
  }
});

// GET /api/workspace/projects/:id/attachments/:docId — streams one attachment
// back to the browser. Needed now that attachments live in object storage
// instead of as an inline dataUrl the browser could link to directly (see
// storage.js). Same visibility rule as reading the project itself: the
// owner, or anyone if the project is public.
// GET /api/workspace/projects/:id/attachments/:docId — streams one attachment
// back to the browser. Needed now that attachments live in object storage
// instead of as an inline dataUrl the browser could link to directly (see
// storage.js).
//
// Now routed through projectAccess.resolveAccessById — the same "single
// source of truth" helper GET /api/workspace itself effectively encodes via
// projectForViewer. Previously this only checked `owner_id === sub` or
// `visibility === 'public'`, which silently ignored an explicit
// project_access share: someone granted access to a private project could
// see its attachments listed in the workspace payload but got a hard 403
// trying to actually download one. That's the same class of bug as
// /versions and /openapi-link below (a new/adjacent route not carrying over
// the visibility check every other read route enforces) — fixed here the
// same way, by calling the shared helper instead of re-deriving the check.
// GET /api/workspace/projects/:id/attachments/:docId — streams one attachment
// back to the browser. Needed now that attachments live in object storage
// instead of as an inline dataUrl the browser could link to directly (see
// storage.js).
//
// Visibility check previously only covered `owner_id === sub` or
// `visibility === 'public'` — silently ignoring an explicit project_access
// share, so someone granted access to a private project could see its
// attachments listed in the workspace payload but got a hard 403 trying to
// actually download one. Fixed by adding the grant check every other read
// route already has. Deliberately NOT using the has_public_endpoint fallback
// resolveAccess() applies for endpoint-level reads: attachments (like the
// architecture diagram) are project-level, not per-endpoint, so — same rule
// projectForViewer already applies — they only surface when the WHOLE
// project is public, never via a single public endpoint on an otherwise
// private project. That's why this checks `visibility === 'public'`
// directly rather than calling resolveAccessById wholesale.
router.get('/projects/:id/attachments/:docId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, owner_id, organisation, visibility, data, data_enc FROM projects WHERE id = $1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Project not found.' });
    const row = rows[0];
    if (row.organisation !== req.authUser.organisation) return res.status(404).json({ error: 'Project not found.' });

    const isOwner = row.owner_id === req.authUser.sub;
    let hasGrant = false;
    if (!isOwner) {
      const { rows: grantRows } = await pool.query(
        `SELECT 1 FROM project_access WHERE project_id = $1 AND user_id = $2`,
        [req.params.id, req.authUser.sub]
      );
      hasGrant = grantRows.length > 0;
    }
    if (!isOwner && !hasGrant && row.visibility !== 'public') {
      return res.status(403).json({ error: 'This project is private.' });
    }

    // Attachments are frozen into each stage's snapshot — without this,
    // downloading a document while viewing a non-draft stage always served
    // whatever's on the current draft instead of what was actually in that
    // stage's frozen snapshot.
    const envKey = req.query.environmentId;
    let data;
    if (envKey) {
      const allEnvs = await getOrgEnvironments(row.organisation);
      const stages = pipelineStages(allEnvs);
      const idx = stages.findIndex((e) => e.id === envKey);
      if (idx < 0) return res.status(400).json({ error: 'Unknown environment.' });
      data = await loadStageData(row, envKey, idx);
    } else {
      data = decryptProjectData(row);
    }
    const doc = (data.attachments || []).find((a) => a && a.id === req.params.docId);
    if (!doc) return res.status(404).json({ error: 'Attachment not found.' });

    let buffer;
    if (doc.storageKey) {
      if (!storage.isEnabled()) return res.status(500).json({ error: 'Object storage is not configured on this server.' });
      buffer = await storage.downloadAttachment({ projectId: row.id, storageKey: doc.storageKey });
    } else if (typeof doc.dataUrl === 'string') {
      const match = /^data:([^;]+);base64,(.+)$/s.exec(doc.dataUrl);
      buffer = Buffer.from(match ? match[2] : doc.dataUrl, 'base64');
    } else {
      return res.status(404).json({ error: 'Attachment has no stored content.' });
    }

    res.setHeader('Content-Type', doc.type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${(doc.name || 'file').replace(/"/g, '')}"`);
    res.send(buffer);
  } catch (err) {
    console.error('GET attachment failed:', err);
    res.status(500).json({ error: 'Could not load attachment.' });
  }
});

// ---- Shared org-level extras (environments / request history / flow presets) ----
// NOTE: audit logging used to be a third "column" here (a client-overwritable
// JSONB blob) — that endpoint is removed. Audit events are now written one at
// a time, server-side only, via POST /api/audit/events (see routes/audit.js).
async function upsertOrgWorkspace(org, column, value) {
  const columnWhitelist = ['custom_flow_directions', 'custom_icons', 'branding']; // the only remaining plaintext-JSONB columns
  if (!columnWhitelist.includes(column)) throw new Error('Invalid column');
  await pool.query(
    `INSERT INTO org_workspace (organisation, ${column}, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (organisation) DO UPDATE SET ${column} = EXCLUDED.${column}, updated_at = now()`,
    [org, JSON.stringify(value)]
  );
}

// environments/request_history/tryit_collections can carry real hosts,
// tokens, and captured request/response bodies, so — unlike
// custom_flow_directions (pure UI preference) — they're encrypted before
// they reach Postgres. tryit_collections has no legacy plain-JSONB column
// (it was born encrypted-only), so it always writes '{}' into that slot.
async function upsertEncryptedOrgWorkspace(org, purpose, value) {
  const column = purpose === 'environments' ? 'environments'
    : purpose === 'tryit_collections' ? 'tryit_collections' : 'request_history';
  const legacyPlaceholder = column === 'environments' ? '[]' : '{}';
  if (column === 'tryit_collections') {
    // No legacy plaintext column - it was born encrypted-only.
    const { enc, version } = encryptOrgBlob(value, org, purpose);
    await pool.query(
      `INSERT INTO org_workspace (organisation, ${column}_enc, ${column}_key_version, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (organisation) DO UPDATE SET
         ${column}_enc = EXCLUDED.${column}_enc,
         ${column}_key_version = EXCLUDED.${column}_key_version, updated_at = now()`,
      [org, enc, version]
    );
    return;
  }
  const { enc, version } = encryptOrgBlob(value, org, purpose);
  await pool.query(
    `INSERT INTO org_workspace (organisation, ${column}, ${column}_enc, ${column}_key_version, updated_at)
     VALUES ($1, $2::jsonb, $3, $4, now())
     ON CONFLICT (organisation) DO UPDATE SET
       ${column} = EXCLUDED.${column}, ${column}_enc = EXCLUDED.${column}_enc,
       ${column}_key_version = EXCLUDED.${column}_key_version, updated_at = now()`,
    [org, legacyPlaceholder, enc, version]
  );
}

router.put('/environments', async (req, res) => {
  if (!Array.isArray(req.body?.environments)) return res.status(400).json({ error: 'Expected { environments: [] }.' });
  try {
    await upsertEncryptedOrgWorkspace(req.authUser.organisation, 'environments', req.body.environments);
    await cache.invalidateOrg(req.authUser.organisation);
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT environments failed:', err);
    res.status(500).json({ error: 'Could not save environments.' });
  }
});

router.put('/request-history', async (req, res) => {
  if (!isPlainObject(req.body?.requestHistory)) return res.status(400).json({ error: 'Expected { requestHistory: {} }.' });
  try {
    await upsertEncryptedOrgWorkspace(req.authUser.organisation, 'request_history', req.body.requestHistory);
    await cache.invalidateOrg(req.authUser.organisation);
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT request-history failed:', err);
    res.status(500).json({ error: 'Could not save request history.' });
  }
});


// Try It collection variables + saved requests (Postman-style). Same
// org-shared, encrypted-at-rest treatment as /request-history — a variable
// value can be a real bearer token, and a saved request can embed one.
router.put('/tryit-collections', async (req, res) => {
  const body = req.body?.tryitCollections;
  if (!isPlainObject(body) || !Array.isArray(body.variables) || !Array.isArray(body.saved)) {
    return res.status(400).json({ error: 'Expected { tryitCollections: { variables: [], saved: [] } }.' });
  }
  try {
    await upsertEncryptedOrgWorkspace(req.authUser.organisation, 'tryit_collections', body);
    await cache.invalidateOrg(req.authUser.organisation);
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT tryit-collections failed:', err);
    res.status(500).json({ error: 'Could not save Try It collections.' });
  }
});

// Personal Try It variables + saved requests — PER-USER, never included in
// the org-shared tryit_collections blob above. See the users.tryit_personal_enc
// comment in server/db.js for why this needs to be a genuinely separate,
// per-user-encrypted column rather than a client-side-filtered flag on a
// shared record (the latter would still ship everyone's "personal" tokens
// to every other org member's browser, just hidden by the UI).
router.put('/tryit-personal', async (req, res) => {
  const body = req.body?.tryitPersonal;
  if (!isPlainObject(body) || !Array.isArray(body.variables) || !Array.isArray(body.saved)) {
    return res.status(400).json({ error: 'Expected { tryitPersonal: { variables: [], saved: [] } }.' });
  }
  try {
    const userId = req.authUser.sub;
    const enc = dataCrypto.encryptField(JSON.stringify(body), `user:${userId}:tryit_personal`);
    await pool.query(
      `UPDATE users SET tryit_personal_enc = $1, tryit_personal_key_version = $2 WHERE id = $3`,
      [enc, dataCrypto.currentKeyVersion(), userId]
    );
    await cache.invalidateOrg(req.authUser.organisation);
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT tryit-personal failed:', err);
    res.status(500).json({ error: 'Could not save your personal Try It data.' });
  }
});

router.put('/custom-flow-directions', async (req, res) => {
  if (!Array.isArray(req.body?.customFlowDirections)) return res.status(400).json({ error: 'Expected { customFlowDirections: [] }.' });
  try {
    await upsertOrgWorkspace(req.authUser.organisation, 'custom_flow_directions', req.body.customFlowDirections);
    await cache.invalidateOrg(req.authUser.organisation);
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT custom-flow-directions failed:', err);
    res.status(500).json({ error: 'Could not save flow direction presets.' });
  }
});

// Custom icon/logo library for Architecture Studio — shared across every
// project in the organisation (people drop in their own vendor artwork
// under their own license + a name, once, and it shows up in every
// diagram's component palette from then on). Not per-project: the whole
// point is "save it for further" use elsewhere.
router.put('/custom-icons', async (req, res) => {
  if (!Array.isArray(req.body?.customIcons)) return res.status(400).json({ error: 'Expected { customIcons: [] }.' });
  const icons = req.body.customIcons;
  if (icons.length > MAX_CUSTOM_ICONS) {
    return res.status(400).json({ error: `Custom icon library is limited to ${MAX_CUSTOM_ICONS} icons per organisation.` });
  }
  for (const icon of icons) {
    if (!icon || typeof icon.id !== 'string' || typeof icon.name !== 'string' || typeof icon.dataUrl !== 'string') {
      return res.status(400).json({ error: 'Each custom icon needs an id, name, and dataUrl.' });
    }
    if (!/^data:image\/(png|jpeg|jpg|svg\+xml|webp);base64,/.test(icon.dataUrl)) {
      return res.status(400).json({ error: `"${icon.name}" isn't a supported image type (PNG, JPEG, WebP, or SVG only).` });
    }
    if (icon.dataUrl.length > MAX_CUSTOM_ICON_BYTES) {
      return res.status(400).json({ error: `"${icon.name}" is too large (max ${Math.floor(MAX_CUSTOM_ICON_BYTES / 1024)}KB — logos don't need to be huge).` });
    }
  }
  try {
    await upsertOrgWorkspace(req.authUser.organisation, 'custom_icons', icons);
    await cache.invalidateOrg(req.authUser.organisation);
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT custom-icons failed:', err);
    res.status(500).json({ error: 'Could not save custom icons.' });
  }
});

// Organisation letterhead branding — a logo + display label stamped on every
// page of a generated PDF export (see public/js/studio/20-export-pdf.js) and
// on its cover page. Org-wide, and Admin-only to change (same reasoning as
// PII rules/AI config: it's a shared, visible-to-everyone setting, not a
// personal preference) — set from Your Profile ▸ Organisation branding.
// Stored in `org_workspace.branding`, so it persists in Postgres across
// restarts/redeploys rather than living only in a browser or on local disk.
router.put('/branding', requireAdmin, async (req, res) => {
  const { orgDisplayName, logoDataUrl, logoWidth, logoHeight } = req.body || {};
  if (orgDisplayName !== undefined && typeof orgDisplayName !== 'string') {
    return res.status(400).json({ error: 'orgDisplayName must be a string.' });
  }
  if (orgDisplayName && orgDisplayName.length > 80) {
    return res.status(400).json({ error: 'Display name is limited to 80 characters.' });
  }
  // logoDataUrl: undefined = leave the existing logo alone; null = explicitly
  // remove it; a string = replace it. jsPDF's addImage (used to stamp the
  // native per-page header) only accepts raster formats, so SVG — allowed for
  // the Architecture Studio custom-icon library above — is deliberately not
  // accepted here.
  if (logoDataUrl !== undefined && logoDataUrl !== null) {
    if (typeof logoDataUrl !== 'string' || !/^data:image\/(png|jpeg|jpg|webp);base64,/.test(logoDataUrl)) {
      return res.status(400).json({ error: 'Logo must be a PNG, JPEG, or WebP image.' });
    }
    if (logoDataUrl.length > MAX_BRAND_LOGO_BYTES) {
      return res.status(400).json({ error: `Logo is too large (max ${Math.floor(MAX_BRAND_LOGO_BYTES / 1024)}KB after compression).` });
    }
    // logoWidth/logoHeight: the logo's natural pixel dimensions, captured client-side
    // at upload time — lets the PDF header/cover fit the logo to its real aspect
    // ratio instead of assuming it's square. Optional (older clients may omit them),
    // but when a fresh logoDataUrl is sent they should be sane positive numbers.
    if (logoWidth !== undefined && logoWidth !== null && (typeof logoWidth !== 'number' || !(logoWidth > 0 && logoWidth <= 20000))) {
      return res.status(400).json({ error: 'logoWidth must be a positive number.' });
    }
    if (logoHeight !== undefined && logoHeight !== null && (typeof logoHeight !== 'number' || !(logoHeight > 0 && logoHeight <= 20000))) {
      return res.status(400).json({ error: 'logoHeight must be a positive number.' });
    }
  }
  try {
    const existing = await pool.query(`SELECT branding FROM org_workspace WHERE organisation = $1`, [req.authUser.organisation]);
    const prevBranding = (existing.rows[0] && existing.rows[0].branding) || {};
    const branding = {
      orgDisplayName: (orgDisplayName || '').trim(),
      logoDataUrl: logoDataUrl === undefined ? (prevBranding.logoDataUrl || null) : logoDataUrl,
      logoWidth: logoDataUrl === undefined ? (prevBranding.logoWidth || null) : (logoDataUrl === null ? null : (logoWidth || null)),
      logoHeight: logoDataUrl === undefined ? (prevBranding.logoHeight || null) : (logoDataUrl === null ? null : (logoHeight || null)),
      updatedAt: new Date().toISOString(),
      updatedBy: req.authUser.username || null,
    };
    await upsertOrgWorkspace(req.authUser.organisation, 'branding', branding);
    await cache.invalidateOrg(req.authUser.organisation);
    res.json({ ok: true, branding });
  } catch (err) {
    console.error('PUT branding failed:', err);
    res.status(500).json({ error: 'Could not save organisation branding.' });
  }
});

// POST /api/workspace/migrate — one-time import of a browser's old localStorage
// workspace. Every project comes in owned by the caller, private by default
// (people can flip individual projects/endpoints public afterwards). Org-level
// extras are merged (deduped by id) rather than overwritten, since several
// people migrating shouldn't stomp on each other's environments/audit history.
router.post('/migrate', async (req, res) => {
  const userId = req.authUser.sub;
  const org = req.authUser.organisation;
  const body = req.body || {};
  const incomingProjects = isPlainObject(body.projects) ? body.projects : {};
  const projectIds = Object.keys(incomingProjects);
  if (projectIds.length > MAX_PROJECTS_PER_SAVE) {
    return res.status(400).json({ error: `Too many projects to migrate at once (max ${MAX_PROJECTS_PER_SAVE}).` });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let imported = 0;
    for (const oldId of projectIds) {
      const proj = incomingProjects[oldId] || {};
      // Guard against id collisions with an existing project owned by someone else.
      const existing = await client.query('SELECT owner_id FROM projects WHERE id = $1', [oldId]);
      const id = existing.rows.length && existing.rows[0].owner_id !== userId
        ? `${oldId}-${Math.random().toString(36).slice(2, 8)}`
        : oldId;
      const name = typeof proj.name === 'string' && proj.name.trim() ? proj.name.trim() : 'Untitled API';
      const dataToStore = { ...proj, id, visibility: 'private' };
      (dataToStore.endpoints || []).forEach((ep) => { if (ep && !ep.visibility) ep.visibility = 'private'; });

      const sizeError = attachmentSizeError(dataToStore);
      if (sizeError) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: sizeError, projectId: oldId });
      }
      await offloadAttachments(dataToStore, id);

      const hasPublicEndpoint = computeHasPublicEndpoint(dataToStore);
      const { legacyPlaceholder, enc, version } = encryptProjectData(dataToStore, id);
      await client.query(
        `INSERT INTO projects (id, owner_id, organisation, visibility, name, data, data_enc, data_key_version, has_public_endpoint)
         VALUES ($1, $2, $3, 'private', $4, $5::jsonb, $6, $7, $8)
         ON CONFLICT (id) DO NOTHING`,
        [id, userId, org, name, legacyPlaceholder, enc, version, hasPublicEndpoint]
      );
      imported++;
    }

    // Merge org-level extras.
    const wsRes = await client.query(
      `SELECT environments, environments_enc, request_history, request_history_enc, custom_flow_directions
       FROM org_workspace WHERE organisation = $1 FOR UPDATE`,
      [org]
    );
    const wsRow = wsRes.rows[0] || {};
    const current = {
      environments: decryptOrgBlob(wsRow.environments_enc, wsRow.environments, org, 'environments', []),
      request_history: decryptOrgBlob(wsRow.request_history_enc, wsRow.request_history, org, 'request_history', {}),
      custom_flow_directions: wsRow.custom_flow_directions || [],
    };

    const mergeById = (existingArr, incomingArr) => {
      const arr = Array.isArray(existingArr) ? existingArr.slice() : [];
      const seen = new Set(arr.map((x) => x && x.id));
      (Array.isArray(incomingArr) ? incomingArr : []).forEach((item) => {
        if (item && !seen.has(item.id)) { arr.push(item); seen.add(item.id); }
      });
      return arr;
    };

    const mergedEnvironments = mergeById(current.environments, body.environments);
    const mergedFlowDirections = mergeById(current.custom_flow_directions, body.customFlowDirections);
    const mergedHistory = { ...(current.request_history || {}) };
    if (isPlainObject(body.requestHistory)) {
      Object.entries(body.requestHistory).forEach(([epId, entries]) => {
        const prior = Array.isArray(mergedHistory[epId]) ? mergedHistory[epId] : [];
        mergedHistory[epId] = prior.concat(Array.isArray(entries) ? entries : []).slice(0, 100);
      });
    }

    const mergedEnvEnc = encryptOrgBlob(mergedEnvironments, org, 'environments');
    const mergedHistEnc = encryptOrgBlob(mergedHistory, org, 'request_history');
    await client.query(
      `INSERT INTO org_workspace
        (organisation, environments, environments_enc, environments_key_version,
         request_history, request_history_enc, request_history_key_version,
         custom_flow_directions, updated_at)
       VALUES ($1, '[]'::jsonb, $2, $3, '{}'::jsonb, $4, $5, $6::jsonb, now())
       ON CONFLICT (organisation) DO UPDATE SET
         environments = EXCLUDED.environments, environments_enc = EXCLUDED.environments_enc,
         environments_key_version = EXCLUDED.environments_key_version,
         request_history = EXCLUDED.request_history, request_history_enc = EXCLUDED.request_history_enc,
         request_history_key_version = EXCLUDED.request_history_key_version,
         custom_flow_directions = EXCLUDED.custom_flow_directions,
         updated_at = now()`,
      [org, mergedEnvEnc.enc, mergedEnvEnc.version, mergedHistEnc.enc, mergedHistEnc.version, JSON.stringify(mergedFlowDirections)]
    );

    // This browser's old localStorage audit history gets a one-time, clearly-
    // labeled import into the real audit_logs table (as its own event type) —
    // it does NOT get treated as authoritative history for arbitrary past
    // actions, since we can't verify who really performed them.
    if (Array.isArray(body.auditLog) && body.auditLog.length) {
      for (const legacyEntry of body.auditLog.slice(0, 500)) {
        await recordAuditEvent(req.authUser, req, {
          action: 'LEGACY_AUDIT_IMPORTED',
          resourceType: (legacyEntry && legacyEntry.entityType) || 'unknown',
          entityName: legacyEntry && legacyEntry.entityName,
          projectName: legacyEntry && legacyEntry.projectName,
          details: legacyEntry && legacyEntry.details,
          severity: 'info',
          metadata: {
            originalActor: legacyEntry && legacyEntry.actor,
            originalTs: legacyEntry && legacyEntry.ts,
            originalAction: legacyEntry && legacyEntry.action,
          },
        });
      }
    }

    await client.query('COMMIT');
    await cache.invalidateOrg(org);
    res.json({ ok: true, imported });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/workspace/migrate failed:', err);
    res.status(500).json({ error: 'Migration failed.' });
  } finally {
    client.release();
  }
});

// ============================================================================
// Environment stages: Dev (live draft) plus whatever other environments the
// org has configured, each non-Dev stage potentially holding a frozen
// snapshot (project_env_versions) read by GET /environment-metrics and
// GET /projects/:id/snapshot below.
//
// The stage order comes from the org's OWN environments list (org_workspace
// .environments — user-configurable, see the environment settings UI), not a
// hardcoded list, since orgs can rename/reorder/add environments freely. One
// convention: an environment labeled "DR" (case-insensitive) is never a
// manual stage — it mirrors whatever's currently in the last stage.
// ============================================================================

async function getOrgEnvironments(org) {
  const { rows } = await pool.query(
    `SELECT environments, environments_enc FROM org_workspace WHERE organisation = $1`,
    [org]
  );
  const ws = rows[0] || {};
  const list = decryptOrgBlob(ws.environments_enc, ws.environments, org, 'environments', []);
  return Array.isArray(list) ? list : [];
}

// The pipeline is every configured environment EXCEPT ones labeled "DR" —
// those mirror the last pipeline stage automatically instead of being
// manually promoted to. Stage 0 is always the live draft (projects.data),
// never a project_env_versions row.
function pipelineStages(allEnvironments) {
  return allEnvironments.filter((e) => String(e.label || '').trim().toUpperCase() !== 'DR');
}

// GET /api/workspace/environment-metrics — workspace-wide rollup of how many
// endpoints actually exist "in" each pipeline environment, not just whether a
// project has a base URL configured for it. Dev/the draft stage always shows
// what's live in each project's editable draft; every later stage (SIT, UAT,
// Staging, Production, ...) shows what was actually promoted into that
// stage's frozen snapshot — so it's completely normal (and expected) for
// Production's count to be lower than Dev's while endpoints are still being
// built out and haven't been promoted the whole way down the pipeline yet.
//
// Scoped exactly like GET '/' — a project only counts here if the caller
// owns it, or it (or one of its endpoints) is public. For someone else's
// project, only its public endpoints are counted, in both the draft and any
// promoted snapshot, mirroring projectForViewer()'s rule.
// Same ids/default as ENDPOINT_STATUSES / DEFAULT_ENDPOINT_STATUS in
// public/js/doc-meta.js — kept in sync by hand since that file is
// browser-only. An ep.status this list doesn't recognise (older/newer
// build, hand-edited data) is still counted, just under its own raw key,
// mirroring endpointStatusOf()'s "unknown status passes through" behavior.
const ENDPOINT_STATUS_IDS = ['active', 'in_development', 'in_review', 'no_consumers', 'deprecated'];
const DEFAULT_ENDPOINT_STATUS_ID = 'active';
function endpointStatusIdOf(ep) {
  const s = ep && ep.status;
  return s ? String(s) : DEFAULT_ENDPOINT_STATUS_ID;
}
function tallyByStatus(endpoints) {
  const tally = {};
  (endpoints || []).forEach((ep) => {
    const id = endpointStatusIdOf(ep);
    tally[id] = (tally[id] || 0) + 1;
  });
  return tally;
}
function mergeByStatus(target, addition) {
  Object.keys(addition || {}).forEach((id) => { target[id] = (target[id] || 0) + addition[id]; });
  return target;
}

router.get('/environment-metrics', async (req, res) => {
  try {
    const userId = req.authUser.sub;
    const org = req.authUser.organisation;

    const { rows } = await pool.query(
      `SELECT id, owner_id, organisation, visibility, data, data_enc
       FROM projects
       WHERE owner_id = $1
          OR (organisation = $2 AND (visibility = 'public' OR has_public_endpoint))`,
      [userId, org]
    );

    const allEnvs = await getOrgEnvironments(org);
    const stages = pipelineStages(allEnvs);
    if (!stages.length) return res.json({ stages: [], mirrors: [], totalProjects: rows.length, baselineTotal: 0 });

    // Stage 0 (the live draft) — counts (and now per-status tallies) come
    // straight from each project's current data, filtered down to what this
    // viewer is allowed to see.
    const draftCounts = new Map(); // projectId -> count
    const draftByStatus = new Map(); // projectId -> {statusId: count}
    // How many of this project's draft endpoints are actually release-ready
    // right now (see endpointReadinessProblem) — needed below so "fully
    // promoted" means "every endpoint that's ready IS live," not "literally
    // every endpoint the project has ever documented."
    const draftReadyCounts = new Map(); // projectId -> count
    rows.forEach((row) => {
      const viewerData = projectForViewer(row, userId, decryptProjectData(row));
      const endpoints = viewerData.endpoints || [];
      draftCounts.set(row.id, endpoints.length);
      draftByStatus.set(row.id, tallyByStatus(endpoints));
      draftReadyCounts.set(row.id, endpoints.filter((ep) => !endpointReadinessProblem(ep)).length);
    });

    // Promoted stages — one query for every frozen snapshot across these
    // projects, decrypted and counted (and tallied by status) the same
    // viewer-scoped way.
    const promotedCounts = new Map(); // `${projectId}:${environmentId}` -> count
    const promotedByStatus = new Map(); // `${projectId}:${environmentId}` -> {statusId: count}
    const projectIds = rows.map((r) => r.id);
    if (projectIds.length) {
      const { rows: verRows } = await pool.query(
        `SELECT project_id, environment_id, data_enc FROM project_env_versions WHERE project_id = ANY($1::text[])`,
        [projectIds]
      );
      const rowById = new Map(rows.map((r) => [r.id, r]));
      verRows.forEach((v) => {
        const projRow = rowById.get(v.project_id);
        if (!projRow) return;
        let count = 0;
        let byStatus = {};
        try {
          const stageData = JSON.parse(dataCrypto.decryptField(v.data_enc, `project-env:${v.project_id}:${v.environment_id}`));
          const endpoints = Array.isArray(stageData.endpoints) ? stageData.endpoints : [];
          const isOwner = projRow.owner_id === userId;
          const visible = isOwner ? endpoints : endpoints.filter((ep) => ep && ep.visibility === 'public');
          count = visible.length;
          byStatus = tallyByStatus(visible);
        } catch (err) {
          console.error('Failed to decrypt env snapshot for environment-metrics:', err);
        }
        promotedCounts.set(`${v.project_id}:${v.environment_id}`, count);
        promotedByStatus.set(`${v.project_id}:${v.environment_id}`, byStatus);
      });
    }

    const baselineTotal = Array.from(draftCounts.values()).reduce((s, n) => s + n, 0);

    const buildStageMetric = (env, idx) => {
      let totalEndpoints = 0, projectsWithEndpoints = 0;
      const byStatus = {};
      rows.forEach((row) => {
        const count = idx === 0 ? (draftCounts.get(row.id) || 0) : (promotedCounts.get(`${row.id}:${env.id}`) || 0);
        const statusTally = idx === 0 ? (draftByStatus.get(row.id) || {}) : (promotedByStatus.get(`${row.id}:${env.id}`) || {});
        totalEndpoints += count;
        if (count > 0) projectsWithEndpoints++;
        mergeByStatus(byStatus, statusTally);
      });
      return {
        environmentId: env.id,
        label: env.label,
        color: env.color,
        isDraftStage: idx === 0,
        totalEndpoints,
        projectsWithEndpoints,
        totalProjects: rows.length,
        percentOfBaseline: baselineTotal ? Math.round((totalEndpoints / baselineTotal) * 100) : (idx === 0 ? 0 : 0),
        byStatus,
      };
    };

    const stageMetrics = stages.map((env, idx) => buildStageMetric(env, idx));

    // "DR" environments auto-mirror the pipeline's last stage rather than
    // being a manual pipeline stage — see pipelineStages() above — but they
    // still hold their own project_env_versions rows, so they're reported
    // the same way, just kept in a separate list.
    const drEnvs = allEnvs.filter((e) => String(e.label || '').trim().toUpperCase() === 'DR');
    const mirrorMetrics = drEnvs.map((env) => buildStageMetric(env, -1)); // idx -1 => never the draft stage

    // Per-project breakdown — same counts, just grouped by project instead
    // of summed across the workspace. Lets the "APIs" table show each
    // project's own promotion progress instead of the old "has a base URL"
    // checkbox count.
    const perProject = rows.map((row) => {
      const byEnvironment = {};
      stages.forEach((env, idx) => {
        byEnvironment[env.id] = idx === 0 ? (draftCounts.get(row.id) || 0) : (promotedCounts.get(`${row.id}:${env.id}`) || 0);
      });
      const draftTotal = draftCounts.get(row.id) || 0;
      const readyTotal = draftReadyCounts.get(row.id) || 0;
      const stagesReached = stages.filter((env, idx) => idx > 0 && (byEnvironment[env.id] || 0) > 0).length;
      const lastStage = stages[stages.length - 1];
      // "Fully promoted" means every endpoint that's actually release-ready
      // (see endpointReadinessProblem) has reached the last stage — NOT every
      // endpoint the project has ever documented, so a project intentionally
      // leaving not-yet-ready endpoints out of the last stage can still show
      // as fully promoted once its ready subset is all live.
      const fullyPromoted = readyTotal > 0 && lastStage && byEnvironment[lastStage.id] === readyTotal;
      // Draft-stage status mix — this is the "current/API-level" breakdown
      // (what's live in the editable doc right now), as opposed to the
      // per-environment byStatus above which is scoped to a promoted snapshot.
      const byStatus = draftByStatus.get(row.id) || {};
      return { projectId: row.id, byEnvironment, draftTotal, readyTotal, stagesReached, fullyPromoted, byStatus };
    });

    res.json({
      stages: stageMetrics,
      mirrors: mirrorMetrics,
      totalProjects: rows.length,
      baselineTotal,
      pipelineStageCount: stages.length,
      perProject,
    });
  } catch (err) {
    console.error('GET environment-metrics failed:', err);
    res.status(500).json({ error: 'Could not load environment metrics.' });
  }
});


// ---- Endpoint release readiness (used by GET /environment-metrics) ----
// An endpoint is only counted as "ready" in environment-metrics' per-project
// readyTotal when it is status:active and its SecOps/VAPT/Log Mgmt reviews are
// all approved — see endpointReadinessProblem below.
const RELEASE_REVIEW_KINDS = ['secOps', 'vapt', 'logMgmt'];

function endpointReadinessProblem(ep) {
  const label = `${(ep.method || '').toUpperCase()} ${ep.path || ''}`;
  const status = ep.status || 'active';
  if (status !== 'active') {
    return `${label} is marked "${status.replace(/_/g, ' ')}", not Active`;
  }
  for (const kind of RELEASE_REVIEW_KINDS) {
    const st = ep[kind + 'Status'] || (ep[kind + 'Reviewed'] ? 'approved' : 'none');
    if (st !== 'approved') {
      return `${label} — ${kind} review is "${st.replace(/_/g, ' ')}", not approved`;
    }
  }
  return null;
}

// Shared by the diff and snapshot routes below: resolves one pipeline
// stage's endpoint data — the live draft for stage 0, otherwise whatever
// (if anything) has been promoted into that stage's frozen copy.
async function loadStageData(project, envId, stageIdx) {
  if (stageIdx === 0) return decryptProjectData(project);
  const { rows } = await pool.query(
    `SELECT data_enc FROM project_env_versions WHERE project_id = $1 AND environment_id = $2`,
    [project.id, envId]
  );
  if (!rows.length) return { endpoints: [] };
  return JSON.parse(dataCrypto.decryptField(rows[0].data_enc, `project-env:${project.id}:${envId}`));
}

// GET /api/workspace/projects/:id/snapshot?environmentId=X — read-only view
// of exactly what's live in one pipeline stage (the frozen promoted copy,
// or the live draft for stage 0). This is what the studio UI renders when
// someone switches the environment switcher away from the draft stage —
// browsing SIT/UAT/Staging/Production/etc. shows what was actually promoted
// there, not the still-being-edited draft.
//
// This has to apply the exact same three gates as GET /api/workspace
// (projectForViewer + applyDocLock above), or switching off the draft stage
// silently bypasses all of them: (1) a private, non-owned, non-granted
// project shouldn't be readable at all here just because the org matches;
// (2) someone viewing purely via the public catalog should only ever see
// endpoints marked public, promoted-stage snapshot or not; (3) whatever
// endpoints survive that cut still need per-endpoint doc-access locking
// unless the caller's role has blanket doc access.
router.get('/projects/:id/snapshot', async (req, res) => {
  try {
    const envKey = req.query.environmentId;
    if (!envKey) return res.status(400).json({ error: 'environmentId is required.' });

    const { rows } = await pool.query(
      `SELECT id, owner_id, organisation, visibility, has_public_endpoint, data, data_enc, release_version
       FROM projects WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Project not found.' });
    const project = rows[0];
    if (project.organisation !== req.authUser.organisation) return res.status(404).json({ error: 'Project not found.' });

    const userId = req.authUser.sub;
    const isOwner = project.owner_id === userId;
    let grant = null;
    if (!isOwner) {
      const { rows: grantRows } = await pool.query(
        `SELECT environments, permission FROM project_access WHERE project_id = $1 AND user_id = $2`,
        [req.params.id, userId]
      );
      if (grantRows.length) grant = grantRows[0];
    }
    // Same visibility rule as the main workspace listing (projectForViewer):
    // owner or an explicit share sees the project at all; everyone else only
    // if it (or at least one endpoint in it) is public.
    if (!isOwner && !grant && project.visibility !== 'public' && !project.has_public_endpoint) {
      return res.status(404).json({ error: 'Project not found.' });
    }

    const allEnvs = await getOrgEnvironments(project.organisation);
    const stages = pipelineStages(allEnvs);
    const idx = stages.findIndex((e) => e.id === envKey);
    if (idx < 0) return res.status(400).json({ error: 'Unknown environment.' });

    // A project_access grant also names which environments this person may
    // browse for this project (see projectForViewer's _grantedEnvironments) —
    // enforce that here too, not just for Try It.
    if (grant && !grantCoversEnvironment(grant.environments, envKey)) {
      return res.status(403).json({ error: 'You do not have access to this environment for this project.' });
    }

    const isDraft = idx === 0;
    let versionLabel = null, promotedAt = null, promotedBy = null;
    if (!isDraft) {
      const { rows: vRows } = await pool.query(
        `SELECT version, promoted_at, promoted_by_username FROM project_env_versions WHERE project_id = $1 AND environment_id = $2`,
        [project.id, envKey]
      );
      if (vRows.length) {
        versionLabel = `1.0.${vRows[0].version}`;
        promotedAt = vRows[0].promoted_at;
        promotedBy = vRows[0].promoted_by_username;
      }
    }

    const stageData = await loadStageData(project, envKey, idx);
    let endpoints = Array.isArray(stageData.endpoints) ? stageData.endpoints : [];

    if (!isOwner && !grant) {
      endpoints = endpoints.filter((ep) => ep && ep.visibility === 'public');
      if (endpoints.length && !userHasFullDocAccess(req.authUser)) {
        const accessMap = await getDocAccessMap(project.organisation, userId, project.id, endpoints.map((e) => e.id), envKey);
        endpoints = endpoints.map((ep) => applyDocLock(ep, accessMap.get(ep.id)));
      }
    }

    // SECURITY (Finding 4.2): same masking as GET /api/workspace — applied
    // after doc-locking so a locked stub's absent fields stay absent.
    const orgRules = await getOrgPiiRules(project.organisation);
    endpoints = endpoints.map((ep) => piiMasking.maskEndpoint(ep, orgRules));

    // Attachments are project-level, frozen into the stage snapshot exactly
    // like endpoints are — so switching the environment switcher off the
    // draft has to switch the Documents list too, not keep showing whatever
    // is currently on the draft. Same visibility rule as projectForViewer's
    // attachments field: a non-owner/non-grant viewer only sees them if the
    // whole project is public, never per-endpoint-public.
    let attachments = Array.isArray(stageData.attachments) ? stageData.attachments : [];
    if (!isOwner && !grant && project.visibility !== 'public') attachments = [];

    res.json({
      environmentId: envKey,
      label: stages[idx].label,
      isDraft,
      versionLabel: isDraft ? `1.0.${project.release_version} (draft)` : versionLabel,
      promotedAt,
      promotedBy,
      endpoints,
      attachments,
    });
  } catch (err) {
    console.error('GET project snapshot failed:', err);
    res.status(500).json({ error: 'Could not load environment snapshot.' });
  }
});


// POST /api/workspace/projects/:id/openapi-link — mints a short-lived,
// signed public URL for this project's full combined OpenAPI spec, meant to
// be handed straight to a third-party tool (editor.swagger.io) that can't
// carry our session cookie. Anyone who can already view this project inside
// the app can mint one (same visibility rule as GET /versions and /diff
// above — via resolveAccessById, so an explicit project_access grant works
// too, not just ownership or a fully public project) — this isn't a new
// access grant, just a differently-shaped export of data the caller can
// already see and already export via "View > Swagger" per endpoint or
// "Export as PDF" for the whole project.
//
// The link itself expires in 10 minutes (enforced in server.js on read) and
// only ever serves the always-masked spec built by openapiExport.js — never
// real host URLs or secret values — regardless of whether an Admin currently
// has "reveal" turned on in their own session.
router.post('/projects/:id/openapi-link', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, owner_id, organisation, visibility, has_public_endpoint, data, data_enc FROM projects WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Project not found.' });
    const project = rows[0];
    if (project.organisation !== req.authUser.organisation) return res.status(404).json({ error: 'Project not found.' });
    const access = await resolveAccessById(req.authUser.sub, req.params.id, req.authUser.organisation);
    if (!access.canView) return res.status(404).json({ error: 'Project not found.' });

    const token = dataCrypto.encryptShareToken({
      pid: project.id,
      org: project.organisation,
      exp: Date.now() + 10 * 60 * 1000,
    });
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json({ url: `${baseUrl}/public/openapi/${encodeURIComponent(token)}.yaml`, expiresInSeconds: 600 });
  } catch (err) {
    console.error('POST openapi-link failed:', err);
    res.status(500).json({ error: 'Could not generate a share link.' });
  }
});


module.exports = router;
module.exports.MAX_ATTACHMENT_BYTES = MAX_ATTACHMENT_BYTES;
module.exports.reencryptOrganisation = reencryptOrganisation;
module.exports.decryptProjectData = decryptProjectData;
module.exports.getOrgEnvironments = getOrgEnvironments;
module.exports.pipelineStages = pipelineStages;
module.exports.getDocAccessMap = getDocAccessMap;
module.exports.loadStageData = loadStageData;
module.exports.projectForViewer = projectForViewer;
module.exports.applyDocLock = applyDocLock;
module.exports.userHasFullDocAccess = userHasFullDocAccess;
module.exports.duplicateEndpointError = duplicateEndpointError;
module.exports.endpointFieldsError = endpointFieldsError;
