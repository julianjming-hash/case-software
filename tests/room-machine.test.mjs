import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { uuidv7 } from '../src/shared/ids.mjs';
import { initialState, reduce, dispatch, applySegment, project, PHASES, facilitatorActions, MAX_PARTICIPANTS } from '../src/shared/room-machine.mjs';
import { validateCaseDocument } from '../src/shared/case-document.mjs';
import { miniCase } from './helpers/mini-case.mjs';
import { legacyPausedState } from './helpers/legacy-pause.mjs';

// ── harness ──────────────────────────────────────────────────────────────────
function room(doc = miniCase().doc) {
  let state = initialState({ sessionId: uuidv7(), joinCode: '7K3QX9', caseDoc: doc });
  const ledger = new Map();
  let t = Date.parse('2026-10-01T09:00:00Z');
  const fac = { role: 'facilitator', id: 'fac' };
  const api = {
    get state() { return state; },
    send(type, payload = {}, actor = fac, opts = {}) {
      t += 1000;
      const ev = { type, epoch: opts.epoch ?? state.epoch, actor, at: new Date(t).toISOString(), ...payload };
      if (opts.cid !== false) ev.clientEventId = opts.cid ?? uuidv7();
      const r = dispatch(state, ev, ledger);
      state = r.state;
      return r;
    },
    ledger,
    /** A room persisted while paused, before Pause for discussion was retired (CASE-255). */
    legacyPause() { t += 1000; state = legacyPausedState(state, new Date(t).toISOString()); },
    f(type, payload = {}, opts) {
      if (['start', 'advance', 'reopen', 'reset_checkpoint'].includes(type)) payload = { roundId: uuidv7(), ...payload };
      return api.send(type, payload, fac, opts);
    },
    /** Authorised beats prepare public context before voting. Keep old clinical tests' full
     *  paths explicit without treating a single advance as an implicit round open. */
    toOpenRound() {
      let result;
      for (let n = 0; n < 15 && state.phase !== 'responses_open'; n++) result = api.f('advance');
      assert.equal(state.phase, 'responses_open', 'the authored decision context completed before voting');
      return result;
    },
    join(name = 'Adrenaline Junkie') {
      const id = uuidv7();
      api.send('join', { displayName: name }, { role: 'participant', id });
      return id;
    },
    vote(pid, response, opts = {}) {
      return api.send('vote', { roundId: opts.roundId ?? state.round?.id ?? 'none', response, responseId: uuidv7() }, { role: 'participant', id: pid }, opts);
    },
    receipt(r) { return r.effects.find((e) => e.type === 'receipt')?.receipt; },
  };
  return api;
}

/** The recommended D1 path id of a mini case document. */
function miniCaseIds(doc) { return { decompress: doc.decisions[0].paths.find((x) => x.recommended).id }; }

/** Strings that must never reach a public (display/participant) projection. */
function secretsOf(doc, state) {
  const revealed = new Set(state.revealed.map((r) => r.surfaceId));
  const out = [];
  for (const s of doc.surfaces) {
    if (!revealed.has(s.id)) out.push(...s.points, ...(s.variants || []).flatMap((v) => v.points), s.id);
    // Notes are facilitator-only even after the surface is revealed (CASE-087).
    out.push(s.notes, ...(s.variants || []).map((v) => v.notes));
  }
  for (const d of doc.decisions) for (const p of d.paths) out.push(p.cue, p.rationale, p.label, p.id);
  for (const b of doc.beats) if (b.cue) out.push(b.cue);
  // Text that is legitimately public (option labels, revealed surfaces) is not a secret,
  // even when a facilitator-facing path label happens to repeat it.
  const pub = [
    ...doc.decisions.flatMap((d) => (d.interaction.options || []).map((o) => o.label)),
    ...doc.surfaces.filter((x) => revealed.has(x.id)).flatMap((x) => [x.title, ...x.points, ...(x.variants || []).flatMap((v) => v.points)]),
  ].join('\n');
  return out.filter((x) => typeof x === 'string' && x.length > 3 && !pub.includes(x));
}
function assertNoLeak(doc, state) {
  const secrets = secretsOf(doc, state);
  for (const role of ['display', 'participant']) {
    const pid = Object.keys(state.participants)[0] ?? null;
    // The post-session recap deliberately teaches with the participant's OWN path rationale
    // (CASE-082); it is checked separately. Everything else must stay free of review data.
    const { recap, ...view } = project(state, role, pid);
    const json = JSON.stringify(view);
    for (const s of secrets) assert.ok(!json.includes(s), `${role} projection leaks "${s.slice(0, 40)}" in phase ${state.phase}`);
    assert.ok(!/aggregate|suggestion|classification|"cue"/.test(json), `${role} projection exposes review data in ${state.phase}`);
  }
}

// ── the happy path ───────────────────────────────────────────────────────────
test('[AS-003] [AS-005] [AS-007] [AS-017] full recommended path: lobby → D1 → D2 → debrief → end', () => {
  const { doc, o, p } = miniCase();
  const r = room(doc);
  const a = r.join('A');
  const b = r.join('B');
  assert.equal(r.state.phase, 'lobby');
  r.f('start');
  assert.equal(r.state.phase, 'surface_live');
  r.toOpenRound();
  assert.equal(r.state.phase, 'responses_open');
  assert.equal(r.receipt(r.vote(a, { option_id: o.decompress })), 'accepted');
  assert.equal(r.receipt(r.vote(b, { option_id: o.image })), 'accepted');
  r.vote(b, { option_id: o.decompress }); // revise until lock
  r.f('lock');
  assert.equal(r.state.phase, 'responses_locked');
  assert.equal(r.state.round.suggestion.pathId, p.decompress);
  r.f('select_path', { pathId: p.decompress });
  assert.equal(r.state.resolutionKind, 'majority');
  r.f('show_results', { on: false }); r.f('reveal');
  assert.equal(r.state.phase, 'consequence_revealed');
  assert.deepEqual(r.state.flags, ['workshop_flag_01']);
  r.toOpenRound(); // reveal the next authored context, then open D2 (requires workshop_flag_01)
  assert.equal(r.state.phase, 'responses_open');
  r.vote(a, { option_id: o.fast });
  r.f('lock');
  r.f('select_path', { pathId: p.fast });
  r.f('show_results', { on: false }); r.f('reveal');
  r.f('advance'); // debrief
  assert.equal(r.state.phase, 'surface_live');
  assert.equal(r.state.nextBeatId, null);
  assert.equal(r.receipt(r.f('advance')), 'rejected');
  r.f('end');
  assert.equal(r.state.phase, 'ended');
  const recap = project(r.state, 'participant', a).recap;
  assert.equal(recap.rounds.length, 2);
  assert.deepEqual(recap.rounds[0].yourResponse, { option_id: o.decompress });
});

test('revision strictly increases and every change journals', () => {
  const r = room();
  r.join();
  let last = r.state.revision;
  for (const cmd of ['start', 'advance', 'advance', 'lock']) {
    const res = r.f(cmd);
    assert.ok(r.state.revision > last, cmd);
    assert.ok(res.effects.some((e) => e.type === 'journal'));
    assert.ok(res.effects.some((e) => e.type === 'broadcast' && e.revision === r.state.revision));
    last = r.state.revision;
  }
});

// ── votes, receipts, idempotency ─────────────────────────────────────────────
test('[AS-006] [AS-024] vote at the lock boundary gets a definitive receipt; retries are idempotent', () => {
  const { doc, o } = miniCase();
  const r = room(doc);
  const a = r.join();
  r.f('start'); r.toOpenRound();
  const roundId = r.state.round.id;
  const cid = uuidv7();
  assert.equal(r.receipt(r.vote(a, { option_id: o.decompress }, { cid })), 'accepted');
  assert.equal(r.receipt(r.vote(a, { option_id: o.decompress }, { cid })), 'already_accepted');
  r.f('lock');
  assert.equal(r.receipt(r.vote(a, { option_id: o.image }, { roundId })), 'locked');
  assert.equal(r.receipt(r.vote(a, { option_id: o.decompress }, { cid })), 'already_accepted', 'a retry of the accepted vote stays accepted after lock');
  assert.deepEqual(r.state.round.responses[a].response, { option_id: o.decompress });
});

