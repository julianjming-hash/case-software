// Projector cue volume: a per-device local preference (CASE-171). Storage may be blocked; never throw.
export const DEFAULT_VOLUME = 1;
const KEY = 'case-room-volume';
export function readVolume(storage) {
  try { const raw = storage?.getItem(KEY); const v = raw === '' || raw == null ? NaN : Number(raw); return Number.isFinite(v) && v >= 0 && v <= 1 ? v : DEFAULT_VOLUME; } catch { return DEFAULT_VOLUME; }
}
export function writeVolume(storage, value) {
  try { storage?.setItem(KEY, String(Math.min(1, Math.max(0, Number(value) || 0)))); } catch { /* preference only */ }
}
