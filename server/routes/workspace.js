const express = require('express');
const nodeCrypto = require('crypto');
const { pool } = require('../db');
const { authenticate, requireAdmin, blockIfScheduleLocked } = require('../middleware/authGuard');
const { recordAuditEvent } = require('../auditService');
const dataCrypto = require('../crypto');
const storage = require('../storage');
const cache = require('../cache');
const { resolveAccessById, environmentAllowed } = require('../projectAccess');
const { notifyUser, notifyUsers, adminUserIds } = require('../notifications');
const { detectBreakingChanges } = require('../breakingChangeDetector');
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
// synchronous, save-time gate; the DNS-resolving check happens again,
// immediately before firing, in server/routes/liveMode.js. Returns an error
// string, or null if every entry is fine.
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
function duplicateEndpointError(projectData) {
  const endpoints = Array.isArray(projectData && projectData.endpoints) ? projectData.endpoints : [];
  const seen = new Set();
  for (const ep of endpoints) {
    if (!ep || !ep.method || !ep.path) continue;
    const key = `${String(ep.method).toUpperCase()} ${String(ep.path).trim()}`;
    if (seen.has(key)) {
      return `This project already has two endpoints for ${key} — give one a different path, or delete the duplicate before saving.`;
    }
    seen.add(key);
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
            tryit_collections_enc, endpoint_metrics_enc, environments_key_version,
            request_history_key_version, tryit_collections_key_version, endpoint_metrics_key_version
     FROM org_workspace WHERE organisation = $1`,
    [organisation]
  );
  if (wsRows.length) {
    const ws = wsRows[0];
    const envPlain = decryptOrgBlob(ws.environments_enc, ws.environments, organisation, 'environments', []);
    const histPlain = decryptOrgBlob(ws.request_history_enc, ws.request_history, organisation, 'request_history', {});
    const tryitPlain = decryptOrgBlob(ws.tryit_collections_enc, null, organisation, 'tryit_collections', { variables: [], saved: [] });
    const metricsPlain = decryptOrgBlob(ws.endpoint_metrics_enc, null, organisation, 'endpoint_metrics', {});
    const envEnc = encryptOrgBlob(envPlain, organisation, 'environments');
    const histEnc = encryptOrgBlob(histPlain, organisation, 'request_history');
    const tryitEnc = encryptOrgBlob(tryitPlain, organisation, 'tryit_collections');
    const metricsEnc = encryptOrgBlob(metricsPlain, organisation, 'endpoint_metrics');
    await pool.query(
      `UPDATE org_workspace SET
         environments = '[]'::jsonb, environments_enc = $1, environments_key_version = $2,
         request_history = '{}'::jsonb, request_history_enc = $3, request_history_key_version = $4,
         tryit_collections_enc = $5, tryit_collections_key_version = $6,
         endpoint_metrics_enc = $7, endpoint_metrics_key_version = $8
       WHERE organisation = $9
         AND environments_key_version IS NOT DISTINCT FROM $10
         AND request_history_key_version IS NOT DISTINCT FROM $11
         AND tryit_collections_key_version IS NOT DISTINCT FROM $12
         AND endpoint_metrics_key_version IS NOT DISTINCT FROM $13`,
      [envEnc.enc, envEnc.version, histEnc.enc, histEnc.version, tryitEnc.enc, tryitEnc.version, metricsEnc.enc, metricsEnc.version,
        organisation, ws.environments_key_version, ws.request_history_key_version, ws.tryit_collections_key_version, ws.endpoint_metrics_key_version]
    );
  }
  return { projects: projectsTouched, orgWorkspace: true };
}

// A project is visible in full only to its owner, OR to someone holding a
// named project_access grant (see server/projectAccess.js) — a grant means
// "share the whole project with this person," same as an owner would see it,
// gated only by `_readonly` (view-only grants can't be saved back) and
// `_grantedEnvironments` (which of the project's environments this person may
// actually use in Try It/Live Mode/promotion views — enforced at THOSE call
// sites, not here, since endpoints themselves aren't per-environment).
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
        `SELECT environments, environments_enc, request_history, request_history_enc, tryit_collections_enc, endpoint_metrics_enc, custom_flow_directions, custom_icons, branding
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
    // Composed from per-writer segments when the blob has them, returned
    // as-is otherwise (a single-agent deployment, or data written before
    // multi-writer support). Either way the client sees one flat shape.
    const storedMetrics = decryptOrgBlob(ws.endpoint_metrics_enc, null, org, 'endpoint_metrics', {});
    const endpointMetrics = composeWriterSegments(storedMetrics);
    const payload = {
      projects,
      environments: decryptOrgBlob(ws.environments_enc, ws.environments, org, 'environments', []),
      requestHistory: decryptOrgBlob(ws.request_history_enc, ws.request_history, org, 'request_history', {}),
      tryitCollections: decryptOrgBlob(ws.tryit_collections_enc, null, org, 'tryit_collections', { variables: [], saved: [] }),
      endpointMetrics,
      // Revision of the STORED blob, not the composed view above - a
      // whole-blob writer is overwriting what's stored, so that's what it
      // has to prove it read. See PUT /endpoint-metrics.
      endpointMetricsRev: metricsRev(storedMetrics),
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
    // one stale entry — same tolerance liveMode.js applies to its grants.
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

    // Attachments are frozen into each stage's snapshot the same as
    // endpoints are (see finalizePromotion) — without this, downloading a
    // document while viewing SIT/UAT/Staging/Production always served
    // whatever's on the current DEV draft instead of what was actually
    // promoted, so a document replaced after a promotion looked identical
    // in every environment even though the live stages hadn't changed.
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
    : purpose === 'tryit_collections' ? 'tryit_collections'
    : purpose === 'endpoint_metrics' ? 'endpoint_metrics' : 'request_history';
  const legacyPlaceholder = column === 'environments' ? '[]' : '{}';
  if (column === 'tryit_collections' || column === 'endpoint_metrics') {
    // No legacy plaintext column for either - both were born encrypted-only.
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

// Traffic metrics pushed by the SIT log auto-discovery agent (ops/sit-doc-agent) -
// keyed by "METHOD /path", org-shared, encrypted like request_history (client IPs
// are PII). Whole-blob overwrite by design: the agent recomputes and replaces its
// own metrics wholesale from its own state each push, same as the doc-discovery
// project push - no merge-by-key needed since there's exactly one writer
// (the service account), not multiple humans editing concurrently.
// Optimistic-locking guard for the endpoint-metrics blob.
//
// This blob is written as a WHOLE-BLOB OVERWRITE by the SIT log agent, and
// "only one writer" used to be enforced by nothing but convention. Two agents
// running at once (a stale systemd unit, a manual debug run alongside the
// service, a second server) meant one silently erased the other's entire
// history - every counter, every record - with no error and no trace.
//
// Unlike projects, this can't key off org_workspace.updated_at: that column is
// shared with environments / request_history / tryit_collections, so an
// unrelated write to any of those would bump it and cause a false conflict
// here. A content hash of the blob itself is the honest revision - it changes
// when and only when THIS blob changes.
function metricsRev(value) {
  return nodeCrypto.createHash('sha256')
    .update(JSON.stringify(value === undefined ? {} : value))
    .digest('hex')
    .slice(0, 16);
}

// --- Multi-writer support ---------------------------------------------------
// Whole-blob overwrite only works with exactly one agent. A deployment with
// several Mule servers needs one agent per server, and they must not clobber
// each other - the ifMatchRev guard above would make them 409 in a loop
// instead, which is safe but useless.
//
// So a writer may instead claim only its OWN segment: the stored blob becomes
// { writers: { [writerId]: {endpoints, agentHealth, logRecords, updatedAt} } }
// and a merge-mode write replaces exactly one segment, leaving the others
// untouched. No lost updates, no conflict, no coordination between agents.
//
// GET composes the segments back into the flat { endpoints, agentHealth,
// logRecords } shape the client already reads, so nothing on the page has to
// know this happened.
const MAX_METRICS_WRITERS = 50;

// Endpoint counters are summed across writers reporting the SAME endpoint,
// which is right for two load-balanced nodes of one environment and wrong
// across environments: the same API is deployed to SIT, UAT and PROD, so a
// pooled `totalRequests` is not a rougher truth but a meaningless number, and
// a pooled `topSourceIps` leaks PROD client addresses into a SIT view.
//
// So composition happens strictly WITHIN an environment. Each writer segment
// carries the environment its node serves (the agent refuses to guess it);
// segments from before this existed have none, and are grouped under
// UNSCOPED_ENVIRONMENT so they stay visible rather than vanishing.
const UNSCOPED_ENVIRONMENT = 'Unscoped';

function segmentEnvironment(seg) {
  const raw = typeof seg.environment === 'string' ? seg.environment.trim() : '';
  return raw ? raw.slice(0, 32) : UNSCOPED_ENVIRONMENT;
}

function composeOneEnvironment(entries) {
  const endpoints = {};
  let logRecords = [];
  const agents = [];

  for (const [writerId, seg] of entries) {
    for (const [key, ep] of Object.entries(seg.endpoints || {})) {
      const prev = endpoints[key];
      if (!prev) { endpoints[key] = { ...ep }; continue; }
      // Same method+path seen on two servers: these are aggregate counters,
      // so the union is the sum. Anything else would under-report a
      // load-balanced endpoint.
      const merged = { ...prev };
      merged.totalRequests = (prev.totalRequests || 0) + (ep.totalRequests || 0);
      merged.statusBreakdown = { ...(prev.statusBreakdown || {}) };
      for (const [fam, n] of Object.entries(ep.statusBreakdown || {})) {
        merged.statusBreakdown[fam] = (merged.statusBreakdown[fam] || 0) + n;
      }
      const errs = (merged.statusBreakdown['4xx'] || 0) + (merged.statusBreakdown['5xx'] || 0);
      const withStatus = Object.values(merged.statusBreakdown).reduce((a, b) => a + b, 0);
      merged.errorRate = withStatus ? Math.round((errs / withStatus) * 10000) / 10000 : 0;
      // Source IPs: sum per IP, then keep the heaviest few.
      const ipTotals = new Map();
      for (const list of [prev.topSourceIps || [], ep.topSourceIps || []]) {
        for (const row of list) ipTotals.set(row.ip, (ipTotals.get(row.ip) || 0) + (row.count || 0));
      }
      merged.topSourceIps = [...ipTotals.entries()]
        .sort((a, b) => b[1] - a[1]).slice(0, 10)
        .map(([ip, count]) => ({ ip, count }));
      merged.lastSeenAt = [prev.lastSeenAt, ep.lastSeenAt].filter(Boolean).sort().pop() || null;
      endpoints[key] = merged;
    }
    if (Array.isArray(seg.logRecords)) logRecords = logRecords.concat(seg.logRecords);
    if (isPlainObject(seg.agentHealth)) agents.push({ writerId, ...seg.agentHealth });
  }

  // Newest-first, then capped - with several agents this is the union of
  // their ring buffers and could otherwise grow without bound.
  logRecords.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  logRecords = logRecords.slice(0, 5000);

  // The page renders one agentHealth card; give it the most recently
  // generated one, and attach every writer's own health beside it so a
  // multi-server deployment can still see each agent individually.
  agents.sort((a, b) => String(b.generatedAt || '').localeCompare(String(a.generatedAt || '')));
  const agentHealth = agents.length ? { ...agents[0], writers: agents } : null;

  return { endpoints, agentHealth, logRecords };
}

function composeWriterSegments(stored) {
  if (!isPlainObject(stored) || !isPlainObject(stored.writers)) return stored || {};

  const byEnv = new Map();
  for (const [writerId, seg] of Object.entries(stored.writers)) {
    if (!isPlainObject(seg)) continue;
    const env = segmentEnvironment(seg);
    if (!byEnv.has(env)) byEnv.set(env, []);
    byEnv.get(env).push([writerId, seg]);
  }

  const environments = {};
  for (const [env, entries] of byEnv) environments[env] = composeOneEnvironment(entries);

  // The page picks ONE environment to display. A single-environment install
  // (the common case) still gets the flat shape at the top level so nothing
  // downstream has to special-case it; with several, the flat fields describe
  // the default environment only, and `environmentNames` drives the selector.
  // They are deliberately NOT a cross-environment sum - see the note above.
  const names = [...byEnv.keys()].sort();
  const primary = names.includes(UNSCOPED_ENVIRONMENT) && names.length > 1
    ? names.find((n) => n !== UNSCOPED_ENVIRONMENT)
    : names[0];
  const head = (primary && environments[primary]) || { endpoints: {}, agentHealth: null, logRecords: [] };

  return { ...head, environments, environmentNames: names, defaultEnvironment: primary || null };
}

router.put('/endpoint-metrics', async (req, res) => {
  if (!isPlainObject(req.body?.endpointMetrics)) return res.status(400).json({ error: 'Expected { endpointMetrics: {} }.' });
  const org = req.authUser.organisation;
  try {
    // Merge mode: this writer owns one named segment and never touches the
    // others, so several agents (one per Mule server) can write concurrently
    // with no conflict and no lost updates. No ifMatchRev is needed or
    // honoured here - there is nothing to race against.
    const writerId = typeof req.body.writerId === 'string' ? req.body.writerId.trim().slice(0, 64) : '';
    if (writerId) {
      // The merge itself is a read-modify-write of one encrypted blob, which
      // cannot be done with jsonb_set - the value is ciphertext. So it runs
      // inside a transaction holding FOR UPDATE on the row: without that,
      // two agents pushing at the same moment would both read the same
      // `writers` map and the second write would drop the first agent's
      // segment. That is exactly the lost-update class of bug this whole
      // endpoint is being hardened against, so it would be absurd to
      // reintroduce it here.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query(
          `SELECT endpoint_metrics_enc FROM org_workspace WHERE organisation = $1 FOR UPDATE`,
          [org]
        );
        const stored = rows.length
          ? decryptOrgBlob(rows[0].endpoint_metrics_enc, null, org, 'endpoint_metrics', {})
          : {};
        // A blob written by a pre-merge single agent has no `writers` key.
        // Its data is adopted under a reserved id rather than discarded, so
        // switching an existing deployment to merge mode doesn't reset
        // history.
        const writers = isPlainObject(stored.writers) ? { ...stored.writers } : (
          (stored.endpoints || stored.agentHealth) ? { 'legacy-single-writer': stored } : {}
        );
        if (!writers[writerId] && Object.keys(writers).length >= MAX_METRICS_WRITERS) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: `Too many distinct metrics writers (${MAX_METRICS_WRITERS}). Each agent must send a STABLE writerId; a value that changes per restart will exhaust this.`,
          });
        }
        // The environment label is rendered on a page and used as a grouping
        // key, so it is constrained here rather than taken as sent - an agent
        // is not a trusted source of display strings.
        const seg = { ...req.body.endpointMetrics, updatedAt: new Date().toISOString() };
        const envRaw = typeof seg.environment === 'string' ? seg.environment.trim() : '';
        seg.environment = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,31}$/.test(envRaw) ? envRaw : null;
        if (envRaw && !seg.environment) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: 'environment must be a short label (letters, digits, spaces, - or _, max 32 chars).',
          });
        }
        writers[writerId] = seg;
        const { enc, version } = encryptOrgBlob({ writers }, org, 'endpoint_metrics');
        await client.query(
          `INSERT INTO org_workspace (organisation, endpoint_metrics_enc, endpoint_metrics_key_version, updated_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (organisation) DO UPDATE SET
             endpoint_metrics_enc = EXCLUDED.endpoint_metrics_enc,
             endpoint_metrics_key_version = EXCLUDED.endpoint_metrics_key_version, updated_at = now()`,
          [org, enc, version]
        );
        await client.query('COMMIT');
        await cache.invalidateOrg(org);
        return res.json({ ok: true, writerId, writerCount: Object.keys(writers).length });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }

    // A client that sends `ifMatchRev` is held to it; one that omits it (an
    // older agent build) is never blocked - same forgiving contract the
    // projects route uses for `_rev`, so upgrading the server can't break a
    // deployed agent.
    if (typeof req.body.ifMatchRev === 'string') {
      const { rows } = await pool.query(
        `SELECT endpoint_metrics_enc FROM org_workspace WHERE organisation = $1`,
        [org]
      );
      const current = rows.length
        ? decryptOrgBlob(rows[0].endpoint_metrics_enc, null, org, 'endpoint_metrics', {})
        : {};
      const actualRev = metricsRev(current);
      if (actualRev !== req.body.ifMatchRev) {
        // 409, NOT a silent win-by-last-write. The caller is expected to
        // re-read and retry rather than force its stale copy through.
        return res.status(409).json({
          error: 'Endpoint metrics changed since you read them — another writer (a second agent?) is active. Re-read and retry.',
          currentRev: actualRev,
        });
      }
    }
    await upsertEncryptedOrgWorkspace(org, 'endpoint_metrics', req.body.endpointMetrics);
    await cache.invalidateOrg(org);
    res.json({ ok: true, rev: metricsRev(req.body.endpointMetrics) });
  } catch (err) {
    console.error('PUT endpoint-metrics failed:', err);
    res.status(500).json({ error: 'Could not save endpoint metrics.' });
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
// Environment release pipeline: Dev (live draft) -> SIT -> UAT -> Staging ->
// Production, each non-Dev stage holding a frozen, versioned snapshot until
// explicitly promoted forward. Promotion is Admin-only.
//
// The pipeline order comes from the org's OWN environments list (org_workspace
// .environments — user-configurable, see the environment settings UI), not a
// hardcoded list, since orgs can rename/reorder/add environments freely. One
// convention: an environment labeled "DR" (case-insensitive) is never a
// manual pipeline stage — it always auto-mirrors whatever's currently in the
// pipeline's last stage (Production, by default) the moment that stage is
// promoted to, with no separate "Promote" click.
// ============================================================================

function isAdminUser(req) {
  return req.authUser.role === 'admin';
}

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
    // How many of this project's draft endpoints actually pass the
    // Production gate right now (see partitionForFinalStagePromotion) —
    // needed below so "fully promoted" means "every endpoint that CAN be in
    // Production IS," not "literally every endpoint the project has ever
    // documented," which a project using partial Production promotion could
    // never satisfy even once its ready endpoints are genuinely all live.
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
      // has reached the last stage — NOT every endpoint the project has ever
      // documented. A project intentionally leaving not-yet-ready endpoints
      // out of Production (see partitionForFinalStagePromotion) should still
      // be able to show as fully promoted once its ready subset is all live,
      // rather than being permanently stuck below 100% for endpoints that
      // were never eligible in the first place.
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

// GET /api/workspace/projects/:id/versions — read-only status of every stage
// for this project. Any org member who can see the project may view it;
// promoting is Admin-only (enforced in the POST route below).
// GET /api/workspace/projects/:id/versions — release-pipeline status
// (version numbers, who promoted, when) for one project.
//
// Previously this only checked `project.organisation === req.authUser.organisation`
// — ANY signed-in member of the organisation could pull the promotion status
// of ANY project, including a fully private one with no public endpoint and
// no explicit share, just by knowing its id. Same visibility rule as
// GET /projects/:id/snapshot and /diff now applies: owner, an explicit
// project_access grant, or the project (or at least one endpoint) being
// public.
router.get('/projects/:id/versions', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, owner_id, organisation, visibility, has_public_endpoint, release_version FROM projects WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Project not found.' });
    const project = rows[0];
    if (project.organisation !== req.authUser.organisation) return res.status(404).json({ error: 'Project not found.' });

    const access = await resolveAccessById(req.authUser.sub, req.params.id, req.authUser.organisation);
    if (!access.canView) return res.status(404).json({ error: 'Project not found.' });

    const allEnvs = await getOrgEnvironments(project.organisation);
    const stages = pipelineStages(allEnvs);
    const drEnvs = allEnvs.filter((e) => String(e.label || '').trim().toUpperCase() === 'DR');

    const { rows: versionRows } = await pool.query(
      `SELECT environment_id, version, source_environment_id, promoted_by_username, auto_mirrored, promoted_at
       FROM project_env_versions WHERE project_id = $1`,
      [req.params.id]
    );
    const byEnv = new Map(versionRows.map((r) => [r.environment_id, r]));

    res.json({
      releaseVersion: project.release_version,
      draftLabel: `1.0.${project.release_version} (draft)`,
      stages: stages.map((env, idx) => {
        const v = byEnv.get(env.id);
        return {
          environmentId: env.id,
          label: env.label,
          color: env.color,
          isDraftStage: idx === 0,
          // GitHub-style branch protection: an environment flagged this way
          // can't be promoted into directly (POST /promote refuses it) — a
          // second Admin has to approve a promotion request instead. See
          // POST /projects/:id/promotion-requests below.
          requiresApproval: !!env.requiresApproval,
          version: v ? v.version : null,
          versionLabel: v ? `1.0.${v.version}` : null,
          promotedBy: v ? v.promoted_by_username : null,
          promotedAt: v ? v.promoted_at : null,
          sourceEnvironmentId: v ? v.source_environment_id : null,
        };
      }),
      mirrors: drEnvs.map((env) => {
        const v = byEnv.get(env.id);
        return {
          environmentId: env.id,
          label: env.label,
          version: v ? v.version : null,
          versionLabel: v ? `1.0.${v.version}` : null,
          mirrorsEnvironmentId: v ? v.source_environment_id : null,
          promotedAt: v ? v.promoted_at : null,
        };
      }),
    });
  } catch (err) {
    console.error('GET project versions failed:', err);
    res.status(500).json({ error: 'Could not load release pipeline status.' });
  }
});

