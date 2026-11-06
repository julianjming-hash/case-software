// The "/" menu of a new block (CASE-344; prototypes/builder-simplify.html). A pure catalogue and matcher: the query a
// facilitator types after "/" lives in the editor's own state and never reaches the draft, the autosave or the undo stack.
export const SLASH_GROUPS = Object.freeze(['Blood gas', 'Text', 'Callout', 'Table', 'Values', 'Chart', 'Image']);

// Each entry is what the new block starts as: `kind` is a slide-edit addBlock kind (a heading is a text block starting as
// a heading), `recipe` and `sample` its starters, `ordered` a numbered list, `tone` and `icon` a callout's, `picture` an
// image (it needs a workspace image chosen first, so the menu opens the chooser instead of making an empty block).
export const SLASH = Object.freeze([
  { name: 'Arterial blood gas', group: 'Blood gas', tag: 'ABG', kind: 'gas', sample: 'arterial' },
  { name: 'Venous blood gas', group: 'Blood gas', tag: 'VBG', kind: 'gas', sample: 'venous' },
  { name: 'Heading', group: 'Text', kind: 'heading' },
  { name: 'Paragraph', group: 'Text', kind: 'text' },
  { name: 'Bulleted list', group: 'Text', kind: 'list' },
  { name: 'Numbered list', group: 'Text', kind: 'list', ordered: true },
  { name: 'Note', group: 'Callout', kind: 'callout', tone: 'blue', icon: 'info' },
  { name: 'Warning', group: 'Callout', kind: 'callout', tone: 'amber', icon: 'alert' },
  { name: 'Danger', group: 'Callout', kind: 'callout', tone: 'coral', icon: 'stop' },
  { name: 'Quote', group: 'Callout', kind: 'callout', tone: 'plain', icon: 'quote' },
  { name: 'Blank table', group: 'Table', kind: 'table', recipe: 'blank' },
  { name: 'Observations', group: 'Table', kind: 'table', recipe: 'observations' },
  { name: 'Investigations', group: 'Table', kind: 'table', recipe: 'investigations' },
  { name: 'Comparison', group: 'Table', kind: 'table', recipe: 'comparison' },
  { name: 'Timeline table', group: 'Table', kind: 'table', recipe: 'timeline' },
  { name: 'Values', group: 'Values', kind: 'values' },
  { name: 'Timeline', group: 'Values', kind: 'timeline' },
  { name: 'Trend chart', group: 'Chart', kind: 'trend' },
  { name: 'Image', group: 'Image', kind: 'image', picture: 'image' },
  { name: 'ECG', group: 'Image', kind: 'image', picture: 'ecg' },
  { name: 'Video or GIF', group: 'Image', kind: 'image', picture: 'moving' },
]);

const words = text => String(text ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * The entries a query matches, grouped in the menu's order. A query matches by the start of any word of the entry's name,
 * group or tag, so "/ab" puts Arterial blood gas first and "/ti" finds Timeline and Timeline table. Blank lists them all.
 */
export function slashMatches(query, entries = SLASH) {
  const q = String(query ?? '').trim().toLowerCase();
  const found = entries.filter(entry => !q || [...words(entry.name), ...words(entry.group), ...words(entry.tag)].some(word => word.startsWith(q))
    || `${entry.name} ${entry.tag ?? ''}`.toLowerCase().replace(/\s+/g, ' ').startsWith(q));
  const rank = entry => { const word = [...words(entry.name), ...words(entry.tag)]; return q && word.some(w => w.startsWith(q)) ? 0 : 1; };
  return found.map((entry, at) => ({ entry, at })).sort((a, b) => SLASH_GROUPS.indexOf(a.entry.group) - SLASH_GROUPS.indexOf(b.entry.group) || rank(a.entry) - rank(b.entry) || a.at - b.at).map(item => item.entry);
}

/** The text the menu reads its query from: a new block's text when it starts with "/", else null (it is plain writing). */
export function slashQuery(text) {
  return typeof text === 'string' && text.startsWith('/') ? text.slice(1) : null;
}
