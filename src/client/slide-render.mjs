// Typed slide render primitives (card 56, CASE-209/210). `slidePlan` is pure: it turns role-authorized blocks and one
// composition into a node plan. `buildSlide` turns a plan into DOM with text nodes only, from an allowlist of tags,
// attributes and classes. Callers pass only released blocks; nothing unreleased gets a node, a placement or a name.
import { CALLOUT_ICONS, paragraphsText } from '../shared/slide-text.mjs';
import { trendChart } from './slide-trend-render.mjs';
import { imageFigure } from './slide-image-render.mjs';
import { gasVisible, gasFlag, gasRange, gasTitle, gasColumns, gasCells, gasTyped, GAS_FLAG_MARK } from '../shared/slide-gas-view.mjs';

const TAGS = new Set(['figure', 'figcaption', 'img', 'video', 'section', 'div', 'p', 'strong', 'sub', 'sup', 'span', 'ul', 'ol', 'li', 'blockquote', 'aside', 'table', 'caption', 'colgroup', 'col', 'thead', 'tbody', 'tr', 'th', 'td', 'dl', 'dt', 'dd', 'h2', 'h3', 'h4', 'h5', 'h6']);
const ATTRIBUTES = new Set(['aria-label', 'aria-hidden', 'scope', 'colspan', 'role', 'alt', 'data-video-block', 'data-video-handle']);
// Trend charts (card 59 M1, CASE-263; slide-trend-render.mjs) draw as SVG built with the DOM, labels as text nodes.
// Callout icons (CASE-344, shared/icons.mjs) draw Lucide's own path, circle and rect nodes on its 24-unit grid.
const SVG_TAGS = new Set(['svg', 'line', 'polyline', 'polygon', 'circle', 'text', 'path', 'rect']);
const SVG_ATTRIBUTES = new Set(['viewBox', 'aria-hidden', 'focusable', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'points', 'cx', 'cy', 'r', 'text-anchor', 'd', 'width', 'height', 'rx', 'ry']);
// Callout icons (CASE-344) load on the first slide that draws one, as their own lazy chunk (shared/icons.mjs), so the room's
// slide chunks stay within their caps. The icon's box is sized by the stylesheet, so the fit pass measures it either way.
let icons = null, iconsLoading = null;
export const slideIcons = () => icons ? Promise.resolve(icons) : (iconsLoading ??= import('../shared/icons.mjs').then(module => (icons = module), () => { iconsLoading = null; return null; }));
// D23 hero (CASE-264, shared/slide-hero.mjs): text grows up to HERO_CAP; a question, table or chart keeps the full width.
export const HERO_CAP = 1.5;
const HERO_FULL = ['question', 'table', 'trend', 'gas'];
// It starts at HERO_CAP, in 5% steps never above its title, on the CASE-211 scale in cqw (projector.css, builder-slides.css).
const SCALE = { h1: 4.8, h2: 3.9, h3: 3.3, h4: 3 }, top = block => Math.max(2.75, ...(block?.type === 'text' ? block.paragraphs.map(item => SCALE[item.style] ?? 0) : []));
/** A hero card's width as a centred span of `n` (even) of the 12 columns, chosen by the room's fit pass (projector-slides);
 *  `justify` '' lets it hug its text again (the fit pass measures it so). */
export const heroColumns = (node, n, justify = 'stretch') => { node.dataset.heroCols = n; node.style.gridColumn = `${(12 - n) / 2 + 1} / span ${n}`; node.style.justifySelf = justify; };
const node = (tag, cls, children = [], extra = {}) => ({ tag, cls, children, ...extra });
const text = value => ({ text: String(value) });
// A run is text, optionally sub- or superscript (CASE-225), optionally bold around it.
const runs = list => (Array.isArray(list) ? list : []).map(run => { let part = text(run.text); if (run.script) part = node(run.script, null, [part]); return run.bold ? node('strong', null, [part]) : part; });
// A text colour shows only on a plain ground (CASE-244): on a fill, a soft background, banded rows or a callout the text
// stays the slide's ink, so every pair keeps 7:1 in every presentation theme and room (tests/design-gates.test.mjs).
// A whole-slide fill (CASE-312) is not the plain ground either, so on a filled slide text keeps the slide's ink.
export const inkShows = (style, type, filled = false) => !(filled || style.tone && style.tone !== 'plain' || style.background === 'soft' || style.banded || type === 'callout');

