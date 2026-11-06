const copy = value => structuredClone(value);
const same = (left, right) => {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) return left.length === right.length && left.every((value, index) => same(value, right[index]));
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && same(left[key], right[key]));
};

/**
 * Keep one canonical local draft beside an acknowledged server revision.
 * Private values stay in memory only; persistence is supplied by the caller.
 *
 * services.issueWindow(baseRevision) -> { operationId }
 * services.saveDraft({ operationId, document, authoringMetadata }) -> receipt
 * services.readReceipt(operationId) -> receipt | { status: 'absent' }
 * services.readLatest() -> { revision, document, authoringMetadata }
 * services.validate({ document, authoringMetadata }) -> [] | issues
 */
export function createBuilderSaveState({ initial, services, onChange = () => {} }) {
  if (!initial || !Number.isSafeInteger(initial.revision) || initial.revision < 0) throw new TypeError('initial draft needs a non-negative revision');
  for (const name of ['issueWindow', 'saveDraft', 'readReceipt', 'readLatest']) {
    if (typeof services?.[name] !== 'function') throw new TypeError(`services.${name} is required`);
  }

  let baseRevision = initial.revision;
  let intentDigest = initial.intentDigest ?? null;
  let document = copy(initial.document);
  let authoringMetadata = copy(initial.authoringMetadata);
  let localGeneration = 0;
  let savedGeneration = 0;
  let status = 'saved';
  let conflict = null;
  let uncertainOperation = null;
  let lastReceipt = null;
  let active = false;
  let lifecycle = 0;

  const snapshot = () => copy({
    status, baseRevision, intentDigest, document, authoringMetadata,
    dirty: localGeneration !== savedGeneration,
    conflict, uncertainOperation, localGeneration, savedGeneration, lastReceipt,
  });
  // The change listener (the studio) gets the held draft itself, never changed in place by either side, so a key on a
  // draft at the caps is not copied whole on every publish (round 28). A caller is handed a full copy, except one that
  // handed over its own values (`owned`), which gets them back.
  const publish = (owned = false) => {
    const value = { ...copy({ status, baseRevision, intentDigest, dirty: localGeneration !== savedGeneration, conflict, uncertainOperation, localGeneration, savedGeneration, lastReceipt }), document, authoringMetadata };
    onChange(value); return owned ? value : snapshot();
  };
  const dirtyStatus = () => { if (!conflict && !uncertainOperation && status !== 'saving') status = localGeneration === savedGeneration ? 'saved' : 'dirty'; };

  // `owned`: the caller hands over fresh values it will not touch again, so they are kept without a second copy
  // (a keystroke on a draft at the caps; every snapshot handed out is still a copy).
  function setDraft(nextDocument, nextMetadata = authoringMetadata, { owned = false } = {}) {
    document = owned ? nextDocument : copy(nextDocument);
    authoringMetadata = owned ? nextMetadata : copy(nextMetadata);
    localGeneration++;
    dirtyStatus();
    return publish(owned);
  }

  function load(next) {
    if (!next || !Number.isSafeInteger(next.revision) || next.revision < 0) throw new TypeError('loaded draft needs a non-negative revision');
    lifecycle++;
    active = false;
    baseRevision = next.revision;
    intentDigest = next.intentDigest ?? null;
    document = copy(next.document);
    authoringMetadata = copy(next.authoringMetadata);
    localGeneration++;
    savedGeneration = localGeneration;
    status = 'saved';
    conflict = null;
    uncertainOperation = null;
    lastReceipt = null;
    return publish();
  }

  function resolveConflict(choice) {
    if (status !== 'conflict' || !conflict) throw new Error('there is no draft conflict to resolve');
    if (choice === 'saved') {
      baseRevision = conflict.revision;
      intentDigest = conflict.intentDigest ?? null;
      document = copy(conflict.document);
      authoringMetadata = copy(conflict.authoringMetadata);
      localGeneration++;
      savedGeneration = localGeneration;
      lastReceipt = null;
      conflict = null;
      status = 'saved';
      return publish();
    }
    if (choice === 'local') {
      baseRevision = conflict.revision;
      intentDigest = conflict.intentDigest ?? null;
      conflict = null;
      status = 'dirty';
      lastReceipt = null;
      return publish();
    }
    throw new TypeError('choose saved or local');
  }

  function markConflict(latest, submitted = null) {
    if (!latest || !Number.isSafeInteger(latest.revision) || latest.revision < 0) throw new Error('latest draft response is invalid');
    conflict = copy(latest);
    conflict.submitted = submitted ? copy(submitted) : null;
    baseRevision = latest.revision;
    intentDigest = latest.intentDigest ?? null;
    status = 'conflict';
    uncertainOperation = null;
    return publish();
  }

  function receiptShape(receipt, operationId, baseRevision) {
    return receipt && receipt.operationId === operationId && Number.isSafeInteger(receipt.revision) &&
      receipt.revision >= baseRevision && ['saved', 'noop'].includes(receipt.status) &&
      typeof receipt.intentDigest === 'string' && receipt.intentDigest.length > 0 &&
      (receipt.baseRevision === undefined || receipt.baseRevision === baseRevision);
  }

  async function save() {
    if (active) throw Object.assign(new Error('A save is already in progress.'), { code: 'save_in_progress' });
    if (status === 'conflict') throw Object.assign(new Error('Resolve the saved-draft conflict before saving.'), { code: 'save_conflict' });
    if (status === 'uncertain') throw Object.assign(new Error('Reconcile the previous save before saving again.'), { code: 'save_uncertain' });
    if (localGeneration === savedGeneration) return snapshot();

    const validation = services.validate?.({ document: copy(document), authoringMetadata: copy(authoringMetadata) }) ?? [];
    if (validation.length) throw Object.assign(new Error('This draft contains unsupported or invalid saved content.'), { code: 'invalid_candidate', issues: copy(validation) });

    active = true;
    const owner = lifecycle;
    const frozen = { document: copy(document), authoringMetadata: copy(authoringMetadata), generation: localGeneration, baseRevision };
    status = 'saving';
    publish();
    let operationId = null;
    let receipt;
    try {
      try {
        // CASE-240: the Worker names a save-window quota refusal; say it plainly instead of request_unavailable.
        const window = await services.issueWindow(frozen.baseRevision).catch(error => {
          throw error?.code === 'save_quota' ? Object.assign(new Error('Save limit reached for this case. Your writing is kept here; try again later.'), { code: 'save_quota', cause: error }) : error;
        });
        operationId = window?.operationId;
        if (typeof operationId !== 'string' || !operationId) throw Object.assign(new Error('Save window response is invalid.'), { code: 'save_protocol' });
        if (owner !== lifecycle) return snapshot();
        receipt = await services.saveDraft({ operationId, document: copy(frozen.document), authoringMetadata: copy(frozen.authoringMetadata) });
        if (owner !== lifecycle) return snapshot();
        if (!receiptShape(receipt, operationId, frozen.baseRevision)) throw Object.assign(new Error('Save receipt does not match the submitted operation.'), { code: 'save_protocol' });
        lastReceipt = copy(receipt);
      } catch (error) {
        if (owner !== lifecycle) return snapshot();
        if (error?.code === 'revision_conflict') {
          try {
            const latest = await services.readLatest();
            if (owner !== lifecycle) return snapshot();
            markConflict(latest, frozen);
            throw Object.assign(new Error('Another saved draft is newer. Both copies are kept.'), { code: 'revision_conflict', cause: error });
          } catch (readError) {
            if (owner !== lifecycle) return snapshot();
            if (readError?.code === 'revision_conflict') throw readError;
            // The write is definitively refused, but the current saved copy could not be fetched.
            // Keep the exact local draft and require an explicit refresh before another save.
            status = 'conflict_read_failed';
            publish();
            throw Object.assign(new Error('The save was refused because a newer revision exists, but it could not be loaded. Refresh the saved copy before retrying.'), { code: 'conflict_read_failed', cause: readError });
          }
        }
        if (operationId && !isDefinitive(error)) {
          uncertainOperation = { operationId, baseRevision: frozen.baseRevision, generation: frozen.generation, document: frozen.document, authoringMetadata: frozen.authoringMetadata, receipt: null };
          status = 'uncertain';
          publish();
          throw Object.assign(new Error('The save acknowledgement is uncertain. Reconcile this exact save before continuing.'), { code: 'save_uncertain', cause: error });
        }
        status = localGeneration === savedGeneration ? 'saved' : 'dirty';
        publish();
        throw error;
      }
      return await acceptReceipt(receipt, frozen, owner);
    } finally {
      if (owner === lifecycle) active = false;
    }
  }

  async function acceptReceipt(receipt, frozen, owner) {
    let latest;
    try { latest = await services.readLatest(); }
    catch (error) {
      if (owner !== lifecycle) return snapshot();
      uncertainOperation = { operationId: receipt.operationId, baseRevision: frozen.baseRevision, generation: frozen.generation, document: frozen.document, authoringMetadata: frozen.authoringMetadata, receipt: copy(receipt) };
      status = 'uncertain';
      publish();
      throw Object.assign(new Error('The save committed, but the current draft could not be read. Reconcile before saving again.'), { code: 'save_uncertain', cause: error });
    }
    if (owner !== lifecycle) return snapshot();
    if (latest.revision < receipt.revision) {
      uncertainOperation = { operationId: receipt.operationId, baseRevision: frozen.baseRevision, generation: frozen.generation, document: frozen.document, authoringMetadata: frozen.authoringMetadata, receipt: copy(receipt) };
      status = 'uncertain';
      publish();
      throw Object.assign(new Error('The current draft is older than the acknowledged save receipt.'), { code: 'save_protocol' });
    }
    if (latest.revision > receipt.revision) {
      lastReceipt = copy(receipt);
      return markConflict(latest, frozen);
    }
    if (!same(latest.document, frozen.document) || !same(latest.authoringMetadata, frozen.authoringMetadata)) {
      uncertainOperation = { operationId: receipt.operationId, baseRevision: frozen.baseRevision, generation: frozen.generation, document: frozen.document, authoringMetadata: frozen.authoringMetadata, receipt: copy(receipt) };
      status = 'uncertain';
      publish();
      throw Object.assign(new Error('The acknowledged revision does not contain the exact submitted draft.'), { code: 'save_protocol' });
    }
    baseRevision = receipt.revision;
    intentDigest = receipt.intentDigest;
    savedGeneration = Math.max(savedGeneration, frozen.generation);
    // REVIEW-01: the held draft is kept when the acknowledged revision holds the same content, so a review the studio
    // took on it (compared by identity) stays valid through an autosave that changed nothing.
    if (localGeneration === frozen.generation) {
      if (!same(document, latest.document)) document = copy(latest.document);
      if (!same(authoringMetadata, latest.authoringMetadata)) authoringMetadata = copy(latest.authoringMetadata);
    }
    status = localGeneration === savedGeneration ? 'saved' : 'dirty';
    uncertainOperation = null;
    conflict = null;
    return publish();
  }

  async function reconcile() {
    if (status === 'conflict_read_failed') {
      if (active) throw Object.assign(new Error('A saved-copy refresh is already in progress.'), { code: 'reconcile_in_progress' });
      active = true;
      const owner = lifecycle;
      try {
        const latest = await services.readLatest();
        if (owner !== lifecycle) return snapshot();
        markConflict(latest);
        return snapshot();
      } catch (error) {
        if (owner === lifecycle) { status = 'conflict_read_failed'; publish(); }
        throw Object.assign(new Error('The newer saved copy is still unavailable. Your local writing remains unchanged.'), { code: 'conflict_read_failed', cause: error });
      } finally { if (owner === lifecycle) active = false; }
    }
    if (status !== 'uncertain' || !uncertainOperation) throw new Error('there is no uncertain save to reconcile');
    if (active) throw Object.assign(new Error('A save reconciliation is already in progress.'), { code: 'reconcile_in_progress' });
    active = true;
    const owner = lifecycle;
    const operation = copy(uncertainOperation);
    try {
      const receipt = await services.readReceipt(operation.operationId);
      if (owner !== lifecycle) return snapshot();
      if (receiptShape(receipt, operation.operationId, operation.baseRevision)) {
        lastReceipt = copy(receipt);
        const frozen = { ...operation, generation: operation.generation, baseRevision: operation.baseRevision };
        return await acceptReceipt(receipt, frozen, owner);
      }
      if (receipt?.operationId !== operation.operationId || receipt.baseRevision !== operation.baseRevision) {
        throw Object.assign(new Error('The exact save status response is invalid. Reconcile again before saving.'), { code: 'save_protocol' });
      }
      if (receipt.status === 'issued') {
        // Re-submit only the exact frozen payload under the same server operation ID. An absent
        // receipt is not evidence that a timed-out request has finished.
        try {
          const replay = await services.saveDraft({ operationId: operation.operationId, document: copy(operation.document), authoringMetadata: copy(operation.authoringMetadata) });
          if (owner !== lifecycle) return snapshot();
          if (!receiptShape(replay, operation.operationId, operation.baseRevision)) throw Object.assign(new Error('Save replay receipt does not match the submitted operation.'), { code: 'save_protocol' });
          lastReceipt = copy(replay);
          const frozen = { ...operation, generation: operation.generation, baseRevision: operation.baseRevision };
          return await acceptReceipt(replay, frozen, owner);
        } catch (error) {
          if (owner !== lifecycle) return snapshot();
          if (error?.code === 'revision_conflict') {
            const latest = await services.readLatest();
            if (owner !== lifecycle) return snapshot();
            return markConflict(latest, operation);
          }
          if (status !== 'uncertain') { status = 'uncertain'; uncertainOperation = operation; publish(); }
          throw Object.assign(new Error('The exact save is still unresolved. Reconcile this same operation before saving again.'), { code: 'save_uncertain', cause: error });
        }
      }
      if (receipt.status === 'expired') {
        const latest = await services.readLatest();
        if (owner !== lifecycle) return snapshot();
        if (!validLatest(latest) || latest.revision < operation.baseRevision) throw Object.assign(new Error('Latest draft response is invalid.'), { code: 'save_protocol' });
        if (latest.revision > operation.baseRevision) return markConflict(latest, operation);
        uncertainOperation = null;
        status = localGeneration === savedGeneration ? 'saved' : 'dirty';
        return publish();
      }
      throw Object.assign(new Error('The exact save status is unavailable or expired from retention. Keep this draft unresolved and request help.'), { code: 'save_protocol' });
    } finally {
      if (owner === lifecycle) active = false;
    }
  }

  return Object.freeze({ snapshot, setDraft, load, save, reconcile, resolveConflict });
}

function validLatest(value) {
  return Boolean(value && Number.isSafeInteger(value.revision) && value.revision >= 0 &&
    value.document && typeof value.document === 'object' && value.authoringMetadata && typeof value.authoringMetadata === 'object');
}

function isDefinitive(error) {
  return Boolean(error?.definitive || ['invalid_candidate', 'revision_conflict', 'conflict', 'permission_denied', 'save_window_expired'].includes(error?.code));
}
