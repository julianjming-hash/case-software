import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from '../src/shared/ids.mjs';
import { validateBuilderDocument } from '../src/shared/builder-document.mjs';
import { builderTemplates, createBuilderStarter } from '../src/client/builder-templates.mjs';
import { BUILDER_RESPONSE_LIMIT, createBuilderApi, createBuilderCase } from '../src/client/builder-api.mjs';

const caseId = uuidv7();
const workspaceId = uuidv7();
const operationId = uuidv7();
const checkpointId = uuidv7();
const restoreDigest = `\\x${'a'.repeat(64)}`;

test('four empty teaching starters preserve as schema 2 without clinical assertions', () => {
  for (const type of ['single_choice', 'multi_select', 'ranking', 'free_text']) {
    const candidate = createBuilderStarter(type);
    const result = validateBuilderDocument(candidate.document, candidate.authoringMetadata, { mode: 'preserve' });
    assert.equal(result.ok, true, type);
    assert.equal(candidate.document.decisions[0].interaction.type, type);
    assert.equal(candidate.document.decisions[0].paths.filter(path => path.recommended === true).length, 1);
    assert.equal(candidate.document.title, '');
  }
  assert.equal(builderTemplates().length, 4);
});

test('authenticated adapter binds every draft/save/checkpoint request to the selected case and exact revision', async () => {
  const calls = [];
  const latest = { revision: 0, document: { schema_version: 2 }, authoringMetadata: { metadata_version: 1 } };
  let draftReads = 0;
  const request = async (parts, options = {}) => {
    calls.push({ parts, options });
    if (parts.length === 1 && parts[0] === 'cases') return { caseId };
    if (parts.at(-1) === 'draft' && options.method !== 'PUT') return { case: { caseId, workspaceId, role: 'author' }, ...(++draftReads === 1 ? { draft: null, revision: 0 } : { draft: { ...latest, revision: 2, intentDigest: restoreDigest } }) };
    if (parts.at(-1) === 'save-windows' && options.method === 'POST') return { operationId, baseRevision: options.body.baseRevision };
    if (parts.at(-1) === 'draft' && options.method === 'PUT') return { operationId, revision: 1, intentDigest: 'opaque', status: 'saved' };
    if (parts.at(-1) === 'checkpoints' && options.method === undefined) return { checkpoints: [] };
    if (parts.includes('restore')) return { operationId: calls.at(-1).options.body.operationId, revision: 2, intentDigest: restoreDigest, status: 'restored' };
    if (parts.includes('save-windows')) return { operationId, baseRevision: 0, revision: 1, intentDigest: restoreDigest, status: 'saved' };
    return { id: checkpointId, name: 'Recovery', revision: 1, createdAt: '2026-10-09T00:00:00Z' };
  };
  const createdCase = await createBuilderCase(request, workspaceId, '  New case  ');
  assert.ok(createdCase);
  assert.deepEqual(calls[0].options.body, { workspaceId, title: 'New case' });
  const api = createBuilderApi({ request, caseId, workspaceId, initialWhenMissing: latest });
  assert.deepEqual(await api.readLatest(), latest);
  const window = await api.saveServices.issueWindow(0);
  assert.equal(window.operationId, operationId);
  assert.deepEqual(await api.saveServices.saveDraft({ operationId, document: latest.document, authoringMetadata: latest.authoringMetadata }),
    { operationId, revision: 1, intentDigest: 'opaque', status: 'saved' });
  assert.equal(await api.checkpointServices.list().then(list => list.length), 0);
  const checkpoint = await api.checkpointServices.create('Recovery', 2);
  assert.equal(checkpoint.id, checkpointId);
  assert.deepEqual(calls.find(call => call.parts.at(-1) === 'checkpoints' && call.options.method === 'POST').options.body,
    { name: 'Recovery', expectedRevision: 2 });
  const restored = await api.checkpointServices.restore(checkpointId, 2);
  assert.equal(restored.revision, 2);
  const windowCall = calls.filter(call => call.parts.at(-1) === 'save-windows' && call.options.method === 'POST').at(-1);
  assert.deepEqual(windowCall.options.body, { baseRevision: 2 });
  const restoreCall = calls.find(call => call.parts.includes('restore'));
  assert.deepEqual(restoreCall.options.body, { operationId });
  const maxRequest = calls.find(call => call.parts[0] === 'builder');
  assert.equal(maxRequest.options.maxResponseBytes, BUILDER_RESPONSE_LIMIT);
  assert.ok(calls.filter(call => call.parts[0] === 'builder').every(call => call.parts[2] === caseId));
});

