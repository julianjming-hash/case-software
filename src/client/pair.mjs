import { shellNotice } from './shell.mjs';
import { requestDisplayPair, storeCredential } from './transport.mjs';
import { isUuid, isUuidV7, uuidv7, normalizeCode, formatCode } from '../shared/ids.mjs';
import { parseRoute, sessionUrl, localNotesObjectUrl } from '../shared/urls.mjs';
import { WIRE_VERSION } from '../shared/wire.mjs';
import { mountAccount } from './auth-ui.mjs';
import { mountConsoleApproval } from './console-approval.mjs';
import { createTeardown, recoverOnLoad, authNavigationPreservation } from './teardown.mjs';
import { requestConsolePair } from './console-pair-request.mjs';
import { mountConsoleRoom } from './console-room.mjs';
import { ConsoleManualRoom, savedManualKey } from './console-manual.mjs';
import { validatedConsoleHandoff } from './console-pc-handoff.mjs';

// A phone that can approve a shared PC (Card 11). It no longer decides where an account session is kept (card 38).
const isPhoneEligible = () => {
  try { return globalThis.screen?.isExtended !== true && /\b(Android|iPhone|iPad|Mobile)\b/i.test(navigator.userAgent); }
  catch { return false; }
};

// A shared PC only ever holds the one-use pair capability and eventual room
// capability in memory. It never requests or stores the phone's account JWT.
export function mountConsolePair() {
  const main = document.querySelector('main'); main.replaceChildren(); main.classList.add('console-pair');
  const element = (tag, value, cls) => { const item = document.createElement(tag); item.textContent = value; if (cls) item.className = cls; return item; };
  main.append(element('p', 'Case · shared PC', 'eyebrow'), element('h1', 'Pair this PC'));
  const code = element('p', '…', 'pair-code'); code.setAttribute('aria-label', 'PC approval code');
  const status = element('p', 'Asking for a code…'); status.setAttribute('role', 'status');
  const usePhone = element('button', 'Use a shared computer', 'btn'); usePhone.type = 'button';
  main.append(element('p', 'On your signed-in phone, open your room, choose Room, then Use a shared computer, and enter this code.'), code, status);
  if (isPhoneEligible()) main.append(usePhone);
  const savedKey = () => { const key = savedManualKey(); return key ? [key] : []; };
  const saved = savedManualKey();
  if (saved) {
    const download = element('button', 'Download saved manual notes', 'btn'); download.type = 'button';
    download.addEventListener('click', () => {
      const key = savedManualKey();
      const segment = key && ConsoleManualRoom.saved(key.slice('case-lab:segment:'.length));
      if (!segment) { download.remove(); return; }
      const blob = new Blob([ConsoleManualRoom.notesFromSaved(segment)], { type: 'text/plain;charset=utf-8' });
      const url = localNotesObjectUrl(blob);
      const anchor = element('a', ''); anchor.href = url; anchor.download = 'case-manual-notes.txt';
      anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
    });
    main.append(download);
  }
  let closed = false, pageClosed = false, handoffPending = false, roomToken = null, pairSecret = null, activeRoom = null;
  const activeRequests = new Set();
  const close = reason => { closed = true; roomToken = null; pairSecret = null;
    activeRoom?.close({ preserveSegment: reason === 'pagehide' }); activeRoom = null;
    for (const controller of activeRequests) controller.abort(); activeRequests.clear(); };
  const pcTeardown = createTeardown({ clearMemory: close,
    ...authNavigationPreservation({ sessionStorage, preserveSessionKeys: savedKey }) });
  const onPageHide = () => { pageClosed = true; void pcTeardown('pagehide'); };
  window.addEventListener('pagehide', onPageHide, { once: true });
  usePhone.addEventListener('click', () => {
    if (!isPhoneEligible() || closed || pageClosed || handoffPending) return;
    handoffPending = true;
    void (async () => {
      const cleaned = await pcTeardown('pagehide');
      if (pageClosed) return;
      if (!cleaned.complete) { status.textContent = 'Pairing unavailable. Reload to try again.'; return; }
      // Keep the PC listener through the async cleanup. Transfer ownership in
      // this synchronous turn, just before Auth installs its pagehide listener.
      window.removeEventListener('pagehide', onPageHide);
      main.replaceChildren(element('p', 'Case · phone approval', 'eyebrow'), element('h1', 'Approve a PC'));
      let approval = null;
      mountAccount(main, {
        onSignedOut() { approval?.clear(); approval = null; },
        onSignedIn(auth) { approval?.clear(); approval = mountConsoleApproval(main, auth); },
      });
    })();
  });
  const request = (parts, options = {}) => requestConsolePair({
    origin: location.origin, parts, ...options, controllers: activeRequests,
  });
  void (async () => {
    try {
      const recovered = await recoverOnLoad({ preserveSessionKeys: savedKey });
      if (closed) return;
      if (!recovered.complete) throw new Error('pair_unavailable');
      const pair = await request(['console-pairs'], { method: 'POST' });
      if (closed || !isUuidV7(pair?.pairId) || normalizeCode(pair?.code, 8) !== pair.code ||
          typeof pair.secret !== 'string' || !pair.secret) throw new Error('pair_unavailable');
      pairSecret = pair.secret;
      code.textContent = formatCode(pair.code); status.textContent = 'Waiting for phone approval…';
      const expires = Date.parse(pair.expiresAt);
      while (!closed && Date.now() < expires) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        if (closed) return;
        const result = await request(['console-pairs', pair.pairId], { secret: pairSecret });
        if (closed) return;
        if (result.pending === true) continue;
        if (!isUuidV7(result.sessionId) || typeof result.facilitatorToken !== 'string' || !result.facilitatorToken)
          throw new Error('pair_unavailable');
        roomToken = result.facilitatorToken;
        pairSecret = null;
        const snapshot = await request(['sessions', result.sessionId, 'snapshot'], { secret: roomToken, large: true });
        if (closed) return;
        if (!Number.isSafeInteger(snapshot?.epoch) || snapshot.epoch < 0) throw new Error('pair_unavailable');
        const taken = await request(['sessions', result.sessionId, 'commands'], { method: 'POST', secret: roomToken,
          body: { v: WIRE_VERSION, type: 'takeover', epoch: snapshot.epoch, clientEventId: uuidv7() } });
        if (closed) return;
        const handoff = validatedConsoleHandoff(result, snapshot, taken);
        if (!handoff) throw new Error('pair_unavailable');
        const preservedKey = savedManualKey();
        const restoredSaved = preservedKey === `case-lab:segment:${handoff.sessionId}` ?
          ConsoleManualRoom.saved(handoff.sessionId) : null;
        if (preservedKey && !restoredSaved) try { sessionStorage.removeItem(preservedKey); } catch {}
        code.textContent = ''; pairSecret = null;
        activeRoom = mountConsoleRoom(main, { sessionId: handoff.sessionId,
          joinCode: handoff.joinCode, facilitatorToken: handoff.facilitatorToken,
          restoredSaved, readyNotice: 'PC ready', onEnded({ localOnly = false, reason = null, ended = null } = {}) {
            void pcTeardown('room_end').then(async () => {
              if (pageClosed) return;
              // Card 40 slice 6 (ruling D): a shared computer also shows the ended summary first; it shows no feedback count (R9).
              if (ended) {
                const { mountEndedSummary } = await import('./ended-summary.mjs');
                if (pageClosed) return;
                await new Promise((done) => { mountEndedSummary(main, { ...ended, sharedComputer: true, onBack: done }); });
                if (pageClosed) return;
              }
              const again = element('button', 'Approve a new session', 'btn primary'); again.type = 'button';
              again.addEventListener('click', () => location.reload());
              main.replaceChildren(element('h1', reason === 'access_lost' ? 'Console access ended' : localOnly ? 'Local presentation ended' : 'Room ended'),
                element('p', reason === 'access_lost' ? 'This computer no longer controls the room: the room starter stopped it or took the room back. The room may still be running. Approve a new session from your signed-in phone.' :
                  localOnly ? 'Sign in on your phone when online to confirm the server room is closed.' :
                  'This PC has cleared the room. Approve a new session from your signed-in phone.'), again);
            }).catch(() => {});
          } });
        roomToken = null;
        return;
      }
      throw new Error('pair_unavailable');
    } catch { roomToken = null; pairSecret = null; if (!closed) status.textContent = 'Pairing expired or unavailable. Reload to get a new code.'; }
  })();
}

