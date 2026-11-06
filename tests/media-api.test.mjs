// Builder image routes (card 59 M2, CASE-268) against an in-memory bucket and a fake RPC client (hard rule 12):
// authorization before bytes, the structural check, content addressing, registration from stored metadata only, the
// image-only response policy; image approval is gone (CASE-342).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleMediaApi, mediaKey, runMediaSweep } from '../src/worker/media-api.mjs';
import { mintElevation } from '../src/worker/admin/stepup.mjs';
import { withSecurityHeaders } from '../src/worker/headers.mjs';
import { cleanJpeg } from '../src/shared/media.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
import { gifFixture, mp4Fixture } from './helpers/media-fixtures.mjs';
import { cleanMp4 } from '../src/shared/media-mp4.mjs';

const jpeg = cleanJpeg(new Uint8Array(readFileSync(new URL('./fixtures/media/clean-300x200.jpg', import.meta.url))));
const workspaceId = uuidv7(), authorId = uuidv7(), adminId = uuidv7(), outsiderId = uuidv7();
const sessionId = uuidv7();
const users = { author: { userId: authorId, email: 'author@example.org', sessionId }, admin: { userId: adminId, email: 'admin@example.org', sessionId }, outsider: { userId: outsiderId, email: 'x@example.org', sessionId } };
const env = { ADMIN_EMAILS: 'admin@example.org', STEPUP_SECRET: 'test-only-step-up-secret-0123456789abcdef' };

function bucket() {
  const objects = new Map();
  return { objects,
    async put(key, bytes, options) { objects.set(key, { bytes: new Uint8Array(bytes), ...options }); return {}; },
    async head(key) { const found = objects.get(key); return found ? { size: found.bytes.byteLength, customMetadata: found.customMetadata } : null; },
    async get(key) { const found = objects.get(key); return found ? { body: found.bytes, size: found.bytes.byteLength } : null; },
    async delete(keys) { for (const key of [keys].flat()) objects.delete(key); },
    // As R2 lists: lexical key order, after `startAfter`, at most `limit`, with `truncated` when more remain.
    async list({ prefix = '', limit = 1000, startAfter = '' } = {}) {
      const all = [...objects.keys()].filter(key => key.startsWith(prefix) && key > startAfter).sort(), page = all.slice(0, limit);
      return { objects: page.map(key => ({ key, uploaded: objects.get(key).uploaded ?? new Date() })), truncated: all.length > page.length };
    } };
}
function rpc(rows = {}) {
  const calls = [];
  return { calls, async call(name, args) {
    calls.push([name, args]);
    if (name === 'admin_account_active') return { ok: true, data: true };
    if (name === 'builder_media_put_allowance' && !rows[name]) return { ok: true, data: true };
    if (name === 'get_me') return { ok: true, data: [{ user_id: args.p_user_id, display_name: null, next_after: null, admin: args.p_admin,
      memberships: args.p_user_id === outsiderId ? [] : [{ workspace_id: workspaceId, role: args.p_admin ? 'admin' : 'author' }] }] };
    return rows[name] ? rows[name](args) : { ok: false, kind: 'bad_request', status: 400, code: null };
  } };
}
const call = (who, method, path, { body, type, store = bucket(), rows = {}, headers = {} } = {}) => {
  const fake = rpc(rows);
  const request = new Request(`https://case.test/api/v1/builder/workspaces/${workspaceId}/${path}`, { method, body, duplex: 'half',
    headers: { authorization: 'Bearer test', ...(type ? { 'content-type': type } : {}), ...headers } });
  return handleMediaApi(request, { rpc: fake, env: { ...env, MEDIA: store }, verifyUser: async () => (who ? users[who] : null) }).then(response => ({ response, store, fake }));
};
const errorOf = async response => (await response.json()).error;

