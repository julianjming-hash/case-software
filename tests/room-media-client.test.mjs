// Room images on public screens (card 59 M3, CASE-269). Red-team S6: a read the room refuses for now (429) is retried with
// a growing pause, then once a window; a withdrawn image is never retried; ending the room frees every held image and
// cancels pending retries. Red-team H1: a slide with many images is fetched once per image, never in an evict-and-refetch
// loop, and no screen fetches one image more often than the room allows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoomMedia, MEDIA_HELD, acceptLocalMedia, acceptMediaWanted, createMediaRelay, validMedia } from '../src/client/room-media.mjs';
import { SLIDE_LIMITS } from '../src/shared/slide-document.mjs';

const JPEG = () => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]).buffer;
const block = handle => ({ type: 'image', media: { handle, width: 1200, height: 800, credit: null } });
const settle = () => new Promise(resolve => setImmediate(resolve));

function harness(answers, options = {}) {
  const loads = [], pending = new Map();
  let next = 0, clock = 1_000_000;
  const media = createRoomMedia({
    load: handle => { loads.push(handle); return answers(loads.length, handle); },
    wait: (fn, ms) => { const id = ++next; pending.set(id, { fn, ms }); return id; },
    unwait: id => pending.delete(id),
    now: () => clock,
    ...options,
  });
  // Fire the oldest pause, moving the clock to its end.
  const fire = () => { const [id, { fn, ms }] = pending.entries().next().value; pending.delete(id); clock += ms; fn(); return ms; };
  return { media, loads, pending, fire, tick: ms => { clock += ms; } };
}

test('[AS-168] red-team S6: a refused read (429) shows as missing, then is fetched again after a growing pause', async () => {
  const h = harness(n => (n < 3 ? { state: 'busy' } : { bytes: JPEG() }));
  assert.equal(h.media.resolve(block('h1')).url, null);
  await settle();
  assert.equal(h.media.resolve(block('h1')).state, 'missing');
  assert.equal(h.loads.length, 1, 'no new request while the pause runs');
  const first = h.fire();
  h.media.resolve(block('h1')); await settle();
  const second = h.fire();
  assert.ok(second > first, `the pause grows (${first} then ${second} ms)`);
  const shown = h.media.resolve(block('h1')); await settle();
  assert.equal(h.loads.length, 3);
  assert.match(h.media.resolve(block('h1')).url, /^blob:/);
  assert.equal(shown.state, undefined);
  h.media.dispose();
});

test('[AS-168] red-team S6: retries stop after their limit, and a withdrawn image is never asked for again', async () => {
  const busy = harness(() => ({ state: 'busy' }));
  busy.media.resolve(block('h2')); await settle();
  for (let retry = 0; retry < 5; retry++) { busy.fire(); busy.media.resolve(block('h2')); await settle(); }
  assert.equal(busy.loads.length, 6, 'the first read and five retries');
  assert.equal(busy.media.resolve(block('h2')).state, 'missing');
  const [{ ms: windowPause }] = [...busy.pending.values()];
  assert.ok(windowPause >= 0.75 * 10 * 60 * 1000 && windowPause <= 1.25 * 10 * 60 * 1000, `then one more try after about a whole window (${windowPause} ms)`);
  const gone = harness(() => ({ state: 'withdrawn' }));
  gone.media.resolve(block('h3')); await settle();
  assert.equal(gone.pending.size, 0);
  assert.equal(gone.media.resolve(block('h3')).state, 'withdrawn');
});

test('[AS-168] ending the room frees held images and cancels pending retries; a later view fetches again', async () => {
  const h = harness(n => (n === 1 ? { bytes: JPEG() } : { state: 'busy' }));
  h.media.resolve(block('h4')); await settle();
  const url = h.media.resolve(block('h4')).url;
  assert.match(url, /^blob:/);
  h.media.resolve(block('h5')); await settle();
  assert.equal(h.pending.size, 1);
  h.media.clear();
  assert.equal(h.pending.size, 0, 'the pending retry is cancelled');
  await assert.rejects(fetch(url), 'the freed image URL no longer resolves');
  h.media.resolve(block('h4'));
  assert.equal(h.loads.length, 3);
  h.media.dispose();
});

