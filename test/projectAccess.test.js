// environmentAllowed() — the environment-matching predicate for a resolved
// access result. grantCoversEnvironment() (a standalone check against a raw
// project_access.environments array) was removed in the environment-collapse
// cluster: grants are project-wide only now, so both of its call sites
// (pii.js, workspace.js) dropped the check entirely instead of calling a
// function that could only ever return true. Pure function, zero-DB, same
// node:test style as the rest of this directory.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused@127.0.0.1:1/none';
process.env.MASTER_KEY = process.env.MASTER_KEY || Buffer.alloc(32, 9).toString('base64');

const test = require('node:test');
const assert = require('node:assert/strict');
const { environmentAllowed } = require('../server/projectAccess');

test('environmentAllowed: false when access has no view permission', () => {
  assert.equal(environmentAllowed({ canView: false, allowedEnvironments: 'all' }, 'default'), false);
  assert.equal(environmentAllowed(null, 'default'), false);
});

test('environmentAllowed: "all" covers the one environment there is', () => {
  assert.equal(environmentAllowed({ canView: true, allowedEnvironments: 'all' }, 'default'), true);
});

test('environmentAllowed: an explicit list only covers its own entries', () => {
  assert.equal(environmentAllowed({ canView: true, allowedEnvironments: ['default'] }, 'default'), true);
  assert.equal(environmentAllowed({ canView: true, allowedEnvironments: [] }, 'default'), false);
});
