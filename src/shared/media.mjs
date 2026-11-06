// Visual evidence media (card 59 M2, G10). One contract for the Builder, the Worker and SQL: which files are admitted,
// how large each stored rendition may be, which sources the author can name, and the structural check every stored JPEG
// passes (GIF and video have their own walks: media-gif.mjs, media-mp4.mjs). Julian's rulings (2026-10-15, re-ruled the
// same day): every image, animated GIF and video is allowed behind format and size checks; nothing about the content is
// reviewed, refused or censored, and the rights details and de-identification tick only warn. A configured admin approves.
// Nothing here decodes pixels.

/** Stored types and their key extensions. Stills are re-encoded to JPEG; GIFs and videos are stored cleaned, not re-encoded. */
export const MEDIA_TYPES = Object.freeze({ 'image/jpeg': 'jpg', 'image/gif': 'gif', 'video/mp4': 'mp4' });
/**
 * What the Builder makes of a chosen file: 'still' (any image the browser decodes, re-encoded to JPEG), 'gif' (kept
 * animated when it has more than one frame), 'video' (H.264 MP4 or MOV), or null.
 */
export function inputKind({ type = '', name = '' } = {}) {
  if (type === 'image/gif' || (!type && /\.gif$/i.test(name))) return 'gif';
  if (['video/mp4', 'video/quicktime', 'video/x-m4v'].includes(type) || (!type && /\.(mp4|mov|m4v)$/i.test(name))) return 'video';
  if (type.startsWith('image/') || (!type && /\.(heic|heif|avif|jpe?g|png|webp|bmp|tiff?)$/i.test(name))) return 'still';
  return null;
}
/** Stored JPEG renditions: made in the Builder, checked by the Worker. A GIF's or video's poster is a display-sized JPEG. */
export const MEDIA_RENDITIONS = Object.freeze({
  display: Object.freeze({ maxEdge: 2400, maxBytes: 600 * 1024 }),
  phone: Object.freeze({ maxEdge: 1280, maxBytes: 300 * 1024 }),
  poster: Object.freeze({ maxEdge: 2400, maxBytes: 600 * 1024 }),
});
/** Animated GIFs and videos, stored as one object serving display and phone (J3: 12 MB for images and GIFs; video 25 MB, 2 min). */
export const MOVING_LIMITS = Object.freeze({
  'image/gif': Object.freeze({ maxEdge: 4096, maxBytes: 12 * 1024 * 1024 }),
  'video/mp4': Object.freeze({ maxEdge: 3840, maxBytes: 25 * 1024 * 1024, maxSeconds: 120 }),
});
/** ECGs keep more pixels on phones, where people zoom into the trace (J3). */
export const ECG_PHONE = Object.freeze({ maxEdge: 2000, maxBytes: 500 * 1024 });
import { IMAGE_TEXT } from './slide-image.mjs';
export const MEDIA_LIMITS = Object.freeze({ inputBytes: 12 * 1024 * 1024, videoBytes: 25 * 1024 * 1024, inputPixels: 40_000_000, minEdge: 16, altText: IMAGE_TEXT.alt, caption: IMAGE_TEXT.caption,
  creator: 200, attribution: 300, rightsNote: 1000, sourceUrl: 2000, perVersionBytes: 150 * 1024 * 1024 });
export const EVIDENCE_KINDS = Object.freeze(['photo', 'ecg', 'imaging', 'diagram', 'other']);
/**
 * Sources and licences the author can name (J2 as re-ruled: every source is allowed; `warn` is shown, never enforced).
 * `attribution` and `note` mark sources where a credit or written licence is expected; a missing one is a warning too.
 */
