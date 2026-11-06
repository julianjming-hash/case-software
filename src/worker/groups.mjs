// Card 30 (CASE-168 (3), docs/PERMISSIONS.md P-12, P-18 to P-20): the group routes. The workspace is in the
// path and is authorized through the one core before any group RPC; every child id (group, case, move target)
// is bound to that workspace again in SQL (invariant 6). The user id is the verified JWT subject; the admin flag
// comes only from the core (adminArgs). An admin archive (P-19 `step`) needs this sign-in session's admin
// elevation (R-a); its id goes to SQL, which checks it against the recorded issue. Owners archive with the typed
// name only. Groups never grant access: nothing here feeds an authorization decision.
import { isUuidV7 } from '../shared/ids.mjs';
import { ACTIONS } from '../shared/permissions.mjs';
import { cleanGroupName, isTint, validCatalogueGroupRow, GROUPS_MAX, cleanGroupDescription, validGroupRow } from '../shared/groups.mjs';

import { authorize, adminArgs } from './authorize.mjs';
import { rpcFailure } from './published-rooms.mjs';
import { verifyElevation } from './admin/stepup.mjs';

const unavailable = { ok: false, error: 'unavailable', status: 503 };
const bad = { ok: false, error: 'bad_request', status: 400 };
const revision = value => Number.isSafeInteger(value) && value >= 0;
const keys = (body, allowed) => body && typeof body === 'object' && !Array.isArray(body) &&
  Object.keys(body).every(key => allowed.includes(key)) && allowed.every(key => Object.hasOwn(body, key));

/** The group routes this module owns: { kind, workspaceId, id } or null. */
export function matchGroupRoute(path, method) {
  let m = /^\/api\/v1\/workspaces\/([0-9a-f-]{36})\/groups$/.exec(path);
  if (m && (method === 'GET' || method === 'POST')) return { kind: method === 'GET' ? 'list' : 'create', workspaceId: m[1] };
  m = /^\/api\/v1\/workspaces\/([0-9a-f-]{36})\/groups\/([0-9a-f-]{36})$/.exec(path);
  if (m && method === 'PUT') return { kind: 'edit', workspaceId: m[1], id: m[2] };
  m = /^\/api\/v1\/workspaces\/([0-9a-f-]{36})\/groups\/([0-9a-f-]{36})\/archive$/.exec(path);
  if (m && method === 'POST') return { kind: 'archive', workspaceId: m[1], id: m[2] };
  m = /^\/api\/v1\/workspaces\/([0-9a-f-]{36})\/cases\/([0-9a-f-]{36})\/group$/.exec(path);
  if (m && method === 'PUT') return { kind: 'assign', workspaceId: m[1], id: m[2] };
  return null;
}

/** Validate a write body before any RPC. Resolves the cleaned fields, or null. */
function fields(kind, body) {
  if (kind === 'create' || kind === 'edit') {
    if (!keys(body, kind === 'create' ? ['name', 'description', 'tint'] : ['expectedRevision', 'name', 'description', 'tint'])) return null;
    const name = cleanGroupName(body.name), description = cleanGroupDescription(body.description);
    if (!name || description === undefined || !isTint(body.tint) || (kind === 'edit' && !revision(body.expectedRevision))) return null;
    return { name, description, tint: body.tint, expectedRevision: body.expectedRevision };
  }
  if (kind === 'archive') {
    if (!keys(body, ['expectedRevision', 'confirmName', 'moveTo']) || !revision(body.expectedRevision) ||
        typeof body.confirmName !== 'string' || body.confirmName.length > 240 ||
        !(body.moveTo === null || isUuidV7(body.moveTo))) return null;
    return { expectedRevision: body.expectedRevision, confirmName: body.confirmName, moveTo: body.moveTo };
  }
  if (!keys(body, ['expectedRevision', 'groupId']) || !revision(body.expectedRevision) ||
      !(body.groupId === null || isUuidV7(body.groupId))) return null;
  return { expectedRevision: body.expectedRevision, groupId: body.groupId };
}

// SQL refusals with a fixed meaning here; anything else is the shared mapping (a 42501 is a 500 alert).
function refused(name, result, onAlert, kind) {
  if (result?.code === '23505') return { ok: false, error: 'name_taken', status: 409 };
  if (result?.code === '40001') return { ok: false, error: 'conflict', status: 409 };
  if (result?.code === 'P0002') return { ok: false, error: 'not_found', status: 404 };
  if (result?.code === '23514') return { ok: false, error: kind === 'archive' ? 'confirm_mismatch' : 'invalid_group', status: 422 };
  return rpcFailure(name, result, onAlert);
}
const one = (result, check) => Array.isArray(result.data) && result.data.length === 1 && check(result.data[0]) ? result.data[0] : null;

/**
 * Handle one group route for a verified user. `readBody` reads the bounded JSON body (the facilitator API's).
 * Resolves `{ ok, status, body }` or `{ ok: false, error, status }`.
 */
