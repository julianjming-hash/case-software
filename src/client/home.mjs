// The participant-first root (card 29, CASE-166). Everyone arrives at room-code entry, signed in or not.
// The root never reads, restores or clears an account or a participant credential: it holds no Auth
// client and runs no teardown, so a facilitator's kept sign-in and a participant's saved place are left
// exactly as they were. Continue is a document navigation to the existing join document (/J/<code>), so
// the join validation, Turnstile scope (join documents only) and recovery are unchanged; the root's own
// CSP never admits the Turnstile origin. The code input never auto-submits.
import { JOIN_CODE_LENGTH, normalizeCode } from '../shared/ids.mjs';
import { joinUrl } from '../shared/urls.mjs';
import { mountSiteHeader } from './site-header.mjs';
import { attachRoomCodeMask, watchCodeLength, typedLength } from './phone-join-code.mjs';
import { mountCodeBoxes } from './code-boxes.mjs';

export const ROOM_CODE_ERROR = 'Enter the six-character session code shown on the projector.';
/** The code a typed or pasted value names, or null. Spaces, hyphens and the O/I/L aliases are accepted. */
export const roomCodeFrom = value => normalizeCode(String(value ?? ''), JOIN_CODE_LENGTH);

export function mount() {
  const main = document.querySelector('main');
  main.replaceChildren(); main.className = 'home'; main.removeAttribute('aria-labelledby');
  const header = mountSiteHeader(document.body, { current: 'join' });
  const splash = document.createElement('div'); splash.className = 'home-splash';
  const art = document.createElement('div'); art.className = 'home-art'; art.setAttribute('aria-hidden', 'true');
  const form = document.createElement('form'); form.className = 'home-panel'; form.noValidate = true;
  form.setAttribute('aria-labelledby', 'homeTitle');
  const title = document.createElement('h1'); title.id = 'homeTitle'; title.textContent = 'Join the Case';
  const lead = document.createElement('p'); lead.className = 'muted'; lead.textContent = 'Enter the code shown on the projector.';
  const label = document.createElement('label'); label.htmlFor = 'roomCode'; label.textContent = 'Session code';
  const input = document.createElement('input');
  Object.assign(input, { id: 'roomCode', type: 'text', inputMode: 'text', autocomplete: 'off', spellcheck: false, maxLength: 12 });
  input.setAttribute('autocapitalize', 'characters'); input.setAttribute('autocorrect', 'off');
  // One native input, masked to the code's characters (paste, aliases, caret); the two groups of three boxes are its rendering.
  attachRoomCodeMask(input, null, '');
  const boxes = mountCodeBoxes(input);
  const error = document.createElement('p'); error.id = 'roomCodeError'; error.className = 'field-error'; error.hidden = true;
  const submit = document.createElement('button'); submit.type = 'submit'; submit.className = 'btn primary lg block'; submit.textContent = 'Continue';
  const field = document.createElement('div'); field.className = 'field'; field.append(label, boxes.root, error);
  form.append(title, lead, field, submit);
  splash.append(art, form); main.append(splash);
  const clearError = () => {
    if (error.hidden) return;
    error.hidden = true; error.textContent = ''; input.removeAttribute('aria-invalid');
    input.removeAttribute('aria-describedby');
  };
  // Typing never submits; the mask keeps the caret where the person put it.
  input.addEventListener('input', clearError);
  form.addEventListener('submit', event => {
    event.preventDefault();
    const code = roomCodeFrom(input.value);
    if (!code) {
      error.textContent = ROOM_CODE_ERROR; error.hidden = false; error.setAttribute('role', 'alert');
      input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', 'roomCodeError');
      input.focus(); return;
    }
    location.assign(joinUrl(code, location.origin));
  });
  let splashArt = null, renderer = null, hidden = false;
  // The brand braid composes beside the panel and re-solves on resize itself; typing lays the route one sixth per
  // character (only the count is read).
  const paint = () => {
    if (!renderer || hidden || !art.isConnected) return;
    splashArt?.stop();
    splashArt = renderer.mountCaseSplash(art, null, { brand: true, surface: 'home', aspect: 1.6 });
    splashArt.laid(typedLength(input)); // characters typed before the art loaded, or kept by a back/forward restore
  };
  watchCodeLength(input, count => splashArt?.laid(count));
  // Optional public artwork is never a prerequisite for the room-code controls.
  void import('./splash.mjs').then(chunk => { renderer = chunk; paint(); }).catch(() => {});
  addEventListener('pagehide', () => { hidden = true; splashArt?.stop(); splashArt = null; });
  addEventListener('pageshow', event => { if (event.persisted) { hidden = false; paint(); } });
  return { header, input, form };
}