export const MEDIA_LICENCES = Object.freeze({
  own: Object.freeze({ label: 'My own image', rights_basis: 'own_work', licence: 'own-work', attribution: false, note: false }),
  patient: Object.freeze({ label: 'Patient image, consent recorded outside Case', rights_basis: 'consented_patient', licence: 'own-work', attribution: false, note: false }),
  cc0: Object.freeze({ label: 'CC0 1.0', rights_basis: 'creative_commons', licence: 'CC0-1.0', attribution: false, note: false }),
  ccby: Object.freeze({ label: 'CC BY 4.0', rights_basis: 'creative_commons', licence: 'CC-BY-4.0', attribution: true, note: false }),
  ccbysa: Object.freeze({ label: 'CC BY-SA 4.0', rights_basis: 'creative_commons', licence: 'CC-BY-SA-4.0', attribution: true, note: false }),
  pd: Object.freeze({ label: 'Public domain', rights_basis: 'public_domain', licence: 'PDM', attribution: false, note: false }),
  licensed: Object.freeze({ label: 'Licensed for this use (write the licence)', rights_basis: 'licensed', licence: 'licensed-other', attribution: true, note: true }),
  ccbync: Object.freeze({ label: 'CC BY-NC 4.0', rights_basis: 'creative_commons', licence: 'CC-BY-NC-4.0', attribution: true, note: false, warn: 'Non-commercial licence: check before any paid or commercial use.' }),
  ccbyncsa: Object.freeze({ label: 'CC BY-NC-SA 4.0', rights_basis: 'creative_commons', licence: 'CC-BY-NC-SA-4.0', attribution: true, note: false, warn: 'Non-commercial licence: check before any paid or commercial use.' }),
  ccbynd: Object.freeze({ label: 'CC BY-ND 4.0', rights_basis: 'creative_commons', licence: 'CC-BY-ND-4.0', attribution: true, note: false, warn: 'No-derivatives licence: cropping or covering may count as an adaptation.' }),
  ccbyncnd: Object.freeze({ label: 'CC BY-NC-ND 4.0', rights_basis: 'creative_commons', licence: 'CC-BY-NC-ND-4.0', attribution: true, note: false, warn: 'Non-commercial, no-derivatives licence: check use and any cropping.' }),
  publication: Object.freeze({ label: 'Textbook or journal figure (no licence held)', rights_basis: 'unlicensed', licence: 'unlicensed', attribution: true, note: false, warn: 'Copyright stays with the publisher: use only where your institution allows it.' }),
  unknown: Object.freeze({ label: 'Source not known', rights_basis: 'unlicensed', licence: 'unknown', attribution: false, note: false, warn: 'Unknown source: the rights to show this are not recorded.' }),
});
export { ECG_SPEEDS, ECG_GAINS, ECG_LAYOUTS } from './slide-image.mjs';

// The exact JFIF baseline stream a browser encoder writes, each segment parsed to its exact length: APP0 (JFIF, 16
// bytes, no thumbnail), DQT and DHT tables, an optional DRI, one SOF0 frame of 1 or 3 components, and at most three
// baseline scans. Anything else (APP1 Exif/XMP, APP2 ICC, APP13 IPTC, COM, progressive or arithmetic frames, padding
// or text inside a table, extra scans that make a decode bomb) is refused, never stripped (red-team S1). Tables are
// 8-bit quantisation only, Huffman counts must fit their code space as libjpeg requires, component ids are unique, every
// table a frame or scan names is defined, and no scan is empty. Entropy-coded data is not decoded (CASE-268 residual).
const SOF0 = 0xc0;
const ALLOWED = new Set([0xe0, 0xdb, 0xc4, 0xdd, 0xda, SOF0]);
const MAX_SCANS = 3;

/**
 * Walk a JPEG's segments without decoding it. Returns `{ ok: true, width, height }` for a clean JFIF baseline stream
 * that ends exactly at EOI, or `{ ok: false, reason }`. The Builder's encoder output (after cleanJpeg) always passes.
 */
