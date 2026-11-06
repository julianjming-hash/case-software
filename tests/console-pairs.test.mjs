import assert from 'node:assert/strict';
import { test } from 'node:test';
import { devicePreview, publicAuthConfig } from '../src/worker/console-pairs.mjs';

test('[AS-080] device preview returns only browser family, coarse location and server time', () => {
  const request = { headers: new Headers({ 'user-agent': 'Mozilla/5.0 Chrome/120.1 private-fingerprint',
    'cf-connecting-ip': '203.0.113.9', authorization: 'Bearer should-never-echo' }),
  cf: { country: 'AU', city: 'Perth', latitude: '-31.95', longitude: '115.86' } };
  const preview = devicePreview(request, 1_780_000_000_000);
  assert.deepEqual(preview, { browser: 'Chrome', country: 'AU', city: 'Perth', requestedAt: '2026-05-28T20:26:40.000Z' });
  const serialized = JSON.stringify(preview);
  for (const forbidden of ['203.0.113.9', 'should-never-echo', 'private-fingerprint', '-31.95']) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('public Auth config returns only selected HTTPS Auth origin and publishable values; missing config fails closed', () => {
  const configured = {
    CASE_ENV: 'staging', SUPABASE_URL: 'https://staging.example.invalid',
    SUPABASE_JWT_ISSUER: 'https://staging.example.invalid/auth/v1',
    SUPABASE_JWKS_URL: 'https://staging.example.invalid/auth/v1/.well-known/jwks.json',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', SUPABASE_SECRET_KEY: 'sb_secret_test',
    TURNSTILE_SITE_KEY: 'public-site-key',
  };
  assert.deepEqual(publicAuthConfig(configured), { supabaseUrl: 'https://staging.example.invalid',
    publishableKey: 'sb_publishable_test', turnstileSiteKey: 'public-site-key' });
  assert.equal(publicAuthConfig({ ...configured, SUPABASE_PUBLISHABLE_KEY: '' }), null);
  assert.equal(publicAuthConfig({ ...configured, SUPABASE_URL: 'http://staging.example.invalid' }), null);
  assert.equal(publicAuthConfig({ ...configured, SUPABASE_JWT_ISSUER: 'https://other.example.invalid/auth/v1' }), null);
});
