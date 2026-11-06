// RT-04: expected visibility is a test-owned per-occurrence ledger. Do not import
// presentation group/projector helpers or derive expectations from reducer projections.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uuidv7 } from '../src/shared/ids.mjs';
import { initialState, dispatch, project, applySegment, COMMANDS } from '../src/shared/room-machine.mjs';
import { validateCaseDocument } from '../src/shared/case-document.mjs';
import { snapshotBody } from '../src/shared/wire.mjs';
import { assertPublicDisclosure } from './helpers/public-disclosure.mjs';
import { miniCase } from './helpers/mini-case.mjs';
import { legacyPausedState } from './helpers/legacy-pause.mjs';

const FAC = { role: 'facilitator', id: 'facilitator' };
const GROUPS = ['scene', 'observations', 'findings', 'investigations'];
function random(seed) {
  let value = seed >>> 0;
  return () => { value ^= value << 13; value ^= value >>> 17; value ^= value << 5; return value >>> 0; };
}
function fixture(seed) {
  const f = miniCase(), next = random(seed), expected = new Map(), secrets = [];
  for (const [index, surface] of f.doc.surfaces.entries()) {
    const prefix = `RT04_SURFACE_${index}_`;
    // Start/context/terminal have at least two groups; remaining empty/populated masks vary.
    const mask = index === 0 || index === 1 || index === 4 ? (next() % 16) | 5 : (next() % 16) | 4;
    const groups = GROUPS.filter((_, bit) => mask & (1 << bit));
    if (groups.includes('scene')) surface.scene = `${prefix}SCENE_END`;
    if (groups.includes('observations')) surface.observations = [{ label: `${prefix}OBS_LABEL_END`, value: `${prefix}OBS_VALUE_END` }];
    surface.points = [`${prefix}FINDING_END`];
    if (groups.includes('investigations')) surface.investigations = [`${prefix}INVESTIGATION_END`];
    surface.notes = `${prefix}PRIVATE_NOTE_END`;
    surface.asset_ids = [uuidv7()];
    expected.set(surface.id, { surface, groups });
    secrets.push(surface.notes, ...surface.asset_ids);
  }
  for (const [index, path] of f.doc.decisions.flatMap(d => d.paths).entries()) {
    path.cue = `RT04_PRIVATE_CUE_${index}_END`;
    path.rationale = `RT04_PRIVATE_RATIONALE_${index}_END`;
    secrets.push(path.cue, path.rationale);
  }
  assert.equal(validateCaseDocument(f.doc).ok, true, 'randomized authored fixture is legal');
  return { ...f, expected, secrets, next };
}
function room(f) {
  let state = initialState({ sessionId: uuidv7(), joinCode: '7K3QX9', caseDoc: f.doc });
  const ledger = new Map(), entries = [], participants = [uuidv7(), uuidv7()], joined = new Set(), counters = {
    accepted: 0, partial: 0, repeated: 0, replay: 0, manual: 0, rebuild: 0,
  };
  let clock = Date.UTC(2026, 9, 3), cursor = null;
  const event = (type, extra = {}, epoch = state.epoch) => ({ type, epoch, actor: FAC,
    at: new Date(clock += 1000).toISOString(), clientEventId: uuidv7(), ...extra });
  function append(surfaceId, manual = false, timelineKind = 'live') {
    if (entries.some(entry => entry.surfaceId === surfaceId)) counters.repeated++;
    entries.push({ surfaceId, shown: Math.min(1, f.expected.get(surfaceId).groups.length), manual,
      at: new Date(clock).toISOString(), timelineKind });
  }
  function expectedSurface(entry) {
    if (!entry) return null;
    const { surface, groups } = f.expected.get(entry.surfaceId);
    const shown = new Set(groups.slice(0, entry.shown));
    return { surfaceId: surface.id, kind: surface.kind, title: surface.title,
      at: entry.at, timelineKind: entry.timelineKind, scene: shown.has('scene') ? surface.scene : null,
      observations: shown.has('observations') ? surface.observations.map(o => ({ ...o, trend: null, previous: null })) : [],
      points: shown.has('findings') ? surface.points : [],
      investigations: shown.has('investigations') ? surface.investigations : [], assetIds: [], manual: entry.manual };
  }
  function compare(actual, entry, context) {
    const expected = expectedSurface(entry);
    if (!expected) { assert.equal(actual, null, context); return; }
    assert.ok(actual, context);
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(actual[key], value, `${context}.${key}`);
    assert.equal(Object.hasOwn(actual, 'notes'), false, `${context}.notes`);
  }
  function check() {
    assert.equal(state.revealed.length, entries.length, 'test ledger occurrence count');
    for (const [index, entry] of entries.entries()) {
      assert.equal(state.revealed[index].groupsShown, entry.shown, `authority reveal count ${index}`);
      if (entry.shown > 0 && entry.shown < f.expected.get(entry.surfaceId).groups.length) counters.partial++;
    }
    const display = project(state, 'display'), fac = project(state, 'facilitator');
    const selected = entries[cursor ?? entries.length - 1] ?? null;
    compare(display.surface, selected, `display occurrence ${cursor ?? entries.length - 1}`);
    compare(fac.publicDisplaySurface, selected, 'facilitator room-visible surface');
    for (const pid of joined) {
      const phone = project(state, 'participant', pid);
      assert.equal(phone.timeline.length, entries.length, 'phone occurrence count');
      phone.timeline.forEach((surface, index) => compare(surface, entries[index], `phone timeline ${index}`));
      compare(phone.liveSurface, entries.at(-1), 'phone live surface');
      assert.equal(phone.you.id, pid);
      // This is the serialized snapshot/frame payload, not DOM text. Across all entries,
      // a previously public marker may remain public while its new occurrence is withheld.
      // Exact per-entry comparisons above catch that leak; this global check catches unknown
      // surfaces/private markers and additional public fields outside the surface schema.
      const allowed = new Set(entries.flatMap(entry => {
        const expected = expectedSurface(entry);
        return [expected.scene, ...expected.observations.flatMap(o => [o.label, o.value]),
          ...expected.points, ...expected.investigations].filter(Boolean);
      }));
      for (const payload of [snapshotBody(state, display), snapshotBody(state, phone),
        { publicDisplaySurface: fac.publicDisplaySurface }]) {
        assertPublicDisclosure(payload, f.secrets);
        const json = JSON.stringify(payload);
        for (const secret of f.secrets) assert.ok(!json.includes(secret), `serialized public payload leaked ${secret}`);
        for (const { surface } of f.expected.values()) {
          const markers = [surface.scene, ...(surface.observations ?? []).flatMap(o => [o.label, o.value]),
            ...surface.points, ...(surface.investigations ?? [])].filter(Boolean);
          for (const marker of markers) if (!allowed.has(marker)) assert.ok(!json.includes(marker), `unrevealed marker ${marker}`);
        }
        assert.doesNotMatch(json, /"suggestion"|"classification"|"cue"|"notes"/);
      }
      assert.ok(!JSON.stringify(phone).includes(participants.find(other => other !== pid)), 'another participant identity');
    }
  }
  function send(type, extra = {}, update = () => {}) {
    const result = dispatch(state, event(type, extra), ledger);
    const receipt = result.effects.find(effect => effect.type === 'receipt');
    assert.equal(receipt?.receipt, 'accepted', `${type}: ${receipt?.reason ?? receipt?.receipt}`);
    state = result.state; counters.accepted++;
    if (type === 'join') joined.add(extra.actor.id);
    update(); check();
  }
  for (const pid of participants) send('join', { actor: { role: 'participant', id: pid }, displayName: 'Synthetic' });
  return {
    get state() { return state; }, entries, counters, participants, append, send, check,
    /** A room persisted while paused before CASE-255 retired Pause for discussion. */
    legacyPause() { state = legacyPausedState(state, new Date(clock += 1000).toISOString()); counters.accepted++; check(); },
    advanceGroup() { send('advance', { roundId: uuidv7() }, () => entries.at(-1).shown++); },
    complete() { while (entries.at(-1).shown < f.expected.get(entries.at(-1).surfaceId).groups.length) this.advanceGroup(); },
    replay(index) { send('replay', { entryIndex: index }, () => { cursor = index; counters.replay++; }); },
    hide() { if (COMMANDS.show_results) send('show_results', { on: false }); },
    rebuild() { const { caseDoc, ...persisted } = state; state = { ...JSON.parse(JSON.stringify(persisted)), caseDoc }; counters.rebuild++; check(); },
    segment() {
      const events = [event('enter_manual', { segmentId: uuidv7() }), event('advance', {}, state.epoch + 1),
        event('resume_online', {}, state.epoch + 1)];
      const result = applySegment(state, events, ledger);
      assert.equal(result.ok, true, result.reason);
      assert.equal(result.effects.filter(effect => effect.type === 'receipt' && effect.receipt === 'accepted').length, 3);
      state = result.state; counters.accepted += 3; counters.manual++;
      entries.at(-1).shown++; check();
    },
  };
}

