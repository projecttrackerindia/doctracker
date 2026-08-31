const express = require('express');
const { pool } = require('../db');
const { authenticate } = require('../middleware/authGuard');
const { recordAuditEvent } = require('../auditService');
const dataCrypto = require('../crypto');

const router = express.Router();
router.use(authenticate);

const MAX_PROJECTS_PER_SAVE = 200;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024; // hard server-side cap per file (base64 dataUrl length)

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
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
async function reencryptOrganisation(organisation) {
  const client = await pool.connect();
  let projectsTouched = 0;
  try {
    await client.query('BEGIN');
    const { rows: projectRows } = await client.query(
      `SELECT id, data, data_enc FROM projects WHERE organisation = $1 FOR UPDATE`,
      [organisation]
    );
    for (const row of projectRows) {
      const plain = decryptProjectData(row);
      const { legacyPlaceholder, enc, version } = encryptProjectData(plain, row.id);
      await client.query(
        `UPDATE projects SET data = $1::jsonb, data_enc = $2, data_key_version = $3 WHERE id = $4`,
        [legacyPlaceholder, enc, version, row.id]
      );
      projectsTouched++;
    }

    const { rows: wsRows } = await client.query(
      `SELECT environments, environments_enc, request_history, request_history_enc
       FROM org_workspace WHERE organisation = $1 FOR UPDATE`,
      [organisation]
    );
    if (wsRows.length) {
      const ws = wsRows[0];
      const envPlain = decryptOrgBlob(ws.environments_enc, ws.environments, organisation, 'environments', []);
      const histPlain = decryptOrgBlob(ws.request_history_enc, ws.request_history, organisation, 'request_history', {});
      const envEnc = encryptOrgBlob(envPlain, organisation, 'environments');
      const histEnc = encryptOrgBlob(histPlain, organisation, 'request_history');
      await client.query(
        `UPDATE org_workspace SET
           environments = '[]'::jsonb, environments_enc = $1, environments_key_version = $2,
           request_history = '{}'::jsonb, request_history_enc = $3, request_history_key_version = $4
         WHERE organisation = $5`,
        [envEnc.enc, envEnc.version, histEnc.enc, histEnc.version, organisation]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { projects: projectsTouched, orgWorkspace: true };
}

// A project is visible in full only to its owner. For everyone else in the
// same organisation, we strip it down: only `public` endpoints survive, and
// attachments (which are project-level, not per-endpoint) only survive if the
// project itself is `public`. Different organisation => caller never sees the
// row at all (filtered out in SQL before this runs).
function projectForViewer(row, viewerId, data) {
  data = data || {};
  const isOwner = row.owner_id === viewerId;
  if (isOwner) {
    return { ...data, id: row.id, visibility: row.visibility, _owned: true };
  }
  const endpoints = Array.isArray(data.endpoints)
    ? data.endpoints.filter((ep) => ep && ep.visibility === 'public')
    : [];
  const attachments = row.visibility === 'public' && Array.isArray(data.attachments) ? data.attachments : [];
  return { ...data, id: row.id, visibility: row.visibility, endpoints, attachments, _owned: false, _readonly: true };
}

// GET /api/workspace — everything the signed-in user should see: their own
// projects (untouched) + any project from their organisation that has public
// content, plus the shared org-level environments/audit log/history/presets.
router.get('/', async (req, res) => {
  try {
    const userId = req.authUser.sub;
    const org = req.authUser.organisation;

    // `data` is encrypted, so we can no longer ask Postgres to peek inside it
    // with a jsonb path EXISTS check — we fetch every candidate row (own, or
    // same-organisation) and decide public/private visibility in the app
    // after decrypting, in projectForViewer() below.
    const { rows } = await pool.query(
      `SELECT id, owner_id, organisation, visibility, name, data, data_enc
       FROM projects
       WHERE owner_id = $1 OR organisation = $2`,
      [userId, org]
    );

    const projects = {};
    rows.forEach((row) => {
      const data = decryptProjectData(row);
      const isOwner = row.owner_id === userId;
      if (!isOwner) {
        const hasPublicEndpoint = Array.isArray(data.endpoints) && data.endpoints.some((ep) => ep && ep.visibility === 'public');
        if (row.visibility !== 'public' && !hasPublicEndpoint) return; // not owner, nothing public — skip entirely
      }
      projects[row.id] = projectForViewer(row, userId, data);
    });

    const wsResult = await pool.query(
      `SELECT environments, environments_enc, request_history, request_history_enc, custom_flow_directions
       FROM org_workspace WHERE organisation = $1`,
      [org]
    );
    const ws = wsResult.rows[0] || {};

    // Audit log is no longer part of this payload — it's fetched separately
    // from GET /api/audit/events, which returns server-authoritative entries
    // from the audit_logs table instead of a client-writable JSONB blob.
    res.json({
      projects,
      environments: decryptOrgBlob(ws.environments_enc, ws.environments, org, 'environments', []),
      requestHistory: decryptOrgBlob(ws.request_history_enc, ws.request_history, org, 'request_history', {}),
      customFlowDirections: ws.custom_flow_directions || [],
    });
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
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT id, owner_id FROM projects WHERE id = ANY($1)', [ids]);
    const ownerById = new Map(existing.rows.map((r) => [r.id, r.owner_id]));

    for (const id of ids) {
      if (ownerById.has(id) && ownerById.get(id) !== userId) {
        skipped.push(id); // exists and belongs to someone else — never touch it
        continue;
      }
      const proj = incoming[id] || {};
      const visibility = proj.visibility === 'public' ? 'public' : 'private';
      const name = typeof proj.name === 'string' && proj.name.trim() ? proj.name.trim() : 'Untitled API';
      const dataToStore = { ...proj, id };
      const { legacyPlaceholder, enc, version } = encryptProjectData(dataToStore, id);
      await client.query(
        `INSERT INTO projects (id, owner_id, organisation, visibility, name, data, data_enc, data_key_version, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, now())
         ON CONFLICT (id) DO UPDATE SET
           visibility = EXCLUDED.visibility,
           name = EXCLUDED.name,
           data = EXCLUDED.data,
           data_enc = EXCLUDED.data_enc,
           data_key_version = EXCLUDED.data_key_version,
           updated_at = now()
         WHERE projects.owner_id = $2`,
        [id, userId, org, visibility, name, legacyPlaceholder, enc, version]
      );
      saved.push(id);
    }
    await client.query('COMMIT');
    res.json({ ok: true, saved, skipped });
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
    res.json({ ok: true });
  } catch (err) {
    console.error('PATCH visibility failed:', err);
    res.status(500).json({ error: 'Could not update visibility.' });
  }
});

// DELETE /api/workspace/projects/:id — owner only.
router.delete('/projects/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM projects WHERE id = $1 AND owner_id = $2 RETURNING id',
      [req.params.id, req.authUser.sub]
    );
    if (!rows.length) return res.status(404).json({ error: 'Project not found, or you are not the owner.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE project failed:', err);
    res.status(500).json({ error: 'Could not delete project.' });
  }
});

// ---- Shared org-level extras (environments / request history / flow presets) ----
// NOTE: audit logging used to be a third "column" here (a client-overwritable
// JSONB blob) — that endpoint is removed. Audit events are now written one at
// a time, server-side only, via POST /api/audit/events (see routes/audit.js).
async function upsertOrgWorkspace(org, column, value) {
  const columnWhitelist = ['custom_flow_directions']; // the only remaining plaintext-JSONB column
  if (!columnWhitelist.includes(column)) throw new Error('Invalid column');
  await pool.query(
    `INSERT INTO org_workspace (organisation, ${column}, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (organisation) DO UPDATE SET ${column} = EXCLUDED.${column}, updated_at = now()`,
    [org, JSON.stringify(value)]
  );
}

// environments/request_history can carry real hosts, tokens, and captured
// request/response bodies, so — unlike custom_flow_directions (pure UI
// preference) — they're encrypted before they reach Postgres.
async function upsertEncryptedOrgWorkspace(org, purpose, value) {
  const column = purpose === 'environments' ? 'environments' : 'request_history';
  const { enc, version } = encryptOrgBlob(value, org, purpose);
  await pool.query(
    `INSERT INTO org_workspace (organisation, ${column}, ${column}_enc, ${column}_key_version, updated_at)
     VALUES ($1, $2::jsonb, $3, $4, now())
     ON CONFLICT (organisation) DO UPDATE SET
       ${column} = EXCLUDED.${column}, ${column}_enc = EXCLUDED.${column}_enc,
       ${column}_key_version = EXCLUDED.${column}_key_version, updated_at = now()`,
    [org, column === 'environments' ? '[]' : '{}', enc, version]
  );
}

router.put('/environments', async (req, res) => {
  if (!Array.isArray(req.body?.environments)) return res.status(400).json({ error: 'Expected { environments: [] }.' });
  try {
    await upsertEncryptedOrgWorkspace(req.authUser.organisation, 'environments', req.body.environments);
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
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT request-history failed:', err);
    res.status(500).json({ error: 'Could not save request history.' });
  }
});

router.put('/custom-flow-directions', async (req, res) => {
  if (!Array.isArray(req.body?.customFlowDirections)) return res.status(400).json({ error: 'Expected { customFlowDirections: [] }.' });
  try {
    await upsertOrgWorkspace(req.authUser.organisation, 'custom_flow_directions', req.body.customFlowDirections);
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT custom-flow-directions failed:', err);
    res.status(500).json({ error: 'Could not save flow direction presets.' });
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
      const { legacyPlaceholder, enc, version } = encryptProjectData(dataToStore, id);
      await client.query(
        `INSERT INTO projects (id, owner_id, organisation, visibility, name, data, data_enc, data_key_version)
         VALUES ($1, $2, $3, 'private', $4, $5::jsonb, $6, $7)
         ON CONFLICT (id) DO NOTHING`,
        [id, userId, org, name, legacyPlaceholder, enc, version]
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
    res.json({ ok: true, imported });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/workspace/migrate failed:', err);
    res.status(500).json({ error: 'Migration failed.' });
  } finally {
    client.release();
  }
});

module.exports = router;
module.exports.MAX_ATTACHMENT_BYTES = MAX_ATTACHMENT_BYTES;
module.exports.reencryptOrganisation = reencryptOrganisation;
