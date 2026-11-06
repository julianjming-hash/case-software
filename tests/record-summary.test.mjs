// The participant-record summary (room PDFs v2, Julian 2026-10-18): time, decisions, topics and the room's split, all from this phone's own ended view. Expected values
// are hand-written from the fixture below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordSummary, factsSummary } from '../src/client/record-summary.mjs';

const at = (m) => `2026-10-19T09:${String(m).padStart(2, '0')}:00.000Z`;
const q = (id) => ({ id, type: 'question' });
const slide = (title, blocks, m, kind = 'live') => ({ title, timelineKind: kind, at: at(m), slide: { blocks } });
const round = (o) => ({ decisionId: 'd', prompt: '', roundNo: 1, status: 'resolved', optionIds: ['a', 'b', 'c'], yourResponse: null, yourAnswer: null,
  yourClassification: null, why: null, doDifferently: null, revealIndex: null, ...o });
function view() {
  const timeline = [slide('Day 6 · Likely?', [q('q1')], 0), slide('Day 6 · Ask', [q('q2')], 5), slide('Day 7 · Likely now?', [q('q3')], 20), slide('Day 8 · Rank', [q('q4')], 40)];
  const rounds = [
    round({ decisionId: 'd1', prompt: 'How likely is decompression sickness?', yourResponse: { option_id: 'b' }, yourAnswer: 'Possible',
      room: { total: 3, options: [{ label: 'Unlikely', count: 1 }, { label: 'Possible', count: 2 }, { label: 'Likely', count: 0 }] } }),
    round({ decisionId: 'd2', prompt: 'What would you ask her?', optionIds: [], yourResponse: { text: 'Any floodwater?' }, yourAnswer: 'Any floodwater?' }),
    round({ decisionId: 'd3', prompt: 'How likely is decompression sickness now?', yourResponse: { option_id: 'a' }, yourAnswer: 'Unlikely' }),
    round({ decisionId: 'd4', prompt: 'Rank the differential', yourResponse: null, yourAnswer: null }),
  ];
  return { role: 'participant', phase: 'ended', endedAt: at(52), timeline, recap: { caseTitle: 'Diving Deeper', caseVersionNo: 2, rounds, learningPoints: ['One.', 'Two.', 'Three.'] } };
}

test('[room PDFs v2] the summary counts time, decisions and topics from the phone\'s own view', () => {
  const s = recordSummary(view());
  assert.equal(s.title, 'Diving Deeper');
  assert.equal(s.versionNo, 2);
  assert.equal(s.minutes, 52, 'first timeline entry to the end');
  assert.deepEqual(s.decisions, { made: 3, total: 4 });
  assert.equal(s.topics, 3);
});

test('[AS-176] you and the room: only rounds that carry the shown split, your own option marked', () => {
  assert.deepEqual(recordSummary(view()).room, [{ prompt: 'How likely is decompression sickness?', total: 3, options: [
    { mark: 0, label: 'Unlikely', count: 1, mine: false }, { mark: 1, label: 'Possible', count: 2, mine: true }, { mark: 2, label: 'Likely', count: 0, mine: false }] }]);
  const bad = view(); bad.recap.rounds[0].room = { total: 'x', options: [] };
  assert.deepEqual(recordSummary(bad).room, [], 'a malformed split is ignored');
});

test('[room PDFs v2] a browser that did not join gets the session facts only', () => {
  assert.deepEqual(factsSummary({ title: 'Diving Deeper', versionNo: 2, startedAt: at(0), endedAt: '2026-10-19T10:02:00.000Z', objectives: ['One.'] }),
    { title: 'Diving Deeper', versionNo: 2, startedAt: at(0), endedAt: '2026-10-19T10:02:00.000Z', minutes: 62, decisions: null, topics: 1, objectives: ['One.'], room: [], facilitator: null });
  assert.equal(factsSummary({ title: 'T', facilitator: 'Julian Ming, Emergency registrar' }).facilitator, 'Julian Ming, Emergency registrar');
  assert.equal(factsSummary({ title: 'T', facilitator: { name: 'x' } }).facilitator, null);
  assert.equal(recordSummary({}).minutes, null);
  assert.equal(recordSummary({}).facilitator, null);
  assert.equal(recordSummary({ recap: { facilitator: 'Julian Ming, Emergency registrar' } }).facilitator, 'Julian Ming, Emergency registrar');
});

test('in Debrief the record counts the session so far, so Hours start from it (Julian, 2026-11-01)', () => {
  const view = { phase: 'debrief', endedAt: null, timeline: [{ at: '2026-11-01T04:46:00.000Z' }], recap: { rounds: [] } };
  assert.equal(recordSummary(view, { now: Date.parse('2026-11-01T05:00:00.000Z') }).minutes, 14);
  assert.equal(recordSummary(view).minutes, null, 'no clock, no guess');
  assert.equal(recordSummary({ ...view, phase: 'surface_live' }, { now: Date.parse('2026-11-01T05:00:00.000Z') }).minutes, null);
});
