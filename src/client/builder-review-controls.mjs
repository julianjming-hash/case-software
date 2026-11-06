import { isUuidV7, uuidv7 } from '../shared/ids.mjs';

const MAX_CANDIDATE_BYTES = 2 * 1_048_576;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = value => typeof value === 'string' && /^\\x[0-9a-f]{64}$/i.test(value);
const text = (doc, tag, value = '') => {
  const item = doc.createElement(tag);
  item.textContent = value;
  return item;
};
// A publishing refusal names each problem once, with its count: 86 unreviewed traces read as one line, not 86 repeats
// of the schema's text (Julian, 2026-10-31). Readiness lists each one and offers Mark all reviewed.
const COUNTED_ISSUES = { provenance_unreviewed: n => `${n} source traces have not been reviewed. Review them in Readiness.`,
  provenance_stale: n => `${n} source traces changed since they were reviewed. Review them again in Readiness.`,
  rights_unresolved: n => `${n} sources need their permission recorded.` };
const sentence = message => `${message[0].toUpperCase()}${message.slice(1)}${/[.!?]$/.test(message) ? '' : '.'}`;
export function refusalWords(issues) {
  const groups = new Map();
  for (const issue of issues) {
    if (typeof issue?.message !== 'string' || !issue.message) continue;
    const key = COUNTED_ISSUES[issue.code] ? `code:${issue.code}` : `text:${issue.message}`;
    const group = groups.get(key) ?? { issue, count: 0 }; group.count++; groups.set(key, group);
  }
  return [...groups.values()].map(({ issue, count }) => count === 1 ? sentence(issue.message) : COUNTED_ISSUES[issue.code]?.(count) ?? `${sentence(issue.message)} (${count} places)`).join(' ');
}
const errorText = error => ({
  unauthorised: 'Sign in again to continue.', forbidden: 'This account cannot perform that review action.',
  conflict: 'The candidate or draft changed. Reload current information before continuing.',
  bad_request: 'The server refused this action. Check publishing readiness and current status.',
  source_digest_mismatch: 'A source changed. Save it again before publishing.',
  not_found: 'This candidate is no longer available.', not_ready: 'The exact saved draft is not ready for review.',
  review_metadata_unresolved: 'Resolve source rights and provenance before submitting.',
  request_timeout: 'The request timed out. Its result is uncertain; reload current information before acting again.',
  closed: 'This review view is no longer active.',
}[error?.code ?? error?.message] ?? 'The review service is unavailable. Reload current information before continuing.');

/**
 * Mount explicit Pending/review controls. `request` is the authenticated accountRequest
 * adapter; `getAcknowledgedDraft` must return only the latest acknowledged C42 pair.
 * Release art/assets are supplied by a caller-owned reviewed dependency and never guessed here.
 */
