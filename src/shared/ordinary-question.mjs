/** An ordinary question has no response-dependent route mapping for an author to maintain. */
import { formattedTextPlainText } from './builder-format.mjs';
export function isQuestionOnlySlide(document, beatId) {
  const slide = document.compositions?.find(item => item.owner?.kind === 'beat' && item.owner.id === beatId);
  return slide?.reading_order?.length === 1 && document.blocks?.find(item => item.id === slide.reading_order[0])?.type === 'question';
}
export function withOrdinaryMappings(document, before = null) {
  // Notes edits retain these immutable dependencies; avoid rebuilding question and Outline indices.
  if (before && ['decisions', 'beats', 'compositions', 'blocks'].every(key => document[key] === before[key])) return document;
  const blocks = new Map((document.blocks ?? []).map(item => [item.id, item]));
  const questionOnly = new Set((document.compositions ?? []).filter(item => item.reading_order?.length === 1).map(item => blocks.get(item.reading_order[0])?.decision_id));
  const titles = new Map(), decisions = (document.decisions ?? []).map(decision => {
    const ordinary = decision.paths?.length === 1 && decision.paths[0].continue_to_next === true;
    if (!ordinary && !questionOnly.has(decision.id)) return decision;
    const prompt = typeof decision.prompt === 'string' ? decision.prompt : formattedTextPlainText(decision.prompt);
    // Navigation labels have the existing 120-character bound; the full public question is untouched.
    titles.set(decision.id, prompt.length > 120 ? `${prompt.slice(0, 117).replace(/[\uD800-\uDBFF]$/, '')}…` : prompt);
    if (!ordinary) return decision;
    const path = { ...decision.paths[0] };
    if (decision.interaction?.type === 'single_choice') path.option_ids = (decision.interaction.options ?? []).map(option => option.id);
    else delete path.option_ids;
    return { ...decision, paths: [path] };
  });
  const surfaceTitles = new Map();
  const beats = (document.beats ?? []).map(beat => {
    if (!titles.has(beat.decision_id)) return beat;
    const title = titles.get(beat.decision_id); surfaceTitles.set(beat.surface_id, title); return { ...beat, title };
  });
  return { ...document, decisions, beats, surfaces: (document.surfaces ?? []).map(surface => surfaceTitles.has(surface.id) ? { ...surface, title: surfaceTitles.get(surface.id) } : surface) };
}

/** A question-only slide needs no blank heading/body blocks or per-slide metadata work. */
export function withOrdinaryQuestionSlide(document, beatId, decisionId, createId) {
  const question = { id: createId(), type: 'question', decision_id: decisionId };
  return { ...document, blocks: [...document.blocks, question], compositions: [...document.compositions, {
    id: createId(), owner: { kind: 'beat', id: beatId }, template: 'blank', placements: [{ block_id: question.id, col: 1, row: 1, w: 12, h: 12 }],
    reading_order: [question.id], steps: [{ id: createId(), block_ids: [question.id] }], styles: [] }] };
}
