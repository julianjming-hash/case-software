// Legacy surfaces in slide terms (card 56, CASE-210). `legacySlide` is an in-memory view for inspection: its ids are
// visibly synthetic and it never writes the draft. `convertToSlideDocument` is the explicit, reviewed upgrade: fresh
// UUIDv7 identities, learner text moved (never copied) into blocks, provenance remapped and marked stale.
import { PRESENTATION_GROUPS, populatedPresentationGroups } from './presentation-order.mjs';
import { SLIDE_CAPABILITY, SLIDE_SCHEMA_VERSION, BUILDER_SCHEMA_VERSION } from './case-document.mjs';
import { validateBuilderDocument } from './builder-document.mjs';
import { validateBuilderProvenancePaths } from './builder-provenance.mjs';
import { validateSlideParts } from './slide-document.mjs';
import { gasVisible } from './slide-gas-view.mjs';

const runsOf = text => [{ text }];
const MOVED = ['scene', 'points', 'investigations', 'observations'];

/**
 * Blocks for one surface in the fixed legacy reveal order (scene, observations, findings, investigations), gated
 * exactly like the room (`populatedPresentationGroups`). `targets` maps each legacy field form to where it now lives.
 */
function surfaceGroups(surface, makeId, withTitle = false) {
  const populated = new Set(populatedPresentationGroups(surface)), groups = [];
  // CASE-222: on conversion the learner heading also opens the slide as an H1 in the title slot, On entry (the spec's
  // template proposal). The surface keeps its heading: phones title the card with it and drop this repeat (slide-render).
  // The in-memory legacy view leaves it out: today's fixed layout shows the heading in its own chrome.
  const title = withTitle && typeof surface.title === 'string' && surface.title.trim() ? { id: makeId('title'), type: 'text', paragraphs: [{ style: 'h1', runs: runsOf(surface.title) }] } : null;
  const targets = { scene: [], sceneBlocks: new Map(), lists: {}, observations: null };
  for (const group of PRESENTATION_GROUPS) {
    if (!populated.has(group)) continue;
    const blocks = [];
    if (group === 'scene') {
      if (typeof surface.scene === 'string') blocks.push({ id: makeId('scene'), type: 'text', paragraphs: [{ style: 'p', runs: runsOf(surface.scene) }] });
      else surface.scene.blocks.forEach((item, index) => {
        // Consecutive formatted paragraphs share one text block; a formatted list keeps its own list block.
        const last = blocks.at(-1);
        if (item.type === 'list') blocks.push({ id: makeId('scene'), type: 'list', ordered: item.ordered, items: item.items.map(entry => ({ runs: structuredClone(entry.runs) })) });
        else if (last?.type === 'text') last.paragraphs.push({ style: 'p', runs: structuredClone(item.runs) });
        else blocks.push({ id: makeId('scene'), type: 'text', paragraphs: [{ style: 'p', runs: structuredClone(item.runs) }] });
        const block = blocks.at(-1);
        targets.sceneBlocks.set(index, { entity: block.id, field: block.type === 'list' ? 'items' : `paragraphs[${block.paragraphs.length - 1}]` });
      });
      targets.scene = blocks.map(block => ({ entity: block.id, field: block.type === 'list' ? 'items' : 'paragraphs' }));
    } else if (group === 'observations') {
      const rows = surface.observations.map((item, index) => ({ id: makeId(`observation${index}`), label: item.label, value: String(item.value ?? ''), unit: item.unit ?? '' }));
      blocks.push({ id: makeId('observations'), type: 'values', rows });
      targets.observations = { entity: blocks[0].id, rows: rows.map(row => row.id) };
    } else {
      const key = group === 'findings' ? 'points' : 'investigations';
      blocks.push({ id: makeId(key), type: 'list', ordered: false, items: surface[key].map(text => ({ runs: runsOf(text) })) });
      targets.lists[key] = blocks[0].id;
    }
    groups.push({ group, blocks });
  }
  if (title) { if (groups.length) groups[0].blocks.unshift(title); else groups.push({ group: 'title', blocks: [title] }); }
  return { groups, targets };
}

