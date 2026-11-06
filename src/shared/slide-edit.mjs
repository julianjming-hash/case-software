// Pure schema-3 authoring operations (card 51). Each takes the canonical document and returns a new one, or a refusal
// with a reason and no change. Blocks, steps, rows and columns are addressed by identity, never by array position.
// Validation (slide-document.mjs) runs at the studio's commit boundary; nothing here repairs or trims content.
import { CALLOUT_ICONS, CALLOUT_ICON_CAPABILITY, CALLOUT_TONES, SLIDE_LIMITS, SLIDE_GRID, paragraphsText } from './slide-document.mjs';
import { TREND_SCALES, TREND_STYLES } from './slide-trend.mjs';
import { ECG_SPEEDS, ECG_GAINS, ECG_LAYOUTS, IMAGE_FITS } from './slide-image.mjs';
import { INK_TONES } from './slide-text.mjs';
import { SLIDE_THEMES } from './slide-themes.mjs';
import { HERO_SETTINGS } from './slide-hero.mjs';
import { gasStarter, gasCells, gasTyped, GAS_SAMPLES, GAS_LIMITS } from './slide-gas.mjs';
import { SLIDE_FILLS } from './slide-text.mjs';

const refuse = reason => ({ ok: false, reason });
const done = document => ({ ok: true, document });
const byId = (list, id) => (Array.isArray(list) ? list : []).find(item => item?.id === id) ?? null;
/** A new document whose block `blockId` alone is a fresh copy (null when absent); the rest is shared, never changed. */
function ownBlock(document, blockId) {
  const blocks = Array.isArray(document?.blocks) ? [...document.blocks] : [], at = blocks.findIndex(item => item?.id === blockId);
  if (at >= 0) blocks[at] = structuredClone(blocks[at]);
  return { next: { ...document, blocks }, block: blocks[at] ?? null };
}
function edit(document, compositionId, change) {
  const next = structuredClone(document), composition = byId(next.compositions, compositionId);
  if (!composition) return refuse('This slide no longer exists.');
  return change(next, composition) ?? done(next);
}
const usesOf = (document, blockId) => document.compositions.filter(item => item.reading_order.includes(blockId));
const isHeading = block => block?.type === 'text' && block.paragraphs.some(item => item.style !== 'p');

// Template slots: [role, col, row, w, h]. Applying one moves placements only; content, steps and reading order stay.
export const TEMPLATES = Object.freeze({
  bento: [['title', 1, 1, 12, 2], ['main', 1, 3, 7, 10], ['side', 8, 3, 5, 5], ['side', 8, 8, 5, 5]],
  story: [['title', 1, 1, 12, 2], ['main', 1, 3, 12, 5], ['main', 1, 8, 12, 5]],
  columns: [['title', 1, 1, 12, 2], ['main', 1, 3, 6, 10], ['main', 7, 3, 6, 10]],
  title_text: [['title', 1, 1, 12, 2], ['main', 1, 3, 12, 10]],
  blank: [],
});

/** The case's presentation theme (CASE-227): one for every slide; 'case' removes the choice (the room's own look). */
export function setTheme(document, theme) {
  if (!Object.hasOwn(SLIDE_THEMES, theme)) return refuse('Unknown theme.');
  const next = structuredClone(document);
  if (theme === 'case') delete next.theme; else next.theme = theme;
  return done(next);
}

/** D23 hero (CASE-264): 'off', 'centred', or null for the default (shown large, at the top). */
export function setHero(document, compositionId, value) {
  if (value !== null && !HERO_SETTINGS.includes(value)) return refuse('Unknown setting.');
  return edit(document, compositionId, (next, composition) => { if (value === null) delete composition.hero; else composition.hero = value; });
}

/** A whole-slide fill (CASE-312): one of the slide tones, or null for the plain ground. */
export function setFill(document, compositionId, value) {
  if (value !== null && !SLIDE_FILLS.includes(value)) return refuse('Unknown fill.');
  return edit(document, compositionId, (next, composition) => { if (value === null) delete composition.fill; else composition.fill = value; });
}

/** Re-lay a slide on a template. Blocks are matched by role in reading order; extras stay visibly unplaced. */
export function applyTemplate(document, compositionId, template) {
  if (!Object.hasOwn(TEMPLATES, template)) return refuse('Unknown template.');
  return edit(document, compositionId, (next, composition) => {
    const blocks = composition.reading_order.map(id => byId(next.blocks, id)).filter(Boolean), slots = TEMPLATES[template].map(([role, col, row, w, h]) => ({ role, col, row, w, h }));
    const take = predicate => { const index = slots.findIndex(predicate); return index < 0 ? null : slots.splice(index, 1)[0]; };
    const placements = [], waiting = [];
    // A heading block takes the title slot and a question prefers a side slot; everything else fills in reading order.
    const title = blocks.find(isHeading);
    for (const block of blocks) {
      const slot = block === title ? take(item => item.role === 'title') : block.type === 'question' ? take(item => item.role === 'side') ?? take(item => item.role !== 'title') : null;
      if (slot) placements.push({ block_id: block.id, col: slot.col, row: slot.row, w: slot.w, h: slot.h }); else waiting.push(block);
    }
    for (const block of waiting) {
      const slot = take(item => item.role !== 'title') ?? (title ? null : take(() => true));
      if (slot) placements.push({ block_id: block.id, col: slot.col, row: slot.row, w: slot.w, h: slot.h });
    }
    composition.template = template;
    composition.placements = placements;
  });
}

const STARTERS = {
  text: () => ({ paragraphs: [{ style: 'p', runs: [{ text: '' }] }] }),
  heading: () => ({ type: 'text', paragraphs: [{ style: 'h2', runs: [{ text: '' }] }] }),
  list: () => ({ ordered: false, items: [{ runs: [{ text: '' }] }] }),
  quote: () => ({ paragraphs: [{ runs: [{ text: '' }] }] }),
  callout: () => ({ paragraphs: [{ runs: [{ text: '' }] }] }),
  values: createId => ({ rows: [{ id: createId(), label: '', value: '', unit: '' }] }),
  timeline: createId => ({ entries: [{ id: createId(), label: '', text: '' }] }),
  // A trend starts with labels and room for two readings; it never invents a value, an axis bound or a series name.
  trend: createId => ({ caption: '', x_label: 'Time', x_unit: 'h', y_label: '', y_unit: '', y_min: '', y_max: '', scale: 'time', style: 'line', values_shown: true,
    points: [{ id: createId(), label: '', at: '' }, { id: createId(), label: '', at: '' }], series: [{ id: createId(), label: '', values: ['', ''] }] }),
};
// Table recipes carry visible labels and units columns only; they never invent clinical values or reference ranges.
export const TABLE_RECIPES = Object.freeze({
  blank: ['', ''], observations: ['Time', 'Observation', 'Value', 'Unit'], investigations: ['Test', 'Result', 'Unit', 'Reference'],
  timeline: ['Time', 'Event'], comparison: ['Feature', 'Option A', 'Option B'],
});
// Starter column widths in parts (1–6) so each recipe's widest column has room from the start (final audit, round 15).
const RECIPE_WIDTHS = Object.freeze({ blank: [1, 1], observations: [1, 2, 1, 1], investigations: [2, 1, 1, 2], timeline: [1, 4], comparison: [2, 2, 2] });
const starterWidth = (recipe, index) => RECIPE_WIDTHS[recipe]?.[index] ?? (index ? 1 : 2);

/**
 * A full slide makes room by sharing its largest block's area (round 15–16, CASE-239/241): half of it, split along its
 * longer visible side. Undo restores both. Null when nothing can split.
 */
/** Most content (serialised characters per grid cell) a block may hold once halved; above it the text would shrink. */
const SPARE_LOAD = 8;

/**
 * Where a full slide makes room for a new block (round 19): the block with the most room for its content gives up half
 * its area along its longer side, so dense text is never squeezed while a roomy or near-empty block has space to spare.
 * The new block's half must be at least `min` × `min`. With no such block the new block waits unplaced, where the slide
 * offers to place it or choose a layout with more room, instead of squeezing what is there (round 20).
 */
function splitRoomiest(placements, blocks, minW = 3, minH = 3) {
  // A question needs its slot for options and results, and dense text would shrink, so neither gives up area (round 20).
  const load = id => { const block = blocks.find(item => item.id === id); if (!block) return 0;
    const body = block.paragraphs ?? block.items ?? block.rows ?? block.entries ?? null;
    return block.type === 'question' ? Infinity : body ? JSON.stringify(body).length : 50; };
  // Both ways of halving a block are offered, the longer side first, so a wide table can take the bottom half of a
  // full-width block when the right half would be too narrow for it (round 22).
  const halves = item => {
    const down = () => { const h = Math.floor(item.h / 2); return { keep: { h: item.h - h }, share: { col: item.col, row: item.row + item.h - h, w: item.w, h } }; };
    const across = () => { const w = Math.floor(item.w / 2); return { keep: { w: item.w - w }, share: { col: item.col + item.w - w, row: item.row, w, h: item.h } }; };
    const tall = item.h >= 2 && (item.w < 2 || item.h * 9 > item.w * 16);
    return [tall ? down() : across(), tall ? (item.w >= 2 ? across() : null) : (item.h >= 2 ? down() : null)].filter(Boolean);
  };
  const options = placements.filter(item => item.h >= 2 || item.w >= 2).flatMap(item => halves(item).map((half, order) => ({ item, ...half, order, density: load(item.block_id) / (item.w * item.h) })))
    .filter(option => option.share.w >= minW && option.share.h >= minH && load(option.item.block_id) / ((option.keep.w ?? option.item.w) * (option.keep.h ?? option.item.h)) <= SPARE_LOAD)
    .sort((a, b) => a.density - b.density || b.item.w * b.item.h - a.item.w * a.item.h || a.order - b.order);
  if (!options.length) return null;
  const [best] = options; Object.assign(best.item, best.keep); return best.share;
}

/**
 * Room for a block (round 21; sized by blockNeeds, round 22): a free whole-width band, else the largest free area of at
 * least `minW` columns × `minH` rows (shorter or narrower than the starter if that is what is free), else half of a block with room
 * to spare. Null when the slide is truly full; adding and placing share it, so the palette and the tray agree.
 */
/**
 * The room a block needs to read on the projector (round 22): its starter height and the smallest area it may take.
 * A table needs two grid columns per table column and three rows; a question its full slot; text two rows, a heading one.
 */
