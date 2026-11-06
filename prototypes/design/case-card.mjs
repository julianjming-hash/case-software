// Study component only. Callers provide entitled summaries and destinations, never full case packs.
const node = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
};

/** One anatomy; variant follows the task. Selection is opt-in and independent of navigation/state. */
export function caseCard(item, { variant = 'vertical', purpose = 'browse', href, navigate, media, context, states = [], selection, heading = 'h2', dialog = false } = {}) {
  if (!['vertical', 'horizontal', 'panorama'].includes(variant)) throw new Error('unknown_card_variant');
  if (!['browse', 'draft'].includes(purpose)) throw new Error('unknown_card_purpose');
  const card = node('article', undefined, `case-tile case-tile-${variant}`);
  card.dataset.purpose = purpose;
  const open = node(dialog ? 'div' : 'a', undefined, 'case-tile-open card-open');
  if (!dialog) { open.href = href; open.setAttribute('aria-label', `Explore ${item.title}`); }
  if (navigate && !dialog) open.addEventListener('click', event => {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); navigate();
  });
  const illustration = node('div', undefined, 'case-tile-media'); illustration.setAttribute('aria-hidden', 'true');
  if (media) illustration.append(media);
  else illustration.append(node('span', 'CASE', 'case-tile-placeholder'));
  const copy = node('div', undefined, 'case-tile-copy');
  copy.append(node(heading, item.title, 'case-tile-title'));
  const metadata = node('ul', undefined, 'case-tile-meta');
  for (const fact of item.facts ?? []) metadata.append(node('li', fact));
  if (metadata.childElementCount) copy.append(metadata);
  if (item.cardSummary ?? item.summary) copy.append(node('p', item.cardSummary ?? item.summary, 'case-tile-summary'));
  if(media || purpose!=='draft')open.append(illustration);
  open.append(copy); card.append(open);
  if (states.length) {
    const indicators = node('div', undefined, 'case-tile-states');
    for (const state of states) {
      const label = node('span', state.label, 'case-tile-state');
      if (['ok', 'warn', 'private', 'muted'].includes(state.tone)) label.dataset.tone = state.tone;
      indicators.append(label);
    }
    // Teaching facts immediately follow the title; publication/check state follows those facts.
    if (purpose === 'draft' || variant==='horizontal') copy.append(indicators);
    else card.append(indicators);
  }
  if (context) { const slot = node('div', undefined, 'case-tile-context'); slot.append(context); if(purpose==='draft')copy.append(slot);else card.append(slot); }
  if (dialog) {
    const button = node('button', undefined, 'case-tile-dialog'); button.type = 'button';
    button.setAttribute('aria-label', `Open case: ${item.title}`); button.setAttribute('aria-haspopup', 'dialog');
    button.addEventListener('click', () => navigate?.()); card.append(button);
  }
  if (selection) {
    const label = node('label', undefined, 'case-tile-selection'), checkbox = node('input');
    checkbox.type = 'checkbox'; checkbox.checked = Boolean(selection.checked);
    checkbox.setAttribute('aria-label', `Select ${item.title} for comparison`);
    card.dataset.selected = String(checkbox.checked);
    checkbox.addEventListener('change', () => { card.dataset.selected = String(checkbox.checked); selection.change(checkbox.checked); });
    label.append(checkbox); card.append(label);
  }
  return card;
}
