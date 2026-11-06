// The real Worker in local workerd behind a fake Supabase origin whose replies and delays the test controls.
// The wrapper records the Worker's fixed-schema log lines (GET /__logs). No Supabase project is contacted.
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { fileURLToPath } from 'node:url';
import { signTestJwt } from '../../src/worker/auth.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
export const FAKE_SECRET = 'test-only-secret-not-for-production';
export const FAKE_ORIGIN = 'https://postgrest.test';

/** `upstream(name)` answers each outbound call by its last path segment (an RPC name or `jwks.json`). */
export async function startFakeUpstreamWorker(upstream, bindings = {}) {
  const bundled = await build({ stdin: { contents: `
    import Worker from './src/worker/index.mjs';
    export { RoomDO, DirectoryDO, AlertDO } from './src/worker/index.mjs';
    const lines = [];
    console.error = line => lines.push(line);
    export default { async fetch(request, env, ctx) {
      if (new URL(request.url).pathname === '/__logs') return Response.json(lines.splice(0));
      return Worker.fetch(request, env, ctx);
    } };`, resolveDir: root }, bundle: true, write: false, format: 'esm', platform: 'neutral',
  target: 'es2022', loader: { '.sql': 'text' }, external: ['cloudflare:workers'] });
  const mf = new Miniflare(convertV4MiniflareOptions({ host: '127.0.0.1', port: 0, rootPath: root,
    script: bundled.outputFiles[0].text, modules: true, compatibilityDate: '2026-08-22',
    bindings: { BUILD_SHA: 'a'.repeat(40), SUPABASE_JWT_SECRET: FAKE_SECRET, CASE_ALLOW_HS256: '1',
      SUPABASE_URL: `${FAKE_ORIGIN}/`, SUPABASE_SECRET_KEY: 'sb_secret_test_only', ...bindings },
    durableObjects: { ROOM: { className: 'RoomDO', useSQLite: true }, DIRECTORY: { className: 'DirectoryDO', useSQLite: true },
      ALERTS: { className: 'AlertDO', useSQLite: true } },
    outboundService: async request => {
      if (new URL(request.url).origin !== FAKE_ORIGIN) throw new Error('Unexpected outbound host in fake-upstream test');
      return upstream(new URL(request.url).pathname.split('/').pop());
    } }));
  try {
    const origin = (await mf.ready).origin;
    return { origin, stop: () => mf.dispose(),
      logs: async () => (await (await fetch(`${origin}/__logs`)).json()).map(line => JSON.parse(line)) };
  } catch (error) { await mf.dispose(); throw error; }
}

export const fakeJwt = userId => signTestJwt({ sub: userId, aud: 'authenticated', role: 'authenticated',
  exp: Math.floor(Date.now() / 1000) + 3600 }, FAKE_SECRET);

/** An ES256 key pair, its public JWK and a signer, for tests that exercise JWKS. */
export async function es256Signer() {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', keys.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
  const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const sign = async claims => {
    const head = `${b64({ alg: 'ES256', kid: 'k1', typ: 'JWT' })}.${b64(claims)}`;
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, new TextEncoder().encode(head));
    return `${head}.${Buffer.from(signature).toString('base64url')}`;
  };
  return { jwk, sign };
}
