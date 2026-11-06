import { renderFormattedText } from './formatted-text.mjs';

const clone = value => structuredClone(value);
const allowedInline = new Set(['#text', 'STRONG', 'B', 'BR']);

export { renderFormattedText } from './formatted-text.mjs';

export function emptyFormattedText() { return { blocks: [{ type: 'paragraph', runs: [{ text: '' }] }] }; }

/** Apply a bold toggle to a UTF-16 selection within one paragraph or list item. */
export function applyBoldSelection(value, { blockIndex, itemIndex, start, end }) {
  if (!Number.isInteger(blockIndex) || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) throw new TypeError('select a non-empty text range');
  const next = clone(value);
  const target = getRunTarget(next, blockIndex, itemIndex);
  if (!target) throw new RangeError('selected text block does not exist');
  const total = target.runs.reduce((length, run) => length + run.text.length, 0);
  if (end > total) throw new RangeError('selection exceeds the selected text block');
  const segments = [];
  let offset = 0;
  for (const run of target.runs) {
    const text = run.text;
    const from = offset;
    const to = from + text.length;
    const cuts = [0, Math.max(0, Math.min(text.length, start - from)), Math.max(0, Math.min(text.length, end - from)), text.length]
      .filter((point, index, all) => index === 0 || point !== all[index - 1])
      .sort((a, b) => a - b);
    for (let i = 0; i < cuts.length - 1; i++) {
      const a = cuts[i], b = cuts[i + 1];
      if (a === b) continue;
      const selected = from + a >= start && from + a < end;
      segments.push({ text: text.slice(a, b), bold: Boolean(run.bold), selected });
    }
    offset = to;
  }
  const removeBold = segments.filter(segment => segment.selected).every(segment => segment.bold);
  target.runs = segments.map(({ text, bold, selected }) => {
    const nextBold = selected ? !removeBold : bold;
    return nextBold ? { text, bold: true } : { text };
  });
  return next;
}

export function convertParagraphToList(value, blockIndex, ordered) {
  if (typeof ordered !== 'boolean') throw new TypeError('ordered must be a boolean');
  if (!Number.isInteger(blockIndex) || value?.blocks?.[blockIndex]?.type !== 'paragraph') throw new RangeError('selected block is not a paragraph');
  const next = clone(value);
  const block = next.blocks[blockIndex];
  next.blocks.splice(blockIndex, 1, { type: 'list', ordered, items: [{ runs: block.runs }] });
  return next;
}

export function convertListToParagraphs(value, blockIndex) {
  if (!Number.isInteger(blockIndex) || value?.blocks?.[blockIndex]?.type !== 'list') throw new RangeError('selected block is not a list');
  const next = clone(value);
  const block = next.blocks[blockIndex];
  next.blocks.splice(blockIndex, 1, ...block.items.map(item => ({ type: 'paragraph', runs: item.runs })));
  return next;
}

/**
 * Read only the constrained DOM vocabulary used by the native editing surface.
 * This never reads HTML strings and returns no partial value when it sees an unknown node.
 */
export function readFormattedDom(root, { validateFormattedText } = {}) {
  const issues = [];
  const blocks = [];
  for (const node of root?.childNodes ?? []) {
    if (node.nodeType === 3 && node.nodeValue === '') continue;
    const tag = node.nodeType === 1 ? node.tagName : '';
    if (tag === 'P' || tag === 'DIV') {
      const runs = readInline(node, issues, `/blocks/${blocks.length}`);
      blocks.push({ type: 'paragraph', runs });
    } else if (tag === 'UL' || tag === 'OL') {
      const items = [];
      for (const item of node.childNodes) {
        if (item.nodeType === 3 && item.nodeValue.trim() === '') continue;
        if (item.nodeType !== 1 || item.tagName !== 'LI') {
          issues.push({ code: 'unsupported_dom', at: `/blocks/${blocks.length}`, message: 'A list may contain list items only.' });
          continue;
        }
        items.push({ runs: readInline(item, issues, `/blocks/${blocks.length}/items/${items.length}`) });
      }
      blocks.push({ type: 'list', ordered: tag === 'OL', items });
    } else {
      issues.push({ code: 'unsupported_dom', at: `/blocks/${blocks.length}`, message: 'Use paragraphs, bold text and simple lists only.' });
    }
  }
  const value = { blocks };
  if (!issues.length && typeof validateFormattedText === 'function') issues.push(...validateFormattedText(value));
  return { value: issues.length ? null : value, issues };
}

