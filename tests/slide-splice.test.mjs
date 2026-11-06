// Splicing slides (Julian, 2026-10-17, I2–I4): deleting a slide joins what led to it to what followed it, and moving
// lifts it out the same way and drops it at a chosen place. Shapes copy Diving Deeper v2's last slides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { healSlideRemoval, planSlideMove, slideExit } from '../src/shared/slide-splice.mjs';

const stage = (id, next, kind = 'surface') => ({ id, kind, title: id.toUpperCase(), surface_id: `v-${id}`, ...(next ? { next_beat_id: next } : {}) });
const question = (id, decisionId) => ({ id, kind: 'decision', title: id.toUpperCase(), surface_id: `v-${id}`, decision_id: decisionId });
const path = (id, next, extra = {}) => ({ id, label: `Branch ${id}`, reveal_surface_id: `r-${id}`, ...(next ? { next_beat_id: next } : {}), ...extra });
/** 33 → 34 → Q35 (one branch p7) → 36 (debrief) → 37: Diving's tail. */
function tail() {
  return { start_beat_id: 's33', beats: [stage('s33', 's34'), stage('s34', 'q35'), question('q35', 'd35'), stage('s36', 's37', 'debrief'), stage('s37')],
    decisions: [{ id: 'd35', paths: [path('p7', 's36', { recommended: true })] }], clarifications: [] };
}
/** Q24 splits: p1 → 25 (recommended), p2 and p3 → r1 → 25. Then 25 → 26. */
function split() {
  return { start_beat_id: 'q24', beats: [question('q24', 'd24'), stage('r1', 's25'), stage('s25', 's26'), stage('s26')],
    decisions: [{ id: 'd24', paths: [path('p1', 's25', { recommended: true }), path('p2', 'r1'), path('p3', 'r1')] }], clarifications: [] };
}
const beat = (doc, id) => doc.beats.find(item => item.id === id);
const branch = (doc, id) => doc.decisions.flatMap(item => item.paths).find(item => item.id === id);
/** Every link names a slide that exists: what the validator requires of the result. */
function linksResolve(doc) {
  const ids = new Set(doc.beats.map(item => item.id));
  assert.ok(ids.has(doc.start_beat_id), 'start resolves');
  for (const item of doc.beats) if (item.next_beat_id !== undefined) assert.ok(ids.has(item.next_beat_id), `${item.id} next resolves`);
  for (const item of doc.decisions.flatMap(decision => decision.paths)) {
    if (item.terminal) assert.ok(ids.has(item.terminal.checkpoint_beat_id), `${item.id} checkpoint resolves`);
    else assert.ok(ids.has(item.next_beat_id), `${item.id} next resolves`);
  }
}
const removed = (doc, id) => ({ ...doc, beats: doc.beats.filter(item => item.id !== id) });

test('the last slide (Diving slide 37) deletes: the slide before it becomes the end', () => {
  const doc = tail(), plan = healSlideRemoval(doc, 's37');
  assert.equal(plan.ok, true, plan.reason);
  assert.equal(beat(plan.document, 's36').next_beat_id, undefined);
  assert.deepEqual(plan.changes, ['“S36” becomes the last slide.']);
  assert.equal(plan.after, null);
  assert.deepEqual(plan.from.map(item => item.beatId), ['s36']);
  linksResolve(removed(plan.document, 's37'));
  assert.equal(beat(doc, 's36').next_beat_id, 's37', 'the input is not changed');
});

test('a debrief reached from a branch (Diving slide 36) deletes: the branch goes on to the next slide', () => {
  const plan = healSlideRemoval(tail(), 's36');
  assert.equal(plan.ok, true, plan.reason);
  assert.equal(branch(plan.document, 'p7').next_beat_id, 's37');
  assert.deepEqual(plan.changes, ['Branch “Branch p7” now goes to “S37”.']);
  linksResolve(removed(plan.document, 's36'));
});

test('a question with one way on deletes; the slide before it goes to what the question led to', () => {
  const plan = healSlideRemoval(tail(), 'q35');
  assert.equal(plan.ok, true, plan.reason);
  assert.equal(beat(plan.document, 's34').next_beat_id, 's36');
});

