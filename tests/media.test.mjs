// Visual evidence media contract (card 59 M2): the structural JPEG check the Worker applies to every stored rendition,
// the Builder's own clean-up of its encoder output, the size allowlist and the author's rights details.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspectJpeg, cleanJpeg, renditionFits, assetDetails, inputKind, MEDIA_LIMITS } from '../src/shared/media.mjs';

const fixture = name => new Uint8Array(readFileSync(new URL(`./fixtures/media/${name}`, import.meta.url)));
const chromium = fixture('clean-64x48.jpg'), clean = cleanJpeg(chromium);
const segment = (marker, payload) => { const body = new TextEncoder().encode(payload); return Uint8Array.from([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body]); };
const splice = (bytes, at, insert) => Uint8Array.from([...bytes.subarray(0, at), ...insert, ...bytes.subarray(at)]);
const afterJfif = 2 + 2 + ((clean[4] << 8) | clean[5]);

test('[AS-167] the Builder strips its encoder\'s colour profile and the result passes the Worker\'s structural check', () => {
  assert.equal(inspectJpeg(chromium).reason, 'metadata', 'Chromium writes an ICC profile (APP2)');
  assert.deepEqual(inspectJpeg(clean), { ok: true, width: 64, height: 48 });
  assert.deepEqual(inspectJpeg(cleanJpeg(fixture('clean-300x200.jpg'))), { ok: true, width: 300, height: 200 });
  // Cleaning is idempotent and never touches the scan data.
  assert.deepEqual(cleanJpeg(clean), clean);
});

test('[AS-167] metadata, comments, trailing bytes, truncation and non-JPEG files are refused, never repaired', () => {
  const cases = {
    exif: [splice(clean, afterJfif, segment(0xe1, 'Exif\0\0GPS -33.86 151.21')), 'exif_or_xmp'],
    xmp: [splice(clean, afterJfif, segment(0xe1, 'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>')), 'exif_or_xmp'],
    iptc: [splice(clean, afterJfif, segment(0xed, 'Photoshop 3.0\0')), 'metadata'],
    comment: [splice(clean, afterJfif, segment(0xfe, 'Patient: J Citizen MRN 1234567')), 'comment'],
    trailingHtml: [Uint8Array.from([...clean, ...new TextEncoder().encode('<script>alert(1)</script>')]), 'trailing_bytes'],
    truncated: [clean.subarray(0, clean.length - 40), 'truncated'],
    png: [fixture('not-jpeg.png'), 'not_jpeg'],
    svg: [new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), 'not_jpeg'],
    empty: [new Uint8Array(0), 'not_jpeg'],
  };
  for (const [name, [bytes, reason]] of Object.entries(cases)) assert.deepEqual(inspectJpeg(bytes), { ok: false, reason }, name);
  // A second frame header (a stacked image) is refused.
  const sof = clean.findIndex((byte, index) => byte === 0xff && [0xc0, 0xc2].includes(clean[index + 1]));
  const length = (clean[sof + 2] << 8) | clean[sof + 3];
  assert.equal(inspectJpeg(splice(clean, sof, clean.subarray(sof, sof + 2 + length))).reason, 'bad_frame');
  // The cleaner refuses what it cannot make clean (appended data) instead of passing it on.
  assert.equal(cleanJpeg(cases.png[0]), null);
});

test('[AS-167] stored renditions stay inside the allowlisted sizes; ECG phone copies may be larger', () => {
  assert.equal(renditionFits('display', { width: 2400, height: 1600, bytes: 600 * 1024 }), true);
  assert.equal(renditionFits('display', { width: 2401, height: 1600, bytes: 1000 }), false);
  assert.equal(renditionFits('display', { width: 2400, height: 1600, bytes: 600 * 1024 + 1 }), false);
  assert.equal(renditionFits('phone', { width: 2000, height: 800, bytes: 400 * 1024 }), false);
  assert.equal(renditionFits('phone', { width: 2000, height: 800, bytes: 400 * 1024 }, { ecg: true }), true);
  assert.equal(renditionFits('phone', { width: 10, height: 800, bytes: 4000 }), false, 'a sliver is not an image');
  assert.equal(renditionFits('original', { width: 100, height: 100, bytes: 100 }), false);
});

