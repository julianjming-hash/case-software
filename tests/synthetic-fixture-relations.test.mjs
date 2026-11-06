import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => JSON.parse(readFileSync(new URL('./fixtures/synthetic/'+name, import.meta.url), 'utf8'));
const witness = read('builder-input-relations.json');
const inputs = Object.fromEntries(witness.files.map(name => [name, read(name)]));
const at = ({file,pointer}) => pointer.split('/').slice(1).reduce((value,key) => value[key.replace(/~1/g,'/').replace(/~0/g,'~')],inputs[file]);

test('synthetic complex inputs retain authored text volume and every repeated-value relationship', () => {
  assert.equal(witness.private_source_text_or_short_value_hashes_included, false);
  assert.equal(witness.character_counts.length, 372, 'the complete authored-field volume witness must remain present');
  assert.equal(witness.equal_value_groups.length, 135, 'no repeated source relationship may disappear silently');
  for (const field of witness.character_counts) {
    const value = at(field); assert.equal(typeof value, 'string', field.pointer);
    assert.equal([...value].length, field.characters, 'authored character volume: '+field.pointer);
  }
  for (const group of witness.equal_value_groups) {
    assert.ok(group.members.length > 1);
    const expected = at(group.members[0]);
    for (const field of group.members) assert.equal(at(field), expected, 'repeated authored value: '+field.pointer);
  }
  function review(value) {
    if (!value || typeof value !== 'object') return;
    if (Object.hasOwn(value, 'review_status')) assert.notEqual(value.review_status, 'confirmed', 'new input cannot inherit a clinical approval');
    for (const child of Object.values(value)) review(child);
  }
  for (const input of Object.values(inputs)) review(input);
});
