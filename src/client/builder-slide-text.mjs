// Direct text editing on the slide (BWR04/17). A selected text, quote, callout or list block becomes a native
// contenteditable surface in place: paragraphs keep their style as their element, bold is <strong>, and subscript and
// superscript are <sub>/<sup> (CASE-225). Reading accepts
// only that vocabulary (spans the browser adds are transparent) and returns no partial value otherwise. Nothing is read
// while an IME composition is open; paste inserts plain text only. Undo/Redo belong to the Builder's draft history.
const STYLE_TAGS = Object.freeze({ h1: 'h2', h2: 'h3', h3: 'h4', h4: 'h5', p: 'p' });
const TAG_STYLES = Object.freeze({ H2: 'h1', H3: 'h2', H4: 'h3', H5: 'h4', P: 'p', DIV: 'p' });
const INLINE = new Set(['SPAN', 'FONT', 'EM', 'I', 'U']);

const runsOf = list => (Array.isArray(list) ? list : []);
function fillRuns(doc, node, runs) {
  for (const run of runsOf(runs)) {
    if (!run.text) continue;
    let part = doc.createTextNode(run.text);
    if (run.script) { const script = doc.createElement(run.script); script.append(part); part = script; }
    if (run.bold) { const strong = doc.createElement('strong'); strong.append(part); part = strong; }
    node.append(part);
  }
  if (!node.childNodes.length) node.append(doc.createElement('br'));
}

/** Read inline content into merged runs; `null` when it holds something this model cannot keep exactly. */
function readRuns(node, bold = false, out = [], script = null) {
  for (const child of node.childNodes) {
    if (child.nodeType === 3) { if (child.nodeValue) out.push({ text: child.nodeValue.replace(/ /g, ' '), bold, script }); continue; }
    if (child.nodeType !== 1) continue;
    const tag = child.tagName;
    if (tag === 'BR') continue; // the placeholder in an empty line
    if (tag === 'STRONG' || tag === 'B') { if (!readRuns(child, true, out, script)) return null; continue; }
    if (tag === 'SUB' || tag === 'SUP') { if (!readRuns(child, bold, out, tag.toLowerCase())) return null; continue; }
    // Spans the browser adds while merging lines carry no meaning here; a heavy span is bold.
    if (INLINE.has(tag)) { const weight = Number.parseInt(child.style?.fontWeight, 10); if (!readRuns(child, bold || weight >= 600, out, script)) return null; continue; }
    return null;
  }
  return out;
}
const merged = runs => {
  const out = [];
  for (const run of runs) {
    const last = out.at(-1);
    if (last && Boolean(last.bold) === Boolean(run.bold) && (last.script ?? null) === (run.script ?? null)) last.text += run.text;
    else out.push({ text: run.text, ...(run.bold ? { bold: true } : {}), ...(run.script ? { script: run.script } : {}) });
  }
  return out.length ? out : [{ text: '' }];
};

/** Paragraphs (or list items) from the surface, or null when the surface holds unsupported structure. */
export function readSurface(surface, kind) {
  const rows = [];
  const lines = kind === 'list' ? [...surface.children] : [...surface.childNodes];
  for (const line of lines) {
    if (line.nodeType === 3) { if (!line.nodeValue.trim()) continue; rows.push({ style: 'p', runs: merged([{ text: line.nodeValue, bold: false }]) }); continue; }
    if (line.nodeType !== 1) continue;
    if (kind === 'list' ? line.tagName !== 'LI' : !TAG_STYLES[line.tagName]) return null;
    const runs = readRuns(line);
    if (!runs) return null;
    rows.push({ style: kind === 'list' ? 'p' : TAG_STYLES[line.tagName] ?? 'p', runs: merged(runs) });
  }
  if (!rows.length) rows.push({ style: 'p', runs: [{ text: '' }] });
  if (kind === 'list') return rows.map(row => ({ runs: row.runs }));
  if (kind === 'text') return rows;
  return rows.map(row => ({ runs: row.runs }));
}

const kindOf = block => block.type === 'list' ? 'list' : block.type === 'text' ? 'text' : 'plain';