test('[AS-167] rights details warn and never refuse (J2 as re-ruled): every source, a missing credit or licence note, an unticked de-identification check', () => {
  const base = { alt: '12-lead ECG, 25 mm/s, 10 mm/mV', evidenceKind: 'ecg', source: 'own', attested: true };
  assert.deepEqual(assetDetails(base), { ok: true, warnings: [], value: { alt: base.alt, evidenceKind: 'ecg', rightsBasis: 'own_work', licence: 'own-work', creator: '', attribution: '', rightsNote: '', sourceUrl: '', attested: true } });
  const fields = details => details.warnings.map(item => item.field);
  const unticked = assetDetails({ ...base, attested: false });
  assert.equal(unticked.ok, true); assert.deepEqual(fields(unticked), ['attested']); assert.equal(unticked.value.attested, false);
  assert.deepEqual(fields(assetDetails({ alt: base.alt, evidenceKind: 'ecg', source: 'own' })), ['attested'], 'leaving the tick out is the same as unticked');
  for (const source of ['ccbync', 'ccbyncsa', 'ccbynd', 'ccbyncnd', 'publication', 'unknown']) {
    const chosen = assetDetails({ ...base, source, attribution: 'Figure 3, A. Author' });
    assert.equal(chosen.ok, true, source); assert.deepEqual(fields(chosen), ['source'], source);
  }
  assert.equal(assetDetails({ ...base, source: 'ccbync' }).value.licence, 'CC-BY-NC-4.0');
  assert.deepEqual(fields(assetDetails({ ...base, source: 'ccby' })), ['attribution']);
  assert.deepEqual(fields(assetDetails({ ...base, source: 'ccby', attribution: 'Photo: A. Author, CC BY 4.0' })), []);
  assert.deepEqual(fields(assetDetails({ ...base, source: 'licensed', attribution: 'Licensed from X' })), ['rightsNote']);
  // Malformed text is still refused: these are input errors, not content decisions.
  assert.equal(assetDetails({ ...base, alt: ' ' }).field, 'alt');
  assert.equal(assetDetails({ ...base, source: 'stolen' }).field, 'source');
  assert.equal(assetDetails({ ...base, attested: 'yes' }).field, 'attested');
  assert.equal(assetDetails({ ...base, sourceUrl: 'http://example.com/a.jpg' }).field, 'sourceUrl');
  assert.equal(assetDetails({ ...base, sourceUrl: 'javascript:alert(1)' }).field, 'sourceUrl');
  assert.equal(assetDetails({ ...base, alt: 'ECG\u202e' }).field, 'alt', 'bidirectional overrides are refused');
  assert.equal(assetDetails({ ...base, extra: 1 }).field, 'body');
});

test('[AS-167] every file kind the Builder accepts (J1 as re-ruled) and the stored bounds for GIF and video', () => {
  assert.equal(inputKind({ type: 'image/png' }), 'still');
  assert.equal(inputKind({ type: 'image/avif' }), 'still');
  assert.equal(inputKind({ type: '', name: 'IMG_0001.HEIC' }), 'still');
  assert.equal(inputKind({ type: 'image/gif' }), 'gif');
  assert.equal(inputKind({ type: 'video/quicktime' }), 'video');
  assert.equal(inputKind({ type: '', name: 'clip.mov' }), 'video');
  assert.equal(inputKind({ type: 'application/pdf' }), null);
  assert.equal(MEDIA_LIMITS.inputBytes, 12 * 1024 * 1024, 'J3: 12 MB for images and GIFs');
  assert.equal(renditionFits('display', { width: 4096, height: 2000, bytes: 12 * 1024 * 1024 }, { type: 'image/gif' }), true);
  assert.equal(renditionFits('display', { width: 640, height: 360, bytes: 12 * 1024 * 1024 + 1 }, { type: 'image/gif' }), false);
  assert.equal(renditionFits('phone', { width: 1920, height: 1080, bytes: 25 * 1024 * 1024 }, { type: 'video/mp4' }), true);
  assert.equal(renditionFits('display', { width: 4096, height: 2160, bytes: 1000 }, { type: 'video/mp4' }), false);
  assert.equal(renditionFits('poster', { width: 2400, height: 1350, bytes: 600 * 1024 }), true);
  assert.equal(renditionFits('poster', { width: 640, height: 360, bytes: 1000 }, { type: 'video/mp4' }), false, 'a poster is always a JPEG');
});

