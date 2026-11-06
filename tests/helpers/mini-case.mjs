// tests/helpers/mini-case.mjs: a minimal valid case document for unit tests.
import { uuidv7 } from '../../src/shared/ids.mjs';

/** Minimal valid two-decision case: open → D1 (sound | unsafe-delay | terminal) → reassess D2 → debrief. */
export function miniCase() {
  const id = () => uuidv7();
  const s = { open: id(), d1ctx: id(), partial: id(), delay: id(), arrest: id(), d2ctx: id(), better: id(), debrief: id() };
  const b = { open: id(), d1: id(), d2: id(), debrief: id() };
  const o = { decompress: id(), image: id(), intubate: id(), fast: id(), fluids: id() };
  const p = { decompress: id(), image: id(), intubate: id(), fast: id(), fluids: id() };
  const f = { treated: id() };
  const d1 = id();
  const d2 = id();
  const surface = (sid, kind, title) => ({ id: sid, kind, title, points: [`${title}.`] });
  const doc = {
    schema_version: 1,
    title: 'Mini case',
    summary: 'A minimal case for tests.',
    audience: 'Registrars',
    setting: 'Rural ED',
    duration_min: 15,
    learning_objectives: ['Recognise and treat tension physiology.'],
    flags: [{ id: f.treated, key: 'workshop_flag_01', label: 'Tension treated' }],
    surfaces: [
      surface(s.open, 'handover', 'Arrival'),
      surface(s.d1ctx, 'observations', 'Primary survey'),
      surface(s.partial, 'update', 'Partial response'),
      surface(s.delay, 'update', 'Worse while imaging'),
      surface(s.arrest, 'update', 'PEA after induction'),
      surface(s.d2ctx, 'update', 'Second shock'),
      surface(s.better, 'update', 'Haemorrhage found'),
      surface(s.debrief, 'debrief', 'Debrief'),
    ],
    beats: [
      { id: b.open, kind: 'surface', title: 'Arrival', surface_id: s.open, next_beat_id: b.d1 },
      { id: b.d1, kind: 'decision', title: 'Decisive intervention', surface_id: s.d1ctx, decision_id: d1 },
      { id: b.d2, kind: 'decision', title: 'Reassess', surface_id: s.d2ctx, decision_id: d2, requires_flags: ['workshop_flag_01'] },
      { id: b.debrief, kind: 'debrief', title: 'Debrief', surface_id: s.debrief },
    ],
    start_beat_id: b.open,
    decisions: [
      {
        id: d1,
        prompt: 'S00172 workshop prompt. Record a sensor',
        interaction: { type: 'single_choice', options: [
          { id: o.decompress, label: 'Decompress the right chest' },
          { id: o.image, label: 'Chest X-ray first' },
          { id: o.intubate, label: 'RSI and intubate' },
        ] },
        fallback_path_id: p.decompress,
        paths: [
          { id: p.decompress, label: 'Decompress', classification: 'sound', recommended: true, rationale: 'Treats tension.', option_ids: [o.decompress], set_flags: ['workshop_flag_01'], reveal_surface_id: s.partial, next_beat_id: b.d2, cue: 'Pause.' },
          { id: p.image, label: 'Image first', classification: 'unsafe', rationale: 'Delays treatment.', option_ids: [o.image], set_flags: ['workshop_flag_01'], reveal_surface_id: s.delay, next_beat_id: b.d2, cue: 'Cost of delay; then decompress.' },
          { id: p.intubate, label: 'Intubate first', classification: 'terminal-unsafe', rationale: 'PPV on untreated tension → arrest.', option_ids: [o.intubate], reveal_surface_id: s.arrest, terminal: { checkpoint_beat_id: b.d1, debrief_prompt: 'Why did positive pressure precipitate arrest?', restore_policy: 'snapshot' }, cue: 'Let the room feel it.' },
        ],
      },
      {
        id: d2,
        prompt: 'S00200 workshop prompt. Record a sensor s',
        interaction: { type: 'single_choice', options: [{ id: o.fast, label: 'Repeat primary survey + eFAST' }, { id: o.fluids, label: 'More crystalloid' }] },
        fallback_path_id: p.fast,
        paths: [
          { id: p.fast, label: 'Reassess', classification: 'sound', recommended: true, rationale: 'Finds the bleed.', option_ids: [o.fast], reveal_surface_id: s.better, next_beat_id: b.debrief, cue: 'Activate MTP.' },
          { id: p.fluids, label: 'Fluids', classification: 'unsafe', rationale: 'Dilutes, delays.', option_ids: [o.fluids], reveal_surface_id: s.better, next_beat_id: b.debrief, cue: 'Discuss.' },
        ],
      },
    ],
  };
  return { doc, s, b, o, p, d1, d2 };
}
