// Stage C room lab: the simulated Durable Object, the client bus and the facilitator's local
// authority, wired together over a real BroadcastChannel exactly as the lab page wires them.
// Guards the mockups against drift in room-machine.mjs and wire.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SimRoom } from '../prototypes/room/lib/sim-do.mjs';
import { connect, CHANNEL } from '../prototypes/room/lib/bus.mjs';
import { LocalAuthority } from '../prototypes/room/lib/local-authority.mjs';
import { demoInteractionsCase } from '../prototypes/room/lib/demo-interactions.mjs';
import { validateCaseDocument } from '../src/shared/case-document.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
import { AVATAR_IDS } from '../src/shared/participant.mjs';

const fixture = () => JSON.parse(readFileSync(new URL('../src/fixtures/synthetic-workshop.case.json', import.meta.url), 'utf8'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await wait(10); }
  assert.fail('condition not met in time');
}

/** A minimal lab router: what index.html does, minus the UI. */
function lab(caseDoc) {
  const ch = new BroadcastChannel(CHANNEL);
  const down = new Set();
  const room = new SimRoom({ caseDoc, send: (id, raw) => { if (!down.has(id)) ch.postMessage({ k: 'down', clientId: id, raw }); } });
  ch.onmessage = async ({ data: m }) => {
    if (m.k === 'up' && !down.has(m.clientId)) room.receive(m.clientId, m.raw);
    if (m.k === 'presence' && m.role !== 'participant') ch.postMessage({ k: 'credential', clientId: m.clientId, token: await room.issueCredential(m.role) });
  };
  const links = [];
  return {
    room, down,
    connect: (o) => { const l = connect(o); links.push(l); return l; },
    close: () => { for (const l of links) l.close(); ch.close(); },
  };
}

/** Walk the authored presentation one populated group at a time before the decision opens. */
async function openPreparedDecision(fac, room) {
  for (let n = 0; n < 20 && room.state.phase !== 'responses_open'; n++) {
    assert.equal((await fac.send('advance')).receipt, 'accepted');
  }
  assert.equal(room.state.phase, 'responses_open', 'context must finish before voting');
}

test('the demo case covers the three non-single-choice interaction types and validates', () => {
  const doc = demoInteractionsCase();
  assert.deepEqual(validateCaseDocument(doc).errors, []);
  assert.deepEqual(doc.decisions.map((d) => d.interaction.type), ['multi_select', 'ranking', 'free_text']);
});

test('[AS-001] [AS-028] [AS-033] [AS-034] [AS-040] [AS-045] [AS-049] room lab: join, vote, partial outage, manual segment, eviction rebuild', async () => {
  const L = lab(fixture());
  try {
    const fac = L.connect({ role: 'facilitator' });
    const disp = L.connect({ role: 'display' });
    const ph = L.connect({ role: 'participant', slot: 'T1' });
    await until(() => fac.snapshot && disp.snapshot && fac.casePack);
    assert.equal(fac.snapshot.view.phase, 'lobby');
    assert.ok(fac.snapshot.mirror, 'the console holds full state for manual mode');
    assert.equal(disp.snapshot.mirror, undefined, 'only the console gets the mirror');

    const j = await ph.join(L.room.state.joinCode.toLowerCase(), 'Sam', AVATAR_IDS[0]);
    assert.ok(j.ok, j.error);
    await until(() => ph.snapshot);

    assert.equal((await fac.send('start')).receipt, 'accepted');
    await until(() => fac.snapshot.view.phase === 'surface_live');
    await openPreparedDecision(fac, L.room);
    await until(() => ph.snapshot.view.decision?.status === 'open');
    const d = ph.snapshot.view.decision;
    assert.equal((await ph.send('vote', { roundId: d.roundId, response: { option_id: d.interaction.options[0].id } })).receipt, 'accepted');

    // A stale console revision is fenced, and a delayed duplicate advance changes nothing.
    const stale = await fac.sendFrame({ v: 1, t: 'command', type: 'lock', epoch: 0, clientEventId: uuidv7(), expectRevision: 0 });
    assert.equal(stale.reason, 'stale_revision');
    const revBefore = L.room.state.revision;
    const dup = await fac.sendFrame({ v: 1, t: 'command', type: 'advance', epoch: 0, clientEventId: uuidv7(), expectRevision: 1 });
    assert.equal(dup.reason, 'stale_revision');
    assert.equal(L.room.state.revision, revBefore);

    // The console loses its link and runs manual mode locally; phones keep voting meanwhile.
    L.down.add(fac.clientId);
    const la = new LocalAuthority(fac.snapshot.mirror, fac.casePack);
    assert.equal(la.enter().receipt, 'accepted');
    const rec = la.view().decision.paths.find((p) => p.recommended);
    assert.equal(la.command('select_path', { pathId: rec.id }).receipt, 'accepted');
    assert.equal(la.command('reveal').receipt, 'accepted');
    assert.equal(la.command('manual_marker', { text: 'show of hands' }).receipt, 'accepted');
    assert.equal(la.command('resume_online').receipt, 'accepted');
    assert.equal((await ph.send('vote', { roundId: d.roundId, response: { option_id: d.interaction.options[1].id } })).receipt, 'accepted');
    la.close();

    L.down.delete(fac.clientId);
    assert.ok(la.segmentBody().events.filter((e) => e.type === 'manual_marker').every((e) => e.text === ''), 'marker text never leaves the console');
    const up = await fac.uploadSegment(la.segmentBody());
    assert.equal(up.status, 200, JSON.stringify(up.body));
    assert.equal(L.room.state.phase, 'consequence_revealed');
    assert.equal(L.room.state.epoch, 2);
    assert.equal(L.room.state.rounds[0].status, 'abandoned', 'the round open at manual entry is voided; its votes are discarded');
    await until(() => ph.snapshot.view.lastRound?.status === 'abandoned');

    // A retried upload (the first response was lost) is idempotent: same client_event_ids, no change.
    const rev = L.room.state.revision;
    assert.equal((await fac.uploadSegment(la.segmentBody())).status, 200);
    assert.equal(L.room.state.revision, rev);

    // Eviction: rebuild from meta.state gives identical projections, and clients reconnect.
    const ev = await L.room.evict(50);
    assert.ok(ev.identical);
    await until(() => fac.status === 'online' && ph.status === 'online' && disp.status === 'online', 8000);
  } finally {
    L.close();
  }
});

