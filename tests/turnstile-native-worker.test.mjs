import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { fileURLToPath } from 'node:url';
import { uuidv7, newCapabilityToken, newJoinCode } from '../src/shared/ids.mjs';
import { apiUrl } from '../src/shared/urls.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));

async function worker(provider) {
  const key = newCapabilityToken(), siteKey = newCapabilityToken();
  const bundled = await build({ stdin: { contents: `
    import Worker from './src/worker/index.mjs';
    import fixture from './src/fixtures/synthetic-workshop.case.json';
    import { directoryFor, roomFor } from './src/worker/directory-do.mjs';
    export { RoomDO, DirectoryDO } from './src/worker/index.mjs';
    const coarseCounts=new Map();
    export default { async fetch(request, env, ctx) {
      if (new URL(request.url).pathname === '/__fixture_setup') {
        for (const item of await request.json()) {
          await directoryFor(env,item.code).register(item.code,item.sessionId,Date.now()+3600000);
          const created=await roomFor(env,item.sessionId).create({sessionId:item.sessionId,joinCode:item.code,
            caseDoc:fixture,ownerUserId:item.ownerId,ttlMs:3600000});
          if(created.error) throw Error('fixture_setup_failed');
        }
        return Response.json({ok:true});
      }
      const calls=[],points=[],pending=[];
      const missing=request.headers.get('x-fixture-missing');
      const bindings={...env,...(missing==='secret'?{TURNSTILE_SECRET_KEY:''}:missing==='sitekey'?{TURNSTILE_SITE_KEY:''}:missing==='environment'?{CASE_ENV:''}:missing==='malformedsitekey'?{TURNSTILE_SITE_KEY:'<invalid>'}:missing==='oversizedsitekey'?{TURNSTILE_SITE_KEY:'x'.repeat(129)}:missing==='newlinesitekey'?{TURNSTILE_SITE_KEY:'invalid\\n'}:{}),JOIN_ATTEMPTS:{limit:async({key})=>{
          calls.push('coarse');const now=Date.now(),old=coarseCounts.get(key);
          const row=old&&now-old.start<60000?old:{start:now,n:0};row.n=Math.min(601,row.n+1);coarseCounts.set(key,row);
          return {success:request.headers.get('x-fixture-coarse')!=='1'&&row.n<=600};}},
        METRICS:{writeDataPoint:p=>points.push(p)},DIRECTORY:{idFromName:n=>env.DIRECTORY.idFromName(n),get:(id,options)=>{
          const actual=env.DIRECTORY.get(id,options);
          return new Proxy(actual,{get(target,method){return (...args)=>{calls.push(String(method));return target[method](...args);};}});
        }}};
      const response=await Worker.fetch(request,bindings,{waitUntil:p=>pending.push(p)});
      await Promise.all(pending);
      return Response.json({status:response.status,body:await response.json(),calls,points});
    }};`, resolveDir: root }, bundle: true, write: false, format: 'esm', platform: 'browser', loader: { '.sql': 'text' }, external: ['cloudflare:workers'] });
  const mf = new Miniflare(convertV4MiniflareOptions({ script: bundled.outputFiles[0].text, modules: true, compatibilityDate: '2026-08-22',
    durableObjects: { ROOM: { className: 'RoomDO', useSQLite: true }, DIRECTORY: { className: 'DirectoryDO', useSQLite: true } },
    bindings: { CASE_ENV: 'staging', BUILD_SHA: 'a'.repeat(40), TURNSTILE_SECRET_KEY: key, TURNSTILE_SITE_KEY: siteKey, CASE_DEV_INLINE_CASES: '1', BROADCAST_COALESCE_MS: '0', LOCK_GRACE_MS: '0', AUTO_LOCK_MS: '0' },
    outboundService: async request => {
      const url = new URL(request.url);
      assert.equal(url.origin, 'https://challenges.cloudflare.com'); assert.equal(url.pathname, '/turnstile/v0/siteverify');
      assert.equal(url.search, ''); assert.equal(request.method, 'POST');
      const body = await request.json(); assert.ok(body.secret === key); assert.ok(typeof body.response === 'string');
      return provider(body);
    } }));
  mf.publicSiteKey = siteKey; return mf;
}
const rooms = n => Array.from({ length: n }, () => ({ code: newJoinCode(), sessionId: uuidv7(), ownerId: uuidv7() }));
async function setup(mf, list) {
  assert.deepEqual(await (await mf.dispatchFetch('http://localhost/__fixture_setup', { method: 'POST', body: JSON.stringify(list) })).json(), { ok: true });
}
const join = async (mf, code, token, extra = {}) => (await mf.dispatchFetch(apiUrl('http://localhost', 'join'), {
  method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.50', ...extra },
  body: JSON.stringify({ v: 1, code, displayName: 'Sam', avatarId: 'shadows-01', ...(token ? { turnstileToken: token } : {}) }),
})).json();

