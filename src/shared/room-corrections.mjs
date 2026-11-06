// Finite teaching-control inverses. Private answers live in authority evidence, never this chain.
import { isUuidV7 } from './ids.mjs';
export const MAX_TEACHING_ACTIONS = 64;
export const MAX_TEACHING_BYTES = 64 * 1024;
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
export function recordTeachingAction(before, after, event, kind) {
  if (!isUuidV7(event.clientEventId)) return after;
  const context = before.revealed.at(-1);
  const actions = before.teachingActions ?? [];
  const selection = kind === 'reveal' && actions.at(-1)?.kind === 'selection' &&
    actions.at(-1).decisionId === before.decisionId && actions.at(-1).roundId === (before.round?.id ?? null) ? actions.at(-1) : null;
  const action = {
    id: event.clientEventId, kind, mode: before.manual ? 'manual' : 'online',
    decisionId: before.decisionId, roundId: before.round?.id ?? null,
    contextIndex: before.revealed.length - 1, contextOccurrenceId: context?.occurrenceId ?? null,
    groupsShown: context?.groupsShown ?? 0,
    ...(kind === 'reveal' && before.beatId !== after.beatId ? { continuation: { beatId: after.beatId,
      occurrenceId: after.revealed.at(-1)?.occurrenceId, checkpoint: before.checkpoints[after.beatId] ?? null } } : {}),
    ...(selection ? { selectionId: selection.id } : {}),
    control: { beatId: before.beatId, nextBeatId: before.nextBeatId, terminalPathId: before.terminalPathId,
      ...(kind === 'reveal' ? { flags: [...before.flags], checkpoint: before.checkpoints[before.beatId] ?? null } : {}) },
    ...(kind === 'lock' ? { remainingS: before.timer ? Math.max(0, before.timer.remainingS ??
      Math.round(before.timer.durationS - (Date.parse(event.at) - Date.parse(before.timer.startedAt)) / 1000)) : 0,
      ...(before.timer ? { totalS: before.timer.totalS ?? before.timer.durationS } : {}) } : {}),
  };
  const next = [...actions, action];
  let pruned = before.undoPruned ?? false;
  while (next.length > MAX_TEACHING_ACTIONS || bytes(next) > MAX_TEACHING_BYTES) { next.shift(); pruned = true; }
  return { ...after, interpretationVersion: 1, teachingActions: next, undoPruned: pruned };
}

export function undoDescriptor(state) {
  if (state.phase === 'ended') return { available: false, reason: 'room_ended' };
  if (state.phase === 'discussion_paused') return { available: false, reason: 'resume_first' };
  if (state.round?.closing) return { available: false, reason: 'closing' }; // CASE-319: nothing to undo until the lock lands
  const action = state.teachingActions?.at(-1);
  if (!action) return { available: false, reason: state.undoPruned ? 'undo_limit_reached' : 'no_teaching_action' };
  if (action.mode !== (state.manual ? 'manual' : 'online')) return { available: false, reason: 'mode_changed' };
  const revealContext = action.kind === 'reveal' && ['consequence_revealed', 'terminal_teaching'].includes(state.phase);
  const continued = action.kind === 'reveal' && state.phase === 'surface_live' && action.continuation?.beatId === state.beatId && action.continuation?.occurrenceId === state.revealed.at(-1)?.occurrenceId;
  if (!continued && (action.control.beatId !== state.beatId || (!revealContext && action.decisionId !== state.decisionId)))
    return { available: false, reason: 'teaching_context_changed' };
  if (action.kind === 'selection' && state.phase !== 'path_selected') return { available: false, reason: 'selection_context_changed' };
  return { available: true, targetEventId: action.id, kind: action.kind };
}

export function consumeTeachingAction(state, action) {
  return (state.teachingActions ?? []).filter(value => value.id !== action.id && value.id !== action.selectionId);
}

/** Latest live publication identity, even during replay/overlays; never private inverses. */
export function publicationDescriptor(state) {
  return entryPublication(state.revealed.at(-1));
}

/** Same bounded public metadata for one chronological entry. */
export function entryPublication(entry) {
  if (!isUuidV7(entry?.occurrenceId)) return undefined;
  return { v: 1, occurrenceId: entry.occurrenceId,
    ...(isUuidV7(entry.checkpointOf) ? { checkpointOf: entry.checkpointOf } : {}),
    ...(isUuidV7(entry.correctionOf) ? { correctionOf: entry.correctionOf,
      restoresOccurrenceId: isUuidV7(entry.restoresOccurrenceId) ? entry.restoresOccurrenceId : null } : {}) };
}
