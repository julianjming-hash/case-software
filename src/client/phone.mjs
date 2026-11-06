import {uiIcon} from './ui-icons.mjs';
import {createSurfaceNotice} from './surface-notice.mjs';
// Served participant renderer ported from the approved room phone prototype.
import { connect, participantCredential, participantCredentials, credentialKey } from './transport.mjs';
import { participantStorageFence } from './storage-barrier.mjs';
import { parseRoute, privacyUrl, sessionUrl, joinEntryUrl } from '../shared/urls.mjs';
import { createOutbox } from './outbox.mjs';
import { settlePhoneDelivery, restorePhoneVote, guardPhoneVoteStore } from './phone-delivery.mjs';
import { createTurnstileController } from './turnstile-widget.mjs';
import { createJoinDocumentHandoff } from './join-handoff.mjs';
import { createPhoneTerminal } from './phone-terminal.mjs';
import { installPhonePageRestore } from './phone-pageshow.mjs';
import { openVoteStore } from './vote-store.mjs';
import { normalizeCode, formatCode, JOIN_CODE_LENGTH } from '../shared/ids.mjs';
import { WIRE_VERSION } from '../shared/wire.mjs';
import { NAME_MAX, NAME_PROBLEM_TEXT, displayNameProblem, normaliseDisplayName } from '../shared/participant.mjs';
import { avatarEl } from './avatar.mjs';
import { h } from './phone-dom.mjs';
import { attachSiteMenu } from './shared-menu.mjs';
import { applyProfileReceipt } from './phone-profile.mjs';
import { customAvatarPicker, joinAvatarPicker } from './phone-avatar-picker.mjs';
import { attachRoomCodeMask, watchCodeLength, typedLength } from './phone-join-code.mjs';
import { mountCodeBoxes } from './code-boxes.mjs';
import { createPhoneBootstrap } from './phone-bootstrap.mjs';
import { createPhoneCleanup } from './phone-cleanup.mjs';
import { createParticipantTelemetry } from './phone-telemetry.mjs';
import { createTelemetry } from './telemetry.mjs';
import { inspectPhoneInventory } from './phone-recovery.mjs';
import { TEARDOWN_KEYS, assertKnownStorageKeys } from './teardown.mjs';
import { buildPhoneScreen, createPhoneRenderer, phoneIcon, idWarn, PHONE_COPY, sameResponse, savedResponse } from './phone-render.mjs';
import { createRoomMedia } from './room-media.mjs';

export async function mount() {
  const removePageRestore=installPhonePageRestore();
  let stopped=false,live=null,bootstrap=null,preserve=false,knownInventory=false,privacyReturn=false,handoffSessionId=null;
  const safeStorage=name=>{try{return globalThis[name];}catch{return null;}};
  const localStorage=safeStorage('localStorage'),sessionStorage=safeStorage('sessionStorage');
  const route=parseRoute(location.href);
  const entryDocument=route?.route==='join';
  let draft='';try{draft=sessionStorage?.getItem('case:phone:join-code-draft') ?? '';}catch{/* denied */}
  const initialCode=route?.code ?? normalizeCode(draft,JOIN_CODE_LENGTH) ?? '';
  let credential=participantCredential(route?.sessionId,localStorage);
  let ownedCredential=credential ? {sessionId:credential.sessionId,credential,participantId:null} : null;
  const missingSavedPlace=!!route?.sessionId&&!credential;
  const cleanup=createPhoneCleanup({localStorage,sessionStorage,caches:globalThis.caches,indexedDB:globalThis.indexedDB,
    selection:()=>({role:'participant',...ownedCredential,sessionId:ownedCredential?.sessionId ?? handoffSessionId,knownInventory,queueValidated:preserve}),
    privacyReturn:()=>privacyReturn,clearMemory:reason=>{if(reason!=='next_load'){credential=null;if(stopped||live)bootstrap?.dispose();else bootstrap?.release();}live?.cancel();}});
  const recoveryMain=()=>document.querySelector('main')??(document.querySelector('.phone-app')??document.body).appendChild(h('main',{id:'main'}));
  recoveryMain();
  const retryMount=()=>{stopped=true;bootstrap?.dispose();live?.cancel();removePageRestore();window.removeEventListener('pagehide',onPagehide);void mount();};
  const storageNotice=(retry=retryMount)=>{
    if(stopped)return;
    recoveryMain().replaceChildren(h('section',{class:'card'},h('h1',{text:'Answer storage unavailable'}),h('p',{text:'Private storage is unavailable. Retry to check it again.'}),h('button',{type:'button',class:'btn primary',text:'Retry',onclick:retry})));
  };
  const handoff=createJoinDocumentHandoff({cleanup,active:()=>!stopped,origin:location.origin,
    navigate:url=>{stopped=true;credential=null;bootstrap?.dispose();location.replace(url);},
    onUnavailable:()=>storageNotice(()=>void enterPlay(handoffSessionId))});
  const enterPlay=sessionId=>{handoffSessionId=sessionId;return handoff(sessionId);};
  const onPagehide=()=>{stopped=true;void cleanup('pagehide');};
  window.addEventListener('pagehide',onPagehide,{once:true});
  const inspectInventory=async()=>{const result=await inspectPhoneInventory({localStorage,sessionStorage,indexedDB:globalThis.indexedDB,
    assertKnownStorageKeys,knownDatabases:TEARDOWN_KEYS.knownDatabases,detailed:true});knownInventory=result.status==='known';return result;};
  if(stopped)return;
  bootstrap=createPhoneBootstrap({code:route?.code,sessionId:route?.sessionId,credential,knownInventory,inspectInventory,candidateCredentials:()=>participantCredentials(localStorage),
    onCandidate:c=>{ownedCredential=c?{sessionId:c.sessionId,credential:c,participantId:null}:null;},
    cleanup:(reason,selected,proof)=>{preserve=selected;return cleanup(reason,proof);}});
  const activate=result=>{
    if(stopped)return;
    credential=null;bootstrap.dispose();
    if(result.status==='ready'&&entryDocument){void enterPlay(result.sessionId);return;}
    if(result.status==='refused'&&!entryDocument){document.querySelector('main').replaceChildren(h('section',{class:'card'},h('h1',{text:'Your saved place is unavailable'}),h('p',{text:'This browser no longer has your saved place. To rejoin a session that is still open, enter its code.'}),h('p',{text:"Open in your browser or use mobile data if this page won't load"}),h('a',{href:joinEntryUrl(location.origin),class:'btn',text:'Enter a session code'})));return;}
    const fence=participantStorageFence({localStorage,initialBinding:result.status==='ready'&&ownedCredential?{key:credentialKey('participant',ownedCredential.sessionId),credential:ownedCredential.credential}:null});
    const commit=fence.commit;fence.commit=async(write,next)=>{const saved=await commit(write,next);if(saved===true&&next)ownedCredential={sessionId:next.credential.sessionId,credential:{...next.credential},participantId:ownedCredential?.sessionId===next.credential.sessionId&&ownedCredential?.credential.token===next.credential.token?ownedCredential.participantId:null};return saved;};
    live=mountParticipant({initialCode,cleanup,missingSavedPlace,entryDocument,onHandoff:enterPlay,credentialFence:fence,onStorageUnavailable:storageNotice,
      onValidated:participantId=>{preserve=true;if(ownedCredential)ownedCredential.participantId=participantId;},onPrivacy:()=>{privacyReturn=true;},active:()=>!stopped,restoreCredential:result.status==='ready'});
  };
  const show=result=>{
    if(stopped)return;
    if(result.status==='ready'||result.status==='refused'){activate(result);return;}
    const unavailable=result.status==='unavailable';
    const main=document.querySelector('main');
    main.replaceChildren(h('section',{class:'card'},h('h1',{text:unavailable?'Recovery unavailable':'Answer storage unavailable'}),
      h('p',{text:unavailable?'Could not confirm your room. Retry when the connection is available.':'Private storage is unavailable. Retry to check it again.'}),
      result.count?h('p',{text:`Not sent yet · ${result.count}`}):null,
      h('button',{type:'button',class:'btn primary',text:'Retry',onclick:async event=>{
        event.currentTarget.disabled=true;show(await bootstrap.retry());
      }})));
  };
  show(await bootstrap.start());
  return {cancel(){stopped=true;credential=null;bootstrap?.dispose();live?.cancel();removePageRestore();window.removeEventListener('pagehide',onPagehide);},
    teardown:reason=>{stopped=true;credential=null;bootstrap?.dispose();return cleanup(reason??'token_loss');}};
}

