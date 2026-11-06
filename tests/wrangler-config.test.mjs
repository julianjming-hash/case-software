// wrangler.toml: Case's rate-limit namespaces never collide with iatrogenic's on the shared Cloudflare
// account (CASE-111). namespace_id is account-scoped; 1xxx belongs to iatrogenic, 2000-2999 to Case.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');

test('[CASE-111] every Case rate-limit namespace_id is in 2000-2999 and unique', () => {
  const blocks = toml.split(/^\[\[ratelimits\]\]\s*$/m).slice(1);
  assert.ok(blocks.length >= 3, 'the Worker declares its rate limiters');
  const ids = blocks.map((b) => {
    const m = b.match(/^namespace_id\s*=\s*"?(\d+)"?\s*$/m);
    assert.ok(m, `a [[ratelimits]] block without a numeric namespace_id:\n${b}`);
    return Number(m[1]);
  });
  for (const id of ids) assert.ok(id >= 2000 && id <= 2999, `namespace_id ${id} is outside Case's 2000-2999 range (1xxx is iatrogenic's)`);
  assert.equal(new Set(ids).size, ids.length, 'namespace_ids are unique');
});

test('deployed environments explicitly isolate routes, vars, limit counters and own Durable Objects', () => {
  assert.doesNotMatch(toml, /mode\s*=\s*["']smart["']/);
  const section = name => {
    const found = toml.match(new RegExp(`^\\[env\\.${name}\\]\\s*$`, 'm'));
    assert.ok(found, `${name} environment must be explicit`);
    const rest = toml.slice(found.index); const next = rest.slice(1).search(/^\[env\.[a-z]+\]\s*$/m);
    return next < 0 ? rest : rest.slice(0, next + 1);
  };
  const prod = section('production'); const stage = section('staging');
  const ids = block => [...block.matchAll(/^namespace_id\s*=\s*"(\d+)"/gm)].map(m => Number(m[1]));
  // 2006/2016: the invitation peek (CASE-341, INVITE_PEEK).
  assert.deepEqual(ids(prod), [2001, 2002, 2003, 2005, 2006]); assert.deepEqual(ids(stage), [2011, 2012, 2013, 2015, 2016]);
  assert.equal(new Set([...ids(prod), ...ids(stage)]).size, 10);
  for (const [name, block, host, worker] of [['production', prod, 'software.example.invalid', 'case'], ['staging', stage, 'staging.example.invalid', 'case-staging']]) {
    assert.match(block, new RegExp(`^name = "${worker}"$`, 'm'));
    assert.match(block, new RegExp(`CASE_ENV = "${name}"`)); assert.match(block, /CASE_DEV_INLINE_CASES = "0"/);
    assert.match(block, new RegExp(`routes = \\[\\{ pattern = "${host.replaceAll('.', '\\.')}"[,] custom_domain = true \\}\\]`));
    assert.equal([...block.matchAll(/class_name = "(RoomDO|DirectoryDO)"/g)].length, 2);
    assert.doesNotMatch(block, /script_name\s*=/, 'DOs must belong to this Worker, not a shared production script');
    assert.doesNotMatch(block, /SUPABASE_(SECRET_KEY|JWT_SECRET)\s*=/);
  }
  // CASE-159: staging shares the production Supabase project's public URLs (never its secrets or pilot pin).
  for (const key of ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_JWT_ISSUER', 'SUPABASE_JWKS_URL']) {
    const value = block => block.match(new RegExp(`^${key} = "([^"]*)"$`, 'm'))?.[1];
    assert.ok(value(prod), `${key} must be set for production`);
    assert.equal(value(stage), value(prod), `${key} must match production for staging (CASE-159)`);
  }
  assert.match(stage, /CASE_PILOT_VERSION_ID = ""/); assert.match(stage, /CASE_PILOT_CONTENT_SHA256 = ""/);
});

test('[CASE-137] production names its admins and its one admin-write origin; staging inherits neither', () => {
  const block = name => { const rest = toml.slice(toml.search(new RegExp(`^\\[env\\.${name}\\.vars\\]`, 'm'))); return rest.slice(0, rest.slice(1).search(/^\[/m) + 1); };
  const prod = block('production'); const stage = block('staging');
  const admins = prod.match(/^ADMIN_EMAILS = "([^"]+)"$/m)?.[1];
  assert.ok(admins, 'production must declare ADMIN_EMAILS or nobody can open /admin');
  for (const address of admins.split(',').map(value => value.trim()))
    assert.equal(address, address.toLowerCase(), 'the gate matches the verified email exactly, so entries are lowercase');
  assert.match(prod, /^CASE_PUBLIC_ORIGIN = "https:\/\/software\.example\.invalid"$/m);
  assert.doesNotMatch(stage, /^ADMIN_EMAILS =/m, 'staging admins are a separate, deliberate choice');
  assert.doesNotMatch(stage, /^CASE_PUBLIC_ORIGIN = "https:\/\/software\.example\.invalid"$/m, 'staging never accepts the production origin');
  assert.doesNotMatch(prod + stage, /STEPUP_SECRET\s*=/, 'STEPUP_SECRET is a Wrangler secret, never a var');
});

test('production and staging both declare weekly keepalive and hourly catch-up schedules', () => {
  for (const prefix of ['', 'env.production.', 'env.staging.']) {
    const heading = `[${prefix}triggers]`;
    const start = toml.indexOf(heading);
    assert.ok(start >= 0, `${heading} is missing`);
    const block = toml.slice(start + heading.length).split(/^\[/m)[0];
    assert.match(block, /^crons\s*=\s*\["37 3 \* \* 1", "17 \* \* \* \*", "47 \* \* \* \*"\]/m);
  }
});
