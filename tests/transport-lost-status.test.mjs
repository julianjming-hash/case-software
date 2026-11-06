// A link already declared lost stays lost until the room is live again (AS-061). The browser's offline event
// declares the socket dead at once; the sockets that then fail send the transport to long-poll, and that mode switch
// must not count an HTTP reply from before the outage as fresh contact. It did: the status went back to 'connecting'
// for up to HEARTBEAT_MS with nothing reaching the room, and the console hid its recovery card (and the armed
// "Press again: manual room" in it) for those seconds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { connect, testLifecycle } from '../src/client/transport.mjs';
import { uuidv7, newCapabilityToken } from '../src/shared/ids.mjs';
import { PING_FRAME, PONG_FRAME } from '../src/shared/wire.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const net = { down: false };
class Socket {
  listeners = new Map();
  constructor() {
    Socket.latest=this;
    if (net.down) setTimeout(() => { this.fire('error'); this.fire('close'); }, 5);
    else queueMicrotask(() => this.fire('open'));
  }
  addEventListener(kind, fn) { this.listeners.set(kind, [...(this.listeners.get(kind) ?? []), fn]); }
  fire(kind, data) { for (const fn of this.listeners.get(kind) ?? []) fn({ data }); }
  send(text) {
    if (net.down) return;
    if (text === PING_FRAME) queueMicrotask(() => this.fire('message', PONG_FRAME));
    else if (JSON.parse(text).t === 'hello') queueMicrotask(() => this.fire('message', JSON.stringify({ v: 1, t: 'welcome' })));
  }
  close() { this.fire('close'); }
}

for(const closedFirst of [false,true]) test(`[AS-061] offline invalidates pre-outage evidence; close-first=${closedFirst}`, { timeout: 5000 }, async () => {
  const lifecycle = testLifecycle();
  const fetchImpl = async () => {
    if (net.down) throw new TypeError('fetch failed: offline');
    return Response.json({ v: 1, t: 'snapshot', epoch: 0, revision: 1, displayRevision: 1, view: {} });
  };
  const link = connect({ role: 'participant', api: 'https://case.test', sessionId: uuidv7(), token: newCapabilityToken(),
    storage: null, persistentStorage: null, lifecycle, WebSocketImpl: Socket, fetchImpl, telemetryImpl: () => {},
    // A heartbeat long enough that an HTTP reply from just before the outage is still inside its grace when the
    // transport switches to long-poll, as with the real 10 s heartbeat.
    timings: { HEARTBEAT_MS: 1000, DEAD_AFTER_MS: 2500, RECONNECT_BASE_MS: 10, RECONNECT_MAX_MS: 10, WS_FAILURES_TO_FALL_BACK: 2,
      LONG_POLL_WAIT_S: 0.05, POLL_MS: 50, LONG_POLL_PROBE_MS: 60_000, WS_PROBE_MS: 60_000 } });
  const after = [];
  try {
    const live = Date.now() + 1000;
    while (link.status !== 'online' && Date.now() < live) await sleep(5);
    assert.equal(link.status, 'online');
    assert.equal(link.mode, 'ws');
    assert.equal(await link.refetch(), true, 'an HTTP reply from the room just before the outage');

    net.down = true;
    if(closedFirst)Socket.latest.close();
    link.on('status', status => after.push(status));
    lifecycle.fire('offline');
    assert.equal(link.status, 'lost', 'the offline event declares the socket dead at once');
    const fellBack = Date.now() + 1000;
    while (link.mode === 'ws' && Date.now() < fellBack) await sleep(5);
    assert.equal(link.mode, 'long-poll', 'the failing sockets sent the transport to long-poll');
    await sleep(300); // well inside the pre-outage reply's heartbeat grace
    assert.equal(link.status, 'lost');
    assert.deepEqual([...new Set(after)], ['lost'], 'nothing reached the room, so the link never looked like it was connecting');

    net.down = false;
    lifecycle.fire('online');
    const back = Date.now() + 2000;
    while (link.status !== 'online' && Date.now() < back) await sleep(5);
    assert.equal(link.status, 'online', 'contact again ends the loss');
  } finally { net.down = false; link.close(); }
});
