// The room code (card 36a): two groups of three aria-hidden boxes mirroring ONE native input (the only control).
import { JOIN_CODE_LENGTH } from '../shared/ids.mjs';

/** Wrap `input` in the boxes. Returns `{ root, sync }`; put `root` where the input was and call `sync()` after setting `input.value`. */
export function mountCodeBoxes(input) {
  const root = document.createElement('div'); root.className = 'code-boxes';
  const boxes = [];
  for (let i = 0; i < JOIN_CODE_LENGTH; i++) {
    if (i === JOIN_CODE_LENGTH / 2) { const gap = document.createElement('span'); gap.className = 'code-gap'; gap.setAttribute('aria-hidden', 'true'); root.append(gap); }
    const box = document.createElement('span'); box.className = 'code-box'; box.setAttribute('aria-hidden', 'true');
    boxes.push(box); root.append(box);
  }
  input.classList.add('code-boxes-input');
  root.append(input);
  const sync = () => {
    const at = document.activeElement === input ? Math.min(input.selectionStart ?? input.value.length, JOIN_CODE_LENGTH - 1) : -1;
    boxes.forEach((box, i) => {
      const char = input.value[i] ?? '';
      if (box.textContent !== char) box.textContent = char;
      if (i === at) box.setAttribute('data-active', ''); else box.removeAttribute('data-active');
    });
  };
  for (const type of ['input', 'paste', 'keyup', 'keydown', 'click', 'select', 'focus', 'blur']) input.addEventListener(type, () => queueMicrotask(sync));
  sync();
  return { root, sync };
}
