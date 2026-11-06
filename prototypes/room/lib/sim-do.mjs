// prototypes/room/lib/sim-do.mjs: a simulated live-room Durable Object for the stage C mockups.
//
// It runs in the lab page (index.html) and does what the Phase 1 DO will do, using the SAME shared
// modules: wire.mjs parses every frame, buildEvent stamps actor/time/ids, room-machine dispatch()
// is the only state transition, and project() is the only thing a client ever receives.
//
// `storage` stands in for DO SQLite (db/durable-object/room-schema.sql): meta.state, case_doc,
// receipts, journal, and capability-token hashes. It survives evict(); everything else is lost.
//
// Prototype-only (see prototypes/room/README.md, "Spec gaps found by stage C"):
//   • the facilitator snapshot also carries `mirror`, the full reducer state, and the console gets
//     a `case_pack` frame, so it can become the local authority in manual mode.
//   • joins and segment uploads arrive as `join_http` / `segment_http` frames on the bus instead of
//     HTTPS POSTs.
import { uuidv7, newJoinCode, newCapabilityToken, hashToken, normalizeCode, JOIN_CODE_LENGTH } from '../../../src/shared/ids.mjs';
import { initialState, dispatch, applySegment, project } from '../../../src/shared/room-machine.mjs';
import {
  WIRE_VERSION, PONG_FRAME, parseClientFrame, parseCommandEnvelope, buildEvent, receiptBody, snapshotBody,
  parseManualSegment, parseJoinRequest,
} from '../../../src/shared/wire.mjs';

const FAC_ID = 'facilitator';

export class SimRoom {
  /** @param {{caseDoc:object, send:(clientId:string, raw:string)=>void, onChange?:()=>void}} opts */
  constructor({ caseDoc, send, onChange = () => {} }) {
    this.send = send;
    this.onChange = onChange;
    const joinCode = newJoinCode();
    const state = initialState({ sessionId: uuidv7(), joinCode, caseDoc, caseVersionNo: 1 });
    this.storage = {
      meta: new Map([['schema_version', '1'], ['state', stringifyState(state)]]),
      caseDoc: JSON.stringify(caseDoc),
      receipts: new Map(),
      journal: [],
      tokens: new Map(), // sha256 hex → { role, participantId? }
    };
    this.alive = true;
    this.rebuilds = 0;
    this.#load();
  }

