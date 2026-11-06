import { formattedTextPlainText } from './builder-format.mjs';
// Text groups have one stable reveal order. Media waits for a delivery contract.
export const PRESENTATION_GROUPS = Object.freeze(['scene', 'observations', 'findings', 'investigations']);

export function populatedPresentationGroups(surface) {
  if (!surface || typeof surface !== 'object') return [];
  return PRESENTATION_GROUPS.filter((group) => {
    if (group === 'scene') return typeof surface.scene === 'string' ? surface.scene.length > 0 : formattedTextPlainText(surface.scene).length > 0;
    if (group === 'observations') return Array.isArray(surface.observations) && surface.observations.length > 0;
    if (group === 'findings') return Array.isArray(surface.points) && surface.points.length > 0;
    return Array.isArray(surface.investigations) && surface.investigations.length > 0;
  });
}