/**
 * @param {{blocks: object[], composition: object}} slide role-authorized blocks (released ones only) and their composition
 * @param {{layout?: 'grid'|'reflow', headingBase?: number, repeats?: string, hero?: object|null}} options reflow is chosen by the caller from the
 *   actual width; `repeats` is a heading the host already shows (the phone card's title), so a leading block that only
 *   repeats it is left out (CASE-222); `hero` is the slide's hero (D23, CASE-264): slideHero() of the full composition,
 *   or the public slide's own `hero` from the room
 */
export function slidePlan({ blocks, composition }, { layout = 'grid', headingBase: base = 2, repeats = '', media = null, hero: given = null } = {}) {
  // The host page owns h1; slide headings start at h2 or deeper.
  const headingBase = Math.max(2, Math.min(5, Number.isInteger(base) ? base : 2));
  const byId = new Map(blocks.map(block => [block.id, block]));
  const placements = new Map((composition.placements ?? []).map(placement => [placement.block_id, placement]));
  const styles = new Map((composition.styles ?? []).map(style => [style.block_id, style]));
  // Reading order decides DOM order (and so assistive technology and reflow); grid areas only move pixels.
  const ordered = (composition.reading_order ?? []).filter(id => byId.has(id));
  const unplaced = layout === 'grid' ? ordered.filter(id => !placements.has(id)) : [];
  const shown = layout === 'grid' ? ordered.filter(id => placements.has(id)) : ordered.slice();
  const firstHeading = shown.map(id => byId.get(id)).find(block => block.type === 'text' && block.paragraphs.some(item => item.style !== 'p'));
  const title = firstHeading ? paragraphsText(firstHeading.paragraphs.filter(item => item.style !== 'p').slice(0, 1)) : '';
  // D23 hero (CASE-264): grid only; phones and narrow reflow keep their own sizes.
  const hero = layout === 'grid' ? given : null;
  const lead = byId.get(shown[0]);
  if (repeats && lead?.type === 'text' && lead.paragraphs.every(item => item.style !== 'p') && paragraphsText(lead.paragraphs).trim() === repeats.trim()) shown.shift();
  const fill = typeof composition.fill === 'string' && /^[a-z]+$/.test(composition.fill) ? composition.fill : null;
  const children = shown.map(id => {
    const block = byId.get(id), s = styles.get(id) ?? {}, placement = placements.get(id);
    const cls = ['slide-block', `slide-${block.type}`, block.type === 'callout' && Object.hasOwn(block, 'icon') && 'slide-centred', s.tone && s.tone !== 'plain' && `slide-tone-${s.tone}`, s.ink && inkShows(s, block.type, Boolean(fill)) && `slide-ink-${s.ink}`,
      s.align && `slide-align-${s.align}`, s.padding && `slide-pad-${s.padding}`, s.background && `slide-bg-${s.background}`, s.banded && 'slide-banded',
      s.density && `slide-density-${s.density}`, s.text_size && `slide-text-${s.text_size}`,
      hero?.block_id === id && `slide-hero slide-hero-${hero.align}${HERO_FULL.includes(block.type) ? ' slide-hero-full' : ''}`, hero?.title_id === id && 'slide-hero-title'].filter(Boolean).join(' ');
    const area = layout !== 'grid' ? null : hero?.block_id === id ? `${hero.row} / 1 / span ${13 - hero.row} / span 12` : `${placement.row} / ${placement.col} / span ${placement.h} / span ${placement.w}`;
    const cap = hero?.block_id === id ? Math.max(1, Math.floor(Math.min(HERO_CAP, (hero.title_id ? top(byId.get(hero.title_id)) : 9) / top(block) / (s.text_size === 'large' ? 1.15 : 1)) * 20 + 1e-9) / 20) : null;
    return node('div', cls, blockChildren(block, { layout, headingBase, media, area }), { area, cap, slot: block.type === 'question' ? 'question' : null });
  });
  // A generic region name until a released authored heading exists; no hidden title ever names the slide.
  return { root: node('section', `slide-canvas slide-${layout}${fill ? ` slide-filled slide-fill-${fill}` : ''}`, children, { attrs: { 'aria-label': title || 'Slide' } }), unplaced, slots: shown.filter(id => byId.get(id).type === 'question'),
    hero: hero && byId.has(hero.block_id) ? hero : null };
}

