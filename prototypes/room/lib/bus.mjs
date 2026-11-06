// prototypes/room/lib/bus.mjs: the client side of the stage C lab network.
//
// Every window (facilitator, display, phone) talks to the simulated Durable Object in the lab
// page (index.html) through one BroadcastChannel. The lab sits in the middle and applies the
// faults chosen in its fault panel (link down, flaky, eviction), so each client experiences a
// real-looking network: it must detect a dead link from missing pongs, re-hello, and retry
// commands with the SAME clientEventId until a receipt arrives (idempotency, CASE-072).
//
//   const link = connect({ role: 'participant', slot: 'A', label: 'Phone A' });
//   link.on('snapshot', (snap) => render(snap.view));      // snapshotBody() from wire.mjs
//   link.on('status', (s) => …);                           // 'connecting' | 'online' | 'lost'
//   const rb = await link.send('vote', { roundId, response });   // receiptBody(), or {receipt:'timeout'}
//   await link.join('7K3QX9', 'Sam');                      // participant only
//   link.on('case_pack', (doc) => …);                      // facilitator only: the full case document
//
// Timings are the wire.mjs constants scaled down so a review session does not wait 25 s.
import { uuidv7 } from '../../../src/shared/ids.mjs';
import { WIRE_VERSION, PING_FRAME, PONG_FRAME } from '../../../src/shared/wire.mjs';

export const LAB = Object.freeze({
  HEARTBEAT_MS: 1500,     // wire HEARTBEAT_MS 10 s, scaled
  DEAD_AFTER_MS: 4500,    // wire DEAD_AFTER_MS 25 s, scaled
  DISPLAY_LOST_MS: 6000,  // separate display: "Connection lost" after 15 s, scaled
  RETRY_MS: 1200,         // command resend interval while no receipt
  MAX_TRIES: 25,
});
export const CHANNEL = 'case-room-lab';
export const LOCAL_CHANNEL = 'case-room-local'; // same-PC facilitator → projector window (HANDOFF §dual display)

/** Commands that carry `expectRevision` when sent from the console (room-machine FENCEABLE). */
const FENCEABLE = new Set(['start', 'advance', 'lock', 'reopen', 'void_round', 'select_path', 'back_to_review', 'reveal', 'reset_checkpoint', 'enter_manual', 'resume_online', 'end']);

