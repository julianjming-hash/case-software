// Video evidence (card 59 M2; Julian's re-ruling of J1, 2026-10-15): H.264 video with optional AAC sound, in MP4 or
// QuickTime MOV, up to 25 MB and two minutes. One box walk for the Builder's clean-up and the Worker's check, without
// decoding a frame. Phones write location, device and time into the file (udta, meta and uuid boxes, a timed-metadata
// track, creation times, handler and encoder names); the Builder neutralises all of it IN PLACE (a box becomes `free`
// with a zeroed payload, a track that is not picture or sound disappears, times and names become zero, every media byte
// no kept track references becomes zero), so no offset moves and the video plays unchanged. The Worker re-walks the
// result: only the listed boxes, each container bounded, each header and table exactly its length, nothing else.
// Residual (red-team S2, recorded in CASE-268): the coded samples themselves (H.264 NAL units, including SEI user data,
// and AAC frames) are not decoded, so bytes hidden inside a sample cannot be ruled out; nosniff, a sandboxed response and
// blob-only playback keep them inert, and the author's de-identification check covers what a frame shows.

// maxSamples bounds every table a track has (samples, chunks, runs) and so the walk's memory (red-team N2): two minutes of
// 240 fps slow motion is 28,800 frames and of 96 kHz AAC about 11,250, so 50,000 is generous.
export const VIDEO_LIMITS = Object.freeze({ maxBytes: 25 * 1024 * 1024, maxSeconds: 120, maxEdge: 3840, minEdge: 16, maxSamples: 50_000,
  maxChildren: 64, maxMdats: 4 });

const FREE = new Set(['free', 'skip', 'wide']);
const FRAGMENTED = new Set(['moof', 'mfra', 'sidx', 'styp', 'ssix', 'emsg']);
// The boxes each container keeps; any other child is neutralised by clean and refused by inspect. Edit lists and the
// initial object descriptor are dropped: an edit list could hide frames a reviewer never sees (red-team, Low).
const KEEP = {
  top: new Set(['ftyp', 'moov', 'mdat']),
  moov: new Set(['mvhd', 'trak']),
  trak: new Set(['tkhd', 'mdia']),
  mdia: new Set(['mdhd', 'hdlr', 'minf']),
  minf: new Set(['vmhd', 'smhd', 'dinf', 'stbl', 'hdlr']),
  dinf: new Set(['dref']),
  stbl: new Set(['stsd', 'stts', 'stss', 'ctts', 'stsc', 'stsz', 'stco', 'co64']),
  avc: new Set(['avcC', 'pasp', 'colr', 'btrt', 'clap', 'fiel']),
  mp4a: new Set(['esds', 'btrt', 'wave', 'chan']),
  wave: new Set(['frma', 'mp4a', 'esds', 'enda', '\0\0\0\0']),
};
const VIDEO_CODECS = new Set(['avc1', 'avc3']), HEVC = new Set(['hvc1', 'hev1', 'dvh1', 'dvhe']), AUDIO_CODECS = new Set(['mp4a']);
// Exact body lengths (after the 8-byte header) of the fixed headers, by version 0 and 1 (red-team S2).
const FIXED = { mvhd: [100, 112], tkhd: [84, 96], mdhd: [24, 36], vmhd: [12, 12], smhd: [8, 8] };
// Table entry sizes, after version/flags and the entry count.
const TABLES = { stts: 8, ctts: 8, stss: 4, stsc: 12, stco: 4, co64: 8 };
// Exact body lengths of the small boxes a sample entry may hold, so none has room for text (red-team S2 residue). A colour
// box is nclx or nclc only (never an ICC profile); a channel layout holds at most eight channel descriptions.
const EXACT = { pasp: 8, btrt: 12, clap: 32, fiel: 2, frma: 4, enda: 2, '\0\0\0\0': 0 };
const UNITY = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];

class Refused extends Error { constructor(reason) { super(reason); this.reason = reason; } }
const refuse = reason => { throw new Refused(reason); };
const fourcc = (bytes, at) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);

