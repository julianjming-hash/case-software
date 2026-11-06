// Schema-3 slide contract (card 56, CASE-210). Shared semantic blocks are referenced by per-occurrence compositions
// that own grid placement, reading order, grouped reveal steps and presentation. Validation never repairs or reorders.
import { isUuidV7 } from './ids.mjs';
import { CALLOUT_ICONS, CALLOUT_ICON_CAPABILITY, CALLOUT_TONES, INK_TONES, RUN_SCRIPTS, SLIDE_FILLS, paragraphsText } from './slide-text.mjs';
import { SLIDE_THEMES } from './slide-themes.mjs';
import { validateTrend } from './slide-trend.mjs';
import { validateGas } from './slide-gas.mjs';
import { validateImage } from './slide-image.mjs';
import { HERO_SETTINGS } from './slide-hero.mjs';

export { CALLOUT_ICONS, CALLOUT_ICON_CAPABILITY, CALLOUT_TONES, SLIDE_FILLS, paragraphsText };

export const SLIDE_BLOCK_TYPES = Object.freeze(['text', 'list', 'quote', 'callout', 'values', 'table', 'timeline', 'trend', 'image', 'gas', 'question']);
export const PARAGRAPH_STYLES = Object.freeze(['p', 'h1', 'h2', 'h3', 'h4']);
export const SLIDE_TEMPLATES = Object.freeze(['bento', 'story', 'columns', 'title_text', 'blank']);
export const COMPOSITION_OWNERS = Object.freeze(['beat', 'path', 'clarification']);
export const SLIDE_GRID = 12;
/** Proposed bounds approved as the starting contract (CASE-210); existing document caps still apply on top. */
export const SLIDE_LIMITS = Object.freeze({
  documentBlocks: 600, compositionBlocks: 32, compositionSteps: 32,
  // Text-bearing blocks reuse the existing formatted-text caps (64 blocks, 256 items, 1024 runs) so converting any valid
  // legacy scene is lossless. A list keeps the legacy findings allowance: 8 points × 100 characters, separators excluded.
  textChars: 500, listChars: 800, paragraphs: 64, runs: 1024, listItems: 256,
  tableRows: 32, tableColumns: 12, cellChars: 500, columnLabel: 120, caption: 200, unit: 40, tableBytes: 64 * 1024,
  valueRows: 24, valueLabel: 120, valueValue: 120,
  timelineEntries: 32, timelineLabel: 120,
  // Trend charts (card 59 M1, CASE-263; slide-trend.mjs): authored numbers only, kept as exact text so 7.30 stays 7.30.
  trendSeries: 4, trendPoints: 24, trendLabel: 120, trendPointLabel: 40,
  // CASE-212 (G11): public content one slide can release, so one reveal to 300 phones stays small (about 9.4 MiB).
  publicBytes: 32 * 1024,
});

const unsafeText = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩﻿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const record = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const BLOCK_KEYS = {
  text: ['paragraphs'], list: ['ordered', 'items'], quote: ['paragraphs'], callout: ['paragraphs', 'icon'], values: ['rows'],
  table: ['caption', 'header_row', 'first_column_header', 'columns', 'rows'], timeline: ['entries'], question: ['decision_id'],
  image: ['asset_id', 'alt', 'caption', 'fit', 'ecg'],
  trend: ['caption', 'x_label', 'x_unit', 'y_label', 'y_unit', 'y_min', 'y_max', 'scale', 'style', 'values_shown', 'points', 'series'],
  gas: ['sample', 'caption', 'groups', 'compare'],
};

/** Plain learner text of a list's items, without separators, for the list bound only. */
const itemsText = items => (Array.isArray(items) ? items : []).map(item => (Array.isArray(item?.runs) ? item.runs : []).map(run => typeof run?.text === 'string' ? run.text : '').join('')).join('');

/**
 * Validate `blocks` and `compositions` of a schema-3 document. `identities` is the document-wide id set the caller
 * already claimed; slide ids join it so no id is reused across records. Returns issues; it never mutates.
 */
