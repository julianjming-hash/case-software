// The History debrief reads as one document (Julian, 2026-10-30): readWholeRecord joins every record page in order, so
// rounds that follow a busy room's events never land in a second part; a record that changes mid-read is refused, and
// a record past the page cap is reported as too large rather than drawn without its rounds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from '../src/shared/ids.mjs';
import { miniCase } from './helpers/mini-case.mjs';
import { projectSessionRecord } from '../src/shared/session-record.mjs';
import { buildDebrief } from '../src/client/debrief-model.mjs';
import { readWholeRecord } from '../src/client/session-detail.mjs';

const W = uuidv7(), S = uuidv7(), C = uuidv7(), V = uuidv7();
const t = (m) => `2026-10-19T08:${String(m).padStart(2, '0')}:00Z`;
function wholePage() {
  const doc = miniCase().doc, d = doc.decisions[0], [a, b] = d.interaction.options, chosen = d.paths.find((p) => p.recommended) ?? d.paths[0];
  const r = { interpretationLimited: false, session: { id: S, workspaceId: W, caseId: C, versionId: V, versionNo: 2, digest: 'd'.repeat(64), title: 'Every Breath You Take', status: 'ended', sourceStatus: 'published', createdAt: t(0), startedAt: t(0), endedAt: t(42), expiresAt: t(59), own: true, manifest: { interpretation: 1, versionId: V, revision: 2, epoch: 0, seq: 2, roundCount: 2, joined: 12 } },
    boundary: 'b'.repeat(64), document: doc, eventCount: 2, maxSeq: 2, nextPosition: null, items: [
      { type: 'event', position: 1, seq: 1, eventId: uuidv7(), epoch: 0, kind: 'checkpoint_reset', at: t(10), payload: { beatId: doc.beats[0].id, publication: { occurrenceId: uuidv7(), beatId: doc.beats[0].id } } },
      { type: 'event', position: 2, seq: 2, eventId: uuidv7(), epoch: 0, kind: 'path_selected', at: t(12), payload: { decisionId: d.id, pathId: chosen.id } },
      { type: 'round', position: 3, id: uuidv7(), decisionId: d.id, number: 1, status: 'superseded', openedAt: t(5), closedAt: t(7), pathId: chosen.id, resolution: 'minority', aggregate: { total: 13, counts: { [a.id]: 3, [b.id]: 10 } } },
      { type: 'round', position: 4, id: uuidv7(), decisionId: d.id, number: 2, status: 'resolved', openedAt: t(20), closedAt: t(22), pathId: chosen.id, resolution: 'majority', aggregate: { total: 12, counts: { [a.id]: 10, [b.id]: 2 } } },
    ] };
  const page = projectSessionRecord(r, { debrief: true }); delete page.nextPosition;
  return page;
}
/** The same record served as two pages: the events, then the rounds. */
function twoPages(page, { boundary2 = page.boundary } = {}) {
  const pages = new Map([[null, { ...page, items: page.items.slice(0, 2), nextAfter: 'cursor-2' }], ['cursor-2', { ...page, boundary: boundary2, items: page.items.slice(2), nextAfter: null }]]);
  const asked = [];
  return { asked, request: async (cursor) => { asked.push(cursor); return structuredClone(pages.get(cursor)); } };
}

test('History joins every record page into one debrief', async () => {
  const page = wholePage(), { asked, request } = twoPages(page);
  const whole = await readWholeRecord(request);
  assert.deepEqual(asked, [null, 'cursor-2']);
  assert.equal(whole.nextAfter, null);
  assert.deepEqual(whole.items.map(i => i.position), [1, 2, 3, 4]);
  const one = buildDebrief(page), joined = buildDebrief(whole);
  assert.equal(joined.questions.length, 2, 'both rounds are in the one debrief');
  assert.equal(joined.more, false, 'and it reads as complete, not as part 1');
  assert.deepEqual(joined.questions, one.questions, 'the same debrief as a record that fitted one page');
  const partOne = buildDebrief({ ...page, items: page.items.slice(0, 2), nextAfter: 'cursor-2' });
  assert.equal(partOne.questions.length, 0, 'before: the first part of a busy room held no questions');
});

test('a record that changes between pages is refused, not mixed', async () => {
  const page = wholePage(), { request } = twoPages(page, { boundary2: 'c'.repeat(64) });
  await assert.rejects(readWholeRecord(request), /record_changed/);
});

test('a record past the page cap stops with its cursor, so History says it is too large', async () => {
  const page = wholePage();
  let n = 0;
  const whole = await readWholeRecord(async () => { n++; return { ...structuredClone(page), items: [{ ...page.items[0], position: n }], nextAfter: `c${n}` }; });
  assert.equal(n, 40);
  assert.equal(whole.nextAfter, 'c40');
});
