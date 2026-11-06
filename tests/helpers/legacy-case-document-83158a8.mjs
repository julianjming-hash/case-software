// Frozen source at 83158a8; SHA256 1afd6471861c7aee68da5b7b7906c9fb1928364fdaaf700272416e8334fdd481; only import root rebased.
// src/shared/case-document.mjs: the case document format (schema_version 1) and its validator.
//
// A case is ONE JSON document (docs/ARCHITECTURE.md §5, CASE-049). This module is the source of
// truth for its shape. It runs everywhere: the Worker before save/publish, the builder for
// readiness, and the tests. It is dependency-free, and errors carry a JSON-pointer-like `at`.
//
// Shape (all ids UUIDv7, unique across the document):
//   { schema_version: 1, title, summary, audience, setting, duration_min, learning_objectives[],
//     flags[{id,key,label}], surfaces[{id,kind,title,scene?,points[],investigations?[],notes?,observations?,asset_ids?,variants?}],
//     beats[{id,kind,title,surface_id?,decision_id?,next_beat_id?,requires_flags?,cue?}],
//     start_beat_id,
//     decisions[{id,prompt,timer_s?,interaction{type,options[{id,label}],max_length?,rank_count?,order_meaning?},
//                rules?[{when,path_id,reason?}], fallback_path_id,
//                paths[{id,label,classification,recommended?,rationale,option_ids?,set_flags?,
//                       clear_flags?,reveal_surface_id,next_beat_id?,terminal?,cue}]}] }
//
// Semantics enforced (HANDOFF §Publishing and runtime invariants, CASE-040/041/042):
//   • every reference resolves; one start beat; every beat reachable from it
//   • a surface/debrief beat shows a surface; a decision beat owns exactly one decision
//   • single choice maps every option to exactly one path; multi/ranking/free text have rules + fallback
//   • exactly one recommended path per decision; >3 paths is a warning (recommended + up to two)
//   • `terminal-unsafe` paths, and only those, carry terminal {checkpoint_beat_id, debrief_prompt,
//     restore_policy:'snapshot'}; the checkpoint is a beat that lies on every route to the decision
//   • beat entry flags (requires_flags) are guaranteed on EVERY route into the beat (must-analysis)

import { isUuid } from '../../src/shared/ids.mjs';