/** Where a legacy provenance field now lives: a list of {entity, field}, [] when nothing moved, or null if unmappable. */
function remapField(field, targets) {
  const rest = field.replace(/^surfaces\[[0-9a-f-]{36}\]\./, '').replace(/^surfaces\./, '');
  if (!MOVED.some(key => rest === key || rest.startsWith(`${key}.`) || rest.startsWith(`${key}[`))) return [];
  let match;
  if ((match = /^scene(?:\.blocks(?:\[(\d+)\](?:\..+)?)?)?$/.exec(rest))) return match[1] === undefined ? targets.scene : targets.sceneBlocks.has(Number(match[1])) ? [targets.sceneBlocks.get(Number(match[1]))] : null;
  if ((match = /^(points|investigations)(?:\[(\d+)\](?:\..+)?)?$/.exec(rest)) && targets.lists[match[1]]) return [{ entity: targets.lists[match[1]], field: match[2] === undefined ? 'items' : `items[${match[2]}].runs` }];
  if ((match = /^observations(?:\[(\d+)\](?:\.(label|value|unit))?)?$/.exec(rest)) && targets.observations) {
    if (match[1] === undefined) return [{ entity: targets.observations.entity, field: 'rows' }];
    const rowId = targets.observations.rows[Number(match[1])];
    if (!rowId) return null;
    return [match[2] ? { entity: rowId, field: match[2] } : { entity: targets.observations.entity, field: `rows[${match[1]}]` }];
  }
  return null;
}

/** Whole-cell placement for any member count: as many full-height columns as a 12-row grid needs. */
// Fit-aware layout (CASE-211 geometry at the 1280×720 projector target): the slide is 944×531 px with 3% padding, so its
// content box is about 887×474 px and one grid row is about 29.1 px plus an 11.3 px gap, and body text (2.75cqw ≈ 24.4 px, line height 1.35) is about 33 px a
// line. Heights are estimated from text length; the Builder's fit check and the projector measure the real slide.
// Every block has a .3em .5em inset (CASE-223): about 15 px of height and 24 px of width at the target.
const ROW = 29.1, GAP = 11.3, LINE = 33, CHAR = 12.7, INSET_Y = 15, INSET_X = 24;
const colWidth = cols => cols * 63.6 + (cols - 1) * GAP - INSET_X;
const textOf = runs => (Array.isArray(runs) ? runs : []).map(run => run?.text ?? '').join('');
const wrapLines = (text, cols, scale = 1) => String(text).split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length * CHAR * scale / colWidth(cols))), 0);
function blockHeight(block, cols, decision) { return INSET_Y + contentHeight(block, cols, decision); }
function contentHeight(block, cols, decision) {
  if (block.type === 'text' || block.type === 'quote' || block.type === 'callout') {
    const pad = block.type === 'text' ? 0 : LINE * 0.8;
    // Headings are wider per character (CASE-211 scale) but set tighter (line height 1.15–1.3 against body 1.35).
    return pad + block.paragraphs.reduce((sum, p) => { const scale = { h1: 1.75, h2: 1.42, h3: 1.2, h4: 1.1 }[p.style] ?? 1, line = { h1: 1.49, h2: 1.26, h3: 1.11, h4: 1.05 }[p.style] ?? 1; return sum + wrapLines(textOf(p.runs), cols, scale) * LINE * line + LINE * 0.4; }, -LINE * 0.4);
  }
  if (block.type === 'list') return block.items.reduce((sum, item) => sum + wrapLines(textOf(item.runs), cols - 1) * LINE + 4, 0);
  if (block.type === 'values') return block.rows.length * (LINE + 6);
  if (block.type === 'timeline') return block.entries.reduce((sum, entry) => sum + wrapLines(`${entry.label} ${entry.text}`, cols) * LINE + 6, 0);
  if (block.type === 'trend') return LINE * 10 + (block.caption ? LINE : 0) + (block.series.length > 1 ? LINE : 0);
  if (block.type === 'table') return (block.caption ? LINE : 0) + (block.rows.length + (block.header_row ? 1 : 0)) * (LINE + 4);
  // A blood gas flows its groups into two columns at full width (CASE-311): about half its shown rows and headings per column.
  // In compare mode (CASE-317) it is one table: a head row, then each group's name and rows, never flowed into columns.
  if (block.type === 'gas') { const groups = gasVisible(block), lines = groups.reduce((sum, group) => sum + group.rows.length + 1, 0); return LINE + (block.compare ? lines + 1 : Math.ceil(lines / (cols >= 8 ? 2 : 1))) * (LINE + 2); }
  if (block.type === 'question') {
    // The open decision: its call line, the prompt and one tile per option (the slot shrinks to the floor if needed).
    const options = decision?.interaction?.options?.length ?? 4, prompt = typeof decision?.prompt === 'string' ? decision.prompt : textOf((decision?.prompt?.blocks ?? []).flatMap(item => item.runs ?? []));
    return LINE + wrapLines(prompt || 'Question', cols) * LINE + Math.max(1, options) * (LINE * 1.25 + 6) + LINE * 0.8;
  }
  return LINE;
}
const rowsFor = height => Math.max(1, Math.ceil((height + GAP) / (ROW + GAP)));

