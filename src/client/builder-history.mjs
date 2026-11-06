// Unified draft history (card 58, BWR16). One chronological stack of reversible transactions over the canonical
// paired draft, recorded at the commit boundary as pointer-level changes, never whole-pair snapshots. Undo and Redo
// produce new local generations; they never restore server revisions, receipts, approvals or room state.
export const HISTORY_LIMITS = Object.freeze({ transactions: 200, bytes: 8 * 1024 * 1024, coalesceMs: 1000 });

const record = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const same = (left, right) => left === right || JSON.stringify(left) === JSON.stringify(right);

/** Minimal changes from `before` to `after`. Arrays of unequal length are replaced whole: bounded, never guessed. */
export function diffPair(before, after, path = [], out = []) {
  // One walk: records and equal-length arrays recurse, and only leaves are compared, so a keystroke on a draft at the
  // caps no longer stringifies every level of the pair (re-audit round 12, BWR13).
  if (before === after) return out;
  if (record(before) && record(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const had = Object.hasOwn(before, key), has = Object.hasOwn(after, key);
      if (had && has) diffPair(before[key], after[key], [...path, key], out);
      else out.push({ path: [...path, key], had, has, before: had ? structuredClone(before[key]) : undefined, after: has ? structuredClone(after[key]) : undefined });
    }
  } else if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    before.forEach((item, index) => diffPair(item, after[index], [...path, index], out));
  } else if (!same(before, after)) out.push({ path, had: true, has: true, before: structuredClone(before), after: structuredClone(after) });
  return out;
}

const read = (value, path) => { let at = value; for (const key of path) { if (at === null || typeof at !== 'object' || !Object.hasOwn(at, key)) return { found: false }; at = at[key]; } return { found: true, value: at }; };

/** Apply `changes` toward `side` ('before' to undo, 'after' to redo) on a copy. Refuses if the draft diverged. */
export function applyChanges(pair, changes, side) {
  const from = side === 'before' ? 'after' : 'before', present = side === 'before' ? 'has' : 'had', target = side === 'before' ? 'had' : 'has';
  // Chronology guard: every touched value must still be exactly what this transaction left; otherwise a later edit
  // (or an unrecorded derived change) owns it and an older transaction may not overwrite it.
  for (const change of changes) {
    const current = read(pair, change.path);
    if (current.found !== change[present] || (current.found && !same(current.value, change[from]))) return null;
  }
  // Only the containers on each changed path are copied (a later path re-copies a copy, never the original); the rest
  // is shared with `pair`, which is never changed in place (round 28: no full copy of a draft at the caps per key).
  const own = (holder, key) => { const value = holder[key]; return value && typeof value === 'object' ? holder[key] = Array.isArray(value) ? [...value] : { ...value } : value; };
  let next = own({ pair }, 'pair');
  for (const change of [...changes].reverse()) {
    if (!change.path.length) { next = structuredClone(change[side]); continue; }
    const parent = change.path.slice(0, -1).reduce(own, next), key = change.path.at(-1);
    if (change[target]) parent[key] = structuredClone(change[side]);
    else if (Array.isArray(parent)) parent.splice(key, 1); else delete parent[key];
  }
  return next;
}

const sizeOf = changes => new TextEncoder().encode(JSON.stringify(changes)).byteLength;

/**
 * Mount-local history. `record` is called by the commit boundary with the exact before/after canonical pairs.
 * `coalesceKey` groups ordinary typing in one field; anything else (structure, paste, format) is its own entry. `where`
 * is the selection the change was made in, returned by Undo/Redo so the editor can show what changed.
 */
