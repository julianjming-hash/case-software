// The counts-only facilitator debrief (card 40 + feedback integration slice 2): the P-34 record's v:2 round fields, the
// shared model, and the PDF it draws, read back through the structure tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from '../src/shared/ids.mjs';
import { miniCase } from './helpers/mini-case.mjs';
import { projectSessionRecord } from '../src/shared/session-record.mjs';
import { recordPage } from '../src/shared/session-record-wire.mjs';
import { handleSessionPortfolio } from '../src/worker/session-portfolio.mjs';
import { sessionPdf } from '../src/client/session-pdf.mjs';
import { buildDebrief } from '../src/client/debrief-model.mjs';
import { debriefPdfRows } from '../src/client/debrief-render.mjs';
import { readPdf } from './helpers/pdf-read.mjs';

const W = uuidv7(), S = uuidv7(), C = uuidv7(), V = uuidv7(), U = uuidv7();
const t = (m) => `2026-10-19T08:${String(m).padStart(2, '0')}:00Z`;
function raw() {
  const doc = miniCase().doc;
  return { interpretationLimited: false, session: { id: S, workspaceId: W, caseId: C, versionId: V, versionNo: 2, digest: 'd88c5713'.padEnd(64, '0'), title: 'Diving Deeper', status: 'ended', sourceStatus: 'published', createdAt: t(0), startedAt: t(0), endedAt: t(42), expiresAt: t(59), own: true, manifest: { interpretation: 1, versionId: V, revision: 2, epoch: 0, seq: 2, roundCount: 2, joined: 33 } },
    boundary: 'b'.repeat(64), document: doc, items: [], eventCount: 2, maxSeq: 2, nextPosition: null };
}
/** Two rounds of the fixture's first decision (the second opened earlier) and one recorded event. */
function withRounds(r) {
  const d = r.document.decisions[0], [a, b] = d.interaction.options, chosen = d.paths.find((p) => p.recommended) ?? d.paths[0];
  r.items = [
    { type: 'event', position: 1, seq: 1, eventId: uuidv7(), epoch: 0, kind: 'checkpoint_reset', at: t(10), payload: { beatId: r.document.beats[0].id, publication: { occurrenceId: uuidv7(), beatId: r.document.beats[0].id } } },
    { type: 'event', position: 2, seq: 2, eventId: uuidv7(), epoch: 0, kind: 'path_selected', at: t(12), payload: { decisionId: d.id, pathId: chosen.id } },
    { type: 'round', position: 3, id: uuidv7(), decisionId: d.id, number: 2, status: 'resolved', openedAt: t(20), closedAt: t(22), pathId: chosen.id, resolution: 'majority', aggregate: { total: 14, counts: { [a.id]: 10, [b.id]: 4 } } },
    { type: 'round', position: 4, id: uuidv7(), decisionId: d.id, number: 1, status: 'superseded', openedAt: t(5), closedAt: t(7), pathId: chosen.id, resolution: 'minority', aggregate: { total: 13, counts: { [a.id]: 3, [b.id]: 10 } } },
  ];
  return { d, chosen };
}
const deps = (record) => ({ env: {}, verifyUser: async () => ({ userId: U, email: 'x@example.org' }), rpc: { async call(name) {
  if (name === 'admin_account_active') return { ok: true, data: true };
  if (name === 'get_me') return { ok: true, data: [{ user_id: U, admin: false, display_name: null, next_after: null, memberships: [{ workspace_id: W, role: 'owner' }] }] };
  if (name === 'read_session_portfolio') return { ok: true, data: record };
  return { ok: false, code: 'XX000' };
} } });
const req = (body) => new Request('https://case.test/api/v1/portfolio/record', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer jwt' }, body: JSON.stringify(body) });

test('[card 40 debrief] v:2 asks the record for the debrief round fields; a client without it keeps the original shape', async () => {
  const r = raw(); const { chosen } = withRounds(r);
  const v2 = await (await handleSessionPortfolio(req({ sessionId: S, after: null, v: 2 }), deps(structuredClone(r)))).json();
  const round = recordPage(v2).items.find((i) => i.type === 'round');
  assert.equal(round.interaction, 'single_choice');
  assert.equal(round.branch, true);
  assert.equal(round.classification, chosen.classification);
  assert.equal(round.recommended, chosen.recommended === true);
  const v1 = await (await handleSessionPortfolio(req({ sessionId: S, after: null }), deps(structuredClone(r)))).json();
  assert.ok(v1.items.filter((i) => i.type === 'round').every((i) => !('branch' in i) && !('classification' in i)), 'an old client gets the original round shape');
  assert.equal((await handleSessionPortfolio(req({ sessionId: S, after: null, v: 3 }), deps(structuredClone(r)))).status, 400);
  const partial = structuredClone(v2); delete partial.items.find((i) => i.type === 'round').classification;
  assert.throws(() => recordPage(partial), /invalid_record/, 'debrief fields come as a set or not at all');
});

test('[card 40 debrief] the model orders questions by when they opened and keeps counts only', () => {
  const r = raw(); withRounds(r);
  const page = projectSessionRecord(r, { debrief: true }); delete page.nextPosition;
  const m = buildDebrief(recordPage(page));
  assert.deepEqual(m.questions.map((q) => [q.n, q.status, q.total]), [[1, 'superseded', 13], [2, 'resolved', 14]]);
  assert.deepEqual(m.questions[1].rows.map((x) => x.count), [10, 4, 0], 'an option nobody chose still shows, with 0');
  assert.equal(m.joined, 33); assert.equal(m.minutes, 42); assert.equal(m.resets, 1); assert.equal(m.routeChoices.length, 2);
  assert.doesNotMatch(JSON.stringify(m), /[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/, 'no id in the readable model');
});

test('[card 40 debrief] the PDF reads back as the debrief, without ids, event kinds or names', () => {
  const r = raw(); const { d, chosen } = withRounds(r);
  r.items[1].payload.displayName = 'PRIVATE NAME';
  const page = projectSessionRecord(r, { debrief: true }); delete page.nextPosition;
  const lines = readPdf(sessionPdf(debriefPdfRows(buildDebrief(recordPage(page))), { title: 'Diving Deeper' })).lines.join('\n');
  for (const want of ['Diving Deeper', 'Version 2 · d88c5713', '33 joined', 'At a glance', 'The Case', d.prompt, chosen.label, d.interaction.options[0].label, '14/33']) assert.ok(lines.includes(want), want);
  assert.doesNotMatch(lines, /[0-9a-f]{8}-[0-9a-f]{4}-7|checkpoint_reset|path_selected|PRIVATE NAME|participant/i);
});

test('[card 40 debrief] a free-text round shows only its count, a ranking its first places', () => {
  const page = { session: { title: 'T', versionNo: 1, digest: 'a'.repeat(64), startedAt: null, endedAt: null, sourceStatus: 'published' }, joined: 20, completeness: 'limited', intendedObjectives: [], nextAfter: null,
    items: [
      { type: 'round', status: 'resolved', number: 1, prompt: 'What do we think is going on?', openedAt: t(1), closedAt: t(2), interaction: 'free_text', branch: false, pathLabel: 'x', aggregate: { total: 17, counts: [] } },
      { type: 'round', status: 'resolved', number: 2, prompt: 'Rank the differential.', openedAt: t(3), closedAt: t(4), interaction: 'ranking', branch: false, pathLabel: 'y', aggregate: { total: 18, rankCount: 2, completeOrders: [], counts: [{ optionId: uuidv7(), label: 'DCS', count: 18, positionCounts: [12, 6] }, { optionId: uuidv7(), label: 'Lepto', count: 18, positionCounts: [6, 12] }] } },
    ] };
  const m = buildDebrief(page);
  assert.equal(m.questions[0].freeText, true); assert.equal(m.questions[0].total, 17); assert.deepEqual(m.questions[0].rows, []);
  assert.deepEqual(m.questions[1].rows.map((x) => x.count), [12, 6]); assert.equal(m.questions[1].ranking, true);
  assert.equal(m.routeChoices.length, 0, 'a question with one route is not a route choice');
  const text = readPdf(sessionPdf(debriefPdfRows(m))).lines.join('\n');
  assert.match(text, /17 written answers/); assert.match(text, /Ranked first · 18\/20/);
});

test('[card 40 debrief] every route classification draws its own shape in the PDF', () => {
  const classes = ['sound', 'defensible', 'context-dependent', 'unsafe', 'terminal-unsafe', 'discussion-prompt'];
  const page = { session: { title: 'T', versionNo: 1, digest: 'a'.repeat(64), startedAt: null, endedAt: null, sourceStatus: 'published' }, joined: 3, completeness: 'complete', intendedObjectives: [], nextAfter: null,
    items: classes.map((classification, i) => ({ type: 'round', status: 'resolved', number: i + 1, prompt: `Question ${i + 1}`, openedAt: t(2 * i + 1), closedAt: t(2 * i + 2),
      interaction: 'single_choice', branch: true, pathLabel: `Route ${i + 1}`, classification, recommended: false, aggregate: { total: 1, counts: [] } })) };
  const text = readPdf(sessionPdf(debriefPdfRows(buildDebrief(page)))).lines.join('\n');
  for (const word of ['Sound', 'Defensible', 'Context-dependent', 'Unsafe · recoverable', 'Terminal · needs a checkpoint reset', 'Discussion prompt']) assert.match(text, new RegExp(word));
});