/** Mount a native contenteditable editor for the bounded Case representation. */
export function mountNativeFormatEditor(container, {
  value, validateFormattedText, onChange = () => {}, onStatus = () => {}, label = 'Formatted teaching text',
} = {}) {
  const doc = container?.ownerDocument;
  if (!doc) throw new TypeError('editor container must belong to a document');
  validateOrThrow(value, validateFormattedText);
  let current = clone(value);
  let composing = false;
  let destroyed = false;
  let editEpoch = 0;
  let formatUndo = null;
  const toolbar = doc.createElement('div');
  const surface = doc.createElement('div');
  const status = doc.createElement('p');
  const undo = makeButton(doc, 'Undo format', true);
  const bold = makeButton(doc, 'Bold selection');
  const ordered = makeButton(doc, 'Make ordered list');
  const unordered = makeButton(doc, 'Make bulleted list');
  toolbar.setAttribute('role', 'group');
  toolbar.setAttribute('aria-label', 'Text formatting');
  surface.setAttribute('contenteditable', 'true');
  surface.setAttribute('role', 'textbox');
  surface.setAttribute('aria-multiline', 'true');
  surface.setAttribute('aria-label', label);
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');
  undo.disabled = true;
  toolbar.append(bold, ordered, unordered, undo);
  container.append(toolbar, surface, status);
  renderInto(surface, current, validateFormattedText);

  const handleInput = () => {
    if (destroyed || composing) return;
    editEpoch++;
    formatUndo = null;
    undo.disabled = true;
    const parsed = readFormattedDom(surface, { validateFormattedText });
    if (parsed.issues.length) {
      setStatus(`This edit contains unsupported formatting. It remains visible, but has not entered the saved draft. ${parsed.issues[0].message}`);
      return;
    }
    current = parsed.value;
    setStatus('Text updated. Changes are not saved until the draft is saved.');
    onChange(clone(current), { reason: 'native-input' });
  };
  const handleBeforeInput = event => {
    if (/^format/i.test(event.inputType || '') && event.cancelable) {
      event.preventDefault();
      setStatus('Use the Case formatting buttons so unsupported marks are not added.');
    }
  };
  const handleCompositionStart = () => { composing = true; };
  const handleCompositionEnd = () => { composing = false; handleInput(); };
  const handleKeyDown = event => {
    if ((event.metaKey || event.ctrlKey) && !event.isComposing && String(event.key).toLowerCase() === 'b') {
      event.preventDefault();
      toggleBold();
    } else if ((event.metaKey || event.ctrlKey) && String(event.key).toLowerCase() === 'z' && !event.shiftKey && formatUndo && editEpoch === formatUndo.epoch) {
      event.preventDefault();
      undoFormatting();
    }
  };
  const handlePaste = event => {
    event.preventDefault();
    // Hidden characters are cleaned silently (CASE-236): tabs become spaces; other controls and bidi marks go.
    const raw = event.clipboardData?.getData('text/plain'), plain = typeof raw === 'string' ? raw.replace(/\t/g, ' ').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ufeff]/g, '') : raw;
    if (typeof plain !== 'string' || (!plain && event.clipboardData?.getData('text/html'))) { setStatus('This clipboard has no plain text. Rich clipboard content was not imported.'); return; }
    const before = clone(current);
    if (!insertPlainText(doc, surface, plain)) { setStatus('Place the text cursor in the teaching text, then paste again.'); return; }
    editEpoch++;
    formatUndo = { before, epoch: editEpoch };
    undo.disabled = false;
    handleInputAfterScript('paste');
    if (event.clipboardData.getData('text/html')) setStatus('Pasted plain text. Clipboard formatting and other content were not imported.');
  };
  const handleDrop = event => {
    event.preventDefault();
    const plain = event.dataTransfer?.getData('text/plain');
    if (typeof plain !== 'string' || !plain) { setStatus('Only plain text can be dropped into this field. Nothing was inserted.'); return; }
    const before = clone(current);
    const range = doc.caretRangeFromPoint?.(event.clientX, event.clientY) ?? doc.caretPositionFromPoint?.(event.clientX, event.clientY);
    if (!range) { setStatus('Place the text cursor in the teaching text, then drop again.'); return; }
    if (range && 'offsetNode' in range) {
      const nativeRange = doc.createRange(); nativeRange.setStart(range.offsetNode, range.offset); nativeRange.collapse(true);
      const selection = doc.getSelection(); selection.removeAllRanges(); selection.addRange(nativeRange);
    } else if ('startContainer' in range) {
      if (!surface.contains(range.startContainer)) { setStatus('Place the text cursor in the teaching text, then drop again.'); return; }
      const selection = doc.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    } else {
      setStatus('Place the text cursor in the teaching text, then drop again.'); return;
    }
    if (!insertPlainText(doc, surface, plain)) { setStatus('Place the text cursor in the teaching text, then drop again.'); return; }
    editEpoch++;
    formatUndo = { before, epoch: editEpoch };
    undo.disabled = false;
    handleInputAfterScript('drop');
    if (event.dataTransfer.getData('text/html')) setStatus('Dropped plain text. Clipboard formatting and other content were not imported.');
  };
  const onButtonDown = event => event.preventDefault();
  for (const button of [bold, ordered, unordered, undo]) button.addEventListener('mousedown', onButtonDown);
  surface.addEventListener('input', handleInput);
  surface.addEventListener('beforeinput', handleBeforeInput);
  surface.addEventListener('compositionstart', handleCompositionStart);
  surface.addEventListener('compositionend', handleCompositionEnd);
  surface.addEventListener('keydown', handleKeyDown);
  surface.addEventListener('paste', handlePaste);
  surface.addEventListener('drop', handleDrop);
  bold.addEventListener('click', toggleBold);
  ordered.addEventListener('click', () => setList(true));
  unordered.addEventListener('click', () => setList(false));
  undo.addEventListener('click', undoFormatting);

  function setStatus(message) { status.textContent = message; onStatus(message); }
  function handleInputAfterScript(reason) {
    const parsed = readFormattedDom(surface, { validateFormattedText });
    if (parsed.issues.length) { setStatus(`This edit contains unsupported formatting. It remains visible, but has not entered the saved draft. ${parsed.issues[0].message}`); return; }
    current = parsed.value;
    setStatus(reason === 'paste' ? 'Plain text inserted. Use Undo format to reverse this paste.' : 'Plain text inserted. Use Undo format to reverse this drop.');
    onChange(clone(current), { reason });
  }
  function toggleBold() {
    const target = selectedTarget(doc, surface);
    if (!target || target.start === target.end) { setStatus('Select text before applying bold.'); return; }
    applyFormatting(next => applyBoldSelection(current, target), target);
  }
  function setList(isOrdered) {
    const target = selectedTarget(doc, surface);
    if (!target) { setStatus('Place the cursor in a paragraph or list first.'); return; }
    const block = current.blocks[target.blockIndex];
    try {
      const next = block.type === 'paragraph'
        ? convertParagraphToList(current, target.blockIndex, isOrdered)
        : block.ordered === isOrdered ? convertListToParagraphs(current, target.blockIndex) : setListKind(current, target.blockIndex, isOrdered);
      applyFormatting(() => next, target);
    } catch { setStatus('This text block could not be changed to a list.'); }
  }
  function applyFormatting(transform, target) {
    const before = clone(current);
    let next;
    try { next = transform(); validateOrThrow(next, validateFormattedText); }
    catch (error) { setStatus(error?.message || 'This formatting change is unavailable.'); return; }
    formatUndo = { before, target: selectionTargetForValue(target, before, next), epoch: ++editEpoch };
    current = clone(next);
    renderInto(surface, current, validateFormattedText);
    undo.disabled = false;
    surface.focus();
    restoreSelection(doc, surface, selectionTargetForValue(target, before, next));
    setStatus('Formatting applied. Use Undo format to reverse it.');
    onChange(clone(current), { reason: 'format-command' });
  }
  function undoFormatting() {
    if (!formatUndo || formatUndo.epoch !== editEpoch) return;
    const { before, target } = formatUndo;
    formatUndo = null;
    current = clone(before);
    renderInto(surface, current, validateFormattedText);
    undo.disabled = true;
    surface.focus();
    if (target) restoreSelection(doc, surface, target);
    setStatus('Last formatting change undone.');
    onChange(clone(current), { reason: 'format-undo' });
  }
  function setValue(next) {
    if (composing) return false;
    validateOrThrow(next, validateFormattedText);
    current = clone(next);
    formatUndo = null;
    editEpoch++;
    undo.disabled = true;
    renderInto(surface, current, validateFormattedText);
    return true;
  }
  function handleDestroy() {
    if (destroyed) return;
    destroyed = true;
    surface.replaceChildren();
    container.replaceChildren();
    current = { blocks: [] };
    formatUndo = null;
  }

  return Object.freeze({
    getValue: () => clone(current),
    setValue,
    focus: () => surface.focus(),
    destroy: handleDestroy,
    elements: Object.freeze({ surface, status, toolbar, undo, bold, ordered, unordered }),
  });
}

