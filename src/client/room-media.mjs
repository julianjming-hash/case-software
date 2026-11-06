// Room images, GIFs and videos on public screens (card 59 M3, CASE-269). A released image block carries only an opaque
// room handle, its size and its stored type; this module fetches a rendition with the screen's own room credential in
// the header, keeps them as browser-local handles in memory (never in Cache Storage, IndexedDB or history) and revokes
// them on eviction and teardown. The projector fetches what it shows (a still, a GIF, a video); a phone fetches a still
// or GIF and a video's poster, and the video itself only when the learner taps it. The same-PC projector has no
// credential: its console relays the bytes of released media over the local channel (createMediaRelay below), so a
// projector beside the console shows them, also in manual mode.
import { mediaObjectUrl } from '../shared/urls.mjs';

// Each stored type: its largest stored file and its leading bytes (shared/media.mjs; media-gif.mjs; media-mp4.mjs).
const TYPES = {
  'image/jpeg': { max: 600 * 1024, magic: bytes => bytes[0] === 0xff && bytes[1] === 0xd8 },
  'image/gif': { max: 12 * 1024 * 1024, magic: bytes => bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 },
  'video/mp4': { max: 25 * 1024 * 1024, magic: bytes => String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]) === 'ftyp' },
};
const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Bytes that are plausibly the stored type: within its size bound and starting the way it must. */
export const validMedia = (bytes, type) => bytes instanceof ArrayBuffer && Object.hasOwn(TYPES, type) && bytes.byteLength > 8 &&
  bytes.byteLength <= TYPES[type].max && TYPES[type].magic(new Uint8Array(bytes, 0, 8));

// A screen holds a whole slide's media: a slide has at most 32 blocks (SLIDE_LIMITS.compositionBlocks), so drawing one
// never evicts what the same draw needs (red-team H1). The byte bound is above a version's whole media (150 MiB), so it
// can never force a slide's own media out either.
export const MEDIA_HELD = 32;
// Bytes a screen holds (red-team S8): a projector, which shows each released file, keeps the most; a phone, which loads a
// GIF or video only when tapped, keeps far less.
const HELD_BYTES = { display: 160 * 1024 * 1024, phone: 48 * 1024 * 1024 };
// Below the room's own allowance (24 reads of one rendition per ten minutes, room-do MEDIA_READS), so a screen never
// spends it. Counted outside the held media, so eviction cannot reset the count or skip a pause.
const CLIENT_READS = { perWindow: 20, windowMs: 10 * 60 * 1000 };

/**
 * `load(handle, rendition)` fetches one rendition with the screen's own credential (transport link.mediaBytes) and answers
 * `{ bytes, type }` or `{ state }`; a same-PC projector has no loader and is given bytes with put(). `role` is 'display'
 * (the projector: every type's display file, videos driven by the room's playback) or 'phone' (phone copies; a video's
 * poster until `play(handle)`, then the video with its own controls). A `busy` answer (the room's read allowance, 429)
 * is retried after a growing, jittered pause, at most `retries` times; after that it waits a whole allowance window
 * before one more try. Meanwhile it shows as missing. Without a loader, `want(handle)` asks once for a file a draw needs
 * and does not hold (red-team N1: a same-PC projector evicts past 32, and its console relays each file only once).
 */
