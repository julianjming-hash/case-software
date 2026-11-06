// Served composition of private transfer and exact Pending review. No persistent device state.
import { mountBuilderTransferControls } from './builder-transfer-controls.mjs';
import { publicationSummary } from './publication-summary.mjs';
import { isUuidV7 } from '../shared/ids.mjs';
import { mountBuilderReviewControls } from './builder-review-controls.mjs';
import { createBuilderTransferExport, parseBuilderTransfer, inspectBuilderTransfer, createBuilderCopyCandidate, summariseBuilderPair } from '../shared/builder-transfer.mjs';
import { validateBuilderDocument } from '../shared/builder-document.mjs';
// The route injects its slide-aware validator (card 57 activation); schema 3 then reviews and releases like schema 2.
let validate = (document, metadata, options) => validateBuilderDocument(document, metadata, options);
import { prepareArt } from '../shared/mosaic-geometry.mjs';

// A JSONB acknowledgement may reorder object keys; authored array order and all values remain significant.
function same(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => same(value, b[index]));
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && same(a[key], b[key]));
}
const digest = value => typeof value === 'string' && /^\\x[0-9a-f]{64}$/i.test(value);

/** Latest server acknowledgement is checked against the unchanged local snapshot before submission. */
export async function acknowledgedBuilderPair({ readLatest, getSnapshot, current = () => true }) {
  const before = getSnapshot();
  if (!current() || before.dirty || before.status !== 'saved' || before.baseRevision < 1)
    throw new Error('Save and reconcile all writing before submitting it for review.');
  const latest = await readLatest();
  const after = getSnapshot();
  if (!current() || after.localGeneration !== before.localGeneration || after.baseRevision !== before.baseRevision || after.dirty || after.status !== 'saved' ||
      latest?.revision !== before.baseRevision || !digest(latest.intentDigest) ||
      !same(latest.document, before.document) || !same(latest.authoringMetadata, before.authoringMetadata))
    throw new Error('The local or saved draft changed. Reload or reconcile it before submitting.');
  // Card 51: slide drafts are refused by name here until activation, not as unnamed readiness issues.
  const checked = validate(latest.document, latest.authoringMetadata, { mode: 'ready' });
  if (!checked.ok) throw new Error('Resolve the readiness issues before submitting the saved draft.');
  return structuredClone(latest);
}

export function builderReleaseMaterial(candidate) {
  const checked = validate(candidate.document, candidate.authoringMetadata, { mode: 'ready' });
  if (!checked.ok) throw new Error('Candidate is not ready for release.');
  const { art } = prepareArt(candidate.document);
  // Card 59 M3: a slide version pins every image its blocks show; release refuses any not approved in this workspace.
  const assetIds = [...new Set([...(candidate.document.surfaces ?? []).flatMap(surface => surface.asset_ids ?? []),
    ...(candidate.document.blocks ?? []).filter(block => block?.type === 'image').map(block => block.asset_id)])];
  return { art, assetIds };
}

/**
 * Import, export and copy (CASE-344): the transfer tools of a draft, mounted by the Builder's ⋯ menu in a dialog. `studio`
 * supplies the saved pair (`getSnapshot`), `applyImport`; every change is explicit and reviewed.
 */
export function mountBuilderTransfer(host, { studio, current, createCopy, validateDocument = null, slides = false }) {
  if (validateDocument) validate = validateDocument;
  const getCurrentState = () => {
    const snapshot = studio.getSnapshot();
    const intentDigest = digest(snapshot.intentDigest) ? snapshot.intentDigest : null;
    return { document: snapshot.document, authoringMetadata: snapshot.authoringMetadata, revision: snapshot.baseRevision,
      generation: snapshot.localGeneration, dirty: snapshot.dirty, intentDigest };
  };
  const transfer = mountBuilderTransferControls(host, {
    getCurrentState, isCurrent: current,
    transfer: { createExport: createBuilderTransferExport, parse: parseBuilderTransfer, inspect: inspectBuilderTransfer, createCopyCandidate: createBuilderCopyCandidate, summarise: summariseBuilderPair },
    applyCandidate(candidate, expected) {
      const state = getCurrentState();
      if (!current() || state.generation !== expected.expectedGeneration || state.revision !== expected.expectedRevision || state.intentDigest !== expected.expectedIntentDigest)
        return { ok: false, message: 'The draft changed. Inspect this proposal again.' };
      // Slide drafts transfer as version 2; they enter only a case whose workspace grants slides (CASE-221).
      if (candidate.document?.schema_version === 3 && !slides) return { ok: false, message: 'This workspace does not have slides yet, so a slide draft cannot be imported here.' };
      const checked = (validateDocument ?? validateBuilderDocument)(candidate.document, candidate.authoring_metadata, { mode: 'preserve' });
      if (!checked.ok) return { ok: false, message: 'This proposal cannot be preserved safely.' };
      return studio.applyImport(candidate.document, candidate.authoring_metadata)
        ? { ok: true } : { ok: false, message: 'The draft changed. Inspect this proposal again.' };
    },
    createCopy,
    download({ filename, content, contentType }) {
      if (!current()) throw new Error('Retired authoring view');
      const doc = host.ownerDocument, win = doc.defaultView;
      const url = win.URL.createObjectURL(new Blob([content], { type: contentType }));
      const link = doc.createElement('a'); link.href = url; link.download = filename;
      doc.body.append(link); link.click(); link.remove();
      win.setTimeout(() => win.URL.revokeObjectURL(url), 0);
    },
  });
  return { close() { transfer.retire(); } };
}

export function mountBuilderWorkflows(host, { caseId, canReview = false, request, studio, readLatest, current, createCopy, validateDocument = null, slides = false, nameImages = null }) {
  if (validateDocument) validate = validateDocument;
  const review = mountBuilderReviewControls(host, {
    caseId, request, current, simplified: true, canReview,
    getAcknowledgedDraft: async () => {
      await studio.save?.();
      const pair = await acknowledgedBuilderPair({ readLatest, getSnapshot: studio.getSnapshot, current });
      if (!canReview) return pair;
      const readiness = await request(['builder', 'cases', caseId, 'readiness'], { method: 'POST', body: { revision: pair.revision } });
      // PUBLISH-01 (card 62): the confirmation names each refused image with its slide, text alternative and status.
      if (readiness?.ready !== true || readiness.revision !== pair.revision) throw Object.assign(Error('Resolve publishing readiness issues before continuing.'),
        { issues: (nameImages ? await nameImages(readiness, pair.document) : readiness)?.issues });
      return pair;
    },
    getPublicationSummary: async draft => {
      const response = await request(['builder', 'cases', caseId, 'draft'], { maxResponseBytes: 2_097_152 });
      if (response?.case?.caseId !== caseId || !isUuidV7(response.case.workspaceId)) throw Error('Case context changed.');
      const source = response.case.sourceVersion;
      if (source === null) return publicationSummary(null, draft.document);
      if (!isUuidV7(source?.versionId)) throw Error('Published history unavailable.');
      const pack = await request(['workspaces', response.case.workspaceId, 'versions', source.versionId, 'pack'], { maxResponseBytes: 2_097_152 });
      if (pack?.workspaceId !== response.case.workspaceId || pack?.versionId !== source.versionId || !pack.document) throw Error('Published snapshot unavailable.');
      return publicationSummary(pack.document, draft.document);
    },
    releaseMaterial: builderReleaseMaterial,
  });
  return { publish: () => review.publish(), close() { review.clear(); } };
}
