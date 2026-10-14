// Single source of truth for "can this user see/edit this project." Centralizes
// the three independent layers that decide project access, checked in this
// order:
//
//   1. Owner                                   -> full access, no query needed.
//   2. project_access                          -> a named grant to THIS project
//                                                  (see db.js). Project-wide —
//                                                  there is no per-environment
//                                                  scoping any more (environment
//                                                  collapse cluster: the app has
//                                                  exactly one implicit
//                                                  environment, so a grant either
//                                                  covers the project or it
//                                                  doesn't).
//   3. visibility='public' / has_public_endpoint -> org-wide fallback, same
//                          rule workspace.js already applied everywhere.
//                          View-only, and (per projectForViewer()) only
//                          public endpoints/attachments actually surface.
//
// Call sites should use this instead of re-deriving owner/visibility checks
// inline, so a project-level grant only has to be taught to the access model
// once and every read path picks it up.
//
// `allowedEnvironments` is kept on the returned shape (always 'all' now) for
// call-site compatibility rather than removed outright — environmentAllowed()
// below still works unchanged for anything still calling it.
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
    `SELECT permission FROM project_access WHERE project_id = $1 AND user_id = $2`,
    [projectRow.id, userId]
  );
  if (rows.length) {
    // Grants are project-wide only now (environment collapse cluster) — a
    // project_access row used to carry its own `environments` scope
    // (`["*"]` or a specific subset), but with exactly one environment left
    // in the whole app, any grant at all already covers "every environment
    // there is." The column itself is left in place in project_access
    // (always `["*"]` as of the collapse migration) only so existing rows
    // don't need a schema change; nothing reads it any more.
    return {
      canView: true,
      canEdit: rows[0].permission === 'edit',
      allowedEnvironments: 'all',
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

// True if `environmentId` is one this access grant covers. Trivial now that
// allowedEnvironments is always 'all' or [] (environment collapse cluster),
// but kept as its own function/signature since callers still read as "is
// this environment covered," and `canView` alone would be a less honest name
// for what they're checking.
function environmentAllowed(access, environmentId) {
  if (!access || !access.canView) return false;
  return access.allowedEnvironments === 'all' || access.allowedEnvironments.includes(environmentId);
}

// grantCoversEnvironment() used to live here — a standalone "does this raw
// project_access.environments array cover this environment" check, used by
// pii.js and workspace.js against a grant row they'd already fetched
// themselves. Removed: grants are project-wide only now (see resolveAccess
// above), so both call sites dropped the check entirely rather than call a
// function that could only ever return true.
module.exports = { resolveAccess, resolveAccessById, environmentAllowed, NO_ACCESS };
