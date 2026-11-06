import { describe, expect, it, beforeAll, vi } from 'vitest';
import { verifyFacilitatorJwt, AuthUnavailableError, signTestJwt } from '../../src/worker/auth.mjs';
import { supabaseConfig, ConfigError } from '../../src/worker/supabase-keys.mjs';
import { uuidv7 } from '../../src/shared/ids.mjs';
import worker from '../../src/worker/index.mjs';

const enc = new TextEncoder();
const b64 = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const json64 = (value) => b64(enc.encode(JSON.stringify(value)));
const issuer = 'https://local.invalid/auth/v1';
let pairES, pairRS, jwkES, jwkRS;

beforeAll(async () => {
  pairES = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  pairRS = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  jwkES = { ...await crypto.subtle.exportKey('jwk', pairES.publicKey), kid: 'es-1', alg: 'ES256', use: 'sig' };
  jwkRS = { ...await crypto.subtle.exportKey('jwk', pairRS.publicKey), kid: 'rs-1', alg: 'RS256', use: 'sig' };
});

const env = (suffix = crypto.randomUUID()) => ({ CASE_ENV: 'test-deployed', SUPABASE_URL: 'https://local.invalid', SUPABASE_JWT_ISSUER: issuer, SUPABASE_JWKS_URL: `https://local.invalid/${suffix}` });
const claims = (extra = {}) => ({ sub: uuidv7(), aud: 'authenticated', role: 'authenticated', iss: issuer, exp: Math.floor(Date.now() / 1000) + 3600, ...extra });
const response = (keys) => new Response(JSON.stringify({ keys }), { status: 200 });
const fetchKeys = (keys) => async () => response(keys);