test('[AS-167] a rendition is stored only for an entitled author, only as a clean JPEG inside its size bounds', async () => {
  assert.equal((await call(null, 'PUT', 'media/display', { body: jpeg, type: 'image/jpeg' })).response.status, 401);
  const outsider = await call('outsider', 'PUT', 'media/display', { body: jpeg, type: 'image/jpeg' });
  assert.equal(outsider.response.status, 403); assert.equal(outsider.store.objects.size, 0, 'nothing is written for a refused caller');
  assert.equal((await call('author', 'PUT', 'media/display', { body: jpeg, type: 'image/png' })).response.status, 415);
  const exif = Uint8Array.from([...jpeg.subarray(0, 20), 0xff, 0xe1, 0x00, 0x08, ...new TextEncoder().encode('Exif\0\0'), ...jpeg.subarray(20)]);
  const refused = await call('author', 'PUT', 'media/display', { body: exif, type: 'image/jpeg' });
  assert.equal(refused.response.status, 422); assert.equal(await errorOf(refused.response), 'invalid_image:exif_or_xmp'); assert.equal(refused.store.objects.size, 0);
  // Red-team S1: the attempt is counted against the hourly allowance before the file is parsed.
  assert.ok(refused.fake.calls.some(([name]) => name === 'builder_media_put_allowance'), 'a refused file still counts as an attempt');
  const big = await call('author', 'PUT', 'media/display', { body: new Uint8Array(700 * 1024), type: 'image/jpeg' });
  assert.equal(big.response.status, 413);
  const stored = await call('author', 'PUT', 'media/display', { body: jpeg, type: 'image/jpeg' });
  assert.equal(stored.response.status, 201);
  const result = await stored.response.json();
  assert.deepEqual(Object.keys(result).sort(), ['bytes', 'height', 'sha256', 'type', 'width']);
  assert.deepEqual([...stored.store.objects.keys()], [mediaKey(workspaceId, result.sha256)]);
  assert.deepEqual(stored.store.objects.get(mediaKey(workspaceId, result.sha256)).customMetadata, { width: '300', height: '200' });
  // The same bytes again while an image names them (red-team N1): the stored object is not rewritten, so its uploaded time
  // stays and live rooms keep it.
  const key = mediaKey(workspaceId, result.sha256), before = stored.store.objects.get(key), writes = [];
  const store = { ...stored.store, put: async (...args) => { writes.push(args[0]); return stored.store.put(...args); } };
  const named = { media_known_keys: args => ({ ok: true, data: args.p_keys.map(r2_key => ({ r2_key })) }) };
  const again = await call('author', 'PUT', 'media/display', { body: jpeg, type: 'image/jpeg', store, rows: named });
  assert.equal(again.response.status, 200);
  assert.deepEqual(await again.response.json(), result);
  assert.deepEqual(writes, []);
  assert.equal(stored.store.objects.get(key), before);
  // No image names them (an earlier, unfinished upload): written again, so the orphan grace starts over (N1-b).
  const unnamed = await call('author', 'PUT', 'media/display', { body: jpeg, type: 'image/jpeg', store, rows: { media_known_keys: () => ({ ok: true, data: [] }) } });
  assert.equal(unnamed.response.status, 201);
  assert.deepEqual(writes, [key]);
  // The lookup unavailable: refused, never a guess either way.
  const down = await call('author', 'PUT', 'media/display', { body: jpeg, type: 'image/jpeg', store, rows: { media_known_keys: () => ({ ok: false, kind: 'unavailable', status: 503, code: null }) } });
  assert.equal(down.response.status, 503);
  assert.deepEqual(writes, [key]);
});