function setListKind(value, index, ordered) {
  const next = clone(value);
  next.blocks[index].ordered = ordered;
  return next;
}

function makeButton(doc, label, disabled = false) {
  const button = doc.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.setAttribute('aria-label', label);
  button.disabled = disabled;
  return button;
}

function renderInto(surface, value, validateFormattedText) {
  const rendered = renderFormattedText(surface.ownerDocument, value, { validateFormattedText });
  surface.replaceChildren(...rendered.childNodes);
  rendered.replaceChildren();
  setBlockIdentity(surface);
}

function setBlockIdentity(surface) {
  let blockIndex = 0;
  for (const block of surface.childNodes) {
    block.setAttribute('data-block-index', String(blockIndex++));
    if (block.tagName === 'UL' || block.tagName === 'OL') {
      let itemIndex = 0;
      for (const item of block.childNodes) item.setAttribute('data-item-index', String(itemIndex++));
    }
  }
}

function selectedTarget(doc, surface) {
  const selection = doc.getSelection?.();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!surface.contains(range.startContainer) || !surface.contains(range.endContainer)) return null;
  const startBlock = nearestBlock(range.startContainer, surface);
  const endBlock = nearestBlock(range.endContainer, surface);
  if (!startBlock || startBlock !== endBlock) return null;
  const blockIndex = Number(startBlock.getAttribute('data-block-index'));
  const item = startBlock.closest('li');
  const itemIndex = item ? Number(item.getAttribute('data-item-index')) : undefined;
  const start = textOffset(doc, startBlock, range.startContainer, range.startOffset);
  const end = textOffset(doc, startBlock, range.endContainer, range.endOffset);
  if (![blockIndex, start, end].every(Number.isInteger)) return null;
  return { blockIndex, ...(itemIndex === undefined ? {} : { itemIndex }), start: Math.min(start, end), end: Math.max(start, end) };
}