export function blockNeeds(block) {
  if (block?.type === 'table') return { height: 4, minW: Math.min(SLIDE_GRID, Math.max(4, 2 * (block.columns?.length ?? 2))), minH: 3 };
  if (block?.type === 'question') return { height: 4, minW: 4, minH: 4 };
  if (block?.type === 'values' || block?.type === 'timeline') return { height: 3, minW: 4, minH: 2 };
  if (block?.type === 'trend') return { height: 6, minW: 5, minH: 4 };
  if (block?.type === 'image') return { height: 7, minW: 4, minH: 3 };
  if (block?.type === 'gas') return { height: 9, minW: 6, minH: 4 };
  const heading = block?.type === 'text' && block.paragraphs?.length && block.paragraphs.every(item => /^h[1-3]$/.test(item?.style ?? ''));
  return { height: heading ? 2 : 3, minW: 3, minH: heading ? 1 : 2 };
}

export function findRoom(placements, blocks, need) {
  const { height, minW, minH } = need;
  const band = freeBand(placements, height);
  if (band) return { col: 1, row: band, w: SLIDE_GRID, h: height };
  let best = null;
  for (let row = 1; row <= SLIDE_GRID; row++) for (let col = 1; col <= SLIDE_GRID; col++) {
    for (let h = Math.min(height, SLIDE_GRID - row + 1); h >= minH; h--) for (let w = SLIDE_GRID - col + 1; w >= minW; w--) {
      const cell = { col, row, w, h };
      if (best && w * h <= best.w * best.h) break;
      if (!placements.some(item => overlaps(item, cell))) { best = cell; break; }
    }
  }
  return best ?? splitRoomiest(placements, blocks, Math.max(3, minW), Math.max(3, minH));
}

/** A free whole-width band of `height` rows, or null when the grid is full (the new block then stays unplaced). */
function freeBand(placements, height) {
  const taken = new Set(placements.flatMap(item => Array.from({ length: item.h }, (_, dy) => item.row + dy)));
  for (let row = 1; row + height - 1 <= SLIDE_GRID; row++) if (Array.from({ length: height }, (_, dy) => row + dy).every(r => !taken.has(r))) return row;
  return null;
}

/** Add a block as a new last reveal step, placed in the first free band or left visibly unplaced. */
/** The first free w × h area on the 12 × 12 grid, row by row, or null when none is left. */
export function freeSpace(placements, w, h) {
  for (let row = 1; row + h - 1 <= SLIDE_GRID; row++) for (let col = 1; col + w - 1 <= SLIDE_GRID; col++) {
    const cell = { col, row, w, h };
    if (!placements.some(item => overlaps(item, cell))) return cell;
  }
  return null;
}

/**
 * Teaching presets (BWR17): a few existing primitives assembled in one transaction and one new reveal step. They carry
 * structure and visible labels only, never clinical values.
 */
export const PRESETS = Object.freeze({
  handover: { label: 'Handover', parts: [['heading', 'Handover'], ['text', null], ['values', null]] },
  investigations: { label: 'Investigation panel', parts: [['heading', 'Investigations'], ['table', 'investigations']] },
  comparison: { label: 'Comparison', parts: [['heading', 'Comparison'], ['table', 'comparison']] },
  debrief: { label: 'Debrief', parts: [['heading', 'Debrief'], ['list', null]] },
});
export function addPreset(document, compositionId, preset, createId) {
  if (!Object.hasOwn(PRESETS, preset)) return refuse('Unknown preset.');
  return edit(document, compositionId, (next, composition) => {
    const parts = PRESETS[preset].parts;
    if (composition.reading_order.length + parts.length > SLIDE_LIMITS.compositionBlocks) return refuse(`A slide holds at most ${SLIDE_LIMITS.compositionBlocks} blocks.`);
    const step = { id: createId(), block_ids: [] };
    for (const [kind, extra] of parts) {
      let block;
      if (kind === 'table') { const columns = TABLE_RECIPES[extra].map((label, index) => ({ id: createId(), label, width: starterWidth(extra, index), align: 'start' })); block = { id: createId(), type: 'table', header_row: true, first_column_header: false, columns, rows: [{ id: createId(), cells: columns.map(() => '') }] }; }
      else if (kind === 'heading') block = { id: createId(), type: 'text', paragraphs: [{ style: 'h2', runs: [{ text: extra }] }] };
      else block = { id: createId(), type: kind, ...STARTERS[kind](createId) };
      next.blocks.push(block); step.block_ids.push(block.id); composition.reading_order.push(block.id);
      const height = kind === 'heading' ? 2 : kind === 'table' ? 4 : 3, row = freeBand(composition.placements, height);
      if (row) composition.placements.push({ block_id: block.id, col: 1, row, w: SLIDE_GRID, h: height });
    }
    composition.steps.push(step);
    return { ok: true, document: next, blockId: step.block_ids[0] };
  });
}

/** Swap an empty table to another starter's columns; a table with any value, caption or edited label refuses. */
export function applyTableRecipe(document, blockId, recipe, createId) {
  if (!Object.hasOwn(TABLE_RECIPES, recipe)) return refuse('Unknown table starter.');
  const next = structuredClone(document), table = byId(next.blocks, blockId);
  if (table?.type !== 'table') return refuse('Only a table has a starter.');
  const known = Object.values(TABLE_RECIPES).some(labels => labels.join('|') === table.columns.map(column => column.label).join('|'));
  if (table.caption || table.rows.some(row => row.cells.some(Boolean)) || !known) return refuse('Use a starter while the table is empty. Existing labels and values are kept.');
  table.columns = TABLE_RECIPES[recipe].map((label, index) => ({ id: createId(), label, width: starterWidth(recipe, index), align: 'start' }));
  table.header_row = true;
  table.rows = table.rows.map(row => ({ id: row.id, cells: table.columns.map(() => '') }));
  return done(next);
}

/**
 * A new block of `kind` for this slide (its starter content, fresh identities), or a refusal reason. A question binds the
 * slide's decision once; an image names one workspace image; a blood gas starts with every standard row and no value.
 */
function makeBlock(next, composition, kind, createId, { recipe = 'observations', decisionId = null, image = null, sample = 'arterial' } = {}) {
  // A decision's own slide can put its question back (re-audit #13); the block holds only the decision's id.
  if (kind === 'question') {
    if (!byId(next.decisions, decisionId)) return { reason: 'Only a decision’s slide shows its question.' };
    if (composition.reading_order.some(id => { const item = byId(next.blocks, id); return item?.type === 'question' && item.decision_id === decisionId; })) return { reason: 'The question is already on this slide.' };
    return { block: { id: createId(), type: 'question', decision_id: decisionId } };
  }
  if (kind === 'table') {
    if (!Object.hasOwn(TABLE_RECIPES, recipe)) return { reason: 'Unknown table recipe.' };
    const labels = TABLE_RECIPES[recipe], columns = labels.map((label, index) => ({ id: createId(), label, width: starterWidth(recipe, index), align: 'start' }));
    return { block: { id: createId(), type: 'table', header_row: true, first_column_header: false, columns, rows: [{ id: createId(), cells: columns.map(() => '') }] } };
  }
  if (kind === 'image') {
    // An image block names one workspace image; its alt text starts as the image's own description (card 59 M2).
    if (!image || typeof image.assetId !== 'string' || typeof image.alt !== 'string') return { reason: 'Choose an image first.' };
    return { block: { id: createId(), type: 'image', asset_id: image.assetId, alt: image.alt, caption: '', fit: 'contain', ecg: image.ecg ? { speed: '25', gain: '10', layout: '12-lead' } : null } };
  }
  if (kind === 'gas') {
    // A blood gas (CASE-311) starts with every standard row, its unit and an editable adult range, and no values.
    if (!Object.hasOwn(GAS_SAMPLES, sample)) return { reason: 'Unknown sample.' };
    return { block: { id: createId(), type: 'gas', ...gasStarter(sample, createId) } };
  }
  if (kind === 'heading') return { block: { id: createId(), ...STARTERS.heading() } };
  if (Object.hasOwn(STARTERS, kind)) return { block: { id: createId(), type: kind, ...STARTERS[kind](createId) } };
  return { reason: 'That block type is not available yet.' };
}

/** Add a block as its own new reveal step. `at` places it in that free area; otherwise the first free full-width band. */
export function addBlock(document, compositionId, kind, createId, { recipe = 'observations', at = null, decisionId = null, image = null, sample = 'arterial' } = {}) {
  return edit(document, compositionId, (next, composition) => {
    if (composition.reading_order.length >= SLIDE_LIMITS.compositionBlocks) return refuse(`A slide holds at most ${SLIDE_LIMITS.compositionBlocks} blocks.`);
    const { block, reason } = makeBlock(next, composition, kind, createId, { recipe, decisionId, image, sample });
    if (!block) return refuse(reason);
    if (block.type === 'callout') { block.icon = 'none'; withCalloutIcons(next); }
    next.blocks.push(block);
    composition.steps.push({ id: createId(), block_ids: [block.id] });
    composition.reading_order.push(block.id);
    const inside = at && [at.col, at.row, at.w, at.h].every(Number.isInteger) && at.col >= 1 && at.row >= 1 && at.col + at.w - 1 <= SLIDE_GRID && at.row + at.h - 1 <= SLIDE_GRID;
    if (inside && !composition.placements.some(item => overlaps(item, at))) composition.placements.push({ block_id: block.id, col: at.col, row: at.row, w: at.w, h: at.h });
    else { const room = findRoom(composition.placements, next.blocks, blockNeeds(block)); if (room) composition.placements.push({ block_id: block.id, ...room }); }
    return { ok: true, document: next, blockId: block.id, unplaced: !composition.placements.some(item => item.block_id === block.id) };
  });
}

/** Remove a block from this slide; shared content stays for its other uses. A question keeps its decision binding. */
export function removeBlock(document, compositionId, blockId) {
  return edit(document, compositionId, (next, composition) => {
    const block = byId(next.blocks, blockId);
    if (!block || !composition.reading_order.includes(blockId)) return refuse('That block is not on this slide.');
    // On a clarification's slide the question is optional (D15): it can go, and the open question is drawn beside it.
    if (block.type === 'question' && composition.owner?.kind !== 'clarification') return refuse('The question is bound to this stage\'s decision and cannot be removed here.');
    for (const step of composition.steps) step.block_ids = step.block_ids.filter(id => id !== blockId);
    composition.reading_order = composition.reading_order.filter(id => id !== blockId);
    composition.placements = composition.placements.filter(item => item.block_id !== blockId);
    composition.styles = (composition.styles ?? []).filter(item => item.block_id !== blockId);
    if (!usesOf(next, blockId).length) next.blocks = next.blocks.filter(item => item.id !== blockId);
  });
}

