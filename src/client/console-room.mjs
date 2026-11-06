import { renderOptions, renderSurface, renderAggregate, renderRoutes as renderTeachingRoutes, renderTeachingDock, renderTeachingSecondary, renderOnlyYou } from './teaching-controls.mjs';
import { enhanceSelect } from './accessible-select.mjs';
import { createConsoleSelects } from './console-selects.mjs';
import { menuIdentity } from './navigation-access.mjs';
import { attachSiteMenu } from './shared-menu.mjs';
import { wordmark } from './site-header.mjs';
import { readDevicePreferences, writeDevicePreference, DEVICE_PREFERENCE_KEYS, DEVICE_PREFERENCES_CHANGE } from './device-preference-values.mjs';
import { readAudioLevel } from './audio-preferences.mjs';
import { readVolume } from './room-volume.mjs';
import { accountRequest } from './auth-ui.mjs';
import { presentationTiles } from './console-timeline.mjs';
// The facilitator's served room surface. The room capability, mirror and case
// pack remain in this closure; the local projector receives display frames only.
import { connect } from './transport.mjs';
import { keepScreenAwake } from './device.mjs';
import { primaryAction, dockControl, refusedCommandNotice, armedRoute, armsFirst, debriefSteps, debriefQuestionStep } from './console-actions.mjs';
import { markFor, markSvg } from './projector-marks.mjs';
import { consolePublicSurface, presentationNav } from './presentation-nav.mjs';
import { facilitatorKey } from './keymap.mjs';
import { createDisplayCheck, createProjectorHandshake } from './console-device.mjs';
import { phaseModel } from './console-view.mjs';
import { createRouteSelection } from './console-route-selection.mjs';
import { consoleRankingRows, renderRankedControls } from './console-ranking.mjs';
import { projectorFrame, publishProjectorFrame } from './console-projection.mjs';
import { roomDebrief, CLASS } from './debrief-model.mjs';
import { summaryPages } from '../shared/debrief-pages.mjs';
import { createMediaRelay, acceptMediaWanted } from './room-media.mjs';
import { ConsoleManualRoom } from './console-manual.mjs';
import { createManualRecovery } from './console-recovery.mjs';
import { samePcProjectorUrl, joinUrl, localNotesObjectUrl, casesUrl, displayPairUrl } from '../shared/urls.mjs';
import { formatCode, isUuidV7, uuidv7 } from '../shared/ids.mjs';
import { cleanText } from '../shared/text.mjs';
import { timerRemainingS, timerWords } from '../shared/timer.mjs';
import { focusAfterConsoleUpdate, patchChildren, helloNeedsRender } from './console-focus.mjs';
import { observeDisplayTopology } from './console-screen.mjs';
import { reducedMotion as reducedMotionQuery } from './appearance-watch.mjs';

// Console layout v2 (Julian, 2026-10-18): the console's two panel dividers, in CSS pixels, on this device only.
// Exact and non-personal: two optional integers in range, or nothing.
const CONSOLE_SPLIT_KEY = 'case:preferences:console-split';
const splitValue = (value, max) => Number.isSafeInteger(value) && value >= 96 && value <= max ? value : null;
export function readConsoleSplit(storage) {
  try {
    const raw = storage?.getItem(CONSOLE_SPLIT_KEY);
    const match = typeof raw === 'string' ? /^(\d{1,4}|-),(\d{1,4}|-)$/.exec(raw) : null;
    if (!match) return { left: null, sees: null };
    return { left: splitValue(match[1] === '-' ? null : Number(match[1]), 4000), sees: splitValue(match[2] === '-' ? null : Number(match[2]), 3000) };
  } catch { return { left: null, sees: null }; }
}
function writeConsoleSplit(storage, { left = null, sees = null } = {}) {
  const l = splitValue(left, 4000), r = splitValue(sees, 3000);
  try {
    if (l === null && r === null) storage?.removeItem(CONSOLE_SPLIT_KEY);
    else storage?.setItem(CONSOLE_SPLIT_KEY, `${l ?? '-'},${r ?? '-'}`);
    return true;
  } catch { return false; }
}

const MAX_TEXT = 2_000;
const CLASSIFICATION = Object.freeze({
  sound: '● Sound', defensible: '◯ Defensible',
  'context-dependent': '⑂ Context-dependent', unsafe: '▲ Unsafe · recoverable',
  'terminal-unsafe': '⬣ Terminal · needs a checkpoint reset',
  'discussion-prompt': '▤ Discussion prompt',
});
function el(tag, text, className) {
  const item = document.createElement(tag);
  if (text != null) item.textContent = cleanText(text, MAX_TEXT);
  if (className) item.className = className;
  return item;
}
function button(label, action, className = 'btn') {
  const item = el('button', label, className);
  item.type = 'button';
  item.dataset.focusKey = label;
  item.onclick = action; // a property, so a kept node takes the fresh render's handler (console-focus.mjs)
  return item;
}
function section(title, className = 'console-card') {
  const item = el('section', null, className);
  item.append(el('h2', title));
  return item;
}
function addTextList(parent, items, className = '') {
  if (!items?.length) return;
  const list = el('ul', null, className);
  for (const text of items) list.append(el('li', text));
  parent.append(list);
}

