// Card 37 item 4 (CASE-176, Julian's ruling (b), 2026-10-07): `show_lobby {on}` puts the projector back on the
// lobby join screen mid-case without ending the room. A display layer, not a phase: it changes display.lobby,
// display.revision and the journal only, publishes nothing, and phones never see it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { uuidv7 } from '../src/shared/ids.mjs';
import { initialState, reduce, project, facilitatorActions, COMMANDS } from '../src/shared/room-machine.mjs';
import { walkRoom, WALK_AT } from './helpers/room-walk.mjs';

const FAC = { role: 'facilitator', id: 'fac' };
const ALLOWED = ['surface_live', 'responses_open', 'responses_locked', 'path_selected', 'consequence_revealed', 'terminal_teaching', 'discussion_paused'];
const PUBLISHING = ['advance', 'reveal', 'reset_checkpoint', 'replay', 'show_results', 'results_page', 'ranked_page', 'show_names'];
const PRIVATE_STEPS = ['lock', 'reopen', 'void_round', 'select_path', 'back_to_review', 'pause', 'resume'];
const LOBBY_KEYS = ['arrivalCount', 'art', 'avatars', 'caseTitle', 'caseVersionNo', 'counts', 'decision', 'displayRevision', 'endedAt', 'epoch',
  'joinCode', 'joiningClosed', 'lastResult', 'manual', 'music', 'names', 'phase', 'recapExpiresAt', 'replay', 'responseResult', 'resultsPage',
  'resultsShown', 'revision', 'role', 'sessionId', 'surface', 'timer'];

const lobby = (state, on, extra = {}) => reduce(state, { type: 'show_lobby', on, epoch: state.epoch, actor: FAC, at: WALK_AT, ...extra });
const receipt = r => r.effects.find(e => e.type === 'receipt');
const without = (state, ...keys) => { const { caseDoc, ...rest } = state; const copy = structuredClone(rest); for (const k of keys) delete copy[k]; return copy; };
const comparable = state => { const copy = without(state, 'revision', 'lastAt'); delete copy.display.revision; return copy; };
const { doc, pid, states } = walkRoom();
const reachable = states.filter(s => s.phase !== 'ended');

test('[AS-107] [CASE-176] show_lobby is a facilitator command with an `on` boolean', () => {
  assert.deepEqual(COMMANDS.show_lobby, ['facilitator']);
  const live = reachable.find(s => s.phase === 'surface_live' && !s.manual);
  assert.equal(receipt(lobby(live, 'yes', { clientEventId: uuidv7() })).reason, 'bad_payload');
  assert.equal(receipt(reduce(live, { type: 'show_lobby', on: true, epoch: live.epoch, actor: { role: 'participant', id: pid }, at: WALK_AT, clientEventId: uuidv7() })).reason, 'forbidden');
  assert.equal(initialState({ sessionId: uuidv7(), caseDoc: doc }).display.lobby, false);
  const legacy = structuredClone(without(live)); delete legacy.display.lobby;
  assert.equal(project({ ...legacy, caseDoc: live.caseDoc }, 'display').phase, project(live, 'display').phase, 'a stored room without the field reads as off');
});

test('[AS-107] [CASE-176] on then off, from every allowed state, restores the whole state except display.revision and the journal', () => {
  let tried = 0;
  for (const state of reachable) {
    const on = lobby(state, true, { clientEventId: uuidv7() });
    if (!ALLOWED.includes(state.phase) || state.manual) {
      assert.equal(on.state, state, `${state.phase}${state.manual ? ' (manual)' : ''} refuses show_lobby`);
      assert.equal(receipt(on).reason, state.phase === 'lobby' ? 'already_in_lobby' : 'manual_room');
      assert.ok(!facilitatorActions(state).includes('show_lobby'));
      continue;
    }
    tried += 1;
    assert.ok(facilitatorActions(state).includes('show_lobby'), `${state.phase}: offered`);
    assert.equal(receipt(on).receipt, 'accepted');
    assert.equal(on.state.phase, state.phase, 'no phase change');
    assert.equal(on.state.display.lobby, true);
    assert.equal(on.state.display.revision, state.display.revision + 1);
    assert.deepEqual(on.effects.filter(e => e.type === 'journal').map(e => [e.kind, e.payload]), [['lobby_shown', { on: true }]]);
    assert.deepEqual(on.effects.find(e => e.type === 'broadcast').roles, ['facilitator', 'display'], 'phones are not told');
    assert.ok(on.effects.some(e => e.type === 'display'));
    assert.deepEqual(comparable({ ...on.state, display: { ...on.state.display, lobby: state.display.lobby } }), comparable(state), 'only the layer changed');
    assert.equal(receipt(lobby(on.state, true, { clientEventId: uuidv7() })).reason, 'no_change', 'a repeat is refused');
    assert.equal(receipt(lobby(state, false, { clientEventId: uuidv7() })).reason, 'no_change');
    const off = lobby(on.state, false);
    assert.equal(off.state.display.lobby, false);
    assert.deepEqual(comparable(off.state), comparable(state), `${state.phase}: on then off restores the state`);
    assert.equal(JSON.stringify(project(off.state, 'display')), JSON.stringify({ ...project(state, 'display'),
      revision: off.state.revision, displayRevision: off.state.display.revision }), 'the projector shows exactly what it showed before');
  }
  assert.ok(tried > 300, `exercised ${tried} allowed states`);
});

