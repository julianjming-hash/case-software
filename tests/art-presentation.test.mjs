// CASE-274: the released Diving topology must not lose its branches in presentation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScene } from '../src/shared/mosaic-geometry.mjs';
import { presentationArt } from '../src/shared/art-presentation.mjs';
import { divingArt } from './helpers/diving-art.mjs';
test('Diving cover and full detail retain every branching group without mutating the published descriptor', () => {
  const before = JSON.stringify(divingArt);
  assert.equal(buildScene(divingArt, { validateOnly: true }).problems.length, 3);
  for (const full of [false,true]) {
    const shown = presentationArt(divingArt, { full });
    const scene = buildScene(shown, { validateOnly: true });
    assert.deepEqual(scene.problems, []);
    assert.equal(scene.bands.filter(b => b.kind === 'rejoin').length, 3);
    assert.equal(shown.decisions.reduce((n,d) => n + d.strands.length, 0), 5);
    if (full) assert.equal(shown.summarised, false);
  }
  assert.equal(JSON.stringify(divingArt), before);
});
test('healthy published artwork stays on its original descriptor and unsupported renderers are untouched', () => {
  const simple = { ...divingArt, stops: 2, decisions: [], summarised: false };
  assert.equal(presentationArt(simple), simple);
  const unknown = { ...simple, renderer: 999 };
  assert.equal(presentationArt(unknown), unknown);
});
