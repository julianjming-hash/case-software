// Animated GIF and video evidence (card 59 M2; Julian's re-ruling of J1, 2026-10-15). The Builder removes what can carry
// names, dates or places without touching a frame; the Worker refuses any file that still carries it, and refuses
// formats that would not play everywhere or could decode to an unbounded size.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectGif, cleanGif, GIF_LIMITS } from '../src/shared/media-gif.mjs';
import { inspectMp4, cleanMp4, VIDEO_LIMITS } from '../src/shared/media-mp4.mjs';
import { gifFixture, mp4Fixture, FIXTURE_LOCATION } from './helpers/media-fixtures.mjs';

const has = (bytes, text) => Buffer.from(bytes).includes(text);

test('[AS-167] an animated GIF passes as it is; comments, XMP and plain text are refused, and the Builder removes them without touching a frame', () => {
  assert.deepEqual(inspectGif(gifFixture()), { ok: true, width: 32, height: 24, frames: 2 });
  for (const [name, options, reason] of [['comment', { comment: 'Patient: J Smith 02/03' }, 'comment'], ['XMP', { xmp: '<x:xmpmeta>MRN 1234567</x:xmpmeta>' }, 'metadata'],
    ['plain text', { plainText: true }, 'plain_text']]) {
    const dirty = gifFixture(options);
    assert.equal(inspectGif(dirty).reason, reason, name);
    const cleaned = cleanGif(dirty);
    assert.deepEqual(inspectGif(cleaned), { ok: true, width: 32, height: 24, frames: 2 }, `${name}: cleaned`);
    assert.deepEqual(cleaned, gifFixture(), `${name}: the cleaned GIF is the plain one, frame for frame`);
    assert.ok(!has(cleaned, 'Smith') && !has(cleaned, 'MRN') && !has(cleaned, 'Patient'));
  }
  assert.equal(inspectGif(gifFixture({ trailing: true })).reason, 'trailing_bytes');
  assert.equal(cleanGif(gifFixture({ trailing: true })), null);
  assert.equal(inspectGif(gifFixture().subarray(0, 60)).reason, 'truncated');
  assert.equal(inspectGif(new TextEncoder().encode('<svg onload=alert(1)>')).reason, 'not_gif');
});

test('[AS-167] a GIF that would decode to too many frames or pixels is refused (decode bomb)', () => {
  // Pinned (red-team S8): derived from the constant, a raised bound would raise the test with it.
  assert.equal(GIF_LIMITS.maxPixels, 100_000_000, 'decoded pixels a phone may be asked to hold');
  const edge = GIF_LIMITS.maxEdge, frames = Math.ceil(100_000_000 / (edge * edge)) + 1;
  assert.equal(inspectGif(gifFixture({ width: edge, height: edge, frames, emptyFrames: true })).reason, 'decode_bomb');
  assert.equal(inspectGif(gifFixture({ width: 16, height: 16, frames: GIF_LIMITS.maxFrames + 1, emptyFrames: true })).reason, 'decode_bomb');
  assert.equal(inspectGif(gifFixture({ width: 16, height: 16, frames: GIF_LIMITS.maxFrames, emptyFrames: true })).ok, true);
  assert.equal(inspectGif(gifFixture({ width: edge + 1, height: 16 })).reason, 'bad_size');
});

test('[AS-167] a phone video is cleaned in place: location, device and time data, a metadata track and hidden bytes are gone, every offset unchanged', () => {
  assert.deepEqual(inspectMp4(mp4Fixture()), { ok: true, width: 640, height: 360, seconds: 10, audio: true });
  const phone = mp4Fixture({ udta: true, moovMeta: true, uuid: true, metaTrack: true, times: true, hidden: true });
  assert.ok(has(phone, FIXTURE_LOCATION) && has(phone, 'MRN'));
  assert.equal(inspectMp4(phone).reason, 'metadata', 'the Worker refuses the uncleaned file');
  const cleaned = cleanMp4(phone);
  assert.deepEqual([cleaned.width, cleaned.height, cleaned.seconds, cleaned.audio], [640, 360, 10, true]);
  assert.equal(cleaned.bytes.length, phone.length, 'cleaned in place: no box moved');
  assert.ok(!has(cleaned.bytes, FIXTURE_LOCATION) && !has(cleaned.bytes, 'MRN') && !has(cleaned.bytes, 'com.apple.quicktime.location'));
  assert.equal(inspectMp4(cleaned.bytes).ok, true);
  assert.ok(has(phone, FIXTURE_LOCATION), 'the input is not modified');
  // Each fault alone is refused by the Worker and removed by the Builder.
  for (const fault of ['udta', 'moovMeta', 'uuid', 'metaTrack', 'times', 'hidden']) {
    const dirty = mp4Fixture({ [fault]: true });
    assert.equal(inspectMp4(dirty).ok, false, fault);
    assert.equal(inspectMp4(cleanMp4(dirty).bytes).ok, true, fault);
  }
});