// GET /api/workspace/projects/:id/release-history — Release Pipeline v2's
// GitHub-style unified merge history: every promotion/rollback across EVERY
// environment for this project, newest first, in one feed instead of having
// to open each stage's own history panel separately. Same access rule as
// GET /versions above (owner, an explicit grant, or a public project) since
// it's the same class of metadata, just the full timeline instead of only
// "what's live right now."
router.get('/projects/:id/release-history', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, owner_id, organisation, visibility, has_public_endpoint FROM projects WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Project not found.' });
    const project = rows[0];
    if (project.organisation !== req.authUser.organisation) return res.status(404).json({ error: 'Project not found.' });

    const access = await resolveAccessById(req.authUser.sub, req.params.id, req.authUser.organisation);
    if (!access.canView) return res.status(404).json({ error: 'Project not found.' });

    const allEnvs = await getOrgEnvironments(project.organisation);
    const labelById = new Map(allEnvs.map((e) => [e.id, e.label]));

    // ---- Pagination + filters (GitHub commit-log parity) ----
    // `before` is a history row id cursor, not an offset — offset pagination
    // over a feed that keeps getting new rows at the top would skip or
    // repeat entries as promotions land between page loads; "give me
    // everything with id < this" is stable regardless of what's added
    // concurrently. One extra row is fetched past `limit` purely to know
    // whether there's more to page to, then trimmed back off before
    // responding.
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
    const before = req.query.before ? parseInt(req.query.before, 10) : null;
    const environmentId = req.query.environmentId ? String(req.query.environmentId) : null;
    const author = req.query.author ? String(req.query.author).trim() : null;
    const breakingOnly = req.query.breakingOnly === 'true' || req.query.breakingOnly === '1';

    const params = [req.params.id];
    let where = 'WHERE project_id = $1';
    if (environmentId) { params.push(environmentId); where += ` AND environment_id = $${params.length}`; }
    if (author) { params.push(`%${author}%`); where += ` AND promoted_by_username ILIKE $${params.length}`; }
    if (breakingOnly) { where += ` AND jsonb_array_length(breaking_changes) > 0`; }
    if (before && Number.isFinite(before)) { params.push(before); where += ` AND id < $${params.length}`; }
    params.push(limit + 1);

    const { rows: historyRows } = await pool.query(
      `SELECT id, environment_id, version, source_environment_id, action, rolled_back_from_id,
              promoted_by_username, auto_mirrored, promoted_at, release_note, breaking_changes
       FROM project_env_version_history ${where} ORDER BY promoted_at DESC, id DESC LIMIT $${params.length}`,
      params
    );
    const hasMore = historyRows.length > limit;
    const pageRows = hasMore ? historyRows.slice(0, limit) : historyRows;

    res.json({
      entries: pageRows.map((h) => ({
        id: h.id,
        environmentId: h.environment_id,
        environmentLabel: labelById.get(h.environment_id) || h.environment_id,
        version: h.version,
        versionLabel: `1.0.${h.version}`,
        sourceEnvironmentId: h.source_environment_id,
        sourceEnvironmentLabel: h.source_environment_id ? (labelById.get(h.source_environment_id) || h.source_environment_id) : null,
        action: h.action,
        rolledBackFromId: h.rolled_back_from_id,
        promotedByUsername: h.promoted_by_username,
        autoMirrored: h.auto_mirrored,
        promotedAt: h.promoted_at,
        releaseNote: h.release_note,
        breakingChanges: Array.isArray(h.breaking_changes) ? h.breaking_changes : [],
      })),
      hasMore,
      nextBefore: hasMore ? pageRows[pageRows.length - 1].id : null,
    });
  } catch (err) {
    console.error('GET release history failed:', err);
    res.status(500).json({ error: 'Could not load release history.' });
  }
});

