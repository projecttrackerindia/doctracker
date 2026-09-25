const express = require('express');
const { pool } = require('../db');
const { authenticate, blockIfScheduleLocked } = require('../middleware/authGuard');
const { recordAuditEvent } = require('../auditService');
const { notifyUser, notifyUsers, adminUserIds } = require('../notifications');
const cache = require('../cache');
const { decryptProjectData, getDocAccessMap, getOrgEnvironments, pipelineStages } = require('./workspace');

const router = express.Router();
router.use(authenticate);
router.use(blockIfScheduleLocked);

// ---- Approval scope: Admin (everything) or the owner of the specific
// project a request belongs to (their own project only) ----
//
// Previously every approve/deny/revoke/delete was requireAdmin, full stop —
// fine when one Admin oversees a handful of projects, but it doesn't scale:
// every project owner's documentation-access decisions funnel through one
// org-wide queue regardless of how many projects/teams exist. This lets a
// project owner act on requests scoped to THEIR OWN project while an Admin
// keeps full visibility/override across all of them — same shape as
// projectAccess.js's owner-or-grant model, applied here to the approval
// workflow instead of read access.
async function loadRequestWithProjectOwner(requestId, organisation) {
  const { rows } = await pool.query(
    `SELECT r.id, r.project_id, r.endpoint_id, r.endpoint_label, r.environment_id, r.environment_label, r.requested_by_username, r.status,
            to_char(r.start_date,'YYYY-MM-DD') AS start_date, to_char(r.end_date,'YYYY-MM-DD') AS end_date,
            r.requested_by, p.owner_id AS project_owner_id, p.name AS project_name
     FROM doc_access_requests r
     LEFT JOIN projects p ON p.id = r.project_id
     WHERE r.id = $1 AND r.organisation = $2`,
    [requestId, organisation]
  );
  return rows[0] || null;
}

// Pure decision functions — kept separate from the route handlers below so
// the permission/status rules that caused past regressions ("the kind #6
// and #7 were", per README's Known gaps) can be unit-tested without a DB
// round-trip. Exported as properties on the router (module.exports.*, see
// the bottom of this file), the same pattern server/routes/workspace.js
// already uses for its own pure helpers.

// Admin, or the request's own project owner — and never the requester
// themselves, regardless of role. Low-impact today: an Admin/editor already
// has full doc access regardless of any grant (see userHasFullDocAccess in
// workspace.js), and a project owner is never locked out of their own
// project's endpoints in the first place (see applyDocLock there), so this
// mostly guards against someone hitting the API directly rather than a
// reachable UI path. It matters more once approval authority gets
// delegated more broadly than "Admin or owner."
function canActOnDocAccessRequest(row, authUser) {
  if (authUser.role !== 'admin' && row.project_owner_id !== authUser.sub) {
    return { allowed: false, reason: "Only an Admin or this project's owner can do that." };
  }
  if (row.requested_by === authUser.sub) {
    return { allowed: false, reason: 'You cannot act on your own documentation access request.' };
  }
  return { allowed: true, reason: null };
}

// Attaches `req._docAccessRequest` (already fetched — approve/deny/revoke/
// delete all need the row anyway, so this avoids fetching it twice) and lets
// the request through only when canActOnDocAccessRequest() allows it.
async function requireAdminOrProjectOwner(req, res, next) {
  try {
    const row = await loadRequestWithProjectOwner(req.params.id, req.authUser.organisation);
    if (!row) return res.status(404).json({ error: 'Request not found.' });
    const decision = canActOnDocAccessRequest(row, req.authUser);
    if (!decision.allowed) return res.status(403).json({ error: decision.reason });
    req._docAccessRequest = row;
    next();
  } catch (err) {
    console.error('requireAdminOrProjectOwner failed:', err);
    res.status(500).json({ error: 'Could not verify permission.' });
  }
}

