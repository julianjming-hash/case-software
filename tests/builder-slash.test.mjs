// CASE-344 (B2): the "/" menu's catalogue and matching. The acceptance tag is a [AS-215] placeholder until the Builder rows land.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SLASH, SLASH_GROUPS, slashMatches, slashQuery } from '../src/client/builder-slash.mjs';
import { addBlock, setCalloutIcon } from '../src/shared/slide-edit.mjs';
import { CALLOUT_ICONS } from '../src/shared/slide-document.mjs';

test('[AS-215] the query is what follows a leading "/"; plain writing has none', () => {
  assert.equal(slashQuery('/ab'), 'ab');
  assert.equal(slashQuery('/'), '');
  assert.equal(slashQuery('ab'), null);
  assert.equal(slashQuery(' /ab'), null, 'only the first character counts');
  assert.equal(slashQuery(''), null);
});

test('[AS-215] "/ab" puts the arterial blood gas first; a blank query lists every kind in the menu\'s order; nothing matches nonsense', () => {
  assert.equal(slashMatches('ab')[0].name, 'Arterial blood gas');
  assert.equal(slashMatches('vb')[0].name, 'Venous blood gas');
  assert.deepEqual(slashMatches('').map(entry => entry.name), SLASH.map(entry => entry.name));
  assert.deepEqual([...new Set(slashMatches('').map(entry => entry.group))], SLASH_GROUPS);
  assert.deepEqual(slashMatches('ti').map(entry => entry.name), ['Timeline table', 'Timeline'], 'by the start of any word, in the menu\'s group order');
  assert.deepEqual(slashMatches('warn').map(entry => entry.name), ['Warning']);
  assert.deepEqual(slashMatches('zz'), []);
  assert.deepEqual(slashMatches(' Blood ').map(entry => entry.group), ['Blood gas', 'Blood gas']);
});

test('[AS-215] every entry names something the Builder can add: a kind slide-edit makes, a closed icon, a table starter', () => {
  const document = { schema_version: 3, blocks: [], compositions: [{ id: 'c', owner: { kind: 'beat', id: 'b' }, placements: [], reading_order: [], steps: [], styles: [] }], decisions: [], beats: [] };
  let n = 0; const createId = () => `00000000-0000-7000-8000-${String(++n).padStart(12, '0')}`;
  for (const entry of SLASH) {
    if (entry.picture) { assert.equal(entry.kind, 'image'); continue; }
    const made = addBlock(document, 'c', entry.kind, createId, { recipe: entry.recipe, sample: entry.sample });
    assert.equal(made.ok, true, `${entry.name}: ${made.reason}`);
    if (entry.icon) { assert.ok(CALLOUT_ICONS.includes(entry.icon), entry.name); assert.equal(setCalloutIcon(made.document, made.blockId, entry.icon).ok, true, entry.name); }
  }
});