/** Rows each block needs at a width, the column total, and whether it fits the 12 available rows. */
const measure = (blocks, cols, decision) => { const rows = blocks.map(block => rowsFor(blockHeight(block, cols, decision))); return { rows, total: rows.reduce((a, b) => a + b, 0) }; };
/** Lay a column of blocks into rows starting at `top`, giving any spare rows to the last block; overfull columns scale down. */
function stack(blocks, rows, col, w, top = 1, bottom = 12) {
  const room = bottom - top + 1, need = rows.reduce((a, b) => a + b, 0);
  let sized = rows.slice();
  if (need > room) { sized = rows.map(r => Math.max(1, Math.floor(r * room / need))); while (sized.reduce((a, b) => a + b, 0) > room) sized[sized.indexOf(Math.max(...sized))]--; }
  else if (sized.length) sized[sized.length - 1] += room - need;
  let row = top;
  return blocks.map((block, index) => { const placement = { block_id: block.id, col, row, w, h: sized[index] }; row += sized[index]; return placement; });
}

/**
 * Candidate layouts for a converted occurrence, best estimate first: everything stacked full width when it fits;
 * otherwise two columns (7/5, 6/6, 8/4), the reading order split left to right with the question on the right, ordered by
 * estimated overflow; the stacked layout is always offered. A measuring caller (the conversion script, the Builder fit
 * check) picks the first candidate that really fits; without measurement the first is used.
 */
