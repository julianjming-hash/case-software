// Tiny text-only element helpers shared by views that must not load all teaching controls.
import { setAuthoredText, isAuthoredFormat } from './authored-text.mjs';
import { cleanText } from '../shared/text.mjs';

const MAX_TEXT = 2_000;
export function el(tag, text, className) {
  const item = document.createElement(/^(p|h[1-6])$/.test(tag) && isAuthoredFormat(text) ? 'div' : tag);
  if (text != null) {
    if (isAuthoredFormat(text)) setAuthoredText(item, text, MAX_TEXT);
    else item.textContent = cleanText(text, MAX_TEXT);
  }
  if (className) item.className = className;
  return item;
}
export function button(label, action, className = 'btn') {
  const item = el('button', label, className);
  item.type = 'button'; item.dataset.focusKey = label;
  item.onclick = action;
  return item;
}