function mountParticipant({initialCode,cleanup,onValidated,onPrivacy,active,missingSavedPlace=false,entryDocument=false,onHandoff,credentialFence,onStorageUnavailable,restoreCredential=true}) {
let disposed = false;
const timeouts = new Set(), intervals = new Set(), listeners = [], challenges = new Set(), splashes = new Set();
const listen = (target, type, fn) => { target.addEventListener(type, fn); listeners.push(() => target.removeEventListener(type, fn)); };
const setTimeout = (fn, delay) => { const id = globalThis.setTimeout(() => { timeouts.delete(id); if (!disposed) fn(); }, delay); timeouts.add(id); return id; };
const setInterval = (fn, delay) => { const id = globalThis.setInterval(() => { if (!disposed) fn(); }, delay); intervals.add(id); return id; };


// ───────────────────────── tiny DOM helpers (text only) ─────────────────────────
// The room screens are drawn by phone-render.mjs (preview overhaul slice 2); this page keeps join, rename, the menu,
// the connection line and answer delivery (transport, outbox, durable answers, receipts) around it.
const icon = (name, size, cls) => phoneIcon(document, name, size, cls);
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────── exact copy (docs/SCREENS.md) ─────────────────────────
const C = {
  ...PHONE_COPY,
  removed: 'You were removed from this session',
  invalidCode: "That code isn't right · check it against the projector",
  closed: 'This session is not accepting new participants',
};

const { root, parts } = buildPhoneScreen(document);
const previousMain=document.querySelector('main');
(previousMain.closest('.phone-app')??previousMain).replaceWith(root);
document.body.classList.add('phone-page');
document.documentElement.classList.add('phone-page');
const terminate=createPhoneTerminal({cleanup,active,show:(reason,complete)=>{
  const heading=!complete?'Answer storage unavailable':reason==='removed'?C.removed:reason==='recap_expiry'?'Your recap has expired':'Your saved place is unavailable';
  root.replaceChildren(h('main',{},h('section',{class:'card'},h('h1',{text:heading}),
    h('p',{text:complete?'To join a session that is still open, enter its code.':'Private storage could not be cleared. Close this page and reopen it in your browser.'}),
    complete?h('a',{href:joinEntryUrl(location.origin),class:'btn',text:'Enter a session code'}):h('button',{type:'button',class:'btn primary',text:'Retry',onclick:()=>void terminate(reason)}))));
}});

// ───────────────────────── connection ─────────────────────────
const route = parseRoute(location.href);
const JOIN_CODE_DRAFT = 'case:phone:join-code-draft'; // Public code only; no name or credential.
const participantTelemetry = createParticipantTelemetry({ createReporter: () => createTelemetry({ api: location.origin }) });
const link = connect({ role: 'participant', api: location.origin, sessionId: route?.sessionId ?? null, telemetryImpl: participantTelemetry,credentialFence,restoreCredential });
const voteStore = guardPhoneVoteStore(openVoteStore(),credentialFence);
let outbox = null, outboxOwner = null, bindRetries = 0, binding = Promise.resolve(), enqueuing = 0, enqueueTail = Promise.resolve(), expiryTimer = null;
async function updateUnsent() {
  if (disposed) return;
  try {
    const count = outbox ? await outbox.count() : link.hasToken && link.sessionId ? (await voteStore.read(link.sessionId)).filter(row => !row.superseded).length : 0;
    if (!disposed) $('unsent').textContent = count ? `Not sent yet · ${count}` : '';
  } catch { if (!disposed) $('unsent').textContent = 'Answer storage unavailable · keep this page open'; }
}
function restoreOutbox(view) {
  binding = binding.then(async () => {
    if (!(await link.credentialReady)) { if(!disposed){clearMemory();onStorageUnavailable();}return; }
    if (disposed || view !== S.view || view?.you?.removed || !view?.you?.id || !link.sessionId) return;
    const owner = view.you.id, roomId = link.sessionId;
    if (outboxOwner !== owner) {
      await outbox?.close();
      if (disposed || view !== S.view) return;
      // A newly confirmed participant must never restore an earlier owner's draft.
      await voteStore.update(roomId, rows => ({ rows: rows.filter(row => row.participantId === owner), result: null }));
      if (disposed || view !== S.view) return;
      outboxOwner = owner;
      participantTelemetry.confirm(view, roomId);
      onValidated(owner);
      if(entryDocument){await onHandoff(roomId);return;}
      outbox = createOutbox({ store: voteStore, roomId, participantId: owner, onRoundClosed: (roundId, receipt) => {
        if (disposed || renderer.decision.roundId !== roundId) return;
        dec.ver++; dec.pend = null; dec.desired = null; dec.queueFailed = false;
        if (receipt === 'locked') dec.locked = true;
        dec.msg = alertMsg(receipt === 'locked' ? savedOf(S.view.decision) ? C.lockedSaved : C.lockedNone : C.rejected);
        link.refetch(); refreshDecision();
      }, send: async envelope => {
        const p = dec.pend?.body.clientEventId === envelope.clientEventId ? dec.pend : { roundId: envelope.roundId, response: envelope.response, body: envelope, state: 'sending' };
        const receipt = await link.sendFrame({ ...envelope, t: 'command' });
        if (!disposed) {
          const outcome = receipt.receipt === 'dropped' ? { ...receipt, receipt: 'timeout' } : receipt;
          onReceipt(p, outcome);
          // An earlier admitted answer may still fence a newer desired choice. Its delivery
          // outcome must drive recovery even when its receipt no longer owns the latest UI.
          if (dec.pend !== p && ['stale_epoch', 'paused_held'].includes(outcome.receipt)) link.refetch();
          if (dec.pend !== p && outcome.receipt === 'timeout') setTimeout(() => dispatchPending(dec.pend), 1000);
        }
        return receipt;
      } });
    }
    await voteStore.update(roomId, rows => ({ rows: rows.filter(row => row.participantId !== owner || row.envelope.roundId === view.decision?.roundId), result: null }));
    if (disposed || view !== S.view) return;
    await outbox.setEpoch(S.snap?.epoch ?? 0);
    const pending = await restorePhoneVote({
      read: () => view.decision ? outbox.latest(view.decision.roundId) : null,
      current: () => !disposed && view === S.view,
      accepted: () => dec.accepted,
      version: () => dec.ver,
      restore: pending => {
        if (!dec.pend || dec.pend.body.clientEventId !== pending.clientEventId) {
          dec.pend = { roundId: pending.roundId, body: pending, response: pending.response, state: view.decision.status === 'held' ? 'held' : 'waiting' };
          dec.desired = pending.response;
          renderer.decision.restore(view.decision, pending.response);
          refreshDecision();
        }
      },
    });
    if (disposed || view !== S.view) return;
    await updateUnsent();
    if(disposed || view!==S.view)return;
    if (pending && dec.accepted?.clientEventId !== pending.clientEventId && view.decision?.status === 'open' && !view.manual && S.conn === 'online') dispatchPending(dec.pend);
    if (view.recap?.expiresAt) {
      if (expiryTimer) globalThis.clearTimeout(expiryTimer);
      const remaining = Date.parse(view.recap.expiresAt) - Date.now();
      if (Number.isFinite(remaining)) expiryTimer = setTimeout(() => controller.teardown('recap_expiry'), Math.max(0, remaining));
    }
  }).then(() => { bindRetries = 0; }, () => {
    if (disposed) return;
    $('unsent').textContent = 'Answer storage unavailable · keep this page open';
    // A storage step that failed once (a slow device past the barrier's deadline) is retried, bounded, so binding and
    // the join handoff never wait for a snapshot that may not come. Each retry rechecks every fence from the start.
    if (bindRetries < 3) { bindRetries++; setTimeout(() => { if (!disposed && S.view) void restoreOutbox(S.view); }, 400 * bindRetries); }
  });
  return binding;
}


const S = {
  mode: null, view: null, snap: null, conn: link.status, everOnline: false, removed: false, joinedHere: false,
};
const main = parts.main;
// The room screens (lobby, surface, banners, decision card, result, recap, timeline). Answers go to onAnswer; the
// card reads this page's delivery state, and every receipt or connection change redraws it (refreshDecision).
// Card 59 M3: released images, fetched with this phone's own credential (phone renditions), held in memory only.
const roomMedia = createRoomMedia({ role: 'phone', load: (handle, rendition) => link.mediaBytes(handle, rendition), onChange: () => { if (S.mode === 'room' && S.view) renderer.update(S.view); } });
window.addEventListener('pagehide', () => roomMedia.dispose(), { once: true });
// Card 40b (Julian's ruling 1, 2026-10-17): a revealed image for the recap PDF as JPEG bytes, a still's phone copy or a GIF's or
// video's poster. What this phone holds is used as it is; anything else is read once now with this phone's own credential.
const recapStill = async block => {
  const { handle, type } = block.media, rendition = /gif|mp4/.test(type) ? 'poster' : 'phone';
  const found = roomMedia.held(handle, rendition) ?? await link.mediaBytes(handle, rendition);
  const bytes = found instanceof Blob ? await found.arrayBuffer() : found?.bytes;
  return bytes ? new Uint8Array(bytes) : null;
};
// Room PDFs v2: the Finish block for this room, built once (lazy chunks) and kept, so redraws re-append the same node. It reads
// this phone's saved feedback only if this tab saved some (a content-free flag), so End brings no burst of reads.
let finish = null;
const finishFor = (view, code) => {
  if (finish?.sessionId === view.sessionId) return finish.host;
  const host = document.createElement('div'), flag = `case:finish:${view.sessionId}:saved`;
  finish = { sessionId: view.sessionId, host };
  void (async () => {
    const [{ createFinishBlock }, { createFeedbackSaver }, { recordSummary }, art] = await Promise.all([import('./finish-block.mjs'), import('./feedback-client.mjs'), import('./record-summary.mjs'), import('./splash.mjs')]);
    let marked = false; try { marked = sessionStorage.getItem(flag) === '1'; } catch { /* storage denied */ }
    const base = code ? createFeedbackSaver({ code, sessionId: view.sessionId, closesAt: view.recap?.expiresAt ?? null, win: window }) : null;
    const saver = base && { ...base, save: async answers => { const r = await base.save(answers); if (r.ok) { try { sessionStorage.setItem(flag, '1'); } catch { /* storage denied */ } } return r; } };
    const saved = base && marked ? await base.mine() : null;
    if (disposed || finish?.host !== host) return;
    const block = createFinishBlock({ win: window, summary: recordSummary(view, { now: Date.now() }), saver, saved, closesAt: base?.closesAt ?? view.recap?.expiresAt ?? null,
      bandArt: () => art.bandArt(view.art, { aspect: 7, group: view.tint ?? 'neutral' }),
      // The record's masthead is the same braid, its layout and shading seeded with the name typed here (never sent).
      download: async (summary, entry) => {
        const band = (() => { try { return art.pdfBandFor(view.art, { group: view.tint ?? 'neutral', contentSeed: String(entry.name ?? '').trim() || summary.title }); } catch { return null; } })();
        return (await import('./participant-record.mjs')).downloadParticipantRecord(document, { ...summary, ...(band ? { band } : {}) }, entry); } });
    host.replaceChildren(block.node); block.shown();
  })().catch(() => { if (finish?.host === host) host.replaceChildren(); });
  return host;
};
const renderer = createPhoneRenderer({ doc: document, parts, onAnswer, media: roomMedia, rename: prefix => buildRename(prefix),
  // Card 40b: the recap's Give feedback link (the room's public code only, CASE-284) and its built-in PDF, a lazy chunk
  // that loads the tagged writer only when Download is pressed; it reads the revealed images through recapStill.
  recap: { finish: finishFor, download: async view => { const [m, art] = await Promise.all([import('./recap-pdf.mjs'), import('./splash.mjs').catch(() => null)]);
    let band = null; try { band = art?.pdfBandFor(view.art, { group: view.tint ?? 'neutral', contentSeed: view.recap?.caseTitle ?? '' }) ?? null; } catch { /* plain band */ }
    return m.downloadRecap(view, recapStill, band); } },
  delivery: {
    state: () => ({ online: S.conn === 'online', enqueuing, pending: dec.pend, accepted: dec.accepted, message: dec.msg, queueFailed: dec.queueFailed, locked: dec.locked }),
    round: d => { resetDecision(); if (d?.yourResponse) dec.msg = ok(C.saved); },
    reconcile: v => reconcilePending(v),
  } });

let snapshotVersion=0;
link.on('snapshot', (snap) => {const version=++snapshotVersion;void link.credentialReady.then(ready=>{if(disposed||version!==snapshotVersion)return;if(!ready){clearMemory();onStorageUnavailable();return;}if(snap.view?.you?.removed){void terminate('removed');return;}if(snap.view?.recap?.expiresAt&&Date.parse(snap.view.recap.expiresAt)<=Date.now()){void terminate('recap_expiry');return;}S.conn=link.status;S.snap=snap;S.view=snap.view;if(!entryDocument)render();restoreOutbox(snap.view);});});
link.on('status', (st) => { if (disposed) return; S.conn = st; if (S.conn === 'online') S.everOnline = true; else { link.dropPending(); if (dec.pend) dec.pend.state = 'waiting'; } renderConn(); updateUnsent(); if (S.mode === 'room') { refreshDecision(); if (S.conn === 'online') restoreOutbox(S.view); } });
link.on('welcome', () => { if(!disposed)S.everOnline = true; });
link.on('error', (e) => {
  if (e === 'removed') { void terminate('removed'); }
  if (e === 'unauthorised') { void terminate('unauthorised'); }
});
listen(window, 'offline', () => { if (disposed) return; S.conn = 'lost'; link.dropPending(); if (dec.pend) dec.pend.state = 'waiting'; renderConn(); refreshDecision(); });
listen(document, 'visibilitychange', () => { if (!document.hidden && S.mode === 'room') refreshDecision(); });

// Print on white paper in either theme (card 36a, spec §11): the light tokens apply while the browser prints.
let printTheme = null;
const toPaper = () => { if (printTheme !== null) return; printTheme = document.documentElement.dataset.theme ?? ''; document.documentElement.dataset.theme = 'light'; };
const fromPaper = () => { if (printTheme === null) return; if (printTheme) document.documentElement.dataset.theme = printTheme; else delete document.documentElement.dataset.theme; printTheme = null; };
listen(window, 'beforeprint', toPaper); listen(window, 'afterprint', fromPaper);
const printQuery = globalThis.matchMedia?.('print');
const onPrintQuery = (event) => { if (event.matches) toPaper(); else fromPaper(); };
printQuery?.addEventListener?.('change', onPrintQuery);
listeners.push(() => { printQuery?.removeEventListener?.('change', onPrintQuery); fromPaper(); });

// ───────────────────────── mode switching ─────────────────────────
function pickMode() {
  const v = S.view;
  if (S.removed || v?.you?.removed) return 'removed';
  if (v?.you) return 'room';
  if (link.hasToken) return 'connecting';
  return 'join';
}

function render() {
  if (disposed) return;
  const mode = pickMode();
  if (mode !== S.mode) {
    const first = S.mode === null;
    S.mode = mode;
    mountMode(mode);
    if (!first) queueMicrotask(() => focusIfLost());
  }
  renderer.header(mode, S.view);
  renderConn();
  if (mode === 'room') renderer.update(S.view);
}

function mountMode(mode) {
  stopSplashes();
  renderer.reset();
  if (mode === 'join') main.append(buildJoin());
  else if (mode === 'removed') main.append(h('section', { class: 'card', 'aria-labelledby': 'mh' }, h('h1', { id: 'mh', tabindex: '-1', text: C.removed })));
  else if (mode === 'connecting') main.append(h('section', { class: 'card', 'aria-labelledby': 'mh' }, h('h1', { id: 'mh', tabindex: '-1', text: 'Checking the session…' }), h('p', { class: 'muted', text: 'Your place in the room is saved on this phone.' })));
  else if (mode === 'room') renderer.mount();
}

function focusIfLost() {
  const a = document.activeElement;
  if (a && a !== document.body && a.isConnected) return;
  const t = main.querySelector('[data-focus-heading]') || main.querySelector('h1, h2');
  t?.focus({ preventScroll: true });
}
// ───────────────────────── header, connection chip, menu ─────────────────────────
function renderConn() {
  const box = $('conn');
  let kind = null, text = '';
  if (S.mode === 'room' || S.mode === 'connecting') {
    if (S.conn === 'lost') { kind = 'lost'; text = 'Connection lost · follow the room'; }
    else if (S.conn !== 'online') { kind = 'wait'; text = S.everOnline ? 'Reconnecting…' : 'Connecting…'; }
  }
  const sig = `${kind}|${text}`;
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.replaceChildren();
  if (!kind) return;
  box.append(h('div', { class: `banner ${kind}` }, icon(kind === 'lost' ? 'wifioff' : 'spinner', 18, kind === 'wait' ? 'spin' : ''), h('span', { text })));
}

let renameCtl = null;
const participantMenu = attachSiteMenu($('menuBtn'), { participant: true, profile: host => {
  const view = S.view;
  if (S.mode !== 'room' || !view?.you || view.you.removed) return;
  host.append(h('button',{type:'button',class:'btn',text:'Report an issue',onclick:async()=>{
    const credential=participantCredential(view.sessionId,localStorage);if(!credential)return;closeMenu();
    const {mountIssueReporter}=await import('./issue-reporter.mjs');if(disposed)return;
    const current=()=>!disposed&&S.mode==='room'&&S.view?.you&&!S.view.you.removed&&participantCredential(view.sessionId,localStorage)?.token===credential.token;
    if(!current())return;mountIssueReporter({ui:{uiIcon,createSurfaceNotice},participant:{sessionId:view.sessionId,token:credential.token},isCurrent:current,opener:$('menuBtn')});
  }}));
  if (view.phase !== 'ended' && view.phase !== 'debrief') {
    renameCtl ??= buildRename('menu'); renameCtl.sync();
    host.append(h('h2', { class: 'rename-heading', text: 'Your name and avatar' }), renameCtl.root);
  } else {
    const recap = h('button', { type: 'button', class: 'btn', text: 'Your private recap', onclick: () => {
      closeMenu(); renderer.browse(null); render(); $('recH')?.focus();
    } });
    host.append(recap);
  }
} });
function closeMenu() { participantMenu.close(); }

/**
 * The name field (CASE-119): required, 3–20 letters, numbers, spaces, hyphens or apostrophes; duplicates
 * allowed. Checked as you type once you have typed, and again on submit; the server checks it too.
 */
function nameField(prefix, { value = '' } = {}) {
  const input = h('input', { type: 'text', id: `${prefix}-name`, maxlength: String(NAME_MAX + 10), autocomplete: 'nickname', autocapitalize: 'words', enterkeyhint: 'done', required: '', 'aria-describedby': `${prefix}-count ${prefix}-nerr` });
  input.value = value;
  const count = h('p', { class: 'counter', id: `${prefix}-count`, text: `${[...value].length} of ${NAME_MAX}` });
  const err = h('p', { class: 'err', id: `${prefix}-nerr`, role: 'status', 'aria-live': 'polite' });
  const warn = idWarn(input, `${prefix}-warn`);
  let touched = false;
  const problem = () => displayNameProblem(input.value);
  const show = (force) => {
    const pr = problem();
    const on = pr && (touched || force);
    err.replaceChildren(...(on ? [icon('alert', 16), document.createTextNode(NAME_PROBLEM_TEXT[pr])] : []));
    if (on) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
    return !pr;
  };
  input.addEventListener('input', () => { count.textContent = `${[...input.value.trim()].length} of ${NAME_MAX}`; if (touched) show(); });
  input.addEventListener('blur', () => { if (input.value.trim()) { touched = true; show(); } });
  const root = h('div', {}, h('label', { class: 'field', for: `${prefix}-name`, text: 'Your name' }), input, count, err, warn.p);
  return {
    root, input, valid: () => show(true), value: () => normaliseDisplayName(input.value),
    set(v) { input.value = v ?? ''; count.textContent = `${[...input.value].length} of ${NAME_MAX}`; touched = false; show(); warn.upd(); },
  };
}

/** Change of name or avatar (lobby inline and header menu): `Save changes` (CASE-121). Epoch-fenced, so a stale_epoch is retried once. */

function buildRename(prefix) {
  const name = nameField(prefix);
  const pick = customAvatarPicker(prefix);
  const msg = h('p', { class: 'small', id: `${prefix}-msg`, role: 'status', 'aria-live': 'polite' });
  const btn = h('button', { type: 'submit', class: 'btn block', text: 'Save changes' });
  let dirty = false;
  name.input.addEventListener('input', () => { dirty = true; });
  pick.onPick(() => { dirty = true; });
  const root = h('form', { class: 'stack', novalidate: '' }, name.root, pick.root, btn, msg);
  root.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!name.valid()) { name.input.focus(); return; }
    if (!pick.valid()) return;
    const body = { displayName: name.value(), avatarId: pick.value() };
    btn.disabled = true;
    msg.textContent = S.conn === 'online' ? 'Saving…' : 'Waiting for connection · your changes will send automatically';
    let rb = await link.send('rename', body);
    if (disposed) return;
    if (rb.receipt === 'stale_epoch') { await sleep(700); if (disposed) return; rb = await link.send('rename', body); }
    if (disposed) return;
    btn.disabled = false;
    if (rb.receipt === 'accepted' || rb.receipt === 'already_accepted') {
      msg.textContent = 'Changes saved'; dirty = false;
      // Rename is quiet for phones; the server receipt confirms this phone's own saved appearance.
      applyProfileReceipt(rb, S.view, body, () => {
        if (prefix === 'menu') closeMenu(true);
        else { const details = root.closest('details'); if (details) { details.open = false; details.querySelector('summary')?.focus(); } }
      });
      render();
    }
    else if (rb.reason === 'unknown_participant') { void terminate('removed'); }
    else msg.textContent = 'Not saved · check your name and try again';
  });
  return {
    root, input: name.input,
    sync() { if (!dirty && !root.contains(document.activeElement)) { name.set(S.view?.you?.name ?? ''); pick.set(S.view?.you?.avatarId ?? null); } },
  };
}

