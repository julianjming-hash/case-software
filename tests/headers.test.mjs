import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withSecurityHeaders } from '../src/worker/headers.mjs';

const HTML = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; require-trusted-types-for 'script'; trusted-types case-default";
const JSON_CSP = "default-src 'none'; frame-ancestors 'none'";
for (const kind of ['json', 'html', 'asset', 'ws-refusal']) {
  test(`security policy for ${kind} preserves response and overrides unsafe headers`, async () => {
    const response = withSecurityHeaders(new Response('body', { status: 429, headers: { 'retry-after': '5', 'cache-control': 'public', 'content-security-policy': "script-src 'unsafe-inline'" } }), kind);
    assert.equal(response.status, 429);
    assert.equal(await response.text(), 'body');
    assert.equal(response.headers.get('retry-after'), '5');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('content-security-policy'), kind === 'html' ? HTML : JSON_CSP);
    assert.equal(response.headers.get('strict-transport-security'), 'max-age=63072000; includeSubDomains');
    assert.equal(response.headers.get('permissions-policy'), 'camera=(), screen-wake-lock=(self), window-management=(self)');
    assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  });
}
test('immutable asset caching requires explicit hashed-asset classification', () => {
  assert.equal(withSecurityHeaders(new Response('x'), 'immutable-asset').headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.throws(() => withSecurityHeaders(new Response('x'), 'unknown'), TypeError);
});

test('[AS-079] selected HTTPS Auth path alone enters HTML connect-src even before a public key is configured', () => {
  const env = { CASE_ENV: 'staging', SUPABASE_URL: 'https://staging.example.invalid',
    SUPABASE_JWT_ISSUER: 'https://staging.example.invalid/auth/v1',
    SUPABASE_JWKS_URL: 'https://staging.example.invalid/auth/v1/.well-known/jwks.json',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test' };
  const selected = withSecurityHeaders(new Response('html'), 'html', env).headers.get('content-security-policy');
  assert.match(selected, /connect-src 'self' https:\/\/staging\.example\.invalid\/auth\/v1\/;/);
  assert.equal(selected.includes('https://staging.example.invalid/rest/v1'), false);
  assert.equal(selected.includes('*'), false);
  assert.equal(withSecurityHeaders(new Response('html'), 'html', { ...env, SUPABASE_PUBLISHABLE_KEY: '' })
    .headers.get('content-security-policy'), selected);
  assert.equal(withSecurityHeaders(new Response('html'), 'html', { ...env, SUPABASE_JWT_ISSUER: 'https://other.invalid/auth/v1' })
    .headers.get('content-security-policy'), HTML);
});
