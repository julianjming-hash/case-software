// A schema-3 draft that carries every optional field the Builder can author (CASE-344 B3, AS-220), and the registry the
// reachability checks read: `tests/builder-reach.test.mjs` proves the fixture carries each field (and no field is left out
// of the registry), `e2e/builder-reach.spec.mjs` edits or clears each one through the Builder and asserts the saved draft
// changed. Fields are named by pattern: arrays are `[]`, a block's fields are qualified by its type (`blocks<callout>.icon`).
import { uuidv7 } from '../../src/shared/ids.mjs';
import * as ops from '../../src/shared/slide-edit.mjs';
import { addGasSample } from '../../src/shared/slide-gas-edit.mjs';
import { roomyPair, startSlide } from './builder-simplify-fixture.mjs';

const must = result => { if (!result.ok) throw new Error(result.reason ?? 'edit refused'); return result; };
const text = value => [{ style: 'p', runs: [{ text: value }] }];

/** Keys that name an identity or a reference: the Builder mints and maintains these, an author never types them. */
// Also structural: a stage's kind and a block's type are chosen when it is added (a block can be turned into another type),
// an image's `ecg` (null or a calibration) follows the kind of image chosen, and a terminal path's restore policy has one value.
const STRUCTURAL = /(^|\.)id$|_ids?(\[\])?$|^\.?schema_version$|^\.required_capabilities\[\]$|^\.compositions\[\]\.(owner\.kind|placements\[\]\.(col|row|w|h))$|runs\[\]\.text$|^#\.metadata_version$|^\.beats\[\]\.kind$|<image>\.ecg$|restore_policy$/;
const TEXT_ONLY = /\.runs\[\]\.(bold|script)$/;

/** Every field pattern a pair carries, with a value to tell them apart; ids, references and derived keys are left out. */
export function fieldPatterns(document, metadata = {}) {
  const found = new Set();
  const walk = (value, path) => {
    if (Array.isArray(value)) { value.forEach(item => walk(item, `${path}[]`)); return; }
    if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        const here = path === '.blocks[]' && key !== 'type' ? `${path}<${value.type}>.${key}` : `${path}.${key}`;
        walk(item, here);
      }
      return;
    }
    found.add(path);
  };
  walk(document, '');
  walk(metadata, '#');
  return [...found].filter(name => !STRUCTURAL.test(name) || TEXT_ONLY.test(name)).sort();
}