export function inspectJpeg(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const n = bytes.length;
  if (n < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return { ok: false, reason: 'not_jpeg' };
  let at = 2, frame = null, scans = 0, jfif = false, tables = 0;
  const quant = new Set(), dc = new Set(), ac = new Set();
  const bad = reason => ({ ok: false, reason });
  while (at < n) {
    if (bytes[at] !== 0xff || at + 1 >= n) return bad(at + 1 >= n ? 'truncated' : 'bad_marker');
    const marker = bytes[at + 1];
    if (marker === 0xd9) { if (at + 2 !== n) return bad('trailing_bytes'); break; }
    if (!ALLOWED.has(marker)) return bad(marker === 0xe1 ? 'exif_or_xmp' : marker === 0xfe ? 'comment' : (marker & 0xf0) === 0xe0 ? 'metadata' : marker >= 0xc1 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc ? 'unsupported_frame' : 'unsupported_segment');
    if (at + 4 > n) return bad('truncated');
    const length = (bytes[at + 2] << 8) | bytes[at + 3];
    if (length < 2 || at + 2 + length > n) return bad('truncated');
    const body = bytes.subarray(at + 4, at + 2 + length);
    if (marker === 0xe0) {
      if (jfif || at !== 2 || length !== 16 || String.fromCharCode(...body.subarray(0, 5)) !== 'JFIF\0' || body[7] > 2 || body[12] !== 0 || body[13] !== 0) return bad('metadata');
      jfif = true;
    } else if (marker === 0xdb) {
      let p = 0;
      while (p < body.length) { const precision = body[p] >> 4, id = body[p] & 15; if (precision !== 0 || id > 3) return bad('bad_table'); quant.add(id); p += 65; if (++tables > 16) return bad('bad_table'); }
      if (p !== body.length) return bad('bad_table');
    } else if (marker === 0xc4) {
      let p = 0;
      while (p < body.length) {
        if (p + 17 > body.length) return bad('bad_table');
        const kind = body[p] >> 4, id = body[p] & 15; let count = 0, code = 0;
        // Canonical codes must fit their length, and no code may be all ones (libjpeg's jpeg_make_d_derived_tbl).
        for (let i = 1; i <= 16; i++) { count += body[p + i]; code += body[p + i]; if (code >= 2 ** i) return bad('bad_table'); code *= 2; }
        if (kind > 1 || id > 3 || count < 1 || count > 256) return bad('bad_table');
        // A DC symbol is a difference category: at most 15 (11 for 8-bit samples; 15 is libjpeg's own bound).
        if (kind === 0) for (let i = 0; i < count; i++) if (body[p + 17 + i] > 15) return bad('bad_table');
        (kind ? ac : dc).add(id);
        p += 17 + count; if (++tables > 16) return bad('bad_table');
      }
      if (p !== body.length) return bad('bad_table');
    } else if (marker === 0xdd) {
      if (length !== 4) return bad('bad_table');
    } else if (marker === SOF0) {
      const components = body[5];
      if (frame || body[0] !== 8 || ![1, 3].includes(components) || length !== 8 + 3 * components) return bad('bad_frame');
      const ids = new Map();
      for (let c = 0; c < components; c++) {
        const sampling = body[7 + 3 * c], h = sampling >> 4, v = sampling & 15;
        if (h < 1 || h > 2 || v < 1 || v > 2 || body[8 + 3 * c] > 3 || ids.has(body[6 + 3 * c])) return bad('bad_frame');
        ids.set(body[6 + 3 * c], body[8 + 3 * c]);
      }
      frame = { height: (body[1] << 8) | body[2], width: (body[3] << 8) | body[4], components, ids };
    } else if (marker === 0xda) {
      const count = body[0];
      if (!frame || count < 1 || count > frame.components || length !== 6 + 2 * count || ++scans > MAX_SCANS) return bad('bad_scan');
      // Baseline: the whole spectrum, no successive approximation.
      if (body[1 + 2 * count] !== 0 || body[2 + 2 * count] !== 63 || body[3 + 2 * count] !== 0) return bad('bad_scan');
      const seen = new Set();
      for (let c = 0; c < count; c++) {
        const id = body[1 + 2 * c], selectors = body[2 + 2 * c];
        if (!frame.ids.has(id) || seen.has(id) || !quant.has(frame.ids.get(id)) || !dc.has(selectors >> 4) || !ac.has(selectors & 15)) return bad('bad_scan');
        seen.add(id);
      }
    }
    at += 2 + length;
    if (marker === 0xda) {
      // Entropy-coded data: skip to the next real marker (not a stuffed 0xff00 or a restart marker).
      const start = at;
      while (at < n && !(bytes[at] === 0xff && bytes[at + 1] !== 0x00 && !(bytes[at + 1] >= 0xd0 && bytes[at + 1] <= 0xd7))) at++;
      if (at >= n) return bad('truncated');
      if (at === start) return bad('bad_scan');
    }
  }
  if (at >= n) return bad('truncated');
  if (!frame || !scans || !frame.width || !frame.height) return bad('bad_frame');
  return { ok: true, width: frame.width, height: frame.height };
}

/** Whether a stored rendition is inside its allowlisted size and pixel bounds. GIF and video use their own type's bounds. */
export function renditionFits(rendition, { width, height, bytes }, { ecg = false, type = 'image/jpeg' } = {}) {
  const limit = type !== 'image/jpeg' ? (rendition === 'poster' ? null : MOVING_LIMITS[type]) : rendition === 'phone' && ecg ? ECG_PHONE : MEDIA_RENDITIONS[rendition];
  return Boolean(limit) && Number.isSafeInteger(bytes) && bytes > 0 && bytes <= limit.maxBytes &&
    Math.max(width, height) <= limit.maxEdge && Math.min(width, height) >= MEDIA_LIMITS.minEdge;
}

const unsafe = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩﻿]/;
/**
 * The author's description of an asset: what it shows and where it came from. Returns { ok, value, warnings } with
 * exactly the stored fields, or { ok: false, field } for malformed text only. Nothing about rights refuses (J2 as
 * re-ruled): a source's caution, a missing credit or licence note, and an unticked de-identification check (`attested`)
 * come back as `warnings` [{ field, text }] for the Builder to show and the admin to see at approval.
 */