export function layoutCandidates(blocks, decision = null) {
  if (!blocks.length) return [{ template: 'story', placements: [] }];
  const rows = isTitle(blocks[0]) ? Math.min(6, Math.max(2, rowsFor(blockHeight(blocks[0], 12)))) : 0;
  if (rows && blocks.length - 1 <= 12 - rows) {
    // A leading heading takes the template's title rows (at least two) across the slide; the rest fills the rows beneath.
    const head = { block_id: blocks[0].id, col: 1, row: 1, w: 12, h: rows };
    if (blocks.length === 1) return [{ template: 'title_text', placements: [head] }];
    return bodyCandidates(blocks.slice(1), decision, rows + 1).map(({ template, placements }) => ({ template, placements: [head, ...placements] }));
  }
  if (blocks.length > 12) {
    // More blocks than grid rows: an even grid of columns, so every block stays placed (the author re-lays it out).
    const columns = Math.ceil(blocks.length / 12), rows = Math.ceil(blocks.length / columns), width = Math.floor(12 / columns), height = Math.floor(12 / rows);
    return [{ template: 'story', placements: blocks.map((block, index) => {
      const column = Math.floor(index / rows), row = index % rows, lastRow = row === rows - 1 || index === blocks.length - 1;
      return { block_id: block.id, col: 1 + column * width, row: 1 + row * height, w: column === columns - 1 ? 12 - column * width : width, h: lastRow ? 12 - row * height : height };
    }) }];
  }
  return bodyCandidates(blocks, decision, 1);
}
const isTitle = block => block?.type === 'text' && block.paragraphs.length > 0 && block.paragraphs.every(item => item.style !== 'p');
/** Stacked and two-column layouts of `blocks` in rows `top`..12, least estimated overflow first. */
function bodyCandidates(blocks, decision, top) {
  const room = 13 - top, full = measure(blocks, 12, decision), stacked = { template: 'story', placements: stack(blocks, full.rows, 1, 12, top), over: Math.max(0, full.total - room), spread: 0 };
  const columns = [];
  for (const left of [7, 6, 8]) for (let split = 1; split < blocks.length; split++) {
    const a = blocks.slice(0, split), b = blocks.slice(split);
    if (a.some(block => block.type === 'question')) continue;
    const ma = measure(a, left, decision), mb = measure(b, 12 - left, decision);
    columns.push({ template: 'columns', placements: [...stack(a, ma.rows, 1, left, top), ...stack(b, mb.rows, left + 1, 12 - left, top)],
      over: Math.max(0, ma.total - room) + Math.max(0, mb.total - room), spread: Math.abs(ma.total - mb.total) });
  }
  columns.sort((x, y) => x.over - y.over || x.spread - y.spread);
  const ordered = stacked.over === 0 ? [stacked, ...columns] : [...columns.filter(item => item.over < stacked.over), stacked, ...columns.filter(item => item.over >= stacked.over)];
  return ordered.map(({ template, placements }) => ({ template, placements }));
}

function storyComposition(id, owner, groups, makeId, decision = null) {
  const blocks = groups.flatMap(group => group.blocks), { template, placements } = layoutCandidates(blocks, decision)[0];
  const steps = groups.map((group, index) => ({ id: makeId(`step${index}`), block_ids: group.blocks.map(block => block.id) }));
  // An occurrence with no learner content keeps an empty On entry step: preserved, and flagged until written.
  return { id, owner, template, placements, reading_order: blocks.map(block => block.id), steps: steps.length ? steps : [{ id: makeId('step0'), block_ids: [] }], styles: [] };
}

function owners(document) {
  const list = [];
  for (const beat of document.beats ?? []) if (beat?.surface_id) list.push({ kind: 'beat', id: beat.id, surfaceId: beat.surface_id, decisionId: beat.kind === 'decision' ? beat.decision_id : null });
  for (const decision of document.decisions ?? []) for (const path of decision?.paths ?? [])
    if (path?.reveal_surface_id && !(path.continue_to_next === true && document.required_capabilities?.includes('direct_continuation'))) list.push({ kind: 'path', id: path.id, surfaceId: path.reveal_surface_id, decisionId: null });
  for (const clarification of document.clarifications ?? []) if (clarification?.surface_id) list.push({ kind: 'clarification', id: clarification.id, surfaceId: clarification.surface_id, decisionId: null });
  return list;
}

/**
 * In-memory slide view of one legacy occurrence, reproducing today's reveal exactly: On entry is the first populated
 * group, then one step per later group, with the decision's question last. Synthetic ids (`legacy:…`) are never
 * persisted or offered as authored identities.
 */
