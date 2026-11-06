import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { diffPair, applyChanges, createDraftHistory, bindHistoryKeys } from '../src/client/builder-history.mjs';

// Drafts come from JSON.parse, so objects always have Object.prototype.
const json = fc.letrec(tie => ({ value: fc.oneof({ depthSize: 'small' }, fc.string(), fc.integer(), fc.boolean(), fc.constant(null),
  fc.array(tie('value'), { maxLength: 4 }), fc.dictionary(fc.constantFrom('a', 'b', 'c', 'd'), tie('value'), { maxKeys: 4, noNullPrototype: true })) })).value;

test('[AS-139] pointer changes are an exact, reversible round trip for any JSON pair', () => {
  fc.assert(fc.property(json, json, (before, after) => {
    const changes = diffPair(before, after);
    assert.deepEqual(applyChanges(before, changes, 'after'), after);
    assert.deepEqual(applyChanges(after, changes, 'before'), before);
  }), { numRuns: 400 });
});

// Round 28 (CASE-267): Undo and Redo copy only the containers on a changed path. The input is never changed (a frozen
// pair still round-trips) and what no change touched is the same object, so later checks can stop at identity.
const frozen = value => { if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); } return value; };
test('[AS-139] Undo and Redo never change the pair they start from, and share what no change touched', () => {
  fc.assert(fc.property(json, json, (before, after) => {
    const changes = diffPair(before, after), a = frozen(structuredClone(before)), b = frozen(structuredClone(after));
    assert.deepEqual(applyChanges(a, changes, 'after'), after);
    assert.deepEqual(applyChanges(b, changes, 'before'), before);
  }), { numRuns: 400 });
  const draft = frozen({ document: { blocks: [{ id: 'a', text: 'one' }, { id: 'b', text: 'two' }], beats: [{ id: 'x' }] }, authoringMetadata: { metadata_version: 1 } });
  const typed = { ...draft, document: { ...draft.document, blocks: [draft.document.blocks[0], { id: 'b', text: 'two!' }] } };
  const undone = applyChanges(typed, diffPair(draft, typed), 'before');
  assert.deepEqual(undone, draft);
  assert.equal(undone.document.blocks[0], typed.document.blocks[0], 'an untouched block is shared');
  assert.equal(undone.document.beats, typed.document.beats, 'an untouched collection is shared');
  assert.equal(undone.authoringMetadata, typed.authoringMetadata);
});

const pair = () => ({ document: { title: 'Case', surfaces: [{ id: 's', scene: '' }], notes: '' }, authoringMetadata: { metadata_version: 1 } });
function harness() {
  let clock = 0, current = pair(), messages = [];
  const history = createDraftHistory({ now: () => clock, onChange: state => state.message && messages.push(state.message) });
  const commit = (edit, options) => { const before = current; current = structuredClone(current); edit(current.document); history.record(before, current, options); };
  const tick = ms => { clock += ms; };
  const undo = () => { const result = history.undo(current); if (result.ok) current = result.pair; return result; };
  const redo = () => { const result = history.redo(current); if (result.ok) current = result.pair; return result; };
  return { history, commit, tick, undo, redo, messages, get current() { return current; }, set current(value) { current = value; } };
}

test('[AS-139] text A, a structural change, then text B undo and redo in exact chronological order', () => {
  const h = harness();
  for (const text of ['O', 'On', 'Ons']) { h.commit(doc => { doc.surfaces[0].scene = text; }, { label: 'Scene', coalesceKey: 's:scene' }); h.tick(100); }
  h.commit(doc => { doc.surfaces.push({ id: 't', scene: 'New stage' }); }, { label: 'Add stage' });
  h.commit(doc => { doc.notes = 'Private note'; }, { label: 'Notes', coalesceKey: 'notes' });
  const states = [structuredClone(h.current)];
  assert.equal(h.undo().label, 'Notes'); states.push(structuredClone(h.current)); assert.equal(h.current.document.notes, '');
  assert.equal(h.undo().label, 'Add stage'); states.push(structuredClone(h.current)); assert.equal(h.current.document.surfaces.length, 1);
  assert.equal(h.undo().label, 'Scene'); assert.deepEqual(h.current, pair());
  assert.equal(h.undo().ok, false);
  for (const expected of [...states].reverse()) { h.redo(); assert.deepEqual(h.current, expected); }
  assert.equal(h.redo().ok, false);
});

test('[AS-139] coalescing groups one field\'s typing only; a pause, another field or structure starts a new step', () => {
  const h = harness();
  h.commit(doc => { doc.title = 'Ca'; }, { coalesceKey: 'title' }); h.tick(200);
  h.commit(doc => { doc.title = 'Cas'; }, { coalesceKey: 'title' }); h.tick(5000);
  h.commit(doc => { doc.title = 'Case two'; }, { coalesceKey: 'title' });
  assert.equal(h.history.state().undo, 2);
  h.undo(); assert.equal(h.current.document.title, 'Cas');
  // New editing after Undo clears Redo.
  h.commit(doc => { doc.notes = 'x'; }, { coalesceKey: 'notes' });
  assert.equal(h.redo().ok, false);
});