// A screen that redraws its slide whenever an image arrives (as the phone and projector do), counting fetches.
async function drawSlide(count, options = {}) {
  const blocks = Array.from({ length: count }, (_, i) => block(`img-${i}`));
  let media;
  const h = harness(() => ({ bytes: JPEG() }), { onChange: () => { for (const item of blocks) media.resolve(item); }, ...options });
  media = h.media;
  for (const item of blocks) media.resolve(item);
  for (let turn = 0; turn < 50; turn++) await settle();
  return { ...h, blocks };
}

test('[AS-168] red-team H1: a slide with 9, 16 or 32 images fetches each image once, however often it redraws', async () => {
  assert.equal(MEDIA_HELD, SLIDE_LIMITS.compositionBlocks, 'a screen holds as many images as a slide has blocks');
  for (const count of [9, 16, 32]) {
    const h = await drawSlide(count);
    assert.equal(h.loads.length, count, `${count} images`);
    assert.ok(h.blocks.every(item => /^blob:/.test(h.media.resolve(item).url)));
    h.media.dispose();
  }
});

test('[AS-168] red-team H1: even a screen that holds too few images cannot loop; each image is fetched at most 20 times a window', async () => {
  const h = await drawSlide(9, { limit: 8 });
  assert.ok(h.loads.length <= 9 * 20, `bounded (${h.loads.length} fetches)`);
  const perImage = new Map();
  for (const handle of h.loads) perImage.set(handle, (perImage.get(handle) ?? 0) + 1);
  assert.ok([...perImage.values()].every(n => n <= 20));
  h.media.dispose();
});

const MP4 = () => Uint8Array.from([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 2, 0, 0, 0, 0, 8, 109, 100, 97, 116]).buffer;
const GIF = () => Uint8Array.from([71, 73, 70, 56, 57, 97, 16, 0, 16, 0, 0, 0, 0, 59]).buffer;
const videoBlock = handle => ({ type: 'image', media: { handle, width: 1280, height: 720, credit: null, type: 'video/mp4', durationMs: 42000 } });

test('[AS-168] a phone shows a video\'s poster and fetches the video only when the learner taps it; the projector fetches the video itself', async () => {
  const loads = [];
  const phone = createRoomMedia({ role: 'phone', load: (handle, rendition) => { loads.push(rendition); return rendition === 'poster' ? { bytes: JPEG(), type: 'image/jpeg' } : { bytes: MP4(), type: 'video/mp4' }; } });
  phone.resolve(videoBlock('v1')); await settle();
  const before = phone.resolve(videoBlock('v1'));
  assert.deepEqual([before.url, before.type, before.controls, loads], [null, 'video/mp4', true, ['poster']]);
  assert.match(before.poster, /^blob:/);
  phone.play('v1'); phone.resolve(videoBlock('v1')); await settle();
  const after = phone.resolve(videoBlock('v1'));
  assert.deepEqual(loads, ['poster', 'phone']);
  assert.match(after.url, /^blob:/); assert.match(after.poster, /^blob:/);
  phone.dispose();
  const projectorLoads = [];
  const projector = createRoomMedia({ role: 'display', load: (handle, rendition) => { projectorLoads.push(rendition); return { bytes: MP4(), type: 'video/mp4' }; } });
  projector.resolve(videoBlock('v2')); await settle();
  assert.deepEqual([projectorLoads, projector.resolve(videoBlock('v2')).controls], [['display'], false]);
  projector.dispose();
});

test('[AS-168] only the stored types reach a screen: bytes must match their declared type, and a relayed frame names its type', async () => {
  assert.equal(validMedia(MP4(), 'video/mp4'), true);
  assert.equal(validMedia(GIF(), 'image/gif'), true);
  assert.equal(validMedia(JPEG(), 'video/mp4'), false, 'a JPEG is not a video');
  assert.equal(validMedia(MP4(), 'text/html'), false);
  const posted = [];
  const relay = createMediaRelay({ load: async (handle, rendition) => ({ bytes: MP4(), type: 'video/mp4', rendition }), post: frame => posted.push(frame), sessionId: 's1' });
  await relay.frame({ surface: { slide: { blocks: [videoBlock('01a0f4c9-8abb-74fc-aef7-56efce51760f')] } } });
  assert.equal(posted[0].type, 'video/mp4');
  assert.ok(acceptLocalMedia(posted[0], 's1'));
  assert.equal(acceptLocalMedia({ ...posted[0], type: 'image/gif' }, 's1'), null, 'declared GIF, bytes of a video');
  const { type: _type, ...untyped } = posted[0];
  assert.equal(acceptLocalMedia(untyped, 's1'), null);
});