/** Block order: move a block to another step (by id) or into a new last step. Placement is untouched. */
export function moveBlockToStep(document, compositionId, blockId, target, createId) {
  return edit(document, compositionId, (next, composition) => {
    const from = composition.steps.find(step => step.block_ids.includes(blockId));
    if (!from) return refuse('That block is not on this slide.');
    // 'new' appends a last step; 'own' splits the block into a new step right after the one it leaves.
    if (target === 'own' && from.block_ids.length === 1) return refuse('The block already has a step of its own.');
    const fresh = target === 'new' || target === 'own', to = fresh ? { id: createId(), block_ids: [] } : composition.steps.find(step => step.id === target);
    if (!to) return refuse('That step no longer exists.');
    if (to === from) return refuse('The block is already in that step.');
    from.block_ids = from.block_ids.filter(id => id !== blockId);
    if (target === 'new') composition.steps.push(to);
    if (target === 'own') composition.steps.splice(composition.steps.indexOf(from) + 1, 0, to);
    to.block_ids.push(blockId);
    // A later step left empty by the move is removed; On entry always remains.
    if (!from.block_ids.length && composition.steps.indexOf(from) > 0) composition.steps = composition.steps.filter(step => step !== from);
  });
}

/** Move a whole step earlier or later; every block in it keeps its membership and placement. */
export function moveStep(document, compositionId, stepId, delta) {
  return edit(document, compositionId, (next, composition) => {
    const index = composition.steps.findIndex(step => step.id === stepId), target = index + delta;
    if (index < 0) return refuse('That step no longer exists.');
    if (target < 0 || target >= composition.steps.length) return refuse(delta < 0 ? 'This step is already first.' : 'This step is already last.');
    // Remove and insert, so a drag several steps away keeps every other step's order (a one-step move is a swap).
    composition.steps.splice(target, 0, composition.steps.splice(index, 1)[0]);
  });
}

/** Semantic reading order for phones and assistive technology, independent of placement and reveal. */
export function moveInReadingOrder(document, compositionId, blockId, delta) {
  return edit(document, compositionId, (next, composition) => {
    const order = composition.reading_order, index = order.indexOf(blockId), target = index + delta;
    if (index < 0) return refuse('That block is not on this slide.');
    if (target < 0 || target >= order.length) return refuse('The block is already at that end.');
    [order[index], order[target]] = [order[target], order[index]];
  });
}

/** Callout tone is presentation local to this slide; it never implies clinical or private meaning. */
// The first value of each list is the default, stored as an absent key (CASE-220 adds background and table presentation).
// CASE-225: every block can take a fill (tone) and a text colour (ink); the first value of each list is the default.
const STYLE_VALUES = Object.freeze({ tone: Object.keys(CALLOUT_TONES), ink: ['plain', ...INK_TONES], align: ['start', 'center', 'end'], padding: ['none', 'normal', 'roomy'], background: ['plain', 'soft', 'outline'],
  banded: [false, true], density: ['normal', 'compact', 'roomy'], text_size: ['normal', 'large'] });
const TABLE_STYLES = new Set(['banded', 'density', 'text_size']);
/** A block that stops being a table keeps its fill and text colour but sheds the table-only presentation (BWR20). */
const shedTableStyles = (next, blockId) => { for (const composition of next.compositions) for (const style of composition.styles ?? []) if (style.block_id === blockId) for (const key of TABLE_STYLES) delete style[key]; };
/** Set a block's alignment or spacing on this slide; the default value (start, none) removes the key. */
export function setBlockStyle(document, compositionId, blockId, key, value) {
  if (!Object.hasOwn(STYLE_VALUES, key) || !STYLE_VALUES[key].includes(value)) return refuse('Unknown block style.');
  return edit(document, compositionId, (next, composition) => {
    if (!composition.reading_order.includes(blockId)) return refuse('That block is not on this slide.');
    if (TABLE_STYLES.has(key) && byId(next.blocks, blockId)?.type !== 'table') return refuse('That setting applies to tables only.');
    composition.styles ??= [];
    let style = composition.styles.find(item => item.block_id === blockId);
    if (!style) composition.styles.push(style = { block_id: blockId });
    if (value === STYLE_VALUES[key][0]) delete style[key]; else style[key] = value;
    if (Object.keys(style).length === 1) composition.styles = composition.styles.filter(item => item !== style);
  });
}

/**
 * Duplicate a block as an independent copy: fresh identities for the block and every row, column and entry, its own new
 * last step, the same size in free space (else unplaced) and the same local style. A question binds its decision and
 * is never copied (that would be a second active decision).
 */
export function duplicateBlock(document, compositionId, blockId, createId) {
  return edit(document, compositionId, (next, composition) => {
    const source = byId(next.blocks, blockId);
    if (!source || !composition.reading_order.includes(blockId)) return refuse('That block is not on this slide.');
    if (source.type === 'question') return refuse('A question shows its decision; it cannot be copied.');
    if (composition.reading_order.length >= SLIDE_LIMITS.compositionBlocks) return refuse(`A slide holds at most ${SLIDE_LIMITS.compositionBlocks} blocks.`);
    const copy = structuredClone(source); freshIdentities(copy, createId);
    next.blocks.push(copy);
    composition.steps.push({ id: createId(), block_ids: [copy.id] });
    composition.reading_order.push(copy.id);
    const placement = composition.placements.find(item => item.block_id === blockId);
    const space = placement && freeSpace(composition.placements, placement.w, placement.h);
    if (space) composition.placements.push({ block_id: copy.id, ...space });
    const style = composition.styles?.find(item => item.block_id === blockId);
    if (style) composition.styles.push({ ...structuredClone(style), block_id: copy.id });
    return { ok: true, document: next, blockId: copy.id };
  });
}

/** Give a copied block, and every row, column, entry, point, series and group in it, a fresh identity; old id → new id. */
function freshIdentities(copy, createId) {
  const ids = new Map(), renew = item => { if (item && typeof item === 'object' && 'id' in item) { const id = createId(); ids.set(item.id, id); item.id = id; } };
  renew(copy);
  for (const list of [copy.columns, copy.rows, copy.entries, copy.points, copy.series, copy.groups, copy.compare?.earlier]) for (const item of list ?? []) renew(item);
  for (const group of copy.groups ?? []) for (const item of group?.rows ?? []) renew(item);
  return ids;
}

/** A block's fill colour (any block since CASE-225); its other presentation stays. */
export function setCalloutTone(document, compositionId, blockId, tone) {
  if (!Object.hasOwn(CALLOUT_TONES, tone)) return refuse('Unknown tone.');
  return setBlockStyle(document, compositionId, blockId, 'tone', tone);
}

// ── tables ─────────────────────────────────────────────────────────────────────────────────────────────────
function editTable(document, blockId, change) {
  const next = structuredClone(document), table = byId(next.blocks, blockId);
  if (table?.type !== 'table') return refuse('That table no longer exists.');
  return change(table, next) ?? done(next);
}
const column = (table, id) => table.columns.findIndex(item => item.id === id);
const row = (table, id) => table.rows.findIndex(item => item.id === id);

export const setCaption = (document, blockId, caption) => editTable(document, blockId, table => { if (caption === '') delete table.caption; else table.caption = caption; });
export function setCell(document, blockId, rowId, columnId, value) {
  return editTable(document, blockId, table => {
    const r = row(table, rowId), c = column(table, columnId);
    if (r < 0 || c < 0) return refuse('That cell no longer exists.');
    table.rows[r].cells[c] = value;
  });
}
export function setColumn(document, blockId, columnId, change) {
  return editTable(document, blockId, table => {
    const c = column(table, columnId);
    if (c < 0) return refuse('That column no longer exists.');
    const target = table.columns[c];
    if ('label' in change) { if (!table.header_row && change.label) return refuse('Turn on the header row to name columns.'); target.label = change.label; }
    if ('width' in change) target.width = change.width;
    if ('align' in change) target.align = change.align;
    if ('unit' in change) { if (change.unit) target.unit = change.unit; else delete target.unit; }
  });
}
export function addRow(document, blockId, afterRowId, createId) {
  return editTable(document, blockId, table => {
    if (table.rows.length >= SLIDE_LIMITS.tableRows) return refuse(`A table holds at most ${SLIDE_LIMITS.tableRows} rows.`);
    const at = afterRowId ? row(table, afterRowId) + 1 : table.rows.length;
    if (at === 0 && afterRowId) return refuse('That row no longer exists.');
    table.rows.splice(at, 0, { id: createId(), cells: table.columns.map(() => '') });
  });
}
export function addColumn(document, blockId, afterColumnId, createId) {
  return editTable(document, blockId, table => {
    if (table.columns.length >= SLIDE_LIMITS.tableColumns) return refuse(`A table holds at most ${SLIDE_LIMITS.tableColumns} columns.`);
    const at = afterColumnId ? column(table, afterColumnId) + 1 : table.columns.length;
    if (at === 0 && afterColumnId) return refuse('That column no longer exists.');
    table.columns.splice(at, 0, { id: createId(), label: table.header_row ? 'Column' : '', width: 1, align: 'start' });
    for (const item of table.rows) item.cells.splice(at, 0, '');
  });
}
/** Deleting a row or column that holds text needs `confirmed`; the last one is never removed (shape stays valid). */
export function removeRow(document, blockId, rowId, { confirmed = false } = {}) {
  return editTable(document, blockId, table => {
    const r = row(table, rowId);
    if (r < 0) return refuse('That row no longer exists.');
    if (table.rows.length === 1) return refuse('A table keeps at least one row.');
    if (!confirmed && table.rows[r].cells.some(cell => cell !== '')) return { ok: false, reason: 'This row has content. Confirm to delete it.', review: true };
    table.rows.splice(r, 1);
  });
}
export function removeColumn(document, blockId, columnId, { confirmed = false } = {}) {
  return editTable(document, blockId, table => {
    const c = column(table, columnId);
    if (c < 0) return refuse('That column no longer exists.');
    if (table.columns.length === 1) return refuse('A table keeps at least one column.');
    if (!confirmed && (table.columns[c].label || table.rows.some(item => item.cells[c] !== ''))) return { ok: false, reason: 'This column has content. Confirm to delete it.', review: true };
    table.columns.splice(c, 1);
    for (const item of table.rows) item.cells.splice(c, 1);
  });
}
export function moveRow(document, blockId, rowId, delta) {
  return editTable(document, blockId, table => {
    const r = row(table, rowId), t = r + delta;
    if (r < 0 || t < 0 || t >= table.rows.length) return refuse('The row cannot move further.');
    [table.rows[r], table.rows[t]] = [table.rows[t], table.rows[r]];
  });
}
export function moveColumn(document, blockId, columnId, delta) {
  return editTable(document, blockId, table => {
    const c = column(table, columnId), t = c + delta;
    if (c < 0 || t < 0 || t >= table.columns.length) return refuse('The column cannot move further.');
    [table.columns[c], table.columns[t]] = [table.columns[t], table.columns[c]];
    for (const item of table.rows) [item.cells[c], item.cells[t]] = [item.cells[t], item.cells[c]];
  });
}
/** Header semantics off keeps the labels as an ordinary first row; on promotes the first row back. Nothing is hidden. */
export function setHeaderRow(document, blockId, on, createId, { confirmed = false } = {}) {
  return editTable(document, blockId, table => {
    if (on === table.header_row) return refuse(on ? 'The header row is already on.' : 'The header row is already off.');
    if (!on) {
      if (table.columns.some(item => item.label) && table.rows.length >= SLIDE_LIMITS.tableRows) return refuse('There is no room for the header text as a row.');
      if (table.columns.some(item => item.label)) table.rows.unshift({ id: createId(), cells: table.columns.map(item => item.label) });
      for (const item of table.columns) item.label = '';
      table.header_row = false;
    } else {
      const first = table.rows[0];
      if (table.rows.length > 1 && first.cells.some(cell => cell.length > SLIDE_LIMITS.columnLabel)) return refuse('The first row is too long to become column labels.');
      if (table.rows.length > 1 && !confirmed) return { ok: false, reason: 'The first row becomes the column labels and stops being a body row. Confirm to continue.', review: true };
      if (table.rows.length > 1) { table.columns.forEach((item, index) => { item.label = first.cells[index]; }); table.rows.shift(); }
      table.header_row = true;
    }
  });
}
export const setFirstColumnHeader = (document, blockId, on) => editTable(document, blockId, table => { table.first_column_header = Boolean(on); });

