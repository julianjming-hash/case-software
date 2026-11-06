// Exact non-personal device preferences. Missing music level is unset, not a calibrated default.
export const AUDIO_LEVEL_KEYS = Object.freeze({ music: 'case:audio:music-volume', effects: 'case:audio:effects-volume' });
export function readAudioLevel(storage, channel, fallback = null) {
  if (!Object.hasOwn(AUDIO_LEVEL_KEYS, channel)) return fallback;
  try { const raw = storage?.getItem(AUDIO_LEVEL_KEYS[channel]);
    if (raw === null || raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw); return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
  } catch { return fallback; }
}
export function writeAudioLevel(storage, channel, value) {
  if (!Object.hasOwn(AUDIO_LEVEL_KEYS, channel) || !Number.isFinite(value) || value < 0 || value > 1) return false;
  try { if (typeof storage?.setItem !== 'function') return false; storage.setItem(AUDIO_LEVEL_KEYS[channel], String(value)); return true; } catch { return false; }
}
