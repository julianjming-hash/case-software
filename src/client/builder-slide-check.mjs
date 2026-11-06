// Card 51: what every Builder view needs to load a schema-3 slide draft: the slide validator and which stages are
// composed. The route loads it only when the server grants `slide_composition`. The slide canvas itself
// (builder-slides.mjs) loads only when the editor view is shown.
export { validateSlideParts } from '../shared/slide-document.mjs';

/**
 * The composition shown for a selection: a clarification's own slide when one is selected (D15), else a consequence's
 * own slide when it has one, otherwise its stage's.
 */
export function compositionFor(document, { beatId, pathId, clarificationId = null }) {
  const find = (kind, id) => (document?.compositions ?? []).find(item => item.owner?.kind === kind && item.owner.id === id) ?? null;
  if (clarificationId) return find('clarification', clarificationId);
  return (pathId && find('path', pathId)) || find('beat', beatId);
}
/**
 * The decision a clarification's slide may place as its Question block (D15): the one decision every stage it is
 * shown during asks, or null. The room shows a clarification while that question is open.
 */
export function clarificationDecision(document, clarificationId) {
  const stages = (document?.clarifications ?? []).find(item => item.id === clarificationId)?.beat_ids ?? [];
  const asked = new Set(stages.map(id => (document.beats ?? []).find(beat => beat.id === id)?.decision_id ?? null));
  const [only] = asked;
  return stages.length && asked.size === 1 && only ? only : null;
}
/** A beat's surface is composed when the beat has a slide; schema 3 refuses mixed composed and legacy use. */
export const isComposed = (document, beatId) => document?.schema_version === 3 && Boolean(compositionFor(document, { beatId }));

/**
 * After a graph edit (stage, consequence or clarification removed), drop the slides of owners that no longer exist and
 * the blocks no remaining slide shows. Like stage removal itself, it refuses (`traces` > 0) while private source traces
 * still point into that content, so no trace is orphaned or silently dropped.
 */
export function reconcile(document, metadata) {
  if (document?.schema_version !== 3 || !Array.isArray(document.compositions)) return { document, traces: 0, traced: [] };
  const owners = new Set([...(document.beats ?? []).map(item => `beat:${item.id}`), ...(document.clarifications ?? []).map(item => `clarification:${item.id}`),
    ...(document.decisions ?? []).flatMap(decision => (decision.paths ?? []).map(path => `path:${path.id}`))]);
  const kept = document.compositions.filter(item => owners.has(`${item.owner?.kind}:${item.owner?.id}`));
  if (kept.length === document.compositions.length) return { document, traces: 0, traced: [] };
  const shown = new Set(kept.flatMap(item => item.reading_order ?? []));
  const gone = (document.blocks ?? []).filter(block => !shown.has(block.id) && document.compositions.some(item => !kept.includes(item) && item.reading_order?.includes(block.id)));
  // Every nested identity a trace can name: table and value rows, timeline entries, columns, trend points and series,
  // and a blood gas's groups and their rows.
  const nested = block => ['rows', 'entries', 'columns', 'points', 'series', 'groups'].flatMap(key => (block[key] ?? []).flatMap(item => [item.id, ...(key === 'groups' ? (item.rows ?? []).map(row => row.id) : [])]));
  const inside = new Set(gone.flatMap(block => [block.id, ...nested(block)]));
  // `traced` lists each blocking trace's index, so a review can name it and lead to it (D7).
  const traced = (metadata?.provenance ?? []).flatMap((entry, index) => inside.has(entry?.entity_id) ? [index] : []);
  return { document: { ...document, compositions: kept, blocks: document.blocks.filter(block => !gone.includes(block)) }, traces: traced.length, traced };
}
