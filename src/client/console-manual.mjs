// Device-local room authority during an outage. Only the event segment enters
// sessionStorage; the case pack and mirror stay in memory. Spoken marker text
// remains in that bounded tab segment for local notes, never in an upload.
import { uuidv7, isUuidV7 } from '../shared/ids.mjs';
import { dispatch, project } from '../shared/room-machine.mjs';
import { WIRE_VERSION, parseCommandEnvelope, parseManualCommandEnvelope, buildEvent } from '../shared/wire.mjs';
import { cleanText } from '../shared/text.mjs';
import { publishProjectorFrame } from './console-projection.mjs';

import { notesFromSaved, readSavedManualSegment, MAX_SAVED_BYTES, MAX_EVENTS, keyFor, utf8Bytes } from './console-manual-storage.mjs';

export class ConsoleManualRoom {
  constructor(mirror, caseDoc, options = {}) {
    const { storage = sessionStorage, channel = new BroadcastChannel('case-room-local'),
      segmentId = uuidv7(), onFrame = null } = options;
    this.onFrame = onFrame;
    this.state = { ...structuredClone(mirror), caseDoc };
    this.storage = storage;
    this.channel = channel;
    this.ownsChannel = !Object.hasOwn(options, 'channel');
    this.segmentId = segmentId;
    this.storageKey = keyFor(mirror.sessionId);
    this.epoch = mirror.epoch;
    this.events = [];
    this.markers = [];
    this.ledger = new Map();
    this.persistenceOk = null;
  }

  static saved(sessionId, storage = globalThis.sessionStorage) { return readSavedManualSegment(sessionId,storage); }

  static restore(mirror, caseDoc, saved, options = {}) {
    if (!saved || saved.epoch !== mirror.epoch || !isUuidV7(saved.segmentId) ||
        !Array.isArray(saved.events) || saved.events.length > MAX_EVENTS ||
        !Array.isArray(saved.markers) || saved.markers.length > MAX_EVENTS) return null;
    const manual = new ConsoleManualRoom(mirror, caseDoc,
      { ...options, segmentId: saved.segmentId });
    for (const event of saved.events) {
      const { at, ...envelope } = event;
      if (typeof at !== 'string' || manual.#apply(envelope, at, true).receipt !== 'accepted') {
        manual.close(); manual.forget(); return null;
      }
    }
    manual.markers = saved.markers;
    manual.persistenceOk = manual.save();
    return manual;
  }

  enter() { return this.command('enter_manual', { segmentId: this.segmentId }); }

  command(type, payload = {}) {
    if (this.events.length >= MAX_EVENTS) return { receipt: 'rejected', reason: 'segment_full' };
    if (type === 'manual_marker') {
      if (typeof payload.text !== 'string' || payload.text.length > 200)
        return { receipt: 'rejected', reason: 'bad_text' };
      payload = { ...payload, text: cleanText(payload.text, 200) };
    }
    const envelope = { v: WIRE_VERSION, type, epoch: this.state.epoch,
      clientEventId: uuidv7(), ...payload,
      ...(['reveal_path', 'undo', 'confirm_recovery', 'show_clarification', 'return_clarification'].includes(type) && this.state.manual ? { expectRevision: this.state.revision } : {}) };
    const receipt = this.#apply(envelope, new Date().toISOString());
    if (receipt.receipt === 'accepted') {
      if (type === 'manual_marker') this.markers.push({ at: this.events.at(-1).at,
        text: payload.text });
      this.persistenceOk = this.save();
    }
    return receipt;
  }

  #apply(envelope, at, restoring = false) {
    const parsed = restoring ? parseManualCommandEnvelope(envelope) : parseCommandEnvelope(envelope, 'facilitator');
    if (!parsed.ok) return { receipt: 'rejected', reason: parsed.error };
    const event = buildEvent(parsed.envelope,
      { actor: { role: 'facilitator', id: 'facilitator' }, at, newId: uuidv7 });
    if (['ranked_page', 'reveal_path', 'undo', 'confirm_recovery', 'show_clarification', 'return_clarification'].includes(event.type) && this.state.manual) event.expectRevision = this.state.revision;
    const result = dispatch(this.state, event, this.ledger);
    const receipt = result.effects.find(effect => effect.type === 'receipt') ??
      { receipt: 'accepted' };
    if (receipt.receipt === 'accepted') {
      this.state = result.state;
      const recorded = { ...envelope };
      if (['ranked_page', 'reveal_path', 'undo', 'confirm_recovery', 'show_clarification', 'return_clarification'].includes(recorded.type)) delete recorded.expectRevision;
      this.events.push({ ...recorded, at });
      this.publish();
    }
    return receipt;
  }

  save() {
    const raw = JSON.stringify({ epoch: this.epoch, segmentId: this.segmentId,
      events: this.events, markers: this.markers });
    if (utf8Bytes(raw) > MAX_SAVED_BYTES) return false;
    try { this.storage.setItem(this.storageKey, raw); return true; }
    catch { return false; }
  }

  forget() { try { this.storage.removeItem(this.storageKey); } catch { /* private mode */ } }
  view() { return project(this.state, 'facilitator'); }
  /** What this computer's projector shows (CASE-327: the console's Room sees draws the same projection). */
  displayView() { return project(this.state, 'display'); }
  publish() {
    const frame = { t: 'local_snapshot', epoch: this.state.epoch,
      revision: this.state.revision, displayRevision: this.state.display.revision,
      view: project(this.state, 'display') };
    if (publishProjectorFrame(this.channel, frame, this.state.sessionId)) this.onFrame?.(frame.view);
  }
  segmentBody() {
    return { v: WIRE_VERSION, segmentId: this.segmentId,
      events: this.events.map(event => event.type === 'manual_marker' ?
        { ...event, text: '' } : event) };
  }
  notesText() {
    const paths = new Map(this.state.caseDoc.decisions.flatMap(decision =>
      decision.paths.map(path => [path.id, path.label])));
    const lines = [`Case: ${this.state.caseDoc.title}`,
      `Manual session segment ${this.segmentId}`, ''];
    for (const event of this.events) {
      if (['select_path', 'reveal_path'].includes(event.type)) lines.push(`${event.at}  Route chosen: ${paths.get(event.pathId) ?? event.pathId}`);
      if (['reveal', 'reveal_path'].includes(event.type)) lines.push(`${event.at}  Revealed to the room`);
      if (event.type === 'undo') lines.push(`${event.at}  Teaching action corrected (${event.targetEventId})`);
    }
    for (const marker of this.markers) lines.push(`${marker.at}  Marker: ${marker.text}`);
    return lines.join('\n') + '\n';
  }
  static notesFromSaved(saved) { return notesFromSaved(saved); }
  close() {
    this.channel.postMessage({ t: 'local_end', sessionId: this.state.sessionId });
    if (this.ownsChannel) this.channel.close();
  }
}

export { savedManualKey } from './console-manual-storage.mjs';