// ───────────────────────── join flow ─────────────────────────
// Code and a required name, with an allowlisted avatar default, then `Join case` (CASE-119, CASE-121). There is no
// nameless join. Everything is checked here first, and again by the server (parseJoinRequest).
// Card 36a: a well-formed prefilled code is confirmed in one line (Change opens the existing input in place); the avatar
// is preassigned with the grid folded under Change avatar; the page draws the BRAND braid (this phone holds only a code,
// so no case is disclosed, CASE-164).
/** Draw splash art into `host` from the lazy chunk; a failed load leaves the plain ground (the art is decorative). */
async function paintSplash(host, opts) {
  let chunk;
  try { chunk = await import('./splash.mjs'); } catch { return null; }
  if (disposed || !host.isConnected) return null;
  const splash = chunk.mountCaseSplash(host, opts.art ?? null, opts);
  splashes.add(splash);
  return splash;
}
function stopSplashes() { for (const splash of splashes) splash.stop(); splashes.clear(); }
function buildJoin() {
  let savedCode = '';
  try { savedCode = sessionStorage.getItem(JOIN_CODE_DRAFT) || ''; } catch { /* private browsing can deny storage */ }
  const code = h('input', { type: 'text', id: 'jcode', inputmode: 'text', autocomplete: 'off', autocapitalize: 'characters', autocorrect: 'off', spellcheck: 'false', maxlength: String(JOIN_CODE_LENGTH), minlength: String(JOIN_CODE_LENGTH), enterkeyhint: 'next', required: '', 'aria-describedby': 'jcode-hint jcode-err' });
  const codeHint = h('p', { class: 'hint', id: 'jcode-hint' });
  attachRoomCodeMask(code, codeHint, initialCode || savedCode);
  try { sessionStorage.removeItem(JOIN_CODE_DRAFT); } catch { /* denied */ }
  const codeErr = h('p', { class: 'err', id: 'jcode-err', role: 'alert' });
  const preset = normalizeCode(code.value, JOIN_CODE_LENGTH);
  const codeBoxes = mountCodeBoxes(code);
  const codeField = h('div', { id: 'jcode-field' }, h('label', { class: 'field', for: 'jcode', text: 'Session code' }), codeBoxes.root, codeHint, codeErr);
  const change = h('button', { type: 'button', class: 'btn tertiary', id: 'jcode-change', 'aria-label': 'Change code', 'aria-controls': 'jcode-field', 'aria-expanded': 'false', text: 'Change' });
  const roomText = h('p', { class: 'room-line-text' });
  roomText.append(document.createTextNode('Room '), h('span', { class: 'room-code', text: preset ? formatCode(preset) : '' }));
  const roomLine = h('div', { class: 'room-line' }, roomText, change);
  // The input is shown whenever there is no well-formed code, and whenever a refusal fills the error under it.
  const showCodeField = (focus) => { codeField.hidden = false; roomLine.hidden = true; change.setAttribute('aria-expanded', 'true'); if (focus) code.focus(); };
  codeField.hidden = !!preset; roomLine.hidden = !preset;
  change.addEventListener('click', () => showCodeField(true));
  const name = nameField('j');
  name.root.classList.add('join-name');
  name.root.append(h('p', { class: 'hint', text: 'Do not enter patient details.' }));
  // The avatar is preassigned (the allowlisted random default); the grid and Randomise sit under Change avatar.
  const pick = joinAvatarPicker('j');
  pick.ensureSelected();
  const avatarSlot = h('span', { class: 'avatar-slot' });
  const avatarNote = h('span', { class: 'avatar-note', text: 'Picked at random. You can change it now or later.' });
  const updAvatar = () => avatarSlot.replaceChildren(avatarEl(pick.value(), { size: 56, name: name.value() }));
  pick.onPick(() => { avatarNote.textContent = 'Your choice. You can change it now or later.'; updAvatar(); });
  name.input.addEventListener('input', updAvatar);
  updAvatar();
  const avatarRow = h('div', { class: 'avatar-row' }, avatarSlot, h('div', { class: 'avatar-text' }, h('span', { class: 'avatar-label', text: 'Your avatar' }), avatarNote));
  const avatarMore = h('details', { class: 'disclose' }, h('summary', { text: 'Change avatar' }), pick.root);
  const joinErr = h('p', { class: 'err', id: 'jerr', role: 'alert' });
  const joinBtn = h('button', { type: 'submit', class: 'btn primary block lg', text: 'Join case' });
  const status = h('p', { class: 'small muted', role: 'status', 'aria-live': 'polite' });
  const challengeArea=h('div',{'data-turnstile-challenge':''});
  const challenge=createTurnstileController(challengeArea,{onUnavailable:()=>{if(!disposed)status.textContent='Verification unavailable · check your code and try Join again';}});
  challenges.add(challenge);
  const privacy = h('a', { href: privacyUrl(location.origin), text: 'Privacy' });
  privacy.addEventListener('click', () => {
    try {
      sessionStorage.setItem(JOIN_CODE_DRAFT, code.value);
      onPrivacy();
    } catch { /* the link still works */ }
  });
  const form = h('form', { class: 'card splash-panel', novalidate: '', 'aria-labelledby': 'mh' },
    h('h1', { id: 'mh', tabindex: '-1', 'data-focus-heading': '', text: 'Join the case' }),
    missingSavedPlace ? h('p', { text: 'This browser no longer has your saved place. To rejoin a session that is still open, enter its code.' }) : null,
    missingSavedPlace ? h('p', { class: 'hint', text: "Open in your browser or use mobile data if this page won't load" }) : null,
    roomLine, codeField,
    name.root, avatarRow, avatarMore,
    joinErr, status, challengeArea, h('p', { class: 'hint', text: 'Your name and avatar appear on the projector in the lobby.' }), joinBtn,
    h('footer', { class: 'join-footer' }, privacy));
  const artHost = h('div', { class: 'splash-art', 'data-splash-art': '', 'aria-hidden': 'true' });
  // Typing lays the route one sixth per character (only the count is read); the art arrives once per page.
  let joinArt = null;
  void paintSplash(artHost, { brand: true, surface: 'join' }).then(splash => { joinArt = splash; if (!preset) splash?.laid(typedLength(code)); });
  watchCodeLength(code, count => joinArt?.laid(count));

  async function go() {
    codeErr.textContent = ''; joinErr.textContent = ''; code.removeAttribute('aria-invalid');
    const norm = normalizeCode(code.value, JOIN_CODE_LENGTH);
    if (!norm) { code.setAttribute('aria-invalid', 'true'); codeErr.replaceChildren(icon('alert', 16), document.createTextNode(C.invalidCode)); showCodeField(true); return; }
    if (!name.valid()) { name.input.focus(); return; }
    pick.ensureSelected();
    joinBtn.disabled = true;
    status.textContent = 'Joining…';
    const res = await link.join(norm, name.value(), pick.value(), challenge.takeToken() ?? undefined);
    if (disposed) return;
    if (res.ok) { await restoreOutbox(link.snapshot?.view ?? S.view); if (disposed) return; if(entryDocument){status.textContent='Joined · checking the session…';return;} try { sessionStorage.removeItem(JOIN_CODE_DRAFT); } catch { /* no stored draft */ } status.textContent = 'Joined · checking the session…'; render(); return; }
    joinBtn.disabled = false;
    status.textContent = '';
    const e = res.error;
    if(e==='challenge_required'){if(res.siteKey){status.textContent='Verify to try another code';await challenge.challenge(res.siteKey);}else status.textContent='Verification unavailable · check your code and try Join again';return;}
    if(e==='challenge_failed'){status.textContent='Verification expired · try again';return;}
    if (e === 'unknown_code' || e === 'bad_code') { code.setAttribute('aria-invalid', 'true'); codeErr.replaceChildren(icon('alert', 16), document.createTextNode(C.invalidCode)); showCodeField(true); }
    else if (e === 'bad_display_name' || e === 'unsafe_characters') { joinErr.textContent = NAME_PROBLEM_TEXT.characters; name.input.focus(); }
    else if (e === 'bad_avatar') joinErr.textContent = 'Choose an avatar';
    else if (e === 'joining_closed') joinErr.textContent = C.closed;
    else if (e === 'room_full') joinErr.textContent = 'This session is full';
    else if (e === 'removed') { void terminate('removed'); }
    else if (e === 'network') joinErr.textContent = "Couldn't reach the room · check your connection and try again";
    else joinErr.textContent = "Couldn't join · check the code and try again";
  }
  form.addEventListener('submit', (ev) => { ev.preventDefault(); go(); });
  return h('div', { class: 'phone-splash' }, artHost, form);
}