test('[AS-167] red-team S1: text hidden in APP0 or a quantisation table, extra scans and non-baseline frames are refused', () => {
  const marker = (bytes, code) => bytes.findIndex((byte, index) => byte === 0xff && bytes[index + 1] === code);
  const seg = (bytes, at) => (bytes[at + 2] << 8) | bytes[at + 3];
  const withLength = (bytes, at, extra) => { const length = seg(bytes, at) + extra.length;
    return Uint8Array.from([...bytes.subarray(0, at + 2), length >> 8, length & 0xff, ...bytes.subarray(at + 4, at + 2 + seg(bytes, at)), ...extra, ...bytes.subarray(at + 2 + seg(bytes, at))]); };
  const html = new TextEncoder().encode('<script>alert(1)</script> MRN 1234567');
  assert.equal(inspectJpeg(withLength(clean, 2, html)).reason, 'metadata', 'a long APP0 carrying text');
  assert.equal(inspectJpeg(withLength(clean, marker(clean, 0xdb), html)).reason, 'bad_table', 'text after a DQT table');
  assert.equal(inspectJpeg(withLength(clean, marker(clean, 0xc4), html)).reason, 'bad_table', 'text after a DHT table');
  // Four more scans after the first: a decode bomb.
  const sos = marker(clean, 0xda), eoi = clean.length - 2, scan = clean.subarray(sos, eoi);
  const bomb = Uint8Array.from([...clean.subarray(0, eoi), ...scan, ...scan, ...scan, ...clean.subarray(eoi)]);
  assert.equal(inspectJpeg(bomb).reason, 'bad_scan');
  const progressive = Uint8Array.from(clean); progressive[marker(clean, 0xc0) + 1] = 0xc2;
  assert.equal(inspectJpeg(progressive).reason, 'unsupported_frame');
  const fourComponents = Uint8Array.from(clean); fourComponents[marker(clean, 0xc0) + 9] = 4;
  assert.equal(inspectJpeg(fourComponents).reason, 'bad_frame');
  assert.deepEqual(inspectJpeg(clean), { ok: true, width: 64, height: 48 }, 'the Builder output still passes');
});

test('[AS-167] red-team S1 tightening: 16-bit tables, overfull Huffman counts, repeated components, undefined tables and empty scans are refused', () => {
  const marker = (bytes, code) => bytes.findIndex((byte, index) => byte === 0xff && bytes[index + 1] === code);
  const mutate = (change) => { const bytes = Uint8Array.from(clean); change(bytes); return inspectJpeg(bytes).reason; };
  const sof = marker(clean, 0xc0), sos = marker(clean, 0xda);
  assert.equal(clean[sof + 9], 3, 'the fixture is a three-component frame');
  // Self-consistent extra segments (their lengths are right), so only the new rules can refuse them.
  const extra = (code, body) => Uint8Array.from([0xff, code, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body]);
  const sixteenBit = extra(0xdb, [0x12, ...new Array(128).fill(1)]);
  const overfull = extra(0xc4, [0x02, 3, ...new Array(15).fill(0), 0, 1, 2]);
  assert.equal(inspectJpeg(splice(clean, afterJfif, sixteenBit)).reason, 'bad_table', 'a 16-bit quantisation table under SOF0');
  assert.equal(inspectJpeg(splice(clean, afterJfif, overfull)).reason, 'bad_table', 'three 1-bit Huffman codes');
  assert.equal(inspectJpeg(splice(clean, afterJfif, extra(0xc4, [0x02, 1, ...new Array(15).fill(0), 16]))).reason, 'bad_table', 'a DC symbol above 15');
  assert.deepEqual(inspectJpeg(splice(clean, afterJfif, extra(0xc4, [0x12, 1, ...new Array(15).fill(0), 16]))), { ok: true, width: 64, height: 48 }, 'an AC symbol may be above 15');
  assert.deepEqual(inspectJpeg(splice(clean, afterJfif, extra(0xc4, [0x02, 1, ...new Array(15).fill(0), 0]))), { ok: true, width: 64, height: 48 }, 'a well-formed extra table passes');
  assert.equal(mutate(bytes => { bytes[sof + 13] = bytes[sof + 10]; }), 'bad_frame', 'two components with one id');
  assert.equal(mutate(bytes => { bytes[sos + 6] = 0x33; }), 'bad_scan', 'a scan naming Huffman tables never defined');
  const header = sos + 2 + ((clean[sos + 2] << 8) | clean[sos + 3]);
  assert.equal(inspectJpeg(Uint8Array.from([...clean.subarray(0, header), 0xff, 0xd9])).reason, 'bad_scan', 'a scan with no data');
  assert.deepEqual(inspectJpeg(cleanJpeg(fixture('clean-300x200.jpg'))), { ok: true, width: 300, height: 200 });
});
