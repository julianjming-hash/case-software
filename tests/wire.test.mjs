import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7, newCapabilityToken } from '../src/shared/ids.mjs';
import { AVATAR_IDS } from '../src/shared/participant.mjs';
import {
  WIRE_VERSION, COMMAND_PAYLOADS, ROUND_OPENING, MAX_FRAME_BYTES, PING_FRAME,
  parseCommandEnvelope, buildEvent, parseClientFrame, parseUpdatesQuery, parseManualSegment, parseJoinRequest,
  receiptBody, snapshotBody,
} from '../src/shared/wire.mjs';
import { COMMANDS, initialState, reduce, project } from '../src/shared/room-machine.mjs';
import { miniCase } from './helpers/mini-case.mjs';

const env = (type, extra = {}) => ({ v: WIRE_VERSION, type, epoch: 0, clientEventId: uuidv7(), ...extra });

test('the wire allowlist covers exactly the reducer commands, with the same roles', () => {
  assert.deepEqual(Object.keys(COMMAND_PAYLOADS).sort(), Object.keys(COMMANDS).sort());
  for (const [type, roles] of Object.entries(COMMANDS)) {
    assert.deepEqual(Object.keys(COMMAND_PAYLOADS[type]).sort(), [...roles].sort(), type);
  }
});

test('envelopes reject unknown fields, so actor and time cannot be smuggled in', () => {
  assert.equal(parseCommandEnvelope(env('lock', { actor: { role: 'facilitator' } }), 'facilitator').error, 'unexpected_field:actor');
  assert.equal(parseCommandEnvelope(env('lock', { at: '2020-01-01T00:00:00Z' }), 'facilitator').error, 'unexpected_field:at');
  assert.equal(parseCommandEnvelope(env('advance', { roundId: uuidv7() }), 'facilitator').error, 'unexpected_field:roundId');
});

test('roles are enforced at the wire, before the reducer', () => {
  assert.equal(parseCommandEnvelope(env('lock'), 'participant').error, 'forbidden');
  assert.equal(parseCommandEnvelope(env('vote', { roundId: uuidv7(), response: { option_id: uuidv7() } }), 'facilitator').error, 'forbidden');
  assert.equal(parseCommandEnvelope(env('lock'), 'display').error, 'forbidden');
  assert.ok(parseCommandEnvelope(env('vote', { roundId: uuidv7(), response: { option_id: uuidv7() } }), 'participant').ok);
});

test('envelopes need a version, an epoch and a UUID client_event_id', () => {
  assert.equal(parseCommandEnvelope({ ...env('lock'), v: 2 }, 'facilitator').error, 'wire_version');
  assert.equal(parseCommandEnvelope({ ...env('lock'), epoch: -1 }, 'facilitator').error, 'bad_epoch');
  assert.equal(parseCommandEnvelope({ ...env('lock'), clientEventId: 'x' }, 'facilitator').error, 'bad_client_event_id');
});

test('buildEvent adds the server actor, server time and server-generated round ids', () => {
  for (const type of ROUND_OPENING) {
    const { envelope } = parseCommandEnvelope(env(type), 'facilitator');
    const ev = buildEvent(envelope, { actor: { role: 'facilitator', id: 'f' }, at: '2026-10-01T09:00:00Z', newId: () => 'R' });
    assert.equal(ev.roundId, 'R');
    assert.equal(ev.actor.role, 'facilitator');
    assert.equal(ev.v, undefined);
  }
});

test('wire → reducer round trip: a participant vote through envelopes', () => {
  const { doc, o } = miniCase();
  let s = initialState({ sessionId: uuidv7(), joinCode: '7K3QX9', caseDoc: doc });
  const pid = uuidv7();
  let t = 0;
  const send = (body, actor) => {
    const p = parseCommandEnvelope(body, actor.role);
    assert.ok(p.ok, p.error);
    const r = reduce(s, buildEvent(p.envelope, { actor, at: new Date(Date.UTC(2026, 9, 1, 9, 0, t++)).toISOString(), newId: uuidv7 }));
    s = r.state;
    return r;
  };
  const fac = { role: 'facilitator', id: 'f' };
  send(env('join', { displayName: 'Ana', avatarId: 'shadows-02' }), { role: 'participant', id: pid });
  send(env('start'), fac);
  send(env('advance'), fac); // prepare the decision surface
  send(env('advance'), fac); // open responses after its only populated group
  const r = send(env('vote', { roundId: s.round.id, response: { option_id: o.decompress } }), { role: 'participant', id: pid });
  const rb = receiptBody(r.effects.find((e) => e.type === 'receipt'), s);
  assert.equal(rb.receipt, 'accepted');
  assert.equal(rb.revision, s.revision);
  const snap = snapshotBody(s, project(s, 'participant', pid));
  assert.equal(snap.view.decision.yourResponse.option_id, o.decompress);
  assert.ok(JSON.stringify(snap).length < 16_384, 'a participant snapshot fits comfortably in one frame');
});

