// Card 40 + feedback integration slice 6: the console's End model (ruling I1). Derived from the facilitator's ended
// mirror and the pack before the purge, it is the same counts-only model the History debrief draws, and nothing
// personal survives into it: no name, participant id, token or answer text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walkRoom } from './helpers/room-walk.mjs';
import { roomDebrief } from '../src/client/debrief-model.mjs';
import { debriefPdfRows } from '../src/client/debrief-render.mjs';
import { sessionPdf } from '../src/client/session-pdf.mjs';
import { readPdf } from './helpers/pdf-read.mjs';

const { states } = walkRoom();
const ended = states.filter((s) => s.phase === 'ended' && s.rounds.some((r) => r.aggregate));
const mirrorOf = ({ caseDoc, ...mirror }) => mirror;
const CLOSED = new Set(['resolved', 'superseded', 'abandoned']);

test('[card 40 ended summary] the End model is one question per closed round, with the room\'s own counts', () => {
  assert.ok(ended.length > 0);
  for (const state of ended) {
    const m = roomDebrief(mirrorOf(state), state.caseDoc);
    const closed = state.rounds.filter((r) => CLOSED.has(r.status));
    assert.equal(m.questions.length, closed.length);
    assert.deepEqual(m.objectives, state.caseDoc.learning_objectives);
    m.questions.forEach((q, i) => {
      const r = [...closed].sort((a, b) => Date.parse(a.openedAt) - Date.parse(b.openedAt) || a.no - b.no)[i];
      const d = state.caseDoc.decisions.find((x) => x.id === r.decisionId);
      assert.equal(q.total, r.aggregate ? r.aggregate.total : null);
      if (r.aggregate && d.interaction.type !== 'free_text' && d.interaction.type !== 'ranking')
        assert.deepEqual(q.rows.map((row) => row.count), d.interaction.options.map((o) => r.aggregate.counts[o.id] ?? 0));
      assert.equal(Boolean(q.route), d.paths.length > 1 && Boolean(r.selectedPathId), 'a route only where the question changes it');
    });
    assert.equal(m.joined, Object.values(state.participants).length);
    assert.equal(m.resets, state.exploredTerminal.length);
  }
});

test('[card 40 ended summary] nothing personal reaches the End model or its PDF', () => {
  for (const state of ended.slice(0, 40)) {
    const named = structuredClone(state);
    for (const [pid, p] of Object.entries(named.participants)) p.name = `CANARY-NAME-${pid.slice(-4)}`;
    for (const r of named.rounds) r.answers = Object.fromEntries(Object.keys(named.participants).map((pid) => [pid, { text: 'CANARY-ANSWER' }]));
    const m = roomDebrief(mirrorOf(named), named.caseDoc), json = JSON.stringify(m);
    assert.doesNotMatch(json, /CANARY/);
    for (const pid of Object.keys(named.participants)) assert.ok(!json.includes(pid), 'no participant id');
    assert.doesNotMatch(readPdf(sessionPdf(debriefPdfRows(m), { title: m.title })).lines.join('\n'), /CANARY|undefined|null/);
  }
});

test('[card 40 ended summary] a missing pack or mirror gives no model, never a partial one', () => {
  const state = ended[0];
  assert.equal(roomDebrief(null, state.caseDoc), null);
  assert.equal(roomDebrief(mirrorOf(state), null), null);
});
