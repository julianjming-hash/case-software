// Hero slides (D23, CASE-264). A slide whose whole content is one block, or a title and one block, shows that block
// large: it takes every row under the title, centred across the slide, and the fit pass grows its text (HERO_CAP in
// slide-render.mjs). It is decided on the full composition (every step), never on the visible prefix, so nothing re-flows as steps are
// revealed (fixed placement during reveal). A title must be revealed no later than its block, so when the hero block is
// released the whole slide is, and the public projection's `hero` field says nothing about unreleased steps.

/** The author's per-slide choices, stored on the composition only when not the default (on, top). */
export const HERO_SETTINGS = Object.freeze(['off', 'centred']);

const headingsOnly = block => block?.type === 'text' && Array.isArray(block.paragraphs) && block.paragraphs.length > 0 && block.paragraphs.every(item => item.style !== 'p');

/**
 * The hero of a full composition, or null. `blockOf(id)` returns a block or undefined (callers may know only released
 * blocks: the title is always released no later than the hero block). Returns { block_id, title_id, row, align }:
 * the hero area runs from grid line `row` to the bottom, across the whole slide.
 */
export function slideHero(composition, blockOf) {
  if (!composition || composition.hero === 'off') return null;
  const order = Array.isArray(composition.reading_order) ? composition.reading_order : [];
  if (order.length < 1 || order.length > 2) return null;
  const placements = new Map((composition.placements ?? []).map(item => [item.block_id, item]));
  if (!order.every(id => placements.has(id))) return null;
  let title = null, body = order[0];
  if (order.length === 2) {
    if (!headingsOnly(blockOf(order[0]))) return null;
    const stepOf = id => (composition.steps ?? []).findIndex(step => step.block_ids?.includes(id));
    [title, body] = order;
    if (stepOf(title) < 0 || stepOf(body) < 0 || stepOf(title) > stepOf(body)) return null;
  }
  const row = title ? placements.get(title).row + placements.get(title).h : 1;
  if (row > 12) return null;
  return { block_id: body, title_id: title, row, align: composition.hero === 'centred' ? 'centred' : 'top' };
}