/** The fixture: the roomy MVC case with a block of every kind and every optional field on a consequence slide each. */
export function everythingPair() {
  const base = roomyPair();
  let document = base.document;
  const metadata = { ...base.authoringMetadata, preparation_requirements: 'Bring a pleural drain trolley.' };
  const slides = document.compositions.filter(item => item.owner.kind === 'path');
  const create = uuidv7;
  for (const slide of slides.slice(0, 5)) {
    const current = document.compositions.find(item => item.id === slide.id);
    for (const id of [...current.reading_order]) document = must(ops.removeBlock(document, slide.id, id)).document;
  }
  const add = (slide, kind, options, at) => {
    const result = must(ops.addBlock(document, slide.id, kind, create, { ...options, at }));
    document = result.document;
    return result.blockId;
  };
  const edit = (block, change) => { document = structuredClone(document); change(document.blocks.find(item => item.id === block)); };
  const [first, second, third, fourth, fifth] = slides;

  // Slide 1: a callout with an icon and tone, a values list with units, a timeline and a numbered list.
  const callout = add(first, 'callout', {}, { col: 1, row: 1, w: 6, h: 3 });
  edit(callout, block => { block.paragraphs = [{ runs: [{ text: 'Decompress ', bold: true, script: 'sub' }, { text: 'before imaging' }] }]; });
  document = must(ops.setCalloutIcon(document, callout, 'alert')).document;
  document = must(ops.setBlockStyle(document, first.id, callout, 'tone', 'amber')).document;
  const values = add(first, 'values', {}, { col: 7, row: 1, w: 6, h: 4 });
  edit(values, block => { block.rows = [{ id: create(), label: 'SpO2', value: '84', unit: '%' }, { id: create(), label: 'BP', value: '66/40', unit: 'mmHg' }]; });
  document = must(ops.setBlockStyle(document, first.id, values, 'ink', 'blue')).document;
  document = must(ops.setBlockStyle(document, first.id, values, 'align', 'center')).document;
  document = must(ops.setBlockStyle(document, first.id, values, 'padding', 'roomy')).document;
  const timeline = add(first, 'timeline', {}, { col: 1, row: 5, w: 6, h: 4 });
  edit(timeline, block => { block.entries = [{ id: create(), label: '0 min', text: 'Arrival' }, { id: create(), label: '4 min', text: 'Needle goes in' }]; });
  document = must(ops.setBlockStyle(document, first.id, timeline, 'background', 'outline')).document;
  const list = add(first, 'list', {}, { col: 7, row: 6, w: 6, h: 4 });
  edit(list, block => { block.ordered = true; block.items = [{ runs: [{ text: 'Needle' }] }, { runs: [{ text: 'Finger' }] }]; });
  document = must(ops.setBlockStyle(document, first.id, list, 'tone', 'soft')).document;
  document = must(ops.setFill(document, first.id, 'teal')).document;
  document = must(ops.applyTemplate(document, first.id, 'blank')).document;
  document = reserve(document, first.id, [[callout, 1, 1, 6, 3], [values, 7, 1, 6, 4], [timeline, 1, 5, 6, 4], [list, 7, 6, 6, 4]]);

  // Slide 2: a table with a caption, column units, widths, alignment and every table presentation setting.
  const table = add(second, 'table', { recipe: 'observations' }, { col: 1, row: 1, w: 12, h: 6 });
  edit(table, block => {
    block.caption = 'Observations at the door'; block.header_row = true; block.first_column_header = true;
    block.columns[0].unit = 'min'; block.columns[2].align = 'end'; block.columns[2].width = 2;
    block.rows[0].cells = ['0', 'SpO2', '84', '%'];
  });
  for (const [key, value] of [['banded', true], ['density', 'compact'], ['text_size', 'large'], ['background', 'soft'], ['ink', 'coral'], ['align', 'end'], ['padding', 'normal']]) document = must(ops.setBlockStyle(document, second.id, table, key, value)).document;
  document = must(ops.setFill(document, second.id, 'soft')).document;

  // Slide 3: a chart with a caption, units, axis bounds, a category scale, points only and its values hidden.
  const trend = add(third, 'trend', {}, { col: 1, row: 1, w: 12, h: 8 });
  edit(trend, block => {
    block.caption = 'Saturation after decompression'; block.x_label = 'Time'; block.x_unit = 'min'; block.y_label = 'SpO2'; block.y_unit = '%'; block.y_min = '70'; block.y_max = '100';
    block.scale = 'time'; block.style = 'points'; block.values_shown = false;
    block.points[0].label = 'Door'; block.points[0].at = '0'; block.points[1].label = 'After'; block.points[1].at = '4';
    block.series[0].label = 'SpO2'; block.series[0].values = ['84', '93'];
  });

  // Slide 4: a venous blood gas in compare mode with a caption.
  const gas = add(fourth, 'gas', { sample: 'venous' }, { col: 1, row: 1, w: 12, h: 10 });
  document = must(ops.setGasField(document, gas, 'caption', 'Venous gas at the door')).document;
  document = must(ops.setGasRow(document, gas, document.blocks.find(item => item.id === gas).groups[0].rows[0].id, 'value', '7.31')).document;
  document = must(addGasSample(document, gas, { label: 'Earlier', current: 'Now' }, create)).document;

  // Slide 5: an ECG (calibrated, always whole) and a plain image with its caption.
  const ecg = add(fifth, 'image', { image: { assetId: uuidv7(), alt: 'A rhythm strip', ecg: true } }, { col: 1, row: 1, w: 12, h: 5 });
  edit(ecg, block => { block.caption = 'Rhythm strip at the door'; });
  const photo = add(fifth, 'image', { image: { assetId: uuidv7(), alt: 'A chest film', ecg: false } }, { col: 1, row: 6, w: 12, h: 5 });
  edit(photo, block => { block.fit = 'cover'; });

  document = must(ops.setTheme(document, 'clinic')).document;
  const opening = startSlide(document);
  document = must(ops.setHero(document, opening.id, 'centred')).document;

  // Each slide's first block shows on entry (a block added later is its own step).
  for (const [slide, id] of [[first, callout], [second, table], [third, trend], [fourth, gas], [fifth, ecg]]) document = must(ops.moveBlockToStep(document, slide.id, id, document.compositions.find(item => item.id === slide.id).steps[0].id, create)).document;
  document = caseLevel(document);
  document.required_capabilities = [...new Set([...document.required_capabilities, 'callout_icon', 'required_recovery', 'direct_continuation'])];
  return { document, authoringMetadata: metadata, ids: { callout, values, timeline, list, table, trend, gas, ecg, photo }, slides: { first, second, third, fourth, fifth } };
}