test('[AS-167] video that would not play everywhere, is too long or too large, is fragmented or points outside itself is refused with a reason', () => {
  for (const [options, reason] of [[{ codec: 'hvc1' }, 'hevc'], [{ codec: 'vp09' }, 'unsupported_codec'], [{ seconds: VIDEO_LIMITS.maxSeconds + 10 }, 'too_long'],
    [{ fragmented: true }, 'fragmented'], [{ external: true }, 'external_data'], [{ videoTracks: 2 }, 'bad_structure'], [{ width: 4096, height: 2160 }, 'bad_size']]) {
    assert.equal(inspectMp4(mp4Fixture(options)).reason, reason, JSON.stringify(options));
    assert.equal(cleanMp4(mp4Fixture(options)).reason, reason, `clean ${JSON.stringify(options)}`);
  }
  assert.equal(inspectMp4(mp4Fixture({ audio: false })).audio, false, 'sound is optional');
  assert.equal(inspectMp4(new Uint8Array(VIDEO_LIMITS.maxBytes + 1)).reason, 'too_large');
  assert.equal(inspectMp4(mp4Fixture().subarray(0, 300)).reason, 'truncated');
  assert.equal(inspectMp4(new TextEncoder().encode('<html><script>alert(1)</script>')).ok, false);
});

test('[AS-167] red-team S2: the re-walk checks contents, not just box types; the Builder blanks or drops what it can', () => {
  for (const [name, options] of [['a handler name (an app or device name)', { handlerName: 'Core Media Video' }], ['an encoder box inside the sample entry', { avcChild: 'Xenc' }],
    ['an object descriptor', { iods: true }], ['an edit list (hidden frames)', { edts: true }]]) {
    const dirty = mp4Fixture(options);
    assert.equal(inspectMp4(dirty).reason, 'metadata', name);
    const cleaned = cleanMp4(dirty);
    assert.equal(inspectMp4(cleaned.bytes).ok, true, `${name}: cleaned`);
    assert.equal(cleaned.bytes.length, dirty.length, `${name}: in place`);
  }
  assert.ok(!has(cleanMp4(mp4Fixture({ handlerName: 'iPhone 15 Pro' })).bytes, 'iPhone'));
  assert.equal(inspectMp4(mp4Fixture({ mvhdTail: 4 })).reason, 'bad_box', 'bytes after a header box\'s fields');
  assert.equal(inspectMp4(mp4Fixture({ tableTail: 4 })).reason, 'bad_box', 'bytes past a table\'s count');
  assert.equal(cleanMp4(mp4Fixture({ mvhdTail: 4 })).reason, 'bad_box');
  // Residue (re-check): the allowed sample-entry boxes have exact lengths, so none carries text; a colour box is never an
  // ICC profile; the movie header's matrix and reserved fields are the standard ones.
  const text = new TextEncoder().encode('Encoder: Patient Cam 2');
  const fourcc = kind => new TextEncoder().encode(kind);
  for (const type of ['pasp', 'colr', 'btrt', 'clap', 'fiel']) {
    const dirty = mp4Fixture({ avcChild: [type, text] });
    assert.equal(inspectMp4(dirty).reason, 'metadata', `${type} holding text`);
    const cleaned = cleanMp4(dirty);
    assert.equal(inspectMp4(cleaned.bytes).ok, true, `${type}: cleaned`);
    assert.ok(!has(cleaned.bytes, 'Patient'), `${type}: text gone`);
  }
  for (const [type, body] of [['pasp', new Uint8Array(8)], ['btrt', new Uint8Array(12)], ['clap', new Uint8Array(32)], ['fiel', Uint8Array.of(1, 0)],
    ['colr', Uint8Array.of(...fourcc('nclx'), 0, 1, 0, 1, 0, 1, 0)], ['colr', Uint8Array.of(...fourcc('nclc'), 0, 1, 0, 1, 0, 1)]]) {
    assert.equal(inspectMp4(mp4Fixture({ avcChild: [type, body] })).ok, true, `a standard ${type}`);
  }
  assert.equal(inspectMp4(mp4Fixture({ avcChild: ['colr', Uint8Array.of(...fourcc('prof'), ...new Uint8Array(7))] })).reason, 'metadata', 'an ICC profile');
  const odd = Uint8Array.of(...text.subarray(0, 16), ...new Uint8Array(20));
  assert.equal(inspectMp4(mp4Fixture({ matrix: odd })).reason, 'metadata', 'text in the movie matrix');
  const normal = cleanMp4(mp4Fixture({ matrix: odd }));
  assert.equal(inspectMp4(normal.bytes).ok, true); assert.ok(!has(normal.bytes, 'Encoder'));
});