// ───────────────────────── decision card + answer lifecycle ─────────────────────────
// The answer's delivery state (the card itself lives in phone-render.mjs and reads this through `delivery.state`).
const dec = { ver: 0, intent: 0, desired: null, queueFailed: false, pend: null, accepted: null, msg: null, locked: false };

/** A round started or the card was cleared: forget this round's delivery. */
function resetDecision() {
  dec.ver++;
  dec.intent++; dec.desired = null; dec.queueFailed = false;
  dec.pend = null; dec.accepted = null; dec.msg = null; dec.locked = false;
}
const ok = (text) => ({ kind: 'ok', text });
const alertMsg = (text) => ({ kind: 'alert', text });
function savedOf(d) { return savedResponse(d, dec.accepted); }
function refreshDecision() {
  if(disposed)return; renderer.refreshDecision(); }

// The renderer's Send hands over the drafted response; onSend decides whether it is a new answer to keep and send.
let offered = null;
function onAnswer(response) { offered = response; return onSend(); }
async function onSend() {
  const d = S.view?.decision, response = offered;
  const single = d?.interaction.type === 'single_choice';
  if (!d || d.status !== 'open' || S.view.manual || !single && (enqueuing || dec.pend?.state === 'sending' && S.conn === 'online')) return;
  if (!response || !dec.queueFailed && sameResponse(response, dec.desired ?? savedOf(d))) return;
  dec.desired = response; dec.queueFailed = false;
  const intent = ++dec.intent;
  enqueuing++; dec.ver++; dec.msg = null; refreshDecision();
  const job = async () => { try {
    await binding;
    if (disposed || S.view?.decision?.roundId !== d.roundId || S.view.decision.status === 'locked' || S.view.manual) {
      if (intent === dec.intent) dec.desired = null;
      return;
    }
    if (!outbox) throw new Error('Vote storage unavailable');
    const body = await outbox.enqueue({ roundId: d.roundId, epoch: S.snap?.epoch ?? 0, response });
    if (disposed) return;
    if (S.view?.decision?.roundId !== d.roundId) { await voteStore.update(link.sessionId, rows => ({ rows: rows.filter(row => row.envelope.clientEventId !== body.clientEventId), result: null })); return; }
    if (intent === dec.intent) {
      dec.ver++; dec.pend = { roundId: d.roundId, body, response, state: S.conn === 'online' ? 'sending' : 'waiting' };
      dec.msg = null;
    }
    await updateUnsent(); dispatchPending(dec.pend);
  } catch { if (!disposed && intent === dec.intent) { dec.queueFailed = true; dec.msg = alertMsg('Answer not queued · storage is unavailable or the queue is full'); } }
  finally { enqueuing--; if (!disposed) refreshDecision(); } };
  enqueueTail = enqueueTail.then(job, job);
  await enqueueTail;
}
function dispatchPending(p) {
  if (!p || disposed || !outbox || S.conn !== 'online' || S.view?.manual || S.view?.decision?.status !== 'open') return;
  p.state = 'sending'; refreshDecision();
  void settlePhoneDelivery({flush:()=>outbox.flush(),current:()=>!disposed,
    failed:()=>{if(dec.pend!==p)return;p.state='waiting';dec.msg=alertMsg('Answer storage unavailable · keep this page open');},
    settled:()=>{void updateUnsent();refreshDecision();}});
}
function resend(p) {
  if (!outbox || disposed) return;
  outbox.setEpoch(S.snap?.epoch ?? p.body.epoch).then(() => dispatchPending(p)).catch(() => { if (disposed) return; dec.msg = alertMsg('Answer storage unavailable · keep this page open'); refreshDecision(); });
}