/**
 * Paste a rectangular, tab-separated range at a cell. One final newline is ignored; blank cells are kept exactly.
 * Ragged, quoted or oversized input refuses atomically; populated cells need `confirmed` before they are overwritten.
 */
export function pasteRange(document, blockId, rowId, columnId, text, createId, { confirmed = false } = {}) {
  return editTable(document, blockId, table => {
    if (typeof text !== 'string' || !text) return refuse('Nothing to paste.');
    if (text.includes('"')) return refuse('Quoted spreadsheet text is not supported; paste plain tab-separated cells.');
    const lines = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').map(line => line.split('\t'));
    if (new Set(lines.map(line => line.length)).size !== 1) return refuse('Every pasted row needs the same number of cells.');
    const r = row(table, rowId), c = column(table, columnId);
    if (r < 0 || c < 0) return refuse('That cell no longer exists.');
    if (c + lines[0].length > table.columns.length) return refuse('The pasted range is wider than the table. Add columns first.');
    if (r + lines.length > SLIDE_LIMITS.tableRows) return refuse(`A table holds at most ${SLIDE_LIMITS.tableRows} rows.`);
    if (lines.flat().some(cell => cell.length > SLIDE_LIMITS.cellChars)) return refuse(`A cell holds at most ${SLIDE_LIMITS.cellChars} characters.`);
    const overwrite = lines.some((line, dy) => line.some((_, dx) => (table.rows[r + dy]?.cells[c + dx] ?? '') !== ''));
    if (overwrite && !confirmed) return { ok: false, reason: 'The paste replaces cells that have content. Confirm to replace them.', review: true };
    while (table.rows.length < r + lines.length) table.rows.push({ id: createId(), cells: table.columns.map(() => '') });
    lines.forEach((line, dy) => line.forEach((cell, dx) => { table.rows[r + dy].cells[c + dx] = cell; }));
  });
}

// ── text ───────────────────────────────────────────────────────────────────────────────────────────────────
/** Replace a writing block's paragraphs from the editor; style changes are shared edits to every use. */
export function setParagraphs(document, blockId, paragraphs) {
  const { next, block } = ownBlock(document, blockId); // typed on every key (round 28)
  if (!['text', 'quote', 'callout'].includes(block?.type)) return refuse('That block is not a writing block.');
  block.paragraphs = structuredClone(paragraphs);
  return done(next);
}
export function setListOrdered(document, blockId, ordered) {
  const next = structuredClone(document), block = byId(next.blocks, blockId);
  if (block?.type !== 'list') return refuse('That block is not a list.');
  block.ordered = Boolean(ordered);
  return done(next);
}
export function setListItems(document, blockId, items) {
  const { next, block } = ownBlock(document, blockId);
  if (block?.type !== 'list') return refuse('That block is not a list.');
  block.items = structuredClone(items);
  return done(next);
}

/**
 * Turn into between writing types, keeping identity, placement, step, reading order and every word. A change that
 * drops heading styles, or one shared by several slides, needs `confirmed`. A question never turns into text.
 */
export function turnInto(document, blockId, type, { confirmed = false, createId = null } = {}) {
  const writing = ['text', 'quote', 'callout', 'list'];
  const next = structuredClone(document), block = byId(next.blocks, blockId);
  if (!block) return refuse('That block no longer exists.');
  if (block.type === 'question') return refuse('A question stays bound to its decision.');
  if (block.type === type) return refuse('The block is already that type.');
  if (type === 'table' && writing.includes(block.type)) return createId ? writingToTable(next, block, confirmed, createId) : refuse('That conversion needs new identities.');
  if (block.type === 'table' && writing.includes(type)) return tableToWriting(next, block, type, confirmed);
  // Values and Timeline are tables with fixed columns (BWR20): they turn into a table and back without losing a value.
  if (Object.hasOwn(RECORDS, block.type) && type === 'table') return createId ? recordsToTable(next, block, confirmed, createId) : refuse('That conversion needs new identities.');
  if (block.type === 'table' && Object.hasOwn(RECORDS, type)) return tableToRecords(next, block, type, confirmed);
  if (!writing.includes(block.type) || !writing.includes(type)) return refuse('That conversion is not available yet.');
  const lines = block.type === 'list' ? block.items.map(item => ({ style: 'p', runs: item.runs })) : block.paragraphs.map(item => ({ style: item.style ?? 'p', runs: item.runs }));
  const losses = [];
  if (type !== 'text' && lines.some(item => item.style !== 'p')) losses.push('heading styles');
  if (block.type === 'list' && block.ordered) losses.push('list numbering');
  const uses = usesOf(next, blockId).length;
  if (uses > 1) losses.push(`the same content on ${uses} slides`);
  if (losses.length && !confirmed) return { ok: false, reason: `Turning this into a ${type} changes ${losses.join(' and ')}. Confirm to continue.`, review: true };
  for (const key of ['paragraphs', 'items', 'ordered']) delete block[key];
  if (type === 'list') { block.ordered = false; block.items = lines.map(item => ({ runs: item.runs })); }
  else block.paragraphs = lines.map(item => type === 'text' ? { style: item.style, runs: item.runs } : { runs: item.runs });
  block.type = type;
  // Fill and text colour belong to every block type (CASE-225), so they stay through a conversion.
  return done(next);
}