test('[AS-083] native join wrong-code challenge verifies once, resets strikes and never challenges a correct code', { timeout: 20000 }, async () => {
  const used = new Set(); let providerCalls = 0;
  const mf = await worker(body => {
    providerCalls++;
    if (used.has(body.response)) return Response.json({ success: false, 'error-codes': ['timeout-or-duplicate'] });
    used.add(body.response);
    return body.response.startsWith('invalid') ? Response.json({ success: false, 'error-codes': ['invalid-input-response'] }) : Response.json({ success: true, hostname: 'case-staging.iatrogenic.app', action: 'join' });
  });
  try {
    const [room] = rooms(1); await setup(mf, [room]); let wrong = newJoinCode(); while (wrong === room.code) wrong = newJoinCode();
    for (let n = 0; n < 3; n++) assert.equal((await join(mf, wrong)).status, 404);
    const challenge = await join(mf, wrong); assert.equal(challenge.status, 428); assert.deepEqual(challenge.body, { error: 'challenge_required', siteKey: mf.publicSiteKey });
    assert.equal(providerCalls, 0);
    const correct = await join(mf, room.code); assert.equal(correct.status, 201); assert.deepEqual(correct.calls, ['coarse', 'lookup']);
    assert.equal((await join(mf, wrong, 'invalid' + newCapabilityToken())).status, 403);
    const token = newCapabilityToken(); assert.equal((await join(mf, wrong, token)).status, 404);
    for (let n = 0; n < 2; n++) assert.equal((await join(mf, wrong)).status, 404);
    assert.equal((await join(mf, wrong)).status, 428);
    const replay = await join(mf, wrong, token); assert.equal(replay.status, 403); assert.deepEqual(replay.body, { error: 'challenge_failed' });
  } finally { await mf.dispose(); }
});

test('native join keeps coarse flood and legacy wrong-code limits only during verifier outage', { timeout: 20000 }, async () => {
  let providerCalls = 0; const mf = await worker(() => { providerCalls++; return new Response(null, { status: 503 }); });
  try {
    const [room] = rooms(1); await setup(mf, [room]); let wrong = newJoinCode(); while (wrong === room.code) wrong = newJoinCode();
    for (let n = 0; n < 3; n++) assert.equal((await join(mf, wrong)).status, 404);
    const token = newCapabilityToken();
    for (let n = 0; n < 20; n++) {
      const result = await join(mf, wrong, token); assert.equal(result.status, 404);
      assert.equal(result.points.filter(p => p.blobs[0] === 'turnstile_failopen').length, 1);
    }
    assert.equal((await join(mf, wrong, token)).status, 429);
    const correct = await join(mf, room.code); assert.equal(correct.status, 201); assert.deepEqual(correct.calls, ['coarse', 'lookup']);
    const before = providerCalls; const coarse = await join(mf, room.code, undefined, { 'x-fixture-coarse': '1' });
    assert.equal(coarse.status, 429); assert.deepEqual(coarse.calls, ['coarse']); assert.equal(providerCalls, before);
    assert.deepEqual(coarse.points, [{ blobs: ['join_fail', 'staging', 'a'.repeat(40), '', 'rate_limited'], doubles: [1], indexes: ['staging'] }]);
  } finally { await mf.dispose(); }
});

test('native join accepts six hundred successful hospital NAT joins without any challenge or failure-counter call', { timeout: 30000 }, async () => {
  let providerCalls = 0; const mf = await worker(() => { providerCalls++; throw Error('unexpected verifier call'); });
  try {
    const list = rooms(3); await setup(mf, list);
    // 200 per real RoomDO preserves the existing 300-participant bound; all 600 share one prefix.
    for (let n = 0; n < 600; n++) {
      const result = await join(mf, list[Math.floor(n / 200)].code);
      assert.equal(result.status, 201); assert.deepEqual(result.calls, ['coarse', 'lookup']);
    }
    assert.equal(providerCalls, 0);
    const limited = await join(mf, list[0].code);
    assert.equal(limited.status, 429); assert.deepEqual(limited.calls, ['coarse']);
    assert.equal(providerCalls, 0);
  } finally { await mf.dispose(); }
});

test('native join returns fixed 408 for a stalled body before touching Directory or RoomDO', { timeout: 20000 }, async () => {
  const mf = await worker(() => { throw Error('unexpected verifier call'); });
  let controller, timer;
  const body = new ReadableStream({ start(c) { controller = c; c.enqueue(new TextEncoder().encode('{')); } });
  // Release the old unbounded reader at 12 seconds so the genuine first-red run terminates safely.
  timer = setTimeout(() => { try { controller.close(); } catch { /* already cancelled */ } }, 12000);
  const started = performance.now();
  try {
    const result = await (await mf.dispatchFetch(apiUrl('http://localhost', 'join'), {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.51' }, body, duplex: 'half',
    })).json();
    assert.equal(result.status, 408); assert.deepEqual(result.body, { error: 'request_timeout' });
    assert.deepEqual(result.calls, ['coarse']); assert.ok(performance.now() - started < 11500);
  } finally {
    clearTimeout(timer); try { controller.close(); } catch { /* already cancelled */ }
    await mf.dispose();
  }
});

test('native join missing selected environment or widget key uses bounded fallback without provider calls', { timeout: 20000 }, async () => {
  let providerCalls = 0; const mf = await worker(() => { providerCalls++; throw Error('unexpected verifier call'); });
  try {
    const [room] = rooms(1); await setup(mf, [room]); let wrong = newJoinCode(); while (wrong === room.code) wrong = newJoinCode();
    for (const [n, missing] of ['secret', 'sitekey', 'environment', 'malformedsitekey', 'oversizedsitekey', 'newlinesitekey'].entries()) {
      const headers = { 'x-fixture-missing': missing, 'cf-connecting-ip': `192.0.2.${61 + n}` };
      for (let attempt = 0; attempt < 20; attempt++) {
        const result = await join(mf, wrong, undefined, headers); assert.equal(result.status, 404);
        assert.equal(result.points.filter(p => p.blobs[0] === 'turnstile_failopen').length, 1);
      }
      assert.equal((await join(mf, wrong, undefined, headers)).status, 429);
      const correct = await join(mf, room.code, undefined, headers);
      assert.equal(correct.status, 201); assert.deepEqual(correct.calls, ['coarse', 'lookup']);
      assert.deepEqual(correct.points, []);
    }
    assert.equal(providerCalls, 0);
  } finally { await mf.dispose(); }
});