test('[AS-005] votes need a client_event_id, a known participant, a valid option', () => {
  const { doc, o } = miniCase();
  const r = room(doc);
  const a = r.join();
  r.f('start'); r.toOpenRound();
  assert.equal(r.receipt(r.vote(uuidv7(), { option_id: o.decompress })), 'rejected');
  assert.equal(r.receipt(r.vote(a, { option_id: uuidv7() })), 'rejected');
  assert.equal(r.vote(a, { option_id: o.decompress }, { cid: false }).state.round.responses[a], undefined);
});

test('[AS-027] stale-epoch commands change nothing', () => {
  const r = room();
  r.join();
  r.f('start');
  r.f('enter_manual', { segmentId: uuidv7() });
  const before = r.state;
  const res = r.f('advance', {}, { epoch: 0 });
  assert.equal(r.receipt(res), 'stale_epoch');
  assert.equal(r.state, before);
});

test('[AS-027] a rejected command emits only its receipt', () => {
  const r = room();
  const res = r.f('lock');
  assert.deepEqual(res.effects.map((e) => e.type), ['receipt']);
});

// ── pause (retired, CASE-255) ────────────────────────────────────────────────
test('[AS-010] [CASE-255] pause is refused as retired in every phase and is never offered', () => {
  const { doc, o, p } = miniCase();
  const r = room(doc);
  const a = r.join();
  const probe = () => {
    assert.ok(!facilitatorActions(r.state).includes('pause'), `phase ${r.state.phase} offers pause`);
    const before = r.state, res = r.f('pause');
    assert.equal(res.effects[0].reason, 'retired', r.state.phase);
    assert.deepEqual(res.effects.map((e) => e.type), ['receipt']);
    assert.equal(r.state, before);
  };
  probe();
  r.f('start'); probe();
  r.toOpenRound(); probe();
  r.vote(a, { option_id: o.decompress }); r.f('lock'); probe();
  r.f('select_path', { pathId: p.decompress }); probe();
  r.f('show_results', { on: false }); r.f('reveal'); probe();
});

test('[AS-011] [CASE-255] a room persisted while paused during an open vote still holds answers and resumes to its phase', () => {
  const { doc, o } = miniCase();
  const r = room(doc);
  const a = r.join();
  r.f('start'); r.toOpenRound();
  r.legacyPause();
  assert.deepEqual(facilitatorActions(r.state).filter((x) => ['pause', 'resume'].includes(x)), ['resume']);
  assert.equal(r.state.phase, 'discussion_paused');
  assert.equal(r.receipt(r.vote(a, { option_id: o.decompress })), 'paused_held');
  assert.equal(project(r.state, 'participant', a).decision.status, 'held');
  r.f('resume');
  assert.equal(r.state.phase, 'responses_open');
  assert.equal(r.receipt(r.vote(a, { option_id: o.decompress })), 'accepted');
});

// ── reopen and void ──────────────────────────────────────────────────────────
test('[AS-012] reopen creates round n+1 and preserves the first round', () => {
  const { doc, o } = miniCase();
  const r = room(doc);
  const a = r.join();
  r.f('start'); r.toOpenRound();
  r.vote(a, { option_id: o.image });
  r.f('lock');
  const first = r.state.round.id;
  r.f('reopen');
  assert.equal(r.state.round.no, 2);
  assert.notEqual(r.state.round.id, first);
  assert.equal(r.state.rounds[0].status, 'superseded');
  assert.deepEqual(r.state.rounds[0].aggregate.counts, { [o.image]: 1 });
  assert.equal(r.receipt(r.vote(a, { option_id: o.image }, { roundId: first })), 'locked');
});

test('[AS-013] void round abandons it; its answers never reach an aggregate or recap', () => {
  const { doc, o } = miniCase();
  const r = room(doc);
  const a = r.join();
  r.f('start'); r.toOpenRound();
  r.vote(a, { option_id: o.image });
  r.f('void_round');
  assert.equal(r.state.phase, 'surface_live');
  assert.equal(r.state.rounds[0].status, 'abandoned');
  assert.equal(r.state.rounds[0].aggregate, null);
  assert.deepEqual(r.state.rounds[0].answers, {});
  r.f('advance'); // fresh round on the same decision
  assert.equal(r.state.phase, 'responses_open');
  assert.equal(r.state.round.no, 2);
});

// ── manual room ──────────────────────────────────────────────────────────────
test('[AS-031] entering manual mode inside a round voids it in the same command (CASE-071)', () => {
  const { doc, o } = miniCase();
  const r = room(doc);
  const a = r.join();
  r.f('start'); r.toOpenRound();
  r.vote(a, { option_id: o.image });
  assert.equal(r.receipt(r.f('enter_manual', { segmentId: uuidv7() })), 'accepted');
  assert.equal(r.state.epoch, 1);
  assert.equal(r.state.phase, 'surface_live');
  assert.equal(r.state.rounds.at(-1).status, 'abandoned');
  assert.deepEqual(r.state.rounds.at(-1).answers, {});
});

test('[AS-031] manual entry is refused once a path is selected (reveal or go back first)', () => {
  const { doc, o, p } = miniCase();
  const r = room(doc);
  const a = r.join();
  r.f('start'); r.toOpenRound();
  r.vote(a, { option_id: o.decompress });
  r.f('lock'); r.f('select_path', { pathId: p.decompress });
  assert.equal(r.receipt(r.f('enter_manual', { segmentId: uuidv7() })), 'rejected');
});

test('[CASE-255] a legacy room paused from a selection still refuses manual entry', () => {
  const { doc, o, p } = miniCase();
  const r = room(doc);
  const a = r.join();
  r.f('start'); r.toOpenRound();
  r.vote(a, { option_id: o.decompress });
  r.f('lock'); r.f('select_path', { pathId: p.decompress });
  r.legacyPause();
  assert.equal(r.receipt(r.f('enter_manual', { segmentId: uuidv7() })), 'rejected');
});

test('[AS-030] [AS-031] lobby entry: manual mode starts before the case does', () => {
  const r = room();
  r.join();
  assert.equal(r.receipt(r.f('enter_manual', { segmentId: uuidv7() })), 'accepted', 'lobby: network down before the case starts');
  assert.equal(r.state.phase, 'lobby');
  r.f('resume_online');
  assert.equal(r.receipt(r.f('start')), 'accepted');
});

test('[CASE-255] a legacy room paused mid-vote enters manual mode, voids the round and resumes to the decision surface', () => {
  const r = room();
  r.join();
  r.f('start'); r.toOpenRound();
  r.legacyPause();
  assert.ok(facilitatorActions(r.state).includes('enter_manual'));
  r.f('enter_manual', { segmentId: uuidv7() });
  assert.equal(r.state.phase, 'discussion_paused');
  assert.equal(r.state.resumePhase, 'surface_live');
  r.f('resume');
  assert.equal(r.state.phase, 'surface_live');
  assert.equal(r.state.round, null);
});

test('[AS-032] ending in manual mode closes the segment; a terminal reset works offline', () => {
  const { doc, p } = miniCase();
  const r = room(doc);
  r.join();
  r.f('start');
  r.f('enter_manual', { segmentId: uuidv7() });
  r.f('advance');
  r.f('select_path', { pathId: p.intubate });
  r.f('reveal');
  assert.equal(r.state.phase, 'terminal_teaching');
  r.f('reset_checkpoint');
  assert.equal(r.state.phase, 'surface_live');
  assert.equal(r.state.decisionId, doc.decisions[0].id);
  assert.equal(r.receipt(r.f('select_path', { pathId: p.intubate })), 'rejected', 'explored terminal path stays greyed');
  r.f('end');
  assert.equal(r.state.manual, null);
  assert.equal(r.state.manualSegments.length, 1);
});