const plain = runs => runs.map(run => run.text).join('');
const sharedNote = (document, blockId) => { const uses = usesOf(document, blockId).length; return uses > 1 ? ` It changes the same content on ${uses} slides.` : ''; };
/** Writing → table: one row per paragraph or list item in a single column; formatting that cells cannot hold is named. */
function writingToTable(next, block, confirmed, createId) {
  const lines = (block.type === 'list' ? block.items : block.paragraphs).map(item => ({ text: plain(item.runs), styled: item.style && item.style !== 'p', bold: item.runs.some(run => run.bold), script: item.runs.some(run => run.script) }));
  const losses = [lines.some(line => line.bold) && 'bold', lines.some(line => line.script) && 'subscript or superscript', lines.some(line => line.styled) && 'heading styles', block.type === 'list' && block.ordered && 'list numbering'].filter(Boolean);
  const preview = lines.map(line => `| ${line.text} |`).join('\n');
  if (!confirmed) return { ok: false, review: true, preview, reason: `Turn into a one-column table with ${lines.length} ${lines.length === 1 ? 'row' : 'rows'}?${losses.length ? ` Cells keep the words but not ${losses.join(' or ')}.` : ''}${sharedNote(next, block.id)} Confirm to continue.` };
  for (const key of ['paragraphs', 'items', 'ordered']) delete block[key];
  Object.assign(block, { type: 'table', header_row: false, first_column_header: false, columns: [{ id: createId(), label: '', width: 1, align: 'start' }],
    rows: lines.map(line => ({ id: createId(), cells: [line.text] })) });
  for (const composition of next.compositions) for (const style of composition.styles ?? []) if (style.block_id === block.id) delete style.tone;
  return done(next);
}
/** The fixed columns of the record blocks: [column label, field, limit]. */
const RECORDS = Object.freeze({
  values: { list: 'rows', name: 'values', fields: [['Label', 'label', SLIDE_LIMITS.valueLabel], ['Value', 'value', SLIDE_LIMITS.valueValue], ['Unit', 'unit', SLIDE_LIMITS.unit]], max: SLIDE_LIMITS.valueRows },
  timeline: { list: 'entries', name: 'a timeline', fields: [['Time', 'label', SLIDE_LIMITS.timelineLabel], ['Event', 'text', SLIDE_LIMITS.textChars]], max: SLIDE_LIMITS.timelineEntries },
});
/** Values or Timeline → table: one row per record, a header row naming the fields; an empty Unit column is left out. */
function recordsToTable(next, block, confirmed, createId) {
  const spec = RECORDS[block.type], items = block[spec.list];
  const fields = spec.fields.filter(([, key]) => key !== 'unit' || items.some(item => item.unit));
  const preview = [`| ${fields.map(([label]) => label).join(' | ')} |`, ...items.map(item => `| ${fields.map(([, key]) => item[key] ?? '').join(' | ')} |`)].join('\n');
  if (!confirmed) return { ok: false, review: true, preview, reason: `Turn into a table with ${items.length} ${items.length === 1 ? 'row' : 'rows'} and the columns ${fields.map(([label]) => label).join(', ')}? Every value is kept.${sharedNote(next, block.id)}` };
  delete block[spec.list];
  Object.assign(block, { type: 'table', header_row: true, first_column_header: false,
    columns: fields.map(([label, key]) => ({ id: createId(), label, width: key === 'text' ? 3 : 1, align: 'start' })),
    rows: items.map(item => ({ id: item.id, cells: fields.map(([, key]) => item[key] ?? '') })) });
  return done(next);
}
/** Table → Values or Timeline, when the table has those columns' shape and fits their limits; otherwise says why. */
function tableToRecords(next, block, type, confirmed) {
  const spec = RECORDS[type], need = type === 'values' ? [2, 3] : [2];
  if (!need.includes(block.columns.length)) return refuse(type === 'values' ? 'A table turns into values when it has two or three columns: label, value and unit.' : 'A table turns into a timeline when it has two columns: time and event.');
  if (block.rows.length > spec.max) return refuse(`${type === 'values' ? 'Values hold' : 'A timeline holds'} at most ${spec.max} rows.`);
  const long = block.rows.some(row => row.cells.some((cell, index) => cell.length > spec.fields[index][2]));
  if (long) return refuse(`A cell is longer than ${type === 'values' ? 'values' : 'a timeline'} can hold. Shorten it first.`);
  if (block.rows.some(row => !row.cells[0] || !row.cells[1])) return refuse('Every row needs its first two cells filled first.');
  const dropped = [block.caption && 'the caption', block.header_row && block.columns.some(column => column.label) && 'the column names', block.columns.some(column => column.unit) && 'column units'].filter(Boolean);
  const preview = block.rows.map(row => spec.fields.slice(0, block.columns.length).map(([label], index) => `${label}: ${row.cells[index]}`).join(' · ')).join('\n');
  if (!confirmed) return { ok: false, review: true, preview, reason: `Turn this table into ${spec.name} with ${block.rows.length} ${block.rows.length === 1 ? 'row' : 'rows'}? Every value is kept${dropped.length ? `; ${dropped.join(', ')} ${dropped.length === 1 ? 'is' : 'are'} not` : ''}.${sharedNote(next, block.id)}` };
  const items = block.rows.map(row => Object.fromEntries([['id', row.id], ...spec.fields.map(([, key], index) => [key, row.cells[index] ?? ''])]));
  for (const key of ['header_row', 'first_column_header', 'columns', 'rows', 'caption']) delete block[key];
  Object.assign(block, { type, [spec.list]: items });
  shedTableStyles(next, block.id);
  return done(next);
}
/** Table → writing: one paragraph (or item) per row, each cell kept with its column label and unit. */
function tableToWriting(next, block, type, confirmed) {
  const lines = block.rows.map(row => row.cells.map((cell, index) => {
    const column = block.columns[index], value = cell === '' ? '' : `${cell}${column.unit ? ` ${column.unit}` : ''}`;
    return value && block.header_row && column.label ? `${column.label}: ${value}` : value;
  }).filter(Boolean).join(' · '));
  const preview = lines.join('\n');
  if (!confirmed) return { ok: false, review: true, preview, reason: `Turn this table into ${type === 'list' ? 'a list' : `a ${type} block`} with ${lines.length} ${lines.length === 1 ? 'line' : 'lines'}? Every value is kept as text; the column structure, widths and alignment are not.${sharedNote(next, block.id)} Confirm to continue.` };
  for (const key of ['header_row', 'first_column_header', 'columns', 'rows', 'caption']) delete block[key];
  block.type = type;
  shedTableStyles(next, block.id);
  if (type === 'list') { block.ordered = false; block.items = lines.map(text => ({ runs: [{ text }] })); }
  else block.paragraphs = lines.map(text => type === 'text' ? { style: 'p', runs: [{ text }] } : { runs: [{ text }] });
  return done(next);
}

// ── placement ──────────────────────────────────────────────────────────────────────
const overlaps = (a, b) => a.col < b.col + b.w && b.col < a.col + a.w && a.row < b.row + b.h && b.row < a.row + a.h;
/** Move or resize one block on this slide. Out-of-grid or overlapping cells refuse; reveal and reading order stay. */
export function setPlacement(document, compositionId, blockId, { col, row, w, h }) {
  const cell = { col, row, w, h };
  if (![col, row, w, h].every(Number.isInteger) || col < 1 || row < 1 || w < 1 || h < 1 || col + w - 1 > SLIDE_GRID || row + h - 1 > SLIDE_GRID)
    return refuse(`A block sits inside the ${SLIDE_GRID} × ${SLIDE_GRID} grid.`);
  return edit(document, compositionId, (next, composition) => {
    if (!composition.reading_order.includes(blockId)) return refuse('That block is not on this slide.');
    if (composition.placements.some(item => item.block_id !== blockId && overlaps(item, cell))) return refuse('That position overlaps another block.');
    composition.placements = [...composition.placements.filter(item => item.block_id !== blockId), { block_id: blockId, ...cell }];
  });
}
/** Place an unplaced block in the first free whole-width band, or refuse when the grid has no room. */
export function placeBlock(document, compositionId, blockId) {
  return edit(document, compositionId, (next, composition) => {
    if (!composition.reading_order.includes(blockId)) return refuse('That block is not on this slide.');
    if (composition.placements.some(item => item.block_id === blockId)) return refuse('That block is already placed.');
    // The same room the palette finds (round 21): free space of any useful size, else a block with room to spare.
    const block = byId(next.blocks, blockId), need = blockNeeds(block), room = findRoom(composition.placements, next.blocks, need);
    if (room) { composition.placements.push({ block_id: blockId, ...room }); return; }
    // The refusal says what the block needs (round 23), so shrinking the wrong block is not a guess.
    const what = block?.type === 'table' ? `A ${block.columns.length}-column table` : 'This block';
    return refuse(`No room on the slide. Make a block smaller first. ${what} needs a free area ${need.minW} grid cells wide and ${need.minH} tall.`);
  });
}
/** Take a block off the canvas. Its content, reveal step and reading position stay, and it is reported as unplaced. */
export function unplaceBlock(document, compositionId, blockId) {
  return edit(document, compositionId, (next, composition) => {
    if (!composition.placements.some(item => item.block_id === blockId)) return refuse('That block is not placed.');
    composition.placements = composition.placements.filter(item => item.block_id !== blockId);
  });
}

// ── values and timeline entries ────────────────────────────────────────────────────
const ENTRY = { values: ['rows', ['label', 'value', 'unit'], SLIDE_LIMITS.valueRows], timeline: ['entries', ['label', 'text'], SLIDE_LIMITS.timelineEntries] };
function editEntries(document, blockId, change) {
  const next = structuredClone(document), block = byId(next.blocks, blockId), spec = ENTRY[block?.type];
  if (!spec) return refuse('That block has no rows.');
  return change(block[spec[0]], spec) ?? done(next);
}
export function setEntry(document, blockId, entryId, key, value) {
  return editEntries(document, blockId, (list, [, keys]) => {
    const entry = byId(list, entryId);
    if (!entry || !keys.includes(key)) return refuse('That row no longer exists.');
    entry[key] = value;
  });
}
export function addEntry(document, blockId, afterEntryId, createId) {
  return editEntries(document, blockId, (list, [, keys, max]) => {
    if (list.length >= max) return refuse(`This block holds at most ${max} rows.`);
    const index = afterEntryId ? list.findIndex(item => item.id === afterEntryId) : list.length - 1;
    if (afterEntryId && index < 0) return refuse('That row no longer exists.');
    list.splice(index + 1, 0, { id: createId(), ...Object.fromEntries(keys.map(key => [key, ''])) });
  });
}
/** Move a Values or Timeline row up or down; authored row order is what the room reads (BWR17). */
export function moveEntry(document, blockId, entryId, delta) {
  return editEntries(document, blockId, list => {
    const index = list.findIndex(item => item.id === entryId), target = index + delta;
    if (index < 0) return refuse('That row no longer exists.');
    if (target < 0 || target >= list.length) return refuse(delta < 0 ? 'That row is already first.' : 'That row is already last.');
    list.splice(target, 0, list.splice(index, 1)[0]);
  });
}
export function removeEntry(document, blockId, entryId, { confirmed = false } = {}) {
  return editEntries(document, blockId, (list, [, keys]) => {
    const index = list.findIndex(item => item.id === entryId);
    if (index < 0) return refuse('That row no longer exists.');
    if (list.length === 1) return refuse('This block keeps at least one row.');
    if (!confirmed && keys.some(key => list[index][key])) return { ok: false, reason: 'This row has content. Confirm to delete it.', review: true };
    list.splice(index, 1);
  });
}

