// Run preview engine (preview overhaul slice 3, CASE-226). The real room machine in memory with simulated learners who
// join and vote through its own `join`/`vote` events. Every accepted command is logged, so the run can be replayed:
// Jump to stage restarts and drives the reducer along the route (history and Undo stay exact), and an edit rebuilds the
// run from the newest draft by replaying the log. Memory-only: never instantiate ConsoleManualRoom, and nothing here
// reaches a room, storage or the network.
import { initialState, reduce, project, facilitatorActions, recoveryDescriptor, FENCEABLE } from '../shared/room-machine.mjs';
import { uuidv7 } from '../shared/ids.mjs';
import { AVATAR_SHAPES, AVATAR_COLORS, customAvatarId } from '../shared/participant.mjs';
import { Rehearsal } from './preview-rehearsal.mjs';

const NAMES = ['Ari', 'Bea', 'Cal', 'Dev', 'Eli', 'Fen', 'Gia', 'Hal', 'Isa', 'Jo', 'Kit', 'Lu'];
export const MAX_LEARNERS = NAMES.length;
const SEARCH_BUDGET = 400;
// At a decision on the way to a target, the replay prefers the authored routes a teacher would take first.
const ROUTE_ORDER = ['sound', 'defensible', 'context-dependent', 'discussion-prompt', 'unsafe', 'terminal-unsafe'];

/** A seeded generator, so a replay's simulated answers are the answers the run first gave. */
const random = seed => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const shuffle = (list, next) => { const out = [...list]; for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; } return out; };

/**
 * One simulated answer for a decision. `lean` is an option id most learners favour (the route a jump takes), or null
 * for an even spread; disabled options are never chosen. Null when no valid answer exists (as on a real phone).
 */
export function simulatedResponse(decision, { lean = null, disabled = [], next = Math.random, index = 0 } = {}) {
  const it = decision.interaction, ids = (it.options ?? []).map(option => option.id).filter(id => !disabled.includes(id));
  if (it.type === 'free_text') return { text: `Sample answer ${index + 1}` };
  if (!ids.length) return null;
  const pick = () => lean && ids.includes(lean) && next() < .7 ? lean : ids[Math.floor(next() * ids.length)];
  if (it.type === 'single_choice') return { option_id: pick() };
  if (it.type === 'multi_select') { const first = pick(); return { option_ids: [first, ...shuffle(ids.filter(id => id !== first), next).slice(0, Math.floor(next() * 2))] }; }
  if (it.type === 'ranking') {
    const need = it.rank_count ?? ids.length;
    if (need > ids.length) return null;
    const first = pick(); return { order: [first, ...shuffle(ids.filter(id => id !== first), next)].slice(0, need) };
  }
  return null;
}

/** Options a phone cannot choose: disabled ones and those leading only to an explored terminal route. */
function unavailableOptions(state, decision) {
  const explored = new Set(state.exploredTerminal ?? []);
  const closed = (decision.paths ?? []).filter(path => explored.has(path.id)).flatMap(path => path.option_ids ?? []);
  return [...(state.disabledOptions?.[decision.id] ?? []), ...closed];
}

/** Where a run is, for keeping the author in place across an edit. */
export const positionOf = state => !state || state.phase === 'lobby' ? null : { beatId: state.beatId, pathId: state.revealed.at(-1)?.pathId ?? null, phase: state.phase };
const samePosition = (a, b) => (a?.beatId ?? null) === (b?.beatId ?? null) && (a?.pathId ?? null) === (b?.pathId ?? null) && (a?.phase ?? null) === (b?.phase ?? null);

export class PreviewRoom extends Rehearsal {
  /**
   * `media` is the room's image map (room-machine sanitizeRoomMedia), keyed by asset id (D28): the Builder's own images
   * under handles of the preview's own, so each shows once its step is revealed, as in a room. Set it before a rebuild.
   */
  constructor(doc, { mode = 'online', learners = 4, media = null } = {}) {
    super(null, mode);
    this.doc = doc; this.log = []; this.seed = 1; this.media = media;
    this.learners = NAMES.slice(0, Math.max(0, Math.min(MAX_LEARNERS, learners))).map((name, i) => ({ id: uuidv7(), name, avatarId: customAvatarId(AVATAR_SHAPES[(i * 5) % AVATAR_SHAPES.length].id, AVATAR_COLORS[(i * 3) % AVATAR_COLORS.length].id) }));
    this.restart();
  }

  /** Back to the lobby with the simulated learners joined, and an empty log. */
  restart() { this.log = []; this.reset(); }

  /** A fresh room with the learners joined, at `at` (a replay joins them when the run first began). */
  reset(at = new Date().toISOString()) {
    if (!this.doc) return;
    this.routes.clear(); this.rounds = new Map(); this.reason = null;
    this.state = initialState({ sessionId: uuidv7(), caseDoc: this.doc, media: this.media });
    for (const learner of this.learners) this.apply({ kind: 'join', learnerId: learner.id, at }, false);
  }

