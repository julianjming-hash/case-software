// src/shared/art-descriptor.mjs: the numbers-only art descriptor of a case (card 28, CASE-164).
//
// Pure and dependency-free: it runs in the Worker (publish verification and delivery), the builder
// (publish) and tests. The descriptor is the ONE thing about unrevealed structure that may reach a
// public client, so it carries integers and one boolean only: no ids, labels, classifications,
// flags or text (hard rule 1 exception, CASE-164).
//
//   { v: 1, stops, decisions: [{ stop, strands: [{ rejoin }], resets, ends }], attempt, summarised, renderer }
//
// Walk: follow the authored default route (each decision's recommended path) from start_beat_id.
// Every stop on that route gets an index. Every other path of each decision is
//   • a strand: it reaches a later stop on the default route (its rejoin index), possibly via side beats;
//   • a reset: terminal (back to its checkpoint), or it returns upstream;
//   • an end: it never returns to the default route.
// `attempt` and `summarised` are added by the builder's bounded layout search (src/shared/mosaic-geometry.mjs),
// with `renderer`, the geometry version that solved them. A published version keeps its renderer: a
// renderer change ships as a new version beside the old ones (tests/mosaic-fingerprint.test.mjs).

export const ART_DESCRIPTOR_VERSION = 1;
export const ART_ATTEMPTS = 16;
/** Renderer (geometry) versions the clients can draw, oldest first; the last is the one the builder solves with. */
export const ART_RENDERERS = Object.freeze([1]);
export const ART_LABEL = 'Abstract branching mosaic artwork';
export const ART_SUMMARISED_WARNING = 'This case is too large for the cover to show every route. The cover summarises each decision; case detail shows the full braid.';
export const ART_UNAVAILABLE_WARNING = 'This case is too large even for a summarised cover: some decisions may be missing from it. Case detail shows the full braid.';
// Generous bounds: a valid case document has at most a few hundred beats.
const MAX_STOPS = 1024, MAX_DECISIONS = 512, MAX_ROUTES = 64;