async function token(alg, kid, body = claims(), header = {}) {
  const head = `${json64({ typ: 'JWT', alg, kid, ...header })}.${json64(body)}`;
  const key = alg === 'ES256' ? pairES.privateKey : pairRS.privateKey;
  const sig = await crypto.subtle.sign(alg === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' }, key, enc.encode(head));
  return `${head}.${b64(new Uint8Array(sig))}`;
}

describe('facilitator JWKS', () => {
  it('[AS-067] verifies ES256 and RS256 and refuses algorithm downgrade or malformed claims', async () => {
    const e = env();
    const fetchJwks = fetchKeys([jwkES, jwkRS]);
    expect((await verifyFacilitatorJwt(await token('ES256', 'es-1'), e, { fetchJwks }))?.userId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await verifyFacilitatorJwt(await token('RS256', 'rs-1'), e, { fetchJwks }))?.userId).toMatch(/^[0-9a-f-]{36}$/);
    const bad = [
      await token('ES256', 'missing'), await token('ES256', '../es-1'),
      await token('ES256', 'es-1', claims({ iss: 'https://wrong.invalid' })),
      await token('ES256', 'es-1', claims({ exp: 1 })),
      await token('ES256', 'es-1', claims({ nbf: Math.floor(Date.now() / 1000) + 3600 })),
      await token('ES256', 'es-1', claims({ is_anonymous: true })),
      await token('ES256', 'es-1', claims({ sub: 'not-a-uuid' })),
      await token('RS256', 'rs-1', claims(), { alg: 'ES256' }),
      `${json64({ alg: 'none', kid: 'es-1' })}.${json64(claims())}.`,
      await signTestJwt(claims(), 'throwaway'),
    ];
    for (const value of bad) expect(await verifyFacilitatorJwt(value, e, { fetchJwks })).toBeNull();
  });

  it('[AS-067] accepts a rotated key after one refresh and throttles unknown kids', async () => {
    const e = env();
    let calls = 0;
    let keys = [jwkES];
    const fetchJwks = async () => { calls++; return response(keys); };
    expect(await verifyFacilitatorJwt(await token('ES256', 'es-1'), e, { fetchJwks })).toBeTruthy();
    keys = [jwkES, jwkRS];
    expect(await verifyFacilitatorJwt(await token('RS256', 'rs-1'), e, { fetchJwks })).toBeTruthy();
    expect(calls).toBe(2);
    const unknown = await token('ES256', 'unknown');
    await Promise.all(Array.from({ length: 100 }, () => verifyFacilitatorJwt(unknown, e, { fetchJwks })));
    expect(calls).toBe(2);
    const separate = env();
    let coldCalls = 0;
    const coldFetch = async () => { coldCalls++; return response([jwkES]); };
    await Promise.all(Array.from({ length: 100 }, () => verifyFacilitatorJwt(unknown, separate, { fetchJwks: coldFetch })));
    expect(coldCalls).toBe(1);
  });

  it('uses warm keys when JWKS fails, but cold failure is auth_unavailable', async () => {
    const e = env();
    const valid = await token('ES256', 'es-1');
    expect(await verifyFacilitatorJwt(valid, e, { fetchJwks: fetchKeys([jwkES]) })).toBeTruthy();
    expect(await verifyFacilitatorJwt(valid, e, { nowMs: Date.now() + 11 * 60_000, fetchJwks: async () => { throw Error('down'); } })).toBeTruthy();
    await expect(verifyFacilitatorJwt(valid, env(), { fetchJwks: async () => { throw Error('down'); } })).rejects.toMatchObject({ name: 'AuthUnavailableError', code: 'auth_unavailable' });
  });

  it('backs off repeated cold and stale JWKS failures for 60 seconds', async () => {
    const valid = await token('ES256', 'es-1');
    const base = Date.now();
    const coldEnv = env();
    let coldCalls = 0;
    const coldFetch = async () => { coldCalls++; throw Error('down'); };
    for (let i = 0; i < 3; i++) {
      await expect(verifyFacilitatorJwt(valid, coldEnv, { nowMs: base + i, fetchJwks: coldFetch })).rejects.toBeInstanceOf(AuthUnavailableError);
    }
    expect(coldCalls).toBe(1);
    await expect(verifyFacilitatorJwt(valid, coldEnv, { nowMs: base + 60_001, fetchJwks: coldFetch })).rejects.toBeInstanceOf(AuthUnavailableError);
    expect(coldCalls).toBe(2);

    const warmEnv = env();
    let warmCalls = 0;
    let down = false;
    const warmFetch = async () => { warmCalls++; if (down) throw Error('down'); return response([jwkES]); };
    expect(await verifyFacilitatorJwt(valid, warmEnv, { nowMs: base, fetchJwks: warmFetch })).toBeTruthy();
    down = true;
    for (let i = 0; i < 3; i++) {
      expect(await verifyFacilitatorJwt(valid, warmEnv, { nowMs: base + 11 * 60_000 + i, fetchJwks: warmFetch })).toBeTruthy();
    }
    expect(warmCalls).toBe(2);
    expect(await verifyFacilitatorJwt(valid, warmEnv, { nowMs: base + 12 * 60_000 + 1, fetchJwks: warmFetch })).toBeTruthy();
    expect(warmCalls).toBe(3);
  });

  it('replaces a JWKS fetch stranded by another request instead of awaiting it (2026-10-17 incident)', async () => {
    // Workers cancel a finished or disconnected request's I/O and timers. A fetch it started, shared at
    // module scope, then never settles, and every later sign-in in that isolate would wait on it.
    const e = env();
    const valid = await token('ES256', 'es-1');
    const base = Date.now();
    let calls = 0;
    const stranded = () => { calls++; return new Promise(() => {}); };
    verifyFacilitatorJwt(valid, e, { nowMs: base, fetchJwks: stranded }).catch(() => {});
    const fresh = async () => { calls++; return response([jwkES]); };
    const started = Date.now();
    expect(await verifyFacilitatorJwt(valid, e, { nowMs: base + 4_500, fetchJwks: fresh })).toBeTruthy();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(calls).toBe(2);
  });

  it('returns HTTP 503 auth_unavailable for a cold JWKS outage', async () => {
    vi.stubGlobal('fetch', async () => { throw Error('simulated JWKS outage'); });
    try {
      const request = new Request('https://case.test/api/v1/sessions', { method: 'POST', headers: { authorization: `Bearer ${await token('ES256', 'es-1')}` } });
      const res = await worker.fetch(request, env());
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'auth_unavailable' });
    } finally { vi.unstubAllGlobals(); }
  });

  it('refuses oversized JWKS, too many keys and unsafe kid without exposing token data', async () => {
    const valid = await token('ES256', 'es-1');
    await expect(verifyFacilitatorJwt(valid, env(), { fetchJwks: fetchKeys(Array(21).fill(jwkES)) })).rejects.toBeInstanceOf(AuthUnavailableError);
    await expect(verifyFacilitatorJwt(valid, env(), { fetchJwks: async () => new Response('x'.repeat(65_537)) })).rejects.toBeInstanceOf(AuthUnavailableError);
    expect(await verifyFacilitatorJwt(await token('ES256', 'x'.repeat(300)), env(), { fetchJwks: fetchKeys([jwkES]) })).toBeNull();
  });
});

describe('Supabase configuration', () => {
  it('requires deployed JWKS settings and rejects HS256 or malformed key prefixes without values in errors', () => {
    const cases = [
      { ...env(), SUPABASE_JWT_ISSUER: undefined },
      { ...env(), CASE_ALLOW_HS256: '1' },
      { ...env(), SUPABASE_SECRET_KEY: 'wrong-private-value' },
      { ...env(), SUPABASE_PUBLISHABLE_KEY: 'wrong-public-value' },
    ];
    for (const value of cases) {
      try { supabaseConfig(value); throw Error('accepted'); }
      catch (error) { expect(error).toBeInstanceOf(ConfigError); expect(error.message).not.toContain('wrong-'); }
    }
    expect(supabaseConfig(env()).allowHs256).toBe(false);
  });
});