test('[AS-167] registration reads sizes from the stored objects, never from the request, and checks the rights details', async () => {
  const store = bucket();
  const put = await call('author', 'PUT', 'media/display', { body: jpeg, type: 'image/jpeg', store });
  const { sha256 } = await put.response.json();
  const details = { alt: 'Chest X-ray, PA', evidenceKind: 'imaging', source: 'own', attested: true };
  const missing = await call('author', 'POST', 'assets', { body: JSON.stringify({ display: { sha256 }, phone: { sha256: 'f'.repeat(64) }, details }), store });
  assert.equal(missing.response.status, 409); assert.equal(await errorOf(missing.response), 'rendition_missing');
  // An unticked de-identification check registers with a warning (Julian, 2026-10-15: soft warning only).
  const unattested = await call('author', 'POST', 'assets', { body: JSON.stringify({ display: { sha256 }, phone: { sha256 }, details: { ...details, attested: false } }), store,
    rows: { builder_create_asset: () => ({ ok: true, data: { asset_id: uuidv7(), status: 'quarantined', created: true } }) } });
  assert.equal(unattested.response.status, 201);
  assert.deepEqual((await unattested.response.json()).warnings.map(item => item.field), ['attested']);
  assert.equal(unattested.fake.calls.find(([name]) => name === 'builder_create_asset')[1].p_details.attested, false);
  const lying = await call('author', 'POST', 'assets', { body: JSON.stringify({ display: { sha256, width: 10 }, phone: { sha256 }, details }), store });
  assert.equal(lying.response.status, 400, 'a declared size is not a field the Worker accepts');
  const assetId = uuidv7();
  const made = await call('author', 'POST', 'assets', { body: JSON.stringify({ display: { sha256 }, phone: { sha256 }, details }), store,
    rows: { builder_create_asset: args => ({ ok: true, data: { asset_id: assetId, status: 'quarantined', created: true, args } }) } });
  assert.equal(made.response.status, 201);
  const [, args] = made.fake.calls.find(([name]) => name === 'builder_create_asset');
  assert.deepEqual(args.p_display, { sha256, bytes: jpeg.byteLength, width: 300, height: 200, type: 'image/jpeg' });
  assert.deepEqual(args.p_details, { alt_text: 'Chest X-ray, PA', evidence_kind: 'imaging', rights_basis: 'own_work', licence: 'own-work', creator: '', attribution: '', rights_note: '', source_url: '', attested: true });
  assert.equal(args.p_poster, null);
  // SQL refusals reach the author by name: the hourly or workspace limit, and a file that was rejected or withdrawn.
  for (const [code, error, status] of [['23514', 'media_limit', 429], ['23505', 'asset_closed', 409]]) {
    const refused = await call('author', 'POST', 'assets', { body: JSON.stringify({ display: { sha256 }, phone: { sha256 }, details }), store,
      rows: { builder_create_asset: () => ({ ok: false, kind: code === '23505' ? 'unique' : 'bad_request', status: 409, code }) } });
    assert.equal(refused.response.status, status); assert.equal(await errorOf(refused.response), error);
  }
});

test('[AS-167] a rendition is served as a sandboxed, uncached image; a withdrawn one is gone', async () => {
  const store = bucket(), assetId = uuidv7();
  await store.put('media/x/a.jpg', jpeg, {});
  const served = await call('author', 'GET', `assets/${assetId}/display`, { store,
    rows: { builder_asset_rendition: () => ({ ok: true, data: [{ status: 'quarantined', r2_key: 'media/x/a.jpg', content_sha256: 'a'.repeat(64), byte_size: jpeg.byteLength }] }) } });
  const response = withSecurityHeaders(served.response, 'json', {});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/jpeg');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'; sandbox");
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), jpeg);
  const gone = await call('author', 'GET', `assets/${assetId}/display`, { store,
    rows: { builder_asset_rendition: () => ({ ok: true, data: [{ status: 'withdrawn', r2_key: null, content_sha256: null, byte_size: 10 }] }) } });
  assert.equal(gone.response.status, 410);
  const other = await call('author', 'GET', `assets/${assetId}/display`, { store, rows: { builder_asset_rendition: () => ({ ok: true, data: [] }) } });
  assert.equal(other.response.status, 404);
  // JSON answers keep the strict JSON policy.
  assert.equal(withSecurityHeaders(other.response, 'json', {}).headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'");
});

// Image approval is removed (CASE-342; AS-172 retired). The approval this file used to drive (card 62's fenced body,
// admin-only, 409 on a changed image) now reaches no route and no SQL, for an author and for a configured admin alike.
const fencedApproval = { decision: 'approve', expected: { attested: false, rights_basis: 'unlicensed', licence: 'unknown', creator: null,
  attribution: null, rights_note: null, source_url: null }, acknowledged: ['not_deidentified', 'source_unknown'] };
test('[AS-172] retired with approval: no one reviews an image; the review route answers nothing and calls no SQL', async () => {
  const assetId = uuidv7();
  for (const who of ['author', 'admin']) {
    const { response, fake } = await call(who, 'POST', `assets/${assetId}/review`, { body: JSON.stringify(fencedApproval) });
    assert.equal(response, null, `${who}: the media API owns no review route`);
    assert.deepEqual(fake.calls, [], `${who}: nothing is read or written`);
  }
});

