// A page-local preview. Only a deliberate Reveal or Undo sends an authority command.
const eligible = (view, pathId) => view?.decision?.paths?.some(path => path.id === pathId && !path.explored);
const reviewing = view => ['responses_locked', 'path_selected'].includes(view?.phase) ||
  Boolean(view?.manual && view?.phase === 'surface_live' && view?.decision);
const key = view => view?.decision ? `${view.decision.id}:${view.round?.id ?? view.publication?.occurrenceId ?? 'manual'}` : null;
export function createRouteSelection() {
  let context = null, pathId = null, previous, suppressed = false, wasReviewing = false, committedPathId = null;
  function sync(view) {
    const next = key(view), review = reviewing(view);
    if (next !== context) { context = next; pathId = null; previous = undefined; suppressed = false; wasReviewing = false; committedPathId = null; }
    if (!next) return null;
    if (view.selectedPathId) { committedPathId=view.selectedPathId; pathId = eligible(view, view.selectedPathId) ? view.selectedPathId : null; previous = undefined; }
    else if(committedPathId){committedPathId=null;pathId=null;previous=undefined;suppressed=true;}
    else if (review && !wasReviewing && !suppressed) {
      const suggestion = view.round?.suggestion, available = view.decision.paths.filter(path => !path.explored);
      // An ordinary question's Continue (card 61) is no choice of the facilitator's, so there is nothing local to undo.
      if (available.length === 1) { pathId = available[0].id; previous = view.decision.directContinue ? undefined : { pathId: null, suppressed: true }; }
      else
      if (view.round?.seededStatus !== 'locked' && view.round?.responseCount > 0 &&
          ['plurality', 'rules'].includes(suggestion?.kind) && eligible(view, suggestion.pathId)) {
        pathId = suggestion.pathId; previous = { pathId: null, suppressed: true };
      }
    }
    if (pathId && !eligible(view, pathId)) { pathId = null; previous = undefined; suppressed = true; }
    wasReviewing = review;
    return pathId;
  }
  return {
    sync,
    choose(view, chosen) {
      sync(view);
      if (!reviewing(view) || view.selectedPathId || !eligible(view, chosen) || chosen === pathId) return false;
      previous = { pathId, suppressed }; pathId = chosen; suppressed = true; return true;
    },
    undo(view) {
      sync(view);
      if (!previous || view.selectedPathId) return false;
      ({ pathId, suppressed } = previous); previous = undefined; return true;
    },
    canUndo(view) { sync(view); return previous !== undefined && !view?.selectedPathId; },
    clear() { context = null; pathId = null; previous = undefined; suppressed = false; wasReviewing = false; committedPathId = null; },
  };
}