/** Place blocks at fixed cells (the blank layout leaves a slide's blocks where they were put). */
function reserve(document, compositionId, cells) {
  for (const [id, col, row, w, h] of cells) document = must(ops.setPlacement(document, compositionId, id, { col, row, w, h })).document;
  return document;
}

/** The case-level optional fields: a multi-select and a ranking with rules, a free-text stage, continuation, recovery, cleared flags. */
function caseLevel(input) {
  const document = structuredClone(input), [, selection, ranking] = document.decisions, create = uuidv7;
  const options = decision => decision.interaction.options;
  // Question 2 becomes a multi-select with a rule (its consequences no longer map single responses).
  selection.interaction = { type: 'multi_select', options: structuredClone(options(selection)) };
  for (const path of selection.paths) delete path.option_ids;
  selection.rules = [{ path_id: selection.paths[0].id, reason: 'Both of the first two', when: { includes_all: options(selection).slice(0, 2).map(option => option.id) } }];
  for (const key of ['includes_any', 'excludes']) selection.rules.push({ path_id: selection.paths[1].id, reason: key, when: { [key]: [options(selection)[0].id] } });
  // Question 3 becomes a ranking with an order meaning, a rank count and a rule.
  ranking.interaction = { type: 'ranking', options: structuredClone(options(ranking)), order_meaning: 'action', rank_count: 2 };
  for (const path of ranking.paths) delete path.option_ids;
  ranking.rules = [{ path_id: ranking.paths[0].id, reason: 'Survey first', when: { top: [options(ranking)[1].id] } }];
  ranking.rules.push({ path_id: ranking.paths[1].id, reason: 'Compare priorities', when: { before: options(ranking).slice(0, 2).map(option => option.id) } });
  const clarificationId = create();
  document.clarifications = [{ id: clarificationId, label: 'Clarify arrival', surface_id: document.beats[0].surface_id, beat_ids: [document.start_beat_id] }];
  const intro = structuredClone(document.compositions.find(item => item.owner.kind === 'beat' && item.owner.id === document.start_beat_id));
  document.compositions.push({ ...intro, id: create(), owner: { kind: 'clarification', id: clarificationId }, steps: intro.steps.map(step => ({ ...step, id: create() })) });
  document.required_capabilities.push('early_clarification');
  // A flag a consequence clears, and a recovery prompt on an unsafe consequence.
  document.decisions[0].paths[0].clear_flags = ['workshop_flag_02'];
  document.decisions[0].paths[2].recovery = { prompt: 'Recover the airway before anything else.' };
  return freeTextStage(document, ranking, create);
}

/** A free-text stage before the debrief: a keyword rule, a length limit and one discussion route that simply continues. */
function freeTextStage(input, previous, create) {
  let document = input;
  const debrief = document.beats.find(beat => beat.kind === 'debrief');
  const ids = Object.fromEntries(['stageSurface', 'beat', 'decision', 'path'].map(key => [key, create()]));
  document.surfaces.push({ id: ids.stageSurface, kind: 'update', title: 'Airway plan', notes: 'Say it aloud before typing.' });
  document.decisions.push({
    id: ids.decision, prompt: 'What is the airway plan?', timer_s: 90, interpretation: 'rules', interaction: { type: 'free_text', max_length: 240 }, fallback_path_id: ids.path,
    rules: [{ path_id: ids.path, reason: 'Names the plan', when: { keywords: ['airway', 'plan'] } }],
    paths: [{ id: ids.path, label: 'Plan agreed', classification: 'discussion-prompt', recommended: true, rationale: 'Any plan is discussed.', cue: 'Ask what the plan changes.', continue_to_next: true, reveal_surface_id: ids.stageSurface, next_beat_id: debrief.id }],
  });
  document.beats.splice(document.beats.indexOf(debrief), 0, { id: ids.beat, kind: 'decision', title: 'Airway plan', surface_id: ids.stageSurface, decision_id: ids.decision, cue: 'Let them type first.' });
  for (const path of previous.paths) path.next_beat_id = ids.beat;
  document.compositions.push(
    { id: create(), owner: { kind: 'beat', id: ids.beat }, template: 'blank', placements: [], reading_order: [], steps: [{ id: create(), block_ids: [] }] });
  const stage = document.compositions.at(-1);
  document = must(ops.addBlock(document, stage.id, 'question', create, { decisionId: ids.decision })).document;
  return must(ops.moveBlockToStep(document, stage.id, document.blocks.at(-1).id, document.compositions.at(-1).steps[0].id, create)).document;
}

/** Every field the fixture carries. `tests/builder-reach.test.mjs` proves the fixture and this list agree; `e2e/builder-reach.spec.mjs`
 * edits or clears each through the Builder. Adding a field to a draft means adding it here, and then giving it a control. */