// A grant can only be revoked while it is the current approved grant —
// revoking an already-denied/revoked/pending request is meaningless.
function canRevokeDocAccessRequest(status) {
  return status === 'approved';
}

// Deleting is housekeeping on a CLOSED-OUT request only: a pending request
// must be denied first (so the requester gets an answer, not silence), and
// a currently-active approved grant must be revoked first (revoking is
// always the one path that actually ends live access, never a delete).
function canDeleteDocAccessRequest({ status, is_active }) {
  return !(status === 'pending' || is_active);
}

// What GET /endpoint-status shows for one environment. 'active' wins over
// everything else (an approved grant whose date range covers today); an
// 'approved' row OUTSIDE its date range reads as 'expired' rather than
// staying 'approved' — is_active is a derived column, not a stored one, so
// without this a grant would go stale with no background job ever marking
// it, and the two words would otherwise mean the same thing to a caller.
function deriveDocAccessDisplayStatus(row) {
  if (!row) return { status: 'none', endDate: null };
  if (row.is_active) return { status: 'active', endDate: row.end_date };
  if (row.status === 'pending') return { status: 'pending', endDate: null };
  if (row.status === 'denied') return { status: 'denied', endDate: null };
  if (row.status === 'approved') return { status: 'expired', endDate: null };
  if (row.status === 'revoked') return { status: 'revoked', endDate: null };
  return { status: 'none', endDate: null };
}

// A defensive cap, not a realistic ceiling — this is time-boxed
// documentation access, not a permanent role change, so a single request
// shouldn't be able to ask for (or be approved for) an indefinite window.
const MAX_RANGE_DAYS = 366;