test('[AS-032] [AS-035] in manual mode the facilitator selects paths without votes; resume opens a fresh decision', () => {
  const { doc, o, p } = miniCase();
  const r = room(doc);
  const a = r.join();
  r.f('start');
  r.f('enter_manual', { segmentId: uuidv7() });
  r.f('advance'); // into D1: manual → no round
  assert.equal(r.state.phase, 'surface_live');
  assert.equal(r.state.round, null);
  assert.equal(r.receipt(r.vote(a, { option_id: o.decompress }, { roundId: uuidv7() })), 'rejected');
  r.f('manual_marker', { text: 'Show of hands: most would decompress.' });
  r.f('select_path', { pathId: p.decompress });
  assert.equal(r.state.resolutionKind, 'manual_room');
  r.f('reveal');
  assert.equal(r.state.revealed.at(-1).manual, true);
  r.f('resume_online');
  assert.equal(r.state.epoch, 2);
  assert.equal(r.state.manual, null);
  assert.equal(r.state.manualSegments.length, 1);
  r.toOpenRound(); // D2 context and fresh online round
  assert.equal(r.state.phase, 'responses_open');
  assert.equal(r.state.round.no, 1);
});

test('[AS-033] [AS-034] votes keep flowing while the facilitator is offline; a later void + manual abandons them', () => {
  const { doc, o } = miniCase();
  const r = room(doc);
  const a = r.join();
  const b = r.join();
  r.f('start'); r.toOpenRound();
  // facilitator offline: phones keep voting into the open round
  assert.equal(r.receipt(r.vote(a, { option_id: o.decompress })), 'accepted');
  assert.equal(r.receipt(r.vote(b, { option_id: o.image })), 'accepted');
  // facilitator's uploaded manual segment begins with void + enter_manual at the old epoch
  r.f('void_round');
  r.f('enter_manual', { segmentId: uuidv7() });
  assert.equal(r.state.rounds[0].status, 'abandoned');
  assert.deepEqual(r.state.rounds[0].answers, {});
});

// ── terminal teaching ────────────────────────────────────────────────────────
test('[AS-015] terminal path: teaching state, reset restores snapshot, greys the option, keeps history', () => {
  const { doc, o, p } = miniCase();
  const r = room(doc);
  const a = r.join();
  r.f('start'); r.toOpenRound();
  r.vote(a, { option_id: o.intubate });
  r.f('lock');
  r.f('select_path', { pathId: p.intubate });
  r.f('show_results', { on: false }); r.f('reveal');
  assert.equal(r.state.phase, 'terminal_teaching');
  const timelineBefore = r.state.revealed.length;
  r.f('reset_checkpoint');
  r.toOpenRound();
  assert.equal(r.state.phase, 'responses_open');
  assert.equal(r.state.round.no, 2);
  assert.ok(r.state.revealed.length >= timelineBefore, 'history retained');
  assert.ok(r.state.revealed.some((e) => e.kind === 'terminal'));
  const opt = project(r.state, 'participant', a).decision.interaction.options.find((x) => x.id === o.intubate);
  assert.equal(opt.disabled, true);
  assert.equal(r.receipt(r.vote(a, { option_id: o.intubate })), 'rejected');
  r.f('lock');
  assert.equal(r.receipt(r.f('select_path', { pathId: p.intubate })), 'rejected');
});

test('[AS-008] override and minority resolution kinds', () => {
  const { doc, o, p } = miniCase();
  const r = room(doc);
  const a = r.join();
  const b = r.join();
  r.f('start'); r.toOpenRound();
  r.vote(a, { option_id: o.decompress });
  r.vote(b, { option_id: o.decompress });
  r.f('lock');
  r.f('select_path', { pathId: p.image });
  assert.equal(r.state.resolutionKind, 'override');
  r.f('back_to_review');
  assert.equal(r.state.phase, 'responses_locked');
});

// ── projections ──────────────────────────────────────────────────────────────
test('[AS-007] [AS-019] public projections never leak unrevealed surfaces, cues, paths or aggregates', () => {
  const { doc, o, p } = miniCase();
  const r = room(doc);
  const a = r.join();
  const check = () => assertNoLeak(doc, r.state);
  check();
  r.f('start'); check();
  r.f('advance'); check();
  r.vote(a, { option_id: o.decompress }); check();
  r.f('lock'); check();
  r.f('select_path', { pathId: p.decompress }); check();
  r.legacyPause(); check();
  r.f('resume');
  r.f('reveal'); check();
  r.f('advance'); check();
});

test('[AS-019] late joiner sees exactly the revealed timeline and the current decision', () => {
  const { doc } = miniCase();
  const r = room(doc);
  r.join();
  r.f('start'); r.toOpenRound();
  const late = r.join('Late');
  const view = project(r.state, 'participant', late);
  assert.deepEqual(view.timeline.map((x) => x.surfaceId), r.state.revealed.map((x) => x.surfaceId));
  assert.equal(view.decision.status, 'open');
  assert.equal(view.decision.yourResponse, null);
});

test('[AS-037] replay moves only the projector; phones and session revision are untouched', () => {
  const r = room();
  const a = r.join();
  r.f('start'); r.toOpenRound();
  const first = r.state.revealed[0].surfaceId;
  const rev = r.state.revision;
  const res = r.f('replay', { surfaceId: first });
  assert.equal(r.state.revision, rev);
  assert.ok(res.effects.some((e) => e.type === 'display'));
  assert.equal(project(r.state, 'display').replay, true);
  assert.equal(project(r.state, 'display').surface.surfaceId, first);
  assert.notEqual(project(r.state, 'participant', a).liveSurface.surfaceId, first);
  assert.equal(r.receipt(r.f('replay', { surfaceId: uuidv7() })), 'rejected');
});

test('[AS-014] lobby names are visible; play names require Show names', () => {
  const r = room();
  r.join('Adrenaline Junkie');
  assert.deepEqual(project(r.state, 'display').names, [{ name: 'Adrenaline Junkie', avatarId: null }]);
  r.f('start');
  assert.equal(project(r.state, 'display').names, null);
  r.f('show_names', { on: true });
  assert.deepEqual(project(r.state, 'display').names, [{ name: 'Adrenaline Junkie', avatarId: null }]);
});

test('[AS-064] play display receives avatar IDs without participant names until Show names', () => {
  const r = room();
  const a = uuidv7();
  r.send('join', { displayName: 'Sam', avatarId: 'shadows-03' }, { role: 'participant', id: a });
  assert.deepEqual(project(r.state, 'display').names, [{ name: 'Sam', avatarId: 'shadows-03' }]);
  r.f('start');
  const hidden = project(r.state, 'display');
  assert.equal(hidden.names, null);
  assert.deepEqual(hidden.avatars, ['shadows-03']);
  assert.equal(JSON.stringify(hidden).includes('Sam'), false);
  r.f('show_names', { on: true });
  assert.deepEqual(project(r.state, 'display').names, [{ name: 'Sam', avatarId: 'shadows-03' }]);
});

test('[AS-063] scene prose and investigations reach every screen alike; notes stay with the facilitator', () => {
  const { doc } = miniCase();
  doc.surfaces[0].scene = 'A pale driver, breathing fast.';
  doc.surfaces[0].investigations = ['CXR: large R pneumothorax'];
  doc.surfaces[0].notes = 'Private mechanism.';
  const r = room(doc);
  const a = r.join('Sam');
  r.f('start');
  assert.deepEqual(project(r.state, 'display').surface.investigations, [], 'later investigations remain withheld');
  r.f('advance'); // findings
  r.f('advance'); // investigations
  const views = [project(r.state, 'display').surface, project(r.state, 'participant', a).liveSurface, project(r.state, 'facilitator').liveSurface];
  for (const v of views) {
    assert.equal(v.scene, 'A pale driver, breathing fast.');
    assert.deepEqual(v.investigations, ['CXR: large R pneumothorax']);
  }
  assert.equal(views[0].notes, undefined);
  assert.equal(views[1].notes, undefined);
  assert.equal(views[2].notes, 'Private mechanism.');
});