  /** The projection a role sees: 'display' for the projector, 'participant' with a learner id for a phone. */
  view(role = 'facilitator', learnerId = null) {
    if (!this.state) return null;
    // Presence is a projection input in the room (never reducer state): every simulated learner is connected.
    return project(this.state, role, learnerId, role === 'participant' ? {} : { present: new Set(this.learners.map(learner => learner.id)) });
  }

  /** Facilitator command, as the console sends it. */
  command(type, payload = {}) {
    if (!this.state) return false;
    const entry = { kind: 'command', type, clientEventId: uuidv7(), roundId: uuidv7(), payload: { ...payload } };
    delete entry.payload.expectRevision; // re-fenced against the state it applies to, so a replay fences correctly
    if (!this.apply(entry)) return false;
    if (type === 'start' && this.mode === 'manual') return this.command('enter_manual', { segmentId: uuidv7() });
    return true;
  }

  /** One learner's answer to the open round: from a phone driven by hand, or the simulator. */
  vote(learnerId, response) {
    if (!this.state?.round || !response) return false;
    return this.apply({ kind: 'vote', learnerId, roundId: this.state.round.id, clientEventId: uuidv7(), responseId: uuidv7(), response });
  }

  /** Every learner who has not answered the open round answers now; `lean` favours one option. */
  simulateVotes({ lean = null } = {}) {
    const round = this.state?.round, decision = round && this.doc.decisions.find(item => item.id === round.decisionId);
    if (!decision || this.state.phase !== 'responses_open') return 0;
    const next = random(this.seed++ * 7919), disabled = unavailableOptions(this.state, decision);
    let count = 0;
    this.learners.forEach((learner, index) => { if (!round.responses[learner.id] && this.vote(learner.id, simulatedResponse(decision, { lean, disabled, next, index }))) count++; });
    return count;
  }

  /** Apply one log entry to the current state; an accepted entry is appended to the log when `record` is set. */
  apply(entry, record = true) {
    // Each entry keeps the time it first happened, so a replay keeps a round's countdown where it was.
    entry.at ??= new Date().toISOString();
    const before = this.state, at = entry.at;
    let event;
    if (entry.kind === 'join') {
      const learner = this.learners.find(item => item.id === entry.learnerId);
      event = { type: 'join', actor: { role: 'participant', id: learner.id }, at, displayName: learner.name, avatarId: learner.avatarId };
    } else if (entry.kind === 'vote') {
      event = { type: 'vote', epoch: before.epoch, actor: { role: 'participant', id: entry.learnerId }, at, clientEventId: entry.clientEventId, roundId: entry.roundId, responseId: entry.responseId, response: entry.response };
    } else {
      // Only the room's fenced commands carry the revision they expect; the reducer refuses it on any other.
      event = { type: entry.type, epoch: before.epoch, ...(FENCEABLE.has(entry.type) ? { expectRevision: before.revision } : {}), actor: { role: 'facilitator' }, at, clientEventId: entry.clientEventId, roundId: entry.roundId, ...entry.payload };
      if (entry.type === 'undo') {
        const action = before.teachingActions.at(-1), source = this.rounds.get(action?.roundId) ?? (before.round?.id === action?.roundId ? before.round : null);
        event.sourceRound = source; event.seedResponseIds = Object.fromEntries(Object.keys(source?.responses ?? {}).map(id => [id, uuidv7()]));
      }
    }
    // A draft mid-edit can be inconsistent enough for the reducer to throw; that refuses the entry like a rejection.
    let result;
    try { result = reduce(before, event); } catch { this.reason = 'draft_inconsistent'; return false; }
    const receipt = result.effects.find(effect => effect.type === 'receipt');
    // A rejoin is idempotent and returns no receipt; anything else must be accepted.
    if (entry.kind !== 'join' && receipt?.receipt !== 'accepted') { this.reason = receipt?.reason ?? 'rejected'; return false; }
    this.reason = null; this.state = result.state;
    if (this.state.round) this.rounds.set(this.state.round.id, structuredClone(this.state.round));
    if (record) this.log.push(entry);
    return true;
  }

  /**
   * Rebuild from `doc` (the newest draft) by replaying the log. Replay is by position, so an edit that adds or removes a
   * content group on an earlier stage would shift every later step: when the replay stops early or ends anywhere other
   * than where the run was, the run is replayed to that stage instead (`moved`). A refused answer is dropped.
   */
  rebuild(doc = this.doc) {
    const log = this.log, was = positionOf(this.state);
    this.doc = doc; this.log = []; this.reset(log[0]?.at);
    let stopped = false;
    for (const entry of log) {
      if (this.apply(entry)) continue;
      if (entry.kind === 'command') { stopped = true; break; }
    }
    if (!stopped && samePosition(positionOf(this.state), was)) return { stopped: false, moved: false };
    if (was && this.jumpTo(was)) return { stopped: false, moved: true };
    return { stopped: true, moved: false };
  }

