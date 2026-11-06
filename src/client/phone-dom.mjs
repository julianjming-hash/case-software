import { setAuthoredText, isAuthoredFormat } from './authored-text.mjs';
// Text-only DOM construction shared by participant controls. Attributes and event listeners
// are supplied by application code; content always becomes a text node.
import { cleanText } from '../shared/text.mjs';
function build(doc, tag, props, kids) {
  const e = doc.createElement(/^(p|h[1-6])$/.test(tag) && isAuthoredFormat(props.text) ? 'div' : tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') setAuthoredText(e, v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  // A node from another document (a preview frame) is still a node: never turn it into text.
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node || typeof c?.nodeType === 'number' ? c : doc.createTextNode(cleanText(c)));
  return e;
}
export const h = (tag, props = {}, ...kids) => build(document, tag, props, kids);
/** The same builder over a given document (the phone renderer draws into a preview frame's document). */
export const domBuilder = doc => (tag, props = {}, ...kids) => build(doc, tag, props, kids);