function parseDateOnly(str) {
  if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
  const d = new Date(`${str}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}
function todayUTC() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// By the time any route below calls this, the real write (INSERT/UPDATE/
// DELETE on doc_access_requests) has already been committed. What's left —
// the audit row and the notification fan-out — is bookkeeping, not the
// thing the caller asked for. If either throws (a transient DB blip, a
// dropped connection, whatever), that must never turn an already-successful
// change into a reported 500: the person would see an error and reasonably
// assume nothing happened, when it did. So this logs and swallows rather
// than propagating — the HTTP response is decided by the core write only.
async function afterCommit(label, fn) {
  try {
    await fn();
  } catch (err) {
    console.error(`${label} (write already committed — audit/notify step failed, non-fatal):`, err);
  }
}

// POST /api/workspace/doc-access/requests — a Viewer (or a 'custom' role
// without edit rights) asking for time-boxed access to one locked
// endpoint's documentation, scoped to one or more pipeline environments
// (Dev/SIT/UAT/...) — a grant for SIT should never quietly unlock the same
// endpoint's docs in every other environment too. One row is written per
// requested environment; any environment where the caller already has an
// active grant or a pending request is skipped rather than erroring out the
// whole batch, so asking for ["SIT","UAT"] when SIT is already covered
// still gets UAT submitted.
// Body: { projectId, endpointId, environmentIds: [...], startDate: 'YYYY-MM-DD', endDate: 'YYYY-MM-DD', reason? }
router.post('/requests', async (req, res) => {
  const { projectId, endpointId, environmentIds, environmentId, startDate, endDate, reason } = req.body || {};
  if (!projectId || !endpointId) return res.status(400).json({ error: 'projectId and endpointId are required.' });
  // environmentId (singular) still accepted for anyone hitting the API directly / old clients.
  const envIds = [...new Set(Array.isArray(environmentIds) ? environmentIds : (environmentId ? [environmentId] : []))];
  if (!envIds.length) return res.status(400).json({ error: 'Pick at least one environment you need documentation access for.' });
  const start = parseDateOnly(startDate);
  const end = parseDateOnly(endDate);
  if (!start || !end) return res.status(400).json({ error: 'startDate and endDate must be dates in YYYY-MM-DD form.' });
  const today = todayUTC();
  if (start < today) return res.status(400).json({ error: "Start date can't be in the past." });
  if (end < start) return res.status(400).json({ error: 'End date must be on or after the start date.' });
  const rangeDays = Math.round((end - start) / 86400000);
  if (rangeDays > MAX_RANGE_DAYS) {
    return res.status(400).json({ error: `That's more than ${MAX_RANGE_DAYS} days — request a shorter window (you can always ask for an extension later).` });
  }
  if (reason != null && (typeof reason !== 'string' || reason.length > 500)) {
    return res.status(400).json({ error: 'Reason must be 500 characters or fewer.' });
  }

  try {
    const org = req.authUser.organisation;
    const userId = req.authUser.sub;

    const { rows: projRows } = await pool.query(
      `SELECT id, owner_id, organisation, visibility, name, data, data_enc FROM projects WHERE id = $1 AND organisation = $2`,
      [projectId, org]
    );
    if (!projRows.length) return res.status(404).json({ error: 'Project not found.' });
    const project = decryptProjectData(projRows[0]);
    const ep = (project.endpoints || []).find((e) => e.id === endpointId);
    if (!ep) return res.status(404).json({ error: 'Endpoint not found.' });

    // Every environment must be a real stage in this org's pipeline. DR is
    // excluded the same way it is from promotion — it auto-mirrors the last
    // stage rather than being something anyone requests access to directly.
    const stages = pipelineStages(await getOrgEnvironments(org));
    const stageById = new Map(stages.map((s) => [s.id, s]));
    const unknown = envIds.filter((id) => !stageById.has(id));
    if (unknown.length) return res.status(400).json({ error: 'Unknown environment.' });

    const label = `${(ep.method || 'GET').toUpperCase()} ${ep.path || ''}`.trim();
    const created = [];
    const skipped = [];

    for (const envId of envIds) {
      const envMeta = stageById.get(envId);
      const existingMap = await getDocAccessMap(org, userId, projectId, [endpointId], envId);
      const existing = existingMap.get(endpointId);
      if (existing && existing.is_active) {
        skipped.push({ environmentId: envId, environmentLabel: envMeta.label, reason: `already have access until ${existing.end_date}` });
        continue;
      }
      if (existing && existing.status === 'pending') {
        skipped.push({ environmentId: envId, environmentLabel: envMeta.label, reason: 'already have a pending request' });
        continue;
      }
      try {
        const { rows } = await pool.query(
          `INSERT INTO doc_access_requests
            (organisation, project_id, endpoint_id, endpoint_label, environment_id, environment_label, requested_by, requested_by_username, reason, start_date, end_date)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           RETURNING id, status, environment_id, environment_label, to_char(start_date,'YYYY-MM-DD') AS start_date, to_char(end_date,'YYYY-MM-DD') AS end_date, created_at`,
          [org, projectId, endpointId, label, envId, envMeta.label, userId, req.authUser.username, (reason || '').trim() || null, startDate, endDate]
        );
        created.push(rows[0]);
      } catch (err) {
        // The check above (existingMap lookup) is check-then-insert and
        // inherently racy — two rapid clicks, two open tabs, or a retry can
        // both pass it before either has committed. uq_doc_access_pending_per_scope
        // (see db.js) is the real guard against that race; if we lose the
        // race and hit it, treat it exactly like the check above would have,
        // instead of failing the whole batch over one already-covered
        // environment.
        if (err.code === '23505') {
          skipped.push({ environmentId: envId, environmentLabel: envMeta.label, reason: 'already have a pending request' });
          continue;
        }
        throw err;
      }
    }

    if (!created.length) {
      // Every requested environment was already covered — nothing new to
      // submit. Not a hard error: the caller's UI should read this as "you're
      // already set" rather than a failure.
      return res.status(409).json({
        error: skipped.map((s) => `${s.environmentLabel}: ${s.reason}`).join('; '),
        skipped,
      });
    }

    const envList = created.map((r) => r.environment_label).join(', ');

    // The requests above are already committed — everything past this
    // point is audit/notification bookkeeping and must not turn a
    // successful submission into a reported failure (see afterCommit).
    await afterCommit('DOC_ACCESS_REQUESTED', async () => {
      await recordAuditEvent(req.authUser, req, {
        action: 'DOC_ACCESS_REQUESTED',
        resourceType: 'endpoint',
        resourceId: String(endpointId),
        entityName: label,
        projectName: project.name,
        details: `Requested documentation access to ${envList} from ${startDate} to ${endDate}`,
        severity: 'info',
      });
      await cache.invalidateOrg(org);

      // Notify whoever can actually act on this — the project owner, plus
      // every Admin (who can act on anything, and should still see it even
      // when a project owner ends up handling it themselves). See
      // requireAdminOrProjectOwner above for why both are recipients.
      const admins = await adminUserIds(org);
      const recipients = new Set(admins);
      if (projRows[0].owner_id) recipients.add(projRows[0].owner_id);
      await notifyUsers([...recipients], {
        organisation: org,
        type: 'DOC_ACCESS_REQUESTED',
        title: `${req.authUser.username} requested documentation access`,
        body: `${label} in ${project.name} (${envList})`,
        link: { view: 'security', tab: 'docaccess' },
      });
    });

    res.json({ created, skipped });
  } catch (err) {
    console.error('POST /api/workspace/doc-access/requests failed:', err);
    res.status(500).json({ error: 'Could not submit the request.' });
  }
});