test('[AS-167] red-team S2/B1: a rendition is allowed in SQL before any byte is stored; a refusal stores nothing', async () => {
  for (const [code, error, status] of [['23514', 'media_limit', 429], ['23505', 'asset_closed', 409]]) {
    const refused = await call('author', 'PUT', 'media/display', { body: jpeg, type: 'image/jpeg',
      rows: { builder_media_put_allowance: () => ({ ok: false, kind: code === '23505' ? 'unique' : 'bad_request', status: 409, code }) } });
    assert.equal(refused.response.status, status); assert.equal(await errorOf(refused.response), error);
    assert.equal(refused.store.objects.size, 0, `${error}: nothing written`);
  }
  const allowed = await call('author', 'PUT', 'media/display', { body: jpeg, type: 'image/jpeg' });
  const [, args] = allowed.fake.calls.find(([name]) => name === 'builder_media_put_allowance');
  assert.deepEqual([args.p_bytes, args.p_sha256.length], [jpeg.byteLength, 64]);
  assert.equal(allowed.store.objects.size, 1);
});

test('[AS-169] only a configured admin with this session\'s step-up withdraws an image, and its bytes go at once', async () => {
  const assetId = uuidv7(), key = mediaKey(workspaceId, 'a'.repeat(64)), body = JSON.stringify({ reason: 'Rights complaint' });
  const rows = { admin_withdraw_asset: args => ({ ok: true, data: [{ asset_id: args.p_asset_id, status: 'withdrawn', r2_key: key }] }), media_known_keys: () => ({ ok: true, data: [] }) };
  const fresh = () => { const store = bucket(); store.objects.set(key, { bytes: jpeg }); return store; };
  const author = await call('author', 'POST', `assets/${assetId}/withdraw`, { body, rows, store: fresh() });
  assert.equal(author.response.status, 403);
  const noStepUp = await call('admin', 'POST', `assets/${assetId}/withdraw`, { body, rows, store: fresh() });
  assert.equal(await errorOf(noStepUp.response), 'step_up_required'); assert.ok(!noStepUp.fake.calls.some(([name]) => name === 'admin_withdraw_asset'));
  const other = await mintElevation('admin@example.org', uuidv7(), env.STEPUP_SECRET);
  const wrongSession = await call('admin', 'POST', `assets/${assetId}/withdraw`, { body, rows, store: fresh(), headers: { 'x-admin-elevation': other.token } });
  assert.equal(await errorOf(wrongSession.response), 'step_up_required', 'an elevation from another sign-in session is refused');
  const elevation = await mintElevation('admin@example.org', sessionId, env.STEPUP_SECRET);
  const done = await call('admin', 'POST', `assets/${assetId}/withdraw`, { body, rows, store: fresh(), headers: { 'x-admin-elevation': elevation.token } });
  assert.equal(done.response.status, 200);
  assert.equal(done.store.objects.size, 0, 'the stored rendition is deleted with the withdrawal');
  const [, args] = done.fake.calls.find(([name]) => name === 'admin_withdraw_asset');
  assert.deepEqual([args.p_reason, args.p_elevation_id, args.p_admin], ['Rights complaint', elevation.jti, true]);
  // Red-team S5: re-checked just before deleting, a file an image names again is kept (the queue still holds it).
  const named = await call('admin', 'POST', `assets/${assetId}/withdraw`, { body, store: fresh(), headers: { 'x-admin-elevation': elevation.token },
    rows: { ...rows, media_known_keys: () => ({ ok: true, data: [{ r2_key: key }] }) } });
  assert.equal(named.response.status, 200); assert.equal(named.store.objects.size, 1);
});

test('[AS-169] the hourly sweep deletes queued bytes and day-old objects no live image names, walking every page from a stored position', async () => {
  const store = bucket(), old = new Date(Date.now() - 2 * 86_400_000);
  const keys = Array.from({ length: 12 }, (_, i) => mediaKey(workspaceId, i.toString(16).padStart(2, '0').repeat(32)));
  for (const key of keys) store.objects.set(key, { bytes: jpeg, uploaded: old });
  store.objects.set(mediaKey(uuidv7(), 'f'.repeat(64)), { bytes: jpeg, uploaded: new Date() }); // too new to judge
  const live = new Set(keys.filter((_, i) => i % 3 === 0)), queued = keys[1];
  let position = '';
  const calls = [];
  const fake = { async call(name, args) { calls.push([name, args]);
    if (name === 'media_purge_claim') return { ok: true, data: [{ r2_key: queued }] };
    if (name === 'media_purge_complete') return { ok: true, data: args.p_keys.length };
    if (name === 'media_known_keys') return { ok: true, data: args.p_keys.filter(k => live.has(k)).map(r2_key => ({ r2_key })) };
    if (name === 'media_sweep_position') { const was = position; if (args.p_start_after !== null) position = args.p_start_after; return { ok: true, data: [{ resume_after: was }] }; }
    return { ok: false }; } };
  // Small pages (two of five a run): the first run walks ten keys and stores where it stopped.
  const listedFirst = [...store.objects.keys()].filter(key => key !== queued).sort();
  const first = await runMediaSweep({ env: { MEDIA: store }, rpc: fake, pages: 2, pageSize: 5 });
  assert.equal(first.ok, true); assert.equal(first.deleted, 1); assert.equal(first.walked, 10);
  assert.equal(position, listedFirst[9], 'the walk resumes after the last key it reached');
  // The second run finishes the listing and starts over next time; every key no live image names is gone.
  const second = await runMediaSweep({ env: { MEDIA: store }, rpc: fake, pages: 2, pageSize: 5 });
  assert.equal(second.ok, true); assert.equal(position, '', 'a finished walk starts again at the beginning');
  const left = [...store.objects.keys()];
  assert.deepEqual(keys.filter(key => left.includes(key)).sort(), [...live].sort());
  assert.equal(left.length, live.size + 1, 'the new object is kept until it is a day old');
  assert.deepEqual(calls.find(([name]) => name === 'media_purge_complete')[1], { p_keys: [queued] });
});

