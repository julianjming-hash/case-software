// Card 29 (CASE-166): the facilitator catalogue reads. The verified JWT subject is the only user id;
// membership is preflighted before any catalogue RPC; every served row is rebuilt from the public
// library fields (validCatalogueRow), art from validated numbers (sanitizeArt), or the read is refused.
import { isUuidV7 } from '../shared/ids.mjs';
import { sanitizeArt } from '../shared/art-descriptor.mjs';
import { validCatalogueRow, validVersionList, CATALOGUE_OBJECTIVES_MAX, CATALOGUE_AUDIENCE_MAX, CATALOGUE_UNGROUPED } from '../shared/catalogue.mjs';
import { readCaseGroup } from './groups.mjs';
import { rpcFailure } from './published-rooms.mjs';
import { authorize, adminArgs, holds, allows } from './authorize.mjs';
import { shareFacts } from './case-access.mjs';
import { ACTIONS } from '../shared/permissions.mjs';

const unavailable = { ok: false, error: 'unavailable', status: 503 };
const ROW_KEYS = ['version_id', 'case_id', 'title', 'summary', 'audience', 'setting', 'duration_min', 'version_no',
  'published_at', 'content_sha256', 'art', 'group_id', 'group_name', 'tint'];
// Case detail's version read carries no group (card 29's signature, unchanged); its group is read separately.
const DETAIL_KEYS = ROW_KEYS.filter(key => !['group_id', 'group_name', 'tint'].includes(key));
const publicRow = source => {
  const row = Object.fromEntries(ROW_KEYS.map(key => [key, source?.[key] === undefined ? null : source[key]]));
  row.art = sanitizeArt(row.art);
  return validCatalogueRow(row) ? row : null;
};

export async function readCatalogue(client, actor, workspaceId, query, onAlert) {
  const member = await authorize(client, actor, workspaceId, ACTIONS.browseLibrary, onAlert);
  if (!member.ok) return member;
  const listed = await client.call('list_case_catalogue_current', { p_user_id: actor.userId, p_workspace_id: workspaceId, ...adminArgs(actor),
    p_sort: query.sort, p_descending: query.descending, p_query: query.query || null, p_duration: query.duration,
    p_audience: query.audience, p_limit: query.limit, p_offset: query.offset,
    p_group_id: query.group === CATALOGUE_UNGROUPED ? null : query.group, p_ungrouped: query.group === CATALOGUE_UNGROUPED });
  if (!listed?.ok) return rpcFailure('list_case_catalogue_current', listed, onAlert);
  if (!Array.isArray(listed.data) || listed.data.length > query.limit) return unavailable;
  const extra = row => Object.keys(row ?? {}).some(key => key !== 'total_count' && !ROW_KEYS.includes(key));
  const totals = new Set(listed.data.map(row => row?.total_count));
  const total = listed.data.length ? listed.data[0]?.total_count : null;
  if (listed.data.some(extra) || totals.size > 1 || (listed.data.length && (!Number.isSafeInteger(total) ||
      total < query.offset + listed.data.length))) return unavailable;
  const cases = listed.data.map(publicRow);
  if (cases.some(row => row === null)) return unavailable;
  // An empty page past the first cannot know the total; it never claims zero.
  return { ok: true, cases, total: listed.data.length ? total : query.offset === 0 ? 0 : null };
}

export async function readCatalogueAudiences(client, actor, workspaceId, onAlert) {
  const member = await authorize(client, actor, workspaceId, ACTIONS.browseLibrary, onAlert);
  if (!member.ok) return member;
  const listed = await client.call('list_case_catalogue_audiences', { p_user_id: actor.userId, p_workspace_id: workspaceId, ...adminArgs(actor) });
  if (!listed?.ok) return rpcFailure('list_case_catalogue_audiences', listed, onAlert);
  if (!Array.isArray(listed.data) || listed.data.length > 50 || listed.data.some(row => Object.keys(row ?? {}).length !== 2 ||
      typeof row.audience !== 'string' || !row.audience || row.audience.length > CATALOGUE_AUDIENCE_MAX ||
      !Number.isSafeInteger(row.case_count) || row.case_count < 1)) return unavailable;
  return { ok: true, audiences: listed.data.map(row => ({ audience: row.audience, count: row.case_count })) };
}

export async function readCatalogueCase(client, actor, caseId, versionNo, onAlert) {
  const read = await client.call('get_catalogue_case_history', { p_user_id: actor.userId, p_case_id: caseId, p_version_no: versionNo, ...adminArgs(actor) });
  if (!read?.ok) return rpcFailure('get_catalogue_case_history', read, onAlert);
  if (!Array.isArray(read.data) || read.data.length > 1) return unavailable;
  if (!read.data.length) return { ok: false, error: 'not_found', status: 404 };
  const [source] = read.data;
  const allowed = new Set([...DETAIL_KEYS, 'workspace_id', 'role', 'learning_objectives', 'versions']);
  if (Object.keys(source ?? {}).some(key => !allowed.has(key))) return unavailable;
  const row = publicRow({ ...source, group_id: null, group_name: null, tint: 'neutral' });
  const objectives = source.learning_objectives;
  if (!row || row.case_id !== caseId || row.version_no !== versionNo || !isUuidV7(source.workspace_id) ||
      !(actor.admin ? source.role === 'admin' : ['owner', 'author', 'facilitator'].includes(source.role)) || !Array.isArray(objectives) ||
      objectives.length > CATALOGUE_OBJECTIVES_MAX ||
      objectives.some(item => typeof item !== 'string' || !item || item.length > 300) ||
      !validVersionList(source.versions)) return unavailable;
  // Keep the deployed clients' exact version-row contract; new History metadata is an additive sibling.
  const versions = source.versions.map(({ version_id, version_no, published_at, content_sha256 }) => ({ version_id, version_no, published_at, content_sha256 }));
  const edition_version_ids = source.versions.filter(version => version.edition === true).map(version => version.version_id);
  // What the caller holds on this case: one read (membership, the live grant on this case, the workspace's policies).
  const held = await authorize(client, actor, { workspaceId: source.workspace_id, caseId }, ACTIONS.browseLibrary, onAlert);
  if (!held.ok) return held;
  // Card 30: the case's group (cover tint, and the assignment revision an owner's Change group names). Settings and groups
  // are workspace-only (P-12): a person who holds this case alone (CASE-336) has no group to read, so it is Ungrouped.
  const mayReadGroup = held.role === 'admin' ? allows(ACTIONS.readSettings, { admin: true }) : holds(ACTIONS.readSettings, { role: held.held?.role ?? null, policies: held.policies }) !== null;
  const group = mayReadGroup ? await readCaseGroup(client, actor, caseId, source.workspace_id, onAlert)
    : { ok: true, group: { id: null, name: null, tint: 'neutral', revision: 0 } };
  if (!group.ok) return group;
  const { group_id, group_name, tint, ...fields } = row;
  // Share (P-43): what the caller may offer, so the page shows only what will work. null: no Share on this case for them.
  const sharing = holds(ACTIONS.shareCase, { role: held.held?.role ?? null, grant: held.held?.grant ?? null, policies: held.policies }) !== null || (held.role === 'admin' && allows(ACTIONS.shareCase, { admin: true }));
  return { ok: true, case: { ...fields, workspace_id: source.workspace_id, role: source.role, scope: held.scope, learning_objectives: objectives, versions, edition_version_ids,
    group: group.group, share: sharing ? shareFacts(held) : null } };
}