test('[AS-139] an older step never overwrites a later unrecorded change; refused steps change nothing', () => {
  const h = harness();
  h.commit(doc => { doc.title = 'Recorded'; }, { label: 'Title' });
  // A derived change the history does not own (for example a digest) edits the same value.
  h.current = { ...structuredClone(h.current), document: { ...structuredClone(h.current.document), title: 'Derived' } };
  const before = structuredClone(h.current), result = h.undo();
  assert.equal(result.ok, false); assert.match(result.refused, /later change/);
  assert.deepEqual(h.current, before); assert.equal(h.history.state().undo, 1);
});

test('[AS-139] bounds evict whole oldest steps once-announced; an oversized change restarts history visibly', () => {
  let clock = 0; const messages = [];
  const history = createDraftHistory({ limits: { transactions: 3, bytes: 4096, coalesceMs: 0 }, now: () => clock++, onChange: state => state.message && messages.push(state.message) });
  let current = pair();
  for (let index = 0; index < 6; index++) { const before = current; current = structuredClone(current); current.document.title = `T${index}`; history.record(before, current, { label: `T${index}` }); }
  assert.equal(history.state().undo, 3);
  assert.equal(messages.filter(item => /released/.test(item)).length, 1);
  let result; const seen = [];
  while ((result = history.undo(current)).ok) { current = result.pair; seen.push(current.document.title); }
  assert.deepEqual(seen, ['T4', 'T3', 'T2']);
  const before = current; current = structuredClone(current); current.document.notes = 'x'.repeat(5000);
  assert.equal(history.record(before, current, {}).oversized, true);
  assert.equal(history.state().undo, 0); assert.match(messages.at(-1), /too large to undo/);
  history.boundary('Checkpoint restored. Undo history starts from the restored draft.');
  assert.deepEqual(history.state(), { undo: 0, redo: 0, bytes: 0 });
});

test('[AS-139] a coalesced burst of any shape undoes to exactly its starting state and redoes to its end', () => {
  fc.assert(fc.property(json, fc.array(json, { minLength: 2, maxLength: 5 }), (start, states) => {
    const history = createDraftHistory({ now: () => 0 });
    let current = { document: { field: start } };
    for (const value of states) { const before = current; current = { document: { field: value } }; history.record(before, current, { coalesceKey: 'field' }); }
    const undone = history.undo(current);
    if (same(start, states.at(-1))) return assert.equal(undone.ok, false);
    assert.equal(undone.ok, true); assert.deepEqual(undone.pair, { document: { field: start } });
    assert.deepEqual(history.redo(undone.pair).pair, current);
  }), { numRuns: 300 });
});
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

test('[AS-139] Enter then typing in the same burst stays undoable and never wedges older steps', () => {
  const history = createDraftHistory({ now: () => 0 });
  let current = { document: { title: '', scene: { blocks: [{ type: 'paragraph', runs: [{ text: 'A' }] }] } } };
  const commit = (edit, key) => { const before = current; current = structuredClone(current); edit(current.document); history.record(before, current, { coalesceKey: key }); };
  commit(doc => { doc.title = 'Title'; }, 'title');
  commit(doc => { doc.scene.blocks.push({ type: 'paragraph', runs: [{ text: '' }] }); }, 'scene');
  commit(doc => { doc.scene.blocks[1].runs[0].text = 'L'; }, 'scene');
  const first = history.undo(current); assert.equal(first.ok, true); current = first.pair;
  assert.equal(current.document.scene.blocks.length, 1);
  const second = history.undo(current); assert.equal(second.ok, true);
  assert.equal(second.pair.document.title, '');
});

test('[AS-139] key routing survives a lost compositionend and leaves shortcuts another editor already handled', () => {
  const root = new EventTarget(), calls = [];
  bindHistoryKeys(root, { undo: () => calls.push('undo'), redo: () => calls.push('redo') });
  const key = (extra = {}) => Object.assign(new Event('keydown', { cancelable: true }), { key: 'z', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false }, extra);
  root.dispatchEvent(new Event('compositionstart'));
  root.dispatchEvent(key()); assert.deepEqual(calls, []);
  // The field re-rendered mid-composition: no compositionend arrives, but focus leaves.
  root.dispatchEvent(new Event('focusout'));
  root.dispatchEvent(key()); assert.deepEqual(calls, ['undo']);
  // An inner editor (the format editor's own Undo) handled it before the event bubbled to the root.
  const handled = key(); handled.preventDefault();
  root.dispatchEvent(handled); assert.deepEqual(calls, ['undo']);
  root.dispatchEvent(key({ shiftKey: true })); assert.deepEqual(calls, ['undo', 'redo']);
  // No editor opts out (the dead data-native-undo hook is gone, CASE-249): the Edit menu's Undo goes to the history too.
  const menuUndo = Object.assign(new Event('beforeinput', { cancelable: true }), { inputType: 'historyUndo' });
  root.dispatchEvent(menuUndo); assert.equal(menuUndo.defaultPrevented, true);
  assert.deepEqual(calls, ['undo', 'redo', 'undo']);
});