function onReceipt(p, rb) {
  if (disposed || dec.pend !== p) return; // dropped (round changed) or superseded
  dec.ver++;
  const d = S.view?.decision;
  switch (rb.receipt) {
    case 'accepted': case 'already_accepted':
      dec.pend = null;
      dec.accepted = { roundId: p.roundId, response: p.response, clientEventId: p.body.clientEventId };
      renderer.decision.accepted(d, p.response);
      dec.msg = ok(rb.receipt === 'accepted' ? C.saved : C.savedDup);
      break;
    case 'locked': {
      dec.pend = null; dec.locked = true;
      const had = d ? savedOf(d) : null;
      dec.msg = alertMsg(had ? C.lockedSaved : C.lockedNone);
      break;
    }
    case 'paused_held':
      p.state = 'held'; // keep the same clientEventId; resent when decision.status returns to open
      link.refetch();
      break;
    case 'stale_epoch':
      p.state = 'refetch';
      link.refetch(); // fresh snapshot, then reconcilePending resends under the new epoch
      setTimeout(() => { if (dec.pend === p && p.state === 'refetch') reconcilePending(S.view, true); }, 3000);
      break;
    case 'rejected': {
      dec.pend = null;
      const r = rb.reason;
      if (r === 'round_voided') dec.msg = alertMsg(C.voided);
      else if (r === 'manual_room') dec.msg = alertMsg(C.manualRoom);
      else if (r === 'unknown_participant') { void terminate('removed'); return; }
      else if (r === 'room_ended') dec.msg = alertMsg(C.ended);
      else dec.msg = alertMsg(C.rejected); // client_event_id_reused, bad_response, unknown_round: the snapshot refetch follows
      break;
    }
    case 'timeout':
      p.state = 'waiting'; // bus gave up after MAX_TRIES: say so, keep the answer, retry with the same id
      setTimeout(() => { if (dec.pend === p && p.state === 'waiting') dispatchPending(p); }, 1000);
      break;
    default:
      dec.pend = null; dec.msg = alertMsg(C.rejected);
  }
  if (S.mode === 'room') { if (rb.receipt !== 'paused_held') reconcilePending(S.view); refreshDecision(); }
}

