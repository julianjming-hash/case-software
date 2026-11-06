import test from 'node:test';
import assert from 'node:assert/strict';
import { newlyPublicGroup } from '../src/client/presentation-emphasis.mjs';

test('Card 23 public emphasis marks only an actually new visible text group and never animates a repeat or deferred media', () => {
  const scene = { surfaceId: 'a', at: 'one', scene: 'Opening', observations: [], points: [], investigations: [], assetIds: [] };
  const findings = { ...scene, points: ['New finding'] };
  assert.equal(newlyPublicGroup(null, scene), null, 'a late joiner gets readable content without replay animation');
  assert.equal(newlyPublicGroup(scene, scene), null);
  assert.equal(newlyPublicGroup(scene, findings), 'findings');
  assert.equal(newlyPublicGroup(findings, { ...findings, assetIds: ['withheld'] }), null);
  assert.equal(newlyPublicGroup(findings, { ...findings, surfaceId: 'b', at: 'two' }), 'scene');
});
