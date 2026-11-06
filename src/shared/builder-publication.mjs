import { validateBuilderProvenancePaths } from './builder-provenance.mjs';

const BLOCKERS = new Set(['rights_unresolved', 'rights_restricted', 'source_missing', 'source_range', 'source_range_missing', 'provenance_unreviewed', 'provenance_stale', 'provenance_entity_missing', 'provenance_field_missing']);

/** Shared local publication blockers. Server resources and saved revision require a separate fresh check. */
export function builderPublicationIssues(document, metadata, validation) {
  const issues = [...(validation?.errors ?? []), ...(validation?.warnings ?? []).filter(issue => BLOCKERS.has(issue.code)), ...validateBuilderProvenancePaths(document, metadata)];
  for (const [index, source] of (metadata?.sources ?? []).entries()) {
    if (source?.rights_status !== 'permitted') issues.push({ code: 'rights_unresolved', at: `/sources/${index}/rights_status`, message: 'Record permission to use this source before publishing.' });
  }
  const seen = new Set();
  return issues.filter(issue => { const key = `${issue.code}|${issue.at}`; if (seen.has(key)) return false; seen.add(key); return true; });
}
