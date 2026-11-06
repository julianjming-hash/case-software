// The `?` sheet of Case's one keymap (CASE-249), loaded only when asked for. Each row: the key, what it does in a room
// (the live console and the Run preview alike), and in the Builder; empty where the key does nothing.
import { node } from './keymap.mjs';
const TILE = 'On the selected slide tile: ';
export const KEYMAP = Object.freeze([
  ['Space', 'Press the main action (a path reveal asks twice)', TILE + 'next step'],
  ['→ Enter', 'Next step; forward while replaying', TILE + 'next step'],
  ['←', 'Replay back', TILE + 'previous step'],
  ['↑ ↓', '', 'Move between slide tiles'],
  ['⌘Z', 'Press Undo when shown', 'Undo'],
  ['⇧⌘Z', '', 'Redo'],
  ['⌘S', '', 'Save the draft'],
  ['Escape', '', 'Close the menu, review or reveal preview; stop editing a block'],
  ['Delete', '', 'Remove the selected block'],
  ['?', 'This list', 'This list'],
]);
const ESCAPE = { console: 'Close the case map, path or Session setup; cancel a press-again confirm', preview: 'Close the phone or notes; else Restart preview' };

/** The sheet for 'builder', 'preview' or 'console': every key and what it does there. */
export function shortcutSheet(doc, surface) {
  const dialog = node(doc, 'dialog', null, 'case-keys'), list = node(doc, 'dl'), close = node(doc, 'button', 'Close', 'btn quiet');
  const mac = /Mac|iP/.test(globalThis.navigator?.platform ?? '');
  for (const [keys, room, builder] of KEYMAP) {
    const does = surface === 'builder' ? builder : keys === 'Escape' ? ESCAPE[surface] : room;
    if (does) list.append(node(doc, 'dt', mac ? keys : keys.replace('⇧⌘Z', 'Ctrl+Y').replace('⌘', 'Ctrl+')), node(doc, 'dd', does));
  }
  dialog.setAttribute('aria-label', 'Keyboard shortcuts'); close.type = 'button'; close.onclick = () => dialog.close();
  dialog.append(node(doc, 'h2', 'Keyboard shortcuts'), list, close); dialog.onclose = () => dialog.remove();
  doc.body.append(dialog); dialog.showModal(); close.focus();
}
