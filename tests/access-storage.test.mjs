// Facilitator-UX A3 (plan §3 A3 and A7, CASE-342): images without approval, within storage. The review route is gone,
// rooms and session records use any live image at once, a case place uploads under a Can edit grant with the
// uploader's confirmation, the full-storage refusal names the bytes used and allowed, the same file is one object, and
// Admin reads storage and deletes unused images with the step-up. Fakes only (hard rule 12).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleMediaApi, mediaKey } from '../src/worker/media-api.mjs';
import { readRoomMedia } from '../src/worker/published-rooms.mjs';
import { handleAdminRequest } from '../src/worker/admin/handler.mjs';
import { matchAdminRoute } from '../src/worker/admin/routes.mjs';
import { mintElevation } from '../src/worker/admin/stepup.mjs';
import { rpcClient } from '../src/worker/rpc.mjs';
import { fakePostgrest } from './helpers/fake-postgrest.mjs';
import { cleanJpeg } from '../src/shared/media.mjs';
import { POLICIES } from '../src/shared/permissions.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';

const jpeg = cleanJpeg(new Uint8Array(readFileSync(new URL('./fixtures/media/clean-300x200.jpg', import.meta.url))));
const WS = uuidv7(), CASE = uuidv7(), EDITOR = uuidv7(), RUNNER = uuidv7(), ADMIN = uuidv7(), SESSION = uuidv7();
const ADMIN_EMAIL = 'admin@example.org', SECRET = 'test-only-step-up-secret-0123456789abcdef';
const env = { ADMIN_EMAILS: ADMIN_EMAIL, STEPUP_SECRET: SECRET, CASE_PUBLIC_ORIGIN: 'https://case.test' };
const users = { editor: { userId: EDITOR, email: 'ed@example.org', sessionId: SESSION }, runner: { userId: RUNNER, email: 'r@example.org', sessionId: SESSION },
  admin: { userId: ADMIN, email: ADMIN_EMAIL, sessionId: SESSION } };

function bucket() {
  const objects = new Map();
  return { objects,
    async put(key, bytes, options) { objects.set(key, { bytes: new Uint8Array(bytes), ...options }); return {}; },
    async head(key) { const found = objects.get(key); return found ? { size: found.bytes.byteLength, customMetadata: found.customMetadata } : null; },
    async get(key) { const found = objects.get(key); return found ? { body: found.bytes, size: found.bytes.byteLength } : null; },
    async delete(keys) { for (const key of [keys].flat()) objects.delete(key); } };
}
/** A case-only editor (Can edit on CASE) and a case-only runner (Can run), as get_access answers them. */
function rpc(rows = {}) {
  const calls = [];
  return { calls, async call(name, args) {
    calls.push([name, args]);
    if (name === 'admin_account_active') return { ok: true, data: true };
    if (name === 'get_access') {
      if (args.p_case_id !== CASE) return { ok: true, data: [] };
      const level = args.p_user_id === EDITOR ? 'edit' : args.p_user_id === RUNNER ? 'run' : null;
      return { ok: true, data: [{ case_id: CASE, workspace_id: WS, member_role: null, grant_level: level,
        role: level === 'edit' ? 'author' : 'facilitator', scope: 'case', policies: POLICIES }] };
    }
    if (rows[name]) return rows[name](args);
    if (name === 'builder_case_media_put_allowance') return { ok: true, data: true };
    if (name === 'media_known_keys') return { ok: true, data: [] };
    return { ok: false, kind: 'bad_request', status: 400, code: null };
  } };
}
const call = (who, method, path, { body, type, store = bucket(), rows = {}, base = `cases/${CASE}` } = {}) => {
  const fake = rpc(rows);
  const request = new Request(`https://case.test/api/v1/builder/${base}/${path}`, { method, body, duplex: 'half',
    headers: { authorization: 'Bearer test', ...(type ? { 'content-type': type } : {}) } });
  return handleMediaApi(request, { rpc: fake, env: { ...env, MEDIA: store }, verifyUser: async () => users[who] ?? null }).then(response => ({ response, store, fake }));
};
const details = { alt: 'Chest X-ray, PA', evidenceKind: 'imaging', source: 'own', attested: true };

test('[AS-213] the image-review route is gone: no route answers it, and no call reaches the review RPC', async () => {
  for (const base of [`workspaces/${WS}`, `cases/${CASE}`]) {
    const { response, fake } = await call('admin', 'POST', `assets/${uuidv7()}/review`, { base, body: JSON.stringify({ decision: 'approve' }) });
    assert.equal(response, null, `${base}: the media API no longer owns a review route`);
    assert.ok(!fake.calls.some(([name]) => name === 'admin_review_asset'));
  }
  assert.doesNotMatch(readFileSync(new URL('../src/worker/media-api.mjs', import.meta.url), 'utf8'), /admin_review_asset|image-review/);
});

