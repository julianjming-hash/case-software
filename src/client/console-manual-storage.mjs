// Validated tab-segment persistence only; this module never imports the live room engine.
import { isUuidV7 } from '../shared/ids.mjs';
import { parseManualCommandEnvelope } from '../shared/wire.mjs';
import { cleanText } from '../shared/text.mjs';
export const MAX_SAVED_BYTES=256_000, MAX_EVENTS=500;
export const keyFor=sessionId=>`case-lab:segment:${sessionId}`;
export const utf8Bytes=text=>new TextEncoder().encode(text).byteLength;
export function readSavedManualSegment(sessionId,storage=globalThis.sessionStorage){
    if (!isUuidV7(sessionId)) return null;
    try {
      const raw = storage.getItem(keyFor(sessionId));
      if (!raw || utf8Bytes(raw) > MAX_SAVED_BYTES) return null;
      const saved = JSON.parse(raw);
      if (!isUuidV7(saved?.segmentId) || !Number.isSafeInteger(saved.epoch) ||
          !Array.isArray(saved.events) || saved.events.length > MAX_EVENTS ||
          !Array.isArray(saved.markers) || saved.markers.length > MAX_EVENTS) return null;
      if (Object.keys(saved).sort().join(',') !== 'epoch,events,markers,segmentId') return null;
      if (!saved.markers.every(marker => marker && typeof marker.at === 'string' &&
          marker.at.length <= 40 && Number.isFinite(Date.parse(marker.at)) &&
          typeof marker.text === 'string' && marker.text.length <= 200 &&
          marker.text === cleanText(marker.text, 200) &&
          Object.keys(marker).sort().join(',') === 'at,text')) return null;
      if (!saved.events.every(event => event && typeof event.at === 'string' &&
          event.at.length <= 40 && Number.isFinite(Date.parse(event.at)) &&
          (() => { const { at, ...envelope } = event;
            return parseManualCommandEnvelope(envelope).ok &&
              (event.type !== 'manual_marker' || event.text === cleanText(event.text, 200)); })())) return null;
      return saved;
    } catch { return null; }
  }
/** Exactly one validated tab segment may pass a navigation boundary. */
export function savedManualKey(storage = null) {
  try {
    storage ??= globalThis.sessionStorage;
    let found = null;
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key?.startsWith('case-lab:segment:')) continue;
      const sessionId = key.slice('case-lab:segment:'.length);
      if (found || !isUuidV7(sessionId) || !readSavedManualSegment(sessionId, storage)) return null;
      found = key;
    }
    return found;
  } catch { return null; }
}

// Formatting a validated saved segment does not load the live room engine.
export function notesFromSaved(saved) {
    if (!saved || !isUuidV7(saved.segmentId) || !Array.isArray(saved.events) ||
        !Array.isArray(saved.markers)) return '';
    const lines = [`Manual session segment ${saved.segmentId}`,
      'Saved on this device after a reload. Session and path names return only after you reconnect.', ''];
    for (const event of saved.events) {
      if (['select_path', 'reveal_path'].includes(event.type)) lines.push(`${event.at}  Route chosen (${event.pathId})`);
      if (['reveal', 'reveal_path'].includes(event.type)) lines.push(`${event.at}  Revealed to the room`);
      if (event.type === 'undo') lines.push(`${event.at}  Teaching action corrected (${event.targetEventId})`);
    }
    for (const marker of saved.markers)
      lines.push(`${marker.at}  Marker: ${cleanText(marker.text, 200)}`);
    return lines.join('\n') + '\n';
  }
