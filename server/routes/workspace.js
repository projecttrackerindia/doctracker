const express = require('express');
const { pool } = require('../db');
const { authenticate } = require('../middleware/authGuard');

const router = express.Router();
router.use(authenticate);

const MAX_PROJECTS_PER_SAVE = 200;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024; // hard server-side cap per file (base64 dataUrl length)

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

// A project is visible in full only to its owner. For everyone else in the
// same organisation, we strip it down: only `public` endpoints survive, and
// attachments (which are project-level, not per-endpoint) only survive if the
// project itself is `public`. Different organisation => caller never sees the
// row at all (filtered out in SQL before this runs).
function projectForViewer(row, viewerId) {
  const data = row.data || {};
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

    const { rows } = await pool.query(
      `SELECT id, owner_id, organisation, visibility, name, data
       FROM projects
       WHERE owner_id = $1
          OR (organisation = $2 AND (
                visibility = 'public'
                OR EXISTS (
                  SELECT 1 FROM jsonb_array_elements(COALESCE(data->'endpoints', '[]'::jsonb)) e
                  WHERE e->>'visibility' = 'public'
                )
              ))`,
      [userId, org]
    );

    const projects = {};
    rows.forEach((row) => {
      projects[row.id] = projectForViewer(row, userId);
    });

    const wsResult = await pool.query(
      `SELECT environments, audit_log, request_history, custom_flow_directions FROM org_workspace WHERE organisation = $1`,
      [org]
    );
    const ws = wsResult.rows[0] || {
      environments: [],
      audit_log: [],
      request_history: {},
      custom_flow_directions: [],
    };

    res.json({
      projects,
      environments: ws.environments || [],
      auditLog: ws.audit_log || [],
      requestHistory: ws.request_history || {},
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
      await client.query(
        `INSERT INTO projects (id, owner_id, organisation, visibility, name, data, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (id) DO UPDATE SET
           visibility = EXCLUDED.visibility,
           name = EXCLUDED.name,
           data = EXCLUDED.data,
           updated_at = now()
         WHERE projects.owner_id = $2`,
        [id, userId, org, visibility, name, JSON.stringify(dataToStore)]
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
    const { rows } = await pool.query(
      `UPDATE projects SET visibility = $1, data = jsonb_set(data, '{visibility}', to_jsonb($1::text)), updated_at = now()
       WHERE id = $2 AND owner_id = $3
       RETURNING id`,
      [visibility, req.params.id, userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Project not found, or you are not the owner.' });
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

// ---- Shared org-level extras (environments / audit log / request history / flow presets) ----
async function upsertOrgWorkspace(org, column, value) {
  const columnWhitelist = ['environments', 'audit_log', 'request_history', 'custom_flow_directions'];
  if (!columnWhitelist.includes(column)) throw new Error('Invalid column');
  await pool.query(
    `INSERT INTO org_workspace (organisation, ${column}, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (organisation) DO UPDATE SET ${column} = EXCLUDED.${column}, updated_at = now()`,
    [org, JSON.stringify(value)]
  );
}

router.put('/environments', async (req, res) => {
  if (!Array.isArray(req.body?.environments)) return res.status(400).json({ error: 'Expected { environments: [] }.' });
  try {
    await upsertOrgWorkspace(req.authUser.organisation, 'environments', req.body.environments);
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT environments failed:', err);
    res.status(500).json({ error: 'Could not save environments.' });
  }
});

router.put('/audit-log', async (req, res) => {
  if (!Array.isArray(req.body?.auditLog)) return res.status(400).json({ error: 'Expected { auditLog: [] }.' });
  try {
    await upsertOrgWorkspace(req.authUser.organisation, 'audit_log', req.body.auditLog);
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT audit-log failed:', err);
    res.status(500).json({ error: 'Could not save audit log.' });
  }
});

router.put('/request-history', async (req, res) => {
  if (!isPlainObject(req.body?.requestHistory)) return res.status(400).json({ error: 'Expected { requestHistory: {} }.' });
  try {
    await upsertOrgWorkspace(req.authUser.organisation, 'request_history', req.body.requestHistory);
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
      await client.query(
        `INSERT INTO projects (id, owner_id, organisation, visibility, name, data)
         VALUES ($1, $2, $3, 'private', $4, $5)
         ON CONFLICT (id) DO NOTHING`,
        [id, userId, org, name, JSON.stringify(dataToStore)]
      );
      imported++;
    }

    // Merge org-level extras.
    const wsRes = await client.query('SELECT * FROM org_workspace WHERE organisation = $1 FOR UPDATE', [org]);
    const current = wsRes.rows[0] || { environments: [], audit_log: [], request_history: {}, custom_flow_directions: [] };

    const mergeById = (existingArr, incomingArr) => {
      const arr = Array.isArray(existingArr) ? existingArr.slice() : [];
      const seen = new Set(arr.map((x) => x && x.id));
      (Array.isArray(incomingArr) ? incomingArr : []).forEach((item) => {
        if (item && !seen.has(item.id)) { arr.push(item); seen.add(item.id); }
      });
      return arr;
    };

    const mergedEnvironments = mergeById(current.environments, body.environments);
    const mergedAuditLog = mergeById(current.audit_log, body.auditLog).slice(0, 1000);
    const mergedFlowDirections = mergeById(current.custom_flow_directions, body.customFlowDirections);
    const mergedHistory = { ...(current.request_history || {}) };
    if (isPlainObject(body.requestHistory)) {
      Object.entries(body.requestHistory).forEach(([epId, entries]) => {
        const prior = Array.isArray(mergedHistory[epId]) ? mergedHistory[epId] : [];
        mergedHistory[epId] = prior.concat(Array.isArray(entries) ? entries : []).slice(0, 100);
      });
    }

    await client.query(
      `INSERT INTO org_workspace (organisation, environments, audit_log, request_history, custom_flow_directions, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (organisation) DO UPDATE SET
         environments = EXCLUDED.environments,
         audit_log = EXCLUDED.audit_log,
         request_history = EXCLUDED.request_history,
         custom_flow_directions = EXCLUDED.custom_flow_directions,
         updated_at = now()`,
      [org, JSON.stringify(mergedEnvironments), JSON.stringify(mergedAuditLog), JSON.stringify(mergedHistory), JSON.stringify(mergedFlowDirections)]
    );

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