// Independent schedules force valid accepted paths; randomness selects populated masks,
// reveal interruption points, optional legacy pause/rebuilds, repeated replay targets and votes.
test('[AS-084] [AS-085] RT04 randomized online disclosure oracle checks each repeated checkpoint occurrence and replay payload', () => {
  const coverage = { accepted: 0, partial: 0, repeated: 0, replay: 0, rebuild: 0 };
  for (let seed = 1; seed <= 40; seed++) {
    const f = fixture(seed), r = room(f);
    r.send('start', {}, () => r.append(f.s.open));
    if (f.next() % 2) { r.legacyPause(); r.send('resume'); }
    r.complete(); r.send('advance', { roundId: uuidv7() }, () => r.append(f.s.d1ctx));
    r.complete(); r.send('advance', { roundId: uuidv7() });
    const option = [f.o.decompress, f.o.image, f.o.intubate][f.next() % 3];
    r.send('vote', { actor: { role: 'participant', id: r.participants[0] }, roundId: r.state.round.id,
      responseId: uuidv7(), response: { option_id: option } });
    r.send('lock'); r.hide(); r.send('select_path', { pathId: f.p.intubate });
    r.send('reveal', {}, () => r.append(f.s.arrest, false, 'terminal'));
    const terminal = r.entries.length - 1;
    // Leave the terminal partial, then enter a fresh occurrence of the same context.
    r.send('reset_checkpoint', { roundId: uuidv7() }, () => r.append(f.s.d1ctx));
    r.replay(terminal); r.rebuild(); r.replay(1);
    r.advanceGroup(); // phones advance the new context, while old display occurrence remains fixed.
    r.replay(null); r.rebuild();
    for (const key of Object.keys(coverage)) coverage[key] += r.counters[key];
  }
  for (const [key, count] of Object.entries(coverage)) assert.ok(count > 0, `non-vacuous ${key} coverage`);
  console.log(JSON.stringify({ rt04: 'online', seeds: 40, ...coverage }));
});