export function validateSlideParts(doc, { mode = 'preserve', identities = new Set() } = {}) {
  const errors = [], warnings = [];
  const fail = (code, at, message) => errors.push({ code, at, message });
  const flag = (code, at, message) => (mode === 'ready' ? errors : warnings).push({ code, at, message });
  const blocks = new Map(), uses = new Map();
  const claim = (id, at) => {
    // New slide records are always minted by the shared UUIDv7 helper (hard rule 3).
    if (typeof id !== 'string' || !isUuidV7(id)) { fail('bad_id', at, 'must be a lower-case UUIDv7'); return false; }
    if (identities.has(id)) { fail('duplicate_id', at, 'document identity is duplicated'); return false; }
    identities.add(id); return true;
  };
  const keys = (value, allowed, at) => { for (const key of Object.keys(value)) if (!allowed.includes(key)) fail('unknown_key', `${at}/${key}`, 'unknown slide field'); };
  const text = (value, at, max, min = 0) => {
    if (typeof value !== 'string') { fail('type', at, 'must be text'); return 0; }
    if (unsafeText.test(value)) fail('unsafe_characters', at, 'contains unsafe control or bidirectional characters');
    if (value.length > max) fail('too_long', at, `must be at most ${max} characters`);
    if (value.length < min) flag('required', at, 'needs text');
    return value.length;
  };
  const runs = (value, at) => {
    if (!Array.isArray(value)) { fail('type', at, 'must be an array of text runs'); return 0; }
    value.forEach((run, index) => {
      const runAt = `${at}/${index}`;
      if (!record(run)) { fail('type', runAt, 'must be a text-run object'); return; }
      keys(run, ['text', 'bold', 'script'], runAt);
      text(run.text, `${runAt}/text`, SLIDE_LIMITS.textChars);
      if (run.bold !== undefined && typeof run.bold !== 'boolean') fail('type', `${runAt}/bold`, 'must be a boolean when present');
      if (run.script !== undefined && !RUN_SCRIPTS.includes(run.script)) fail('enum', `${runAt}/script`, 'sub or sup when present');
    });
    return value.length;
  };
  const paragraphs = (value, at, styled) => {
    if (!Array.isArray(value) || !value.length) { fail('type', at, 'must be a non-empty array of paragraphs'); return; }
    if (value.length > SLIDE_LIMITS.paragraphs) fail('too_many', at, `must have at most ${SLIDE_LIMITS.paragraphs} paragraphs`);
    let count = 0;
    value.forEach((paragraph, index) => {
      const paragraphAt = `${at}/${index}`;
      if (!record(paragraph)) { fail('type', paragraphAt, 'must be a paragraph object'); return; }
      keys(paragraph, styled ? ['style', 'runs'] : ['runs'], paragraphAt);
      if (styled && !PARAGRAPH_STYLES.includes(paragraph.style)) fail('enum', `${paragraphAt}/style`, `one of ${PARAGRAPH_STYLES.join(', ')}`);
      count += runs(paragraph.runs, `${paragraphAt}/runs`);
    });
    if (count > SLIDE_LIMITS.runs) fail('too_many_runs', at, `must have at most ${SLIDE_LIMITS.runs} runs`);
    // A block keeps the 500-unit free-text convention; splitting text across blocks is an explicit authoring act.
    if (paragraphsText(value).length > SLIDE_LIMITS.textChars) fail('too_long', at, `block text must be at most ${SLIDE_LIMITS.textChars} characters`);
    if (!paragraphsText(value).trim()) flag('empty_block', at, 'add learner text or remove the block');
  };
  const rows = (value, at, max, check) => {
    if (!Array.isArray(value) || !value.length) { fail('type', at, 'must be a non-empty array'); return; }
    if (value.length > max) fail('too_many', at, `must have at most ${max} rows`);
    value.forEach((row, index) => { const rowAt = `${at}/${index}`; if (!record(row)) fail('type', rowAt, 'must be an object'); else check(row, rowAt); });
  };

  // ── presentation theme (CASE-227): optional, one of the named themes ──
  if (doc.theme !== undefined && !Object.hasOwn(SLIDE_THEMES, doc.theme)) fail('enum', '/theme', `one of ${Object.keys(SLIDE_THEMES).join(', ')} when present`);

  // ── blocks ──
  const blockList = doc.blocks;
  if (!Array.isArray(blockList)) fail('type', '/blocks', 'must be an array');
  else {
    if (blockList.length > SLIDE_LIMITS.documentBlocks) fail('too_many', '/blocks', `must have at most ${SLIDE_LIMITS.documentBlocks} blocks`);
    blockList.forEach((block, index) => {
      const at = `/blocks/${index}`;
      if (!record(block)) { fail('type', at, 'must be a block object'); return; }
      if (!SLIDE_BLOCK_TYPES.includes(block.type)) { fail('enum', `${at}/type`, `one of ${SLIDE_BLOCK_TYPES.join(', ')}`); return; }
      keys(block, ['id', 'type', ...BLOCK_KEYS[block.type]], at);
      if (claim(block.id, `${at}/id`)) blocks.set(block.id, { block, at });
      validateBlock(block, at);
    });
  }

  function validateBlock(block, at) {
    if (block.type === 'text') paragraphs(block.paragraphs, `${at}/paragraphs`, true);
    else if (block.type === 'quote' || block.type === 'callout') {
      paragraphs(block.paragraphs, `${at}/paragraphs`, false);
      // CASE-344: a callout's icon is one of a closed set (builder-document.mjs requires the callout_icon capability for it).
      // A quote stays valid for published versions; it becomes a callout only when its author edits it (slide-edit.mjs).
      if (block.type === 'callout' && 'icon' in block && !CALLOUT_ICONS.includes(block.icon)) fail('enum', `${at}/icon`, `one of ${CALLOUT_ICONS.join(', ')}`);
    }
    else if (block.type === 'list') {
      if (typeof block.ordered !== 'boolean') fail('type', `${at}/ordered`, 'must be a boolean');
      rows(block.items, `${at}/items`, SLIDE_LIMITS.listItems, (item, itemAt) => {
        keys(item, ['runs'], itemAt); runs(item.runs, `${itemAt}/runs`);
        if (!itemsText([item]).trim()) flag('empty_item', itemAt, 'a list item needs text');
      });
      if (Array.isArray(block.items) && itemsText(block.items).length > SLIDE_LIMITS.listChars) fail('too_long', `${at}/items`, `list text must be at most ${SLIDE_LIMITS.listChars} characters`);
    } else if (block.type === 'values') rows(block.rows, `${at}/rows`, SLIDE_LIMITS.valueRows, (row, rowAt) => {
      keys(row, ['id', 'label', 'value', 'unit'], rowAt); claim(row.id, `${rowAt}/id`);
      text(row.label, `${rowAt}/label`, SLIDE_LIMITS.valueLabel, 1); text(row.value, `${rowAt}/value`, SLIDE_LIMITS.valueValue, 1); text(row.unit, `${rowAt}/unit`, SLIDE_LIMITS.unit);
    });
    else if (block.type === 'timeline') rows(block.entries, `${at}/entries`, SLIDE_LIMITS.timelineEntries, (entry, entryAt) => {
      keys(entry, ['id', 'label', 'text'], entryAt); claim(entry.id, `${entryAt}/id`);
      text(entry.label, `${entryAt}/label`, SLIDE_LIMITS.timelineLabel, 1); text(entry.text, `${entryAt}/text`, SLIDE_LIMITS.textChars, 1);
    });
    else if (block.type === 'question') { if (typeof block.decision_id !== 'string') fail('bad_id', `${at}/decision_id`, 'must reference a decision'); }
    else if (block.type === 'trend') validateTrend(block, at, { text, rows, keys, claim, fail, flag }, SLIDE_LIMITS);
    else if (block.type === 'image') validateImage(block, at, { text, keys, fail });
    else if (block.type === 'gas') validateGas(block, at, { text, rows, keys, claim, fail, flag });
    else if (block.type === 'table') validateTable(block, at);
  }

  function validateTable(table, at) {
    if (table.caption !== undefined) text(table.caption, `${at}/caption`, SLIDE_LIMITS.caption);
    for (const key of ['header_row', 'first_column_header']) if (typeof table[key] !== 'boolean') fail('type', `${at}/${key}`, 'must be a boolean');
    rows(table.columns, `${at}/columns`, SLIDE_LIMITS.tableColumns, (column, columnAt) => {
      keys(column, ['id', 'label', 'width', 'align', 'unit'], columnAt); claim(column.id, `${columnAt}/id`);
      text(column.label, `${columnAt}/label`, SLIDE_LIMITS.columnLabel);
      // With header semantics off no label text may remain hidden: turning headers off moves it into a visible row.
      if (table.header_row === false && typeof column.label === 'string' && column.label !== '') fail('hidden_header_text', `${columnAt}/label`, 'column labels must be empty when the header row is off');
      if (!Number.isInteger(column.width) || column.width < 1 || column.width > 6) fail('range', `${columnAt}/width`, 'must be an integer from 1 to 6');
      if (!['start', 'end'].includes(column.align)) fail('enum', `${columnAt}/align`, 'one of start, end');
      if (column.unit !== undefined) text(column.unit, `${columnAt}/unit`, SLIDE_LIMITS.unit);
    });
    const width = Array.isArray(table.columns) ? table.columns.length : 0;
    rows(table.rows, `${at}/rows`, SLIDE_LIMITS.tableRows, (row, rowAt) => {
      keys(row, ['id', 'cells'], rowAt); claim(row.id, `${rowAt}/id`);
      // Cells are exact strings addressed by (row id, column id); blanks are kept, shape is never padded or trimmed.
      if (!Array.isArray(row.cells) || row.cells.length !== width) { fail('table_shape', `${rowAt}/cells`, `must have exactly one cell per column (${width})`); return; }
      row.cells.forEach((cell, index) => text(cell, `${rowAt}/cells/${index}`, SLIDE_LIMITS.cellChars));
    });
    // Blank cells are valid data; a table with no text at all is not ready to show.
    const filled = row => row?.cells?.some?.(cell => typeof cell === 'string' && cell.trim()), list = table.rows;
    if (Array.isArray(list) && !list.some(filled)) flag('empty_block', at, 'add table content or remove the table');
    // Empty rows left at the end (a row added by Tab, say) draw as a blank card on phones and an empty rule on the
    // projector (critique r23–r25): advice in every mode, never a stop, as a blank cell inside the table is valid data.
    else if (Array.isArray(list)) {
      let n = list.length; while (!filled(list[n - 1])) n--;
      if (n < list.length) warnings.push({ code: 'empty_table_row', at: `${at}/rows/${n}`, message: 'remove the empty rows at the end' });
    }
    if (new TextEncoder().encode(JSON.stringify(table)).byteLength > SLIDE_LIMITS.tableBytes) fail('too_large', at, `table exceeds ${SLIDE_LIMITS.tableBytes} serialized bytes`);
  }

  // ── compositions ──
  const owners = ownerIndex(doc), seenOwners = new Set();
  const compositions = doc.compositions;
  if (!Array.isArray(compositions)) fail('type', '/compositions', 'must be an array');
  else compositions.forEach((composition, index) => {
    const at = `/compositions/${index}`;
    if (!record(composition)) { fail('type', at, 'must be a composition object'); return; }
    keys(composition, ['id', 'owner', 'template', 'placements', 'reading_order', 'steps', 'styles', 'hero', 'fill'], at);
    claim(composition.id, `${at}/id`);
    const owner = composition.owner;
    if (!record(owner) || !COMPOSITION_OWNERS.includes(owner.kind) || !owners[owner.kind]?.has(owner.id)) fail('ref', `${at}/owner`, 'must name an existing stage, consequence or clarification');
    else {
      keys(owner, ['kind', 'id'], `${at}/owner`);
      const key = `${owner.kind}:${owner.id}`;
      if (seenOwners.has(key)) fail('duplicate_owner', `${at}/owner`, 'each occurrence has at most one composition');
      seenOwners.add(key);
    }
    if (!SLIDE_TEMPLATES.includes(composition.template)) fail('enum', `${at}/template`, `one of ${SLIDE_TEMPLATES.join(', ')}`);
    // D23 hero (CASE-264): stored only when not the default (shown large, top-aligned).
    if ('hero' in composition && !HERO_SETTINGS.includes(composition.hero)) fail('enum', `${at}/hero`, `one of ${HERO_SETTINGS.join(', ')}`);
    // A whole-slide fill (CASE-312) is stored only when the slide has one.
    if ('fill' in composition && !SLIDE_FILLS.includes(composition.fill)) fail('enum', `${at}/fill`, `one of ${SLIDE_FILLS.join(', ')} when present`);
    validateComposition(composition, at);
  });
  // A block no composition references is preserved, never deleted; it simply cannot reach a learner.
  for (const [id, { at }] of blocks) if (!uses.has(id)) flag('orphan_block', at, 'block is not placed in any slide');
  return { errors, warnings, blocks, uses };

  function validateComposition(composition, at) {
    const members = new Map();
    // Steps: steps[0] is On entry. Every member belongs to exactly one step; empty later steps are preserved.
    if (!Array.isArray(composition.steps) || !composition.steps.length) fail('type', `${at}/steps`, 'must start with an On entry step');
    else {
      if (composition.steps.length > SLIDE_LIMITS.compositionSteps) fail('too_many', `${at}/steps`, `must have at most ${SLIDE_LIMITS.compositionSteps} steps`);
      composition.steps.forEach((step, index) => {
        const stepAt = `${at}/steps/${index}`;
        if (!record(step)) { fail('type', stepAt, 'must be a step object'); return; }
        keys(step, ['id', 'block_ids'], stepAt); claim(step.id, `${stepAt}/id`);
        if (!Array.isArray(step.block_ids)) { fail('type', `${stepAt}/block_ids`, 'must be an array of block ids'); return; }
        step.block_ids.forEach((id, position) => {
          const memberAt = `${stepAt}/block_ids/${position}`;
          if (!blocks.has(id)) fail('ref', memberAt, 'must reference a block');
          else if (members.has(id)) fail('duplicate_membership', memberAt, 'a block belongs to exactly one step');
          else members.set(id, index);
        });
      });
      if (!composition.steps[0]?.block_ids?.length) flag('empty_entry', `${at}/steps/0`, 'On entry needs at least one block');
    }
    if (members.size > SLIDE_LIMITS.compositionBlocks) fail('too_many', `${at}/steps`, `must have at most ${SLIDE_LIMITS.compositionBlocks} blocks`);
    for (const id of members.keys()) uses.set(id, [...(uses.get(id) ?? []), composition.id]);
    // Reading order is an explicit permutation of the members, independent of placement and reveal.
    const order = composition.reading_order;
    if (!Array.isArray(order) || order.length !== members.size || new Set(order).size !== order.length || order.some(id => !members.has(id)))
      fail('reading_order', `${at}/reading_order`, 'must list every block of this slide exactly once');
    // Placements: integral, inside the 12×12 grid, non-overlapping; an unplaced member is preserved but not ready.
    const cells = new Uint8Array(SLIDE_GRID * SLIDE_GRID), placed = new Set();
    if (!Array.isArray(composition.placements)) fail('type', `${at}/placements`, 'must be an array');
    else composition.placements.forEach((placement, index) => {
      const placeAt = `${at}/placements/${index}`;
      if (!record(placement)) { fail('type', placeAt, 'must be a placement object'); return; }
      keys(placement, ['block_id', 'col', 'row', 'w', 'h'], placeAt);
      if (!members.has(placement.block_id)) { fail('ref', `${placeAt}/block_id`, 'must reference a block of this slide'); return; }
      if (placed.has(placement.block_id)) { fail('duplicate_placement', `${placeAt}/block_id`, 'a block is placed at most once'); return; }
      placed.add(placement.block_id);
      const { col, row, w, h } = placement;
      if (![col, row, w, h].every(Number.isInteger) || col < 1 || row < 1 || w < 1 || h < 1 || col + w - 1 > SLIDE_GRID || row + h - 1 > SLIDE_GRID) {
        fail('placement_bounds', placeAt, `must be whole cells inside the ${SLIDE_GRID}×${SLIDE_GRID} grid`); return;
      }
      for (let x = col; x < col + w; x++) for (let y = row; y < row + h; y++) {
        if (cells[(x - 1) * SLIDE_GRID + y - 1]++) { fail('placement_overlap', placeAt, 'blocks may not overlap'); return; }
      }
    });
    for (const id of members.keys()) if (!placed.has(id)) flag('unplaced_block', `${at}/placements`, 'a block of this slide is not placed');
    // Styles are composition-local presentation. CASE-225: any block may have a fill (tone) and a text colour (ink).
    if (composition.styles !== undefined) {
      if (!Array.isArray(composition.styles)) fail('type', `${at}/styles`, 'must be an array');
      else {
        const styled = new Set();
        composition.styles.forEach((style, index) => {
          const styleAt = `${at}/styles/${index}`;
          if (!record(style)) { fail('type', styleAt, 'must be a style object'); return; }
          keys(style, ['block_id', 'tone', 'ink', 'align', 'padding', 'background', 'banded', 'density', 'text_size'], styleAt);
          if (!members.has(style.block_id) || styled.has(style.block_id)) { fail('ref', `${styleAt}/block_id`, 'must name one block of this slide once'); return; }
          styled.add(style.block_id);
          if (style.tone !== undefined && !Object.hasOwn(CALLOUT_TONES, style.tone)) fail('enum', `${styleAt}/tone`, 'a tone from the slide palette');
          if (style.ink !== undefined && !INK_TONES.includes(style.ink)) fail('enum', `${styleAt}/ink`, 'a text colour from the slide palette');
          if (style.align !== undefined && !['start', 'center', 'end'].includes(style.align)) fail('enum', `${styleAt}/align`, 'one of start, center, end');
          if (style.padding !== undefined && !['none', 'normal', 'roomy'].includes(style.padding)) fail('enum', `${styleAt}/padding`, 'one of none, normal, roomy');
          // CASE-220 amendment: a block background, and table presentation (banded rows, density, text size). Presentation
          // only, slide-local; table keys are meaningful only on a table.
          if (style.background !== undefined && !['soft', 'outline'].includes(style.background)) fail('enum', `${styleAt}/background`, 'one of soft, outline');
          const table = blocks.get(style.block_id).block.type === 'table';
          if (style.banded !== undefined && (style.banded !== true || !table)) fail('enum', `${styleAt}/banded`, 'true, on a table only');
          if (style.density !== undefined && (!['compact', 'roomy'].includes(style.density) || !table)) fail('enum', `${styleAt}/density`, 'compact or roomy, on a table only');
          if (style.text_size !== undefined && (style.text_size !== 'large' || !table)) fail('enum', `${styleAt}/text_size`, 'large, on a table only');
        });
      }
    }
    // A question binds the owner's own decision, once. It never creates a second active decision.
    const questions = [...members.keys()].filter(id => blocks.get(id).block.type === 'question');
    if (questions.length > 1) fail('question_count', `${at}/steps`, 'a slide binds at most one question');
    // A decision stage's slide must show its question somewhere, or the prompt and options have no place (BWR15).
    if (composition.owner?.kind === 'beat' && owners.decisionOf.get(composition.owner.id) && !questions.length) flag('question_missing', `${at}/steps`, 'add the decision question to this slide');
    // An early clarification is shown while its stage's question is open, so its slide may place that question too
    // (D15, CASE-258): only when every stage it is shown during asks that one decision.
    for (const id of questions) {
      const owner = composition.owner, decisionId = blocks.get(id).block.decision_id, stages = owners.stagesOf.get(owner?.id) ?? [];
      if (owner?.kind === 'beat' ? owners.decisionOf.get(owner.id) !== decisionId : owner?.kind !== 'clarification' || !stages.length || stages.some(beat => owners.decisionOf.get(beat) !== decisionId)) fail('question_binding', blocks.get(id).at, 'a question block binds the decision of the stage that owns this slide');
    }
    if (Array.isArray(order) && Array.isArray(composition.steps)) headingPrefixes(composition, order, members, at);
    const publicBytes = new TextEncoder().encode(JSON.stringify([...members.keys()].map(id => blocks.get(id).block))).byteLength;
    if (publicBytes > SLIDE_LIMITS.publicBytes) flag('slide_payload_too_large', `${at}/steps`, `this slide releases ${publicBytes} bytes of content; split it below ${SLIDE_LIMITS.publicBytes}`);
  }

  // Every reveal prefix keeps a valid heading outline in reading order: the first heading is H1 or H2 and no
  // later heading skips a level. Readiness names the offending step; levels are never renumbered (BWR17).
  function headingPrefixes(composition, order, members, at) {
    for (let step = 0; step < composition.steps.length; step++) {
      let previous = 0;
      for (const id of order) {
        if (!(members.get(id) <= step) || blocks.get(id)?.block.type !== 'text') continue;
        const paragraphs = blocks.get(id).block.paragraphs;
        for (const paragraph of Array.isArray(paragraphs) ? paragraphs : []) {
          const level = PARAGRAPH_STYLES.indexOf(paragraph?.style);
          if (level < 1) continue;
          if (previous ? level > previous + 1 : level > 2) { flag('heading_order', `${at}/steps/${step}`, `revealing this step leaves heading H${level} without its parent heading`); return; }
          previous = level;
        }
      }
    }
  }
}

function ownerIndex(doc) {
  const ids = rows => new Set((Array.isArray(rows) ? rows : []).map(row => row?.id));
  const paths = (Array.isArray(doc.decisions) ? doc.decisions : []).flatMap(decision => Array.isArray(decision?.paths) ? decision.paths : []);
  return { beat: ids(doc.beats), path: ids(paths), clarification: ids(doc.clarifications),
    decisionOf: new Map((Array.isArray(doc.beats) ? doc.beats : []).map(beat => [beat?.id, beat?.decision_id])),
    stagesOf: new Map((Array.isArray(doc.clarifications) ? doc.clarifications : []).map(card => [card?.id, Array.isArray(card?.beat_ids) ? card.beat_ids : []])) };
}
