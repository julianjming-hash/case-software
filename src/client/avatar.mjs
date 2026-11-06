import { isAvatarId } from '../shared/participant.mjs';
import { AVATAR_URLS } from './avatar-assets.mjs';
export function avatarEl(id, { size = 32, name = '' } = {}) {
  const url = isAvatarId(id) ? AVATAR_URLS[id] : null;
  if (url) {
    const image = document.createElement('img'); image.className = 'avatar'; image.src = new URL(url, document.baseURI).href; // absolute, so a frame drawn from this page (Run preview) loads it too
    image.alt = ''; image.width = size; image.height = size; image.decoding = 'async'; return image;
  }
  const fallback = document.createElement('span'); fallback.className = 'avatar avatar-none';
  fallback.setAttribute('aria-hidden', 'true'); fallback.textContent = name.trim().slice(0, 1).toUpperCase(); return fallback;
}