// GET /api/workspace/doc-access/endpoint-status?projectId=&endpointId= — for
// the request modal: this caller's current status (none/pending/active/
// denied/expired) against THIS endpoint, broken out per pipeline
// environment, so the UI can grey out or label environments they already
// have covered instead of letting them file a request that just gets
// rejected as a duplicate.
router.get('/endpoint-status', async (req, res) => {
  const { projectId, endpointId } = req.query || {};
  if (!projectId || !endpointId) return res.status(400).json({ error: 'projectId and endpointId are required.' });
  try {
    const org = req.authUser.organisation;
    const userId = req.authUser.sub;
    const stages = pipelineStages(await getOrgEnvironments(org));

    const { rows } = await pool.query(
      `SELECT environment_id, status,
              to_char(start_date,'YYYY-MM-DD') AS start_date,
              to_char(end_date,'YYYY-MM-DD') AS end_date,
              (status = 'approved' AND start_date <= CURRENT_DATE AND end_date >= CURRENT_DATE) AS is_active,
              created_at
       FROM doc_access_requests
       WHERE organisation = $1 AND requested_by = $2 AND project_id = $3 AND endpoint_id = $4
       ORDER BY created_at DESC`,
      [org, userId, projectId, endpointId]
    );

    // Newest-first, so the first row seen per environment_id (or the first
    // NULL-environment / legacy row) is the one that counts — same
    // "exact environment wins, otherwise fall back to a pre-migration
    // environment-less grant" rule getDocAccessMap uses elsewhere.
    const byEnv = new Map();
    let legacyRow = null;
    rows.forEach((r) => {
      if (r.environment_id) {
        if (!byEnv.has(r.environment_id)) byEnv.set(r.environment_id, r);
      } else if (!legacyRow) {
        legacyRow = r;
      }
    });

    const environments = stages.map((s) => {
      const row = byEnv.get(s.id) || legacyRow || null;
      const { status, endDate } = deriveDocAccessDisplayStatus(row);
      return { id: s.id, label: s.label, status, endDate };
    });

    res.json({ environments });
  } catch (err) {
    console.error('GET /api/workspace/doc-access/endpoint-status failed:', err);
    res.status(500).json({ error: 'Could not load access status.' });
  }
});