test('a slide two branches lead to deletes: both branches go on to its next slide', () => {
  const plan = healSlideRemoval(split(), 'r1');
  assert.equal(plan.ok, true, plan.reason);
  assert.equal(branch(plan.document, 'p2').next_beat_id, 's25');
  assert.equal(branch(plan.document, 'p3').next_beat_id, 's25');
  assert.equal(plan.changes.length, 2);
});

test('the first slide deletes and the case starts at the next one', () => {
  const plan = healSlideRemoval(tail(), 's33');
  assert.equal(plan.ok, true);
  assert.equal(plan.document.start_beat_id, 's34');
  assert.deepEqual(plan.changes, ['The case now starts at “S34”.']);
});

test('refusals say why and name the fix', () => {
  assert.equal(healSlideRemoval(split(), 'q24').code, 'splits', 'a question whose branches part');
  assert.match(healSlideRemoval(split(), 'q24').reason, /different slides/);
  const ends = tail(); ends.beats = ends.beats.filter(item => item.id !== 's37'); delete beat(ends, 's36').next_beat_id;
  const redirect = healSlideRemoval(ends, 's36');
  assert.equal(redirect.code, 'redirect', 'a branch leads to a last slide'); assert.equal(redirect.pathId, 'p7');
  const only = { start_beat_id: 'a', beats: [stage('a')], decisions: [], clarifications: [] };
  assert.equal(healSlideRemoval(only, 'a').code, 'only');
  const shared = tail(); shared.beats.push({ ...question('q99', 'd35') });
  assert.equal(healSlideRemoval(shared, 'q35').code, 'shared', 'a question another slide also asks');
});

test('a reset that returns to a deleted slide returns to the next slide instead; a last-slide checkpoint refuses', () => {
  const doc = tail(); doc.decisions[0].paths.push(path('pt', null, { terminal: { checkpoint_beat_id: 's34', debrief_prompt: 'x' } }));
  const plan = healSlideRemoval(doc, 's34');
  assert.equal(plan.ok, true, plan.reason);
  assert.equal(branch(plan.document, 'pt').terminal.checkpoint_beat_id, 'q35');
  assert.ok(plan.changes.includes('Branch “Branch pt” now resets to “Q35”.'));
  doc.decisions[0].paths[1].terminal.checkpoint_beat_id = 's37';
  assert.equal(healSlideRemoval(doc, 's37').code, 'checkpoint');
});

test('a clarification shown only during the deleted slide goes with it; one shown elsewhere stays', () => {
  const doc = tail(); doc.clarifications = [{ id: 'c1', label: 'Eyes', beat_ids: ['s34'], surface_id: 'v-c1' }, { id: 'c2', label: 'Ears', beat_ids: ['s34', 's36'], surface_id: 'v-c2' }];
  const plan = healSlideRemoval(doc, 's34');
  assert.deepEqual(plan.document.clarifications.map(item => [item.id, item.beat_ids]), [['c2', ['s36']]]);
  assert.ok(plan.changes.includes('Clarification “Eyes” goes too.'));
});

test('slideExit names one way on, or why there is none', () => {
  assert.deepEqual(slideExit(tail(), 's34'), { ok: true, to: 'q35' });
  assert.deepEqual(slideExit(tail(), 's37'), { ok: true, to: null });
  assert.deepEqual(slideExit(tail(), 'q35'), { ok: true, to: 's36' });
  assert.equal(slideExit(split(), 'q24').code, 'splits');
});

test('a debrief moves up past a question (refused before): 34 → 36 → Q35 → 37', () => {
  const plan = planSlideMove(tail(), 's36', { beatId: 's34' });
  assert.equal(plan.ok, true, plan.reason);
  const d = plan.document;
  assert.equal(beat(d, 's34').next_beat_id, 's36'); assert.equal(beat(d, 's36').next_beat_id, 'q35'); assert.equal(branch(d, 'p7').next_beat_id, 's37');
  assert.deepEqual(plan.changes, ['“S36” now comes after “S34”.']);
  linksResolve(d);
});

