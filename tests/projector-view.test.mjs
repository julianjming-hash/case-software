import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from '../src/shared/ids.mjs';
import { initialState, dispatch, project } from '../src/shared/room-machine.mjs';
import { miniCase } from './helpers/mini-case.mjs';
import { acceptDisplayView, acceptLocalFrame, visiblePeople, cueForChange } from '../src/client/projector-view.mjs';
const view = () => project(initialState({ sessionId: uuidv7(), joinCode: '7K3QX9', caseDoc: miniCase().doc }), 'display');

test('projector accepts public projection and rejects private or malformed nested payloads', () => {
  const clean = view();
  assert.deepEqual(acceptDisplayView(clean), clean);
  const state = initialState({ sessionId: uuidv7(), joinCode: '7K3QX9', caseDoc: miniCase().doc });
  state.liveSurfaceId = state.caseDoc.surfaces[0].id;
  state.revealed = [{ surfaceId: state.liveSurfaceId, variant: -1, kind: 'live', manual: false, at: '2026-10-02T00:00:00Z' }];
  state.phase = 'surface_live';
  const live = project(state, 'display');
  assert.deepEqual(acceptDisplayView(live), live);
  for (const key of ['cue', 'notes', 'rationale', 'classification', 'caseDoc', 'mirror', 'answers']) {
    assert.equal(acceptDisplayView({ ...clean, [key]: 'private' }), null, key);
    assert.equal(acceptDisplayView({ ...clean, names: [{ name: 'Team', avatarId: null, [key]: 'private' }] }), null, key);
  }
  assert.equal(acceptDisplayView({ ...clean, role: 'facilitator' }), null);
  assert.equal(acceptDisplayView({ ...clean, counts: { ...clean.counts, responded: 'one' } }), null);
  assert.equal(acceptDisplayView({ ...clean, names: [{ name: 'Team', avatarId: null }], counts: { ...clean.counts, responded: 1 } }), null);
});

test('same-PC frames are room-bound display projections with monotonic revisions', () => {
  const clean = view();
  const frame = { t: 'local_snapshot', view: clean, epoch: clean.epoch, revision: clean.revision, displayRevision: clean.displayRevision };
  assert.deepEqual(acceptLocalFrame(frame, clean.sessionId), frame);
  assert.equal(acceptLocalFrame(frame, uuidv7()), null);
  assert.equal(acceptLocalFrame({ ...frame, mirror: {} }, clean.sessionId), null);
  assert.equal(acceptLocalFrame({ ...frame, revision: -1 }, clean.sessionId), null);
  assert.equal(acceptLocalFrame(frame, clean.sessionId, frame), null);
});

test('projector play people are avatar-only until reveal and bounded to twelve names', () => {
  const clean = view(); clean.phase = 'live'; clean.names = null; clean.avatars = Array(15).fill(null);
  assert.deepEqual(visiblePeople(clean), { people: Array.from({ length: 12 }, () => ({ name: null, avatarId: null })), more: 3 });
  clean.names = Array.from({ length: 15 }, () => ({ name: '\u202eTeam\u0000', avatarId: null })); clean.avatars = null;
  const shown = visiblePeople(clean);
  assert.equal(shown.people.length, 12); assert.equal(shown.more, 3); assert.equal(shown.people[0].name, 'Team');
});

test('projector sound transitions never cue replay, teaching, deterioration or repeated snapshots', () => {
  const clean = view();
  assert.equal(cueForChange(clean, { ...clean, phase: 'decision_open' }), 'decision_open');
  assert.equal(cueForChange(clean, { ...clean, phase: 'live', surface: { surfaceId: uuidv7(), timelineKind: 'live' } }), 'reveal');
  for (const timelineKind of ['consequence', 'terminal']) assert.equal(cueForChange(clean, { ...clean, phase: 'live', surface: { surfaceId: uuidv7(), timelineKind } }), null);
  assert.equal(cueForChange(clean, { ...clean, replay: true, phase: 'decision_open' }), null);
  assert.equal(cueForChange(clean, clean), null);
});

