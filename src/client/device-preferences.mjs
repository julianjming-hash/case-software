// Device settings reuse the one audio schema shared with the music/effects controllers.
import { appearanceControl } from './appearance.mjs';
import { AUDIO_LEVEL_KEYS, readAudioLevel, writeAudioLevel } from './audio-preferences.mjs';
import { readVolume } from './room-volume.mjs';
export const AUDIO_PREFERENCES_CHANGE = 'case-audio-preferences-change';
import { DEVICE_PREFERENCES_CHANGE, DEVICE_PREFERENCE_KEYS, readDevicePreferences, writeDevicePreference } from './device-preference-values.mjs';
export { DEVICE_PREFERENCES_CHANGE, DEVICE_PREFERENCE_KEYS, readDevicePreferences, writeDevicePreference } from './device-preference-values.mjs';
export function devicePreferences(doc = document) {
  const root = doc.createElement('section'); root.className = 'device-preferences'; root.setAttribute('aria-label', 'Device settings');
  const title = doc.createElement('h3'); title.textContent = 'Settings on this device'; root.append(title, appearanceControl(doc));
  const audio = doc.createElement('fieldset'); audio.className = 'device-audio';
  const legend = doc.createElement('legend'); legend.textContent = 'Sound'; audio.append(legend);
  const status = doc.createElement('p'); status.className = 'appearance-note'; status.setAttribute('role', 'status');
  const controls = new Map();
  let storage = null; try { storage = doc.defaultView.localStorage; } catch { /* Honest write failure below. */ }
  const level = channel => readAudioLevel(storage, channel, channel === 'effects' ? readVolume(storage) : null);
  const describe = value => value === null || value === 0 ? 'Off' : `${Math.round(value * 100)}%`;
  for (const [channel, name] of [['music', 'Music volume'], ['effects', 'Effects volume']]) {
    const label = doc.createElement('label'); label.className = 'device-level';
    const text = doc.createElement('span'); text.textContent = name;
    const value = doc.createElement('output'), input = doc.createElement('input');
    input.type = 'range'; input.min = '0'; input.max = '1'; input.step = '0.05'; input.setAttribute('aria-label', name);
    controls.set(channel, { input, value });
    input.addEventListener('input', () => {
      const chosen = Number(input.value);
      if (!storage || !writeAudioLevel(storage, channel, chosen)) {
        status.textContent = 'Device settings could not be saved. Try again.'; refresh(); return;
      }
      status.textContent = ''; doc.defaultView.dispatchEvent(new Event(AUDIO_PREFERENCES_CHANGE)); refresh();
    });
    label.append(text, value, input); audio.append(label);
  }
  const note = doc.createElement('p'); note.className = 'appearance-note';
  note.textContent = 'The facilitator sets the session music and effects; these levels scale them on this device. Reduced motion silences it.';
  const general = doc.createElement('div'); general.className = 'device-general';
  const toggles = new Map();
  // Reduce motion (WCAG 2.2.2) sits in Appearance: checked disables motion (data-motion="false"; appearance-watch.mjs).
  // The console's timeline became one strip (console layout v2), so it no longer has a collapse preference.
  for (const [name, text] of [['motion', 'Reduce motion'], ['uiTones', 'Interface sounds']]) {
    const label = doc.createElement('label'), input = doc.createElement('input'); label.className='device-toggle';input.type = 'checkbox';input.setAttribute('role','switch');
    toggles.set(name, input);
    input.addEventListener('change', () => {
      const chosen=name==='motion'?!input.checked:input.checked;
      if (!writeDevicePreference(storage, name, chosen)) { status.textContent = 'Device settings could not be saved. Try again.'; refresh(); return; }
      if (name === 'motion') doc.documentElement.dataset.motion = chosen;
      status.textContent = ''; doc.defaultView.dispatchEvent(new Event(DEVICE_PREFERENCES_CHANGE));
    });
    label.append(input, text); name === 'motion' ? title.nextSibling.lastChild.before(label) : general.append(label);
  }
  audio.append(note); root.append(audio, general, status);
  function refresh() {
    for (const [channel, { input, value }] of controls) {
      const current = level(channel); input.value = String(current ?? 0); value.textContent = describe(current);
      input.setAttribute('aria-valuetext', describe(current));
    }
    const current = readDevicePreferences(storage); for (const [name, input] of toggles) input.checked = name==='motion'?!current[name]:current[name];
  }
  const changed = event => { if (event.type !== 'storage' || [...Object.values(AUDIO_LEVEL_KEYS), ...Object.values(DEVICE_PREFERENCE_KEYS), 'case-room-volume'].includes(event.key)) refresh(); };
  doc.defaultView.addEventListener('storage', changed); doc.defaultView.addEventListener(AUDIO_PREFERENCES_CHANGE, changed);
  doc.defaultView.addEventListener(DEVICE_PREFERENCES_CHANGE, changed); refresh();
  return { root, audio, refresh, dispose() {
    doc.defaultView.removeEventListener('storage', changed); doc.defaultView.removeEventListener(AUDIO_PREFERENCES_CHANGE, changed);
    doc.defaultView.removeEventListener(DEVICE_PREFERENCES_CHANGE, changed); root.remove();
  } };
}