function reconcilePending(v, force = false) {
  const p = dec.pend;
  if (!p || !v) return;
  const d = v.decision;
  if (!d || d.roundId !== p.roundId) { dec.ver++; dec.pend = null; return; }
  if (d.status === 'locked') { // the round locked while the answer was held or in flight
    dec.ver++; dec.pend = null; dec.msg = alertMsg(savedOf(d) ? C.lockedSaved : C.lockedNone);
    return;
  }
  if (p.state === 'held' && d.status === 'open') { resend(p); return; }
  if (p.state === 'refetch' && S.snap) {
    if (S.snap.epoch !== p.body.epoch || force) {
      if (d.status === 'open') resend(p); else p.state = 'held';
    }
  }
}

// ───────────────────────── advisory timer (drawn by the renderer, ticked here) ─────────────────────────
setInterval(() => { if (S.mode === 'room') renderer.tick(); }, 1000);

// ───────────────────────── go ─────────────────────────
render();
const clearMemory = () => {
  disposed = true;
  participantMenu.remove();
  stopSplashes();
  for(const challenge of challenges)challenge.close();challenges.clear();
  for (const remove of listeners) remove();
  for (const id of timeouts) globalThis.clearTimeout(id);
  for (const id of intervals) globalThis.clearInterval(id);
  link.dropPending(); link.close(); outbox?.close(); outbox=null;outboxOwner=null;voteStore.close().catch(() => {});
  roomMedia.clear(); S.view = null; S.snap = null; dec.pend = null; dec.accepted = null; dec.msg = null; renameCtl = null;
  renderer.dispose();
  root.replaceChildren(); document.body.classList.remove('phone-page'); document.documentElement.classList.remove('phone-page');
};
const controller = { cancel: clearMemory, get sessionId() { return link.sessionId; },
  teardown: (reason='token_loss') => terminate(reason),
};
updateUnsent();
return controller;

}
