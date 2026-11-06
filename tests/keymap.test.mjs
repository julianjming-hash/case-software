// CASE-249: the one keymap shared by the Builder, the Run preview and the live console (Julian, 2026-10-14).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { facilitatorKey, builderTileKey, helpKey, chord } from '../src/client/keymap.mjs';
import { KEYMAP } from '../src/client/keymap-sheet.mjs';

const doc = { querySelector: () => null };
const on = (match = () => null, extra = {}) => ({ closest: selector => match(selector), ownerDocument: doc, ...extra });
const key = (name, extra = {}) => ({ key: name, target: on(), ...extra });

test('Space presses the main action; → reveals the next group, or replays forward; ← replays back (CASE-140 reversed for Space)', () => {
  assert.equal(facilitatorKey(key(' ')), 'advance');
  assert.equal(facilitatorKey(key('ArrowRight'), { hasMoreGroup: true }), 'reveal_group');
  assert.equal(facilitatorKey(key('ArrowRight'), { hasMoreGroup: false }), null);
  assert.equal(facilitatorKey(key('ArrowRight'), { hasMoreGroup: true, replaying: true, canReplayForward: true }), 'replay_forward');
  assert.equal(facilitatorKey(key('ArrowLeft'), { canReplayBack: true }), 'replay_back');
  assert.equal(facilitatorKey(key('ArrowLeft'), { canReplayBack: false }), null);
  for (const rejected of ['Home', 'End']) assert.equal(facilitatorKey(key(rejected), { hasMoreGroup: true }), null, `${rejected} is not a facilitator key`);
  // CASE-251 (Julian, 2026-10-14): Enter is →. It reveals the next group or replays forward, never the main action.
  assert.equal(facilitatorKey(key('Enter'), { hasMoreGroup: true }), 'reveal_group');
  assert.equal(facilitatorKey(key('Enter'), { hasMoreGroup: false }), null, 'with no next step Enter does nothing (never the main action or a route)');
  assert.equal(facilitatorKey(key('Enter'), { hasMoreGroup: true, replaying: true, canReplayForward: true }), 'replay_forward');
  assert.equal(facilitatorKey(key('Escape')), 'escape');
  assert.equal(facilitatorKey(key('?', { shiftKey: true })), 'help');
});

test('⌘/Ctrl+Z presses Undo and ⌘/Ctrl+S is swallowed; single keys ignore modifiers, repeats and composition', () => {
  assert.equal(facilitatorKey(key('z', { metaKey: true })), 'undo');
  assert.equal(facilitatorKey(key('Z', { ctrlKey: true })), 'undo');
  assert.equal(facilitatorKey(key('z', { metaKey: true, shiftKey: true })), null);
  assert.equal(facilitatorKey(key('s', { metaKey: true })), 'save');
  assert.equal(facilitatorKey(key('z', { metaKey: true, isComposing: true })), null);
  for (const name of [' ', 'ArrowRight', 'Enter', 'ArrowLeft', 'Escape']) {
    for (const extra of [{ repeat: true }, { altKey: true }, { ctrlKey: true }, { metaKey: true }, { isComposing: true }, { defaultPrevented: true }])
      assert.equal(facilitatorKey(key(name, extra), { hasMoreGroup: true, canReplayBack: true }), null, `${name} ignores ${Object.keys(extra)[0]}`);
  }
  assert.equal(facilitatorKey(key(' ', { shiftKey: true })), null);
});

