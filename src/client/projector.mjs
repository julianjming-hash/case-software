import { connect, storedCredential } from './transport.mjs';
import { avatarEl } from './avatar.mjs';
import { avatarParts, AVATAR_COLORS } from '../shared/participant.mjs';
import { parseRoute, displayPairUrl } from '../shared/urls.mjs';
import { isUuidV7 } from '../shared/ids.mjs';
import { cleanText } from '../shared/text.mjs';
import { timerWords, TIMER_ANNOUNCE_AT } from '../shared/timer.mjs';
import { keepScreenAwake } from './device.mjs';
import { acceptDisplayView, acceptLocalFrame, visiblePeople } from './projector-view.mjs';
import { newlyPublicGroup } from './presentation-emphasis.mjs';
import { buildScreen, createProjectorRenderer, refreshCountdown } from './projector-render.mjs';
import { arrivalFeedback } from './lobby-arrivals.mjs';
import { roomCueForChange } from './room-cue-events.mjs';
import { createProjectorSound } from './projector-sound.mjs';
import { reducedMotion } from './appearance-watch.mjs';
import { createRoomMedia, acceptLocalMedia } from './room-media.mjs';

export function mount() {
const route = parseRoute(location.pathname);
const credential = storedCredential('display');
const sessionId = route?.sessionId ?? credential?.sessionId;
const params = new URLSearchParams(location.search);
const topology = params.get('topology') === 'same-pc' ? 'same-pc' : 'separate';
const timeScale = Math.min(1, Math.max(.005, Number(params.get('scale')) || 1));
if (!sessionId || (topology === 'separate' && credential?.sessionId !== sessionId)) { location.replace(displayPairUrl('00000000', location.origin)); return; }
document.body.classList.add('projector');
document.querySelector('main')?.remove();
const { root, parts } = buildScreen(document);
for (const id of ['announce', 'timerStatus']) { const n = document.createElement('div'); n.id = id; n.className = 'sr-only'; n.setAttribute('aria-live', 'polite'); document.body.append(n); }
document.body.prepend(root);
let roomArt = null, closed = false; // splash.mjs, lazy (card 36b)
keepScreenAwake();
const reduced = reducedMotion();
const sound = createProjectorSound({ getView: () => current().view, changed: () => render() });
let audioSource = null, audioEpoch = null;
const trackedFetch = async (...args) => { const response = await fetch(...args); if (response.ok) lastContact = Date.now(); return response; };
class ContactSocket extends WebSocket { constructor(...args) { super(...args); this.addEventListener('message', () => { lastContact = Date.now(); }); } }
const link = credential?.sessionId === sessionId ? connect({ role: 'display', api: location.origin, sessionId, timeScale, timings: { LONG_POLL_WAIT_S: Math.max(1, Math.round(10 * timeScale)) }, fetchImpl: trackedFetch, WebSocketImpl: ContactSocket }) : null;
// ── state ──
let server = null;          // latest server snapshot { epoch, revision, view }
let local = null;           // latest local_snapshot (same-PC manual mode) { epoch, revision, view }
let status = 'connecting';  // link status
let lastContact = Date.now();
let lostNotice = false;
let presented = false;

// Lobby arrivals (2026-10-10): each newly appended person's chip waits, hidden, while their avatar's join moment plays
// in the art (splash.mjs projectorJoin); it lands in "In the room" and only then does the count update. Anonymous:
// only the avatar and the count, which this screen already shows. Under reduced motion nothing waits.
let arrivalPrevious = null, joinsToPlay = [];
const pending = new Map(); // roster index → avatarId whose chip is still waiting for its avatar to land
const arrivalStatus = document.createElement('div');
arrivalStatus.className = 'arrival-status sr-only'; arrivalStatus.setAttribute('role', 'status');
arrivalStatus.setAttribute('aria-live', 'polite'); arrivalStatus.setAttribute('aria-atomic', 'true');
document.body.append(arrivalStatus);
function noteArrivals(view) {
  const cue = view ? arrivalFeedback(arrivalPrevious, view, { reducedMotion: reduced.matches }) : null;
  arrivalPrevious = view;
  if (view?.phase !== 'waiting') { arrivalStatus.textContent = ''; pending.clear(); joinsToPlay = []; return; }
  arrivalStatus.dataset.arrivals = view.arrivalCount;
  if (!cue) return;
  arrivalStatus.textContent = `${cue.count} joined`;
  const { people } = visiblePeople(view);
  for (const index of cue.indices) {
    const avatarId = people[index]?.avatarId, colour = AVATAR_COLORS.find(c => c.id === avatarParts(avatarId)?.colorId);
    if (!colour) continue;
    pending.set(index, avatarId);
    joinsToPlay.push({ image: avatarEl(avatarId, { size: 160 }), ink: colour.ink, background: colour.background,
      target: () => $('foot').querySelector(`.names li[data-index="${index}"]`) ?? $('foot').querySelector('.names .chip.more'),
      landed: () => landed(index, avatarId) });
  }
}
/** Hand queued arrivals to the art once its chunk has loaded (its first render calls this again); no art lands them at once. */
function playJoins() {
  if (!joinsToPlay.length || !roomArt || roomArt instanceof Promise) return;
  const specs = joinsToPlay.splice(0);
  if (roomArt.projectorJoin) roomArt.projectorJoin(root, specs); else for (const spec of specs) spec.landed();
}
const waitingFor = (index, avatarId) => pending.get(index) === avatarId;
function landed(index, avatarId) {
  if (!waitingFor(index, avatarId)) return;
  pending.delete(index);
  const view = current().view;
  if (closed || view?.phase !== 'waiting') return;
  const hadFocus = sound.focus(); renderFooter(view); fitNames(); if (hadFocus) sound.restoreFocus(hadFocus);
  if (!reduced.matches) $('foot').querySelector(`.names li[data-index="${index}"]`)?.animate([{ transform: 'scale(1.25)' }, { transform: 'none' }], { duration: 300, easing: 'ease-out' });
}


const $ = (id) => document.getElementById(id);
// Card 59 M3: released images. A paired display fetches with its own credential; a same-PC window has none and shows
// the bytes its console relays over the local channel.
const roomMedia = createRoomMedia({ role: 'display', load: link ? (handle, rendition) => link.mediaBytes(handle, rendition) : null, onChange: () => { if (!closed) render(); },
  want: handle => { try { lc?.postMessage({ t: 'projector_wants', sessionId, handle }); } catch { /* a closed channel */ } } });
const { renderTop, renderMain, renderFooter, fitNames, fit, placements } = createProjectorRenderer({ doc: document, parts, origin: location.origin, topology, media: roomMedia.resolve,
  status: () => status, lost: () => lostNotice, waitingFor: (index, avatarId) => waitingFor(index, avatarId), sound, onReady: () => { if (!closed) render(); } });

// ── what to render: the server snapshot, or the console's local view (same PC, manual mode) ──
function current() {
  if (topology === 'same-pc' && local && local.epoch >= (server?.epoch ?? 0)) return { view: local.view, from: 'local' };
  return server ? { view: server.view, from: 'server' } : { view: null, from: 'none' };
}

// Cues follow the selected public view, never an inactive transport source.
// Once this projector has presented material, leaving the join screen restores it silently.
function changed(previous) {
  const view = current().view;
  const source = current().from;
  const epoch = source === 'local' ? local?.epoch : server?.epoch;
  const recovery = audioSource !== source || audioEpoch !== epoch; audioSource = source; audioEpoch = epoch;
  if (recovery) sound.recover();
  const baseline = sound.update(view, { baseline: recovery });
  const cue = baseline ? null : roomCueForChange(previous, view, presented);
  if (cue || previous?.phase !== view.phase || view.replay || view.manual || previous?.decision?.decisionId !== view.decision?.decisionId || previous?.surface?.surfaceId !== view.surface?.surfaceId) sound.cancel();
  noteArrivals(view); void sound.play(cue);
  presented ||= view.phase !== 'waiting';
  render();
}

link?.on('snapshot', (snap) => {
  if (!acceptDisplayView(snap.view) || snap.view.sessionId !== sessionId) return;
  const previous = current().view;
  server = snap; lastContact = Date.now();
  if (local && snap.epoch > local.epoch) local = null;
  changed(previous);
});
link?.on('status', (s) => { if (s !== status) sound.recover(); status = s; render(); });
link?.on('error', error => {
  if (error === 'unauthorised' || error === 'unknown_room') {
    link.forget(); cleanup(); location.replace(displayPairUrl('00000000', location.origin));
  }
});
let lc = null; let hello = null;
if (topology === 'same-pc') {
  lc = new BroadcastChannel('case-room-local');
  // CASE-327: with this window's size, so the console's Room sees draws the same screen.
  const say = () => lc.postMessage({ t: 'projector_hello', sessionId, width: innerWidth, height: innerHeight });
  // A window that has just opened (or reloaded) holds no relayed media yet: the console sends it all once more (card 59).
  lc.postMessage({ t: 'projector_ready', sessionId });
  say(); hello = setInterval(say, Math.max(10, 4000 * timeScale));
  lc.onmessage = ({ data: frame }) => {
    if (frame?.t === 'mute_projector') {
      if (Object.keys(frame).length === 3 && frame.sessionId === sessionId && isUuidV7(frame.requestId)) {
        sound.mute(); render();
        lc.postMessage({ t: 'projector_muted', sessionId, requestId: frame.requestId });
      }
      return;
    }
    const image = acceptLocalMedia(frame, sessionId);
    if (image) { roomMedia.put(image.handle, image.bytes, image.type); return; }
    const accepted = acceptLocalFrame(frame, sessionId, local);
    if (accepted) { const previous = current().view; local = accepted; changed(previous); }
    else if (frame?.t === 'local_end' && frame.sessionId === sessionId && Object.keys(frame).length === 2) { sound.mute(); if (local?.view.phase !== 'ended') local = null; render(); }
    else if (frame?.t === 'show_projector' && frame.sessionId === sessionId && Object.keys(frame).length === 2) showProjectorWord();
    // Console layout v2: End case from Debrief closes this computer's projector window (a window it opened; else a no-op).
    else if (frame?.t === 'close_projector' && frame.sessionId === sessionId && Object.keys(frame).length === 2) { sound.mute(); window.close(); }
  };
}
// The display check: the word `Projector` fills this screen for a moment, so the facilitator can
// see which physical screen is the projector (and that the console is not duplicated onto it).
function showProjectorWord() {
  let o = document.getElementById('projectorCheck');
  if (!o) {
    o = document.createElement('div');
    o.id = 'projectorCheck';
    o.setAttribute('role', 'status');

    o.textContent = 'Projector';
    document.body.append(o);
  }
  o.hidden = false;
  clearTimeout(showProjectorWord.t);
  showProjectorWord.t = setTimeout(() => { o.hidden = true; }, 6000 * timeScale);
}

const clock = setInterval(() => {
  if (topology === 'separate') {
    const stale = Date.now() - lastContact > 15000 * timeScale;
    if (stale !== lostNotice) { lostNotice = stale; render(); }
  }
  tickTimer();
}, Math.max(10, 250 * timeScale));

// ── advisory timer: text only, announced politely at 60 s, 10 s and 0 only. ONE rounding with the
// console and the phones (src/shared/timer.mjs; walkthrough bug 3). ──
let timerKey = null; const announced = new Set();
function tickTimer() {
  const { view } = current();
  // CASE-334: words, numeral, bar and state from the authoritative deadline on every tick (no chained countdown).
  const now = refreshCountdown(document, view);
  if (!now) return;
  const rem = now.remaining;
  const key = view.timer.endsAt ?? `p${view.timer.remainingS}`;
  if (key !== timerKey) { timerKey = key; announced.clear(); }
  for (const mark of [...TIMER_ANNOUNCE_AT].reverse()) {
    if (rem <= mark && !announced.has(mark)) {
      announced.add(mark);
      if (mark === 60 && (announced.has(10) || announced.has(0))) continue;
      $('timerStatus').textContent = timerWords(mark);
      break;
    }
  }
}

window.addEventListener('resize', render);

let lastKey = null, lastPresented = null;
function announceIfChanged(view, group) {
  const surface = view?.surface;
  const groupSignature = surface ? JSON.stringify([surface.scene, surface.observations, surface.points, surface.investigations, surface.slide?.reading_order]) : '';
  const key = view ? [view.phase, view.joiningClosed, view.surface?.surfaceId, groupSignature, view.manual, view.replay, view.decision?.prompt, view.decision?.status, !!view.lastResult].join('|') : 'none';
  if (key === lastKey) return;
  lastKey = key;
  if (!view) return;
  const say = view.phase === 'waiting' ? `${view.caseTitle}. ${view.joiningClosed ? 'Joining is closed' : 'Join the case'}`
    : view.phase === 'decision_open' ? 'Prompt'
    : view.phase === 'reviewing' ? (view.manual ? 'Manual session mode. Facilitator-led discussion' : 'Responses locked. Facilitator reviewing')
    : view.phase === 'paused' ? 'Discussion pause'
    : view.phase === 'ended' ? 'Session ended'
    : view.phase === 'debrief' && !view.surface ? 'Debrief. Your recap and the feedback form are on your phone'
    : `${view.surface?.title ?? ''}`;
  $('announce').textContent = group ? `New ${group} shared. ${say}` : say;
}

function render() {
  const hadFocus = sound.focus();
  const { view, from } = current();
  // Card 59: the room's images leave this screen's memory when the room ends.
  if (view?.phase === 'ended') roomMedia.clear();
  // A slide step that adds blocks to the same slide is announced like a newly shared group (card 57).
  const slideStep = view?.surface?.slide && !view.replay && lastPresented?.slide && lastPresented.surfaceId === view.surface.surfaceId
    && view.surface.slide.reading_order.length > lastPresented.slide.reading_order.length;
  const accentGroup = view && !view.replay ? (slideStep ? 'step' : newlyPublicGroup(lastPresented, view.surface)) : null;
  lastPresented = view?.replay ? null : view?.surface ?? null;
  renderTop(view, from);
  renderMain(view, placements(view)[0]);
  if (roomArt?.projectorArt) roomArt.projectorArt(root, view); else roomArt ||= import('./splash.mjs').then(m => { roomArt = m; if (!closed) render(); }, () => { roomArt = {}; });
  renderFooter(view);
  announceIfChanged(view, accentGroup);
  fit(view);
  const accentSelector = { scene: '.scene', observations: '.vitals', findings: '.findings', investigations: '.investigations' }[accentGroup];
  if (accentSelector) $('main').querySelector(accentSelector)?.classList.add('presentation-new-group');
  fitNames();
  playJoins();
  if (hadFocus) sound.restoreFocus(hadFocus);
  document.title = 'Case projector';
  document.documentElement.dataset.topology = topology;
  document.documentElement.dataset.source = from;
}
render();

function cleanup() { sound.close(); closed = true; roomMedia.dispose(); roomArt?.projectorArt?.(root, null); pending.clear(); arrivalStatus.remove(); clearInterval(clock); clearInterval(hello); clearTimeout(showProjectorWord.t); lc?.close(); link?.close(); lastPresented = null; window.removeEventListener('resize', render); }
window.addEventListener('pagehide', cleanup, { once: true });
return { close: cleanup };
}
