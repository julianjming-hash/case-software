// Card 28: the SQL derivation (case_app.art_structure, db/tests/case-version-art.test.sql) and the JS
// describeCase must agree. Every dollar-quoted doc/expected pair the SQL test asserts is asserted here against JS too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describeCase } from '../src/shared/art-descriptor.mjs';

const SQL = readFileSync(new URL('../db/tests/case-version-art.test.sql', import.meta.url), 'utf8');
const FIXTURE = JSON.parse(readFileSync(new URL('../src/fixtures/synthetic-workshop.case.json', import.meta.url), 'utf8'));

test('every SQL parity pair derives the same descriptor in JS', () => {
  const pairs = [...SQL.matchAll(/\$doc\$([\s\S]*?)\$doc\$,\s*\$exp\$([\s\S]*?)\$exp\$/g)];
  assert.ok(pairs.length >= 2, 'the SQL test lost its parity pairs');
  for (const [, doc, exp] of pairs) assert.deepEqual(describeCase(JSON.parse(doc)), JSON.parse(exp));
});

test('the SQL expectation for the MVC fixture is the JS descriptor', () => {
  const [, exp] = SQL.match(/art_structure\(\(select doc from art_fixture\)\) <>\s*\$exp\$([\s\S]*?)\$exp\$/) ?? [];
  assert.ok(exp, 'the SQL test lost its MVC expectation');
  assert.deepEqual(describeCase(FIXTURE), JSON.parse(exp));
});
