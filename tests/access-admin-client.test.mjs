// Facilitator-UX A5 (plan §3 A5, AS-212): the Administration client. Step-up errors told apart from an outage, destructive
// dialogs that state their consequences, a workbench that never says "uncertain" when nothing ran, a whitespace-only
// search, a failed refresh that keeps the last data, plain messages for the refusals the Worker names, and the dead
// client paths gone. Pure state machines and static checks only: no DOM here (the screens are proved in
// e2e/access-admin.spec.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { adminMessage, stepUpMessage, stepUpFailure } from '../src/client/admin-messages.mjs';
import * as say from '../src/client/admin-consequences.mjs';
import { createAdminElevation } from '../src/client/admin-elevation.mjs';
import { createAdminConfirm } from '../src/client/admin-confirm.mjs';
import { createAdminModel } from '../src/client/admin-model.mjs';
import { createAdminApi } from '../src/client/admin-api.mjs';
import { acceptAdminResponse } from '../src/client/admin-schema.mjs';
import { activitySentence } from '../src/shared/admin-workbench.mjs';
import { storageSummary, quotaBytesFromGb, policyChanges } from '../src/client/admin-workspaces.mjs';

const read = file => readFileSync(new URL(`../src/client/${file}`, import.meta.url), 'utf8');
const src = file => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');

// ── Messages ─────────────────────────────────────────────────────────────────────────────────────────────────
test('[AS-212] every refusal the Worker names has its own plain message, and none shows a raw key', () => {
  const named = ['not_found', 'unauthorised', 'too_large', 'unsupported_media_type', 'code_rejected', 'step_up_required', 'conflict', 'forbidden', 'rate_limited',
    'request_timeout', 'bad_request', 'audit_unavailable', 'change_reverted_audit_unavailable', 'manual_reconciliation_needed', 'admin_unavailable'];
  const seen = new Set();
  for (const key of named) {
    const text = adminMessage(key);
    assert.ok(text && text.length > 20, key);
    assert.ok(!/[a-z]+_[a-z_]+/.test(text), `${key} shows a raw key: ${text}`);
    seen.add(text);
  }
  assert.equal(seen.size, named.length, 'each refusal is worded differently');
  for (const key of ['not_found', 'unauthorised', 'too_large', 'unsupported_media_type'])
    assert.notEqual(adminMessage(key), adminMessage('something_unknown'), `${key} fell through to the generic message`);
});

test('[AS-212] a code that did not work, a rate limit and an outage read differently, and say nothing was changed', () => {
  const wrong = stepUpMessage('code_rejected'), limited = stepUpMessage('rate_limited'), down = stepUpMessage('admin_unavailable');
  assert.equal(new Set([wrong, limited, down]).size, 3);
  assert.match(wrong, /wrong or has expired/i); assert.match(wrong, /new code/i);
  assert.match(limited, /too many/i);
  assert.match(down, /sign-in service/i); assert.match(down, /nothing was changed/i);
  assert.equal(stepUpMessage('request_timeout'), down);
  for (const text of [wrong, limited, down]) assert.match(text, /nothing was changed/i);
  // The elevation reports `code`; Groups once read `error` and so always said "unavailable".
  assert.equal(stepUpFailure({ ok: false, code: 'code_rejected' }), wrong);
  assert.equal(stepUpFailure({ ok: false, error: 'rate_limited' }), limited);
  assert.equal(stepUpFailure({ ok: false }), down);
});

test('[AS-212] Groups reads the step-up failure from `.code`, as the elevation provides it', () => {
  const groups = read('groups-screen.mjs');
  assert.doesNotMatch(groups, /sent\?\.error|verified\?\.error/, 'Groups reads .error, which the elevation never sets');
  assert.match(groups, /stepUpFailure\(sent\)/); assert.match(groups, /stepUpFailure\(verified\)/);
});

