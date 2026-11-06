import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInfo, withSecurityHeaders } from '../src/worker/headers.mjs';

test('build metadata echoes only a validated public SHA and known environment', () => {
  const build = 'a'.repeat(40);
  assert.deepEqual(buildInfo({ BUILD_SHA: build, CASE_ENV: 'staging' }), { build, env: 'staging', wire: 1 });
  assert.equal(withSecurityHeaders(new Response('{}'), 'json', { BUILD_SHA: build }).headers.get('x-case-build'), build);
  const untrusted = { BUILD_SHA: 'never-echo-this-value', CASE_ENV: 'never-echo-this-env' };
  assert.deepEqual(buildInfo(untrusted), { build: 'unconfigured', env: 'local', wire: 1 });
  assert.equal(withSecurityHeaders(new Response('{}'), 'json', untrusted).headers.get('x-case-build'), 'unconfigured');
});

for (const [name, invalid] of [
  ['terminal newline', 'a'.repeat(40) + '\n'],
  ['array', ['a'.repeat(40)]],
  ['object', { toString: () => 'a'.repeat(40) }],
]) test(`build provenance rejects a ${name} binding without echoing it`, () => {
  const bindings = { BUILD_SHA: invalid, CASE_ENV: 'staging' };
  assert.equal(buildInfo(bindings).build, 'unconfigured');
  assert.equal(withSecurityHeaders(new Response('{}'), 'json', bindings).headers.get('x-case-build'), 'unconfigured');
});
