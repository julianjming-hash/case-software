// Exact old client source exists only in a throwaway compatibility reference, never in shipped assets.
import { mkdtempSync, readFileSync, createReadStream, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { createConnection } from 'node:net';
import { gunzipSync, brotliDecompressSync, inflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { expect } from '@playwright/test';
import { startLocalAuthStub } from './local-auth-stub.mjs';
import { startPublishedWorker } from './published-worker.mjs';
import { controlsCase, captureCommands, mirror } from './live-console-controls.mjs';
import { apiUrl, samePcProjectorUrl } from '../../src/shared/urls.mjs';
import { isUuidV7 } from '../../src/shared/ids.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export { LEGACY_SHA } from './legacy-source.mjs';
import { LEGACY_SHA, LEGACY_WITNESSES as witnesses, archiveLegacySource, verifyLegacyWitnesses } from './legacy-source.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const mime = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.woff2': 'font/woff2', '.wav': 'audio/wav' };

// Observe the original local upstream response while forwarding it unchanged. Chromium's
// later CDP body lookup is not the authority for a response the real client already consumed.
export function legacyCreationCapture(timeoutMs = 10_000) {
  let waiting = null;
  return {
    waitForCreatedRoom() {
      if (waiting) throw new Error('local_creation_waiter_exists');
      return new Promise((resolve, reject) => {
        const waiter = { matched: false, finish(error, value) {
          if (waiting !== waiter) return;
          clearTimeout(timer); waiting = null; error ? reject(error) : resolve(value);
        } };
        const timer = setTimeout(() => waiter.finish(new Error('local_creation_response_timeout')),
          Math.max(1, Math.min(10_000, timeoutMs)));
        waiting = waiter;
      });
    },
    observe(request, path, result) {
      const waiter = waiting;
      if (!waiter || waiter.matched || request.method !== 'POST' || path !== '/api/v1/sessions') return;
      waiter.matched = true;
      const chunks = []; let bytes = 0;
      result.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 65536) { chunks.length = 0; waiter.finish(new Error('local_creation_response_invalid')); }
        else chunks.push(chunk);
      });
      result.once('end', () => {
        try {
          if (bytes > 65536 || result.statusCode !== 201) throw new Error();
          let body = Buffer.concat(chunks);
          const encoding = result.headers['content-encoding'];
          const decoders = { gzip: gunzipSync, br: brotliDecompressSync, deflate: inflateSync };
          if (encoding && encoding !== 'identity') {
            if (!Object.hasOwn(decoders, encoding)) throw new Error();
            body = decoders[encoding](body, { maxOutputLength: 65536 });
          }
          if (body.length > 65536) throw new Error();
          const room = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
          if (!room || Object.keys(room).sort().join() !== 'expiresAt,facilitatorToken,joinCode,sessionId' ||
              !isUuidV7(room.sessionId) || typeof room.facilitatorToken !== 'string' || !room.facilitatorToken ||
              !/^[0-9A-HJKMNP-TV-Z]{6}$/.test(room.joinCode) || typeof room.expiresAt !== 'string' ||
              !Number.isFinite(Date.parse(room.expiresAt))) throw new Error();
          waiter.finish(null, room);
        } catch { waiter.finish(new Error('local_creation_response_invalid')); }
        finally { chunks.length = 0; }
      });
      const unavailable = () => { chunks.length = 0; waiter.finish(new Error('local_creation_response_unavailable')); };
      result.once('error', unavailable); result.once('aborted', unavailable);
      result.once('close', () => { if (!result.complete) unavailable(); });
    },
    close() { waiting?.finish(new Error('local_creation_response_unavailable')); },
  };
}

