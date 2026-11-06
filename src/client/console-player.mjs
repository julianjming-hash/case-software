// The facilitator's player (CASE-335, Julian 2026-11-01: "like Spotify or Apple Music"): one widget for the round timer and the
// room's music. Timer: a ring clock read from the deadline, a −/+ length stepper over the CASE-320 stops, one round Start or
// Restart button, a clear button and the auto-lock switch. Music: the now-playing mosaic cover, play/pause, the room's music
// volume and Effects for every projector, the Build dial and a row of album covers (Auto · shuffle and the four themes).
// No native select or checkbox: buttons with aria-pressed / role=switch and two styled range inputs. Rendered into the patched
// console, so controls take property handlers and focus keys (card 37); covers are inline SVG, redrawn with each render.
import { TIMER_STOPS, nearestTimerStop, timerClock, timerSpoken, timerRemainingS } from '../shared/timer.mjs';
import { MUSIC_CHOICES, MUSIC_TRACK_NAMES, MUSIC_INTENSITY_DEFAULT, MUSIC_VOLUME_DEFAULT, validMusicIntensity, validMusicVolume } from '../shared/music-catalogue.mjs';

const SVGNS = 'http://www.w3.org/2000/svg';
const ICONS = {
  play: 'M8 5.5v13l11-6.5z', pause: 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z', minus: 'M5 12h14', plus: 'M12 5v14M5 12h14', clear: 'M6 6l12 12M18 6L6 18',
  restart: 'M5 12a7 7 0 1 0 2.05-4.95M5 4v4h4', volume: 'M4 9v6h4l5 4V5L8 9zM16.5 9a4 4 0 0 1 0 6', mute: 'M4 9v6h4l5 4V5L8 9zM17 9l4 6M21 9l-4 6',
  effects: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z',
  build: 'M5 19v-3M9.5 19v-6M14 19v-9M18.5 19V6', shuffle: 'M4 7h3.5l9 10H20M4 17h3.5l9-10H20M17.5 4.5L20 7l-2.5 2.5M17.5 14.5L20 17l-2.5 2.5',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z',
};
const TIMER_KEY = 'case:console:timer-seconds';
let timerPick = (() => { try { return nearestTimerStop(localStorage.getItem(TIMER_KEY) ?? 90); } catch { return 90; } })();
// A level the facilitator is dragging, kept until the room confirms it, so a render never pulls a slider back.
const sharedDragging = { intensity: null, volume: null };