test('[AS-168] a screen that spent its reads of one image asks again once, after the window, not on every draw', async () => {
  const h = await drawSlide(9, { limit: 8 });
  assert.ok(h.pending.size > 0, 'a retry is scheduled for an image whose reads are spent');
  const before = h.loads.length;
  for (let draw = 0; draw < 50; draw++) h.media.resolve(block('img-0'));
  await settle();
  assert.equal(h.loads.length, before, 'redraws inside the window fetch nothing');
  h.media.dispose();
});

test('[AS-168] red-team M3-B1: over a minute of hellos the same-PC projector keeps one blob for a playing video; a reloaded window gets the file again without replacing a held one', async () => {
  const posted = [], handle = '01a0f4c9-8abb-74fc-aef7-56efce51760f', view = { surface: { slide: { blocks: [videoBlock(handle)] } } };
  let clock = 0; // a simulated minute: the relay may not resend on a timer, whatever the clock says
  const relay = createMediaRelay({ load: async () => ({ bytes: MP4(), type: 'video/mp4' }), post: frame => posted.push(frame), sessionId: 's1', now: () => clock });
  const projector = createRoomMedia({ role: 'display' });
  // A hello every 4 s publishes a frame; the console relays each file once per projector window.
  for (let second = 0; second <= 60; second += 4) {
    clock = second * 1000;
    await relay.frame(view);
    for (const frame of posted.splice(0)) projector.put(frame.handle, frame.bytes, frame.type);
    if (second === 0) var first = projector.resolve(videoBlock(handle)).url; // eslint-disable-line no-var
    assert.equal(projector.resolve(videoBlock(handle)).url, first, `at ${second} s the video's blob is unchanged`);
  }
  assert.match(first, /^blob:/);
  // The window reloads: it says projector_ready, the console resets and sends again; a window that still holds it keeps it.
  relay.reset(); await relay.frame(view);
  assert.equal(posted.length, 1);
  projector.put(posted[0].handle, posted[0].bytes, posted[0].type);
  assert.equal(projector.resolve(videoBlock(handle)).url, first);
  projector.dispose();
});

test('[AS-168] red-team S6: a phone shows a GIF\'s poster and loads the animation only when tapped; peeking never fetches', async () => {
  const loads = [], gifBlock = { type: 'image', media: { handle: 'g1', width: 32, height: 24, credit: null, type: 'image/gif', durationMs: null } };
  const phone = createRoomMedia({ role: 'phone', load: (handle, rendition) => { loads.push(rendition); return rendition === 'poster' ? { bytes: JPEG(), type: 'image/jpeg' } : { bytes: GIF(), type: 'image/gif' }; } });
  assert.equal(phone.resolve(gifBlock, { peek: true }).url, null);
  assert.deepEqual(loads, [], 'a peek fetches nothing');
  phone.resolve(gifBlock); await settle();
  assert.deepEqual(loads, ['poster']);
  assert.equal(phone.resolve(gifBlock).url, null);
  phone.play('g1'); phone.resolve(gifBlock); await settle();
  assert.deepEqual(loads, ['poster', 'phone']);
  assert.match(phone.resolve(gifBlock).url, /^blob:/);
  assert.equal(phone.resolve(gifBlock).controls, false, 'a GIF has no player controls');
  phone.dispose();
});

test('[AS-168] red-team N1: a same-PC projector that evicted a released image gets it back: 33 one-image slides, then slide 1 again', async () => {
  const handles = Array.from({ length: MEDIA_HELD + 1 }, (_, i) => `01a0f4c9-8abb-74fc-aef7-${String(i).padStart(12, '0')}`);
  const toProjector = [], toConsole = [], fetched = [];
  const relay = createMediaRelay({ load: async handle => { fetched.push(handle); return { bytes: JPEG(), type: 'image/jpeg' }; }, post: frame => toProjector.push(frame), sessionId: 's1' });
  const projector = createRoomMedia({ role: 'display', want: handle => toConsole.push({ t: 'projector_wants', sessionId: 's1', handle }) });
  // The local channel, both ways, until it is quiet.
  const pump = async () => {
    for (let round = 0; round < 5; round++) {
      await settle();
      for (const frame of toProjector.splice(0)) { const image = acceptLocalMedia(frame, 's1'); if (image) projector.put(image.handle, image.bytes, image.type); }
      for (const frame of toConsole.splice(0)) { const asked = acceptMediaWanted(frame, 's1'); if (asked) await relay.again(asked.handle); }
    }
  };
  const show = async handle => { await relay.frame({ surface: { slide: { blocks: [block(handle)] } } }); await pump(); projector.resolve(block(handle)); await pump(); return projector.resolve(block(handle)).url; };
  for (const handle of handles) assert.match(await show(handle), /^blob:/);
  assert.equal(projector.resolve(block(handles[0]), { peek: true }).url, null, 'the first image was evicted past 32');
  assert.match(await show(handles[0]), /^blob:/, 'back on slide 1, the projector shows its image again');
  assert.equal(fetched.filter(handle => handle === handles[0]).length, 1, 'from the console\'s memory, without a second read');
  projector.dispose();
});

