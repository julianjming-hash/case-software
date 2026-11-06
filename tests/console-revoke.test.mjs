// Card 35b, PERMISSIONS E27 / P-27 (CASE-177): the console's Consoles list. The list and the revoke go through the
// starter's account session only (never the room token), a failed list never loops requests, and the patched Room
// tab keeps card 37's rules: property handlers, id-based focus keys, no listener. The server side is
// tests/worker/console-revoke.test.mjs; the whole flow is e2e/console.spec.mjs [AS-109].
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createConsoles } from '../src/client/console-room-tab.mjs';

const SESSION = '0199a000-0000-7000-8000-000000000001';
function harness(replies) {
  const calls = [];
  globalThis.location = { origin: 'https://case.test' };
  globalThis.fetch = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.authorization, body: init.body ?? null });
    const reply = replies.shift();
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 });
  };
  const auth = { accessToken: () => 'account-jwt', restore: async () => 'account-jwt', sessionGeneration: () => 1,
    refresh: async () => false, handle401: async () => {} };
  let renders = 0, status = '';
  const list = createConsoles({ auth, sessionId: SESSION, render: () => { renders++; }, setStatus: text => { status = text; } });
  return { calls, list, renders: () => renders, status: () => status };
}

test('[AS-109] the console list is read with the account session and keeps only well-formed rows', async () => {
  const run = harness([{ body: { consoles: [{ id: 1, kind: 'starter', issuedAt: '2026-10-07T00:00:00.000Z' },
    { id: 2, kind: 'shared', issuedAt: '2026-10-07T00:01:00.000Z' }, { id: '3', kind: 'shared' }, { id: 4, kind: 'display' }] } }]);
  await run.list.load();
  assert.deepEqual(run.list.view().rows.map(row => row.id), [1, 2]);
  assert.deepEqual(run.calls, [{ url: `https://case.test/api/v1/sessions/${SESSION}/consoles`, method: 'GET', auth: 'Bearer account-jwt', body: null }]);
  assert.equal(run.renders(), 1);
});

test('[PM-27] a console paired before the update is listed as unknown, offers no Stop, and names Take over and End', async () => {
  const run = harness([{ body: { consoles: [{ id: 1, kind: 'unknown', issuedAt: '2026-10-07T00:00:00.000Z' }] } }]);
  await run.list.load();
  assert.deepEqual(run.list.view().rows.map(row => row.kind), ['unknown']);
  const source = readFileSync(new URL('../src/client/console-room-tab.mjs', import.meta.url), 'utf8');
  const section = source.slice(source.indexOf('function renderConsoles('), source.indexOf('/** The starter'));
  assert.match(section, /Console paired before an update · since \$\{since\} · use Take over or End case to remove it/);
  assert.match(section, /if \(shared\) row\.append\(armable\(`revoke-console-/, 'only a shared computer gets a Stop control, confirmed in place');
  assert.match(source, /could not be stopped\. Refresh and try again; a console paired before an update needs Take over or End case\./);
});

test('[AS-109] stopping a shared computer posts only its id, says so, and lists again', async () => {
  const run = harness([{ body: { ok: true } }, { body: { consoles: [{ id: 1, kind: 'starter', issuedAt: '2026-10-07T00:00:00.000Z' }] } }]);
  await run.list.revoke(2);
  assert.deepEqual(run.calls.map(call => [call.url.replace('https://case.test/api/v1', ''), call.method, call.auth, call.body]), [
    [`/sessions/${SESSION}/consoles/revoke`, 'POST', 'Bearer account-jwt', '{"id":2}'],
    [`/sessions/${SESSION}/consoles`, 'GET', 'Bearer account-jwt', null]]);
  assert.equal(run.status(), 'Shared computer stopped. It has left this session.');
  assert.deepEqual(run.list.view().rows.map(row => row.kind), ['starter']);
});

test('[PM-27] a refused stop says so plainly; a failed list waits for Refresh instead of looping', async () => {
  const run = harness([{ status: 409, body: { error: 'not_shared_computer' } }, { status: 503, body: { error: 'unavailable' } }]);
  await run.list.revoke(1);
  assert.equal(run.status(), 'That shared computer could not be stopped. Refresh and try again; a console paired before an update needs Take over or End case.');
  assert.deepEqual(run.list.view(), { rows: null, failed: true });
  const source = readFileSync(new URL('../src/client/console-room-tab.mjs', import.meta.url), 'utf8');
  assert.match(source, /if \(!rows\) \{ if \(!failed\) consoles\.load\(\);/, 'the render loads only before a failure');
});

test('[PM-27] the Consoles section follows the patcher rules and never touches the room token', () => {
  const source = readFileSync(new URL('../src/client/console-room-tab.mjs', import.meta.url), 'utf8');
  const section = source.slice(source.indexOf('function renderConsoles('), source.indexOf('// "Use a shared computer"'));
  assert.ok(section.length > 200);
  assert.doesNotMatch(section, /addEventListener/);
  assert.match(section, /armable\(`revoke-console-\$\{entry\.id\}`/);
  // Take over (Julian, 2026-10-18): only when another console is connected, confirmed in place.
  assert.match(section, /if \(rows\?\.length > 1 && view\?\.actions\?\.includes\('takeover'\)/);
  assert.match(section, /keyed\('refresh-consoles'/);
  assert.match(section, /row\.dataset\.id = `console-\$\{entry\.id\}`/);
  assert.doesNotMatch(section, /\blink\b|facilitatorToken|token/i, 'the list and stop use the account session, never the room capability');
  // Only a console that holds the starter's account offers it: a shared computer has no auth.
  const room = readFileSync(new URL('../src/client/console-room.mjs', import.meta.url), 'utf8');
  assert.match(room, /consoles: \(\) => \(auth \? consoleList \?\?= roomTab\.createConsoles\(/);
});
