import { populatedPresentationGroups } from '../shared/presentation-order.mjs';

/** A visual accent is only for a live newly shared text group, never a replay or initial join. */
export function newlyPublicGroup(previous, next) {
  if (!previous || !next) return null;
  const groups = populatedPresentationGroups(next);
  if (previous.surfaceId !== next.surfaceId || previous.at !== next.at) return groups[0] ?? null;
  const old = new Set(populatedPresentationGroups(previous));
  return groups.find(group => !old.has(group)) ?? null;
}
