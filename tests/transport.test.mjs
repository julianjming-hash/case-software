// tests/transport.test.mjs: the client transport (src/client/transport.mjs) against the REAL Worker,
// RoomDO and DirectoryDO in local workerd (`wrangler dev`, tests/helpers/local-worker.mjs). No network,
// no Cloudflare account, no Supabase (AGENTS.md hard rule 12).
//
// Faults are injected between the client and the Worker by `Net`: it wraps fetch and WebSocket the way
// a bad network would (down, WebSockets blocked, one path blocked, a socket that stays OPEN but goes
// silent, a response lost after the server applied the request). The server is never steered except by
// the facilitator's own commands; assertions read its state through the facilitator snapshot's mirror.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect, requestDisplayPair, testLifecycle, PIN_KEY, credentialKey, storedCredential, TIMINGS, scaledTimings } from '../src/client/transport.mjs';
import { PONG_FRAME } from '../src/shared/wire.mjs';
import { AVATAR_IDS } from '../src/shared/participant.mjs';
import { startLocalWorker, createRoom, serverMirror, FIXTURE } from './helpers/local-worker.mjs';

const SCALE = 0.1; // HEARTBEAT 1 s, DEAD_AFTER 2.5 s, long-poll wait 3 s, retry 200 ms
let worker;
const links = [];

before(async () => { worker = await startLocalWorker(); });
after(async () => {
  for (const l of links) l.close();
  await worker?.stop();
});

/** A network between one or more clients and the Worker, with faults. */
class Net {
  constructor() {
    this.down = false;        // nothing gets through; open sockets go silent both ways
    this.wsBlocked = false;   // new sockets fail (a proxy that drops the upgrade)
    this.blockPaths = [];     // fetches whose URL contains one of these fail
    this.loseResponses = 0;   // the next N command POSTs reach the server but their responses are lost
    this.afterLostResponse = null;
    this.urls = [];           // every URL a client opened (fetch and WebSocket)
    this.posts = [];          // every command envelope POSTed
    this.sockets = new Set();
    this.stallAfterMs = 0;    // every socket goes silent this long after it opens (a proxy that stalls at 90 s)
    this.onlyPongs = false;   // sockets pass the auto-answered pong but nothing the room itself sends
    this.dropSnapshots = false; // sockets lose snapshot frames but pass everything else (a missed broadcast)
    this.opened = 0;          // sockets opened so far
    this.fetch = async (url, init = {}) => {
      url = String(url);
      this.urls.push(url);
      if (this.down) throw new TypeError('fetch failed: network down');
      if (this.blockPaths.some((p) => url.includes(p))) throw new TypeError('fetch failed: blocked');
      const isCommand = init.method === 'POST' && url.endsWith('/commands');
      if (isCommand) this.posts.push(JSON.parse(init.body));
      const res = await fetch(url, init);
      if (isCommand && this.loseResponses > 0) {
        this.loseResponses -= 1;
        await res.arrayBuffer();
        this.afterLostResponse?.();
        throw new TypeError('fetch failed: response lost');
      }
      return res;
    };
    const net = this;
    this.WebSocket = class FaultySocket extends EventTarget {
      constructor(url) {
        super();
        net.urls.push(url);
        this.silent = false;
        if (net.down || net.wsBlocked) {
          this.ws = null;
          setTimeout(() => { this.dispatchEvent(new Event('error')); this.dispatchEvent(new Event('close')); }, 5);
          return;
        }
        const ws = this.ws = new WebSocket(url);
        net.sockets.add(this);
        net.opened += 1;
        ws.addEventListener('open', () => {
          if (net.stallAfterMs) setTimeout(() => { this.silent = true; }, net.stallAfterMs);
          this.dispatchEvent(new Event('open'));
        });
        ws.addEventListener('message', (e) => {
          if (this.silent || net.down) return;
          const t = e.data === PONG_FRAME ? 'pong' : (() => { try { return JSON.parse(e.data).t; } catch { return null; } })();
          if (net.onlyPongs && t !== 'pong' && t !== 'welcome') return;
          if (net.dropSnapshots && t === 'snapshot') return;
          this.dispatchEvent(new MessageEvent('message', { data: e.data }));
        });
        ws.addEventListener('close', () => { net.sockets.delete(this); this.dispatchEvent(new Event('close')); });
        ws.addEventListener('error', () => this.dispatchEvent(new Event('error')));
      }
      get readyState() { return this.ws ? this.ws.readyState : 3; }
      send(d) { if (!this.silent && !net.down) try { this.ws.send(d); } catch { /* closing */ } }
      close(code, reason) { try { this.ws?.close(code, reason); } catch { /* gone */ } }
    };
  }
  /** Every open socket stays OPEN but nothing passes either way (an iOS-style zombie). */
  silenceSockets() { const s = [...this.sockets]; s.forEach((x) => { x.silent = true; }); return s; }
  /** Close every open socket at once (a reconnect storm). */
  killSockets() { for (const s of [...this.sockets]) s.close(4002, 'storm'); }
}

