// Image, GIF, video and ECG drawing (card 59, CASE-268/269), planned for slide-render.mjs's buildSlide. The picture is a
// blob: URL the caller already fetched under its own authority (the Builder's authoring route; a room's reveal-gated
// route); a block whose bytes are not here yet, or never will be, shows its text alternative in the same box instead.
// A video is a <video> once its file is here: the projector's is driven by the room's playback, a phone's has its own
// controls; before that a phone shows the poster, which plays the video when tapped. Caption and calibration are text nodes. Credits belong in private facilitator notes. An ECG is always shown whole.
const node = (tag, cls, children = [], extra = {}) => ({ tag, cls, children, ...extra });
const text = value => ({ text: String(value) });

/** The calibration line an ECG shows under it, from the author's choices only. */
export function ecgCalibration(ecg) {
  if (!ecg) return '';
  const parts = [ecg.speed && `${ecg.speed} mm/s`, ecg.gain && `${ecg.gain} mm/mV`].filter(Boolean);
  const layout = { '12-lead': '12-lead', 'rhythm-strip': 'Rhythm strip', other: '' }[ecg.layout] ?? '';
  return [layout, parts.length ? parts.join(' · ') : 'Calibration not stated'].filter(Boolean).join(' · ');
}

/**
 * `media(block)` answers `{ url, width, height, attribution, state, type?, poster?, controls? }` or null; state is
 * 'withdrawn' for a withdrawn image. The Builder resolves a block by its asset id (a video as its poster); a room by
 * the opaque `media` handle the room released with it.
 */
export function imageFigure(block, media) {
  const found = typeof media === 'function' ? media(block) : null, ecg = block.ecg !== null;
  const fit = ecg ? 'contain' : block.fit;
  const video = found?.type === 'video/mp4', moving = video || found?.type === 'image/gif', what = video ? 'video' : 'animation';
  const picture = found?.url && video
    ? node('video', `slide-picture slide-video slide-fit-${fit}`, [], { attrs: { 'aria-label': block.alt, 'data-video-block': block.id }, src: found.url,
      ...(found.poster ? { poster: found.poster } : {}), video: { controls: Boolean(found.controls) }, size: [found.width, found.height] })
    : moving && !found.url && found.poster
      // A phone's GIF or video before it is fetched: the poster, which plays it when tapped (phone-render wires the tap).
      ? node('img', `slide-picture slide-video-poster slide-fit-${fit}`, [], { attrs: { alt: `${found.loading ? `Loading ${what}` : `Play ${what}`}: ${block.alt}`, 'data-video-handle': found.handle },
        src: found.poster, size: [found.width, found.height] })
    : found?.url
    ? node('img', `slide-picture slide-fit-${fit}`, [], { attrs: { alt: block.alt }, src: found.url, size: [found.width, found.height] })
    : node('div', 'slide-image-missing', [text(found?.state === 'withdrawn' ? `Image withdrawn. ${block.alt}` : block.alt)], { attrs: { role: 'img', 'aria-label': block.alt } });
  const cue = moving && !found?.url && found?.poster && node('span', 'slide-figure-cue', [text(found.loading ? `Loading the ${what}…` : `Tap the picture to play the ${what}`)]);
  const lines = [cue, block.caption && node('span', 'slide-figure-caption', [text(block.caption)]), ecg && node('span', 'slide-figure-calibration', [text(ecgCalibration(block.ecg))])].filter(Boolean);
  return [node('figure', `slide-figure${ecg ? ' slide-figure-ecg' : ''}`, [picture, ...(lines.length ? [node('figcaption', null, lines)] : [])])];
}