export const REACH_FIELDS = Object.freeze([
  '#.preparation_requirements',
  '.audience',
  '.beats[].cue',
  '.beats[].requires_flags[]',
  '.beats[].title',
  '.blocks[].type',
  '.blocks[]<callout>.icon',
  '.blocks[]<callout>.paragraphs[].runs[].bold',
  '.blocks[]<callout>.paragraphs[].runs[].script',
  '.clarifications[].label',
  '.decisions[].rules[].when.includes_any[]',
  '.decisions[].rules[].when.excludes[]',
  '.decisions[].rules[].when.before[]',
  '.blocks[]<gas>.caption',
  '.blocks[]<gas>.compare.earlier[].label',
  '.blocks[]<gas>.compare.label',
  '.blocks[]<gas>.groups[].label',
  '.blocks[]<gas>.groups[].rows[].earlier[]',
  '.blocks[]<gas>.groups[].rows[].high',
  '.blocks[]<gas>.groups[].rows[].label',
  '.blocks[]<gas>.groups[].rows[].low',
  '.blocks[]<gas>.groups[].rows[].unit',
  '.blocks[]<gas>.groups[].rows[].value',
  '.blocks[]<gas>.sample',
  '.blocks[]<image>.alt',
  '.blocks[]<image>.caption',
  '.blocks[]<image>.ecg.gain',
  '.blocks[]<image>.ecg.layout',
  '.blocks[]<image>.ecg.speed',
  '.blocks[]<image>.fit',
  '.blocks[]<list>.ordered',
  '.blocks[]<table>.caption',
  '.blocks[]<table>.columns[].align',
  '.blocks[]<table>.columns[].label',
  '.blocks[]<table>.columns[].unit',
  '.blocks[]<table>.columns[].width',
  '.blocks[]<table>.first_column_header',
  '.blocks[]<table>.header_row',
  '.blocks[]<table>.rows[].cells[]',
  '.blocks[]<text>.paragraphs[].style',
  '.blocks[]<timeline>.entries[].label',
  '.blocks[]<timeline>.entries[].text',
  '.blocks[]<trend>.caption',
  '.blocks[]<trend>.points[].at',
  '.blocks[]<trend>.points[].label',
  '.blocks[]<trend>.scale',
  '.blocks[]<trend>.series[].label',
  '.blocks[]<trend>.series[].values[]',
  '.blocks[]<trend>.style',
  '.blocks[]<trend>.values_shown',
  '.blocks[]<trend>.x_label',
  '.blocks[]<trend>.x_unit',
  '.blocks[]<trend>.y_label',
  '.blocks[]<trend>.y_max',
  '.blocks[]<trend>.y_min',
  '.blocks[]<trend>.y_unit',
  '.blocks[]<values>.rows[].label',
  '.blocks[]<values>.rows[].unit',
  '.blocks[]<values>.rows[].value',
  '.compositions[].fill',
  '.compositions[].hero',
  '.compositions[].reading_order[]',
  '.compositions[].styles[].align',
  '.compositions[].styles[].background',
  '.compositions[].styles[].banded',
  '.compositions[].styles[].density',
  '.compositions[].styles[].ink',
  '.compositions[].styles[].padding',
  '.compositions[].styles[].text_size',
  '.compositions[].styles[].tone',
  '.compositions[].template',
  '.decisions[].interaction.max_length',
  '.decisions[].interaction.options[].label',
  '.decisions[].interaction.order_meaning',
  '.decisions[].interaction.rank_count',
  '.decisions[].interaction.type',
  '.decisions[].interpretation',
  '.decisions[].paths[].classification',
  '.decisions[].paths[].clear_flags[]',
  '.decisions[].paths[].continue_to_next',
  '.decisions[].paths[].cue',
  '.decisions[].paths[].label',
  '.decisions[].paths[].rationale',
  '.decisions[].paths[].recommended',
  '.decisions[].paths[].recovery.prompt',
  '.decisions[].paths[].set_flags[]',
  '.decisions[].paths[].terminal.debrief_prompt',
  '.decisions[].prompt',
  '.decisions[].rules[].reason',
  '.decisions[].rules[].when.includes_all[]',
  '.decisions[].rules[].when.keywords[]',
  '.decisions[].rules[].when.top[]',
  '.decisions[].timer_s',
  '.duration_min',
  '.flags[].key',
  '.flags[].label',
  '.learning_objectives[]',
  '.setting',
  '.summary',
  '.surfaces[].kind',
  '.surfaces[].notes',
  '.surfaces[].title',
  '.theme',
  '.title',
]);
