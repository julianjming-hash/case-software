/** Render the bounded Case formatted-text shape with DOM construction only. */
export function renderFormattedText(doc, value, { validateFormattedText } = {}) {
  if (typeof validateFormattedText !== 'function') throw new TypeError('validateFormattedText is required');
  const issues = validateFormattedText(value);
  if (issues.length) throw Object.assign(new TypeError('formatted text is invalid'), { code: 'invalid_formatted_text', issues: structuredClone(issues) });
  const root = doc.createElement('div');
  for (const block of value.blocks) {
    if (block.type === 'paragraph') root.append(renderParagraph(doc, block.runs));
    else {
      const list = doc.createElement(block.ordered ? 'ol' : 'ul');
      for (const item of block.items) {
        const li = doc.createElement('li');
        appendRuns(doc, li, item.runs);
        list.append(li);
      }
      root.append(list);
    }
  }
  return root;
}

function renderParagraph(doc, runs) {
  const paragraph = doc.createElement('p');
  appendRuns(doc, paragraph, runs);
  return paragraph;
}

function appendRuns(doc, parent, runs) {
  for (const run of runs) {
    const text = doc.createTextNode(run.text);
    if (run.bold) {
      const strong = doc.createElement('strong');
      strong.append(text);
      parent.append(strong);
    } else parent.append(text);
  }
}