/** The boxes in [start, end): { type, start, body, end }. A size of 0 runs to `end` (top level only). Bounded in count. */
function children(bytes, view, start, end, top = false) {
  const list = [];
  for (let at = start; at < end;) {
    if (at + 8 > end) refuse('truncated');
    if (list.length >= VIDEO_LIMITS.maxChildren) refuse('bad_structure');
    let size = view.getUint32(at), body = at + 8;
    if (size === 1) {
      if (at + 16 > end) refuse('truncated');
      size = Number(view.getBigUint64(at + 8)); body = at + 16;
    } else if (size === 0) {
      if (!top) refuse('bad_box');
      size = end - at;
    }
    if (size < body - at || at + size > end) refuse('truncated');
    list.push({ type: fourcc(bytes, at + 4), start: at, body, end: at + size });
    at += size;
  }
  return list;
}

/** Turn a box into `free` with a zeroed payload, keeping its size so nothing after it moves. */
function neutralise(bytes, box) {
  bytes.set([0x66, 0x72, 0x65, 0x65], box.start + 4);
  bytes.fill(0, box.body, box.end);
}

/** A version-0/1 header box must be exactly its length; returns whether it is version 1. */
function fixedBox(bytes, box) {
  const version = bytes[box.body], lengths = FIXED[box.type];
  if (version > 1 || box.end - box.body !== lengths[version]) refuse('bad_box');
  return version === 1;
}

/** A table must hold exactly the entries its count says, nothing after them. Returns the count. */
function table(view, box) {
  if (box.end - box.body < 8) refuse('bad_box');
  if (box.type === 'stsz') {
    if (box.end - box.body < 12) refuse('bad_box');
    const fixed = view.getUint32(box.body + 4), count = view.getUint32(box.body + 8);
    if (count > VIDEO_LIMITS.maxSamples || box.end - box.body !== 12 + (fixed ? 0 : count * 4)) refuse('bad_box');
    return count;
  }
  const count = view.getUint32(box.body + 4);
  if (count > VIDEO_LIMITS.maxSamples || box.end - box.body !== 8 + count * TABLES[box.type]) refuse('bad_box');
  return count;
}

/** The byte ranges a track's samples occupy, from its chunk offsets, samples-per-chunk runs and sample sizes. */
function sampleRanges(view, stbl) {
  const box = type => stbl.find(item => item.type === type);
  const stsc = box('stsc'), stsz = box('stsz'), offsets = box('stco') ?? box('co64');
  if (!stsc || !stsz || !offsets) refuse('bad_track');
  const chunkCount = table(view, offsets), wide = offsets.type === 'co64', runs = table(view, stsc), samples = table(view, stsz);
  const fixed = view.getUint32(stsz.body + 4);
  const ranges = [];
  let sample = 0;
  for (let run = 0; run < runs; run++) {
    const first = view.getUint32(stsc.body + 8 + run * 12), perChunk = view.getUint32(stsc.body + 12 + run * 12);
    const last = run + 1 < runs ? view.getUint32(stsc.body + 8 + (run + 1) * 12) - 1 : chunkCount;
    if (first < 1 || last < first - 1 || last > chunkCount || perChunk > samples) refuse('bad_track');
    for (let chunk = first; chunk <= last; chunk++) {
      const offset = wide ? Number(view.getBigUint64(offsets.body + 8 + (chunk - 1) * 8)) : view.getUint32(offsets.body + 8 + (chunk - 1) * 4);
      let size = 0;
      for (let i = 0; i < perChunk; i++, sample++) {
        if (sample >= samples) refuse('bad_track');
        size += fixed || view.getUint32(stsz.body + 12 + sample * 4);
      }
      if (size) ranges.push([offset, offset + size]);
    }
  }
  if (sample !== samples) refuse('bad_track');
  return ranges;
}

/** Whether a sample entry's child box is exactly its spec length (boxes not listed are checked elsewhere or not at all). */
function exact(bytes, view, box) {
  const length = box.end - box.body, kind = length >= 4 ? fourcc(bytes, box.body) : '';
  if (box.type === 'colr') return (kind === 'nclx' && length === 11) || (kind === 'nclc' && length === 10);
  if (box.type === 'chan') return length >= 16 && view.getUint32(box.body + 12) <= 8 && length === 16 + 20 * view.getUint32(box.body + 12);
  return !Object.hasOwn(EXACT, box.type) || length === EXACT[box.type];
}

