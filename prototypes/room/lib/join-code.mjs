// Native six-character input mask. Uses the shared Crockford normaliser; no room or network state.
import { normalizeCode, JOIN_CODE_LENGTH } from '../../../src/shared/ids.mjs';

export function attachRoomCodeMask(code, codeHint, initialValue = '') {
  const maskedCode = (raw) => [...String(raw)].map((c) => normalizeCode(c, 1) || '').join('').slice(0, JOIN_CODE_LENGTH);
  code.value = maskedCode(initialValue);
  codeHint.textContent = `${code.value.length} of ${JOIN_CODE_LENGTH} characters`;
  const applyCode = (raw, caret) => {
    const pos = maskedCode(raw.slice(0, caret)).length;
    code.value = maskedCode(raw);
    code.setSelectionRange(pos, pos);
    codeHint.textContent = `${code.value.length} of ${JOIN_CODE_LENGTH} characters`;
  };
  code.addEventListener('input', () => applyCode(code.value, code.selectionStart ?? code.value.length));
  code.addEventListener('paste', (ev) => {
    const pasted = ev.clipboardData?.getData('text/plain');
    if (pasted === undefined) return;
    ev.preventDefault();
    const start = code.selectionStart ?? code.value.length;
    const end = code.selectionEnd ?? start;
    const text = maskedCode(pasted);
    applyCode(code.value.slice(0, start) + text + code.value.slice(end), start + text.length);
  });
}
