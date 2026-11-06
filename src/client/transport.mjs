// src/client/transport.mjs: the real client transport for a Case room (Phase 1).
//
// Same API as the stage C lab bus (prototypes/room/lib/bus.mjs), so the facilitator console, the
// display and the phone run unchanged against either:
//
//   const link = connect({ role: 'participant', slot: 'A', api: 'https://case.iatrogenic.app' });
//   link.on('snapshot', (snap) => render(snap.view));     // snapshotBody() from wire.mjs
//   link.on('status', (s, { mode }) => …);                 // 'connecting' | 'online' | 'lost'; mode below
//   const rb = await link.send('vote', { roundId, response });  // receiptBody(), or {receipt:'timeout'}
//   await link.join('7K3QX9', 'Sam');                      // participant only: POST /join
//   link.on('case_pack', (doc) => …);                      // facilitator only: GET /case-pack
//
// How it talks to the Worker (docs/plans/2026-10-01-phase-1-room-runtime.md, HANDOFF §Network resilience):
//   • Snapshots arrive over a WebSocket first (`link.mode === 'ws'`). The first frame is `hello` with
//     the token; the token never goes in a URL. The fixed PING_FRAME goes out every HEARTBEAT_MS and
//     ANY inbound frame counts as life: a socket silent for DEAD_AFTER_MS is dead even if it still
//     reports OPEN (AS-022), so it is closed and replaced.
//   • A socket that cannot open, or keeps dying, falls back to long-poll `GET /updates`
//     (`'long-poll'`), and long-poll that keeps failing falls back to short polling of `/snapshot`
//     with jitter (`'poll'`). Each fallback probes the better transport again now and then.
//   • Commands always go over HTTPS (`POST /commands`), and the receipt is the response. A command is
//     retried with the SAME clientEventId until a receipt arrives, so the caller never claims success
//     before one (HANDOFF), and a retry the server already applied comes back `already_accepted`.
//   • On `visibilitychange` to visible and on `online`, the client verifies its revision against a
//     fresh snapshot, replaces a stale socket and resends pending commands at once (AS-021).
//   • Every SYNC_MS the socket also carries the fixed SYNC_FRAME, which the room itself answers with its
//     revisions: no answer is a dead socket even while pongs (auto-answered) still arrive, and a newer
//     revision is a missed broadcast, so the snapshot is refetched (AS-022, spec red team 2 P1-1).
//   • A socket the heartbeat finds dead counts as a failure however long it lived. Two such deaths in
//     STALL_WINDOW_MS pin this network to long-poll for PIN_MS, remembered in localStorage under
//     PIN_KEY (no token, no name; AS-060). A display starts on long-poll, the expected path on a
//     hospital proxy, and tries the socket only after a healthy long-poll period.
//   • Tokens never go in a URL. Where each role keeps its token (CASE-103, CASE-106):
//       participant  localStorage until the recap expires (`expiresAt`), so a closed browser keeps the
//                    recap; expired entries are purged on load;
//       display      sessionStorage (one paired window);
//       facilitator  memory only.
//
// Runs in browsers and in Node 22 (global fetch and WebSocket). Everything environmental can be
// injected (fetch, WebSocket, storage, lifecycle events) so the transport tests can cut the network.
import { createTelemetry } from './telemetry.mjs';
import { apiOrigin } from './api-origin.mjs';
import { apiPath, roomMediaPath } from '../shared/urls.mjs';
export { apiOrigin } from './api-origin.mjs';
import { uuidv7, newCapabilityToken } from '../shared/ids.mjs';
import { WIRE_VERSION, PING_FRAME, SYNC_FRAME, HEARTBEAT_MS, DEAD_AFTER_MS, LONG_POLL_MAX_S, SYNC_MS, SYNC_TIMEOUT_MS } from '../shared/wire.mjs';

/** Real timings. `connect({ timeScale })` multiplies every duration (tests use e.g. 0.1). */
export const TIMINGS = Object.freeze({
  HEARTBEAT_MS,                 // ping interval (wire.mjs)
  DEAD_AFTER_MS,                // no inbound frame for this long ⇒ the socket is dead (wire.mjs)
  CONNECT_TIMEOUT_MS: 10_000,   // a socket not welcomed within this has failed to open
  WS_FAILURES_TO_FALL_BACK: 2,  // consecutive failed or short-lived sockets before long-poll
  WS_SHORT_LIFE_MS: 60_000,     // a welcomed socket that dies sooner than this counts as a failure
  WS_PROBE_MS: 60_000,          // on a fallback, try the socket again this often
  LONG_POLL_WAIT_S: LONG_POLL_MAX_S,
  LONG_POLL_FAILURES_TO_FALL_BACK: 2,
  LONG_POLL_PROBE_MS: 30_000,   // on short polling, try long-poll again this often
  POLL_MS: 3_000,               // short-poll interval, ± POLL_JITTER
  POLL_JITTER: 0.5,
  RETRY_MS: 2_000,              // command resend interval while no receipt
  MAX_TRIES: 30,                // then the command resolves {receipt:'timeout'}; callers may resend
  REQUEST_TIMEOUT_MS: 10_000,   // one HTTP attempt
  RECONNECT_BASE_MS: 500,       // socket reconnect backoff (doubling, jittered)
  RECONNECT_MAX_MS: 8_000,
  SYNC_MS,                      // app-level sync frame interval (wire.mjs)
  SYNC_TIMEOUT_MS,              // no sync answer within this ⇒ the socket is dead (wire.mjs)
  STALL_WINDOW_MS: 600_000,     // heartbeat deaths counted within this window…
  STALLS_TO_PIN: 2,             // …this many pin the network to long-poll (AS-060)
  PIN_MS: 24 * 60 * 60_000,     // how long a pin lasts
  DISPLAY_UPGRADE_MS: 120_000,  // a display tries the socket only after this long on healthy long-poll
});

/** localStorage key of the long-poll pins: `{ [network]: untilMs }`. Never a token, a name or a room. */
export const PIN_KEY = 'case:transport:pin';
/** How long a participant token is kept when the room's own recap expiry is not yet known (24 h room + 24 h recap). */
import {PARTICIPANT_TOKEN_MAX_MS,validateParticipantRecovery,participantRoomInventory} from './storage-policy.mjs';
export {PARTICIPANT_TOKEN_MAX_MS} from './storage-policy.mjs';

