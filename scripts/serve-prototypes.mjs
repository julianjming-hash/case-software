// scripts/serve-prototypes.mjs: a static server for the stage C room lab (Playwright's webServer).
// Serves the repo root, because the lab imports `src/shared/*.mjs` and the fixture by relative path.
//
// With CASE_API_PROXY=<origin of a LOCAL Worker> (e.g. `wrangler dev`), it also forwards `/api/*`,
// WebSocket upgrades included, so the room windows and the Worker share one origin (the Worker is
// same-origin only: no CORS). Dev and tests only; it refuses anything but a localhost upstream.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const types = { '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json' };

/** Start the server. Resolves the `http.Server` once it is listening. */
export function startServer({ root = '.', port = 4173, apiProxy = null } = {}) {
  root = resolve(root);
  const upstream = apiProxy ? new URL(apiProxy) : null;
  if (upstream && !['127.0.0.1', 'localhost', '[::1]'].includes(upstream.hostname)) throw new Error('CASE_API_PROXY must be a local Worker (127.0.0.1 or localhost)');

  const server = createServer((request, response) => {
    // A malformed escape (`/%E0`) used to throw out of the handler and kill the server mid-suite.
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); } catch { response.writeHead(400).end('Bad request'); return; }
    if (upstream && pathname.startsWith('/api/')) {
      const up = httpRequest({ host: upstream.hostname, port: upstream.port, method: request.method, path: request.url, headers: { ...request.headers, host: upstream.host } }, (res) => {
        response.writeHead(res.statusCode, res.headers);
        res.pipe(response);
      });
      up.on('error', () => { if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' }); response.end('{"error":"upstream_unreachable"}'); });
      request.pipe(up);
      return;
    }
    const file = resolve(root, `.${pathname === '/' ? '/prototypes/room/index.html' : pathname}`);
    // `root + sep`, not `root`: a sibling folder sharing the prefix (case vs case-harness) is outside.
    if (!file.startsWith(root + sep) || !existsSync(file) || statSync(file).isDirectory()) {
      response.writeHead(404).end('Not found');
      return;
    }
    response.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    createReadStream(file).pipe(response);
  });

  // Upgraded sockets leave the server's connection list, so they are tracked here: `dropAll()` cuts
  // every connection at once, as a total outage would (the AS-061 e2e).
  const tunnels = new Set();
  server.dropAll = () => { server.closeAllConnections?.(); for (const s of tunnels) s.destroy(); tunnels.clear(); };

  // WebSocket upgrades to /api/* are piped to the Worker byte for byte.
  server.on('upgrade', (request, socket, head) => {
    if (!upstream || !request.url.startsWith('/api/')) { socket.destroy(); return; }
    const up = netConnect(Number(upstream.port), upstream.hostname, () => {
      const lines = [`${request.method} ${request.url} HTTP/1.1`];
      for (let i = 0; i < request.rawHeaders.length; i += 2) {
        const [k, v] = [request.rawHeaders[i], request.rawHeaders[i + 1]];
        lines.push(`${k}: ${k.toLowerCase() === 'host' ? upstream.host : v}`);
      }
      up.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head?.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    tunnels.add(socket); tunnels.add(up);
    const end = () => { socket.destroy(); up.destroy(); tunnels.delete(socket); tunnels.delete(up); };
    up.on('error', end);
    socket.on('error', end);
    up.on('close', () => socket.destroy());
    socket.on('close', () => up.destroy());
  });

  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolveListen(server));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4173);
  const apiProxy = process.env.CASE_API_PROXY || null;
  startServer({ root: process.argv[2] || '.', port, apiProxy })
    .then(() => console.log(`Case prototype server: http://127.0.0.1:${port}${apiProxy ? ` (/api → ${apiProxy})` : ''}`));
}