// GET /api/workspace/doc-access/my-requests — the caller's own request
// history, newest first, across every project. Not currently surfaced by
// any dedicated screen, but every locked endpoint already shows this
// person's own latest request for THAT endpoint (via GET /api/workspace) —
// this exists for a future "all my requests in one place" view.
// Cursor pagination shared by /my-requests and /admin below. Sorted by
// (sortRank, id) so a stable, indexable cursor ("give me the ones after this
// id, within this rank") works even though the primary ordering is a
// computed boolean (pending-first), not just id/created_at — a plain
// OFFSET/LIMIT couldn't do that cheaply, and a naive `id < cursor` cursor
// would break pending-first ordering entirely, so the cursor here is a pair.
const PAGE_SIZE_DEFAULT = 50;
const PAGE_SIZE_MAX = 200;

function parsePageParams(query) {
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || PAGE_SIZE_DEFAULT, 1), PAGE_SIZE_MAX);
  const cursorId = query.cursorId ? Number(query.cursorId) : null;
  return { limit, cursorId: Number.isInteger(cursorId) ? cursorId : null };
}

// /admin sorts pending-first (`ORDER BY (status = 'pending') DESC, id DESC`)
// but /my-requests sorts by id alone — so only /admin's cursor needs to
// carry the pending-rank of the last row shown, alongside its id. 'true'/
// 'false' from the client (see 12-security-center.js, which reads it off
// the last row of the previous page); null if the caller didn't send it.
function parseCursorPending(query) {
  if (query.cursorPending === 'true') return true;
  if (query.cursorPending === 'false') return false;
  return null;
}

// GET /api/workspace/doc-access/my-requests?limit=50&cursorId=123 — the
// caller's own request history, newest first, across every project.
// Previously hard-capped at 200 with no way to see anything past it and no
// indication anything was even missing — now cursor-paginated like /admin.
router.get('/my-requests', async (req, res) => {
  const { limit, cursorId } = parsePageParams(req.query);
  try {
    const params = [req.authUser.organisation, req.authUser.sub];
    let cursorClause = '';
    if (cursorId) {
      params.push(cursorId);
      cursorClause = `AND r.id < $${params.length}`;
    }
    params.push(limit + 1);
    const { rows } = await pool.query(
      `SELECT r.id, r.project_id, p.name AS project_name, r.endpoint_id, r.endpoint_label,
              r.environment_id, r.environment_label,
              r.reason, r.status,
              to_char(r.start_date,'YYYY-MM-DD') AS start_date, to_char(r.end_date,'YYYY-MM-DD') AS end_date,
              (r.status = 'approved' AND r.start_date <= CURRENT_DATE AND r.end_date >= CURRENT_DATE) AS is_active,
              r.decided_by_username, r.decided_at, r.decision_note, r.created_at
       FROM doc_access_requests r
       LEFT JOIN projects p ON p.id = r.project_id
       WHERE r.organisation = $1 AND r.requested_by = $2 ${cursorClause}
       ORDER BY r.id DESC
       LIMIT $${params.length}`,
      params
    );
    const hasMore = rows.length > limit;
    res.json({ requests: rows.slice(0, limit), hasMore });
  } catch (err) {
    console.error('GET /api/workspace/doc-access/my-requests failed:', err);
    res.status(500).json({ error: 'Could not load your requests.' });
  }
});

// ---- Admin / project-owner management (Security ▸ Documentation Access) ----

