import { matchWorkspaceManagement, handleWorkspaceManagement } from './workspace-management.mjs';
// Facilitator-only authoring and picker routes. Every user id comes from a verified JWT.
import { bearer, verifyFacilitatorJwt, AuthUnavailableError } from './auth.mjs';
import { isUuidV7 } from '../shared/ids.mjs';
import { cleanText } from '../shared/room-machine.mjs';
import { validateCaseDocument } from '../shared/case-document.mjs';
import { sanitizeArt } from '../shared/art-descriptor.mjs';
import { readMe, readIntactVersion, preCheckVersionCase, rpcFailure } from './published-rooms.mjs';
import { actorFor, adminArgs, authorize, allows, onCase } from './authorize.mjs';
import { ACTIONS } from '../shared/permissions.mjs';
import { rpcClient } from './rpc.mjs';
import { accountActive } from './admin/account-active.mjs';
import { acceptInvitations } from './invitations.mjs';
import { pilotPinFromEnv } from './pilot-pin.mjs';
import { refusedRoomWorkspaces } from './room-workspace-refusal.mjs';
import { parseCatalogueQuery } from '../shared/catalogue.mjs';
import { readCatalogue, readCatalogueAudiences, readCatalogueCase } from './catalogue.mjs';
import { matchGroupRoute, handleGroupRoute, readCatalogueGroups } from './groups.mjs';
import { BODY_READ_DEADLINE_MS } from './request-deadline.mjs';
import { parseLabelFields } from '../shared/facilitator-label.mjs';

const META_BYTES = 16 * 1024;
const DRAFT_BYTES = 1_048_576;
const BODY_TIMEOUT_MS = BODY_READ_DEADLINE_MS;
const response = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json; charset=utf-8' },
});
const fail = (error, status) => response({ error }, status);
const positive = value => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value));
const revision = value => Number.isSafeInteger(value) && value >= 0;

function cancelReader(reader) {
  try { Promise.resolve(reader.cancel()).catch(() => {}); }
  catch { /* A rejected cancellation cannot hold up the response. */ }
}

async function readBody(request, maxBytes, timeoutMs) {
  if (Number(request.headers.get('content-length') || 0) > maxBytes) return { error: 'too_large' };
  if (!request.body) return { error: 'not_json' };
  const reader = request.body.getReader(), chunks = [];
  let bytes = 0;
  let timer;
  const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next === null) { cancelReader(reader); return { error: 'request_timeout' }; }
      const { done, value } = next;
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) { cancelReader(reader); return { error: 'too_large' }; }
      chunks.push(value);
    }
  } catch {
    cancelReader(reader);
    return { error: 'not_json' };
  } finally {
    clearTimeout(timer);
  }
  const merged = new Uint8Array(bytes);
  let at = 0;
  for (const chunk of chunks) { merged.set(chunk, at); at += chunk.byteLength; }
  try { return { body: JSON.parse(new TextDecoder().decode(merged)) }; }
  catch { return { error: 'not_json' }; }
}

// Case-addressed writes: the workspace comes from the case (never the caller), and the role the SQL core
// resolved there is checked against the matrix again here.
async function authorPreflight(client, actor, caseId, action, onAlert) {
  const access = await client.call('get_case_authoring_access', { p_case_id: caseId, p_user_id: actor.userId, ...adminArgs(actor) });
  if (!access?.ok) return rpcFailure('get_case_authoring_access', access, onAlert);
  if (!Array.isArray(access.data) || access.data.length > 1) return { ok: false, error: 'unavailable', status: 503 };
  if (!access.data.length) return { ok: false, error: 'forbidden', status: 403 };
  const [row] = access.data;
  if (row?.case_id !== caseId || !isUuidV7(row.workspace_id) || (row.role === 'admin') !== actor.admin)
    return { ok: false, error: 'unavailable', status: 503 };
  if (!allows(action, { admin: actor.admin, role: row.role })) return { ok: false, error: 'forbidden', status: 403 };
  return { ok: true, workspaceId: row.workspace_id, role: row.role };
}