// ── blood gas reports (CASE-311; compare-mode columns live in slide-gas-edit.mjs, CASE-317) ───────────────────────────────────────────────────
// Groups and rows are addressed by identity. Values, units and bounds are the author's exact text; flags are never stored.
const GAS_ROW_KEYS = ['label', 'value', 'unit', 'low', 'high'];
export function editGas(document, blockId, change) {
  const next = structuredClone(document), block = byId(next.blocks, blockId);
  if (block?.type !== 'gas') return refuse('That blood gas no longer exists.');
  return change(block) ?? done(next);
}
// In compare mode (CASE-317) a new row carries one empty reading per earlier sample, and "has a value" means any reading.
const blankGasRow = (gas, createId) => ({ id: createId(), label: '', value: '', unit: '', low: '', high: '', ...(gas.compare ? { earlier: gas.compare.earlier.map(() => '') } : {}) });
const gasFilled = (gas, row) => gasCells(gas, row).some(gasTyped);
export const gasRow = (gas, rowId) => { for (const group of gas.groups) { const index = group.rows.findIndex(row => row.id === rowId); if (index >= 0) return { group, index }; } return null; };
export function setGasField(document, blockId, key, value) {
  return editGas(document, blockId, gas => {
    if (key === 'sample' ? !Object.hasOwn(GAS_SAMPLES, value) : key !== 'caption' || typeof value !== 'string') return refuse('That setting cannot change.');
    gas[key] = value;
  });
}
export function setGasRow(document, blockId, rowId, key, value) {
  return editGas(document, blockId, gas => {
    const found = gasRow(gas, rowId);
    if (!found || !GAS_ROW_KEYS.includes(key) || typeof value !== 'string') return refuse('That row no longer exists.');
    found.group.rows[found.index][key] = value;
  });
}
export function setGasGroupLabel(document, blockId, groupId, value) {
  return editGas(document, blockId, gas => { const group = byId(gas.groups, groupId); if (!group || typeof value !== 'string') return refuse('That group no longer exists.'); group.label = value; });
}
export function addGasRow(document, blockId, groupId, createId) {
  return editGas(document, blockId, gas => {
    const group = byId(gas.groups, groupId);
    if (!group) return refuse('That group no longer exists.');
    if (group.rows.length >= GAS_LIMITS.rows) return refuse(`A group holds at most ${GAS_LIMITS.rows} rows.`);
    if (gas.groups.reduce((sum, item) => sum + item.rows.length, 0) >= GAS_LIMITS.totalRows) return refuse(`A report holds at most ${GAS_LIMITS.totalRows} rows.`);
    group.rows.push(blankGasRow(gas, createId));
  });
}
/** Move a row within its group; the order is what the room reads. */
export function moveGasRow(document, blockId, rowId, delta) {
  return editGas(document, blockId, gas => {
    const found = gasRow(gas, rowId);
    if (!found) return refuse('That row no longer exists.');
    const target = found.index + delta;
    if (target < 0 || target >= found.group.rows.length) return refuse(delta < 0 ? 'That row is already first in its group.' : 'That row is already last in its group.');
    found.group.rows.splice(target, 0, found.group.rows.splice(found.index, 1)[0]);
  });
}
export function removeGasRow(document, blockId, rowId, { confirmed = false } = {}) {
  return editGas(document, blockId, gas => {
    const found = gasRow(gas, rowId);
    if (!found) return refuse('That row no longer exists.');
    if (found.group.rows.length === 1) return refuse('A group keeps at least one row; delete the group instead.');
    if (!confirmed && gasFilled(gas, found.group.rows[found.index])) return { ok: false, reason: 'This row has a value. Confirm to delete it.', review: true };
    found.group.rows.splice(found.index, 1);
  });
}
export function addGasGroup(document, blockId, createId) {
  return editGas(document, blockId, gas => {
    if (gas.groups.length >= GAS_LIMITS.groups) return refuse(`A report holds at most ${GAS_LIMITS.groups} groups.`);
    if (gas.groups.reduce((sum, item) => sum + item.rows.length, 0) >= GAS_LIMITS.totalRows) return refuse(`A report holds at most ${GAS_LIMITS.totalRows} rows.`);
    gas.groups.push({ id: createId(), label: 'Other', rows: [blankGasRow(gas, createId)] });
  });
}
export function removeGasGroup(document, blockId, groupId, { confirmed = false } = {}) {
  return editGas(document, blockId, gas => {
    const index = gas.groups.findIndex(group => group.id === groupId);
    if (index < 0) return refuse('That group no longer exists.');
    if (gas.groups.length === 1) return refuse('A report keeps at least one group.');
    if (!confirmed && gas.groups[index].rows.some(row => gasFilled(gas, row))) return { ok: false, reason: 'This group has values. Confirm to delete it.', review: true };
    gas.groups.splice(index, 1);
  });
}

// ── trend charts (card 59 M1, CASE-263) ────────────────────────────────────────────
// Points and series are addressed by identity; a series holds one value per point, in point order, so adding, moving or
// removing a point moves its readings with it. Values stay the author's exact text; validation names what is not ready.
const TREND_TEXT = ['caption', 'x_label', 'x_unit', 'y_label', 'y_unit', 'y_min', 'y_max'];
function editTrend(document, blockId, change) {
  const next = structuredClone(document), block = byId(next.blocks, blockId);
  if (block?.type !== 'trend') return refuse('That chart no longer exists.');
  return change(block) ?? done(next);
}
export function setTrendField(document, blockId, key, value) {
  return editTrend(document, blockId, trend => {
    if (TREND_TEXT.includes(key) ? typeof value !== 'string' : key === 'scale' ? !TREND_SCALES.includes(value) : key === 'style' ? !TREND_STYLES.includes(value) : key !== 'values_shown' || typeof value !== 'boolean') return refuse('That chart setting is not available.');
    trend[key] = value;
  });
}
export function setTrendPoint(document, blockId, pointId, key, value) {
  return editTrend(document, blockId, trend => {
    const point = byId(trend.points, pointId);
    if (!point || !['label', 'at'].includes(key) || typeof value !== 'string') return refuse('That point no longer exists.');
    point[key] = value;
  });
}
export function setTrendSeriesLabel(document, blockId, seriesId, value) {
  return editTrend(document, blockId, trend => { const series = byId(trend.series, seriesId); if (!series || typeof value !== 'string') return refuse('That series no longer exists.'); series.label = value; });
}
export function setTrendValue(document, blockId, seriesId, pointId, value) {
  return editTrend(document, blockId, trend => {
    const series = byId(trend.series, seriesId), index = trend.points.findIndex(point => point.id === pointId);
    if (!series || index < 0 || typeof value !== 'string') return refuse('That reading no longer exists.');
    series.values[index] = value;
  });
}
export function addTrendPoint(document, blockId, afterPointId, createId) {
  return editTrend(document, blockId, trend => {
    if (trend.points.length >= SLIDE_LIMITS.trendPoints) return refuse(`A chart holds at most ${SLIDE_LIMITS.trendPoints} points.`);
    const index = afterPointId ? trend.points.findIndex(point => point.id === afterPointId) : trend.points.length - 1;
    if (afterPointId && index < 0) return refuse('That point no longer exists.');
    trend.points.splice(index + 1, 0, { id: createId(), label: '', at: '' });
    for (const series of trend.series) series.values.splice(index + 1, 0, '');
  });
}
export function moveTrendPoint(document, blockId, pointId, delta) {
  return editTrend(document, blockId, trend => {
    const index = trend.points.findIndex(point => point.id === pointId), target = index + delta;
    if (index < 0) return refuse('That point no longer exists.');
    if (target < 0 || target >= trend.points.length) return refuse(delta < 0 ? 'That point is already first.' : 'That point is already last.');
    for (const list of [trend.points, ...trend.series.map(series => series.values)]) list.splice(target, 0, list.splice(index, 1)[0]);
  });
}
export function removeTrendPoint(document, blockId, pointId, { confirmed = false } = {}) {
  return editTrend(document, blockId, trend => {
    const index = trend.points.findIndex(point => point.id === pointId);
    if (index < 0) return refuse('That point no longer exists.');
    if (trend.points.length <= 2) return refuse('A chart keeps at least two points.');
    if (!confirmed && (trend.points[index].label || trend.points[index].at || trend.series.some(series => series.values[index]))) return { ok: false, reason: 'This point has readings. Confirm to delete it.', review: true };
    trend.points.splice(index, 1);
    for (const series of trend.series) series.values.splice(index, 1);
  });
}
export function addTrendSeries(document, blockId, createId) {
  return editTrend(document, blockId, trend => {
    if (trend.series.length >= SLIDE_LIMITS.trendSeries) return refuse(`A chart holds at most ${SLIDE_LIMITS.trendSeries} series.`);
    trend.series.push({ id: createId(), label: '', values: trend.points.map(() => '') });
  });
}
export function removeTrendSeries(document, blockId, seriesId, { confirmed = false } = {}) {
  return editTrend(document, blockId, trend => {
    const index = trend.series.findIndex(series => series.id === seriesId);
    if (index < 0) return refuse('That series no longer exists.');
    if (trend.series.length === 1) return refuse('A chart keeps at least one series.');
    if (!confirmed && (trend.series[index].label || trend.series[index].values.some(Boolean))) return { ok: false, reason: 'This series has readings. Confirm to delete it.', review: true };
    trend.series.splice(index, 1);
  });
}

// ── images and ECGs (card 59 M2, CASE-268) ──────────────────────────────────────────
/** One field of an image block: its alt text, caption, fit, image, or an ECG's calibration. An ECG is always contain. */
export function setImageField(document, blockId, key, value) {
  const next = structuredClone(document), block = byId(next.blocks, blockId);
  if (block?.type !== 'image') return refuse('That image no longer exists.');
  if (key === 'alt' || key === 'caption') { if (typeof value !== 'string') return refuse('Text only.'); block[key] = value; }
  else if (key === 'fit') { if (!IMAGE_FITS.includes(value)) return refuse('Unknown fit.'); if (block.ecg && value !== 'contain') return refuse('An ECG is always shown whole.'); block.fit = value; }
  else if (key === 'asset_id') { if (typeof value !== 'string') return refuse('Choose an image.'); block.asset_id = value; }
  else if (key === 'ecg') {
    if (value === null) block.ecg = null;
    else if (value && ECG_SPEEDS.includes(value.speed) && ECG_GAINS.includes(value.gain) && ECG_LAYOUTS.includes(value.layout)) { block.ecg = { speed: value.speed, gain: value.gain, layout: value.layout }; block.fit = 'contain'; }
    else return refuse('Unknown ECG calibration.');
  } else return refuse('That image setting is not available.');
  return done(next);
}

// ── source traces ──────────────────────────────────────────────────────────────────
const strings = value => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === 'object' ? Object.entries(value).filter(([key]) => key !== 'id' && key !== 'style').flatMap(([, item]) => strings(item)) : [];
const sameText = (a, b) => JSON.stringify(strings(a)) === JSON.stringify(strings(b));
// Each block and its rows, entries, columns, points and series by id, first found in scan order; built once per draft.
const entities = new WeakMap();
function entityIn(document, id) {
  let index = entities.get(document);
  if (!index) {
    entities.set(document, index = new Map());
    const add = item => { if (item && !index.has(item.id)) index.set(item.id, item); };
    for (const block of document.blocks ?? []) { add(block); for (const key of ['rows', 'entries', 'columns', 'points', 'series', 'groups']) (block[key] ?? []).forEach(add); for (const group of block.groups ?? []) (group?.rows ?? []).forEach(add); }
  }
  return index.get(id) ?? null;
}
const parse = field => { const match = /^([a-z_]+)(?:\[(\d+)\])?(.*)$/.exec(field ?? ''); return match ? { key: match[1], index: match[2] === undefined ? null : Number(match[2]), rest: match[3] } : null; };
function at(entity, field) {
  const segments = String(field).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let target = entity;
  for (const segment of segments) { if (target === null || typeof target !== 'object' || !Object.hasOwn(target, segment)) return undefined; target = target[segment]; }
  return target;
}