export function legacySlide(document, owner) {
  const target = owners(document).find(item => item.kind === owner?.kind && item.id === owner?.id);
  const surface = target && (document.surfaces ?? []).find(item => item?.id === target.surfaceId);
  if (!surface) return null;
  const prefix = `legacy:${target.kind}:${target.id}:`, makeId = name => prefix + name;
  const { groups } = surfaceGroups(surface, makeId);
  if (target.decisionId) groups.push({ group: 'question', blocks: [{ id: makeId('question'), type: 'question', decision_id: target.decisionId }] });
  return { legacy: true, groups: groups.map(group => group.group), blocks: groups.flatMap(group => group.blocks), composition: storyComposition(makeId('composition'), { kind: target.kind, id: target.id }, groups, makeId, (document.decisions ?? []).find(item => item?.id === target.decisionId)) };
}

/**
 * Explicit schema-2 → schema-3 conversion. Returns a candidate pair and never mutates the source. Refuses, unchanged,
 * anything it cannot carry losslessly (flag variants, invalid input, an unmappable source trace). Shared surfaces
 * become shared blocks referenced by each occurrence's own composition. Every moved provenance trace is re-pointed
 * (a whole-scene trace to every block the scene became) and marked stale; no approval carries.
 */
export function convertToSlideDocument(document, metadata, { createId }) {
  const refuse = (code, message, errors = []) => ({ ok: false, code, message, errors });
  if (document?.schema_version !== BUILDER_SCHEMA_VERSION) return refuse('schema_version', 'Only a schema-2 draft can be upgraded to slides.');
  const before = validateBuilderDocument(document, metadata, { mode: 'preserve' });
  if (!before.ok) return refuse('invalid_source', 'Repair the draft before upgrading it.', before.errors);
  if (validateBuilderProvenancePaths(document, metadata).length) return refuse('invalid_provenance', 'Repair source traces that no longer resolve before upgrading.');
  if ((document.surfaces ?? []).some(surface => surface?.variants?.length)) return refuse('variants_need_review', 'Flag-dependent content variants need a reviewed slide mapping before upgrade.');
  const next = structuredClone(document), nextMetadata = structuredClone(metadata);
  const used = new Set(owners(next).map(owner => owner.surfaceId)), bySurface = new Map(), targets = new Map();
  next.blocks = []; next.compositions = [];
  for (const surface of next.surfaces ?? []) {
    // A surface no occurrence shows keeps its legacy fields; it has no slide to move them to.
    if (!used.has(surface.id)) continue;
    const result = surfaceGroups(surface, () => createId(), true);
    bySurface.set(surface.id, result.groups); targets.set(surface.id, result.targets);
    next.blocks.push(...result.groups.flatMap(group => group.blocks));
    for (const key of MOVED) delete surface[key];
  }
  for (const owner of owners(next)) {
    const groups = [...(bySurface.get(owner.surfaceId) ?? [])];
    if (owner.decisionId) { const question = { id: createId(), type: 'question', decision_id: owner.decisionId }; next.blocks.push(question); groups.push({ group: 'question', blocks: [question] }); }
    next.compositions.push(storyComposition(createId(), { kind: owner.kind, id: owner.id }, groups, () => createId(), (next.decisions ?? []).find(item => item?.id === owner.decisionId)));
  }
  next.schema_version = SLIDE_SCHEMA_VERSION;
  next.required_capabilities = [...new Set([...(next.required_capabilities ?? []), SLIDE_CAPABILITY])];
  let staled = 0;
  const provenance = [];
  for (const entry of nextMetadata.provenance ?? []) {
    const mapped = targets.has(entry.entity_id) ? remapField(entry.field ?? '', targets.get(entry.entity_id)) : [];
    if (mapped === null) return refuse('provenance_unmapped', 'A source trace points inside moved content that has no exact slide location; review it before upgrading.');
    if (!mapped.length) { provenance.push(entry); continue; }
    for (const target of mapped) { provenance.push({ ...entry, entity_id: target.entity, field: target.field, review_status: 'stale' }); staled++; }
  }
  if (nextMetadata.provenance) nextMetadata.provenance = provenance;
  const after = validateBuilderDocument(next, nextMetadata, { mode: 'preserve', validateSlides: validateSlideParts });
  if (!after.ok) return refuse('conversion_invalid', 'The upgraded draft would not be valid; nothing was changed.', after.errors);
  const paths = validateBuilderProvenancePaths(next, nextMetadata);
  if (paths.length) return refuse('conversion_invalid', 'Source traces would not resolve after upgrade; nothing was changed.', paths);
  return { ok: true, candidate: { document: next, authoringMetadata: nextMetadata }, staled,
    changes: ['schema_version', 'required_capabilities', 'blocks', 'compositions', 'surface learner fields moved', 'provenance re-pointed and stale'] };
}