export const SCHEMA_VERSION = 1;
export const SURFACE_KINDS = Object.freeze(['handover', 'update', 'observations', 'image', 'ecg', 'gas', 'text', 'debrief']);
export const BEAT_KINDS = Object.freeze(['surface', 'decision', 'debrief']);
export const INTERACTION_TYPES = Object.freeze(['single_choice', 'multi_select', 'ranking', 'free_text']);
export const CLASSIFICATIONS = Object.freeze(['sound', 'defensible', 'context-dependent', 'unsafe', 'terminal-unsafe', 'discussion-prompt']);
export const DURATIONS = Object.freeze([15, 45]);
const POINTS_MAX = 7;   // projected bullets per surface (a debrief may use one more)
const POINT_CHARS = 100;
const POINT_WORDS = 12;
export const SCENE_MAX = 320;      // projected scene prose (CASE-116): two or three sentences that paint the scene
const INVESTIGATIONS_MAX = 5;      // projected investigation results, a tile beside the findings (CASE-117)
/** Words, not separators: `Collar · 15 L NRB` is four words; `·`, `→` and `×` are not words. */
const words = (t) => t.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
const FLAG_KEY = /^[a-z][a-z0-9_]{1,47}$/;
const UNSAFE_TEXT = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ufeff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** @returns {{ok:boolean, errors:{code:string,at:string,message:string}[], warnings:{code:string,at:string,message:string}[]}} */
export function validateCaseDocument(doc) {
  const errors = [];
  const warnings = [];
  const err = (code, at, message) => errors.push({ code, at, message });
  const warn = (code, at, message) => warnings.push({ code, at, message });

  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    err('not_object', '', 'document must be a JSON object');
    return { ok: false, errors, warnings };
  }
  if (doc.schema_version !== SCHEMA_VERSION) err('schema_version', '/schema_version', `must be ${SCHEMA_VERSION}`);
  for (const k of ['title', 'summary', 'audience', 'setting']) str(doc[k], `/${k}`, 1, k === 'summary' ? 1200 : 200);
  if (!DURATIONS.includes(doc.duration_min)) err('duration', '/duration_min', `must be one of ${DURATIONS.join(', ')}`);
  arr(doc.learning_objectives, '/learning_objectives', 1, 8)?.forEach((o, i) => str(o, `/learning_objectives/${i}`, 1, 300));

  // ── ids ──
  const ids = new Map(); // id → at
  const claim = (id, at) => {
    if (!isUuid(id)) return err('bad_id', at, 'id must be a lower-case UUID (UUIDv7 for new items)');
    if (ids.has(id)) return err('duplicate_id', at, `id also used at ${ids.get(id)}`);
    ids.set(id, at);
  };

  // ── flags ──
  const flagKeys = new Set();
  (arr(doc.flags, '/flags', 0, 64) || []).forEach((f, i) => {
    const at = `/flags/${i}`;
    if (!obj(f, at)) return;
    claim(f.id, `${at}/id`);
    if (typeof f.key !== 'string' || !FLAG_KEY.test(f.key)) err('flag_key', `${at}/key`, 'snake_case, 2–48 chars');
    else if (flagKeys.has(f.key)) err('duplicate_flag', `${at}/key`, `flag ${f.key} defined twice`);
    else flagKeys.add(f.key);
    str(f.label, `${at}/label`, 1, 120);
  });
  const flagList = (v, at) => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) { err('type', at, 'must be an array of flag keys'); return []; }
    v.forEach((k, i) => { if (!flagKeys.has(k)) err('unknown_flag', `${at}/${i}`, `unknown flag "${k}"`); });
    return v.filter((k) => flagKeys.has(k));
  };

  // Projected text (CASE-087, CASE-116, CASE-117): a short `scene` (prose that paints the scene, at most
  // SCENE_MAX characters), telegraphic `points` (the findings) and optional `investigations` (results),
  // all shown identically on the projector and phones; `notes` reach only the facilitator. `body`, the
  // old long prose, stays refused. A variant may override the scene, points and investigations.
  const projectedText = (x, at, { variant = false } = {}) => {
    if (x.body !== undefined) err('not_allowed', `${at}/body`, 'use scene (short prose), points (shown to the room) and notes (facilitator only)');
    if (x.scene !== undefined) str(x.scene, `${at}/scene`, 1, SCENE_MAX);
    else if (!variant) warn('no_scene', `${at}/scene`, 'add two or three sentences that paint the scene for the room');
    const pts = arr(x.points, `${at}/points`, 1, POINTS_MAX + 1) || [];
    const bullet = (pt, a) => {
      str(pt, a, 1, POINT_CHARS);
      if (typeof pt === 'string' && words(pt) > POINT_WORDS) warn('long_point', a, `over ${POINT_WORDS} words; keep projected points telegraphic`);
    };
    pts.forEach((pt, k) => bullet(pt, `${at}/points/${k}`));
    if (pts.length > POINTS_MAX && x.kind !== 'debrief') warn('many_points', `${at}/points`, `${pts.length} points; aim for ${POINTS_MAX} or fewer`);
    if (x.investigations !== undefined) (arr(x.investigations, `${at}/investigations`, 1, INVESTIGATIONS_MAX) || []).forEach((pt, k) => bullet(pt, `${at}/investigations/${k}`));
    if (x.notes !== undefined) str(x.notes, `${at}/notes`, 0, 2000);
  };

  // ── surfaces ──
  const surfaces = new Map();
  (arr(doc.surfaces, '/surfaces', 1, 200) || []).forEach((s, i) => {
    const at = `/surfaces/${i}`;
    if (!obj(s, at)) return;
    claim(s.id, `${at}/id`);
    surfaces.set(s.id, s);
    if (!SURFACE_KINDS.includes(s.kind)) err('enum', `${at}/kind`, `one of ${SURFACE_KINDS.join(', ')}`);
    str(s.title, `${at}/title`, 1, 120);
    projectedText(s, at);
    if (s.observations !== undefined) {
      (arr(s.observations, `${at}/observations`, 1, 20) || []).forEach((o, j) => {
        const oa = `${at}/observations/${j}`;
        if (!obj(o, oa)) return;
        str(o.label, `${oa}/label`, 1, 40);
        str(String(o.value ?? ''), `${oa}/value`, 1, 40);
        if (o.unit !== undefined) str(o.unit, `${oa}/unit`, 0, 20);
      });
    }
    if (s.asset_ids !== undefined) (arr(s.asset_ids, `${at}/asset_ids`, 0, 8) || []).forEach((a, j) => { if (!isUuid(a)) err('bad_id', `${at}/asset_ids/${j}`, 'asset id must be a UUID'); });
    if (s.variants !== undefined) {
      (arr(s.variants, `${at}/variants`, 1, 8) || []).forEach((v, j) => {
        const va = `${at}/variants/${j}`;
        if (!obj(v, va)) return;
        flagList(v.when_flags, `${va}/when_flags`);
        if (!Array.isArray(v.when_flags) || v.when_flags.length === 0) err('required', `${va}/when_flags`, 'at least one flag');
        projectedText(v, va, { variant: true });
      });
    }
  });

  // ── decisions (collected before beats so beats can reference them) ──
  const decisions = new Map();
  const paths = new Map(); // pathId → {path, decisionId}
  (arr(doc.decisions, '/decisions', 0, 40) || []).forEach((d, i) => {
    const at = `/decisions/${i}`;
    if (!obj(d, at)) return;
    claim(d.id, `${at}/id`);
    decisions.set(d.id, { d, at });
    str(d.prompt, `${at}/prompt`, 1, 200);
    if (d.timer_s !== undefined && d.timer_s !== null && !(Number.isInteger(d.timer_s) && d.timer_s >= 10 && d.timer_s <= 600)) {
      err('range', `${at}/timer_s`, 'null or an integer 10–600');
    }
    const it = d.interaction;
    if (!obj(it, `${at}/interaction`)) return;
    if (!INTERACTION_TYPES.includes(it.type)) err('enum', `${at}/interaction/type`, `one of ${INTERACTION_TYPES.join(', ')}`);
    if (Object.hasOwn(it, 'order_meaning')) {
      if (it.type !== 'ranking') err('not_allowed', `${at}/interaction/order_meaning`, 'only ranking has an order meaning');
      else if (!['priority', 'action'].includes(it.order_meaning)) err('enum', `${at}/interaction/order_meaning`, 'priority or action');
    }
    const optionIds = new Set();
    if (it.type === 'free_text') {
      if (!(Number.isInteger(it.max_length) && it.max_length >= 1 && it.max_length <= 280)) err('range', `${at}/interaction/max_length`, 'integer 1–280');
      if (it.options !== undefined && it.options.length) err('not_allowed', `${at}/interaction/options`, 'free text has no options');
    } else {
      (arr(it.options, `${at}/interaction/options`, 2, 8) || []).forEach((o, j) => {
        const oa = `${at}/interaction/options/${j}`;
        if (!obj(o, oa)) return;
        claim(o.id, `${oa}/id`);
        optionIds.add(o.id);
        str(o.label, `${oa}/label`, 1, 120);
      });
      if (it.type === 'ranking' && it.rank_count !== undefined && !(Number.isInteger(it.rank_count) && it.rank_count >= 2 && it.rank_count <= optionIds.size)) {
        err('range', `${at}/interaction/rank_count`, `integer 2–${optionIds.size}`);
      }
    }

    let recommended = 0;
    const mapped = new Map(); // optionId → pathId
    const pathList = arr(d.paths, `${at}/paths`, 1, 8) || [];
    if (pathList.length > 3) warn('branching_complexity', `${at}/paths`, `${pathList.length} paths; guidance is the recommended path plus up to two alternatives, each with a teaching purpose`);
    pathList.forEach((p, j) => {
      const pa = `${at}/paths/${j}`;
      if (!obj(p, pa)) return;
      claim(p.id, `${pa}/id`);
      paths.set(p.id, { p, decisionId: d.id, at: pa });
      str(p.label, `${pa}/label`, 1, 120);
      str(p.rationale, `${pa}/rationale`, 1, 600);
      str(p.cue, `${pa}/cue`, 1, 600);
      if (!CLASSIFICATIONS.includes(p.classification)) err('enum', `${pa}/classification`, `one of ${CLASSIFICATIONS.join(', ')}`);
      if (p.recommended !== undefined && typeof p.recommended !== 'boolean') err('recommended_type', `${pa}/recommended`, 'must be true or false');
      if (p.recommended === true) recommended++;
      flagList(p.set_flags, `${pa}/set_flags`);
      flagList(p.clear_flags, `${pa}/clear_flags`);
      if (!surfaces.has(p.reveal_surface_id)) err('ref', `${pa}/reveal_surface_id`, 'must reference a surface');
      const isTerminal = p.classification === 'terminal-unsafe';
      if (isTerminal) {
        if (!obj(p.terminal, `${pa}/terminal`)) { /* reported */ } else {
          str(p.terminal.debrief_prompt, `${pa}/terminal/debrief_prompt`, 1, 600);
          if (p.terminal.restore_policy !== 'snapshot') err('enum', `${pa}/terminal/restore_policy`, 'must be "snapshot"');
        }
        if (p.next_beat_id !== undefined) err('not_allowed', `${pa}/next_beat_id`, 'a terminal path resets to its checkpoint instead');
      } else {
        if (p.terminal !== undefined) err('not_allowed', `${pa}/terminal`, 'only terminal-unsafe paths are terminal');
        if (typeof p.next_beat_id !== 'string') err('required', `${pa}/next_beat_id`, 'non-terminal paths must name the next beat');
      }
      if (it.type === 'single_choice') {
        (arr(p.option_ids, `${pa}/option_ids`, 0, 8) || []).forEach((o, k) => {
          if (!optionIds.has(o)) err('ref', `${pa}/option_ids/${k}`, 'unknown option');
          else if (mapped.has(o)) err('option_mapped_twice', `${pa}/option_ids/${k}`, `option already maps to path ${mapped.get(o)}`);
          else mapped.set(o, p.id);
        });
      } else if (p.option_ids !== undefined) err('not_allowed', `${pa}/option_ids`, 'option_ids is only for single choice; use rules');
    });
    if (recommended !== 1) err('recommended', `${at}/paths`, `exactly one path must be recommended (found ${recommended})`);
    const decisionPaths = new Set(pathList.map((p) => p && p.id));
    if (!decisionPaths.has(d.fallback_path_id)) err('ref', `${at}/fallback_path_id`, 'must be one of this decision\'s paths');
    else if (pathList.find((p) => p?.id === d.fallback_path_id)?.classification === 'terminal-unsafe') {
      err('terminal_fallback', `${at}/fallback_path_id`, 'the fallback (used for no votes or a tie) must not be a terminal path');
    }

    if (it.type === 'single_choice') {
      for (const o of optionIds) if (!mapped.has(o)) err('option_unmapped', `${at}/interaction/options`, `option ${o} maps to no path`);
      if (d.rules !== undefined && d.rules.length) err('not_allowed', `${at}/rules`, 'single choice maps options via option_ids');
    } else {
      (arr(d.rules, `${at}/rules`, 1, 12) || []).forEach((r, j) => {
        const ra = `${at}/rules/${j}`;
        if (!obj(r, ra)) return;
        if (!decisionPaths.has(r.path_id)) err('ref', `${ra}/path_id`, 'must be one of this decision\'s paths');
        if (r.reason !== undefined) str(r.reason, `${ra}/reason`, 1, 200);
        checkWhen(it.type, r.when, optionIds, `${ra}/when`);
      });
    }
  });

  function checkWhen(type, when, optionIds, at) {
    if (!obj(when, at)) return;
    const allowed = {
      multi_select: ['includes_all', 'includes_any', 'excludes'],
      ranking: ['top', 'before'],
      free_text: ['keywords'],
    }[type] || [];
    const keys = Object.keys(when);
    if (keys.length === 0) err('required', at, 'empty condition');
    for (const k of keys) {
      if (!allowed.includes(k)) { err('not_allowed', `${at}/${k}`, `not a ${type} condition (use ${allowed.join(', ')})`); continue; }
      if (k === 'keywords') {
        (arr(when[k], `${at}/${k}`, 1, 40) || []).forEach((w, i) => str(w, `${at}/${k}/${i}`, 2, 40));
      } else if (k === 'before') {
        if (!Array.isArray(when.before) || when.before.length !== 2 || !when.before.every((o) => optionIds.has(o))) err('ref', `${at}/before`, 'two option ids [a, b]: a ranked above b');
      } else {
        (arr(when[k], `${at}/${k}`, 1, 8) || []).forEach((o, i) => { if (!optionIds.has(o)) err('ref', `${at}/${k}/${i}`, 'unknown option'); });
      }
    }
  }

  // ── beats ──
  const beats = new Map();
  const decisionOwners = new Map();
  (arr(doc.beats, '/beats', 1, 60) || []).forEach((b, i) => {
    const at = `/beats/${i}`;
    if (!obj(b, at)) return;
    claim(b.id, `${at}/id`);
    beats.set(b.id, { b, at });
    if (!BEAT_KINDS.includes(b.kind)) err('enum', `${at}/kind`, `one of ${BEAT_KINDS.join(', ')}`);
    str(b.title, `${at}/title`, 1, 120);
    if (b.cue !== undefined) str(b.cue, `${at}/cue`, 0, 600);
    flagList(b.requires_flags, `${at}/requires_flags`);
    if (b.kind === 'decision') {
      if (!decisions.has(b.decision_id)) err('ref', `${at}/decision_id`, 'must reference a decision');
      else if (decisionOwners.has(b.decision_id)) err('decision_shared', `${at}/decision_id`, `decision already owned by ${decisionOwners.get(b.decision_id)}`);
      else decisionOwners.set(b.decision_id, at);
      if (!surfaces.has(b.surface_id)) err('ref', `${at}/surface_id`, 'a decision beat shows a surface (its prompt context)');
      if (b.next_beat_id !== undefined) err('not_allowed', `${at}/next_beat_id`, 'a decision continues through its paths');
    } else {
      if (!surfaces.has(b.surface_id)) err('ref', `${at}/surface_id`, 'must reference a surface');
      if (b.decision_id !== undefined) err('not_allowed', `${at}/decision_id`, 'only decision beats own a decision');
    }
  });
  for (const id of decisions.keys()) if (!decisionOwners.has(id)) err('decision_orphan', '/decisions', `decision ${id} is not used by any beat`);
  for (const [, { b, at }] of beats) if (b.next_beat_id !== undefined && !beats.has(b.next_beat_id)) err('ref', `${at}/next_beat_id`, 'must reference a beat');
  for (const [, { p, at }] of paths) {
    if (p.next_beat_id !== undefined && !beats.has(p.next_beat_id)) err('ref', `${at}/next_beat_id`, 'must reference a beat');
    if (p.terminal && !beats.has(p.terminal.checkpoint_beat_id)) err('ref', `${at}/terminal/checkpoint_beat_id`, 'must reference a beat');
  }
  if (!beats.has(doc.start_beat_id)) err('ref', '/start_beat_id', 'must reference a beat');

  // Graph analysis only on a referentially sound document.
  if (errors.length === 0) graphChecks();
  answerCues(doc, warn);
  return { ok: errors.length === 0, errors, warnings };

  function graphChecks() {
    const succ = (beatId) => {
      const { b } = beats.get(beatId);
      if (b.kind !== 'decision') return b.next_beat_id ? [{ to: b.next_beat_id, set: [], clear: [] }] : [];
      const { d } = decisions.get(b.decision_id);
      return d.paths.filter((p) => p.next_beat_id).map((p) => ({ to: p.next_beat_id, set: p.set_flags || [], clear: p.clear_flags || [] }));
    };
    // Reachability.
    const seen = new Set([doc.start_beat_id]);
    const queue = [doc.start_beat_id];
    while (queue.length) for (const e of succ(queue.shift())) if (!seen.has(e.to)) { seen.add(e.to); queue.push(e.to); }
    for (const [id, { at }] of beats) if (!seen.has(id)) err('unreachable', at, `beat ${id} is not reachable from start_beat_id`);
    if (!seen.size || errors.length) return;

    // Must-analysis: flags guaranteed on entry to each beat = ∩ over incoming routes.
    const ALL = [...flagKeys];
    const entry = new Map([...beats.keys()].map((id) => [id, new Set(ALL)]));
    entry.set(doc.start_beat_id, new Set());
    let changed = true;
    let guard = 0;
    while (changed && guard++ < 1000) {
      changed = false;
      for (const id of seen) {
        const out = entry.get(id);
        for (const e of succ(id)) {
          const exit = new Set([...out, ...e.set].filter((k) => !e.clear.includes(k)));
          const cur = entry.get(e.to);
          const next = new Set([...cur].filter((k) => exit.has(k)));
          if (e.to === doc.start_beat_id) continue;
          if (next.size !== cur.size) { entry.set(e.to, next); changed = true; }
        }
      }
    }
    for (const [id, { b, at }] of beats) {
      for (const k of b.requires_flags || []) {
        if (!entry.get(id).has(k)) err('entry_flag_unmet', `${at}/requires_flags`, `flag "${k}" is not guaranteed on every route into "${b.title}"`);
      }
    }

    // Terminal checkpoints must dominate (lie on every route to) the decision they reset.
    for (const [, { p, decisionId, at }] of paths) {
      if (!p.terminal) continue;
      const decisionBeat = [...beats.values()].find(({ b }) => b.decision_id === decisionId).b.id;
      const cp = p.terminal.checkpoint_beat_id;
      if (cp !== decisionBeat && reachableAvoiding(doc.start_beat_id, decisionBeat, cp)) {
        err('checkpoint_not_dominating', `${at}/terminal/checkpoint_beat_id`, 'the checkpoint must lie on every route to this decision (normally the decision beat or the spine beat before it)');
      }
    }
    function reachableAvoiding(from, to, avoid) {
      if (from === avoid) return false;
      const s = new Set([from]);
      const q = [from];
      while (q.length) {
        const x = q.shift();
        if (x === to) return true;
        for (const e of succ(x)) if (e.to !== avoid && !s.has(e.to)) { s.add(e.to); q.push(e.to); }
      }
      return false;
    }

    // An ending exists: some reachable beat has no successor.
    if (![...seen].some((id) => succ(id).length === 0)) err('no_ending', '/beats', 'no reachable beat ends the case');
  }

  // ── small helpers ──
  function str(v, at, min, max) {
    if (typeof v !== 'string') return err('type', at, 'must be a string');
    if (v.length < min || v.length > max) err('length', at, `length must be ${min}–${max}`);
    // Content is rendered as text only, but control and bidi characters still corrupt archives and
    // can disguise text, so they are refused at authoring time (red team P0-4, P1 XSS).
    if (UNSAFE_TEXT.test(v)) err('unsafe_characters', at, 'contains control, bidi-override or unpaired-surrogate characters');
  }
  function arr(v, at, min, max) {
    if (!Array.isArray(v)) { err('type', at, 'must be an array'); return null; }
    if (v.length < min || v.length > max) err('length', at, `must have ${min}–${max} items`);
    return v;
  }
  function obj(v, at) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) { err('type', at, 'must be an object'); return false; }
    return true;
  }
}

