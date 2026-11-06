// CASE-313: a question branches when its authored routes lead to two or more different next slides (an ending counts as
// one destination). The room may show that a choice changes the route, never which route; the facilitator still selects
// every path (hard rule 2). Shared by the room's public decision, the Builder canvas and the fit frames.
export function decisionBranches(decision) {
  const paths = Array.isArray(decision?.paths) ? decision.paths : [];
  // In a single choice an answer reaches only a path its option maps to; a path with no option is the facilitator's alone.
  const answered = decision?.interaction?.type === 'single_choice' ? paths.filter(path => path?.option_ids?.length) : paths;
  return new Set(answered.map(path => path?.next_beat_id ?? null)).size > 1;
}
/** Lucide "split" (ISC licence, lucide.dev), 24-unit stroke paths: the branching badge on projector, phone and Builder. */
export const BRANCH_ICON_PATH = 'M16 3h5v5M8 3H3v5M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3M15 9l6-6';
export const BRANCH_LABEL = 'Branching question';
