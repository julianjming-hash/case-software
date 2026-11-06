import test from 'node:test';
import assert from 'node:assert/strict';
import { connect, requestDisplayPair, testLifecycle } from '../src/client/transport.mjs';
import { uuidv7, newCapabilityToken } from '../src/shared/ids.mjs';
import { validateCaseDocument } from '../src/shared/case-document.mjs';
import { parseManualSegment } from '../src/shared/wire.mjs';
import { miniCase } from './helpers/mini-case.mjs';

const api = 'https://case.test';
const defer = () => { let resolve; const promise = new Promise(ok => { resolve = ok; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const pairBody = () => ({ pairId: uuidv7(), code: '7K3QX9', secret: newCapabilityToken(), expiresAt: new Date(Date.now() + 300000).toISOString() });
async function finite(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve('watchdog_pending'), 250); })]); }
  finally { clearTimeout(timer); }
}
class IdleSocket { addEventListener() {} close() {} }
const options = () => ({ role: 'participant', api, sessionId: uuidv7(), token: newCapabilityToken(), storage: null, persistentStorage: null, lifecycle: testLifecycle(), WebSocketImpl: IdleSocket, telemetryImpl: () => {} });

// These are deliberately abort-ignoring injected fetch/stream implementations.
// A failing watchdog establishes a caller guarantee gap, not an observed browser hang.
test('RT03 ignored fetch abort still settles the whole pairing attempt before late headers', async () => {
  const held = defer(); let signal;
  const pending = requestDisplayPair({ api, timeoutMs: 20, fetchImpl: async (_url, init) => { signal = init.signal; return held.promise; } });
  try {
    assert.deepEqual(await finite(pending), { error: 'network' });
    assert.equal(signal.aborted, true);
  } finally { held.resolve(Response.json(pairBody(), { status: 201 })); await pending.catch(() => {}); }
});

test('RT03 ignored body abort and nonsettling cancellation cannot hold pairing past its deadline', async () => {
  let controller, cancellations = 0, signal;
  const body = new ReadableStream({ start(c) { controller = c; }, cancel() { cancellations++; return new Promise(() => {}); } }, { highWaterMark: 0 });
  const pending = requestDisplayPair({ api, timeoutMs: 20, fetchImpl: async (_url, init) => { signal = init.signal; return new Response(body, { status: 201 }); } });
  pending.catch(() => {});
  try {
    assert.deepEqual(await finite(pending), { error: 'network' });
    assert.equal(signal.aborted, true);
    assert.equal(cancellations, 1);
  } finally { try { controller.close(); } catch {} await pending.catch(() => {}); }
});

test('RT03 close settles an abort-ignoring HTTP read and never starts the late private body', async () => {
  const entered = defer(), headers = defer(); let reads = 0, cancellations = 0, snapshots = 0;
  const privateSnapshot = { v: 1, t: 'snapshot', epoch: 0, revision: 1, displayRevision: 0, view: { you: { id: uuidv7(), name: 'Private late identity' } } };
  const body = new ReadableStream({ pull(c) { reads++; c.enqueue(new TextEncoder().encode(JSON.stringify(privateSnapshot))); c.close(); }, cancel() { cancellations++; } }, { highWaterMark: 0 });
  const response = new Response(body);
  const link = connect({ ...options(), fetchImpl: async () => { entered.resolve(); return headers.promise; } });
  link.on('snapshot', () => { snapshots++; });
  const pending = link.refetch();
  try {
    await entered.promise; link.close();
    assert.equal(await finite(pending), false);
    headers.resolve(response); await tick(); await tick();
    assert.equal(reads, 0); assert.equal(cancellations, 1);
    assert.equal(snapshots, 0); assert.equal(link.snapshot, null); assert.equal(link.participantId, null); assert.equal(link.hasToken, false);
  } finally { link.close(); headers.resolve(response); await pending.catch(() => {}); }
});