// GET /api/workspace/projects/:id/release-health — breaking-changes-per-
// release trend for the Overview page's sparkline (Release Pipeline v2 item
// #5: "a signal, not just something you see mid-promotion"). One point per
// promotion INTO the pipeline's last stage (the stage that actually reaches
// consumers), not every intermediate SIT/UAT hop, so the sparkline reads as
// "releases that shipped" rather than every internal promotion.
router.get('/projects/:id/release-health', async (req, res) => {
  try {
    const { rows: projRows } = await pool.query(`SELECT id, organisation FROM projects WHERE id = $1`, [req.params.id]);
    if (!projRows.length || projRows[0].organisation !== req.authUser.organisation) {
      return res.status(404).json({ error: 'Project not found.' });
    }
    const access = await resolveAccessById(req.authUser.sub, req.params.id, req.authUser.organisation);
    if (!access.canView) return res.status(404).json({ error: 'Project not found.' });

    const allEnvs = await getOrgEnvironments(projRows[0].organisation);
    const stages = pipelineStages(allEnvs);
    if (stages.length < 2) return res.json({ points: [] });
    const lastStage = stages[stages.length - 1];

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 12, 1), 50);
    const { rows } = await pool.query(
      `SELECT version, breaking_changes, promoted_at FROM project_env_version_history
       WHERE project_id = $1 AND environment_id = $2 AND action = 'promote'
       ORDER BY promoted_at DESC, id DESC LIMIT $3`,
      [req.params.id, lastStage.id, limit]
    );
    const points = rows.reverse().map((r) => ({
      versionLabel: `1.0.${r.version}`,
      breakingChangesCount: Array.isArray(r.breaking_changes) ? r.breaking_changes.length : 0,
      promotedAt: r.promoted_at,
    }));
    res.json({ lastStageLabel: lastStage.label, points });
  } catch (err) {
    console.error('GET release-health failed:', err);
    res.status(500).json({ error: 'Could not load release health.' });
  }
});

// ---- Shared promotion core (item: GitHub-style branch protection) ----
// Everything from "encrypt the target snapshot" through the mirror insert,
// commit, audit trail, and Admin notification is IDENTICAL whether a
// promotion happens immediately (POST /promote, target doesn't require
// approval) or after a second Admin approves a promotion request (target
// DOES require approval — see project_promotion_requests below). This is
// that shared tail end, so the two call sites can't drift out of sync on
// what "a promotion" actually does.
// Writes the promotion itself (target stage + optional DR mirror) inside
// the caller's already-open transaction. Deliberately does NOT commit —
// see the two call sites: direct-promote has nothing left to do and
// commits right after calling this, but the approve-a-request path still
// has one more write of its own (marking the request row 'approved') that
// must land in the SAME transaction as everything here. This function used
// to commit+release internally, which meant the approve route's later
// UPDATE ran against an already-closed transaction — any hiccup there
// (which is exactly what happened in practice) left the promotion silently
// applied while the request stayed stuck "pending" forever, with no way to
// tell from the outside that anything had actually gone through.
async function finalizePromotion(client, req, {
  project, allEnvs, stages, fromIdx, targetStage, sourceData, newReleaseVersion,
  fromEnvironmentId, releaseNote, breakingChanges, actingUser,
}) {
  const targetEnc = dataCrypto.encryptField(JSON.stringify(sourceData), `project-env:${project.id}:${targetStage.id}`);
  const targetKeyVersion = dataCrypto.currentKeyVersion();
  await client.query(
    `INSERT INTO project_env_versions
       (project_id, environment_id, version, data_enc, data_key_version, source_environment_id, promoted_by, promoted_by_username, auto_mirrored, promoted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, now())
     ON CONFLICT (project_id, environment_id) DO UPDATE SET
       version = EXCLUDED.version, data_enc = EXCLUDED.data_enc, data_key_version = EXCLUDED.data_key_version,
       source_environment_id = EXCLUDED.source_environment_id, promoted_by = EXCLUDED.promoted_by,
       promoted_by_username = EXCLUDED.promoted_by_username, auto_mirrored = false, promoted_at = now()`,
    [project.id, targetStage.id, newReleaseVersion, targetEnc, targetKeyVersion, fromEnvironmentId, actingUser.sub, actingUser.username]
  );
  await recordEnvVersionHistory(client, {
    projectId: project.id, environmentId: targetStage.id, version: newReleaseVersion,
    dataEnc: targetEnc, dataKeyVersion: targetKeyVersion, sourceEnvironmentId: fromEnvironmentId,
    action: 'promote', promotedBy: actingUser.sub, promotedByUsername: actingUser.username, autoMirrored: false,
    releaseNote, breakingChanges,
  });

  let mirrored = null;
  const isLastStage = fromIdx + 1 === stages.length - 1;
  if (isLastStage) {
    const drEnv = allEnvs.find((e) => String(e.label || '').trim().toUpperCase() === 'DR');
    if (drEnv) {
      const mirrorEnc = dataCrypto.encryptField(JSON.stringify(sourceData), `project-env:${project.id}:${drEnv.id}`);
      const mirrorKeyVersion = dataCrypto.currentKeyVersion();
      await client.query(
        `INSERT INTO project_env_versions
           (project_id, environment_id, version, data_enc, data_key_version, source_environment_id, promoted_by, promoted_by_username, auto_mirrored, promoted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, now())
         ON CONFLICT (project_id, environment_id) DO UPDATE SET
           version = EXCLUDED.version, data_enc = EXCLUDED.data_enc, data_key_version = EXCLUDED.data_key_version,
           source_environment_id = EXCLUDED.source_environment_id, promoted_by = EXCLUDED.promoted_by,
           promoted_by_username = EXCLUDED.promoted_by_username, auto_mirrored = true, promoted_at = now()`,
        [project.id, drEnv.id, newReleaseVersion, mirrorEnc, mirrorKeyVersion, targetStage.id, actingUser.sub, actingUser.username]
      );
      await recordEnvVersionHistory(client, {
        projectId: project.id, environmentId: drEnv.id, version: newReleaseVersion,
        dataEnc: mirrorEnc, dataKeyVersion: mirrorKeyVersion, sourceEnvironmentId: targetStage.id,
        action: 'promote', promotedBy: actingUser.sub, promotedByUsername: actingUser.username, autoMirrored: true,
        releaseNote: `Auto-mirrored from ${targetStage.label}: ${releaseNote}`,
      });
      mirrored = { environmentId: drEnv.id, label: drEnv.label };
    }
  }

  return { toEnvironmentId: targetStage.id, toEnvironmentLabel: targetStage.label, versionLabel: `1.0.${newReleaseVersion}`, mirrored };
}

// Side effects that only make sense once the promotion has ACTUALLY
// committed — cache invalidation, audit log, notifications. Called by both
// finalizePromotion() callers right after their own successful COMMIT,
// never before. Failures here (e.g. a notification hiccup) intentionally
// don't roll back the promotion — the write already happened — they just
// won't crash the request; each call site still returns ok:true either way
// since the promotion itself is what the caller actually asked for.
async function afterPromotionCommitted(req, {
  project, stages, fromIdx, targetStage, newReleaseVersion, fromEnvironmentId, releaseNote, breakingChanges, actingUser, mirrored,
}) {
  await cache.invalidateOrg(project.organisation);

  await recordAuditEvent(actingUser, req, {
    action: 'PROJECT_PROMOTED',
    resourceType: 'project',
    resourceId: project.id,
    entityName: stages[fromIdx].label + ' → ' + targetStage.label,
    details: `Promoted "${project.id}" from ${stages[fromIdx].label} to ${targetStage.label} — v1.0.${newReleaseVersion}.`
      + (breakingChanges.length ? ` Included ${breakingChanges.length} acknowledged breaking change${breakingChanges.length === 1 ? '' : 's'}.` : ''),
    severity: breakingChanges.length ? 'warning' : 'info',
    metadata: { fromEnvironmentId, toEnvironmentId: targetStage.id, version: newReleaseVersion, breakingChangesCount: breakingChanges.length },
  });
  if (mirrored) {
    await recordAuditEvent(actingUser, req, {
      action: 'PROJECT_ENV_MIRRORED',
      resourceType: 'project',
      resourceId: project.id,
      entityName: mirrored.label,
      details: `${mirrored.label} auto-mirrored ${targetStage.label} — v1.0.${newReleaseVersion}.`,
      severity: 'info',
      metadata: { mirroredFrom: targetStage.id, version: newReleaseVersion },
    });
  }

  const recipientIds = (await adminUserIds(project.organisation)).filter((id) => id !== actingUser.sub);
  if (recipientIds.length) {
    const hasBreaking = breakingChanges.length > 0;
    await notifyUsers(recipientIds, {
      organisation: project.organisation,
      type: hasBreaking ? 'PROJECT_PROMOTED_BREAKING' : 'PROJECT_PROMOTED',
      title: `${actingUser.username} promoted ${stages[fromIdx].label} → ${targetStage.label}${hasBreaking ? ' (breaking changes)' : ''}`,
      body: releaseNote,
      link: { view: 'release-pipeline', projectId: project.id },
    });
  }
}

