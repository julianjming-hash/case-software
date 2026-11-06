import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateTeachingPair, exportTeachingPair } from '../scripts/teaching-case.mjs';
import { createBuilderCopyCandidate, createBuilderTransferExport, inspectBuilderTransfer } from '../src/shared/builder-transfer.mjs';
import { Rehearsal } from '../src/client/preview-rehearsal.mjs';
import { project, recoveryDescriptor } from '../src/shared/room-machine.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';

const read = async name => JSON.parse(await readFile(new URL(`../tests/fixtures/synthetic/sensor-authoring-${name}.json`, import.meta.url), 'utf8'));
const document = await read('document'), metadata = await read('metadata');

test('native teaching pair rejects unsupported fields and source corruption', async () => {
  assert.equal((await validateTeachingPair(document, metadata)).ok, true);
  const bad = structuredClone(document); bad.decisions[0].interaction.exact_selection_count = 3;
  assert.equal((await validateTeachingPair(bad, metadata)).ok, false);
  const corrupted = structuredClone(metadata); corrupted.sources[0].text += 'changed';
  assert.equal((await exportTeachingPair(document, corrupted)).ok, false);
});

test('native teaching export preserves every private/source field and supported copy remaps references', async () => {
  const result = await exportTeachingPair(document, metadata);
  assert.equal(result.ok, true); assert.equal(result.semanticExact, true);
  const delivered = await inspectBuilderTransfer(await read('transfer'), {mode:'ready',acknowledgeRedactions:true});
  assert.equal(delivered.ok,true);
  assert.deepEqual(delivered.candidate.document,document,'saved transfer must match the editable document');
  assert.deepEqual(delivered.candidate.authoring_metadata,metadata,'saved transfer must match paired metadata');
  assert.equal(result.exported.envelope.transfer_version, 2);
  assert.deepEqual(result.inspected.candidate.document, document);
  assert.deepEqual(result.inspected.candidate.authoring_metadata, metadata);
  assert.deepEqual(result.exported.preview.excluded, ['/authoring_metadata/lineage']);
  const copied = await createBuilderCopyCandidate(result.inspected.candidate);
  assert.equal(copied.ok, true);
  assert.notEqual(copied.candidate.document.start_beat_id, document.start_beat_id);
  assert.equal((await validateTeachingPair(copied.candidate.document, copied.candidate.authoring_metadata)).ok, true);
  const stripped = await createBuilderTransferExport({document, metadata});
  assert.equal(stripped.ok, true);
  assert.ok(stripped.preview.excluded.includes('/authoring_metadata'));
  assert.ok(stripped.preview.excluded.some(path => path.endsWith('/notes')));
});

function routes(beatId, choices = [], seen = []) {
  assert.ok(!seen.includes(beatId), 'unexpected cycle in teaching graph');
  const beat = document.beats.find(b => b.id === beatId); assert.ok(beat);
  const trail = [...seen, beatId];
  if (beat.kind === 'decision') {
    const decision = document.decisions.find(d => d.id === beat.decision_id);
    return decision.paths.flatMap(path => routes(path.next_beat_id, [...choices, {decisionId:decision.id, pathId:path.id}], trail));
  }
  return beat.next_beat_id ? routes(beat.next_beat_id, choices, trail) : [{choices, trail}];
}

