import test from 'node:test';
import assert from 'node:assert/strict';
import { publicationSummary } from '../src/client/publication-summary.mjs';
test('publication summary compares shared content, slide structure, questions and case details without private notes', () => {
  const before = { title: 'Case', decisions: [], blocks: [{ id: 'text', text: 'Before' }], compositions: [{ id: 'slide', reading_order: ['text'] }] };
  const after = structuredClone(before); after.blocks[0].text = 'After'; after.title = 'Changed';
  assert.equal(publicationSummary(before, after), '1 slides edited · Case details updated');
  assert.equal(publicationSummary(null, before), 'New case · 1 slides · 0 questions');
  after.compositions = [{ id: 'new', reading_order: [] }]; after.privateNotes = 'Secret';
  assert.equal(publicationSummary(before, after).includes('Secret'), false);
  assert.match(publicationSummary(before, after), /1 slides added · 1 slides removed/);
});
test('publication summary never calls a legacy content edit or routing-setting edit unchanged', () => {
  const before = { beats: [{ id: 'opening', surface_id: 'surface' }], surfaces: [{ id: 'surface', scene: 'Before' }], decisions: [], flags: [] };
  const content = structuredClone(before); content.surfaces[0].scene = 'After';
  assert.equal(publicationSummary(before, content), '1 slides edited');
  const routing = structuredClone(before); routing.flags.push({ id: 'flag', key: 'new_flag' });
  assert.equal(publicationSummary(before, routing), 'Teaching content or settings updated');
  assert.equal(publicationSummary(before, structuredClone(before)), 'No teaching-content changes');
});
