import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { refusedRoomWorkspaces } from '../src/worker/room-workspace-refusal.mjs';
import { isUuidV7 } from '../src/shared/ids.mjs';

// AUTONOMOUS-DEPLOY slice 5a (CASE-160, plan R10). The staging load account can sign in to production
// (shared Supabase project, CASE-159); production refuses rooms in the Load testing workspace so a
// leaked load credential cannot run rooms or meter production.
const LOAD_TESTING_WORKSPACE = '01a1aafa-0fcb-7606-9dd5-f96dd402c399';
const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
const section = name => { const start = toml.indexOf(`[${name}]\n`); assert.ok(start >= 0, name); const rest = toml.slice(start + name.length + 3); return rest.slice(0, rest.search(/^\[/m)); };
const value = (body, key) => body.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm'))?.[1];

test('[AS-100] production refuses the Load testing workspace; staging and local do not', () => {
  assert.equal(value(section('env.production.vars'), 'CASE_REFUSED_ROOM_WORKSPACES'), LOAD_TESTING_WORKSPACE);
  assert.equal(value(section('env.staging.vars'), 'CASE_REFUSED_ROOM_WORKSPACES'), undefined);
  assert.equal(value(section('vars'), 'CASE_REFUSED_ROOM_WORKSPACES'), undefined);
});
test('the refusal list parses comma-separated UUIDv7s and nothing else counts', () => {
  assert.deepEqual([...refusedRoomWorkspaces({ CASE_REFUSED_ROOM_WORKSPACES: ` ${LOAD_TESTING_WORKSPACE} ,, ` })], [LOAD_TESTING_WORKSPACE]);
  assert.equal(refusedRoomWorkspaces({}).size, 0);
  assert.equal(refusedRoomWorkspaces({ CASE_REFUSED_ROOM_WORKSPACES: 'not-a-uuid' }).size, 0);
  assert.ok(isUuidV7(LOAD_TESTING_WORKSPACE));
});
