// Animated GIF evidence (card 59 M2; Julian's re-ruling of J1, 2026-10-15: GIFs stay animated). One block walk for the
// Builder's clean-up and the Worker's check, without decoding a pixel. Kept: the screen descriptor and colour tables,
// graphic control extensions, the NETSCAPE2.0 / ANIMEXTS1.0 loop extension and image frames. Dropped by the Builder and
// refused by the Worker: comment, plain-text and every other application extension (XMP, ICC and private data can carry
// names, dates or places). Frame and pixel bounds stop a small file from decoding to billions of pixels; the pixel bound
// (100 million decoded, red-team S8) is set for phones, which hold the whole animation in memory.

export const GIF_LIMITS = Object.freeze({ maxBytes: 12 * 1024 * 1024, maxEdge: 4096, minEdge: 16, maxFrames: 1000, maxPixels: 100_000_000 });
const LOOP_APPS = new Set(['NETSCAPE2.0', 'ANIMEXTS1.0']);

/** Skip a run of data sub-blocks from `at`; returns the index after the zero terminator, or -1 when truncated. */
function subBlocks(bytes, at) {
  while (at < bytes.length) {
    const size = bytes[at];
    if (size === 0) return at + 1;
    at += 1 + size;
  }
  return -1;
}

/**
 * Walk a GIF's blocks. Returns `{ ok: true, width, height, frames }` for a clean GIF that ends exactly at its trailer,
 * or `{ ok: false, reason }`, with the byte ranges a clean copy keeps; `{ clean: true }` skips refusable extensions.
 */
export function walkGif(input, { clean = false } = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input), n = bytes.length;
  const bad = reason => ({ ok: false, reason });
  if (n < 13 || bytes.length > GIF_LIMITS.maxBytes) return bad(n < 13 ? 'not_gif' : 'too_large');
  const magic = String.fromCharCode(...bytes.subarray(0, 6));
  if (magic !== 'GIF89a' && magic !== 'GIF87a') return bad('not_gif');
  const width = bytes[6] | (bytes[7] << 8), height = bytes[8] | (bytes[9] << 8), packed = bytes[10];
  if (Math.min(width, height) < GIF_LIMITS.minEdge || Math.max(width, height) > GIF_LIMITS.maxEdge) return bad('bad_size');
  let at = 13 + (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0);
  if (at > n) return bad('truncated');
  const keep = [[0, at]];
  let frames = 0, pixels = 0;
  while (at < n) {
    const kind = bytes[at];
    if (kind === 0x3b) {
      if (at + 1 !== n) return bad('trailing_bytes');
      keep.push([at, at + 1]);
      if (!frames) return bad('no_frames');
      return { ok: true, width, height, frames, keep };
    }
    if (kind === 0x21) {
      if (at + 2 > n) return bad('truncated');
      const label = bytes[at + 1], end = subBlocks(bytes, at + 2);
      if (end < 0) return bad('truncated');
      let allowed = false;
      if (label === 0xf9) allowed = bytes[at + 2] === 4 && end === at + 8;
      else if (label === 0xff && bytes[at + 2] === 11 && LOOP_APPS.has(String.fromCharCode(...bytes.subarray(at + 3, at + 14)))) {
        // The loop count: one 3-byte data sub-block (1, count low, count high), then the terminator.
        allowed = bytes[at + 14] === 3 && bytes[at + 15] === 1 && end === at + 19;
      }
      if (!allowed && !clean) return bad(label === 0xfe ? 'comment' : label === 0xff ? 'metadata' : label === 0x01 ? 'plain_text' : 'bad_extension');
      if (allowed) keep.push([at, end]);
      at = end;
    } else if (kind === 0x2c) {
      if (at + 11 > n) return bad('truncated');
      const left = bytes[at + 1] | (bytes[at + 2] << 8), top = bytes[at + 3] | (bytes[at + 4] << 8);
      const w = bytes[at + 5] | (bytes[at + 6] << 8), h = bytes[at + 7] | (bytes[at + 8] << 8), local = bytes[at + 9];
      if (!w || !h || left + w > width || top + h > height) return bad('bad_frame');
      const data = at + 10 + (local & 0x80 ? 3 * 2 ** ((local & 7) + 1) : 0);
      if (data >= n || bytes[data] < 2 || bytes[data] > 8) return bad('bad_frame');
      const end = subBlocks(bytes, data + 1);
      if (end < 0) return bad('truncated');
      if (++frames > GIF_LIMITS.maxFrames || (pixels += w * h) > GIF_LIMITS.maxPixels) return bad('decode_bomb');
      keep.push([at, end]);
      at = end;
    } else return bad('bad_block');
  }
  return bad('truncated');
}

/** The structural check the Worker applies to a stored GIF. */
export function inspectGif(input) {
  const walked = walkGif(input);
  return walked.ok ? { ok: true, width: walked.width, height: walked.height, frames: walked.frames } : walked;
}

/**
 * The author's GIF reduced to the blocks inspectGif admits: comments, plain text and metadata extensions are dropped;
 * frames and timing are untouched. Returns null for anything malformed.
 */
export function cleanGif(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const walked = walkGif(bytes, { clean: true });
  if (!walked.ok) return null;
  const out = new Uint8Array(walked.keep.reduce((sum, [start, end]) => sum + end - start, 0));
  let offset = 0;
  for (const [start, end] of walked.keep) { out.set(bytes.subarray(start, end), offset); offset += end - start; }
  return inspectGif(out).ok ? out : null;
}
