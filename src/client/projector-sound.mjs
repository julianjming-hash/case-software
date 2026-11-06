// Projector-local permission. Saved settings never unlock audio; remote messages can mute. CASE-335: the room's music on/off,
// volume and Effects come from the console's player (public `music`); this device's saved levels only scale them.
import { createRoomCuePlayer } from './room-cue-events.mjs';
import { CUE_URLS } from './audio-assets.mjs';
import { readVolume } from './room-volume.mjs';
import { MUSIC_VOLUME_DEFAULT, EFFECTS_LEVEL } from '../shared/music-catalogue.mjs';
import { AUDIO_LEVEL_KEYS, readAudioLevel } from './audio-preferences.mjs';
import { reducedMotion } from './appearance-watch.mjs';
/** CASE-335: this display's levels: the room's (from the console's player; defaults when a server sends none) times this
 *  device's saved levels (unset counts as full). Paused room music and Effects off are silent whatever the device says. */
export function roomLevels(music, deviceMusic = null, deviceEffects = null) {
  const room = music?.playing === false ? 0 : (Number.isInteger(music?.volume) ? music.volume : MUSIC_VOLUME_DEFAULT) / 100;
  return { music: room * (deviceMusic ?? 1), effects: (music?.effects === false ? 0 : EFFECTS_LEVEL) * (deviceEffects ?? 1) };
}
export function createProjectorSound({ doc = document, getView, changed = () => {},
  createContext = () => new AudioContext(), loadMusic = () => import('./room-music.mjs'), storage }) {
  if (storage === undefined) { try { storage = globalThis.localStorage; } catch { storage = null; } }
  let ctx = null, enabled = false, closed = false, failed = false, musicFailed = false, moduleFailed = false, music = null, loading = null, loadingBaseline = null, generation = 0, rebaseline = true;
  let deviceMusic = readAudioLevel(storage, 'music'), deviceEffects = readAudioLevel(storage, 'effects', readVolume(storage));
  const musicLevel = () => roomLevels(getView()?.music, deviceMusic, deviceEffects).music;
  const effectsLevel = () => roomLevels(getView()?.music, deviceMusic, deviceEffects).effects;
  const media = reducedMotion(globalThis);
  const cues = createRoomCuePlayer({ urls: CUE_URLS, enabled: () => enabled && !closed, reduced: () => !!media?.matches,
    hidden: () => doc.hidden, getContext: () => ctx, volume: effectsLevel });
  const element = doc.createElement('div'); element.className = 'sound-cell';
  const button = doc.createElement('button'); button.type = 'button'; button.className = 'sound'; button.dataset.soundControl = 'sound';
  button.setAttribute('aria-label', 'Session sound');
  const ns = 'http://www.w3.org/2000/svg';
  const glyph = doc.createElementNS(ns, 'svg'); glyph.setAttribute('viewBox', '0 0 24 24'); glyph.setAttribute('class', 'ic'); glyph.setAttribute('aria-hidden', 'true');
  const glyphPath = doc.createElementNS(ns, 'path'); glyph.append(glyphPath);
  const buttonLabel = doc.createElement('span'); buttonLabel.className = 'sr-only'; button.append(glyph, buttonLabel);
  const status = doc.createElement('span'); status.className = 'sound-status'; status.setAttribute('role', 'status');
  const reload = doc.createElement('button'); reload.type = 'button'; reload.className = 'btn sound-reload'; reload.textContent = 'Reload page'; reload.dataset.soundControl = 'reload'; reload.hidden = true;
  reload.addEventListener('click', () => doc.defaultView.location.reload());
  const controls = { sound: button, reload };
  function labels() {
    button.setAttribute('aria-pressed', String(enabled));
    buttonLabel.textContent = enabled ? 'Mute sound' : failed ? 'Retry sound' : 'Enable sound'; button.title = buttonLabel.textContent;
    glyphPath.setAttribute('d', enabled ? 'M4 9v6h4l5 4V5L8 9zM16.5 9a4 4 0 0 1 0 6' : 'M4 9v6h4l5 4V5L8 9zM17 9l4 6M21 9l-4 6');
    reload.hidden = !moduleFailed;
    status.textContent = moduleFailed ? 'Session music could not load. Reload this page to try again.' : failed ? 'Sound unavailable. Try again on this projector.'
      : enabled && musicFailed ? 'Session music unavailable. Mute and enable sound to retry.' : '';
  }
  function reconcile(baseline = false) { music?.reconcile(getView(), { baseline }); }
  async function ensureMusic(baseline = false) {
    if (moduleFailed) return;
    if (!enabled || closed || !(musicLevel() > 0) || media?.matches || doc.hidden) { music?.baseline(); return; }
    if (music) { reconcile(baseline); return; }
    if (loading) return loading;
    const ticket = generation;
    loadingBaseline = getView();
    loading = loadMusic().then(module => {
      if (closed || ticket !== generation || !enabled) return;
      music = module.createRoomMusic({ enabled: () => enabled && !closed, reduced: () => !!media?.matches, hidden: () => doc.hidden,
        getContext: () => ctx, volume: musicLevel, report: result => { if (closed) return; musicFailed = result === 'unavailable'; labels(); } });
      music.reconcile(loadingBaseline, { baseline: true });
      if (getView() !== loadingBaseline) reconcile();
    }).catch(() => { if (!closed && ticket === generation) { moduleFailed = true; labels(); } }).finally(() => {
      loading = null;
      if (ticket !== generation && enabled && !closed && !music && !failed) void ensureMusic(true);
    });
    return loading;
  }
  function silence() { generation++; enabled = false; cues.cancel(); music?.baseline(); labels(); }
  button.addEventListener('click', async () => {
    if (enabled) { silence(); changed(); return; }
    const ticket = ++generation; failed = false; musicFailed = false;
    try {
      ctx ??= createContext();
      ctx.onstatechange = () => { if (closed) return; if (ctx.state !== 'running') { silence(); failed = true; labels(); changed(); } };
      await ctx.resume();
      if (closed || ticket !== generation) return;
      enabled = ctx.state === 'running'; failed = !enabled;
      labels(); changed();
      if (enabled) await ensureMusic(true);
    } catch { enabled = false; failed = true; cues.cancel(); music?.baseline(); }
    labels(); changed();
  });
  element.append(button, status, reload); labels();
  const window = doc.defaultView ?? globalThis;
  const preferencesChanged = event => {
    if (event.type === 'storage' && event.key !== null && ![...Object.values(AUDIO_LEVEL_KEYS), 'case-room-volume'].includes(event.key)) return;
    const nextMusic = readAudioLevel(storage, 'music'), nextEffects = readAudioLevel(storage, 'effects', readVolume(storage));
    if (nextMusic !== deviceMusic) { deviceMusic = nextMusic; void ensureMusic(true); }
    if (nextEffects !== deviceEffects) { deviceEffects = nextEffects; cues.cancel(); }
    labels();
  };
  window.addEventListener?.('storage', preferencesChanged); window.addEventListener?.('case-audio-preferences-change', preferencesChanged);
  const visibility = () => { cues.cancel(); music?.baseline(); rebaseline = true; if (!doc.hidden) void ensureMusic(true); };
  const reducedChange = () => { cues.cancel(); music?.baseline(); rebaseline = true; if (!media?.matches) void ensureMusic(true); };
  doc.addEventListener('visibilitychange', visibility); media?.addEventListener('change', reducedChange);
  return {
    element,
    play: kind => cues.play(kind),
    cancel: () => cues.cancel(),
    mute: silence,
    recover() { rebaseline = true; cues.cancel(); music?.baseline(); },
    update(view, { baseline = false } = {}) {
      const recovering = baseline || rebaseline; if (recovering && loading) loadingBaseline = view;
      // The console's player can start, stop or change the music for this room at any time (CASE-335).
      if (enabled && !music && !loading && musicLevel() > 0) void ensureMusic(true);
      else if (music && !(musicLevel() > 0)) music.baseline();
      music?.reconcile(view, { baseline: recovering }); rebaseline = false;
      return recovering;
    },
    focus() { return Object.entries(controls).find(([,node]) => doc.activeElement === node)?.[0] ?? null; },
    restoreFocus(key) { controls[key]?.focus(); },
    close() { closed = true; generation++; enabled = false; cues.cancel(); music?.close(); doc.removeEventListener('visibilitychange', visibility);
      window.removeEventListener?.('storage', preferencesChanged); window.removeEventListener?.('case-audio-preferences-change', preferencesChanged);
      media?.removeEventListener('change', reducedChange); if (ctx) { ctx.onstatechange = null; try { void ctx.close().catch(() => {}); } catch { /* Already closed. */ } } },
  };
}
