// Card 59 M3 (CASE-269): reveal-gated room images on the real Worker and RoomDO in workerd, with the in-memory PostgREST
// fake and the locally simulated MEDIA bucket (hard rule 12). Before its step is released an image reaches no public
// payload and no public fetch succeeds; after it, display and phones fetch it with their own credential; the facilitator
// may fetch any image of its room; foreign, guessed and withdrawn handles fail without revealing anything.
import { env } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import worker from '../../src/worker/index.mjs';
import fixture from '../../src/fixtures/synthetic-workshop.case.json';
import { signTestJwt } from '../../src/worker/auth.mjs';
import { uuidv7 } from '../../src/shared/ids.mjs';
import { WIRE_VERSION } from '../../src/shared/wire.mjs';
import { convertSchema1ToBuilderDocument } from '../../src/shared/builder-document.mjs';
import { convertToSlideDocument } from '../../src/shared/slide-legacy.mjs';
import { knownAccountFake } from '../helpers/admin-account-fixture.mjs';
import { addBlock } from '../../src/shared/slide-edit.mjs';

const ORIGIN = 'https://case.test', SECRET = 'test-only-secret-not-for-production';
const workspaceId = uuidv7(), versionId = uuidv7(), userId = uuidv7(), caseId = uuidv7();
const localEnv = { ...env, SUPABASE_URL: 'https://postgrest.test/', SUPABASE_SECRET_KEY: 'sb_secret_test_only' };
const jwt = () => signTestJwt({ sub: userId, aud: 'authenticated', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
const api = (path, { method = 'GET', token, body } = {}) => worker.fetch(new Request(`${ORIGIN}/api/v1${path}`, {
  method, headers: { 'x-case-schema': '3', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body) }), localEnv);
const hex = bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
// Placeholder video bytes: the route serves what storage holds; structure is checked at upload (media-mp4.mjs), not here.
const VIDEO = Uint8Array.from([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 2, 0, 0, 0, 0, 8, 109, 100, 97, 116]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
// The Builder's cleaned 64×48 encoder output (tests/fixtures/media/clean-64x48.jpg after cleanJpeg): a real rendition the
// upload route accepts, inlined because workerd tests cannot read fixture files.
const UPLOADABLE = Uint8Array.from(atob('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAQDAwQDAwQEBAQFBQQFBwsHBwYGBw4KCggLEA4RERAOEA8SFBoWEhMYEw8QFh8XGBsbHR0dERYgIh8cIhocHRz/2wBDAQUFBQcGBw0HBw0cEhASHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBz/wAARCAAwAEADASIAAhEBAxEB/8QAGwAAAwEBAAMAAAAAAAAAAAAAAAYHBQQCAwj/xAAxEAAABQIFAgQGAQUAAAAAAAABAgMEBQYRAAdIhsQSEwgVITEUIjdBdbMjFzJiZYL/xAAZAQADAQEBAAAAAAAAAAAAAAAAAQIEAwX/xAAsEQABAgMFBQkAAAAAAAAAAAABABECAxIEE2JjsSFBUdLTMTIzQ2Fxc5Ki/9oADAMBAAIRAxEAPwD6v067S4eDTrtLh4Qszq1e0d4eqNTaOI5sSbjko1wu/SOoUiZo1ZT5QKctjmMkUoCIiAdXsOMb+o0oOQsbFsZKCmn0vHqxySjVsoikxSRjjLLAqAqnFRUpC2C3QAmOHoABjOICQ+Fe0ZoEVO+9VW067S4eDTrtLh4nEpV9UUl4eFUZplHPQfxDRhEOWgmRBUq7cQMCqZjGEpkigJhEBsf0sBfW3lS9avHOWktTD6oKVlQRo06yZIxcEnrQxWwAKKzcVTmGxTB/IHSFwEBKFwwU7HwpiNyzeaqLp12lw8GnXaXDxMKrr2paayYS7kbFJQC0MyiWqa65geyJl2qYKKogFygVPuGHpEBEQSONyhYR46IzXcVVlQ9iF38K2TSgH7RFiKK5HSxW6KiXURQ1kzjZMDmAlxKA+tsFJZ8KdYds1VvTrtLh4aMtvp1SP4hp+kmI1UGbMVTuTqkAtGTLlwhSLQ7lw0bAdBsRy3MmkY5uoBABOUQsACP3sIAIht0FnTDs6BpRl5NPLSxSt4gI1FqQzgyxWRXACAdfT0GSscDCPsPzdNhtUuCKoFtyz2uZDdTIX23h0K5a2pB3VPh+pd0yk0mDiBhyyQCq1FcqxfLVUjJ2A5ekRKsNjXGwgHoOM2VoOYn/AA+xzyTqBsMjDQ4SMWuzjxR7KfwJiHRUAyp+4B0znKJg6fcBAPTD9p12lw8GnXaXDxAiI+q0GAEvm8Spy5ytUm/D3IPZ6cWdyS0IzftFEEu0kxK1b9aKZExMa/ubrMI3P1j/AG2KAeyOy+mBy5QrCZqFu6M0olyzasGkf2E00lWqZrmMKhjGP/EW4+w/YpfvQtOu0uHg067S4eHWezCkJYBfN4lTI2W9QEy+eVenUcQqRelE00kHsKdZdm2KxKB0EVviCgmBxAxhMBPUTeoGAADHSjl9NuspIuVm6kQkYqFp5y+jmpY/tLkOsxUIBVFu4IHKmRUxSgBCiPyiYRELjRNOu0uHg067S4eFUfyqpDvmpJkcvvMMk5+U8x6PN6OjSdvsX7XwiJ1ffq9evuW9gta/re2NvLTK6yNJVX5r7g0k/hfh/wDUEZdHX1f93t/jb7429Ou0uHhoy2+nVI/iGn6SYuXEagPRZ7VALmYcw6FK+nXaXDwaddpcPBp12lw8GnXaXDxz5Vp6qNOu0uHg067S4eDTrtLh4NOu0uHg5UdVGnXaXDwaddpcPBp12lw8GnXaXDwcqOqjTrtLh4aMtvp1SP4hp+kmFfTrtLh4aMtvp1SP4hp+kmKl94ey4WvwI/kOi//Z'), c => c.charCodeAt(0));
afterEach(() => vi.unstubAllGlobals());

/** The fixture as a slide case: image A is the opening slide's last step, image B sits on a slide the room never reaches. */
async function slideCase() {
  const source = convertSchema1ToBuilderDocument(structuredClone(fixture), { metadata_version: 1 }).candidate;
  for (const surface of source.surfaces) delete surface.variants;
  const doc = convertToSlideDocument(source, { metadata_version: 1 }, { createId: uuidv7 }).candidate.document;
  let opening = doc.compositions.find(item => item.owner.kind === 'beat' && item.owner.id === doc.start_beat_id);
  const otherId = doc.compositions.find(item => item !== opening).id;
  const assetA = uuidv7(), assetB = uuidv7();
  // Each image is added as its own new last reveal step, placed in free grid space, as the Builder adds it.
  const add = (compositionId, assetId, alt) => {
    // Free a band by shortening the slide's largest non-question block, then add the image there.
    const composition = doc.compositions.find(item => item.id === compositionId);
    const largest = composition.placements.filter(item => doc.blocks.find(block => block.id === item.block_id)?.type !== 'question').sort((x, y) => y.w * y.h - x.w * x.h)[0];
    largest.h = Math.max(2, largest.h - 5);
    const result = addBlock(doc, compositionId, 'image', uuidv7, { image: { assetId, alt, ecg: false } });
    expect(result.ok && !result.unplaced).toBe(true);
    const block = result.document.blocks.find(item => item.id === result.blockId); block.caption = `${alt} caption`;
    Object.assign(doc, result.document);
  };
  add(opening.id, assetA, 'Sentinel image A alt');
  add(otherId, assetB, 'Sentinel image B alt');
  opening = doc.compositions.find(item => item.id === opening.id);
  return { doc, assetA, assetB, steps: opening.steps.filter(step => step.block_ids.length).length };
}

async function startRoom({ phoneKeyA, videoA = false } = {}) {
  const { doc, assetA, assetB, steps } = await slideCase();
  const fake = knownAccountFake({ actors: [userId], origin: 'https://postgrest.test' });
  const text = JSON.stringify(doc), hash = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  const key = name => `media/${workspaceId}/${name.repeat(64)}.jpg`;
  for (const name of ['a', 'b', 'c', 'd', 'f']) await env.MEDIA.put(key(name), JPEG);
  await env.MEDIA.put(key('e').replace('.jpg', '.mp4'), VIDEO, { httpMetadata: { contentType: 'video/mp4' } });
  fake.replies.set('get_me', [{ user_id: userId, display_name: 'Facilitator', memberships: [{ workspace_id: workspaceId, role: 'owner' }], next_after: null, admin: false }]);
  fake.replies.set('get_case_version_for_workspace', [{ case_id: caseId, version_no: 1, schema_version: 3, document_text: text, document: doc, content_sha256: `\\x${hash}`, art: null }]);
  fake.replies.set('room_media_manifest', [
    videoA ? { asset_id: assetA, status: 'approved', width: 1280, height: 720, attribution: null, display_key: key('e').replace('.jpg', '.mp4'), phone_key: key('e').replace('.jpg', '.mp4'),
      poster_key: key('f'), media_type: 'video/mp4', duration_ms: 42000 }
      : { asset_id: assetA, status: 'approved', width: 1200, height: 800, attribution: 'Photo: A. Author, CC BY 4.0', display_key: key('a'), phone_key: phoneKeyA ?? key('b') },
    { asset_id: assetB, status: 'approved', width: 1200, height: 800, attribution: null, display_key: key('c'), phone_key: key('d') }]);
  vi.stubGlobal('fetch', fake.fetchImpl);
  const started = await api('/sessions', { method: 'POST', token: await jwt(), body: { workspaceId, caseVersionId: versionId, ttlMinutes: 60 } });
  expect(started.status).toBe(201);
  const room = await started.json();
  const participant = await (await api('/join', { method: 'POST', body: { v: 1, code: room.joinCode, displayName: 'Sam', avatarId: 'shadows-01' } })).json();
  const pair = await (await api('/display-pairs', { method: 'POST' })).json();
  expect((await api(`/sessions/${room.sessionId}/display-pairs/approve`, { method: 'POST', token: room.facilitatorToken, body: { code: pair.code } })).status).toBe(200);
  const display = await (await api(`/display-pairs/${pair.pairId}`, { token: pair.secret })).json();
  const read = async token => (await api(`/sessions/${room.sessionId}/snapshot`, { token })).text();
  const media = (token, handle, rendition = 'display', sessionId = room.sessionId) => api(`/sessions/${sessionId}/media/${handle}/${rendition}`, { token });
  const command = async (type, extra = {}) => {
    const snap = JSON.parse(await read(room.facilitatorToken));
    const response = await api(`/sessions/${room.sessionId}/commands`, { method: 'POST', token: room.facilitatorToken,
      body: { v: WIRE_VERSION, type, epoch: snap.epoch, clientEventId: uuidv7(), expectRevision: snap.revision, ...extra } });
    expect((await response.json()).receipt?.receipt ?? 'accepted').toBe('accepted');
  };
  const handles = JSON.parse(await read(room.facilitatorToken)).mirror.media;
  return { fake, room, participant, display, read, media, command, steps, handleA: handles[assetA].handle, handleB: handles[assetB].handle, assetA, assetB, key };
}

it('[AS-168] an image reaches no public payload or fetch before its step; afterwards each role fetches it with its own credential', async () => {
  const r = await startRoom();
  expect(r.handleA).not.toBe(r.handleB);
  // The pre-reveal checks below must actually run (red-team S9): the image is not on the opening step.
  expect(r.steps).toBeGreaterThan(1);
  await r.command('start');
  const publicRoles = [r.participant.token, r.display.token];
  for (let shown = 1; shown < r.steps; shown++) {
    for (const token of publicRoles) {
      const text = await r.read(token);
      for (const sentinel of [r.handleA, r.handleB, r.assetA, r.assetB, 'Sentinel image A alt', 'Sentinel image A caption', 'media/', 'CC BY 4.0']) expect(text).not.toContain(sentinel);
      for (const handle of [r.handleA, r.handleB, uuidv7()]) {
        const refused = await r.media(token, handle, token === r.display.token ? 'display' : 'phone');
        expect(refused.status).toBe(404);
        expect(await refused.json()).toEqual({ error: 'not_found' });
      }
    }
    await r.command('advance');
  }
  // Released: the public block carries the handle and public facts only, never the asset id or a storage key.
  for (const token of publicRoles) {
    const text = await r.read(token), view = JSON.parse(text).view;
    const block = (view.surface ?? view.liveSurface).slide.blocks.find(item => item.type === 'image');
    expect(block).toEqual({ id: block.id, type: 'image', alt: 'Sentinel image A alt', caption: 'Sentinel image A alt caption', fit: 'contain', ecg: null,
      media: { handle: r.handleA, width: 1200, height: 800, credit: null, type: 'image/jpeg', durationMs: null } });
    for (const sentinel of [r.assetA, r.assetB, r.handleB, 'media/', 'Photo: A. Author', 'CC BY 4.0']) expect(text).not.toContain(sentinel);
  }
  const facilitator = JSON.parse(await r.read(r.room.facilitatorToken)).view;
  expect(facilitator.liveSurface.notes).toContain('Photo: A. Author, CC BY 4.0');
  const shown = await r.media(r.participant.token, r.handleA, 'phone');
  expect(shown.status).toBe(200);
  expect(shown.headers.get('content-type')).toBe('image/jpeg');
  expect(shown.headers.get('cache-control')).toBe('private, no-store');
  expect(shown.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'none'; sandbox");
  expect(new Uint8Array(await shown.arrayBuffer())).toEqual(JPEG);
  expect((await r.media(r.display.token, r.handleA, 'display')).status).toBe(200);
  // Red-team S7: each role reads only its own copies; any other answers like an unknown handle.
  for (const [token, rendition] of [[r.participant.token, 'display'], [r.display.token, 'phone']]) {
    const other = await r.media(token, r.handleA, rendition);
    expect(other.status).toBe(404); expect(await other.json()).toEqual({ error: 'not_found' });
  }
  // A Range request is answered with the whole object after the same gate, never a partial or ungated read.
  const ranged = await worker.fetch(new Request(`${ORIGIN}/api/v1/sessions/${r.room.sessionId}/media/${r.handleA}/phone`,
    { headers: { authorization: `Bearer ${r.participant.token}`, range: 'bytes=0-3', 'x-case-schema': '3' } }), localEnv);
  expect(ranged.status).toBe(200); expect(ranged.headers.get('content-range')).toBeNull();
  expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(JPEG);
  const rangedEarly = await worker.fetch(new Request(`${ORIGIN}/api/v1/sessions/${r.room.sessionId}/media/${r.handleB}/phone`,
    { headers: { authorization: `Bearer ${r.participant.token}`, range: 'bytes=0-3', 'x-case-schema': '3' } }), localEnv);
  expect(rangedEarly.status).toBe(404);
  // B was never released to the public roles; the facilitator may fetch every image of its room.
  expect((await r.media(r.participant.token, r.handleB, 'phone')).status).toBe(404);
  expect((await r.media(r.room.facilitatorToken, r.handleB, 'display')).status).toBe(200);
  // No credential, a malformed handle or rendition: refused without a lookup that could leak.
  expect((await r.media(null, r.handleA)).status).toBe(401);
  expect((await r.media(r.participant.token, 'not-a-handle')).status).toBe(404);
  expect((await api(`/sessions/${r.room.sessionId}/media/${r.handleA}/original`, { token: r.participant.token })).status).toBe(404);
  // A withdrawn image (its bytes deleted) answers 410 to a role that already holds its handle (B1), and so does the
  // same key stored again after the room started: it is not the image this room was started with.
  await env.MEDIA.delete(r.key('b'));
  const gone = await r.media(r.participant.token, r.handleA, 'phone');
  expect(gone.status).toBe(410);
  expect(await gone.json()).toEqual({ error: 'withdrawn' });
  await new Promise(resolve => setTimeout(resolve, 5));
  await env.MEDIA.put(r.key('b'), JPEG);
  expect((await r.media(r.participant.token, r.handleA, 'phone')).status).toBe(410);
  // A public credential reads one rendition at most 24 times in ten minutes (S6): five reloads and paging back over more
  // than a phone's eight held images fit; a loop does not. The facilitator, whose console prefetches every image on each
  // load, has no per-image count (only the room's image bucket).
  const reads = [];
  for (let i = 0; i < 24; i++) reads.push((await r.media(r.display.token, r.handleA, 'display')).status);
  expect(reads.slice(0, 23)).toEqual(new Array(23).fill(200));
  expect(reads[23]).toBe(429);
  const facilitatorReads = [];
  for (let i = 0; i < 30; i++) facilitatorReads.push((await r.media(r.room.facilitatorToken, r.handleB, 'display')).status);
  expect(facilitatorReads).toEqual(new Array(30).fill(200));
  // No MEDIA binding configured: unavailable, never a false "withdrawn".
  const unbound = await worker.fetch(new Request(`${ORIGIN}/api/v1/sessions/${r.room.sessionId}/media/${r.handleB}/display`, { headers: { authorization: `Bearer ${r.room.facilitatorToken}` } }), { ...localEnv, MEDIA: undefined });
  expect(unbound.status).toBe(503);
});

it('[AS-168] a handle belongs to its room: another room\'s credential and session never reach it', async () => {
  const first = await startRoom();
  await first.command('start');
  for (let shown = 1; shown < first.steps; shown++) await first.command('advance');
  vi.unstubAllGlobals();
  const second = await startRoom();
  // The second room's participant, on its own room's route, asking for the first room's released handle.
  expect((await second.media(second.participant.token, first.handleA, 'phone')).status).toBe(404);
  // The second room's credential on the first room's route is not a credential of that room.
  expect((await first.media(second.participant.token, first.handleA, 'phone')).status).toBe(401);
});

it('[AS-168] red-team N1: an author storing the same bytes again leaves a live room\'s approved image in place', async () => {
  const sha = hex(await crypto.subtle.digest('SHA-256', UPLOADABLE)), phoneKey = `media/${workspaceId}/${sha}.jpg`;
  await env.MEDIA.put(phoneKey, UPLOADABLE);
  const r = await startRoom({ phoneKeyA: phoneKey });
  await r.command('start');
  for (let shown = 1; shown < r.steps; shown++) await r.command('advance');
  expect((await r.media(r.participant.token, r.handleA, 'phone')).status).toBe(200);
  const uploaded = (await env.MEDIA.head(phoneKey)).uploaded.getTime();
  await new Promise(resolve => setTimeout(resolve, 5));
  r.fake.replies.set('builder_media_put_allowance', true);
  r.fake.replies.set('media_known_keys', [{ r2_key: phoneKey }]);
  const again = await worker.fetch(new Request(`${ORIGIN}/api/v1/builder/workspaces/${workspaceId}/media/phone`, { method: 'PUT', body: UPLOADABLE,
    headers: { authorization: `Bearer ${await jwt()}`, 'content-type': 'image/jpeg' } }), localEnv);
  expect(again.status).toBe(200);
  expect((await again.json()).sha256).toBe(sha);
  expect((await env.MEDIA.head(phoneKey)).uploaded.getTime()).toBe(uploaded);
  expect((await r.media(r.participant.token, r.handleA, 'phone')).status).toBe(200);
});

it('[AS-168] a released video: phones get its poster and then the video, each with its own type; only the facilitator plays it, and only the projector follows', async () => {
  const r = await startRoom({ videoA: true });
  await r.command('start');
  // No revision fence: playback is not a step.
  const control = async payload => {
    const now = JSON.parse(await r.read(r.room.facilitatorToken));
    const response = await api(`/sessions/${r.room.sessionId}/commands`, { method: 'POST', token: r.room.facilitatorToken,
      body: { v: WIRE_VERSION, type: 'media_control', epoch: now.epoch, clientEventId: uuidv7(), ...payload } });
    return (await response.json()).receipt;
  };
  // Before its step is released the projector does not show it, so it cannot be played.
  const hidden = JSON.parse(await r.read(r.room.facilitatorToken)).view.liveSurface.slide.blocks.find(block => block.type === 'image');
  expect((await control({ blockId: hidden.id, action: 'play', position: 0 })).reason).toBe('not_revealed');
  for (let shown = 1; shown < r.steps; shown++) await r.command('advance');
  const display = JSON.parse(await r.read(r.display.token)).view;
  const video = display.surface.slide.blocks.find(block => block.type === 'image');
  expect(video.media).toEqual({ handle: r.handleA, width: 1280, height: 720, credit: null, type: 'video/mp4', durationMs: 42000 });
  const poster = await r.media(r.participant.token, r.handleA, 'poster');
  expect([poster.status, poster.headers.get('content-type')]).toEqual([200, 'image/jpeg']);
  const file = await r.media(r.participant.token, r.handleA, 'phone');
  expect([file.status, file.headers.get('content-type'), file.headers.get('content-security-policy')]).toEqual([200, 'video/mp4', "default-src 'none'; frame-ancestors 'none'; sandbox"]);
  expect(new Uint8Array(await file.arrayBuffer())).toEqual(VIDEO);
  expect((await r.media(r.display.token, r.handleA, 'display')).headers.get('content-type')).toBe('video/mp4');
  // A still image has no poster.
  expect((await r.media(r.room.facilitatorToken, r.handleB, 'poster')).status).toBe(404);
  // Play: the projector's view carries the playback; a phone's never does.
  expect(display.playback).toBeUndefined();
  expect((await control({ blockId: video.id, action: 'play', position: 0 })).receipt).toBe('accepted');
  const playing = JSON.parse(await r.read(r.display.token)).view.playback;
  expect(playing).toMatchObject({ blockId: video.id, playing: true, at: 0 });
  expect(JSON.parse(await r.read(r.room.facilitatorToken)).view.playback).toMatchObject({ blockId: video.id, playing: true });
  expect(JSON.parse(await r.read(r.participant.token)).view.playback).toBeUndefined();
  expect((await control({ blockId: video.id, action: 'pause', position: 12.5 })).receipt).toBe('accepted');
  expect(JSON.parse(await r.read(r.display.token)).view.playback).toMatchObject({ blockId: video.id, playing: false, at: 12.5 });
  // A block that is not a released video on the projector is refused.
  const snap = JSON.parse(await r.read(r.room.facilitatorToken));
  const refused = await api(`/sessions/${r.room.sessionId}/commands`, { method: 'POST', token: r.room.facilitatorToken,
    body: { v: WIRE_VERSION, type: 'media_control', epoch: snap.epoch, clientEventId: uuidv7(), blockId: uuidv7(), action: 'play', position: 0 } });
  expect((await refused.json()).receipt?.reason).toBe('not_revealed');
  // A participant cannot send it at all.
  const phone = await api(`/sessions/${r.room.sessionId}/commands`, { method: 'POST', token: r.participant.token,
    body: { v: WIRE_VERSION, type: 'media_control', epoch: snap.epoch, clientEventId: uuidv7(), blockId: video.id, action: 'play', position: 0 } });
  const phoneBody = await phone.json();
  expect(phone.status >= 400 || phoneBody.receipt?.receipt === 'rejected').toBe(true);
  expect(JSON.parse(await r.read(r.display.token)).view.playback).toMatchObject({ blockId: video.id, playing: false, at: 12.5 });
});