/** Commands that carry `expectRevision` when sent from the console (room-machine FENCEABLE). Same as the bus. */
const FENCEABLE = new Set(['start', 'advance', 'lock', 'reopen', 'void_round', 'select_path', 'back_to_review', 'reveal', 'reset_checkpoint', 'enter_manual', 'resume_online', 'end']);
const AUTH_ERRORS = new Set(['unauthorised', 'removed', 'unknown_room', 'room_deleted']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function scaledTimings(timeScale = 1, overrides = {}) {
  const s = Number(timeScale) > 0 ? Number(timeScale) : 1;
  const t = {};
  // PIN_MS is wall-clock policy (a day), not a protocol timing, so tests never shrink it.
  for (const [k, v] of Object.entries(TIMINGS)) t[k] = k.endsWith('_MS') && k !== 'PIN_MS' ? Math.max(1, Math.round(v * s)) : v;
  t.LONG_POLL_WAIT_S = Math.max(1, Math.round(TIMINGS.LONG_POLL_WAIT_S * s));
  return Object.freeze({ ...t, ...overrides });
}

/** The web-storage key for a role and slot (the bus uses `case-lab:…`; the real client `case:…`). */
export const credentialKey = (role, slot = null) => `case:${role}:${slot ?? 'main'}:token`;

/**
 * The stored `{ sessionId, token, expiresAt? }` for a role and slot, or null. Pass the storage the role
 * uses: sessionStorage for a display (and the dev hand-off of a facilitator token), localStorage for a
 * participant. An entry past its `expiresAt` is removed and not returned.
 */
export function storedCredential(role, slot = null, storage = defaultStorage(), nowMs = Date.now()) {
  try {
    const key = credentialKey(role, slot);
    const c = JSON.parse(storage?.getItem(key) ?? 'null');
    if (!c || typeof c.token !== 'string' || !UUID.test(c.sessionId ?? '')) return null;
    if (Number.isFinite(c.expiresAt) && c.expiresAt <= nowMs) { storage.removeItem(key); return null; }
    return c;
  } catch { return null; }
}

/** Save `{ sessionId, token, expiresAt? }` for a role and slot in the given storage. */
export function storeCredential(role, slot, cred, storage = defaultStorage()) {
  try {
    const key=credentialKey(role,role==='participant'&&slot==null?cred.sessionId:slot),value=JSON.stringify({ sessionId: cred.sessionId, token: cred.token, ...(Number.isFinite(cred.expiresAt) ? { expiresAt: cred.expiresAt } : {}) });
    storage?.setItem(key,value);return storage?.getItem(key)===value;
  } catch { return false; }
}

/** Served phones select an exact room; a legacy main record is the only unbound upgrade candidate. */
export function participantCredential(sessionId = null, storage = defaultPersistentStorage(), nowMs = Date.now()) {
  let legacy;
  try{legacy=JSON.parse(storage?.getItem(credentialKey('participant',sessionId))??'null')??JSON.parse(storage?.getItem(credentialKey('participant'))??'null');}catch{return null;}
  if(!legacy&&!sessionId){try{const candidates=participantCredentials(storage,nowMs);return candidates.length===1?candidates[0]:null;}catch{return null;}}
  if ((sessionId&&legacy?.sessionId!==sessionId)||!validateParticipantRecovery({role:'participant',sessionId:legacy?.sessionId,credential:legacy,rows:[],knownInventory:true,now:nowMs}).preserve)return null;
  return legacy;
}

/** Candidates authorize counts-only recovery probes, never private rendering or sending. */
export const participantCredentials=(storage=defaultPersistentStorage(),nowMs=Date.now())=>[...participantRoomInventory(storage,nowMs).rooms.values()].map(owner=>owner.credential);

/** Remove every expired participant credential from `storage` (run on load; CASE-106). */
export function purgeExpiredCredentials(storage = defaultPersistentStorage(), nowMs = Date.now()) {
  try {
    const keys = [];
    for (let i = 0; i < (storage?.length ?? 0); i++) keys.push(storage.key(i));
    for (const k of keys) {
      if (!/^case:participant:[^:]+:token$/.test(k ?? '')) continue;
      let c = null;
      try { c = JSON.parse(storage.getItem(k)); } catch { /* unreadable: drop it */ }
      if (!c || !Number.isFinite(c.expiresAt) || c.expiresAt <= nowMs) storage.removeItem(k);
    }
  } catch { /* storage unavailable */ }
}

/** This network's label for the long-poll pin: the connection type where the browser exposes one. */
export function networkLabel() {
  try { return String(globalThis.navigator?.connection?.type || 'default'); } catch { return 'default'; }
}

/** Whether `network` is pinned to long-poll now (AS-060). */
export function pinnedToLongPoll(storage = defaultPersistentStorage(), network = networkLabel(), nowMs = Date.now()) {
  try {
    const pins = JSON.parse(storage?.getItem(PIN_KEY) ?? '{}') || {};
    return Number(pins[network]) > nowMs;
  } catch { return false; }
}

function pinLongPoll(storage, network, untilMs, nowMs = Date.now()) {
  try {
    const pins = JSON.parse(storage?.getItem(PIN_KEY) ?? '{}') || {};
    for (const [k, v] of Object.entries(pins)) if (!(Number(v) > nowMs)) delete pins[k];
    pins[network] = untilMs;
    storage?.setItem(PIN_KEY, JSON.stringify(pins));
  } catch { /* private mode: the pin lasts for this page only */ }
}


/**
 * A display asks to be paired (POST /display-pairs). Returns `{ pairId, code, expiresAt, poll }`;
 * `poll()` resolves `{ pending: true }`, `{ sessionId, token }` once approved (single use), or
 * `{ error }`. The pair secret stays in this closure and travels only as a bearer header.
 */
export async function requestDisplayPair({ api, fetchImpl = globalThis.fetch, timeoutMs = TIMINGS.REQUEST_TIMEOUT_MS } = {}) {
  const base = `${apiOrigin(api)}/api/v1`;
  const res = await httpJson(fetchImpl, 'POST', `${base}/display-pairs`, { timeoutMs });
  if (res.status !== 201) return { error: res.body?.error ?? (res.status ? `http_${res.status}` : 'network') };
  const { pairId, code, secret, expiresAt } = res.body;
  return {
    pairId, code, expiresAt,
    async poll() {
      const r = await httpJson(fetchImpl, 'GET', `${base}/display-pairs/${pairId}`, { token: secret, timeoutMs });
      if (r.status === 200) return r.body.pending ? { pending: true } : { sessionId: r.body.sessionId, token: r.body.token };
      return { error: r.body?.error ?? (r.status ? `http_${r.status}` : 'network') };
    },
  };
}

/**
 * Connect a room client.
 * @param {object} o
 * @param {'facilitator'|'display'|'participant'} o.role
 * @param {string} o.api           the Worker origin, e.g. 'https://case.iatrogenic.app'
 * @param {string} [o.sessionId]   the room; a participant learns it from join
 * @param {string} [o.token]       a room capability token; otherwise the stored one for this role and slot
 * @param {number} [o.timeScale]   multiply every duration (tests)
 */
export function connect({
  role, slot = null, label = role, api, sessionId = null, token = null,
  timeScale = 1, timings = {}, fetchImpl = globalThis.fetch?.bind(globalThis), WebSocketImpl = globalThis.WebSocket,
  storage = defaultStorage(), persistentStorage = defaultPersistentStorage(), network = networkLabel,
  lifecycle = defaultLifecycle(), telemetryImpl, credentialFence = null, restoreCredential = true,
} = {}) {
  const T = scaledTimings(timeScale, timings);
  const base = `${apiOrigin(api)}/api/v1`;
  const wsBase = base.replace(/^http/, 'ws');
  const clientId = uuidv7();
  const beacon=typeof telemetryImpl === 'function' ? telemetryImpl : createTelemetry({api,fetchImpl});
  const observe=event=>{try {void Promise.resolve(beacon(event)).catch(()=>{});} catch { /* optional */ }};
  const handlers = {};
  const emit = (ev, ...a) => (handlers[ev] || []).forEach((fn) => { try { fn(...a); } catch { console.error('transport_callback_error'); } });
  const pending = new Map(); // clientEventId → { body, resolve, tries, timer, inFlight }

  // Where this role keeps its token (CASE-103, CASE-106): a participant in localStorage until its recap
  // expires, a display in sessionStorage, a facilitator in memory only (never web storage).
  const credStore = role === 'participant' ? persistentStorage : role === 'display' ? storage : null;
  let tokenExpiresAt = null, saveVersion=0,credentialReady=Promise.resolve(true);
  if (role === 'participant' && slot != null) purgeExpiredCredentials(persistentStorage);
  const saveCredential = () => {
    if (!credStore || !token || !sessionId) return;
    if (role === 'participant' && !Number.isFinite(tokenExpiresAt)) tokenExpiresAt = Date.now() + PARTICIPANT_TOKEN_MAX_MS;
    const credential={sessionId,token,...(role==='participant'?{expiresAt:tokenExpiresAt}:{})},seen=++saveVersion;
    const commit=()=>{if(seen!==saveVersion || credentialFence && !credentialFence.valid())return false;
      return storeCredential(role,slot,credential,credStore);};
    credentialReady=Promise.resolve(credentialFence ? credentialFence.commit(commit,{key:credentialKey(role,role==='participant'&&slot==null?sessionId:slot),credential}) : commit()).catch(()=>false);
  };
  const dropCredential = (previousToken = token) => { try {
    const key = credentialKey(role, role === 'participant' && slot == null ? sessionId : slot);
    const saved = storedCredential(role, role === 'participant' && slot == null ? sessionId : slot, credStore);
    if (saved?.token === previousToken) credStore?.removeItem(key);
  } catch { /* private mode */ } };
  // Credential: explicit, else the stored one if it is for this room (a participant takes any).
  if (!token && restoreCredential) {
    const c = credStore ? role === 'participant' && slot == null ? participantCredential(sessionId, credStore) : storedCredential(role, slot, credStore) : null;
    if (c && (!sessionId || c.sessionId === sessionId)) { token = c.token; sessionId = c.sessionId; tokenExpiresAt = c.expiresAt ?? null; }
  } else if (sessionId) saveCredential();

  // AS-060: a network whose sockets keep stalling is pinned to long-poll for a day. A display starts on
  // long-poll (the expected path behind a hospital proxy) and tries the socket only once that is healthy.
  let pinned = pinnedToLongPoll(persistentStorage, network());
  const initialMode = () => (pinned || role === 'display' ? 'long-poll' : 'ws');
  let stalls = [];            // times of heartbeat-detected socket deaths, within STALL_WINDOW_MS
  let wsEverWelcomed = false;

  let mode = initialMode();   // 'ws' | 'long-poll' | 'poll'
  let status = 'connecting';
  let closed = false;
  let halted = false;         // an auth error: stop until a new token arrives
  let everOnline = false;
  let socket = null;          // { ws, welcomed, openedAt, welcomedAt, timer, probe }
  let wsFailures = 0;
  let lpFailures = 0;
  let lastWsInbound = 0;
  let lastPingAt = 0;
  let lastHttpOk = 0;
  let httpLive = false;
  let httpGen = 0;            // bumps to stop a running HTTP loop
  let reconnectTimer = null;
  let probeTimer = null;
  let packLoading = false;
  let credentialGeneration = 0;
  const inflight = new Set(); // AbortControllers to cancel on close

  const link = {
    clientId, role, slot, label,
    get credentialReady(){return credentialReady;},
    snapshot: null,
    casePack: null,
    participantId: null,
    get status() { return status; },
    get mode() { return mode; },
    /** True once this network is pinned to long-poll (AS-060). */
    get pinned() { return pinned; },
    get sessionId() { return sessionId; },
    get hasToken() { return Boolean(token); },
    /** Card 59 M3: one released image rendition's bytes, with this link's credential in the header only. */
    async mediaBytes(handle, rendition) {
      if (closed || !credentialIsCurrent() || !token || !sessionId) return { state: 'missing' };
      const generation = credentialGeneration;
      try {
        const response = await fetchImpl(new URL(roomMediaPath(sessionId, handle, rendition), base).href, { headers: { authorization: `Bearer ${token}` },
          cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(rendition === 'poster' ? 15_000 : 120_000) });
        if (closed || generation !== credentialGeneration) return { state: 'missing' };
        if (response.status === 410) return { state: 'withdrawn' };
        if (response.status === 429) return { state: 'busy' };
        // A still, a GIF or a video (card 59): only a stored media type is taken.
        const type = response.headers.get('content-type');
        if (!response.ok || !['image/jpeg', 'image/gif', 'video/mp4'].includes(type)) return { state: 'missing' };
        return { bytes: await response.arrayBuffer(), type };
      } catch { return { state: 'missing' }; }
    },
    /** Card 40 slice 6: the ended room's paging grant (P-36), credential in the header only; the caller validates it. */
    debriefGrant() { return closed || !token ? null : fetchImpl(new URL(apiPath('sessions', sessionId, 'debrief', 'grant'), base).href, { method: 'POST', headers: { authorization: `Bearer ${token}` }, cache: 'no-store', credentials: 'omit' }).then(r => r.ok ? r.json() : null, () => null); },
    on(ev, fn) { (handlers[ev] ||= []).push(fn); return link; },

    /** Send a command; resolves with the receipt. Retries the identical envelope until one arrives. */
    send(type, payload = {}, { fence = role === 'facilitator' } = {}) {
      const snap = link.snapshot;
      const body = { v: WIRE_VERSION, t: 'command', type, epoch: snap?.epoch ?? 0, clientEventId: uuidv7(), ...payload };
      if (fence && FENCEABLE.has(type) && snap && body.expectRevision === undefined) body.expectRevision = snap.revision;
      return link.sendFrame(body);
    },
    /** Lower level: send a prepared command frame (a held vote is resent with the same clientEventId). */
    sendFrame(body) {
      return new Promise((resolve) => {
        const id = body.clientEventId;
        // Resending a held answer (same clientEventId, maybe a new epoch) replaces the old attempt;
        // both callers get the one receipt.
        const prior = pending.get(id);
        if (prior) clearTimeout(prior.timer);
        const item = { body, resolve: prior ? (r) => { prior.resolve(r); resolve(r); } : resolve, tries: 0, timer: null, inFlight: false };
        pending.set(id, item);
        attempt(item);
      });
    },
    /** Abandon every command still retrying (e.g. online commands overtaken by manual mode). */
    dropPending() {
      for (const [id, item] of pending) { clearTimeout(item.timer); item.resolve({ receipt: 'dropped', clientEventId: id }); }
      pending.clear();
    },
    /** Fetch a fresh snapshot now (the "refetch the snapshot" steps of the answer lifecycle). */
    refetch() { return fetchSnapshot(true); },
    /** What `visibilitychange` (to visible) and `online` run: verify the revision, recycle a stale socket, resend now. */
    resync,
    /** Commands still waiting for a receipt (for the facilitator recovery tray). */
    get pendingCount() { return pending.size; },

    /** Participant join: POST /join. Uses the participant credential store; never a token in a URL. */
    async join(code, displayName, avatarId, turnstileToken = undefined) {
      const generation = credentialGeneration;
      if (turnstileToken !== undefined && (typeof turnstileToken !== 'string' || turnstileToken.length < 1 || turnstileToken.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(turnstileToken))) return { ok: false, error: 'bad_turnstile_token' };
      // One private capability per logical join, unchanged across its existing retry attempts.
      const joinToken = newCapabilityToken();
      let res;
      for (let i = 0; i < 3; i++) {
        if (closed || generation !== credentialGeneration) return { ok: false, error: closed ? 'closed' : 'no_credential' };
        res = await request('POST', '/join', { v: WIRE_VERSION, code, displayName, avatarId, joinToken, ...(turnstileToken === undefined ? {} : { turnstileToken }) }, { auth: false });
        if (closed || generation !== credentialGeneration) return { ok: false, error: closed ? 'closed' : 'no_credential' };
        if (res.status !== 0 && res.status < 500) break;
        await sleep(T.RETRY_MS);
      }
      if (res.status === 201) {
        if (res.body?.token !== joinToken) return { ok: false, error: 'join_identity_mismatch' };
        adopt(res.body.sessionId, res.body.token);
        link.participantId = res.body.participantId;
        return { ok: true, participantId: res.body.participantId };
      }
      if (res.status === 428 && res.body?.error === 'challenge_required' && typeof res.body.siteKey === 'string' && res.body.siteKey.length > 0 && res.body.siteKey.length <= 128 && !/[^A-Za-z0-9_-]/.test(res.body.siteKey)) return { ok: false, error: 'challenge_required', siteKey: res.body.siteKey };
      return { ok: false, error: res.status === 0 ? 'network' : res.body?.error ?? `http_${res.status}` };
    },
    /** Manual segment upload on recovery: POST /manual-segment. `{status, body}`; status 0 = no network. */
    uploadSegment(body) { return request('POST', '/manual-segment', body); },
    /** Facilitator: approve a display's pair code (number matching). `{ ok }` or `{ ok:false, error }`. */
    async approveDisplay(code) {
      const r = await request('POST', '/display-pairs/approve', { code });
      return r.status === 200 ? { ok: true } : { ok: false, error: r.status === 0 ? 'network' : r.body?.error ?? `http_${r.status}` };
    },
    /** Use a new credential (e.g. a display just paired). */
    adopt(newSessionId, newToken) { adopt(newSessionId, newToken); },
    /** Forget this client's token (sign-out, lab reset, re-pair). */
    forget() {
      credentialGeneration += 1; packLoading = false;
      dropCredential(); token = null; saveVersion++;
      stopChannels();
      link.snapshot = null; link.casePack = null; link.participantId = null;
      everOnline = false;
      setStatus('connecting');
    },
    close() {
      saveVersion++;
      closed = true;
      link.dropPending();
      token = link.snapshot = link.casePack = link.participantId = null;
      stopChannels();
      clearInterval(beat);
      for (const item of pending.values()) clearTimeout(item.timer);
      for (const c of inflight) c.abort();
      lifecycle.off?.(onVisible, onOnline, onOffline);
      removeCredentialFence?.();
      try {beacon.close?.();} catch { /* optional telemetry cleanup */ }
    },
  };

  const credentialIsCurrent=()=>{if(!credentialFence||credentialFence.valid())return true;link.close();emit('error','unauthorised');return false;};

  // ─── HTTP ──────────────────────────────────────────────────────────────────

  async function request(method, path, body, { auth = true, timeoutMs = T.REQUEST_TIMEOUT_MS } = {}) {
    if (closed || !credentialIsCurrent() || auth && (!token || !sessionId)) return { status: 0, body: { error: 'no_credential' } };
    const generation = credentialGeneration;
    const url = auth ? `${base}/sessions/${sessionId}${path}` : `${base}${path}`;
    const r = await httpJson(fetchImpl, method, url, { token: auth ? token : null, body, timeoutMs, inflight });
    if (closed || !credentialIsCurrent() || generation !== credentialGeneration) return { status: 0, body: { error: 'no_credential' } };
    if (r.body?.error === 'client_upgrade_required') { emit('error', 'client_upgrade_required'); halted = true; }
    // Only the Worker's own JSON is contact with the room: a proxy or portal page (often HTML 200) is not (2026-10-17 audit).
    if (r.status > 0 && r.status < 500 && r.body) lastHttpOk = Date.now();
    if (auth && (r.status === 401 || r.status === 403 || r.status === 404 || r.status === 410) && AUTH_ERRORS.has(r.body?.error)) onAuthError(r.body.error);
    return r;
  }

  async function attempt(item) {
    const id = item.body.clientEventId;
    if (pending.get(id) !== item || closed) return;
    clearTimeout(item.timer); item.timer = null;
    if (item.tries++ >= T.MAX_TRIES) { pending.delete(id); item.resolve({ receipt: 'timeout', clientEventId: id }); return; }
    if (!token || !sessionId || halted) { item.timer = setTimeout(() => attempt(item), T.RETRY_MS); return; }
    const { t, ...envelope } = item.body; // the HTTP route takes the envelope; `t` is the socket frame tag
    item.inFlight = true;
    const r = await request('POST', '/commands', envelope);
    item.inFlight = false;
    if (pending.get(id) !== item) return; // superseded by a resend or dropped
    if (r.status === 200 && r.body?.receipt) {
      pending.delete(id);
      if (r.body.snapshot) applySnapshot(r.body.snapshot);
      emit('receipt', r.body.receipt, item.body);
      item.resolve(r.body.receipt);
      return;
    }
    if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) {
      // Refused before the reducer (auth, size, shape): no receipt will ever come, so say so.
      pending.delete(id);
      item.resolve({ v: WIRE_VERSION, t: 'receipt', clientEventId: id, receipt: 'rejected', reason: r.body?.error ?? `http_${r.status}` });
      return;
    }
    item.timer = setTimeout(() => attempt(item), T.RETRY_MS);
  }

  function kickPending() {
    for (const item of pending.values()) if (!item.inFlight) attempt(item);
  }

  async function fetchSnapshot(force = false) {
    const r = await request('GET', '/snapshot');
    if (r.status === 200) { applySnapshot(r.body, force); return true; }
    return false;
  }

  async function loadCasePack() {
    if (role !== 'facilitator' || link.casePack || packLoading) return;
    const generation = credentialGeneration;
    packLoading = true;
    try {
      const r = await request('GET', '/case-pack');
      if (!closed && generation === credentialGeneration && r.status === 200) { link.casePack = r.body; emit('case_pack', r.body); }
    } finally { if (generation === credentialGeneration) packLoading = false; }
  }

  // ─── snapshots and status ──────────────────────────────────────────────────

  function applySnapshot(snap, force = false) {
    if (closed || !snap || snap.t !== 'snapshot') return;
    const cur = link.snapshot;
    if (cur) {
      // A forced refresh may repeat equal state, but an older in-flight HTTP response must
      // never undo a newer broadcast/refetch (notably the epoch after manual recovery).
      const older = snap.epoch < cur.epoch || (snap.epoch === cur.epoch && (snap.revision < cur.revision || (snap.revision === cur.revision && snap.displayRevision < cur.displayRevision)));
      const equal = snap.epoch === cur.epoch && snap.revision === cur.revision && snap.displayRevision === cur.displayRevision;
      if (older || (equal && !force)) return;
    }
    link.snapshot = snap;
    if (snap.view?.you?.id) link.participantId = snap.view.you.id;
    // Once the room has ended, keep the participant's token exactly until its recap expires (CASE-106).
    const recapEnd = role === 'participant' ? Date.parse(snap.view?.recapExpiresAt ?? '') : NaN;
    if (Number.isFinite(recapEnd) && recapEnd !== tokenExpiresAt) { tokenExpiresAt = recapEnd; saveCredential(); }
    emit('snapshot', snap);
  }

  function live() {
    if (!token || halted) return false;
    if (mode === 'ws') return Boolean(socket?.welcomed) && Date.now() - lastWsInbound <= T.DEAD_AFTER_MS;
    return httpLive && Date.now() - lastHttpOk <= T.DEAD_AFTER_MS + T.LONG_POLL_WAIT_S * 1000;
  }
  function evaluate() {
    if (closed) return;
    if (live()) { everOnline = true; setStatus('online'); return; }
    // Lost stays lost until the room is live again. A mode switch after the loss (the offline event drops the socket,
    // the failing sockets fall back to long-poll) must not count an HTTP reply from before the outage as fresh
    // contact: that showed 'connecting' for up to HEARTBEAT_MS and hid the console's recovery card (AS-061).
    if (status === 'lost') return;
    const since = Math.max(lastWsInbound, mode === 'ws' ? 0 : lastHttpOk);
    setStatus(everOnline && Date.now() - since > Math.min(T.DEAD_AFTER_MS, T.HEARTBEAT_MS) ? 'lost' : 'connecting');
  }
  function setStatus(s) { if (s !== status) { status = s; emit('status', s, { mode }); } }
  function setMode(m) {
    if (m === mode) return;
    mode = m;
    emit('status', status, { mode });
    evaluate();
    observe({event:'transport_mode',transport:mode});
  }

  function becameLive(participantId = null) {
    if (participantId) link.participantId = participantId;
    emit('welcome', { v: WIRE_VERSION, t: 'welcome', role, participantId: link.participantId, mode });
    evaluate();
    loadCasePack();
    kickPending();
  }

  function onAuthError(error) {
    if (halted) return;
    halted = true;
    stopChannels();
    if (error === 'unauthorised' && role === 'participant') { if(!credentialFence)dropCredential(); token = null; }
    emit('error', error);
    setStatus(everOnline ? 'lost' : 'connecting');
  }

  // ─── WebSocket ─────────────────────────────────────────────────────────────

  function openSocket({ probe = false } = {}) {
    if (closed || halted || !token || !sessionId || !WebSocketImpl) return;
    if (!probe && socket) return;
    let ws;
    try { ws = new WebSocketImpl(`${wsBase}/sessions/${sessionId}/ws`); } catch { if (!probe) socketFailed(null); return; }
    const s = { ws, welcomed: false, openedAt: Date.now(), welcomedAt: 0, probe, timer: null, syncSentAt: 0, lastSyncAt: 0 };
    if (!probe) socket = s;
    s.timer = setTimeout(() => { if (!s.welcomed) { dropSocket(s); if (!s.probe) socketFailed(s); } }, T.CONNECT_TIMEOUT_MS);
    // Card 57: every role renders slides (schema 3), so clients declare it; older cached clients are refused by slide rooms.
    ws.addEventListener('open', () => {
      const snap = link.snapshot;
      try { ws.send(JSON.stringify({ v: WIRE_VERSION, t: 'hello', supportedSchema: 3, token, lastRevision: snap?.revision ?? 0, lastEpoch: snap?.epoch ?? 0 })); } catch { /* closing */ }
    });
    ws.addEventListener('message', (e) => onSocketFrame(s, e.data));
    const onEnd = () => {
      clearTimeout(s.timer);
      if (s.dropped) return;
      s.dropped = true;
      if (s.probe) return;
      if (socket !== s) return;
      socket = null;
      const shortLived = !s.welcomed || Date.now() - s.welcomedAt < T.WS_SHORT_LIFE_MS;
      if (s.welcomed && !shortLived) wsFailures = 0;
      socketFailed(s, shortLived);
    };
    ws.addEventListener('close', onEnd);
    ws.addEventListener('error', onEnd);
  }

  function dropSocket(s) {
    if (!s || s.dropped) return;
    s.dropped = true;
    clearTimeout(s.timer);
    try { s.ws.close(4000, 'dead'); } catch { /* gone */ }
    if (socket === s) socket = null;
  }

  function socketFailed(s, counts = true) {
    if (closed || halted) return;
    if (counts) wsFailures += 1;
    evaluate();
    if (mode === 'ws' && wsFailures >= T.WS_FAILURES_TO_FALL_BACK) { fallBackTo('long-poll'); return; }
    if (mode !== 'ws') return;
    clearTimeout(reconnectTimer);
    const backoff = Math.min(T.RECONNECT_MAX_MS, T.RECONNECT_BASE_MS * 2 ** Math.max(0, wsFailures - 1));
    reconnectTimer = setTimeout(() => openSocket(), s?.welcomed ? jitter(T.RECONNECT_BASE_MS, 0.5) : jitter(backoff, 0.3));
  }

  function onSocketFrame(s, data) {
    if(!credentialIsCurrent())return;
    if (s.dropped || typeof data !== 'string') return;
    if (s.probe && !s.welcomed) {
      // A probe socket replaces the HTTP fallback only once the server has welcomed it.
      try { if (JSON.parse(data).t !== 'welcome') return; } catch { return; }
      s.probe = false;
      if (socket) dropSocket(socket);
      socket = s;
      wsFailures = 0; lpFailures = 0;
      stopHttp();
      setMode('ws');
    }
    if (socket !== s) return;
    lastWsInbound = Date.now(); // ANY inbound frame is life
    let f;
    try { f = JSON.parse(data); } catch { return; }
    switch (f.t) {
      case 'welcome':
        s.welcomed = true; s.welcomedAt = Date.now(); s.lastSyncAt = s.welcomedAt;
        wsEverWelcomed = true;
        clearTimeout(s.timer);
        becameLive(f.participantId ?? null);
        break;
      case 'snapshot': applySnapshot(f); break;
      case 'sync': {
        // The room answered: the path is alive. A newer revision means a broadcast never arrived.
        s.syncSentAt = 0;
        const cur = link.snapshot;
        if (!cur || f.epoch > cur.epoch || f.revision > cur.revision || f.displayRevision > cur.displayRevision) fetchSnapshot();
        break;
      }
      case 'receipt': {
        const item = pending.get(f.clientEventId);
        if (item) { clearTimeout(item.timer); pending.delete(f.clientEventId); item.resolve(f); }
        emit('receipt', f, item?.body ?? null);
        break;
      }
      case 'error':
        if (f.error === 'client_upgrade_required') { halted = true; stopHttp(); clearTimeout(reconnectTimer); dropSocket(s); emit('error', f.error); break; }
        if (AUTH_ERRORS.has(f.error)) onAuthError(f.error); else emit('error', f.error);
        break;
      default: break; // pong: life only
    }
  }

  // ─── HTTP fallbacks ────────────────────────────────────────────────────────

  function fallBackTo(next) {
    if (closed || halted) return;
    if (socket) dropSocket(socket);
    clearTimeout(reconnectTimer);
    stopHttp();
    httpLive = false;
    setMode(next);
    const gen = ++httpGen;
    if (next === 'long-poll') longPoll(gen); else shortPoll(gen);
    scheduleProbe();
  }

  function stopHttp() { httpGen += 1; httpLive = false; }

  async function longPoll(gen) {
    if (!link.snapshot) await httpStep(gen, () => request('GET', '/snapshot'));
    while (gen === httpGen && !closed && !halted) {
      const s = link.snapshot;
      const q = `?after=${s?.revision ?? 0}&afterDisplay=${s?.displayRevision ?? 0}&wait=${T.LONG_POLL_WAIT_S}`;
      const ok = await httpStep(gen, () => request('GET', `/updates${q}`, undefined, { timeoutMs: T.LONG_POLL_WAIT_S * 1000 + T.REQUEST_TIMEOUT_MS }));
      if (gen !== httpGen) return;
      if (ok) { lpFailures = 0; continue; }
      lpFailures += 1;
      if (lpFailures >= T.LONG_POLL_FAILURES_TO_FALL_BACK) { fallBackTo('poll'); return; }
      await sleep(jitter(T.RECONNECT_BASE_MS * 2 ** lpFailures, 0.3));
    }
  }

  async function shortPoll(gen) {
    while (gen === httpGen && !closed && !halted) {
      await httpStep(gen, () => request('GET', '/snapshot'));
      if (gen !== httpGen) return;
      await sleep(jitter(T.POLL_MS, T.POLL_JITTER));
    }
  }

  /** One HTTP read; true on a usable response. Marks the HTTP channel live and applies any snapshot. */
  async function httpStep(gen, run) {
    const r = await run();
    if (gen !== httpGen) return false;
    // A 200 without a revision (every snapshot and `unchanged` frame has one) came from something in between, not the room.
    if (r.status !== 200 || !(r.body?.revision >= 0)) { evaluate(); return false; }
    const wasLive = httpLive;
    httpLive = true;
    if (r.body?.t === 'snapshot') applySnapshot(r.body);
    if (!wasLive) becameLive(); else evaluate();
    return true;
  }

  /**
   * On a fallback: periodically try the socket again (and, from short polling, long-poll). A pinned
   * network never tries the socket (AS-060); a display tries it only from a healthy long-poll, after
   * DISPLAY_UPGRADE_MS the first time.
   */
  function scheduleProbe() {
    clearTimeout(probeTimer);
    if (closed || halted || mode === 'ws') return;
    if (pinned && mode === 'long-poll') return;
    const delay = mode === 'poll' ? T.LONG_POLL_PROBE_MS : role === 'display' && !wsEverWelcomed ? T.DISPLAY_UPGRADE_MS : T.WS_PROBE_MS;
    probeTimer = setTimeout(() => {
      if (closed || halted || mode === 'ws') return;
      if (mode === 'poll') { if (!pinned) openSocket({ probe: true }); lpFailures = 0; fallBackTo('long-poll'); return; }
      if (role === 'display' && !(httpLive && lpFailures === 0)) { scheduleProbe(); return; }
      openSocket({ probe: true });
      scheduleProbe();
    }, delay);
  }

  /**
   * The heartbeat (or a missing sync answer) found the socket dead. Every such death counts, however
   * long the socket lived: a proxy that stalls sockets at 90 s used to loop forever, because a socket
   * older than WS_SHORT_LIFE_MS never counted (spec red team 2, P1-1). Two in STALL_WINDOW_MS pin
   * this network to long-poll for PIN_MS.
   */
  function socketDied(s) {
    dropSocket(s);
    evaluate();
    const now = Date.now();
    stalls = stalls.filter((t) => now - t < T.STALL_WINDOW_MS);
    stalls.push(now);
    if (stalls.length >= T.STALLS_TO_PIN) {
      pinned = true;
      pinLongPoll(persistentStorage, network(), now + T.PIN_MS, now);
      emit('pinned', { mode: 'long-poll', untilMs: now + T.PIN_MS });
      fallBackTo('long-poll');
      observe({event:'transport_pin',transport:'long-poll'});
      return;
    }
    socketFailed(s, true);
  }

  // ─── lifecycle ─────────────────────────────────────────────────────────────

  function start() {
    if (closed || !token || !sessionId) return;
    halted = false;
    if (mode === 'ws') openSocket();
    else fallBackTo(mode);
  }

  function stopChannels() {
    clearTimeout(reconnectTimer);
    clearTimeout(probeTimer);
    if (socket) dropSocket(socket);
    socket = null;
    stopHttp();
    for (const controller of inflight) controller.abort();
  }

  function adopt(newSessionId, newToken) {
    if (closed || !credentialIsCurrent()) return;
    credentialGeneration += 1; packLoading = false;
    stopChannels();
    if (newSessionId !== sessionId) { link.snapshot = null; link.casePack = null; tokenExpiresAt = null; }
    sessionId = newSessionId; token = newToken;
    saveCredential();
    halted = false; wsFailures = 0; lpFailures = 0; mode = initialMode();
    start();
  }

  /** AS-021: back from the background or the network. */
  async function resync() {
    if (closed || halted || !token || !sessionId) return;
    if (mode === 'ws' && (!socket || Date.now() - lastWsInbound > T.HEARTBEAT_MS)) {
      // iOS keeps a suspended socket OPEN but dead: replace it rather than wait DEAD_AFTER_MS.
      if (socket) dropSocket(socket);
      clearTimeout(reconnectTimer);
      openSocket();
    }
    kickPending();
    const ok = await fetchSnapshot();
    if (ok && mode !== 'ws') { httpLive = true; evaluate(); }
  }

  const onVisible = () => { if (lifecycle.visible()) resync(); };
  // The network changed: failures while offline say nothing about whether sockets are blocked, so
  // start again from the socket (a blocked one falls back again after WS_FAILURES_TO_FALL_BACK).
  const onOnline = () => {
    if (closed || halted || !token || !sessionId) return;
    wsFailures = 0; lpFailures = 0;
    pinned = pinnedToLongPoll(persistentStorage, network()); // the pin is per network
    const want = initialMode();
    if (want === 'ws' && mode !== 'ws') { stopHttp(); clearTimeout(probeTimer); setMode('ws'); }
    else if (want === 'long-poll' && mode !== 'long-poll') fallBackTo('long-poll');
    resync();
  };
  // The browser says the network went away: a socket cannot be trusted, so stop waiting for it.
  const onOffline = () => {
    // Close may be delivered before the browser's offline event. Invalidate old evidence in either order;
    // only a later real server reply may establish life again (a browser hint alone is not authority).
    lastWsInbound = 0; lastHttpOk = 0; httpLive = false;
    if (socket?.welcomed) { dropSocket(socket); socketFailed(null, false); }
    evaluate();
  };
  const removeCredentialFence=credentialFence?.watch(credentialIsCurrent);
  lifecycle.on?.(onVisible, onOnline, onOffline);

  // Heartbeat: the fixed PING frame; a socket with no inbound frame for DEAD_AFTER_MS is dead (AS-022).
  // Every SYNC_MS the room-answered SYNC_FRAME too; no answer within SYNC_TIMEOUT_MS is a dead socket
  // even if the auto-answered pongs still arrive (AS-060).
  const beat = setInterval(() => {
    if (closed) return;
    const s = socket;
    if (mode === 'ws' && s?.welcomed && !s.dropped) {
      const now = Date.now();
      const syncExpired=s.syncSentAt && now-s.syncSentAt > T.SYNC_TIMEOUT_MS;
      if (now - lastWsInbound > T.DEAD_AFTER_MS || syncExpired) {
        if (syncExpired) observe({event:'sync_timeout'});
        socketDied(s);
      }
      else {
        if (now - lastPingAt >= T.HEARTBEAT_MS) {
          lastPingAt = now;
          try { s.ws.send(PING_FRAME); } catch { /* closing */ }
        }
        if (!s.syncSentAt && now - s.lastSyncAt >= T.SYNC_MS) {
          s.syncSentAt = s.lastSyncAt = now;
          try { s.ws.send(SYNC_FRAME); } catch { /* closing */ }
        }
      }
    }
    evaluate();
  }, Math.max(10, Math.floor(Math.min(T.HEARTBEAT_MS, T.SYNC_TIMEOUT_MS) / 2)));
  beat.unref?.();

  observe({event:'transport_mode',transport:mode});
  queueMicrotask(start);
  return link;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

// Fixed metadata is tiny. The private document endpoint admits the published pack
// envelope separately. Successful history-bearing responses remain uncapped here:
// repeated entries materialize surfaces, so the state limit is not a snapshot bound.
const HTTP_METADATA_BYTES = 64 * 1024;
const HTTP_CASE_PACK_BYTES = 8 * 1024 * 1024;
function responseByteLimit(method, url, status) {
  if (status >= 400) return HTTP_METADATA_BYTES;
  const path = new URL(url).pathname;
  if (path.endsWith('/case-pack')) return HTTP_CASE_PACK_BYTES;
  if (method === 'POST' && /\/(?:join|display-pairs|display-pairs\/approve|manual-segment)$/.test(path)
    || method === 'GET' && /\/display-pairs\/[0-9a-f-]+$/i.test(path)) return HTTP_METADATA_BYTES;
  return Infinity;
}

async function httpJson(fetchImpl, method, url, { token = null, body, timeoutMs, inflight = null }) {
  const ctl = new AbortController();
  inflight?.add(ctl);
  let reader = null, terminal = false, abortResult = { status: 0, body: { error: 'network' } };
  const contain = promise => { try { promise?.catch?.(() => {}); } catch { /* cancellation is best effort */ } };
  const cancelReader = () => { try { contain(reader?.cancel()); } catch { /* already closed */ } };
  const cancelBody = response => { try { contain(response.body?.cancel()); } catch { /* locked or closed */ } };
  let settleAbort;
  const aborted = new Promise(resolve => { settleAbort = resolve; });
  const onAbort = () => { terminal = true; cancelReader(); settleAbort(abortResult); };
  ctl.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const tooLarge = response => {
    abortResult = { status: 503, body: { error: 'response_too_large' } };
    if (!reader) cancelBody(response);
    ctl.abort();
    return abortResult;
  };
  const request = (async () => {
    try {
      const res = await fetchImpl(url, {
        method,
        headers: { 'x-case-schema': '3', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal,
        cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
      });
      if (terminal || ctl.signal.aborted) { cancelBody(res); return abortResult; }
      const limit = responseByteLimit(method, url, res.status);
      const declared = res.headers?.get?.('content-length');
      if (Number.isFinite(limit) && declared !== null && declared !== undefined
        && /^\d+$/.test(declared) && Number(declared) > limit) return tooLarge(res);
      let parsed = null;
      try {
        // Only capped responses are streamed for byte counting. Uncapped snapshot/update bodies keep the
        // ordinary parser (browser tooling can inspect them), bounded by the deadline race (CASE-157).
        if (Number.isFinite(limit) && res.body?.getReader) {
          reader = res.body.getReader();
          const decoder = new TextDecoder('utf-8', { fatal: true });
          let text = '', bytes = 0;
          for (;;) {
            if (terminal || ctl.signal.aborted) return abortResult;
            const part = await reader.read();
            if (terminal || ctl.signal.aborted) return abortResult;
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > limit) return tooLarge(res);
            text += decoder.decode(part.value, { stream: true });
          }
          text += decoder.decode();
          parsed = JSON.parse(text);
        } else {
          // Native Response has a stream; the fallback preserves injected test
          // response objects and empty bodies under the same operation deadline.
          parsed = await res.json();
          if (terminal || ctl.signal.aborted) return abortResult;
          if (Number.isFinite(limit) && new TextEncoder().encode(JSON.stringify(parsed)).byteLength > limit) return tooLarge(res);
        }
      } catch {
        cancelReader(); // decoding/read failure must not leave an unread locked tail
        /* retain existing empty/non-JSON response handling */
      }
      if (terminal || ctl.signal.aborted) return abortResult;
      return { status: res.status, body: parsed };
    } catch { return abortResult; }
  })();
  try { return await Promise.race([request, aborted]); }
  finally {
    terminal = true;
    clearTimeout(timer);
    ctl.signal.removeEventListener('abort', onAbort);
    inflight?.delete(ctl);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms, f) => Math.max(1, Math.round(ms * (1 - f + Math.random() * 2 * f)));

function defaultStorage() {
  try { return globalThis.sessionStorage ?? null; } catch { return null; }
}

function defaultPersistentStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/** Browser lifecycle: `visibilitychange` (to visible), `online` and `offline`. A no-op in Node. */
function defaultLifecycle() {
  const doc = globalThis.document;
  const win = typeof globalThis.addEventListener === 'function' ? globalThis : null;
  return {
    visible: () => !doc || doc.visibilityState !== 'hidden',
    on(onVisible, onOnline, onOffline) {
      doc?.addEventListener('visibilitychange', onVisible);
      win?.addEventListener('online', onOnline);
      win?.addEventListener('offline', onOffline);
    },
    off(onVisible, onOnline, onOffline) {
      doc?.removeEventListener('visibilitychange', onVisible);
      win?.removeEventListener('online', onOnline);
      win?.removeEventListener('offline', onOffline);
    },
  };
}

/** A lifecycle source for tests: `fire('visible' | 'hidden' | 'online' | 'offline')`. */
export function testLifecycle() {
  let visible = true;
  const subs = new Set();
  return {
    visible: () => visible,
    on(a, b, c) { subs.add([a, b, c]); },
    off(a) { for (const s of subs) if (s[0] === a) subs.delete(s); },
    fire(ev) {
      if (ev === 'hidden') { visible = false; return; }
      if (ev === 'visible') visible = true;
      for (const [onVisible, onOnline, onOffline] of subs) (ev === 'visible' ? onVisible : ev === 'online' ? onOnline : onOffline)();
    },
  };
}