/** Index a (valid) document for fast lookup by the runtime. */
export function indexCaseDocument(doc) {
  const surfaces = new Map(doc.surfaces.map((s) => [s.id, s]));
  const beats = new Map(doc.beats.map((b) => [b.id, b]));
  const decisions = new Map(doc.decisions.map((d) => [d.id, d]));
  const paths = new Map();
  for (const d of doc.decisions) for (const p of d.paths) paths.set(p.id, { ...p, decision_id: d.id });
  const beatForDecision = new Map(doc.beats.filter((b) => b.kind === 'decision').map((b) => [b.decision_id, b.id]));
  return { doc, surfaces, beats, decisions, paths, beatForDecision };
}

/**
 * Suggest a path from responses (never chooses it: the facilitator does, CASE-042).
 * @param {object} decision
 * @param {object[]} responses  shapes: single {option_id} · multi {option_ids} · ranking {order} · free {text}
 * @returns {{path_id:string, reason:string, counts:Record<string,number>, total:number}}
 */
export function suggestPath(decision, responses) {
  const type = decision.interaction.type;
  const counts = {};
  const total = responses.length;
  if (total === 0) return { path_id: decision.fallback_path_id, reason: 'No responses; fallback path.', counts, total, kind: 'none' };

  if (type === 'single_choice') {
    for (const r of responses) counts[r.option_id] = (counts[r.option_id] || 0) + 1;
    const order = decision.interaction.options.map((o) => o.id);
    const top = order.reduce((best, id) => ((counts[id] || 0) > (counts[best] || 0) ? id : best), order[0]);
    const tied = order.filter((id) => (counts[id] || 0) === (counts[top] || 0)).length > 1;
    if (tied) return { path_id: decision.fallback_path_id, reason: 'Tied vote; fallback path.', counts, total, kind: 'tie' };
    const path = decision.paths.find((p) => (p.option_ids || []).includes(top));
    return { path_id: path.id, reason: `Most chose "${label(top)}" (${counts[top]}/${total}).`, counts, total, kind: 'plurality' };
  }

  // Rule-based types: evaluate rules per response, suggest the most common rule outcome.
  const outcome = {};
  for (const r of responses) {
    let hit = null;
    if (type === 'multi_select') for (const o of r.option_ids || []) counts[o] = (counts[o] || 0) + 1;
    if (type === 'ranking') { const first = (r.order || [])[0]; if (first) counts[first] = (counts[first] || 0) + 1; }
    for (const rule of decision.rules || []) {
      if (matches(type, rule.when, r)) { hit = rule.path_id; break; }
    }
    hit = hit || decision.fallback_path_id;
    outcome[hit] = (outcome[hit] || 0) + 1;
  }
  const best = Object.keys(outcome).sort((a, b) => outcome[b] - outcome[a])[0];
  const rule = (decision.rules || []).find((x) => x.path_id === best);
  return { path_id: best, reason: rule?.reason ? `${rule.reason} (${outcome[best]}/${total}).` : `Most responses fit this path (${outcome[best]}/${total}).`, counts, total, kind: 'rules' };

  function label(id) { return decision.interaction.options.find((o) => o.id === id)?.label ?? id; }
}

