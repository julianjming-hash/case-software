// The authored surface stays whole on the facilitator device. Public roles receive only the
// groups the room authority has deliberately revealed. Asset IDs remain private until a
// visible media delivery contract exists; no invisible group consumes a reveal press.
import { gasVisible } from './slide-gas-view.mjs';
import { populatedPresentationGroups } from './presentation-order.mjs';
import { slideHero } from './slide-hero.mjs';
export { PRESENTATION_GROUPS, populatedPresentationGroups } from './presentation-order.mjs';

export function publicPresentationSurface(surface, shown) {
  if (surface.slide) return publicSlideSurface(surface, shown);
  const groups = populatedPresentationGroups(surface);
  const count = Number.isSafeInteger(shown) && shown >= 0 ? Math.min(shown, groups.length) : 0;
  const visible = new Set(groups.slice(0, count));
  return {
    surfaceId: surface.surfaceId,
    kind: surface.kind,
    title: surface.title,
    scene: visible.has('scene') ? surface.scene : null,
    assetIds: [],
    observations: visible.has('observations') ? surface.observations : [],
    points: visible.has('findings') ? surface.points : [],
    investigations: visible.has('investigations') ? surface.investigations : [],
    timelineKind: surface.timelineKind,
    manual: surface.manual,
    at: surface.at,
  };
}

/**
 * Slides (card 57): only blocks of the first `shown` non-empty steps, with only their placements, reading order and
 * styles. No step identity or count, no composition or owner identity, no unreleased block, placement or name.
 */
// Public fields per block type: a second layer under schema-3 validation, so no unexpected field is ever forwarded.
const PUBLIC_BLOCK_FIELDS = { text: ['paragraphs'], list: ['ordered', 'items'], quote: ['paragraphs'], callout: ['paragraphs', 'icon'], values: ['rows'],
  table: ['caption', 'header_row', 'first_column_header', 'columns', 'rows'], timeline: ['entries'],
  image: ['alt', 'caption', 'fit', 'ecg', 'media'],
  trend: 'caption x_label x_unit y_label y_unit y_min y_max scale style values_shown points series'.split(' '),
  gas: ['sample', 'caption', 'groups', 'compare'], question: [] };
const publicBlock = block => Object.fromEntries([['id', block.id], ['type', block.type], ...(PUBLIC_BLOCK_FIELDS[block.type] ?? []).filter(key => key in block).map(key => [key, block[key]]),
  // A blood gas (CASE-311) carries only the rows the room sees: an empty row's label, unit and range stay with the author.
  // In compare mode (CASE-317) a row is seen when any sample has a reading; its earlier readings are columns of this slide.
  ...(block.type === 'gas' ? [['groups', gasVisible(block)]] : [])]);

function publicSlideSurface(surface, shown) {
  // An already-public slide row (no composition) passes through unchanged; it holds only released content.
  if (!surface.slide.composition) return surface;
  const { composition, blocks } = surface.slide;
  const steps = composition.steps.filter(step => step.block_ids.length > 0);
  const count = Number.isSafeInteger(shown) && shown >= 0 ? Math.min(shown, steps.length) : 0;
  const released = new Set(steps.slice(0, count).flatMap(step => step.block_ids));
  const keep = item => released.has(item.block_id);
  const hero = slideHero(composition, id => blocks.find(block => block.id === id));
  return {
    surfaceId: surface.surfaceId, kind: surface.kind, title: surface.title, assetIds: [],
    slide: { template: composition.template,
      // A question block is only a slot; its decision arrives through the existing round lifecycle.
      blocks: blocks.filter(block => released.has(block.id) && Object.hasOwn(PUBLIC_BLOCK_FIELDS, block.type)).map(publicBlock),
      placements: composition.placements.filter(keep), reading_order: composition.reading_order.filter(id => released.has(id)),
      styles: (composition.styles ?? []).filter(keep), ...(surface.slide.theme ? { theme: surface.slide.theme } : {}),
      // A whole-slide fill (CASE-312) is sent only when set, so a case without one reaches an older projector unchanged.
      ...(composition.fill ? { fill: composition.fill } : {}),
      // D23 hero (CASE-264): only once its block is released, when the title (if any) is too, so no step is foretold.
      ...(hero && released.has(hero.block_id) ? { hero } : {}) },
    timelineKind: surface.timelineKind, manual: surface.manual, at: surface.at,
  };
}