test('checkpoint create refuses a changed revision and restore retries its exact server window after an uncertain response', async () => {
  const calls = [];
  let restoreAttempts = 0, revision = 4;
  const retryId = uuidv7();
  const request = async (parts, options = {}) => {
    calls.push({ parts, options });
    if (parts.at(-1) === 'draft' && options.method !== 'PUT') return { case: { caseId, workspaceId, role: 'author' }, draft: { revision, document: {}, authoringMetadata: { metadata_version: 1 }, intentDigest: revision === 4 ? `\\x${'4'.repeat(64)}` : restoreDigest } };
    if (parts.at(-1) === 'save-windows') return { operationId: retryId, baseRevision: options.body.baseRevision };
    if (parts.includes('restore')) {
      restoreAttempts++;
      if (restoreAttempts === 1) throw new Error('response lost');
      revision = 5;
      return { operationId: options.body.operationId, revision: 5, intentDigest: restoreDigest, status: 'restored' };
    }
    return {};
  };
  const api = createBuilderApi({ request, caseId, workspaceId });
  await assert.rejects(api.checkpointServices.create('stale', 3), /changed before checkpoint creation/);
  assert.equal(calls.some(call => call.parts.at(-1) === 'checkpoints' && call.options.method === 'POST'), false);

  await assert.rejects(api.checkpointServices.restore(checkpointId, 4), /response lost/);
  assert.equal(calls.filter(call => call.parts.at(-1) === 'save-windows').length, 1);
  const firstOperation = calls.find(call => call.parts.includes('restore')).options.body.operationId;
  const restored = await api.checkpointServices.restore(checkpointId, 4);
  const operationIds = calls.filter(call => call.parts.includes('restore')).map(call => call.options.body.operationId);
  assert.deepEqual(operationIds, [firstOperation, firstOperation]);
  assert.equal(restored.revision, 5);
  assert.equal(calls.filter(call => call.parts.at(-1) === 'save-windows').length, 1);
});

test('checkpoint restore refuses malformed receipts and same-revision digest mismatches', async () => {
  for (const { receiptDigest, latestDigest } of [
    { receiptDigest: 'opaque', latestDigest: restoreDigest },
    { receiptDigest: restoreDigest, latestDigest: `\\x${'b'.repeat(64)}` },
  ]) {
    let revision = 4;
    const request = async (parts, options = {}) => {
      if (parts.at(-1) === 'draft' && options.method !== 'PUT') return { case: { caseId, workspaceId, role: 'author' },
        draft: { revision, document: {}, authoringMetadata: { metadata_version: 1 }, intentDigest: latestDigest } };
      if (parts.at(-1) === 'save-windows' && options.method === 'POST') return { operationId, baseRevision: options.body.baseRevision };
      if (parts.includes('restore')) { revision = 5; return { operationId, revision, intentDigest: receiptDigest, status: 'restored' }; }
      return {};
    };
    const api = createBuilderApi({ request, caseId, workspaceId });
    await assert.rejects(api.checkpointServices.restore(checkpointId, 4), /acknowledgement is invalid|saved pair no longer matches/);
  }
});

test('concurrent restores share one pending initialization and one server operation ID', async () => {
  let releaseWindow, windowCalls = 0, restoreCalls = 0, revision = 4;
  const windowGate = new Promise(resolve => { releaseWindow = resolve; });
  const request = async (parts, options = {}) => {
    if (parts.at(-1) === 'draft' && options.method !== 'PUT') return { case: { caseId, workspaceId, role: 'author' },
      draft: { revision, document: {}, authoringMetadata: { metadata_version: 1 }, intentDigest: revision === 4 ? `\\x${'4'.repeat(64)}` : restoreDigest } };
    if (parts.at(-1) === 'save-windows' && options.method === 'POST') { windowCalls++; return windowGate; }
    if (parts.includes('restore')) { restoreCalls++; revision = 5; return { operationId: options.body.operationId, revision, intentDigest: restoreDigest, status: 'restored' }; }
    return {};
  };
  const api = createBuilderApi({ request, caseId, workspaceId });
  const first = api.checkpointServices.restore(checkpointId, 4);
  const second = api.checkpointServices.restore(checkpointId, 4);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(windowCalls, 1, 'both callers await the same restore-window initialization');
  releaseWindow({ operationId, baseRevision: 4 });
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
  assert.equal(windowCalls, 1);
  assert.equal(restoreCalls, 2, 'concurrent submissions replay one operation ID through the server receipt');
});

test('D13: a draft read answered 503 is read again once after a pause; a second 503 or any other refusal is reported', async () => {
  const refuse = status => Object.assign(new Error('request_unavailable'), { status, code: status === 503 ? 'unavailable' : 'forbidden' });
  const draft = { case: { caseId, workspaceId, role: 'author' }, draft: { revision: 4, document: { schema_version: 2 }, authoringMetadata: { metadata_version: 1 }, intentDigest: restoreDigest } };
  const run = async replies => {
    const pauses = [];
    let reads = 0;
    const api = createBuilderApi({ caseId, pause: async ms => { pauses.push(ms); },
      request: async parts => { assert.equal(parts.at(-1), 'draft'); const reply = replies[reads++]; if (reply instanceof Error) throw reply; return reply; } });
    try { return { value: await api.saveServices.readLatest(), reads, pauses }; } catch (error) { return { error, reads, pauses }; }
  };
  const once = await run([refuse(503), draft]);
  assert.equal(once.value.revision, 4); assert.equal(once.reads, 2); assert.deepEqual(once.pauses, [600]);
  const twice = await run([refuse(503), refuse(503), draft]);
  assert.equal(twice.error.status, 503); assert.equal(twice.reads, 2);
  const other = await run([refuse(403), draft]);
  assert.equal(other.error.status, 403); assert.equal(other.reads, 1); assert.deepEqual(other.pauses, []);
});
