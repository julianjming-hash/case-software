// Case-owned formatting is rendered with text nodes; no HTML or Markdown boundary.
import { validateFormattedText, formattedTextPlainText } from '../shared/builder-format.mjs';
import { renderFormattedText } from './formatted-text.mjs';
import { cleanText } from '../shared/text.mjs';
export function isAuthoredFormat(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function validAuthoredText(value, max = 2000) {
  if (typeof value === 'string') return value.length <= max;
  return isAuthoredFormat(value) && validateFormattedText(value, { maxBytes: 1_048_576 }).length === 0 && formattedTextPlainText(value).length <= max;
}
export function setAuthoredText(element, value, max = 2000) {
  if (!isAuthoredFormat(value)) { element.textContent = cleanText(value, max); return; }
  if (!validAuthoredText(value, max)) throw new TypeError('Unsupported authored text');
  const content = renderFormattedText(element.ownerDocument, value, { validateFormattedText: candidate => validateFormattedText(candidate, { maxBytes: 1_048_576 }) });
  element.replaceChildren(...content.childNodes);
}