export function glyph(doc, name) {
  const svg = doc.createElementNS(SVGNS, 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'player-icon'); svg.setAttribute('aria-hidden', 'true');
  const path = doc.createElementNS(SVGNS, 'path'); path.setAttribute('d', ICONS[name]); svg.append(path); return svg;
}
/** The live clock's text, also refreshed in place between renders by console-room.mjs's ticker (no chained countdown). */
export function timerClockParts(timer, nowMs = Date.now()) {
  const remaining = timerRemainingS(timer, nowMs), total = Math.max(1, Math.round(timer.totalS ?? timer.durationS));
  return remaining > 0
    ? { clock: timerClock(remaining), detail: `of ${timerClock(total)}`, fraction: Math.min(1, remaining / total), up: false }
    : { clock: 'Time up', detail: 'Answers still open', fraction: 0, up: true };
}
/** What the Build dial does at a value, in the room's words (CASE-334). */
export function buildWords(value) {
  if (value === 0) return 'Stays calm: no build.';
  if (value < 60) return 'A gentle build to time-up.';
  if (value < 100) return 'Builds to most of the full peak at time-up.';
  if (value === 100) return 'The full approved peak at time-up.';
  return `Full peak, then fuller and faster near time-up (+${value > 125 ? 12 : 6}% tempo, same pitch).`;
}
/** What the room is hearing now: the lobby and debrief beds follow the room; a question plays its theme. */
export function nowPlaying(view, music) {
  const t = music.transport;
  if (view.phase === 'lobby' || view.display?.lobby) return { id: 'atlas-arrival', title: 'Atlas · Arrival', detail: 'Lobby' };
  if (view.phase === 'debrief') return { id: 'side-street-afterglow', title: 'Side Street · Afterglow', detail: 'Debrief' };
  if (t) return { id: t.trackId, title: MUSIC_TRACK_NAMES[t.trackId], detail: music.choice === 'auto' ? `Shuffle · question ${t.draw + 1}` : 'Chosen for every question' };
  return { id: music.choice, title: music.choice === 'auto' ? 'Auto · shuffle' : MUSIC_TRACK_NAMES[music.choice], detail: 'Plays when a question opens' };
}
// Album covers (CASE-335): a strong ground per theme and a motif drawn from what it plays, in a 64-unit square. Decorative only:
// each tile's button carries the name. Auto is the four themes as one collage.
const MOTIFS = {
  'atlas-current': [['circle', { cx: 6, cy: 58, r: 14 }], ['circle', { cx: 6, cy: 58, r: 26 }], ['circle', { cx: 6, cy: 58, r: 38 }], ['circle', { cx: 6, cy: 58, r: 50 }]],
  'atlas-crossing': [['path', { d: 'M-4 20L44 68M-4 4L60 68M12 -4L68 52M28 -4L68 36' }], ['path', { d: 'M68 20L20 68M68 4L4 68M52 -4L-4 52M36 -4L-4 36' }]],
  'side-street-developed': [['path', { d: 'M14 6V58M24 6V58M34 6V58M44 6V58M54 6V58' }], ['path', { d: 'M6 40C20 30 40 50 58 36' }]],
  'night-platform-developed': [['path', { d: 'M4 46H60M4 52H60' }], ...[12, 24, 36, 48].flatMap(x => [16, 28].map(y => ['circle', { cx: x, cy: y, r: 3.4, class: 'cover-dot' }]))],
  'atlas-arrival': [['path', { d: 'M4 46H60' }], ['circle', { cx: 32, cy: 46, r: 14 }], ['circle', { cx: 32, cy: 46, r: 22 }]],
  'side-street-afterglow': [['path', { d: 'M4 18H60M4 28H60M10 38H54M18 48H46M26 56H38' }]],
};
export function albumCover(doc, id) {
  const svg = doc.createElementNS(SVGNS, 'svg'); svg.setAttribute('viewBox', '0 0 64 64'); svg.setAttribute('class', `player-cover cover-${id}`); svg.setAttribute('aria-hidden', 'true');
  const add = (tag, attrs, parent = svg) => { const node = doc.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v)); parent.append(node); return node; };
  if (id === 'auto') {
    for (const [i, theme] of ['atlas-current', 'atlas-crossing', 'side-street-developed', 'night-platform-developed'].entries())
      add('rect', { x: (i % 2) * 32, y: Math.floor(i / 2) * 32, width: 32, height: 32, class: `cover-ground cover-${theme}` });
    return svg;
  }
  add('rect', { width: 64, height: 64, class: 'cover-ground' });
  const motif = add('g', { class: 'cover-motif' });
  for (const [tag, attrs] of MOTIFS[id] ?? []) add(tag, attrs, motif);
  return svg;
}
function ring(doc, fraction, live) {
  const svg = doc.createElementNS(SVGNS, 'svg'); svg.setAttribute('viewBox', '0 0 36 36'); svg.setAttribute('class', 'player-ring'); svg.setAttribute('aria-hidden', 'true');
  if (live) svg.dataset.timerBar = '';
  svg.style.setProperty('--fill', String(Math.round(fraction * 1000) / 10));
  for (const cls of ['ring-track', 'ring-fill']) { const c = doc.createElementNS(SVGNS, 'circle'); c.setAttribute('cx', '18'); c.setAttribute('cy', '18'); c.setAttribute('r', '15.9155'); c.setAttribute('pathLength', '100'); c.setAttribute('class', cls); svg.append(c); }
  return svg;
}
function iconButton(c, name, label, run, cls = '') {
  const b = c.button('', run, `player-btn ${cls}`.trim()); b.replaceChildren(glyph(b.ownerDocument, name)); b.setAttribute('aria-label', label); b.title = label; return b;
}
function range({ el }, { label, min, max, step, value, words, key, onDrag, onSet }) {
  const input = el('input'); input.type = 'range'; input.min = String(min); input.max = String(max); input.step = String(step);
  input.setAttribute('value', String(value)); input.setAttribute('aria-label', label); input.setAttribute('aria-valuetext', words(value)); input.dataset.focusKey = key;
  input.oninput = event => { const live = event.currentTarget, v = Number(live.value); live.setAttribute('value', live.value); live.setAttribute('aria-valuetext', words(v)); onDrag(v, live); };
  input.onchange = event => onSet(Number(event.currentTarget.value));
  return input;
}