test('a single-branch question moves; all of its branches follow it', () => {
  const plan = planSlideMove(tail(), 'q35', { beatId: 's36' });
  assert.equal(plan.ok, true, plan.reason);
  const d = plan.document;
  assert.equal(beat(d, 's34').next_beat_id, 's36'); assert.equal(beat(d, 's36').next_beat_id, 'q35'); assert.equal(branch(d, 'p7').next_beat_id, 's37');
  linksResolve(d);
});

test('moving to the start, after a branch, and to the end', () => {
  const first = planSlideMove(tail(), 's34', { start: true });
  assert.equal(first.ok, true, first.reason);
  assert.equal(first.document.start_beat_id, 's34'); assert.equal(beat(first.document, 's34').next_beat_id, 's33'); assert.equal(beat(first.document, 's33').next_beat_id, 'q35');
  assert.deepEqual(first.changes, ['“S34” now starts the case.']);
  const onBranch = planSlideMove(tail(), 's34', { pathId: 'p7' });
  assert.equal(onBranch.ok, true, onBranch.reason);
  assert.equal(branch(onBranch.document, 'p7').next_beat_id, 's34'); assert.equal(beat(onBranch.document, 's34').next_beat_id, 's36');
  assert.deepEqual(onBranch.changes, ['“S34” now follows branch “Branch p7”.']);
  const last = planSlideMove(tail(), 's34', { beatId: 's37' });
  assert.equal(last.ok, true, last.reason);
  assert.equal(beat(last.document, 's37').next_beat_id, 's34'); assert.equal(beat(last.document, 's34').next_beat_id, undefined);
  for (const plan of [first, onBranch, last]) linksResolve(plan.document);
});

test('a slide two branches lead to moves, and both branches follow the splice', () => {
  const plan = planSlideMove(split(), 'r1', { beatId: 's26' });
  assert.equal(plan.ok, true, plan.reason);
  assert.equal(branch(plan.document, 'p2').next_beat_id, 's25'); assert.equal(beat(plan.document, 's26').next_beat_id, 'r1');
  linksResolve(plan.document);
});

test('move refusals', () => {
  assert.equal(planSlideMove(split(), 'q24', { beatId: 's26' }).code, 'splits', 'a question whose branches part');
  assert.equal(planSlideMove(split(), 's26', { beatId: 'q24' }).code, 'splits', 'after a question whose branches part: pick a branch');
  assert.equal(planSlideMove(tail(), 's34', { beatId: 's33' }).code, 'here', 'already there');
  assert.equal(planSlideMove(tail(), 's34', { beatId: 's34' }).code, 'here');
  assert.equal(planSlideMove(tail(), 'q35', { beatId: 's37' }).code, 'question-last', 'a question cannot end the case');
  const ends = tail(); ends.beats = ends.beats.filter(item => item.id !== 's37'); delete beat(ends, 's36').next_beat_id;
  assert.equal(planSlideMove(ends, 's36', { beatId: 's33' }).code, 'redirect', 'moving the last slide away would leave its branch going nowhere');
});

test('moves never leave a dangling link, over every slide and every place in both shapes', () => {
  for (const make of [tail, split]) {
    const doc = make(), anchors = [{ start: true }, ...doc.beats.map(item => ({ beatId: item.id })), ...doc.decisions.flatMap(item => item.paths).map(item => ({ pathId: item.id }))];
    for (const self of doc.beats) for (const anchor of anchors) {
      const plan = planSlideMove(doc, self.id, anchor);
      if (!plan.ok) { assert.ok(plan.reason && plan.code, `refusal has words for ${self.id}`); continue; }
      linksResolve(plan.document);
      // The moved slide is still reachable from the start.
      const seen = new Set(); const walk = id => { if (!id || seen.has(id)) return; seen.add(id); const b = beat(plan.document, id);
        if (b.kind === 'decision') for (const p of plan.document.decisions.find(item => item.id === b.decision_id).paths) walk(p.next_beat_id); else walk(b.next_beat_id); };
      walk(plan.document.start_beat_id);
      assert.ok(seen.has(self.id), `${self.id} reachable after a move to ${JSON.stringify(anchor)}`);
    }
  }
});