test('[AS-169] with production defaults the sweep walks 5,000 keys a run, resumes, and is never wedged by a key it cannot parse', async () => {
  const store = bucket(), old = new Date(Date.now() - 2 * 86_400_000);
  for (let i = 0; i < 5_250; i++) store.objects.set(mediaKey(workspaceId, i.toString(16).padStart(64, '0')), { bytes: jpeg, uploaded: old });
  // A stray object that is not a content-addressed rendition: the walk passes it (and stores it as a position) but never
  // deletes it.
  const stray = `media/${workspaceId}/notes.txt`;
  store.objects.set(stray, { bytes: jpeg, uploaded: old });
  let position = '';
  const fake = { async call(name, args) {
    if (name === 'media_purge_claim') return { ok: true, data: [] };
    if (name === 'media_known_keys') return { ok: true, data: args.p_keys.map(r2_key => ({ r2_key })) };
    if (name === 'media_sweep_position') { const was = position; if (args.p_start_after !== null) position = args.p_start_after; return { ok: true, data: [{ resume_after: was }] }; }
    return { ok: false }; } };
  const first = await runMediaSweep({ env: { MEDIA: store }, rpc: fake });
  assert.deepEqual([first.ok, first.walked], [true, 5_000]);
  assert.notEqual(position, '');
  const second = await runMediaSweep({ env: { MEDIA: store }, rpc: fake });
  assert.deepEqual([second.ok, second.walked, position], [true, 251, '']);
  assert.ok(store.objects.has(stray));
  assert.equal(store.objects.size, 5_251, 'every key is named by a live image, so nothing else is deleted');
});