export function mountBuilderReviewControls(container, {
  caseId, request, getAcknowledgedDraft, releaseMaterial = null,
  current = () => true, canReview = false, makeId = uuidv7, simplified = false, getPublicationSummary = null,
} = {}) {
  const doc = container?.ownerDocument ?? globalThis.document;
  if (!doc || !container || !isUuidV7(caseId) || typeof request !== 'function' || typeof getAcknowledgedDraft !== 'function')
    throw new TypeError('invalid Builder review controls dependencies');
  const root = doc.createElement('section'); root.setAttribute('aria-label', 'Awaiting case review');
  const heading = text(doc, 'h2', 'Awaiting review');
  const status = text(doc, 'p', 'Review the exact saved draft before submitting.'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const submitLabel = simplified ? (canReview ? 'Publish' : 'Send for review') : 'Send for review';
  const submitButton = text(doc, 'button', submitLabel); submitButton.type = 'button'; if (simplified) submitButton.className = 'btn primary';
  const reload = text(doc, 'button', 'Reload candidates'); reload.type = 'button'; reload.className = 'btn tertiary';
  const list = doc.createElement('ul'); list.setAttribute('aria-label', 'Review details');
  const detail = doc.createElement('section'); detail.setAttribute('aria-label', 'Selected candidate');
  if (simplified) {
    heading.textContent = 'Publishing';
    const history = doc.createElement('details'); history.append(text(doc, 'summary', 'Versions and review details'), list, detail);
    reload.textContent = 'Check status';
    root.append(heading, status, submitButton, reload, history);
  } else root.append(heading, status, submitButton, reload, list, detail);
  container.append(root);

  let closed = false, generation = 0, listing = false, acting = false, preparing = false, confirming = false;
  let pendingSubmission = null, selected = null, retryOperation = null;
  let candidates = [];
  const retireSubmission = () => {
    pendingSubmission = null;
    if (retryOperation?.kind === 'submit') retryOperation = null;
    submitButton.textContent = submitLabel;
  };
  const reconcileSubmission = rows => {
    if (pendingSubmission && rows.some(row => row.revision >= pendingSubmission.revision && ['pending', 'approved', 'released'].includes(row.status))) retireSubmission();
  };
  function retire() {
    if (closed) return;
    closed = true; generation++; listing = false; acting = false;
    pendingSubmission = null; selected = null; retryOperation = null;
    root.replaceChildren(); root.remove();
  }
  const active = token => {
    if (closed) return false;
    if (current() !== true) { retire(); return false; }
    return token === generation;
  };
  const setStatus = (message, token = generation) => { if (active(token)) status.textContent = message; };
  const clearDetail = () => { detail.replaceChildren(); selected = null; retryOperation = null; };
  const button = (label, handler) => {
    const item = text(doc, 'button', label); item.type = 'button'; item.addEventListener('click', handler); return item;
  };
  const dangerButton = (label, handler) => { const item = button(label, handler); item.className = 'builder-danger'; return item; };
  const call = async (parts, options, token) => {
    if (!active(token)) return null;
    const result = await request(parts, options);
    if (!active(token)) return null;
    if (!record(result)) throw Object.assign(new Error('invalid_response'), { code: 'invalid_response' });
    return result;
  };
  const reviewPath = (...parts) => ['builder', 'cases', caseId, ...parts];
  const parseCandidate = result => {
    const value = result?.candidate;
    if (!record(value) || !isUuidV7(value.candidateId) || !Number.isSafeInteger(value.revision) || value.revision < 1 ||
        ![1, 2, 3].includes(value.schemaVersion) || !digest(value.intentDigest) || !digest(value.contentSha256) ||
        !['pending', 'approved', 'superseded', 'cancelled', 'released'].includes(value.status) ||
        typeof value.submittedAt !== 'string' || value.submittedAt.length > 40 ||
        !(value.document === null || record(value.document)) || !(value.authoringMetadata === null || record(value.authoringMetadata))) return null;
    let bytes;
    try { bytes = new TextEncoder().encode(JSON.stringify({ document: value.document, authoringMetadata: value.authoringMetadata })).byteLength; }
    catch { return null; }
    return bytes <= MAX_CANDIDATE_BYTES ? value : null;
  };
  const renderCandidate = candidate => {
    clearDetail(); selected = candidate; reconcileSubmission([candidate]);
    detail.append(text(doc, 'h3', `Candidate revision ${candidate.revision} · ${candidate.status}`));
    detail.append(text(doc, 'p', `Candidate ${candidate.candidateId}. Submitted ${candidate.submittedAt}.`));
    detail.append(text(doc, 'p', `Document digest ${candidate.contentSha256}. Paired draft digest ${candidate.intentDigest}.`));
    if (candidate.approvedAt) detail.append(text(doc, 'p', `Approved ${candidate.approvedAt}. Approval is bound to the digests shown above.`));
    if (candidate.document === null) detail.append(text(doc, 'p', 'Candidate body has been deleted; retained history contains identity and review status only.'));
    else {
      detail.append(text(doc, 'h4', 'Candidate document'));
      const documentText = text(doc, 'pre', JSON.stringify(candidate.document, null, 2)); documentText.setAttribute('aria-label', 'Private candidate document'); detail.append(documentText);
      detail.append(text(doc, 'h4', 'Private authoring metadata'));
      const metadataText = text(doc, 'pre', JSON.stringify(candidate.authoringMetadata, null, 2)); metadataText.setAttribute('aria-label', 'Private authoring metadata'); detail.append(metadataText);
    }
    if (candidate.status === 'pending' && candidate.document !== null) {
      if (canReview) detail.append(button('Approve for publication', () => void approve(candidate)));
      detail.append(dangerButton('Cancel this candidate…', () => confirmAction('cancel', candidate)));
    }
    if (canReview && candidate.status === 'approved' && candidate.document !== null) {
      if (typeof releaseMaterial === 'function') detail.append(button('Publish', () => void release(candidate)));
      else detail.append(text(doc, 'p', 'Release is unavailable until the reviewed art and asset dependency is supplied.'));
    }
    if (['superseded', 'cancelled'].includes(candidate.status) && candidate.document !== null)
      detail.append(dangerButton('Delete retained candidate body…', () => confirmAction('delete', candidate)));
  };
  const refreshList = async ({ preserveSelection = false } = {}) => {
    if (closed || listing || acting || preparing || !current()) return false;
    listing = true; const token = ++generation; reload.disabled = true;
    try {
      const result = await call(reviewPath('candidates'), {}, token);
      if (!active(token)) return false;
      if (!Array.isArray(result.candidates) || result.candidates.length > 1000 || !result.candidates.every(row =>
        record(row) && isUuidV7(row.candidateId) && Number.isSafeInteger(row.revision) && row.revision >= 0 &&
        ['pending', 'approved', 'superseded', 'cancelled', 'released'].includes(row.status) && typeof row.submittedAt === 'string' && row.submittedAt.length <= 40))
        throw new Error('invalid_response');
      candidates = result.candidates; reconcileSubmission(candidates);
      const formerId = preserveSelection ? selected?.candidateId : null;
      list.replaceChildren();
      for (const row of result.candidates) {
        const item = doc.createElement('li');
        item.append(text(doc, 'span', `Revision ${row.revision} · ${row.status} · ${row.submittedAt} · ${row.candidateId} `));
        item.append(button('Inspect', () => void inspect(row.candidateId)));
        list.append(item);
      }
      listing = false; reload.disabled = false;
      if (formerId) void inspect(formerId);
      else clearDetail();
      setStatus(result.candidates.length ? `${result.candidates.length} retained candidate record(s). Select Inspect to review exact content.` : 'No Pending or retained candidates.', token);
      return true;
    } catch (error) { setStatus(errorText(error), token); return false; }
    finally { if (active(token)) { listing = false; reload.disabled = false; } }
  };
  async function inspect(candidateId) {
    if (closed || acting || listing || preparing || !isUuidV7(candidateId) || !current()) return false;
    const token = ++generation; clearDetail(); setStatus('Loading exact candidate…', token);
    try {
      const result = await call(reviewPath('candidates', candidateId), { maxResponseBytes: MAX_CANDIDATE_BYTES }, token);
      if (!active(token)) return false;
      const candidate = parseCandidate(result);
      if (!candidate || candidate.candidateId !== candidateId) throw new Error('invalid_response');
      renderCandidate(candidate); setStatus(simplified ? (candidate.status === 'released' ? `Update published. Available to facilitators.` : `Revision ${candidate.revision} · ${candidate.status}.`) : 'Candidate content is private to this entitled review view. Approval and release are separate explicit actions.', token);
      return true;
    } catch (error) { setStatus(errorText(error), token); return false; }
  }
  async function submit(exact = null) {
    if (closed || acting || listing || preparing || confirming || !current()) return false;
    if (!exact) {
      const draftToken = generation;
      let draft;
      preparing = true;
      try { draft = structuredClone(await getAcknowledgedDraft()); } catch { setStatus('Could not read the latest acknowledged draft. Save or reload it before submitting.'); return false; }
      finally { preparing = false; }
      if (!active(draftToken)) return false;
      if (!record(draft) || !Number.isSafeInteger(draft.revision) || draft.revision < 1 || !record(draft.document) ||
          !record(draft.authoringMetadata) || !digest(draft.intentDigest)) {
        setStatus('There is no complete acknowledged draft revision to submit. Save and reload the draft first.'); return false;
      }
      const requestId = makeId();
      if (!isUuidV7(requestId)) { setStatus('Review submission identity could not be created. Nothing was submitted.'); return false; }
      exact = { requestId, revision: draft.revision, document: draft.document, authoringMetadata: draft.authoringMetadata };
      pendingSubmission = exact;
    }
    pendingSubmission = exact;
    const token = ++generation; acting = true; submitButton.disabled = true;
    setStatus('Submitting the exact acknowledged revision…', token);
    try {
      const result = await call(reviewPath('candidates'), { method: 'POST', body: exact }, token);
      if (!active(token)) return false;
      if (!isUuidV7(result?.candidateId) || result.revision !== exact.revision || !digest(result.intentDigest) ||
          !digest(result.contentSha256) || !['pending', 'approved', 'superseded', 'cancelled', 'released'].includes(result.status)) throw new Error('invalid_response');
      pendingSubmission = null; retryOperation = null; acting = false;
      submitButton.disabled = false; submitButton.textContent = submitLabel;
      setStatus(`Revision ${result.revision} submitted as candidate ${result.candidateId} (${result.status}).`, token);
      await refreshList({ preserveSelection: false }); return true;
    } catch (error) {
      if (!active(token)) return false;
      retryOperation = { kind: 'submit', body: exact };
      setStatus(`${errorText(error)} The exact submission is retained; retry uses the same request ID and bytes.`, token);
      showRetry(); return false;
    } finally { if (active(token)) {
      acting = false; submitButton.disabled = false;
      submitButton.textContent = pendingSubmission ? (simplified ? 'Check status' : 'Retry exact pending submission') : submitLabel;
    } }
  }
  function showRetry() {
    if (!retryOperation || closed || !current()) return;
    if (simplified) { submitButton.textContent = 'Check status'; return; }
    const existing = [...detail.children].find(item => item.dataset?.retry === 'true'); existing?.remove();
    const retry = button('Retry exact pending review request', () => {
      const operation = retryOperation; if (operation?.kind === 'submit') void submit(operation.body);
      else if (operation?.kind === 'approve') void approve(operation.candidate);
      else if (operation?.kind === 'release') void release(operation.candidate, operation.body);
    }); retry.dataset.retry = 'true'; detail.append(retry);
  }
  async function approve(candidate) {
    if (!canReview || closed || acting || listing || preparing || !current() || !candidate || candidate.status !== 'pending') return false;
    const body = { revision: candidate.revision, intentDigest: candidate.intentDigest, contentSha256: candidate.contentSha256 };
    return runBoundAction('approve', candidate, body, 'approve', 'Candidate approval recorded for the exact digests.', ['POST']);
  }
  async function release(candidate, suppliedBody = null, newEdition = undefined) {
    if (!canReview || closed || acting || listing || preparing || !current() || !candidate || candidate.status !== 'approved') return false;
    let body = suppliedBody;
    if (!body) {
      if (typeof releaseMaterial !== 'function') { setStatus('Release is unavailable until the reviewed art and asset dependency is supplied. No release request was sent.'); return false; }
      const token = generation;
      preparing = true;
      try { body = await releaseMaterial(structuredClone(candidate)); } catch { setStatus('Reviewed art and assets are unavailable. No release request was sent.'); return false; }
      finally { preparing = false; }
      if (!active(token)) return false;
      if (!record(body) || !record(body.art) || !Array.isArray(body.assetIds) || body.assetIds.some(id => !isUuidV7(id))) {
        setStatus('The supplied release material is incomplete or invalid. No release request was sent.'); return false;
      }
      body = { revision: candidate.revision, intentDigest: candidate.intentDigest, contentSha256: candidate.contentSha256,
        assetIds: structuredClone(body.assetIds), art: structuredClone(body.art), ...(newEdition === undefined ? {} : { newEdition }) };
    }
    return runBoundAction('release', candidate, body, 'release', 'Candidate released as an immutable version.', ['POST']);
  }
  async function runBoundAction(kind, candidate, body, action, success, methods) {
    const token = ++generation; acting = true; setStatus(`${kind === 'approve' ? 'Recording approval' : 'Releasing'} the exact candidate…`, token);
    try {
      const result = await call(reviewPath('candidates', candidate.candidateId, action), { method: methods[0], body }, token);
      if (!active(token)) return false;
      const exactDigests = result?.candidateId === candidate.candidateId &&
        result.intentDigest === candidate.intentDigest && result.contentSha256 === candidate.contentSha256;
      const actionResultValid = kind === 'approve'
        ? result.revision === candidate.revision && ['approved', 'superseded', 'cancelled', 'released'].includes(result.status) && typeof result.approvedAt === 'string'
        : result.status === 'released' && isUuidV7(result.versionId) && Number.isSafeInteger(result.versionNo) && result.versionNo > 0;
      if (!exactDigests || !actionResultValid)
        throw new Error('invalid_response');
      retryOperation = null; acting = false;
      setStatus(kind === 'release' ? 'Update published.' : `${success} Reload candidate status to verify current eligibility.`, token);
      await inspect(candidate.candidateId); return true;
    } catch (error) {
      if (!active(token)) return false;
      retryOperation = { kind, candidate, body };
      setStatus(`${errorText(error)} The exact candidate binding is retained; use the explicit retry or reload.`, token); showRetry(); return false;
    } finally { if (active(token)) acting = false; }
  }
  async function confirmAction(kind, candidate) {
    if (closed || acting || listing || preparing || !current() || !candidate) return;
    const label = kind === 'cancel' ? 'Confirm cancel and delete this candidate body' : 'Confirm delete retained candidate body';
    const confirm = dangerButton(label, async () => {
      if (closed || acting || listing || preparing || !current()) return;
      const token = ++generation; acting = true; setStatus(kind === 'cancel' ? 'Cancelling candidate…' : 'Deleting retained candidate body…', token);
      try {
        const result = kind === 'cancel'
          ? await call(reviewPath('candidates', candidate.candidateId, 'cancel'), { method: 'POST', body: {} }, token)
          : await call(reviewPath('candidates', candidate.candidateId, 'body'), { method: 'DELETE' }, token);
        if (!active(token)) return;
        if (result?.candidateId !== candidate.candidateId || (kind === 'cancel' && !['cancelled', 'superseded', 'approved', 'released'].includes(result.status)) || (kind === 'delete' && typeof result.deleted !== 'boolean')) throw new Error('invalid_response');
        acting = false;
        setStatus(kind === 'cancel' ? `Cancellation action completed; current candidate status is ${result.status}.` : `Retained body deletion ${result.deleted ? 'completed' : 'was already complete'}.`, token);
        await refreshList();
      } catch (error) { if (active(token)) setStatus(`${errorText(error)} Reload candidates to determine the current status before retrying.`, token); }
      finally { if (active(token)) acting = false; }
    });
    detail.append(confirm);
  }

  submitButton.addEventListener('click', () => void submitDraft());
  async function submitDraft() {
    if (!simplified) return submit(pendingSubmission);
    if (closed || acting || listing || preparing || confirming || !current()) return false;
    if ((pendingSubmission || retryOperation) && !await refreshList()) return false;
    if (!canReview) return submit(pendingSubmission);
    let draft, summary;
    const token = generation; preparing = true;
    try { draft = await getAcknowledgedDraft(); summary = getPublicationSummary ? await getPublicationSummary(draft) : `${draft.document?.beats?.length ?? 0} slides · ${draft.document?.decisions?.length ?? 0} questions`; }
    catch (error) { setStatus(`Publishing needs attention. ${Array.isArray(error?.issues) ? refusalWords(error.issues) : error?.message || 'Save the draft and resolve its readiness issues.'}`); return false; }
    finally { preparing = false; }
    if (!active(token)) return false;
    if (candidates.some(row => row.revision === draft.revision && row.status === 'released')) { setStatus(`Revision ${draft.revision} is already published.`); return true; }
    const confirmation = doc.createElement('dialog'); confirmation.className = 'computer-dialog';
    confirming = true;
    reload.disabled = true;
    confirmation.setAttribute('aria-label', 'Confirm publication');
    confirmation.append(text(doc, 'p', `Publish this update? ${summary}. Existing rooms keep their current snapshot.`));
    const editionLabel = text(doc, 'label'), edition = doc.createElement('input'); edition.type = 'checkbox';
    editionLabel.append(edition, text(doc, 'span', 'Record as a new edition in Versions')); confirmation.append(editionLabel);
    const dismiss = () => { confirming = false; confirmation.close?.(); confirmation.remove(); submitButton.hidden = false; reload.disabled = false; submitButton.focus?.(); };
    const cancel = button('Keep editing', dismiss);
    confirmation.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
    cancel.className = 'btn tertiary';
    const confirm = button('Publish this update', async () => {
      if (!active(token) || acting || listing || preparing) return;
      dismiss();
      let latest; preparing = true;
      try { latest = await getAcknowledgedDraft(); } catch { setStatus('The saved draft could not be checked. Check status before publishing.'); return; }
      finally { preparing = false; }
      if (!active(token)) return;
      if (latest.revision !== draft.revision || latest.intentDigest !== draft.intentDigest) { setStatus('The draft changed. Review it again before publishing.'); return; }
      if (!await refreshList()) return;
      let row = candidates.find(item => item.revision === draft.revision && ['pending', 'approved', 'released'].includes(item.status));
      if (!row) {
        const exact = pendingSubmission?.revision === draft.revision ? pendingSubmission : { requestId: makeId(), revision: draft.revision, document: draft.document, authoringMetadata: draft.authoringMetadata };
        if (!await submit(exact)) return;
        row = candidates.find(item => item.revision === draft.revision && ['pending', 'approved', 'released'].includes(item.status));
      }
      if (!row || !await inspect(row.candidateId)) return;
      if (selected?.status === 'released') { setStatus(`Revision ${draft.revision} is already published.`); return; }
      if (selected?.revision !== draft.revision || selected?.intentDigest !== draft.intentDigest) { setStatus('The candidate changed. Check status before publishing.'); return; }
      if (selected.status === 'pending' && !await approve(selected)) return;
      if (selected?.status === 'approved') await release(selected, null, edition.checked === true);
    });
    confirm.className = 'btn primary'; submitButton.hidden = true;
    confirmation.append(cancel, confirm); root.append(confirmation); confirmation.showModal?.(); cancel.focus?.();
    return true;
  }
  reload.addEventListener('click', () => void refreshList());
  const ready = refreshList();
  return {
    publish: async () => await ready ? submitDraft() : false,
    refresh: () => refreshList(),
    clear() {
      retire();
    },
  };
}
