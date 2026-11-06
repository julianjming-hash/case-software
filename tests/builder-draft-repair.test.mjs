// Card 60 PREVIEW-02: a draft saved before the terminal fix is repaired when it loads, and nothing valid is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseDraftTerminals } from '../src/shared/builder-draft-repair.mjs';
import { convertSchema1ToBuilderDocument, validateBuilderDocument } from '../src/shared/builder-document.mjs';
import fixture from '../src/fixtures/synthetic-workshop.case.json' with { type: 'json' };

const schema2 = () => { const doc = convertSchema1ToBuilderDocument(structuredClone(fixture), { metadata_version: 1 }).candidate; for (const surface of doc.surfaces) delete surface.variants; return doc; };
const terminalPath = doc => doc.decisions.flatMap(decision => decision.paths).find(path => path.terminal);
const errorsAt = (doc, field) => validateBuilderDocument(doc, { metadata_version: 1 }, { mode: 'ready' }).errors.filter(issue => issue.at.endsWith(field));

test('[AS-154] PREVIEW-02: a valid draft, as every published snapshot is, comes back as the same object', () => {
  const doc = schema2();
  assert.ok(terminalPath(doc), 'the fixture has a terminal consequence');
  const result = normaliseDraftTerminals(doc);
  assert.equal(result.changed, false);
  assert.equal(result.document, doc);
  for (const value of [null, undefined, {}, { decisions: 'x' }, { decisions: [{ paths: null }] }]) assert.equal(normaliseDraftTerminals(value).document, value);
});

test('[AS-154] PREVIEW-02: a terminal saved without its restore policy gets "snapshot", once', () => {
  const doc = schema2(), path = terminalPath(doc);
  delete path.terminal.restore_policy;
  assert.equal(errorsAt(doc, '/terminal/restore_policy').length, 1);
  const first = normaliseDraftTerminals(doc);
  assert.equal(first.changed, true);
  assert.notEqual(first.document, doc, 'the input is not changed in place');
  assert.equal(terminalPath(doc).terminal.restore_policy, undefined);
  assert.equal(terminalPath(first.document).terminal.restore_policy, 'snapshot');
  assert.deepEqual(errorsAt(first.document, '/terminal/restore_policy'), []);
  const second = normaliseDraftTerminals(first.document);
  assert.equal(second.changed, false);
  assert.equal(second.document, first.document);
});

test('[AS-154] PREVIEW-02: a consequence left with both a terminal and a next stage keeps the one its classification names', () => {
  const doc = schema2(), path = terminalPath(doc), next = doc.beats.find(beat => beat.kind === 'debrief').id;
  // Terminal-unsafe: it resets to its checkpoint, so the next stage goes.
  path.next_beat_id = next; delete path.terminal.restore_policy;
  let repaired = terminalPath(normaliseDraftTerminals(doc).document);
  assert.equal('next_beat_id' in repaired, false);
  assert.equal(repaired.terminal.restore_policy, 'snapshot');
  // Any other classification continues, so the terminal goes.
  path.classification = 'unsafe';
  const result = normaliseDraftTerminals(doc), continued = result.document.decisions.flatMap(decision => decision.paths).find(item => item.id === path.id);
  assert.equal('terminal' in continued, false);
  assert.equal(continued.next_beat_id, next);
  assert.deepEqual(errorsAt(result.document, `/paths/${result.document.decisions.find(d => d.paths.includes(continued)).paths.indexOf(continued)}/terminal`), []);
  assert.equal(normaliseDraftTerminals(result.document).changed, false);
});
