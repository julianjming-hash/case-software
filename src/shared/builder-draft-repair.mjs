// Load-time repair of Builder drafts saved before card 60 (PREVIEW-02). The Builder once made a terminal consequence
// without `restore_policy:'snapshot'`, and its terminal and continue controls merged into the consequence, so a
// consequence could keep both `terminal` and `next_beat_id`. Neither runs. This repairs only those two shapes, is
// idempotent, and returns the same object when there is nothing to repair. A published version always passed the ready
// validator, which refuses both shapes, so a published snapshot is never changed; the Builder applies this to its own
// draft only.
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = value => Array.isArray(value) ? value : [];

/** Returns `{ document, changed }`; `document` is a repaired copy, or the input itself when nothing needed repair. */
export function normaliseDraftTerminals(document) {
  const needs = path => record(path) && record(path.terminal) && (path.terminal.restore_policy === undefined || Object.hasOwn(path, 'next_beat_id'));
  if (!record(document) || !list(document.decisions).some(decision => list(decision?.paths).some(needs))) return { document, changed: false };
  const next = structuredClone(document);
  for (const decision of next.decisions) for (const path of list(decision?.paths)) {
    if (!needs(path)) continue;
    // Both a terminal and a next stage: the classification says which the author meant, as the validator reads it.
    if (Object.hasOwn(path, 'next_beat_id')) {
      if (path.classification === 'terminal-unsafe') delete path.next_beat_id;
      else { delete path.terminal; continue; }
    }
    if (path.terminal.restore_policy === undefined) path.terminal.restore_policy = 'snapshot';
  }
  return { document: next, changed: true };
}