test('[AS-107] [CASE-176] while shown, publishing commands are refused as lobby_shown and omitted; private round steps stay', () => {
  const shown = reachable.filter(s => ALLOWED.includes(s.phase) && !s.manual).map(s => lobby(s, true).state);
  const at = new Date(Date.parse(WALK_AT) + 1).toISOString();
  for (const state of shown) {
    const actions = facilitatorActions(state);
    for (const command of PUBLISHING) {
      assert.ok(!actions.includes(command), `${state.phase}: ${command} omitted`);
      const r = reduce(state, { type: command, epoch: state.epoch, actor: FAC, at, clientEventId: uuidv7(), on: true, page: 0, entryIndex: null,
        group: 0, position: 0, closedRoundId: uuidv7(), expectRevision: ['reveal', 'advance', 'reset_checkpoint', 'ranked_page'].includes(command) ? state.revision : undefined, roundId: uuidv7() });
      assert.equal(r.state, state); assert.equal(receipt(r).reason, 'lobby_shown', `${state.phase}: ${command}`);
    }
    const base = facilitatorActions(lobby(state, false).state);
    for (const command of [...PRIVATE_STEPS, 'close_joining', 'rename', 'remove_participant', 'set_timer', 'takeover', 'end', 'enter_manual'])
      assert.equal(actions.includes(command), base.includes(command), `${state.phase}: ${command} availability unchanged`);
    assert.ok(actions.includes('show_lobby'));
  }
});

test('[AS-108] [CASE-176] the lobby screen carries no case material: exactly the lobby keys, nothing surfaced, decided or counted', () => {
  const secrets = [...doc.surfaces.flatMap(s => [s.title, s.scene, ...s.points]), ...doc.decisions.flatMap(d => [d.prompt, ...d.interaction.options.map(o => o.label),
    ...d.paths.flatMap(p => [p.label, p.rationale, p.cue])])].filter(x => typeof x === 'string' && x.length > 3 && x !== doc.title);
  const lobbyPhase = states.find(s => s.phase === 'lobby');
  for (const state of reachable.filter(s => ALLOWED.includes(s.phase) && !s.manual)) {
    const on = lobby(state, true).state, view = project(on, 'display');
    assert.deepEqual(Object.keys(view).filter(k => k !== 'tint').sort(), LOBBY_KEYS);
    assert.deepEqual(Object.keys(view).sort(), Object.keys(project(lobbyPhase, 'display')).sort(), 'the same keys as the real lobby');
    for (const key of ['surface', 'decision', 'responseResult', 'lastResult', 'timer']) assert.equal(view[key], null, key);
    // Hidden names stay hidden mid-case (CASE-133, red team L1): avatars only until Show names.
    if (state.namesShown) { assert.equal(view.avatars, null); assert.ok(Array.isArray(view.names)); }
    else { assert.equal(view.names, null, `${state.phase}: names hidden`); assert.ok(Array.isArray(view.avatars)); }
    assert.equal(view.phase, 'waiting'); assert.equal(view.replay, false); assert.equal(view.manual, false);
    assert.equal(view.counts.responded, null);
    assert.equal(view.caseTitle, doc.title);
    const json = JSON.stringify(view);
    for (const secret of secrets) assert.ok(!json.includes(secret), `${state.phase}: lobby screen leaked "${secret}"`);
    // Phones are unchanged: only the journal sequence moved, and phones are not even sent that (quiet broadcast).
    assert.deepEqual({ ...project(on, 'participant', pid), revision: state.revision }, project(state, 'participant', pid), 'phones are unchanged');
  }
});

