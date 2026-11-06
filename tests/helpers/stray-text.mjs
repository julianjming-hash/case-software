// D26: a value that is not a node or a string must never reach the page as text. DOM insertion (append, replaceChildren)
// turns null into the text "null", so a dropped optional part shows up as a stray word. Run in the page.
export function strayText() {
  const found = [], walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (/^(null|undefined|NaN|\[object Object\])$/.test(node.data.trim())) found.push(`${node.parentElement?.tagName.toLowerCase()}${node.parentElement?.className ? `.${node.parentElement.className}` : ''}: ${node.data.trim()}`);
  }
  return found;
}