test('client frames: hello carries the token (never the URL); ping; size and shape limits', () => {
  const tok = 'a'.repeat(43);
  assert.deepEqual(parseClientFrame(JSON.stringify({ v: 1, t: 'hello', token: tok, lastRevision: 3, lastEpoch: 0 })).frame,
    { t: 'hello', token: tok, lastRevision: 3, lastEpoch: 0 });
  assert.deepEqual(parseClientFrame(PING_FRAME).frame, { t: 'ping' });
  assert.equal(parseClientFrame(JSON.stringify({ v: 1, t: 'ping', n: 4 })).error, 'bad_ping', 'only the fixed frame, so the DO can auto-respond without waking');
  assert.equal(parseClientFrame('{').error, 'not_json');
  assert.equal(parseClientFrame(JSON.stringify({ v: 1, t: 'nope' })).error, 'unknown_frame');
  assert.equal(parseClientFrame('x'.repeat(MAX_FRAME_BYTES + 1)).error, 'frame_too_large');
  const cmd = parseClientFrame(JSON.stringify({ v: 1, t: 'command', type: 'lock', epoch: 0, clientEventId: uuidv7() }));
  assert.ok(parseCommandEnvelope({ v: 1, ...cmd.frame.body }, 'facilitator').ok);
});

test('a 500-character response fits the existing command frame budget', () => {
  const frame = JSON.stringify({ v: 1, t: 'command', body: env('vote', {
    roundId: uuidv7(), response: { text: '界'.repeat(500) },
  }) });
  assert.ok(new TextEncoder().encode(frame).length < MAX_FRAME_BYTES);
  assert.equal(parseClientFrame(frame).error, undefined);
});

test('long-poll wait is capped under proxy idle timeouts', () => {
  assert.deepEqual(parseUpdatesQuery(new URLSearchParams('after=7&wait=300')), { ok: true, after: 7, afterDisplay: 0, wait: 25 });
  assert.equal(parseUpdatesQuery(new URLSearchParams('after=7&afterDisplay=3')).afterDisplay, 3);
  assert.equal(parseUpdatesQuery(new URLSearchParams('after=-1')).error, 'bad_after');
});

test('manual segments: facilitator-only envelopes with ordered device times', () => {
  const seg = uuidv7();
  const ok = parseManualSegment({ v: 1, segmentId: seg, events: [
    { ...env('void_round'), at: '2026-10-01T09:00:00Z' },
    { ...env('enter_manual', { segmentId: seg }), at: '2026-10-01T09:00:05Z' },
    { ...env('advance'), at: '2026-10-01T09:01:00Z' },
  ] });
  assert.ok(ok.ok, ok.error);
  assert.equal(ok.events.length, 3);
  const vote = parseManualSegment({ v: 1, segmentId: seg, events: [{ ...env('vote', { roundId: uuidv7(), response: {} }), at: '2026-10-01T09:00:00Z' }] });
  assert.equal(vote.error, 'event_0:forbidden');
  const order = parseManualSegment({ v: 1, segmentId: seg, events: [
    { ...env('advance'), at: '2026-10-01T09:01:00Z' }, { ...env('advance'), at: '2026-10-01T09:00:00Z' },
  ] });
  assert.equal(order.error, 'event_1:out_of_order');
});

