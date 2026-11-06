import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import { gzipSync, brotliCompressSync, deflateSync, gunzipSync, brotliDecompressSync, inflateSync } from 'node:zlib';
import { createParticipantJoinCapture } from './helpers/participant-join-capture.mjs';
import { uuidv7, isUuidV7, newCapabilityToken } from '../src/shared/ids.mjs';
import { parseVoteEnvelope } from '../src/shared/vote-envelope.mjs';

const scope = () => ({ sessionId: uuidv7(), joinCode: '7K3QX9', displayName: 'Learner Name' });
const inputs = s => {
  const token = newCapabilityToken();
  return { request: { v: 1, code: s.joinCode, displayName: s.displayName, avatarId: 'shadows-01', joinToken: token },
    response: { sessionId: s.sessionId, participantId: uuidv7(), token } };
};
const bytes = value => Buffer.from(JSON.stringify(value));
function stream({ method = 'POST', url = '/api/v1/join', status = 201, encoding = null } = {}) {
  const result = new EventEmitter(); Object.assign(result, { method, url, statusCode: status, headers: encoding ? { 'content-encoding': encoding } : {}, complete: false });
  result.send = data => { result.emit('data', data); result.complete = true; result.emit('end'); result.emit('close'); };
  return result;
}
function arm(timeout = 1000) {
  const capture = createParticipantJoinCapture(timeout), s = scope(), input = inputs(s), promise = capture.waitForParticipant(s);
  promise.catch(() => {});
  return { capture, s, input, promise };
}
function pair(f, { request = f.input.request, response = f.input.response, status = 201, encoding = null, beforeRequest = false } = {}) {
  const req = stream(), res = stream({ status, encoding }), ticket = f.capture.prepareRequest(req, req.url);
  ticket?.observeResponse(res);
  if (beforeRequest) res.send(Buffer.isBuffer(response) ? response : bytes(response));
  req.send(Buffer.isBuffer(request) ? request : bytes(request));
  if (!beforeRequest) res.send(Buffer.isBuffer(response) ? response : bytes(response));
  return { req, res, ticket };
}

test('original request and exact original201 are captured in either stream-end order, without duplicate writes', async () => {
  for (const beforeRequest of [false, true]) {
    const f = arm(), p = pair(f, { beforeRequest });
    assert.deepEqual(await f.promise, f.input.response);
    assert.equal(p.req.listenerCount('data'), 0); assert.equal(p.res.listenerCount('data'), 0);
    assert.ok(Object.isFrozen(await f.promise));
  }
});

test('wrong method/path/query, code and name never consume the scoped waiter', async () => {
  const f = arm();
  for (const [method, url] of [['GET', '/api/v1/join'], ['POST', '/api/v1/other'], ['POST', '/api/v1/join?code=7K3QX9']]) {
    assert.equal(f.capture.prepareRequest(stream({ method, url }), new URL(url, 'http://127.0.0.1').pathname), null);
  }
  pair(f, { request: { ...f.input.request, code: 'AB1234' } });
  pair(f, { request: { ...f.input.request, displayName: 'Other Name' } });
  pair(f); assert.deepEqual(await f.promise, f.input.response);
});

test('only one matching request/result can settle a waiter; late old bytes and cancellation cannot affect a later arm', async () => {
  const f = arm(), req = stream(), res = stream(), ticket = f.capture.prepareRequest(req, req.url);
  ticket.observeResponse(res); req.send(bytes(f.input.request));
  assert.equal(f.capture.prepareRequest(stream(), '/api/v1/join'), null);
  ticket.observeResponse(stream({ status: 500 })); res.send(bytes(f.input.response));
  assert.deepEqual(await f.promise, f.input.response);
  const lateResponse = stream(); ticket.observeResponse(lateResponse);
  assert.equal(lateResponse.listenerCount('data'), 0); assert.equal(lateResponse.listenerCount('error'), 0);
  const next = f.capture.waitForParticipant(f.s); next.catch(() => {});
  f.promise.cancel(); res.send(Buffer.from('{}'));
  pair({ ...f, promise: next }); assert.deepEqual(await next, f.input.response);
});