test('projector replay survives a new shared reveal until the facilitator selects Live surface', async () => {
  const { dispatch } = await import('../src/shared/room-machine.mjs');
  const { doc, s, p } = miniCase();
  let state = initialState({ sessionId: uuidv7(), joinCode: '7K3QX9', caseDoc: doc });
  const ledger = new Map();
  const send = (type, payload = {}) => {
    const result = dispatch(state, { type, actor: { role: 'facilitator', id: 'fac' }, at: '2026-10-02T00:00:00Z', epoch: state.epoch, clientEventId: uuidv7(), ...(['start', 'advance'].includes(type) ? { roundId: uuidv7() } : {}), ...payload }, ledger);
    assert.equal(result.effects.find(e => e.type === 'receipt')?.receipt, 'accepted', type); state = result.state;
  };
  send('start'); send('advance'); send('advance'); // prepare, then open the decision
  send('replay', { surfaceId: s.open }); send('lock'); send('select_path', { pathId: p.decompress }); send('reveal');
  const replay = project(state, 'display');
  assert.equal(replay.replay, true); assert.equal(replay.surface.surfaceId, s.open);
  assert.equal(project(state, 'participant', null).liveSurface.surfaceId, s.partial);
  send('replay', { surfaceId: null });
  const live = project(state, 'display'); assert.equal(live.replay, false); assert.equal(live.surface.surfaceId, s.partial);
});

// Real authority produces both public representations after an authored consequence.
function closedResultView(type) {
  const fixture = miniCase(), decision = fixture.doc.decisions[0];
  decision.interaction.type = type;
  if (type === 'ranking') decision.interaction.rank_count = 3;
  if (type === 'free_text') decision.interaction = { type, max_length: 280 };
  const participant = uuidv7(), ledger = new Map();
  let state = initialState({ sessionId: uuidv7(), joinCode: '7K3QX9', caseDoc: fixture.doc });
  const send = (type, payload = {}, actor = { role: 'facilitator', id: uuidv7() }) => {
    const next = dispatch(state, { type, epoch: state.epoch, actor, at: '2026-10-03T10:00:00Z', clientEventId: uuidv7(),
      ...(['start', 'advance'].includes(type) ? { roundId: uuidv7() } : {}), ...payload }, ledger);
    assert.equal(next.effects.find(row => row.type === 'receipt')?.receipt, 'accepted', type); state = next.state;
  };
  send('join', { displayName: 'Sam' }, { role: 'participant', id: participant });
  send('start'); send('advance'); assert.equal(state.round, null); send('advance');
  const ids = decision.interaction.options?.map(row => row.id);
  const response = type === 'ranking' ? { order: ids } : type === 'multi_select' ? { option_ids: [ids[0]] }
    : type === 'free_text' ? { text: 'Simulation answer' } : { option_id: ids[0] };
  send('vote', { roundId: state.round.id, responseId: uuidv7(), response }, { role: 'participant', id: participant });
  send('lock'); send('select_path', { pathId: fixture.p.decompress }); send('show_results', { on: false }); send('reveal'); send('show_results', { on: true });
  return project(state, 'display');
}

test('Card24 projector refuses conflicting closed first-choice counts across public result representations', () => {
  for (const type of ['single_choice', 'multi_select', 'free_text']) {
    const clean = closedResultView(type); assert.equal(acceptDisplayView(clean), clean, type);
    if (type === 'free_text') continue;
    const forged = structuredClone(clean);
    forged.lastResult.counts[0].count = 0; forged.lastResult.counts[1].count = 1;
    assert.equal(acceptDisplayView(forged), null, type);
  }
});

