import { PRESENTATION_GROUPS, populatedPresentationGroups, publicPresentationSurface } from '../shared/presentation-groups.mjs';

/** Phone browsing is by public timeline entry, never by a surface ID that can repeat. */
export function publicTimelineEntry(timeline, index) {
  const rows = Array.isArray(timeline) ? timeline : [];
  const last = rows.length - 1;
  const browsing = Number.isSafeInteger(index) && index >= 0 && index < last;
  return { entry: browsing ? rows[index] : rows[last] ?? null, browsing };
}

/** The console may hold the full pack, but its room-visible card must use the public projection. */
export function consolePublicSurface(view) {
  const rows = view?.timeline;
  const row = view?.publicDisplaySurface;
  if (!Array.isArray(rows) || !row) return null;
  const selected = presentationNav(view).at;
  const entry = rows[selected];
  if (!entry || row.surfaceId !== entry.surfaceId || row.at !== entry.at) return null;
  // An explicit authority projection is required. Never infer an older entry's reveal count
  // from the current live progress or from the facilitator's complete private timeline.
  return publicPresentationSurface(row, populatedPresentationGroups(row).length);
}

/** Only already-published timeline entries can be presentation targets. Null explicitly means Live. */
export function presentationNav(view) {
  const timeline = Array.isArray(view?.timeline) ? view.timeline : [];
  const last = timeline.length - 1;
  const cursor = view?.display?.cursor ?? null;
  const selected = Number.isSafeInteger(cursor) && cursor >= 0 && cursor < last ? cursor
    : typeof cursor === 'string' ? timeline.findLastIndex((row) => row.surfaceId === cursor) : last;
  const at = selected >= 0 && selected < last ? selected : last;
  const replaying = at >= 0 && at < last;
  const rows = timeline.map((row, entryIndex) => ({
    entryIndex, title: row.title, selected: entryIndex === at, live: entryIndex === last,
  }));
  let nextActionLabel = null;
  if (view?.actions?.includes('advance')) {
    const nextGroup = view.presentation?.nextGroup;
    if (nextGroup === 'step') nextActionLabel = 'Reveal next step'; // card 57: a slide's next authored step
    else if (PRESENTATION_GROUPS.includes(nextGroup)) nextActionLabel = `Reveal ${nextGroup}`;
    else if (view.phase === 'surface_live' && view.decision) nextActionLabel = 'Open responses';
    else if (view.nextBeat?.kind === 'decision') nextActionLabel = 'Show decision context';
    else nextActionLabel = 'Reveal next surface';
  }
  return {
    rows, at, replaying, liveTarget: null,
    canBack: at > 0, backTarget: at > 0 ? at - 1 : null,
    canForward: at >= 0 && at < last, forwardTarget: at >= 0 && at < last - 1 ? at + 1 : null,
    nextActionLabel,
  };
}