// POST /api/workspace/projects/:id/promote — { fromEnvironmentId }. Promotes
// that stage's current content into the NEXT stage in the pipeline (server-
// derived from the org's environment list — the client can't specify an
// arbitrary target, so stages can't be skipped). Admin-only.
router.post('/projects/:id/promote', async (req, res) => {
  if (!isAdminUser(req)) return res.status(403).json({ error: 'Only Admins can promote a project between environments.' });
  const fromEnvironmentId = req.body?.fromEnvironmentId;
  if (!fromEnvironmentId) return res.status(400).json({ error: 'fromEnvironmentId is required.' });
  // Release Pipeline v2: a release note is required on every promotion — the
  // diff already shows *what* changed, this is the one place "why" gets
  // captured, and it's what makes the merge-history timeline (GET
  // /release-history) read like an actual changelog instead of a bare list
  // of version bumps.
  const releaseNote = String(req.body?.releaseNote || '').trim().slice(0, 500);
  if (!releaseNote) return res.status(400).json({ error: 'A release note is required before promoting.' });
  if (releaseNote.length < 10) return res.status(400).json({ error: 'That release note is too short to be useful — say a bit more about what changed and why (at least 10 characters).' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: projRows } = await client.query(
      `SELECT id, organisation, data, data_enc, release_version FROM projects WHERE id = $1 FOR UPDATE`,
      [req.params.id]
    );
    if (!projRows.length || projRows[0].organisation !== req.authUser.organisation) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Project not found.' });
    }
    const project = projRows[0];

    const allEnvs = await getOrgEnvironments(project.organisation);
    const stages = pipelineStages(allEnvs);
    const fromIdx = stages.findIndex((e) => e.id === fromEnvironmentId);
    if (fromIdx < 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Unknown source environment.' });
    }
    const targetStage = stages[fromIdx + 1];
    if (!targetStage) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `${stages[fromIdx].label} is already the last stage in the pipeline.` });
    }

    // ---- Branch-protection gate ----
    // An environment flagged requiresApproval can never be promoted into
    // directly, even by the Admin who started the promotion — that's the
    // whole point of a second-approver requirement. Refuse here, before any
    // writes, and point the caller at the request flow instead.
    if (targetStage.requiresApproval) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        error: `${targetStage.label} requires a second Admin's approval — open a promotion request instead of promoting directly.`,
        requiresApproval: true,
      });
    }

    let sourceData, newReleaseVersion;
    if (fromIdx === 0) {
      // Promoting out of the draft stage: cut a brand-new release.
      sourceData = decryptProjectData(project);
      newReleaseVersion = project.release_version + 1;
      await client.query(`UPDATE projects SET release_version = $1 WHERE id = $2`, [newReleaseVersion, project.id]);
    } else {
      // Promoting an already-cut release further down the pipeline: carry
      // the same version forward unchanged, just copy the snapshot along.
      const { rows: srcRows } = await client.query(
        `SELECT version, data_enc FROM project_env_versions WHERE project_id = $1 AND environment_id = $2`,
        [project.id, fromEnvironmentId]
      );
      if (!srcRows.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Nothing has been promoted to ${stages[fromIdx].label} yet.` });
      }
      sourceData = JSON.parse(dataCrypto.decryptField(srcRows[0].data_enc, `project-env:${project.id}:${fromEnvironmentId}`));
      newReleaseVersion = srcRows[0].version;
    }

    // Note: the per-endpoint readiness gate (partitionForFinalStagePromotion)
    // only ever applies to the LAST stage, and the last stage is always
    // flagged requiresApproval, which is refused above before sourceData is
    // even loaded — so this route never actually reaches the last stage.

    // ---- Diff-viewed gate (see checkDiffToken above) ----
    // Recompute the exact same diff a caller would see for this from/to
    // pair right now, and require a token proving they actually pulled up
    // that diff (and that nothing changed since). This runs AFTER loading
    // sourceData so the recomputed diff reflects the same content that's
    // about to be promoted, not a stale read from before this transaction.
    const toStageIdx = fromIdx + 1;
    const toStageData = await loadStageData(project, targetStage.id, toStageIdx);
    const liveDiff = diffEndpointLists(sourceData.endpoints || [], toStageData.endpoints || []);
    // detectBreakingChanges(fromEndpoints, toEndpoints) expects from=live-today,
    // to=about-to-become-live — i.e. (current target content, promoted source
    // content), the reverse of diffEndpointLists' (source, target) order above.
    const liveBreakingChanges = detectBreakingChanges(toStageData.endpoints || [], sourceData.endpoints || []);
    const tokenError = checkDiffToken(req.body?.diffToken, {
      projectId: project.id, from: fromEnvironmentId, to: targetStage.id,
      diff: liveDiff, breakingChanges: liveBreakingChanges, ackBreakingChanges: req.body?.ackBreakingChanges === true,
    });
    if (tokenError) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: tokenError, breakingChanges: liveBreakingChanges });
    }

    const result = await finalizePromotion(client, req, {
      project, allEnvs, stages, fromIdx, targetStage, sourceData, newReleaseVersion,
      fromEnvironmentId, releaseNote, breakingChanges: liveBreakingChanges, actingUser: req.authUser,
    });
    await client.query('COMMIT');

    // The promotion has now genuinely committed — anything past this point
    // (cache, audit log, notifications) must not be able to turn a
    // successful promotion into a reported failure, so it's isolated in its
    // own try/catch rather than sharing the one above.
    try {
      await afterPromotionCommitted(req, {
        project, stages, fromIdx, targetStage, newReleaseVersion, fromEnvironmentId,
        releaseNote, breakingChanges: liveBreakingChanges, actingUser: req.authUser, mirrored: result.mirrored,
      });
    } catch (sideEffectErr) {
      console.error('POST promote: side effects after commit failed (promotion itself still succeeded):', sideEffectErr);
    }

    res.json({ ok: true, ...result, breakingChangesCount: liveBreakingChanges.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST promote failed:', err);
    res.status(500).json({ error: 'Could not promote project.' });
  } finally {
    client.release();
  }
});

// ============================================================================
// Promotion requests — the "protected branch / required review" half of the
// GitHub model. An environment flagged requiresApproval refuses direct
// POST /promote (see the gate above); instead, an Admin opens a request
// here, and a DIFFERENT Admin has to approve it before the promotion
// actually happens. This mirrors "you can't approve your own pull request."
// ============================================================================

// POST /api/workspace/projects/:id/promotion-requests — { fromEnvironmentId,
// releaseNote, ackBreakingChanges }. Validates exactly what POST /promote
// would (release note length, adjacency, diff-viewed-recently via the
// client's diffToken), but instead of writing the promotion, freezes the
// diff + breaking changes it just computed onto a pending request row for
// another Admin to review.
router.post('/projects/:id/promotion-requests', async (req, res) => {
  if (!isAdminUser(req)) return res.status(403).json({ error: 'Only Admins can request a promotion.' });
  const fromEnvironmentId = req.body?.fromEnvironmentId;
  if (!fromEnvironmentId) return res.status(400).json({ error: 'fromEnvironmentId is required.' });
  const releaseNote = String(req.body?.releaseNote || '').trim().slice(0, 500);
  if (!releaseNote) return res.status(400).json({ error: 'A release note is required before requesting a promotion.' });
  if (releaseNote.length < 10) return res.status(400).json({ error: 'That release note is too short to be useful — say a bit more about what changed and why (at least 10 characters).' });

  try {
    const { rows: projRows } = await pool.query(
      `SELECT id, organisation, data, data_enc, release_version FROM projects WHERE id = $1`,
      [req.params.id]
    );
    if (!projRows.length || projRows[0].organisation !== req.authUser.organisation) {
      return res.status(404).json({ error: 'Project not found.' });
    }
    const project = projRows[0];

    const allEnvs = await getOrgEnvironments(project.organisation);
    const stages = pipelineStages(allEnvs);
    const fromIdx = stages.findIndex((e) => e.id === fromEnvironmentId);
    if (fromIdx < 0) return res.status(400).json({ error: 'Unknown source environment.' });
    const targetStage = stages[fromIdx + 1];
    if (!targetStage) return res.status(400).json({ error: `${stages[fromIdx].label} is already the last stage in the pipeline.` });
    if (!targetStage.requiresApproval) {
      return res.status(400).json({ error: `${targetStage.label} doesn't require approval — promote directly instead.` });
    }

    const fromData = fromIdx === 0 ? decryptProjectData(project) : await loadStageData(project, fromEnvironmentId, fromIdx);
    const toStageData = await loadStageData(project, targetStage.id, fromIdx + 1);

    // Per-endpoint Production gate: only ready endpoints (plus whatever's
    // already frozen in Production for the ones that aren't) go into this
    // request — see partitionForFinalStagePromotion. targetStage is always
    // the last stage here since only it is ever flagged requiresApproval.
    const isFinalStage = targetStage.id === stages[stages.length - 1].id;
    const gate = isFinalStage
      ? partitionForFinalStagePromotion(fromData.endpoints || [], toStageData.endpoints || [])
      : { endpoints: fromData.endpoints || [], excluded: [] };
    const gatedFromEndpoints = gate.endpoints;

    const liveDiff = diffEndpointLists(gatedFromEndpoints, toStageData.endpoints || []);
    const liveBreakingChanges = detectBreakingChanges(toStageData.endpoints || [], gatedFromEndpoints);
    const ackBreakingChanges = req.body?.ackBreakingChanges === true;
    if (liveBreakingChanges.length && !ackBreakingChanges) {
      const n = liveBreakingChanges.length;
      return res.status(409).json({
        error: `This promotion includes ${n} breaking change${n === 1 ? '' : 's'} — check "I've reviewed the breaking changes" before requesting.`,
        breakingChanges: liveBreakingChanges,
      });
    }
    const total = liveDiff.added.length + liveDiff.removed.length + liveDiff.modified.length;
    if (!total) {
      return res.status(400).json({
        error: gate.excluded.length
          ? `Nothing release-ready to promote — ${gate.excluded.length} endpoint${gate.excluded.length === 1 ? '' : 's'} in ${stages[fromIdx].label} still ${gate.excluded.length === 1 ? "isn't" : "aren't"} Active with SecOps/VAPT/Log Mgmt approved.`
          : `${stages[fromIdx].label} and ${targetStage.label} are already in sync — nothing to promote.`,
        excludedNotReady: gate.excluded,
      });
    }

    const diffHash = hashDiff(liveDiff, liveBreakingChanges);
    let created;
    try {
      const { rows } = await pool.query(
        `INSERT INTO project_promotion_requests
           (project_id, from_environment_id, to_environment_id, diff_hash, diff_snapshot, breaking_changes,
            ack_breaking_changes, release_note, requested_by, requested_by_username)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id, created_at`,
        [project.id, fromEnvironmentId, targetStage.id, diffHash, JSON.stringify(liveDiff), JSON.stringify(liveBreakingChanges),
          ackBreakingChanges, releaseNote, req.authUser.sub, req.authUser.username]
      );
      created = rows[0];
    } catch (err) {
      if (err.code === '23505') { // unique_violation — a pending request already targets this stage
        return res.status(409).json({ error: `There's already a pending promotion request into ${targetStage.label}. Cancel it before opening another.` });
      }
      throw err;
    }

    await recordAuditEvent(req.authUser, req, {
      action: 'PROJECT_PROMOTION_REQUESTED',
      resourceType: 'project',
      resourceId: project.id,
      entityName: stages[fromIdx].label + ' → ' + targetStage.label,
      details: `Requested promotion of "${project.id}" from ${stages[fromIdx].label} to ${targetStage.label} — awaiting a second Admin's approval.`
        + (gate.excluded.length ? ` ${gate.excluded.length} endpoint${gate.excluded.length === 1 ? '' : 's'} left out as not release-ready.` : ''),
      severity: liveBreakingChanges.length ? 'warning' : 'info',
      metadata: { fromEnvironmentId, toEnvironmentId: targetStage.id, requestId: created.id, excludedNotReadyCount: gate.excluded.length },
    });

    const recipientIds = (await adminUserIds(project.organisation)).filter((id) => id !== req.authUser.sub);
    if (recipientIds.length) {
      await notifyUsers(recipientIds, {
        organisation: project.organisation,
        type: 'PROJECT_PROMOTION_REQUESTED',
        title: `${req.authUser.username} requested promotion into ${targetStage.label} — needs your approval`,
        body: releaseNote,
        link: { view: 'release-pipeline', projectId: project.id },
      });
    }

    res.json({ ok: true, id: created.id, toEnvironmentLabel: targetStage.label, createdAt: created.created_at, excludedNotReady: gate.excluded });
  } catch (err) {
    console.error('POST promotion-requests failed:', err);
    res.status(500).json({ error: 'Could not open a promotion request.' });
  }
});