test('[AS-045] [AS-084] RT04 randomized manual and atomic segment disclosure oracle checks serialized per-entry fields after rebuild', () => {
  const coverage = { accepted: 0, partial: 0, manual: 0, rebuild: 0, replay: 0 };
  for (let seed = 41; seed <= 80; seed++) {
    const f = fixture(seed), r = room(f);
    r.send('start', {}, () => r.append(f.s.open));
    r.segment(); r.rebuild(); r.complete();
    r.send('enter_manual', { segmentId: uuidv7() }, () => r.counters.manual++);
    r.send('advance', {}, () => r.append(f.s.d1ctx, true)); r.complete();
    const path = f.next() % 2 ? f.p.decompress : f.p.image;
    const surface = path === f.p.decompress ? f.s.partial : f.s.delay;
    r.send('select_path', { pathId: path }); r.send('reveal', {}, () => r.append(surface, true, 'consequence'));
    r.replay(0); r.rebuild(); r.replay(null);
    r.send('resume_online'); r.rebuild();
    for (const key of Object.keys(coverage)) coverage[key] += r.counters[key];
  }
  for (const [key, count] of Object.entries(coverage)) assert.ok(count > 0, `non-vacuous ${key} coverage`);
  console.log(JSON.stringify({ rt04: 'manual', seeds: 40, ...coverage }));
});
