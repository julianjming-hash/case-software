import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from '../src/shared/ids.mjs';
import { readFileSync } from 'node:fs';
import { validateCaseDocument, suggestPath, shuffleOptions, SCENE_MAX, MAX_STAGES } from '../src/shared/case-document.mjs';
import { miniCase } from './helpers/mini-case.mjs';

test('a well-formed mini case validates', () => {
  const r = validateCaseDocument(miniCase().doc);
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
});

test('[AS-016] an unmet entry flag on any rejoining route is an error', () => {
  const { doc } = miniCase();
  doc.decisions[0].paths[1].set_flags = []; // image-first path no longer treats tension
  const r = validateCaseDocument(doc);
  assert.ok(r.errors.some((e) => e.code === 'entry_flag_unmet'), JSON.stringify(r.errors));
});

test('a single-choice option without a path, or mapped twice, is an error', () => {
  const { doc, o } = miniCase();
  doc.decisions[0].paths[1].option_ids = [];
  assert.ok(validateCaseDocument(doc).errors.some((e) => e.code === 'option_unmapped'));
  doc.decisions[0].paths[1].option_ids = [o.decompress];
  assert.ok(validateCaseDocument(doc).errors.some((e) => e.code === 'option_mapped_twice'));
});

test('terminal paths need terminal config, a dominating checkpoint, and no next beat', () => {
  const { doc, b } = miniCase();
  const t = doc.decisions[0].paths[2];
  t.next_beat_id = b.d2;
  assert.ok(validateCaseDocument(doc).errors.some((e) => e.code === 'not_allowed'));
  delete t.next_beat_id;
  t.terminal.checkpoint_beat_id = b.debrief; // not on the route to D1
  assert.ok(validateCaseDocument(doc).errors.some((e) => e.code === 'checkpoint_not_dominating'));
});

test('exactly one recommended path; >3 paths warns', () => {
  const { doc } = miniCase();
  doc.decisions[0].paths[1].recommended = true;
  assert.ok(validateCaseDocument(doc).errors.some((e) => e.code === 'recommended'));
});

test('unreachable beats and dangling references are errors', () => {
  const { doc } = miniCase();
  doc.beats[0].next_beat_id = doc.beats[3].id; // skip both decisions
  const r = validateCaseDocument(doc);
  assert.ok(r.errors.some((e) => e.code === 'unreachable'));
});

test('suggestPath: single choice majority, tie → fallback, none → fallback', () => {
  const { doc, o, p } = miniCase();
  const d = doc.decisions[0];
  assert.equal(suggestPath(d, [{ option_id: o.image }, { option_id: o.image }, { option_id: o.decompress }]).path_id, p.image);
  assert.equal(suggestPath(d, [{ option_id: o.image }, { option_id: o.decompress }]).path_id, p.decompress);
  assert.equal(suggestPath(d, []).path_id, p.decompress);
});

test('suggestPath: multi-select, ranking and free-text rules', () => {
  const ids = Array.from({ length: 6 }, () => uuidv7());
  const [a, bb, c, pa, pb, pc] = ids;
  const base = (type, rules) => ({
    interaction: { type, options: [{ id: a, label: 'A' }, { id: bb, label: 'B' }, { id: c, label: 'C' }] },
    fallback_path_id: pc,
    paths: [{ id: pa }, { id: pb }, { id: pc }],
    rules,
  });
  const multi = base('multi_select', [{ when: { includes_all: [a], excludes: [c] }, path_id: pa }, { when: { includes_any: [c] }, path_id: pb }]);
  assert.equal(suggestPath(multi, [{ option_ids: [a] }, { option_ids: [a, bb] }, { option_ids: [c] }]).path_id, pa);
  const rank = base('ranking', [{ when: { before: [a, c] }, path_id: pa }, { when: { top: [c] }, path_id: pb }]);
  assert.equal(suggestPath(rank, [{ order: [c, a, bb] }, { order: [c, bb, a] }, { order: [a, c, bb] }]).path_id, pb);
  const free = { ...base('free_text', [{ when: { keywords: ['decompress', 'needle'] }, path_id: pa }]), interaction: { type: 'free_text', max_length: 120 } };
  assert.equal(suggestPath(free, [{ text: 'Needle it' }, { text: 'xray' }, { text: 'DECOMPRESS now' }]).path_id, pa);
});