function open(opts) {
  const net = opts.net ?? new Net();
  const link = connect({ api: worker.origin, timeScale: SCALE, fetchImpl: net.fetch, WebSocketImpl: net.WebSocket, ...opts });
  links.push(link);
  return link;
}
/** Web storage in memory (localStorage stand-in for Node). */
class MemoryStorage {
  constructor() { this.map = new Map(); }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

const facilitatorOf = (room, o = {}) => Object.assign(open({ role: 'facilitator', sessionId: room.sessionId, token: room.facilitatorToken, ...o }), { room });
async function phoneIn(room, slot, o = {}) {
  const link = open({ role: 'participant', slot, ...o });
  const r = await link.join(room.joinCode, `Phone ${slot}`, AVATAR_IDS[0]);
  assert.equal(r.ok, true, `join ${slot}: ${r.error}`);
  return link;
}

/** Poll a condition (never a fixed sleep as the assertion itself). */
async function until(fn, message, timeoutMs = 15_000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out: ${message}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const mirror = (room) => serverMirror(worker.origin, room);
const ok = (rb) => ['accepted', 'already_accepted'].includes(rb.receipt);
async function facCmd(fac, type, payload) {
  const rb = await fac.send(type, payload);
  assert.ok(ok(rb), `${type}: ${rb.receipt} ${rb.reason ?? ''}`);
  // Like the console, act on the next snapshot, not just the receipt (the next command is fenced).
  await until(() => fac.snapshot && fac.snapshot.revision >= rb.revision && fac.snapshot.epoch >= rb.epoch, `${type} snapshot`);
  return rb;
}
/** Reveal the fixture's authored opening and decision context, then explicitly open responses. */
async function openDecision(fac) {
  await until(() => fac.status === 'online' && fac.snapshot, 'facilitator online');
  // Joins bump the revision and reach the console on a coalesced broadcast: like a person at the
  // console, act only once it shows the room as it is now, or `start` is fenced as stale.
  await until(async () => fac.snapshot.revision === (await mirror(fac.room)).revision, 'facilitator caught up');
  await facCmd(fac, 'start');
  assert.equal(fac.snapshot.view.presentation.shown, 1);
  assert.equal(fac.snapshot.view.presentation.total, 2, 'the opening finding is still withheld');
  assert.equal(fac.snapshot.view.round, null, 'starting the room does not open voting');
  await facCmd(fac, 'advance'); // Reveal the opening finding.
  assert.equal(fac.snapshot.view.presentation.shown, 2);
  await facCmd(fac, 'advance'); // Enter the authored decision with its scene only.
  assert.equal(fac.snapshot.view.presentation.shown, 1);
  assert.equal(fac.snapshot.view.presentation.total, 3);
  assert.equal(fac.snapshot.view.round, null, 'entering a decision does not open voting');
  await facCmd(fac, 'advance'); // Reveal observations.
  assert.equal(fac.snapshot.view.presentation.shown, 2);
  assert.equal(fac.snapshot.view.round, null);
  await facCmd(fac, 'advance'); // Reveal findings.
  assert.equal(fac.snapshot.view.presentation.shown, 3);
  assert.equal(fac.snapshot.view.round, null, 'the final context reveal is separate from opening');
  await facCmd(fac, 'advance'); // Open responses as a distinct facilitator action.
  assert.ok(fac.snapshot.view.round?.id);
}
const voteFor = (link, i = 0) => {
  const d = link.snapshot.view.decision;
  return { roundId: d.roundId, response: { option_id: d.interaction.options[i].id } };
};
const caughtUp = async (link, room) => link.snapshot && link.snapshot.revision === (await mirror(room)).revision;

test('WebSocket happy path: welcome, snapshots, case pack, receipts over HTTPS, and no token in any URL', async () => {
  const room = await createRoom(worker.origin);
  const net = new Net();
  const fac = facilitatorOf(room, { net });
  const phone = await phoneIn(room, 'A', { net });
  await until(() => fac.casePack && phone.status === 'online', 'console has the case pack, phone online');
  assert.equal(fac.mode, 'ws');
  assert.equal(phone.mode, 'ws');
  assert.equal(fac.casePack.title, FIXTURE.title);
  assert.ok(fac.snapshot.mirror, 'the facilitator snapshot carries the mirror (CASE-092)');
  assert.equal(phone.snapshot.mirror, undefined, 'never to a phone');

  await openDecision(fac);
  await until(() => phone.snapshot?.view.decision?.roundId, 'decision reaches the phone over the socket');
  const rb = await phone.send('vote', voteFor(phone, 2));
  assert.equal(rb.receipt, 'accepted');
  const s = await mirror(room);
  assert.equal(Object.keys(s.round.responses).length, 1);
  // Facilitator commands are fenced with expectRevision, as on the lab bus.
  assert.ok(net.posts.filter((p) => p.type === 'advance').every((p) => Number.isInteger(p.expectRevision)));
  // Tokens travel only in headers or the first socket frame.
  assert.ok(net.urls.length > 0);
  for (const u of net.urls) {
    assert.ok(!u.includes(room.facilitatorToken), `token in URL ${u}`);
    assert.ok(!/token|secret|bearer/i.test(new URL(u).search), `credential-shaped query in ${u}`);
  }
  fac.close(); phone.close();
});

test('[AS-023] WebSockets blocked: the phone falls back to long-poll, then short polling, and votes still get receipts', async () => {
  const room = await createRoom(worker.origin);
  const fac = facilitatorOf(room);
  const net = new Net();
  net.wsBlocked = true;
  const modes = [];
  const phone = await phoneIn(room, 'A', { net, timings: { WS_PROBE_MS: 600_000, LONG_POLL_PROBE_MS: 600_000 } });
  phone.on('status', (_s, d) => modes.push(d.mode));
  await until(() => phone.mode === 'long-poll' && phone.status === 'online', 'long-poll after the socket failed to open');

  await openDecision(fac);
  await until(() => phone.snapshot?.view.decision?.roundId, 'the open decision arrives by long-poll');
  let rb = await phone.send('vote', voteFor(phone, 0));
  assert.equal(rb.receipt, 'accepted', 'a vote over HTTPS gets its receipt');

  // Long-poll blocked too (a proxy that kills held requests): short polling with jitter.
  net.blockPaths = ['/updates'];
  await until(() => phone.mode === 'poll' && phone.status === 'online', 'short polling after long-poll failed');
  const changed = voteFor(phone, 2);
  rb = await phone.send('vote', changed);
  assert.equal(rb.receipt, 'accepted', 'changing the answer still gets a receipt');
  await until(() => caughtUp(fac, room), 'console sees the changed answer');
  await facCmd(fac, 'lock');
  await until(async () => phone.snapshot.view.decision?.status === 'locked' && caughtUp(phone, room), 'the lock arrives by short poll');
  const s = await mirror(room);
  const [resp] = Object.values(s.round.responses);
  assert.equal(resp.response.option_id, changed.response.option_id);
  assert.ok(modes.includes('long-poll') && modes.includes('poll'));
  assert.ok(net.urls.some((u) => u.includes('/updates?after=')), 'long-poll was used');
  fac.close(); phone.close();
});

test('[AS-022] a socket that reports OPEN but is silent is declared dead within DEAD_AFTER_MS and replaced', async () => {
  const room = await createRoom(worker.origin);
  const fac = facilitatorOf(room);
  const net = new Net();
  const phone = await phoneIn(room, 'A', { net });
  await until(() => phone.status === 'online' && phone.mode === 'ws', 'phone on the socket');
  const statuses = [];
  phone.on('status', (s) => statuses.push(s));

  const [zombie] = net.silenceSockets();
  const t0 = Date.now();
  await openDecision(fac); // the room moves on; the zombie socket delivers none of it
  assert.equal(zombie.ws.readyState, 1, 'the silent socket still reports OPEN');
  await until(() => statuses.includes('lost'), 'declared dead');
  const detectedMs = Date.now() - t0;
  assert.ok(detectedMs <= 2500 + 1000 + 500, `detected in ${detectedMs} ms (DEAD_AFTER 2.5 s + one heartbeat tick)`);
  await until(async () => phone.status === 'online' && (await caughtUp(phone, room)), 'recovered on a fresh socket at the latest revision');
  assert.equal(phone.mode, 'ws');
  assert.ok(phone.snapshot.view.decision?.roundId, 'the decision opened while the socket was silent is now shown');
  const rb = await phone.send('vote', voteFor(phone, 1));
  assert.equal(rb.receipt, 'accepted');
  fac.close(); phone.close();
});

test('[AS-021] background and resume: the phone resyncs to the latest revision and replays its pending vote with the same id', async () => {
  const room = await createRoom(worker.origin);
  const fac = facilitatorOf(room);
  const net = new Net();
  const life = testLifecycle();
  // Real timings here: the resync must come from the lifecycle event, not the 25 s dead-socket detector.
  const phone = await phoneIn(room, 'A', { net, lifecycle: life, timeScale: 1 });
  await openDecision(fac);
  await until(() => phone.snapshot?.view.decision?.roundId && phone.status === 'online', 'decision on the phone');

  // The vote reaches the server, then the phone is backgrounded before the response arrives.
  net.loseResponses = 1;
  net.afterLostResponse = () => { net.down = true; life.fire('hidden'); };
  const receipt = phone.send('vote', voteFor(phone, 2));
  await until(() => net.down, 'backgrounded mid-request');
  assert.equal(phone.pendingCount, 1, 'no receipt yet, so the phone has not claimed success');
  await until(async () => Object.keys((await mirror(room)).round.responses).length === 1, 'the server applied the vote');

  // While backgrounded the room moves on, and the phone misses the broadcast.
  await facCmd(fac, 'show_names', { on: true });
  const moved = await mirror(room);
  assert.ok(phone.snapshot.revision < moved.revision, 'the phone is behind');

  await new Promise((r) => setTimeout(r, 1500));
  net.down = false;
  const t0 = Date.now();
  life.fire('visible');
  await until(() => caughtUp(phone, room), 'resynced after visibilitychange');
  const resyncMs = Date.now() - t0;
  assert.ok(resyncMs < 2000, `resync took ${resyncMs} ms: driven by the lifecycle event, not the 25 s detector`);
  const rb = await receipt;
  assert.equal(rb.receipt, 'already_accepted', 'the replay with the same clientEventId was recognised');
  const votes = net.posts.filter((p) => p.type === 'vote');
  assert.ok(votes.length >= 2, 'the vote was sent again');
  assert.equal(new Set(votes.map((p) => p.clientEventId)).size, 1, 'every attempt carried the same clientEventId');
  const s = await mirror(room);
  assert.equal(Object.keys(s.round.responses).length, 1, 'recorded once');
  assert.equal(phone.pendingCount, 0);
  fac.close(); phone.close();
});

test('[AS-025] a display pairs by number match, re-pairs after a restart, and gets the latest public snapshot', async () => {
  const room = await createRoom(worker.origin);
  const fac = facilitatorOf(room);
  await until(() => fac.status === 'online', 'console online');
  const pairAndConnect = async () => {
    const pair = await requestDisplayPair({ api: worker.origin });
    assert.match(pair.code, /^[0-9A-HJKMNP-TV-Z]{8}$/);
    assert.deepEqual(await pair.poll(), { pending: true });
    assert.deepEqual(await fac.approveDisplay(pair.code), { ok: true });
    const cred = await pair.poll();
    assert.equal(cred.sessionId, room.sessionId);
    assert.ok(cred.token.length > 20);
    assert.ok((await pair.poll()).error, 'a pairing is single use');
    return open({ role: 'display', sessionId: cred.sessionId, token: cred.token });
  };
  assert.equal((await fac.approveDisplay('ZZZZZZZZ')).ok, false, 'an unknown code is refused');

  const first = await pairAndConnect();
  await until(() => first.status === 'online' && first.snapshot, 'first display online');
  await openDecision(fac);
  await until(() => caughtUp(first, room), 'first display follows the room');
  const firstView=JSON.stringify(first.snapshot.view);
  first.close(); // the projector PC restarts

  await facCmd(fac, 'lock'); // the room moves on while no display is connected
  const second = await pairAndConnect();
  await until(() => second.snapshot, 'second display has a snapshot');
  const s = await mirror(room);
  assert.equal(second.snapshot.revision, s.revision, 'the first snapshot is the latest revision');
  assert.equal(second.snapshot.displayRevision, s.displayRevision);
  assert.equal(second.snapshot.mirror, undefined, 'a display never gets the mirror');
  const text = JSON.stringify(second.snapshot);
  for (const surface of FIXTURE.surfaces) if (surface.notes) assert.ok(!text.includes(surface.notes.slice(0, 40)), 'no facilitator notes on the display');
  assert.notEqual(JSON.stringify(second.snapshot.view), firstView, 'the re-paired display shows the locked state, not the stale one');
  fac.close(); second.close();
});

test('[AS-026] 50 phones reconnecting together converge on the same snapshot with no stall', async (t) => {
  const room = await createRoom(worker.origin);
  const fac = facilitatorOf(room);
  const net = new Net();
  // Fifty simultaneous command receipts keep the bounded production HTTP deadline.
  // Socket/retry timings still use SCALE; no reconnect or receipt assertion is relaxed.
  const phoneOptions = { net, timings: { REQUEST_TIMEOUT_MS: TIMINGS.REQUEST_TIMEOUT_MS } };
  assert.equal(scaledTimings(SCALE, phoneOptions.timings).REQUEST_TIMEOUT_MS, 10_000, 'AS-026 keeps the bounded production HTTP deadline');
  // Joining is fixture setup; the measured reconnect storm below still drops all 50 sockets together.
  const phones = [];
  for (let i = 0; i < 50; i++) phones.push(await phoneIn(room, `P${i}`, phoneOptions));
  await until(() => phones.every((p) => p.status === 'online' && p.mode === 'ws'), 'all 50 on sockets', 30_000);
  assert.equal(Object.keys((await mirror(room)).participants).length, 50);

  // Every socket drops at once while the room moves on.
  const rewelcomed = new Map();
  phones.forEach((p, i) => p.on('welcome', () => { if (!rewelcomed.has(i)) rewelcomed.set(i, Date.now() - t0); }));
  const t0 = Date.now();
  net.killSockets();
  await openDecision(fac);
  const converged = new Map();
  await until(async () => {
    const rev = (await mirror(room)).revision;
    for (const [i, p] of phones.entries()) if (!converged.has(i) && p.status === 'online' && p.snapshot?.revision === rev) converged.set(i, Date.now() - t0);
    return converged.size === phones.length;
  }, `all 50 converged (${converged.size} so far)`, 20_000);
  assert.equal(rewelcomed.size, 50, `every phone really reconnected (a new socket was welcomed): ${rewelcomed.size}, sockets ${net.sockets.size}, modes ${[...new Set(phones.map((p) => p.mode))]}`);
  const back = [...rewelcomed.values()].sort((a, b) => a - b);
  const conv = [...converged.values()].sort((a, b) => a - b);
  t.diagnostic(`re-welcomed ms after the drop: p50 ${back[24]}, p95 ${back[47]}, max ${back[49]}; converged by ${conv[49]} ms`);
  assert.ok(back[49] < 5000, `slowest reconnect ${back[49]} ms`);
  const views = new Set(phones.map((p) => JSON.stringify({ ...p.snapshot.view, you: undefined, recap: undefined })));
  assert.equal(views.size, 1, 'every phone sees the same room');

  // No stall: all 50 vote together and each gets a receipt; the console sees all 50.
  const receipts = await Promise.all(phones.map((p, i) => p.send('vote', voteFor(p, i % 4))));
  assert.ok(receipts.every((r) => r.receipt === 'accepted'), JSON.stringify(receipts.filter((r) => r.receipt !== 'accepted').slice(0, 3)));
  await until(() => fac.snapshot?.mirror?.round && Object.keys(fac.snapshot.mirror.round.responses).length === 50, 'console sees 50 answers');
  await until(() => caughtUp(fac, room), 'console caught up');
  await facCmd(fac, 'lock');
  await until(() => phones.every((p) => p.snapshot.view.decision?.status === 'locked'), 'all 50 see the lock');
  fac.close();
  for (const p of phones) p.close();
});

test('[AS-060] a socket that opens then stalls at 90 s is counted every time; two stalls pin this network to long-poll for a day', async () => {
  const room = await createRoom(worker.origin);
  const fac = facilitatorOf(room);
  const net = new Net();
  net.stallAfterMs = 4_000; // at ×0.1 this is 40 s: longer than WS_SHORT_LIFE_MS (6 s), which never counted before
  const local = new MemoryStorage();
  const timings = { WS_PROBE_MS: 1_500 }; // probe often, so a probe that should not happen would show
  const phone = await phoneIn(room, 'A', { net, persistentStorage: local, timings });
  const pinned = new Promise((r) => phone.on('pinned', r));
  await until(() => phone.status === 'online' && phone.mode === 'ws', 'phone on the socket');
  await pinned;
  await until(() => phone.mode === 'long-poll' && phone.status === 'online', 'pinned to long-poll and online', 20_000);
  assert.equal(phone.pinned, true);
  assert.equal(net.opened, 2, 'exactly two sockets: one per stall, then no more');
  const pins = JSON.parse(local.getItem(PIN_KEY));
  assert.deepEqual(Object.keys(pins), ['default'], 'one pin, keyed by network only');
  assert.ok(pins.default > Date.now() + 23 * 3_600_000, 'the pin lasts about a day');
  for (const secret of [room.sessionId, phone.snapshot.view.you.id, storedCredential('participant', 'A', local).token]) {
    assert.ok(!local.getItem(PIN_KEY).includes(secret), 'the pin carries no room, participant or token');
  }

  // Pinned: no socket probes, yet the room still reaches the phone and votes get receipts.
  await openDecision(fac);
  await until(() => phone.snapshot?.view.decision?.roundId, 'the decision arrives by long-poll');
  assert.equal((await phone.send('vote', voteFor(phone, 1))).receipt, 'accepted');
  await new Promise((r) => setTimeout(r, timings.WS_PROBE_MS * 3));
  assert.equal(net.opened, 2, 'no socket probe while pinned');

  // The pin is remembered: a new page on the same network starts on long-poll and never opens a socket.
  net.stallAfterMs = 0;
  const again = open({ role: 'participant', slot: 'A', net, persistentStorage: local, timings });
  await until(() => again.status === 'online' && again.snapshot, 'the reopened phone is back in the room from its stored token');
  assert.equal(again.mode, 'long-poll');
  assert.equal(net.opened, 2);
  fac.close(); phone.close(); again.close();
});

test('[AS-022] the room-answered sync frame: a socket whose pongs still arrive but whose room never answers is dead; a missed broadcast is refetched', async () => {
  const room = await createRoom(worker.origin);
  const fac = facilitatorOf(room);
  const net = new Net();
  const timings = { SYNC_MS: 1_000, SYNC_TIMEOUT_MS: 800 };
  const phone = await phoneIn(room, 'A', { net, timings, persistentStorage: new MemoryStorage() });
  await until(() => phone.status === 'online' && phone.mode === 'ws', 'phone on the socket');

  // A broadcast is lost on the way, but the sync answer says the room moved: the phone refetches.
  net.dropSnapshots = true;
  await openDecision(fac);
  await until(() => caughtUp(phone, room), 'caught up through the sync answer, not a broadcast');
  assert.ok(net.urls.some((u) => u.endsWith('/snapshot')), 'the snapshot was refetched over HTTPS');
  net.dropSnapshots = false;

  // Pongs flow (the runtime answers them), but the room never answers the sync: the socket is dead.
  const before = net.opened;
  net.onlyPongs = true;
  await until(() => net.opened > before, 'replaced after an unanswered sync, though pongs kept arriving', 8_000);
  net.onlyPongs = false;
  await until(() => phone.status === 'online' && phone.mode === 'ws', 'back on a fresh socket');
  fac.close(); phone.close();
});

test('[AS-017] a participant token outlives the browser until its recap expires, then is purged on load; the facilitator token is never stored', async () => {
  const room = await createRoom(worker.origin);
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  const fac = facilitatorOf(room, { storage: session, persistentStorage: local });
  const phone = await phoneIn(room, 'A', { persistentStorage: local, storage: session });
  await until(() => fac.status === 'online' && phone.status === 'online', 'online');
  const stored = storedCredential('participant', 'A', local);
  assert.equal(stored.sessionId, room.sessionId);
  assert.ok(stored.expiresAt > Date.now() + 47 * 3_600_000, 'kept up to room life + recap until the room ends');
  assert.equal(session.length, 0, 'nothing in sessionStorage');
  assert.ok(![...local.map.values(), ...session.map.values()].join('').includes(room.facilitatorToken), 'the facilitator token is memory only');
  await facCmd(fac, 'end');
  await until(() => phone.snapshot?.view.phase === 'ended', 'the phone sees the end');
  const recapEnd = Date.parse(phone.snapshot.view.recapExpiresAt);
  await until(() => storedCredential('participant', 'A', local)?.expiresAt === recapEnd, 'the stored expiry is the recap expiry');
  phone.close();
  // The browser was closed and reopened: the recap is still there.
  const reopened = open({ role: 'participant', slot: 'A', persistentStorage: local });
  await until(() => reopened.snapshot?.view.recap, 'the recap reopens from the stored token');
  reopened.close();
  // Past its expiry the entry is purged on load, and a new page starts signed out.
  local.setItem(credentialKey('participant', 'A'), JSON.stringify({ ...storedCredential('participant', 'A', local), expiresAt: Date.now() - 1 }));
  const later = open({ role: 'participant', slot: 'A', persistentStorage: local });
  assert.equal(later.hasToken, false);
  assert.equal(local.getItem(credentialKey('participant', 'A')), null);
  later.close(); fac.close();
});


test('[AS-096] a lost accepted join response retries one participant without merging distinct same-name joins', async () => {
  const room = await createRoom(worker.origin);
  const net = new Net();
  const observations = [];
  let dropped = false;
  const joinFetch = async (url, init = {}) => {
    const response = await net.fetch(url, init);
    if (init.method !== 'POST' || new URL(String(url)).pathname !== '/api/v1/join') return response;
    // Local-only controlled loss after the actual Worker accepted and issued a credential.
    const body = await response.clone().json();
    observations.push({ status: response.status, body });
    if (!dropped && response.status === 201) {
      dropped = true;
      await response.arrayBuffer();
      throw new TypeError('controlled_join_response_loss');
    }
    return response;
  };
  const phone = open({ role: 'participant', slot: 'join-loss', net, fetchImpl: joinFetch,
    persistentStorage: new MemoryStorage() });
  const joined = await phone.join(room.joinCode, 'Same Name', AVATAR_IDS[0]);
  assert.equal(joined.ok, true, 'the same logical join must recover its accepted response');
  assert.equal(dropped, true, 'the controlled first accepted response must actually be lost');
  assert.equal(observations.length, 2, 'the existing join retry must make exactly two controlled attempts');
  assert.equal(observations.every(row => row.status === 201), true, 'both controlled attempts reached an accepting Worker');
  const state = await mirror(room);
  assert.equal(Object.keys(state.participants).length, 1, 'a retried accepted join must allocate exactly one participant');
  assert.equal(joined.participantId === observations[0].body.participantId, true, 'retry must recover the original participant identity');
  assert.equal(observations[0].body.token === observations[1].body.token, true, 'retry must recover the same private capability');
  assert.equal(net.urls.every(url => observations.every(row => !url.includes(row.body.token))), true, 'join capabilities must never enter URLs');
  const other = open({ role: 'participant', slot: 'join-distinct', persistentStorage: new MemoryStorage() });
  const distinct = await other.join(room.joinCode, 'Same Name', AVATAR_IDS[0]);
  assert.equal(distinct.ok, true, 'an independent same-name join remains legal');
  assert.equal(distinct.participantId !== joined.participantId, true, 'names and avatars must never become an identity key');
  assert.equal(Object.keys((await mirror(room)).participants).length, 2, 'two independent joins must remain two participants');
});

test('[AS-170] a broadcast\'s shared phone timeline: phones on a socket and on long-poll get exactly what GET /snapshot gives them', async () => {
  const room = await createRoom(worker.origin);
  const fac = facilitatorOf(room);
  const lpNet = new Net();
  lpNet.wsBlocked = true;
  const phones = [
    await phoneIn(room, 'A'), await phoneIn(room, 'B'),
    await phoneIn(room, 'C', { net: lpNet, timings: { WS_PROBE_MS: 600_000, LONG_POLL_PROBE_MS: 600_000 } }),
  ];
  // Snapshots that arrived by broadcast or long-poll (the shared-timeline path), not by this test's own refetch.
  const pushed = phones.map(() => new Map());
  let refetching = false;
  phones.forEach((p, i) => p.on('snapshot', (snap) => { if (!refetching) pushed[i].set(snap.revision, structuredClone(snap.view)); }));
  await until(() => phones.every((p) => p.status === 'online') && phones[2].mode === 'long-poll' && phones[0].mode === 'ws', 'phones online');
  let compared = 0;
  const check = async (label) => {
    const rev = (await mirror(room)).revision;
    await until(() => phones.every((p) => p.snapshot?.revision === rev), `${label}: phones caught up`);
    for (const [i, p] of phones.entries()) {
      const got = pushed[i].get(rev);
      if (!got) continue; // this revision reached the phone only through its own earlier fetch
      refetching = true;
      try { assert.equal(await p.refetch(), true); } finally { refetching = false; }
      if (p.snapshot.revision !== rev) continue; // the room moved meanwhile; the next step compares again
      assert.deepEqual(got, p.snapshot.view, `${label}: phone ${i} broadcast equals its own GET /snapshot`);
      compared++;
    }
  };
  await openDecision(fac);
  await check('decision open');
  for (const [i, p] of phones.entries()) assert.equal((await p.send('vote', voteFor(p, i % 2))).receipt, 'accepted');
  await until(() => caughtUp(fac, room), 'votes reach the console');
  await facCmd(fac, 'lock');
  await check('locked');
  const path = fac.snapshot.view.decision.paths.find((x) => x.recommended) ?? fac.snapshot.view.decision.paths[0];
  await facCmd(fac, 'select_path', { pathId: path.id });
  await facCmd(fac, 'show_results', { on: false });
  await facCmd(fac, 'reveal');
  await check('consequence revealed');
  assert.ok(phones.every((p) => p.snapshot.view.timeline.length >= 3), 'the phones hold a multi-entry timeline');
  await facCmd(fac, 'advance');
  await check('next step');
  await facCmd(fac, 'end');
  await check('recap');
  assert.ok(phones[0].snapshot.view.recap, 'the recap was compared');
  assert.ok(compared >= 8, `pushed snapshots were compared (${compared})`);
  assert.ok(pushed[2].size >= 4, 'the long-poll phone received pushed snapshots');
  fac.close(); for (const p of phones) p.close();
});