test('[AS-205] [AS-213] a Can edit grant uploads to its case; the storage key takes the case\'s workspace; Can run cannot', async () => {
  const put = await call('editor', 'PUT', 'media/display', { body: jpeg, type: 'image/jpeg' });
  assert.equal(put.response.status, 201);
  const { sha256 } = await put.response.json();
  assert.ok(put.store.objects.has(mediaKey(WS, sha256)), 'stored under the workspace the case row names');
  const [, args] = put.fake.calls.find(([name]) => name === 'builder_case_media_put_allowance');
  assert.equal(args.p_case_id, CASE); assert.equal(args.p_workspace_id, undefined);
  const runner = await call('runner', 'PUT', 'media/display', { body: jpeg, type: 'image/jpeg' });
  assert.equal(runner.response.status, 403); assert.equal(runner.store.objects.size, 0);
  const elsewhere = await call('editor', 'PUT', 'media/display', { body: jpeg, type: 'image/jpeg', base: `cases/${uuidv7()}` });
  assert.equal(elsewhere.response.status, 403, 'a grant never reaches another case');
  // The case place has no attestation, withdraw or review sub-route.
  for (const part of ['attestation', 'withdraw']) assert.equal((await call('admin', 'POST', `assets/${uuidv7()}/${part}`, { body: '{}' })).response, null, part);
});

test('[AS-213] the full-storage refusal names the bytes used and allowed, and nothing is stored', async () => {
  // As rpc.mjs maps case_app.media_allow_put's refusal; only these exact words yield numbers.
  const fake = fakePostgrest();
  const client = rpcClient({ SUPABASE_URL: 'https://postgrest.test/', SUPABASE_SECRET_KEY: `sb_secret_${uuidv7()}` }, { fetchImpl: fake.fetchImpl });
  fake.faults.push({ status: 400, code: '23514', message: 'storage_full: used 1999990000 of 2000000000 bytes' });
  assert.deepEqual(await client.call('ping', {}), { ok: false, kind: 'storage_full', status: 507, code: '23514', usedBytes: 1999990000, quotaBytes: 2000000000 });
  for (const message of ['media_rate', 'storage_full: used 1 of 2 bytes; drop table', 'Storage_full: used 1 of 2 bytes', 'storage_full: used -1 of 2 bytes']) {
    fake.faults.push({ status: 400, code: '23514', message });
    assert.deepEqual(await client.call('ping', {}), { ok: false, kind: 'bad_request', status: 400, code: '23514' }, message);
  }
  fake.faults.push({ status: 400, code: '22023', message: 'storage_full: used 1 of 2 bytes' });
  assert.equal((await client.call('ping', {})).kind, 'bad_request', 'only a 23514 carries the numbers');
  const full = await call('editor', 'PUT', 'media/display', { body: jpeg, type: 'image/jpeg',
    rows: { builder_case_media_put_allowance: () => ({ ok: false, kind: 'storage_full', status: 507, code: '23514', usedBytes: 1999990000, quotaBytes: 2000000000 }) } });
  assert.equal(full.response.status, 507);
  assert.deepEqual(await full.response.json(), { error: 'storage_full', usedBytes: 1999990000, quotaBytes: 2000000000 });
  assert.equal(full.store.objects.size, 0);
  // The hourly limit keeps its own name.
  const rate = await call('editor', 'PUT', 'media/display', { body: jpeg, type: 'image/jpeg',
    rows: { builder_case_media_put_allowance: () => ({ ok: false, kind: 'bad_request', status: 400, code: '23514' }) } });
  assert.equal(rate.response.status, 429); assert.equal((await rate.response.json()).error, 'media_limit');
});

test('[AS-213] registering on a case needs the uploader\'s confirmation; the same file again is the same image', async () => {
  const store = bucket();
  const { sha256 } = await (await call('editor', 'PUT', 'media/display', { body: jpeg, type: 'image/jpeg', store })).response.json();
  const body = extra => JSON.stringify({ display: { sha256 }, phone: { sha256 }, details: { ...details, ...extra } });
  const unconfirmed = await call('editor', 'POST', 'assets', { body: body({ attested: false }), store });
  assert.equal(unconfirmed.response.status, 422); assert.equal((await unconfirmed.response.json()).error, 'invalid_details:attested');
  assert.ok(!unconfirmed.fake.calls.some(([name]) => name === 'builder_create_case_asset'));
  const assetId = uuidv7();
  const first = await call('editor', 'POST', 'assets', { body: body(), store,
    rows: { builder_create_case_asset: () => ({ ok: true, data: { asset_id: assetId, status: 'quarantined', created: true } }) } });
  assert.equal(first.response.status, 201);
  assert.equal(first.fake.calls.find(([name]) => name === 'builder_create_case_asset')[1].p_case_id, CASE);
  const again = await call('editor', 'POST', 'assets', { body: body(), store,
    rows: { builder_create_case_asset: () => ({ ok: true, data: { asset_id: assetId, status: 'quarantined', created: false } }) } });
  assert.equal(again.response.status, 200); assert.equal((await again.response.json()).asset.asset_id, assetId);
  // Uploading identical bytes again writes nothing new: the object a live image names is left untouched.
  const reput = await call('editor', 'PUT', 'media/display', { body: jpeg, type: 'image/jpeg', store,
    rows: { media_known_keys: () => ({ ok: true, data: [{ r2_key: mediaKey(WS, sha256) }] }) } });
  assert.equal(reput.response.status, 200);
  // Lists and renditions go through the case RPCs.
  const listed = await call('editor', 'GET', 'assets', { rows: { builder_list_case_assets: () => ({ ok: true, data: [] }) } });
  assert.equal(listed.response.status, 200); assert.equal(listed.fake.calls.find(([name]) => name === 'builder_list_case_assets')[1].p_case_id, CASE);
});

