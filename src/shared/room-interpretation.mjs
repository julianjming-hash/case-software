// Versioned IDs-only interpretation shared by later audience-specific read models.
// It never guesses a consequence from a path label, surface ID, timestamp or first match.
import { isUuidV7 } from './ids.mjs';
export function traceSpine(entries) {
  const occurrences = new Map(), gaps = [];
  let spine = [];
  for (const entry of entries) {
    if (!isUuidV7(entry.occurrenceId) || occurrences.has(entry.occurrenceId)) {
      gaps.push({ kind: 'missing_or_duplicate_occurrence' }); continue;
    }
    occurrences.set(entry.occurrenceId, entry);
    const restore = entry.clarificationReturnOf ?? (entry.correctionOf ? entry.restoresOccurrenceId : entry.checkpointOf);
    if (restore) {
      const index = spine.findLastIndex(item => item.occurrenceId === restore);
      if (index < 0) gaps.push({ kind: 'missing_restore_context', occurrenceId: entry.occurrenceId });
      else spine = spine.slice(0, index);
    } else if (entry.correctionOf) gaps.push({ kind: 'missing_restore_context', occurrenceId: entry.occurrenceId });
    spine.push(entry);
  }
  return { occurrences, gaps, spine };
}
export function interpretRoomTrace(state) {
  const entries = state.revealed ?? [];
  const { occurrences, gaps, spine } = traceSpine(entries);
  const active = new Set(spine.map(entry => entry.occurrenceId));
  const allRounds = [...(state.rounds ?? []), ...(state.round ? [state.round] : [])];
  const replaced = new Set(allRounds.map(round => round.seedSourceRoundId).filter(Boolean));
  const resolutions = allRounds.map(round => {
    const occurrence = occurrences.get(round.consequenceOccurrenceId);
    if (round.status === 'resolved' && !occurrence) gaps.push({ kind: 'missing_round_occurrence', roundId: round.id });
    return { roundId: round.id, decisionId: round.decisionId, roundNo: round.no,
      status: replaced.has(round.id) ? 'replaced' : round.status,
      ...(round.seedSourceRoundId ? { seedSourceRoundId: round.seedSourceRoundId } : {}),
      occurrenceId: occurrence?.occurrenceId ?? null,
      retained: Boolean(occurrence && active.has(occurrence.occurrenceId)),
      ...(occurrence ? { variant: occurrence.variant, groupsShown: occurrence.groupsShown } : {}) };
  });
  const manualResolutions = entries.filter(entry => entry.manual && ['consequence', 'terminal'].includes(entry.kind) && !entry.clarificationReturnOf).map(entry => {
    if (!entry.decisionId) gaps.push({ kind: 'missing_manual_decision', occurrenceId: entry.occurrenceId ?? null });
    return { decisionId: entry.decisionId ?? null, occurrenceId: entry.occurrenceId ?? null,
      retained: active.has(entry.occurrenceId), variant: entry.variant, groupsShown: entry.groupsShown,
      kind: 'manual', roundId: null };
  });
  return { v: 1, complete: gaps.length === 0, gaps,
    spine: spine.map(entry => entry.occurrenceId),
    detours: entries.filter(entry => entry.occurrenceId && !active.has(entry.occurrenceId)).map(entry => entry.occurrenceId),
    resolutions, manualResolutions };
}
