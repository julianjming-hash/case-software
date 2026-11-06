// Card 34 / CASE-168: the educational-only statement lives on the policy page only, once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const STATEMENT = 'Case is an educational simulation only. It is not clinical advice.';
const PHRASES = [/educational simulation/i, /clinical advice/i];
const POLICY_PAGES = new Set(['src/client/privacy.mjs', 'prototypes/room/privacy.html']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(mjs|js|html|css)$/.test(name)) out.push(p);
  }
  return out;
}
const surfaces = ['src', 'prototypes'].flatMap(d => walk(join(root, d))).map(p => relative(root, p));

test('the disclaimer phrases appear on no surface except the policy page', () => {
  const offenders = surfaces.filter(f => !POLICY_PAGES.has(f) && PHRASES.some(re => re.test(readFileSync(join(root, f), 'utf8'))));
  assert.deepEqual(offenders, []);
});

test('each policy page carries the statement exactly once and no other variant', () => {
  for (const f of POLICY_PAGES) {
    const text = readFileSync(join(root, f), 'utf8');
    assert.equal(text.split(STATEMENT).length - 1, 1, `${f} must state it once`);
    assert.equal((text.match(/educational simulation/gi) || []).length, 1, `${f} has a duplicate`);
    assert.equal((text.match(/clinical advice/gi) || []).length, 1, `${f} has a duplicate`);
  }
});

test('the privacy instruction in "What not to enter" is kept', () => {
  for (const f of POLICY_PAGES) {
    assert.ok(readFileSync(join(root, f), 'utf8').includes('Do not enter patient details or information that identifies another person in your name or answers.'));
  }
});