  /**
   * Jump to a stage by replay: restart and drive the reducer along the route until the target beat is entered, or the
   * target consequence is revealed. Votes are simulated, leaning to each decision's chosen route. The run is unchanged
   * when no route reaches the target (`reason` says 'unreachable', or 'search_limit' when the search gave up).
   */
  jumpTo({ beatId, pathId = null }) {
    if (!this.doc) return false;
    const saved = { state: this.state, log: this.log, rounds: this.rounds };
    this.restart();
    const found = routeTo(this, { beatId, pathId });
    const fail = reason => { Object.assign(this, saved); this.routes.clear(); this.reason = reason; return false; };
    if (!found.plan) return fail(found.reason);
    this.restart();
    for (const step of found.plan) if (!this.run(step)) return fail('unreachable');
    return true;
  }

  /**
   * Share an early clarification at the decision stage the run is on (D15), opening the stage's round first as the
   * facilitator would (each advance shows the next content group, then opens the round). Unchanged when it cannot.
   */
  showClarification(clarificationId) {
    const at = this.state?.beatId;
    // Bounded: each accepted advance shows one more of the stage's groups, then opens the round and leaves surface_live.
    while (this.state?.decisionId && this.state.phase === 'surface_live' && this.command('advance') && this.state.beatId === at);
    // Refused: the run is replayed back to the stage as it was.
    return (this.state?.beatId === at && this.command('show_clarification', { clarificationId })) || (this.jumpTo({ beatId: at }) && false);
  }

  /** One planned step: a command, or a decision resolved along `pathId` (simulated answers, lock, reveal). */
  run(step) {
    // Recovery is confirmed for the occurrence this run revealed (each run mints its own occurrence ids).
    if (step.type === 'confirm_recovery') return this.command('confirm_recovery', { occurrenceId: recoveryDescriptor(this.state)?.occurrenceId ?? null, confirmed: true });
    if (step.type !== 'resolve') return this.command(step.type);
    if (this.state.phase === 'responses_open') {
      const decision = this.doc.decisions.find(item => item.id === this.state.decisionId), path = decision?.paths.find(item => item.id === step.pathId);
      this.simulateVotes({ lean: path?.option_ids?.[0] ?? null });
      if (!this.command('lock')) return false;
    }
    return this.command('reveal_path', { pathId: step.pathId });
  }

  close() { super.close(); this.log = []; this.learners = []; }
}

const arrived = (state, { beatId, pathId }) => pathId
  ? state.revealed.at(-1)?.pathId === pathId && ['consequence_revealed', 'terminal_teaching'].includes(state.phase)
  : state.beatId === beatId && state.phase === 'surface_live' && state.revealed.at(-1)?.beatId === beatId && !state.revealed.at(-1)?.pathId;

/**
 * The planned steps from the lobby to a target: a depth-first search over the reducer itself (so flags, entry rules,
 * required recovery and explored routes all apply), trying the target's own route first at its decision. Returns
 * `{ plan }`, or `{ reason }` — 'unreachable' when no route exists, 'search_limit' when the search gave up.
 */
function routeTo(room, target) {
  const stack = [{ state: room.state, rounds: room.rounds, plan: [] }], seen = new Set();
  const decisionOf = target.pathId ? room.doc.decisions.find(item => (item.paths ?? []).some(path => path.id === target.pathId)) : null;
  const order = path => path.id === target.pathId ? -1 : ROUTE_ORDER.indexOf(path.classification);
  let budget = SEARCH_BUDGET;
  while (stack.length) {
    if (budget-- <= 0) return { reason: 'search_limit' };
    const node = stack.pop();
    if (arrived(node.state, target)) return { plan: node.plan };
    const s = node.state, last = s.revealed.at(-1);
    const key = JSON.stringify([s.phase, s.beatId, [...s.flags].sort(), s.exploredTerminal, last?.groupsShown, last?.pathId ?? null, s.recoveryConfirmation?.occurrenceId ?? null]);
    if (seen.has(key)) continue; seen.add(key);
    const actions = facilitatorActions(s), next = [];
    const tryStep = step => {
      room.state = node.state; room.rounds = new Map(node.rounds); room.log = [];
      if (room.run(step)) next.push({ state: room.state, rounds: room.rounds, plan: [...node.plan, step] });
    };
    const recovery = actions.includes('confirm_recovery') ? recoveryDescriptor(s) : null;
    if (actions.includes('start')) tryStep({ type: 'start' });
    else if (recovery && !recovery.confirmed) tryStep({ type: 'confirm_recovery' });
    else if (s.decisionId && (s.phase === 'responses_open' || (s.phase === 'surface_live' && !actions.includes('advance')))) {
      const decision = room.doc.decisions.find(item => item.id === s.decisionId);
      const paths = (decision?.paths ?? []).filter(path => path.classification !== 'terminal-unsafe' || path.id === target.pathId)
        .sort((a, b) => (decisionOf?.id === decision?.id ? order(a) - order(b) : ROUTE_ORDER.indexOf(a.classification) - ROUTE_ORDER.indexOf(b.classification)));
      // Pushed in reverse so the preferred route is explored first.
      for (const path of paths.reverse()) tryStep({ type: 'resolve', pathId: path.id });
    } else if (actions.includes('advance')) tryStep({ type: 'advance' });
    stack.push(...next);
  }
  return { reason: 'unreachable' };
}