export async function handleGroupRoute(client, { route, actor, user, request, env, readBody, onAlert }) {
  const { kind, workspaceId, id } = route;
  if (!isUuidV7(workspaceId) || (id !== undefined && !isUuidV7(id))) return bad;
  let input = null;
  if (kind !== 'list') {
    const { body, error } = await readBody();
    if (error) return { ok: false, error, status: error === 'too_large' ? 413 : error === 'request_timeout' ? 408 : 400 };
    input = fields(kind, body);
    if (!input) return bad;
  }
  const action = kind === 'list' ? ACTIONS.readSettings : kind === 'archive' ? ACTIONS.archiveGroup
    : kind === 'assign' ? ACTIONS.assignGroup : ACTIONS.editGroup;
  const member = await authorize(client, actor, workspaceId, action, onAlert);
  if (!member.ok) return member;
  const admin = adminArgs(actor);

  if (kind === 'list') {
    const listed = await client.call('list_groups', { p_user_id: actor.userId, p_workspace_id: workspaceId, ...admin });
    if (!listed?.ok) return rpcFailure('list_groups', listed, onAlert);
    if (!Array.isArray(listed.data) || listed.data.length > GROUPS_MAX) return unavailable;
    const groups = listed.data.map(row => ({ id: row?.id, name: row?.name, description: row?.description ?? null, tint: row?.tint,
      revision: row?.revision, caseCount: row?.case_count }));
    if (listed.data.some(row => Object.keys(row ?? {}).length !== 6) || !groups.every(validGroupRow)) return unavailable;
    return { ok: true, status: 200, body: { groups } };
  }
  if (kind === 'create' || kind === 'edit') {
    const name = kind === 'create' ? 'create_group' : 'edit_group';
    const result = await client.call(name, { p_user_id: actor.userId, p_workspace_id: workspaceId,
      ...(kind === 'edit' ? { p_group_id: id, p_expected_revision: input.expectedRevision } : {}),
      p_name: input.name, p_description: input.description, p_tint: input.tint, ...admin });
    if (!result?.ok) return refused(name, result, onAlert, kind);
    const row = one(result, r => isUuidV7(r?.id) && revision(r.revision) && (kind === 'create' || r.id === id));
    return row ? { ok: true, status: kind === 'create' ? 201 : 200, body: { group: { id: row.id, revision: row.revision } } } : unavailable;
  }
  if (kind === 'archive') {
    // P-19: an admin's archive needs this session's elevation; an owner's never forwards one.
    let elevationId = null;
    if (actor.admin) {
      const elevation = await verifyElevation(request.headers.get('X-Admin-Elevation'), actor.email, user.sessionId, env?.STEPUP_SECRET);
      if (!elevation) return { ok: false, error: 'forbidden', status: 403 };
      elevationId = elevation.jti;
    }
    const result = await client.call('archive_group', { p_user_id: actor.userId, p_workspace_id: workspaceId, p_group_id: id,
      p_expected_revision: input.expectedRevision, p_confirm_name: input.confirmName, p_move_to: input.moveTo, ...admin,
      p_elevation_id: elevationId });
    if (!result?.ok) return refused('archive_group', result, onAlert, kind);
    const row = one(result, r => r?.id === id && revision(r.revision) && Number.isSafeInteger(r.moved) && r.moved >= 0);
    return row ? { ok: true, status: 200, body: { group: { id: row.id, revision: row.revision }, moved: row.moved } } : unavailable;
  }
  const result = await client.call('assign_case_group', { p_user_id: actor.userId, p_workspace_id: workspaceId, p_case_id: id,
    p_expected_revision: input.expectedRevision, p_group_id: input.groupId, ...admin });
  if (!result?.ok) return refused('assign_case_group', result, onAlert, kind);
  const row = one(result, r => r?.case_id === id && r.group_id === input.groupId && revision(r.group_revision));
  return row ? { ok: true, status: 200, body: { case: { id: row.case_id, groupId: row.group_id, groupRevision: row.group_revision } } } : unavailable;
}

/** The library's group filter and board columns (P-11): live groups with catalogue counts, then Ungrouped. */
export async function readCatalogueGroups(client, actor, workspaceId, onAlert) {
  const member = await authorize(client, actor, workspaceId, ACTIONS.browseLibrary, onAlert);
  if (!member.ok) return member;
  const listed = await client.call('list_case_catalogue_groups', { p_user_id: actor.userId, p_workspace_id: workspaceId, ...adminArgs(actor) });
  if (!listed?.ok) return rpcFailure('list_case_catalogue_groups', listed, onAlert);
  if (!Array.isArray(listed.data) || listed.data.length > 4 * GROUPS_MAX || listed.data.some(row => Object.keys(row ?? {}).length !== 4)) return unavailable;
  const groups = listed.data.map(row => ({ id: row.group_id, name: row.name, tint: row.tint, count: row.case_count }));
  if (!groups.every(validCatalogueGroupRow) || groups.filter(row => row.id === null).length !== 1 || groups.at(-1).id !== null) return unavailable;
  // Over the cap (never expected; creates are serialised per workspace) the filter keeps the first 100 named
  // groups and Ungrouped rather than failing the library.
  return { ok: true, groups: groups.length > GROUPS_MAX + 1 ? [...groups.slice(0, GROUPS_MAX), groups.at(-1)] : groups };
}

/** Case detail's group (P-12), read after the catalogue read has bound the case to the caller's workspace. */
export async function readCaseGroup(client, actor, caseId, workspaceId, onAlert) {
  const read = await client.call('get_case_group', { p_user_id: actor.userId, p_case_id: caseId, ...adminArgs(actor) });
  if (!read?.ok) return rpcFailure('get_case_group', read, onAlert);
  const row = Array.isArray(read.data) && read.data.length === 1 ? read.data[0] : null;
  if (!row || row.case_id !== caseId || row.workspace_id !== workspaceId || !revision(row.group_revision) ||
      !(row.group_id === null ? row.group_name === null && row.tint === 'neutral'
        : isUuidV7(row.group_id) && typeof row.group_name === 'string' && isTint(row.tint))) return unavailable;
  return { ok: true, group: { id: row.group_id, name: row.group_name, tint: row.tint, revision: row.group_revision } };
}