test('[AS-168] red-team N1: the console resends only a file this projector window was already sent; the request is exact', async () => {
  const posted = [], released = '01a0f4c9-8abb-74fc-aef7-56efce51760f', hidden = '01a0f4c9-8abb-74fc-aef7-56efce517610';
  const relay = createMediaRelay({ load: async () => ({ bytes: JPEG(), type: 'image/jpeg' }), post: frame => posted.push(frame), sessionId: 's1' });
  await relay.again(released);
  assert.equal(posted.length, 0, 'never sent, never resent');
  await relay.frame({ surface: { slide: { blocks: [block(released)] } } });
  await relay.again(hidden); await relay.again(released);
  assert.deepEqual(posted.map(frame => frame.handle), [released, released], 'an unreleased handle is not sent on request');
  relay.reset(); await relay.again(released);
  assert.equal(posted.length, 2, 'a reloaded window is sent its media by the next frame, not by a request');
  assert.ok(acceptMediaWanted({ t: 'projector_wants', sessionId: 's1', handle: released }, 's1'));
  for (const frame of [{ t: 'projector_wants', sessionId: 's2', handle: released }, { t: 'projector_wants', sessionId: 's1', handle: 'x' },
    { t: 'projector_wants', sessionId: 's1', handle: released, rendition: 'display' }]) assert.equal(acceptMediaWanted(frame, 's1'), null);
});

test('[AS-168] red-team S8: a phone holds at most 48 MiB of media; a projector holds far more', async () => {
  const MiB = 1024 * 1024, big = () => { const bytes = new Uint8Array(11 * MiB); bytes.set([71, 73, 70, 56, 57, 97]); return bytes.buffer; };
  const gifBlock = handle => ({ type: 'image', media: { handle, width: 32, height: 24, credit: null, type: 'image/gif', durationMs: null } });
  const handles = ['g1', 'g2', 'g3', 'g4', 'g5'];
  const phone = createRoomMedia({ role: 'phone', load: (handle, rendition) => (rendition === 'poster' ? { bytes: JPEG(), type: 'image/jpeg' } : { bytes: big(), type: 'image/gif' }) });
  for (const handle of handles) { phone.play(handle); phone.resolve(gifBlock(handle)); await settle(); phone.resolve(gifBlock(handle)); await settle(); }
  const held = handles.filter(handle => phone.resolve(gifBlock(handle), { peek: true }).url);
  assert.deepEqual(held, ['g2', 'g3', 'g4', 'g5'], 'four 11 MiB GIFs (44 MiB) fit in 48 MiB; the fifth evicts the oldest');
  phone.dispose();
  const display = createRoomMedia({ role: 'display', load: () => ({ bytes: big(), type: 'image/gif' }) });
  for (const handle of handles) { display.resolve(gifBlock(handle)); await settle(); }
  assert.equal(handles.filter(handle => display.resolve(gifBlock(handle), { peek: true }).url).length, 5, 'a projector holds all five (55 MiB)');
  display.dispose();
});

test('[card 40b recap images] a held rendition is readable as its own bytes, so the recap PDF uses what the phone holds without fetching it again', async () => {
  const h = harness(() => ({ bytes: JPEG(), type: 'image/jpeg' }), { role: 'phone' });
  assert.equal(h.media.held('h9', 'phone'), null, 'nothing held before the first sight');
  h.media.resolve(block('h9')); await settle();
  const blob = h.media.held('h9', 'phone');
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), new Uint8Array(JPEG()));
  assert.equal(h.loads.length, 1, 'reading it fetched nothing');
  h.media.clear();
  assert.equal(h.media.held('h9', 'phone'), null, 'ending frees it');
});
