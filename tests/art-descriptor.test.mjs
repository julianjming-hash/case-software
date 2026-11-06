// Card 28: the numbers-only art descriptor (CASE-164). Pure module tests; the network-payload privacy
// test lives in tests/worker/art-delivery.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { uuidv7 } from '../src/shared/ids.mjs';
import { validateCaseDocument } from '../src/shared/case-document.mjs';
import {
  describeCase, structureKey, validArtDescriptor, sanitizeArt, sameStructure, withSolution,
  artReadiness, ART_SUMMARISED_WARNING, ART_UNAVAILABLE_WARNING, ART_LABEL, ART_RENDERERS, artPrivacyViolations,
} from '../src/shared/art-descriptor.mjs';
import { miniCase } from './helpers/mini-case.mjs';

const FIXTURE = JSON.parse(readFileSync(new URL('../src/fixtures/synthetic-workshop.case.json', import.meta.url), 'utf8'));
const MVC = { v: 1, stops: 5, decisions: [
  { stop: 1, strands: [{ rejoin: 2 }, { rejoin: 2 }], resets: 1, ends: 0 },
  { stop: 2, strands: [{ rejoin: 3 }, { rejoin: 3 }], resets: 0, ends: 0 },
  { stop: 3, strands: [{ rejoin: 4 }, { rejoin: 4 }], resets: 0, ends: 0 },
] };
const valid = (doc) => assert.deepEqual(validateCaseDocument(doc).errors, []);

test('describeCase on the MVC fixture: three decisions of two strands, one reset at the first', () => {
  assert.deepEqual(describeCase(FIXTURE), MVC);
  assert.equal(structureKey(MVC), 'b1|5|1:2.2:1:0,2:3.3:0:0,3:4.4:0:0');
});

test('describeCase on the mini case: a strand and a terminal reset, then one strand', () => {
  const { doc } = miniCase();
  valid(doc);
  assert.deepEqual(describeCase(doc), { v: 1, stops: 4, decisions: [
    { stop: 1, strands: [{ rejoin: 2 }], resets: 1, ends: 0 },
    { stop: 2, strands: [{ rejoin: 3 }], resets: 0, ends: 0 },
  ] });
});

test('a skip: a route that passes a later decision rejoins further downstream', () => {
  const { doc, b } = miniCase();
  doc.decisions[0].paths[1].next_beat_id = b.debrief;   // image first skips the reassessment
  valid(doc);
  assert.deepEqual(describeCase(doc).decisions[0], { stop: 1, strands: [{ rejoin: 3 }], resets: 1, ends: 0 });
});

test('a reset: a non-terminal route that returns upstream counts as a reset', () => {
  const { doc, b } = miniCase();
  doc.decisions[1].paths[1].next_beat_id = b.d1;         // fluids returns to the first decision
  assert.deepEqual(describeCase(doc).decisions[1], { stop: 2, strands: [], resets: 1, ends: 0 });
});

test('a dead end: a route that finishes off the default route is an end', () => {
  const { doc } = miniCase();
  const surface = uuidv7(), beat = uuidv7();
  doc.surfaces.push({ id: surface, kind: 'debrief', title: 'Different ending', points: ['Different ending.'] });
  doc.beats.push({ id: beat, kind: 'debrief', title: 'Different ending', surface_id: surface });
  doc.decisions[1].paths[1].next_beat_id = beat;
  valid(doc);
  assert.deepEqual(describeCase(doc).decisions[1], { stop: 2, strands: [], resets: 0, ends: 1 });
});

test('text-only edits leave the descriptor unchanged; a path edit changes it', () => {
  const doc = structuredClone(FIXTURE);
  doc.title = 'Renamed'; doc.summary = 'A different summary.';
  for (const d of doc.decisions) { d.prompt = 'Changed prompt'; for (const p of d.paths) { p.label = 'Relabelled'; p.rationale = 'New rationale.'; p.cue = 'New cue.'; } }
  for (const b of doc.beats) b.title = 'Retitled';
  for (const s of doc.surfaces) s.title = 'Resurfaced';
  valid(doc);
  assert.deepEqual(describeCase(doc), MVC);
  const moved = structuredClone(FIXTURE);
  const d2Beat = moved.beats.find((b) => b.kind === 'decision' && b.decision_id === moved.decisions[1].id);
  const last = moved.beats.find((b) => b.kind === 'debrief');
  moved.decisions[0].paths.find((p) => !p.recommended && !p.terminal).next_beat_id = last.id;   // retarget one alternative
  assert.notEqual(d2Beat.id, last.id);
  assert.notDeepEqual(describeCase(moved), MVC);
  assert.notEqual(structureKey(describeCase(moved)), structureKey(MVC));
});

