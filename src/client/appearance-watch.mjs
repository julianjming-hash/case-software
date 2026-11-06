// Watching this device's appearance choices (appearance.mjs, and Motion in device-preferences.mjs) from the surfaces that react to them: the painted theme
// (covers and splash art repaint) and "reduce motion" (the OS preference OR Motion off). Every script that gates
// motion, sound cues or splash art asks reducedMotion(), never matchMedia alone. Kept out of appearance.mjs so the
// shared first load carries only the chooser.
import { APPEARANCE_KEY } from './appearance.mjs';
import { DEVICE_PREFERENCE_KEYS, DEVICE_PREFERENCES_CHANGE } from './device-preference-values.mjs';

/** Call `onChange` whenever the painted theme may differ: a choice here, or the OS scheme under Auto. */
export function watchTheme(onChange) {
  const media = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
  globalThis.addEventListener?.(APPEARANCE_KEY, onChange);
  media?.addEventListener?.('change', onChange);
  return () => { globalThis.removeEventListener?.(APPEARANCE_KEY, onChange); media?.removeEventListener?.('change', onChange); };
}


/**
 * A MediaQueryList-like view of "reduce motion": true under the OS preference or this device's Motion off.
 * `matches` is live; `change` listeners fire for either source (including another tab's choice).
 */
export function reducedMotion(win = globalThis) {
  const media = win.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
  const root = () => win.document?.documentElement;
  const listeners = new Set();
  const emit = () => { for (const fn of listeners) fn(); };
  const onStorage = event => {
    if (event.key !== DEVICE_PREFERENCE_KEYS.motion) return;
    const r = root(); if (r) r.dataset.motion = event.newValue !== 'false';
    emit();
  };
  let wired = false;
  const wire = on => {
    if (on === wired) return; wired = on;
    const verb = on ? 'addEventListener' : 'removeEventListener';
    media?.[verb]?.('change', emit); win[verb]?.(DEVICE_PREFERENCES_CHANGE, emit); win[verb]?.('storage', onStorage);
  };
  return {
    get matches() { return Boolean(media?.matches) || root()?.getAttribute('data-motion') === 'false'; },
    addEventListener(type, fn) { if (type !== 'change') return; listeners.add(fn); wire(true); },
    removeEventListener(type, fn) { if (type !== 'change') return; listeners.delete(fn); if (!listeners.size) wire(false); },
  };
}