export function connect({ role, slot = null, label = role, topology = null }) {
  const clientId = uuidv7();
  const ch = new BroadcastChannel(CHANNEL);
  const handlers = {};
  const emit = (ev, ...a) => (handlers[ev] || []).forEach((fn) => { try { fn(...a); } catch (e) { console.error(e); } });
  const tokenKey = `case-lab:${role}:${slot ?? 'main'}:token`;
  const pending = new Map(); // clientEventId → { raw, resolve, tries, timer }
  const http = new Map();    // reqId → resolve
  let token = role === 'participant' ? safeGet(tokenKey) : null;
  let lastPong = 0;
  let status = 'connecting';
  let welcomed = false;

  const link = {
    clientId, role, slot,
    snapshot: null,
    casePack: null,
    participantId: null,
    get status() { return status; },
    get hasToken() { return Boolean(token); },
    on(ev, fn) { (handlers[ev] ||= []).push(fn); return link; },

    /** Send a command; resolves with the receipt. Retries the identical frame until one arrives. */
    send(type, payload = {}, { fence = role === 'facilitator' } = {}) {
      const snap = link.snapshot;
      const body = { v: WIRE_VERSION, t: 'command', type, epoch: snap?.epoch ?? 0, clientEventId: uuidv7(), ...payload };
      if (fence && FENCEABLE.has(type) && snap && body.expectRevision === undefined) body.expectRevision = snap.revision;
      return link.sendFrame(body);
    },
    /** Lower level: send a prepared command frame (used to resend a held vote with the same id). */
    sendFrame(body) {
      return new Promise((resolve) => {
        const raw = JSON.stringify(body);
        // Resending a held answer (same clientEventId, maybe a new epoch) replaces the old attempt;
        // both callers get the one receipt.
        const prior = pending.get(body.clientEventId);
        if (prior) clearTimeout(prior.timer);
        const item = { raw, resolve: prior ? (r) => { prior.resolve(r); resolve(r); } : resolve, tries: 0, body };
        pending.set(body.clientEventId, item);
        const fire = () => {
          if (!pending.has(body.clientEventId)) return;
          if (item.tries++ >= LAB.MAX_TRIES) { pending.delete(body.clientEventId); return resolve({ receipt: 'timeout', clientEventId: body.clientEventId }); }
          if (welcomed) up(raw);
          item.timer = setTimeout(fire, LAB.RETRY_MS);
        };
        fire();
      });
    },
    /** Abandon every command still retrying (e.g. online commands overtaken by manual mode). */
    dropPending() {
      for (const [id, item] of pending) { clearTimeout(item.timer); item.resolve({ receipt: 'dropped', clientEventId: id }); }
      pending.clear();
    },
    /** Ask for a fresh snapshot (the "refetch the snapshot" steps of the answer lifecycle). */
    refetch() { hello(); },
    /** Commands still waiting for a receipt (for the facilitator recovery tray). */
    get pendingCount() { return pending.size; },

    /** Participant join (an HTTPS POST in production). Stores the capability token; never in a URL. */
    async join(code, displayName, avatarId) {
      const res = await request('join_http', { v: WIRE_VERSION, code, displayName, avatarId });
      if (res.status === 201) {
        token = res.body.token;
        safeSet(tokenKey, token);
        hello();
        return { ok: true, participantId: res.body.participantId };
      }
      return { ok: false, error: res.body?.error ?? `http_${res.status}` };
    },
    /** Manual segment upload on recovery (an HTTPS POST in production). */
    uploadSegment(body) { return request('segment_http', body); },
    /** Forget this phone's token (lab reset). */
    forget() { token = null; safeDel(tokenKey); welcomed = false; link.snapshot = null; },
    close() { ch.postMessage({ k: 'bye', clientId }); ch.close(); clearInterval(beat); },
  };

  function up(raw) { ch.postMessage({ k: 'up', clientId, raw }); }
  function request(t, body) {
    const reqId = uuidv7();
    return new Promise((resolve) => {
      http.set(reqId, resolve);
      let tries = 0;
      const fire = () => {
        if (!http.has(reqId)) return;
        if (tries++ > 8) { http.delete(reqId); return resolve({ status: 0, body: { error: 'network' } }); }
        up(JSON.stringify({ v: WIRE_VERSION, t, reqId, body }));
        setTimeout(fire, LAB.RETRY_MS * 2);
      };
      fire();
    });
  }
  function hello() {
    if (!token) return;
    const s = link.snapshot;
    up(JSON.stringify({ v: WIRE_VERSION, t: 'hello', token, lastRevision: s?.revision ?? 0, lastEpoch: s?.epoch ?? 0 }));
  }
  function setStatus(s) { if (s !== status) { status = s; emit('status', s); } }
  function announce() { ch.postMessage({ k: 'presence', clientId, role, slot, label, topology }); }

  ch.onmessage = ({ data: m }) => {
    if (m?.k === 'lab-hello') { announce(); return; }
    if (m?.k === 'credential' && m.clientId === clientId) { token = m.token; hello(); return; }
    if (m?.k !== 'down' || m.clientId !== clientId) return;
    if (m.raw === PONG_FRAME) {
      lastPong = Date.now();
      if (status === 'lost' || (status === 'connecting' && !welcomed)) { welcomed = false; hello(); }
      if (welcomed) setStatus('online');
      return;
    }
    let f;
    try { f = JSON.parse(m.raw); } catch { return; }
    switch (f.t) {
      case 'welcome':
        welcomed = true;
        link.participantId = f.participantId;
        lastPong = Date.now();
        setStatus('online');
        emit('welcome', f);
        for (const item of pending.values()) up(item.raw); // flush anything queued while offline
        break;
      case 'case_pack':
        link.casePack = f.document;
        emit('case_pack', f.document);
        break;
      case 'snapshot':
        link.snapshot = f;
        emit('snapshot', f);
        break;
      case 'receipt': {
        const item = pending.get(f.clientEventId);
        if (item) { clearTimeout(item.timer); pending.delete(f.clientEventId); item.resolve(f); }
        emit('receipt', f, item?.body ?? null);
        break;
      }
      case 'http': {
        const r = http.get(f.reqId);
        if (r) { http.delete(f.reqId); r({ status: f.status, body: f.body }); }
        break;
      }
      case 'closed': // the DO went away (eviction or redeploy): reconnect
        welcomed = false;
        setStatus('lost');
        break;
      case 'error':
        if (f.error === 'unauthorised' && role === 'participant') { token = null; safeDel(tokenKey); }
        emit('error', f.error);
        break;
    }
  };

  // Application heartbeat: the fixed PING frame; a link with no pong for DEAD_AFTER_MS is dead.
  const beat = setInterval(() => {
    up(PING_FRAME);
    if (welcomed && Date.now() - lastPong > LAB.DEAD_AFTER_MS) setStatus('lost');
    if (!welcomed && status === 'online') setStatus('connecting');
  }, LAB.HEARTBEAT_MS);
  globalThis.addEventListener?.('pagehide', () => ch.postMessage({ k: 'bye', clientId }));

  announce();
  queueMicrotask(() => { up(PING_FRAME); hello(); });
  return link;
}

function safeGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { sessionStorage.setItem(k, v); } catch { /* private mode */ } }
function safeDel(k) { try { sessionStorage.removeItem(k); } catch { /* private mode */ } }