// GET /api/workspace/projects/:id/promotion-requests?status=pending — list
// requests for this project. Same visibility as GET /versions.
router.get('/projects/:id/promotion-requests', async (req, res) => {
  try {
    const { rows: projRows } = await pool.query(`SELECT id, organisation FROM projects WHERE id = $1`, [req.params.id]);
    if (!projRows.length || projRows[0].organisation !== req.authUser.organisation) {
      return res.status(404).json({ error: 'Project not found.' });
    }
    const access = await resolveAccessById(req.authUser.sub, req.params.id, req.authUser.organisation);
    if (!access.canView) return res.status(404).json({ error: 'Project not found.' });

    const status = ['pending', 'approved', 'rejected', 'cancelled'].includes(req.query.status) ? req.query.status : 'pending';
    const allEnvs = await getOrgEnvironments(projRows[0].organisation);
    const labelById = new Map(allEnvs.map((e) => [e.id, e.label]));

    const { rows } = await pool.query(
      `SELECT id, from_environment_id, to_environment_id, breaking_changes, ack_breaking_changes, release_note,
              status, requested_by, requested_by_username, decided_by_username, decision_note, decided_at, created_at
       FROM project_promotion_requests WHERE project_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT 50`,
      [req.params.id, status]
    );
    res.json({
      requests: rows.map((r) => ({
        id: r.id,
        fromEnvironmentId: r.from_environment_id,
        fromEnvironmentLabel: labelById.get(r.from_environment_id) || r.from_environment_id,
        toEnvironmentId: r.to_environment_id,
        toEnvironmentLabel: labelById.get(r.to_environment_id) || r.to_environment_id,
        breakingChanges: Array.isArray(r.breaking_changes) ? r.breaking_changes : [],
        ackBreakingChanges: r.ack_breaking_changes,
        releaseNote: r.release_note,
        status: r.status,
        requestedBy: r.requested_by,
        requestedByUsername: r.requested_by_username,
        decidedByUsername: r.decided_by_username,
        decisionNote: r.decision_note,
        decidedAt: r.decided_at,
        createdAt: r.created_at,
        // The requester can't approve their own request — the client uses
        // this to grey out the Approve button rather than let someone click
        // it and be refused server-side.
        canApprove: isAdminUser(req) && r.requested_by !== req.authUser.sub,
        canCancel: r.requested_by === req.authUser.sub,
      })),
    });
  } catch (err) {
    console.error('GET promotion-requests failed:', err);
    res.status(500).json({ error: 'Could not load promotion requests.' });
  }
});

// GET /api/workspace/promotion-requests?status=pending — org-wide list, for
// the top-level Release Pipeline nav page. Admin-only (a non-admin only ever
// sees requests through a project they can already reach, via the per-project
// route above); joins back to projects for a name/id to link into
// openReleasePipelineTab from a single cross-project view.
router.get('/promotion-requests', async (req, res) => {
  try {
    if (!isAdminUser(req)) return res.status(403).json({ error: 'Admin access required.' });

    const status = ['pending', 'approved', 'rejected', 'cancelled'].includes(req.query.status) ? req.query.status : 'pending';
    const allEnvs = await getOrgEnvironments(req.authUser.organisation);
    const labelById = new Map(allEnvs.map((e) => [e.id, e.label]));

    const { rows } = await pool.query(
      `SELECT r.id, r.project_id, p.name AS project_name, r.from_environment_id, r.to_environment_id,
              r.breaking_changes, r.ack_breaking_changes, r.release_note,
              r.status, r.requested_by, r.requested_by_username, r.decided_by_username, r.decision_note,
              r.decided_at, r.created_at
       FROM project_promotion_requests r
       JOIN projects p ON p.id = r.project_id
       WHERE p.organisation = $1 AND r.status = $2
       ORDER BY r.created_at DESC LIMIT 100`,
      [req.authUser.organisation, status]
    );
    res.json({
      requests: rows.map((r) => ({
        id: r.id,
        projectId: r.project_id,
        projectName: r.project_name,
        fromEnvironmentId: r.from_environment_id,
        fromEnvironmentLabel: labelById.get(r.from_environment_id) || r.from_environment_id,
        toEnvironmentId: r.to_environment_id,
        toEnvironmentLabel: labelById.get(r.to_environment_id) || r.to_environment_id,
        breakingChanges: Array.isArray(r.breaking_changes) ? r.breaking_changes : [],
        ackBreakingChanges: r.ack_breaking_changes,
        releaseNote: r.release_note,
        status: r.status,
        requestedBy: r.requested_by,
        requestedByUsername: r.requested_by_username,
        decidedByUsername: r.decided_by_username,
        decisionNote: r.decision_note,
        decidedAt: r.decided_at,
        createdAt: r.created_at,
        canApprove: r.requested_by !== req.authUser.sub,
      })),
    });
  } catch (err) {
    console.error('GET org-wide promotion-requests failed:', err);
    res.status(500).json({ error: 'Could not load promotion requests.' });
  }
});

// POST /api/workspace/projects/:id/promotion-requests/:reqId/approve —
// Admin-only, and NOT the Admin who opened the request (GitHub's "you can't
// approve your own PR"). Recomputes the live diff for the same from/to pair
// and compares its hash against what was frozen at request time; if
// anything's moved since (someone else promoted in the meantime, or the
// draft changed), the approval is refused with the same "view it again"
// framing as the direct-promote path, rather than silently approving
// content nobody actually reviewed.
router.post('/projects/:id/promotion-requests/:reqId/approve', async (req, res) => {
  if (!isAdminUser(req)) return res.status(403).json({ error: 'Only Admins can approve a promotion request.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: reqRows } = await client.query(
      `SELECT * FROM project_promotion_requests WHERE id = $1 AND project_id = $2 FOR UPDATE`,
      [req.params.reqId, req.params.id]
    );
    if (!reqRows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Promotion request not found.' }); }
    const request = reqRows[0];
    if (request.status !== 'pending') { await client.query('ROLLBACK'); return res.status(400).json({ error: `This request was already ${request.status}.` }); }
    if (request.requested_by === req.authUser.sub) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: "You can't approve your own promotion request — ask another Admin to review it." });
    }

    const { rows: projRows } = await client.query(
      `SELECT id, organisation, data, data_enc, release_version FROM projects WHERE id = $1 FOR UPDATE`,
      [req.params.id]
    );
    if (!projRows.length || projRows[0].organisation !== req.authUser.organisation) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Project not found.' });
    }
    const project = projRows[0];
    const allEnvs = await getOrgEnvironments(project.organisation);
    const stages = pipelineStages(allEnvs);
    const fromIdx = stages.findIndex((e) => e.id === request.from_environment_id);
    const targetStage = stages.find((e) => e.id === request.to_environment_id);
    if (fromIdx < 0 || !targetStage || stages[fromIdx + 1]?.id !== targetStage.id) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'The pipeline has changed since this request was opened — cancel it and open a fresh one.' });
    }

    let sourceData, newReleaseVersion;
    if (fromIdx === 0) {
      sourceData = decryptProjectData(project);
    } else {
      const { rows: srcRows } = await client.query(
        `SELECT version, data_enc FROM project_env_versions WHERE project_id = $1 AND environment_id = $2`,
        [project.id, request.from_environment_id]
      );
      if (!srcRows.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: `Nothing has been promoted to ${stages[fromIdx].label} yet.` }); }
      sourceData = JSON.parse(dataCrypto.decryptField(srcRows[0].data_enc, `project-env:${project.id}:${request.from_environment_id}`));
    }
    const toStageData = await loadStageData(project, targetStage.id, fromIdx + 1);

    // Same per-endpoint Production gate as when the request was opened — has
    // to be recomputed identically here so the hash check below still
    // matches (it's a pure function of sourceData + Production's current
    // content, and Production hasn't moved since unless someone else
    // promoted into it in the meantime, which the hash check below still
    // correctly catches).
    const isFinalStage = targetStage.id === stages[stages.length - 1].id;
    const gate = isFinalStage
      ? partitionForFinalStagePromotion(sourceData.endpoints || [], toStageData.endpoints || [])
      : { endpoints: sourceData.endpoints || [], excluded: [] };
    const gatedSourceData = { ...sourceData, endpoints: gate.endpoints };

    const liveDiff = diffEndpointLists(gatedSourceData.endpoints, toStageData.endpoints || []);
    const liveBreakingChanges = detectBreakingChanges(toStageData.endpoints || [], gatedSourceData.endpoints);
    if (hashDiff(liveDiff, liveBreakingChanges) !== request.diff_hash) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: "What's changed since this request was opened — ask the requester to cancel it and open a fresh one." });
    }

    if (fromIdx === 0) {
      newReleaseVersion = project.release_version + 1;
      await client.query(`UPDATE projects SET release_version = $1 WHERE id = $2`, [newReleaseVersion, project.id]);
    } else {
      const { rows: srcRows } = await client.query(
        `SELECT version FROM project_env_versions WHERE project_id = $1 AND environment_id = $2`,
        [project.id, request.from_environment_id]
      );
      newReleaseVersion = srcRows[0].version;
    }

    const result = await finalizePromotion(client, req, {
      project, allEnvs, stages, fromIdx, targetStage, sourceData: gatedSourceData, newReleaseVersion,
      fromEnvironmentId: request.from_environment_id, releaseNote: request.release_note,
      breakingChanges: liveBreakingChanges, actingUser: { sub: request.requested_by, username: request.requested_by_username },
    });

    // This UPDATE has to land in the SAME transaction as finalizePromotion's
    // writes above (see finalizePromotion's own comment) — this is exactly
    // that commit point, covering both at once.
    await client.query(
      `UPDATE project_promotion_requests SET status = 'approved', decided_by = $1, decided_by_username = $2, decided_at = now() WHERE id = $3`,
      [req.authUser.sub, req.authUser.username, request.id]
    );
    await client.query('COMMIT');

    // Everything below is now purely post-commit side effects — the
    // promotion AND the request's approved status are both already durable.
    // Isolated in its own try/catch so a notification hiccup can never be
    // reported back as "approval failed" when it actually succeeded.
    try {
      const requestedByActingUser = { sub: request.requested_by, username: request.requested_by_username };
      await afterPromotionCommitted(req, {
        project, stages, fromIdx, targetStage, newReleaseVersion,
        fromEnvironmentId: request.from_environment_id, releaseNote: request.release_note,
        breakingChanges: liveBreakingChanges, actingUser: requestedByActingUser, mirrored: result.mirrored,
      });
      await recordAuditEvent(req.authUser, req, {
        action: 'PROJECT_PROMOTION_APPROVED',
        resourceType: 'project',
        resourceId: project.id,
        entityName: stages[fromIdx].label + ' → ' + targetStage.label,
        details: `Approved ${request.requested_by_username || 'a teammate'}'s promotion request from ${stages[fromIdx].label} to ${targetStage.label} — v1.0.${newReleaseVersion}.`,
        severity: 'info',
        metadata: { requestId: request.id, version: newReleaseVersion },
      });
      if (request.requested_by) {
        await notifyUsers([request.requested_by], {
          organisation: project.organisation,
          type: 'PROJECT_PROMOTION_APPROVED',
          title: `${req.authUser.username} approved your promotion into ${targetStage.label}`,
          body: `${result.versionLabel} is now live in ${targetStage.label}.`,
          link: { view: 'release-pipeline', projectId: project.id },
        });
      }
    } catch (sideEffectErr) {
      console.error('POST promotion-requests/approve: side effects after commit failed (approval itself still succeeded):', sideEffectErr);
    }

    res.json({ ok: true, ...result, excludedNotReady: gate.excluded });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST promotion-requests/approve failed:', err);
    res.status(500).json({ error: 'Could not approve this promotion request.' });
  } finally {
    client.release();
  }
});