/**
 * Carry private source traces across one slide operation. A trace whose text moved (a removed paragraph before it,
 * a row or column move, Turn into between paragraphs and list items) follows it; a trace whose text was edited stays
 * and is marked stale; a trace whose content was removed is dropped and counted, so the caller can review that first.
 */
export function carryProvenance(before, after, metadata) {
  const entries = Array.isArray(metadata?.provenance) ? metadata.provenance : null;
  if (!entries?.length) return { metadata, removed: 0 };
  let removed = 0;
  const provenance = [];
  for (const entry of entries) {
    const old = entityIn(before, entry.entity_id), was = old && at(old, entry.field), path = parse(entry.field);
    if (!old || was === undefined || !path) { provenance.push(entry); continue; }
    const now = entityIn(after, entry.entity_id);
    // An untouched record is shared by both drafts (round 28): its trace stays exactly as it is.
    if (now === old) { provenance.push(entry); continue; }
    if (!now) { removed++; continue; }
    // Turn into renames paragraphs <-> items; the trace follows the same position under the new name.
    const key = now[path.key] !== undefined ? path.key : ({ paragraphs: 'items', items: 'paragraphs' })[path.key] ?? path.key;
    const point = index => `${key}${index === null ? '' : `[${index}]`}${path.rest}`;
    const keep = (field, stale) => provenance.push(field === entry.field && !stale ? entry : { ...entry, field, ...(stale ? { review_status: 'stale' } : {}) });
    if (path.index === null) {
      const value = at(now, point(null));
      if (value === undefined) removed++; else keep(point(null), !sameText(was, value));
      continue;
    }
    const list = Array.isArray(now[key]) ? now[key] : [], oldList = old[path.key], traced = oldList[path.index];
    if (sameText(traced, list[path.index])) { keep(point(path.index), !sameText(was, at(now, point(path.index)))); continue; }
    const moved = list.flatMap((item, index) => sameText(traced, item) ? [index] : []);
    if (moved.length === 1) keep(point(moved[0]), false);
    else if (list.length < oldList.length || path.index >= list.length) removed++;
    else keep(point(path.index), true);
  }
  const same = provenance.length === entries.length && provenance.every((entry, index) => entry === entries[index]);
  return same ? { metadata, removed: 0 } : { metadata: { ...metadata, provenance }, removed };
}

// ── one learner heading (r24 P2-3) ─────────────────────────────────────────────────
/**
 * Each stage slide's lead heading block (one heading line, shown on that slide only), by stage id. One pass over the
 * draft's compositions and blocks: this runs on every keystroke, so it must stay linear at the caps (BWR13, r24).
 */
function leadHeadings(document) {
  const list = value => Array.isArray(value) ? value : [];
  // First item per id, as the scan it replaces found it (a valid draft has no duplicate ids).
  const first = items => { const map = new Map(); for (const item of list(items)) if (!map.has(item?.id)) map.set(item?.id, item); return map; };
  const blocks = first(document.blocks), uses = new Map(), lead = new Map(), found = new Map();
  for (const composition of list(document.compositions)) {
    for (const id of list(composition?.reading_order)) uses.set(id, (uses.get(id) ?? 0) + 1);
    if (composition?.owner?.id && !lead.has(composition.owner.id)) lead.set(composition.owner.id, composition.reading_order?.[0]);
  }
  for (const [beatId, id] of lead) {
    const block = blocks.get(id);
    if (block?.type !== 'text' || block.paragraphs?.length !== 1 || block.paragraphs[0].style === 'p' || uses.get(id) !== 1) continue;
    found.set(beatId, { block, text: list(block.paragraphs[0].runs).map(run => run?.text ?? '').join('') });
  }
  return found;
}
export function followHeadings(document, before) {
  if (document?.schema_version !== 3 || !before) return document;
  const list = value => Array.isArray(value) ? value : [];
  const owners = doc => {
    const surfaces = new Map(list(doc.surfaces).map(item => [item.id, item]));
    return [...list(doc.beats).map(item => ({ item, title: item.title, surface: item.surface_id })),
      // A branch's clinical action is separate from the heading of its outcome slide.
      ...list(doc.decisions).flatMap(decision => list(decision.paths).map(item => ({ item, title: surfaces.get(item.reveal_surface_id)?.title, surface: item.reveal_surface_id }))),
      ...list(doc.clarifications).map(item => ({ item, title: item.label, surface: item.surface_id }))];
  };
  const current = owners(document), was = new Map(owners(before).map(owner => [owner.item.id, owner.title])), single = new Map();
  for (const owner of current) single.set(owner.surface, single.has(owner.surface) ? null : owner.item.id);
  const blocks = new Map(), titles = new Map(), names = new Map(), nowHeadings = leadHeadings(document), thenHeadings = leadHeadings(before);
  for (const owner of current) {
    if (single.get(owner.surface) !== owner.item.id || !was.has(owner.item.id)) continue;
    const now = nowHeadings.get(owner.item.id), then = thenHeadings.get(owner.item.id);
    if (!now) continue;
    if (was.get(owner.item.id) !== owner.title && typeof owner.title === 'string' && then?.text === now.text) {
      blocks.set(now.block.id, owner.title); titles.set(owner.surface, owner.title);
    } else if (then && then.block.id === now.block.id && then.text !== now.text) {
      titles.set(owner.surface, now.text); names.set(owner.item.id, now.text);
    }
  }
  if (!blocks.size && !titles.size && !names.size) return document;
  const named = item => names.has(item.id) ? { ...item, label: names.get(item.id) } : item;
  return { ...document,
    beats: document.beats.map(beat => names.has(beat.id) ? { ...beat, title: names.get(beat.id) } : beat),
    ...(document.clarifications ? { clarifications: document.clarifications.map(named) } : {}),
    blocks: document.blocks.map(block => blocks.has(block.id) ? { ...block, paragraphs: [{ ...block.paragraphs[0], runs: [{ text: blocks.get(block.id) }] }] } : block),
    surfaces: document.surfaces.map(surface => titles.has(surface.id) ? { ...surface, title: titles.get(surface.id) } : surface) };
}

// Source-trace targets on slide content (D7): each block and its rows, entries and columns, named by its slide, kind and
// first words, so the trace editor never shows a block trace without a target.
const BLOCK_WORDS = { text: 'Text', list: 'List', quote: 'Quote', callout: 'Callout', values: 'Values', table: 'Table', timeline: 'Timeline', trend: 'Trend chart', image: 'Image', gas: 'Blood gas', question: 'Question' };
const NOT_TEXT = new Set(['id', 'type', 'style', 'width', 'align', 'decision_id', 'header_row', 'first_column_header', 'ordered', 'scale', 'asset_id', 'fit', 'sample']);
const CHILDREN = [['rows', 'row'], ['entries', 'entry'], ['columns', 'column'], ['points', 'point'], ['series', 'series'], ['groups', 'group']];
// A blood gas's rows sit one level deeper, inside its groups (CASE-311).
const groupRows = block => (Array.isArray(block?.groups) ? block.groups : []).flatMap(group => (Array.isArray(group?.rows) ? group.rows : []).map((row, at) => ({ row, at, group })));
const textOf = value => typeof value === 'string' ? value : Array.isArray(value) ? value.map(textOf).filter(Boolean).join(' ')
  : value && typeof value === 'object' ? Object.entries(value).filter(([key]) => !NOT_TEXT.has(key)).map(([, item]) => textOf(item)).filter(Boolean).join(' ') : '';
const clip = text => { const words = text.replace(/\s+/g, ' ').trim(); return words.length > 40 ? `${words.slice(0, 39).trimEnd()}…` : words; };
function slideName(document, blockId) {
  const owner = (document.compositions ?? []).find(item => item?.reading_order?.includes(blockId))?.owner, find = (items, id) => (items ?? []).find(item => item.id === id);
  const name = owner?.kind === 'beat' ? find(document.beats, owner.id)?.title || 'Untitled stage' : owner?.kind === 'path' ? find((document.decisions ?? []).flatMap(item => item.paths ?? []), owner.id)?.label || 'Untitled consequence'
    : owner?.kind === 'clarification' ? find(document.clarifications, owner.id)?.label || 'Untitled clarification' : null;
  return name ? `Slide · ${name}` : 'Block not on a slide';
}
export function traceTargets(document) {
  const targets = [];
  for (const block of document?.blocks ?? []) {
    if (!block?.id) continue;
    const home = slideName(document, block.id), kind = BLOCK_WORDS[block.type] ?? 'Block', named = value => { const words = clip(textOf(value)); return words ? ` · “${words}”` : ''; };
    targets.push({ id: block.id, kind: 'block', label: `${home} · ${kind}${named(block)}` });
    for (const [key, noun] of CHILDREN) for (const [at, child] of (Array.isArray(block[key]) ? block[key] : []).entries())
      if (child?.id) targets.push({ id: child.id, kind: 'block', label: `${home} · ${kind} ${noun} ${at + 1}${named(child)}` });
    for (const { row, at, group } of groupRows(block)) if (row?.id) targets.push({ id: row.id, kind: 'block', label: `${home} · ${kind} ${group.label || 'group'} row ${at + 1}${named(row)}` });
  }
  return targets;
}
/** The text fields a trace on a block (or one of its rows, entries or columns) can point at. */
export function traceFields(entity, document) {
  const record = (document?.blocks ?? []).flatMap(block => [block, ...CHILDREN.flatMap(([key]) => Array.isArray(block?.[key]) ? block[key] : []), ...groupRows(block).map(item => item.row)]).find(item => item?.id === entity?.id);
  const fields = [];
  for (const [key, value] of Object.entries(record ?? {})) {
    if (NOT_TEXT.has(key) || CHILDREN.some(([name]) => name === key)) continue;
    if (typeof value === 'string') fields.push(key);
    else if (Array.isArray(value)) for (const [index] of value.entries()) fields.push(`${key}[${index}]`);
  }
  return fields;
}