test('[AS-062] the reducer stores an allow-listed avatar and projects it wherever the name is shown (CASE-119)', () => {
  const r = room();
  const a = uuidv7();
  r.send('join', { displayName: 'Sam', avatarId: 'shadows-03' }, { role: 'participant', id: a });
  const b = uuidv7();
  r.send('join', { displayName: 'Sam', avatarId: 'https://api.dicebear.com/x.svg' }, { role: 'participant', id: b });
  assert.equal(r.state.participants[a].avatarId, 'shadows-03');
  assert.equal(r.state.participants[b].avatarId, null, 'anything off the allow-list is never stored');
  assert.equal(project(r.state, 'participant', a).you.avatarId, 'shadows-03');
  assert.deepEqual(project(r.state, 'facilitator').participants.map((p) => [p.name, p.avatarId]), [['Sam', 'shadows-03'], ['Sam', null]], 'duplicate names are allowed');
  r.f('show_names', { on: true });
  assert.deepEqual(project(r.state, 'display').names, [{ name: 'Sam', avatarId: 'shadows-03' }, { name: 'Sam', avatarId: null }]);
  r.send('rename', { displayName: 'Samira', avatarId: 'shadows-12' }, { role: 'participant', id: a });
  r.send('rename', { displayName: 'Sammy' }, { role: 'participant', id: b });
  assert.deepEqual(project(r.state, 'display').names, [{ name: 'Samira', avatarId: 'shadows-12' }, { name: 'Sammy', avatarId: null }]);
});

test('facilitator actions are exactly those the reducer accepts in each reachable phase', () => {
  const { doc, o, p } = miniCase();
  const r = room(doc);
  const a = r.join();
  const steps = [
    () => r.f('start'), () => r.f('advance'), () => r.f('advance'), () => r.vote(a, { option_id: o.decompress }),
    () => r.f('lock'), () => r.f('select_path', { pathId: p.decompress }), () => r.f('reveal'),
    () => r.legacyPause(), // a room persisted while paused before CASE-255: resume is listed and accepted
  ];
  for (const step of [() => {}, ...steps]) {
    step();
    const acts = facilitatorActions(r.state);
    for (const cmd of ['start', 'advance', 'lock', 'reopen', 'void_round', 'reveal', 'back_to_review', 'reset_checkpoint', 'pause', 'resume']) {
      const probe = reduce(r.state, { type: cmd, epoch: r.state.epoch, actor: { role: 'facilitator' }, at: '2026-10-01T10:00:00Z', roundId: uuidv7(), clientEventId: uuidv7() });
      const ok = probe.effects[0]?.receipt === 'accepted';
      assert.equal(acts.includes(cmd), ok, `phase ${r.state.phase}: "${cmd}" listed=${acts.includes(cmd)} accepted=${ok}`);
    }
  }
});

test('every phase in PHASES but the retired discussion_paused is reachable in the mini case (CASE-255)', () => {
  const { doc, o, p } = miniCase();
  const r = room(doc);
  const seen = new Set([r.state.phase]);
  const a = r.join();
  const step = (fn) => { fn(); seen.add(r.state.phase); };
  step(() => r.f('start'));
  step(() => r.f('advance'));
  step(() => r.f('advance')); // the decision context is complete before its round opens
  step(() => r.f('pause')); // refused: retired
  step(() => r.vote(a, { option_id: o.intubate }));
  step(() => r.f('lock'));
  step(() => r.f('select_path', { pathId: p.intubate }));
  step(() => { r.f('show_results', { on: false }); r.f('reveal'); });
  step(() => r.f('reset_checkpoint'));
  step(() => r.f('advance')); // reopen the reset checkpoint only after its context
  step(() => r.f('lock'));
  step(() => r.f('select_path', { pathId: p.decompress }));
  step(() => { r.f('show_results', { on: false }); r.f('reveal'); });
  step(() => r.f('debrief')); // console layout v2: reversible, then final
  step(() => r.f('back_to_case'));
  step(() => r.f('debrief'));
  step(() => r.f('end'));
  assert.deepEqual([...seen].sort(), PHASES.filter((phase) => phase !== 'discussion_paused').sort());
});

// ── the canonical fixture ────────────────────────────────────────────────────
test('the MVC tension pneumothorax fixture validates and plays end to end on recommended paths', () => {
  const doc = JSON.parse(readFileSync(new URL('../src/fixtures/synthetic-workshop.case.json', import.meta.url), 'utf8'));
  const v = validateCaseDocument(doc);
  assert.deepEqual(v.errors, []);
  const r = room(doc);
  const a = r.join();
  r.f('start');
  let guard = 0;
  while (r.state.phase !== 'ended' && guard++ < 50) {
    if (r.state.phase === 'responses_open') {
      const d = doc.decisions.find((x) => x.id === r.state.round.decisionId);
      const rec = d.paths.find((x) => x.recommended);
      r.vote(a, { option_id: rec.option_ids[0] });
      r.f('lock');
      assert.equal(r.state.round.suggestion.pathId, rec.id);
      r.f('select_path', { pathId: rec.id });
      r.f('show_results', { on: false }); r.f('reveal');
    } else if (facilitatorActions(r.state).includes('advance')) {
      r.f('advance');
    } else {
      r.f('end');
    }
    assertNoLeak(doc, r.state);
  }
  assert.equal(r.state.phase, 'ended');
  assert.equal(r.state.rounds.filter((x) => x.status === 'resolved').length, doc.decisions.length);
});

// ── projection fields added from the SCREENS.md spec gaps ───────────────────
test('facilitator sees the terminal checkpoint to label "Reset to …"', () => {
  const { doc, o, p, b } = miniCase();
  const r = room(doc);
  const a = r.join();
  r.f('start'); r.toOpenRound();
  r.vote(a, { option_id: o.intubate });
  r.f('lock'); r.f('select_path', { pathId: p.intubate }); r.f('show_results', { on: false }); r.f('reveal');
  const t = project(r.state, 'facilitator').terminal;
  assert.equal(t.checkpointBeat.id, b.d1);
  assert.equal(t.checkpointBeat.title, 'Decisive intervention');
  assert.ok(t.debriefPrompt.length > 0);
});

test('a voided round is visible to phones as lastRound.status = abandoned', () => {
  const r = room();
  const a = r.join();
  r.f('start'); r.toOpenRound();
  r.f('void_round');
  const v = project(r.state, 'participant', a);
  assert.equal(v.decision, null);
  assert.equal(v.lastRound.status, 'abandoned');
});

test('every role gets the case title; the advisory timer reaches display and phones only while open', () => {
  const { doc } = miniCase();
  doc.decisions[0].timer_s = 60;
  const r = room(doc);
  const a = r.join();
  for (const role of ['facilitator', 'display', 'participant']) assert.equal(project(r.state, role, a).caseTitle, 'Mini case');
  r.f('start'); r.toOpenRound();
  assert.ok(project(r.state, 'display').timer.endsAt);
  r.f('lock');
  assert.equal(project(r.state, 'display').timer, null);
});

test('[AS-010] [CASE-255] a legacy room paused with a timer shows it frozen and restarts it from the frozen value on resume', () => {
  const { doc } = miniCase();
  doc.decisions[0].timer_s = 60;
  const r = room(doc);
  const a = r.join();
  r.f('start'); r.toOpenRound();
  r.legacyPause();
  const frozen = project(r.state, 'participant', a).timer;
  assert.equal(frozen.paused, true);
  r.f('resume');
  assert.equal(r.state.timer.durationS, frozen.remainingS);
  assert.ok(project(r.state, 'display').timer.endsAt);
});

