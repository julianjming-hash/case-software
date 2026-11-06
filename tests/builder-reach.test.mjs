// CASE-344 B3, [AS-220]: the draft that carries every optional field is a valid draft, and the list of fields the Builder is
// tested against is exactly the fields it carries. The e2e (e2e/builder-reach.spec.mjs) edits each one through the Builder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateBuilderDocument } from '../src/shared/builder-document.mjs';
import { validateSlideParts, SLIDE_BLOCK_TYPES, CALLOUT_ICONS } from '../src/shared/slide-document.mjs';
import { everythingPair, fieldPatterns, REACH_FIELDS } from './helpers/builder-everything-fixture.mjs';

test('[AS-220] the fixture is a ready slide draft with every kind of block, and its fields are exactly the registered ones', () => {
  const pair = everythingPair();
  for (const mode of ['preserve', 'ready']) {
    const checked = validateBuilderDocument(pair.document, pair.authoringMetadata, { mode, validateSlides: validateSlideParts });
    assert.equal(checked.ok, true, `${mode}: ${JSON.stringify(checked.errors)}`);
  }
  const carried = fieldPatterns(pair.document, pair.authoringMetadata);
  assert.deepEqual(carried.filter(name => !REACH_FIELDS.includes(name)), [], 'a field the fixture carries has no entry in REACH_FIELDS');
  assert.deepEqual(REACH_FIELDS.filter(name => !carried.includes(name)), [], 'REACH_FIELDS names a field the fixture does not carry');
  assert.equal(new Set(REACH_FIELDS).size, REACH_FIELDS.length);
  // Every block type but a quote (which only an old published draft holds, and which converts when edited) is in it.
  const types = new Set(pair.document.blocks.map(block => block.type));
  assert.deepEqual(SLIDE_BLOCK_TYPES.filter(type => !types.has(type) && type !== 'quote'), []);
  // Every question type and every optional composition setting is carried.
  assert.deepEqual([...new Set(pair.document.decisions.map(item => item.interaction.type))].sort(), ['free_text', 'multi_select', 'ranking', 'single_choice']);
  assert.ok(CALLOUT_ICONS.includes(pair.document.blocks.find(block => block.type === 'callout').icon));
  for (const key of ['hero', 'fill']) assert.ok(pair.document.compositions.some(item => key in item), key);
  for (const key of ['tone', 'ink', 'align', 'padding', 'background', 'banded', 'density', 'text_size']) assert.ok(pair.document.compositions.some(item => item.styles?.some(style => key in style)), key);
  assert.ok(pair.document.theme);
});

test('[AS-220] a field with no entry is caught: a key the registry does not name shows up as missing', () => {
  const pair = everythingPair();
  pair.document.blocks.find(block => block.type === 'table').future_setting = true;
  assert.deepEqual(fieldPatterns(pair.document, pair.authoringMetadata).filter(name => !REACH_FIELDS.includes(name)), ['.blocks[]<table>.future_setting']);
});

// Schema-derived inventory, independent of the fixture: a new authored field needs coverage or a named exclusion.
// UUID identities/references are created and maintained by the Builder. Sources/provenance use AS-191 in
// builder-workspace.spec.mjs; metadata lineage and hashes are derived, never manually entered.
test('[AS-220] the schema field inventory has no unaccounted editable case or block field', () => {
  const source = readFileSync(new URL('../src/shared/builder-document.mjs', import.meta.url), 'utf8');
  const literal = source.match(/const specs = (\{[\s\S]*?\n\});/);
  assert.ok(literal, 'case schema inventory remains discoverable');
  const specs = Function(`return (${literal[1]})`)();
  const excluded = new Map([
    ['.schema_version', 'chosen by explicit document conversion'],
    ['.required_capabilities', 'derived from authored content'],
    ['.beats[].kind', 'chosen when adding a stage'],
    ['.decisions[].paths[].terminal.restore_policy', 'the contract has one fixed value'],
    ...['scene', 'points[]', 'investigations[]', 'observations[].label', 'observations[].value', 'observations[].unit',
      'variants[].when_flags[]', 'variants[].scene', 'variants[].points[]', 'variants[].investigations[]', 'variants[].notes']
      .map(field => [`.surfaces[].${field}`, 'legacy surfaces are explicitly converted to schema-3 slide blocks; schema-2 controls retain their existing tests']),
  ]);
  const missing = [];
  const walk = (name, path) => {
    for (const [key, type] of Object.entries(specs[name])) {
      const p = `${path}.${key}`, [kind, target] = type.split(':');
      if (kind === 'array' && specs[target]) walk(target, `${p}[]`);
      else if (kind === 'object') walk(target, p);
      else {
        const field = p + (kind === 'array' ? '[]' : '');
        if (!REACH_FIELDS.includes(field) && !excluded.has(field) && !/(^id$|_ids?$)/.test(key)) missing.push(field);
      }
    }
  };
  walk('root', '');
  assert.deepEqual(missing, [], 'each schema field has a browser reach case or an explicit exclusion');
  const slides = readFileSync(new URL('../src/shared/slide-document.mjs', import.meta.url), 'utf8');
  const blockKeys = Function(`return (${slides.match(/const BLOCK_KEYS = (\{[\s\S]*?\n\});/)[1]})`)();
  const blocks = everythingPair().document.blocks;
  for (const [type, keys] of Object.entries(blockKeys)) for (const key of keys) {
    if (type === 'quote') continue; // Existing quotes are read-only until conversion; AS-218 covers that conversion.
    assert.ok(blocks.some(block => block.type === type && Object.hasOwn(block, key)), `${type}.${key} must be carried by the fixture`);
  }
  const runKeys = Function(`return (${slides.match(/keys\(run, (\[[^\]]+\])/)[1]})`)();
  for (const key of runKeys) assert.ok(key === 'text' || REACH_FIELDS.some(field => field.endsWith(`.runs[].${key}`)), `run ${key} needs formatting coverage`);
});