/**
 * One-off for drafts already on slides (CASE-222): give each slide that has no heading its surface's learner heading as
 * an H1, On entry, in the title rows. Only a slide still in a layout the conversion offered is re-laid; one an author
 * has arranged is reported, never moved. `converted` is the document the conversion saved, when known: a slide whose
 * layout, reading order and steps are still exactly as saved there is the conversion's own even if today's heuristics
 * would offer different candidates. A surface's title block is shared by the slides that show that surface.
 */
export function addSlideTitles(document, { createId, converted = null }) {
  if (document?.schema_version !== SLIDE_SCHEMA_VERSION) return { ok: false, reason: 'Only a slide draft gets slide titles.' };
  if (!Array.isArray(document.blocks) || !Array.isArray(document.compositions) || !Array.isArray(document.surfaces)) return { ok: false, reason: 'The slide draft is incomplete; open it in the Builder first.' };
  const next = structuredClone(document), byId = new Map(next.blocks.map(block => [block.id, block])), made = new Map(), added = [], skipped = [];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // Placement order carries no meaning (reading order does), so layouts compare as sets.
  const layoutKey = placements => JSON.stringify([...(placements ?? [])].map(item => [item.block_id, item.col, item.row, item.w, item.h]).sort());
  const saved = new Map((Array.isArray(converted?.compositions) ? converted.compositions : []).map(item => [item?.id, item]));
  const asSaved = composition => { const was = saved.get(composition.id); return Boolean(was) && was.template === composition.template && layoutKey(was.placements) === layoutKey(composition.placements) && ['reading_order', 'steps'].every(key => same(was[key], composition[key])); };
  for (const owner of owners(next)) {
    const composition = next.compositions.find(item => item.owner?.kind === owner.kind && item.owner?.id === owner.id);
    const surface = next.surfaces.find(item => item?.id === owner.surfaceId), label = `${owner.kind}:${owner.id}`;
    if (!composition) continue;
    if (typeof surface?.title !== 'string' || !surface.title.trim()) { skipped.push({ owner: label, reason: 'no learner heading' }); continue; }
    const members = composition.reading_order.map(id => byId.get(id)).filter(Boolean), decision = (next.decisions ?? []).find(item => item?.id === owner.decisionId) ?? null;
    if (members.some(isTitle)) { skipped.push({ owner: label, reason: 'already has a heading' }); continue; }
    if (!asSaved(composition) && !layoutCandidates(members, decision).some(item => item.template === composition.template && layoutKey(item.placements) === layoutKey(composition.placements))) {
      skipped.push({ owner: label, reason: 'arranged by an author; add the title by hand' }); continue;
    }
    if (!made.has(surface.id)) { const block = { id: createId(), type: 'text', paragraphs: [{ style: 'h1', runs: runsOf(surface.title) }] }; made.set(surface.id, block); next.blocks.push(block); byId.set(block.id, block); }
    const title = made.get(surface.id), layout = layoutCandidates([title, ...members], decision)[0];
    composition.reading_order.unshift(title.id); composition.steps[0].block_ids.unshift(title.id);
    composition.template = layout.template; composition.placements = layout.placements;
    added.push({ owner: label, compositionId: composition.id });
  }
  return { ok: true, document: next, added, skipped };
}