// POST /api/workspace/projects/:id/promotion-requests/:reqId/reject — any
// Admin other than the requester can reject, with an optional note (shown
// to the requester, same as GitHub's "changes requested" review comment).
router.post('/projects/:id/promotion-requests/:reqId/reject', async (req, res) => {
  if (!isAdminUser(req)) return res.status(403).json({ error: 'Only Admins can reject a promotion request.' });
  try {
    const { rows } = await pool.query(
      `SELECT pr.*, p.organisation FROM project_promotion_requests pr JOIN projects p ON p.id = pr.project_id
       WHERE pr.id = $1 AND pr.project_id = $2`,
      [req.params.reqId, req.params.id]
    );
    if (!rows.length || rows[0].organisation !== req.authUser.organisation) return res.status(404).json({ error: 'Promotion request not found.' });
    const request = rows[0];
    if (request.status !== 'pending') return res.status(400).json({ error: `This request was already ${request.status}.` });
    if (request.requested_by === req.authUser.sub) return res.status(403).json({ error: "You can't reject your own promotion request — cancel it instead." });

    const decisionNote = String(req.body?.note || '').trim().slice(0, 500) || null;
    await pool.query(
      `UPDATE project_promotion_requests SET status = 'rejected', decided_by = $1, decided_by_username = $2, decision_note = $3, decided_at = now() WHERE id = $4`,
      [req.authUser.sub, req.authUser.username, decisionNote, request.id]
    );
    await recordAuditEvent(req.authUser, req, {
      action: 'PROJECT_PROMOTION_REJECTED',
      resourceType: 'project',
      resourceId: request.project_id,
      entityName: request.to_environment_id,
      details: `Rejected ${request.requested_by_username || 'a teammate'}'s promotion request into ${request.to_environment_id}.` + (decisionNote ? ` Note: ${decisionNote}` : ''),
      severity: 'warning',
      metadata: { requestId: request.id },
    });
    if (request.requested_by) {
      await notifyUsers([request.requested_by], {
        organisation: request.organisation,
        type: 'PROJECT_PROMOTION_REJECTED',
        title: `${req.authUser.username} rejected your promotion request`,
        body: decisionNote || 'No reason given.',
        link: { view: 'release-pipeline', projectId: request.project_id },
      });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('POST promotion-requests/reject failed:', err);
    res.status(500).json({ error: 'Could not reject this promotion request.' });
  }
});

// POST /api/workspace/projects/:id/promotion-requests/:reqId/cancel — the
// original requester withdraws their own still-pending request.
router.post('/projects/:id/promotion-requests/:reqId/cancel', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT pr.*, p.organisation FROM project_promotion_requests pr JOIN projects p ON p.id = pr.project_id
       WHERE pr.id = $1 AND pr.project_id = $2`,
      [req.params.reqId, req.params.id]
    );
    if (!rows.length || rows[0].organisation !== req.authUser.organisation) return res.status(404).json({ error: 'Promotion request not found.' });
    const request = rows[0];
    if (request.status !== 'pending') return res.status(400).json({ error: `This request was already ${request.status}.` });
    if (request.requested_by !== req.authUser.sub) return res.status(403).json({ error: 'Only the person who opened this request can cancel it.' });
    await pool.query(`UPDATE project_promotion_requests SET status = 'cancelled', decided_at = now() WHERE id = $1`, [request.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST promotion-requests/cancel failed:', err);
    res.status(500).json({ error: 'Could not cancel this promotion request.' });
  }
});

// ----------------------------------------------------------------------------
// Release pipeline diff — generic structural (git-diff-style) comparison of
// the `endpoints` array between any two pipeline stages. Read-only: unlike
// /promote, `from`/`to` don't have to be adjacent stages (comparing Dev
// directly against Production is a legitimate thing to want to see); the
// client is told via `canMerge` whether the pair also lines up with what
// POST /promote will actually accept, and gates the "Merge" button on that.
// ----------------------------------------------------------------------------

// Fields that are pure bookkeeping (who/when an endpoint was last touched) —
// diffing them would bury the actual content changes under noise every time
// a stage is re-promoted.
const DIFF_IGNORE_KEYS = new Set(['id', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', '_open']);

function isPlainObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

// Arrays of parameters/headers/responses aren't identified by array index —
// re-ordering shouldn't read as add+remove — so match items by their natural
// key (name+in, response code, or name) when every item in both arrays has one.
function arrayItemKey(item) {
  if (isPlainObj(item)) {
    if (item.name != null && item.in != null) return `ni:${item.in}:${item.name}`;
    if (item.code != null) return `code:${item.code}`;
    if (item.name != null) return `n:${item.name}`;
  }
  return null;
}

function diffArrays(a, b, path, out) {
  a = a || []; b = b || [];
  const keyable = (a.length || b.length) && a.every((x) => arrayItemKey(x) != null) && b.every((x) => arrayItemKey(x) != null);
  if (keyable) {
    const am = new Map(a.map((x) => [arrayItemKey(x), x]));
    const bm = new Map(b.map((x) => [arrayItemKey(x), x]));
    for (const k of new Set([...am.keys(), ...bm.keys()])) {
      const av = am.get(k), bv = bm.get(k);
      if (av === undefined) out.push({ path, kind: 'added', before: null, after: bv });
      else if (bv === undefined) out.push({ path, kind: 'removed', before: av, after: null });
      else diffValue(av, bv, path, out);
    }
  } else if (JSON.stringify(a) !== JSON.stringify(b)) {
    out.push({ path, kind: 'changed', before: a, after: b });
  }
}

function diffValue(a, b, path, out) {
  if (a === b) return;
  if (isPlainObj(a) && isPlainObj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (DIFF_IGNORE_KEYS.has(k)) continue;
      diffValue(a[k], b[k], path ? `${path}.${k}` : k, out);
    }
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) { diffArrays(a, b, path, out); return; }
  const av = a === undefined ? null : a;
  const bv = b === undefined ? null : b;
  if (JSON.stringify(av) !== JSON.stringify(bv)) {
    out.push({ path, kind: a === undefined ? 'added' : b === undefined ? 'removed' : 'changed', before: av, after: bv });
  }
}

function epSummary(ep) {
  return { id: ep.id, method: ep.method || '', path: ep.path || '', summary: ep.summary || '' };
}

// `from` is the stage being promoted (its content is what the target stage
// is ABOUT TO BECOME); `to` is the target stage's CURRENT content, which
// gets overwritten by `from`'s content the moment promotion happens. So
// "added" has to mean "present in `from`, missing from `to`" — that's what
// the target stage gains once promoted — and "removed" is the reverse: only
// in `to` today, and about to disappear because `from` doesn't have it.
// (Swapping these reads as a plain chronological from-old/to-new diff, which
// is backwards here — promoting overwrites `to` with `from`, it doesn't
// turn `from` into `to`.)
// ---- Release readiness gate (item #7) ----
// A promotion into the pipeline's LAST stage (Production, by convention —
// DR isn't a manual stage, it inherits Production's readiness for free)
// used to be all-or-nothing: a single endpoint that wasn't status:active
// with SecOps/VAPT/Log Mgmt all approved blocked the ENTIRE project from
// reaching Production, even when most of it was long since ready. That
// pushed teams into forking a project into a second "-prod" copy just to
// get its finished endpoints live, fragmenting the documentation for no
// real reason. Instead, a Production promotion now carries forward only
// the endpoints that are actually release-ready — see
// partitionForFinalStagePromotion below — while everything not ready
// simply sits out of this particular promotion; the next promotion picks
// it up automatically once it passes. An endpoint already live in
// Production is never silently pulled or overwritten by an unapproved
// edit just because its review status later regressed — it's kept frozen
// at its last-promoted content until it's ready again.
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

// Splits `fromEndpoints` (what's about to be promoted) into what actually
// gets carried into Production this time. Ready endpoints pass through
// as-is. Not-ready endpoints that are already live in Production are kept
// at their CURRENT Production content (not silently dropped, not silently
// updated). Not-ready endpoints that have never reached Production are
// left out entirely. Returns the effective endpoint list to promote plus
// a summary of what was excluded, for transparency in the diff/response.
function partitionForFinalStagePromotion(fromEndpoints, currentTargetEndpoints) {
  const currentById = new Map((currentTargetEndpoints || []).filter((e) => e && e.id).map((e) => [e.id, e]));
  const endpoints = [];
  const excluded = [];
  for (const ep of fromEndpoints || []) {
    if (!ep || !ep.id) continue;
    const problem = endpointReadinessProblem(ep);
    if (!problem) {
      endpoints.push(ep);
      continue;
    }
    const already = currentById.get(ep.id);
    if (already) {
      endpoints.push(already);
      excluded.push({ ...epSummary(ep), reason: problem, keptAsIs: true });
    } else {
      excluded.push({ ...epSummary(ep), reason: problem, keptAsIs: false });
    }
  }
  return { endpoints, excluded };
}

function diffEndpointLists(fromEps, toEps) {
  const fm = new Map((fromEps || []).map((e) => [e.id, e]));
  const tm = new Map((toEps || []).map((e) => [e.id, e]));
  const added = [], removed = [], modified = [];
  for (const id of new Set([...fm.keys(), ...tm.keys()])) {
    const fe = fm.get(id), te = tm.get(id);
    if (!fe) { removed.push(epSummary(te)); continue; }
    if (!te) { added.push(epSummary(fe)); continue; }
    const changes = [];
    diffValue(fe, te, '', changes);
    if (changes.length) modified.push({ ...epSummary(te), changes });
  }
  return { added, removed, modified };
}

// ---- "You must have actually seen the diff" promotion gate (item #6) ----
// Previously POST /promote had no relationship at all to GET /diff — nothing
// stopped a caller from promoting straight to the next stage without ever
// having pulled up what would change, even though the UI's own Merge button
// only ever appears inside the rendered diff panel. This closes that gap
// server-side rather than relying on the UI's own sequencing: GET /diff
// mints a short-lived signed token binding (project, from, to, a content
// hash of the diff) together; POST /promote requires that token and
// recomputes the SAME hash at promote time, so a token only works for the
// exact diff it was issued for — if the source content changed in between
// (someone else edited the draft), the hash won't match and promote is
// rejected with a clear "diff has changed, view it again" error instead of
// silently promoting something nobody actually reviewed.
const DIFF_TOKEN_TYPE = 'diff-ack';
const DIFF_TOKEN_TTL_MS = 15 * 60 * 1000;

function hashDiff(diff, breakingChanges) {
  // Field order from diffEndpointLists/epSummary (and detectBreakingChanges,
  // which walks the same endpoint maps the same way) is already
  // deterministic, so a plain JSON.stringify is a stable, reproducible
  // fingerprint of "exactly this diff + these breaking-change findings" —
  // not cryptographic integrity (the token's own AEAD already provides
  // that), just a fingerprint for the equality check below. Breaking
  // changes are folded into the SAME hash as the structural diff (rather
  // than a separate token field) so there's exactly one "has this changed
  // since you looked at it" check to get right, not two that could
  // disagree.
  return nodeCrypto.createHash('sha256').update(JSON.stringify({ diff, breakingChanges })).digest('hex');
}

function mintDiffToken({ projectId, from, to, diff, breakingChanges }) {
  return dataCrypto.encryptShareToken({
    t: DIFF_TOKEN_TYPE,
    pid: projectId,
    from,
    to,
    hash: hashDiff(diff, breakingChanges),
    bc: (breakingChanges || []).length,
    exp: Date.now() + DIFF_TOKEN_TTL_MS,
  });
}

// Returns null (valid) or an error message string. `ackBreakingChanges` is
// whatever the client sent in POST /promote's body — required to be
// explicitly truthy whenever the acknowledged diff included at least one
// breaking-change finding, same "you must have actually seen it" principle
// as the diff-viewed check itself, just for the specific subset of changes
// most likely to take a live consumer down.
function checkDiffToken(token, { projectId, from, to, diff, breakingChanges, ackBreakingChanges }) {
  if (!token || typeof token !== 'string') {
    return 'View the diff before promoting — open the From/To comparison first.';
  }
  const payload = dataCrypto.decryptShareToken(token);
  if (!payload || payload.t !== DIFF_TOKEN_TYPE) {
    return 'Your diff confirmation is invalid — view the diff again and retry.';
  }
  if (payload.pid !== projectId || payload.from !== from || payload.to !== to) {
    return 'That diff confirmation was for a different comparison — view the current diff and retry.';
  }
  if (!payload.exp || Date.now() > payload.exp) {
    return 'Your diff confirmation has expired — view the diff again and retry.';
  }
  if (payload.hash !== hashDiff(diff, breakingChanges)) {
    return "What's changed since you last viewed the diff — view it again before promoting.";
  }
  if ((breakingChanges || []).length && !ackBreakingChanges) {
    const n = breakingChanges.length;
    return `This promotion includes ${n} breaking change${n === 1 ? '' : 's'} — check "I've reviewed the breaking changes" before merging.`;
  }
  return null;
}

// ---- Append-only promotion history (item #6 — rollback) ----
// project_env_versions (below) stays a single overwritten "what's live right
// now" row per (project, environment); this table is its append-only
// companion so a bad promotion can be rolled back to a specific earlier
// version instead of only ever moving forward. Called from inside the same
// transaction as the project_env_versions upsert, with the exact same
// already-encrypted payload — no re-encryption needed, since the AAD
// (`project-env:<id>:<env>`) binds to project+environment only, not to
// "current" vs "historical".
async function recordEnvVersionHistory(client, {
  projectId, environmentId, version, dataEnc, dataKeyVersion, sourceEnvironmentId,
  action = 'promote', rolledBackFromId = null, promotedBy, promotedByUsername, autoMirrored = false,
  releaseNote = null, breakingChanges = [],
}) {
  const { rows } = await client.query(
    `INSERT INTO project_env_version_history
       (project_id, environment_id, version, data_enc, data_key_version, source_environment_id,
        action, rolled_back_from_id, promoted_by, promoted_by_username, auto_mirrored, promoted_at,
        release_note, breaking_changes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now(), $12, $13)
     RETURNING id`,
    [projectId, environmentId, version, dataEnc, dataKeyVersion, sourceEnvironmentId, action, rolledBackFromId, promotedBy, promotedByUsername, autoMirrored,
      releaseNote, JSON.stringify(breakingChanges || [])]
  );
  return rows[0].id;
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
    // enforce that here too, not just for Try It/Live Mode.
    if (grant) {
      const envs = Array.isArray(grant.environments) ? grant.environments : [];
      if (!envs.includes('*') && !envs.includes(envKey)) {
        return res.status(403).json({ error: 'You do not have access to this environment for this project.' });
      }
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

// GET /api/workspace/projects/:id/diff?from=<environmentId>&to=<environmentId>
// Any org member who can see the project may view a diff (same visibility as
// GET /versions); only POST /promote itself is Admin-gated.
// GET /api/workspace/projects/:id/diff?from=<environmentId>&to=<environmentId>
// Any org member who can see the project may view a diff (same visibility as
// GET /versions); only POST /promote itself is Admin-gated. "Can see the
// project" is enforced the same way as the snapshot route just above — owner
// or an explicit grant sees everything, everyone else only public endpoints,
// further reduced to locked stubs without an active doc-access grant. This
// used to skip all of that (org match only), so a diff could leak full
// before/after bodies for private or doc-locked endpoints.
router.get('/projects/:id/diff', async (req, res) => {
  try {
    const fromKey = req.query.from, toKey = req.query.to;
    if (!fromKey || !toKey) return res.status(400).json({ error: 'from and to are required.' });

    const { rows } = await pool.query(
      `SELECT id, owner_id, organisation, visibility, has_public_endpoint, data, data_enc, release_version FROM projects WHERE id = $1`,
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
    if (!isOwner && !grant && project.visibility !== 'public' && !project.has_public_endpoint) {
      return res.status(404).json({ error: 'Project not found.' });
    }

    const allEnvs = await getOrgEnvironments(project.organisation);
    const stages = pipelineStages(allEnvs);
    const stageById = new Map(stages.map((s, idx) => [s.id, { ...s, idx }]));
    if (!stageById.has(fromKey) || !stageById.has(toKey)) {
      return res.status(400).json({ error: 'Unknown environment.' });
    }
    if (grant) {
      const envs = Array.isArray(grant.environments) ? grant.environments : [];
      if (!envs.includes('*') && (!envs.includes(fromKey) || !envs.includes(toKey))) {
        return res.status(403).json({ error: 'You do not have access to these environments for this project.' });
      }
    }

    const [fromData, toData] = await Promise.all([
      loadStageData(project, fromKey, stageById.get(fromKey).idx),
      loadStageData(project, toKey, stageById.get(toKey).idx),
    ]);
    let fromEndpoints = fromData.endpoints || [];
    let toEndpoints = toData.endpoints || [];

    if (!isOwner && !grant) {
      const filterAndLock = async (endpoints, envKey) => {
        let filtered = endpoints.filter((ep) => ep && ep.visibility === 'public');
        if (filtered.length && !userHasFullDocAccess(req.authUser)) {
          const accessMap = await getDocAccessMap(project.organisation, userId, project.id, filtered.map((e) => e.id), envKey);
          filtered = filtered.map((ep) => applyDocLock(ep, accessMap.get(ep.id)));
        }
        return filtered;
      };
      [fromEndpoints, toEndpoints] = await Promise.all([filterAndLock(fromEndpoints, fromKey), filterAndLock(toEndpoints, toKey)]);
    }

    // The diff-token hash has to match exactly what POST /promote recomputes
    // at promotion time — and that recomputation reads the RAW (unmasked)
    // stage content, since that's what's actually being written. Snapshot
    // the access-filtered-but-unmasked lists here, before masking, so the
    // token below is minted from the same content promote will hash.
    // Without this, ANY promotion touching a "modified" endpoint whose
    // masked fields differ from their raw values (a header example, a PII
    // field, anything maskEndpoint touches) would mint a token that can
    // never match — a real request would recompute the diff on raw data,
    // get a different hash, and fail every single time with a false
    // "diff has changed since you last viewed it" error.
    // Per-endpoint Production gate: previewing a promotion INTO the last
    // stage only shows what would actually go — ready endpoints, plus
    // whatever's already frozen in Production for anything not ready yet
    // (see partitionForFinalStagePromotion). Without this, the diff would
    // show endpoints as "added" that a subsequent promotion-request would
    // then silently leave out, which is confusing at best.
    const fromIdxForGate = stageById.get(fromKey).idx, toIdxForGate = stageById.get(toKey).idx;
    const isFinalStageTarget = toIdxForGate === stages.length - 1 && toIdxForGate === fromIdxForGate + 1;
    const gate = isFinalStageTarget
      ? partitionForFinalStagePromotion(fromEndpoints, toEndpoints)
      : { endpoints: fromEndpoints, excluded: [] };
    fromEndpoints = gate.endpoints;

    const rawFromEndpoints = fromEndpoints;
    const rawToEndpoints = toEndpoints;
    const rawDiff = diffEndpointLists(rawFromEndpoints, rawToEndpoints);
    const rawBreakingChanges = detectBreakingChanges(rawToEndpoints, rawFromEndpoints);

    // SECURITY (Finding 4.2): same masking as GET /api/workspace and the
    // snapshot route — a diff is still a full read path for example values.
    // This masked copy is for the response payload the client actually
    // displays; the diff token above is minted from the raw copy instead.
    const orgRules = await getOrgPiiRules(project.organisation);
    fromEndpoints = fromEndpoints.map((ep) => piiMasking.maskEndpoint(ep, orgRules));
    toEndpoints = toEndpoints.map((ep) => piiMasking.maskEndpoint(ep, orgRules));

    const diff = diffEndpointLists(fromEndpoints, toEndpoints);
    const breakingChanges = detectBreakingChanges(toEndpoints, fromEndpoints);
    const fromIdx = stageById.get(fromKey).idx, toIdx = stageById.get(toKey).idx;
    const canMerge = toIdx === fromIdx + 1;

    res.json({
      from: { environmentId: fromKey, label: stageById.get(fromKey).label },
      to: { environmentId: toKey, label: stageById.get(toKey).label, requiresApproval: !!stageById.get(toKey).requiresApproval },
      canMerge,
      // Only minted for an adjacent pair (the only pair POST /promote will
      // ever accept) — see the diff-viewed gate above. A non-adjacent,
      // purely-informational comparison (e.g. Dev vs Production) doesn't
      // need one since it can never back a promote call anyway.
      diffToken: canMerge ? mintDiffToken({ projectId: project.id, from: fromKey, to: toKey, diff: rawDiff, breakingChanges: rawBreakingChanges }) : null,
      summary: { added: diff.added.length, removed: diff.removed.length, modified: diff.modified.length },
      added: diff.added,
      removed: diff.removed,
      modified: diff.modified,
      breakingChanges,
      hasBreakingChanges: breakingChanges.length > 0,
      excludedNotReady: gate.excluded,
    });
  } catch (err) {
    console.error('GET project diff failed:', err);
    res.status(500).json({ error: 'Could not compute diff.' });
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

// ---- Rollback (item #6) ----
// GET /api/workspace/projects/:id/versions/:environmentId/history — the last
// N promotions (and rollbacks) made into one environment, newest first. Only
// exposed to whoever could already see /versions for this project (owner,
// grant, or public — same resolveAccessById check), since it's the same
// class of metadata (promotion status), just historical instead of current.
router.get('/projects/:id/versions/:environmentId/history', async (req, res) => {
  try {
    const { rows: projRows } = await pool.query(
      `SELECT id, organisation FROM projects WHERE id = $1`,
      [req.params.id]
    );
    if (!projRows.length || projRows[0].organisation !== req.authUser.organisation) {
      return res.status(404).json({ error: 'Project not found.' });
    }
    const access = await resolveAccessById(req.authUser.sub, req.params.id, req.authUser.organisation);
    if (!access.canView) return res.status(404).json({ error: 'Project not found.' });

    const { rows } = await pool.query(
      `SELECT id, version, action, source_environment_id, auto_mirrored,
              promoted_by_username, promoted_at, rolled_back_from_id
       FROM project_env_version_history
       WHERE project_id = $1 AND environment_id = $2
       ORDER BY id DESC
       LIMIT 20`,
      [req.params.id, req.params.environmentId]
    );
    res.json({ history: rows });
  } catch (err) {
    console.error('GET versions/history failed:', err);
    res.status(500).json({ error: 'Could not load version history.' });
  }
});

// POST /api/workspace/projects/:id/rollback — Body: { environmentId, historyId }
// Re-applies a specific historical promotion as the environment's current
// version — "one-click rollback instead of only forward promotion." Admin
// only, same as promote: rolling back Production (say) is exactly as
// consequential as promoting into it. Re-applying rather than deleting
// forward means the rollback itself becomes a new, fully-audited history
// entry (action='rollback', rolled_back_from_id pointing at what was live
// just before) — the environment's real timeline is "promote, promote,
// rollback," never silently rewritten.
router.post('/projects/:id/rollback', async (req, res) => {
  if (!isAdminUser(req)) return res.status(403).json({ error: 'Only Admins can roll back an environment.' });
  const { environmentId, historyId } = req.body || {};
  if (!environmentId || !historyId) return res.status(400).json({ error: 'environmentId and historyId are required.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: projRows } = await client.query(
      `SELECT id, organisation FROM projects WHERE id = $1 FOR UPDATE`,
      [req.params.id]
    );
    if (!projRows.length || projRows[0].organisation !== req.authUser.organisation) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Project not found.' });
    }
    const project = projRows[0];

    const { rows: currentRows } = await client.query(
      `SELECT id FROM project_env_version_history WHERE project_id = $1 AND environment_id = $2 ORDER BY id DESC LIMIT 1`,
      [project.id, environmentId]
    );
    const { rows: targetRows } = await client.query(
      `SELECT id, version, data_enc, data_key_version, source_environment_id
       FROM project_env_version_history WHERE id = $1 AND project_id = $2 AND environment_id = $3`,
      [historyId, project.id, environmentId]
    );
    if (!targetRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'That version was not found in this environment\'s history.' });
    }
    const target = targetRows[0];
    if (currentRows.length && currentRows[0].id === target.id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'That version is already the one currently live in this environment.' });
    }

    await client.query(
      `INSERT INTO project_env_versions
         (project_id, environment_id, version, data_enc, data_key_version, source_environment_id, promoted_by, promoted_by_username, auto_mirrored, promoted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, now())
       ON CONFLICT (project_id, environment_id) DO UPDATE SET
         version = EXCLUDED.version, data_enc = EXCLUDED.data_enc, data_key_version = EXCLUDED.data_key_version,
         source_environment_id = EXCLUDED.source_environment_id, promoted_by = EXCLUDED.promoted_by,
         promoted_by_username = EXCLUDED.promoted_by_username, auto_mirrored = false, promoted_at = now()`,
      [project.id, environmentId, target.version, target.data_enc, target.data_key_version, target.source_environment_id, req.authUser.sub, req.authUser.username]
    );
    await recordEnvVersionHistory(client, {
      projectId: project.id, environmentId, version: target.version,
      dataEnc: target.data_enc, dataKeyVersion: target.data_key_version, sourceEnvironmentId: target.source_environment_id,
      action: 'rollback', rolledBackFromId: currentRows[0]?.id || null,
      promotedBy: req.authUser.sub, promotedByUsername: req.authUser.username, autoMirrored: false,
      releaseNote: String(req.body?.note || '').trim().slice(0, 500) || `Rolled back to v1.0.${target.version}`,
    });

    await client.query('COMMIT');
    await cache.invalidateOrg(project.organisation);

    await recordAuditEvent(req.authUser, req, {
      action: 'PROJECT_ROLLED_BACK',
      resourceType: 'project',
      resourceId: project.id,
      entityName: environmentId,
      details: `Rolled ${environmentId} back to v1.0.${target.version} (history #${target.id}).`,
      severity: 'warning',
      metadata: { environmentId, historyId: target.id, version: target.version },
    });

    res.json({ ok: true, environmentId, versionLabel: `1.0.${target.version}` });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST rollback failed:', err);
    res.status(500).json({ error: 'Could not roll back this environment.' });
  } finally {
    client.release();
  }
});

