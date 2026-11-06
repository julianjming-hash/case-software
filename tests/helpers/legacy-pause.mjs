// A room as the pre-CASE-255 reducer left it after `pause`. Pause for discussion is retired: nothing enters
// `discussion_paused` any more, but a room persisted while paused must still read, hold answers and resume.
// This is that persisted state; it mirrors the retired `pause` case of room-machine.mjs (5fe6576) exactly.
export function legacyPausedState(state, at) {
  if (!canLegacyPause(state)) throw new Error(`a room could not be paused from ${state.phase}`);
  at = new Date(Math.max(Date.parse(at), state.lastAt ? Date.parse(state.lastAt) : Date.parse(at))).toISOString();
  const { caseDoc, ...rest } = state;
  const s = structuredClone(rest);
  s.caseDoc = caseDoc; // shared, never copied, as the reducer does
  s.resumePhase = s.phase;
  s.phase = 'discussion_paused';
  if (s.timer && s.timer.remainingS === null) {
    const elapsed = Math.max(0, (Date.parse(at) - Date.parse(s.timer.startedAt)) / 1000);
    s.timer.remainingS = Math.max(0, Math.round(s.timer.durationS - elapsed));
  }
  s.revision += 1;
  s.lastAt = at;
  return s;
}

// The complete live phase set accepted by 5fe6576. New phases (such as Debrief, introduced after
// Pause retired) cannot acquire a fabricated historical paused state through a negative denylist.
const LEGACY_PAUSABLE_PHASES = new Set(['surface_live', 'responses_open', 'responses_locked',
  'path_selected', 'consequence_revealed', 'terminal_teaching']);
/** Where the retired `pause` was accepted (epoch and actor aside). */
export const canLegacyPause = (state) => LEGACY_PAUSABLE_PHASES.has(state.phase);