/** @param {object} doc a validated schema_version 1 case document */
export function describeCase(doc) {
  const beats = new Map(doc.beats.map((b) => [b.id, b]));
  const decisions = new Map(doc.decisions.map((d) => [d.id, d]));
  const recommendedNext = (b) => {
    const rec = decisions.get(b.decision_id)?.paths.find((p) => p.recommended === true);
    return rec && rec.next_beat_id ? rec.next_beat_id : null;
  };
  const route = [];
  const index = new Map();
  for (let b = beats.get(doc.start_beat_id); b && !index.has(b.id);) {
    index.set(b.id, route.length); route.push(b.id);
    const next = b.kind === 'decision' ? recommendedNext(b) : b.next_beat_id;
    b = next ? beats.get(next) : null;
  }
  // Follow a non-default path forward until it touches the default route (bounded: no infinite loops).
  const rejoinOf = (beatId) => {
    const seen = new Set();
    for (let id = beatId; id && !seen.has(id);) {
      if (index.has(id)) return index.get(id);
      seen.add(id);
      const b = beats.get(id);
      if (!b) return null;
      id = b.kind === 'decision' ? recommendedNext(b) : b.next_beat_id;
    }
    return null;
  };
  const out = { v: ART_DESCRIPTOR_VERSION, stops: route.length, decisions: [] };
  route.forEach((id, i) => {
    const b = beats.get(id);
    if (b.kind !== 'decision') return;
    const d = decisions.get(b.decision_id);
    const entry = { stop: i, strands: [], resets: 0, ends: 0 };
    for (const p of d.paths) {
      if (p.recommended === true) continue;
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

/** Canonical key of the structure: identical structure ⇒ identical key ⇒ identical geometry seed. */
export function structureKey(desc) {
  return 'b1|' + desc.stops + '|' + desc.decisions.map((d) => [d.stop, d.strands.map((s) => s.rejoin).join('.'), d.resets, d.ends].join(':')).join(',');
}

const int = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const exactKeys = (v, keys) => plain(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));

/** The structure alone (no solver fields), checked for shape and internal consistency. */
export function validStructure(d) {
  if (!plain(d) || d.v !== ART_DESCRIPTOR_VERSION || !int(d.stops, 0, MAX_STOPS) || !Array.isArray(d.decisions) || d.decisions.length > MAX_DECISIONS) return false;
  let last = -1;
  for (const x of d.decisions) {
    if (!exactKeys(x, ['stop', 'strands', 'resets', 'ends']) || !int(x.stop, 0, d.stops - 1) || x.stop <= last) return false;
    last = x.stop;
    if (!Array.isArray(x.strands) || x.strands.length > MAX_ROUTES || !int(x.resets, 0, MAX_ROUTES) || !int(x.ends, 0, MAX_ROUTES)) return false;
    if (!x.strands.every((s) => exactKeys(s, ['rejoin']) && int(s.rejoin, x.stop + 1, d.stops - 1))) return false;
  }
  return true;
}

/** A complete stored/delivered descriptor: the structure plus the solved attempt and summarised flag. */
export function validArtDescriptor(d) {
  return exactKeys(d, ['v', 'stops', 'decisions', 'attempt', 'summarised', 'renderer'])
    && validStructure({ v: d.v, stops: d.stops, decisions: d.decisions })
    && int(d.attempt, 0, ART_ATTEMPTS - 1) && typeof d.summarised === 'boolean' && ART_RENDERERS.includes(d.renderer);
}

/** A fresh copy built from validated fields only, or null. Delivery passes nothing else through. */
export function sanitizeArt(d) {
  if (!validArtDescriptor(d)) return null;
  return { v: d.v, stops: d.stops,
    decisions: d.decisions.map((x) => ({ stop: x.stop, strands: x.strands.map((s) => ({ rejoin: s.rejoin })), resets: x.resets, ends: x.ends })),
    attempt: d.attempt, summarised: d.summarised, renderer: d.renderer };
}

/** The structure without solver fields, in canonical key order. */
export const structureOf = (d) => ({ v: d.v, stops: d.stops,
  decisions: d.decisions.map((x) => ({ stop: x.stop, strands: x.strands.map((s) => ({ rejoin: s.rejoin })), resets: x.resets, ends: x.ends })) });

/** True when both carry the same structure (solver fields ignored). */
export function sameStructure(a, b) {
  if (!validStructure(structureOf(a)) || !validStructure(structureOf(b))) return false;
  return JSON.stringify(structureOf(a)) === JSON.stringify(structureOf(b));
}

/** The descriptor with the builder's solved layout attached. */
export function withSolution(desc, { attempt, summarised, renderer = ART_RENDERERS.at(-1) }) {
  return { ...structureOf(desc), attempt, summarised, renderer };
}

/** Builder readiness: a summarised (or, beyond capacity, unavailable) cover warns and never blocks publishing. */
export function artReadiness(art, { unavailable = false } = {}) {
  const out = art && art.summarised ? [{ code: 'art_summarised', at: '', message: ART_SUMMARISED_WARNING, blocking: false }] : [];
  if (unavailable) out.push({ code: 'art_unavailable', at: '', message: ART_UNAVAILABLE_WARNING, blocking: false });
  return out;
}

/** Every string, and every non-integer number other than the summarised flag, in a payload value. */
export function artPrivacyViolations(value, at = '') {
  if (typeof value === 'string') return [`${at}: string`];
  if (typeof value === 'boolean') return at.endsWith('/summarised') ? [] : [`${at}: boolean`];
  if (typeof value === 'number') return Number.isSafeInteger(value) ? [] : [`${at}: non-integer`];
  if (value === null || value === undefined) return [`${at}: empty`];
  if (Array.isArray(value)) return value.flatMap((v, i) => artPrivacyViolations(v, `${at}/${i}`));
  if (typeof value === 'object') {
    const allowed = new Set(['v', 'stops', 'decisions', 'attempt', 'summarised', 'renderer', 'stop', 'strands', 'resets', 'ends', 'rejoin']);
    return Object.entries(value).flatMap(([k, v]) => [...(allowed.has(k) ? [] : [`${at}/${k}: key`]), ...artPrivacyViolations(v, `${at}/${k}`)]);
  }
  return [`${at}: ${typeof value}`];
}