test('Card24 projector refuses conflicting ranking positions while retaining valid legacy first-choice snapshots', () => {
  const clean = closedResultView('ranking'); assert.equal(acceptDisplayView(clean), clean);
  const forged = structuredClone(clean);
  [forged.lastResult.counts[1].positionCounts, forged.lastResult.counts[2].positionCounts]
    = [forged.lastResult.counts[2].positionCounts, forged.lastResult.counts[1].positionCounts];
  assert.equal(acceptDisplayView(forged), null, 'both independent matrices are valid but disagree');
  const legacy = structuredClone({ ...clean, responseResult: null });
  delete legacy.lastResult.rankCount; legacy.lastResult.counts.forEach(row => { delete row.positionCounts; });
  assert.equal(acceptDisplayView(legacy), legacy);
});

test('Card24 projector rejects named rosters with either anonymous answer-count representation', () => {
  const clean = closedResultView('single_choice'); assert.equal(acceptDisplayView(clean), clean);
  for (const field of ['responseResult', 'lastResult']) {
    const forged = structuredClone(clean); forged.names = [{ name: 'Sam', avatarId: null }];
    forged[field === 'responseResult' ? 'lastResult' : 'responseResult'] = null;
    assert.equal(acceptDisplayView(forged), null, field);
  }
});


test('Card24 strict display rejects avatar rosters beside either count-bearing result and retains plain avatar play', () => {
  const clean = closedResultView('single_choice');
  assert.equal(acceptDisplayView(clean), clean);
  for (const field of ['responseResult', 'lastResult']) {
    const forged = structuredClone(clean); forged.names = null; forged.avatars = ['shadows-01'];
    forged[field === 'responseResult' ? 'lastResult' : 'responseResult'] = null;
    assert.equal(acceptDisplayView(forged), null, field);
  }
  const ordinary = structuredClone(clean); ordinary.responseResult = null; ordinary.lastResult = null;
  ordinary.names = null; ordinary.avatars = ['shadows-01'];
  assert.equal(acceptDisplayView(ordinary), ordinary);
});

test('[C30-skew] a projector accepts a view with an additive key it does not know, still validates known keys and refuses private ones', () => {
  const clean = view();
  // A newer Worker adds a field this projector predates: the view is kept (the field is dropped, never rendered).
  const newer = { ...clean, futureChrome: { shade: 3 } };
  assert.deepEqual(acceptDisplayView(newer), clean);
  // Known keys stay validated, and private fields stay refused even beside an additive one.
  assert.equal(acceptDisplayView({ ...newer, revision: 'two' }), null);
  assert.equal(acceptDisplayView({ ...newer, tint: 'magenta' }), null);
  for (const key of ['cue', 'notes', 'rationale', 'classification', 'caseDoc', 'mirror', 'answers', 'beats', 'decisions', 'facilitatorNotes'])
    assert.equal(acceptDisplayView({ ...newer, [key]: 'private' }), null, key);
});

test('[C30-skew] a room created before card 30 (no stored tint) projects no tint key; a new room projects its tint', () => {
  const legacy = initialState({ sessionId: uuidv7(), joinCode: '7K3QX9', caseDoc: miniCase().doc });
  delete legacy.tint;
  for (const role of ['display', 'participant', 'facilitator']) assert.equal('tint' in project(legacy, role), false, role);
  const fresh = initialState({ sessionId: uuidv7(), joinCode: '7K3QX9', caseDoc: miniCase().doc, tint: 'coral' });
  assert.equal(project(fresh, 'display').tint, 'coral');
});

test('mid-case join-screen restoration is silent while first-start cues remain', () => {
  const waiting = view();
  const live = { ...waiting, phase: 'live', surface: { surfaceId: uuidv7(), timelineKind: 'live' } };
  const decision = { ...waiting, phase: 'decision_open' };
  assert.equal(cueForChange(waiting, live, false), 'reveal');
  assert.equal(cueForChange(waiting, decision, false), 'decision_open');
  for (const next of [live, decision]) assert.equal(cueForChange(waiting, next, true), null);
  assert.equal(cueForChange(live, decision, true), 'decision_open');
  assert.equal(cueForChange(live, { ...live, surface: { ...live.surface, surfaceId: uuidv7() } }, true), 'reveal');
});
