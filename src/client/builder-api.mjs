// Authenticated client adapter for the revision-paired Builder persistence contract (C42).
// All transport remains inside accountRequest; documents and private metadata stay in memory.
import { isUuidV7 } from '../shared/ids.mjs';

const MAX_RESPONSE = 2_097_152;
export function builderCaseContext(response, caseId, expectedWorkspaceId = null) {
  const access = response?.case;
  if (!isUuidV7(caseId) || access?.caseId !== caseId || !isUuidV7(access?.workspaceId) ||
      !['owner', 'author', 'admin'].includes(access?.role) ||
      (expectedWorkspaceId !== null && expectedWorkspaceId !== access.workspaceId))
    throw new Error('Case unavailable in this account.');
  return { caseId, workspaceId: access.workspaceId, role: access.role };
}
const parts = caseId => {
  if (!isUuidV7(caseId)) throw new TypeError('Builder case ID must be a UUIDv7.');
  return ['builder', 'cases', caseId];
};
const pair = draft => {
  if (!draft || !Number.isSafeInteger(draft.revision) || draft.revision < 0 ||
      !draft.document || typeof draft.document !== 'object' ||
      (draft.authoringMetadata !== null && draft.authoringMetadata !== undefined && typeof draft.authoringMetadata !== 'object'))
    throw new Error('Saved draft incomplete.');
  return { revision: draft.revision, document: draft.document, authoringMetadata: draft.authoringMetadata ?? { metadata_version: 1 }, intentDigest: draft.intentDigest ?? null };
};
const draftFrom = response => {
  if (response?.draft === null && response?.revision === 0) return null;
  return pair(response?.draft);
};

export async function createBuilderCase(request, workspaceId, title) {
  if (typeof request !== 'function' || !isUuidV7(workspaceId) || typeof title !== 'string' || !title.trim())
    throw new TypeError('Workspace and title are required.');
  const result = await request(['cases'], { method: 'POST', body: { workspaceId, title: title.trim() } });
  if (!isUuidV7(result?.caseId)) throw new Error('The new case could not be confirmed.');
  return result.caseId;
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
// D13: the Worker answers 503 when a database call times out or the network to it fails; Supabase then logs nothing.
// Reading the draft is safe to repeat, so one 503 is read again once after a pause before it is reported (a save's
// follow-up read would otherwise leave the author reconciling a save that committed).
export const DRAFT_READ_RETRY_MS = 600;

export function createBuilderApi({ request, caseId, workspaceId = null, initialWhenMissing = null, pause = wait } = {}) {
  if (typeof request !== 'function') throw new TypeError('An authenticated request function is required.');
  const root = parts(caseId);
  const send = (suffix, options = {}) => request([...root, ...suffix], { maxResponseBytes: MAX_RESPONSE, ...options });
  const operationBases = new Map();
  let pendingRestore = null;
  const validDigest = value => typeof value === 'string' && /^\\x[0-9a-f]{64}$/i.test(value);
  const readLatest = async () => {
    const response = await send(['draft']).catch(async error => { if (error?.status !== 503) throw error; await pause(DRAFT_READ_RETRY_MS); return send(['draft']); });
    builderCaseContext(response, caseId, workspaceId);
    const value = draftFrom(response);
    if (value) return value;
    if (initialWhenMissing) return { revision: 0, document: structuredClone(initialWhenMissing.document), authoringMetadata: structuredClone(initialWhenMissing.authoringMetadata) };
    throw new Error('No saved Builder draft exists for this case.');
  };
  const saveServices = {
    async issueWindow(baseRevision) {
      const value = await send(['save-windows'], { method: 'POST', body: { baseRevision } });
      if (typeof value?.operationId === 'string') operationBases.set(value.operationId, baseRevision);
      return { operationId: value?.operationId, baseRevision: value?.baseRevision };
    },
    async saveDraft({ operationId, document, authoringMetadata }) {
      return send(['draft'], { method: 'PUT', body: { operationId, document, authoringMetadata } });
    },
    async readReceipt(operationId) {
      try { return await send(['save-windows', operationId]); }
      catch (error) {
        if (error?.status === 404 && error?.code === 'not_found') {
          const baseRevision = operationBases.get(operationId);
          return Number.isSafeInteger(baseRevision) ? { operationId, baseRevision, status: 'not_found' } : { operationId, status: 'not_found' };
        }
        throw error;
      }
    },
    readLatest,
  };
  const checkpointServices = {
    async list() {
      const value = await send(['checkpoints']);
      if (!Array.isArray(value?.checkpoints)) throw new Error('Checkpoint list is unavailable.');
      return value.checkpoints;
    },
    async create(name, expectedRevision) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new TypeError('Checkpoint creation needs the exact saved revision.');
      const current = await readLatest();
      if (current.revision !== expectedRevision) throw new Error('The saved draft changed before checkpoint creation. Reload it and try again.');
      return send(['checkpoints'], { method: 'POST', body: { name, expectedRevision } });
    },
    async delete(checkpointId) {
      if (!isUuidV7(checkpointId)) throw new TypeError('Checkpoint ID must be a UUIDv7.');
      return send(['checkpoints', checkpointId], { method: 'DELETE' });
    },
    async restore(checkpointId, expectedRevision) {
      if (!isUuidV7(checkpointId)) throw new TypeError('Checkpoint ID must be a UUIDv7.');
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new TypeError('Checkpoint restore needs the exact acknowledged base revision.');
      if (pendingRestore && (pendingRestore.checkpointId !== checkpointId || pendingRestore.baseRevision !== expectedRevision))
        throw new Error('A checkpoint restore is still being reconciled. Retry that same restore before starting another.');
      if (!pendingRestore) {
        const attempt = { checkpointId, baseRevision: expectedRevision, operationId: null, receipt: null, initialization: null };
        pendingRestore = attempt;
        attempt.initialization = (async () => {
          try {
            const current = await readLatest();
            if (current.revision !== expectedRevision) throw new Error('The saved draft changed before checkpoint restore. Reload it and try again.');
            const window = await saveServices.issueWindow(expectedRevision);
            if (!isUuidV7(window?.operationId) || window.baseRevision !== expectedRevision)
              throw new Error('A matching server save window could not be issued for checkpoint restore.');
            attempt.operationId = window.operationId;
          } catch (error) {
            if (pendingRestore === attempt) pendingRestore = null;
            throw error;
          }
        })();
      }
      const attempt = pendingRestore;
      if (attempt.initialization) {
        await attempt.initialization;
        attempt.initialization = null;
      }
      if (!attempt.receipt) {
        const receipt = await send(['checkpoints', checkpointId, 'restore'], { method: 'POST', body: { operationId: attempt.operationId } });
        if (receipt?.operationId !== attempt.operationId || !Number.isSafeInteger(receipt?.revision) ||
            !validDigest(receipt?.intentDigest) || receipt.status !== 'restored')
          throw new Error('Checkpoint restore acknowledgement is invalid.');
        attempt.receipt = receipt;
      }
      const latest = await readLatest();
      if (latest.revision !== attempt.receipt.revision || latest.intentDigest !== attempt.receipt.intentDigest) {
        if (pendingRestore === attempt) pendingRestore = null;
        throw new Error('The current saved pair no longer matches the checkpoint restore receipt.');
      }
      if (pendingRestore === attempt) pendingRestore = null;
      return latest;
    },
  };
  return Object.freeze({ saveServices, checkpointServices, readLatest });
}

export const BUILDER_RESPONSE_LIMIT = MAX_RESPONSE;
