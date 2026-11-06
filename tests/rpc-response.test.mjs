import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rpcClient } from '../src/worker/rpc.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
import { validateCaseDocument } from '../src/shared/case-document.mjs';
import { miniCase } from './helpers/mini-case.mjs';

const env = () => ({ SUPABASE_URL: 'https://postgrest.test/', SUPABASE_SECRET_KEY: `sb_secret_${uuidv7()}` });
const utf8 = value => new TextEncoder().encode(value);
const failure = code => ({ ok: false, kind: 'unavailable', status: 503, code });
const metadataLimit = 1_048_576;
const documentLimit = 8 * 1_048_576 + 65_536;
const errorLimit = 65_536;
// The document read the Worker still calls (card 35 retired the member-only get_case_version).
const documentArgs = () => ({ p_version_id: uuidv7(), p_workspace_id: uuidv7(), p_user_id: uuidv7(), p_admin: false, p_admin_email: null });

function chunked(bytes, { declared, neverCancel = false, status = 200 } = {}) {
  let offset = 0, cancellations = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      const end = Math.min(bytes.length, offset + 8_191);
      controller.enqueue(bytes.slice(offset, end)); offset = end;
    },
    cancel() { cancellations++; if (neverCancel) return new Promise(() => {}); },
  });
  return { response: new Response(stream, { status, headers: declared === undefined ? {} : { 'content-length': String(declared) } }),
    cancelled: () => cancellations, consumed: () => offset };
}

async function withinDeadline(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('RPC caller stayed pending')), 500); })]); }
  finally { clearTimeout(timer); }
}

function maximumPack() {
  const { doc } = miniCase();
  while (doc.surfaces.length < 200) doc.surfaces.push({ id: uuidv7(), kind: 'text', title: 'Boundary fixture', points: ['Test fixture.'] });
  const pattern = '漢漢漢\\"';
  let low = 0, high = 2_000;
  const setNotes = length => { for (const surface of doc.surfaces) surface.notes = pattern.repeat(Math.ceil(length / pattern.length)).slice(0, length); };
  while (low < high) {
    const mid = Math.ceil((low + high) / 2); setNotes(mid);
    if (utf8(JSON.stringify(doc)).length <= 1_048_576) low = mid; else high = mid - 1;
  }
  setNotes(low);
  const missing = 1_048_576 - utf8(JSON.stringify(doc)).length;
  for (const surface of doc.surfaces) {
    const count = Math.min(2_000 - surface.notes.length, 1_048_576 - utf8(JSON.stringify(doc)).length);
    surface.notes += 'x'.repeat(count);
    if (utf8(JSON.stringify(doc)).length === 1_048_576) break;
  }
  assert.ok(missing >= 0);
  assert.equal(utf8(JSON.stringify(doc)).length, 1_048_576);
  assert.deepEqual(validateCaseDocument(doc).errors, []);
  return doc;
}

test('RPC streams UTF-8 metadata bytes and refuses oversized unknown or lying lengths without parsing private content', async () => {
  const config = env();
  const bytes = utf8(JSON.stringify({ private: 'é'.repeat(metadataLimit / 2 + 4 * 8_191), secret: config.SUPABASE_SECRET_KEY }));
  assert.ok(bytes.length > metadataLimit);
  assert.ok(new TextDecoder().decode(bytes).length < metadataLimit);
  for (const declared of [undefined, 8]) {
    const body = chunked(bytes, { declared, neverCancel: true });
    const seen = [];
    const result = await withinDeadline(rpcClient(config, { fetchImpl: async () => body.response, onAlert: meta => seen.push(meta) }).call('ping'));
    assert.deepEqual(result, failure('response_too_large'));
    assert.equal(body.cancelled(), 1);
    assert.ok(body.consumed() <= metadataLimit + 2 * 8_191, 'reader stops near the byte boundary');
    assert.deepEqual(seen, [{ kind: 'unavailable', code: 'response_too_large', name: 'ping' }]);
    assert.ok(!JSON.stringify([result, seen]).includes(config.SUPABASE_SECRET_KEY));
  }
});

test('RPC preserves a valid maximum case with duplicated escaped document text and caps the larger document envelope', async () => {
  const doc = maximumPack(), text = JSON.stringify(doc);
  const data = [{ case_id: uuidv7(), version_no: 1, schema_version: 1, document: doc, document_text: text, content_sha256: `\\x${'0'.repeat(64)}` }];
  const bytes = utf8(JSON.stringify(data));
  assert.ok(bytes.length > 2 * 1_048_576, 'escaping and duplicated document exceed a small generic response cap');
  assert.ok(bytes.length < documentLimit);
  const valid = chunked(bytes);
  assert.deepEqual(await rpcClient(env(), { fetchImpl: async () => valid.response }).call('get_case_version_for_workspace', documentArgs()), { ok: true, data });
  const oversized = chunked(utf8(JSON.stringify('x'.repeat(documentLimit + 8 * 8_191))), { declared: 12, neverCancel: true });
  assert.deepEqual(await withinDeadline(rpcClient(env(), { fetchImpl: async () => oversized.response }).call('get_case_version_for_workspace', documentArgs())), failure('response_too_large'));
  assert.equal(oversized.cancelled(), 1);
});