// ── "+" areas, settling, replacing, synced blocks and callout icons (CASE-344) ──────────────────────────────────
/** The smallest empty area that offers a "+": two rows by three columns (prototypes/builder-simplify.html). */
export const FREE_AREA_MIN = Object.freeze({ w: 3, h: 2 });
/**
 * The empty areas of a slide, largest first: repeatedly the largest empty rectangle of the 12 × 12 grid (row by row, the
 * first found wins a tie), until none of at least FREE_AREA_MIN is left. Areas never overlap a block or each other.
 */
export function freeAreas(placements) {
  const taken = Array.from({ length: SLIDE_GRID }, () => Array(SLIDE_GRID).fill(false)), areas = [];
  const mark = ({ col, row, w, h }) => { for (let y = row; y < row + h; y++) for (let x = col; x < col + w; x++) if (y >= 1 && y <= SLIDE_GRID && x >= 1 && x <= SLIDE_GRID) taken[y - 1][x - 1] = true; };
  for (const item of Array.isArray(placements) ? placements : []) mark(item);
  for (;;) {
    let best = null;
    for (let r = 0; r < SLIDE_GRID; r++) for (let c = 0; c < SLIDE_GRID; c++) {
      if (taken[r][c]) continue;
      let maxW = SLIDE_GRID - c;
      for (let h = 1; r + h <= SLIDE_GRID; h++) {
        let w = 0; while (w < maxW && !taken[r + h - 1][c + w]) w++;
        maxW = w; if (!w) break;
        if (w >= FREE_AREA_MIN.w && h >= FREE_AREA_MIN.h && (!best || w * h > best.w * best.h)) best = { col: c + 1, row: r + 1, w, h };
      }
    }
    if (!best) return areas;
    areas.push(best); mark(best);
  }
}

/**
 * Where a block of `kind` settles inside the area it was born in (prototypes/builder-simplify.html, "How each kind settles"):
 * always the area's width, from its top-left corner, never taller than the area. Text takes its lines plus one (at least
 * one row), a callout up to three rows, values, a timeline and a table their rows (at least five), a blood gas up to nine;
 * a chart, an image and a question take the whole area. `block`, when given, supplies the lines or rows.
 */
export function settle(kind, area, block = null) {
  const { col, row, w, h } = area;
  const count = list => (Array.isArray(list) ? list.length : 0);
  // About five characters per grid column: a full-width line holds sixty.
  const lines = list => (Array.isArray(list) && list.length ? list : [{ runs: [] }]).reduce((n, item) => n + Math.max(1, Math.ceil(paragraphsText([item]).length / (5 * w))), 0);
  const height = kind === 'text' || kind === 'heading' || kind === 'list' || kind === 'quote' ? Math.max(1, Math.min(h, lines(block?.paragraphs ?? block?.items) + 1))
    : kind === 'callout' ? Math.min(h, 3)
    : kind === 'values' ? Math.min(h, Math.max(5, count(block?.rows) + 1))
    : kind === 'timeline' ? Math.min(h, Math.max(5, count(block?.entries) + 1))
    : kind === 'table' ? Math.min(h, Math.max(5, count(block?.rows) + (block?.header_row ? 2 : 1)))
    : kind === 'gas' ? Math.min(h, 9)
    : h;
  return { col, row, w, h: height };
}

const WRITING_KINDS = ['text', 'quote', 'callout', 'list'];
/**
 * Replace a block with a new one of `kind` in the same place: its identity, placement, reveal step, reading position and
 * slide styles stay (a non-table sheds the table-only ones), so every source trace whose field still exists stays valid
 * through carryProvenance. Between writing kinds the words are kept, line by line; any other kind starts from its starter.
 * A block on several slides changes on all of them, so that needs `confirmed`. A question stays bound to its decision.
 */
export function replaceBlock(document, compositionId, blockId, kind, createId, { confirmed = false, ...options } = {}) {
  return edit(document, compositionId, (next, composition) => {
    const index = next.blocks.findIndex(item => item?.id === blockId), block = next.blocks[index];
    if (!block || !composition.reading_order.includes(blockId)) return refuse('That block is not on this slide.');
    if (block.type === 'question') return refuse('A question stays bound to its decision.');
    if (block.type === kind) return refuse('The block is already that type.');
    const uses = usesOf(next, blockId).length;
    if (uses > 1 && !confirmed) return { ok: false, review: true, reason: `This block is on ${uses} slides; replacing it changes all of them. Confirm to continue.` };
    const { block: made, reason } = makeBlock(next, composition, kind, createId, options);
    if (!made) return refuse(reason);
    const replacement = { ...made, id: blockId };
    if (WRITING_KINDS.includes(block.type) && WRITING_KINDS.includes(replacement.type)) {
      const lines = block.type === 'list' ? block.items.map(item => ({ style: 'p', runs: item.runs })) : block.paragraphs.map(item => ({ style: item.style ?? 'p', runs: item.runs }));
      if (replacement.type === 'list') replacement.items = lines.map(item => ({ runs: item.runs }));
      else replacement.paragraphs = lines.map(item => replacement.type === 'text' ? { style: kind === 'heading' && item.style === 'p' ? 'h2' : item.style, runs: item.runs } : { runs: item.runs });
    }
    next.blocks[index] = replacement;
    if (replacement.type !== 'table') shedTableStyles(next, blockId);
    return { ok: true, document: next, blockId };
  });
}

/**
 * Show a block on other slides too (a synced block): one shared block, so an edit on any slide changes every one. Each
 * slide that gains it gets its own new last reveal step and its own placement, settled into its largest free area that
 * fits the block (else it waits unplaced), and the block's slide style from where it is first used. Slides already
 * showing it are left as they are. A question shows its own stage's decision and is never shared.
 */
export function shareBlock(document, blockId, compositionIds, createId) {
  const next = structuredClone(document), block = byId(next.blocks, blockId);
  if (!block) return refuse('That block no longer exists.');
  if (block.type === 'question') return refuse('A question shows its own stage’s decision; it cannot be shown on other slides.');
  const first = usesOf(next, blockId)[0], style = first?.styles?.find(item => item.block_id === blockId), added = [];
  for (const id of Array.isArray(compositionIds) ? compositionIds : []) {
    const composition = byId(next.compositions, id);
    if (!composition) return refuse('One of those slides no longer exists.');
    if (composition.reading_order.includes(blockId)) continue;
    if (composition.reading_order.length >= SLIDE_LIMITS.compositionBlocks) return refuse(`A slide holds at most ${SLIDE_LIMITS.compositionBlocks} blocks.`);
    if (composition.steps.length >= SLIDE_LIMITS.compositionSteps) return refuse(`A slide has at most ${SLIDE_LIMITS.compositionSteps} reveal steps.`);
    composition.steps.push({ id: createId(), block_ids: [blockId] });
    composition.reading_order.push(blockId);
    const need = blockNeeds(block), areas = freeAreas(composition.placements), area = areas.find(item => item.w >= need.minW && item.h >= need.minH);
    if (area) composition.placements.push({ block_id: blockId, ...settle(block.type, area, block) });
    if (style) (composition.styles ??= []).push({ ...structuredClone(style), block_id: blockId });
    added.push(id);
  }
  return { ok: true, document: next, added };
}

/**
 * Unsync this slide: it gets its own copy of a shared block, with fresh identities for the block and every row, column
 * and entry in it, in the same placement, step, reading position and style; every other slide keeps the shared block.
 * Source traces on the shared block are copied to the new identities (`metadata` in, `metadata` out).
 */
export function unshareBlock(document, compositionId, blockId, createId, { metadata = null } = {}) {
  return edit(document, compositionId, (next, composition) => {
    const source = byId(next.blocks, blockId);
    if (!source || !composition.reading_order.includes(blockId)) return refuse('That block is not on this slide.');
    if (usesOf(next, blockId).length < 2) return refuse('This block is only on this slide.');
    const copy = structuredClone(source), ids = freshIdentities(copy, createId), swap = id => id === blockId ? copy.id : id;
    next.blocks.push(copy);
    for (const step of composition.steps) step.block_ids = step.block_ids.map(swap);
    composition.reading_order = composition.reading_order.map(swap);
    for (const item of [...composition.placements, ...(composition.styles ?? [])]) if (item.block_id === blockId) item.block_id = copy.id;
    const entries = Array.isArray(metadata?.provenance) ? metadata.provenance : [];
    const copied = entries.filter(entry => ids.has(entry?.entity_id)).map(entry => ({ ...entry, entity_id: ids.get(entry.entity_id) }));
    return { ok: true, document: next, blockId: copy.id, metadata: copied.length ? { ...metadata, provenance: [...entries, ...copied] } : metadata };
  });
}

const withCalloutIcons = next => { next.required_capabilities = [...new Set([...(Array.isArray(next.required_capabilities) ? next.required_capabilities : []), CALLOUT_ICON_CAPABILITY])]; };
/**
 * The edit-time conversion of a quote (CASE-344): when its author edits it, a quote becomes a Plain callout with the quote
 * icon (no fill on any slide), its words and identity unchanged. Any other block, or a quote nobody edits, is left alone:
 * nothing converts on load, and published versions keep their quotes. Returns the same document when there is nothing to do.
 */
export function convertQuote(document, blockId) {
  if (byId(document?.blocks, blockId)?.type !== 'quote') return done(document);
  const { next, block } = ownBlock(document, blockId);
  block.type = 'callout'; block.paragraphs = block.paragraphs.map(item => ({ runs: item.runs })); block.icon = 'quote';
  next.compositions = next.compositions.map(composition => composition.styles?.some(item => item.block_id === blockId && 'tone' in item)
    ? { ...composition, styles: composition.styles.map(item => { if (item.block_id !== blockId) return item; const { tone, ...rest } = item; return rest; }) } : composition);
  withCalloutIcons(next);
  return { ok: true, document: next, converted: true };
}

/** A callout's icon, one of CALLOUT_ICONS ('none' for none); editing a quote's icon converts it first. */
export function setCalloutIcon(document, blockId, icon) {
  if (!CALLOUT_ICONS.includes(icon)) return refuse('Unknown icon.');
  const type = byId(document?.blocks, blockId)?.type;
  if (type !== 'callout' && type !== 'quote') return refuse('Only a callout has an icon.');
  const { next, block } = ownBlock(convertQuote(document, blockId).document, blockId);
  block.icon = icon;
  withCalloutIcons(next);
  return done(next);
}