test('[AS-167] an animated GIF and a video are stored once, cleaned, with their type; a dirty or misplaced file is refused before any byte is written', async () => {
  const store = bucket();
  const gif = await call('author', 'PUT', 'media/display', { body: gifFixture(), type: 'image/gif', store });
  assert.equal(gif.response.status, 201);
  const gifStored = await gif.response.json();
  assert.equal(gifStored.type, 'image/gif');
  assert.ok(store.objects.has(mediaKey(workspaceId, gifStored.sha256, 'image/gif')) && mediaKey(workspaceId, gifStored.sha256, 'image/gif').endsWith('.gif'));
  assert.equal((await call('author', 'PUT', 'media/phone', { body: gifFixture(), type: 'image/gif', store })).response.status, 415, 'a GIF is stored once, as display');
  const comment = await call('author', 'PUT', 'media/display', { body: gifFixture({ comment: 'Patient J Smith' }), type: 'image/gif' });
  assert.equal(await errorOf(comment.response), 'invalid_image:comment'); assert.equal(comment.store.objects.size, 0);
  const dirty = await call('author', 'PUT', 'media/display', { body: mp4Fixture({ udta: true }), type: 'video/mp4' });
  assert.equal(await errorOf(dirty.response), 'invalid_image:metadata'); assert.equal(dirty.store.objects.size, 0);
  const hevc = await call('author', 'PUT', 'media/display', { body: mp4Fixture({ codec: 'hvc1' }), type: 'video/mp4' });
  assert.equal(await errorOf(hevc.response), 'invalid_image:hevc');
  assert.equal((await call('author', 'PUT', 'media/display', { body: jpeg, type: 'image/png' })).response.status, 415);
  const video = await call('author', 'PUT', 'media/display', { body: cleanMp4(mp4Fixture({ udta: true, metaTrack: true })).bytes, type: 'video/mp4', store });
  assert.equal(video.response.status, 201);
  const videoStored = await video.response.json();
  assert.deepEqual([videoStored.type, videoStored.width, videoStored.height, videoStored.durationMs], ['video/mp4', 640, 360, 10000]);
  const allowance = video.fake.calls.find(([name]) => name === 'builder_media_put_allowance')[1];
  assert.equal(allowance.p_type, 'video/mp4');
  // Registration: the file serves display and phone, with a JPEG poster; sizes and duration come from storage.
  const poster = await (await call('author', 'PUT', 'media/poster', { body: jpeg, type: 'image/jpeg', store })).response.json();
  const details = { alt: 'Bedside echo, parasternal long axis', evidenceKind: 'imaging', source: 'own', attested: true };
  const made = await call('author', 'POST', 'assets', { store, body: JSON.stringify({ display: { sha256: videoStored.sha256, type: 'video/mp4' }, phone: { sha256: videoStored.sha256 },
    poster: { sha256: poster.sha256 }, details }), rows: { builder_create_asset: () => ({ ok: true, data: { asset_id: uuidv7(), status: 'quarantined', created: true } }) } });
  assert.equal(made.response.status, 201);
  const args = made.fake.calls.find(([name]) => name === 'builder_create_asset')[1];
  assert.deepEqual(args.p_display, { sha256: videoStored.sha256, bytes: videoStored.bytes, width: 640, height: 360, type: 'video/mp4' });
  assert.deepEqual(args.p_poster, { sha256: poster.sha256, bytes: jpeg.byteLength, width: 300, height: 200, type: 'image/jpeg' });
  assert.equal(args.p_details.duration_ms, 10000);
  for (const body of [{ display: { sha256: videoStored.sha256, type: 'video/mp4' }, phone: { sha256: videoStored.sha256 }, details },
    { display: { sha256: gifStored.sha256, type: 'image/gif' }, phone: { sha256: poster.sha256 }, poster: { sha256: poster.sha256 }, details },
    { display: { sha256: poster.sha256 }, phone: { sha256: poster.sha256 }, poster: { sha256: poster.sha256 }, details }]) {
    assert.equal((await call('author', 'POST', 'assets', { store, body: JSON.stringify(body) })).response.status, 400, JSON.stringify(Object.keys(body)));
  }
});

test('[AS-167] a stored video or GIF is served with its own type under the same sandboxed, uncached policy', async () => {
  const store = bucket(), assetId = uuidv7(), bytes = cleanMp4(mp4Fixture()).bytes;
  await store.put('media/x/v.mp4', bytes, {});
  const served = await call('author', 'GET', `assets/${assetId}/display`, { store,
    rows: { builder_asset_rendition: () => ({ ok: true, data: [{ status: 'approved', r2_key: 'media/x/v.mp4', content_sha256: 'a'.repeat(64), byte_size: bytes.byteLength, content_type: 'video/mp4' }] }) } });
  const response = withSecurityHeaders(served.response);
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'; sandbox");
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
});

test('[AS-169] a leased purge entry whose bytes were registered again meanwhile keeps them (re-check before delete)', async () => {
  const store = bucket(), again = mediaKey(workspaceId, 'b'.repeat(64)), gone = mediaKey(workspaceId, 'c'.repeat(64));
  for (const key of [again, gone]) store.objects.set(key, { bytes: jpeg, uploaded: new Date() });
  const calls = [];
  const fake = { async call(name, args) { calls.push([name, args]);
    if (name === 'media_purge_claim') return { ok: true, data: [{ r2_key: again }, { r2_key: gone }] };
    if (name === 'media_known_keys') return { ok: true, data: args.p_keys.filter(key => key === again).map(r2_key => ({ r2_key })) };
    if (name === 'media_purge_complete') return { ok: true, data: args.p_keys.length };
    if (name === 'media_sweep_position') return { ok: true, data: [{ resume_after: '' }] };
    return { ok: false }; } };
  const run = await runMediaSweep({ env: { MEDIA: store }, rpc: fake, pages: 1, pageSize: 5 });
  assert.equal(run.ok, true); assert.equal(run.deleted, 1);
  assert.ok(store.objects.has(again) && !store.objects.has(gone));
  assert.deepEqual(calls.find(([name]) => name === 'media_purge_complete')[1], { p_keys: [again, gone] });
  // The lookup unavailable: nothing is deleted and nothing is completed.
  const down = { async call(name) { return name === 'media_purge_claim' ? { ok: true, data: [{ r2_key: again }] } : { ok: false }; } };
  store.objects.set(gone, { bytes: jpeg, uploaded: new Date() });
  assert.equal((await runMediaSweep({ env: { MEDIA: store }, rpc: down })).ok, false);
  assert.ok(store.objects.has(again));
});