test('malformed/unsafe/oversized requests and candidate overflow refuse without manufacturing a participant', async () => {
  for (const request of [Buffer.from('{'), Buffer.from([0xff]), Buffer.alloc(4097, 65), { v: 0 },
    { v: 1, code: '7K3QX9', displayName: 'Learner Name', avatarId: 'invalid' }]) {
    const f = arm(); pair(f, { request }); await assert.rejects(f.promise, /local_join_response_invalid/);
  }
  const f = arm(); for (let i = 0; i < 9; i++) f.capture.prepareRequest(stream(), '/api/v1/join');
  await assert.rejects(f.promise, /local_join_response_invalid/);
});

test('wrong status/room/participant/token/schema, malformed UTF8/JSON, encoded overflow and decompression bombs refuse', async () => {
  const failures = [f => ({ status: 200 }), f => ({ status: 403 }), f => ({ response: { ...f.input.response, sessionId: uuidv7() } }),
    f => ({ response: { ...f.input.response, participantId: 'not-uuid' } }), f => ({ response: { ...f.input.response, token: '' } }),
    f => ({ response: { ...f.input.response, token: newCapabilityToken() } }), f => ({ response: { ...f.input.response, expiresAt: 'invented' } }),
    f => ({ response: { ...f.input.response, token: 'x'.repeat(4097) } }), f => ({ response: Buffer.from('{') }),
    f => ({ response: Buffer.from([0xff]) }), f => ({ response: Buffer.alloc(4097, 65) }),
    f => ({ encoding: 'unsupported', response: bytes(f.input.response) }),
    f => ({ encoding: 'gzip', response: gzipSync(Buffer.alloc(4097, 65)) }), f => ({ encoding: 'gzip', response: Buffer.from('not gzip') })];
  for (const make of failures) { const f = arm(); pair(f, make(f)); await assert.rejects(f.promise, /local_join_response_invalid/); }
});

test('bounded original gzip/br/deflate/identity response bytes preserve the exact participant', async () => {
  for (const [encoding, compress] of [['gzip', gzipSync], ['br', brotliCompressSync], ['deflate', deflateSync], ['identity', value => value]]) {
    const f = arm(); pair(f, { encoding, response: compress(bytes(f.input.response)) }); assert.deepEqual(await f.promise, f.input.response);
  }
});

test('abort/error/incomplete close, proxy failure, own cancel, shell close and timeout settle and release observer listeners', async () => {
  for (const target of ['request', 'response']) for (const event of ['error', 'aborted', 'close']) {
    const f = arm(), req = stream(), res = stream(), ticket = f.capture.prepareRequest(req, req.url); ticket.observeResponse(res);
    if (target === 'response') req.send(bytes(f.input.request));
    (target === 'request' ? req : res).emit(event, new Error('private upstream diagnostic'));
    await assert.rejects(f.promise, /local_join_response_unavailable/);
    assert.equal(req.listenerCount('data'), 0); assert.equal(res.listenerCount('data'), 0);
  }
  const proxy = arm(), req = stream(), ticket = proxy.capture.prepareRequest(req, req.url); ticket.unavailable();
  await assert.rejects(proxy.promise, /local_join_response_unavailable/);
  const cancel = arm(); cancel.promise.cancel(); await assert.rejects(cancel.promise, /local_join_response_unavailable/);
  const close = arm(); close.capture.close(); await assert.rejects(close.promise, /local_join_response_unavailable/);
  assert.throws(() => close.capture.waitForParticipant(close.s), /local_join_waiter_unavailable/);
  const expired = arm(5), oldReq = stream(), oldRes = stream(), oldTicket = expired.capture.prepareRequest(oldReq, oldReq.url);
  oldTicket.observeResponse(oldRes); await assert.rejects(expired.promise, /local_join_response_timeout/);
  const fresh = expired.capture.waitForParticipant(expired.s); fresh.catch(() => {});
  oldReq.send(bytes(expired.input.request)); oldRes.send(Buffer.from('{}'));
  pair(expired); assert.deepEqual(await fresh, expired.input.response);
});

