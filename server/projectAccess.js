// Single source of truth for "can this user see/edit this project, and which
// of its environments." Centralizes the three independent layers that decide
// project access, checked in this order:
//
//   1. Owner            -> full access, every environment, no query needed.
//   2. project_access    -> a named grant to THIS project (see db.js). Scoped
//                          to specific environments unless the grant says
//                          ["*"] (every environment the project has).
//   3. visibility='public' / has_public_endpoint -> org-wide fallback, same
//                          rule workspace.js already applied everywhere.
//                          View-only, and (per projectForViewer()) only
//                          public endpoints/attachments actually surface.
//
// Call sites should use this instead of re-deriving owner/visibility checks
// inline, so a project-level grant only has to be taught to the access model
// once and every read path picks it up.
const { pool } = require('./db');

const NO_ACCESS = Object.freeze({ canView: false, canEdit: false, allowedEnvironments: [] });

// projectRow needs at least: owner_id, organisation, visibility, has_public_endpoint (or omit that
// column and pass has_public_endpoint: false if the caller's query didn't select it).
//
// SECURITY (Finding 4.5): `callerOrg` is required. The org-wide public
// fallback below (layer 3) previously granted canView:true for ANY project
// with visibility='public' or has_public_endpoint, from ANY organisation —
// this module never received or checked the caller's organisation at all.
// No current call site was exploitable (each one separately re-checks
// `project.organisation === caller's org` before calling in), but that
// redundant check lived outside this "single source of truth" module, so
// nothing stopped a future call site from skipping it and trusting this
// function's contract at face value. The check now lives here, where the
// module's own docstring already claims it does.
async function resolveAccess(userId, projectRow, callerOrg) {
  if (!projectRow) return NO_ACCESS;
  if (projectRow.organisation !== callerOrg) return NO_ACCESS;

  if (projectRow.owner_id === userId) {
    return { canView: true, canEdit: true, allowedEnvironments: 'all' };
  }

  const { rows } = await pool.query(
    `SELECT environments, permission FROM project_access WHERE project_id = $1 AND user_id = $2`,
    [projectRow.id, userId]
  );
  if (rows.length) {
    const grant = rows[0];
    const envs = Array.isArray(grant.environments) ? grant.environments : [];
    const allowedEnvironments = envs.includes('*') ? 'all' : envs;
    return {
      canView: true,
      canEdit: grant.permission === 'edit',
      allowedEnvironments,
    };
  }

  if (projectRow.visibility === 'public' || projectRow.has_public_endpoint) {
    // Same org-wide fallback workspace.js already applies elsewhere. View
    // only, and it's on the caller (see projectForViewer) to still filter
    // down to public endpoints/attachments only.
    return { canView: true, canEdit: false, allowedEnvironments: 'all' };
  }

  return NO_ACCESS;
}

// Convenience for call sites that only have a project id, not the row.
// `callerOrg` is required — see the note on resolveAccess above.
async function resolveAccessById(userId, projectId, callerOrg) {
  const { rows } = await pool.query(
    `SELECT id, owner_id, organisation, visibility, has_public_endpoint FROM projects WHERE id = $1`,
    [projectId]
  );
  if (!rows.length) return NO_ACCESS;
  return resolveAccess(userId, rows[0], callerOrg);
}

// True if `environmentId` is one this access grant covers.
function environmentAllowed(access, environmentId) {
  if (!access || !access.canView) return false;
  return access.allowedEnvironments === 'all' || access.allowedEnvironments.includes(environmentId);
}

module.exports = { resolveAccess, resolveAccessById, environmentAllowed, NO_ACCESS };
