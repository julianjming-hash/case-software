// One popup per document, including controls inside a native modal dialog. Popovers use the top
// layer without moving focus; Escape closes the popup before it reaches the enclosing dialog.
const active = new WeakMap();
export function sharedPopup(anchor, panel, onClose) {
  const doc = anchor.ownerDocument, win = doc.defaultView;
  let opened = false;
  panel.classList.add('shared-popup'); panel.setAttribute('popover', 'manual');
  panel.hidden = true; doc.body.append(panel);
  function position() {
    const box = anchor.getBoundingClientRect(), gap = 6, edge = 12;
    const width = Math.min(Math.max(box.width, 180), win.innerWidth - edge * 2);
    panel.style.setProperty('--popup-left', `${Math.max(edge, Math.min(box.left, win.innerWidth - width - edge))}px`);
    panel.style.setProperty('--popup-width', `${width}px`);
    const below = win.innerHeight - box.bottom - gap - edge, above = box.top - gap - edge;
    const bottom = below < Math.min(240, above);
    panel.style.setProperty('--popup-top', bottom ? 'auto' : `${box.bottom + gap}px`);
    panel.style.setProperty('--popup-bottom', bottom ? `${win.innerHeight - box.top + gap}px` : 'auto');
    panel.style.setProperty('--popup-height', `${Math.max(44, bottom ? above : below)}px`);
  }
  function close() {
    if (!opened) return;
    opened = false;
    doc.removeEventListener('pointerdown', outside, true); doc.removeEventListener('keydown', escape, true);
    win.removeEventListener('resize', position); doc.removeEventListener('scroll', position, true);
    if (typeof panel.hidePopover === 'function' && panel.matches(':popover-open')) panel.hidePopover();
    panel.hidden = true; if (active.get(doc) === close) active.delete(doc); onClose?.();
  }
  function outside(event) { if (!panel.contains(event.target) && !anchor.contains(event.target)) close(); }
  function escape(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault(); event.stopImmediatePropagation(); close();
  }
  return {
    open() {
      active.get(doc)?.(); opened = true; active.set(doc, close);
      (anchor.closest('dialog[open]') ?? doc.body).append(panel); panel.hidden = false; position();
      if (typeof panel.showPopover === 'function') panel.showPopover();
      doc.addEventListener('pointerdown', outside, true); doc.addEventListener('keydown', escape, true);
      win.addEventListener('resize', position); doc.addEventListener('scroll', position, true);
    }, close, dispose() { close(); panel.replaceChildren(); panel.remove(); }, get opened() { return opened; },
  };
}
