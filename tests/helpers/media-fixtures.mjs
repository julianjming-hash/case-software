// Test-only builders for animated GIF and MP4 evidence (card 59 M2). No encoder is installed on the test machines, so
// these write the containers directly: a real, decodable GIF (uncompressed LZW), and a structurally exact MP4 whose
// samples are placeholder bytes (the walk never decodes). Each privacy fault the Builder must remove can be switched on.

const ascii = text => Uint8Array.from(text, char => char.charCodeAt(0));
const concat = parts => { const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let at = 0; for (const part of parts) { out.set(part, at); at += part.length; } return out; };
const u16le = value => [value & 255, value >> 8];

/** Sub-blocks of at most 255 bytes, then the terminator. */
function subBlocks(data) {
  const parts = [];
  for (let at = 0; at < data.length; at += 255) { const chunk = data.subarray(at, at + 255); parts.push(Uint8Array.of(chunk.length), chunk); }
  parts.push(Uint8Array.of(0));
  return concat(parts);
}

/** Uncompressed LZW at minimum code size 2: a clear code every two pixels keeps every code three bits wide. */
function lzw(pixels) {
  const codes = [];
  for (let i = 0; i < pixels.length; i++) { if (i % 2 === 0) codes.push(4); codes.push(pixels[i]); }
  codes.push(5);
  const out = [];
  let buffer = 0, bits = 0;
  for (const code of codes) { buffer |= code << bits; bits += 3; while (bits >= 8) { out.push(buffer & 255); buffer >>= 8; bits -= 8; } }
  if (bits) out.push(buffer & 255);
  return Uint8Array.from(out);
}

/**
 * An animated GIF: `frames` full-canvas frames in a 4-colour palette, looping. Options add what the Builder strips: a
 * comment, an XMP application extension, a plain-text extension, trailing bytes after the trailer.
 */
export function gifFixture({ width = 32, height = 24, frames = 2, comment = null, xmp = null, plainText = false, trailing = false, emptyFrames = false } = {}) {
  const parts = [ascii('GIF89a'), Uint8Array.of(...u16le(width), ...u16le(height), 0x81, 0, 0), Uint8Array.of(0, 0, 0, 255, 0, 0, 0, 160, 0, 255, 255, 255)];
  parts.push(Uint8Array.of(0x21, 0xff, 11), ascii('NETSCAPE2.0'), Uint8Array.of(3, 1, 0, 0, 0));
  if (comment) parts.push(Uint8Array.of(0x21, 0xfe), subBlocks(ascii(comment)));
  if (xmp) parts.push(Uint8Array.of(0x21, 0xff, 11), ascii('XMP DataXMP'), subBlocks(ascii(xmp)));
  if (plainText) parts.push(Uint8Array.of(0x21, 0x01, 12, 0, 0, 0, 0, 8, 0, 8, 0, 8, 8, 1, 0), subBlocks(ascii('Patient X')));
  for (let f = 0; f < frames; f++) {
    parts.push(Uint8Array.of(0x21, 0xf9, 4, 0x04, 10, 0, 0, 0));
    parts.push(Uint8Array.of(0x2c, 0, 0, 0, 0, ...u16le(width), ...u16le(height), 0), Uint8Array.of(2));
    const pixels = emptyFrames ? [] : Array.from({ length: width * height }, (_, i) => (i + f) % 4);
    parts.push(subBlocks(emptyFrames ? Uint8Array.of(4 | (5 << 3)) : lzw(pixels)));
  }
  parts.push(Uint8Array.of(0x3b));
  if (trailing) parts.push(ascii('MRN 1234567'));
  return concat(parts);
}

