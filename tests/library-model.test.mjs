// Card 29 (CASE-166): library view text and arrangement. Missing values read "not set", paging is
// honest, the table's aria-sort names the server sort, and board columns keep server order.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uuidv7 } from '../src/shared/ids.mjs';
import { NOT_SET, lengthText, fieldText, showingText, ariaSort, nextSort, boardColumns, cataloguePage, pilotTone,
  PILOT_TEXT, SORT_CHOICES, groupText, BOARD_COLUMNS, TABLE_COLUMNS } from '../src/client/library-model.mjs';

const row = over => ({ version_id: uuidv7(), case_id: uuidv7(), title: 'T', summary: null, audience: null, setting: null,
  duration_min: null, version_no: 1, published_at: '2026-10-01T00:00:00Z', content_sha256: `\\x${'c'.repeat(64)}`, art: null,
  group_id: null, group_name: null, tint: 'neutral', ...over });

test('[AS-105] a missing library field reads "not set"; paging says "Showing N of M" and never implies completeness', () => {
  assert.equal(lengthText(null), NOT_SET.length); assert.equal(lengthText(17), 'Length not set'); assert.equal(lengthText(45), '45 min');
  assert.equal(fieldText(null, 'audience'), 'Audience not set'); assert.equal(fieldText('  ', 'summary'), 'Summary not set');
  assert.equal(fieldText('Nurses', 'audience'), 'Nurses');
  assert.equal(showingText(8, 23), 'Showing 8 of 23 published cases');
  assert.equal(showingText(1, 1), 'Showing 1 of 1 published case');
  assert.equal(showingText(0, 0), 'No published cases match.');
  assert.match(showingText(24, null), /more may exist/);
  assert.equal(pilotTone('approved'), 'ok'); assert.equal(pilotTone('unconfigured'), 'warn');
  assert.equal(PILOT_TEXT.different, 'Different from the approved pilot version');
  assert.equal(PILOT_TEXT.unconfigured, undefined); assert.equal(PILOT_TEXT.unverified, undefined);
});

test('[AS-105] table headers carry aria-sort for the server sort; a new column starts ascending', () => {
  assert.equal(ariaSort('title', 'title', false), 'ascending'); assert.equal(ariaSort('title', 'title', true), 'descending');
  assert.equal(ariaSort('length', 'title', false), 'none');
  assert.deepEqual(nextSort('title', 'title', false), { sort: 'title', descending: true });
  assert.deepEqual(nextSort('length', 'title', true), { sort: 'length', descending: false });
  assert.deepEqual(nextSort('published', 'title', false), { sort: 'published', descending: true });
  assert.equal(new Set(SORT_CHOICES.map(c => c.value)).size, SORT_CHOICES.length);
});

test('[AS-105] board columns keep server order and put the missing value last; three views share one dataset', () => {
  const rows = [row({ duration_min: 15, audience: 'Nurses' }), row({ duration_min: null }), row({ duration_min: 45, audience: 'Nurses' }),
    row({ duration_min: 15 })];
  assert.deepEqual(boardColumns(rows, 'length').map(c => [c.label, c.rows.length]), [['15 min', 2], ['45 min', 1], ['Length not set', 1]]);
  assert.deepEqual(boardColumns(rows, 'audience').map(c => [c.label, c.rows.length]), [['Nurses', 2], ['Audience not set', 2]]);
  assert.equal(boardColumns(rows, 'length').flatMap(c => c.rows).length, rows.length, 'no row lost or duplicated');
});

test('[AS-105] a served page is validated whole: a pack field, an oversized page or a dishonest total is refused', () => {
  const ok = { cases: [row()], total: 3, offset: 0, pilotPin: null };
  assert.equal(cataloguePage(ok, { offset: 0, limit: 24 }).total, 3);
  assert.equal(cataloguePage({ ...ok, total: null, offset: 24 }, { offset: 24, limit: 24 }).total, null);
  for (const bad of [{ ...ok, cases: [{ ...row(), beats: [] }] }, { ...ok, total: 0 }, { ...ok, offset: 24 },
    { ...ok, cases: Array.from({ length: 25 }, () => row()), total: 30 }])
    assert.throws(() => cataloguePage(bad, { offset: 0, limit: 24 }));
});

test('[C30-library] the board\'s Group columns: every live group in the server\'s order, empty ones too, then Ungrouped', () => {
  const emergency = uuidv7(), paeds = uuidv7(), quiet = uuidv7();
  const groups = [{ id: emergency, name: 'Emergency', tint: 'petrol', count: 2 }, { id: quiet, name: 'Obstetrics', tint: 'rose', count: 0 },
    { id: paeds, name: 'Paediatrics', tint: 'sage', count: 1 }, { id: null, name: null, tint: 'neutral', count: 1 }];
  const rows = [row({ group_id: emergency, group_name: 'Emergency', tint: 'petrol' }), row({ group_id: paeds, group_name: 'Paediatrics', tint: 'sage' }),
    row(), row({ group_id: emergency, group_name: 'Emergency', tint: 'petrol' })];
  assert.deepEqual(boardColumns(rows, 'group', groups).map(c => [c.label, c.rows.length, c.count]),
    [['Emergency', 2, 2], ['Obstetrics', 0, 0], ['Paediatrics', 1, 1], ['Ungrouped', 1, 1]]);
  assert.equal(boardColumns(rows, 'group', groups).flatMap(c => c.rows).length, rows.length, 'no row lost or duplicated');
  assert.equal(groupText(rows[0]), 'Emergency'); assert.equal(groupText(rows[2]), 'Ungrouped');
  assert.ok(BOARD_COLUMNS.some(([value, label]) => value === 'group' && label === 'Group'));
  assert.ok(TABLE_COLUMNS.some(([value, label]) => value === 'group' && label === 'Group'));
  // Without a group list (it failed to load), the loaded rows still make their own columns, Ungrouped last.
  assert.deepEqual(boardColumns([row(), ...rows.slice(0, 2)], 'group', null).map(c => c.label), ['Emergency', 'Paediatrics', 'Ungrouped']);
});

test('modern published durations display their authored minutes', () => { assert.equal(lengthText(30), '30 min'); assert.equal(lengthText(60), '60 min'); assert.equal(lengthText(90), '90 min'); });