  #load() {
    const caseDoc = JSON.parse(this.storage.caseDoc);
    this.state = { ...JSON.parse(this.storage.meta.get('state')), caseDoc };
    this.conns = new Map(); // clientId → { role, participantId }
  }

  /** Lab-only: mint a facilitator or display credential (stands in for sign-in and pairing). */
  async issueCredential(role) {
    const token = newCapabilityToken();
    this.storage.tokens.set(await hashToken(token), { role });
    return token;
  }

  /** Fault: evict the DO. In-memory state and sockets are lost; storage survives; rebuild after `ms`. */
  evict(ms = 600) {
    const before = this.projectionDigest();
    for (const clientId of this.conns.keys()) this.send(clientId, JSON.stringify({ v: WIRE_VERSION, t: 'closed' }));
    this.alive = false;
    this.state = null;
    this.conns = null;
    this.onChange();
    return new Promise((resolve) => setTimeout(() => {
      this.#load();
      this.alive = true;
      this.rebuilds += 1;
      this.onChange();
      resolve({ identical: before === this.projectionDigest(), before });
    }, ms));
  }

  /** Every role's projection, for the rebuild check (CASE-072). */
  projectionDigest() {
    const s = this.state;
    const pids = Object.keys(s.participants);
    return JSON.stringify([project(s, 'facilitator'), project(s, 'display'), ...pids.map((p) => project(s, 'participant', p))]);
  }

  /** One raw frame from a client, after the lab's network faults. */
  async receive(clientId, raw) {
    if (!this.alive) return; // evicted: the socket is gone
    if (raw === '{"v":1,"t":"ping"}') return this.send(clientId, PONG_FRAME); // setWebSocketAutoResponse
    let f;
    try { f = JSON.parse(raw); } catch { return; }
    if (f?.t === 'join_http') return this.#join(clientId, f);
    if (f?.t === 'segment_http') return this.#segment(clientId, f);
    const parsed = parseClientFrame(raw);
    if (!parsed.ok) return this.#err(clientId, parsed.error);
    const frame = parsed.frame;
    if (frame.t === 'hello') return this.#hello(clientId, frame);
    if (frame.t === 'command') return this.#command(clientId, frame.body);
  }

  async #hello(clientId, frame) {
    const who = this.storage.tokens.get(await hashToken(frame.token));
    if (!who) return this.#err(clientId, 'unauthorised');
    if (!this.alive) return;
    if (who.role === 'participant' && this.state.participants[who.participantId]?.removedAt) return this.#err(clientId, 'removed');
    this.conns.set(clientId, who);
    this.send(clientId, JSON.stringify({ v: WIRE_VERSION, t: 'welcome', role: who.role, participantId: who.participantId ?? null }));
    // The console prefetches the case pack (R2 in production) so it can run manual mode offline.
    if (who.role === 'facilitator') this.send(clientId, JSON.stringify({ v: WIRE_VERSION, t: 'case_pack', document: JSON.parse(this.storage.caseDoc) }));
    this.#snapshotTo(clientId);
    this.onChange();
  }

  #command(clientId, body) {
    const who = this.conns.get(clientId);
    if (!who) return this.#err(clientId, 'say_hello_first');
    const p = parseCommandEnvelope({ v: WIRE_VERSION, ...body }, who.role);
    if (!p.ok) return this.send(clientId, JSON.stringify({ v: WIRE_VERSION, t: 'receipt', clientEventId: body?.clientEventId ?? null, receipt: 'rejected', reason: p.error, revision: this.state.revision, epoch: this.state.epoch }));
    const actor = who.role === 'participant' ? { role: 'participant', id: who.participantId } : { role: 'facilitator', id: FAC_ID };
    const event = buildEvent(p.envelope, { actor, at: new Date().toISOString(), newId: uuidv7 });
    const r = dispatch(this.state, event, this.#ledger());
    this.#commit(r);
    const receipt = r.effects.find((e) => e.type === 'receipt');
    if (receipt) {
      this.send(clientId, JSON.stringify(receiptBody(receipt, this.state)));
      // A refused command is answered with a fresh snapshot so the sender can recover (HANDOFF §epoch).
      if (!['accepted', 'already_accepted'].includes(receipt.receipt)) this.#snapshotTo(clientId);
    }
  }

  async #join(clientId, f) {
    const reply = (status, body) => this.send(clientId, JSON.stringify({ v: WIRE_VERSION, t: 'http', reqId: f.reqId, status, body }));
    const p = parseJoinRequest(f.body);
    if (!p.ok) return reply(400, { error: p.error });
    // The Directory DO resolves the code; in the lab there is one room.
    if (normalizeCode(p.code, JOIN_CODE_LENGTH) !== this.state.joinCode) return reply(404, { error: 'unknown_code' });
    const pid = uuidv7();
    const event = { type: 'join', epoch: this.state.epoch, actor: { role: 'participant', id: pid }, at: new Date().toISOString(), clientEventId: uuidv7(), displayName: p.displayName, avatarId: p.avatarId };
    const r = dispatch(this.state, event, this.#ledger());
    const receipt = r.effects.find((e) => e.type === 'receipt');
    if (receipt.receipt !== 'accepted') return reply(409, { error: receipt.reason ?? receipt.receipt });
    this.#commit(r);
    const token = newCapabilityToken();
    this.storage.tokens.set(await hashToken(token), { role: 'participant', participantId: pid });
    reply(201, { token, participantId: pid });
  }

  #segment(clientId, f) {
    const reply = (status, body) => this.send(clientId, JSON.stringify({ v: WIRE_VERSION, t: 'http', reqId: f.reqId, status, body }));
    const who = this.conns.get(clientId);
    if (who?.role !== 'facilitator') return reply(403, { error: 'forbidden' });
    const p = parseManualSegment(f.body);
    if (!p.ok) return reply(400, { error: p.error });
    const events = p.events.map(({ envelope, at }) => buildEvent(envelope, { actor: { role: 'facilitator', id: FAC_ID }, at, newId: uuidv7 }));
    const r = applySegment(this.state, events, this.#ledger());
    if (!r.ok) return reply(409, { error: r.reason, failedAt: r.failedAt });
    this.#commit({ state: r.state, effects: [...r.effects, { type: 'broadcast', roles: ['facilitator', 'display', 'participant'] }] });
    reply(200, { ok: true, revision: this.state.revision, epoch: this.state.epoch, applied: events.length });
  }

  /** Same "transaction": state, journal rows and receipts, then fan-out (coalesced per command). */
  #commit({ state, effects }) {
    if (state === this.state && !effects.some((e) => e.type === 'journal' || e.type === 'display')) return;
    this.state = state;
    const { caseDoc, ...rest } = state;
    this.storage.meta.set('state', JSON.stringify(rest));
    for (const e of effects) if (e.type === 'journal') this.storage.journal.push({ seq: e.seq, epoch: e.epoch, kind: e.kind, payload: e.payload, at: e.at });
    const roles = new Set(effects.filter((e) => e.type === 'broadcast').flatMap((e) => e.roles ?? ['facilitator', 'display', 'participant']));
    if (effects.some((e) => e.type === 'display')) { roles.add('display'); roles.add('facilitator'); }
    for (const [clientId, who] of this.conns) if (roles.has(who.role)) this.#snapshotTo(clientId);
    this.onChange();
  }

  #snapshotTo(clientId) {
    const who = this.conns.get(clientId);
    if (!who) return;
    const view = project(this.state, who.role, who.participantId ?? null);
    const body = snapshotBody(this.state, view);
    if (who.role === 'facilitator') body.mirror = JSON.parse(this.storage.meta.get('state')); // prototype-only
    this.send(clientId, JSON.stringify(body));
  }

  #err(clientId, error) {
    this.send(clientId, JSON.stringify({ v: WIRE_VERSION, t: 'error', error }));
  }

  #ledger() {
    const m = this.storage.receipts;
    return { get: (k) => m.get(k), set: (k, v) => m.set(k, v) };
  }
}

function stringifyState(state) {
  const { caseDoc, ...rest } = state;
  return JSON.stringify(rest);
}
