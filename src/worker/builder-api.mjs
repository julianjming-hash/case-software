// Builder persistence orchestration. The router owns path dispatch; every mutation
// still re-authorizes in SQL, and payloads are parsed with the bounded shared parser.
import { bearer, verifyFacilitatorJwt, AuthUnavailableError } from './auth.mjs';
import { isUuidV7 } from '../shared/ids.mjs';
import { ACTIONS } from '../shared/permissions.mjs';
import { actorFor, adminArgs, allows, authorize } from './authorize.mjs';
import { accountActive } from './admin/account-active.mjs';
import { rpcFailure } from './published-rooms.mjs';
import { BODY_READ_DEADLINE_MS } from './request-deadline.mjs';

const MAX_WIRE = 2 * 1_048_576;
const fail = (error, status) => new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const revision = n => Number.isSafeInteger(n) && n >= 0;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

async function readBounded(request, parseJson) {
  const length = request.headers.get('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > MAX_WIRE) return { error: 'too_large' };
  if (!request.body || typeof parseJson !== 'function') return { error: 'not_json' };
  const reader = request.body.getReader(), chunks = [];
  let bytes = 0;
  let timer;
  const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(null), BODY_READ_DEADLINE_MS); });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next === null) { try { void reader.cancel(); } catch { /* refusal is already decided */ } return { error: 'request_timeout' }; }
      const { done, value } = next;
      if (done) break;
      if (!(value instanceof Uint8Array) || bytes + value.byteLength > MAX_WIRE) {
        try { void reader.cancel(); } catch { /* refusal is already decided */ }
        return { error: 'too_large' };
      }
      chunks.push(value); bytes += value.byteLength;
    }
  } catch { return { error: 'not_json' }; }
  finally { clearTimeout(timer); }
  const merged = new Uint8Array(bytes);
  let at = 0;
  for (const chunk of chunks) { merged.set(chunk, at); at += chunk.byteLength; }
  try {
    const parsed = parseJson(new TextDecoder('utf-8', { fatal: true }).decode(merged), { maxBytes: MAX_WIRE, maxDepth: 32, maxNodes: 100_000 });
    return parsed?.ok ? { body: parsed.value } : { error: parsed?.error?.code === 'too_large' ? 'too_large' : 'not_json' };
  } catch { return { error: 'not_json' }; }
}

function responseForRpc(name, result, onAlert) {
  if (result?.ok) return null;
  const mapped = rpcFailure(name, result, onAlert);
  return fail(mapped.error, mapped.status);
}

async function authorizeCase(rpc, actor, caseId, onAlert) {
  const access = await rpc.call('get_case_authoring_access', { p_case_id: caseId, p_user_id: actor.userId, ...adminArgs(actor) });
  if (!access?.ok) return { response: responseForRpc('get_case_authoring_access', access, onAlert) };
  if (!Array.isArray(access.data) || access.data.length > 1) return { response: fail('unavailable', 503) };
  if (!access.data.length) return { response: fail('forbidden', 403) };
  const row = access.data[0];
  if (row?.case_id !== caseId || !isUuidV7(row.workspace_id) || (row.role === 'admin') !== actor.admin || !allows(ACTIONS.draft, { admin: actor.admin, role: row.role }))
    return { response: fail('forbidden', 403) };
  if (typeof row.title !== 'string' || !row.title.trim() || row.title.length > 200 ||
      !((row.source_version_id === null && row.source_version_no === null) ||
        (isUuidV7(row.source_version_id) && Number.isSafeInteger(row.source_version_no) && row.source_version_no > 0)))
    return { response: fail('unavailable', 503) };
  // CASE-214: slide drafts are active; the capability tells the Builder to load slide authoring (card 51).
  return { ok: true, case: { caseId: row.case_id, workspaceId: row.workspace_id, role: row.role, title: row.title, capabilities: ['slide_composition'],
    sourceVersion: row.source_version_id === null ? null : { versionId: row.source_version_id, versionNo: row.source_version_no } } };
}

function oneRow(name, result, onAlert) {
  const failed = responseForRpc(name, result, onAlert);
  if (failed) return { response: failed };
  if (!Array.isArray(result.data) || result.data.length !== 1 || !plain(result.data[0])) return { response: fail('unavailable', 503) };
  return { row: result.data[0] };
}