// ── Consequences ─────────────────────────────────────────────────────────────────────────────────────────────
test('[AS-212] destructive dialogs state what happens before the code is asked for', () => {
  const rooms = [{ participantCount: 14 }, { participantCount: 3 }];
  const disable = say.disable({ email: 'a.kaur@example.org', rooms }).join(' ');
  assert.match(disable, /signed out on every device/); assert.match(disable, /2 live rooms end now \(17 phones joined\)/); assert.match(disable, /Enable gives everything back/);
  assert.match(say.disable({ email: 'x@example.org', rooms: [] }).join(' '), /no live room/);
  assert.match(say.disable({ email: 'x@example.org', rooms: null }).join(' '), /Any room they are running ends now/);
  assert.equal(say.disableLabel(rooms), 'Disable and end 2 rooms'); assert.equal(say.disableLabel([rooms[0]]), 'Disable and end 1 room'); assert.equal(say.disableLabel([]), 'Disable');
  const del = say.softDelete({ email: 'x@example.org', rooms: [] }).join(' ');
  assert.match(del, /30 days/); assert.match(del, /Restore/); assert.match(del, /signed out on every device/);
  const remove = say.removeMember({ email: 'x@example.org', workspace: 'Northern ICU' }).join(' ');
  assert.match(remove, /loses access to every case in Northern ICU/); assert.match(remove, /keep going until they end/); assert.match(remove, /added again/);
  const role = say.changeRole({ email: 'x@example.org', workspace: 'Northern ICU', from: 'author', to: 'owner' }).join(' ');
  assert.match(role, /Can edit to Can manage/); assert.match(role, /publish/i);
  const withdraw = say.withdrawVersion({ title: 'Asthma', versionNo: 2 }).join(' ');
  assert.match(withdraw, /No one can start/); assert.match(withdraw, /already running are not ended/); assert.match(withdraw, /Republish/);
  assert.match(say.republishVersion({ title: 'Asthma', versionNo: 2 }).join(' '), /started again/);
  const end = say.endRoom({ participantCount: 14 }).join(' ');
  assert.match(end, /14 phones will see the end screen/); assert.match(say.endRoom({ participantCount: 1 }).join(' '), /1 phone will see the end screen/);
  assert.match(say.revokeInvitation({ email: 'x@example.org' }).join(' '), /stops working at once/);
  const gone = say.deleteUnused({ count: 3, bytes: 5_500_000 }).join(' ');
  assert.match(gone, /3 images \(5\.5 MB\)/); assert.match(gone, /cannot be recovered/);
  for (const text of [disable, del, remove, role, withdraw, end, gone]) assert.ok(!/[a-z]+_[a-z_]+/.test(text), text);
});

// ── The session's step-up ────────────────────────────────────────────────────────────────────────────────────
function elevationFixture(replies = {}) {
  const calls = []; let n = 0;
  const api = { async call(op) { calls.push(op); return replies[op]?.(++n) ?? (op === 'stepup_verify' ? { ok: true, data: { elevation: randomBytes(24).toString('hex') } } : { ok: true, data: { accepted: true } }); } };
  return { calls, elevation: createAdminElevation(api) };
}
test('[AS-212] the elevation lasts the sign-in session, reports failures as `code`, and is dropped on sign-out', async () => {
  const { calls, elevation } = elevationFixture({ stepup_start: () => ({ ok: false, status: 422, error: 'code_rejected' }) });
  assert.equal(elevation.has(), false);
  assert.deepEqual(await elevation.sendCode(), { ok: false, code: 'code_rejected' });
  const second = elevationFixture();
  assert.deepEqual(await second.elevation.sendCode(), { ok: true, code: undefined });
  assert.deepEqual(await second.elevation.verify('12345'), { ok: false, code: 'code_rejected' }, 'five digits never reach the server');
  assert.deepEqual(second.calls, ['stepup_start']);
  assert.deepEqual(await second.elevation.verify('123456'), { ok: true });
  assert.equal(second.elevation.has(), true); assert.ok(second.elevation.token());
  second.elevation.drop(); assert.equal(second.elevation.has(), false);
  assert.deepEqual(calls, ['stepup_start']);
  const third = elevationFixture(); await third.elevation.verify('123456'); third.elevation.clear(); assert.equal(third.elevation.has(), false);
  assert.equal(await third.elevation.verify('123456').then(r => r.ok), false, 'a cleared elevation is closed for good');
});