test('RT03 fixed pairing responses count UTF-8 bytes despite absent or dishonest lengths', async () => {
  const legal = pairBody();
  assert.equal((await requestDisplayPair({ api, fetchImpl: async () => Response.json(legal, { status: 201 }) })).pairId, legal.pairId);
  for (const headers of [{}, { 'content-length': '3' }]) {
    let cancellations = 0;
    const bytes = new TextEncoder().encode(JSON.stringify({ ...legal, unwanted: '漢'.repeat(24000) }));
    const body = new ReadableStream({ pull(c) { c.enqueue(bytes); c.close(); }, cancel() { cancellations++; } }, { highWaterMark: 0 });
    assert.deepEqual(await requestDisplayPair({ api, fetchImpl: async () => new Response(body, { status: 201, headers }) }), { error: 'response_too_large' });
    // Fully supplied one-chunk input may already be closed when cancellation runs.
    assert.ok(cancellations <= 1);
  }
});

test('RT03 declared oversized fixed response is refused before pulling its unread tail', async () => {
  let pulls = 0, cancellations = 0;
  const body = new ReadableStream({ pull() { pulls++; return new Promise(() => {}); }, cancel() { cancellations++; return new Promise(() => {}); } }, { highWaterMark: 0 });
  const pending = requestDisplayPair({ api, timeoutMs: 20, fetchImpl: async () => new Response(body, { status: 201, headers: { 'content-length': '65537' } }) });
  assert.deepEqual(await finite(pending), { error: 'response_too_large' });
  assert.equal(pulls, 0); assert.equal(cancellations, 1);
});

test('RT03 oversized provider errors stay fixed server failures and never expose the body', async () => {
  const privateError = 'Untrusted provider detail 漢'.repeat(5000);
  const result = await requestDisplayPair({ api, fetchImpl: async () => Response.json({ error: privateError }, { status: 503 }) });
  assert.equal(result.error.length <= 24, true, 'oversized provider detail must be replaced by a short fixed error');
  assert.deepEqual(result, { error: 'response_too_large' });
  assert.ok(!JSON.stringify(result).includes('Untrusted provider'));
  assert.deepEqual(await requestDisplayPair({ api, fetchImpl: async () => Response.json({ error: 'unavailable' }, { status: 503 }) }), { error: 'unavailable' });
});

test('RT03 case-pack response admits schema-valid private material above the fixed metadata cap', async () => {
  const { doc } = miniCase();
  for (let index = 0; index < 40; index++) doc.surfaces.push({ id: uuidv7(), kind: 'update', title: 'Additional private notes', points: ['Public short point.'], notes: '漢'.repeat(1800) });
  assert.equal(validateCaseDocument(doc).ok, true);
  assert.ok(new TextEncoder().encode(JSON.stringify(doc)).byteLength > 65536);
  const delivered = defer();
  class WelcomeSocket {
    callbacks = new Map();
    constructor() { queueMicrotask(() => this.callbacks.get('open')?.({})); }
    addEventListener(kind, fn) { this.callbacks.set(kind, fn); }
    send(text) { if (JSON.parse(text).t === 'hello') queueMicrotask(() => this.callbacks.get('message')?.({ data: JSON.stringify({ v: 1, t: 'welcome' }) })); }
    close() {}
  }
  const link = connect({ ...options(), role: 'facilitator', WebSocketImpl: WelcomeSocket, fetchImpl: async () => Response.json(doc) });
  link.on('case_pack', value => delivered.resolve(value));
  try { assert.deepEqual(await finite(delivered.promise), doc); }
  finally { link.close(); }
  const aborted = defer();
  const oversized = connect({ ...options(), role: 'facilitator', WebSocketImpl: WelcomeSocket, fetchImpl: async (_url, init) => {
    init.signal.addEventListener('abort', () => aborted.resolve('aborted'), { once: true });
    return Response.json({ ...doc, unexpected: 'x'.repeat(8 * 1048576) });
  } });
  try {
    assert.equal(await finite(aborted.promise), 'aborted', 'oversized pack must abort the bounded reader');
    assert.equal(oversized.casePack, null);
  } finally { oversized.close(); }
});

