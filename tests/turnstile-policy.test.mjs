import test from 'node:test';
import assert from 'node:assert/strict';
import { HTML_CSP, withSecurityHeaders } from '../src/worker/headers.mjs';
import { joinDocumentCsp } from '../src/worker/join-policy.mjs';

test('join document policy adds only exact widget script frame and ScriptURL policy permissions', () => {
  // CASE-284: the participant feedback page shows the same optional challenge on its first QR-path send.
  for (const path of ['/join', '/J/7K3QX9', '/j/7k3qx9', '/F/7K3QX9', '/f/7k3qx9']) {
    assert.equal(joinDocumentCsp(HTML_CSP, path), HTML_CSP
      .replace("script-src 'self';", "script-src 'self' https://challenges.cloudflare.com;")
      .replace("frame-ancestors 'none';", "frame-src https://challenges.cloudflare.com; frame-ancestors 'none';")
      .replace('trusted-types case-default', 'trusted-types case-default case-turnstile'));
  }
});

test('join policy preserves selected Auth path and leaves every nonjoin surface byte-identical', () => {
  const env = { CASE_ENV:'staging', SUPABASE_URL:'https://staging.example.invalid',
    SUPABASE_JWT_ISSUER:'https://staging.example.invalid/auth/v1', SUPABASE_JWKS_URL:'https://staging.example.invalid/auth/v1/.well-known/jwks.json' };
  const base = withSecurityHeaders(new Response(), 'html', env).headers.get('content-security-policy');
  for (const path of ['/', '/privacy', '/help', '/P/7K3QX9', '/D/7K3QX9', '/check', '/sw.mjs', '/sessions/id/play', '/sessions/id/recap', '/sessions/id/facilitate', '/J/7K3QX9/child', '/join/child', '/F/7K3QX9/child', '/F/U12345', '/feedback']) assert.equal(joinDocumentCsp(base,path),base);
  assert.ok(joinDocumentCsp(base,'/join').includes("connect-src 'self' https://staging.example.invalid/auth/v1/;"));
  assert.ok(joinDocumentCsp(base,'/join').includes("require-trusted-types-for 'script';"));
});

test('join policy fails closed on unsupported baseline script or Trusted Types policy shapes', () => {
  for (const base of [null, '', HTML_CSP.replace("script-src 'self';", "script-src *;"), HTML_CSP.replace('trusted-types case-default','trusted-types default'), HTML_CSP.replace("require-trusted-types-for 'script';",''), HTML_CSP.replace("frame-ancestors 'none';",'') + "; frame-ancestors 'none'", HTML_CSP + "; script-src 'self';"]) assert.throws(()=>joinDocumentCsp(base,'/join'),TypeError);
});

test('join document classification refuses invalid Crockford and nonexact raw paths', () => {
  for (const path of ['/J/U12345', '/j/u12345', '/J/7K3QX9\n', '/J/7K3Q', '/J/7K3QX9/child', '/J/7K3 Q9', '/J/7K3-Q9']) assert.equal(joinDocumentCsp(HTML_CSP,path),HTML_CSP);
  for (const path of ['/J/O12345', '/j/i12345', '/J/l12345']) assert.notEqual(joinDocumentCsp(HTML_CSP,path),HTML_CSP);
});

test('every entry document that may show the challenge runs the Worker first in every environment, so its policy applies', async () => {
  const { readFileSync } = await import('node:fs');
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  const lists = [...toml.matchAll(/^run_worker_first = (\[.*\])$/gm)].map((m) => JSON.parse(m[1]));
  assert.equal(lists.length, 3, 'default, production and staging');
  for (const list of lists) for (const path of ['/join', '/J/*', '/j/*', '/F/*', '/f/*']) assert.ok(list.includes(path), `${path} runs the Worker first`);
});