test('typing guard: text, the answer box, cells, dropdowns, menus and dialogs keep every key; a button keeps Space; overlays pause steps', () => {
  for (const selector of ['input', 'textarea', 'select', '[role="listbox"]', '[role="menu"]', 'dialog', '.shared-select-trigger'])
    for (const name of [' ', 'ArrowRight', 'Enter', 'ArrowLeft', 'Escape', '?'])
      assert.equal(facilitatorKey({ key: name, target: on(s => (s.includes(selector) && s.includes('textarea') ? {} : null)) }, { hasMoreGroup: true, canReplayBack: true }), null, `${name} in ${selector}`);
  assert.equal(facilitatorKey({ key: 'z', metaKey: true, target: on(s => (s.includes('textarea') ? {} : null)) }), null, 'native text undo stays native');
  assert.equal(facilitatorKey({ key: 'x', target: on(() => null, { isContentEditable: true }) }), null);
  const button = on(s => (s.startsWith('button') ? {} : null));
  assert.equal(facilitatorKey({ key: ' ', target: button }), null, 'Space presses the focused button natively');
  assert.equal(facilitatorKey({ key: 'Enter', target: button }, { hasMoreGroup: true }), null, 'Enter presses the focused button natively');
  // CASE-251: a plain button has no arrow action, so ← → still step after a click left focus on it.
  assert.equal(facilitatorKey({ key: 'ArrowRight', target: button }, { hasMoreGroup: true }), 'reveal_group');
  assert.equal(facilitatorKey({ key: 'ArrowLeft', target: button }, { canReplayBack: true }), 'replay_back');
  for (const owner of ['[role="radio"]', '[role="tab"]', '[role="separator"]', '[aria-pressed]'])
    assert.equal(facilitatorKey({ key: 'ArrowRight', target: on(s => (s.startsWith('button') || s.includes(owner) ? {} : null)) }, { hasMoreGroup: true }), null, `${owner} keeps its arrows`);
  assert.equal(facilitatorKey({ key: 'Escape', target: button }), 'escape');
  for (const name of [' ', 'ArrowRight', 'Enter', 'ArrowLeft']) assert.equal(facilitatorKey(key(name), { hasMoreGroup: true, canReplayBack: true, overlay: true }), null, `${name} pauses under an overlay`);
  const withDialog = { key: ' ', target: { closest: () => null, ownerDocument: { querySelector: selector => (selector === 'dialog[open]' ? {} : null) } } };
  assert.equal(facilitatorKey(withDialog), null, 'a confirmation or the sheet is open');
});

test('the Builder steps only on the selected slide tile; ? opens the sheet outside text', () => {
  const tile = current => ({ closest: selector => (selector === '.builder-outline-target' ? { getAttribute: () => String(current) } : null) });
  for (const name of ['ArrowRight', ' ', 'Enter']) assert.equal(builderTileKey({ key: name, target: tile(true) }), 'next_step');
  assert.equal(builderTileKey({ key: 'ArrowLeft', target: tile(true) }), 'previous_step');
  assert.equal(builderTileKey({ key: 'ArrowRight', target: tile(false) }), null, 'another tile is pressed natively');
  assert.equal(builderTileKey({ key: 'ArrowRight', target: on() }), null, 'never while editing a block');
  assert.equal(builderTileKey({ key: 'ArrowRight', target: tile(true), isComposing: true }), null);
  assert.equal(helpKey({ key: '?', shiftKey: true, target: on() }), true);
  assert.equal(helpKey({ key: '?', target: on(s => (s.includes('textarea') ? {} : null)) }), false);
  assert.equal(chord({ key: 's', metaKey: true }, 's'), true);
  assert.equal(chord({ key: 's', ctrlKey: true, altKey: true }, 's'), false);
});

test('the sheet lists every surface\'s keys from the one table, the room keys shared by the console and the preview, and no Home or End', () => {
  assert.ok(KEYMAP.some(([keys, room, builder]) => keys === '?' && room && builder));
  assert.deepEqual(KEYMAP.filter(([keys]) => /Home|End\b/.test(keys)), []);
  assert.deepEqual(KEYMAP.filter(([, room]) => room).map(([keys]) => keys), ['Space', '→ Enter', '←', '⌘Z', '?'], 'the room keys; Escape says per surface what it closes or asks');
});

// Round 28 (CASE-267, critique P2-4): Space on the route already chosen presses the main action (its reveal, armed
// first), so a keyboard rehearsal is never stuck re-choosing it; Space on a route not yet chosen chooses it natively.
test('Space on the chosen route presses the main action; on another route it keeps the route button\'s own press', () => {
  const route = checked => on(selector => selector === '.console-route-pick[aria-checked="true"]' ? (checked ? {} : null) : /button|\[role="radio"\]/.test(selector) ? {} : null);
  assert.equal(facilitatorKey({ key: ' ', target: route(true) }), 'advance');
  assert.equal(facilitatorKey({ key: ' ', target: route(false) }), null);
  assert.equal(facilitatorKey({ key: 'Enter', target: route(true) }, { hasMoreGroup: true }), null, 'Enter stays the button\'s own press');
  assert.equal(facilitatorKey({ key: ' ', target: route(true), repeat: true }), null);
});