function nearestBlock(node, surface) {
  let element = node.nodeType === 1 ? node : node.parentElement;
  while (element && element !== surface) {
    if (element.hasAttribute?.('data-block-index')) return element;
    element = element.parentElement;
  }
  return null;
}

function textOffset(doc, block, node, offset) {
  const range = doc.createRange();
  range.selectNodeContents(block);
  range.setEnd(node, offset);
  return range.toString().length;
}

function selectionTargetForValue(target, before, after) {
  if (!target) return null;
  const prior = before.blocks[target.blockIndex];
  const next = after.blocks[target.blockIndex];
  if (prior?.type === 'list' && next?.type === 'paragraph') {
    return { ...target, blockIndex: target.blockIndex + (target.itemIndex ?? 0), itemIndex: undefined };
  }
  if (next?.type === 'list' && target.itemIndex === undefined) return { ...target, itemIndex: 0 };
  return target;
}

function restoreSelection(doc, surface, target) {
  if (!target) return;
  const block = surface.childNodes[target.blockIndex];
  if (!block) return;
  const leaf = target.itemIndex === undefined ? block : block.childNodes[target.itemIndex];
  if (!leaf) return;
  const start = Math.min(target.start, visibleTextLength(leaf));
  const end = Math.min(target.end, visibleTextLength(leaf));
  const range = doc.createRange();
  const startPoint = textPoint(doc, leaf, start);
  const endPoint = textPoint(doc, leaf, end);
  if (!startPoint || !endPoint) return;
  range.setStart(startPoint.node, startPoint.offset);
  range.setEnd(endPoint.node, endPoint.offset);
  const selection = doc.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function visibleTextLength(root) {
  let length = 0;
  const walk = node => { for (const child of node.childNodes ?? []) { if (child.nodeType === 3) length += child.nodeValue.length; else if (child.nodeName === 'BR') length++; else walk(child); } };
  walk(root); return length;
}

function textPoint(doc, root, targetOffset) {
  const walker = doc.createTreeWalker(root, 4);
  let remaining = targetOffset;
  let node;
  while ((node = walker.nextNode())) {
    if (remaining <= node.nodeValue.length) return { node, offset: remaining };
    remaining -= node.nodeValue.length;
  }
  const text = doc.createTextNode('');
  root.append(text);
  return { node: text, offset: 0 };
}

function insertPlainText(doc, surface, value) {
  const selection = doc.getSelection?.();
  if (!selection?.rangeCount) return false;
  const range = selection.getRangeAt(0);
  if (!surface.contains(range.startContainer) || !surface.contains(range.endContainer)) return false;
  range.deleteContents();
  const fragment = doc.createDocumentFragment();
  const lines = String(value).split(/\r\n|\n|\r/);
  lines.forEach((line, index) => {
    if (index) fragment.append(doc.createElement('br'));
    if (line) fragment.append(doc.createTextNode(line));
  });
  const last = fragment.lastChild;
  range.insertNode(fragment);
  if (last) {
    range.setStartAfter(last);
    range.collapse(true);
    selection.removeAllRanges(); selection.addRange(range);
  }
  return true;
}

function readInline(parent, issues, at, inheritedBold = false) {
  const runs = [];
  const children = [...(parent.childNodes ?? [])];
  if (children.length === 1 && children[0].nodeType === 1 && children[0].tagName === 'BR') return [{ text: '' }];
  for (const child of children) {
    if (child.nodeType === 3) {
      if (child.nodeValue) runs.push(inheritedBold ? { text: child.nodeValue, bold: true } : { text: child.nodeValue });
      continue;
    }
    if (child.nodeType !== 1) {
      issues.push({ code: 'unsupported_dom', at, message: 'The edited text contains an unsupported node.' });
      continue;
    }
    const tag = child.tagName;
    if (!allowedInline.has(tag)) {
      issues.push({ code: 'unsupported_dom', at, message: 'Only plain text, bold text and line breaks are supported.' });
      continue;
    }
    if (tag === 'BR') runs.push(inheritedBold ? { text: '\n', bold: true } : { text: '\n' });
    else runs.push(...readInline(child, issues, at, inheritedBold || tag === 'STRONG' || tag === 'B'));
  }
  return runs;
}

function getRunTarget(value, blockIndex, itemIndex) {
  const block = value?.blocks?.[blockIndex];
  if (block?.type === 'paragraph' && itemIndex === undefined) return block;
  if (block?.type === 'list' && Number.isInteger(itemIndex)) return block.items?.[itemIndex];
  return null;
}

function validateOrThrow(value, validate) {
  if (typeof validate !== 'function') throw new TypeError('validateFormattedText is required');
  const issues = validate(value);
  if (issues.length) throw Object.assign(new TypeError('formatted text is invalid'), { code: 'invalid_formatted_text', issues: clone(issues) });
}
