#!/usr/bin/env node
// scripts/gen-spec.mjs: derives the room-state tables in docs/HANDOFF.md from the executable spec.
//
// It explores every reachable state of a small case through src/shared/room-machine.mjs (BFS over
// all commands) and writes what the reducer ACTUALLY accepts between the markers below. Prose in the
// handoff explains intent; this block is the truth (CASE-057).
//
//   node scripts/gen-spec.mjs          rewrite the block
//   node scripts/gen-spec.mjs --check  exit 1 if the block is stale (run by `npm run check`)

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { initialState, reduce, project, PHASES, COMMANDS } from '../src/shared/room-machine.mjs';
import { miniCase } from '../tests/helpers/mini-case.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HANDOFF = resolve(ROOT, 'docs/HANDOFF.md');
const START = '<!-- gen:room-machine:start -->';
const END = '<!-- gen:room-machine:end -->';

// Deterministic ids so the output never churns.
let n = 0;
const id = () => `00000000-0000-7000-8000-${String(++n).padStart(12, '0')}`;
const { doc } = withDeterministicIds(miniCase());
// Give the generated walk an actual same-phase group step before the next beat
// and before opening a decision. The shared miniCase fixture stays unchanged.
doc.surfaces[0].scene = 'Opening context.';
doc.surfaces[1].scene = 'Decision context.';
const PID = id();

function withDeterministicIds(mc) {
  const map = new Map();
  const swap = (v) => {
    if (typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v)) { if (!map.has(v)) map.set(v, id()); return map.get(v); }
    if (Array.isArray(v)) return v.map(swap);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x)]));
    return v;
  };
  return { doc: swap(mc.doc) };
}

const AT = '2026-10-01T09:00:00.000Z';
const roundEvidence = new Map();
function candidates(state) {
  const fac = { role: 'facilitator', id: 'fac' };
  const out = [];
  for (const type of Object.keys(COMMANDS)) {
    if (type === 'vote' || type === 'join' || type === 'rename' || type === 'remove_participant') continue;
    const base = { type, epoch: state.epoch, actor: fac, at: AT, roundId: id(),
      clientEventId: id(),
      ...(['reveal_path', 'undo', 'ranked_page'].includes(type) ? { expectRevision: state.revision } : {}) };
    if (type === 'select_path' || type === 'reveal_path') {
      const d = doc.decisions.find((x) => x.id === state.decisionId);
      for (const p of d?.paths ?? []) out.push({ ...base, pathId: p.id, _label: type });
    } else if (type === 'undo') {
      const action = state.teachingActions?.at(-1);
      if (action) {
        const sourceRound = state.round?.id === action.roundId ? state.round
          : state.rounds.find(round => round.id === action.roundId) ?? roundEvidence.get(action.roundId);
        out.push({ ...base, targetEventId: action.id,
          ...(!state.manual ? { sourceRound, seedResponseIds: Object.fromEntries(
            Object.keys(sourceRound?.responses ?? {}).map(pid => [pid, id()])), expiresAtMs: Date.parse(AT) + 3600000 } : {}) });
      }
    } else if (type === 'replay') out.push({ ...base, surfaceId: state.revealed[0]?.surfaceId ?? id() });
    else if (type === 'enter_manual') out.push({ ...base, segmentId: id() });
    else if (type === 'manual_marker') out.push({ ...base, text: 'marker' });
    else if (type === 'show_names') out.push({ ...base, on: true });
    else if (type === 'show_lobby') out.push({ ...base, on: true });
    else if (type === 'set_timer') out.push({ ...base, seconds: 60 });
    else out.push(base);
  }
  if (state.round) {
    const d = doc.decisions.find((x) => x.id === state.round.decisionId);
    const opt = d.interaction.options.find((o) => !(state.disabledOptions[d.id] || []).includes(o.id));
    out.push({ type: 'vote', epoch: state.epoch, actor: { role: 'participant', id: PID }, at: AT, roundId: state.round.id, clientEventId: id(), responseId: id(), response: { option_id: opt.id } });
  }
  return out;
}

// A same-phase advance can reveal one more public context group. Keep that bounded
// progress in the exploration key so the generated table reaches the later vote-open
// transition, without keying on the ever-growing timeline across checkpoint resets.
const keyOf = (s) => JSON.stringify([s.presentationVersion, s.phase, s.resumePhase, Boolean(s.manual), s.beatId,
  s.revealed.at(-1)?.groupsShown ?? null, s.round?.status ?? null, s.exploredTerminal,
  s.selectedPathId, s.terminalPathId, s.flags, Object.keys(s.round?.responses ?? {}).length > 0,
  (s.teachingActions ?? []).slice(-2).map(action => [action.kind, action.mode, action.decisionId, action.control.beatId])]);
const label = (s) => (s.manual ? `${s.phase} *(manual)*` : s.phase);