test('native abort followed by error and canceled/timed-out streams keep only a payload-free error sink until close', async () => {
  for (const mode of ['request-abort', 'response-abort', 'cancel', 'timeout']) {
    const f = arm(mode === 'timeout' ? 5 : 1000), req = stream(), res = stream();
    const ticket = f.capture.prepareRequest(req, req.url); ticket.observeResponse(res);
    req.send = data => { req.emit('data', data); req.complete = true; req.emit('end'); };
    req.send(bytes(f.input.request));
    if (mode === 'request-abort') req.emit('aborted');
    else if (mode === 'response-abort') res.emit('aborted');
    else if (mode === 'cancel') f.promise.cancel();
    await assert.rejects(f.promise, mode === 'timeout' ? /local_join_response_timeout/ : /local_join_response_unavailable/);
    assert.equal(req.listenerCount('data'), 0); assert.equal(res.listenerCount('data'), 0);
    assert.equal(req.listenerCount('error'), 1); assert.equal(res.listenerCount('error'), 1);
    assert.doesNotThrow(() => { req.emit('error', new Error('private late request diagnostic')); res.emit('error', new Error('private late response diagnostic')); });
    req.emit('close'); res.emit('close');
    assert.equal(req.listenerCount('error'), 0); assert.equal(res.listenerCount('error'), 0);
  }
});

test('cancel/timeout/mismatch before upstream headers attaches only a payload-free late-result error sink', async () => {
  for (const mode of ['cancel', 'timeout', 'mismatch']) {
    const f = arm(mode === 'timeout' ? 5 : 1000), req = stream(), ticket = f.capture.prepareRequest(req, req.url);
    if (mode === 'cancel') f.promise.cancel();
    else if (mode === 'mismatch') req.send(bytes({ ...f.input.request, code: 'AB1234' }));
    if (mode !== 'mismatch') await assert.rejects(f.promise);
    const late = stream(); ticket.observeResponse(late); ticket.observeResponse(late);
    assert.equal(late.listenerCount('data'), 0); assert.equal(late.listenerCount('error'), 1);
    assert.doesNotThrow(() => late.emit('error', new Error('private late upstream diagnostic')));
    late.emit('close'); assert.equal(late.listenerCount('error'), 0);
    if (mode === 'mismatch') { pair(f); assert.deepEqual(await f.promise, f.input.response); }
  }
});

test('scope and timer configuration are strict and only one waiter can be armed', async () => {
  assert.throws(() => createParticipantJoinCapture(NaN), /local_join_timeout_invalid/);
  for (const change of [{ sessionId: 'not-a-room' }, { joinCode: 'lowercase' }, { displayName: '<private>' }]) {
    const capture = createParticipantJoinCapture(); assert.throws(() => capture.waitForParticipant({ ...scope(), ...change }), /local_join_scope_invalid/);
  }
  const f = arm(); assert.throws(() => f.capture.waitForParticipant(f.s), /local_join_waiter_unavailable/); f.promise.cancel(); await assert.rejects(f.promise);
});