/** Return null when the route is outside Builder. Dependencies keep parsing/validation testable. */
export async function handleBuilderApi(request, {
  rpc, env, onAlert, verifyUser = verifyFacilitatorJwt, parseJson,
  validateDraft, hashSources, nowMs = () => Date.now(),
}) {
  const url = new URL(request.url), path = url.pathname.replace(/\/+$/, ''), method = request.method;
  const match = /^\/api\/v1\/builder\/cases\/([0-9a-f-]{36})(?:\/(draft|archive|save-windows(?:\/([0-9a-f-]{36}))?|checkpoints(?:\/([0-9a-f-]{36})(?:\/(restore))?)?))?$/.exec(path);
  if (!match) return null;
  const caseId = match[1], route = (match[2] ?? '').split('/')[0], operationId = match[3], checkpointId = match[4], restore = match[5] === 'restore';
  if (!isUuidV7(caseId) || (operationId && !isUuidV7(operationId)) || (checkpointId && !isUuidV7(checkpointId))) return fail('bad_request', 400);
  const rpcClient = rpc;
  if (!rpcClient || typeof rpcClient.call !== 'function') return fail('unavailable', 503);
  let user;
  try { user = await verifyUser(bearer(request), env); }
  catch (error) { if (error instanceof AuthUnavailableError) return fail('auth_unavailable', 503); throw error; }
  if (!user) return fail('unauthorised', 401);
  const active = await accountActive(rpcClient, user.userId);
  if (active) return fail(active.error, active.status);
  const actor = actorFor(user, env);
  const entitled = await authorizeCase(rpcClient, actor, caseId, onAlert);
  if (entitled.response) return entitled.response;
  const args = { p_case_id: caseId, p_user_id: actor.userId, ...adminArgs(actor) };

  if (route === 'draft' && method === 'GET') {
    const result = await rpcClient.call('builder_get_draft', args), parsed = oneRow('builder_get_draft', result, onAlert);
    if (parsed.response) return parsed.response;
    const row = parsed.row;
    // Whether this person publishes (P-15: an owner or administrator; an editor only under editors_publish). The Builder then
    // says Publish update or Send for review. SQL and the review routes decide again.
    const publishing = await authorize(rpcClient, actor, { caseId }, ACTIONS.publish, onAlert);
    const context = { ...entitled.case, publishes: publishing.ok === true };
    if (row.revision === 0 && row.schema_version === null && row.document === null && row.authoring_metadata === null && row.updated_at === null && row.intent_digest === null)
      return json({ case: context, draft: null, revision: 0 });
    if (!revision(row.revision) || ![1, 2, 3].includes(row.schema_version) || row.document?.schema_version !== row.schema_version ||
        !(row.authoring_metadata === null || plain(row.authoring_metadata)) || typeof row.updated_at !== 'string' || !/^\\x[0-9a-f]{64}$/i.test(row.intent_digest)) return fail('unavailable', 503);
    return json({ case: context, draft: { revision: row.revision, schemaVersion: row.schema_version, document: row.document,
      authoringMetadata: row.authoring_metadata, updatedAt: row.updated_at, intentDigest: row.intent_digest } });
  }

  // CASE-316 / P-42: an owner or admin archives a never-published draft. The case leaves every list; nothing is deleted.
  if (route === 'archive' && method === 'POST') {
    if (!allows(ACTIONS.archiveDraftCase, { admin: actor.admin, role: entitled.case.role })) return fail('forbidden', 403);
    const parsed = await readBounded(request, parseJson);
    if (parsed.error) return fail(parsed.error, parsed.error === 'too_large' ? 413 : parsed.error === 'request_timeout' ? 408 : 400);
    if (!plain(parsed.body) || Object.keys(parsed.body).length !== 1 || typeof parsed.body.confirmTitle !== 'string' || parsed.body.confirmTitle.length > 200)
      return fail('bad_request', 400);
    const result = await rpcClient.call('builder_archive_case', { ...args, p_confirm_title: parsed.body.confirmTitle });
    const found = oneRow('builder_archive_case', result, onAlert);
    if (found.response) return found.response;
    const outcome = found.row.case_id === caseId ? found.row.outcome : null;
    if (outcome === 'archived') return json({ caseId, archived: true });
    const refused = { published: 'case_published', in_review: 'review_open', title_mismatch: 'title_mismatch' }[outcome];
    return refused ? fail(refused, 409) : fail('unavailable', 503);
  }

  if (route === 'save-windows' && !operationId && method === 'POST') {
    const parsed = await readBounded(request, parseJson);
    if (parsed.error) return fail(parsed.error, parsed.error === 'too_large' ? 413 : parsed.error === 'request_timeout' ? 408 : 400);
    if (!plain(parsed.body) || Object.keys(parsed.body).length !== 1 || !revision(parsed.body.baseRevision)) return fail('bad_request', 400);
    const result = await rpcClient.call('builder_open_save_window', { ...args, p_base_revision: parsed.body.baseRevision });
    // 23514 here is only ever builder_quota (open windows) or builder_storage_quota (CASE-240): name it for the Builder.
    if (!result?.ok && result?.kind === 'bad_request' && result?.code === '23514') return fail('save_quota', 429);
    const found = oneRow('builder_open_save_window', result, onAlert);
    if (found.response) return found.response;
    const row = found.row;
    if (!isUuidV7(row.operation_id) || row.base_revision !== parsed.body.baseRevision || typeof row.expires_at !== 'string' || !Number.isFinite(Date.parse(row.expires_at)) || Date.parse(row.expires_at) <= nowMs()) return fail('unavailable', 503);
    return json({ operationId: row.operation_id, baseRevision: row.base_revision, expiresAt: row.expires_at }, 201);
  }

  if (route === 'save-windows' && operationId && method === 'GET') {
    const result = await rpcClient.call('builder_get_save_receipt', { ...args, p_operation_id: operationId });
    if (result?.ok && Array.isArray(result.data) && result.data.length === 0) return fail('not_found', 404);
    const found = oneRow('builder_get_save_receipt', result, onAlert);
    if (found.response) return found.response;
    const row = found.row;
    if (!isUuidV7(row.operation_id) || row.operation_id !== operationId || !revision(row.base_revision)) return fail('unavailable', 503);
    if (row.status === 'issued' || row.status === 'expired') {
      if (typeof row.expires_at !== 'string' || !Number.isFinite(Date.parse(row.expires_at)) || row.revision !== null || row.intent_digest !== null || row.committed_at !== null)
        return fail('unavailable', 503);
      return json({ operationId, baseRevision: row.base_revision, status: row.status, expiresAt: row.expires_at });
    }
    if (!revision(row.revision) || !/^\\x[0-9a-f]{64}$/i.test(row.intent_digest) || !['saved', 'noop', 'restored'].includes(row.status) || typeof row.committed_at !== 'string') return fail('unavailable', 503);
    return json({ operationId, baseRevision: row.base_revision, revision: row.revision, intentDigest: row.intent_digest, status: row.status, committedAt: row.committed_at });
  }

  if (route === 'draft' && method === 'PUT') {
    const parsed = await readBounded(request, parseJson);
    if (parsed.error) return fail(parsed.error, parsed.error === 'too_large' ? 413 : parsed.error === 'request_timeout' ? 408 : 400);
    const body = parsed.body;
    if (!plain(body) || Object.keys(body).sort().join(',') !== 'authoringMetadata,document,operationId' || !isUuidV7(body.operationId) || !plain(body.document) || !plain(body.authoringMetadata)) return fail('bad_request', 400);
    if (typeof validateDraft !== 'function') return fail('unavailable', 503);
    const validated = validateDraft(body.document, body.authoringMetadata, { mode: 'preserve' });
    if (!validated?.ok) return json({ error: 'invalid_draft', issues: Array.isArray(validated?.errors) ? validated.errors.slice(0, 200) : [] }, 422);
    let sourceHashesMatch = false;
    try {
      if (typeof hashSources === 'function') sourceHashesMatch = await hashSources(body.authoringMetadata);
      else {
        const sources = body.authoringMetadata.sources ?? [];
        sourceHashesMatch = Array.isArray(sources) && await Promise.all(sources.map(async source => {
          if (typeof source?.text !== 'string' || typeof source.sha256 !== 'string') return false;
          const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source.text)));
          const hex = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
          return source.sha256 === hex;
        })).then(results => results.every(Boolean));
      }
    } catch { /* fail closed */ }
    if (!sourceHashesMatch) return fail('source_digest_mismatch', 422);
    const saved = await rpcClient.call('builder_save_draft', { ...args, p_operation_id: body.operationId,
      p_document: body.document, p_authoring_metadata: body.authoringMetadata });
    const found = oneRow('builder_save_draft', saved, onAlert);
    if (found.response) return found.response;
    const row = found.row;
    if (row.operation_id !== body.operationId || !revision(row.revision) || !/^\\x[0-9a-f]{64}$/i.test(row.intent_digest) || !['saved', 'noop'].includes(row.status)) return fail('unavailable', 503);
    return json({ operationId: row.operation_id, revision: row.revision, intentDigest: row.intent_digest, status: row.status });
  }

  if (route === 'checkpoints' && method === 'GET') {
    const result = await rpcClient.call('builder_list_checkpoints', args);
    const failed = responseForRpc('builder_list_checkpoints', result, onAlert);
    if (failed) return failed;
    if (!Array.isArray(result.data) || result.data.length > 3 || result.data.some(row => !isUuidV7(row?.id) || typeof row.name !== 'string' || !revision(row.revision) || ![1, 2, 3].includes(row.schema_version) || typeof row.created_at !== 'string')) return fail('unavailable', 503);
    return json({ checkpoints: result.data.map(row => ({ id: row.id, name: row.name, revision: row.revision, schemaVersion: row.schema_version, createdAt: row.created_at })) });
  }

  if (route === 'checkpoints' && !checkpointId && method === 'POST') {
    const parsed = await readBounded(request, parseJson);
    if (parsed.error) return fail(parsed.error, parsed.error === 'too_large' ? 413 : parsed.error === 'request_timeout' ? 408 : 400);
    if (!plain(parsed.body) || Object.keys(parsed.body).sort().join(',') !== 'expectedRevision,name' || !revision(parsed.body.expectedRevision) || parsed.body.expectedRevision < 1 || typeof parsed.body.name !== 'string' || parsed.body.name.length < 1 || parsed.body.name.length > 60 || parsed.body.name.trim() !== parsed.body.name || /[\u0000-\u001f\u007f]/.test(parsed.body.name)) return fail('bad_request', 400);
    const result = await rpcClient.call('builder_create_checkpoint', { ...args, p_name: parsed.body.name, p_expected_revision: parsed.body.expectedRevision });
    // 23514 here is only ever checkpoint_limit (three per case): name it, so the Builder can say so (D12).
    if (!result?.ok && result?.kind === 'bad_request' && result?.code === '23514') return fail('checkpoint_limit', 409);
    const found = oneRow('builder_create_checkpoint', result, onAlert);
    if (found.response) return found.response;
    const row = found.row;
    if (!isUuidV7(row.id) || !revision(row.revision) || typeof row.name !== 'string' || !Number.isFinite(Date.parse(row.created_at))) return fail('unavailable', 503);
    return json({ id: row.id, name: row.name, revision: row.revision, createdAt: row.created_at }, 201);
  }

  if (route === 'checkpoints' && checkpointId && !restore && method === 'DELETE') {
    const result = await rpcClient.call('builder_delete_checkpoint', { ...args, p_checkpoint_id: checkpointId });
    const found = oneRow('builder_delete_checkpoint', result, onAlert);
    if (found.response) return found.response;
    return found.row.deleted === true ? json({ id: checkpointId, deleted: true }) : fail('unavailable', 503);
  }

  if (route === 'checkpoints' && checkpointId && restore && method === 'POST') {
    const parsed = await readBounded(request, parseJson);
    if (parsed.error) return fail(parsed.error, parsed.error === 'too_large' ? 413 : parsed.error === 'request_timeout' ? 408 : 400);
    if (!plain(parsed.body) || Object.keys(parsed.body).length !== 1 || !isUuidV7(parsed.body.operationId)) return fail('bad_request', 400);
    const result = await rpcClient.call('builder_restore_checkpoint', { ...args, p_checkpoint_id: checkpointId, p_operation_id: parsed.body.operationId });
    const found = oneRow('builder_restore_checkpoint', result, onAlert);
    if (found.response) return found.response;
    const row = found.row;
    if (row.operation_id !== parsed.body.operationId || !revision(row.revision) || !/^\\x[0-9a-f]{64}$/i.test(row.intent_digest) || row.status !== 'restored') return fail('unavailable', 503);
    return json({ operationId: row.operation_id, revision: row.revision, intentDigest: row.intent_digest, status: row.status });
  }
  return fail('method_not_allowed', 405);
}