// GET /api/workspace/doc-access/admin?limit=50&cursorId=123 — Admin sees
// every request in the organisation; a non-Admin sees only requests against
// projects THEY own (see requireAdminOrProjectOwner above for the same
// scoping applied to the action routes). Pending ones first, then newest.
// Previously a flat LIMIT 500 with no pagination — quietly dropped older
// rows past that with nothing telling the viewer they were missing anything;
// now cursor-paginated with an explicit hasMore flag the client can act on.
router.get('/admin', async (req, res) => {
  const isAdminUser = req.authUser.role === 'admin';
  const { limit, cursorId } = parsePageParams(req.query);
  let cursorPending = parseCursorPending(req.query);
  try {
    const params = [req.authUser.organisation];
    let scopeClause = '';
    if (!isAdminUser) {
      params.push(req.authUser.sub);
      scopeClause = `AND p.owner_id = $${params.length}`;
    }
    let cursorClause = '';
    if (cursorId) {
      if (cursorPending === null) {
        // Caller didn't tell us the last row's rank (a stale cached bundle,
        // a direct API call). Look it up rather than guess — one cheap
        // extra query beats silently reproducing the bug below.
        const { rows: cursorRows } = await pool.query(
          `SELECT (status = 'pending') AS is_pending FROM doc_access_requests WHERE id = $1`,
          [cursorId]
        );
        cursorPending = cursorRows[0] ? cursorRows[0].is_pending : false;
      }
      // Real compound keyset cursor matching the ORDER BY below exactly:
      // "every row whose (pending-rank, id) tuple sorts strictly after the
      // cursor's, in that same order" — the two-column generalization of the
      // plain `id < cursor` a single-column DESC cursor uses. The previous
      // version compared id alone, which silently dropped every decided
      // (non-pending) row with an id smaller than the last pending id shown
      // — the normal case for any org with real history, not an edge case,
      // and worse than the flat LIMIT 500 it replaced because it fails
      // silently (hasMore reads false) instead of loudly.
      params.push(cursorPending, cursorId);
      cursorClause = `AND (r.status = 'pending', r.id) < ($${params.length - 1}, $${params.length})`;
    }
    params.push(limit + 1);
    const { rows } = await pool.query(
      `SELECT r.id, r.project_id, p.name AS project_name, p.owner_id AS project_owner_id,
              r.endpoint_id, r.endpoint_label, r.environment_id, r.environment_label,
              r.requested_by, r.requested_by_username, r.reason, r.status,
              to_char(r.start_date,'YYYY-MM-DD') AS start_date, to_char(r.end_date,'YYYY-MM-DD') AS end_date,
              (r.status = 'approved' AND r.start_date <= CURRENT_DATE AND r.end_date >= CURRENT_DATE) AS is_active,
              r.decided_by_username, r.decided_at, r.decision_note, r.created_at
       FROM doc_access_requests r
       LEFT JOIN projects p ON p.id = r.project_id
       WHERE r.organisation = $1 ${scopeClause} ${cursorClause}
       ORDER BY (r.status = 'pending') DESC, r.id DESC
       LIMIT $${params.length}`,
      params
    );
    const hasMore = rows.length > limit;
    res.json({ requests: rows.slice(0, limit), hasMore, scope: isAdminUser ? 'all' : 'owned' });
  } catch (err) {
    console.error('GET /api/workspace/doc-access/admin failed:', err);
    res.status(500).json({ error: 'Could not load documentation access requests.' });
  }
});