// Card 36b Run columns. The Only you renderer stays in this module, which the projector and phone graphs
// never reach (tests/surface-parity-36b.test.mjs; CASE-092/093).
function column(className, heading) {
  const col = el('section', null, `console-col ${className}`), label = el('h2', heading, 'console-zone-label');
  label.id = `${className}-label`; col.setAttribute('aria-labelledby', label.id); col.append(label);
  return col;
}
/** The violet private zone: notes, the beat's cue and the media notice; null when there is none. */
// Card 37: options as the room sees them (the phone's tile, mark, mark name and authored order, CASE-088), with
// the facilitator-only route detail as Only you callouts. Rendered here only, from the facilitator projection.
export function mountConsoleRoom(host, { auth, sessionId, joinCode, facilitatorToken,
  restoredSaved = null, readyNotice = '', onEnded = () => {}, onSignOut = null, onLeave = () => {}, projectorWindow = null } = {}) {
  let token = facilitatorToken;
  let local, check, hello, wake, link;
  try {
    // All local prerequisites must exist before a capability-bearing transport
    // starts. A failed channel cannot leave a live room connection behind.
    local = new BroadcastChannel('case-room-local');
    check = createDisplayCheck();
    hello = createProjectorHandshake(sessionId);
    wake = keepScreenAwake();
    link = connect({ role: 'facilitator', api: location.origin, sessionId, token });
  } catch (error) {
    try { link?.close(); } catch {}
    try { wake?.dispose(); } catch {}
    try { local?.close(); } catch {}
    throw error;
  }
  token = null; facilitatorToken = null;
  // Card 59 M3: the same-PC projector has no credential; the console relays the bytes of released images to it, and
  // keeps every image of its room in memory (it may see them all, CASE-092) so manual mode still shows them.
  const mediaRelay = createMediaRelay({ load: (handle, rendition) => link.mediaBytes(handle, rendition), sessionId,
    post: message => { try { local.postMessage(message); } catch { /* a closed channel ends the relay */ } } });
  let mediaPrefetched = false;
  let privateView=null,mapChunk=null,mapLoading=false,privateRenderer=null,privateKind=null;
  let snapshot = null, pack = null, manual = null, recovery = null, roomStatus = 'connecting';
  let pendingSaved = restoredSaved;
  restoredSaved = null;
  const tab = 'run'; // console layout v2: one screen, no tabs (Julian, 2026-10-18); kept for the focus contract
  let pickedPathId = null, armedUntil = 0, showFallback = false;
  // Console layout v2: the Room setup sheet, the projector pairing card, the folded/hidden panels (this room only) and
  // the per-device split sizes; `armed` is the one in-place press-again confirm (no pop-ups, Julian 2026-10-18).
  let sheetOpen = false, pairOpen = false, seesFolded = false, decisionHidden = false, armed = null, armedTimer = null;
  let split = readConsoleSplit(preferenceStorageEarly());
  const routeSelection=createRouteSelection(),openRouteNotes=new Set();
  const preferenceStorage=()=>{try{return window.localStorage;}catch{return null;}};
  function preferenceStorageEarly(){try{return window.localStorage;}catch{return null;}}
  let projectorWordShown = false;
  let busy = false, closed = false, statusText = readyNotice;
  let projectorOptions = false, displayApprovalPending = false;
  let muteRequestId = null, muteTimer = null, muteStatus = '';
  // CASE-171: console UI tones. Off until this console's own sound toggle is pressed (that press is the gesture).
  let uiAudio = null, uiSoundOn = false;
  let uiSoundPending = false, uiSoundGeneration = 0, uiSoundModuleFailed = false;
  // CASE-255: the dock's Session sound switch. Off asks the same-PC projector to mute and turns console sounds off, through
  // the Menu's own two actions; on turns back on only the console sounds it turned off (a projector unmutes on itself).
  let roomQuiet = false, quietSilencedTones = false;
  const reducedMotion = reducedMotionQuery();
  let uiTones = null; // loaded on first toggle: a lazy chunk (console-tones.mjs) that only this console ever imports
  let renderedPhase = null, renderedTab = null, deferred = false;
  let coverCanvas = null, splash = null; // splash.mjs: the shared lazy art chunk (CASE-173)
  // CASE-327: Room sees is a copy of the projector screen (console-mirror.mjs, lazy); until it loads, the text view stands in.
  let mirror = null, mirrorLoading = false, mirrorFailed = false;
  let armTimer = null, fallbackTimer = null;
  const root = el('section', null, 'console-room');
  host.replaceChildren(root);
  const selects=createConsoleSelects(root,{enhance:enhanceSelect});
  const roomMenuButton=button('Menu',()=>{},'btn tertiary console-menu-button');roomMenuButton.setAttribute('aria-label','Open menu');
  const leaveConsole=({kind}={})=>{
    if (busy || displayApprovalPending || recovery?.pending || recovery?.conflict) { statusText = 'Wait for the current operation to finish before leaving. Check any uncertain outcome first.'; render(); return false; }
    if (!window.confirm(manual ? 'Leave this console? Unexported manual notes on this tab will be discarded. The server session is not ended.' : 'Leave this console? The session will keep running and you will need to Rejoin to control it again.')) return false;
    close({preserveSegment:kind==='history'}); onLeave({preserveResume:kind==='history'}); return true;
  };
  const loadRoomMenuAccount=auth&&onSignOut?async()=>{
    const capturedAccess=auth.accessToken();if(!capturedAccess)return null;
    const me=await accountRequest(auth,['me'],{query:new URLSearchParams({limit:'20'})});
    if(closed||capturedAccess!==auth.accessToken())throw new Error('account_changed');
    return menuIdentity(me,onSignOut);
  }:null;
  const roomMenu=attachSiteMenu(roomMenuButton,{current:'run',beforeNavigate:leaveConsole,
    signOutMessage: () => manual ? 'Sign out and discard private information and unexported manual notes on this device? This does not end the server session.' : 'Sign out and clear private information on this device? The session will keep running.',
    loadAccount:loadRoomMenuAccount});
  if(loadRoomMenuAccount)void loadRoomMenuAccount().then(identity=>{if(!closed)roomMenu.setAccount(identity);}).catch(()=>{});
  const preferenceChanged=event=>{
    if(event.type==='storage'&&event.key!==null&&!Object.values(DEVICE_PREFERENCE_KEYS).includes(event.key))return;
    const preferences=readDevicePreferences(preferenceStorage());
    if(!preferences.uiTones){uiSoundGeneration++;uiSoundPending=false;uiSoundOn=false;uiTones?.cancel();}if(!closed)render();
  };
  window.addEventListener('storage',preferenceChanged);window.addEventListener(DEVICE_PREFERENCES_CHANGE,preferenceChanged);
  async function toggleUiSounds(){
    if(closed)return;
    uiTones?.cancel();
    if(uiSoundModuleFailed){location.reload();return;}
    if(uiSoundOn||uiSoundPending){uiSoundGeneration++;uiSoundPending=false;uiSoundOn=false;writeDevicePreference(preferenceStorage(),'uiTones',false);render();return;}
    const generation=++uiSoundGeneration,current=()=>!closed&&generation===uiSoundGeneration;
    uiSoundPending=true;render();
    try{
      // Resume is invoked in this press's stack, before awaiting the optional module.
      uiAudio??=new AudioContext();await uiAudio.resume();
      if(!current())return;
      let chunk;
      try{chunk=await import('./console-tones.mjs');}
      catch{
        uiSoundModuleFailed=true;
        if(current()){uiSoundOn=false;statusText='Console sound module could not load. Reload the page to try again.';}
        if(!closed)render();return;
      }
      if(!current())return;
      uiTones??=chunk.createUiTonePlayer({enabled:()=>uiSoundOn&&readDevicePreferences(preferenceStorage()).uiTones,reduced:()=>reducedMotion.matches,hidden:()=>document.hidden,getContext:()=>uiAudio,
        volume:()=>readAudioLevel(preferenceStorage(),'effects',readVolume(preferenceStorage()))});
      uiSoundOn=uiAudio.state==='running';if(uiSoundOn)writeDevicePreference(preferenceStorage(),'uiTones',true);
      if(!uiSoundOn)statusText='Console sound is not running. Try enabling it again.';
    }catch{if(current()){uiSoundOn=false;statusText='Console sound is unavailable. Try enabling it again.';}}
    finally{if(current()){uiSoundPending=false;render();}}
  }
  function toggleRoomSound(){
    if(closed)return;
    if(!roomQuiet){
      roomQuiet=true;quietSilencedTones=(uiSoundOn||uiSoundPending)&&!uiSoundModuleFailed;
      if(quietSilencedTones)void toggleUiSounds();
      muteProjector();return;
    }
    roomQuiet=false;muteStatus='Session sound on. Press Session sound on the projector to bring its music back.';
    if(quietSilencedTones&&!uiSoundOn&&!uiSoundPending&&!uiSoundModuleFailed){quietSilencedTones=false;void toggleUiSounds();}
    else{quietSilencedTones=false;render();}
  }
  // Console layout v2 (Julian, 2026-10-18): every confirm is in place. The first press arms the control and the bottom
  // bar's line says what it does; a second press counts only after 600 ms (a double-click cannot fire it) and within 3 s.
  const ARM_HINTS = {
    end: () => manual ? 'Ends this local presentation. If offline, the server session may stay open: confirm it when online.'
      : currentView()?.phase === 'debrief' ? 'Ends the session for everyone and closes the projector. Phones keep their recap for 24 hours.'
      : 'Ends the session for everyone. Phones keep their recap for 24 hours.',
    debrief: () => 'Phones get their recap and feedback opens. Back to the case undoes it.',
    manual: () => ['responses_open', 'responses_locked'].includes(currentView()?.phase) ? 'Discards the open round. This computer runs the session alone; phones pause until you rejoin online.'
      : 'This computer runs the session alone. Phones pause until you rejoin online.',
    'void-round': () => 'Discards this round\u2019s answers. They are never used.',
    takeover: () => 'Makes this the only console. The other consoles stop.',
  };
  function armHint() { if (!armed) return ''; if (armed.hint) return armed.hint; const hint = ARM_HINTS[armed.id] ?? ARM_HINTS[armed.id.replace(/-.*$/, '')]; return hint ? hint() : 'Press again to confirm.'; }
  function disarm() { armed = null; clearTimeout(armedTimer); armedTimer = null; }
  function pressArmed(id, run, hint = '') {
    if (closed || busy || recovery?.pending) return;
    if (armed?.id === id) { if (Date.now() - armed.at < 600) return; disarm(); run(); render(); return; }
    disarm(); armed = { id, at: Date.now(), hint };
    armedTimer = setTimeout(() => { armed = null; if (!closed) render(); }, 3_000);
    render();
  }
  function armable(id, label, armedLabel, run, className = 'btn', hint = '') {
    const isArmed = armed?.id === id;
    const item = button(isArmed ? armedLabel : label, () => pressArmed(id, run, hint), isArmed ? `${className} is-armed` : className);
    item.dataset.focusKey = `arm-${id}`; // stable across the label change, so focus stays on it
    item.setAttribute('aria-describedby', 'console-dock-status');
    if (busy || recovery?.pending) item.setAttribute('aria-disabled', 'true');
    return item;
  }

  // Card 29: room-scoped shared-computer approval, only on a console that holds the facilitator's account.
  let sharedComputer = null; // created by the Room tab chunk on first use, then kept across re-renders
  let consoleList = null; // card 35b: the starter's console list, fetched when the Room tab first renders
  let pointerActivation = null;
  const onPointerDown = event => {
    if (closed || event.button !== 0 || event.isPrimary === false) return;
    const target = event.target.closest?.('button');
    if (target && !target.disabled && root.contains(target)) pointerActivation = { id: event.pointerId, target };
  };
  const finishPointerActivation = () => {
    if (!pointerActivation) return;
    pointerActivation = null;
    if (!closed) render();
  };
  const onPointerUp = event => {
    if (pointerActivation?.id !== event.pointerId) return;
    // A release on this control is followed by click. Keep its listener alive
    // until that click has bubbled through the control's own handler.
    if (pointerActivation.target.disabled || !pointerActivation.target.isConnected ||
        !pointerActivation.target.contains(event.target)) finishPointerActivation();
  };
  const onPointerCancel = event => {
    if (pointerActivation?.id === event.pointerId) finishPointerActivation();
  };
  root.addEventListener('pointerdown', onPointerDown, true);
  root.addEventListener('click', finishPointerActivation);
  const onUiClick = event => { const control = event.target.closest?.('button'); if (control && !control.disabled) void uiTones?.press(control); };
  root.addEventListener('click', onUiClick);
  window.addEventListener('pointerup', onPointerUp, true);
  window.addEventListener('pointercancel', onPointerCancel, true);
  window.addEventListener('blur', finishPointerActivation);
  let topology = null;
  // Bumped on every display this console approves, so a new or replacement
  // display is a pairing change that clears the display check (CASE-165).
  let pairingGeneration = 0;
  // Reads count and screen identity live from the observer (CASE-167).
  const updateDisplaySafety = () => {
    if (closed || !topology) return;
    const previouslyConfirmed = !check.needsCheck();
    check.update({ connected: hello.alive(Date.now()), displayCount: topology.count,
      pairingId: `pairing-${pairingGeneration}`, screenId: topology.fingerprint });
    if (previouslyConfirmed && check.needsCheck()) {
      statusText = 'The projector connection changed. Check the room screen if needed.';
      render();
    }
  };
  topology = observeDisplayTopology({ onChange: updateDisplaySafety });
  updateDisplaySafety();
  topology.ready.then(() => { if (!closed && topology.canRequestScreens) render(); });
  const displayTimer = setInterval(updateDisplaySafety, 2000);
  // CASE-334: the timer clock reads the authoritative deadline every quarter second and patches only its own text, never a
  // chained countdown; crossing zero re-renders once so the panel shows that time is up while answers stay open.
  const clockTimer = setInterval(() => {
    const view = currentView(), parts = view?.timer && !closed ? roomTab?.timerClockParts?.(view.timer) : null;
    if (!parts) return;
    for (const node of root.querySelectorAll('[data-timer-clock]')) {
      if (('up' in node.dataset) !== parts.up) { render(); return; }
      if (node.textContent !== parts.clock) node.textContent = parts.clock;
    }
    for (const node of root.querySelectorAll('[data-timer-detail]')) if (node.textContent !== parts.detail) node.textContent = parts.detail;
    for (const node of root.querySelectorAll('[data-timer-bar]')) node.style.setProperty('--fill', String(Math.round(parts.fraction * 1000) / 10));
  }, 250);

  function currentView() { return manual ? manual.view() : snapshot?.view ?? null; }
  function restoreVerifiedSegment() {
    if (!pendingSaved || !snapshot?.mirror || !pack) return;
    const saved = pendingSaved; pendingSaved = null;
    if (snapshot.mirror.sessionId !== sessionId) return;
    manual = ConsoleManualRoom.restore(snapshot.mirror, pack, saved, { channel: local, onFrame: view => void mediaRelay.frame(view) });
    if (manual) recovery = createManualRecovery(manual, body => link.uploadSegment(body));
    else {
      try { sessionStorage.removeItem(`case-lab:segment:${sessionId}`); } catch {}
      statusText = 'The saved manual room no longer matches this room. Downloaded notes remain on your device.';
    }
  }
  /** The display projection the projector window is drawing now: the manual room's own, else the online room's. */
  function shownOnProjector() {
    try { return manual && snapshot?.view.phase !== 'ended' ? manual.displayView() : projectorFrame(snapshot, pack)?.view ?? null; } catch { return null; }
  }
  function publish() {
    const frame = projectorFrame(snapshot, pack);
    if (!manual || snapshot?.view.phase === 'ended') { if (publishProjectorFrame(local, frame, sessionId)) void mediaRelay.frame(frame.view); }
    if (!mediaPrefetched && snapshot?.mirror?.media) { mediaPrefetched = true; void mediaRelay.prefetch(Object.values(snapshot.mirror.media).map(item => item.handle).filter(Boolean)); }
  }
  function close({ preserveSegment = false } = {}) {
    if (closed) return;
    closed = true;
    try{mediaRelay.dispose();}catch{}try{mirror?.close();}catch{}
    try{selects.dispose();}catch{}try{roomMenu.remove();}catch{}window.removeEventListener('storage',preferenceChanged);window.removeEventListener(DEVICE_PREFERENCES_CHANGE,preferenceChanged);
    try{sharedComputer?.close();}catch{}
    pointerActivation = null;
    root.removeEventListener('pointerdown', onPointerDown, true);
    root.removeEventListener('click', finishPointerActivation);
    root.removeEventListener('click', onUiClick);
    try{uiTones?.cancel();}catch{}uiSoundOn = false;try{uiAudio?.close()?.catch(() => {});}catch{}
    window.removeEventListener('pointerup', onPointerUp, true);
    window.removeEventListener('pointercancel', onPointerCancel, true);
    window.removeEventListener('blur', finishPointerActivation);
    clearTimeout(armTimer); clearTimeout(fallbackTimer); clearTimeout(muteTimer);
    muteRequestId = null; muteStatus = '';
    clearInterval(displayTimer); clearInterval(clockTimer); topology.dispose();
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('keydown', onPresentationKey);
    closeConsoleResources({ sessionId, manual, local, link, wake, preserveSegment });
    manual = null; recovery = null;
    try{privateRenderer?.close();}catch{}privateRenderer=null;mapChunk=null;privateView=null;
    snapshot = null; pack = null; pendingSaved = null; pickedPathId = null; routeSelection.clear();openRouteNotes.clear(); armedUntil = 0;
    root.replaceChildren();
  }
  function onPageHide() { close({ preserveSegment: true }); }
  window.addEventListener('pagehide', onPageHide, { once: true });
  // The shared keymap (CASE-249): the same keys as the Run preview and the Builder.
  function onPresentationKey(event) {
    if (closed) return;
    const view = currentView();
    if (!view) return;
    const nav = presentationNav(view), steps = view.phase === 'debrief' ? debriefSteps(view) : null;
    const action = facilitatorKey(event, {
      hasMoreGroup: view.actions?.includes('advance') && Boolean(view.presentation?.nextGroup),
      replaying: steps ? steps.at !== null : nav.replaying, canReplayForward: steps ? Boolean(steps.forward) : nav.canForward,
      canReplayBack: steps ? Boolean(steps.back) : nav.canBack, overlay: Boolean(privateView),
    });
    if (!action || (tab !== 'run' && !['escape', 'help', 'save'].includes(action))) return;
    event.preventDefault();
    // Space presses the main action; a route reveal asks twice from the keyboard (Julian, 2026-10-14; reverses CASE-140).
    if (action === 'advance') {
      const control = armedRoute(dockControl(view, { pickedPathId, armedUntil, pending: recovery?.pending, debriefArmed: armed?.id === 'debrief' }), armedUntil);
      if (armsFirst(control) && !control.armed && !busy) { armedUntil = Date.now() + 3_000; clearTimeout(armTimer); armTimer = setTimeout(() => { armedUntil = 0; render(); }, 3_000); render(); }
      else doPrimary();
    }
    else if (action === 'reveal_group') roomCommand('advance');
    else if (steps && ['replay_back', 'replay_forward'].includes(action)) { const step = action === 'replay_back' ? steps.back : steps.forward; if (step) roomCommand(step.command, step.payload); }
    else if (action === 'replay_back') roomCommand('replay', { entryIndex: nav.backTarget });
    else if (action === 'replay_forward') roomCommand('replay', { entryIndex: nav.forwardTarget });
    else if (action === 'undo') { const undo = root.querySelector('.console-undo'); if (undo && undo.getAttribute('aria-disabled') !== 'true') undo.click(); }
    else if (action === 'escape') { if (privateView) { privateView = null; render(); } else if (armed) { disarm(); render(); } else if (sheetOpen || pairOpen) { sheetOpen = false; pairOpen = false; render(); } }
    else if (action === 'help') import('./keymap-sheet.mjs').then(sheet => { if (!closed) sheet.shortcutSheet(document, 'console'); }, () => {});
  }
  window.addEventListener('keydown', onPresentationKey);

  local.onmessage = ({ data }) => {
    if (closed) return;
    if (data?.t === 'projector_muted') {
      if (muteRequestId && Object.keys(data).length === 3 && data.sessionId === sessionId &&
          isUuidV7(data.requestId) && data.requestId === muteRequestId) {
        clearTimeout(muteTimer); muteTimer = null; muteRequestId = null;
        muteStatus = 'Projector sound muted.'; render();
      }
      return;
    }
    // Card 59 M3: a projector window that has just opened or reloaded is sent every released medium again.
    if (data?.t === 'projector_ready' && Object.keys(data).length === 2 && data.sessionId === sessionId) { mediaRelay.reset(); publish(); return; }
    // A projector that evicted a released file asks for it again (red-team N1).
    if (acceptMediaWanted(data, sessionId)) { void mediaRelay.again(data.handle); return; }
    if (hello.accept(data, Date.now())) {
      // Card 37: a hello every 4 s re-renders only if what the console shows about the display changed.
      const before = displayState(), firstHello = !projectorWordShown;
      showFallback = false; clearTimeout(fallbackTimer);
      updateDisplaySafety();
      if (!projectorWordShown) {
        local.postMessage({ t: 'show_projector', sessionId });
        projectorWordShown = true;
      }
      publish();
      if (firstHello || helloNeedsRender(before, displayState())) render();
    }
  };
  function displayState() { return { needsCheck: check.needsCheck(), fallback: showFallback }; }
  function muteProjector() {
    if (closed) return;
    clearTimeout(muteTimer);
    const requestId = uuidv7();
    muteRequestId = requestId;
    muteStatus = 'Asking the same-PC projector to mute…';
    try { local.postMessage({ t: 'mute_projector', sessionId, requestId }); }
    catch {
      muteRequestId = null;
      muteStatus = 'The projector could not be reached. Use its Session sound chip to mute it.';
      render(); return;
    }
    muteTimer = setTimeout(() => {
      if (closed || muteRequestId !== requestId) return;
      muteRequestId = null;
      muteStatus = 'No projector acknowledgement. Use its Session sound chip to mute it.';
      render();
    }, 3_000);
    render();
  }
  link.on('snapshot', next => {
    if (closed || next?.view?.sessionId !== sessionId || next.view.role !== 'facilitator') return;
    snapshot = next;
    if (next.view.phase === 'ended') {
      // Console layout v2: ended from Debrief, the review is done there: this computer's projector closes and the console
      // returns to Cases. Otherwise (card 40 slice 6, I1) derive the counts-only debrief and mint the paging grant first.
      if (renderedPhase === 'debrief') { local.postMessage({ t: 'close_projector', sessionId }); publish(); close(); onEnded({ fromDebrief: true, title: next.view.caseTitle ?? null }); return; }
      const ended = { sessionId, model: roomDebrief(next.mirror, pack), feedbackCode: next.mirror?.feedbackCode ?? null, grant: link.debriefGrant() };
      publish(); close(); onEnded({ ended }); return;
    }
    restoreVerifiedSegment(); publish(); render();
  });
  link.on('case_pack', next => { if (!closed) { pack = next; restoreVerifiedSegment(); publish(); render(); } });
  link.on('status', next => { if (!closed) { roomStatus = next; render(); } });
  link.on('error', error => {
    if (closed) return;
    if (['unauthorised', 'removed', 'unknown_room', 'room_deleted'].includes(error)) {
      close(); onEnded({ reason: 'access_lost' }); return;
    }
    statusText = error === 'client_upgrade_required' ? 'Reload Case to open this case’s newer format.' : 'Connection interrupted. Keep this tab open.'; render();
  });

  async function send(type, payload = {}) {
    if (closed || busy || manual) return;
    // Disabled controls cannot keep focus through a pending rebuild. Capture
    // only this new presentation control, and never override a later user move.
    const rankedFocus = type === 'ranked_page' && document.activeElement?.closest('.ranked-controls') ?
      document.activeElement.dataset.focusKey : null;
    busy = true; statusText = '';
    let refused = false;
    if (rankedFocus) root.querySelectorAll('.ranked-controls button, .ranked-controls select')
      .forEach(control => { control.disabled = true; });
    render();
    try {
      const result = await link.send(type, payload);
      if (closed) return;
      if (!['accepted', 'already_accepted'].includes(result?.receipt)) {
        refused = true;
        statusText = refusedCommandNotice(result?.reason, result?.receipt);
        void link.resync();
      }
    } catch { if (!closed) statusText = 'Connection interrupted. Keep this tab open.'; }
    finally {
      busy = false;
      if (!closed) {
        const active = document.activeElement;
        const restoreRankedFocus = rankedFocus && (active === document.body || !active ||
          active.disabled || active.dataset?.focusKey === rankedFocus);
        render();
        if (refused) if (type === 'ranked_page') showRankedChoice();
        if (restoreRankedFocus) [...root.querySelectorAll('[data-focus-key]')]
          .find(control => control.dataset.focusKey === rankedFocus && !control.disabled)?.focus({ preventScroll: true });
      }
    }
  }

  /** The ranked select is a kept node holding the facilitator's pick; after a refusal it shows the room's choice. */
  function showRankedChoice() {
    const select = root.querySelector('.ranked-controls select'), chosen = select?.querySelector('option[selected]');
    if (chosen) select.value = chosen.value;
  }

  function roomCommand(type, payload = {}) {
    if (closed || busy || recovery?.pending) return;
    if (!manual) { void send(type, payload); return; }
    let refused = true;
    try {
      const receipt = manual.command(type, payload);
      refused = receipt.receipt !== 'accepted';
      if (refused) statusText = 'Manual session could not apply that action.';
      else if (type === 'end') {
        // This ends the local presentation. During an outage the server has not
        // acknowledged room closure; its clock and recap expiry remain authoritative.
        close(); onEnded({ localOnly: true }); return;
      } else statusText = manual.persistenceOk === false ?
        'Manual changes are only in memory. Keep this tab open and download your notes.' : '';
    } catch { statusText = 'Manual session could not apply that action.'; }
    render();
    if (refused) if (type === 'ranked_page') showRankedChoice();
  }

  function doPrimary() {
    const view = currentView();
    const action = armedRoute(dockControl(view, { pickedPathId, armedUntil, pending: recovery?.pending, debriefArmed: armed?.id === 'debrief' }), armedUntil);
    if (!action || action.disabled || busy || recovery?.pending) return;
    if (action.local === 'focus_resolution') {
      // A press the facilitator made: focus the routes, then bring them into view.
      const route = root.querySelector('.console-routes button');
      route?.focus({ preventScroll: true }); route?.scrollIntoView({ block: 'nearest' }); return;
    }
    if (action.local === 'debrief') { pressArmed('debrief', () => void send('debrief')); return; }
    if (action.local === 'arm_reveal') {
      armedUntil = Date.now() + 3_000;
      clearTimeout(armTimer);
      armTimer = setTimeout(() => { armedUntil = 0; render(); }, 3_000);
      render(); return;
    }
    armedUntil = 0;
    if (manual) { const receipt = manual.command(action.command, action.payload);
      if (receipt.receipt !== 'accepted') statusText = 'Manual session could not apply that action.';
      else if (manual.persistenceOk === false) statusText = 'Manual changes are only in memory. Keep this tab open and download your notes.';
      render(); return; }
    void send(action.command, action.payload);
  }

  function openProjector(win = null) {
    const url = samePcProjectorUrl(sessionId, location.origin);
    hello.opened(Date.now()); showFallback = false; projectorWordShown = false; mediaRelay.reset();
    // Start room opened the window in its own click (Julian, 2026-10-18); here it only learns the room's address.
    if (win) { try { if (!win.closed) win.location.replace(url); } catch { /* blocked or closed: the fallback appears */ } }
    else window.open(url, '_blank', 'noopener,noreferrer');
    local.postMessage({ t: 'show_projector', sessionId });
    clearTimeout(fallbackTimer);
    fallbackTimer = setTimeout(() => {
      if (!closed && hello.fallbackRequired(Date.now())) { showFallback = true; render(); }
    }, 3_000);
    render();
  }

  async function enterManual() {
    if (closed || manual || !snapshot?.mirror || !pack ||
        !currentView()?.actions?.includes('enter_manual')) return;
    link.dropPending();
    manual = new ConsoleManualRoom(snapshot.mirror, pack, { channel: local, onFrame: view => void mediaRelay.frame(view) });
    const receipt = manual.enter();
    if (receipt.receipt !== 'accepted') { manual = null; statusText = 'Manual session is unavailable at this phase.'; }
    else if (manual.persistenceOk === false) statusText = 'Manual changes are only in memory. Keep this tab open and download your notes.';
    if (manual) recovery = createManualRecovery(manual, body => link.uploadSegment(body));
    render();
  }

  async function resumeOnline() {
    if (!manual || !recovery || roomStatus !== 'online' || busy) return;
    busy = true; render();
    try {
      const result = await recovery.resume();
      if (closed) return;
      if (result.kind === 'applied') {
        manual = null; recovery = null;
        await link.refetch();
        statusText = 'Manual changes rejoined the room.';
      } else if (result.kind === 'refused') statusText = 'The room moved on. Download your notes, then follow the room.';
      else if (result.kind === 'not_ready') statusText = 'Reveal or clear the selection first.';
      else statusText = 'Manual changes were not uploaded. Retry the same segment or download your notes.';
    } catch { if (!closed) statusText = 'Manual changes were not uploaded. Keep this tab open and download your notes.'; }
    finally { busy = false; if (!closed) render(); }
  }

  function downloadNotes() {
    if (!manual) return;
    const blob = new Blob([manual.notesText()], { type: 'text/plain;charset=utf-8' });
    const url = localNotesObjectUrl(blob);
    const linkEl = el('a'); linkEl.href = url; linkEl.download = 'case-manual-notes.txt';
    linkEl.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  const teachingContext = { root, currentView, render, routeSelection, openRouteNotes,
    get busy() { return busy; }, get recovery() { return recovery; },
    get pickedPathId() { return pickedPathId; }, set pickedPathId(value) { pickedPathId = value; } };
  function renderRoutes(view, parent) { renderTeachingRoutes(view, parent, teachingContext); }

  function renderLiveResponses(view) {
    if(!view.round?.responses?.length)return null;
    const card=section('Individual responses · only you','console-card console-live-responses');
    const options=view.decision?.interaction?.options??[];const labels=new Map(options.map(option=>[option.id,option.label]));
    const list=el('ol');
    for(const row of [...view.round.responses].sort((a,b)=>String(b.at).localeCompare(String(a.at))||String(a.participantId).localeCompare(String(b.participantId)))) {
      const item=el('li');item.dataset.responseOwner=row.participantId;
      const response=row.response;const text=response.option_id?labels.get(response.option_id):response.option_ids?response.option_ids.map(id=>labels.get(id)).join('; '):response.order?response.order.map((id,index)=>`${index+1}. ${labels.get(id)}`).join('; '):response.text;
      item.append(el('strong',row.name??'Unnamed'),el('p',text));list.append(item);
    }
    card.append(list);return card;
  }

  // ── Console layout v2 (Julian, 2026-10-18): one screen, a fixed side rail and a Room setup sheet; no tabs. ──

  /** The rail's Projector card: the essential check, so it is the loud card (petrol; coral when not open or mirrored). */
  function renderProjectorCard(view) {
    const alive = hello.alive(Date.now()), single = topology.count === 1, paired = pairingGeneration > 0;
    const state = alive ? (single ? 'One screen' : 'Connected') : paired ? 'Separate display' : 'Not open';
    const card = el('section', null, `console-card console-projector${!alive && !paired || alive && single ? ' is-off' : ''}`);
    card.setAttribute('aria-labelledby', 'console-projector-h');
    const head = el('div', null, 'console-card-head'), title = el('h2', 'Projector'); title.id = 'console-projector-h';
    head.append(title, el('span', state, `tag ${!alive && !paired || alive && single ? 'bad' : 'ok'}`)); card.append(head);
    if (alive && single) card.append(el('p', 'One screen detected. If it is duplicated, the room sees this console: Windows key + P, then Extend.', 'console-projector-warning'));
    else if (alive) card.append(el('p', 'This computer · second screen', 'field-hint'));
    // In the lobby the card shows what the room screen shows: the join screen and its code (Julian, 2026-10-18).
    if ((alive || paired) && view.phase === 'lobby') {
      const thumb = el('div', null, 'console-projector-thumb'); thumb.setAttribute('aria-label', 'The projector shows the join screen');
      thumb.setAttribute('role', 'img'); thumb.append(el('span', 'Join the case'), el('span', formatCode(joinCode), 'mono'));
      card.append(thumb);
    }
    else if (paired) card.append(el('p', 'Connected by its screen code', 'field-hint'));
    if (!alive) {
      const open = button('Open projector', () => openProjector(), 'btn console-projector-open'); open.dataset.focusKey = 'open-projector';
      card.append(open);
      if (showFallback) {
        card.append(el('p', 'Projector not connected. Allow pop-ups or open it manually.', 'field-hint'));
        const fallback = el('a', 'Open projector manually', 'btn tertiary');
        fallback.href = samePcProjectorUrl(sessionId, location.origin); fallback.target = '_blank'; fallback.rel = 'noopener noreferrer'; card.append(fallback);
      }
    }
    const other = button('Use another screen', () => { pairOpen = true; if (currentView()?.phase !== 'lobby') sheetOpen = true; render(); }, 'btn tertiary');
    other.dataset.focusKey = 'use-another-screen'; if (sheetOpen || view.phase === 'lobby') other.setAttribute('aria-controls', 'console-setup'); card.append(other);
    return card;
  }

  /** The sheet's pairing card: a separate display by its screen code, and the screen-check helpers (CASE-165/167). */
  function renderPairingCard() {
    const card = section('Use another screen', 'console-card console-pairing');
    const close = button('Cancel', () => { pairOpen = false; render(); }, 'btn tertiary'); close.dataset.focusKey = 'pairing-cancel'; card.append(close);
    card.append(el('p', `On the other screen, open ${displayPairUrl('00000000', location.origin).replace(/\/00000000$/, '').replace(/^https?:\/\//, '')} and type the screen code it shows. Keep these controls off the room screen.`, 'field-hint'));
    const label = el('label', 'Display pairing code');
    const input = el('input'); input.type = 'text'; input.maxLength = 11;
    input.dataset.focusKey = 'display-code'; input.autocomplete = 'off'; label.append(input);
    const approve = button('Connect projector', async event => {
      if (closed || displayApprovalPending) return;
      const value = event.currentTarget.closest('.console-pairing').querySelector('[data-focus-key="display-code"]').value;
      displayApprovalPending = true; render();
      let result;
      try { const chunk = await import('./console-room-tab.mjs'); if (closed) return; result = await chunk.approveDisplayCode(link, value); }
      catch { result = { ok: false }; }
      if (closed) return;
      displayApprovalPending = false;
      statusText = result.ok ? 'Projector connected.' : 'That display code could not be approved. Check the code and try again.';
      if (result.ok) { pairingGeneration += 1; pairOpen = false; updateDisplaySafety(); }
      render();
    }, 'btn quiet');
    approve.setAttribute('aria-disabled', String(displayApprovalPending));
    if (displayApprovalPending) approve.setAttribute('aria-busy', 'true');
    card.append(label, approve);
    if (displayApprovalPending) card.append(el('p', 'Connecting projector…'));
    card.append(el('p', 'On a separate display, use its Session sound chip to mute it.', 'console-sound-hint'));
    if (check.needsCheck()) card.append(button('Dismiss display reminder', () => { check.confirm(); pairOpen = false; sheetOpen = false; render(); root.querySelector('.console-primary')?.focus({ preventScroll: true }); }, 'btn tertiary'));
    else card.append(button('Check display', () => { check.samePc(); render(); }, 'btn tertiary'));
    if (topology.canRequestScreens) card.append(button('Identify screens', () => {
      topology.requestScreens().then(granted => {
        if (closed) return;
        if (granted) statusText = 'Case can now tell your screens apart.';
        render();
      });
    }, 'btn tertiary'));
    return card;
  }

  /** The rail's connection card: only while the room is unreachable or in manual room mode (the recovery tray). */
  function renderConnectionCard(view) {
    if (manual) {
      const card = section('Manual session', 'console-card console-backup console-manual-tray');
      card.append(el('p', recovery?.pending ? 'Upload pending. Keep this tab open.' : 'This computer runs the session. Keep this tab open.', 'field-hint'));
      const row = el('div', null, 'console-card-actions');
      row.append(button('Download your notes', downloadNotes, 'btn quiet'));
      if (!busy && !recovery?.pending && view.actions?.includes('manual_marker')) row.append(button('Add spoken marker', () => {
        if (closed || busy || recovery?.pending || !manual) return;
        const text = window.prompt('Marker for your local notes (never uploaded)');
        if (text == null) return;
        const result = manual.command('manual_marker', { text });
        statusText = result.receipt === 'accepted' ? '' : 'The marker could not be saved.';
        if (manual.persistenceOk === false) statusText = 'Manual changes are only in memory. Keep this tab open and download your notes.';
        render();
      }, 'btn quiet'));
      card.append(row);
      if (recovery?.refused) card.append(button('Follow current room without manual changes', async () => {
        if (!window.confirm('The manual changes were not applied. Download your notes before following the room. Continue?')) return;
        manual.close(); manual.forget(); manual = null; recovery = null;
        await link.refetch(); statusText = 'Following the current room. Manual changes were not applied.'; render();
      }, 'btn quiet'));
      else if (recovery?.pending || view.actions?.includes('resume_online')) {
        const rejoin = button(recovery?.pending ? 'Retry manual upload' : 'Rejoin online at the next decision', resumeOnline, 'btn');
        rejoin.disabled = roomStatus !== 'online' || busy;
        card.append(rejoin);
      }
      return card;
    }
    if (roomStatus === 'online' || roomStatus === 'connecting') return null;
    const card = section('Connection', 'console-card console-connection-card');
    card.append(el('p', 'Reconnecting. Phones keep their answers.', 'field-hint'));
    if (view.actions?.includes('enter_manual')) card.append(el('p', 'If it stays down, run the room from this computer:', 'field-hint'),
      armable('manual-now', 'Enter manual session mode', 'Press again: manual session', () => void enterManual(), 'btn'));
    return card;
  }

  /** The rail's People card: how many, faces, the join code, joining, and the join screen on the projector. */
  function renderPeopleCard(view, lobbyShown) {
    const roster = view.participants?.filter(p => !p.removed) ?? [];
    const card = el('section', null, 'console-card console-people'); card.setAttribute('aria-label', 'People');
    const debrief = view.phase === 'debrief', count = el('p', null, 'console-people-count'); count.append(el('strong', String(roster.length)), debrief ? ' joined' : ' in the room');
    card.append(count);
    if (!roster.length) card.append(el('p', 'No one has joined yet', 'field-hint'));
    else if (!manual && roomStatus === 'online' && roomTab?.peopleFaces) card.append(roomTab.peopleFaces(roster, 18, el));
    if (debrief) { card.append(el('p', 'Phones show their recap and the feedback form.', 'field-hint')); return card; }
    card.append(el('p', view.joiningClosed ? 'New joins stopped' : 'Join code', 'eyebrow'), el('p', formatCode(joinCode), 'mono console-code'));
    const row = el('div', null, 'console-card-actions');
    if (view.actions?.includes('close_joining')) row.append(button(view.joiningClosed ? 'Allow new joins' : 'Stop new joins',
      () => roomCommand('close_joining', { closed: !view.joiningClosed }), 'btn quiet'));
    if (view.actions?.includes('show_lobby')) {
      const toggle = button(lobbyShown ? 'Hide join screen' : 'Show join screen', () => roomCommand('show_lobby', { on: !lobbyShown }), 'btn quiet');
      toggle.setAttribute('aria-pressed', String(lobbyShown)); toggle.title = 'Puts the join screen on the projector'; if (busy) toggle.setAttribute('aria-disabled', 'true');
      row.append(toggle);
    }
    if (view.phase === 'lobby') { const url = el('a', 'Open join page', 'btn tertiary'); url.href = joinUrl(joinCode, location.origin); url.target = '_blank'; url.rel = 'noopener noreferrer'; row.append(url); }
    if (row.childElementCount) card.append(row);
    return card;
  }

  function renderRail(view, lobbyShown, dock) {
    const rail = el('aside', null, 'console-rail'); rail.setAttribute('aria-label', 'Session');
    rail.append(renderProjectorCard(view));
    const connection = renderConnectionCard(view); if (connection) rail.append(connection);
    rail.append(renderPeopleCard(view, lobbyShown));
    if (view.phase === 'debrief' && roomTab?.renderDebriefRail) rail.append(...roomTab.renderDebriefRail(view, roomTabContext));
    rail.append(el('div', null, 'console-rail-grow'));
    if (view.phase !== 'lobby') {
      const setup = button(sheetOpen ? 'Close session setup' : 'Session setup', () => { sheetOpen = !sheetOpen; if (!sheetOpen) pairOpen = false; render(); }, 'btn quiet console-setup-toggle');
      setup.dataset.focusKey = 'room-setup'; setup.setAttribute('aria-expanded', String(sheetOpen)); if (sheetOpen) setup.setAttribute('aria-controls', 'console-setup');
      rail.append(setup);
    }
    // Debrief now: from any shown slide; greyed inside a round (the primary offers it on the last slide, End is beside Next).
    let why = null;
    const foot = el('div', null, 'console-rail-foot'), round = { responses_open: 'lock or void the round first', responses_locked: 'reveal a path or void the round first', path_selected: 'reveal the path or void the round first' }[view.phase];
    if (view.actions?.includes('debrief') && dock?.local !== 'debrief') foot.append(armable('debrief', 'Debrief now', 'Press again: Debrief', () => roomCommand('debrief'), 'btn quiet console-debrief-now'));
    else if (round && !manual && view.actions?.includes('end')) {
      const greyed = button('Debrief now', () => {}, 'btn quiet console-debrief-now'); greyed.setAttribute('aria-disabled', 'true'); greyed.setAttribute('aria-describedby', 'console-debrief-why');
      why = el('p', `Debrief now: ${round}.`, 'field-hint'); why.id = 'console-debrief-why'; foot.append(greyed);
    }
    if (view.actions?.includes('end') && view.phase !== 'debrief') foot.append(armable('end', 'End case', 'Press again: End case', () => roomCommand('end'), 'btn danger console-end'));
    if (foot.childElementCount) rail.append(foot);
    if (why) rail.append(why);
    return rail;
  }

  /** Room setup: open in the lobby (the main area), folded once the case starts and reopened from the rail. */
  function renderSheet(view) {
    const lobby = view.phase === 'lobby';
    const sheet = el('section', null, `console-sheet${lobby ? ' is-lobby' : ''}`); sheet.id = 'console-setup';
    sheet.setAttribute('aria-labelledby', 'console-setup-h');
    const head = el('div', null, 'console-sheet-head'), titles = el('div'), title = el('h2', 'Session setup'); title.id = 'console-setup-h';
    titles.append(title, el('p', lobby ? (view.nextBeat ? `Opens with: ${view.nextBeat.title}. This folds away when the case starts; Session setup in the side rail opens it again.` : 'This folds away when the case starts.') : 'The projector keeps showing the case.', 'field-hint'));
    head.append(titles);
    if (!lobby) { const close = button('Close', () => { sheetOpen = false; pairOpen = false; render(); }, 'btn quiet'); close.dataset.focusKey = 'sheet-close'; head.append(close); }
    const cards = roomTab?.renderSetupCards?.(view, roomTabContext);
    if (!cards) loadRoomTab();
    const cols = [el('div', null, 'console-sheet-col'), el('div', null, 'console-sheet-col'), el('div', null, 'console-sheet-col')];
    if (cards) cols[0].append(cards.people); else cols[0].append(el('p', 'Loading session controls…', 'console-status'));
    if (cards) { cols[1].append(cards.briefing); if (cards.consoles) cols[1].append(cards.consoles); }
    if (pairOpen) cols[2].append(renderPairingCard());
    if (cards?.shared) cols[2].append(cards.shared);
    // The outage path renders here, never from the lazy chunk.
    if (view.actions?.includes('enter_manual') && !manual) {
      const card = section('Manual session', 'console-card console-backup');
      card.append(el('p', 'Only if the connection fails. This computer runs the session alone; phones pause until you rejoin online.', 'field-hint'),
        armable('manual', 'Enter manual session mode', 'Press again: manual session', () => void enterManual(), 'btn quiet'));
      cols[2].append(card);
    }
    const grid = el('div', null, 'console-sheet-grid'); grid.append(...cols);
    sheet.append(head, grid);
    return sheet;
  }

  /** The strip: presentation replay of already-public entries, newest at the right; the projector follows it. */
  function renderStrip(view) {
    if (!view.actions?.includes('replay')) return null;
    const nav = presentationNav(view), rows = presentationTiles(view), steps = view.phase === 'debrief' ? debriefSteps(view) : null;
    const strip = el('nav', null, 'console-strip'); strip.setAttribute('aria-label', steps ? 'Review the case' : 'Presentation');
    const fixed = el('div', null, 'console-presentation-controls');
    fixed.append(el('span', 'Projector', 'eyebrow console-strip-label'));
    // In Debrief there is no live slide: Back and Forward step the review, and every tile replays its own slide.
    const controls = steps ? [['Back', steps.back], ['Forward', steps.forward]]
      : [['Back', nav.canBack && { command: 'replay', payload: { entryIndex: nav.backTarget } }], ['Live surface', nav.replaying && { command: 'replay', payload: { entryIndex: null } }],
        ['Forward', nav.canForward && { command: 'replay', payload: { entryIndex: nav.forwardTarget } }]];
    for (const [label, step] of controls) {
      const item = button(label, () => step && roomCommand(step.command, step.payload), 'btn quiet'); item.disabled = !step || busy || Boolean(recovery?.pending);
      item.dataset.target = String(step?.payload?.entryIndex ?? null); fixed.append(item);
    }
    const list = el('ol', null, 'console-presentation-tiles');
    // Entry order; after each render the selected entry is scrolled into the row's view (afterRender).
    for (const row of rows) {
      const entry = nav.rows[row.entryIndex], item = el('li'), live = entry.live && !steps, target = live ? null : row.entryIndex;
      const tile = button('', () => roomCommand('replay', { entryIndex: target }), 'btn console-presentation-tile');
      tile.dataset.focusKey = `presentation-row-${row.entryIndex}`; tile.dataset.target = String(target);
      if (steps ? steps.at === row.entryIndex : entry.selected) tile.setAttribute('aria-current', 'step');
      tile.append(el('span', `${row.entryIndex + 1}. ${row.title}${row.correction ? ' · Correction' : ''}${live ? ' · Live' : ''}`, 'console-tile-title'));
      // The then-public groups stay with the entry for screen readers and as a tooltip; the chip shows the title.
      const detail = [row.scene, ...row.points].filter(Boolean).join(' · ');
      if (detail) { tile.title = detail; tile.append(el('span', ` · ${detail}`, 'sr-only')); }
      item.append(tile); list.append(item);
    }
    strip.append(fixed, list);
    if (nav.replaying && !steps) strip.append(el('p', 'Presentation replay · phones remain on the live surface', 'console-replay-notice'));
    return strip;
  }

  // Two dividers resize the three panels, by pointer or arrow keys; double-click resets. Sizes stay on this device.
  function gutter(axis) {
    const g = el('div', null, `console-gutter is-${axis}`);
    g.setAttribute('role', 'separator'); g.tabIndex = 0; g.dataset.focusKey = `gutter-${axis}`;
    g.setAttribute('aria-orientation', axis === 'col' ? 'vertical' : 'horizontal');
    g.setAttribute('aria-label', axis === 'col' ? 'Resize the left and right panels' : 'Resize projector preview and notes');
    const current = axis === 'col' ? split.left : split.sees;
    g.setAttribute('aria-valuemin', '0'); g.setAttribute('aria-valuemax', '4000'); g.setAttribute('aria-valuenow', String(current ?? 0));
    if (current == null) g.setAttribute('aria-valuetext', 'Default size');
    // Handlers read the live divider from the event: a kept node adopts the fresh render's handlers (console-focus.mjs).
    const apply = (el, value, box, persist) => {
      const stage = el.parentElement; if (!stage) return;
      if (axis === 'col') { split = { ...split, left: Math.round(Math.max(320, Math.min(box.width - 340, value))) }; stage.style.gridTemplateColumns = `${split.left}px 10px minmax(320px, 1fr)`; }
      else { split = { ...split, sees: Math.round(Math.max(120, Math.min(box.height - 106, value))) }; stage.style.gridTemplateRows = `${split.sees}px 10px minmax(96px, 1fr)`; }
      el.setAttribute('aria-valuenow', String(axis === 'col' ? split.left : split.sees)); el.removeAttribute('aria-valuetext');
      if (persist) writeConsoleSplit(preferenceStorage(), split);
    };
    g.onpointerdown = event => {
      const el = event.currentTarget, box = el.parentElement?.getBoundingClientRect(); if (!box?.width) return;
      event.preventDefault(); try { el.setPointerCapture(event.pointerId); } catch {}
      el.classList.add('is-dragging');
      el.onpointermove = move => apply(el, axis === 'col' ? move.clientX - box.left : move.clientY - box.top, box, false);
      el.onpointerup = () => { el.onpointermove = null; el.onpointerup = null; el.classList.remove('is-dragging'); writeConsoleSplit(preferenceStorage(), split); };
    };
    g.onkeydown = event => {
      const step = { ArrowLeft: -24, ArrowUp: -24, ArrowRight: 24, ArrowDown: 24 }[event.key]; if (!step) return;
      const el = event.currentTarget, stage = el.parentElement; if (!stage) return;
      event.preventDefault(); event.stopPropagation();
      const box = stage.getBoundingClientRect(), first = stage.firstElementChild.getBoundingClientRect();
      apply(el, (axis === 'col' ? first.width : first.height) + step, box, true);
    };
    g.ondblclick = () => { split = axis === 'col' ? { ...split, left: null } : { ...split, sees: null }; writeConsoleSplit(preferenceStorage(), split); render(); };
    return g;
  }

  /** Card 37 item 4 (CASE-176): while the projector shows the join screen, Room sees says so. */
  function renderJoinScreen(view) {
    const box = el('div', null, 'console-join-screen');
    box.append(el('p', 'Projector: join screen', 'console-projector-pill'), el('p', `${view.participants?.filter(p => !p.removed).length ?? 0} in the room · phones stay on the case`),
      el('p', 'Join code', 'eyebrow'), el('p', formatCode(joinCode), 'mono console-code'));
    if (view.joiningClosed) box.append(el('p', 'New joins are stopped · the projector shows no join link'));
    return box;
  }

  /** A panel's body: it scrolls only when its content is longer than the panel, so the keyboard can reach it too. */
  function scrollBody(label) { const body = el('div', null, 'console-panel-body'); body.tabIndex = 0; body.setAttribute('role', 'group'); body.setAttribute('aria-label', label); return body; }
  function renderMain(view, dock, lobbyShown) {
    const main = el('div', null, 'console-main');
    if (privateView) {
      const back = button('Return to the case', () => { privateView = null; render(); }, 'btn tertiary'); back.dataset.focusKey = 'Return to Run';
      const slot = el('div', null, 'console-private-view'); slot.dataset.keep = 'private-map'; slot.tabIndex = 0; slot.setAttribute('role', 'group'); slot.setAttribute('aria-label', 'Private case inspection'); main.append(back, slot); return main;
    }
    if (view.phase === 'lobby') { main.append(renderSheet(view)); return main; }
    const phase = phaseModel(view), debrief = view.phase === 'debrief', atSlide = Number.isSafeInteger(view.display?.cursor);
    // Debrief (console layout v2): the review's parts come from the room chunk; the panels and strip stay the same.
    const review = debrief ? roomTab?.renderDebrief?.(view, roomTabContext) : null;
    if (debrief && !review) { loadRoomTab(); main.append(el('p', 'Loading the debrief…', 'console-status')); return main; }
    // Room sees: the public surface as the projector shows it (the join screen while that is up). Folds to one line.
    const sees = column('console-room-sees', 'Projector preview');
    const fold = button(seesFolded ? 'Show' : 'Hide', () => { seesFolded = !seesFolded; render(); }, 'btn tertiary console-panel-toggle');
    fold.dataset.focusKey = 'fold-room-sees'; fold.setAttribute('aria-expanded', String(!seesFolded)); fold.setAttribute('aria-label', seesFolded ? 'Show projector preview' : 'Hide projector preview');
    sees.querySelector('.console-zone-label').after(fold);
    if (seesFolded) sees.classList.add('is-folded');
    else {
      const body = scrollBody('Projector');
      if (mirror && shownOnProjector()) {
        // The copy is a picture to sighted readers; the words stay in the panel for assistive tech.
        const slot = el('div', null, 'console-mirror-slot'); slot.dataset.keep = 'room-mirror';
        const words = el('div', null, 'sr-only'); words.append(lobbyShown ? renderJoinScreen(view) : review?.sees ?? renderSurface(view));
        const options = lobbyShown || review || view.actions?.includes('reveal_path') ? null : renderOptions(view);
        if (options) words.append(options);
        body.append(slot, words);
      } else if (lobbyShown) body.append(renderJoinScreen(view));
      else if (review) body.append(review.sees ?? renderSurface(view));
      else {
        body.append(renderSurface(view));
        const options = view.actions?.includes('reveal_path') ? null : renderOptions(view);
        if (options) body.append(options);
      }
      if (!mirror && !mirrorLoading && !mirrorFailed) {
        mirrorLoading = true;
        import('./console-mirror.mjs').then(m => { mirrorLoading = false; if (closed) return; mirror = m.createProjectorMirror({ sourceDocument: document, origin: location.origin }); render(); },
          () => { mirrorLoading = false; mirrorFailed = true; });
      }
      sees.append(body);
    }
    // Only you: private notes and the cue, and the private case map and actual route.
    const only = column('console-only-you', 'Only you');
    const inspection = el('nav', null, 'console-private-inspection'); inspection.setAttribute('aria-label', 'Private case inspection');
    for (const [kind, label] of [['map', 'Case map'], ['route', 'Actual path']]) inspection.append(button(label, () => { privateView = kind; render(); }, 'btn tertiary'));
    only.querySelector('.console-zone-label').after(inspection);
    const notes = scrollBody('Private notes'), privateMaterial = review ? atSlide && renderOnlyYou({ liveSurface: view.timeline?.[view.display.cursor] }) : renderOnlyYou(view);
    notes.append(privateMaterial || el('p', review && !atSlide ? 'The private notes for each slide show here as you review it.' : 'No private notes for this slide.', 'field-hint'));
    only.append(notes);
    // The decision panel: what the facilitator acts on. It hides like a Builder side panel.
    const decision = el('section', null, 'console-col console-decision'); decision.setAttribute('aria-labelledby', 'console-decision-h');
    const detail = section(phase.heading, 'console-phase'); detail.dataset.phase = view.phase;
    const title = detail.querySelector('h2'); title.id = 'console-decision-h';
    const hide = button('×', () => { decisionHidden = true; render(); }, 'btn tertiary console-panel-close');
    hide.dataset.focusKey = 'hide-decision'; hide.setAttribute('aria-label', 'Hide decision panel'); hide.setAttribute('aria-expanded', 'true');
    const titleRow = el('div', null, 'console-card-head'); title.replaceWith(titleRow); titleRow.append(title, hide);
    if (phase.count) detail.append(el('p', phase.count));
    if (phase.reopened) detail.append(el('p', phase.reopened));
    if (view.decision?.prompt && ['responses_open', 'responses_locked'].includes(view.phase)) detail.append(el('p', view.decision.prompt, 'console-prompt'));
    if (view.phase === 'path_selected') detail.append(el('p', 'Phones and the projector have not changed'));
    if (view.nextBeat) detail.append(el('p', `Next: ${view.nextBeat.title}`));
    const secondary = renderTeachingSecondary(view, dock, { root, currentView, render, roomCommand, send, routeSelection, openRouteNotes, armable,
      get manual() { return manual; }, get pickedPathId() { return pickedPathId; }, get busy() { return busy; }, get recovery() { return recovery; } });
    const timer = roomTab?.renderTimer?.(view, roomTabContext);
    if (timer) secondary.append(timer);
    detail.append(secondary);
    const body = scrollBody(review ? 'Review' : 'Decision');
    if (review) { title.textContent = review.title; detail.replaceChildren(titleRow, review.review); body.append(detail); }
    else {
      body.append(detail);
      const videos = renderVideoControls(); if (videos) body.append(videos);
      const aggregate = renderAggregate(view, phase); if (aggregate) body.append(aggregate);
      renderRoutes(view, body);
      const individuals = renderLiveResponses(view); if (individuals) body.append(individuals);
    }
    decision.append(body);
    const left = el('div', null, 'console-stage-left'); left.append(sees);
    if (!seesFolded) left.append(gutter('row')); left.append(only);
    if (seesFolded) left.classList.add('is-folded'); else if (split.sees) left.style.gridTemplateRows = `${split.sees}px 10px minmax(96px, 1fr)`;
    const stage = el('div', null, 'console-stage');
    if (decisionHidden) {
      stage.classList.add('is-solo');
      const reopen = button('Show decision', () => { decisionHidden = false; render(); }, 'btn tertiary console-panel-toggle');
      reopen.dataset.focusKey = 'show-decision'; reopen.setAttribute('aria-expanded', 'false');
      (seesFolded ? only : sees).querySelector('.console-zone-label').after(reopen);
      stage.append(left);
    } else {
      stage.append(left, gutter('col'), decision);
      if (split.left) stage.style.gridTemplateColumns = `${split.left}px 10px minmax(320px, 1fr)`;
    }
    main.append(stage);
    const strip = renderStrip(view);
    if (review) { const row = el('div', null, 'console-debrief-strip'); row.append(review.jump); if (strip) row.append(strip); main.append(row); }
    else if (strip) main.append(strip);
    if (sheetOpen) main.append(renderSheet(view));
    return main;
  }

  // Card 59 M3 (Julian, 2026-10-15): the projector's videos play only when the facilitator says so. The position comes
  // from the room's playback (the projector's own view, as this console projects it), never from a local player.
  function renderVideoControls() {
    const shown = projectorFrame(snapshot, pack)?.view;
    const videos = (shown?.surface?.slide?.blocks ?? []).filter(block => block?.type === 'image' && block.media?.type === 'video/mp4');
    if (!videos.length) return null;
    const box = section('Video on the projector', 'console-card console-video'), playback = shown.playback ?? null;
    const clock = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
    for (const block of videos) {
      const mine = playback?.blockId === block.id, length = (block.media.durationMs ?? 121_000) / 1000;
      const position = mine ? Math.min(length, playback.at + (playback.playing ? Math.max(0, (Date.now() - Date.parse(playback.since)) / 1000) : 0)) : 0;
      const ended = mine && position >= length, playing = mine && playback.playing && !ended;
      const control = (label, action, kind) => button(label, () => roomCommand('media_control', { blockId: block.id, action, position: action === 'restart' ? null : Math.round(position * 10) / 10 }), kind);
      const row = el('div', null, 'console-video-row');
      row.append(el('p', block.alt), el('p', !mine ? 'Not started' : ended ? 'Finished' : playing ? 'Playing' : `Paused at ${clock(position)}`, 'small'),
        playing ? control('Pause', 'pause', 'btn') : ended ? control('Play again', 'restart', 'btn primary') : control('Play', 'play', 'btn primary'));
      if (mine && !ended) row.append(control('Restart', 'restart', 'btn tertiary'));
      box.append(row);
    }
    return box;
  }

  // Imported at mount (precached, AS-076). A failed import is not retried: the browser keeps a failed module URL
  // failed for this document, and the outage controls do not depend on the chunk.
  let roomTab = null; // a promise until console-room-tab.mjs loads
  const loadRoomTab = () => { roomTab ||= import('./console-room-tab.mjs').then(m => { roomTab = m; if (!closed) render(); }, () => {}); };
  const roomTabContext = { el, button, section, roomCommand, render, check, sessionId, joinCode, armable, auth, markSvg, CLASS, summaryPages, debriefQuestionStep,
    // Debrief's record (console layout v2): the End model from the mirror and pack, timed to Debrief's start.
    debriefModel: () => roomDebrief(snapshot?.mirror && { ...snapshot.mirror, endedAt: snapshot.mirror.debrief?.startedAt ?? null }, pack),
    sharedComputer: () => (auth ? sharedComputer ??= roomTab.createSharedComputer({ auth, sessionId, joinCode }) : null),
    // Card 35b (P-27): only a console that holds the starter's account lists and stops shared computers.
    consoles: () => (auth ? consoleList ??= roomTab.createConsoles({ auth, sessionId,
      render: () => { if (!closed) render(); }, setStatus: text => { statusText = text; } }) : null),
    get link() { return link; }, openProjector,
    state: () => ({ manual, closed, showFallback }), pack: () => pack, // card 40a: the briefing reads the in-memory pack
    setStatus: text => { statusText = text; }, showRun: () => { sheetOpen = false; },
    displayApproved: () => { pairingGeneration += 1; updateDisplaySafety(); } };

  /** The persistent 32 px cover slot reserves space while the shared brand/case renderer loads. */
  function coverSlot(view) {
    coverCanvas ??= el('canvas', null, 'console-cover');
    splash?.paintCaseCover?.(coverCanvas, view.art, { size: 32, group: view.tint });
    if (!splash) splash = import('./splash.mjs').then(m => { splash = m; if (!closed) render(); }, () => {});
    const slot = el('span', null, 'console-cover-slot'); slot.dataset.keep = 'cover'; slot.setAttribute('aria-hidden', 'true');
    return slot;
  }

  function render() {
    if (closed) return;
    const view = currentView();
    if (!view) { root.replaceChildren(el('p', 'Connecting to the session…', 'console-status')); return; }
    pickedPathId=routeSelection.sync(view);
    const lobbyShown = view.display?.lobby === true;
    const active = root.contains(document.activeElement) ? document.activeElement : null;
    const nextFocus = focusAfterConsoleUpdate({ activeTag: active?.tagName,
      phase: renderedPhase, nextPhase: view.phase, tab: renderedTab, nextTab: tab,
      focusKey: active?.dataset?.focusKey });
    if (nextFocus.kind === 'defer' ||
        (pointerActivation && renderedPhase === view.phase && renderedTab === tab)) {
      const status = root.querySelector('.console-action-dock [role="status"]');
      if (status) status.textContent = busy ? 'Sending to the session…' : statusText;
      const connection = root.querySelector('.console-connection');
      if (connection) connection.textContent = roomStatus === 'online' ? '● Live' : '◌ Reconnecting';
      const count = root.querySelector('.console-people-count strong');
      if (count) count.textContent = String(view.participants?.filter(p => !p.removed).length ?? 0);
      if (!deferred && nextFocus.kind === 'defer') {
        deferred = true;
        // A synchronous rebuild on blur would remove the button being clicked
        // before its click event fires. Let that interaction finish first.
        active.addEventListener('blur', () => {
          deferred = false; setTimeout(() => { if (!closed) render(); }, 0);
        }, { once: true });
      }
      return;
    }
    // Console layout v2: one header row, then the main area beside the rail, then the bottom bar.
    const header = el('header', null, 'console-orientation');
    const bar = el('div', null, 'console-bar');
    const mark=wordmark(),crumbs=el('nav',null,'console-breadcrumbs');crumbs.setAttribute('aria-label','Breadcrumb');
    const cases=el('a','Present');cases.href=casesUrl(location.origin);const current=el('span',view.caseTitle??'Case');current.setAttribute('aria-current','page');crumbs.append(cases,current);
    bar.append(mark,crumbs,coverSlot(view));
    bar.addEventListener('click',event=>{const link=event.target.closest?.('a[href]');if(!link||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();if(leaveConsole())location.assign(link.href);});
    // The menu keeps sound only: the join screen and End case live in the rail (no duplicates).
    roomMenu.setRoomActions([{label:'Mute same-PC projector',run:muteProjector},
      {label:uiSoundModuleFailed?'Reload page for console sounds':uiSoundPending?'Cancel enabling console sounds':uiSoundOn?'Disable console sounds':'Enable console sounds',run:toggleUiSounds}]);
    const beat = el('div', null, 'console-beat');
    const debrief = view.phase === 'debrief', replayed = debrief && Number.isSafeInteger(view.display?.cursor) ? view.timeline?.[view.display.cursor]?.title : null;
    const heading = el('h1', debrief ? replayed ?? 'Summary' : view.beat?.title ?? (view.phase === 'lobby' ? 'Lobby' : 'Case'));
    heading.tabIndex = -1;
    beat.append(el('span', phaseModel(view).heading, 'console-phase-pill'), heading);
    if (lobbyShown) beat.append(el('span', 'Projector: join screen', 'console-projector-pill'));
    if (manual) beat.append(el('span', recovery?.pending ? 'Manual upload pending' : 'Manual session mode', 'console-manual-pill'));
    if (view.timer) beat.append(el('span', timerWords(timerRemainingS(view.timer)), 'console-timer'));
    const menuSlot=el('span');menuSlot.dataset.keep='room-menu';
    const soundStatus = el('span', muteStatus, 'console-sound-status');
    soundStatus.setAttribute('role', 'status');
    header.append(bar, beat, soundStatus, menuSlot, el('span', roomStatus === 'online' ? '● Live' : '◌ Reconnecting', 'console-connection'));
    const control = armedRoute(dockControl(view, { pickedPathId, armedUntil, pending: recovery?.pending, debriefArmed: armed?.id === 'debrief' }), armedUntil);
    const body = el('div', null, 'console-body');
    body.append(renderMain(view, control, lobbyShown), renderRail(view, lobbyShown, control));
    const status = el('p', null, 'console-status');
    // Debrief: Back to the case in the Undo slot, End case beside Next (never where Debrief was just pressed).
    const back = debrief ? button('Back to the case', () => roomCommand('back_to_case'), 'btn quiet console-undo') : null;
    if (back) { back.dataset.focusKey = 'back-to-case'; if (busy) back.setAttribute('aria-disabled', 'true'); }
    const dock = renderTeachingDock(view,control,{undoControl:back,beside:debrief&&view.actions?.includes('end')?armable('end','End case','Press again: End case',()=>roomCommand('end'),'btn danger console-end-next'):null,onCommand:roomCommand,currentView,onPrimary:doPrimary,routeSelection,busy,pending:Boolean(recovery?.pending),feedback:statusText||armHint(),
      roomSound:{on:!roomQuiet,onToggle:toggleRoomSound,title:roomQuiet?'Session sound is off. Press to turn console sounds back on.':'Turn session music and cues off'},
      onUndo:()=>{if(busy||recovery?.pending)return;const current=currentView();if(routeSelection.undo(current)){pickedPathId=routeSelection.sync(current);render();return;}if(current.undo?.available&&current.actions?.includes('undo'))roomCommand('undo',{targetEventId:current.undo.targetEventId,expectRevision:current.revision});}});
    const dockStatus = dock.querySelector('[role="status"]'); if (dockStatus) { dockStatus.id = 'console-dock-status'; if (armed && !statusText && !busy) dockStatus.classList.add('is-warning'); }
    // Card 37: patch the live surface from the fresh one. Unchanged sections keep their nodes, so a vote or a
    // projector hello never replaces the scene, moves the scroll position or restarts anything.
    const fresh = el('section');
    fresh.append(header, body, status, dock);
    selects.prepare(fresh);patchChildren(root, fresh);selects.sync();
    if(tab==='run'&&privateView){
      const slot=root.querySelector('[data-keep="private-map"]');
      if(!mapChunk&&!mapLoading){mapLoading=true;import('./case-map.mjs').then(chunk=>{mapLoading=false;if(!closed){mapChunk=chunk;render();}},()=>{mapLoading=false;if(!closed){statusText='Private map could not load. Reload to try again.';privateView=null;render();}});}
      if(slot&&mapChunk&&pack){
        if(privateKind!==privateView){privateRenderer?.close();privateRenderer=null;privateKind=privateView;}
        if(!privateRenderer)privateRenderer=privateView==='map'?mapChunk.mountCaseMap(slot,{document:pack,currentBeatId:view.beat?.id,onWalk:()=>{privateView=null;render();}}):mapChunk.mountRoomRoute(slot,{mirror:manual?.state??snapshot?.mirror,view,onInspect:id=>{const row=currentView()?.publicTimeline?.find(row=>row.occurrenceId===id);if(row&&currentView()?.actions?.includes('replay')){privateView=null;roomCommand('replay',{entryIndex:row.entryIndex});}}});
        else if(privateView==='route')privateRenderer.update(manual?.state??snapshot?.mirror,view);
        else {if(privateRenderer.root&&!slot.contains(privateRenderer.root))slot.append(privateRenderer.root);privateRenderer.updateCurrent?.(view.beat?.id);}
      }else if(slot)slot.textContent=pack?'Loading private case map…':'Waiting for the private case pack.';
    }else{privateRenderer?.close();privateRenderer=null;privateKind=null;}
    const mirrorSlot = root.querySelector('[data-keep="room-mirror"]');
    if (mirror && mirrorSlot) { if (mirror.host.parentNode !== mirrorSlot) mirrorSlot.replaceChildren(mirror.host); mirror.draw(shownOnProjector(), hello?.screen?.() ?? null); }
    const menuSlotLive=root.querySelector('[data-keep="room-menu"]');
    if(menuSlotLive&&roomMenuButton.parentNode!==menuSlotLive)menuSlotLive.replaceChildren(roomMenuButton);
    const cover = root.querySelector('[data-keep="cover"]');
    if (cover && coverCanvas.parentNode !== cover) cover.replaceChildren(coverCanvas);
    const shared = root.querySelector('[data-keep="shared-computer"]');
    if (shared && sharedComputer && sharedComputer.section.parentNode !== shared) shared.replaceChildren(sharedComputer.section);
    // Keep the selected presentation entry in the strip's view without moving the page.
    const tiles = root.querySelector('.console-presentation-tiles'), selectedTile = tiles?.querySelector('[aria-current="step"]')?.parentElement;
    if (tiles && selectedTile) {
      const left = selectedTile.offsetLeft, right = left + selectedTile.offsetWidth; // the row is the offset parent
      if (right > tiles.scrollLeft + tiles.clientWidth || left < tiles.scrollLeft) tiles.scrollLeft = Math.max(0, right - tiles.clientWidth + 8);
    }
    renderedPhase = view.phase; renderedTab = tab;
    // Every programmatic focus passes preventScroll: a background update never scrolls the console.
    const focused = document.activeElement;
    if (nextFocus.kind === 'heading' ||
        (nextFocus.kind === 'none' && active?.matches('.console-orientation h1') && !active.isConnected)) {
      const live = root.querySelector('.console-orientation h1');
      if (live !== focused) live?.focus({ preventScroll: true });
    } else if (nextFocus.kind === 'key' && !(focused?.isConnected && focused.dataset?.focusKey === nextFocus.key)) {
      [...root.querySelectorAll('[data-focus-key]')]
        .find(item => item.dataset.focusKey === nextFocus.key)?.focus({ preventScroll: true });
    }
  }

  render();
  loadRoomTab();
  // The window Start room opened in its click learns the room's address now (console layout v2).
  if (projectorWindow) { openProjector(projectorWindow); projectorWindow = null; }
  return { close, beforeNavigate: leaveConsole, get link() { return link; } };
}

// Every cleanup step is independent. A closed BroadcastChannel must never
// prevent facilitator credential and transport cleanup.
export function closeConsoleResources({ sessionId, manual, local, link, wake, preserveSegment = false }) {
  for (const step of [
    () => wake?.dispose(),
    () => manual?.close(),
    () => { if (!preserveSegment) manual?.forget(); },
    () => local?.postMessage({ t: 'local_end', sessionId }),
    () => local?.close(),
    () => link?.dropPending(),
    () => link?.forget(),
    () => link?.close(),
  ]) try { step(); } catch { /* continue clearing the remaining resources */ }
}