// POST /api/workspace/projects/:id/environments/:environmentId/prune-endpoints
// Body: { endpointIds: [...], releaseNote }. Admin-only.
//
// The release-readiness gate (see checkReleaseReadiness) stops a NEW
// promotion from landing an unapproved endpoint in Production — it can't
// undo one that landed before the gate existed, or reach in and pull a
// single endpoint back out without redoing a whole release. This is that:
// edits ONE environment's current promoted snapshot in place, removing just
// the given endpoints, without touching the upstream stage it came from (so
// the next real promotion still diffs correctly against the stage above).
// Writes a normal, fully-audited history entry (action='prune') rather than
// silently rewriting anything, and — same as a real promotion into the
// pipeline's last stage — cascades to DR, since DR exists to mirror what
// Production actually serves, not what an old promotion happened to include.
router.post('/projects/:id/environments/:environmentId/prune-endpoints', async (req, res) => {
  if (!isAdminUser(req)) return res.status(403).json({ error: 'Only Admins can edit a promoted environment.' });
  const { environmentId } = req.params;
  const endpointIds = Array.isArray(req.body?.endpointIds) ? req.body.endpointIds.filter((id) => typeof id === 'string' && id) : [];
  if (!endpointIds.length) return res.status(400).json({ error: 'endpointIds is required.' });
  const releaseNote = String(req.body?.releaseNote || '').trim().slice(0, 500);
  if (!releaseNote || releaseNote.length < 10) {
    return res.status(400).json({ error: 'A release note is required (at least 10 characters) explaining why these endpoints are being pulled.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: projRows } = await client.query(
      `SELECT id, organisation FROM projects WHERE id = $1 FOR UPDATE`,
      [req.params.id]
    );
    if (!projRows.length || projRows[0].organisation !== req.authUser.organisation) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Project not found.' });
    }
    const project = projRows[0];

    const allEnvs = await getOrgEnvironments(project.organisation);
    const stages = pipelineStages(allEnvs);
    const stageIdx = stages.findIndex((e) => e.id === environmentId);
    if (stageIdx <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Unknown or non-editable environment.' });
    }
    const stage = stages[stageIdx];

    const { rows: curRows } = await client.query(
      `SELECT version, data_enc FROM project_env_versions WHERE project_id = $1 AND environment_id = $2 FOR UPDATE`,
      [project.id, environmentId]
    );
    if (!curRows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Nothing has been promoted to ${stage.label} yet.` });
    }
    const current = JSON.parse(dataCrypto.decryptField(curRows[0].data_enc, `project-env:${project.id}:${environmentId}`));
    const removeSet = new Set(endpointIds);
    const before = (current.endpoints || []).length;
    const removed = (current.endpoints || []).filter((e) => e && removeSet.has(e.id));
    if (!removed.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'None of the given endpoint ids are currently present in this environment.' });
    }
    current.endpoints = (current.endpoints || []).filter((e) => !e || !removeSet.has(e.id));

    const dataEnc = dataCrypto.encryptField(JSON.stringify(current), `project-env:${project.id}:${environmentId}`);
    const dataKeyVersion = dataCrypto.currentKeyVersion();
    await client.query(
      `UPDATE project_env_versions SET data_enc = $1, data_key_version = $2, promoted_by = $3, promoted_by_username = $4, auto_mirrored = false, promoted_at = now()
       WHERE project_id = $5 AND environment_id = $6`,
      [dataEnc, dataKeyVersion, req.authUser.sub, req.authUser.username, project.id, environmentId]
    );
    await recordEnvVersionHistory(client, {
      projectId: project.id, environmentId, version: curRows[0].version, dataEnc, dataKeyVersion,
      sourceEnvironmentId: null, action: 'prune', promotedBy: req.authUser.sub, promotedByUsername: req.authUser.username,
      autoMirrored: false, releaseNote: `${releaseNote} (removed ${removed.length} of ${before} endpoints)`,
    });

    let mirrored = null;
    const isLastStage = stageIdx === stages.length - 1;
    if (isLastStage) {
      const drEnv = allEnvs.find((e) => String(e.label || '').trim().toUpperCase() === 'DR');
      if (drEnv) {
        const mirrorEnc = dataCrypto.encryptField(JSON.stringify(current), `project-env:${project.id}:${drEnv.id}`);
        const mirrorKeyVersion = dataCrypto.currentKeyVersion();
        await client.query(
          `INSERT INTO project_env_versions
             (project_id, environment_id, version, data_enc, data_key_version, source_environment_id, promoted_by, promoted_by_username, auto_mirrored, promoted_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, now())
           ON CONFLICT (project_id, environment_id) DO UPDATE SET
             version = EXCLUDED.version, data_enc = EXCLUDED.data_enc, data_key_version = EXCLUDED.data_key_version,
             source_environment_id = EXCLUDED.source_environment_id, promoted_by = EXCLUDED.promoted_by,
             promoted_by_username = EXCLUDED.promoted_by_username, auto_mirrored = true, promoted_at = now()`,
          [project.id, drEnv.id, curRows[0].version, mirrorEnc, mirrorKeyVersion, stage.id, req.authUser.sub, req.authUser.username]
        );
        await recordEnvVersionHistory(client, {
          projectId: project.id, environmentId: drEnv.id, version: curRows[0].version,
          dataEnc: mirrorEnc, dataKeyVersion: mirrorKeyVersion, sourceEnvironmentId: stage.id,
          action: 'prune', promotedBy: req.authUser.sub, promotedByUsername: req.authUser.username, autoMirrored: true,
          releaseNote: `Auto-mirrored from ${stage.label}: ${releaseNote} (removed ${removed.length} of ${before} endpoints)`,
        });
        mirrored = { environmentId: drEnv.id, label: drEnv.label };
      }
    }

    await client.query('COMMIT');
    await cache.invalidateOrg(project.organisation);

    await recordAuditEvent(req.authUser, req, {
      action: 'PROJECT_ENDPOINTS_PRUNED',
      resourceType: 'project',
      resourceId: project.id,
      entityName: stage.label,
      details: `Removed ${removed.length} endpoint${removed.length === 1 ? '' : 's'} from ${stage.label}: ${removed.map((e) => `${(e.method || '').toUpperCase()} ${e.path || ''}`).join(', ')}. ${releaseNote}`,
      severity: 'warning',
      metadata: { environmentId, removedEndpointIds: removed.map((e) => e.id), remainingCount: current.endpoints.length },
    });

    res.json({ ok: true, environmentId, removedCount: removed.length, remainingCount: current.endpoints.length, mirrored });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST prune-endpoints failed:', err);
    res.status(500).json({ error: 'Could not edit this environment.' });
  } finally {
    client.release();
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
