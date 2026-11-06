// prototypes/design/art-descriptor.mjs — SPIKE: derive the sanitized artwork descriptor from a case document.
//
// Design artifact for spec §6 (Julian, 2026-10-06: descriptor + client rendering, braided strands, full art
// for everyone under the topology-only exception). Pure and dependency-free so the same logic can run in the
// Worker at publish time. The output carries NUMBERS ONLY: no ids, labels, classifications, text or flags.
//
// Walk: follow the authored default route (each decision's recommended path) from start_beat_id. Every stop
// on that route (surface, decision or debrief beat) gets an index. For each decision, every other path is:
//   • a strand  — it reaches a later stop on the default route (its rejoin index), possibly via side beats;
//   • a reset   — terminal (terminal-unsafe → checkpoint): drawn as a loop back towards the checkpoint;
//   • an end    — it never returns to the default route (a true divergence that finishes elsewhere).
// Side beats on a strand are not drawn individually in v1; the strand spans them.

/** @param {object} doc a validated schema_version 1 case document */
export function describeCase(doc) {
  const beats = new Map(doc.beats.map((b) => [b.id, b]));
  const decisions = new Map(doc.decisions.map((d) => [d.id, d]));
  const route = [];                     // beat ids on the default route, in order
  const index = new Map();
  for (let b = beats.get(doc.start_beat_id); b && !index.has(b.id);) {
    index.set(b.id, route.length); route.push(b.id);
    if (b.kind === 'decision') {
      const rec = decisions.get(b.decision_id).paths.find((p) => p.recommended);
      b = rec && rec.next_beat_id ? beats.get(rec.next_beat_id) : null;
    } else b = b.next_beat_id ? beats.get(b.next_beat_id) : null;
  }
  // Follow a non-default path forward until it touches the default route (bounded: no infinite loops).
  const rejoinOf = (beatId) => {
    const seen = new Set();
    for (let id = beatId; id && !seen.has(id);) {
      if (index.has(id)) return index.get(id);
      seen.add(id);
      const b = beats.get(id); if (!b) return null;
      if (b.kind === 'decision') { const rec = decisions.get(b.decision_id).paths.find((p) => p.recommended); id = rec ? rec.next_beat_id : null; }
      else id = b.next_beat_id;
    }
    return null;
  };
  const out = { v: 1, stops: route.length, decisions: [] };
  route.forEach((id, i) => {
    const b = beats.get(id); if (b.kind !== 'decision') return;
    const d = decisions.get(b.decision_id);
    const entry = { stop: i, strands: [], resets: 0, ends: 0 };
    for (const p of d.paths) {
      if (p.recommended) continue;
      if (p.terminal) { entry.resets++; continue; }
      const j = p.next_beat_id ? rejoinOf(p.next_beat_id) : null;
      if (j != null && j > i) entry.strands.push({ rejoin: j });
      else if (j != null) entry.resets++;            // returns upstream: drawn like a reset loop
      else entry.ends++;
    }
    out.decisions.push(entry);
  });
  return out;
}

/** Canonical key of the descriptor: identical structure ⇒ identical key ⇒ identical geometry seed. */
export function structureKey(desc) {
  return 'b1|' + desc.stops + '|' + desc.decisions.map((d) => [d.stop, d.strands.map((s) => s.rejoin).join('.'), d.resets, d.ends].join(':')).join(',');
}