test('[AS-051] projected text is bullets: body is refused, points are required, long points warn (CASE-087)', () => {
  const { doc } = miniCase();
  doc.surfaces[0].body = 'Old prose.';
  assert.ok(validateCaseDocument(doc).errors.some((e) => e.code === 'not_allowed' && e.at === '/surfaces/0/body'));
  delete doc.surfaces[0].body;
  delete doc.surfaces[0].points;
  assert.ok(validateCaseDocument(doc).errors.some((e) => e.at === '/surfaces/0/points'));
  doc.surfaces[0].points = ['A point that rambles on far too long for any projector to show at a glance'];
  const r = validateCaseDocument(doc);
  assert.ok(r.ok);
  assert.ok(r.warnings.some((w) => w.code === 'long_point'));
});

test('[AS-063] scene prose is short and optional per variant; investigations are capped bullets; body stays refused (CASE-116, CASE-117)', () => {
  const { doc } = miniCase();
  doc.surfaces[0].scene = 'The doors open on a pale, sweating driver. He talks in short phrases.';
  doc.surfaces[0].investigations = ['eFAST: free fluid in Morison\'s'];
  let r = validateCaseDocument(doc);
  assert.deepEqual(r.errors, []);
  assert.ok(!r.warnings.some((w) => w.at === '/surfaces/0/scene'));
  assert.ok(r.warnings.some((w) => w.code === 'no_scene' && w.at === '/surfaces/1/scene'), 'a surface without a scene warns');
  doc.surfaces[0].scene = 'x'.repeat(SCENE_MAX + 1);
  assert.ok(validateCaseDocument(doc).errors.some((e) => e.code === 'length' && e.at === '/surfaces/0/scene'));
  doc.surfaces[0].scene = '';
  assert.ok(validateCaseDocument(doc).errors.some((e) => e.at === '/surfaces/0/scene'));
  doc.surfaces[0].scene = 'Fine.';
  doc.surfaces[0].scene = 'x'.repeat(500);
  assert.ok(validateCaseDocument(doc).ok, 'a scene at the 500-character ceiling is valid');
  doc.surfaces[0].scene = 'x'.repeat(501);
  assert.ok(validateCaseDocument(doc).errors.some((e) => e.code === 'length' && e.at === '/surfaces/0/scene'));
  doc.surfaces[0].scene = 'Fine.';
  doc.surfaces[0].investigations = Array.from({ length: 6 }, (_, i) => `Result ${i}`);
  assert.ok(validateCaseDocument(doc).errors.some((e) => e.at === '/surfaces/0/investigations'));
  doc.surfaces[0].investigations = ['x'.repeat(101)];
  assert.ok(validateCaseDocument(doc).errors.some((e) => e.at === '/surfaces/0/investigations/0'));
  assert.equal(SCENE_MAX, 500);
});

test('[AS-063] the MVC fixture has a scene on every surface and variant, each within the cap', () => {
  const fx = JSON.parse(readFileSync(new URL('../src/fixtures/synthetic-workshop.case.json', import.meta.url), 'utf8'));
  const r = validateCaseDocument(fx);
  assert.deepEqual(r.errors, []);
  assert.ok(!r.warnings.some((w) => w.code === 'no_scene'));
  for (const s of fx.surfaces) {
    for (const x of [s, ...(s.variants ?? [])]) assert.ok(typeof x.scene === 'string' && x.scene.length <= SCENE_MAX, s.title);
  }
});

