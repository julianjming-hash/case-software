// tests/helpers/local-worker.mjs: the real Case Worker in local workerd (`wrangler dev`), for the
// transport tests and the real-room e2e. No network and no Cloudflare account: wrangler's local
// mode runs Miniflare, and Durable Object storage goes to a throwaway temp dir.
//
// Test-only vars are passed on the command line, never written to the repo:
//   SUPABASE_JWT_SECRET  a throwaway secret, enabled only with CASE_ALLOW_HS256=1
//   CASE_DEV_INLINE_CASES=1, BROADCAST_COALESCE_MS=0
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signTestJwt } from '../../src/worker/auth.mjs';
import { uuidv7, isUuid } from '../../src/shared/ids.mjs';
import { knownAccountFake } from './admin-account-fixture.mjs';
import { buildClient } from '../../scripts/build-client.mjs';

const knownActors = new Set();
export const ACCOUNT_ORIGIN = 'https://admin-accounts.invalid';
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const TEST_JWT_SECRET = 'test-only-secret-not-for-production';
export const FIXTURE = JSON.parse(readFileSync(join(ROOT, 'src/fixtures/synthetic-workshop.case.json'), 'utf8'));

/** The account fake admits only the Worker's exact `admin_account_active` call with this harness's service key. */
export function accountCallRefused({ method, path, header }, serviceKey) {
  return method !== 'POST' || path !== '/rest/v1/rpc/admin_account_active' || header('apikey') !== serviceKey ||
    header('authorization') != null || header('content-profile') !== 'case_api' || header('accept-profile') !== 'case_api' ||
    header('content-type') !== 'application/json';
}

/** Answers an admitted account call: active only for the actors this harness signed tokens for. */
export function answerAccountCall(headers, body) {
  const fake = knownAccountFake({ actors: [...knownActors], origin: ACCOUNT_ORIGIN });
  return fake.fetchImpl(`${ACCOUNT_ORIGIN}/rest/v1/rpc/admin_account_active`, { method: 'POST', headers, body, redirect: 'manual' });
}

/** A free localhost TCP port. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/**
 * Start `wrangler dev` (local mode) on a free port. Resolves `{ origin, stop }` once the Worker answers.
 * @param {{log?: boolean}} [o]
 */
export async function startLocalWorker({ log = Boolean(process.env.CASE_WORKER_LOG) } = {}) {
  // A free port can be taken between the probe and wrangler's bind (other workerd instances, e.g. a
  // parallel test:do run): retry on a fresh pair of ports.
  let lastError;
  for (let i = 0; i < 3; i++) {
    try { return await startOnce({ log }); } catch (e) { lastError = e; }
  }
  throw lastError;
}