async function oldShell({ apiOrigin, authOrigin }) {
  const temp = mkdtempSync(join(tmpdir(), 'case-legacy-83158-'));
  let server;
  const sockets = new Set();
  const creation = legacyCreationCapture();
  try {
    // Archive only client/build inputs and their pure Worker header imports; no config, credentials,
    // workflow or living docs are imported. Git reads the immutable original commit.
    const archive = archiveLegacySource(ROOT);
    execFileSync('tar', ['-xf', '-'], { cwd: temp, input: archive });
    verifyLegacyWitnesses(temp);
    // Reuse pinned test tooling read-only, without installing another dependency graph.
    symlinkSync(join(ROOT, 'node_modules'), join(temp, 'node_modules'), 'dir');
    const { buildClient } = await import(pathToFileURL(join(temp, 'scripts/build-client.mjs')).href);
    const { casesUrl } = await import(pathToFileURL(join(temp, 'src/shared/urls.mjs')).href);
    const outDir = join(temp, 'dist');
    const built = await buildClient({ root: temp, outDir, env: 'staging', buildSha: LEGACY_SHA,
      publicAuthBindings: { SUPABASE_URL: authOrigin, SUPABASE_JWT_ISSUER: `${authOrigin}/auth/v1`,
        SUPABASE_JWKS_URL: `${authOrigin}/auth/v1/.well-known/jwks.json` } });
    const validatorAsset = built.hashedFiles.find(file => /^assets\/case-document\.[a-f0-9]{64}\.mjs$/.test(file));
    if (!validatorAsset) throw new Error('legacy_validator_asset_missing');
    const blocks = [];
    for (const line of readFileSync(join(outDir, '_headers'), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      if (!/^\s/.test(line)) blocks.push({ pattern: line.trim(), headers: {} });
      else { const [, name, value] = /^\s+([^:]+):\s*(.*)$/.exec(line) ?? []; if (name) blocks.at(-1).headers[name.toLowerCase()] = value; }
    }
    const upstream = new URL(apiOrigin);
    if (upstream.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(upstream.hostname)) throw new Error('local_api_required');
    server = createServer((request, response) => {
      const path = new URL(request.url, 'http://127.0.0.1').pathname;
      if (path.startsWith('/api/')) {
        const proxy = httpRequest({ host: upstream.hostname, port: upstream.port, method: request.method,
          path: request.url, headers: { ...request.headers, host: upstream.host } }, result => {
          creation.observe(request, path, result);
          response.writeHead(result.statusCode, result.headers); result.pipe(response);
        });
        proxy.on('error', () => response.writeHead(502).end()); request.pipe(proxy); return;
      }
      const file = ['/', '/cases', '/join', '/privacy', '/help'].includes(path) ? 'index.html'
        : /^\/(?:cases\/|sessions\/|[JjDdPp]\/)/.test(path) ? 'room.html' : path.slice(1);
      const target = resolve(outDir, file);
      try { if (!target.startsWith(outDir + sep) || !statSync(target).isFile()) throw new Error('not_found'); }
      catch { response.writeHead(404).end(); return; }
      const headers = { 'content-type': mime[extname(target)] ?? 'application/octet-stream' };
      for (const block of blocks) if (block.pattern.endsWith('*') ? path.startsWith(block.pattern.slice(0,-1)) : block.pattern === path)
        Object.assign(headers, block.headers);
      response.writeHead(200, headers); createReadStream(target).pipe(response);
    });
    server.on('upgrade', (request, socket, head) => {
      const path = new URL(request.url, 'http://127.0.0.1');
      if (!/^\/api\/v1\/sessions\/[0-9a-f-]{36}\/ws$/.test(path.pathname) || path.search) { socket.destroy(); return; }
      const remote = createConnection(Number(upstream.port), upstream.hostname);
      sockets.add(socket); sockets.add(remote);
      const clear = () => { sockets.delete(socket); sockets.delete(remote); socket.destroy(); remote.destroy(); };
      socket.on('error', clear); remote.on('error', clear);
      remote.on('connect', () => {
        const headers = Object.entries({ ...request.headers, host: upstream.host }).map(([name,value]) => `${name}: ${value}`).join('\r\n');
        remote.write(`${request.method} ${request.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
        if (head.length) remote.write(head); socket.pipe(remote).pipe(socket);
      });
    });
    await new Promise((resolve,reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return { origin: `http://127.0.0.1:${server.address().port}`, outDir, witnesses, casesUrl, validatorAsset: `/${validatorAsset}`,
      waitForCreatedRoom: () => creation.waitForCreatedRoom(),
      installWaitingBuild() {
        const path = join(outDir, 'sw.mjs'), old = readFileSync(path, 'utf8');
        const original = old.match(/case-shell-wire1-[a-f0-9]{64}/)?.[0];
        if (!original) throw new Error('legacy_cache_name_missing');
        const next = `case-shell-wire1-${hash(`${original}:compatibility-update`)}`;
        writeFileSync(path, old.replace(original, next));
        return { next, restore: () => writeFileSync(path, old) };
      },
      async stop() { creation.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); rmSync(temp, { recursive: true, force: true }); } };
  } catch (error) {
    creation.close();
    for (const socket of sockets) socket.destroy();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    rmSync(temp, { recursive: true, force: true }); throw error;
  }
}

export async function startLegacyHarness(kind) {
  const fixture = controlsCase();
  fixture.doc.surfaces.find(surface => surface.id === fixture.s.open).kind = kind;
  fixture.doc.surfaces.find(surface => surface.id === fixture.s.open).scene = `Public ${kind} <b>TEXT_ONLY_SENTINEL</b>.`;
  let auth, worker, shell;
  try {
    auth = await startLocalAuthStub({ appOrigin: null, jwt: null });
    worker = await startPublishedWorker({ authOrigin: auth.origin, caseDocument: fixture.doc });
    auth.setJwt(worker.jwt); shell = await oldShell({ apiOrigin: worker.origin, authOrigin: auth.origin });
    auth.setAppOrigin(shell.origin);
    return { fixture, worker, shell, kind, stop: async () => { await shell.stop(); await worker.stop(); await auth.stop(); } };
  } catch (error) { await shell?.stop(); await worker?.stop(); await auth?.stop(); throw error; }
}

export async function openLegacyRoom(context, harness) {
  const page = await context.newPage(), commands = captureCommands(page);
  await page.goto(harness.shell.casesUrl(harness.shell.origin));
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await page.getByLabel('Email', { exact: true }).fill('owner@example.invalid');
  await page.getByRole('button', { name: 'Email me a sign-in code', exact: true }).click();
  await page.getByLabel('One-time code', { exact: true }).fill('123456');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const created = harness.shell.waitForCreatedRoom();
  created.catch(() => {}); // A body error still rejects the awaited creation after the click completes.
  // The frozen client's labels stay frozen too; current Studio helpers name a different control.
  await page.locator('.library-list').getByRole('link',{name:'Published case',exact:true}).click();
  await page.getByRole('button',{name:'Start room',exact:true}).click(); const room = await created;
  const opened = context.waitForEvent('page');
  await page.getByRole('button', { name: 'Open projector', exact: true }).click();
  const projector = await opened;
  await expect(projector).toHaveURL(samePcProjectorUrl(room.sessionId, harness.shell.origin));
  await page.getByRole('button', { name: 'Other setup options', exact: true }).click();
  await page.getByRole('button', { name: 'Dismiss display reminder', exact: true }).click();
  await page.locator('.console-primary').click();
  await expect(page.locator('.console-phase')).toHaveAttribute('data-phase', 'surface_live');
  expect((await mirror(harness, room)).revealed.at(-1).surfaceId).toBe(harness.fixture.s.open);
  return { page, projector, room, commands };
}

export async function packText(harness, room) {
  const response = await fetch(apiUrl(harness.worker.origin, 'sessions', room.sessionId, 'case-pack'),
    { headers: { authorization: `Bearer ${room.facilitatorToken}` } });
  expect(response.status).toBe(200); return response.text();
}
