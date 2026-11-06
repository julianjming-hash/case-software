import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { fileURLToPath } from 'node:url';
import { uuidv7 } from '../src/shared/ids.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const issuer = 'https://local.invalid/auth/v1';
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

async function signingKey(alg) {
  const spec = alg === 'ES256'
    ? { name: 'ECDSA', namedCurve: 'P-256' }
    : { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
  const pair = await crypto.subtle.generateKey(spec, true, ['sign', 'verify']);
  const kid = alg.toLowerCase();
  const jwk = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid, alg, use: 'sig' };
  const sub = uuidv7();
  const nowMs = Date.now();
  const input = `${encode({ alg, kid })}.${encode({ sub, iss: issuer, aud: 'authenticated', role: 'authenticated', exp: Math.floor(nowMs / 1000) + 3600 })}`;
  const signature = await crypto.subtle.sign(alg === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : spec, pair.privateKey, new TextEncoder().encode(input));
  return { jwk, sub, nowMs, token: `${input}.${Buffer.from(signature).toString('base64url')}` };
}

async function nativeWorker(outbound) {
  const result = await build({
    stdin: { contents: `
      import { verifyFacilitatorJwt } from './src/worker/auth.mjs';
      export default { async fetch(request) {
        const { token, nowMs } = await request.json();
        try {
          const user = await verifyFacilitatorJwt(token, {
            CASE_ENV: 'test-deployed', SUPABASE_URL: 'https://local.invalid',
            SUPABASE_JWT_ISSUER: '${issuer}', SUPABASE_JWKS_URL: 'https://local.invalid/jwks'
          }, { nowMs });
          return Response.json(user || { error: 'unauthorized' }, { status: user ? 200 : 401 });
        } catch (error) {
          if (error.code !== 'auth_unavailable') throw error;
          return Response.json({ error: 'auth_unavailable' }, { status: 503 });
        }
      } };`, resolveDir: root },
    bundle: true, write: false, format: 'esm', platform: 'browser',
  });
  return new Miniflare(convertV4MiniflareOptions({
    script: result.outputFiles[0].text, modules: true, compatibilityDate: '2026-08-22',
    // Native workerd fetch reaches this local hook; unmatched destinations cannot reach DNS.
    outboundService: (request) => {
      assert.equal(new URL(request.url).origin, 'https://local.invalid');
      return outbound(request);
    },
  }));
}

const verify = (mf, key, nowMs = key.nowMs) => mf.dispatchFetch('http://localhost/', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: key.token, nowMs }),
});

test('[AS-067] native workerd fetch verifies ES256 and RS256 JWKS responses', async () => {
  const keys = await Promise.all(['ES256', 'RS256'].map(signingKey));
  let calls = 0;
  const mf = await nativeWorker((request) => {
    assert.equal(new URL(request.url).pathname, '/jwks');
    calls++;
    return Response.json({ keys: keys.map((key) => key.jwk) });
  });
  try {
    for (const key of keys) {
      const response = await verify(mf, key);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { userId: key.sub, email: null, sessionId: null });
    }
    assert.equal(calls, 1);
  } finally { await mf.dispose(); }
});

test('native workerd fetch refuses cold JWKS redirects without following their target', async () => {
  const key = await signingKey('ES256');
  const paths = [];
  const mf = await nativeWorker((request) => {
    const path = new URL(request.url).pathname;
    paths.push(path);
    return path === '/jwks' ? new Response(null, { status: 302, headers: { location: 'https://local.invalid/redirected' } }) : Response.json({ keys: [key.jwk] });
  });
  try {
    const response = await verify(mf, key);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'auth_unavailable' });
    assert.deepEqual(paths, ['/jwks']);
  } finally { await mf.dispose(); }
});

test('native workerd fetch preserves warm trusted keys when a stale JWKS redirects', async () => {
  const key = await signingKey('ES256');
  const paths = [];
  let redirect = false;
  const mf = await nativeWorker((request) => {
    const path = new URL(request.url).pathname;
    paths.push(path);
    return redirect && path === '/jwks'
      ? new Response(null, { status: 307, headers: { location: 'https://local.invalid/redirected' } })
      : Response.json({ keys: [key.jwk] });
  });
  try {
    assert.equal((await verify(mf, key)).status, 200);
    redirect = true;
    const response = await verify(mf, key, key.nowMs + 11 * 60_000);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { userId: key.sub, email: null, sessionId: null });
    assert.deepEqual(paths, ['/jwks', '/jwks']);
  } finally { await mf.dispose(); }
});