test('[AS-107] [CASE-176] lobby on, any allowed commands, lobby off: nothing published or lost (property)', () => {
  const steps = fc.array(fc.record({ type: fc.constantFrom(...PRIVATE_STEPS, ...PUBLISHING, 'vote', 'close_joining', 'set_timer', 'takeover'), pick: fc.nat(5), on: fc.boolean() }), { maxLength: 12 });
  const starts = reachable.filter(s => ALLOWED.includes(s.phase) && !s.manual);
  fc.assert(fc.property(fc.nat(starts.length - 1), steps, (startIndex, plan) => {
    const start = starts[startIndex];
    let withLayer = lobby(start, true).state, plain = start;
    const apply = (state, step, t, ids) => {
      const decision = doc.decisions.find(d => d.id === (state.round?.decisionId ?? state.decisionId));
      const event = step.type === 'vote'
        ? { type: 'vote', epoch: state.epoch, actor: { role: 'participant', id: pid }, at: t, clientEventId: ids.event, roundId: state.round?.id ?? ids.round, responseId: ids.response,
          response: { option_id: decision?.interaction.options[step.pick % decision.interaction.options.length].id ?? ids.round } }
        : { type: step.type, epoch: state.epoch, actor: FAC, at: t, roundId: ids.round, on: step.on, closed: step.on, seconds: step.on ? 60 : null, page: 0, entryIndex: null,
          pathId: decision?.paths[step.pick % decision.paths.length].id ?? ids.round, group: 0, position: 0, closedRoundId: ids.round,
          ...(step.type === 'ranked_page' ? { expectRevision: state.revision } : {}) };
      return reduce(state, event).state;
    };
    let t = Date.parse(WALK_AT);
    for (const step of plan) {
      const at = new Date(t += 1000).toISOString(), ids = { event: uuidv7(), round: uuidv7(), response: uuidv7() };
      const next = apply(withLayer, step, at, ids);
      // Publishing never lands under the layer; a private step lands exactly as it would without it.
      if (PUBLISHING.includes(step.type)) { assert.equal(next, withLayer); continue; }
      withLayer = next; plain = apply(plain, step, at, ids);
    }
    if (withLayer.phase === 'ended' || withLayer.manual) return;
    const back = withLayer.display.lobby ? lobby(withLayer, false, { at: new Date(t += 1000).toISOString() }).state : withLayer;
    for (const key of ['phase', 'revealed', 'resultsShown', 'resultsPage', 'rankedSelection', 'namesShown', 'flags', 'selectedPathId', 'nextBeatId', 'round', 'rounds', 'timer', 'joiningClosed'])
      assert.deepEqual(back[key], plain[key], key);
    assert.equal(back.display.cursor, plain.display.cursor);
    assert.deepEqual(project(back, 'participant', pid), { ...project(plain, 'participant', pid), revision: back.revision, epoch: back.epoch });
  }), { numRuns: 300 });
});

test('[AS-107] [CASE-176] manual mode clears the layer, and end ends the room with the projector on its ended screen', () => {
  const live = reachable.find(s => s.phase === 'surface_live' && !s.manual && facilitatorActions(s).includes('enter_manual'));
  const on = lobby(live, true).state;
  const manual = reduce(on, { type: 'enter_manual', segmentId: uuidv7(), epoch: on.epoch, actor: FAC, at: WALK_AT });
  assert.equal(receipt(manual) ?? 'accepted', 'accepted');
  assert.equal(manual.state.display.lobby, false);
  assert.notEqual(project(manual.state, 'display').phase, 'waiting');
  assert.equal(receipt(lobby(manual.state, true, { clientEventId: uuidv7() })).reason, 'manual_room');
  const ended = reduce(on, { type: 'end', epoch: on.epoch, actor: FAC, at: WALK_AT }).state;
  assert.equal(ended.phase, 'ended');
  assert.equal(project(ended, 'display').phase, 'ended');
  assert.equal(receipt(lobby(ended, false, { clientEventId: uuidv7() })).reason, 'room_ended');
});
