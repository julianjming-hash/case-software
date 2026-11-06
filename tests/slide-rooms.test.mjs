import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertSchema1ToBuilderDocument } from '../src/shared/builder-document.mjs';
import { convertToSlideDocument } from '../src/shared/slide-legacy.mjs';
import { validateSlideParts } from '../src/shared/slide-document.mjs';
import { validateRuntimeDocument } from '../src/shared/runtime-document.mjs';
import { presentationNav } from '../src/client/presentation-nav.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
import fixture from '../src/fixtures/synthetic-workshop.case.json' with { type: 'json' };

function slideCase() {
  const converted = convertSchema1ToBuilderDocument(structuredClone(fixture), { metadata_version: 1 }).candidate;
  for (const surface of converted.surfaces) delete surface.variants;
  return convertToSlideDocument(converted, { metadata_version: 1 }, { createId: uuidv7 }).candidate.document;
}

test('[AS-151] runtime admits a slide case only with the injected slide validator; without it, schema 3 fails closed', () => {
  const document = slideCase();
  assert.equal(validateRuntimeDocument(document).ok, false);
  assert.equal(validateRuntimeDocument(document, { validateSlides: validateSlideParts }).ok, true);
  const broken = structuredClone(document);
  broken.compositions[0].placements[0].w = 13;
  assert.equal(validateRuntimeDocument(broken, { validateSlides: validateSlideParts }).ok, false, 'an invalid slide is still refused');
});

test('[AS-151] the console names a slide step press as Reveal next step', () => {
  const view = { timeline: [{ title: 'Arrival' }], actions: ['advance'], presentation: { nextGroup: 'step' }, phase: 'surface_live' };
  assert.equal(presentationNav(view).nextActionLabel, 'Reveal next step');
  assert.equal(presentationNav({ ...view, presentation: { nextGroup: 'findings' } }).nextActionLabel, 'Reveal findings');
});

test('[AS-151] a composition owner (same id as its stage) never shadows the stage for source traces, in any key order', async () => {
  const { validateBuilderProvenancePaths } = await import('../src/shared/builder-provenance.mjs');
  const beatId = uuidv7();
  const owner = { id: uuidv7(), owner: { kind: 'beat', id: beatId }, reading_order: [], steps: [], placements: [] };
  const metadata = { metadata_version: 1, provenance: [{ entity_id: beatId, field: 'title' }] };
  for (const document of [{ schema_version: 3, beats: [{ id: beatId, title: 'Arrival' }], compositions: [owner] },
    { schema_version: 3, compositions: [owner], beats: [{ id: beatId, title: 'Arrival' }] }])
    assert.deepEqual(validateBuilderProvenancePaths(document, metadata), [], 'the stage, not the owner, resolves the trace');
});
