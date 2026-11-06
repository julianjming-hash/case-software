import { formattedTextPlainText } from '../shared/builder-format.mjs';
// Presentation thumbnails consume only the authority's exact then-public entry projection.
export function presentationTiles(view) {
  const rows = view?.publicTimeline;
  if (!Array.isArray(rows) || rows.length !== view?.timeline?.length) return [];
  return rows.flatMap((row, index) => {
    const surface = row?.surface;
    if (row.entryIndex !== index || !surface || typeof surface.title !== 'string') return [];
    return [{ entryIndex:index, occurrenceId:row.occurrenceId, title:surface.title,
      scene: typeof surface.scene === 'string' ? surface.scene : formattedTextPlainText(surface.scene),
      points:Array.isArray(surface.points) ? surface.points.filter(x => typeof x === 'string') : [],
      correction: Boolean(row.publication?.correctionOf) }];
  });
}