test('RT03 old authenticated case-pack and snapshot reads cannot cross forget or adopt generations', async () => {
  const entered = defer(), body = defer();
  class WelcomeSocket {
    callbacks = new Map();
    constructor() { queueMicrotask(() => this.callbacks.get('open')?.({})); }
    addEventListener(kind, fn) { this.callbacks.set(kind, fn); }
    send(text) { if (JSON.parse(text).t === 'hello') queueMicrotask(() => this.callbacks.get('message')?.({ data: JSON.stringify({ v: 1, t: 'welcome' }) })); }
    close() {}
  }
  const forgotten = connect({ ...options(), role: 'facilitator', WebSocketImpl: WelcomeSocket, fetchImpl: async () => { entered.resolve(); return { status: 200, json: () => body.promise }; } });
  try {
    await entered.promise; forgotten.forget(); body.resolve({ document: miniCase().doc }); await tick(); await tick();
    assert.equal(forgotten.casePack === null, true, 'forgotten private material must remain purged');
    assert.equal(forgotten.hasToken, false);
  } finally { forgotten.close(); body.resolve({}); }
  const readEntered = defer(), snapshotBody = defer();
  const link = connect({ ...options(), fetchImpl: async () => { readEntered.resolve(); return { status: 200, json: () => snapshotBody.promise }; } });
  const oldRoom = link.sessionId, pending = link.refetch(), newRoom = uuidv7();
  try {
    await readEntered.promise; link.adopt(newRoom, newCapabilityToken());
    snapshotBody.resolve({ v: 1, t: 'snapshot', epoch: 0, revision: 99, displayRevision: 0, view: { sessionId: oldRoom, you: { id: uuidv7(), name: 'Old identity' } } });
    assert.equal(await finite(pending), false);
    assert.equal(link.sessionId, newRoom); assert.equal(link.snapshot, null); assert.equal(link.participantId, null);
  } finally { link.close(); snapshotBody.resolve({}); await pending.catch(() => {}); }
});

test('RT03 an old join attempt cannot overwrite credentials adopted while its reply was held', async () => {
  const entered = defer(), body = defer();
  const link = connect({ ...options(), token: null, sessionId: null, timings: { RETRY_MS: 1 }, fetchImpl: async () => { entered.resolve(); return { status: 201, json: () => body.promise }; } });
  const pending = link.join('7K3QX9', 'Legal name', 'shadows-01'), newRoom = uuidv7();
  try {
    await entered.promise; link.adopt(newRoom, newCapabilityToken());
    body.resolve({ sessionId: uuidv7(), participantId: uuidv7(), token: newCapabilityToken() });
    assert.deepEqual(await finite(pending), { ok: false, error: 'no_credential' });
    assert.equal(link.sessionId, newRoom); assert.equal(link.hasToken, true); assert.equal(link.participantId, null);
  } finally { link.close(); body.resolve({}); await pending.catch(() => {}); }
});

// Capped (fixed-metadata) responses are streamed; uncapped snapshot/update bodies keep the ordinary
// parser so browser tooling can still inspect them (CASE-157), bounded by the deadline race instead.
test('RT03 malformed UTF-8 in a capped response cancels the unread stream tail without awaiting cancellation', async () => {
  let reads = 0, cancellations = 0;
  const body = new ReadableStream({ pull(c) { reads++; if (reads === 1) c.enqueue(new Uint8Array([0xc3, 0x28])); else return new Promise(() => {}); }, cancel() { cancellations++; return new Promise(() => {}); } }, { highWaterMark: 0 });
  const link = connect({ ...options(), fetchImpl: async () => new Response(body) });
  try {
    assert.deepEqual(await finite(link.uploadSegment({ v: 1 })), { status: 200, body: null }, 'existing empty/non-JSON status handling stays unchanged');
    assert.equal(cancellations, 1); assert.equal(reads, 1);
  } finally { link.close(); }
});

