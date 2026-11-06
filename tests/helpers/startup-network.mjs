// Measurement-only origin-wide downlink: every page/SW asset competes for one byte lane.
// A page CDP throughput setting alone does not establish SW target throttling.
import { createServer, request as requestHttp } from 'node:http';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
const pause = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
export function stageForPath(path) {
  if (path === '/sw.mjs') return 'sw-script';
  if (path.startsWith('/assets/')) return path.split('/').at(-1);
  if (path === '/api/v1/config') return 'config';
  if (path === '/api/v1/me') return 'membership';
  if (path === '/api/v1/me/rooms') return 'owner-list';
  if (/\/catalogue(?:\/audiences|\/groups)?$/.test(path)) return path.split('/').at(-1);
  return path.startsWith('/api/') ? 'other-api' : 'public-document';
}
export async function startStartupNetwork({ upstream, latencyMs = 75, bytesPerSecond = 1_000_000 }) {
  const target = new URL(upstream);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !Number.isFinite(bytesPerSecond) || bytesPerSecond < 1) throw Error('local_measure_origin_required');
  let nextByte = performance.now(), trial = null;
  const reserve = async bytes => { const now = performance.now(), end = Math.max(now, nextByte) + bytes * 1000 / bytesPerSecond; nextByte = end; await pause(end - now); };
  const sockets = new Set();
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname, current = trial;
    const row = { stage: stageForPath(path), start: Date.now(), end: null, bytes: 0, method: request.method };
    current?.requests.push(row);
    try {
      await pause(latencyMs);
      if (current?.holdArt && /^\/assets\/splash\.[a-f0-9]{64}\.mjs$/.test(path)) await current.artGate;
      if (response.destroyed) return;
      const upstreamRequest = requestHttp(target.origin + request.url, { method: request.method, headers: { ...request.headers, host: target.host } });
      const resultReady = once(upstreamRequest, 'response'); request.pipe(upstreamRequest);
      request.once('aborted', () => upstreamRequest.destroy());
      const [result] = await resultReady; row.status = result.statusCode;
      response.writeHead(result.statusCode, result.headers);
      for await (const buffer of result) for (let offset = 0; offset < buffer.length; offset += 16_384) {
        const chunk = buffer.subarray(offset, offset + 16_384); await reserve(chunk.length);
        if (response.destroyed) { result.destroy(); return; }
        row.bytes += chunk.length; if (!response.write(chunk)) await once(response, 'drain');
      }
      response.end();
    } catch { if (!response.destroyed) response.destroy(); }
    finally { row.end = Date.now(); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { origin: `http://127.0.0.1:${server.address().port}`,
    begin({ holdArt = false } = {}) { let releaseArt; trial = { holdArt, requests: [], artGate: new Promise(resolve => { releaseArt = resolve; }), releaseArt }; nextByte = performance.now(); return trial; },
    async stop() { trial?.releaseArt(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); },
  };
}