test('[AS-062] join requests need a typed code, a 3-20 character name and an allow-listed avatar (CASE-119)', () => {
  const ok = parseJoinRequest({ v: 1, code: '7k3 qx9', displayName: '  Adrenaline   Junkie ', avatarId: 'shadows-04' });
  assert.ok(ok.ok, ok.error);
  assert.equal(ok.displayName, 'Adrenaline Junkie', 'trimmed and spaces collapsed');
  assert.equal(ok.avatarId, 'shadows-04');
  assert.equal(parseJoinRequest({ v: 1, code: 7, displayName: 'Sam', avatarId: 'shadows-01' }).error, 'bad_code');
  const join = (displayName, avatarId = 'shadows-01') => parseJoinRequest({ v: 1, code: '7K3QX9', displayName, avatarId });
  for (const name of [undefined, '', '   ', 'Al', 'A'.repeat(21), 'Sam!', 'Dr. Who', '<b>Sam</b>', '---', "''-"]) assert.equal(join(name).error, 'bad_display_name', String(name));
  for (const name of ['Sam', 'Ana-Maria', "O'Neil", 'O’Neil', 'Zoë 2', 'Nguyễn Văn', 'Søren', 'Ali Al-Hashimi', 'A'.repeat(20)]) assert.ok(join(name).ok, name);
  assert.equal(join('Sam\u202eX').error, 'unsafe_characters');
  assert.equal(parseJoinRequest({ v: 1, code: '7K3QX9', displayName: 'Sam' }).error, 'bad_avatar', 'the avatar is required');
  for (const avatarId of [null, '', 'shadows-17', 'shadows-1', 'https://api.dicebear.com/9.x/shadows/svg', 7]) assert.equal(join('Sam', avatarId).error, 'bad_avatar', String(avatarId));
  assert.ok(join('Sam').ok && join('Sam').ok, 'two people may share a name');
});

test('[AS-062] rename keeps the join rules; the avatar is optional on a rename and checked when given', () => {
  const rn = (extra, role = 'participant') => parseCommandEnvelope(env('rename', extra), role);
  assert.equal(rn({ displayName: 'Jo' }).error, 'bad_display_name');
  assert.equal(rn({}).error, 'bad_display_name', 'a rename cannot clear the name');
  assert.equal(rn({ displayName: 'Josie', avatarId: 'nope' }).error, 'bad_avatar');
  assert.equal(rn({ displayName: '  Josie  ' }).envelope.displayName, 'Josie');
  assert.ok(rn({ displayName: 'Josie', avatarId: 'shadows-16' }).ok);
  assert.equal(rn({ displayName: 'Jo', participantId: uuidv7() }, 'facilitator').error, 'bad_display_name');
  assert.ok(rn({ displayName: 'Josie', participantId: uuidv7() }, 'facilitator').ok);
});

// Optional private join authority preserves the original public wire contract.
const canonicalJoinCapability = value => typeof value === 'string' && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value);
const joinBody = () => ({ v: 1, code: '7K3QX9', displayName: '  Test Person  ', avatarId: AVATAR_IDS[0] });
test('join wire accepts a canonical caller capability while preserving legacy and Turnstile semantics', () => {
  const legacy = parseJoinRequest(joinBody());
  assert.equal(legacy.ok, true);
  assert.equal(Object.hasOwn(legacy, 'joinToken'), false, 'missing optional input stays legacy');
  const token = newCapabilityToken();
  assert.equal(canonicalJoinCapability(token), true, 'the shared generator supplies canonical 256-bit encoding');
  const parsed = parseJoinRequest({ ...joinBody(), joinToken: token, turnstileToken: 'local-challenge' });
  assert.equal(parsed.ok, true);
  assert.equal(Object.hasOwn(parsed, 'joinToken'), true, 'the public parser must retain the caller capability');
  assert.equal(parsed.joinToken === token, true, 'validation cannot alter the private capability');
  assert.equal(parsed.displayName === 'Test Person', true, 'normal name validation still applies');
  assert.equal(parsed.avatarId === AVATAR_IDS[0], true);
  assert.equal(parsed.turnstileToken === 'local-challenge', true, 'challenge data is preserved separately');
});

test('join wire rejects every explicitly malformed capability without weakening required fields or Turnstile', () => {
  for (const token of [undefined, null, false, 1, {}, [], '', 'A'.repeat(42), 'A'.repeat(44),
    'A'.repeat(42) + 'B', 'A'.repeat(42) + '=', 'A'.repeat(41) + ' A', 'A'.repeat(41) + '\nA']) {
    const result = parseJoinRequest({ ...joinBody(), joinToken: token });
    assert.equal(result.ok, false, 'an own malformed optional capability is refused');
    assert.equal(result.error === 'bad_join_token', true, 'refusal uses a fixed non-secret diagnostic');
  }
  const token = newCapabilityToken();
  for (const change of [{ displayName: '' }, { avatarId: 'unknown-avatar' }, { turnstileToken: null }, { turnstileToken: 'with space' }]) {
    assert.equal(parseJoinRequest({ ...joinBody(), joinToken: token, ...change }).ok, false,
      'adding retry authority cannot bypass the original join validations');
  }
});
