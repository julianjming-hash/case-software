import {handleIssuesApi} from '../src/worker/issues-api.mjs';
// tests/permissions-matrix.test.mjs: the permission matrix (docs/PERMISSIONS.md §4) is the source; this
// suite fails when the doc, the shared module (src/shared/permissions.mjs), the generated SQL role table
// or the Worker disagree (card 35, invariant 15).
//
// 1. Parse the marked §4 table; every cell must equal the shared module, and SQL_ACTIONS must be exactly
//    the rows enforced at R. The generated SQL role block and db/tests/permission-matrix.test.sql must be
//    current (that SQL file drives case_app.authorize for every R row and principal under test:db).
// 2. Drive the real Worker code for every W row this card enforces, as each principal: admin (ADMIN_EMAILS,
//    no membership), owner, author, facilitator, a member of another workspace, and a caller with no JWT
//    (participants, projectors and shared computers hold no JWT). The fake database never refuses, so a
//    Worker that forgot a check would answer 2xx and fail here. `step` must fail without and pass with a
//    scoped elevation. Rows a later card ships are reported todo with that card.
// 3. Rows enforced only by the room DO (D) name the test that proves them; the file must still hold it.
// 4. Access = person × place × level (CASE-336) and the four workspace policies (CASE-337), on the shared
//    module: case-grant principals (highest level per case, a grant never reaches another case) and each
//    policy flipping exactly its cells, against hand-computed expectations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MATRIX, PRINCIPALS, LATER, SQL_ACTIONS, POLICIES, POLICY_OF, WORKSPACE_ROLES, CASE_GRANT_LEVELS, rolesFor, caseRolesFor,
  policyRolesFor, policyOn, resolveCell, effectiveLevel, decide } from '../src/shared/permissions.mjs';
import { parseMatrixTable, matrixDrift, matrixShape, sqlRoleBlock, latestSqlBlock, sqlFixture, sqlRolesFor, SQL_PENDING, DOC, SQL_FIXTURE } from '../scripts/gen-permissions.mjs';
import { handleSessionPortfolio } from '../src/worker/session-portfolio.mjs';
import { handleFeedbackResults } from '../src/worker/feedback-results.mjs';
import { handleRoomHistory } from '../src/worker/room-history.mjs';
import { handleFacilitatorApi } from '../src/worker/facilitator-api.mjs';
import { handleBuilderReviewApi } from '../src/worker/builder-review-api.mjs';
import { handleBuilderApi } from '../src/worker/builder-api.mjs';
import { handleAdminRequest } from '../src/worker/admin/handler.mjs';
import { handleInvitationsApi } from '../src/worker/invitations.mjs';
import { startPublishedRoom } from '../src/worker/published-rooms.mjs';
import { actorFor, mayMintConsole } from '../src/worker/authorize.mjs';
import { mintElevation } from '../src/worker/admin/stepup.mjs';
import { uuidv7, newCapabilityToken } from '../src/shared/ids.mjs';
import { miniCase } from './helpers/mini-case.mjs';
import { describeCase, withSolution } from '../src/shared/art-descriptor.mjs';

const doc = readFileSync(DOC, 'utf8');
const rows = parseMatrixTable(doc);

test('[PM-matrix] docs/PERMISSIONS.md §4 parses and equals the shared module, cell by cell', () => {
  assert.equal(rows.length, Object.keys(MATRIX).length);
  assert.deepEqual(matrixDrift(rows), []);
  for (const row of rows) for (const p of PRINCIPALS) assert.equal(MATRIX[row.id][p], row.cells[p], `${row.id} ${p}`);
  // Later-card rows are exactly the NEW rows owned by another card.
  const later = Object.fromEntries(rows.filter(row => row.laterCards.length && !row.laterCards.includes(35))
    .map(row => [row.id, row.laterCards.every(Number.isInteger) ? Math.min(...row.laterCards) : row.laterCards[0]]));
  assert.deepEqual(later, { ...LATER });
});

test('[PM-matrix] a changed cell, a duplicate or a missing id in the doc is caught', () => {
  const lines = doc.split('\n');
  const at = lines.findIndex(line => line.startsWith('| P-13 |'));
  const flipped = [...lines]; flipped[at] = flipped[at].replace('| yes | yes | yes | no |', '| yes | yes | yes | yes |');
  assert.notEqual(flipped[at], lines[at]);
  assert.match(matrixDrift(parseMatrixTable(flipped.join('\n'))).join('\n'), /P-13 facilitator: doc says yes, code says no/);
  const duplicate = [...lines]; duplicate.splice(at, 0, lines[at]);
  assert.throws(() => parseMatrixTable(duplicate.join('\n')), /duplicate permission id/);
  const missing = [...lines]; missing.splice(at, 1);
  assert.throws(() => parseMatrixTable(missing.join('\n')), /missing or out-of-order id/);
  const token = [...lines]; token[at] = token[at].replace('| yes | yes | yes | no |', '| yes | yes | maybe | no |');
  assert.throws(() => parseMatrixTable(token.join('\n')), /unknown cell maybe/);
});

test('[PM-matrix] the SQL role table and the generated SQL matrix test are current', () => {
  const latest = latestSqlBlock();
  assert.ok(latest, 'a migration carries the generated block');
  assert.equal(latest.block, sqlRoleBlock(), `${latest.file} is stale`);
  assert.equal(readFileSync(SQL_FIXTURE, 'utf8'), sqlFixture());
  assert.deepEqual(SQL_ACTIONS, rows.filter(row => row.enforced.includes('R')).map(row => row.id));
});

test('[PM-matrix] the SQL role table lags the matrix only at the listed SQL_PENDING cells, each on a GAP row', () => {
  const lag = SQL_ACTIONS.flatMap(id => rolesFor(id).filter(role => !sqlRolesFor(id).includes(role)).map(role => `${id} ${role}`));
  assert.deepEqual(lag, Object.entries(SQL_PENDING).flatMap(([id, cells]) => Object.keys(cells).map(role => `${id} ${role}`)));
  for (const id of Object.keys(SQL_PENDING)) assert.equal(rows.find(row => row.id === id).status, 'GAP', id);
});
for (const [id, cells] of Object.entries(SQL_PENDING)) for (const [role, step] of Object.entries(cells))
  test.todo(`[PM-matrix] ${id} as ${role} in SQL (case_app.authorize): step ${step}`);

// ─── the Worker, as each principal ──────────────────────────────────────────────────────────────────
const WORKSPACE = uuidv7(), OTHER = uuidv7(), CASE = uuidv7(), VERSION = uuidv7(), CANDIDATE = uuidv7(), LEGACY_ROOM = uuidv7(), DEV_ROOM = uuidv7(), GROUP = uuidv7(), INVITATION = uuidv7();
const ADMIN_EMAIL = 'pm-admin@example.org', SECRET = newCapabilityToken();
const PEOPLE = { admin: uuidv7(), owner: uuidv7(), author: uuidv7(), facilitator: uuidv7(), outsider: uuidv7(),
  caseAuthor: uuidv7(), caseFacilitator: uuidv7() };
