// prototypes/room/lib/demo-interactions.mjs: a short NON-CLINICAL case that exercises the three
// interaction types the MVC fixture does not use (multi-select, ranking, free text), so the phone
// and console mockups can be reviewed for every type. Content is placeholder: not for teaching.
import { uuidv7 } from '../../../src/shared/ids.mjs';

export function demoInteractionsCase() {
  const id = () => uuidv7();
  const s = { open: id(), d1: id(), d1a: id(), d1b: id(), d2: id(), d2a: id(), d2b: id(), d3: id(), d3a: id(), d3b: id(), debrief: id() };
  const b = { open: id(), d1: id(), d2: id(), d3: id(), debrief: id() };
  const o = { a: id(), b: id(), c: id(), d: id(), r1: id(), r2: id(), r3: id(), r4: id() };
  const p = { d1ok: id(), d1miss: id(), d2ok: id(), d2late: id(), d3ok: id(), d3other: id() };
  const d = { d1: id(), d2: id(), d3: id() };
  const surf = (sid, kind, title, point) => ({ id: sid, kind, title, points: [point] });
  return {
    schema_version: 1,
    title: 'Interaction types demo (placeholder content)',
    summary: 'Exercises multi-select, ranking and free-text decisions in the room mockups.',
    audience: 'Mockup reviewers',
    setting: 'Any',
    duration_min: 15,
    learning_objectives: ['Review every interaction type on every screen.'],
    flags: [],
    surfaces: [
      surf(s.open, 'handover', 'Demo arrival', 'Placeholder handover for the interaction-types demo.'),
      surf(s.d1, 'update', 'Equipment check', 'Choose every item you would check before the procedure.'),
      surf(s.d1a, 'update', 'Checklist complete', 'Every critical item was checked.'),
      surf(s.d1b, 'update', 'An item was missed', 'The suction was not checked.'),
      surf(s.d2, 'update', 'Priorities', 'Rank the first three priorities.'),
      surf(s.d2a, 'update', 'Priorities in order', 'Airway came first.'),
      surf(s.d2b, 'update', 'Airway came late', 'Airway was not first.'),
      surf(s.d3, 'update', 'Handover', 'Write the one-line handover.'),
      surf(s.d3a, 'update', 'Clear handover', 'The handover named the problem.'),
      surf(s.d3b, 'update', 'Handover unclear', 'The problem was not named.'),
      surf(s.debrief, 'debrief', 'Demo debrief', 'End of the interaction-types demo.'),
    ],
    beats: [
      { id: b.open, kind: 'surface', title: 'Arrival', surface_id: s.open, next_beat_id: b.d1 },
      { id: b.d1, kind: 'decision', title: 'Equipment', surface_id: s.d1, decision_id: d.d1 },
      { id: b.d2, kind: 'decision', title: 'Priorities', surface_id: s.d2, decision_id: d.d2 },
      { id: b.d3, kind: 'decision', title: 'Handover', surface_id: s.d3, decision_id: d.d3 },
      { id: b.debrief, kind: 'debrief', title: 'Debrief', surface_id: s.debrief },
    ],
    start_beat_id: b.open,
    decisions: [
      {
        id: d.d1, prompt: 'Which items do you check? Choose all that apply.',
        interaction: { type: 'multi_select', options: [
          { id: o.a, label: 'Suction' }, { id: o.b, label: 'Oxygen' }, { id: o.c, label: 'Monitoring' }, { id: o.d, label: 'Music' },
        ] },
        rules: [{ when: { includes_all: [o.a, o.b, o.c], excludes: [o.d] }, path_id: p.d1ok, reason: 'All critical items, nothing extra' }],
        fallback_path_id: p.d1miss,
        paths: [
          { id: p.d1ok, label: 'Complete check', classification: 'sound', recommended: true, rationale: 'Every critical item checked.', reveal_surface_id: s.d1a, next_beat_id: b.d2, cue: 'Placeholder cue.' },
          { id: p.d1miss, label: 'Incomplete check', classification: 'defensible', rationale: 'An item was missed.', reveal_surface_id: s.d1b, next_beat_id: b.d2, cue: 'Placeholder cue.' },
        ],
      },
      {
        id: d.d2, prompt: 'Rank your first three priorities.',
        interaction: { type: 'ranking', rank_count: 3, options: [
          { id: o.r1, label: 'Airway' }, { id: o.r2, label: 'Breathing' }, { id: o.r3, label: 'Circulation' }, { id: o.r4, label: 'Paperwork' },
        ] },
        rules: [{ when: { top: [o.r1] }, path_id: p.d2ok, reason: 'Airway ranked first' }],
        fallback_path_id: p.d2late,
        paths: [
          { id: p.d2ok, label: 'Airway first', classification: 'sound', recommended: true, rationale: 'Airway first.', reveal_surface_id: s.d2a, next_beat_id: b.d3, cue: 'Placeholder cue.' },
          { id: p.d2late, label: 'Airway later', classification: 'context-dependent', rationale: 'Airway was not first.', reveal_surface_id: s.d2b, next_beat_id: b.d3, cue: 'Placeholder cue.' },
        ],
      },
      {
        id: d.d3, prompt: 'Write your one-line handover.',
        interaction: { type: 'free_text', max_length: 140 },
        rules: [{ when: { keywords: ['tension', 'pneumothorax'] }, path_id: p.d3ok, reason: 'Named the problem' }],
        fallback_path_id: p.d3other,
        paths: [
          { id: p.d3ok, label: 'Problem named', classification: 'sound', recommended: true, rationale: 'The handover named the problem.', reveal_surface_id: s.d3a, next_beat_id: b.debrief, cue: 'Placeholder cue.' },
          { id: p.d3other, label: 'Problem not named', classification: 'discussion-prompt', rationale: 'Discuss what the handover should say.', reveal_surface_id: s.d3b, next_beat_id: b.debrief, cue: 'Placeholder cue.' },
        ],
      },
    ],
  };
}