/** Each local workerd owns an immutable initial asset tree; concurrent builds never wipe another. */
export async function prepareLocalAssets(persist, { buildSha = 'unconfigured' } = {}) {
  const assetDir = join(persist, 'assets');
  await buildClient({ outDir: assetDir, buildSha });
  const configPath = join(persist, 'wrangler.toml');
  const config = readFileSync(join(ROOT, 'wrangler.toml'), 'utf8')
    .replace(/^\[build\]\n[\s\S]*?(?=^\[)/m, '')
    .replace(/^main = "src\/worker\/index\.mjs"$/m, `main = ${JSON.stringify(join(ROOT, 'src/worker/index.mjs'))}`)
    .replace(/^directory = "dist"$/m, `directory = ${JSON.stringify(assetDir)}`);
  writeFileSync(configPath, config);
  return { assetDir, configPath };
}

async function startOnce({ log }) {
  const port = await freePort();
  const inspectorPort = await freePort();
  const persist = mkdtempSync(join(tmpdir(), 'case-worker-'));
  let prepared;
  try { prepared = await prepareLocalAssets(persist, { buildSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim() }); }
  catch (error) { rmSync(persist, { recursive: true, force: true }); throw error; }
  // This fake exists only in the throwaway harness; the actual Worker keeps HTTPS-only RPCs.
  const serviceKey = `sb_secret_local_${uuidv7()}`;
  const accountServer = createHttpServer(async (request, response) => {
    const refuse = status => { response.writeHead(status, { 'content-type': 'application/json' }); response.end('{"error":"fixture_refused"}'); };
    if (accountCallRefused({ method: request.method, path: request.url, header: name => request.headers[name] }, serviceKey)) { refuse(404); return; }
    let bytes = 0, ended = false; const chunks = [];
    const timer = setTimeout(() => { if (!ended) { ended = true; refuse(408); request.destroy(); } }, 1000);
    try {
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 1024) { ended = true; refuse(413); request.destroy(); return; }
        chunks.push(chunk);
      }
      if (ended) return;
      const result = await answerAccountCall(request.headers, Buffer.concat(chunks).toString('utf8'));
      ended = true; response.writeHead(result.status, { 'content-type': 'application/json' }); response.end(await result.text());
    } catch { if (!ended) { ended = true; refuse(400); } }
    finally { clearTimeout(timer); }
  });
  await new Promise((resolve, reject) => { accountServer.once('error', reject); accountServer.listen(0, '127.0.0.1', resolve); });
  const accountOrigin = `http://127.0.0.1:${accountServer.address().port}`;
  const entryPath = join(persist, 'account-worker.mjs');
  const actualEntry = JSON.stringify(join(ROOT, 'src/worker/index.mjs'));
  writeFileSync(entryPath, `// Generated local-only account bridge. No runtime source is replaced.
import worker from ${actualEntry};
export { RoomDO, DirectoryDO, AlertDO } from ${actualEntry};
const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init) => {
  const request = new Request(input, init), url = new URL(request.url);
  if (url.origin !== ${JSON.stringify(ACCOUNT_ORIGIN)} || url.pathname !== '/rest/v1/rpc/admin_account_active' || url.search || url.hash)
    throw new Error('Unexpected outbound host or RPC in local Worker test');
  return nativeFetch(${JSON.stringify(accountOrigin)} + url.pathname, { method: request.method,
    headers: request.headers, body: request.body, signal: request.signal, redirect: 'manual' });
};
export default worker;
`);
  writeFileSync(prepared.configPath, readFileSync(prepared.configPath, 'utf8')
    .replace(/^main = .*$/m, `main = ${JSON.stringify(entryPath)}`));
  const args = [
    join(ROOT, 'node_modules/wrangler/bin/wrangler.js'), 'dev', '--config', prepared.configPath,
    '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(inspectorPort), '--persist-to', persist,
    '--var', `SUPABASE_JWT_SECRET:${TEST_JWT_SECRET}`, '--var', 'CASE_ALLOW_HS256:1', '--var', 'CASE_DEV_INLINE_CASES:1', '--var', 'BROADCAST_COALESCE_MS:0', '--var', 'LOCK_GRACE_MS:0', '--var', 'AUTO_LOCK_MS:0',
    '--var', `SUPABASE_URL:${ACCOUNT_ORIGIN}/`, '--var', `SUPABASE_SECRET_KEY:${serviceKey}`,
    '--show-interactive-dev-session=false',
  ];
  const workerLogDir = process.env.CASE_WORKER_LOG_DIR || null;
  if (workerLogDir) mkdirSync(workerLogDir, { recursive: true });
  const child = spawn(process.execPath, args, {
    cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG: log || workerLogDir ? 'info' : 'warn', NO_UPDATE_NOTIFIER: '1', CI: '1' },
  });
  let output = '';
  // CASE_WORKER_LOG_DIR (CI load gates, CASE-161): keep each Worker's full output, every chunk stamped
  // with wall-clock ms, so a stalled gate shows whether the Worker itself was slow to answer.
  const logFile = workerLogDir ? createWriteStream(join(workerLogDir, `wrangler-${Date.now()}-${port}.log`)) : null;
  const collect = (d) => {
    output += d; if (output.length > 64_000) output = output.slice(-32_000); if (log) process.stderr.write(d);
    logFile?.write(String(d).split('\n').filter(Boolean).map(line => `${Date.now()} ${line}\n`).join(''));
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const origin = `http://127.0.0.1:${port}`;
  const stop = async () => {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ }
    await new Promise((r) => { if (child.exitCode !== null) r(); else { child.once('exit', r); setTimeout(r, 3000); } });
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
    accountServer.closeAllConnections();
    await new Promise(resolve => accountServer.close(resolve));
    rmSync(persist, { recursive: true, force: true });
    await new Promise(resolve => logFile ? logFile.end(resolve) : resolve());
  };
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const r = await fetch(`${origin}/api/v1/nope`, { signal: AbortSignal.timeout(1000) });
      if (r.status === 404 && (await r.json()).error === 'not_found') return { origin, port, stop, assetDir: prepared.assetDir };
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  await stop();
  throw new Error(`wrangler dev did not start:\n${output.slice(-4000)}`);
}

/** A local-only facilitator access token for the throwaway secret. */
const TEST_USER_ID = uuidv7();
export function facilitatorJwt(sub = TEST_USER_ID) {
  if (!isUuid(sub)) throw new TypeError('Invalid local facilitator subject');
  knownActors.add(sub);
  return signTestJwt({ sub, aud: 'authenticated', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 }, TEST_JWT_SECRET);
}

/** Create a room on the local Worker. `{ sessionId, joinCode, facilitatorToken, expiresAt }`. */
export async function createRoom(origin, { caseDocument = FIXTURE, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${origin}/api/v1/sessions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await facilitatorJwt()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ caseDocument }),
  });
  if (res.status !== 201) throw new Error(`create room: ${res.status} ${await res.text()}`);
  return res.json();
}

/** The server's full reducer state (the facilitator snapshot's `mirror`): for assertions only. */
export async function serverMirror(origin, room) {
  // Steering speaks as a current client (schema 3, card 57); a slide room refuses clients older than its case.
  const res = await fetch(`${origin}/api/v1/sessions/${room.sessionId}/snapshot`, { headers: { authorization: `Bearer ${room.facilitatorToken}`, 'x-case-schema': '3' } });
  if (res.status !== 200) throw new Error(`snapshot: ${res.status}`);
  const snap = await res.json();
  return { ...snap.mirror, revision: snap.revision, epoch: snap.epoch, displayRevision: snap.displayRevision };
}

/** POST one facilitator command straight to the Worker (test steering, not a client under test). */
export async function facilitatorCommand(origin, room, type, extra = {}) {
  const m = await serverMirror(origin, room);
  const res = await fetch(`${origin}/api/v1/sessions/${room.sessionId}/commands`, {
    method: 'POST',
    headers: { authorization: `Bearer ${room.facilitatorToken}`, 'content-type': 'application/json', 'x-case-schema': '3' },
    body: JSON.stringify({ v: 1, type, epoch: m.epoch, clientEventId: uuidv7(),
      ...(type === 'advance' ? { expectRevision: m.revision } : {}), ...extra }),
  });
  return (await res.json()).receipt;
}
