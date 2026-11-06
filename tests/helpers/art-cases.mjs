// tests/helpers/art-cases.mjs: valid schema_version 1 case documents of a chosen size for the art tests
// (card 28). A chain of n decisions, each with one recommended path and `alts` alternatives that rejoin
// the next decision; every `resetEvery`-th decision also has a terminal reset to its own beat.
import { uuidv7 } from '../../src/shared/ids.mjs';

export function chainCase(n, alts, { resetEvery = 0 } = {}) {
  const id = () => uuidv7();
  const surfaces = [], beats = [], decisions = [];
  const surface = (title, kind = 'update') => { const s = { id: id(), kind, title, points: [`${title}.`] }; surfaces.push(s); return s.id; };
  const open = { id: id(), kind: 'surface', title: 'Arrival', surface_id: surface('Arrival', 'handover') };
  beats.push(open);
  const decisionBeats = Array.from({ length: n }, (_, i) => ({ id: id(), kind: 'decision', title: `Decision ${i + 1}`, surface_id: surface(`Context ${i + 1}`), decision_id: id() }));
  const debrief = { id: id(), kind: 'debrief', title: 'Debrief', surface_id: surface('Debrief', 'debrief') };
  open.next_beat_id = decisionBeats[0]?.id ?? debrief.id;
  beats.push(...decisionBeats, debrief);
  decisionBeats.forEach((beat, i) => {
    const next = decisionBeats[i + 1]?.id ?? debrief.id;
    const options = [], paths = [];
    const add = (label, extra) => { const option = { id: id(), label }; options.push(option); paths.push({ id: id(), label, option_ids: [option.id], rationale: 'Because.', reveal_surface_id: surface(`${label} ${i + 1}`), cue: 'Discuss.', ...extra }); };
    add('Recommended', { classification: 'sound', recommended: true, next_beat_id: next });
    for (let k = 0; k < alts; k++) add(`Alternative ${k + 1}`, { classification: 'defensible', next_beat_id: next });
    if (resetEvery && i % resetEvery === 0) add('Reset', { classification: 'terminal-unsafe', terminal: { checkpoint_beat_id: beat.id, debrief_prompt: 'What happened?', restore_policy: 'snapshot' } });
    decisions.push({ id: beat.decision_id, prompt: `Decision ${i + 1}?`, interaction: { type: 'single_choice', options }, fallback_path_id: paths[0].id, paths });
  });
  return { schema_version: 1, title: `Chain ${n} x ${alts}`, summary: 'A generated case for art tests.', audience: 'Registrars', setting: 'ED',
    duration_min: 45, learning_objectives: ['Test the art.'], flags: [], surfaces, beats, start_beat_id: open.id, decisions };
}