function matches(type, when, r) {
  if (type === 'multi_select') {
    const s = new Set(r.option_ids || []);
    if (when.includes_all && !when.includes_all.every((o) => s.has(o))) return false;
    if (when.includes_any && !when.includes_any.some((o) => s.has(o))) return false;
    if (when.excludes && when.excludes.some((o) => s.has(o))) return false;
    return true;
  }
  if (type === 'ranking') {
    const order = r.order || [];
    if (when.top && !when.top.every((o, i) => order[i] === o)) return false;
    if (when.before) {
      const [a, b] = when.before;
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      if (ia === -1 || (ib !== -1 && ia > ib)) return false;
    }
    return true;
  }
  if (type === 'free_text') {
    const t = String(r.text || '').toLowerCase();
    return (when.keywords || []).some((k) => t.includes(k.toLowerCase()));
  }
  return false;
}

/**
 * Options keep ONE authored order everywhere (CASE-088: no per-phone shuffle; the projector and
 * phones share glyph and colour by position). So the order and wording must not give the answer
 * away: warn when the recommended option is first in every single-choice decision, or is clearly
 * the longest option in a decision (red team, teaching #4).
 */
function answerCues(doc, warn) {
  const single = (Array.isArray(doc.decisions) ? doc.decisions : []).filter((d) => d?.interaction?.type === 'single_choice' && Array.isArray(d.interaction.options) && Array.isArray(d.paths));
  const recIndex = [];
  single.forEach((d) => {
    const at = `/decisions/${doc.decisions.indexOf(d)}`;
    const rec = d.paths.find((p) => p?.recommended === true);
    const opts = d.interaction.options;
    const recOpts = new Set(rec?.option_ids ?? []);
    const i = opts.findIndex((o) => recOpts.has(o?.id));
    if (i < 0) return;
    recIndex.push(i);
    const len = (o) => String(o?.label ?? '').length;
    const others = opts.filter((o) => !recOpts.has(o?.id)).map(len);
    if (others.length && len(opts[i]) > 1.3 * Math.max(...others)) {
      warn('cue_length', `${at}/interaction/options/${i}`, 'the recommended option is clearly the longest; even out the labels');
    }
  });
  if (recIndex.length >= 2 && recIndex.every((i) => i === 0)) {
    warn('cue_position', '/decisions', 'the recommended option is first in every decision; shuffle the option order (shuffleOptions)');
  }
}

/**
 * Build-time shuffle (CASE-088): reorders each decision's options ONCE, when the builder saves or
 * publishes, so the authored order cannot cue the answer. Deterministic for a seed, pure, and the
 * result is then the one order the room sees. Ids and mappings are untouched.
 */
export function shuffleOptions(doc, seed) {
  const out = structuredClone(doc);
  for (const d of out.decisions ?? []) {
    if (Array.isArray(d.interaction?.options)) d.interaction.options = seededShuffle(d.interaction.options, `${seed}:${d.id}`);
  }
  return out;
}

/** Deterministic shuffle: FNV-1a seed, mulberry32 PRNG, Fisher–Yates. Pure. */
export function seededShuffle(items, seedText) {
  let h = 0x811c9dc5;
  for (let i = 0; i < seedText.length; i++) { h ^= seedText.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  let t = h;
  const rand = () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