test('[AS-017] [AS-018] recap: labels, what happened, learning points and a 24 h expiry; no other participant data', () => {
  const { doc, o, p } = miniCase();
  const r = room(doc);
  const a = r.join('A');
  const b2 = r.join('B');
  r.f('start'); r.toOpenRound();
  r.vote(a, { option_id: o.decompress });
  r.vote(b2, { option_id: o.image });
  r.f('lock'); r.f('select_path', { pathId: p.decompress }); r.f('show_results', { on: false }); r.f('reveal');
  r.f('end');
  const recap = project(r.state, 'participant', a).recap;
  assert.equal(recap.rounds[0].yourAnswer, 'Decompress the right chest');
  assert.equal(recap.rounds[0].whatHappened, 'Partial response');
  assert.deepEqual(recap.learningPoints, doc.learning_objectives);
  assert.equal(Date.parse(recap.expiresAt) - Date.parse(r.state.endedAt), 24 * 3600 * 1000);
  // Room PDFs v2: the round's `room` split is the shown result (counts and the option labels every phone already saw), never
  // another phone's answer; it is checked on its own, and everything else still carries no trace of the other answer.
  const { room: split, ...mine } = recap.rounds[0];
  assert.ok(!JSON.stringify({ ...recap, rounds: [mine] }).includes('Chest X-ray first'), 'another participant\'s answer leaked into a recap');
  assert.deepEqual(Object.keys(split).sort(), ['options', 'total']);
  assert.equal(split.total, 2);
  assert.deepEqual(split.options.map((x) => Object.keys(x).sort().join()), split.options.map(() => 'count,label'));
  assert.deepEqual(split.options.map((x) => x.label), doc.decisions[0].interaction.options.map((x) => x.label));
  assert.equal(split.options.reduce((n, x) => n + x.count, 0), 2);
});

test('[AS-176] the recap carries a round\'s room split only when the projector drew that result', () => {
  const { doc, o, p } = miniCase();
  const r = room(doc), a = r.join('A'), b = r.join('B');
  r.f('start'); r.toOpenRound(); r.vote(a, { option_id: o.decompress }); r.vote(b, { option_id: o.decompress });
  assert.equal(project(r.state, 'participant', a).recap, null, 'no recap, and so no split, before End');
  r.f('lock'); r.f('select_path', { pathId: p.decompress }); r.f('show_results', { on: false }); r.f('reveal'); r.f('end');
  const shown = project(r.state, 'participant', a).recap.rounds[0];
  assert.ok(r.state.rounds[0].shown, 'the projector drew the locked result');
  assert.deepEqual(shown.room.options.find((x) => x.label === 'Decompress the right chest')?.count, 2);
  // The same room had the projector never drawn that result (r.shown false): the split stays out.
  const unseen = { ...r.state, rounds: r.state.rounds.map((x) => ({ ...x, shown: false })) };
  assert.equal(project(unseen, 'participant', a).recap.rounds[0].room, undefined, 'a result the room never saw stays out of the recap');
});

// Red-team of #307 (2026-10-18, P2): mutants that dropped the resolved check, allowed free text or sent ranking positions.
const endedTyped = (interaction, rules, responses) => {
  const { doc, p } = miniCase();
  const d = doc.decisions[0];
  if (interaction) { d.interaction = { ...d.interaction, ...interaction }; d.paths.forEach((x) => { delete x.option_ids; }); d.rules = rules(d, p); }
  const r = room(doc), phones = responses(d).map(() => r.join());
  r.f('start'); r.toOpenRound();
  responses(d).forEach((response, i) => assert.equal(r.receipt(r.vote(phones[i], response)), 'accepted'));
  r.f('lock'); r.f('select_path', { pathId: p.decompress }); r.f('show_results', { on: false }); r.f('reveal'); r.f('end');
  return { r, d, a: phones[0] };
};
const optionIds = (d) => d.interaction.options.map((x) => x.id);

test('[AS-176] a shown round that is no longer resolved (reopened, then superseded) carries no split', () => {
  const { r, a } = endedTyped(null, null, (d) => [{ option_id: optionIds(d)[0] }, { option_id: optionIds(d)[1] }]);
  assert.ok(project(r.state, 'participant', a).recap.rounds[0].room, 'the resolved, shown round carries its split');
  for (const status of ['superseded', 'abandoned']) {
    const state = { ...r.state, rounds: r.state.rounds.map((x, i) => (i ? x : { ...x, status })) };
    const rounds = project(state, 'participant', a).recap.rounds;
    assert.ok(rounds.every((x) => x.room === undefined), `a ${status} round never carries the room's split`);
  }
});

test('[AS-176] a free-text round never carries a split, even shown and with an aggregate', () => {
  const { r, a } = endedTyped({ type: 'free_text', max_length: 120 }, (d, p) => [{ when: { keywords: ['fast'] }, path_id: p.decompress }],
    () => [{ text: 'decompress fast' }, { text: 'chest x-ray first' }]);
  const state = { ...r.state, rounds: r.state.rounds.map((x, i) => (i ? x : { ...x, shown: true, aggregate: x.aggregate ?? { total: 2, counts: {} } })) };
  const round = project(state, 'participant', a).recap.rounds[0];
  assert.equal(round.room, undefined);
  assert.ok(!JSON.stringify(project(state, 'participant', a).recap).includes('chest x-ray'), 'another phone\'s text never reaches a recap');
});

test('[AS-176] a ranking\'s split counts first places only, as integers, never position arrays', () => {
  const { r, d, a } = endedTyped({ type: 'ranking', rank_count: 3 }, (d, p) => [{ when: { top: [optionIds(d)[1]] }, path_id: p.decompress }],
    (d) => { const [x, y, z] = optionIds(d); return [{ order: [y, x, z] }, { order: [y, z, x] }, { order: [z, y, x] }]; });
  const { room: split } = project(r.state, 'participant', a).recap.rounds[0];
  assert.equal(split.total, 3);
  assert.deepEqual(split.options.map((x) => x.label), d.interaction.options.map((x) => x.label));
  assert.deepEqual(split.options.map((x) => x.count), [0, 2, 1], 'first places: two for the second option, one for the third');
  assert.ok(split.options.every((x) => Number.isInteger(x.count)), 'a count, never an array of positions');
});

// ── regressions from the 2026-10-01 red team (docs/red-team/2026-10-01-spec-red-team.md) ──
test('[RT] invalid or out-of-range times are rejected; earlier device times are clamped (monotonic)', () => {
  const r = room();
  r.join();
  const before = r.state;
  for (const at of ['2026-99-99T99:99:99Z', 'yesterday', '1999-01-01T00:00:00Z']) {
    const res = reduce(r.state, { type: 'start', epoch: 0, actor: { role: 'facilitator' }, at, roundId: uuidv7(), clientEventId: uuidv7() });
    assert.equal(res.effects[0].reason, 'bad_time', at);
  }
  assert.equal(r.state, before);
  r.f('start');
  const last = r.state.lastAt;
  const res = reduce(r.state, { type: 'advance', epoch: 0, actor: { role: 'facilitator' }, at: '2021-01-01T00:00:00Z', clientEventId: uuidv7() });
  assert.equal(res.state.lastAt, last, 'a backwards device clock is clamped, never applied');
  assert.ok(project(res.state, 'participant').timer === null || Number.isFinite(project(res.state, 'participant').timer?.remainingS ?? 0));
});

test('[AS-044] control, bidi and NUL characters never reach state, journal or projections', () => {
  const { doc } = miniCase();
  doc.decisions[1].interaction = { type: 'free_text', max_length: 120 };
  delete doc.decisions[1].paths[0].option_ids; delete doc.decisions[1].paths[1].option_ids;
  doc.decisions[1].rules = [{ when: { keywords: ['fast'] }, path_id: doc.decisions[1].paths[0].id }];
  const r = room(doc);
  const a = r.join('A\u0000\u001b[2J‮evil');
  assert.equal(r.state.participants[a].name, 'A [2J evil');
  assert.ok(!/[\u0000-\u001f‮]/.test(JSON.stringify(project(r.state, 'facilitator'))));
});

test('[RT] case content with control or bidi characters fails validation', () => {
  const { doc } = miniCase();
  doc.surfaces[0].points = ['Arrival\u0000'];
  assert.ok(validateCaseDocument(doc).errors.some((e) => e.code === 'unsafe_characters'));
});

test('[RT] a terminal fallback path is refused by the validator', () => {
  const { doc, p } = miniCase();
  doc.decisions[0].fallback_path_id = p.intubate;
  assert.ok(validateCaseDocument(doc).errors.some((e) => e.code === 'terminal_fallback'));
});