const EMAILS = { admin: ADMIN_EMAIL, owner: 'pm-owner@example.org', author: 'pm-author@example.org',
  facilitator: 'pm-facilitator@example.org', outsider: 'pm-outsider@example.org',
  caseAuthor: 'pm-case-author@example.org', caseFacilitator: 'pm-case-runner@example.org' };
const ROLE = { [PEOPLE.owner]: 'owner', [PEOPLE.author]: 'author', [PEOPLE.facilitator]: 'facilitator' };
// Step A3: case-grant principals hold no membership, only a live grant on CASE (CASE-336).
const GRANT = { [PEOPLE.caseAuthor]: 'edit', [PEOPLE.caseFacilitator]: 'run' };
// The workspace's policies the fake database answers (CASE-337); a test sets it, then restores the defaults.
let POLICY_STATE = POLICIES;
const env = { ADMIN_EMAILS: ADMIN_EMAIL, STEPUP_SECRET: SECRET, CASE_PUBLIC_ORIGIN: 'https://case.test' };
const draft = miniCase().doc, art = withSolution(describeCase(draft), { attempt: 1, summarised: false });

/** A database that answers every call and never refuses: only the Worker can refuse here. */
function permissiveRpc() {
  const calls = [];
  const call = async (name, args) => {
    calls.push({ name, args });
    const member = ROLE[args.p_user_id];
    switch (name) {
      case 'admin_change_membership': return { ok:true,data:{membership_revision:1,changed:true} };
      case 'read_session_portfolio': return {ok:true,data:{session:{id:LEGACY_ROOM,workspaceId:WORKSPACE,caseId:CASE,versionId:VERSION,versionNo:1,digest:'b'.repeat(64),title:'PM',status:'ended',sourceStatus:'published',createdAt:'2026-10-09T00:00:00Z',startedAt:null,endedAt:'2026-10-09T01:00:00Z',expiresAt:'2026-10-10T00:00:00Z',own:true,manifest:null},boundary:'c'.repeat(64),document:draft,items:[],nextPosition:null,eventCount:0,maxSeq:0}};
      // Slice 9 (P-37, P-38, P-39): the feedback reads answer as the database would for an allowed caller.
      case 'session_feedback_summary': return { ok: true, data: { session: { id: LEGACY_ROOM, workspaceId: WORKSPACE, caseId: CASE, versionNo: 1, title: 'PM', date: '2026-10-09', own: true },
        closed: false, responses: { total: 0, joined: 0, qr: 0 }, ratings: Object.fromEntries(['session', 'case', 'app'].map(q => [q, { counts: [0, 0, 0, 0, 0], n: 0 }])), comments: [] } };
      case 'case_feedback_summary': return { ok: true, data: { case: { id: CASE, workspaceId: WORKSPACE, versionNo: 1, title: 'PM' }, rooms: 0,
        responses: { total: 0, joined: 0, qr: 0 }, ratings: { case: { counts: [0, 0, 0, 0, 0], n: 0 } }, comments: [], commentsTotal: 0 } };
      case 'admin_feedback_page': return { ok: true, data: { scope: 'app', next: null, result: { responses: { total: 0, joined: 0, qr: 0 },
        ratings: { app: { counts: [0, 0, 0, 0, 0], n: 0 } }, months: [], comments: [] } } };
      case 'admin_account_active': return { ok: true, data: true };
      case 'get_me': {
        const all = (args.p_admin ? [WORKSPACE, OTHER].map(id => ({ workspace_id: id, slug: 'pm', name: 'PM', role: 'admin' }))
          : member ? [{ workspace_id: WORKSPACE, slug: 'pm', name: 'PM', role: member }]
            : args.p_user_id === PEOPLE.outsider ? [{ workspace_id: OTHER, slug: 'pm-other', name: 'Other', role: 'owner' }] : [])
          .map(row => ({ ...row, policies: POLICY_STATE }));
        const grants = GRANT[args.p_user_id] ? [{ case_id: CASE, workspace_id: WORKSPACE, workspace_name: 'PM', title: 'PM case',
          level: GRANT[args.p_user_id], policies: POLICY_STATE }] : [];
        const here = row => args.p_workspace_id === null || row.workspace_id === args.p_workspace_id;
        return { ok: true, data: [{ user_id: args.p_user_id, display_name: 'PM', next_after: null, admin: args.p_admin === true,
          memberships: all.filter(here), grants: grants.filter(here) }] };
      }
      // Step A3: one read of the caller's access to a case (case_api.get_access); CASE is in WORKSPACE.
      case 'get_access': {
        if (args.p_case_id !== CASE) return { ok: true, data: [] };
        if (args.p_admin) return { ok: true, data: [{ workspace_id: WORKSPACE, case_id: CASE, member_role: null, grant_level: null, role: 'admin', scope: 'workspace', policies: POLICY_STATE }] };
        const held = effectiveLevel({ role: member ?? null, grant: GRANT[args.p_user_id] ?? null });
        return { ok: true, data: held ? [{ workspace_id: WORKSPACE, case_id: CASE, member_role: member ?? null, grant_level: GRANT[args.p_user_id] ?? null,
          ...held, policies: POLICY_STATE }] : [] };
      }
      // The SQL core would refuse a nonmember here too; this fake answers as the database would for a
      // member, so the Worker's own matrix check is what is under test.
      case 'get_case_authoring_access': return { ok: true, data: [{ case_id: args.p_case_id, workspace_id: WORKSPACE,
        role: args.p_admin ? 'admin' : member ?? (GRANT[args.p_user_id] === 'edit' ? 'author' : 'facilitator'), title: 'PM case', source_version_id: null, source_version_no: null }] };
      // P-42: the archive answers as the database would for an allowed caller.
      case 'builder_archive_case': return { ok: true, data: [{ case_id: args.p_case_id, outcome: 'archived' }] };
      case 'list_room_history':
      case 'list_published_versions': return { ok: true, data: [] };
      case 'ensure_profile': return { ok: true, data: null };
      case 'create_case': case 'bootstrap_workspace': return { ok: true, data: uuidv7() };
      case 'save_draft': return { ok: true, data: 2 };
      case 'get_draft': return { ok: true, data: [{ revision: 1, schema_version: 1, document: draft, updated_at: new Date().toISOString() }] };
      case 'publish_draft_with_art': return { ok: true, data: [{ version_id: uuidv7(), version_no: 1, content_sha256: `\\x${'b'.repeat(64)}` }] };
      case 'builder_get_review_candidate': return { ok: true, data: [{ candidate_id: CANDIDATE, revision: 1, schema_version: 1,
        document: draft, authoring_metadata: { metadata_version: 1, sources: [], provenance: [] }, intent_digest: `\\x${'c'.repeat(64)}`,
        content_sha256: `\\x${'b'.repeat(64)}`, status: 'pending', submitted_by: PEOPLE.author, submitted_at: '2026-10-09T00:00:00Z',
        approved_by: null, approved_at: null, approved_intent_digest: null, approved_content_sha256: null, released_version_id: null }] };
      case 'builder_release_candidate': return { ok: true, data: [{ candidate_id: CANDIDATE, version_id: uuidv7(), version_no: 2,
        content_sha256: `\\x${'b'.repeat(64)}`, intent_digest: `\\x${'c'.repeat(64)}`, status: 'released' }] };
      case 'list_admin_audit': case 'list_workspace_audit': return { ok: true, data: [] };
      case 'admin_set_workspace_policies': return { ok: true, data: { ...POLICIES, revision: 1, mediaQuotaBytes: 2000000000 } };
      case 'claim_admin_stepup_attempt': case 'record_admin_elevation': return { ok: true, data: true };
      // A room started before this branch: its DO has no workspace; its session row has (red-team item 3).
      case 'get_session_workspace': return { ok: true, data: args.p_session_id === LEGACY_ROOM ? WORKSPACE : null };
      case 'version_case': return { ok: true, data: args.p_version_id === VERSION ? CASE : null };
      // Step A4 (CASE-339): the invitation RPCs answer as the database would for an allowed caller.
      case 'create_invitation': case 'resend_invitation': return { ok: true, data: { outcome: name === 'create_invitation' ? 'created' : 'resend',
        invitationId: INVITATION, email: args.p_email ?? 'pm-invitee@example.org', level: args.p_level ?? 'run', workspaceId: WORKSPACE, workspaceName: 'PM',
        caseId: args.p_case_id ?? null, caseTitle: args.p_case_id ? 'PM case' : null, inviterName: 'PM', expiresAt: new Date(Date.now() + 86_400_000).toISOString() } };
      case 'revoke_invitation': return { ok: true, data: { outcome: 'revoked' } };
      case 'list_invitations': return { ok: true, data: { invitations: [], nextAfter: null } };
      case 'record_invitation_delivery': return { ok: true, data: { outcome: 'recorded' } };
      // Card 30's group RPCs answer as the database would for an allowed caller.
      case 'list_groups': return { ok: true, data: [] };
      case 'create_group': return { ok: true, data: [{ id: GROUP, revision: 0 }] };
      case 'edit_group': return { ok: true, data: [{ id: GROUP, revision: args.p_expected_revision + 1 }] };
      case 'archive_group': return { ok: true, data: [{ id: GROUP, revision: args.p_expected_revision + 1, moved: 0 }] };
      case 'assign_case_group': return { ok: true, data: [{ case_id: args.p_case_id, group_id: args.p_group_id, group_revision: args.p_expected_revision + 1 }] };
      case 'write_admin_audit': return { ok: true, data: args.p_event_id };
      case 'admin_provision_facilitator': return { ok: true, data: null };
      case 'admin_read_profiles': return { ok: true, data: [{ user_id: args.p_user_ids[0], disabled_at: null, soft_deleted_at: null,
        delete_due_at: null, admin_revision: 0 }] };
      // P-40, P-41: the label writes answer as the database would for an allowed caller.
      case 'set_own_facilitator_label': return { ok: true, data: [{ display_name: args.p_name, facilitator_role: args.p_role, label_confirmed_at: new Date().toISOString() }] };
      case 'admin_set_facilitator_label': return { ok: true, data: [{ user_id: args.p_user_id, admin_revision: args.p_expected_revision + 1,
        display_name: args.p_name, facilitator_role: args.p_role, label_confirmed_at: null }] };
      case 'admin_transition_profile': return { ok: true, data: [{ user_id: args.p_user_id, disabled_at: new Date().toISOString(),
        soft_deleted_at: null, delete_due_at: null, admin_revision: 1 }] };
      default: return { ok: true, data: null };
    }
  };
  return { calls, call };
}

