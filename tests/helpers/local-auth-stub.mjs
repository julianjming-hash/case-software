// A throwaway HTTPS GoTrue stub for browser tests. Certificates are generated in tmp,
// and every request stays on 127.0.0.1; no Supabase project is contacted.
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_BODY = 2048;
function readJson(request) {
  return new Promise(resolve => {
    const chunks = [];
    let bytes = 0;
    request.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BODY) { request.destroy(); resolve(null); return; }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(null); }
    });
    request.on('error', () => resolve(null));
  });
}

export async function startLocalAuthStub({ appOrigin, jwt, email = 'owner@example.invalid', otp = '123456' }) {
  const temp = mkdtempSync(join(tmpdir(), 'case-auth-stub-'));
  try {
    let allowedOrigin = appOrigin;
    const keyPath = join(temp, 'key.pem'), certPath = join(temp, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=127.0.0.1', '-keyout', keyPath, '-out', certPath], { stdio: 'ignore' });
    const requests = [];
    const server = createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, async (request, response) => {
      const path = new URL(request.url, 'https://127.0.0.1').pathname;
      requests.push({ method: request.method, path }); // no codes, tokens, names or body text in test logs
      const allowed = request.headers.origin === allowedOrigin;
      response.setHeader('access-control-allow-origin', allowed ? allowedOrigin : 'null');
      response.setHeader('access-control-allow-methods', 'POST, OPTIONS');
      response.setHeader('access-control-allow-headers', 'apikey, content-type, authorization');
      response.setHeader('cache-control', 'no-store');
      response.setHeader('content-type', 'application/json; charset=utf-8');
      if (!allowed) { response.writeHead(403).end('{"error":"forbidden"}'); return; }
      if (request.method === 'OPTIONS' && /^\/auth\/v1\/(otp|verify|token)$/.test(path)) {
        response.writeHead(204).end(); return;
      }
      if (request.method !== 'POST') { response.writeHead(404).end('{"error":"not_found"}'); return; }
      const body = await readJson(request);
      if (path === '/auth/v1/otp' && body?.email === email && body.create_user === false) {
        response.writeHead(200).end('{}'); return;
      }
      if (path === '/auth/v1/verify' && jwt && body?.email === email && body.token === otp && body.type === 'email') {
        const sub = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8')).sub;
        response.writeHead(200).end(JSON.stringify({ access_token: jwt, refresh_token: 'local-refresh-only',
          expires_in: 3600, user: { id: sub }, token_type: 'bearer' })); return;
      }
      if (path === '/auth/v1/token' && jwt && body?.auth_code === 'local-one-use-code' &&
          /^[A-Za-z0-9_-]{43,128}$/.test(body.code_verifier ?? '')) {
        const sub = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8')).sub;
        response.writeHead(200).end(JSON.stringify({ access_token: jwt, refresh_token: 'local-refresh-only',
          expires_in: 3600, user: { id: sub }, token_type: 'bearer' })); return;
      }
      if (path === '/auth/v1/token' && jwt && request.url === '/auth/v1/token?grant_type=refresh_token' &&
          body?.refresh_token === 'local-refresh-only') {
        const sub = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8')).sub;
        response.writeHead(200).end(JSON.stringify({ access_token: jwt, refresh_token: 'local-refresh-only',
          expires_in: 3600, user: { id: sub }, token_type: 'bearer' })); return;
      }
      response.writeHead(404).end('{"error":"not_found"}');
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return { origin: `https://127.0.0.1:${server.address().port}`, requests,
      setAppOrigin(value) { allowedOrigin = value; },
      setJwt(value) { jwt = value; },
      async stop() { await new Promise(resolve => server.close(resolve)); rmSync(temp, { recursive: true, force: true }); } };
  } catch (error) { rmSync(temp, { recursive: true, force: true }); throw error; }
}