test('[RT] resume_online cannot be reached through a pause taken from a manual selection', () => {
  const { p } = miniCase();
  const { doc } = miniCase();
  const r = room(doc);
  r.join();
  r.f('start');
  r.f('enter_manual', { segmentId: uuidv7() });
  r.f('advance');
  r.f('select_path', { pathId: doc.decisions[0].paths[0].id });
  r.legacyPause();
  assert.equal(r.receipt(r.f('resume_online')), 'rejected');
  void p;
});

test('[AS-039] [AS-040] expectRevision fences a stale tab; takeover bumps the epoch', () => {
  const r = room();
  r.join();
  r.f('start');
  const rev = r.state.revision;
  assert.equal(r.receipt(r.f('advance', { expectRevision: rev })), 'accepted');
  assert.equal(r.receipt(r.f('advance', { expectRevision: rev })), 'rejected', 'a delayed duplicate advance from a stale tab');
  const oldEpoch = r.state.epoch;
  r.f('takeover');
  assert.equal(r.state.epoch, oldEpoch + 1);
  assert.equal(r.receipt(r.f('lock', {}, { epoch: oldEpoch })), 'stale_epoch');
});

test('[AS-042] idempotency ledger: payload mismatch is rejected; ids are scoped per sender; state stays small', () => {
  const { doc, o } = miniCase();
  const r = room(doc);
  const a = r.join();
  const b = r.join();
  r.f('start'); r.toOpenRound();
  const cid = uuidv7();
  assert.equal(r.receipt(r.vote(a, { option_id: o.decompress }, { cid })), 'accepted');
  const reused = r.vote(a, { option_id: o.image }, { cid });
  assert.equal(r.receipt(reused), 'rejected');
  assert.equal(reused.effects[0].reason, 'client_event_id_reused');
  assert.equal(r.receipt(r.vote(b, { option_id: o.image }, { cid })), 'accepted', 'another participant may reuse the same id');
  assert.equal(r.state.receipts, undefined, 'receipts live in the ledger, not in reducer state');
});

test('[AS-045] applySegment is all-or-nothing and refuses a reused segment id', () => {
  const { doc } = miniCase();
  const r = room(doc);
  r.join();
  r.f('start');
  const seg = uuidv7();
  const fac = { role: 'facilitator', id: 'fac' };
  const ev = (type, extra = {}, epoch = r.state.epoch) => ({ type, epoch, actor: fac, at: '2026-10-01T10:00:00.000Z', clientEventId: uuidv7(), ...extra });
  const bad = applySegment(r.state, [ev('enter_manual', { segmentId: seg }), ev('lock', {}, 1)], r.ledger);
  assert.equal(bad.ok, false);
  assert.equal(bad.failedAt, 1);
  assert.equal(bad.state, r.state, 'nothing applied');
  const good = applySegment(r.state, [ev('enter_manual', { segmentId: seg }), ev('manual_marker', { text: 'hands up' }, 1), ev('resume_online', {}, 1)], r.ledger);
  assert.equal(good.ok, true);
  const again = applySegment(good.state, [ev('enter_manual', { segmentId: seg }, 2)], new Map());
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'segment_reused');
});

test('[RT] resolution kind: a fallback chosen with no votes or a tie is override, not majority', () => {
  const { doc, o, p } = miniCase();
  const r = room(doc);
  const a = r.join();
  const b = r.join();
  r.f('start'); r.toOpenRound();
  r.f('lock');
  r.f('select_path', { pathId: p.decompress });
  assert.equal(r.state.resolutionKind, 'override');
  r.f('back_to_review'); r.f('reopen');
  r.vote(a, { option_id: o.decompress }); r.vote(b, { option_id: o.image });
  r.f('lock');
  assert.equal(r.state.round.suggestion.kind, 'tie');
  r.f('select_path', { pathId: p.decompress });
  assert.equal(r.state.resolutionKind, 'minority');
});

test('[AS-013] a vote for a voided round is told so', () => {
  const { doc, o } = miniCase();
  const r = room(doc);
  const a = r.join();
  r.f('start'); r.toOpenRound();
  const voided = r.state.round.id;
  r.f('void_round');
  const res = r.vote(a, { option_id: o.decompress }, { roundId: voided });
  assert.equal(res.effects[0].reason, 'round_voided');
});

test('[CASE-255] while a legacy room is paused the display keeps the options but no count', () => {
  const r = room();
  r.join();
  r.f('start'); r.toOpenRound();
  r.legacyPause();
  assert.equal(project(r.state, 'display').decision.status, 'paused');
  assert.equal(project(r.state, 'display').counts.responded, null);
  r.f('resume');
  assert.equal(project(r.state, 'display').decision.status, 'open');
});

test('[AS-049] manual marker text stays out of the journal', () => {
  const r = room();
  r.join();
  r.f('start');
  r.f('enter_manual', { segmentId: uuidv7() });
  const res = r.f('manual_marker', { text: 'Dr Smith, patient John Doe' });
  assert.ok(!JSON.stringify(res.effects).includes('John Doe'));
});

test('[AS-039] [AS-041] [AS-050] joins are not epoch-fenced; close_joining stops new joins', () => {
  const r = room();
  r.join();
  r.f('start');
  r.f('enter_manual', { segmentId: uuidv7() });
  const late = uuidv7();
  const res = r.send('join', { displayName: 'Late' }, { role: 'participant', id: late }, { epoch: 0 });
  assert.equal(r.receipt(res), 'accepted');
  r.f('close_joining', { closed: true });
  assert.equal(r.receipt(r.send('join', {}, { role: 'participant', id: uuidv7() })), 'rejected');
  assert.equal(project(r.state, 'display').joiningClosed, true, 'the projector hides its join route');
});

test('[RT] votes and joins broadcast to facilitator and display only', () => {
  const { doc, o } = miniCase();
  const r = room(doc);
  const a = r.join();
  r.f('start'); r.toOpenRound();
  const res = r.vote(a, { option_id: o.decompress });
  assert.deepEqual(res.effects.find((e) => e.type === 'broadcast').roles, ['facilitator', 'display']);
  assert.deepEqual(r.f('lock').effects.find((e) => e.type === 'broadcast').roles, ['facilitator', 'display', 'participant']);
});

test('[AS-043] reducer state survives a JSON round trip (DO meta.state rebuild) with identical projections', () => {
  const { doc, o, p } = miniCase();
  const r = room(doc);
  const a = r.join();
  r.f('start'); r.toOpenRound();
  r.vote(a, { option_id: o.intubate });
  r.f('lock'); r.f('select_path', { pathId: p.intubate }); r.f('show_results', { on: false }); r.f('reveal');
  r.f('show_names', { on: true });
  const { caseDoc, ...persisted } = r.state;
  const rebuilt = { ...JSON.parse(JSON.stringify(persisted)), caseDoc: JSON.parse(JSON.stringify(caseDoc)) };
  for (const role of ['facilitator', 'display', 'participant']) {
    assert.deepEqual(project(rebuilt, role, a), project(r.state, role, a), role);
  }
  let after = reduce(rebuilt, { type: 'reset_checkpoint', epoch: rebuilt.epoch, actor: { role: 'facilitator' }, at: '2026-10-01T12:00:00Z', roundId: uuidv7(), clientEventId: uuidv7() });
  while (after.state.phase === 'surface_live' && after.state.decisionId) {
    after = reduce(after.state, { type: 'advance', epoch: after.state.epoch, actor: { role: 'facilitator' }, at: '2026-10-01T12:00:01Z', roundId: uuidv7(), clientEventId: uuidv7() });
  }
  assert.equal(after.state.phase, 'responses_open');
  assert.ok(project(after.state, 'participant', a).decision.interaction.options.find((x) => x.id === o.intubate).disabled);
});

