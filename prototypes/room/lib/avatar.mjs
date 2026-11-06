// prototypes/room/lib/avatar.mjs: a participant's avatar as an <img> of a vendored file (CASE-120).
//
// The id comes from a projection, so it is checked against the allow-list before it becomes a path:
// only a fixed original or colour-variant SVG from Case's own origin can ever load. The image is decorative
// (alt=""): the name always sits beside it. A participant without an avatar (an older room) gets a
// plain disc with their initial, as text.
import { isAvatarId } from '../../../src/shared/participant.mjs';

export const avatarUrl = (id) => (isAvatarId(id) ? new URL(`./avatars/${id}.svg`, import.meta.url).href : null);

/** @param {string|null} id  @param {{size?:number, name?:string}} o */
export function avatarEl(id, { size = 32, name = '' } = {}) {
  const url = avatarUrl(id);
  if (url) {
    const img = document.createElement('img');
    img.className = 'avatar';
    img.src = url; img.alt = ''; img.width = size; img.height = size;
    img.decoding = 'async'; img.draggable = false;
    return img;
  }
  const d = document.createElement('span');
  d.className = 'avatar avatar-none';
  d.setAttribute('aria-hidden', 'true');
  d.style.width = `${size}px`; d.style.height = `${size}px`; d.style.fontSize = `${Math.round(size * 0.42)}px`;
  d.textContent = String(name).trim().slice(0, 1).toUpperCase();
  return d;
}