/** The movie header after its times: reserved bytes and pre-defined fields zero and the identity matrix; clean writes them. */
function standardMovie(bytes, view, at, check) {
  const loose = [bytes.subarray(at + 6, at + 16), bytes.subarray(at + 52, at + 76)];
  if (!UNITY.some((value, i) => view.getUint32(at + 16 + i * 4) !== value) && !loose.some(part => part.some(byte => byte !== 0))) return;
  if (check) refuse('metadata');
  for (const part of loose) part.fill(0);
  UNITY.forEach((value, i) => view.setUint32(at + 16 + i * 4, value));
}

/** Zero creation and modification times in an mvhd, tkhd or mdhd; with `check`, refuse a non-zero one instead. */
function times(bytes, box, wide, check) {
  const field = bytes.subarray(box.body + 4, box.body + 4 + (wide ? 16 : 8));
  if (check) { if (field.some(byte => byte !== 0)) refuse('metadata'); } else field.fill(0);
}

/** A handler's name (free text: an app or device name) is blanked; the type and the 12 reserved bytes stay. */
function handlerName(bytes, box, check) {
  if (box.end - box.body < 24 || box.end - box.body > 24 + 64) refuse('bad_box');
  const name = bytes.subarray(box.body + 24, box.end);
  if (check) { if (name.some(byte => byte !== 0)) refuse('metadata'); } else name.fill(0);
}

/**
 * A track's own length in seconds: its mdhd duration and the total of its sample durations (stts), both bounded. The
 * durations must cover exactly the track's samples (red-team S4 residue), or a player would play past the bound.
 */
function trackSeconds(view, mdhd, wide, stts, samples) {
  const at = mdhd.body + 4 + (wide ? 16 : 8), timescale = view.getUint32(at);
  const duration = wide ? Number(view.getBigUint64(at + 4)) : view.getUint32(at + 4);
  if (!timescale) refuse('bad_track');
  let total = 0, covered = 0;
  const count = table(view, stts);
  for (let i = 0; i < count; i++) { const run = view.getUint32(stts.body + 8 + i * 8); covered += run; total += run * view.getUint32(stts.body + 12 + i * 8); }
  if (covered !== samples) refuse('bad_track');
  return Math.max(duration, total) / timescale;
}

/**
 * Walk (and with `clean`, neutralise in place) an MP4 or MOV. Returns { width, height, seconds, audio }; throws Refused.
 * `bytes` is modified only when `clean` is true.
 */