// ── teaching rulings (CASE-080..083) ─────────────────────────────────────────
test('[AS-046] after a reveal the room sees the split and how the path was chosen; never during a vote', () => {
  const { doc, o, p } = miniCase();
  const r = room(doc);
  const a = r.join();
  const b = r.join();
  r.f('start'); r.toOpenRound();
  r.vote(a, { option_id: o.decompress }); r.vote(b, { option_id: o.image });
  assert.equal(project(r.state, 'display').lastResult, null);
  r.f('lock');
  assert.equal(project(r.state, 'display').lastResult, null, 'not while the facilitator reviews');
  r.f('select_path', { pathId: p.image });
  r.f('show_results', { on: false }); r.f('reveal'); r.f('show_results', { on: true });
  const res = project(r.state, 'display').lastResult;
  assert.equal(res.total, 2);
  assert.equal(res.counts.find((c) => c.optionId === o.decompress).count, 1);
  assert.equal(res.howChosen, 'minority');
  assert.equal(project(r.state, 'participant', a).lastResult.yourAnswer, 'Decompress the right chest');
  r.f('show_results', { on: false }); r.f('advance');
  assert.equal(project(r.state, 'display').lastResult, null, 'hidden again once the next vote opens');
});

test('[AS-052] [AS-053] [AS-054] one option order for every screen; the projector always shows the options in play (CASE-088/089)', () => {
  const { doc, o, p } = miniCase();
  const r = room(doc);
  const ids = Array.from({ length: 6 }, () => r.join());
  const authored = doc.decisions[0].interaction.options.map((x) => x.id);
  r.f('start');
  assert.equal(project(r.state, 'display').decision, null, 'no options before the decision opens');
  r.toOpenRound();
  for (const id of ids) assert.deepEqual(project(r.state, 'participant', id).decision.interaction.options.map((x) => x.id), authored);
  assert.deepEqual(project(r.state, 'facilitator').decision.interaction.options.map((x) => x.id), authored);
  const open = project(r.state, 'display');
  assert.deepEqual(open.decision.interaction.options.map((x) => x.id), authored);
  assert.equal(open.decision.status, 'open');
  assert.equal(open.counts.responded, 0, 'the answered count is public while open');
  r.vote(ids[0], { option_id: o.decompress });
  assert.equal(project(r.state, 'display').counts.responded, 1);
  r.f('lock');
  const locked = project(r.state, 'display');
  assert.equal(locked.decision.status, 'locked');
  assert.ok(!JSON.stringify(locked).includes('"aggregate"') && !JSON.stringify(locked.decision).includes('count'), 'no split before the reveal');
  r.f('select_path', { pathId: p.decompress });
  assert.deepEqual(project(r.state, 'display').decision, locked.decision, 'a chosen route changes nothing on the projector');
  r.f('show_results', { on: false }); r.f('reveal');
  assert.equal(project(r.state, 'display').decision, null, 'after the reveal the room result takes over');
});

test('[AS-055] observations carry a trend against the last scene the room saw (CASE-090)', () => {
  const { doc } = miniCase();
  doc.surfaces[1].observations = [{ label: 'HR', value: '130' }, { label: 'BP', value: '80/50' }];
  doc.surfaces[2].observations = [{ label: 'HR', value: '118' }, { label: 'BP', value: '98/62' }, { label: 'GCS', value: '15' }];
  const r = room(doc);
  r.join();
  r.f('start'); r.toOpenRound();
  const first = project(r.state, 'display').surface.observations;
  assert.deepEqual(first.map((x) => x.trend), [null, null], 'nothing to compare with yet');
  r.f('lock'); r.f('select_path', { pathId: miniCaseIds(doc).decompress }); r.f('show_results', { on: false }); r.f('reveal');
  const after = project(r.state, 'display').surface.observations;
  assert.deepEqual(after.map((x) => [x.label, x.trend, x.previous]), [['HR', 'down', '130'], ['BP', 'up', '80/50'], ['GCS', null, null]]);
});

test('[AS-051] surface notes reach the facilitator only (CASE-087)', () => {
  const { doc } = miniCase();
  doc.surfaces[0].notes = 'Private narrative for the facilitator.';
  const r = room(doc);
  const a = r.join();
  r.f('start');
  assert.equal(project(r.state, 'facilitator').liveSurface.notes, 'Private narrative for the facilitator.');
  assert.ok(!JSON.stringify(project(r.state, 'display')).includes('Private narrative'));
  assert.ok(!JSON.stringify(project(r.state, 'participant', a)).includes('Private narrative'));
});

test('[AS-015] [AS-048] explored terminal options stay visible, locked and labelled', () => {
  const { doc, o, p } = miniCase();
  const r = room(doc);
  const a = r.join();
  r.f('start'); r.toOpenRound();
  r.vote(a, { option_id: o.intubate });
  r.f('lock'); r.f('select_path', { pathId: p.intubate }); r.f('show_results', { on: false }); r.f('reveal'); r.f('reset_checkpoint');
  r.toOpenRound();
  const opt = project(r.state, 'participant', a).decision.interaction.options.find((x) => x.id === o.intubate);
  assert.equal(opt.explored, true);
  assert.equal(opt.disabled, true);
});

test('[AS-047] the recap teaches with the participant\'s own classification only', () => {
  const { doc, o, p } = miniCase();
  const r = room(doc);
  const a = r.join();
  const b = r.join();
  r.f('start'); r.toOpenRound();
  r.vote(a, { option_id: o.image }); r.vote(b, { option_id: o.decompress });
  r.f('lock'); r.f('select_path', { pathId: p.decompress }); r.f('show_results', { on: false }); r.f('reveal');
  r.f('end');
  const ra = project(r.state, 'participant', a).recap.rounds[0];
  assert.equal(ra.yourClassification, 'unsafe');
  assert.equal(ra.why, 'Delays treatment.');
  assert.match(ra.doDifferently, /Recommended here: Decompress the right chest/);
  const rb = project(r.state, 'participant', b).recap.rounds[0];
  assert.equal(rb.yourClassification, 'sound');
  assert.equal(rb.doDifferently, null);
  assert.ok(!JSON.stringify(project(r.state, 'participant', b).recap).includes('Delays treatment'), 'no other participant\'s path rationale');
});

test('[RT] a room holds at most MAX_PARTICIPANTS entries; a self-rename is quiet for phones', () => {
  const r = room();
  for (let i = 0; i < MAX_PARTICIPANTS; i++) r.join();
  assert.equal(r.send('join', {}, { role: 'participant', id: uuidv7() }).effects[0].reason, 'room_full');
  const pid = Object.keys(r.state.participants)[0];
  const res = r.send('rename', { displayName: 'New' }, { role: 'participant', id: pid });
  assert.deepEqual(res.effects.find((e) => e.type === 'broadcast').roles, ['facilitator', 'display']);
});

// ── spec red team 2 and the walkthrough (docs/red-team/2026-10-01-spec-red-team-2.md) ──
test('[AS-054] no answered count while names are on the projector (RT2 P2)', () => {
  const { doc, o } = miniCase();
  const r = room(doc);
  const a = r.join('Sam');
  r.f('start'); r.toOpenRound();
  r.vote(a, { option_id: o.decompress });
  assert.equal(project(r.state, 'display').counts.responded, 1);
  r.f('show_names', { on: true });
  const d = project(r.state, 'display');
  assert.deepEqual(d.names, [{ name: 'Sam', avatarId: null }]);
  assert.equal(d.counts.responded, null, 'names plus a count would show who has not answered');
});

test('[AS-054] the answered count is out of the connected participants, passed in as presence (RT2 P1-7)', () => {
  const { doc, o } = miniCase();
  const r = room(doc);
  const [a, b, c] = [r.join(), r.join(), r.join()];
  r.f('start'); r.toOpenRound();
  r.vote(c, { option_id: o.decompress }); // c answered, then lost signal
  assert.equal(project(r.state, 'display').counts.present, 3, 'no presence input: everyone counts (lab, rebuild checks)');
  const d = project(r.state, 'display', null, { present: [a] });
  assert.deepEqual([d.counts.responded, d.counts.present, d.counts.participants], [1, 2, 3], 'connected a plus answered c; k never exceeds m');
  assert.equal(project(r.state, 'facilitator', null, { present: [a] }).round.participantCount, 2);
  void b;
});