// GET /api/workspace/doc-access/pending-count — cheap poll target for the
// Security nav badge (see studio.html). Scoped the same way /admin is: an
// Admin gets the org-wide pending count, a project owner gets only pending
// requests against projects they own, and everyone else gets 0 (and the nav
// badge/tab simply doesn't render for them).
router.get('/pending-count', async (req, res) => {
  const isAdminUser = req.authUser.role === 'admin';
  try {
    const params = [req.authUser.organisation];
    let scopeClause = '';
    if (!isAdminUser) {
      params.push(req.authUser.sub);
      scopeClause = `AND p.owner_id = $${params.length}`;
    }
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n
       FROM doc_access_requests r
       LEFT JOIN projects p ON p.id = r.project_id
       WHERE r.organisation = $1 AND r.status = 'pending' ${scopeClause}`,
      params
    );
    res.json({ count: rows[0]?.n || 0 });
  } catch (err) {
    console.error('GET /api/workspace/doc-access/pending-count failed:', err);
    res.status(500).json({ error: 'Could not load pending count.' });
  }
});

// POST /api/workspace/doc-access/:id/approve — grants the window, optionally
// overriding the requested dates first (e.g. to match a shorter policy).
router.post('/:id/approve', requireAdminOrProjectOwner, async (req, res) => {
  try {
    const existing = req._docAccessRequest;

    let finalStart = existing.start_date;
    let finalEnd = existing.end_date;
    const { startDate, endDate } = req.body || {};
    if (startDate || endDate) {
      const start = parseDateOnly(startDate || existing.start_date);
      const end = parseDateOnly(endDate || existing.end_date);
      if (!start || !end || end < start) return res.status(400).json({ error: 'Invalid date override.' });
      finalStart = startDate || existing.start_date;
      finalEnd = endDate || existing.end_date;
    }

    const { rows } = await pool.query(
      `UPDATE doc_access_requests
       SET status = 'approved', start_date = $1, end_date = $2,
           decided_by = $3, decided_by_username = $4, decided_at = now(), decision_note = NULL, updated_at = now()
       WHERE id = $5
       RETURNING id, status, to_char(start_date,'YYYY-MM-DD') AS start_date, to_char(end_date,'YYYY-MM-DD') AS end_date`,
      [finalStart, finalEnd, req.authUser.sub, req.authUser.username, req.params.id]
    );

    await afterCommit('DOC_ACCESS_APPROVED', async () => {
      await recordAuditEvent(req.authUser, req, {
        action: 'DOC_ACCESS_APPROVED',
        resourceType: 'endpoint',
        resourceId: existing.endpoint_id,
        entityName: existing.endpoint_label,
        details: `Approved documentation access for ${existing.requested_by_username} in ${existing.environment_label || 'every environment'}, ${finalStart} to ${finalEnd}`,
        severity: 'info',
      });
      await cache.invalidateOrg(req.authUser.organisation);
      await notifyUser(existing.requested_by, {
        organisation: req.authUser.organisation,
        type: 'DOC_ACCESS_APPROVED',
        title: 'Documentation access approved',
        body: `${existing.endpoint_label}${existing.environment_label ? ` (${existing.environment_label})` : ''} — ${finalStart} to ${finalEnd}`,
        link: { view: 'endpoint', projectId: existing.project_id, endpointId: existing.endpoint_id },
      });
    });

    res.json({ request: rows[0] });
  } catch (err) {
    console.error('POST /api/workspace/doc-access/:id/approve failed:', err);
    res.status(500).json({ error: 'Could not approve the request.' });
  }
});

// POST /api/workspace/doc-access/:id/deny — Body: { note? }
router.post('/:id/deny', requireAdminOrProjectOwner, async (req, res) => {
  const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) || null : null;
  try {
    const existing = req._docAccessRequest;

    const { rows } = await pool.query(
      `UPDATE doc_access_requests
       SET status = 'denied', decided_by = $1, decided_by_username = $2, decided_at = now(), decision_note = $3, updated_at = now()
       WHERE id = $4
       RETURNING id, status`,
      [req.authUser.sub, req.authUser.username, note, req.params.id]
    );

    await afterCommit('DOC_ACCESS_DENIED', async () => {
      await recordAuditEvent(req.authUser, req, {
        action: 'DOC_ACCESS_DENIED',
        resourceType: 'endpoint',
        resourceId: existing.endpoint_id,
        entityName: existing.endpoint_label,
        details: `Denied documentation access for ${existing.requested_by_username}${note ? `: ${note}` : ''}`,
        severity: 'warning',
      });
      await cache.invalidateOrg(req.authUser.organisation);
      await notifyUser(existing.requested_by, {
        organisation: req.authUser.organisation,
        type: 'DOC_ACCESS_DENIED',
        title: 'Documentation access denied',
        body: note ? `${existing.endpoint_label} — ${note}` : existing.endpoint_label,
        link: { view: 'endpoint', projectId: existing.project_id, endpointId: existing.endpoint_id },
      });
    });

    res.json({ request: rows[0] });
  } catch (err) {
    console.error('POST /api/workspace/doc-access/:id/deny failed:', err);
    res.status(500).json({ error: 'Could not deny the request.' });
  }
});

// POST /api/workspace/doc-access/:id/revoke — ends an already-approved grant
// early (e.g. the person's involvement in the project ended).
router.post('/:id/revoke', requireAdminOrProjectOwner, async (req, res) => {
  try {
    const existing = req._docAccessRequest;
    if (!canRevokeDocAccessRequest(existing.status)) return res.status(400).json({ error: 'Only an approved grant can be revoked.' });

    await pool.query(
      `UPDATE doc_access_requests
       SET status = 'revoked', decided_by = $1, decided_by_username = $2, decided_at = now(), updated_at = now()
       WHERE id = $3`,
      [req.authUser.sub, req.authUser.username, req.params.id]
    );

    await afterCommit('DOC_ACCESS_REVOKED', async () => {
      await recordAuditEvent(req.authUser, req, {
        action: 'DOC_ACCESS_REVOKED',
        resourceType: 'endpoint',
        resourceId: existing.endpoint_id,
        entityName: existing.endpoint_label,
        details: `Revoked documentation access for ${existing.requested_by_username}`,
        severity: 'warning',
      });
      await cache.invalidateOrg(req.authUser.organisation);
      await notifyUser(existing.requested_by, {
        organisation: req.authUser.organisation,
        type: 'DOC_ACCESS_REVOKED',
        title: 'Documentation access revoked',
        body: existing.endpoint_label,
        link: { view: 'endpoint', projectId: existing.project_id, endpointId: existing.endpoint_id },
      });
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/workspace/doc-access/:id/revoke failed:', err);
    res.status(500).json({ error: 'Could not revoke access.' });
  }
});

// DELETE /api/workspace/doc-access/:id — permanently removes a closed-out
// record (denied, revoked, or expired) from the review queue. Deliberately
// refuses to touch anything still 'pending' or an active 'approved' grant —
// those have to go through deny/revoke first, so there's always an audit
// trail before a row can disappear.
router.delete('/:id', requireAdminOrProjectOwner, async (req, res) => {
  try {
    const { rows: statusRows } = await pool.query(
      `SELECT status, (status = 'approved' AND start_date <= CURRENT_DATE AND end_date >= CURRENT_DATE) AS is_active
       FROM doc_access_requests WHERE id = $1`,
      [req.params.id]
    );
    const existing = { ...req._docAccessRequest, ...statusRows[0] };
    if (!canDeleteDocAccessRequest(existing)) {
      return res.status(400).json({ error: 'Deny or revoke this request before deleting it.' });
    }

    await pool.query(`DELETE FROM doc_access_requests WHERE id = $1 AND organisation = $2`, [req.params.id, req.authUser.organisation]);

    // Same false-failure risk as approve/deny/revoke above (the row is
    // already gone by this point) — not in the original audit's list for
    // this route, but it's the identical pattern, so it gets the identical
    // fix.
    await afterCommit('DOC_ACCESS_DELETED', async () => {
      await recordAuditEvent(req.authUser, req, {
        action: 'DOC_ACCESS_DELETED',
        resourceType: 'endpoint',
        resourceId: existing.endpoint_id,
        entityName: existing.endpoint_label,
        details: `Deleted ${existing.status} documentation access request from ${existing.requested_by_username}`,
        severity: 'info',
      });
      await cache.invalidateOrg(req.authUser.organisation);
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/workspace/doc-access/:id failed:', err);
    res.status(500).json({ error: 'Could not delete the request.' });
  }
});

module.exports = router;
module.exports.canActOnDocAccessRequest = canActOnDocAccessRequest;
module.exports.canRevokeDocAccessRequest = canRevokeDocAccessRequest;
module.exports.canDeleteDocAccessRequest = canDeleteDocAccessRequest;
module.exports.deriveDocAccessDisplayStatus = deriveDocAccessDisplayStatus;
module.exports.parsePageParams = parsePageParams;
module.exports.parseCursorPending = parseCursorPending;
