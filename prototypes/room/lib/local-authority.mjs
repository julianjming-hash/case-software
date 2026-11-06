// prototypes/room/lib/local-authority.mjs: the facilitator device as the room authority in manual
// room mode (HANDOFF §Manual room and recovery contract, CASE-035/037/071).
//
// Entry is a LOCAL decision: it works with no server reachable. The console takes the last full
// state it holds (`mirror`), runs the same reducer locally, and records every accepted command as
// a segment event (envelope + device time). On recovery the segment is uploaded and replayed
// all-or-nothing by the authority (applySegment). A local ranked-page command carries its current
// revision and closed-round target. Its stored segment omits that transient revision: only trusted
// manual replay rebases it on the staged revision, while the epoch and closed-round target remain
// fences as the server admits participants during a partial outage.
import { uuidv7 } from '../../../src/shared/ids.mjs';
import { dispatch, project } from '../../../src/shared/room-machine.mjs';
import { WIRE_VERSION, parseCommandEnvelope, parseManualCommandEnvelope, buildEvent } from '../../../src/shared/wire.mjs';
import { LOCAL_CHANNEL } from './bus.mjs';

export class LocalAuthority {
  /** @param {object} mirror full reducer state without caseDoc (from the last facilitator snapshot) */
  constructor(mirror, caseDoc, { segmentId = uuidv7() } = {}) {
    this.state = { ...structuredClone(mirror), caseDoc };
    this.ledger = new Map();
    this.events = [];
    this.segmentId = segmentId;
    this.markers = []; // marker text: kept here only; uploads carry an empty text (segmentBody)
    this.local = new BroadcastChannel(LOCAL_CHANNEL);
    this.storageKey = `case-lab:segment:${mirror.sessionId}`;
  }

  /**
   * The segment saved in this tab's session storage (CASE-093), or null. The mirror and case pack
   * are memory-only (CASE-092), so after a reload the console fetches them again once online and
   * replays the saved segment on top with `LocalAuthority.restore`.
   */
  static saved(sessionId) {
    try { return JSON.parse(sessionStorage.getItem(`case-lab:segment:${sessionId}`) ?? 'null'); } catch { return null; }
  }

  /** Rebuild manual mode from a fresh mirror plus a saved segment. Returns null if it no longer applies. */
  static restore(mirror, caseDoc, saved) {
    const la = new LocalAuthority(mirror, caseDoc, { segmentId: saved.segmentId });
    for (const e of saved.events) {
      const { at, ...envelope } = e;
      if (la.#apply(envelope, at, true).receipt !== 'accepted') { la.close(); la.forget(); return null; }
    }
    la.markers = saved.markers ?? [];
    la.save();
    return la;
  }

  /** Enter manual mode. Voids an open or locked round in the same command (CASE-071). */
  enter() { return this.command('enter_manual', { segmentId: this.segmentId }); }

  /** Run one facilitator command locally. Returns the receipt effect. */
  command(type, payload = {}) {
    const envelope = { v: WIRE_VERSION, type, epoch: this.state.epoch, clientEventId: uuidv7(), ...payload };
    const receipt = this.#apply(envelope, new Date().toISOString());
    if (receipt.receipt === 'accepted') {
      if (type === 'manual_marker') this.markers.push({ at: this.events.at(-1).at, text: payload.text });
      this.save();
    }
    return receipt;
  }

  #apply(envelope, at, restoring = false) {
    const p = restoring ? parseManualCommandEnvelope(envelope) : parseCommandEnvelope(envelope, 'facilitator');
    if (!p.ok) return { receipt: 'rejected', reason: p.error };
    const event = buildEvent(p.envelope, { actor: { role: 'facilitator', id: 'facilitator' }, at, newId: uuidv7 });
    if (restoring && event.type === 'ranked_page' && this.state.manual) event.expectRevision = this.state.revision;
    const r = dispatch(this.state, event, this.ledger);
    const receipt = r.effects.find((e) => e.type === 'receipt') ?? { receipt: 'accepted' };
    if (receipt.receipt === 'accepted') {
      this.state = r.state;
      const recorded = { ...envelope };
      if (recorded.type === 'ranked_page') delete recorded.expectRevision;
      this.events.push({ ...recorded, at });
      this.publish();
    }
    return receipt;
  }

  /** Session storage only: survives a reload of this tab, never the tab closing (CASE-093). */
  save() {
    try { sessionStorage.setItem(this.storageKey, JSON.stringify({ segmentId: this.segmentId, events: this.events, markers: this.markers })); } catch { /* private mode */ }
  }
  forget() { try { sessionStorage.removeItem(this.storageKey); } catch { /* private mode */ } }

  /** `Download your notes` (CASE-095): markers and route choices as plain text, made on this device. */
  notesText() {
    const paths = new Map(this.state.caseDoc.decisions.flatMap((d) => d.paths.map((p) => [p.id, p.label])));
    const lines = [`Case: ${this.state.caseDoc.title}`, `Manual room segment ${this.segmentId}`, ''];
    for (const e of this.events) {
      if (e.type === 'select_path') lines.push(`${e.at}  Route chosen: ${paths.get(e.pathId) ?? e.pathId}`);
      if (e.type === 'reveal') lines.push(`${e.at}  Revealed to the room`);
    }
    for (const m of this.markers) lines.push(`${m.at}  Marker: ${m.text}`);
    return lines.join('\n') + '\n';
  }

  /**
   * Notes from a saved segment alone, with no case pack (a reload during a total outage, AS-061): the
   * markers and when each route was chosen and shown. Route names need the case, so ids stand in.
   */
  static notesFromSaved(saved) {
    const lines = [`Manual room segment ${saved.segmentId}`, 'Saved on this device after a reload; route names return with the case.', ''];
    for (const e of saved.events ?? []) {
      if (e.type === 'select_path') lines.push(`${e.at}  Route chosen (${e.pathId})`);
      if (e.type === 'reveal') lines.push(`${e.at}  Revealed to the room`);
    }
    for (const m of saved.markers ?? []) lines.push(`${m.at}  Marker: ${m.text}`);
    return lines.join('\n') + '\n';
  }

  /** The console view, from the local state. */
  view() { return project(this.state, 'facilitator'); }

  /** Same-PC projector window follows the console locally (dual-display topology). */
  publish() {
    this.local.postMessage({ t: 'local_snapshot', epoch: this.state.epoch, revision: this.state.revision, displayRevision: this.state.display.revision, view: project(this.state, 'display') });
  }

  /** The upload body for parseManualSegment(). Marker TEXT stays on this device (SCREENS §Manual room
   *  mode): the server learns that a marker was made, never what it said. */
  segmentBody() {
    const events = this.events.map((e) => (e.type === 'manual_marker' ? { ...e, text: '' } : e));
    return { v: WIRE_VERSION, segmentId: this.segmentId, events };
  }

  close() { this.local.postMessage({ t: 'local_end' }); this.local.close(); }
}