// Hand-computed (round 8). Core prefix: severity 2 × first treatment 3 × level of care 3 × results 3 × course 2 ×
// airway 3 = 324; the handover's two core paths end at the debrief (648). The extension path continues: four ways to the
// ventilator (bagged slowly, spotted early, or shock then exhalation or pressor) × ventilator 3 × rate 3 = 36, so
// 324 × 36 = 11 664. Total 648 + 11 664 = 12 312.
// The case sets no flags, so what the extension does cannot depend on the route that reached the handover. The replay
// therefore covers every core route (648), every core prefix into the extension once (324), and every extension variant
// after one prefix (36): every path, every prefix and every extension route, 648 + 323 + 36 = 1007 replays.
test('every asthma path replays (12312 routes) with private/future content withheld and occurrence-bound recovery', () => {
  const all = routes(document.start_beat_id), advanced = document.beats.find(b => b.title === '38:55 · SET');
  assert.equal(all.length, 12312);
  assert.equal(all.filter(route => !route.trail.includes(advanced.id)).length, 648);
  assert.deepEqual(document.decisions.flatMap(d => d.paths.flatMap(p => [...(p.set_flags ?? []), ...(p.clear_flags ?? [])])), [], 'no flags: the extension is route-independent');
  const handover = document.decisions.find(d => d.prompt === 'Set measuremeiy on flj0. Controllj1 set flj3 controllj4 valj5.');
  const prefix = route => JSON.stringify(route.choices.slice(0, route.choices.findIndex(c => c.decisionId === handover.id)));
  const extension = all.filter(route => route.trail.includes(advanced.id)), first = prefix(extension[0]), prefixes = new Set([first]);
  const replay = [...all.filter(route => !route.trail.includes(advanced.id)), ...extension.filter(route => prefix(route) === first),
    ...extension.filter(route => { const k = prefix(route); if (prefixes.has(k)) return false; prefixes.add(k); return true; })];
  assert.equal(replay.length, 1007);
  const secrets = [...document.surfaces.map(s => s.notes), ...document.decisions.flatMap(d => d.paths.flatMap(p => [p.cue, p.rationale]))].filter(s => s?.length > 60);
  const blockById = new Map(document.blocks.map(b => [b.id, b]));
  let confirmations = 0, replayed = 0;
  for (const route of replay) {
    const r = new Rehearsal(document); let choiceIndex = 0;
    assert.equal(r.command('start'), true);
    const seenCore = new Set();
    for (let count = 0; count < 250; count++) {
      const state = r.state;
      const beat = document.beats.find(b => b.id === state.beatId);
      if (["01a18713-a1ff-708d-a142-938cc45c52df","01a18a6d-06b9-7758-a43a-a467ed2877c0","01a18a6d-06be-75e9-aba6-b82d7260de4d","01a18a6d-06c3-7429-9fbc-00036a92a1ba"].includes(beat.id)) seenCore.add(beat.id);
      if (beat.id === advanced.id) assert.equal(seenCore.size, 0, 'the extension runs before the core debrief, which runs once at the end');
      for (const role of ['display', 'participant']) {
        const view = project(state, role, null), serialized = JSON.stringify(view);
        for (const secret of secrets) assert.ok(!serialized.includes(JSON.stringify(secret).slice(1, -1)), `${role} private leak`);
        const publicSurface = role === 'display' ? view.surface : view.liveSurface;
        const slide = publicSurface?.slide;
        assert.ok(slide, `${role} must expose the expected live slide for reveal checks`);
        if (slide) {
          const entry = state.revealed.at(-1);
          const owner = entry.pathId ? {kind:'path',id:entry.pathId} : {kind:'beat',id:state.beatId};
          const composition = document.compositions.find(c => c.owner.kind === owner.kind && c.owner.id === owner.id);
          assert.ok(composition, 'current occurrence must have a composition');
          const released = new Set(composition.steps.slice(0,entry.groupsShown).flatMap(step => step.block_ids));
          for (const block of slide.blocks) {
            assert.ok(released.has(block.id), `${role} received an unrevealed block`);
            const expected = structuredClone(blockById.get(block.id));
            if (expected.type === 'question') delete expected.decision_id; // public projection intentionally withholds authoring binding
            // An image reaches the room as a media handle, never its private workspace asset id; this replay has no room media.
            if (expected.type === 'image') { assert.equal('asset_id' in block, false, 'asset id withheld'); delete expected.asset_id; expected.media = null; }
            assert.deepEqual(block, expected);
          }
        }
      }
      if (state.phase === 'responses_open') {
        const selected = route.choices[choiceIndex++]; assert.equal(state.decisionId, selected.decisionId);
        assert.equal(r.command('lock'), true);
        assert.equal(r.command('select_path', {pathId:selected.pathId}), true);
        if (r.state.resultsShown) assert.equal(r.command('show_results', {on:false, expectRevision:undefined}), true, r.reason);
        assert.equal(r.command('reveal'), true);
        continue;
      }
      if (r.command('advance')) continue;
      if (r.reason === 'recovery_required') {
        const recovery = recoveryDescriptor(r.state); assert.ok(recovery && !recovery.confirmed);
        assert.equal(r.command('confirm_recovery', {occurrenceId:uuidv7(),confirmed:true}), false);
        assert.equal(r.reason, 'stale_recovery_occurrence');
        assert.equal(r.command('confirm_recovery', {occurrenceId:recovery.occurrenceId,confirmed:true}), true);
        confirmations++; continue;
      }
      assert.equal(r.reason, 'no_next_beat');
      assert.equal(choiceIndex, route.choices.length);
      assert.equal(seenCore.size, 4, 'every route ends with the whole core debrief');
      replayed++; break;
    }
    r.close();
  }
  assert.equal(replayed, 1007); assert.ok(confirmations > 0);
});
