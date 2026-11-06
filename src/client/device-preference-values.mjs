// Exact non-personal device preferences shared by controls and room adapters.
export const DEVICE_PREFERENCES_CHANGE = 'case-device-preferences-change';
export const DEVICE_PREFERENCE_KEYS = Object.freeze({ uiTones: 'case:preferences:ui-tones', timelineCollapsed: 'case:preferences:timeline-collapsed', motion: 'case:preferences:motion' });
export function readDevicePreferences(storage) {
  return Object.fromEntries(Object.entries(DEVICE_PREFERENCE_KEYS).map(([name, key]) => { try { return [name, storage?.getItem(key) !== 'false']; } catch { return [name, true]; } }));
}
export function writeDevicePreference(storage, name, value) {
  if (!storage || !Object.hasOwn(DEVICE_PREFERENCE_KEYS, name) || typeof value !== 'boolean') return false;
  try { storage.setItem(DEVICE_PREFERENCE_KEYS[name], String(value)); return true; } catch { return false; }
}

