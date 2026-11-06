// Case's one keymap (CASE-249, Julian's rulings of 2026-10-14): the Builder, the Run preview and the live console read
// their keys here, so the same action has the same key everywhere, and a key with no action on a surface does nothing
// there. Single keys never fire while text is being written, a dropdown, menu or dialog is open, or a composition runs;
// on a button Space and Enter keep their native press, and ← → step unless the control uses its own arrows. Chords take ⌘ on a Mac and Ctrl everywhere.
export const CHORD = Object.freeze({ undo: 'Meta+Z Control+Z', save: 'Meta+S Control+S' });

const TYPING = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="listbox"], [role="menu"], [role="dialog"], [aria-modal="true"], dialog, .shared-select-trigger';
const NATIVE = 'button, a[href], summary, [role="button"], [role="radio"], [role="tab"], [role="separator"]';
/** Focus is where text, a choice or a dialog takes its own keys. */
export const typing = target => Boolean(target?.isContentEditable || target?.closest?.(TYPING));
const onControl = target => Boolean(target?.closest?.(NATIVE));
// Controls whose own arrows choose or move (radios, tabs, splitters, toggles). A plain button has no arrow action, so ← →
// still step while a clicked dock button keeps focus (CASE-251).
const ARROWS = '[role="radio"], [role="tab"], [role="separator"], [role="slider"], [aria-pressed], summary';
/** A plain single key: no ⌘/Ctrl/Alt, not held down, not mid-composition, not already handled. */
export const single = event => !(event.defaultPrevented || event.repeat || event.isComposing || event.altKey || event.ctrlKey || event.metaKey);
/** ⌘ on a Mac or Ctrl anywhere, plus one letter; never mid-composition. */
export const chord = (event, letter, { shift = false } = {}) => !event.defaultPrevented && !event.isComposing && !event.altKey && (event.metaKey || event.ctrlKey)
  && Boolean(event.shiftKey) === shift && String(event.key).toLowerCase() === letter;
const openDialog = doc => Boolean(doc?.querySelector?.('dialog[open]'));

/**
 * The facilitator's keys, the same on the live console and the Run preview. Returns an action name or null:
 * 'advance' (Space: press the dock's main action), 'reveal_group' (→ or Enter), 'replay_back', 'replay_forward', 'undo' (press Undo when
 * shown), 'save' (swallowed: nothing to save), 'escape', 'help'. `overlay` pauses the step and advance keys while the
 * case map, the route view, the sheet or a confirmation is open.
 */
export function facilitatorKey(event, { hasMoreGroup = false, replaying = false, canReplayForward = false, canReplayBack = false, overlay = false } = {}) {
  const target = event.target, doc = target?.ownerDocument ?? globalThis.document;
  if (chord(event, 's')) return 'save';
  if (chord(event, 'z')) return typing(target) || openDialog(doc) ? null : 'undo';
  if (event.defaultPrevented || event.repeat || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return null;
  if (typing(target) || openDialog(doc)) return null;
  if (event.key === '?') return 'help'; // the sheet itself is keymap-sheet.mjs, loaded when asked for
  if (event.shiftKey) return null;
  if (event.key === 'Escape') return 'escape';
  if (overlay) return null;
  const arrow = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
  // Space on the route already chosen presses the main action (its reveal), so a keyboard rehearsal is never stuck
  // re-choosing it (round 28 P2-4); Space on any other route still chooses that route.
  if (event.key === ' ' && target?.closest?.('.console-route-pick[aria-checked="true"]')) return 'advance';
  if (arrow ? target?.closest?.(ARROWS) : onControl(target)) return null;
  if (event.key === ' ') return 'advance';
  if (event.key === 'ArrowLeft') return canReplayBack ? 'replay_back' : null;
  // Enter is → (Julian, 2026-10-14): the next step or forward in a replay, never the main action or a route.
  if (event.key !== 'ArrowRight' && event.key !== 'Enter') return null;
  if (replaying) return canReplayForward ? 'replay_forward' : null;
  return hasMoreGroup ? 'reveal_group' : null;
}

/** The Builder's step keys: only on the selected slide tile in the Outline (↑/↓ move between tiles there). */
export function builderTileKey(event) {
  const tile = event.target?.closest?.('.builder-outline-target');
  if (!single(event) || event.shiftKey || !tile || tile.getAttribute('aria-current') !== 'true') return null;
  return event.key === 'ArrowRight' || event.key === ' ' || event.key === 'Enter' ? 'next_step' : event.key === 'ArrowLeft' ? 'previous_step' : null;
}

/** `?` on any surface, outside text and dialogs. */
export const helpKey = event => !event.defaultPrevented && !event.isComposing && !event.ctrlKey && !event.metaKey && !event.altKey && event.key === '?' && !typing(event.target) && !openDialog(event.target?.ownerDocument);

export const node = (doc, tag, text, cls) => { const item = doc.createElement(tag); if (text) item.textContent = text; if (cls) item.className = cls; return item; };
/**
 * An in-page confirmation for a room-ending action (End room, Restart). It opens on Cancel, so a stray Enter or Space
 * only cancels; Tab reaches the red button, which Enter, Space or a click confirms (Julian, 2026-10-14, CASE-251).
 * Returns the open dialog.
 */
export function confirmAction(doc, { title, body, action, onConfirm }) {
  const dialog = node(doc, 'dialog', null, 'case-confirm'), id = `case-confirm-${Math.random().toString(36).slice(2)}`;
  const heading = node(doc, 'h2', title); heading.id = id; dialog.setAttribute('aria-labelledby', id);
  const cancel = node(doc, 'button', 'Cancel', 'btn quiet'), confirm = node(doc, 'button', action, 'btn danger');
  cancel.type = confirm.type = 'button';
  cancel.addEventListener('click', () => dialog.close());
  confirm.addEventListener('click', () => { dialog.close(); onConfirm(); });
  const row = node(doc, 'div', null, 'case-confirm-actions'); row.append(cancel, confirm);
  dialog.append(heading, ...(body ? [node(doc, 'p', body)] : []), row);
  dialog.addEventListener('close', () => dialog.remove());
  doc.body.append(dialog); dialog.showModal(); cancel.focus();
  return dialog;
}