test('[AS-213] a room and a session record use any live image at once: no approval state is required', async () => {
  const asset = uuidv7(), key = sha => `media/${WS}/${sha.repeat(64)}.jpg`;
  const manifest = { async call() { return { ok: true, data: [{ asset_id: asset, status: 'quarantined', width: 300, height: 200, attribution: null,
    display_key: key('a'), phone_key: key('b'), poster_key: null, media_type: 'image/jpeg', duration_ms: null }] }; } };
  const media = await readRoomMedia(manifest, { userId: EDITOR, admin: false }, WS, uuidv7(), { blocks: [{ type: 'image', asset_id: asset }] });
  assert.equal(media.ok, true); assert.equal(media.media[asset].displayKey, key('a'));
  const withdrawn = { async call() { return { ok: true, data: [{ asset_id: asset, status: 'withdrawn' }] }; } };
  assert.deepEqual((await readRoomMedia(withdrawn, { userId: EDITOR, admin: false }, WS, uuidv7(), { blocks: [{ type: 'image', asset_id: asset }] })).media[asset], { state: 'withdrawn' });
  assert.match(readFileSync(new URL('../src/worker/session-portfolio.mjs', import.meta.url), 'utf8'), /\['quarantined','approved'\]\.includes\(row\.status\)/);
});

test('[AS-213] Admin reads a workspace\'s storage and unused images, and Delete unused needs this session\'s step-up', async () => {
  const unused = uuidv7(), placed = uuidv7(), calls = [];
  const fake = { async call(name, args) {
    calls.push([name, args]);
    if (name === 'admin_account_active') return { ok: true, data: true };
    if (name === 'admin_workspace_storage') return { ok: true, data: { workspaceId: args.p_workspace_id, usedBytes: 1200, quotaBytes: 2000000000, unusedBytes: 400,
      policies: POLICIES, policyRevision: 0,
      unused: [{ assetId: unused, kind: 'image', mediaType: 'image/jpeg', altText: 'Spare', createdAt: '2026-11-01T00:00:00Z', bytes: 400 }] } };
    if (name === 'admin_delete_unused_assets') return { ok: true, data: { deleted: [unused], queuedKeys: 2 } };
    return { ok: true, data: null };
  } };
  const send = async (who, method, path, body, headers = {}) => handleAdminRequest(new Request(`https://case.test${path}`, { method,
    headers: { authorization: 'Bearer t', origin: 'https://case.test', 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) }),
  { env, rpc: fake, verifyUser: async () => users[who], nowMs: () => Date.now() });
  assert.equal(matchAdminRoute(`/api/v1/admin/workspaces/${WS}/storage`, 'GET').key, 'workspace_storage');
  const read = await send('admin', 'GET', `/api/v1/admin/workspaces/${WS}/storage`);
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), { workspaceId: WS, usedBytes: 1200, quotaBytes: 2000000000, unusedBytes: 400, policies: POLICIES, policyRevision: 0,
    unused: [{ assetId: unused, kind: 'image', mediaType: 'image/jpeg', altText: 'Spare', createdAt: '2026-11-01T00:00:00Z', bytes: 400 }] });
  assert.deepEqual(calls.find(([name]) => name === 'admin_workspace_storage')[1], { p_user_id: ADMIN, p_workspace_id: WS, p_admin: true, p_admin_email: ADMIN_EMAIL });
  assert.equal((await send('editor', 'GET', `/api/v1/admin/workspaces/${WS}/storage`)).status, 403, 'not an admin');
  const path = `/api/v1/admin/workspaces/${WS}/storage/delete-unused`;
  assert.equal((await send('admin', 'POST', path, { assetIds: [unused, placed] })).status, 403, 'no step-up');
  assert.ok(!calls.some(([name]) => name === 'admin_delete_unused_assets'));
  const { token, jti } = await mintElevation(ADMIN_EMAIL, SESSION, SECRET);
  assert.equal((await send('admin', 'POST', path, { assetIds: [] }, { 'x-admin-elevation': token })).status, 400);
  assert.equal((await send('admin', 'POST', path, { assetIds: [unused, unused] }, { 'x-admin-elevation': token })).status, 400);
  const done = await send('admin', 'POST', path, { assetIds: [unused, placed] }, { 'x-admin-elevation': token });
  assert.equal(done.status, 200);
  assert.deepEqual(await done.json(), { deleted: [unused], kept: [placed] }, 'an image used since the listing is kept');
  assert.equal(calls.find(([name]) => name === 'admin_delete_unused_assets')[1].p_elevation_id, jti);
});
