// scripts/deploy-guard.mjs against a local stand-in for the Worker: never the deployed one (AGENTS.md rule 12).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/deploy-guard.mjs', import.meta.url));
const TOKEN = 'test-only-deploy-guard-token';
let server;
let api;
let live = 0;
const seen = [];

before(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization ?? null });
    if (req.url !== '/api/v1/ops/live-rooms' || req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(404).end('{"error":"not_found"}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ live }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  api = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

/** Run the script as `npm run deploy` would (async: the stand-in Worker runs in this process). */
function run(env, args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH, CASE_API: api, ...env } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('[RT2] deploy guard: no live rooms lets the deploy run; live rooms stop it unless --allow-live', async () => {
  live = 0;
  assert.equal((await run({ DEPLOY_GUARD_TOKEN: TOKEN })).status, 0);
  live = 2;
  const stopped = await run({ DEPLOY_GUARD_TOKEN: TOKEN });
  assert.equal(stopped.status, 1);
  assert.match(stopped.stderr, /2 live rooms\. .*Not deploying/);
  assert.equal((await run({ DEPLOY_GUARD_TOKEN: TOKEN }, ['--allow-live'])).status, 0);
});

test('[RT2] deploy guard: fails closed without the token or with a wrong one, and never puts the token in a URL or its output', async () => {
  const none = await run({});
  assert.equal(none.status, 1);
  assert.match(none.stderr, /DEPLOY_GUARD_TOKEN is not set/);
  const wrong = await run({ DEPLOY_GUARD_TOKEN: 'wrong-token-of-some-length' });
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /HTTP 404/);
  const down = await run({ CASE_API: 'http://127.0.0.1:9', DEPLOY_GUARD_TOKEN: TOKEN });
  assert.equal(down.status, 1, 'an unreachable Worker stops the deploy');
  for (const s of seen) assert.ok(!s.url.includes(TOKEN), `token in URL ${s.url}`);
  for (const r of [none, wrong, down]) assert.ok(!`${r.stdout}${r.stderr}`.includes(TOKEN));
});

test('deploy guard accepts only an explicit clean Case/local origin and refuses production without --prod', async () => {
  const { liveRooms } = await import('../scripts/deploy-guard.mjs');
  let requests = 0;
  const fetchImpl = async () => { requests++; return new Response('{"live":0}'); };
  for (const target of [undefined, 'https://case.iatrogenic.app', 'https://other.iatrogenic.app', 'https://token@example.invalid', 'https://case-staging.iatrogenic.app?token=private', 'https://case-staging.iatrogenic.app/path']) {
    const result = await liveRooms({ api: target, token: TOKEN, fetchImpl }); assert.equal(result.ok, false);
    assert.ok(!result.error.includes('private'));
  }
  assert.equal(requests, 0, 'invalid/prod targets never receive the credential');
  assert.equal((await liveRooms({ api: 'https://case.iatrogenic.app', prod: true, token: TOKEN, fetchImpl })).ok, true);
  assert.equal((await liveRooms({ api: 'https://case-staging.iatrogenic.app', token: TOKEN, fetchImpl })).ok, true);
  assert.equal(requests, 2);
});

test('deploy guard bounds count responses and refuses malformed counts and redirects', async () => {
  const { liveRooms } = await import('../scripts/deploy-guard.mjs');
  for (const body of [JSON.stringify({ live: 0, padding: 'x'.repeat(5000) }), '{"live":-1}', '{"live":1.5}', '{"live":9007199254740992}']) {
    const result = await liveRooms({ api, token: TOKEN, fetchImpl: async () => new Response(body) }); assert.equal(result.ok, false);
  }
  let redirect;
  const result = await liveRooms({ api, token: TOKEN, fetchImpl: async (_url, init) => { redirect = init.redirect; return new Response('{}', { status: 302 }); } });
  assert.equal(result.ok, false); assert.equal(redirect, 'error');
});

test('guard deadline aborts actual stalled fetch and body signals', { timeout: 1000 }, async () => {
  const { liveRooms } = await import('../scripts/deploy-guard.mjs');
  for (const body of [false, true]) {
    let aborted = false; const start = performance.now();
    const result = await liveRooms({ api, token: TOKEN, timeoutMs: 30, fetchImpl: async (_url, { signal }) => {
      signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      return body ? new Response(new ReadableStream({ start() {} })) : new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } });
    assert.equal(result.ok, false); assert.equal(aborted, true); assert.ok(performance.now() - start >= 20);
  }
});