export function renderPlayer(view, c) {
  const { el, button, roomCommand } = c, doc = globalThis.document, actions = view.actions ?? [];
  const dragging=c.dragging??sharedDragging,timerChoice=c.timerChoice??{get value(){return timerPick;},set value(value){timerPick=value;try{localStorage.setItem(TIMER_KEY,String(value));}catch{}}};
  const box = el('section', null, 'console-player'); box.setAttribute('aria-label', 'Timer and session music');
  // ── timer ──
  const canTime = actions.includes('set_timer'), running = Boolean(view.timer) && view.phase === 'responses_open';
  if (canTime || running) {
    const row = el('div', null, 'player-timer');
    const parts = running ? timerClockParts(view.timer) : { clock: timerClock(timerChoice.value), detail: 'Timer length', fraction: 1, up: false };
    const face = el('div', null, 'player-clock'); if (parts.up) face.dataset.up = '';
    const digits = el('span', parts.clock, 'player-digits'); const sub = el('span', parts.detail, 'player-sub');
    if (running) { digits.dataset.timerClock = ''; sub.dataset.timerDetail = ''; if (parts.up) digits.dataset.up = ''; }
    face.append(ring(doc, parts.fraction, running), el('span', null, 'player-clock-text'));
    face.lastChild.append(digits, sub);
    row.append(face);
    if (canTime) {
      const verb = view.timer ? 'Restart' : 'Start', step = by => () => {
        const i = Math.max(0, Math.min(TIMER_STOPS.length - 1, TIMER_STOPS.indexOf(timerChoice.value) + by)); timerChoice.value = TIMER_STOPS[i];
        c.render();
      };
      const pick = el('div', null, 'player-pick'); pick.setAttribute('role', 'group'); pick.setAttribute('aria-label', `Timer length ${timerSpoken(timerChoice.value)}`);
      const shorter = iconButton(c, 'minus', 'Shorter timer', step(-1)), longer = iconButton(c, 'plus', 'Longer timer', step(1));
      shorter.dataset.focusKey = 'timer-shorter'; longer.dataset.focusKey = 'timer-longer';
      if (timerChoice.value === TIMER_STOPS[0]) shorter.setAttribute('aria-disabled', 'true');
      if (timerChoice.value === TIMER_STOPS.at(-1)) longer.setAttribute('aria-disabled', 'true');
      pick.append(shorter, el('output', timerClock(timerChoice.value), 'player-pick-value'), longer);
      const go = button('', () => roomCommand('set_timer', { seconds: timerChoice.value }), 'player-btn player-go');
      go.replaceChildren(glyph(doc, view.timer ? 'restart' : 'play')); go.setAttribute('aria-label', `${verb} ${timerClock(timerChoice.value)}`); go.title = `${verb} ${timerClock(timerChoice.value)}`;
      go.dataset.timerStart = verb; go.dataset.focusKey = 'timer-go';
      row.append(pick, go);
      if (view.timer) { const clear = iconButton(c, 'clear', 'No timer', () => roomCommand('set_timer', { seconds: null }), 'player-quiet'); clear.dataset.focusKey = 'timer-clear'; row.append(clear); }
    }
    box.append(row);
  }
  if (actions.includes('cancel_lock')) {
    const auto = view.round?.closing?.auto === true;
    const closing = el('div', null, 'console-closing'); closing.setAttribute('role', 'status');
    closing.append(el('span', auto ? 'Everyone has answered · locking in a few seconds' : 'Locking · phones are sending their answers'),
      button('Keep open', () => roomCommand('cancel_lock'), 'btn quiet'));
    box.append(closing);
  }
  if (actions.includes('set_auto_lock') && ['responses_open', 'surface_live'].includes(view.phase)) {
    const on = view.autoLock !== false, toggle = button('', () => roomCommand('set_auto_lock', { on: !on }), 'player-switch');
    toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-checked', String(on)); toggle.dataset.focusKey = 'auto-lock';
    toggle.replaceChildren(glyph(doc, 'lock'), el('span', 'Lock when everyone connected has answered'));
    box.append(toggle);
  }
  // ── music ──
  if (!actions.includes('set_music')) return box.childNodes.length ? box : null;
  const music = { choice: 'auto', intensity: MUSIC_INTENSITY_DEFAULT, playing: true, volume: MUSIC_VOLUME_DEFAULT, effects: true, transport: null, ...view.music };
  for (const key of ['intensity', 'volume']) if (dragging[key] === music[key]) dragging[key] = null;
  const now = nowPlaying(view, music), playing = music.playing;
  const head = el('div', null, 'player-now');
  const text = el('div', null, 'player-now-text'); text.append(el('span', now.title, 'player-title'), el('span', playing ? now.detail : 'Music paused for the session', 'player-detail'));
  const toggle = iconButton(c, playing ? 'pause' : 'play', playing ? 'Pause session music' : 'Play session music', () => roomCommand('set_music', { playing: !playing }), 'player-go');
  toggle.setAttribute('aria-pressed', String(playing)); toggle.dataset.focusKey = 'music-play';
  head.append(albumCover(doc, now.id), text, toggle);
  const volume = dragging.volume ?? music.volume, intensity = dragging.intensity ?? music.intensity;
  const levels = el('div', null, 'player-levels');
  const speaker = glyph(doc, volume === 0 || !playing ? 'mute' : 'volume');
  const volumeInput = range(c, { label: 'Session music volume', min: 0, max: 100, step: 5, value: volume, words: v => `${v} percent`, key: 'music-volume',
    onDrag: v => { dragging.volume = v; }, onSet: v => { if (validMusicVolume(v)) roomCommand('set_music', { volume: v }); } });
  const effects = iconButton(c, 'effects', music.effects ? 'Session effects on' : 'Session effects off', () => roomCommand('set_music', { effects: !music.effects }), 'player-quiet');
  effects.setAttribute('aria-pressed', String(music.effects)); effects.dataset.focusKey = 'music-effects';
  levels.append(speaker, volumeInput, effects);
  const build = el('div', null, 'player-build');
  const buildValue = el('output', `${intensity}%`, 'player-build-value'); buildValue.setAttribute('aria-hidden', 'true');
  const hint = el('span', buildWords(intensity), 'player-hint');
  const buildInput = range(c, { label: 'Build', min: 0, max: 150, step: 5, value: intensity, words: v => `${v} percent: ${buildWords(v)}`, key: 'music-build',
    onDrag: (v, live) => { dragging.intensity = v; const host = live.closest('.player-build'); host.querySelector('.player-build-value').textContent = `${v}%`; host.querySelector('.player-hint').textContent = buildWords(v); },
    onSet: v => { if (validMusicIntensity(v)) roomCommand('set_music', { intensity: v }); } });
  build.append(glyph(doc, 'build'), el('span', 'Build', 'player-build-label'), buildInput, buildValue, hint);
  const covers = el('div', null, 'player-covers'); covers.setAttribute('role', 'group'); covers.setAttribute('aria-label', 'Question music');
  for (const id of MUSIC_CHOICES) {
    const name = id === 'auto' ? 'Auto · shuffle' : MUSIC_TRACK_NAMES[id], picked = music.choice === id;
    const tile = button('', () => { if (!picked) roomCommand('set_music', { choice: id }); }, 'player-tile');
    tile.setAttribute('aria-pressed', String(picked)); tile.setAttribute('aria-label', name); tile.dataset.focusKey = `music-${id}`;
    const art = el('span', null, 'player-tile-art'); art.append(albumCover(doc, id));
    if (id === 'auto') { const mark = el('span', null, 'player-tile-glyph'); mark.append(glyph(doc, 'shuffle')); art.append(mark); }
    tile.replaceChildren(art, el('span', name, 'player-tile-name'));
    covers.append(tile);
  }
  const music$ = el('div', null, 'player-music'); music$.append(head, levels, build, covers);
  box.append(music$);
  return box;
}
