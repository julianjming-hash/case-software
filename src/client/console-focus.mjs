// Keep a room form stable during background updates. A genuine phase change
// instead announces the new heading; a tab change follows its selected tab.
export function focusAfterConsoleUpdate({ activeTag, phase, nextPhase, tab, nextTab, focusKey }) {
  if (phase && phase !== nextPhase) return { kind: 'heading' };
  if (tab !== nextTab) return { kind: 'key', key: `tab-${nextTab}` };
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(activeTag)) return { kind: 'defer' };
  if (focusKey) return { kind: 'key', key: focusKey };
  return { kind: 'none' };
}

// Console render reconciliation (card 37). Every update builds a fresh tree; the live tree keeps each node
// whose markup is unchanged, so a vote or a projector hello never replaces the scene, never moves the
// scroll position and never replays an entrance. Pure DOM structure only: no text is parsed or written here.

// A control's handler is a closure over the render that built it (a page, a revision, a participant), which its
// markup need not show. Console handlers are element properties, so a kept node takes the fresh render's handlers
// (red team H1) while keeping its focus, its typed value and its picked option; a handler reads any other control
// it needs from the live DOM at the press, never from the render that built it.
const HANDLERS = ['onclick', 'onchange', 'oninput', 'onkeydown'];
function adoptHandlers(live, fresh) {
  for (const name of HANDLERS) if (live[name] !== fresh[name]) live[name] = fresh[name] ?? null;
  if (fresh.hasAttribute?.('data-keep')) return; // a slot's content is a persistent node with its own handlers
  const kids = [...fresh.childNodes], mine = [...live.childNodes];
  kids.forEach((kid, i) => { if (kid.nodeType === 1) adoptHandlers(mine[i], kid); });
}

/** Same element or text, attributes and children; a `data-keep` slot compares by its own attributes only (its
 *  content is a persistent node owned by the console). Values and picks are the person's, not the render's: a
 *  server-driven selection is rendered as the `selected` attribute. */
export function sameNode(a, b) {
  if (a.nodeType !== b.nodeType) return false;
  if (a.nodeType !== 1) return a.nodeValue === b.nodeValue;
  if (a.tagName !== b.tagName || !sameAttributes(a, b)) return false;
  if (b.hasAttribute('data-keep')) return true;
  if (a.childNodes.length !== b.childNodes.length) return false;
  for (let i = 0; i < b.childNodes.length; i += 1) if (!sameNode(a.childNodes[i], b.childNodes[i])) return false;
  return true;
}
function sameAttributes(a, b) {
  if (a.attributes.length !== b.attributes.length) return false;
  for (const { name, value } of b.attributes) if (a.getAttribute(name) !== value) return false;
  return true;
}

/** Bring `live`'s children to `fresh`'s, position by position: an unchanged child is kept, a child whose own
 *  attributes match is patched in place, anything else is replaced; extra children are added or removed. */
export function patchChildren(live, fresh, depth = 6) {
  const next = [...fresh.childNodes], old = [...live.childNodes];
  next.forEach((node, i) => {
    const current = old[i];
    if (!current) { live.append(node); return; }
    if (sameNode(current, node)) { if (node.nodeType === 1) adoptHandlers(current, node); return; }
    if (depth > 0 && current.nodeType === 1 && node.nodeType === 1 && current.tagName === node.tagName
      && sameAttributes(current, node) && !node.hasAttribute('data-keep')) {
      for (const name of HANDLERS) if (current[name] !== node[name]) current[name] = node[name] ?? null;
      patchChildren(current, node, depth - 1);
    }
    else current.replaceWith(node);
  });
  for (const extra of old.slice(next.length)) extra.remove();
}

/** A same-PC projector hello re-renders the console only when what the console shows about it changed. */
export function helloNeedsRender(before, after) {
  return before.needsCheck !== after.needsCheck || before.fallback !== after.fallback;
}