test('[AS-056] the console receives the full state mirror with every facilitator update, and only the console', async () => {
  const L = lab(fixture());
  try {
    const fac = L.connect({ role: 'facilitator' });
    const disp = L.connect({ role: 'display' });
    const ph = L.connect({ role: 'participant', slot: 'M1' });
    await until(() => fac.snapshot && disp.snapshot);
    assert.ok((await ph.join(L.room.state.joinCode, 'Moe', AVATAR_IDS[1])).ok);
    await until(() => ph.snapshot);
    const mirrors = [];
    fac.on('snapshot', (snap) => mirrors.push(snap));
    const stored = () => JSON.parse(L.room.storage.meta.get('state'));
    assert.equal((await fac.send('start')).receipt, 'accepted');
    await until(() => fac.snapshot.revision === L.room.state.revision);
    assert.deepEqual(fac.snapshot.mirror, stored(), 'start: the mirror is the stored meta.state');
    for (let n = 0; n < 20 && L.room.state.phase !== 'responses_open'; n++) {
      assert.equal((await fac.send('advance')).receipt, 'accepted');
      await until(() => fac.snapshot.revision === L.room.state.revision);
      assert.deepEqual(fac.snapshot.mirror, stored(), 'each context advance carries the stored meta.state');
    }
    assert.equal(L.room.state.phase, 'responses_open');
    // A participant's vote re-projects the console too, and its mirror moves with it (CASE-077 scope).
    await until(() => ph.snapshot.view.decision?.status === 'open');
    const d = ph.snapshot.view.decision;
    assert.equal((await ph.send('vote', { roundId: d.roundId, response: { option_id: d.interaction.options[2].id } })).receipt, 'accepted');
    await until(() => fac.snapshot.revision === L.room.state.revision);
    assert.deepEqual(fac.snapshot.mirror, stored());
    assert.ok(mirrors.length >= 3 && mirrors.every((m) => m.mirror && m.mirror.revision === m.revision), 'every facilitator snapshot carries a mirror at its own revision');
    assert.equal(disp.snapshot.mirror, undefined);
    assert.equal(ph.snapshot.mirror, undefined);
  } finally {
    L.close();
  }
});

test('[AS-057] [AS-059] a saved manual segment restores on a fresh mirror after a reload; a stale one is never forced; notes stay local', async () => {
  const L = lab(fixture());
  try {
    const fac = L.connect({ role: 'facilitator' });
    await until(() => fac.snapshot && fac.casePack);
    assert.equal((await fac.send('start')).receipt, 'accepted');
    await until(() => fac.snapshot.view.phase === 'surface_live');
    const la = new LocalAuthority(fac.snapshot.mirror, fac.casePack);
    la.enter();
    la.command('manual_marker', { text: 'show of hands: most decompress' });
    const saved = { segmentId: la.segmentId, events: la.events, markers: la.markers };
    la.close();
    // "Reload": a fresh mirror from the server, the segment from session storage.
    const back = LocalAuthority.restore(fac.snapshot.mirror, fac.casePack, structuredClone(saved));
    assert.ok(back.state.manual, 'manual mode is rebuilt');
    assert.equal(back.segmentId, saved.segmentId);
    assert.match(back.notesText(), /Marker: show of hands: most decompress/);
    assert.ok(back.segmentBody().events.every((e) => e.type !== 'manual_marker' || e.text === ''));
    back.close();
    // A segment that no longer applies (the room's epoch moved on) restores to null, never forced.
    assert.equal((await fac.send('takeover')).receipt, 'accepted');
    await until(() => fac.snapshot.epoch === 1);
    assert.equal(LocalAuthority.restore(fac.snapshot.mirror, fac.casePack, structuredClone(saved)), null);
  } finally {
    L.close();
  }
});
