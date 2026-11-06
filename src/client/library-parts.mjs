// Shared library pieces (card 29): covers, the pilot tag and dates, used by the catalogue and case detail.
import { node } from './auth-ui.mjs';
import { pilotVersionState } from './console-pin.mjs';
import { ART_LABEL, validArtDescriptor } from '../shared/art-descriptor.mjs';
import { BRAND_ART } from './brand-art.mjs';
import { PILOT_TEXT, pilotTone } from './library-model.mjs';
import { tintOf } from '../shared/tints.mjs';

export const formatDate = value => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : 'Date not set';
};

/** The immutable case cover, or decorative brand artwork, in its group's tint. Painted later. */
export function coverFor(row, covers, className = 'cover', { full = false } = {}) {
  const holder = node('div', null, className);
  const tint = tintOf(row.tint); holder.dataset.tint = tint;
  const brand = !validArtDescriptor(row.art);
  const art = brand ? BRAND_ART : row.art;
  holder.dataset.art = brand ? 'brand' : 'case';
  if (brand) holder.setAttribute('aria-hidden', 'true');
  const canvas = node('canvas'); canvas.width = 1; canvas.height = 1;
  canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', ART_LABEL);
  holder.append(canvas); covers.push({ canvas, art, full, group: tint, contentSeed: brand ? 'case-brand' : row.case_id });
  return holder;
}
export function pilotTag(row, pilotPin) {
  const state = pilotVersionState(row, pilotPin);
  return PILOT_TEXT[state] ? node('span', PILOT_TEXT[state], `tag ${pilotTone(state)} pilot-tag`) : null;
}
