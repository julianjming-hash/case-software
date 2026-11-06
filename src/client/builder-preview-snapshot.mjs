import { validateRuntimeDocument } from '../shared/runtime-document.mjs';
import { validateBuilderDocument } from '../shared/builder-document.mjs';

/** Validate the exact cloned Builder snapshot; never substitute a repaired shadow graph. */
export async function prepareBuilderPreviewSnapshot(documentValue, metadataValue = { metadata_version: 1 }) {
  let documentSnapshot, metadataSnapshot;
  try { documentSnapshot = structuredClone(documentValue); metadataSnapshot = structuredClone(metadataValue); }
  catch { return { ok: false, issues: [{ code: 'snapshot', message: 'Draft snapshot is not valid structured data.' }] }; }
  // Card 57: a slide draft validates with the slide validator, loaded only for slides (already on every Builder route).
  const options = documentSnapshot?.schema_version === 3 ? { validateSlides: (await import('./builder-slide-check.mjs')).validateSlideParts } : {};
  const builder = validateBuilderDocument(documentSnapshot, metadataSnapshot, { mode: 'ready', ...options });
  const runtime = validateRuntimeDocument(documentSnapshot, options), issues = [...builder.errors, ...runtime.errors];
  return issues.length ? { ok: false, issues: issues.slice(0, 200), remainingIssues: Math.max(0, issues.length - 200) }
    : { ok: true, document: documentSnapshot, metadata: metadataSnapshot };
}