/** Return null for routes owned elsewhere; otherwise a safe Response. */
export async function handleFacilitatorApi(request, {
  rpc, env, onAlert, verifyUser = verifyFacilitatorJwt, bodyTimeoutMs = BODY_TIMEOUT_MS,
}) {
  const readTimeoutMs = Number.isSafeInteger(bodyTimeoutMs) && bodyTimeoutMs > 0 && bodyTimeoutMs <= BODY_TIMEOUT_MS
    ? bodyTimeoutMs : BODY_TIMEOUT_MS;
  const url = new URL(request.url), path = url.pathname.replace(/\/+$/, '');
  const method = request.method;
  const packMatch = /^\/api\/v1\/workspaces\/([0-9a-f-]{36})\/versions\/([0-9a-f-]{36})\/pack$/.exec(path);
  const versionsMatch = /^\/api\/v1\/workspaces\/([0-9a-f-]{36})\/versions$/.exec(path);
  const draftMatch = /^\/api\/v1\/cases\/([0-9a-f-]{36})\/draft$/.exec(path);
  const publishMatch = /^\/api\/v1\/cases\/([0-9a-f-]{36})\/publish$/.exec(path);
  const catalogueMatch = /^\/api\/v1\/workspaces\/([0-9a-f-]{36})\/catalogue(\/audiences|\/groups)?$/.exec(path);
  const groupRoute = matchGroupRoute(path, method);
  const workspaceManagement=matchWorkspaceManagement(path,method);
  const caseMatch=/^\/api\/v1\/cases\/([0-9a-f-]{36})$/.exec(path);
  const caseVersionMatch = /^\/api\/v1\/cases\/([0-9a-f-]{36})\/versions\/([^/]+)$/.exec(path);
  if (!(path === '/api/v1/me' && method === 'GET') &&
      !(path === '/api/v1/me/profile' && method === 'PUT') &&
      !(packMatch && method === 'GET') &&
      !(versionsMatch && method === 'GET') &&
      !(catalogueMatch && method === 'GET') &&
      !(caseMatch && method === 'GET') &&
      !(caseVersionMatch && method === 'GET') &&
      !(path === '/api/v1/workspaces' && method === 'POST') &&
      !(path === '/api/v1/cases' && method === 'POST') &&
      !(draftMatch && method === 'PUT') &&
      !(publishMatch && method === 'POST') && !groupRoute && !workspaceManagement) return null;
  const client = rpc ?? rpcClient(env);

  let user;
  try { user = await verifyUser(bearer(request), env); }
  catch (error) { if (error instanceof AuthUnavailableError) return fail('auth_unavailable', 503); throw error; }
  if (!user) return fail('unauthorised', 401);
  const refused=await accountActive(client,user.userId);
  if (refused) return fail(refused.error,refused.status);
  // The only admin flag this module sees (card 35): computed from the verified JWT and ADMIN_EMAILS.
  const actor = actorFor(user, env);
  const userId = actor.userId;

  if (packMatch) {
    const [,workspaceId,versionId]=packMatch;
    if(!isUuidV7(workspaceId)||!isUuidV7(versionId)||[...url.searchParams.keys()].length)return fail('bad_request',400);
    if(refusedRoomWorkspaces(env).has(workspaceId))return fail('forbidden',403);
    // As a start (CASE-336): a membership or any grant here reaches the version read; then its own case decides.
    const member=await authorize(client,actor,{workspaceId,anyCase:true},ACTIONS.startRoom,onAlert);
    if(!member.ok)return fail(member.error,member.status);
    const held=await preCheckVersionCase(client,actor,member,versionId,ACTIONS.startRoom,onAlert);
    if(!held.ok)return fail(held.error,held.status);
    const version=await readIntactVersion(client,actor,workspaceId,versionId,onAlert);
    if(!version.ok)return fail(version.error,version.status);
    const onItsCase=onCase(member,version.caseId,ACTIONS.startRoom);
    if(!onItsCase.ok)return fail(onItsCase.error,onItsCase.status);
    return new Response(JSON.stringify({versionId,workspaceId,document:version.document}),{
      headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer'}});
  }

  if (path === '/api/v1/me') {
    const rawLimit = url.searchParams.get('limit');
    const limit = rawLimit === null ? 100 : positive(rawLimit) ? Number(rawLimit) : NaN;
    const after = url.searchParams.get('after'), workspaceId = url.searchParams.get('workspaceId');
    if (!Number.isInteger(limit) || limit > 100 || (after !== null && !isUuidV7(after)) ||
        (workspaceId !== null && !isUuidV7(workspaceId))) return fail('bad_request', 400);
    // CASE-339: pending invitations to the verified address become access first (VOLATILE, separate from the STABLE get_me),
    // on the first page only, so the person sees the place at once; `joined` says what is new for the first-sign-in landing.
    const joined = after === null ? await acceptInvitations(client, user) : [];
    const result = await readMe(client, userId, { limit, after, workspaceId, admin: adminArgs(actor) }, onAlert);
    // Administration is a Worker allowlist of verified emails (gate.mjs); being signed in is not admin.
    // An admin's memberships list every workspace with role 'admin', for display only (invariant 9).
    // Workspaces that may not start rooms here (CASE-160, the Load testing workspace) are flagged so the
    // library picker labels them as operators' and never mixes them in (card 29).
    const refused = refusedRoomWorkspaces(env);
    const memberships = result.ok ? result.memberships.map(row => refused.has(row?.workspace_id) ? { ...row, rooms_refused: true } : row) : null;
    // The caller's live case grants (CASE-336): the client offers the Builder for an edit grant and the shared cases.
    return result.ok ? response({ profile: result.profile, memberships, grants: result.grants, nextAfter: result.nextAfter, joined,
      account: { email: typeof user.email === 'string' ? user.email : null, administration: actor.admin } })
      : fail(result.error, result.status);
  }

  // P-40: the caller's own facilitator Name & role (the first-sign-in step and Account). The JWT subject is the only
  // user id; an account with no workspace, no case grant and no admin reach has no facilitator record to name.
  if (path === '/api/v1/me/profile') {
    if ([...url.searchParams.keys()].length) return fail('bad_request', 400);
    const { body, error } = await readBody(request, META_BYTES, readTimeoutMs);
    if (error) return fail(error, error === 'too_large' ? 413 : error === 'request_timeout' ? 408 : 400);
    const fields = parseLabelFields(body);
    if (!fields.ok || Object.keys(body).some(key => !['name', 'role'].includes(key))) return fail('bad_request', 400);
    const me = await readMe(client, userId, { limit: 1, admin: adminArgs(actor) }, onAlert);
    if (!me.ok) return fail(me.error, me.status);
    // A membership or a live case grant (CASE-336): a case-only runner names themselves at first sign-in too.
    if (!actor.admin && !me.memberships.length && !me.grants.length) return fail('forbidden', 403);
    const saved = await client.call('set_own_facilitator_label', { p_user_id: userId, p_name: fields.name, p_role: fields.role });
    if (!saved?.ok) { const mapped = rpcFailure('set_own_facilitator_label', saved, onAlert); return fail(mapped.error, mapped.status); }
    const [row] = Array.isArray(saved.data) ? saved.data : [];
    if (saved.data?.length !== 1 || row?.display_name !== fields.name || row.facilitator_role !== fields.role || typeof row.label_confirmed_at !== 'string')
      return fail('unavailable', 503);
    return response({ profile: { userId, displayName: row.display_name, role: row.facilitator_role, labelConfirmed: true } });
  }

  if (catalogueMatch) {
    const workspaceId = catalogueMatch[1];
    if (!isUuidV7(workspaceId)) return fail('bad_request', 400);
    if (catalogueMatch[2]) {
      if ([...url.searchParams.keys()].length) return fail('bad_request', 400);
      if (catalogueMatch[2] === '/groups') {
        const result = await readCatalogueGroups(client, actor, workspaceId, onAlert);
        return result.ok ? response({ groups: result.groups }) : fail(result.error, result.status);
      }
      const result = await readCatalogueAudiences(client, actor, workspaceId, onAlert);
      return result.ok ? response({ audiences: result.audiences }) : fail(result.error, result.status);
    }
    const query = parseCatalogueQuery(url.searchParams);
    if (!query) return fail('bad_request', 400);
    const result = await readCatalogue(client, actor, workspaceId, query, onAlert);
    return result.ok ? response({ cases: result.cases, total: result.total, offset: query.offset,
      limit: query.limit, pilotPin: pilotPinFromEnv(env) }) : fail(result.error, result.status);
  }

  if(caseMatch){
    const caseId=caseMatch[1];if(!isUuidV7(caseId)||url.search)return fail('bad_request',400);
    const result=await client.call('resolve_catalogue_case',{p_user_id:userId,p_case_id:caseId,...adminArgs(actor)});
    if(!result?.ok){const error=rpcFailure('resolve_catalogue_case',result,onAlert);return fail(error.error,error.status);}
    if(!Array.isArray(result.data)||result.data.length>1)return fail('unavailable',503);const row=result.data[0];if(!row)return fail('not_found',404);
    if(Object.keys(row).sort().join()!=='role,version_no,workspace_id'||!isUuidV7(row.workspace_id)||!(actor.admin?row.role==='admin':['owner','author','facilitator'].includes(row.role))||!(row.version_no===null||Number.isSafeInteger(row.version_no)&&row.version_no>0))return fail('unavailable',503);
    return new Response(JSON.stringify({caseId,workspaceId:row.workspace_id,versionNo:row.version_no,editable:['owner','author','admin'].includes(row.role)}),{headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer'}});
  }

  if (caseVersionMatch) {
    const caseId = caseVersionMatch[1], rawVersion = caseVersionMatch[2];
    if (!isUuidV7(caseId) || !positive(rawVersion) || Number(rawVersion) > 1_000_000 ||
        [...url.searchParams.keys()].length) return fail('bad_request', 400);
    const result = await readCatalogueCase(client, actor, caseId, Number(rawVersion), onAlert);
    return result.ok ? response({ case: result.case, pilotPin: pilotPinFromEnv(env) }) : fail(result.error, result.status);
  }

  if(workspaceManagement){
    if([...url.searchParams.keys()].length)return fail('bad_request',400);
    const result=await handleWorkspaceManagement(client,{route:workspaceManagement,actor,readBody:()=>readBody(request,META_BYTES,readTimeoutMs)});
    return result.ok?response(result.body,result.status):fail(result.error,result.status);
  }

  // Card 30: groups (P-12, P-18 to P-20), authorized through the one core in groups.mjs.
  if (groupRoute) {
    const result = await handleGroupRoute(client, { route: groupRoute, actor, user, request, env, onAlert,
      readBody: () => readBody(request, META_BYTES, readTimeoutMs) });
    return result.ok ? response(result.body, result.status) : fail(result.error, result.status);
  }

  if (versionsMatch) {
    const workspaceId = versionsMatch[1], rawLimit = url.searchParams.get('limit');
    const limit = rawLimit === null ? 100 : positive(rawLimit) ? Number(rawLimit) : NaN;
    const after = url.searchParams.get('after');
    if (!isUuidV7(workspaceId) || !Number.isInteger(limit) || limit > 100 ||
        (after !== null && !isUuidV7(after))) return fail('bad_request', 400);
    const member = await authorize(client, actor, workspaceId, ACTIONS.browseLibrary, onAlert);
    if (!member.ok) return fail(member.error, member.status);
    const listed = await client.call('list_published_versions', {
      p_user_id: userId, p_workspace_id: workspaceId, p_limit: limit, p_after: after, ...adminArgs(actor),
    });
    if (!listed?.ok) { const error = rpcFailure('list_published_versions', listed, onAlert); return fail(error.error, error.status); }
    if (!Array.isArray(listed.data) || listed.data.length > limit ||
        listed.data.some(row => !isUuidV7(row?.version_id))) return fail('unavailable', 503);
    // Delivery (CASE-164): each row's art is rebuilt from validated numbers, or null. Nothing else is added.
    const versions = listed.data.map(row => ({ ...row, art: sanitizeArt(row.art) }));
    return response({ versions, pilotPin: pilotPinFromEnv(env),
      nextAfter: listed.data.length === limit ? listed.data.at(-1).version_id : null });
  }

  if (path === '/api/v1/workspaces') {
    // P-01: only admins create workspaces (CASE-168 R3, R10). Refused before the body is read; the RPC
    // refuses again in SQL without the admin flag.
    if (!allows(ACTIONS.createWorkspace, { admin: actor.admin })) return fail('forbidden', 403);
    const { body, error } = await readBody(request, META_BYTES, readTimeoutMs);
    if (error) return fail(error, error === 'too_large' ? 413 : error === 'request_timeout' ? 408 : 400);
    const slug = body?.slug;
    const name = typeof body?.name === 'string' ? cleanText(body.name, 120) : '';
    if (typeof slug !== 'string' || slug.length > 48 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) ||
        typeof body.name !== 'string' || body.name.length > 120 || !name)
      return fail('bad_request', 400);
    const me = await readMe(client, userId, { limit: 1, admin: adminArgs(actor) }, onAlert);
    if (!me.ok) return fail(me.error, me.status);
    const displayName = cleanText(me.profile.displayName || '', 80) || 'Facilitator';
    const profile = await client.call('ensure_profile', { p_user_id: userId, p_display_name: displayName });
    if (!profile?.ok) { const mapped = rpcFailure('ensure_profile', profile, onAlert); return fail(mapped.error, mapped.status); }
    const created = await client.call('bootstrap_workspace', { p_user_id: userId, p_slug: slug, p_name: name, ...adminArgs(actor) });
    if (!created?.ok) { const mapped = rpcFailure('bootstrap_workspace', created, onAlert); return fail(mapped.error, mapped.status); }
    return isUuidV7(created.data) ? response({ workspaceId: created.data }, 201) : fail('unavailable', 503);
  }

  if (path === '/api/v1/cases') {
    const { body, error } = await readBody(request, META_BYTES, readTimeoutMs);
    if (error) return fail(error, error === 'too_large' ? 413 : error === 'request_timeout' ? 408 : 400);
    const workspaceId = body?.workspaceId;
    const title = typeof body?.title === 'string' ? cleanText(body.title, 200) : '';
    if (!isUuidV7(workspaceId) || !title) return fail('bad_request', 400);
    const member = await authorize(client, actor, workspaceId, ACTIONS.createCase, onAlert);
    if (!member.ok) return fail(member.error, member.status);
    const profile = await client.call('ensure_profile', {
      p_user_id: userId, p_display_name: member.profile.displayName || 'Facilitator',
    });
    if (!profile?.ok) { const mapped = rpcFailure('ensure_profile', profile, onAlert); return fail(mapped.error, mapped.status); }
    const created = await client.call('create_case', { p_user_id: userId, p_workspace_id: workspaceId, p_title: title, ...adminArgs(actor) });
    if (!created?.ok) { const mapped = rpcFailure('create_case', created, onAlert); return fail(mapped.error, mapped.status); }
    return isUuidV7(created.data) ? response({ caseId: created.data }, 201) : fail('unavailable', 503);
  }

  if (draftMatch) {
    const caseId = draftMatch[1];
    if (!isUuidV7(caseId)) return fail('bad_request', 400);
    const { body, error } = await readBody(request, DRAFT_BYTES, readTimeoutMs);
    if (error) return fail(error, error === 'too_large' ? 413 : error === 'request_timeout' ? 408 : 400);
    if (!revision(body?.expectedRevision) || body.schemaVersion !== 1) return fail('bad_request', 400);
    if (!validateCaseDocument(body.document).ok) return fail('invalid_case', 422);
    const access = await authorPreflight(client, actor, caseId, ACTIONS.draft, onAlert);
    if (!access.ok) return fail(access.error, access.status);
    const saved = await client.call('save_draft', { p_case_id: caseId, p_expected_revision: body.expectedRevision,
      p_schema_version: body.schemaVersion, p_document: body.document, p_user_id: userId, ...adminArgs(actor) });
    if (!saved?.ok) { const mapped = rpcFailure('save_draft', saved, onAlert); return fail(mapped.error, mapped.status); }
    return revision(saved.data) ? response({ revision: saved.data }) : fail('unavailable', 503);
  }

  const caseId = publishMatch[1];
  if (!isUuidV7(caseId)) return fail('bad_request', 400);
  const access = await authorPreflight(client, actor, caseId, ACTIONS.publish, onAlert);
  if (!access.ok) return fail(access.error, access.status);
  return fail('review_required', 409);
}