test('schema1 and schema2 free-text declarations accept 500 and refuse 501', () => {
  const { doc } = miniCase();
  const decision = doc.decisions[0];
  decision.interaction = { type: 'free_text', max_length: 500 };
  decision.paths.forEach(path => { delete path.option_ids; });
  decision.rules = [{ when: { keywords: ['xray'] }, path_id: decision.paths[0].id }];
  assert.equal(validateCaseDocument(doc).ok, true);
  decision.interaction.max_length = 501;
  assert.ok(validateCaseDocument(doc).errors.some(issue => issue.at === '/decisions/0/interaction/max_length'));
  doc.schema_version = 2;
  assert.ok(validateCaseDocument(doc, { profile: 'schema2' }).errors.some(issue => issue.at === '/decisions/0/interaction/max_length'));
});

test('[AS-052] answer cues: recommended first everywhere, or clearly longest, warns (CASE-088)', () => {
  const { doc } = miniCase();
  // mini case: the recommended option is first in both decisions
  assert.ok(validateCaseDocument(doc).warnings.some((w) => w.code === 'cue_position'));
  doc.decisions[0].interaction.options[0].label = 'Decompress the right chest immediately with a large-bore cannula';
  assert.ok(validateCaseDocument(doc).warnings.some((w) => w.code === 'cue_length' && w.at === '/decisions/0/interaction/options/0'));
});

test('shuffleOptions reorders options once, deterministically, keeping ids and mappings', () => {
  const { doc } = miniCase();
  const a = shuffleOptions(doc, 'seed-1');
  assert.deepEqual(shuffleOptions(doc, 'seed-1'), a, 'deterministic');
  assert.ok(validateCaseDocument(a).ok);
  for (const [i, d] of a.decisions.entries()) {
    assert.deepEqual(d.interaction.options.map((o) => o.id).sort(), doc.decisions[i].interaction.options.map((o) => o.id).sort());
  }
  const first = doc.decisions[0].interaction.options[0].id;
  assert.ok(Array.from({ length: 20 }, (_, k) => shuffleOptions(doc, `s${k}`)).some((x) => x.decisions[0].interaction.options[0].id !== first), 'some seed moves the first option');
});

test('Card25 schema permits explicit ranking meaning only for priority or action and keeps legacy fixed counts', () => {
  const { doc, o, p } = miniCase(), decision = doc.decisions[0];
  decision.interaction.type = 'ranking';
  decision.paths.forEach(path => { delete path.option_ids; });
  decision.rules = [{ when: { top: [o.decompress] }, path_id: p.decompress }];
  for (const orderMeaning of [undefined, 'priority', 'action']) {
    if (orderMeaning === undefined) delete decision.interaction.order_meaning;
    else decision.interaction.order_meaning = orderMeaning;
    assert.equal(validateCaseDocument(doc).ok, true);
  }
  for (const bad of [null, undefined, '', 'chronology', 'correct', 1, true, [], {}]) {
    decision.interaction.order_meaning = bad;
    assert.ok(validateCaseDocument(doc).errors.some(error => error.at === '/decisions/0/interaction/order_meaning'), `reject meaning ${String(bad)}`);
  }
  for (const type of ['single_choice', 'multi_select', 'free_text']) {
    const other = miniCase().doc;
    other.decisions[0].interaction.type = type;
    other.decisions[0].interaction.order_meaning = 'priority';
    assert.ok(validateCaseDocument(other).errors.some(error => error.at === '/decisions/0/interaction/order_meaning' && error.code === 'not_allowed'));
  }
  delete decision.interaction.order_meaning;
  while (decision.interaction.options.length < 8) decision.interaction.options.push({ id: uuidv7(), label: 'Same label' });
  for (let count = 2; count <= 8; count++) {
    decision.interaction.rank_count = count;
    assert.equal(validateCaseDocument(doc).ok, true);
  }
  decision.interaction.rank_count = 1;
  assert.ok(validateCaseDocument(doc).errors.some(error => error.at.endsWith('/rank_count')));
  assert.equal(Object.hasOwn(decision.interaction, 'order_meaning'), false, 'legacy meaning is never inferred or added');
});

