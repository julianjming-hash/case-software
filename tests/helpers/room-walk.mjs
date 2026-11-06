// tests/helpers/room-walk.mjs: a deterministic breadth-first walk of the room machine over the mini case
// (the same exploration as scripts/gen-spec.mjs, with fixed ids and a fixed command list so the walk never
// changes when a command is added). Card 37 uses it for the projection golden and the console dock walk.
// `pause` is retired (CASE-255), but a room persisted while paused still exists until M2, so the walk keeps it as the
// legacy persisted state (helpers/legacy-pause.mjs): the explored states, ids and golden stay as they were.
import { initialState, reduce } from '../../src/shared/room-machine.mjs';
import { miniCase } from './mini-case.mjs';
import { canLegacyPause, legacyPausedState } from './legacy-pause.mjs';

export const WALK_AT = '2026-10-01T09:00:00.000Z';
const BASE_COMMANDS = ['start', 'advance', 'lock', 'reopen', 'void_round', 'select_path', 'back_to_review', 'reveal',
  'reset_checkpoint', 'pause', 'resume', 'show_names', 'show_results', 'replay', 'enter_manual', 'manual_marker',
  'resume_online', 'takeover', 'close_joining', 'set_timer', 'end'];

const legacyPause = (state, ev) => ({ state: canLegacyPause(state) && ev.epoch === state.epoch ? legacyPausedState(state, ev.at) : state, effects: [] });

/** A fresh deterministic id source and the mini case with every uuid replaced by one from it. */
export function deterministicCase() {
  let n = 0;
  const id = () => `00000000-0000-7000-8000-${String(++n).padStart(12, '0')}`;
  const map = new Map();
  const swap = (v) => {
    if (typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v)) { if (!map.has(v)) map.set(v, id()); return map.get(v); }
    if (Array.isArray(v)) return v.map(swap);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x)]));
    return v;
  };
  const doc = swap(miniCase().doc);
  doc.surfaces[0].scene = 'Opening context.';
  doc.surfaces[1].scene = 'Decision context.';
  return { doc, id };
}

/**
 * Every reachable state (up to `limit`), in BFS order. `extra(state, base)` may add candidate events
 * (card 37 adds `show_lobby`); `keyExtra(state)` widens the dedup key for those layers.
 * @returns {{ doc, pid, states: object[] }}
 */
export function walkRoom({ extra = () => [], keyExtra = () => null, limit = 5000 } = {}) {
  const { doc, id } = deterministicCase();
  const pid = id();
  const fac = { role: 'facilitator', id: 'fac' };
  const candidates = (state) => {
    const out = [];
    for (const type of BASE_COMMANDS) {
      const base = { type, epoch: state.epoch, actor: fac, at: WALK_AT, roundId: id() };
      if (type === 'select_path') {
        const d = doc.decisions.find((x) => x.id === state.decisionId);
        for (const p of d?.paths ?? []) out.push({ ...base, pathId: p.id });
      } else if (type === 'replay') out.push({ ...base, surfaceId: state.revealed[0]?.surfaceId ?? id() });
      else if (type === 'enter_manual') out.push({ ...base, segmentId: id() });
      else if (type === 'manual_marker') out.push({ ...base, text: 'marker' });
      else if (type === 'show_names' || type === 'show_results') out.push({ ...base, on: false }, { ...base, on: true });
      else if (type === 'close_joining') out.push({ ...base, closed: !state.joiningClosed });
      else if (type === 'set_timer') out.push({ ...base, seconds: 60 });
      else out.push(base);
    }
    out.push(...extra(state, { epoch: state.epoch, actor: fac, at: WALK_AT }));
    if (state.round?.status === 'open') {
      const d = doc.decisions.find((x) => x.id === state.round.decisionId);
      const opt = d.interaction.options.find((o) => !(state.disabledOptions[d.id] || []).includes(o.id));
      out.push({ type: 'vote', epoch: state.epoch, actor: { role: 'participant', id: pid }, at: WALK_AT,
        roundId: state.round.id, clientEventId: id(), responseId: id(), response: { option_id: opt.id } });
    }
    return out;
  };
  const keyOf = (s) => JSON.stringify([s.phase, s.resumePhase, Boolean(s.manual), s.beatId, s.revealed.length > 6 ? 'long' : s.revealed.length,
    s.revealed.at(-1)?.groupsShown ?? null, s.round?.status ?? null, s.exploredTerminal, s.selectedPathId, s.terminalPathId,
    s.flags, Object.keys(s.round?.responses ?? {}).length > 0, s.resultsShown, s.namesShown, s.display.cursor, s.joiningClosed, keyExtra(s)]);
  let start = initialState({ sessionId: id(), joinCode: '7K3QX9', caseDoc: doc });
  start = reduce(start, { type: 'join', epoch: 0, actor: { role: 'participant', id: pid }, at: WALK_AT, displayName: 'P' }).state;
  const seen = new Set([keyOf(start)]);
  const queue = [start], states = [];
  while (queue.length && states.length < limit) {
    const s = queue.shift();
    states.push(s);
    for (const ev of candidates(s)) {
      const { state: t, effects } = ev.type === 'pause' ? legacyPause(s, ev) : reduce(s, ev);
      if (effects.find((e) => e.type === 'receipt')?.receipt === 'rejected' || t === s) continue;
      const k = keyOf(t);
      if (!seen.has(k)) { seen.add(k); queue.push(t); }
    }
  }
  return { doc, pid, states };
}