// ── The confirm dialog ───────────────────────────────────────────────────────────────────────────────────────
const spec = (run, elevation, extra = {}) => ({ title: 'Disable A. Kaur?', sub: 'a.kaur@example.org', consequences: ['One.', 'Two.'], actionLabel: 'Disable', elevation, run, ...extra });
test('[AS-212] without an elevation the dialog sends a code, then verifies it, then runs; wrong code stays in the code step and nothing runs', async () => {
  let ran = 0; const done = [];
  const flow = createAdminConfirm();
  const { elevation, calls } = elevationFixture({ stepup_verify: n => n === 1 ? { ok: false, status: 422, error: 'code_rejected' } : { ok: true, data: { elevation: 'tok-' + n } } });
  flow.open(spec(async token => { ran++; assert.ok(token); return { ok: true }; }, elevation, { onDone: r => done.push(r) }));
  assert.equal(flow.state.open, true); assert.equal(flow.state.phase, 'review'); assert.equal(flow.state.needsCode, true);
  assert.equal(await flow.proceed(), true); assert.equal(flow.state.phase, 'code'); assert.deepEqual(calls, ['stepup_start']);
  assert.equal(await flow.verify('12x456'), false); assert.deepEqual(calls, ['stepup_start'], 'a malformed code never reaches the server');
  assert.match(flow.state.notice, /six digits/i);
  assert.equal(await flow.verify('123456'), false);
  assert.equal(flow.state.phase, 'code'); assert.match(flow.state.notice, /wrong or has expired/i); assert.equal(ran, 0);
  assert.doesNotMatch(flow.state.notice, /uncertain|may or may not/i, 'nothing ran, so nothing is uncertain');
  assert.equal(await flow.verify('123456'), true); assert.equal(ran, 1); assert.equal(flow.state.open, false); assert.equal(done.length, 1); assert.equal(done[0].ok, true);
});

test('[AS-212] the workbench never says "uncertain" when nothing ran: a failed code request is a sign-in-service message', async () => {
  let ran = 0;
  const flow = createAdminConfirm();
  const { elevation } = elevationFixture({ stepup_start: () => ({ ok: false, status: 503, error: 'admin_unavailable' }) });
  flow.open(spec(async () => { ran++; return { ok: true }; }, elevation));
  assert.equal(await flow.proceed(), false);
  assert.equal(ran, 0); assert.equal(flow.state.phase, 'review'); assert.equal(flow.state.open, true);
  assert.match(flow.state.notice, /sign-in service/i); assert.match(flow.state.notice, /nothing was changed/i); assert.doesNotMatch(flow.state.notice, /uncertain/i);
  const limited = elevationFixture({ stepup_start: () => ({ ok: false, status: 429, error: 'rate_limited' }) });
  const second = createAdminConfirm(); second.open(spec(async () => { ran++; return { ok: true }; }, limited.elevation));
  await second.proceed(); assert.match(second.state.notice, /too many/i); assert.equal(ran, 0);
  // The workbench's own source no longer derives "uncertain" from a missing status.
  assert.doesNotMatch(read('admin-workbench.mjs'), /!error\.status\|\|error\.status>=500/);
});