export function displayApproval(value) {
  return value && Object.keys(value).length === 2 && isUuid(value.sessionId) && typeof value.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value.token)
    ? { sessionId: value.sessionId, token: value.token } : null;
}
export function mount() {
  if (parseRoute(location.pathname)?.route !== 'display-pair') { shellNotice('Approve a device'); return; }
  document.body.classList.add('display-pair');
  const main = document.querySelector('main'); main.replaceChildren();
  const element = (tag, text, cls) => { const node = document.createElement(tag); node.textContent = text; if (cls) node.className = cls; return node; };
  const title = element('h1', 'Pair this display');
  const lead = element('p', 'On the facilitator console, open Room → Pair display and enter this code.');
  const code = element('p', '…', 'pair-code'); code.setAttribute('aria-label', 'Display pairing code');
  const status = element('p', 'Asking for a code…'); status.setAttribute('role', 'status');
  const retry = element('button', 'Get a new code', 'btn'); retry.type = 'button'; retry.hidden = true;
  main.append(title, lead, code, status, retry);
  let closed = false; let timer = null; let running = false;
  const timeScale = Math.min(1, Math.max(.005, Number(new URLSearchParams(location.search).get('scale')) || 1));
  const pause = () => new Promise(resolve => { timer = setTimeout(resolve, 2000 * timeScale); });
  async function pair() {
    if (running || closed) return;
    running = true; retry.hidden = true;
    try {
      const request = await requestDisplayPair({ api: location.origin });
      if (closed) return;
      if (request.error || normalizeCode(request.code, 8) !== request.code || !isUuid(request.pairId)) throw new Error('pair_failed');
      code.textContent = formatCode(request.code); status.textContent = 'Waiting for the facilitator to approve…';
      for (;;) {
        await pause(); if (closed) return;
        const response = await request.poll(); if (closed) return;
        const credential = displayApproval(response);
        if (credential) {
          storeCredential('display', null, credential);
          const target = new URL(sessionUrl(credential.sessionId, 'display', location.origin));
          target.searchParams.set('topology', 'separate');
          if (timeScale !== 1) target.searchParams.set('scale', String(timeScale));
          location.replace(target.href); return;
        }
        if (response.pending !== true || Object.keys(response).length !== 1) throw new Error('pair_failed');
      }
    } catch {
      if (!closed) { status.textContent = 'Pairing expired or unavailable. Get a new code to try again.'; retry.hidden = false; }
    } finally { running = false; }
  }
  retry.addEventListener('click', pair);
  window.addEventListener('pagehide', () => { closed = true; clearTimeout(timer); }, { once: true });
  pair();
}
