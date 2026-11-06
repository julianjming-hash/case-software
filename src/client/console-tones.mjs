// Facilitator-console UI tones (CASE-171). Console only: the phone and projector never import this module.
// Gated by the console's own sound toggle; no fallback tone, so a sample that fails to load is simply skipped.
import { createCuePlayer } from './room-cues.mjs';
import { UI_TONE_URLS } from './ui-tone-assets.mjs';
export const UI_TONE_FOR = Object.freeze({ press: 'ui-press', open: 'ui-open', close: 'ui-close' });
/** The tone kind for a clicked control: `data-tone` open/close/none, otherwise a plain press. */
export const toneKindFor = control => { const tone = control?.dataset?.tone; return !control || tone === 'none' ? null : tone === 'open' || tone === 'close' ? tone : 'press'; };
/** Lazy chunk: imported by the console only when its sound toggle is first turned on. `press(control)` plays the control's tone. */
export function createUiTonePlayer(options) {
  const player = createCuePlayer({ urls: UI_TONE_URLS, map: UI_TONE_FOR, ...options });
  return { ...player, press: control => player.play(toneKindFor(control)) };
}