test('[AS-212] only a request that was sent and not answered is uncertain; a refusal is not', async () => {
  const { elevation } = elevationFixture(); await elevation.verify('123456');
  const outcomes = [];
  for (const failure of [{ ok: false, status: 503, error: 'admin_unavailable' }, { ok: false, status: 0, error: 'request_timeout' }, { ok: false, status: 409, error: 'conflict' }, { ok: false, status: 404, error: 'not_found' }]) {
    const flow = createAdminConfirm(); let result = null;
    flow.open(spec(async () => failure, elevation, { onDone: r => { result = r; } }));
    await flow.proceed(); outcomes.push([failure.error, result?.uncertain === true, flow.state.open]);
  }
  assert.deepEqual(outcomes, [['admin_unavailable', true, false], ['request_timeout', true, false], ['conflict', false, false], ['not_found', false, false]]);
  // A 403 means the confirmation was refused: it is dropped, the dialog returns to its first step with the reason, nothing is uncertain.
  const flow = createAdminConfirm(); let ranAgain = 0;
  flow.open(spec(async () => { ranAgain++; return { ok: false, status: 403, error: 'forbidden' }; }, elevation));
  await flow.proceed();
  assert.equal(elevation.has(), false); assert.equal(flow.state.open, true); assert.equal(flow.state.phase, 'review'); assert.equal(flow.state.needsCode, true);
  assert.match(flow.state.notice, /Your access does not allow this action/);
  assert.match(flow.state.notice, /Account → Your access/);
  assert.match(flow.state.notice, /ask a Case administrator/);
});

test('[AS-212] with the session\'s code already given, or none needed, one press runs it; cancel fences a late result', async () => {
  const { elevation } = elevationFixture(); await elevation.verify('123456');
  const flow = createAdminConfirm(); let ran = 0;
  flow.open(spec(async () => { ran++; return { ok: true }; }, elevation)); assert.equal(flow.state.needsCode, false);
  assert.equal(await flow.proceed(), true); assert.equal(ran, 1);
  const plain = createAdminConfirm(); let tokenSeen = 'unset';
  plain.open(spec(async token => { tokenSeen = token; return { ok: true }; }, null)); assert.equal(plain.state.needsCode, false);
  await plain.proceed(); assert.equal(tokenSeen, null);
  let release; const done = [];
  const held = createAdminConfirm();
  held.open(spec(() => new Promise(resolve => { release = resolve; }), elevation, { onDone: r => done.push(r) }));
  const pending = held.proceed(); assert.equal(held.state.busy, true); assert.equal(await held.proceed(), false, 'single flight');
  held.cancel(); release({ ok: true }); await pending;
  assert.equal(held.state.open, false); assert.deepEqual(done.map(r => r.cancelled), [true], 'a late answer after Cancel is reported as the cancel it raced');
});

// ── The People model ─────────────────────────────────────────────────────────────────────────────────────────
const user = () => ({ id: randomUUID(), email: 'facilitator@example.invalid', profile: { admin_revision: 2 }, access: null });
const listing = rows => ({ ok: true, data: { users: rows, nextPage: null } });
test('[AS-212] a whitespace-only search is a plain list, and a padded one is trimmed', async () => {
  const calls = [];
  const model = createAdminModel({ api: { call: async (op, args) => { calls.push([op, args]); return listing([]); }, close() {} }, elevation: createAdminElevation({ call: async () => ({ ok: true, data: {} }) }) });
  await model.search('   ');
  assert.equal(calls[0][0], 'facilitators_list'); assert.equal(model.state.query, '');
  await model.search('  Ann@Example.org ');
  assert.equal(calls[1][0], 'facilitators_search'); assert.equal(calls[1][1].body.query, 'Ann@Example.org'); assert.equal(model.state.query, 'Ann@Example.org');
});

