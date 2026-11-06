// Serve a throwaway built shell with its generated Cloudflare _headers and a local API proxy.
// This exercises the deployed static CSP instead of a test-only replacement header.
import { mkdtempSync, readFileSync, createReadStream, rmSync, statSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { createConnection } from 'node:net';
import { gunzipSync, brotliDecompressSync, inflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildClient } from '../../scripts/build-client.mjs';
import { parseRoute } from '../../src/shared/urls.mjs';
import { isUuidV7 } from '../../src/shared/ids.mjs';
import { parseVoteEnvelope } from '../../src/shared/vote-envelope.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
function headerBlocks(raw) {
  const blocks = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) blocks.push({ pattern: line.trim(), headers: {} });
    else {
      const [, name, value] = /^\s+([^:]+):\s*(.*)$/.exec(line) ?? [];
      if (name) blocks.at(-1).headers[name.toLowerCase()] = value;
    }
  }
  return blocks;
}
function matches(pattern, path) {
  return pattern.endsWith('*') ? path.startsWith(pattern.slice(0, -1)) : pattern === path;
}

export async function startServedAuthShell({ apiOrigin, buildAuthBindings = null, participantJoinObserver = null, casePublicOrigin = null }) {
  const temp = mkdtempSync(join(tmpdir(), 'case-auth-shell-'));
  const outDir = join(temp, 'dist');
  try {
    const build = await buildClient({ root: ROOT, outDir, env: 'staging', buildSha: 'a'.repeat(40),
      publicAuthBindings: buildAuthBindings });
    const blocks = headerBlocks(readFileSync(join(outDir, '_headers'), 'utf8'));
    const upstream = new URL(apiOrigin);
    if (upstream.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(upstream.hostname))
      throw new Error('local_api_required');
    const upgraded = new Set();
    let upgradedCount = 0;
    let creationWaiter = null;
    let voteReceiptLoss = null;
    // One local response-loss fault. The immutable witness cannot manufacture completion.
    function armVoteReceiptLoss(sessionId) {
      if (!isUuidV7(sessionId) || voteReceiptLoss) throw new Error('local_vote_loss_scope_invalid');
      const fault = { sessionId, clientEventId: null, receipt: null, completed: false, error: null };
      voteReceiptLoss = fault;
      return Object.freeze({ get clientEventId() { return fault.clientEventId; },
        get receipt() { return fault.receipt; }, get completed() { return fault.completed; },
        get error() { return fault.error; } });
    }
    function waitForCreatedRoom() {
      if (creationWaiter) throw new Error('local_creation_waiter_exists');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { creationWaiter = null; reject(new Error('local_creation_response_timeout')); }, 10000);
        creationWaiter = { finish(error, value) { clearTimeout(timer); creationWaiter = null; error ? reject(error) : resolve(value); } };
      });
    }
    const server = createServer((request, response) => {
      let path;
      try { path = new URL(request.url, 'http://127.0.0.1').pathname; }
      catch { response.writeHead(400).end(); return; }
      if (path.startsWith('/api/')) {
        const armed = request.method === 'POST' && path === `/api/v1/sessions/${voteReceiptLoss?.sessionId}/commands` ? voteReceiptLoss : null;
        let matchingVote = null;
        if (armed) {
          const chunks = []; let bytes = 0;
          request.on('data', chunk => { bytes += chunk.length; if (bytes <= 4096) chunks.push(chunk); });
          request.once('end', () => {
            if (bytes > 4096 || voteReceiptLoss !== armed) return;
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (!parseVoteEnvelope(body).ok || !isUuidV7(body.clientEventId) || !isUuidV7(body.roundId)) return;
              matchingVote = armed; armed.clientEventId = body.clientEventId; voteReceiptLoss = null;
            } catch { /* a non-vote never consumes the one-shot fault */ }
          });
        }
        const joinObservation = participantJoinObserver?.prepareRequest(request, path);
        // One upstream connection per proxied request (`agent: false`). Node's default agent keeps sockets alive, and
        // reusing one the local Worker had just closed failed at once as a 502: nightly run 38702394070 (AS-163) got a
        // 502 on GET /api/v1/config in 13 ms, so sign-in said "unavailable" and the test waited for a code field.
        const proxy = httpRequest({ host: upstream.hostname, port: upstream.port, agent: false,
          method: request.method, path: request.url, headers: { ...request.headers, host: upstream.host, ...(request.headers.origin === `http://${request.headers.host}` ? { origin: casePublicOrigin ?? upstream.origin } : {}) } }, result => {
          joinObservation?.observeResponse(result);
          const waiter = request.method === 'POST' && path === '/api/v1/sessions' ? creationWaiter : null;
          if (waiter) {
            const chunks = []; let bytes = 0;
            result.on('data', chunk => { bytes += chunk.length; if (bytes <= 65536) chunks.push(chunk); });
            result.once('end', () => {
              try {
                if (bytes > 65536 || result.statusCode !== 201) throw new Error('local_creation_response_invalid');
                let body = Buffer.concat(chunks);
                const encoding = result.headers['content-encoding'];
                const decoders = { gzip: gunzipSync, br: brotliDecompressSync, deflate: inflateSync };
                if (encoding && encoding !== 'identity') {
                  if (!decoders[encoding]) throw new Error('local_creation_encoding_invalid');
                  body = decoders[encoding](body, { maxOutputLength: 65536 });
                }
                if (body.length > 65536) throw new Error('local_creation_response_invalid');
                waiter.finish(null, JSON.parse(body.toString('utf8')));
              } catch { waiter.finish(new Error('local_creation_response_invalid')); }
            });
            result.once('error', () => waiter.finish(new Error('local_creation_response_unavailable')));
          }
          if (matchingVote && result.statusCode === 200) {
            const fault = matchingVote, chunks = []; let bytes = 0, overflow = false;
            result.on('data', chunk => {
              bytes += chunk.length;
              if (bytes <= 4096) chunks.push(chunk);
              else if (!overflow) { overflow = true; fault.error = 'local_vote_receipt_size'; result.destroy(); response.destroy(); }
            });
            result.once('error', () => { fault.error ??= 'local_vote_receipt_unavailable'; response.destroy(); });
            result.once('end', () => {
              if (overflow) return;
              const raw = Buffer.concat(chunks);
              try {
                let body = raw;
                const encoding = result.headers['content-encoding'];
                const decoders = { gzip: gunzipSync, br: brotliDecompressSync, deflate: inflateSync };
                if (encoding && encoding !== 'identity') {
                  if (!decoders[encoding]) throw new Error('local_vote_receipt_encoding');
                  body = decoders[encoding](body, { maxOutputLength: 4096 });
                }
                if (body.length > 4096) throw new Error('local_vote_receipt_size');
                const receipt = JSON.parse(body.toString('utf8')).receipt;
                if (receipt?.v !== 1 || receipt.t !== 'receipt' || receipt.clientEventId !== fault.clientEventId ||
                    !['accepted', 'already_accepted'].includes(receipt.receipt)) throw new Error('local_vote_receipt_invalid');
                if (response.destroyed || response.writableEnded) throw new Error('local_vote_client_already_closed');
                fault.receipt = Object.freeze({ clientEventId: receipt.clientEventId, receipt: receipt.receipt });
                response.once('close', () => { fault.completed = response.destroyed; });
                response.destroy();
              } catch (error) {
                fault.error = error.message;
                if (!response.destroyed) { response.writeHead(result.statusCode, result.headers); response.end(raw); }
              }
            });
            return;
          }
          response.writeHead(result.statusCode, result.headers); result.pipe(response);
        });
        proxy.on('error', () => response.writeHead(502).end());
        if (joinObservation) proxy.once('error', joinObservation.unavailable);
        request.pipe(proxy);
        return;
      }
      const roomRoute = parseRoute(path)?.route === 'display-pair' || /^\/[Pp]\/?$/.test(path) || /^\/[Jj]\/[^/]+$/.test(path) ||
        /^\/sessions\/[0-9a-f-]{36}\/(?:display|play|facilitate)$/.test(path);
      // Card 29: the catalogue and case detail are app routes served from the shell, as _redirects does.
      const catalogueRoute = ['cases', 'case', 'case-version', 'case-new', 'case-edit', 'history', 'session-record', 'account'].includes(parseRoute(path)?.route);
      // CASE-341: the invitation page /i/ is served from the shell, as _redirects does.
      const file = path === '/' || path === '/cases' || parseRoute(path)?.route === 'invite' ? 'index.html' : roomRoute || catalogueRoute ? 'room.html' : path.slice(1);
      const target = resolve(outDir, file);
      try {
        if (!target.startsWith(outDir + sep) || !statSync(target).isFile()) throw new Error('not_found');
      } catch { response.writeHead(404).end(); return; }
      const headers = { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' };
      for (const block of blocks) if (matches(block.pattern, path)) Object.assign(headers, block.headers);
      response.writeHead(200, headers);
      createReadStream(target).pipe(response);
    });
    // The static shell's API proxy must also carry the real room WebSocket.
    // Restrict this test-only tunnel to a local room path; no external host or
    // credential-bearing URL can be introduced by a served browser test.
    server.on('upgrade', (request, socket, head) => {
      let path;
      try { path = new URL(request.url, 'http://127.0.0.1'); }
      catch { socket.destroy(); return; }
      if (!/^\/api\/v1\/sessions\/[0-9a-f-]{36}\/ws$/.test(path.pathname) || path.search ||
          request.headers.upgrade?.toLowerCase() !== 'websocket') { socket.destroy(); return; }
      const remote = createConnection(Number(upstream.port), upstream.hostname);
      upgraded.add(socket); upgraded.add(remote);
      const cleanup = () => { socket.destroy(); remote.destroy(); upgraded.delete(socket); upgraded.delete(remote); };
      socket.on('error', cleanup); remote.on('error', cleanup);
      socket.on('close', cleanup); remote.on('close', cleanup);
      remote.once('connect', () => {
        upgradedCount++;
        const lines = [`GET ${request.url} HTTP/1.1`];
        for (let i = 0; i < request.rawHeaders.length; i += 2)
          lines.push(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}`);
        remote.write(lines.join('\r\n') + '\r\n\r\n');
        if (head.length) remote.write(head);
        socket.pipe(remote).pipe(socket);
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return { origin: `http://127.0.0.1:${server.address().port}`, outDir, entries: build.entries,
      get upgradedCount() { return upgradedCount; }, waitForCreatedRoom, armVoteReceiptLoss,
      async stop() { participantJoinObserver?.close(); for (const socket of upgraded) socket.destroy();
        await new Promise(resolve => server.close(resolve)); rmSync(temp, { recursive: true, force: true }); } };
  } catch (error) { rmSync(temp, { recursive: true, force: true }); throw error; }
}