test('RPC refuses a declared oversized body before consumption and accepts the exact metadata byte boundary', async () => {
  const big = chunked(utf8('null'), { declared: metadataLimit + 1, neverCancel: true });
  assert.deepEqual(await withinDeadline(rpcClient(env(), { fetchImpl: async () => big.response }).call('ping')), failure('response_too_large'));
  assert.equal(big.cancelled(), 1);
  assert.ok(big.consumed() <= 4, 'stream prefetch only; no whole-body reader');
  const exact = utf8(JSON.stringify('x'.repeat(metadataLimit - 2)));
  assert.equal(exact.length, metadataLimit);
  assert.deepEqual(await rpcClient(env(), { fetchImpl: async () => chunked(exact).response }).call('ping'), { ok: true, data: 'x'.repeat(metadataLimit - 2) });
});

test('RPC whole deadline bounds an abort-ignoring stalled stream and never awaits cancellation', async () => {
  for (const stalledFetch of [true, false]) {
    let cancelled = 0;
    const response = new Response(new ReadableStream({ start(c) { c.enqueue(utf8('[')); }, cancel() { cancelled++; return new Promise(() => {}); } }));
    const fetchImpl = stalledFetch ? async () => new Promise(() => {}) : async () => response;
    const result = await withinDeadline(rpcClient(env(), { fetchImpl, timeoutMs: 15 }).call('ping'));
    assert.deepEqual(result, failure('timeout'));
    assert.equal(cancelled, stalledFetch ? 0 : 1);
  }
});

test('RPC bounded error streams preserve ordinary SQL status mappings and sanitize oversized errors', async () => {
  for (const [status, code, kind, mapped] of [[409, '40001', 'conflict', 409], [404, 'PGRST116', 'not_found', 404], [403, '42501', 'forbidden', 500], [503, null, 'unavailable', 503]]) {
    const data = { code, message: 'private echoed value' };
    const result = await rpcClient(env(), { fetchImpl: async () => chunked(utf8(JSON.stringify(data)), { status }).response }).call('ping');
    assert.deepEqual(result, { ok: false, kind, status: mapped, code });
  }
  const bytes = utf8(JSON.stringify({ code: '42501', message: 'private'.repeat(errorLimit) }));
  const body = chunked(bytes, { status: 403, declared: 3, neverCancel: true });
  assert.deepEqual(await withinDeadline(rpcClient(env(), { fetchImpl: async () => body.response }).call('ping')), failure('response_too_large'));
  assert.equal(body.cancelled(), 1);
});

test('RPC cancels a late abort-ignoring fetch body without starting its reader after timeout', async () => {
  let respond, pulls = 0, cancelled = 0;
  const response = new Response(new ReadableStream({
    pull() { pulls++; return new Promise(() => {}); },
    cancel() { cancelled++; return new Promise(() => {}); },
  }, { highWaterMark: 0 }));
  const fetchImpl = async () => new Promise(resolve => { respond = resolve; });
  assert.deepEqual(await withinDeadline(rpcClient(env(), { fetchImpl, timeoutMs: 15 }).call('ping')), failure('timeout'));
  respond(response);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(pulls, 0, 'expired request must not begin body work');
  assert.equal(cancelled, 1, 'late body is cancelled without awaiting cancellation');
});

test('RPC refuses redirects without reading or following private bodies and never awaits their cancellation', async () => {
  for (const status of [302, 307, 308]) {
    const config = env(), requests = [], alerts = [];
    let pulls = 0, cancelled = 0, signal;
    const response = new Response(new ReadableStream({
      pull() { pulls++; return new Promise(() => {}); },
      cancel() { cancelled++; return new Promise(() => {}); },
    }, { highWaterMark: 0 }), {
      status, headers: { location: 'https://untrusted.test/private-redirect-target' },
    });
    const result = await withinDeadline(rpcClient(config, {
      fetchImpl: async (url, options) => {
        requests.push({ url, redirect: options.redirect }); signal = options.signal;
        return response;
      },
      onAlert: alert => alerts.push(alert),
    }).call('ping'));
    assert.deepEqual(result, failure('redirect'));
    assert.deepEqual(requests, [{ url: 'https://postgrest.test/rest/v1/rpc/ping', redirect: 'manual' }]);
    assert.equal(pulls, 0, 'refused redirect must not acquire or read its private stream');
    assert.equal(signal.aborted, true, 'refused redirect aborts the abandoned request');
    assert.equal(cancelled, 1, 'refused redirect cancels its unread body without awaiting cancellation');
    assert.deepEqual(alerts, [{ kind: 'unavailable', code: 'redirect', name: 'ping' }]);
    assert.ok(!JSON.stringify([result, requests, alerts]).includes(config.SUPABASE_SECRET_KEY));
  }
});