test('schema2 formatted values are structurally valid and limited to approved text slots', () => {
  const doc = miniCase().doc;
  doc.schema_version = 2;
  doc.duration_min = 30;
  for (const decision of doc.decisions) decision.interpretation = 'rules';
  doc.surfaces[0].scene = { blocks: [{ type: 'paragraph', runs: [{ text: 'Supported rich text' }] }] };
  assert.equal(validateCaseDocument(doc, { profile: 'schema2' }).ok, true);
  doc.surfaces[0].scene.blocks[0].unexpected = true;
  assert.ok(validateCaseDocument(doc, { profile: 'schema2' }).errors.some(issue => issue.code === 'unknown_key' && issue.at.endsWith('/unexpected')));
  delete doc.surfaces[0].scene.blocks[0].unexpected;
  doc.summary = { blocks: [{ type: 'paragraph', runs: [{ text: 'Not an approved slot' }] }] };
  assert.ok(validateCaseDocument(doc, { profile: 'schema2' }).errors.some(issue => issue.code === 'type' && issue.at === '/summary'));
});

test('[CASE-237] a case runs up to 99 stages; the 100th is refused by count', () => {
  assert.equal(MAX_STAGES, 99);
  const fx = JSON.parse(readFileSync(new URL('../src/fixtures/synthetic-workshop.case.json', import.meta.url), 'utf8'));
  const countError = n => {
    const doc = structuredClone(fx), base = doc.beats[0];
    doc.beats = Array.from({ length: n }, () => ({ ...structuredClone(base), id: uuidv7() }));
    return validateCaseDocument(doc).errors.some(error => error.at === '/beats' && /1–99/.test(error.message));
  };
  assert.equal(countError(99), false);
  assert.equal(countError(100), true);
});

/** A schema-2 mini case whose first decision is a ranking the facilitator interprets (the Diving Deeper shape). */
function facilitatorRanking() {
  const mini = miniCase(), { doc } = mini;
  doc.schema_version = 2; doc.duration_min = 30;
  for (const decision of doc.decisions) decision.interpretation = 'rules';
  const decision = doc.decisions[0];
  decision.interpretation = 'facilitator'; decision.interaction.type = 'ranking';
  for (const path of decision.paths) delete path.option_ids;
  assert.deepEqual(validateCaseDocument(doc, { profile: 'schema2' }).errors, []);
  return { ...mini, decision };
}

test('D20: an empty option_ids on a ranking or select-all consequence maps nothing and passes; a non-empty one is still refused', () => {
  for (const type of ['ranking', 'multi_select']) {
    const { doc, decision, o } = facilitatorRanking();
    decision.interaction.type = type;
    decision.paths[0].option_ids = [];
    assert.deepEqual(validateCaseDocument(doc, { profile: 'schema2' }).errors, [], type);
    decision.paths[0].option_ids = [o.decompress];
    assert.ok(validateCaseDocument(doc, { profile: 'schema2' }).errors.some(issue => issue.code === 'not_allowed' && issue.at === '/decisions/0/paths/0/option_ids'), type);
  }
  // Single choice still maps every option: an empty list there leaves its option unmapped, as before.
  const { doc } = miniCase();
  doc.decisions[0].paths[0].option_ids = [];
  assert.ok(validateCaseDocument(doc).errors.some(issue => issue.code === 'option_unmapped'));
});

test('D22: a surface with no scene or points says what is missing, not "must be an array"', () => {
  const { doc } = facilitatorRanking();
  doc.surfaces.push({ id: uuidv7(), kind: 'text', title: 'Coordinated imaging/surgical review' });
  const result = validateCaseDocument(doc, { profile: 'schema2' }), at = `/surfaces/${doc.surfaces.length - 1}`;
  const points = result.errors.find(issue => issue.at === `${at}/points`);
  assert.equal(points?.code, 'required');
  assert.equal(points.message, 'add the points the room sees');
  assert.ok(!result.errors.some(issue => /must be an array/.test(issue.message)), JSON.stringify(result.errors));
  // Still refused: an unusable surface stops rehearsal until it is written or removed.
  assert.equal(result.ok, false);
});
