// Card 62 PUBLISH-01, after image approval was removed (CASE-342): when publishing is refused over an image (the
// Worker's code `asset_not_approved`, kept for deployed clients, now means the image is missing, belongs to another
// workspace or was taken down), Readiness and the publish confirmation say which image, on which slide, and why. They match
// each image's asset id against the case's listed images, so the readiness RPC is unchanged. A block's issue points at the
// block, so Readiness files it under its slide and its link opens that image. A listed image that is live is never an issue:
// there is no approval state to wait for.

const LIVE = new Set(['quarantined', 'approved']);
const REASONS = { rejected: 'was taken down: replace it', withdrawn: 'was taken down: replace it' };

/** The slide that shows a block, in the author's words: its stage, consequence or clarification title. */
function slideName(document, blockId) {
  const owner = (document?.compositions ?? []).find(item => item?.reading_order?.includes(blockId))?.owner;
  const title = owner?.kind === 'beat' ? (document.beats ?? []).find(item => item.id === owner.id)?.title
    : owner?.kind === 'path' ? (document.decisions ?? []).flatMap(item => item.paths ?? []).find(item => item.id === owner.id)?.label
      : owner?.kind === 'clarification' ? (document.clarifications ?? []).find(item => item.id === owner.id)?.label : null;
  return title ? `Slide “${title}”` : owner ? 'An untitled slide' : 'Content no slide shows';
}

/** One issue for each image the case shows that is missing or taken down: { code, at, message, slide }. */
export function namedImageIssues(document, rows) {
  const listed = new Map((Array.isArray(rows) ? rows : []).map(row => [row?.asset_id, row]));
  const issues = [];
  const name = (assetId, alt) => { const row = listed.get(assetId); return (typeof alt === 'string' && alt.trim()) || (typeof row?.alt_text === 'string' && row.alt_text.trim()) || 'without a text alternative'; };
  const reason = assetId => { const row = listed.get(assetId); return row ? REASONS[row.status] ?? 'cannot be used: replace it' : 'is not in this case’s images: replace it'; };
  (document?.blocks ?? []).forEach((block, index) => {
    if (block?.type !== 'image' || LIVE.has(listed.get(block.asset_id)?.status)) return;
    issues.push({ code: 'asset_not_approved', at: `/blocks/${index}`, message: `Image “${name(block.asset_id, block.alt)}” ${reason(block.asset_id)}.`, slide: slideName(document, block.id) });
  });
  (document?.surfaces ?? []).forEach((surface, index) => {
    for (const assetId of surface?.asset_ids ?? []) {
      if (LIVE.has(listed.get(assetId)?.status)) continue;
      issues.push({ code: 'asset_not_approved', at: `/surfaces/${index}`, message: `Image “${name(assetId, null)}” ${reason(assetId)}.`, slide: surface.title ? `“${surface.title}”` : 'Untitled content' });
    }
  });
  return issues;
}

/**
 * A readiness answer with its one image sentence replaced by the named images. `list` reads the case's images
 * only when an image was refused. If the list cannot be read, or names nothing, the Worker's sentence stays.
 * `withSlide` puts the slide's name in each message, for the publish confirmation, which lists messages without slides.
 */
export async function withImageNames(readiness, document, list, { withSlide = false } = {}) {
  if (!Array.isArray(readiness?.issues) || !readiness.issues.some(issue => issue?.code === 'asset_not_approved')) return readiness;
  let named;
  try { named = namedImageIssues(document, await list()); } catch { return readiness; }
  if (!named.length) return readiness;
  const shown = withSlide ? named.map(issue => ({ ...issue, message: `${issue.slide}: ${issue.message}` })) : named;
  return { ...readiness, issues: [...readiness.issues.filter(issue => issue?.code !== 'asset_not_approved'), ...shown] };
}
