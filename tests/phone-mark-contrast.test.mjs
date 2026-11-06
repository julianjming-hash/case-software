import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MARKS } from '../src/client/projector-marks.mjs';
import { themesFrom, declaredPairs, checkPairs } from './helpers/design-gates.mjs';

test('every actual phone mark tint and outline meets contrast under all authored mark overrides in both themes', () => {
  const css = readFileSync(new URL('../src/client/phone.css', import.meta.url), 'utf8');
  const themes = themesFrom(readFileSync(new URL('../src/client/tokens.css', import.meta.url), 'utf8'));
  const pairs = declaredPairs(css, 'src/client/phone.css').filter(pair => /var\(--mk\)/.test(pair.bg + pair.fg));
  assert.ok(pairs.length >= 6, 'missing actual mark-tint declarations');
  assert.ok(pairs.every(pair => pair.locals.mk), 'each tint rule needs a resolvable local default');
  const overrides = MARKS.flatMap(mark => pairs.map(pair => ({ ...pair, label: `${pair.label} ${mark.name}`, locals: { ...pair.locals, mk: mark.fill } })));
  const results = checkPairs(overrides, themes);
  assert.equal(results.length, pairs.length * MARKS.length * 2);
});