export function createRoomMedia({ load = null, want = () => {}, onChange = () => {}, role = 'display', limit = MEDIA_HELD, heldBytes: byteLimit = HELD_BYTES[role] ?? HELD_BYTES.phone, retryMs = 2_000, retries = 5, wait = setTimeout, unwait = clearTimeout, now = () => Date.now() } = {}) {
  const entries = new Map(), history = new Map(), timers = new Set(), wanted = new Set(), asked = new Set();
  let disposed = false, generation = 0, heldBytes = 0;
  const drop = (key, entry) => { entries.delete(key); heldBytes -= entry.size ?? 0; if (entry.url) URL.revokeObjectURL(entry.url); };
  const keep = (key, entry) => {
    generation++;
    const old = entries.get(key);
    if (old) drop(key, old.url === entry.url ? { ...old, url: null } : old);
    entries.set(key, entry); heldBytes += entry.size ?? 0;
    for (const [oldest, gone] of entries) { if (entries.size <= limit && heldBytes <= byteLimit) break; if (oldest !== key) drop(oldest, gone); }
  };
  const store = (key, bytes, type) => {
    if (disposed || !validMedia(bytes, type)) return false;
    const blob = new Blob([bytes], { type });
    keep(key, { url: mediaObjectUrl(blob), size: bytes.byteLength, blob }); onChange(); return true;
  };
  /**
   * Bytes a same-PC console relayed: the display file of a released handle. A handle already held is kept as it is
   * (red-team M3-B1): replacing it would revoke the blob a playing video uses and rebuild the slide.
   */
  const put = (handle, bytes, type = 'image/jpeg') => { asked.delete(handle); return entries.get(`${handle}:display`)?.url ? true : store(`${handle}:display`, bytes, type); };
  const pastOf = key => {
    let past = history.get(key);
    if (!past) { past = { reads: [], attempts: 0, until: 0, withdrawn: false }; history.set(key, past); }
    return past;
  };
  // After a pause, drop the shown miss and redraw, so the next draw asks again.
  const retryAfter = (key, ms) => {
    const timer = wait(() => {
      timers.delete(timer);
      if (disposed) return;
      if (entries.get(key)?.state === 'missing') entries.delete(key);
      generation++; onChange();
    }, ms);
    timers.add(timer);
  };
  /** One rendition: held, loading, or (unless `peek`) fetched now within the read budget and any pause. */
  const get = (handle, rendition, peek = false) => {
    const key = `${handle}:${rendition}`;
    let entry = entries.get(key);
    if (entry || peek) return entry;
    if (typeof load !== 'function') { if (!asked.has(handle)) { asked.add(handle); want(handle); } return entry; }
    const past = pastOf(key), at = now();
    past.reads = past.reads.filter(time => at - time < CLIENT_READS.windowMs);
    if (past.withdrawn) return { state: 'withdrawn' };
    if (at < past.until) return { state: 'missing' };
    if (past.reads.length >= CLIENT_READS.perWindow) {
      // This window's reads are spent: ask again once the oldest falls out of it (jittered), not on every draw.
      const pause = (CLIENT_READS.windowMs - (at - past.reads[0])) * (1 + Math.random() / 10);
      past.until = at + pause; retryAfter(key, pause);
      return { state: 'missing' };
    }
    past.reads.push(at);
    entry = { loading: true }; keep(key, entry);
    Promise.resolve(load(handle, rendition)).catch(() => ({ state: 'missing' })).then(found => {
      if (disposed || entries.get(key) !== entry) return;
      if (found?.bytes && store(key, found.bytes, found.type ?? 'image/jpeg')) { past.attempts = 0; return; }
      past.withdrawn = found?.state === 'withdrawn';
      keep(key, { state: past.withdrawn ? 'withdrawn' : 'missing' }); onChange();
      if (found?.state !== 'busy') return;
      past.attempts++;
      const pause = (past.attempts <= retries ? retryMs * 2 ** (past.attempts - 1) : CLIENT_READS.windowMs) * (0.75 + Math.random() / 2);
      if (past.attempts > retries) past.attempts = 0;
      past.until = now() + pause;
      retryAfter(key, pause);
    });
    return entry;
  };
  /**
   * The slidePlan resolver: what a released image block shows now; a first sight starts its fetch. A phone loads a GIF or
   * a video (up to 12 or 25 MB) only when the learner taps its poster (red-team S6). With `peek`, nothing is fetched.
   */
  const resolve = (block, { peek = false } = {}) => {
    const media = block?.media;
    if (!media) return null;
    if (media.state === 'withdrawn') return { state: 'withdrawn' };
    const type = media.type ?? 'image/jpeg', video = type === 'video/mp4', moving = video || type === 'image/gif';
    const facts = { width: media.width, height: media.height, attribution: media.credit, type, handle: media.handle, controls: video && role === 'phone' };
    if (role === 'display') { const entry = get(media.handle, 'display', peek); return { ...facts, url: entry?.url ?? null, state: entry?.state }; }
    if (!moving) { const entry = get(media.handle, 'phone', peek); return { ...facts, url: entry?.url ?? null, state: entry?.state }; }
    const poster = get(media.handle, 'poster', peek), file = wanted.has(media.handle) ? get(media.handle, 'phone', peek) : null;
    return { ...facts, url: file?.url ?? null, poster: poster?.url ?? null, state: file?.state ?? poster?.state, loading: Boolean(file?.loading) };
  };
  /** A phone learner tapped a video: fetch it (once) so its own controls can play it. */
  const play = handle => { if (disposed || wanted.has(handle)) return; wanted.add(handle); generation++; onChange(); };
  /** Revoke everything held now (the room ended); later releases fetch again. */
  const clear = () => {
    for (const entry of entries.values()) if (entry.url) URL.revokeObjectURL(entry.url);
    for (const timer of timers) unwait(timer);
    entries.clear(); history.clear(); timers.clear(); wanted.clear(); asked.clear(); heldBytes = 0; generation++;
  };
  const dispose = () => { disposed = true; clear(); };
  /** Card 40b: a held rendition as its Blob, or null; the recap PDF reads what this screen holds without fetching it again. */
  const held = (handle, rendition) => entries.get(`${handle}:${rendition}`)?.blob ?? null;
  return { resolve, put, play, clear, dispose, held, get generation() { return generation; } };
}