test('[AS-046] the room result shows only while its consequence is the live surface (walkthrough bug 1)', () => {
  const { doc, o, p } = miniCase();
  const r = room(doc);
  const a = r.join();
  r.f('start'); r.toOpenRound();
  r.vote(a, { option_id: o.decompress });
  r.f('lock'); r.f('select_path', { pathId: p.decompress }); r.f('show_results', { on: false }); r.f('reveal');
  r.toOpenRound();
  r.vote(a, { option_id: o.fast });
  r.f('lock'); r.f('select_path', { pathId: p.fast }); r.f('show_results', { on: false }); r.f('reveal');
  assert.equal(project(r.state, 'participant', a).lastResult.whatHappened, 'Haemorrhage found');
  r.f('advance'); // the debrief surface
  assert.equal(r.state.phase, 'surface_live');
  assert.equal(project(r.state, 'participant', a).lastResult, null, 'the debrief phone no longer shows decision 2\'s result');
  assert.equal(project(r.state, 'display').lastResult, null);
});

test('[AS-046] room-result copy inputs: a split, no answers, multi-select and ranking counts', () => {
  const tie = (() => {
    const { doc, o, p } = miniCase();
    const r = room(doc);
    const [a, b] = [r.join(), r.join()];
    r.f('start'); r.toOpenRound();
    r.vote(a, { option_id: o.decompress }); r.vote(b, { option_id: o.image });
    r.f('lock'); r.f('select_path', { pathId: p.decompress }); r.f('show_results', { on: false }); r.f('reveal');
    return project(r.state, 'participant', a).lastResult;
  })();
  assert.equal(tie.split, true, '1 : 1 is "the room was split", not a majority');
  assert.equal(tie.countMeaning, 'chose');
  assert.deepEqual(tie.yourOptionIds.length, 1);

  const none = (() => {
    const { doc, p } = miniCase();
    const r = room(doc);
    r.join();
    r.f('start'); r.toOpenRound(); r.f('lock'); r.f('select_path', { pathId: p.decompress }); r.f('show_results', { on: false }); r.f('reveal'); r.f('show_results', { on: true });
    return project(r.state, 'display').lastResult;
  })();
  assert.equal(none.total, 0);
  assert.equal(none.split, false);
  assert.equal(none.howChosen, 'override');

  const typed = (interaction, rules, response) => {
    const { doc, p } = miniCase();
    const d = doc.decisions[0];
    d.interaction = { ...d.interaction, ...interaction };
    d.paths.forEach((x) => { delete x.option_ids; });
    d.rules = rules(d, p);
    const r = room(doc);
    const a = r.join();
    r.f('start'); r.toOpenRound();
    assert.equal(r.receipt(r.vote(a, response(d))), 'accepted');
    r.f('lock'); r.f('select_path', { pathId: p.decompress }); r.f('show_results', { on: false }); r.f('reveal');
    return project(r.state, 'participant', a).lastResult;
  };
  const ids = (d) => d.interaction.options.map((x) => x.id);
  const multi = typed({ type: 'multi_select' }, (d, p) => [{ when: { includes_any: [ids(d)[0]] }, path_id: p.decompress }], (d) => ({ option_ids: ids(d).slice(0, 2) }));
  assert.equal(multi.countMeaning, 'selected');
  assert.deepEqual(multi.counts.map((c) => c.count), [1, 1, 0], 'each selection counts: "selected by"');
  assert.equal(multi.split, false, 'multi-select counts are not a split');
  const rank = typed({ type: 'ranking', rank_count: 3 }, (d, p) => [{ when: { top: [ids(d)[1]] }, path_id: p.decompress }], (d) => ({ order: [ids(d)[1], ids(d)[0], ids(d)[2]] }));
  assert.equal(rank.countMeaning, 'ranked_first');
  assert.deepEqual(rank.counts.map((c) => c.count), [0, 1, 0], 'only the first-ranked option counts: "ranked first by"');
  assert.deepEqual(rank.yourOptionIds, [rank.counts[1].optionId]);
});

test('[AS-055] after a checkpoint reset the trend compares with the restored path, not the abandoned scene (walkthrough bug 2)', () => {
  const { doc, o, p } = miniCase();
  doc.surfaces[0].observations = [{ label: 'HR', value: '110' }];
  doc.surfaces[1].observations = [{ label: 'HR', value: '130' }];
  doc.surfaces[4].observations = [{ label: 'HR', value: '0' }]; // the arrest (terminal) scene
  const r = room(doc);
  const a = r.join();
  r.f('start'); r.toOpenRound();
  const first = project(r.state, 'display').surface.observations[0];
  assert.deepEqual([first.trend, first.previous], ['up', '110']);
  r.vote(a, { option_id: o.intubate });
  r.f('lock'); r.f('select_path', { pathId: p.intubate }); r.f('show_results', { on: false }); r.f('reveal');
  assert.equal(project(r.state, 'display').surface.observations[0].trend, 'down', 'the arrest is down from 130');
  r.f('reset_checkpoint');
  const restored = project(r.state, 'display').surface.observations[0];
  assert.deepEqual([restored.trend, restored.previous], ['up', '110'], 'compared with the scene before the checkpoint, as the first time, not HR 0');
  const tl = project(r.state, 'participant', a).timeline;
  assert.equal(tl.at(-1).observations[0].previous, '110');
  assert.equal(tl.at(-2).observations[0].previous, '130', 'the terminal scene keeps its own history');
});

test('[RT2] free text is public only after close; peer phones and participant identities stay private', () => {
  const { doc, p } = miniCase();
  const d = doc.decisions[0];
  d.interaction = { type: 'free_text', max_length: 120 };
  d.paths.forEach((x) => { delete x.option_ids; });
  d.rules = [{ when: { keywords: ['needle'] }, path_id: p.decompress }];
  const r = room(doc);
  const [a, b] = [r.join(), r.join()];
  r.f('start'); r.toOpenRound();
  const words = 'needle now, Mrs Example DOB 03/04/1961';
  assert.equal(r.receipt(r.vote(a, { text: words })), 'accepted');
  const fac = project(r.state, 'facilitator');
  assert.deepEqual(fac.round.responses[0].identifierFlags, ['dob', 'titled_name'], 'flagged for the facilitator, kinds only');
  for (const phase of ['open', 'lock', 'select', 'reveal']) {
    if (phase === 'lock') r.f('lock');
    if (phase === 'select') r.f('select_path', { pathId: p.decompress });
    if (phase === 'reveal') { r.f('show_results', { on: false }); r.f('reveal'); r.f('show_results', { on: true }); }
    const phone = JSON.stringify(project(r.state, 'participant', b));
    assert.ok(!phone.includes('needle now') && !phone.includes('Example'), `${phase}: peer phone received text`);
    const display = project(r.state, 'display');
    if (phase === 'open') assert.equal(JSON.stringify(display).includes(words), false);
    else { assert.deepEqual(display.responseResult.textPage.answers, [words]); assert.equal(display.names, null); }
    assert.equal(JSON.stringify(display).includes(a), false, 'no response-to-participant link');
  }
  const res = project(r.state, 'display').lastResult;
  assert.deepEqual([res.countMeaning, res.counts], [null, []]);
  assert.equal(project(r.state, 'participant', a).lastResult.youAnswered, true);
});

test('[RT2] free-text responses accept 500 characters and reject 501 without truncating', () => {
  const makeRoom = () => {
    const { doc } = miniCase();
    const decision = doc.decisions[0];
    decision.interaction = { type: 'free_text', max_length: 500 };
    decision.paths.forEach(path => { delete path.option_ids; });
    decision.rules = [];
    const r = room(doc);
    const participant = r.join();
    r.f('start'); r.toOpenRound();
    return { r, participant };
  };
  const accepted = makeRoom();
  assert.equal(accepted.r.receipt(accepted.r.vote(accepted.participant, { text: 'x'.repeat(500) })), 'accepted');
  assert.equal(project(accepted.r.state, 'facilitator').round.responses[0].response.text.length, 500);

  const rejected = makeRoom();
  assert.equal(rejected.r.receipt(rejected.r.vote(rejected.participant, { text: 'x'.repeat(501) })), 'rejected');
  assert.equal(project(rejected.r.state, 'facilitator').round.responses.length, 0, 'overlong input is not silently truncated or stored');
});
