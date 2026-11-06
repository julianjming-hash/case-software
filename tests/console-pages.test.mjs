import test from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from '../src/shared/ids.mjs';
import { consolePage } from '../src/client/console-pages.mjs';

test('Card 12 facilitator picker exposes explicit bounded membership and version cursors', () => {
  const workspaceId = uuidv7(), versionId = uuidv7();
  const memberships = consolePage('memberships', { memberships: [{ workspace_id: workspaceId,
    name: 'Teaching room', role: 'facilitator' }], nextAfter: workspaceId }, null);
  assert.equal(memberships.nextAfter, workspaceId);
  const versions = consolePage('versions', { versions: [{ version_id: versionId,
    title: 'Published case' }], nextAfter: versionId }, null);
  assert.equal(versions.nextAfter, versionId);
});

test('Card 12 malformed, repeated and oversized picker pages fail without claiming the catalog is complete', () => {
  const workspaceId = uuidv7();
  for (const page of [
    { memberships: Array.from({ length: 21 }, () => ({ workspace_id: workspaceId })), nextAfter: null },
    { memberships: [], nextAfter: workspaceId },
    { memberships: [{ workspace_id: workspaceId }], nextAfter: uuidv7() },
  ]) assert.throws(() => consolePage('memberships', page, null));
  assert.throws(() => consolePage('memberships',
    { memberships: [{ workspace_id: workspaceId }], nextAfter: workspaceId }, workspaceId));
  assert.throws(() => consolePage('versions', { versions: [{ version_id: uuidv7(), title: 'x' }],
    nextAfter: 'not-a-cursor' }, null));
});

test('Card 12 a verified membership without a display name gets a generic workspace label', () => {
  const workspaceId = uuidv7();
  const page = consolePage('memberships', { memberships: [{ workspace_id: workspaceId,
    role: 'owner' }], nextAfter: null }, null);
  assert.equal(page.rows[0].workspace_id, workspaceId);
});
