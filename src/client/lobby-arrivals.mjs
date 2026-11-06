/** Anonymous lobby deltas; no participant identifiers or inferred identity matching. */
export function arrivalFeedback(previous, next, { reducedMotion = false } = {}) {
  if (!previous || previous.sessionId !== next.sessionId || previous.epoch !== next.epoch
    || previous.phase !== 'waiting' || next.phase !== 'waiting') return null;
  const before = previous.arrivalCount, after = next.arrivalCount;
  if (!Number.isSafeInteger(before) || !Number.isSafeInteger(after) || before < 0 || after > 300 || after <= before) return null;
  const count = after - before;
  const oldRows = previous.names, newRows = next.names;
  // Exact prefix plus the expected size proves appended rows without inventing identities.
  // A removal, rename, incomplete roster or coalesced ambiguity gets a generic cue instead.
  const appended = Array.isArray(oldRows) && Array.isArray(newRows) && newRows.length === oldRows.length + count
    && oldRows.every((row, index) => row.name === newRows[index].name && row.avatarId === newRows[index].avatarId);
  const indices = appended && !reducedMotion
    ? Array.from({ length: Math.max(0, Math.min(newRows.length, 12) - oldRows.length) }, (_, i) => oldRows.length + i) : [];
  return { count, indices, overflow: count - indices.length };
}
