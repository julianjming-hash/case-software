// Image and ECG blocks (card 59 M2, CASE-268): the block's contract, apart from slide-document.mjs (which imports it and
// passes its checks and SLIDE_LIMITS). A block names one workspace image by id and carries its own text alternative and
// caption, so they reveal with it. An ECG is an image with typed calibration, always shown whole (contain), never a
// vector trace. Whether the image is approved, and its licence and attribution, live with the asset, not the document.
export const ECG_SPEEDS = Object.freeze(['', '25', '50']);
export const ECG_GAINS = Object.freeze(['', '5', '10', '20']);
export const ECG_LAYOUTS = Object.freeze(['12-lead', 'rhythm-strip', 'other']);
export const IMAGE_TEXT = Object.freeze({ alt: 300, caption: 200 });
export const IMAGE_FITS = Object.freeze(['contain', 'cover']);
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function validateImage(block, at, { text, keys, fail }) {
  if (typeof block.asset_id !== 'string' || !UUID_V7.test(block.asset_id)) fail('bad_id', `${at}/asset_id`, 'must name a workspace image');
  text(block.alt, `${at}/alt`, IMAGE_TEXT.alt, 1);
  text(block.caption, `${at}/caption`, IMAGE_TEXT.caption);
  if (!IMAGE_FITS.includes(block.fit)) fail('enum', `${at}/fit`, `one of ${IMAGE_FITS.join(', ')}`);
  if (block.ecg !== null) {
    if (!block.ecg || typeof block.ecg !== 'object' || Array.isArray(block.ecg)) { fail('type', `${at}/ecg`, 'must be ECG calibration or null'); return; }
    keys(block.ecg, ['speed', 'gain', 'layout'], `${at}/ecg`);
    if (!ECG_SPEEDS.includes(block.ecg.speed)) fail('enum', `${at}/ecg/speed`, 'paper speed 25 or 50 mm/s, or not stated');
    if (!ECG_GAINS.includes(block.ecg.gain)) fail('enum', `${at}/ecg/gain`, 'gain 5, 10 or 20 mm/mV, or not stated');
    if (!ECG_LAYOUTS.includes(block.ecg.layout)) fail('enum', `${at}/ecg/layout`, `one of ${ECG_LAYOUTS.join(', ')}`);
    // A trace is never cropped by the slide; only the author's crop at upload trims it.
    if (block.fit !== 'contain') fail('enum', `${at}/fit`, 'an ECG is always shown whole');
  }
}