test('[AS-212] a failed refresh keeps the last data and says so; a background refresh never shows Loading', async () => {
  let answer = listing([user()]); const seen = [];
  const model = createAdminModel({ api: { call: async () => answer, close() {} }, elevation: createAdminElevation({ call: async () => ({ ok: true, data: {} }) }), onChange: s => seen.push(s.loading) });
  await model.load(); const rows = model.state.rows; assert.equal(rows.length, 1); assert.equal(model.state.gate, 'ready');
  seen.length = 0; answer = { ok: false, status: 503, error: 'admin_unavailable' };
  assert.equal(await model.load({ quiet: true }), false);
  assert.ok(!seen.includes(true), 'a background refresh flashed Loading');
  assert.equal(model.state.gate, 'ready'); assert.equal(model.state.rows, rows); assert.ok(model.state.refreshFailed); assert.match(model.state.notice, /could not refresh/i);
  // The same for a refresh the person asked for: the table stays; the notice says it is the last data.
  assert.equal(await model.load(), false); assert.equal(model.state.rows, rows); assert.equal(model.state.gate, 'ready');
  answer = listing([user(), user()]); assert.equal(await model.load({ quiet: true }), true);
  assert.equal(model.state.rows.length, 2); assert.equal(model.state.refreshFailed, false);
  // Sign-in or access really ending still blanks the table.
  answer = { ok: false, status: 403, error: 'forbidden' }; await model.load({ quiet: true });
  assert.equal(model.state.gate, 'admin_only'); assert.deepEqual(model.state.rows, []);
});

test('[AS-212] the model acts on accounts only; Cases, Rooms and the audit have no dead client path', () => {
  const api = read('admin-api.mjs'), shell = read('admin.mjs');
  for (const dead of ['cases_list', 'audit_list']) { assert.ok(!api.includes(dead), `admin-api still names ${dead}`); assert.equal(acceptAdminResponse(dead, {}), null); }
  assert.ok(!shell.includes('groupsView') && !shell.includes('groupsScreen'), 'the unreachable groupsView branch is gone from the shell');
  assert.ok(!read('admin-model.mjs').includes('cases_publish') && !read('admin-model.mjs').includes('rooms_end'));
  // Live rooms is the one list path left, and the Rooms section uses it.
  assert.ok(api.includes('rooms_list')); assert.match(read('admin-workbench.mjs'), /rooms_list/);
});

test('[AS-212] there is no image-review queue in Administration', () => {
  for (const file of readdirSync(new URL('../src/client/', import.meta.url)).filter(f => /^admin.*\.mjs$/.test(f))) {
    assert.doesNotMatch(read(file), /image-review|imageReview|Approve image|review queue|asset_approve/i, file);
  }
  assert.doesNotMatch(src('worker/admin/routes.mjs'), /review/i);
});