const principals = ['admin', 'owner', 'author', 'facilitator', 'outsider', 'signedOut'];
/**
 * What the matrix says this principal may do for a W row under the default workspace policies (CASE-337);
 * outsider and signed-out hold no role. The Worker reads no policies or case grants until step A3, so policy
 * cells are driven at their defaults only and case-grant principals through the shared module (section 4).
 */
function expected(id, principal) {
  if(id==='P-47'&&principal!=='signedOut')return 'own';
  if (principal === 'signedOut' || principal === 'outsider') return 'no';
  return resolveCell(id, principal, POLICIES);
}
/**
 * Cells the matrix now grants that the Worker does not enforce yet (rows marked GAP in docs/PERMISSIONS.md),
 * with the step that ships them. Every other principal on these rows is still driven. Remove an entry when its
 * step lands; the test fails if an entry outlives its gap (the Worker starts granting the cell).
 */
const WORKER_PENDING = Object.freeze({});
const SESSION = uuidv7();
const userOf = principal => principal === 'signedOut' ? null : { userId: PEOPLE[principal], email: EMAILS[principal], sessionId: SESSION };
const verifyUser = principal => async () => userOf(principal);
const jsonRequest = (path, method = 'GET', body, headers = {}) => new Request(`https://case.test/api/v1${path}`, {
  method, headers: { authorization: 'Bearer pm', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
  body: body === undefined ? undefined : JSON.stringify(body) });

const facilitatorRoute = (path, method, body) => async (principal, { elevated = false, noMemberships = false } = {}) => {
  const rpc = permissiveRpc();
  if (noMemberships) rpc.call = (call => async (name, args) => {
    const result = await call(name, args);
    return name === 'get_me' ? { ...result, data: result.data.map(row => ({ ...row, memberships: [] })) } : result;
  })(rpc.call);
  // A step-up row (P-19) is attempted again with this session's admin elevation (R-a).
  const headers = elevated && principal !== 'signedOut'
    ? { 'x-admin-elevation': (await mintElevation(EMAILS[principal], SESSION, SECRET)).token } : {};
  const response = await handleFacilitatorApi(jsonRequest(path, method, body, headers), { rpc, env, verifyUser: verifyUser(principal) });
  return { status: response.status, json: await response.json().catch(() => null), rpc };
};
const builderReviewRoute = (path, method, body) => async principal => {
  if (principal === 'signedOut') return { status: 401 };
  const rpc = permissiveRpc();
  const response = await handleBuilderReviewApi(jsonRequest(path, method, body), { env, rpc, verifyUser: verifyUser(principal),
    parseJson: text => ({ ok: true, value: JSON.parse(text) }), validateDraft: () => ({ ok: true, errors: [], warnings: [] }), hashSources: async () => true });
  return { status: response.status };
};
const builderRoute = (path, method, body) => async principal => {
  if (principal === 'signedOut') return { status: 401 };
  const response = await handleBuilderApi(jsonRequest(path, method, body), { env, rpc: permissiveRpc(), verifyUser: verifyUser(principal),
    parseJson: text => ({ ok: true, value: JSON.parse(text) }), validateDraft: () => ({ ok: true, errors: [] }), hashSources: async () => true });
  return { status: response.status };
};

// Each W row this card enforces: how to attempt it, and how to tell success from refusal.
async function issueDriver(principal,path,{capability=false,create=false}={}){
 const response=await handleIssuesApi(jsonRequest(path,create?'POST':'GET',create?{operationId:uuidv7(),description:'Permission witness',attachments:[]}:undefined,{origin:env.CASE_PUBLIC_ORIGIN}),{
  env:{...env,...(capability?{INCIDENT_ADMIN_EMAILS:ADMIN_EMAIL}:{})},verifyUser:verifyUser(principal),
  rpc:{call:async name=>({ok:true,data:name==='admin_account_active'?true:{rows:[],cursor:null,asOf:new Date().toISOString()}})}});
 return{status:response.status};
}
const DRIVERS = {
 'P-47':principal=>issueDriver(principal,'/issues',{create:true}),
 'P-48':principal=>issueDriver(principal,'/admin/issues'),
 'P-49':(principal,options)=>issueDriver(principal,'/admin/incidents',options),
  'P-34': async principal => ({status:(await handleSessionPortfolio(jsonRequest('/portfolio/record','POST',{sessionId:LEGACY_ROOM,after:null}),{env,rpc:permissiveRpc(),verifyUser:verifyUser(principal)})).status}),
  'P-37': async principal => ({ status: (await handleFeedbackResults(jsonRequest(`/portfolio/sessions/${LEGACY_ROOM}/feedback`), { env, rpc: permissiveRpc(), verifyUser: verifyUser(principal) })).status }),
  'P-38': async principal => ({ status: (await handleFeedbackResults(jsonRequest(`/cases/${CASE}/versions/1/feedback`), { env, rpc: permissiveRpc(), verifyUser: verifyUser(principal) })).status }),
  'P-39': adminRoute('/admin/feedback', 'POST', { filter: { scope: 'app' }, after: null }),
  'P-04': adminRoute('/admin/memberships/change','POST',{workspaceId:WORKSPACE,email:'target@example.org',role:'author',transferFrom:null,expectedRevision:0,confirmEmail:'target@example.org'}),
  'P-05': adminRoute('/admin/memberships/change','POST',{workspaceId:WORKSPACE,email:'target@example.org',role:null,transferFrom:null,expectedRevision:0,confirmEmail:'target@example.org'}),
  'P-32': async principal => ({ status: (await handleRoomHistory(jsonRequest(`/workspaces/${WORKSPACE}/history`), { env, rpc: permissiveRpc(), verifyUser: verifyUser(principal) })).status }),
  'P-01': facilitatorRoute('/workspaces', 'POST', { slug: 'pm-new', name: 'PM new' }),
  'P-10': async principal => {
    const result = await facilitatorRoute('/me', 'GET')(principal);
    // Seeing the workspace in the picker = it is listed for this person.
    const listed = result.status === 200 && result.json.memberships.some(row => row.workspace_id === WORKSPACE);
    return { ...result, status: listed ? 200 : result.status === 200 ? 403 : result.status };
  },
  'P-11': facilitatorRoute(`/workspaces/${WORKSPACE}/versions`, 'GET'),
  'P-12': facilitatorRoute(`/workspaces/${WORKSPACE}/groups`, 'GET'),
  'P-13': facilitatorRoute('/cases', 'POST', { workspaceId: WORKSPACE, title: 'PM case' }),
  'P-18': facilitatorRoute(`/workspaces/${WORKSPACE}/groups`, 'POST', { name: 'PM group', description: null, tint: 'sage' }),
  'P-19': facilitatorRoute(`/workspaces/${WORKSPACE}/groups/${GROUP}/archive`, 'POST', { expectedRevision: 0, confirmName: 'PM group', moveTo: null }),
  'P-20': facilitatorRoute(`/workspaces/${WORKSPACE}/cases/${CASE}/group`, 'PUT', { expectedRevision: 0, groupId: GROUP }),
  'P-14': facilitatorRoute(`/cases/${CASE}/draft`, 'PUT', { expectedRevision: 1, schemaVersion: 1, document: draft }),
  'P-15': builderReviewRoute(`/builder/cases/${CASE}/candidates/${CANDIDATE}/release`, 'POST',
    { revision: 1, intentDigest: `\\x${'c'.repeat(64)}`, contentSha256: `\\x${'b'.repeat(64)}`, assetIds: [], art }),
  'P-33': builderReviewRoute(`/builder/cases/${CASE}/candidates/${CANDIDATE}`, 'GET'),
  'P-21': async principal => {
    if (principal === 'signedOut') return { status: 401 };
    const rpc = permissiveRpc();
    rpc.call = (call => async (name, args) => {
      if (name !== 'get_case_version_for_workspace') return call(name, args);
      rpc.calls.push({ name, args }); return { ok: true, data: [] };
    })(rpc.call);
    // An authorized start reaches the version read (404 for this empty fake); a refused one never does.
    const result = await startPublishedRoom({ rpc, actor: actorFor(userOf(principal), env), workspaceId: WORKSPACE,
      caseVersionId: VERSION, ttlMs: 60_000, sessionId: uuidv7(), newCode: () => 'PMPM01',
      directory: { register: async () => true, release: async () => {} }, room: { create: async () => ({}), abortCreate: async () => {} } });
    return { status: result.status === 404 && rpc.calls.some(c => c.name === 'get_case_version_for_workspace') ? 200 : result.status };
  },
  'P-24': async principal => mintStatus(principal, 'P-24'),
  'P-25': async principal => mintStatus(principal, 'P-25'),
  // Step A4 (CASE-339): invitations name their place and level; GoTrue and Resend are fakes (no key: saved, not sent).
  'P-03': invitationRoute('/invitations', 'POST', { workspaceId: WORKSPACE, level: 'run', email: 'pm-invitee@example.org' }),
  'P-43': invitationRoute('/invitations', 'POST', { workspaceId: WORKSPACE, caseId: CASE, level: 'run', email: 'pm-invitee@example.org' }),
  'P-44': invitationRoute(`/workspaces/${WORKSPACE}/invitations/${INVITATION}/resend`, 'POST', {}),
  'P-07': adminRoute('/admin/audit', 'GET'),
  'P-22': adminRoute(`/admin/workspaces/${WORKSPACE}/audit`, 'GET'),
  'P-45': adminRoute(`/admin/workspaces/${WORKSPACE}/settings`, 'POST', { expectedRevision: 0, policies: { runners_share: true }, mediaQuotaBytes: null }),
  'P-08': adminRoute('/admin/rooms', 'GET'),
  'P-09': adminRoute(`/admin/rooms/${uuidv7()}/end`, 'POST', {}, 'rooms_end'),
  // P-40 is not workspace-scoped: the outsider here is an account with no workspace role anywhere.
  'P-40': (principal, options) => facilitatorRoute('/me/profile', 'PUT', { name: 'PM Name', role: 'Registrar' })(principal,
    { ...options, noMemberships: principal === 'outsider' }),
  'P-42': builderRoute(`/builder/cases/${CASE}/archive`, 'POST', { confirmTitle: 'PM case' }),
  'P-41': adminRoute(`/admin/facilitators/${uuidv7()}/label`, 'POST', { expectedRevision: 0, name: 'PM Name', role: 'Registrar' }),
  'P-06': adminRoute(`/admin/facilitators/${uuidv7()}/disable`, 'POST', { expectedRevision: 0, confirmEmail: 'target@example.org' }, 'facilitators_disable'),
};
async function mintStatus(principal, action) {
  if (principal === 'signedOut') return { status: 401 };
  // A room started from CASE (step A3: the DO records the case it was started from).
  const result = await mayMintConsole(permissiveRpc(), actorFor(userOf(principal), env), { workspaceId: WORKSPACE, caseId: CASE }, action, env);
  return { status: result.ok ? 200 : result.status };
}
function adminRoute(path, method, body, actionClass = null) {
  return async (principal, { elevated = false } = {}) => {
    const rpc = permissiveRpc();
    const headers = { origin: 'https://case.test' };
    if (elevated && principal !== 'signedOut')
      headers['x-admin-elevation'] = (await mintElevation(EMAILS[principal], SESSION, SECRET)).token;
    const response = await handleAdminRequest(jsonRequest(path, method, body, headers), { env, rpc,
      verifyUser: verifyUser(principal), nowMs: () => Date.now(),
      gotrue: { findUserByEmail: async () => ({ ok: true, user: null }), inviteUser: async () => ({ ok: true, userId: uuidv7() }),
        getUser: async id => ({ ok: true, user: { id, email: 'target@example.org', bannedUntil: null } }),
        updateUser: async () => ({ ok: true }) },
      rooms: { endOwned: async () => ({ ok: true }), read: async () => ({ ok: true, rooms: [], nextCursor: null }),
        summary: async sessionId => ({ sessionId, ownerUserId: uuidv7(), status: 'live' }), endOne: async () => ({ ok: true }) } });
    return { status: response.status };
  };
}

function invitationRoute(path, method, body) {
  return async principal => {
    const response = await handleInvitationsApi(jsonRequest(path, method, body), { env, rpc: permissiveRpc(), verifyUser: verifyUser(principal),
      gotrue: { findUserByEmail: async () => ({ ok: true, user: null }), createUser: async () => ({ ok: true, userId: uuidv7() }) } });
    return { status: response.status };
  };
}
// W capability rows (`cap` for every principal): the holder of the reference, not a role, reads it; the named test proves it.
const CAP_PROOF = { 'P-46': ['tests/access-invitations.test.mjs', '[P-46] [AS-208] the peek takes the reference in a body'] };

// D-only rows: the room DO enforces them with its hashed credentials; each names the test that proves it.
const DO_PROOF = {
  'P-23': ['tests/worker/room-runtime.test.mjs', "[P1-6] takeover revokes every other facilitator token; displays can be revoked"],
  'P-26': ['tests/worker/room-runtime.test.mjs', 'display pairing is number-matched, single use and expires'],
  'P-27': ['tests/worker/console-revoke.test.mjs', "[PM-27] only the starter may list or revoke; a shared computer, another user and a signed-out caller are refused"],
  'P-28': ['tests/worker/room-runtime.test.mjs', 'joins by typed code; unconfigured-widget fallback limits wrong codes but never a correct code'],
  'P-29': ['tests/worker/room-runtime.test.mjs', 'votes are idempotent by client_event_id, a reused id with a new payload is refused, and the server stamps actor and time'],
  'P-30': ['tests/transport.test.mjs', '[AS-025] a display pairs by number match, re-pairs after a restart, and gets the latest public snapshot'],
  'P-31': ['tests/transport.test.mjs', '[AS-017] a participant token outlives the browser until its recap expires'],
  'P-35': ['tests/worker/feedback-runtime.test.mjs', '[P-35] returns only a per-room HMAC for a participant credential, stable per phone and refused for every other role'],
  'P-36': ['tests/worker/debrief-paging.test.mjs', 'needs an ended room and a facilitator credential; a phone cannot mint it'],
};

for (const row of rows) {
  const later = LATER[row.id];
  if (later) {
    test(`[PM-matrix] ${row.id} ${row.action}`, { todo: `${typeof later === 'number' ? 'card' : 'step'} ${later} ships this action` }, () => {});
    continue;
  }
  if (DRIVERS[row.id]) {
    const pending = WORKER_PENDING[row.id] ?? {};
    for (const [principal, step] of Object.entries(pending)) {
      test(`[PM-matrix] ${row.id} as ${principal}: the Worker grants ${expected(row.id, principal)}`, { todo: `step ${step}` }, () => {});
      test(`[PM-matrix] ${row.id} as ${principal} is a known gap until its step lands`, async () => {
        assert.equal(row.status, 'GAP', `${row.id} has a pending Worker cell, so docs/PERMISSIONS.md must mark it GAP`);
        const { status } = await DRIVERS[row.id](principal);
        assert.ok([401, 403].includes(status), `${row.id} ${principal} now passes (${status}): remove it from WORKER_PENDING`);
      });
    }
    test(`[PM-matrix] ${row.id} ${row.action}: the Worker grants exactly the matrix`, async () => {
      for (const principal of principals) {
        if (Object.hasOwn(pending, principal)) continue;
        const cell = expected(row.id, principal);
        const { status } = await DRIVERS[row.id](principal);
        if(row.id==='P-49'&&cell==='cap'){assert.equal(status,403,'incident designation is required');assert.equal((await DRIVERS[row.id](principal,{capability:true})).status,200,'current designated deployment admin admitted');}
        else if (cell === 'step') {
          assert.equal(status, 403, `${row.id} ${principal} without step-up`);
          const elevated = await DRIVERS[row.id](principal, { elevated: true });
          assert.ok(elevated.status < 400, `${row.id} ${principal} with a scoped step-up: ${elevated.status}`);
        } else if (['yes', 'own'].includes(cell)) assert.ok(status < 400, `${row.id} ${principal} should pass: ${status}`);
        else assert.ok([401, 403].includes(status), `${row.id} ${principal} should be refused: ${status}`);
      }
    });
    continue;
  }
  if (CAP_PROOF[row.id]) {
    test(`[PM-matrix] ${row.id} ${row.action}: a capability row, proven by its own test`, () => {
      const [file, marker] = CAP_PROOF[row.id];
      assert.ok(PRINCIPALS.every(p => MATRIX[row.id][p] === 'cap'), `${row.id} is a capability for every principal`);
      assert.ok(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').includes(marker), `${file} lost its ${row.id} proof`);
    });
    continue;
  }
  if (DO_PROOF[row.id]) {
    test(`[PM-matrix] ${row.id} ${row.action}: proven by the room DO suite`, () => {
      const [file, marker] = DO_PROOF[row.id];
      assert.ok(row.enforced.includes('D'));
      assert.ok(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').includes(marker), `${file} lost its ${row.id} proof`);
    });
    continue;
  }
  // Card 30: a row the doc calls enforced (OK) must be driven or proven here; only GAP and NEW rows are todo.
  if (row.status === 'OK') test(`[PM-matrix] ${row.id} ${row.action}: enforced (OK) rows need a driver`, () => {
    assert.fail(`${row.id} is OK in docs/PERMISSIONS.md but has no Worker driver or DO proof here`);
  });
  else test(`[PM-matrix] ${row.id} ${row.action}`, { todo: `not enforced on this branch (${row.status}); see docs/PERMISSIONS.md §7` }, () => {});
}

test('[PM-05] no request field, header or query sets the admin flag', async () => {
  for (const principal of ['owner', 'facilitator', 'outsider']) {
    const rpc = permissiveRpc();
    const request = new Request(`https://case.test/api/v1/workspaces?admin=1&isAdmin=true&p_admin=true`, { method: 'POST',
      headers: { authorization: 'Bearer pm', 'content-type': 'application/json', 'x-admin': 'true', 'x-is-admin': '1',
        cookie: 'admin=true; isAdmin=1' },
      body: JSON.stringify({ slug: 'pm-forged', name: 'Forged', admin: true, isAdmin: true, p_admin: true, p_admin_email: ADMIN_EMAIL }) });
    const response = await handleFacilitatorApi(request, { rpc, env, verifyUser: verifyUser(principal) });
    assert.equal(response.status, 403, principal);
    assert.equal(rpc.calls.some(c => c.args?.p_admin === true), false, `${principal}: the RPC never saw an admin flag`);
  }
  // A JWT email that differs from the list only by case is not admin (E02); the flag follows the list per request (E03).
  assert.equal(actorFor({ userId: PEOPLE.admin, email: 'PM-Admin@example.org' }, env).admin, false);
  assert.equal(actorFor({ userId: PEOPLE.admin, email: ADMIN_EMAIL }, { ...env, ADMIN_EMAILS: 'someone@example.org' }).admin, false);
  assert.equal(actorFor({ userId: PEOPLE.admin, email: ADMIN_EMAIL, admin: true }, {}).admin, false);
});

test('[PM-07] an admin write is passed to SQL as an admin write on every environment (staging included)', async () => {
  for (const CASE_ENV of ['production', 'staging', undefined]) {
    const rpc = permissiveRpc();
    const response = await handleFacilitatorApi(jsonRequest('/cases', 'POST', { workspaceId: WORKSPACE, title: 'Admin case' }),
      { rpc, env: { ...env, CASE_ENV }, verifyUser: verifyUser('admin') });
    assert.equal(response.status, 201, String(CASE_ENV));
    assert.deepEqual(rpc.calls.find(c => c.name === 'create_case').args,
      { p_user_id: PEOPLE.admin, p_workspace_id: WORKSPACE, p_title: 'Admin case', p_admin: true, p_admin_email: ADMIN_EMAIL });
  }
});

test('[PM-core] no Worker module outside the core reads or forwards an admin flag from a request', () => {
  for (const file of ['facilitator-api.mjs', 'published-rooms.mjs', 'catalogue.mjs', 'groups.mjs', 'owned-rooms.mjs', 'console-pairs.mjs', 'index.mjs']) {
    const source = readFileSync(new URL(`../src/worker/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /p_admin\s*:/, `${file} sets p_admin itself`);
    assert.doesNotMatch(source, /body\??\.(admin|isAdmin|p_admin)\b|searchParams\.get\(['"](admin|isAdmin|p_admin)/, `${file} reads an admin field`);
    assert.doesNotMatch(source, /memberPreflight|\['owner', 'author'\]/, `${file} keeps a route-local role list`);
  }
  assert.match(readFileSync(new URL('../src/worker/authorize.mjs', import.meta.url), 'utf8'), /p_admin: true, p_admin_email: actor\.email/);
});

test('[PM-22] a room started before this Worker (no workspace in its DO) is rechecked through its session row', async () => {
  for (const principal of ['owner', 'author', 'facilitator', 'admin', 'outsider']) {
    const rpc = permissiveRpc();
    const result = await mayMintConsole(rpc, actorFor(userOf(principal), env), { workspaceId: null }, 'P-24', env, undefined, LEGACY_ROOM);
    assert.equal(result.ok, principal !== 'outsider', principal);
    assert.ok(rpc.calls.some(c => c.name === 'get_session_workspace' && c.args.p_session_id === LEGACY_ROOM), principal);
  }
  // A removed member of a legacy room is refused (no new console), not waved through for lack of a DO record.
  const removed = await mayMintConsole(permissiveRpc(), actorFor({ userId: uuidv7(), email: 'gone@example.org', sessionId: SESSION }, env),
    { workspaceId: null }, 'P-24', env, undefined, LEGACY_ROOM);
  assert.deepEqual(removed, { ok: false, error: 'forbidden', status: 403 });
  // A room with neither a DO workspace nor a session row is refused, even with inline rooms on; only a room its
  // DO marks as an inline dev room is re-minted, and only where CASE_DEV_INLINE_CASES=1.
  const owner = actorFor(userOf('owner'), env);
  assert.equal((await mayMintConsole(permissiveRpc(), owner, { workspaceId: null }, 'P-24', { ...env, CASE_DEV_INLINE_CASES: '1' }, undefined, DEV_ROOM)).ok, false);
  assert.equal((await mayMintConsole(permissiveRpc(), owner, { workspaceId: null, inlineDev: true }, 'P-24', env, undefined, DEV_ROOM)).ok, false);
  assert.equal((await mayMintConsole(permissiveRpc(), owner, { workspaceId: null, inlineDev: true }, 'P-24', { ...env, CASE_DEV_INLINE_CASES: '1' }, undefined, DEV_ROOM)).ok, true);
  // An unreadable session row fails closed.
  const down = permissiveRpc(); const call = down.call;
  down.call = async (name, args) => name === 'get_session_workspace' ? { ok: false, kind: 'unavailable' } : call(name, args);
  assert.equal((await mayMintConsole(down, owner, { workspaceId: null }, 'P-24', env, undefined, LEGACY_ROOM)).status, 503);
});

// ─── 4. Access = person × place × level, and the workspace policies (CASE-336, CASE-337) ────────────────
const ALL_OFF = Object.freeze(Object.fromEntries(Object.keys(POLICIES).map(key => [key, false])));
/** Every cell (row × principal) that differs between two policy settings, as `P-NN principal before→after`. */
function flips(from, to) {
  const out = [];
  for (const id of Object.keys(MATRIX)) for (const p of PRINCIPALS) {
    const a = resolveCell(id, p, from), b = resolveCell(id, p, to);
    if (a !== b) out.push(`${id} ${p} ${a}→${b}`);
  }
  return out.sort();
}
// Hand-computed from docs/PERMISSIONS.md §4.3, not derived from the module.
const FLIPS = Object.freeze({
  managers_invite: ['P-03 owner no→yes', 'P-44 owner no→yes'],
  editors_publish: ['P-15 author no→yes', 'P-15 caseAuthor no→yes', 'P-33 author no→yes', 'P-33 caseAuthor no→yes'],
  runners_share: ['P-43 author no→yes', 'P-43 caseAuthor no→yes', 'P-43 caseFacilitator no→yes', 'P-43 facilitator no→yes'],
  managers_see_records: ['P-32 owner own→yes', 'P-34 owner own→yes', 'P-37 owner own→yes'],
});

test('[AS-210] each workspace policy flips exactly its cells, alone and in every combination; the defaults are CASE-337\'s', () => {
  assert.deepEqual({ ...POLICIES }, { managers_invite: true, editors_publish: false, runners_share: false, managers_see_records: true });
  assert.deepEqual(Object.keys(FLIPS).sort(), Object.keys(POLICIES).sort());
  for (const [key, cells] of Object.entries(FLIPS)) assert.deepEqual(flips(ALL_OFF, { ...ALL_OFF, [key]: true }), [...cells].sort(), key);
  const keys = Object.keys(POLICIES);
  for (let mask = 0; mask < 1 << keys.length; mask++) {
    const on = keys.filter((_, n) => mask & (1 << n));
    const policies = Object.fromEntries(keys.map(key => [key, on.includes(key)]));
    assert.deepEqual(flips(ALL_OFF, policies), on.flatMap(key => FLIPS[key]).sort(), on.join('+') || 'none');
  }
  // The defaults (which every existing workspace receives, "managers see records" included) turn on exactly two.
  assert.deepEqual(flips(ALL_OFF, POLICIES), [...FLIPS.managers_invite, ...FLIPS.managers_see_records].sort());
  // Policy cells never reach the SQL role table unconditionally: pol is policy-only, own+pol grants own.
  assert.deepEqual(rolesFor('P-15'), ['owner']);
  assert.deepEqual(rolesFor('P-33'), ['owner']);
  assert.deepEqual(rolesFor('P-03'), []);
  assert.deepEqual(rolesFor('P-44'), []);
  assert.deepEqual(rolesFor('P-43'), ['owner']);
  assert.deepEqual(rolesFor('P-34'), ['owner', 'author', 'facilitator']);
  assert.deepEqual(policyRolesFor('P-43'), ['author', 'facilitator']);
  assert.deepEqual(policyRolesFor('P-34'), ['owner']);
  assert.deepEqual(Object.keys(POLICY_OF).sort(), ['P-03', 'P-15', 'P-32', 'P-33', 'P-34', 'P-37', 'P-43', 'P-44']);
});

test('[AS-210] a policy is on only for a literal true of a known key', () => {
  for (const bad of [null, undefined, {}, { managers_invite: 'true' }, { managers_invite: 1 }, Object.create({ managers_invite: true })])
    assert.equal(policyOn(bad, 'managers_invite'), false, JSON.stringify(bad));
  assert.equal(policyOn({ managers_invite: true }, 'managers_invite'), true);
  assert.equal(policyOn({ made_up: true }, 'made_up'), false);
  assert.equal(resolveCell('P-03', 'owner', { managers_invite: 'yes' }), 'no');
  assert.equal(resolveCell('P-34', 'owner', undefined), 'own');
});

test('[AS-206] the highest level held on a case wins; Can manage is never a case grant', () => {
  assert.deepEqual(Object.keys(CASE_GRANT_LEVELS).sort(), ['edit', 'run']);
  const cases = [
    [{ role: 'facilitator', grant: 'edit' }, { role: 'author', scope: 'case' }],
    [{ role: 'author', grant: 'run' }, { role: 'author', scope: 'workspace' }],
    [{ role: 'author', grant: 'edit' }, { role: 'author', scope: 'workspace' }],
    [{ role: 'owner', grant: 'edit' }, { role: 'owner', scope: 'workspace' }],
    [{ role: null, grant: 'run' }, { role: 'facilitator', scope: 'case' }],
    [{ role: null, grant: 'edit' }, { role: 'author', scope: 'case' }],
    [{ role: 'facilitator', grant: null }, { role: 'facilitator', scope: 'workspace' }],
  ];
  for (const [held, want] of cases) assert.deepEqual(effectiveLevel(held), want, JSON.stringify(held));
  assert.equal(effectiveLevel({}), null);
  assert.throws(() => effectiveLevel({ grant: 'manage' }), /unknown case grant manage/);
  assert.throws(() => decide('P-14', { grant: 'manage' }), /unknown case grant manage/);
  assert.throws(() => effectiveLevel({ role: 'admin' }), /unknown workspace role admin/);
  // On a case-level row, the strongest held cell equals the cell of the highest level (what SQL's effective_role picks).
  const column = ({ role, scope }) => scope === 'case' ? (role === 'author' ? 'caseAuthor' : 'caseFacilitator') : role;
  for (const id of Object.keys(MATRIX).filter(id => MATRIX[id].caseAuthor !== 'no' || MATRIX[id].caseFacilitator !== 'no'))
    for (const role of [null, ...WORKSPACE_ROLES]) for (const grant of [null, 'run', 'edit']) {
      if (role === null && grant === null) continue;
      for (const policies of [ALL_OFF, POLICIES]) assert.equal(decide(id, { role, grant }, policies),
        resolveCell(id, column(effectiveLevel({ role, grant })), policies), `${id} ${role}/${grant}`);
    }
});

test('[AS-206] a case grant reaches its own case only, and never a workspace action', () => {
  // Grants are per case: the caller passes the grant on the case the request names, so case B sees no grant.
  const grants = { caseA: 'edit' };
  const on = (id, caseId, role = null) => decide(id, { role, grant: caseId ? grants[caseId] ?? null : null }, POLICIES);
  // Case-only editor of A, no workspace role.
  assert.equal(on('P-14', 'caseA'), 'yes');   // edit A's draft
  assert.equal(on('P-21', 'caseA'), 'yes');   // run A
  assert.equal(on('P-11', 'caseA'), 'yes');   // see A in the library
  assert.equal(on('P-14', 'caseB'), 'no');    // nothing on B
  assert.equal(on('P-21', 'caseB'), 'no');
  assert.equal(on('P-11', 'caseB'), 'no');
  assert.equal(on('P-13', null), 'no');       // cannot create a case
  assert.equal(on('P-12', null), 'no');       // no workspace settings, groups
  assert.equal(on('P-10', null), 'no');       // the workspace is not in their picker
  assert.equal(on('P-42', 'caseA'), 'no');    // archive is Can manage's
  assert.equal(on('P-16', 'caseA'), 'no');    // withdraw and republish stay with Can manage (plan §0.4)
  assert.equal(on('P-15', 'caseA'), 'no');    // releases only under editors_publish
  assert.equal(decide('P-15', { grant: 'edit' }, { ...POLICIES, editors_publish: true }), 'yes');
  assert.equal(on('P-34', 'caseA'), 'own');   // own records only, whatever managers_see_records says
  // Workspace runner who can edit A: edits A only; runs everything; workspace actions follow the workspace role.
  assert.equal(on('P-14', 'caseA', 'facilitator'), 'yes');
  assert.equal(on('P-14', 'caseB', 'facilitator'), 'no');
  assert.equal(on('P-21', 'caseB', 'facilitator'), 'yes');
  assert.equal(on('P-12', null, 'facilitator'), 'yes');
  assert.equal(on('P-13', null, 'facilitator'), 'no');
  // A case runner never edits, and shares only under runners_share.
  assert.equal(decide('P-14', { grant: 'run' }, POLICIES), 'no');
  assert.equal(decide('P-43', { grant: 'run' }, POLICIES), 'no');
  assert.equal(decide('P-43', { grant: 'run' }, { ...POLICIES, runners_share: true }), 'yes');
  // A grant never lowers a workspace role: an owner given Can run on a case keeps Can manage there.
  assert.equal(decide('P-42', { role: 'owner', grant: 'run' }, POLICIES), 'yes');
  // The admin path is the admin column alone.
  assert.equal(decide('P-22', { admin: true }, POLICIES), 'yes');
  // SQL's case role table follows the case columns.
  assert.deepEqual(caseRolesFor('P-14'), ['author']);
  assert.deepEqual(caseRolesFor('P-21'), ['author', 'facilitator']);
  assert.deepEqual(caseRolesFor('P-13'), []);
  assert.deepEqual(caseRolesFor('P-15'), []);
});

test('[PM-matrix] the case columns mirror their level and policy cells name exactly one policy', () => {
  assert.deepEqual(matrixShape(), []);
  const with_ = (id, change) => ({ ...MATRIX, [id]: { ...MATRIX[id], ...change } });
  assert.match(matrixShape(with_('P-14', { caseAuthor: 'step' })).join('\n'), /P-14 caseAuthor: step must be no or author's yes/);
  assert.match(matrixShape(with_('P-14', { caseFacilitator: 'yes' })).join('\n'), /P-14 caseFacilitator: yes must be no or facilitator's no/);
  assert.match(matrixShape(with_('P-15', { caseAuthor: 'no' })).join('\n'), /P-15 caseAuthor: a policy cell for author needs the same cell/);
  assert.match(matrixShape(with_('P-14', { author: 'pol', caseAuthor: 'pol' })).join('\n'), /P-14 has a policy cell but no policy/);
  assert.match(matrixShape(MATRIX, { ...POLICY_OF, 'P-14': 'editors_publish' }).join('\n'), /P-14 names policy editors_publish but has no policy cell/);
  assert.match(matrixShape(MATRIX, { ...POLICY_OF, 'P-03': 'made_up' }).join('\n'), /P-03: unknown policy made_up/);
  assert.match(matrixShape(with_('P-03', { participant: 'pol' })).join('\n'), /P-03 participant: a policy cell outside/);
});

// Parts of the Access scenarios later steps build (docs/ACCEPTANCE-SCENARIOS.md lists them). The db parts of AS-205 to
// AS-211 and AS-213 are proved in db/tests/access-invitations-images.test.sql (step A2).
// Step A3: the Worker reads grants and policies per request. Every driven W row, as the two case-grant principals too, and
// every row with a policy cell under both settings of every policy. A case-grant principal reaches only rows whose driver
// addresses its case (CASE_ROUTES); a workspace route (the library listing, groups, settings, history of others) stays
// refused, as the matrix's case columns mean "on that case".
const CASE_ROUTES = new Set(['P-14', 'P-15', 'P-21', 'P-24', 'P-25', 'P-32', 'P-33', 'P-34', 'P-37', 'P-38', 'P-40', 'P-42', 'P-43']);
const EVERY_ON = Object.freeze(Object.fromEntries(Object.keys(POLICIES).map(key => [key, true])));
const EVERY_OFF = Object.freeze(Object.fromEntries(Object.keys(POLICIES).map(key => [key, false])));
function expectedUnder(id, principal, policies) {
  // P-47 is account authority over one's own report; membership/grants do not gate admission.
  if(id==='P-47'&&principal!=='signedOut')return 'own';
  if (principal === 'caseAuthor' || principal === 'caseFacilitator') return CASE_ROUTES.has(id) ? resolveCell(id, principal, policies) : 'no';
  return principal === 'signedOut' || principal === 'outsider' ? 'no' : resolveCell(id, principal, policies);
}
for (const row of rows) {
  if (LATER[row.id] || !DRIVERS[row.id]) continue;
  const settings = Object.hasOwn(POLICY_OF, row.id) ? [['every policy on', EVERY_ON], ['every policy off', EVERY_OFF]] : [['the defaults', POLICIES]];
  test(`[AS-206] [AS-210] [PM-matrix] ${row.id}: the Worker grants exactly the matrix to case-grant principals and under each policy setting`, async () => {
    try {
      for (const [label, policies] of settings) {
        POLICY_STATE = policies;
        for (const principal of [...principals, 'caseAuthor', 'caseFacilitator']) {
          if (Object.hasOwn(WORKER_PENDING[row.id] ?? {}, principal)) continue;
          const cell = expectedUnder(row.id, principal, policies);
          const { status } = await DRIVERS[row.id](principal);
          if (cell === 'step') assert.equal(status, 403, `${row.id} ${principal} (${label}) without step-up`);
          else if (['yes', 'own'].includes(cell)) assert.ok(status < 400, `${row.id} ${principal} (${label}) should pass: ${status}`);
          else assert.ok([401, 403].includes(status), `${row.id} ${principal} (${label}) should be refused: ${status}`);
        }
      }
    } finally { POLICY_STATE = POLICIES; }
  });
}

test('[PM-matrix] P-47 participant authority has a real room DO witness',()=>{assert.ok(rows.find(r=>r.id==='P-47').enforced.includes('D'));assert.ok(readFileSync(new URL('./worker/beta-issue-capability.test.mjs',import.meta.url),'utf8').includes('beta report room capability'));});