const shellSource = readFileSync(new URL('./helpers/served-auth-shell.mjs', import.meta.url), 'utf8');
const apiStart = shellSource.indexOf("      if (path.startsWith('/api/')) {"), apiEnd = shellSource.indexOf('      const roomRoute', apiStart);
function actualProxy(upstream, observer) {
  assert.ok(apiStart >= 0 && apiEnd > apiStart);
  return new Function('httpRequest', 'upstream', 'participantJoinObserver', 'parseVoteEnvelope', 'isUuidV7', 'gunzipSync', 'brotliDecompressSync', 'inflateSync',
    `let creationWaiter = null, voteReceiptLoss = null; return (request, response) => { const path = new URL(request.url, 'http://127.0.0.1').pathname;
    ${shellSource.slice(apiStart, apiEnd)} response.writeHead(404).end(); };`)(httpRequest, new URL(upstream), observer, parseVoteEnvelope, isUuidV7, gunzipSync, brotliDecompressSync, inflateSync);
}
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)); });
const stop = server => server?.listening ? new Promise(resolve => server.close(resolve)) : Promise.resolve();
test('actual proxy forwards one original POST and compressed201 byte-for-byte with observer enabled or default absent', async () => {
  for (const observe of [true, false]) {
    const f = arm(), wire = gzipSync(bytes(f.input.response)), requests = [];
    const upstream = createServer((request, response) => {
      const chunks = []; request.on('data', chunk => chunks.push(chunk)); request.on('end', () => {
        requests.push({ method: request.method, url: request.url, body: Buffer.concat(chunks) });
        response.writeHead(201, { 'content-encoding': 'gzip', 'content-type': 'application/json', 'x-original': 'kept' }); response.end(wire);
      });
    });
    let proxy;
    try {
      const origin = await listen(upstream); proxy = createServer(actualProxy(origin, observe ? f.capture : null));
      const proxyOrigin = await listen(proxy);
      const got = await new Promise((resolve, reject) => {
        const request = httpRequest(`${proxyOrigin}/api/v1/join`, { method: 'POST', headers: { 'content-type': 'application/json' } }, response => {
          const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, raw: Buffer.concat(chunks) }));
        }); request.on('error', reject); request.end(bytes(f.input.request));
      });
      assert.equal(got.status, 201); assert.equal(got.headers['x-original'], 'kept'); assert.deepEqual(got.raw, wire);
      assert.deepEqual(requests, [{ method: 'POST', url: '/api/v1/join', body: bytes(f.input.request) }]);
      if (observe) assert.deepEqual(await f.promise, f.input.response);
      else { f.promise.cancel(); await assert.rejects(f.promise); }
    } finally { f.capture.close(); await stop(proxy); await stop(upstream); }
  }
  assert.ok(shellSource.indexOf('participantJoinObserver?.prepareRequest') < shellSource.indexOf('request.pipe(proxy)'));
  assert.match(shellSource, /response\.writeHead\(result\.statusCode, result\.headers\); result\.pipe\(response\)/);
});

test('actual original HTTP partial201 abort rejects capture and safely follows native aborted/error/close without altering delivered bytes', async () => {
  const f = arm(), wire = bytes(f.input.response), partial = wire.subarray(0, 12), requests = [];
  let proxy, client, originalResult, resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const observer = { prepareRequest(request, path) {
    const ticket = f.capture.prepareRequest(request, path);
    if (!ticket) return null;
    return { unavailable: ticket.unavailable, observeResponse(result) {
      originalResult = result; ticket.observeResponse(result);
      result.once('close', resolveClosed);
    } };
  } };
  const upstream = createServer((request, response) => {
    const chunks = []; request.on('data', chunk => chunks.push(chunk)); request.on('end', () => {
      requests.push(Buffer.concat(chunks));
      response.writeHead(201, { 'content-type': 'application/json', 'content-length': wire.length }); response.write(partial);
      setTimeout(() => response.destroy(), 10);
    });
  });
  try {
    const origin = await listen(upstream); proxy = createServer(actualProxy(origin, observer)); const proxyOrigin = await listen(proxy);
    const arrived = new Promise((resolve, reject) => {
      client = httpRequest(`${proxyOrigin}/api/v1/join`, { method: 'POST' }, response => {
        response.once('data', data => resolve({ status: response.statusCode, data })); response.on('error', () => {});
      }); client.on('error', reject); client.end(bytes(f.input.request));
    });
    const got = await arrived; assert.equal(got.status, 201); assert.deepEqual(got.data, partial);
    await assert.rejects(f.promise, /local_join_response_unavailable/); await closed;
    assert.equal(originalResult.complete, false); assert.equal(originalResult.listenerCount('error'), 0);
    assert.deepEqual(requests, [bytes(f.input.request)], 'the failed original join was sent exactly once');
  } finally { client?.destroy(); f.capture.close(); proxy?.closeAllConnections(); upstream.closeAllConnections(); await stop(proxy); await stop(upstream); }
});