const u32 = value => [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
const box = (type, ...payload) => { const body = concat(payload); return concat([Uint8Array.of(...u32(8 + body.length)), ascii(type), body]); };
const full = (type, version, flags, ...payload) => box(type, Uint8Array.of(version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...payload);
const zeros = count => new Uint8Array(count);
const MATRIX = Uint8Array.of(0, 1, 0, 0, ...zeros(12), 0, 1, 0, 0, ...zeros(12), 64, 0, 0, 0);

/**
 * A structurally exact MP4. Options switch on what phones write: `udta` (a location atom), `moovMeta` (QuickTime keys),
 * `uuid` (XMP), `metaTrack` (a timed location track with its own samples), `times` (creation dates), `hidden` (bytes in
 * the media data no track references). Format faults: `codec` ('hvc1'), `fragmented`, `external` data reference,
 * `seconds` over the limit, `videoTracks: 2`.
 */
/** One chunk per sample: each sample's offset, as stco entries. */
function chunkOffsets(start, samples) {
  const out = new Uint8Array(samples.length * 4), view = new DataView(out.buffer);
  for (let i = 0, at = start; i < samples.length; at += samples[i], i++) view.setUint32(i * 4, at);
  return out;
}

export function mp4Fixture({ width = 640, height = 360, seconds = 10, audio = true, codec = 'avc1', udta = false, moovMeta = false, uuid = false,
  metaTrack = false, times = false, hidden = false, fragmented = false, external = false, videoTracks = 1, handlerName = '', mvhdTail = 0, avcChild = null,
  iods = false, edts = false, videoSamples = [96, 80, 88, 72], mdhdSeconds = null, sttsDelta = 1000, tableTail = 0, extraMdats = 0, freeBoxes = 0,
  chunkEach = false, sttsCount = null, matrix = MATRIX } = {}) {
  const location = ascii('+37.7749-122.4194/');
  const stamp = times ? u32(0xe2b9_0000) : u32(0);
  const tracks = [];
  for (let v = 0; v < videoTracks; v++) tracks.push({ handler: 'vide', codec, samples: videoSamples, fill: 0x11 + v });
  if (audio) tracks.push({ handler: 'soun', codec: 'mp4a', samples: [40, 40, 40, 40], fill: 0x22 });
  if (metaTrack) tracks.push({ handler: 'meta', codec: 'mebx', samples: [location.length, location.length], fill: null });
  const build = mdatStart => {
    let offset = mdatStart;
    const traks = tracks.map((track, index) => {
      const chunk = offset; offset += track.samples.reduce((sum, size) => sum + size, 0);
      const entry = track.handler === 'vide'
        ? box(track.codec, zeros(6), Uint8Array.of(0, 1), zeros(16), Uint8Array.of(width >> 8, width & 255, height >> 8, height & 255, 0, 72, 0, 0, 0, 72, 0, 0), zeros(4), Uint8Array.of(0, 1), zeros(32), Uint8Array.of(0, 24, 255, 255), box('avcC', Uint8Array.of(1, 66, 0, 30, 255, 224)),
          ...(avcChild ? [Array.isArray(avcChild) ? box(avcChild[0], avcChild[1]) : box(avcChild, ascii('Encoder: Patient Cam 2'))] : []))
        : track.handler === 'soun' ? box('mp4a', zeros(6), Uint8Array.of(0, 1), zeros(8), Uint8Array.of(0, 2, 0, 16), zeros(4), Uint8Array.of(172, 68, 0, 0))
          : box('mebx', zeros(6), Uint8Array.of(0, 1));
      const dref = external ? full('url ', 0, 0, ascii('https://example.com/media\0')) : full('url ', 0, 1);
      const stbl = box('stbl',
        full('stsd', 0, 0, Uint8Array.of(...u32(1)), entry),
        full('stts', 0, 0, Uint8Array.of(...u32(1), ...u32(sttsCount ?? track.samples.length), ...u32(sttsDelta)), zeros(tableTail)),
        full('stsc', 0, 0, Uint8Array.of(...u32(1), ...u32(1), ...u32(chunkEach ? 1 : track.samples.length), ...u32(1))),
        full('stsz', 0, 0, Uint8Array.of(...u32(0), ...u32(track.samples.length)), Uint8Array.from(track.samples.flatMap(u32))),
        chunkEach ? full('stco', 0, 0, Uint8Array.of(...u32(track.samples.length)), chunkOffsets(chunk, track.samples)) : full('stco', 0, 0, Uint8Array.of(...u32(1), ...u32(chunk))));
      const header = track.handler === 'vide' ? full('vmhd', 0, 1, zeros(8)) : track.handler === 'soun' ? full('smhd', 0, 0, zeros(4)) : full('nmhd', 0, 0);
      return box('trak',
        full('tkhd', 0, 3, Uint8Array.of(...stamp, ...stamp, ...u32(index + 1), ...zeros(4), ...u32(seconds * 1000), ...zeros(8), 0, 0, 0, 0, track.handler === 'soun' ? 1 : 0, 0, 0, 0), MATRIX,
          Uint8Array.of(...u32(track.handler === 'vide' ? width << 16 : 0), ...u32(track.handler === 'vide' ? height << 16 : 0))),
        box('mdia',
          full('mdhd', 0, 0, Uint8Array.of(...stamp, ...stamp, ...u32(1000), ...u32((mdhdSeconds ?? seconds) * 1000), 0x55, 0xc4, 0, 0)),
          full('hdlr', 0, 0, zeros(4), ascii(track.handler), zeros(12), ascii(handlerName), Uint8Array.of(0)),
          box('minf', header, box('dinf', full('dref', 0, 0, Uint8Array.of(...u32(1)), dref)), stbl)),
        ...(edts ? [box('edts', full('elst', 0, 0, Uint8Array.of(...u32(1), ...u32(seconds * 1000), ...u32(500), 0, 1, 0, 0)))] : []),
        ...(udta ? [box('udta', box('©xyz', location))] : []));
    });
    const moov = box('moov',
      full('mvhd', 0, 0, Uint8Array.of(...stamp, ...stamp, ...u32(1000), ...u32(seconds * 1000), 0, 1, 0, 0, 1, 0, ...zeros(10)), matrix, zeros(24), Uint8Array.of(...u32(tracks.length + 1)), zeros(mvhdTail)),
      ...(iods ? [full('iods', 0, 0, Uint8Array.of(16, 7, 0, 79, 255, 255, 41, 21, 255))] : []),
      ...Array.from({ length: freeBoxes }, () => box('free', zeros(0))),
      ...traks,
      ...(udta ? [box('udta', box('©xyz', location))] : []),
      ...(moovMeta ? [box('meta', full('hdlr', 0, 0, zeros(4), ascii('mdta'), zeros(12), Uint8Array.of(0)), box('keys', ascii('com.apple.quicktime.location.ISO6709')), box('ilst', location))] : []));
    return moov;
  };
  const ftyp = box('ftyp', ascii('isom'), Uint8Array.of(0, 0, 2, 0), ascii('isomavc1'));
  const xmp = uuid ? box('uuid', ascii('be7acfcb97a942e8'), ascii('<x:xmpmeta>MRN</x:>')) : zeros(0);
  const draft = build(0);
  const moov = build(ftyp.length + draft.length + xmp.length + 8);
  const samples = concat(tracks.map(track => track.fill === null ? concat(track.samples.map(() => location)) : Uint8Array.from({ length: track.samples.reduce((sum, size) => sum + size, 0) }, (_, i) => track.fill + (i % 7))));
  const parts = [ftyp, moov];
  if (uuid) parts.push(xmp);
  parts.push(box('mdat', samples, hidden ? ascii('MRN 1234567') : zeros(0)));
  for (let m = 0; m < extraMdats; m++) parts.push(box('mdat', zeros(0)));
  if (fragmented) parts.push(box('moof', zeros(8)));
  return concat(parts);
}

export const FIXTURE_LOCATION = '+37.7749-122.4194/';