/** Build the editable surface for a block; `onChange(value)` receives paragraphs, or items for a list. */
export function mountBlockText(host, { block, label, onChange, onRefused = () => {}, room = null, onLimit = () => {} }) {
  const doc = host.ownerDocument, kind = kindOf(block);
  const surface = doc.createElement(kind === 'list' ? (block.ordered ? 'ol' : 'ul') : 'div');
  surface.className = 'builder-slide-text';
  surface.contentEditable = 'true';
  surface.setAttribute('role', 'textbox'); surface.setAttribute('aria-multiline', 'true'); surface.setAttribute('aria-label', label);
  surface.spellcheck = true;
  if (kind === 'list') for (const item of block.items) { const li = doc.createElement('li'); fillRuns(doc, li, item.runs); surface.append(li); }
  else for (const paragraph of block.paragraphs) {
    const style = kind === 'text' ? paragraph.style : 'p', line = doc.createElement(STYLE_TAGS[style] ?? 'p');
    if (style !== 'p') { line.dataset.style = style; line.className = `slide-${style}`; }
    fillRuns(doc, line, paragraph.runs); surface.append(line);
  }
  let composing = false;
  const read = () => {
    if (composing) return;
    const value = readSurface(surface, kind);
    if (!value) { onRefused('This text holds formatting the slide cannot keep. It stays visible here but is not in the draft; undo it or retype it as plain text.'); return; }
    onChange(value);
  };
  surface.addEventListener('compositionstart', () => { composing = true; });
  surface.addEventListener('compositionend', () => { composing = false; read(); });
  surface.addEventListener('input', event => { if (!event.isComposing) read(); });
  surface.addEventListener('beforeinput', event => {
    // One line per paragraph: a soft line break would be invisible on the slide.
    if (event.inputType === 'insertLineBreak') event.preventDefault();
    // Bold, subscript and superscript are kept; the browser's other formatting commands would be silently dropped.
    if (/^format(?!Bold|Subscript|Superscript)/.test(event.inputType)) event.preventDefault();
    // Typing stops at the block's character limit (round 19), so text the draft would refuse never sits on the slide.
    if (room && /^insert(Text|ReplacementText)$/.test(event.inputType)) {
      const adding = (event.data ?? event.dataTransfer?.getData('text/plain') ?? '').length - String(doc.getSelection() ?? '').length;
      if (adding > 0 && adding > room()) { event.preventDefault(); onLimit(); }
    }
  });
  surface.addEventListener('paste', event => {
    event.preventDefault();
    const text = event.clipboardData?.getData('text/plain') ?? '';
    // Hidden characters are cleaned silently (CASE-236): tabs become spaces; other controls and bidi marks go.
    let clean = text.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ufeff]/g, '');
    // A paste longer than the room left keeps what fits and says the limit was reached (round 19).
    if (room) { const fits = Math.max(0, room() + String(doc.getSelection() ?? '').length); if (clean.replace(/\n/g, '').length > fits) { clean = clean.slice(0, fits); onLimit(); } }
    if (clean) doc.execCommand('insertText', false, clean);
  });
  surface.addEventListener('drop', event => event.preventDefault());
  host.append(surface);
  return {
    surface,
    /** The paragraph style at the caret ('h1'…'p'), or null outside the surface. */
    styleAtCaret() {
      const node = doc.getSelection()?.anchorNode, line = lineOf(surface, node);
      return line ? (line.dataset.style ?? TAG_STYLES[line.tagName] ?? 'p') : null;
    },
    /** Restyle the lines touched by the selection, keep the caret, and commit once. */
    setStyle(style) {
      if (kind !== 'text' || !STYLE_TAGS[style]) return;
      const selection = doc.getSelection(), range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      const lines = [...surface.children].filter(line => range ? range.intersectsNode(line) : false);
      if (!lines.length && surface.firstElementChild) lines.push(surface.firstElementChild);
      const saved = range && { start: offsetIn(surface, range.startContainer, range.startOffset), end: offsetIn(surface, range.endContainer, range.endOffset) };
      for (const line of lines) {
        const next = doc.createElement(STYLE_TAGS[style]);
        if (style !== 'p') { next.dataset.style = style; next.className = `slide-${style}`; }
        next.append(...line.childNodes); line.replaceWith(next);
      }
      if (saved) restore(surface, saved);
      read();
    },
    bold() { surface.focus(); doc.execCommand('bold'); read(); },
    /** Toggle subscript or superscript on the selection (one excludes the other). */
    script(kind) { surface.focus(); doc.execCommand(kind === 'sub' ? 'subscript' : 'superscript'); read(); },
    focus() { surface.focus(); },
  };
}

/** The caret as character offsets across the surface, so a rebuilt surface can put it back exactly. */
export function caretOf(surface) {
  const selection = surface.ownerDocument.getSelection(), range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  if (!range || !surface.contains(range.startContainer)) return null;
  return { start: offsetIn(surface, range.startContainer, range.startOffset), end: offsetIn(surface, range.endContainer, range.endOffset) };
}
export function setCaret(surface, saved) { if (saved) restore(surface, saved); }

const lineOf = (surface, node) => { while (node && node.parentNode !== surface) node = node.parentNode; return node?.nodeType === 1 ? node : null; };
// Character offsets across the whole surface, so a restyle (which replaces elements) can put the caret back.
function offsetIn(surface, container, offset) {
  const walker = surface.ownerDocument.createTreeWalker(surface, 4);
  let total = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node === container) return total + offset;
    if (container.nodeType === 1 && container.contains(node) && [...container.childNodes].indexOf(node) >= offset) return total;
    total += node.nodeValue.length;
  }
  return total;
}
function restore(surface, { start, end }) {
  const doc = surface.ownerDocument, walker = doc.createTreeWalker(surface, 4), range = doc.createRange();
  let total = 0, started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.nodeValue.length;
    if (!started && start <= total + length) { range.setStart(node, start - total); started = true; }
    if (started && end <= total + length) { range.setEnd(node, end - total); const selection = doc.getSelection(); selection.removeAllRanges(); selection.addRange(range); return; }
    total += length;
  }
}