const phoneSource = readFileSync(new URL('./helpers/live-console-controls.mjs', import.meta.url), 'utf8');
const phoneStart = phoneSource.indexOf('export async function openPhone('), phoneEnd = phoneSource.indexOf('\nexport async function selectPhone', phoneStart);
const runPhone = new Function('expect', 'captureRemotePublicFrames', 'captureCommands', 'joinUrl', 'apiUrl',
  `${phoneSource.slice(phoneStart, phoneEnd).replace('export async function', 'async function')} return openPhone;`)(
  value => ({ toBe: expected => assert.equal(value, expected), toBeVisible: async () => {} }), () => [], () => [],
  (code, origin) => `${origin}/J/${code}`, (origin, path) => `${origin}/api/v1/${path}`);
function phoneFixture({ fail = false, contextCloseFails = false } = {}) {
  const f = arm(); f.promise.cancel(); // Use the actual helper's arm, not this fixture's initial arm.
  f.promise.catch(() => {});
  let responseReady, responseReject, clicks = 0, reads = 0, closes = 0, responseWaiterClosed = 0, pendingBeforeClick = false;
  const failure = new Error('original join click failure');
  const page = { goto: async () => {}, on() {}, getByLabel: () => ({ fill: async () => {} }), locator() {},
    waitForResponse(predicate) { return new Promise((resolve, reject) => { responseReject = reject; responseReady = response => { assert.ok(predicate(response)); resolve(response); }; }); },
    getByRole(role) { if (role === 'radio') return { first: () => ({}) }; return { click: async () => {
      clicks++; const req = stream(), res = stream(), ticket = f.capture.prepareRequest(req, req.url); pendingBeforeClick = Boolean(ticket);
      if (fail) throw failure;
      ticket.observeResponse(res); req.send(bytes(f.input.request)); res.send(bytes(f.input.response));
      responseReady({ request: () => ({ method: () => 'POST' }), url: () => 'http://127.0.0.1/api/v1/join', status: () => 201,
        json: async () => { reads++; throw new Error('Protocol error Network.getResponseBody: body unavailable'); } });
    } }; } };
  const context = { newPage: async () => page, close: async () => { closes++; responseWaiterClosed++; responseReject?.(new Error('native response waiter closed')); if (contextCloseFails) throw new Error('cleanup failure'); } };
  return { ...f, page, failure, browser: { newContext: async () => context }, harness: { shell: { origin: 'http://127.0.0.1' }, participantJoins: f.capture },
    room: { sessionId: f.s.sessionId, joinCode: f.s.joinCode }, get clicks() { return clicks; }, get reads() { return reads; }, get closes() { return closes; }, get responseWaiterClosed() { return responseWaiterClosed; }, get pendingBeforeClick() { return pendingBeforeClick; } };
}
test('actual openPhone preserves original201 assertion and UI checks despite unavailable CDP body, with one real Join click', async () => {
  const f = phoneFixture(); const phone = await runPhone(f.browser, f.harness, f.room, f.s.displayName);
  assert.deepEqual(phone.participant, f.input.response); assert.equal(f.clicks, 1); assert.equal(f.reads, 0); assert.equal(f.closes, 0); assert.equal(f.pendingBeforeClick, true);
  f.capture.close();
});
test('actual openPhone failure cancels only its waiter and closes its new context without masking the original error', async () => {
  const f = phoneFixture({ fail: true, contextCloseFails: true });
  await assert.rejects(runPhone(f.browser, f.harness, f.room, f.s.displayName), error => error === f.failure);
  assert.equal(f.closes, 1); assert.equal(f.clicks, 1); assert.equal(f.responseWaiterClosed, 1);
  const next = f.capture.waitForParticipant(f.s); next.catch(() => {}); pair(f); assert.deepEqual(await next, f.input.response); f.capture.close();
});