function walk(bytes, clean) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), n = bytes.length;
  if (n > VIDEO_LIMITS.maxBytes) refuse('too_large');
  // A sample entry's child that is not exactly its length is neutralised by clean and refused by inspect.
  const sized = list => list.filter(box => { if (exact(bytes, view, box)) return true; if (!clean) refuse('metadata'); neutralise(bytes, box); return false; });
  const tidy = (list, keep) => list.filter(box => {
    if (keep.has(box.type)) return true;
    if (FREE.has(box.type)) { if (clean) bytes.fill(0, box.body, box.end); else if (bytes.subarray(box.body, box.end).some(byte => byte !== 0)) refuse('metadata'); return false; }
    if (!clean) refuse(FRAGMENTED.has(box.type) ? 'fragmented' : 'metadata');
    if (FRAGMENTED.has(box.type)) refuse('fragmented');
    neutralise(bytes, box);
    return false;
  });
  const top = children(bytes, view, 0, n, true);
  if (!top.length || top[0].type !== 'ftyp') refuse('not_mp4');
  const ftypLength = top[0].end - top[0].body;
  if (ftypLength < 8 || ftypLength > 64 || ftypLength % 4) refuse('bad_box');
  const kept = tidy(top, KEEP.top);
  const moovs = kept.filter(box => box.type === 'moov'), mdats = kept.filter(box => box.type === 'mdat');
  if (moovs.length !== 1 || !mdats.length || mdats.length > VIDEO_LIMITS.maxMdats || kept.filter(box => box.type === 'ftyp').length !== 1) refuse('bad_structure');
  const moov = tidy(children(bytes, view, moovs[0].body, moovs[0].end), KEEP.moov);
  const mvhd = moov.filter(box => box.type === 'mvhd');
  if (mvhd.length !== 1) refuse('bad_structure');
  const wideMvhd = fixedBox(bytes, mvhd[0]), base = mvhd[0].body + 4 + (wideMvhd ? 16 : 8);
  times(bytes, mvhd[0], wideMvhd, !clean);
  standardMovie(bytes, view, base + (wideMvhd ? 12 : 8), !clean);
  const timescale = view.getUint32(base), duration = wideMvhd ? Number(view.getBigUint64(base + 4)) : view.getUint32(base + 4);
  if (!timescale) refuse('bad_structure');
  const seconds = duration / timescale;
  if (seconds > VIDEO_LIMITS.maxSeconds + 0.5) refuse('too_long');

  let video = null, audio = 0;
  const ranges = [];
  for (const trak of moov.filter(box => box.type === 'trak')) {
    const parts = children(bytes, view, trak.body, trak.end);
    const mdia = parts.find(box => box.type === 'mdia'), mdiaParts = mdia ? children(bytes, view, mdia.body, mdia.end) : [];
    const hdlr = mdiaParts.find(box => box.type === 'hdlr'), handler = hdlr && hdlr.body + 12 <= hdlr.end ? fourcc(bytes, hdlr.body + 8) : '';
    // A track that is neither picture nor sound (timed location or device metadata, chapters, captions) goes entirely.
    if (handler !== 'vide' && handler !== 'soun') { if (!clean) refuse('metadata'); neutralise(bytes, trak); continue; }
    const trakKept = tidy(parts, KEEP.trak);
    const tkhd = trakKept.find(box => box.type === 'tkhd');
    if (!tkhd || !mdia) refuse('bad_track');
    const wideTkhd = fixedBox(bytes, tkhd), tail = tkhd.end;
    times(bytes, tkhd, wideTkhd, !clean);
    const mdiaKept = tidy(mdiaParts, KEEP.mdia);
    const mdhd = mdiaKept.find(box => box.type === 'mdhd'), minf = mdiaKept.find(box => box.type === 'minf');
    if (!mdhd || !minf || mdiaKept.filter(box => box.type === 'hdlr').length !== 1) refuse('bad_track');
    const wideMdhd = fixedBox(bytes, mdhd);
    times(bytes, mdhd, wideMdhd, !clean);
    handlerName(bytes, hdlr, !clean);
    const minfKept = tidy(children(bytes, view, minf.body, minf.end), KEEP.minf);
    for (const box of minfKept) {
      if (box.type === 'vmhd' || box.type === 'smhd') fixedBox(bytes, box);
      if (box.type === 'hdlr') handlerName(bytes, box, !clean);
    }
    const dinf = minfKept.find(box => box.type === 'dinf'), stblBox = minfKept.find(box => box.type === 'stbl');
    if (!stblBox) refuse('bad_track');
    // Media data must be inside this file: every data reference is self-contained (flag 1), never a path or URL.
    if (dinf) {
      for (const dref of tidy(children(bytes, view, dinf.body, dinf.end), KEEP.dinf)) {
        if (dref.end - dref.body < 8) refuse('bad_box');
        const count = view.getUint32(dref.body + 4);
        const entries = children(bytes, view, dref.body + 8, dref.end);
        if (entries.length !== count || entries.some(entry => !['url ', 'alis'].includes(entry.type) || entry.end - entry.body !== 4 || (bytes[entry.body + 3] & 1) !== 1)) refuse('external_data');
      }
    }
    const stbl = tidy(children(bytes, view, stblBox.body, stblBox.end), KEEP.stbl);
    for (const box of stbl) if (Object.hasOwn(TABLES, box.type) || box.type === 'stsz') table(view, box);
    const stsd = stbl.find(box => box.type === 'stsd'), stts = stbl.find(box => box.type === 'stts');
    if (!stsd || !stts || stsd.end - stsd.body < 16 || view.getUint32(stsd.body + 4) !== 1) refuse('bad_track');
    const [entry] = children(bytes, view, stsd.body + 8, stsd.end);
    if (!entry || entry.end !== stsd.end) refuse('bad_track');
    const codec = entry.type;
    if (handler === 'vide') {
      if (HEVC.has(codec)) refuse('hevc');
      if (!VIDEO_CODECS.has(codec) || video) refuse(video ? 'bad_structure' : 'unsupported_codec');
      // The visual sample entry's fixed fields are 78 bytes; its 32-byte compressor name (an encoder's free text) is blanked.
      if (entry.end - entry.body < 78) refuse('bad_box');
      const name = bytes.subarray(entry.body + 42, entry.body + 74);
      if (clean) name.fill(0); else if (name.some(byte => byte !== 0)) refuse('metadata');
      const inner = sized(tidy(children(bytes, view, entry.body + 78, entry.end), KEEP.avc));
      if (!inner.some(box => box.type === 'avcC')) refuse('bad_track');
      video = { width: view.getUint32(tail - 8) >>> 16, height: view.getUint32(tail - 4) >>> 16 };
    } else {
      if (!AUDIO_CODECS.has(codec) || ++audio > 1) refuse(audio > 1 ? 'bad_structure' : 'unsupported_codec');
      // Sound description version 0, 1 or 2 (QuickTime adds 16 or 36 bytes), then its own allowed boxes.
      if (entry.end - entry.body < 28) refuse('bad_box');
      const version = view.getUint16(entry.body + 8), head = [28, 44, 64][version];
      if (head === undefined || entry.end - entry.body < head) refuse('bad_box');
      for (const box of sized(tidy(children(bytes, view, entry.body + head, entry.end), KEEP.mp4a))) {
        if (box.type === 'wave') sized(tidy(children(bytes, view, box.body, box.end), KEEP.wave));
      }
    }
    const stsz = stbl.find(box => box.type === 'stsz');
    if (!stsz || trackSeconds(view, mdhd, wideMdhd, stts, table(view, stsz)) > VIDEO_LIMITS.maxSeconds + 0.5) refuse(stsz ? 'too_long' : 'bad_track');
    for (const range of sampleRanges(view, stbl)) ranges.push(range);
  }
  if (!video) refuse('no_video');
  if (Math.min(video.width, video.height) < VIDEO_LIMITS.minEdge || Math.max(video.width, video.height) > VIDEO_LIMITS.maxEdge) refuse('bad_size');

  // Every media byte is a kept track's sample or zero: nothing else (a removed track's data, hidden bytes) survives. One
  // sort and one sweep (red-team S1): ranges and media payloads are both walked in order.
  const payloads = mdats.map(box => [box.body, box.end]).sort((a, b) => a[0] - b[0]);
  ranges.sort((a, b) => a[0] - b[0]);
  let r = 0;
  for (const [from, to] of payloads) {
    let at = from;
    for (; r < ranges.length && ranges[r][0] < to; r++) {
      const [start, end] = ranges[r];
      if (start < from || end > to) refuse('bad_track');
      if (start > at) { const gap = bytes.subarray(at, start); if (clean) gap.fill(0); else if (gap.some(byte => byte !== 0)) refuse('hidden_data'); }
      if (end > at) at = end;
    }
    const rest = bytes.subarray(at, to);
    if (rest.length) { if (clean) rest.fill(0); else if (rest.some(byte => byte !== 0)) refuse('hidden_data'); }
  }
  if (r !== ranges.length) refuse('bad_track');
  return { width: video.width, height: video.height, seconds, audio: audio === 1 };
}

/** A crafted file is refused with a reason, never a crash (red-team S3): an out-of-bounds read is a truncated file. */
function run(bytes, clean) {
  try { return walk(bytes, clean); } catch (error) {
    if (error instanceof Refused) throw error;
    if (error instanceof RangeError) throw new Refused('truncated');
    throw error;
  }
}

/** The structural check the Worker applies to a stored video: `{ ok, width, height, seconds, audio }` or `{ ok: false, reason }`. */
export function inspectMp4(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  try { return { ok: true, ...run(bytes, false) }; } catch (error) { if (error instanceof Refused) return { ok: false, reason: error.reason }; throw error; }
}

/** A cleaned copy of the author's video (the input is not modified), or `{ reason }` saying why it cannot be used. */
export function cleanMp4(input) {
  const bytes = Uint8Array.from(input instanceof Uint8Array ? input : new Uint8Array(input));
  try { run(bytes, true); } catch (error) { if (error instanceof Refused) return { reason: error.reason }; throw error; }
  const checked = inspectMp4(bytes);
  return checked.ok ? { bytes, ...checked } : { reason: checked.reason };
}