export function createDraftHistory({ limits = HISTORY_LIMITS, now = () => Date.now(), onChange = () => {} } = {}) {
  let undo = [], redo = [], bytes = 0, shortened = false, sequence = 0;
  const notify = message => onChange({ canUndo: undo.length > 0, canRedo: redo.length > 0, undoLabel: undo.at(-1)?.label ?? null, redoLabel: redo.at(-1)?.label ?? null, message });
  const trim = () => {
    let evicted = false;
    // Evict only whole oldest transactions; the newest action is never dropped silently.
    while (undo.length > 1 && (undo.length > limits.transactions || bytes > limits.bytes)) { bytes -= undo.shift().bytes; evicted = true; }
    if (evicted && !shortened) { shortened = true; return 'Older undo steps were released to stay within the history limit.'; }
    return null;
  };
  return {
    record(before, after, { label = 'Edit', coalesceKey = null, where = null } = {}) {
      const changes = diffPair(before, after);
      if (!changes.length) return { recorded: false };
      const size = sizeOf(changes), top = undo.at(-1), at = now();
      if (size > limits.bytes) { undo = []; redo = []; bytes = 0; notify('This change is too large to undo. Undo history starts again from here.'); return { recorded: false, oversized: true }; }
      // New editing after Undo clears Redo; the bound covers retained change data in both stacks.
      for (const entry of redo) bytes -= entry.bytes;
      redo = [];
      // A burst is recomputed from its starting state, never patched path by path: nested or overlapping paths
      // (Enter grows an array, then typing edits inside it) would otherwise leave changes that cannot be undone.
      const base = coalesceKey && top?.coalesceKey === coalesceKey && at - top.at <= limits.coalesceMs ? applyChanges(before, top.changes, 'before') : null;
      if (base) {
        bytes -= top.bytes;
        top.changes = diffPair(base, after); top.bytes = sizeOf(top.changes); top.at = at;
        if (top.changes.length) bytes += top.bytes; else undo.pop();
      } else {
        undo.push({ id: ++sequence, label, coalesceKey, changes, bytes: size, at, where }); bytes += size;
      }
      notify(trim());
      return { recorded: true };
    },
    /** Returns the pair to commit as a new dirty generation, or a refusal when a later change owns the target. */
    undo(current) { return step(undo, redo, current, 'before', 'Undo'); },
    redo(current) { return step(redo, undo, current, 'after', 'Redo'); },
    /** Explicit restore, transfer or conflict replacement: a new root, announced, never a disguised edit. */
    boundary(reason) { undo = []; redo = []; bytes = 0; shortened = false; notify(reason); },
    destroy() { undo = []; redo = []; bytes = 0; },
    state: () => ({ undo: undo.length, redo: redo.length, bytes }),
  };
  function step(source, target, current, side, verb) {
    const entry = source.at(-1);
    if (!entry) return { ok: false };
    const pair = applyChanges(current, entry.changes, side);
    if (!pair) return { ok: false, refused: `${verb} unavailable: a later change already edited this content.` };
    source.pop(); target.push(entry);
    notify(`${verb}: ${entry.label}`);
    return { ok: true, pair, label: entry.label, where: entry.where ?? null };
  }
}

/**
 * Route Undo/Redo inside `root` to the unified history: keyboard shortcuts and the browser's own historyUndo/
 * historyRedo input events (Edit menu, context menu). During an IME composition both are swallowed without acting:
 * the browser's native undo would otherwise edit the field outside the history (G09 spike finding, 2026-10-11).
 */
export function bindHistoryKeys(root, { undo, redo }) {
  let composing = false;
  // Leaving the field also ends composition, so a compositionend lost to a re-render cannot disable Undo for good.
  const onComposition = event => { composing = event.type === 'compositionstart'; };
  const onKey = event => {
    // A nested editor that already handled the shortcut (for example the format editor's own Undo) keeps it.
    if (event.defaultPrevented || !(event.metaKey || event.ctrlKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    const action = key === 'z' ? (event.shiftKey ? redo : undo) : key === 'y' && event.ctrlKey && !event.metaKey ? redo : null;
    if (!action) return;
    event.preventDefault();
    if (!composing && !event.isComposing) action();
  };
  const onBeforeInput = event => {
    if (event.defaultPrevented || (event.inputType !== 'historyUndo' && event.inputType !== 'historyRedo')) return;
    event.preventDefault();
    if (!composing) (event.inputType === 'historyUndo' ? undo : redo)();
  };
  const listeners = [['compositionstart', onComposition, true], ['compositionend', onComposition, true], ['focusout', onComposition, true], ['keydown', onKey], ['beforeinput', onBeforeInput]];
  for (const [type, listener, capture] of listeners) root.addEventListener(type, listener, capture);
  return () => { for (const [type, listener, capture] of listeners) root.removeEventListener(type, listener, capture); };
}