test('[AS-212] revoking an invitation states its consequences in a dialog, not a browser confirm()', () => {
  const invitations = read('admin-invitations.mjs');
  assert.doesNotMatch(invitations, /globalThis\.confirm|[^.\w]confirm\(/);
  assert.match(invitations, /revokeInvitation/);
});

// ── Activity, in words ───────────────────────────────────────────────────────────────────────────────────────
test('[AS-212] Activity reads each row as a sentence: who, what, and the place, never a raw key', () => {
  const at = '2026-11-03T01:02:03Z', id = randomUUID();
  const row = (action, actor_kind, extra = {}) => ({ id, action, actor_kind, actor_email: actor_kind === 'admin' ? 'julian@example.org' : null, target_type: 'invitation', target_id: id, at, ...extra });
  assert.equal(activitySentence(row('invitation_create', 'admin')), 'julian@example.org invited someone');
  assert.equal(activitySentence(row('invitation_revoke', 'owner')), 'An owner revoked an invitation');
  assert.equal(activitySentence(row('case_grant_revoke', 'owner', { target_type: 'grant' })), 'An owner ended a case share');
  assert.equal(activitySentence(row('case_archive', 'admin', { target_type: 'case' })), 'julian@example.org archived a case');
  assert.equal(activitySentence(row('invitation_accept', 'system')), 'The system accepted an invitation');
  assert.equal(activitySentence(row('case_grant', 'system', { target_type: 'grant' })), 'The system gave someone access to a case');
  assert.equal(activitySentence(row('policy_set', 'admin', { target_type: 'workspace' })), 'julian@example.org changed the workspace policies');
  assert.equal(activitySentence(row('quota_set', 'admin', { target_type: 'workspace' })), 'julian@example.org changed the image storage quota');
  assert.equal(activitySentence(row('asset_delete_unused', 'admin', { target_type: 'asset' })), 'julian@example.org deleted an unused image');
  assert.equal(activitySentence(row('version_publish', 'author', { target_type: 'version' })), 'An author published a version');
  assert.equal(activitySentence(row('invitation_resend', 'facilitator')), 'A facilitator sent an invitation again');
  // Deployment audit rows (admin email, phase) read the same way.
  assert.equal(activitySentence({ id, action: 'facilitator_disable', actor_email: 'julian@example.org', target_type: 'facilitator', target_id: id, at, phase: 'outcome' }), 'julian@example.org disabled an account');
  assert.equal(activitySentence({ id, action: 'room_end', actor_email: 'julian@example.org', target_type: 'room', target_id: id, at, phase: 'unresolved' }), 'julian@example.org ended a room (outcome not yet recorded)');
  assert.match(activitySentence(row('made_up_action', 'admin')), /^julian@example\.org made up action$/);
});

// ── Workspaces ───────────────────────────────────────────────────────────────────────────────────────────────
test('[AS-213] storage reads against the quota, warns from 80%, and quota is entered in GB', () => {
  assert.deepEqual(storageSummary({ usedBytes: 1.2e9, quotaBytes: 2e9 }), { percent: 60, warn: false, full: false, used: '1.2 GB', quota: '2 GB', message: '1.2 GB of 2 GB used (60%).' });
  const warn = storageSummary({ usedBytes: 1.7e9, quotaBytes: 2e9 });
  assert.equal(warn.percent, 85); assert.equal(warn.warn, true); assert.match(warn.message, /85%.*Delete unused images or raise the quota/);
  assert.equal(storageSummary({ usedBytes: 1.6e9, quotaBytes: 2e9 }).warn, true, 'exactly 80% warns');
  assert.equal(storageSummary({ usedBytes: 1.59e9, quotaBytes: 2e9 }).warn, false);
  const full = storageSummary({ usedBytes: 2e9, quotaBytes: 2e9 }); assert.equal(full.full, true); assert.match(full.message, /full/i);
  assert.equal(storageSummary({ usedBytes: 0, quotaBytes: 0 }).warn, false);
  assert.equal(storageSummary({ usedBytes: 5, quotaBytes: 0 }).full, true);
  assert.equal(quotaBytesFromGb('2'), 2e9); assert.equal(quotaBytesFromGb(' 0.5 '), 5e8); assert.equal(quotaBytesFromGb('10'), 1e10); assert.equal(quotaBytesFromGb('0'), 0);
  for (const bad of ['', 'abc', '-1', '10.1', '1e3', '2 GB']) assert.equal(quotaBytesFromGb(bad), null, bad);
});
test('[AS-212] only the policies that changed are sent', () => {
  const was = { managers_invite: true, editors_publish: false, runners_share: false, managers_see_records: true };
  assert.deepEqual(policyChanges(was, { ...was }), {});
  assert.deepEqual(policyChanges(was, { ...was, runners_share: true, managers_invite: false }), { managers_invite: false, runners_share: true });
});

// ── API client ───────────────────────────────────────────────────────────────────────────────────────────────
test('[AS-212] the admin API client names the step-up refusals it can be given, instead of calling them an outage', async () => {
  const auth = { accessToken: () => 'a'.repeat(30), sessionGeneration: () => 0, handle401: async () => {} };
  for (const [status, error] of [[422, 'code_rejected'], [403, 'step_up_required'], [429, 'rate_limited'], [404, 'not_found'], [415, 'unsupported_media_type'], [413, 'too_large']]) {
    const api = createAdminApi({ origin: 'https://case.test', auth, fetchImpl: async () => Response.json({ error }, { status }) });
    assert.deepEqual(await api.call('stepup_verify', { body: { code: '123456' } }), { ok: false, status, error }, error); api.close();
  }
});
