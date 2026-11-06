// scripts/measure-room-flush.mjs: the Durable Object's per-broadcast phone work for one case (CASE-281).
// Drives a case document through the pure reducer on its recommended route with N phones voting, and at every
// broadcast times what RoomDO#flush does for the phones: before CASE-281 (one projection and stringify per phone) and
// now (one shared timeline, spliced). Both must produce the same bytes; any difference exits non-zero.
// Local only: no Worker, no network (AGENTS.md hard rule 12). SQL hydration of rounds is not included.
//   node scripts/measure-room-flush.mjs <case-export.json> [phones=60]   (a file whose `document` is the case)
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import * as rm from '../src/shared/room-machine.mjs';
import * as wire from '../src/shared/wire.mjs';
import { snapshotText } from '../src/worker/snapshot-text.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
import { AVATAR_IDS } from '../src/shared/participant.mjs';

const [fixturePath, phonesArg = '60'] = process.argv.slice(2);
if (!fixturePath) { console.error('usage: node scripts/measure-room-flush.mjs <case-export.json> [phones=60]'); process.exit(2); }
const raw = JSON.parse(readFileSync(fixturePath, 'utf8'));
const doc = raw.document ?? raw;
const N = Number(phonesArg);
let clock = Date.parse('2026-10-20T09:00:00.000Z');
let state = rm.initialState({ sessionId: uuidv7(), joinCode: '7K3QX9', caseDoc: doc });
const fac = { role: 'facilitator', id: 'fac' };
const pids = Array.from({ length: N }, () => uuidv7());
const send = (type, extra = {}, actor = fac) => {
  clock += 1000;
  const r = rm.reduce(state, { type, roundId: uuidv7(), clientEventId: uuidv7(), epoch: state.epoch, at: new Date(clock).toISOString(), actor, ...extra });
  const receipt = r.effects.find(e => e.type === 'receipt');
  if (!receipt || ['accepted', 'already_accepted'].includes(receipt.receipt)) state = r.state;
  return receipt;
};
pids.forEach((pid, i) => send('join', { displayName: `Phone ${i + 1}`, avatarId: AVATAR_IDS[i % AVATAR_IDS.length] }, { role: 'participant', id: pid }));
const oldFlush = () => { let bytes = 0; for (const pid of pids) bytes += JSON.stringify(wire.snapshotBody(state, rm.project(state, 'participant', pid))).length; return bytes; };
const newFlush = () => {
  let bytes = 0, shared = null;
  for (const pid of pids) {
    if (!shared) { const timeline = rm.participantTimeline(state); shared = { timeline, text: JSON.stringify(timeline) }; }
    bytes += snapshotText(wire.snapshotBody(state, rm.project(state, 'participant', pid, { timeline: shared.timeline })), shared).length;
  }
  return bytes;
};
const time = (fn, reps = 3) => { let best = Infinity, out; for (let i = 0; i < reps; i++) { const t = performance.now(); out = fn(); best = Math.min(best, performance.now() - t); } return [best, out]; };
const rows = [];
const sample = () => {
  const [o, ob] = time(oldFlush), [n, nb] = time(newFlush);
  if (ob !== nb) throw Error(`byte mismatch at rev ${state.revision}: ${ob} vs ${nb}`);
  rows.push({ rev: state.revision, entries: state.revealed.length, oldMs: o, newMs: n, perPhoneBytes: Math.round(ob / N) });
};
send('start');
for (let step = 0; step < 600 && state.phase !== 'ended'; step++) {
  sample();
  if (state.phase === 'responses_open') {
    const d = doc.decisions.find(x => x.id === state.round.decisionId), it = d.interaction, o = (it.options ?? []).map(x => x.id);
    pids.forEach((pid, i) => {
      const response = it.type === 'multi_select' ? { option_ids: [o[i % o.length]] } : it.type === 'ranking' ? { order: o.slice(0, it.rank_count ?? o.length) }
        : it.type === 'free_text' ? { text: `Phone ${i + 1} answer` } : { option_id: o[i % o.length] };
      send('vote', { roundId: state.round.id, responseId: uuidv7(), response }, { role: 'participant', id: pid });
    });
    send('lock');
    const path = d.paths.find(p => p.recommended) ?? d.paths[0];
    send('select_path', { pathId: path.id, expectRevision: state.revision });
    send('show_results', { on: false });
    const r = send('reveal', { expectRevision: state.revision });
    if (r?.receipt !== 'accepted') throw Error(`reveal ${r?.reason}`);
  } else {
    const r = send('advance', { expectRevision: state.revision });
    if (r?.receipt === 'accepted') continue;
    if (r?.reason === 'recovery_required') { const occ = state.revealed.at(-1).occurrenceId; send('confirm_recovery', { occurrenceId: occ, confirmed: true, expectRevision: state.revision }); continue; }
    send('end', { expectRevision: state.revision });
  }
}
sample();
const sum = k => rows.reduce((a, r) => a + r[k], 0);
const pct = (k, q) => { const s = rows.map(r => r[k]).sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
console.log(JSON.stringify({ phones: N, phase: state.phase, broadcasts: rows.length, finalEntries: state.revealed.length,
  oldMsTotal: Math.round(sum('oldMs')), newMsTotal: Math.round(sum('newMs')), speedup: +(sum('oldMs') / sum('newMs')).toFixed(1),
  oldMsP50: +pct('oldMs', 0.5).toFixed(1), newMsP50: +pct('newMs', 0.5).toFixed(1), oldMsMax: +pct('oldMs', 1).toFixed(1), newMsMax: +pct('newMs', 1).toFixed(1),
  last: rows.at(-1) }, null, 1));
