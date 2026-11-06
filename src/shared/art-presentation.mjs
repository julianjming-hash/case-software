// CASE-274: explicit display repair for a failed cover, never persisted or submitted as published art.
// The frozen renderer and source descriptor remain intact. Single-route decisions have no visible branch;
// omit their empty spacing slots only when the stored layout cannot draw its branches.
import { validArtDescriptor, ART_ATTEMPTS, structureKey } from './art-descriptor.mjs';
import { buildScene } from './mosaic-geometry.mjs';
const cache = new Map();
export function presentationArt(art, { full = false } = {}) {
  if (!validArtDescriptor(art)) return art;
  const key = [structureKey(art), art.renderer, art.attempt, art.summarised, full].join('|');
  if (cache.has(key)) return cache.get(key);
  let shown = full ? { ...art, summarised: false } : art;
  if (buildScene(shown, { validateOnly: true }).problems.length) {
    const decisions = art.decisions.filter(d => d.strands.length || d.resets || d.ends);
    // No effective compaction: retain the published layout, not a new arbitrary solve of healthy art.
    if (decisions.length < art.decisions.length) {
      for (let attempt = 0; attempt < ART_ATTEMPTS; attempt++) {
        const candidate = { ...shown, decisions, attempt };
        if (!buildScene(candidate, { validateOnly: true }).problems.length) { shown = candidate; break; }
      }
    }
  }
  if (cache.size >= 64) cache.delete(cache.keys().next().value);
  cache.set(key, shown);
  return shown;
}