test('[AS-167] an upload is read as it arrives: a 3 MB video in 64 KiB pieces is stored whole; a short body for its declared length is refused', async () => {
  const video = cleanMp4(mp4Fixture({ videoSamples: [1_000_000, 1_000_000, 1_000_000, 1_000], audio: false })).bytes;
  const pieces = bytes => new ReadableStream({ start(controller) { for (let at = 0; at < bytes.length; at += 65_536) controller.enqueue(bytes.slice(at, at + 65_536)); controller.close(); } });
  const store = bucket();
  const whole = await call('author', 'PUT', 'media/display', { body: pieces(video), type: 'video/mp4', store });
  assert.equal(whole.response.status, 201);
  const stored = await whole.response.json();
  assert.equal(stored.bytes, video.length);
  assert.deepEqual(new Uint8Array(store.objects.get(mediaKey(workspaceId, stored.sha256, 'video/mp4')).bytes), video);
  const short = await call('author', 'PUT', 'media/display', { body: pieces(video.subarray(0, 1000)), type: 'video/mp4', headers: { 'content-length': String(video.length) } });
  assert.notEqual(short.response.status, 201); assert.equal(short.store.objects.size, 0);
});

test('[AS-167] an upload that declares 25 MB and sends 10 bytes holds at most 1 MiB, not its declared length', async () => {
  // Every byte buffer the Worker allocates while it reads, recorded (the old reader allocated the declared length first).
  const Native = globalThis.Uint8Array;
  let largest = 0;
  globalThis.Uint8Array = class extends Native { constructor(...args) { super(...args); if (typeof args[0] === 'number') largest = Math.max(largest, args[0]); } };
  try {
    const body = new ReadableStream({ start(controller) { controller.enqueue(new Native(10)); controller.close(); } });
    const short = await call('author', 'PUT', 'media/display', { body, type: 'video/mp4', headers: { 'content-length': String(25 * 1024 * 1024) } });
    assert.notEqual(short.response.status, 201);
  } finally { globalThis.Uint8Array = Native; }
  assert.ok(largest > 0 && largest <= 1024 * 1024, `largest buffer ${largest} bytes`);
});

test('[AS-167] an author updates the pending image tick with a bounded, explicit request; conflicts need reload', async () => {
  const assetId = uuidv7(), path = `assets/${assetId}/attestation`;
  const rows = { builder_set_asset_attestation: args => ({ ok: true, data: { asset_id: assetId, status: 'quarantined', attested: args.p_attested } }) };
  const body = JSON.stringify({ expected: false, attested: true });
  const result = await call('author', 'POST', path, { body, rows });
  assert.equal(result.response?.status, 200);
  assert.equal((await result.response.json()).asset.attested, true);
  assert.deepEqual(result.fake.calls.find(([name]) => name === 'builder_set_asset_attestation')[1], {
    p_workspace_id: workspaceId, p_asset_id: assetId, p_expected: false, p_attested: true, p_user_id: authorId, p_admin: false, p_admin_email: null });
  assert.equal((await call('outsider', 'POST', path, { body, rows })).response.status, 403);
  for (const invalid of [{ attested: true }, { expected: false, attested: 'true' }, { expected: false, attested: true, actor: adminId }])
    assert.equal((await call('author', 'POST', path, { body: JSON.stringify(invalid), rows })).response.status, 400);
  const conflict = await call('author', 'POST', path, { body, rows: { builder_set_asset_attestation: () => ({ ok: false, code: '40001' }) } });
  assert.equal(conflict.response.status, 409);
  assert.equal(await errorOf(conflict.response), 'asset_details_changed');
  assert.equal((await call('author', 'POST', path, { body: ' '.repeat(2049), rows })).response.status, 413);
});