test('[AS-167] red-team S4: a track, or its sample durations, cannot run past two minutes behind a short movie header', () => {
  assert.equal(inspectMp4(mp4Fixture({ mdhdSeconds: VIDEO_LIMITS.maxSeconds + 30 })).reason, 'too_long');
  assert.equal(inspectMp4(mp4Fixture({ sttsDelta: 60_000 })).reason, 'too_long', 'four samples of a minute each');
  assert.equal(inspectMp4(mp4Fixture({ sttsDelta: 1000 })).ok, true);
  // Residue (re-check): durations must cover exactly the samples. One 100 s duration for four samples read as 10 s before.
  assert.equal(inspectMp4(mp4Fixture({ sttsCount: 1, sttsDelta: 100_000 })).reason, 'bad_track', 'durations for 1 of 4 samples');
  assert.equal(inspectMp4(mp4Fixture({ sttsCount: 5 })).reason, 'bad_track', 'durations for 5 of 4 samples');
});

test('[AS-167] red-team S1/N2: bounded work: boxes per container, media-data boxes, and samples and chunks per track', () => {
  assert.equal(inspectMp4(mp4Fixture({ freeBoxes: VIDEO_LIMITS.maxChildren })).reason, 'bad_structure');
  assert.equal(inspectMp4(mp4Fixture({ extraMdats: VIDEO_LIMITS.maxMdats })).reason, 'bad_structure');
  // Pinned: two minutes of 240 fps is 28,800 frames. A million one-byte chunks (5 MB) grew the heap by ~124 MiB (N2).
  assert.equal(VIDEO_LIMITS.maxSamples, 50_000);
  assert.equal(inspectMp4(mp4Fixture({ videoSamples: new Array(50_001).fill(1), audio: false, sttsDelta: 1, chunkEach: true })).reason, 'bad_box');
  // The bound itself, one sample per chunk (every chunk is a separate range in the sweep), in one sweep and little memory.
  const many = mp4Fixture({ videoSamples: new Array(50_000).fill(1), audio: false, sttsDelta: 1, chunkEach: true });
  const heap = process.memoryUsage().heapUsed, started = performance.now(), checked = inspectMp4(many), took = performance.now() - started;
  const grew = (process.memoryUsage().heapUsed - heap) / 2 ** 20;
  assert.equal(checked.ok, true);
  assert.ok(took < 1000, `took ${Math.round(took)} ms`);
  assert.ok(grew < 32, `heap grew ${grew.toFixed(1)} MiB`);
});

test('[AS-167] red-team S3: no damaged file crashes the check; each is refused with a reason (500 mutations)', () => {
  const base = cleanMp4(mp4Fixture()).bytes;
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let i = 0; i < 500; i++) {
    const bytes = Uint8Array.from(base);
    for (let k = 0; k < 4; k++) bytes[Math.floor(random() * bytes.length)] = Math.floor(random() * 256);
    const cut = random() < 0.3 ? bytes.subarray(0, Math.floor(random() * bytes.length)) : bytes;
    const checked = inspectMp4(cut), cleaned = cleanMp4(cut);
    assert.equal(typeof checked.ok, 'boolean');
    assert.ok(checked.ok || typeof checked.reason === 'string');
    assert.ok(cleaned.bytes || typeof cleaned.reason === 'string');
  }
});

test('[AS-167] red-team S3: a sample description cut short at the very end of the file is refused, not a crash', () => {
  const ascii = text => Uint8Array.from(text, c => c.charCodeAt(0));
  const u32 = v => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  const cat = parts => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
  const box = (type, ...body) => { const b = cat(body); return cat([Uint8Array.of(...u32(8 + b.length)), ascii(type), b]); };
  const full = (type, ...body) => box(type, new Uint8Array(4), ...body);
  const matrix = Uint8Array.of(0, 1, 0, 0, ...new Array(12).fill(0), 0, 1, 0, 0, ...new Array(12).fill(0), 64, 0, 0, 0);
  // moov is the last box, and its innermost last box (stsd) has no body: any read of its count runs past the buffer.
  const file = cat([box('ftyp', ascii('isom'), new Uint8Array(4)), box('mdat'), box('moov',
    full('mvhd', new Uint8Array(8), Uint8Array.of(...u32(1000), ...u32(1000), 0, 1, 0, 0, 1, 0), new Uint8Array(10), matrix, new Uint8Array(24), Uint8Array.of(...u32(2))),
    box('trak', full('tkhd', new Uint8Array(20), new Uint8Array(16), matrix, Uint8Array.of(...u32(640 << 16), ...u32(360 << 16))),
      box('mdia', full('mdhd', new Uint8Array(8), Uint8Array.of(...u32(1000), ...u32(1000), 0x55, 0xc4, 0, 0)), full('hdlr', new Uint8Array(4), ascii('vide'), new Uint8Array(12)),
        box('minf', box('stbl', box('stsd'))))))]);
  assert.deepEqual(inspectMp4(file), { ok: false, reason: 'bad_track' });
  assert.deepEqual(cleanMp4(file), { reason: 'bad_track' });
  // Every truncation of a valid file is refused with a reason.
  const valid = cleanMp4(mp4Fixture()).bytes;
  for (let cut = 0; cut < valid.length; cut += 7) assert.equal(typeof inspectMp4(valid.subarray(0, cut)).reason, 'string');
});