test('RT03 a join generation change during retry sleep sends no further stale join request', async () => {
  let requests = 0;
  const parsed = defer();
  const link = connect({ ...options(), token: null, sessionId: null, timings: { RETRY_MS: 40 }, fetchImpl: async () => {
    requests++; return { status: 503, json: async () => { parsed.resolve(); return { error: 'unavailable' }; } };
  } });
  const pending = link.join('7K3QX9', 'Legal name', 'shadows-01'), newRoom = uuidv7();
  try {
    await parsed.promise; await tick(); link.adopt(newRoom, newCapabilityToken());
    assert.deepEqual(await finite(pending), { ok: false, error: 'no_credential' });
    assert.equal(requests, 1); assert.equal(link.sessionId, newRoom);
  } finally { link.close(); await pending; }
});

test('RT03 fixed manual upload metadata stays bounded without treating refusal as recovered success', async () => {
  const segmentId = uuidv7(), at = new Date().toISOString();
  const segment = { v: 1, segmentId, events: [
    { v: 1, type: 'enter_manual', epoch: 0, clientEventId: uuidv7(), segmentId, at },
    { v: 1, type: 'resume_online', epoch: 0, clientEventId: uuidv7(), at },
  ] };
  assert.equal(parseManualSegment(segment).ok, true);
  const success = { ok: true, revision: 17, epoch: 0, applied: 2 };
  const link = connect({ ...options(), role: 'facilitator', fetchImpl: async () => Response.json(success) });
  try {
    assert.deepEqual(await link.uploadSegment(segment), { status: 200, body: success });
  } finally { link.close(); }
  for (const headers of [{}, { 'content-length': '3' }]) {
    const bytes = new TextEncoder().encode(JSON.stringify({ ...success, unwanted: '漢'.repeat(24000) }));
    assert.ok(bytes.byteLength > 65536);
    const body = new ReadableStream({ pull(c) { c.enqueue(bytes); c.close(); } }, { highWaterMark: 0 });
    const oversized = connect({ ...options(), role: 'facilitator', fetchImpl: async () => new Response(body, { headers }) });
    try {
      const refusal = await oversized.uploadSegment(segment);
      assert.equal(refusal.status, 503, 'oversized fixed metadata must be a server refusal');
      assert.deepEqual(refusal, { status: 503, body: { error: 'response_too_large' } });
      assert.equal(oversized.snapshot, null);
    } finally { oversized.close(); }
  }
});

test('RT03 an oversized error on an otherwise uncapped read stops pulling at the error cap', async () => {
  const chunk = new Uint8Array(16 * 1024).fill(0x20);
  let pulled = 0;
  const link = connect({ ...options(), fetchImpl: async () => new Response(new ReadableStream({
    pull(controller) { pulled += 1; if (pulled > 640) controller.close(); else controller.enqueue(chunk); },
  }), { status: 500 }) });
  try {
    await finite(link.refetch());
    // 64 KiB error cap: at most the chunks that cross it (plus stream read-ahead), never the 10 MiB body.
    assert.equal(pulled <= 8, true, `pulled ${pulled} chunks of an oversized error body`);
  } finally { link.close(); }
});

test('RT03 a stale authenticated refusal cannot revoke credentials adopted while it was held', async () => {
  const entered = defer(), reply = defer();
  const link = connect({ ...options(), fetchImpl: async () => { entered.resolve(); return reply.promise; } });
  const pending = link.refetch(), newRoom = uuidv7();
  try {
    await entered.promise; link.adopt(newRoom, newCapabilityToken());
    reply.resolve(Response.json({ error: 'unauthorised' }, { status: 401 }));
    await finite(pending); await tick();
    assert.equal(link.hasToken, true, 'an old generation 401 must not drop the newly adopted credential');
    assert.equal(link.sessionId, newRoom);
  } finally { link.close(); reply.resolve(Response.json({}, { status: 200 })); await pending.catch(() => {}); }
});