export function assetDetails(input, { relaxed = false } = {}) {
  const record = input && typeof input === 'object' && !Array.isArray(input) ? input : null;
  // `relaxed` is the case place (CASE-342, plan §3 A6): only the description and the uploader's tick matter; the kind,
  // the source and licence are optional, and one optional `credit` line replaces the rest of the rights form.
  const keys = ['alt', 'evidenceKind', 'source', 'creator', 'attribution', 'rightsNote', 'sourceUrl', 'attested', ...(relaxed ? ['credit'] : [])];
  if (!record || Object.keys(record).some(key => !keys.includes(key))) return { ok: false, field: 'body' };
  const text = (key, max, required = false) => {
    const value = record[key] ?? '';
    if (typeof value !== 'string' || unsafe.test(value) || value.length > max || (required && !value.trim())) return null;
    return value.trim();
  };
  const alt = text('alt', MEDIA_LIMITS.altText, true);
  if (alt === null) return { ok: false, field: 'alt' };
  const kindGiven = !relaxed || (record.evidenceKind !== undefined && record.evidenceKind !== null);
  if (kindGiven && !EVIDENCE_KINDS.includes(record.evidenceKind)) return { ok: false, field: 'evidenceKind' };
  const sourceGiven = !relaxed || (record.source !== undefined && record.source !== null);
  if (sourceGiven && !Object.hasOwn(MEDIA_LICENCES, record.source ?? '')) return { ok: false, field: 'source' };
  const source = sourceGiven ? MEDIA_LICENCES[record.source] : null;
  const creator = text('creator', MEDIA_LIMITS.creator), credit = relaxed ? text('credit', MEDIA_LIMITS.attribution) : '';
  let attribution = text('attribution', MEDIA_LIMITS.attribution);
  if (creator === null) return { ok: false, field: 'creator' };
  if (credit === null) return { ok: false, field: 'credit' };
  if (attribution === null) return { ok: false, field: 'attribution' };
  attribution ||= credit;
  const rightsNote = text('rightsNote', MEDIA_LIMITS.rightsNote);
  if (rightsNote === null) return { ok: false, field: 'rightsNote' };
  const sourceUrl = text('sourceUrl', MEDIA_LIMITS.sourceUrl);
  if (sourceUrl === null || (sourceUrl && !/^https:\/\/[^\s]+$/.test(sourceUrl))) return { ok: false, field: 'sourceUrl' };
  if (record.attested !== undefined && typeof record.attested !== 'boolean') return { ok: false, field: 'attested' };
  const warnings = [];
  if (source?.warn) warnings.push({ field: 'source', text: source.warn });
  if (source?.attribution && !attribution) warnings.push({ field: 'attribution', text: 'This source usually needs a credit line.' });
  if (source?.note && !rightsNote) warnings.push({ field: 'rightsNote', text: 'Write down the licence you hold.' });
  if (record.attested !== true) warnings.push({ field: 'attested', text: 'Not confirmed: check for names, dates, record numbers and faces before you use it.' });
  return { ok: true, value: { alt, evidenceKind: kindGiven ? record.evidenceKind : null, rightsBasis: source?.rights_basis ?? null, licence: source?.licence ?? null,
    creator, attribution, rightsNote, sourceUrl, attested: record.attested === true }, warnings };
}

/**
 * The Builder's own encoder output, reduced to the segments `inspectJpeg` admits. Browser encoders add an ICC colour
 * profile (Chromium) and sometimes Exif; dropping them changes no pixel data. Returns null for anything that is not a
 * well-formed JPEG; the Worker still checks the result independently.
 */
export function cleanJpeg(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input), n = bytes.length, parts = [bytes.subarray(0, 2)];
  if (n < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  while (at + 1 < n) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1];
    if (marker === 0xd9) { parts.push(bytes.subarray(at, at + 2)); break; }
    if (at + 4 > n) return null;
    const length = (bytes[at + 2] << 8) | bytes[at + 3], end = at + 2 + length;
    if (length < 2 || end > n) return null;
    const jfif = marker === 0xe0 && at === 2 && length === 16 && String.fromCharCode(...bytes.subarray(at + 4, at + 9)) === 'JFIF\0' && bytes[at + 16] === 0 && bytes[at + 17] === 0;
    if (ALLOWED.has(marker) && (marker !== 0xe0 || jfif)) parts.push(bytes.subarray(at, end));
    at = end;
    if (marker === 0xda) {
      const start = at;
      while (at < n && !(bytes[at] === 0xff && bytes[at + 1] !== 0x00 && !(bytes[at + 1] >= 0xd0 && bytes[at + 1] <= 0xd7))) at++;
      parts.push(bytes.subarray(start, at));
    }
  }
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0; for (const part of parts) { out.set(part, offset); offset += part.length; }
  return inspectJpeg(out).ok ? out : null;
}