const transitions = new Map(); // label → Map(command → Set(result label))
const sampleOf = new Map(); // label → a real explored state (for the display column)
const voteReceipt = new Map(); // label → Set(receipt)
let start = initialState({ sessionId: id(), joinCode: '7K3QX9', caseDoc: doc });
start = reduce(start, { type: 'join', epoch: 0, actor: { role: 'participant', id: PID }, at: AT, displayName: 'P' }).state;
const seen = new Set([keyOf(start)]);
const queue = [start];
let exploredOpeningSecondGroup = false;
while (queue.length) {
  const s = queue.shift();
  if (s.phase === 'surface_live' && s.beatId === doc.start_beat_id &&
      s.revealed.at(-1)?.groupsShown === 2) exploredOpeningSecondGroup = true;
  const from = label(s);
  if (!transitions.has(from)) transitions.set(from, new Map());
  if (!sampleOf.has(from)) sampleOf.set(from, s);
  for (const ev of candidates(s)) {
    if (s.round) roundEvidence.set(s.round.id, s.round);
    const { state: t, effects } = reduce(s, ev);
    const receipt = effects.find((e) => e.type === 'receipt')?.receipt ?? (t !== s ? 'accepted' : 'rejected');
    if (ev.type === 'vote') { if (!voteReceipt.has(from)) voteReceipt.set(from, new Set()); voteReceipt.get(from).add(receipt); }
    if (receipt !== 'accepted' || ev.type === 'vote') continue;
    if (t.round) roundEvidence.set(t.round.id, t.round);
    const cmd = ev._label ?? ev.type;
    const m = transitions.get(from);
    if (!m.has(cmd)) m.set(cmd, new Set());
    m.get(cmd).add(label(t));
    const k = keyOf(t);
    if (!seen.has(k)) { seen.add(k); queue.push(t); }
  }
}
if (!exploredOpeningSecondGroup) {
  console.error('gen-spec: staged opening context was not explored');
  process.exit(1);
}

// A malformed candidate must not silently erase a supported phase from the living contract. A retired phase is the
// one exception: no command enters it, so it is never explored, and it must stay that way.
// discussion_paused (CASE-255): only a room persisted before Pause for discussion was retired can be in it; it resumes.
const RETIRED_PHASES = new Set(['discussion_paused']);
for (const phase of RETIRED_PHASES) if ([...transitions.keys()].some(from => from.split(' ')[0] === phase)) {
  console.error(`gen-spec: retired phase ${phase} was entered`);
  process.exit(1);
}
for (const phase of PHASES) if (!RETIRED_PHASES.has(phase) && ![...transitions.keys()].some(from => from.split(' ')[0] === phase)) {
  console.error(`gen-spec: declared phase ${phase} was not explored`);
  process.exit(1);
}

// New teaching commands must be executed, not merely advertised by projection.
for (const phase of ['responses_locked', 'path_selected', 'consequence_revealed', 'terminal_teaching']) {
  if (!transitions.get(phase)?.has('undo')) {
    console.error(`gen-spec: accepted Undo transition missing from ${phase}`);
    process.exit(1);
  }
}

// Vote receipts when no round exists in that phase.
for (const from of transitions.keys()) if (!voteReceipt.has(from)) voteReceipt.set(from, new Set(['rejected (no open round)']));

const order = (l) => PHASES.indexOf(l.split(' ')[0]) * 2 + (l.includes('manual') ? 1 : 0);
const rows = [...transitions.keys()].sort((a, b) => order(a) - order(b));
const SELF = new Set(['show_names', 'manual_marker', 'set_timer', 'replay', 'takeover', 'close_joining', 'show_lobby']);

let out = `${START}\n`;
out += '_Generated by `npm run gen:spec` from `src/shared/room-machine.mjs`. Do not edit by hand; `npm run check` fails if it is stale. Where this block and the prose above differ, this block is what the runtime does._\n\n';
out += '| Phase | Facilitator command → resulting phase | Participant vote receipt | Display shows |\n|---|---|---|---|\n';
for (const from of rows) {
  const m = transitions.get(from);
  const cmds = [...m.keys()].filter((c) => !SELF.has(c)).sort()
    .map((c) => `\`${c}\` → ${[...m.get(c)].sort().map((x) => `\`${x.replace(' *(manual)*', '')}\`${x.includes('manual') ? '*' : ''}`).join(' / ')}`);
  const disp = displayLabel(from);
  out += `| \`${from.replace(' *(manual)*', '')}\`${from.includes('manual') ? ' (manual)' : ''} | ${cmds.join('<br>') || '—'} | ${[...voteReceipt.get(from)].sort().join(', ')} | ${disp} |\n`;
}
out += '\n`*` = in manual room mode. Always available unless the room has ended: `show_names`, `close_joining`, `takeover` (bumps `epoch`, fencing older tabs), `replay` (once anything is revealed), `show_lobby` (after `start`, outside manual mode; CASE-176), `remove_participant`, `rename`, `end`; `set_timer` while responses are open; `manual_marker` in manual mode. While the lobby screen layer is up, legacy `advance`, `reveal`, `reset_checkpoint`, `replay`, `show_results`, `results_page`, `text_page`, `ranked_page` and `show_names` are refused as `lobby_shown`. The atomic `reveal_path` command instead dismisses that layer while publishing the chosen authored consequence in its single transaction. Every accepted command except `replay` increments `session_revision`; `enter_manual` and `resume_online` also increment `epoch`. A command carrying an older epoch returns `stale_epoch` and changes nothing.\n';
out += END;

function displayLabel(from) {
  const v = project(sampleOf.get(from), 'display');
  return `\`${v.phase}\`${v.manual ? ' + manual notice' : ''}${v.decision ? ` + options (${v.decision.status})${v.counts.responded !== null ? ', answered count' : ''}` : ''}`;
}

const text = readFileSync(HANDOFF, 'utf8');
const a = text.indexOf(START);
const b = text.indexOf(END);
if (a === -1 || b === -1) { console.error(`gen-spec: markers missing in docs/HANDOFF.md (${START} … ${END})`); process.exit(1); }
const next = text.slice(0, a) + out + text.slice(b + END.length);
if (process.argv.includes('--check')) {
  if (next !== text) { console.error('gen-spec: docs/HANDOFF.md room-machine tables are stale; run `npm run gen:spec`'); process.exit(1); }
  console.log(`gen-spec — ok (${seen.size} states explored)`);
} else {
  writeFileSync(HANDOFF, next);
  console.log(`gen-spec — wrote ${rows.length} phase rows from ${seen.size} explored states`);
}