test('the descriptor carries no strings and no id-shaped tokens', () => {
  for (const desc of [MVC, describeCase(miniCase().doc), withSolution(MVC, { attempt: 3, summarised: false })]) {
    assert.deepEqual(artPrivacyViolations(desc), []);
    const text = JSON.stringify(desc);
    assert.doesNotMatch(text, /"[^"]*"\s*:\s*"/, 'no string values');
    assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}/i, 'no uuid fragments');
  }
  assert.ok(artPrivacyViolations({ ...MVC, label: 'x' }).length > 0);
  assert.ok(artPrivacyViolations({ ...MVC, decisions: [{ ...MVC.decisions[0], id: uuidv7() }] }).length > 0);
});

test('only a strictly true recommended flag marks the default route, and the validator refuses any other value', () => {
  for (const value of ['no', 1, 'true']) {
    const doc = structuredClone(FIXTURE);
    doc.decisions[0].paths[2].recommended = value;
    assert.deepEqual(describeCase(doc), MVC, JSON.stringify(value));
    assert.ok(validateCaseDocument(doc).errors.some((e) => e.code === 'recommended_type'), JSON.stringify(value));
  }
  const ok = structuredClone(FIXTURE); ok.decisions[0].paths[2].recommended = false;
  valid(ok);
});

test('a route back into its own decision is a reset, not a strand', () => {
  const { doc, b } = miniCase();
  doc.decisions[1].paths[1].next_beat_id = b.d2;
  assert.deepEqual(describeCase(doc).decisions[1], { stop: 2, strands: [], resets: 1, ends: 0 });
});

test('the descriptor records the renderer that solved it; unknown renderers are refused', () => {
  const art = withSolution(MVC, { attempt: 0, summarised: false });
  assert.equal(art.renderer, ART_RENDERERS.at(-1));
  for (const bad of [{ ...art, renderer: 0 }, { ...art, renderer: 99 }, { ...art, renderer: '1' }]) assert.equal(validArtDescriptor(bad), false);
  const { renderer: _r, ...missing } = art;
  assert.equal(validArtDescriptor(missing), false);
});

test('validArtDescriptor accepts only the exact numbers-only shape', () => {
  const art = withSolution(MVC, { attempt: 0, summarised: false });
  assert.equal(validArtDescriptor(art), true);
  assert.equal(validArtDescriptor(MVC), false, 'attempt and summarised are required');
  for (const bad of [
    { ...art, extra: 1 }, { ...art, v: 2 }, { ...art, attempt: 16 }, { ...art, attempt: -1 }, { ...art, attempt: 1.5 },
    { ...art, summarised: 'no' }, { ...art, stops: '5' }, { ...art, decisions: {} },
    { ...art, decisions: [{ ...art.decisions[0], label: 'x' }] },
    { ...art, decisions: [{ ...art.decisions[0], strands: [{ rejoin: 1 }] }] },       // rejoin must be downstream
    { ...art, decisions: [{ ...art.decisions[0], strands: [{ rejoin: 9 }] }] },       // beyond the route
    { ...art, decisions: [art.decisions[1], art.decisions[0]] },                      // stops strictly increase
    { ...art, decisions: [{ ...art.decisions[0], resets: 'one' }] },
    null, [], 'x',
  ]) assert.equal(validArtDescriptor(bad), false, JSON.stringify(bad));
});

test('sanitizeArt rebuilds a fresh copy of a valid descriptor and refuses anything else', () => {
  const art = withSolution(MVC, { attempt: 2, summarised: true });
  const copy = sanitizeArt(art);
  assert.deepEqual(copy, art);
  assert.notEqual(copy, art);
  assert.equal(sanitizeArt({ ...art, label: 'Title' }), null);
  assert.equal(sanitizeArt(undefined), null);
});

test('sameStructure ignores the solver fields and compares structure exactly', () => {
  assert.equal(sameStructure(withSolution(MVC, { attempt: 5, summarised: true }), MVC), true);
  const tampered = structuredClone(MVC); tampered.decisions[0].resets = 0;
  assert.equal(sameStructure(tampered, MVC), false);
  assert.equal(sameStructure({ ...MVC, stops: 6 }, MVC), false);
});

test('readiness warns, without blocking, only for a summarised cover, with the exact card text', () => {
  assert.equal(ART_SUMMARISED_WARNING, 'This case is too large for the cover to show every route. The cover summarises each decision; case detail shows the full braid.');
  assert.deepEqual(artReadiness(withSolution(MVC, { attempt: 0, summarised: false })), []);
  assert.deepEqual(artReadiness(withSolution(MVC, { attempt: 0, summarised: true })),
    [{ code: 'art_summarised', at: '', message: ART_SUMMARISED_WARNING, blocking: false }]);
  assert.equal(ART_LABEL, 'Abstract branching mosaic artwork');
  assert.deepEqual(artReadiness(withSolution(MVC, { attempt: 0, summarised: true }), { unavailable: true }).map((r) => [r.code, r.message, r.blocking]),
    [['art_summarised', ART_SUMMARISED_WARNING, false], ['art_unavailable', ART_UNAVAILABLE_WARNING, false]]);
});
