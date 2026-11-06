/** Human-sized comparison of immutable teaching snapshots; no source notes or response data. */
export function publicationSummary(before, after) {
  const slides = document => new Map((document?.compositions ?? document?.beats ?? []).map(item => [item.id, item]));
  const current = slides(after);
  if (!before) return `New case · ${current.size} slides · ${after.decisions?.length ?? 0} questions`;
  const former = slides(before), oldBlocks = new Map((before.blocks ?? []).map(item => [item.id, item])), blocks = new Map((after.blocks ?? []).map(item => [item.id, item]));
  const oldSurfaces = new Map((before.surfaces ?? []).map(item => [item.id, item])), surfaces = new Map((after.surfaces ?? []).map(item => [item.id, item]));
  let added = 0, changed = 0, removed = 0;
  for (const [id, slide] of current) {
    if (!former.has(id)) added++;
    else if (JSON.stringify(former.get(id)) !== JSON.stringify(slide) ||
      (slide.surface_id && JSON.stringify(oldSurfaces.get(slide.surface_id)) !== JSON.stringify(surfaces.get(slide.surface_id))) ||
      slide.reading_order?.some(key => JSON.stringify(oldBlocks.get(key)) !== JSON.stringify(blocks.get(key)))) changed++;
  }
  for (const id of former.keys()) if (!current.has(id)) removed++;
  const parts = [[added, 'slides added'], [changed, 'slides edited'], [removed, 'slides removed']].filter(([count]) => count).map(([count, word]) => `${count} ${word}`);
  if (JSON.stringify(before.decisions) !== JSON.stringify(after.decisions)) parts.push('Questions or routes updated');
  if (['title','summary','audience','setting','duration_min','learning_objectives'].some(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]))) parts.push('Case details updated');
  return parts.join(' · ') || (JSON.stringify(before) === JSON.stringify(after) ? 'No teaching-content changes' : 'Teaching content or settings updated');
}