/** The released media blocks of a public view (the projector's or a phone's): `{ handle, type }`. */
export function viewMedia(view) {
  const blocks = view?.surface?.slide?.blocks ?? view?.liveSurface?.slide?.blocks ?? [];
  return blocks.filter(block => block?.type === 'image' && block.media?.handle).map(block => ({ handle: block.media.handle, type: block.media.type ?? 'image/jpeg' }));
}
/** The released media handles of a public view. */
export const viewMediaHandles = view => viewMedia(view).map(item => item.handle);

/**
 * Console side: send the display file of every medium a same-PC projector frame releases, once per projector window,
 * from the facilitator's own memory (CASE-092). `load` is the console link's mediaBytes (facilitator credential). A
 * file is sent again only after reset(), when a projector window opens or reloads (red-team M3-B1: a timed resend
 * rebuilt a playing video every 20 s).
 */
export function createMediaRelay({ load, post, sessionId }) {
  const cache = new Map(), sent = new Set();
  const bytesOf = async handle => {
    if (cache.has(handle)) return cache.get(handle);
    const found = await load(handle, 'display'), type = found?.type ?? 'image/jpeg';
    if (!validMedia(found?.bytes, type)) return null;
    const held = { bytes: found.bytes, type };
    cache.set(handle, held); return held;
  };
  return {
    /** Send each released medium of this projector view once per projector window. */
    async frame(view) {
      for (const { handle } of viewMedia(view)) {
        if (sent.has(handle)) continue;
        sent.add(handle);
        const held = await bytesOf(handle);
        if (!held) { sent.delete(handle); continue; }
        post({ t: 'local_media', sessionId, handle, type: held.type, bytes: held.bytes.slice(0) });
      }
    },
    /**
     * The projector asked for a file it no longer holds (it evicted it): send it again, but only one this window was
     * already sent, so a request can never reach a file that was not released to it (red-team N1).
     */
    async again(handle) {
      if (!sent.has(handle)) return;
      const held = await bytesOf(handle);
      if (held) post({ t: 'local_media', sessionId, handle, type: held.type, bytes: held.bytes.slice(0) });
    },
    /** Hold every medium of the room in the console's memory while online, so manual mode can still show them. */
    async prefetch(handles) { for (const handle of handles) await bytesOf(handle); },
    /** A newly opened or reloaded projector window has none of the media yet. */
    reset() { sent.clear(); },
    dispose() { cache.clear(); sent.clear(); },
  };
}

/** Console side: an exact request from this room's projector for a file it no longer holds, or null. */
export function acceptMediaWanted(frame, sessionId) {
  return frame && typeof frame === 'object' && Object.keys(frame).sort().join() === 'handle,sessionId,t' && frame.t === 'projector_wants' &&
    frame.sessionId === sessionId && UUID7.test(frame.handle) ? frame : null;
}

/** Projector side: an exact local media frame for this room, or null. */
export function acceptLocalMedia(frame, sessionId) {
  return frame && typeof frame === 'object' && Object.keys(frame).sort().join() === 'bytes,handle,sessionId,t,type' && frame.t === 'local_media' &&
    frame.sessionId === sessionId && UUID7.test(frame.handle) && validMedia(frame.bytes, frame.type) ? frame : null;
}