function blockChildren(block, { layout, headingBase, media, area }) {
  if (block.type === 'text') return block.paragraphs.map(paragraph => paragraph.style === 'p'
    ? node('p', null, runs(paragraph.runs))
    : node(`h${Math.min(6, headingBase + Number(paragraph.style.slice(1)) - 1)}`, `slide-${paragraph.style}`, runs(paragraph.runs)));
  if (block.type === 'quote') return [node('blockquote', null, block.paragraphs.map(paragraph => node('p', null, runs(paragraph.runs))))];
  if (block.type === 'callout') {
    const paragraphs = block.paragraphs.map(paragraph => node('p', null, runs(paragraph.runs)));
    // CASE-344: a callout that carries `icon` is centred in its area, its icon (decorative; the text carries the meaning)
    // beside the text. A callout without the field draws as before, so published versions keep their look.
    if (!Object.hasOwn(block, 'icon')) return [node('aside', null, paragraphs)];
    // 'none', or a newer build's key this one does not know, draws no icon. buildSlide draws Lucide's own nodes into it.
    const drawn = block.icon !== 'none' && CALLOUT_ICONS.includes(block.icon);
    const icon = drawn ? [node('svg', 'slide-icon', [], { svg: { viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' }, icon: block.icon })] : [];
    return [node('aside', null, [...icon, node('div', 'slide-callout-text', paragraphs)])];
  }
  if (block.type === 'list') return [node(block.ordered ? 'ol' : 'ul', null, block.items.map(item => node('li', null, runs(item.runs))))];
  if (block.type === 'values') return [node('dl', null, block.rows.flatMap(row => [node('dt', null, [text(row.label)]),
    node('dd', null, [text(row.value), ...(row.unit ? [node('span', 'slide-unit', [text(row.unit)])] : [])])]))];
  if (block.type === 'timeline') return [node('ol', 'slide-timeline-list', block.entries.map(entry => node('li', null, [node('strong', null, [text(entry.label)]), text(' '), node('span', null, [text(entry.text)])])))];
  if (block.type === 'question') return [];
  if (block.type === 'trend') return trendChart(block, layout, area);
  if (block.type === 'image') return imageFigure(block, media);
  if (block.type === 'gas') return gasReport(block);
  if (block.type === 'table') return layout === 'reflow' ? tableCards(block) : [tableGrid(block)];
  // A block type this client does not know (a newer deploy's) draws nothing rather than stopping the slide (CASE-311).
  return [];
}

// A blood gas report (CASE-311) as one block, so the fit pass scales every group alike: a heading, then one small table per
// group that the stylesheet flows into columns on a wide slide and stacks on a phone. Only rows with a value are drawn;
// a flag is drawn from the row's own range, with its word for assistive technology.
const gasMark = flag => flag ? [node('span', null, [text(GAS_FLAG_MARK[flag])], { attrs: { 'aria-hidden': 'true' } }), node('span', 'sr-only', [text(flag === 'high' ? 'High: ' : 'Low: ')])] : [];
function gasReport(block) {
  if (gasColumns(block)) return gasCompare(block);
  const groups = gasVisible(block).map(group => node('table', 'slide-gas-table', [node('caption', null, [text(group.label)]), node('tbody', null, group.rows.map(row => {
    const flag = gasFlag(row);
    return node('tr', flag ? `slide-gas-${flag}` : null, [
      node('td', 'slide-gas-flag', gasMark(flag)),
      node('th', null, [text(row.label)], { attrs: { scope: 'row' } }),
      node('td', 'slide-gas-value', [text(row.value.trim())]),
      node('td', 'slide-unit', row.unit ? [text(row.unit)] : []),
      node('td', 'slide-gas-range', [text(gasRange(row))]),
    ]);
  }))]));
  return [node('p', 'slide-gas-title', [text(gasTitle(block))]), node('div', 'slide-gas-groups', groups)];
}
// Compare mode (CASE-317): ONE table, so each sample's column lines up down the whole printout. Its head names the unit, each
// sample oldest first (the newest tinted) and the range; each group is a body whose first row is its name. Every reading is
// flagged from the row's own range; a sample without one prints "–".
function gasCompare(block) {
  const columns = gasColumns(block), last = columns.length - 1, now = at => at === last ? ' slide-gas-now' : '';
  const head = node('thead', null, [node('tr', null, [node('td', null, []), node('th', 'slide-unit', [text('Unit')], { attrs: { scope: 'col' } }),
    ...columns.map((label, at) => node('th', `slide-gas-cell${now(at)}`, [text(label)], { attrs: { scope: 'col' } })),
    node('th', 'slide-gas-range', [text('Range')], { attrs: { scope: 'col' } })])]);
  const groups = gasVisible(block).map(group => node('tbody', null, [
    node('tr', 'slide-gas-group', [node('th', null, [text(group.label)], { attrs: { scope: 'rowgroup', colspan: String(columns.length + 3) } })]),
    ...group.rows.map(row => node('tr', null, [node('th', null, [text(row.label)], { attrs: { scope: 'row' } }), node('td', 'slide-unit', row.unit ? [text(row.unit)] : []),
      ...gasCells(block, row).map((value, at) => { const flag = gasFlag(row, value);
        return node('td', `slide-gas-cell${now(at)}${flag ? ` slide-gas-${flag}` : ''}`, gasTyped(value) ? [...gasMark(flag), text(value.trim())] : [text('–')]); }),
      node('td', 'slide-gas-range', [text(gasRange(row))])]))]));
  return [node('p', 'slide-gas-title', [text(gasTitle(block))]), node('div', 'slide-gas-compare', [node('table', null, [head, ...groups])])];
}

const columnName = (table, column, index) => table.header_row && column.label ? column.label : `Column ${index + 1}`;
const cellValue = (column, value) => [text(value), ...(column.unit && value !== '' ? [node('span', 'slide-unit', [text(column.unit)])] : [])];

function tableGrid(table) {
  const children = [];
  if (table.caption) children.push(node('caption', null, [text(table.caption)]));
  // Authored column widths (1–6 parts) reach every reader as shares of the table (BWR20, final audit P1).
  const parts = table.columns.map(c => c.width || 1), total = parts.reduce((a, b) => a + b);
  children.push(node('colgroup', null, parts.map(w => node('col', null, [], { w: 100 * w / total }))));
  if (table.header_row) children.push(node('thead', null, [node('tr', null, table.columns.map(column => node('th', `slide-${column.align}`, [text(column.label), ...(column.unit ? [node('span', 'slide-unit', [text(column.unit)])] : [])], { attrs: { scope: 'col' } })))]));
  children.push(node('tbody', null, table.rows.map(row => node('tr', null, row.cells.map((value, index) => {
    const column = table.columns[index], heading = table.first_column_header && index === 0;
    return node(heading ? 'th' : 'td', `slide-${column.align}`, cellValue(column, value), heading ? { attrs: { scope: 'row' } } : {});
  })))));
  return node('table', 'slide-table-grid', children, table.caption ? {} : { attrs: { 'aria-label': 'Table' } });
}

// Narrow reflow (BWR20): one labelled card per row, every cell and unit kept in authored order, blanks included.
function tableCards(table) {
  const titleColumn = table.first_column_header ? 0 : -1;
  const cards = table.rows.map(row => node('li', 'slide-table-card', [
    ...(titleColumn === 0 ? [node('strong', null, cellValue(table.columns[0], row.cells[0]))] : []),
    node('dl', null, row.cells.flatMap((value, index) => index === titleColumn ? [] : [node('dt', null, [text(columnName(table, table.columns[index], index))]), node('dd', null, cellValue(table.columns[index], value))])),
  ]));
  return [...(table.caption ? [node('p', 'slide-table-caption', [text(table.caption)])] : []), node('ul', 'slide-table-cards', cards, { attrs: { 'aria-label': table.caption || 'Table' } })];
}

/** Draw a callout icon's nodes into its svg, now when the icons are loaded, else once they arrive (decorative only). */
function drawIcon(doc, element, key) {
  const paint = module => {
    const nodes = module?.iconNodes(key);
    if (!nodes || element.childNodes?.length || element.children?.length) return;
    for (const [tag, attrs] of nodes) {
      if (!SVG_TAGS.has(tag)) throw new TypeError('slide_tag');
      const child = doc.createElementNS('http://www.w3.org/2000/svg', tag);
      for (const [name, value] of Object.entries(attrs)) { if (!SVG_ATTRIBUTES.has(name)) throw new TypeError('slide_attribute'); child.setAttribute(name, value); }
      element.append(child);
    }
  };
  if (icons) paint(icons); else slideIcons().then(paint);
}

/** Build DOM from a plan: text nodes only, allowlisted tags/attributes/classes; returns the root and question slots. */
export function buildSlide(doc, plan) {
  const slots = [];
  const make = item => {
    if (Object.hasOwn(item, 'text')) return doc.createTextNode(item.text);
    const svg = Boolean(item.svg);
    if (!(svg ? SVG_TAGS : TAGS).has(item.tag)) throw new TypeError('slide_tag');
    const element = svg ? doc.createElementNS('http://www.w3.org/2000/svg', item.tag) : doc.createElement(item.tag);
    if (item.cls) { if (!/^[a-z0-9 -]+$/.test(item.cls)) throw new TypeError('slide_class'); element.setAttribute('class', item.cls); }
    for (const [name, value] of Object.entries(item.svg ?? {})) { if (!SVG_ATTRIBUTES.has(name)) throw new TypeError('slide_attribute'); element.setAttribute(name, typeof value === 'number' ? String(Math.round(value * 10) / 10) : value); }
    for (const [name, value] of Object.entries(item.attrs ?? {})) { if (!ATTRIBUTES.has(name)) throw new TypeError('slide_attribute'); element.setAttribute(name, value); }
    // An image or video source (and a video's poster) is only ever a browser-local blob: handle (urls.mjs mediaObjectUrl),
    // never a network address. A video plays inline, preloaded; only a phone's has its own controls (card 59 M3).
    const blob = value => typeof value === 'string' && value.startsWith('blob:');
    if (item.src !== undefined) { if (!['img', 'video'].includes(item.tag) || !blob(item.src)) throw new TypeError('slide_source'); element.src = item.src; }
    if (item.poster !== undefined) { if (item.tag !== 'video' || !blob(item.poster)) throw new TypeError('slide_source'); element.poster = item.poster; }
    if (item.tag === 'video') { element.playsInline = true; element.setAttribute('playsinline', ''); element.preload = 'auto'; element.controls = Boolean(item.video?.controls); }
    if (item.size) { element.width = item.size[0]; element.height = item.size[1]; }
    if (item.area) element.style.gridArea = item.area;
    if (item.cap) element.dataset.heroCap = item.cap;
    if (item.w) element.style.width = item.w + '%';
    if (item.slot) slots.push(element);
    if (item.icon !== undefined) { if (item.tag !== 'svg' || !CALLOUT_ICONS.includes(item.icon)) throw new TypeError('slide_icon'); drawIcon(doc, element, item.icon); }
    for (const child of item.children ?? []) element.append(make(child));
    return element;
  };
  return { root: make(plan.root), slots };
}

