#!/usr/bin/env node
// scripts/gen-permissions.mjs: the permission matrix's one source is docs/PERMISSIONS.md §4 (card 35).
//
// It parses the marked §4 table, checks it against src/shared/permissions.mjs, and derives the SQL role
// table (case_app.action_roles / action_admin / action_case_roles / policy_allows) and the generated SQL
// matrix test from that module.
//
//   node scripts/gen-permissions.mjs          rewrite the generated test fixture
//   node scripts/gen-permissions.mjs --check  exit 1 on any drift (run by `npm run check`)
//
// The SQL role table lives in a migration, and applied migrations are immutable (AGENTS.md rule 7): the
// check reads the LATEST migration that carries the generated block. A matrix change therefore needs a new
// migration that recreates the functions with the regenerated block (print it with --sql).
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { MATRIX, PRINCIPALS, CELLS, SQL_ACTIONS, WORKSPACE_ROLES, CASE_MIRROR, POLICIES, POLICY_OF,
  rolesFor, caseRolesFor, policyRolesFor, policyOn, adminReaches } from '../src/shared/permissions.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DOC = resolve(ROOT, 'docs/PERMISSIONS.md');
export const MIGRATIONS = resolve(ROOT, 'db/supabase/migrations');
export const SQL_FIXTURE = resolve(ROOT, 'db/tests/permission-matrix.test.sql');
const MARKER = '<!-- permission-matrix: card 35 parses this table; keep the columns and tokens exactly. -->';
export const HEADER = ['ID', 'Action', 'Admin', 'Owner', 'Author', 'Facilitator', 'Case author', 'Case facilitator',
  'Participant', 'Projector', 'Shared PC', 'Enforced at', 'Status'];
const ENFORCEMENT = new Set(['W', 'R', 'D', 'S', 'G']);
// NEW names the card (two digits) or the facilitator-UX step (A1–A9, B1–B9) that ships the row.
const LATER_TOKEN = '(?:\\d{2}|[AB]\\d)';
const STATUS = new RegExp(`^(OK|GAP|NEW \\(${LATER_TOKEN}(, ${LATER_TOKEN})*\\))$`);
const POLICY_CELLS = new Set(['pol', 'own+pol']);
export const SQL_BEGIN = '-- BEGIN GENERATED permission roles (scripts/gen-permissions.mjs; do not edit by hand)';
export const SQL_END = '-- END GENERATED permission roles';

/**
 * Matrix grants the SQL role table does not carry yet, with the step that lands them (rows marked GAP in
 * docs/PERMISSIONS.md). Until then the generated block and the generated SQL test keep these cells refused,
 * which is what the database enforces today, so `npm run test:db` proves the real state. Step A2 emptied it in
 * 20261111000000_access_invitations_images.sql, which rewrote the candidate RPCs to audit an owner as `owner`;
 * `--check` fails on an entry whose row is not GAP or whose cell no longer grants.
 */
export const SQL_PENDING = Object.freeze({});
/** The roles the generated SQL grants a row: the matrix's, less any SQL_PENDING cell. */
export function sqlRolesFor(id) {
  return rolesFor(id).filter(role => !Object.hasOwn(SQL_PENDING[id] ?? {}, role));
}
/**
 * Whether case_app.authorize lets a member of the fixture workspace through, which holds the CASE-337 default
 * policies: the role table's cell, or a policy cell whose policy is on by default (P-03 and P-44 for owners).
 */
export function sqlAllowsAtDefaults(id, role) {
  return sqlRolesFor(id).includes(role) || (policyRolesFor(id).includes(role) && policyOn(POLICIES, POLICY_OF[id]));
}

/** Parse the marked §4 table. Any format error throws: the matrix test and `check` fail on it. */
export function parseMatrixTable(text) {
  const lines = text.split('\n');
  const at = lines.indexOf(MARKER);
  if (at < 0 || lines.indexOf(MARKER, at + 1) >= 0) throw new Error('permission matrix marker missing or repeated');
  const cells = line => {
    if (!line.startsWith('|') || !line.endsWith('|')) throw new Error(`not a table row: ${line}`);
    return line.slice(1, -1).split('|').map(part => part.trim());
  };
  if (cells(lines[at + 1]).join('|') !== HEADER.join('|')) throw new Error('permission matrix header changed');
  if (!new RegExp(`^\\|(---\\|){${HEADER.length}}$`).test(lines[at + 2])) throw new Error('permission matrix separator changed');
  const rows = [];
  for (let i = at + 3; i < lines.length && lines[i].startsWith('|'); i++) {
    const [id, action, ...rest] = cells(lines[i]);
    if (rest.length !== HEADER.length - 2) throw new Error(`row ${id}: expected ${HEADER.length} columns`);
    const n = PRINCIPALS.length;
    const values = rest.slice(0, n), enforced = rest[n].split(',').map(x => x.trim()), status = rest[n + 1];
    if (!/^P-\d{2}$/.test(id) || !action) throw new Error(`bad row id or action: ${id}`);
    for (const value of values) if (!CELLS.includes(value)) throw new Error(`row ${id}: unknown cell ${value}`);
    if (!enforced.length || enforced.some(code => !ENFORCEMENT.has(code))) throw new Error(`row ${id}: bad enforcement ${rest[n]}`);
    const match = STATUS.exec(status);
    if (!match) throw new Error(`row ${id}: bad status ${status}`);
    rows.push({ id, action, cells: Object.fromEntries(PRINCIPALS.map((p, n) => [p, values[n]])), enforced, status,
      laterCards: status.startsWith('NEW') ? status.slice(5, -1).split(', ').map(t => (/^\d+$/.test(t) ? Number(t) : t)) : [] });
  }
  const ids = rows.map(row => row.id);
  if (new Set(ids).size !== ids.length) throw new Error('duplicate permission id');
  ids.forEach((id, n) => { if (id !== `P-${String(n + 1).padStart(2, '0')}`) throw new Error(`missing or out-of-order id near ${id}`); });
  return rows;
}

/** Every difference between the doc rows and the shared module, as readable strings. */
export function matrixDrift(rows) {
  const drift = [];
  const docIds = rows.map(row => row.id), codeIds = Object.keys(MATRIX);
  for (const id of codeIds) if (!docIds.includes(id)) drift.push(`${id} is in src/shared/permissions.mjs but not in docs/PERMISSIONS.md`);
  for (const row of rows) {
    if (!Object.hasOwn(MATRIX, row.id)) { drift.push(`${row.id} is in docs/PERMISSIONS.md but not in src/shared/permissions.mjs`); continue; }
    for (const p of PRINCIPALS) if (MATRIX[row.id][p] !== row.cells[p])
      drift.push(`${row.id} ${p}: doc says ${row.cells[p]}, code says ${MATRIX[row.id][p]}`);
  }
  const sqlFromDoc = rows.filter(row => row.enforced.includes('R')).map(row => row.id);
  if (sqlFromDoc.join() !== SQL_ACTIONS.join()) drift.push(`SQL_ACTIONS ${SQL_ACTIONS.join()} != rows enforced at R ${sqlFromDoc.join()}`);
  drift.push(...matrixShape());
  for (const [id, cells] of Object.entries(SQL_PENDING)) {
    const row = rows.find(r => r.id === id);
    if (row?.status !== 'GAP') drift.push(`SQL_PENDING ${id}: the row must be marked GAP while SQL lags the matrix`);
    for (const role of Object.keys(cells)) if (!rolesFor(id).includes(role)) drift.push(`SQL_PENDING ${id} ${role}: the matrix no longer grants this cell`);
  }
  return drift;
}

/**
 * The shape rules the generated SQL relies on (docs/PERMISSIONS.md §4.3), as readable strings:
 * - a case column holds its mirrored workspace role's cell or `no` (a case grant never exceeds that level), and
 *   copies a policy cell exactly, so case_app.policy_allows(action, role, …) answers both scopes;
 * - policy cells appear only in workspace and case columns, and every row that has one names exactly one
 *   known policy in POLICY_OF (and no row names a policy it does not use).
 */
export function matrixShape(matrix = MATRIX, policyOf = POLICY_OF) {
  const problems = [];
  for (const [id, cells] of Object.entries(matrix)) {
    for (const [column, role] of Object.entries(CASE_MIRROR)) {
      if (cells[column] !== 'no' && cells[column] !== cells[role]) problems.push(`${id} ${column}: ${cells[column]} must be no or ${role}'s ${cells[role]}`);
      if (POLICY_CELLS.has(cells[role]) && cells[column] !== cells[role] && cells[column] !== 'no') problems.push(`${id} ${column}: must copy ${role}'s policy cell`);
      if (POLICY_CELLS.has(cells[role]) && cells[column] === 'no') problems.push(`${id} ${column}: a policy cell for ${role} needs the same cell for ${column}`);
    }
    const policyColumns = Object.keys(cells).filter(p => POLICY_CELLS.has(cells[p]));
    for (const p of policyColumns) if (![...WORKSPACE_ROLES, ...Object.keys(CASE_MIRROR)].includes(p)) problems.push(`${id} ${p}: a policy cell outside the workspace and case columns`);
    if (policyColumns.length && !Object.hasOwn(policyOf, id)) problems.push(`${id} has a policy cell but no policy in POLICY_OF`);
    if (!policyColumns.length && Object.hasOwn(policyOf, id)) problems.push(`${id} names policy ${policyOf[id]} but has no policy cell`);
  }
  for (const [id, key] of Object.entries(policyOf)) if (!Object.hasOwn(POLICIES, key)) problems.push(`${id}: unknown policy ${key}`);
  return problems;
}

const sqlArray = roles => roles.length ? `array[${roles.map(r => `'${r}'`).join(', ')}]` : `array[]::text[]`;
/** Every row that has a policy cell, in matrix order. */
const policyRows = () => Object.keys(MATRIX).filter(id => Object.hasOwn(POLICY_OF, id));

/** The SQL role table, derived from the shared module. */
export function sqlRoleBlock() {
  const roles = SQL_ACTIONS.map(id => `    when '${id}' then ${sqlArray(sqlRolesFor(id))}`).join('\n');
  const admin = SQL_ACTIONS.map(id => `    when '${id}' then ${adminReaches(id)}`).join('\n');
  const caseRoles = SQL_ACTIONS.map(id => `    when '${id}' then ${sqlArray(caseRolesFor(id))}`).join('\n');
  const policy = policyRows().map(id =>
    `    when p_action = '${id}' and p_role = any (${sqlArray(policyRolesFor(id))}) then p_policies -> '${POLICY_OF[id]}' = 'true'::jsonb`).join('\n');
  return `${SQL_BEGIN}
create or replace function case_app.action_roles(p_action text)
returns text[] language sql immutable set search_path = '' as $$
  select case p_action
${roles}
  end;
$$;
create or replace function case_app.action_admin(p_action text)
returns boolean language sql immutable set search_path = '' as $$
  select case p_action
${admin}
  end;
$$;
-- The roles (author, facilitator) a case grant of that level reaches on its own case (CASE-336).
create or replace function case_app.action_case_roles(p_action text)
returns text[] language sql immutable set search_path = '' as $$
  select case p_action
${caseRoles}
  end;
$$;
-- True when the role's cell is pol or own+pol and the row's workspace policy is a JSON true in p_policies
-- (CASE-337): pol then grants, own+pol widens own to every room in the workspace. Anything else is false.
create or replace function case_app.policy_allows(p_action text, p_role text, p_policies jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(case
${policy}
  end, false);
$$;
revoke all on function case_app.action_roles(text), case_app.action_admin(text), case_app.action_case_roles(text),
  case_app.policy_allows(text, text, jsonb) from public, anon, authenticated, service_role;
${SQL_END}`;
}

/** The latest migration that carries the generated block, and that block. */
export function latestSqlBlock() {
  const files = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort().reverse();
  for (const file of files) {
    const sql = readFileSync(resolve(MIGRATIONS, file), 'utf8');
    const start = sql.indexOf(SQL_BEGIN);
    if (start < 0) continue;
    const end = sql.indexOf(SQL_END, start);
    if (end < 0) throw new Error(`${file}: generated block not closed`);
    return { file, block: sql.slice(start, end + SQL_END.length) };
  }
  return null;
}

const U = n => `'0199a000-0000-7000-8000-0000000035${n}'`;

// ─── every case_api RPC bound to its action (red-team item 2) ────────────────────────────────────────
// Each service-callable case_api RPC is either bound to the matrix row it enforces, with a call that returns
// true when the caller was let through, or listed as unbound with the reason it authorizes no workspace
// action. The generated test calls every bound RPC as every principal and compares with the matrix, and
// fails when an RPC exists that is in neither list. `adminOnly`: the RPC is the admin path of a row whose
// member path is a different RPC (card 32's owner withdraw), so only an admin may call it.
// Placeholders: :u user, :a admin flag, :e admin email, :j a step-up recorded for the admin.
const W = U('0a'), CASE = U('c1'), LEGACY_CASE = U('c2'), REVIEW_CASE = U('c3'), CANCEL_CASE = U('c4'), VERSION = U('e1'), TARGET = U('09'), GROUP = U('a1');
const GRANT = U('b1'), INVITATION = U('b2');
const MEDIA_CASE = `jsonb_build_object('sha256', repeat('c',64), 'bytes', 4000, 'width', 1200, 'height', 800), jsonb_build_object('sha256', repeat('d',64), 'bytes', 2000, 'width', 640, 'height', 427), jsonb_build_object('alt_text', 'ECG', 'attested', true)`;
const MEDIA = `jsonb_build_object('sha256', repeat('a',64), 'bytes', 4000, 'width', 1200, 'height', 800), jsonb_build_object('sha256', repeat('b',64), 'bytes', 2000, 'width', 640, 'height', 427), jsonb_build_object('alt_text', 'ECG', 'evidence_kind', 'ecg', 'rights_basis', 'own_work', 'licence', 'own-work')`;
export const RPC_BINDINGS = Object.freeze({
  // Card 59 M2 (CASE-268): image uploads and reads follow P-14; approving an image follows P-33 (configured admin only).
  builder_media_put_allowance: ['P-14', `select case_api.builder_media_put_allowance(${W}, :u, :a, :e, repeat('7', 64), 4000)`],
  builder_list_assets: ['P-14', `select jsonb_typeof(case_api.builder_list_assets(${W}, :u, :a, :e, null)) = 'array'`],
  builder_set_asset_attestation: ['P-14', `select (case_api.builder_set_asset_attestation(${W}, ((case_api.builder_create_asset(${W}, ${U('02')}, false, null, ${MEDIA}))->>'asset_id')::uuid, false, true, :u, :a, :e))->>'attested' = 'true'`],
  builder_create_asset: ['P-14', `select (case_api.builder_create_asset(${W}, :u, :a, :e, ${MEDIA}))->>'status' = 'quarantined'`],
  builder_asset_rendition: ['P-14', `select count(*) >= 0 from case_api.builder_asset_rendition(${W}, case_app.uuid_v7(), 'display', :u, :a, :e)`],
  // Card 59 M3 (CASE-269): a room start reads its version's images (P-21).
  room_media_manifest: ['P-21', `select count(*) >= 0 from case_api.room_media_manifest(${VERSION}, ${W}, :u, :a, :e)`],
  // Card 59 M4 (CASE-270): an image takedown is the admin path of P-16, with the session's recorded step-up.
  admin_withdraw_asset: ['P-16', `select count(*) >= 1 from case_api.admin_withdraw_asset(${W}, ((case_api.builder_create_asset(${W}, ${U('02')}, false, null, ${MEDIA}))->>'asset_id')::uuid, 'Rights complaint', :u, :a, :e, :j)`, { adminOnly: true }],
  // Card 62 (CASE-285 R1): approval names the shown state and acknowledges the open warning (the MEDIA image is unticked).
  // Image approval is removed (facilitator-UX plan §0.2): P-33 now means candidates only. A2 makes this RPC admin-only
  // (an owner's P-33 must not reach it) for the deployed Worker's queue until A3 removes the route; a later migration drops it.
  admin_review_asset: ['P-33', `select (case_api.admin_review_asset(${W}, (v->>'asset_id')::uuid, 'approve', jsonb_build_object('attested', v->'attested', 'rights_basis', v->'rights_basis', 'licence', v->'licence', 'creator', v->'creator', 'attribution', v->'attribution', 'rights_note', v->'rights_note', 'source_url', v->'source_url'), '{not_deidentified}', :u, :a, :e))->>'status' = 'approved' from (select case_api.builder_create_asset(${W}, ${U('02')}, false, null, ${MEDIA}) v) created`, { adminOnly: true }],
  builder_list_draft_summaries: ['P-14', `select count(*) >= 0 from case_api.builder_list_draft_summaries(${W}, 50, 0, :u, :a, :e)`],
  builder_list_drafts: ['P-14', `select count(*) >= 0 from case_api.builder_list_drafts(${W}, 50, 0, :u, :a, :e)`],
  builder_get_draft: ['P-14', `select count(*) = 1 from case_api.builder_get_draft(${CASE}, :u, :a, :e)`],
  builder_open_save_window: ['P-14', `select count(*) = 1 from case_api.builder_open_save_window(${CASE}, 1, :u, :a, :e)`],
  builder_get_save_receipt: ['P-14', `select count(*) = 1 from pg_temp.pm_builder_receipt(${CASE}, :u, :a, :e)`],
  builder_save_draft: ['P-14', `select count(*) = 1 from case_api.builder_save_draft(${CASE}, (select operation_id from case_api.builder_open_save_window(${CASE}, 1, :u, :a, :e)), (select doc from pm_doc), cast('{"metadata_version":1}' as jsonb), :u, :a, :e)`],
  builder_list_checkpoints: ['P-14', `select count(*) >= 0 from case_api.builder_list_checkpoints(${CASE}, :u, :a, :e)`],
  builder_create_checkpoint: ['P-14', `select count(*) = 1 from case_api.builder_create_checkpoint(${CASE}, 'PM checkpoint', 1, :u, :a, :e)`],
  builder_delete_checkpoint: ['P-14', `select deleted from case_api.builder_delete_checkpoint(${CASE}, (select id from case_api.builder_create_checkpoint(${CASE}, 'PM checkpoint', 1, :u, :a, :e)), :u, :a, :e)`],
  // CASE-316: the PM case is published, so an entitled caller is answered 'published' and nothing is archived.
  builder_archive_case: ['P-42', `select outcome = 'published' from case_api.builder_archive_case(${CASE}, :u, 'PM case', :a, :e)`],
  builder_restore_checkpoint: ['P-14', `select count(*) = 1 from case_api.builder_restore_checkpoint(${CASE}, (select id from case_api.builder_create_checkpoint(${CASE}, 'PM checkpoint', 1, :u, :a, :e)), (select operation_id from case_api.builder_open_save_window(${CASE}, 1, :u, :a, :e)), :u, :a, :e)`],
  builder_publication_readiness: ['P-14', `select count(*) = 1 and bool_and(code = 'revision_conflict') from case_api.builder_publication_readiness(${CASE}, -1, :u, :a, :e)`],
  builder_submit_candidate: ['P-14', `select count(*) = 1 from pg_temp.pm_builder_ready_draft(${REVIEW_CASE}) d cross join lateral case_api.builder_submit_candidate(${REVIEW_CASE}, case_app.uuid_v7(), d.revision, d.document, d.authoring_metadata, :u, :a, :e)`],
  builder_list_candidates: ['P-14', `select count(*) >= 0 from case_api.builder_list_candidates(${CASE}, :u, :a, :e)`],
  builder_get_review_candidate: ['P-33', `select count(*) = 1 from case_api.builder_get_review_candidate(${REVIEW_CASE}, $candidate::uuid, :u, :a, :e)`],
  builder_cancel_candidate: ['P-14', `select status = 'cancelled' from case_api.builder_cancel_candidate(${CANCEL_CASE}, $candidate::uuid, :u, :a, :e)`],
  builder_delete_candidate_body: ['P-14', `select deleted = false from case_api.builder_delete_candidate_body(${CANCEL_CASE}, $candidate::uuid, :u, :a, :e)`],
  builder_approve_candidate: ['P-33', `with candidate as (select $candidate::uuid as id) select count(*) = 1 from candidate c join case_app.builder_candidates b on b.candidate_id=c.id cross join lateral case_api.builder_approve_candidate(${REVIEW_CASE}, b.candidate_id, b.revision, b.intent_digest, b.content_sha256, :u, :a, :e)`],
  builder_release_candidate: ['P-15', `with candidate as (select $candidate::uuid as id), approved as (select b.* from candidate c join case_app.builder_candidates b on b.candidate_id=c.id cross join lateral case_api.builder_approve_candidate(${REVIEW_CASE}, b.candidate_id, b.revision, b.intent_digest, b.content_sha256, ${U('05')}, true, 'pm-admin@example.org')) select count(*) = 1 from approved b cross join lateral case_api.builder_release_candidate(${REVIEW_CASE}, b.candidate_id, b.revision, b.intent_digest, b.content_sha256, '{}'::uuid[], (select art from pm_doc), :u, :a, :e)`],
  builder_release_update: ['P-15', `with candidate as (select $candidate::uuid as id), approved as (select b.* from candidate c join case_app.builder_candidates b on b.candidate_id=c.id cross join lateral case_api.builder_approve_candidate(${REVIEW_CASE}, b.candidate_id, b.revision, b.intent_digest, b.content_sha256, ${U('05')}, true, 'pm-admin@example.org')) select count(*) = 1 from approved b cross join lateral case_api.builder_release_update(${REVIEW_CASE}, b.candidate_id, b.revision, b.intent_digest, b.content_sha256, '{}'::uuid[], (select art from pm_doc), false, :u, :a, :e)`],

  get_me: ['P-10', `select coalesce((select memberships from case_api.get_me(:u, 100, null, ${W}, :a, :e)) @> jsonb_build_array(jsonb_build_object('workspace_id', ${W})), false)`],
  list_published_versions: ['P-11', `select count(*) >= 0 from case_api.list_published_versions(:u, ${W}, 10, null, :a, :e)`],
  list_case_catalogue: ['P-11', `select count(*) >= 0 from case_api.list_case_catalogue(:u, ${W}, 'title', false, null, null, null, 10, 0, null, false, :a, :e)`],
  list_case_catalogue_current: ['P-11', `select count(*) >= 0 from case_api.list_case_catalogue_current(:u, ${W}, 'title', false, null, null, null, 10, 0, null, false, :a, :e)`],
  list_case_catalogue_groups: ['P-11', `select count(*) >= 1 from case_api.list_case_catalogue_groups(:u, ${W}, :a, :e)`],
  list_groups: ['P-12', `select count(*) >= 0 from case_api.list_groups(:u, ${W}, :a, :e)`],
  get_case_group: ['P-12', `select exists (select 1 from case_api.get_case_group(:u, ${CASE}, :a, :e))`],
  create_group: ['P-18', `select exists (select 1 from case_api.create_group(:u, ${W}, 'PM new group', null, 'sage', :a, :e))`],
  edit_group: ['P-18', `select exists (select 1 from case_api.edit_group(:u, ${W}, ${GROUP}, 0, 'PM group', null, 'coral', :a, :e))`],
  archive_group: ['P-19', `select exists (select 1 from case_api.archive_group(:u, ${W}, ${GROUP}, 0, 'PM group', null, :a, :e, :j))`],
  assign_case_group: ['P-20', `select exists (select 1 from case_api.assign_case_group(:u, ${W}, ${CASE}, 0, ${GROUP}, :a, :e))`],
  list_case_catalogue_audiences: ['P-11', `select count(*) >= 0 from case_api.list_case_catalogue_audiences(:u, ${W}, :a, :e)`],
  get_catalogue_case: ['P-11', `select exists (select 1 from case_api.get_catalogue_case(:u, ${CASE}, 1, :a, :e))`],
  get_catalogue_case_current: ['P-11', `select exists (select 1 from case_api.get_catalogue_case_current(:u, ${CASE}, 1, :a, :e))`],
  get_catalogue_case_history: ['P-11', `select exists (select 1 from case_api.get_catalogue_case_history(:u, ${CASE}, 1, :a, :e))`],
  create_case: ['P-13', `select case_api.create_case(:u, ${W}, 'PM case', :a, :e) is not null`],
  get_case_authoring_access: ['P-14', `select exists (select 1 from case_api.get_case_authoring_access(${CASE}, :u, :a, :e))`],
  get_draft: ['P-14', `select count(*) = 1 from case_api.get_draft(${CASE}, :u, :a, :e)`],
  save_draft: ['P-14', `select case_api.save_draft(${LEGACY_CASE}, 1, 1, (select doc from pm_doc), :u, :a, :e) = 2`],
  get_case_version_for_workspace: ['P-21', `select count(*) = 1 from case_api.get_case_version_for_workspace(${VERSION}, ${W}, :u, :a, :e)`],
  create_session: ['P-21', `select case_api.create_session(case_app.uuid_v7(), ${VERSION}, ${W}, :u, 'PMPM01', interval '1 hour', :a, :e) is not null`],
  admin_list_workspaces: ['P-03', `select case_api.admin_list_workspaces(:u, null, :a, :e) is not null`, { adminOnly: true }],
  // CASE-337: an owner's P-03 policy cell is for invitations only; these deployment RPCs stay admin-only.
  admin_workspace_query: ['P-03', `select case_api.admin_workspace_query(:u, ${W}, 'members', '', 'all', null, null, null, :a, :e) is not null`, { adminOnly: true }],
  admin_change_membership: ['P-04', `select case_api.admin_change_membership(:u, ${W}, 'pm-author@example.org', 'facilitator', null, (select membership_revision from case_app.workspaces where id=${W}), 'pm-author@example.org', :j, :a, :e) is not null`],
  admin_query_operations: ['P-07', `select case_api.admin_query_operations(:u, '', null, :a, :e) is not null`],
  resolve_catalogue_case:['P-11',`select exists(select 1 from case_api.resolve_catalogue_case(:u, ${CASE}, :a, :e))`],
  query_teaching_session_portfolio:['P-32',`select case_api.query_teaching_session_portfolio(:u, ${W}, '', 'all', null, null, null, false, :a, :e, null) is not null`],
  personal_teaching_portfolio_stats:['P-32',`select case_api.personal_teaching_portfolio_stats(:u, ${W}, :a, :e) is not null`],
  query_case_session_portfolio:['P-32',`select case_api.query_case_session_portfolio(:u, ${W}, '', 'all', null, null, null, false, :a, :e, ${CASE}) is not null`],
  query_session_portfolio: ['P-32', `select case_api.query_session_portfolio(:u, ${W}, '', 'all', null, null, null, false, :a, :e) is not null`],
  personal_portfolio_stats: ['P-32', `select case_api.personal_portfolio_stats(:u, ${W}, :a, :e) is not null`],
  read_session_portfolio: ['P-34', `select case_api.read_session_portfolio(:u, case when :u in (${U('01')},${U('02')},${U('03')}) then :u else ${U('f1')} end::uuid, 0, null, :a, :e) is not null`],
  session_media_rendition: ['P-34', `select count(*) >= 0 from case_api.session_media_rendition(:u, case when :u in (${U('01')},${U('02')},${U('03')}) then :u else ${U('f1')} end::uuid, case_app.uuid_v7(), :a, :e)`],
  // Card 40 + feedback slice 9: a room's feedback (P-37, the starter rule), a version's pooled case feedback (P-38) and the admin's
  // pooled view (P-39). Each own principal reads its own room; the admin and an outsider read the owner's.
  session_feedback_summary: ['P-37', `select case_api.session_feedback_summary(:u, case when :u in (${U('01')},${U('02')},${U('03')}) then :u else ${U('f1')} end::uuid, :a, :e) is not null`],
  case_feedback_summary: ['P-38', `select case_api.case_feedback_summary(:u, ${CASE}, 1, :a, :e) is not null`],
  admin_feedback_page: ['P-39', `select case_api.admin_feedback_page(:u, '{"scope":"app"}', 0, :a, :e) is not null`],
  list_room_history: ['P-32', `select count(*) >= 0 from case_api.list_room_history(:u, ${W}, 'all', 10, null, null, :a, :e)`],
  list_workspace_audit: ['P-22', `select count(*) >= 0 from case_api.list_workspace_audit(:u, ${W}, 10, null, :a, :e)`],
  bootstrap_workspace: ['P-01', `select case_api.bootstrap_workspace(:u, 'pm-made', 'PM made', :a, :e) is not null`],
  admin_provision_facilitator: ['P-03', `select true from (select case_api.admin_provision_facilitator(${TARGET}, ${W}, :u, :a, :e)) x`, { adminOnly: true }],
  admin_set_workspace_owner: ['P-04', `select true from (select case_api.admin_set_workspace_owner(${W}, ${TARGET}, :u, :a, :e)) x`],
  admin_set_version_state: ['P-16', `select count(*) = 1 from case_api.admin_set_version_state(${VERSION}, 0, 'withdraw', :u, :a, :e, :j)`, { adminOnly: true }],
  admin_transition_profile: ['P-06', `select count(*) = 1 from case_api.admin_transition_profile(${TARGET}, 0, 'disable', :a, :e)`],
  admin_revert_profile: ['P-06', `select count(*) >= 0 from case_api.admin_revert_profile(${TARGET}, 0, null, null, null, :a, :e)`],
  // P-41: an admin corrects an account's facilitator Name & role (CAS on admin_revision; the Worker holds the step-up).
  // Facilitator-UX A2 (CASE-336–339, CASE-342). Case-keyed images follow P-14 on the case; storage and Delete unused are
  // admin paths (P-45 read, P-16 with the step-up); sharing is P-43; policies P-45; invitations P-03 (workspace) and P-44.
  builder_case_media_put_allowance: ['P-14', `select case_api.builder_case_media_put_allowance(${CASE}, :u, :a, :e, repeat('6', 64), 4000, 'image/jpeg')`],
  builder_create_case_asset: ['P-14', `select (case_api.builder_create_case_asset(${CASE}, :u, :a, :e, ${MEDIA_CASE}, null))->>'status' = 'quarantined'`],
  builder_list_case_assets: ['P-14', `select jsonb_typeof(case_api.builder_list_case_assets(${CASE}, :u, :a, :e, null)) = 'array'`],
  builder_case_asset_rendition: ['P-14', `select count(*) >= 0 from case_api.builder_case_asset_rendition(${CASE}, case_app.uuid_v7(), 'display', :u, :a, :e)`],
  admin_workspace_storage: ['P-45', `select case_api.admin_workspace_storage(:u, ${W}, :a, :e) is not null`, { adminOnly: true }],
  admin_delete_unused_assets: ['P-16', `select case_api.admin_delete_unused_assets(:u, ${W}, array[case_app.uuid_v7()], :j, :a, :e) is not null`, { adminOnly: true }],
  list_case_access: ['P-43', `select case_api.list_case_access(:u, ${CASE}, :a, :e) is not null`],
  revoke_case_grant: ['P-43', `select (case_api.revoke_case_grant(:u, ${GRANT}, :a, :e))->>'outcome' = 'revoked'`],
  admin_set_workspace_policies: ['P-45', `select case_api.admin_set_workspace_policies(:u, ${W}, (select revision from case_app.workspace_policies where workspace_id = ${W}), '{}'::jsonb, null, :a, :e) is not null`],
  create_invitation: ['P-03', `select (case_api.create_invitation(:u, ${W}, null, 'run', 'pm-invitee@example.org', sha256(convert_to('pm-ref', 'UTF8')), null, :a, :e))->>'outcome' = 'created'`],
  list_invitations: ['P-44', `select case_api.list_invitations(:u, ${W}, null, :a, :e) is not null`],
  resend_invitation: ['P-44', `select (case_api.resend_invitation(:u, ${INVITATION}, sha256(convert_to('pm-new-ref', 'UTF8')), :a, :e))->>'outcome' = 'resend'`],
  revoke_invitation: ['P-44', `select (case_api.revoke_invitation(:u, ${INVITATION}, :a, :e))->>'outcome' = 'revoked'`],
  admin_set_facilitator_label: ['P-41', `select count(*) = 1 from case_api.admin_set_facilitator_label(${TARGET}, (select admin_revision from case_app.profiles where id = ${TARGET}), 'PM Name', 'Registrar', :a, :e)`],
});
export const RPC_UNBOUND = Object.freeze({
  beta_issue_dispatch: 'verified Worker account/capability envelope; dedicated beta-issues SQL assertions cover own/admin/incident scopes',
  beta_issue_sweep: 'system-only beta evidence retention and private object deletion queue',
  media_purge_claim: 'hourly image retention sweep (system actor); leases storage keys only',
  media_purge_complete: 'hourly image retention sweep (system actor); marks leased keys deleted',
  media_known_keys: 'hourly orphan sweep (system actor); answers which storage keys a live image names',
  media_sweep_position: 'hourly orphan sweep (system actor); where the bounded walk resumes',
  builder_cleanup_expired_state: 'hourly bounded expiry cleanup with no user-selected authority',
  purge_abandoned_lobbies:'hourly bounded 30-day abandoned-Lobby cleanup; system only, no user-selected authority',
  ensure_profile: 'the verified caller\'s own profile row',
  set_own_facilitator_label: 'the verified caller\'s own Name & role (P-40); the Worker passes only the JWT subject',
  admin_read_facilitator_labels: 'deployment read behind the Worker admin gate',
  set_session_facilitator_label: 'the room\'s label, written once by the Worker right after create_session for the room it just created',
  list_owned_active_sessions: 'the caller\'s own live rooms, filtered to current membership or admin (db PM-rooms)',
  get_session_workspace: 'an id lookup the Worker makes after the room DO verified the starter (db PM-22)',
  record_admin_elevation: 'issued only after the Worker verified an email code for the signed-in admin',
  resolve_join_code: 'participant capability path, enforced in the room DO',
  feedback_resolve: 'public session facts behind a feedback code, which grants one anonymous response only (CASE-284)',
  feedback_upsert: 'one anonymous response per respondent hash; the Worker derives the hash from a DO-verified participant credential or a browser key (CASE-284)',
  feedback_mine: 'the respondent\'s own response, keyed by the same respondent hash (CASE-284)',
  session_feedback_code: 'the room\'s feedback code for its Durable Object, read by the Worker after create_session; null once closed (CASE-284)',
  set_session_debrief: 'the room DO marks its own session in Debrief, which opens feedback before End, and clears it on Back to the case; never an ended room (CASE-291)',
  finalize_session_portfolio: 'trusted room DO final attestation; verifies exact version, contiguous journal and closed rounds in SQL',
  archive_session_batch: 'room DO archive writer', end_session: 'room DO archive writer',
  purge_expired_participant_data: 'retention job', retention_status: 'ops probe behind the deploy-guard token',
  ping: 'keepalive', heartbeats: 'keepalive', lockdown_alerts_since: 'alert poller',
  admin_account_active: 'account activity read used by every gate',
  admin_teaching_workspace_exists: 'deployment read behind the Worker admin gate',
  admin_read_profiles: 'deployment read behind the Worker admin gate',
  admin_read_case_version: 'deployment read behind the Worker admin gate',
  list_admin_case_versions: 'deployment read behind the Worker admin gate',
  list_admin_audit: 'deployment read behind the Worker admin gate (P-07)',
  write_admin_audit: 'deployment audit writer; carries the actor email itself',
  claim_admin_stepup_attempt: 'step-up rate limiter; carries the actor email itself',
  list_admin_due_profiles: 'scheduled hard-delete sweep (system actor)',
  admin_claim_due_profile_deletion: 'scheduled hard-delete sweep; needs a matching audit intent',
  admin_delete_due_profile: 'scheduled hard-delete sweep; needs the claim',
  personal_record_workspaces: 'P-32 self-only paged historical workspace discovery; owner-scoped tests in workspace-case-management.test.sql',
  personal_record_workspace_access: 'P-32 own-only historical scope admission; central authorize_records and explicit negative SQL tests',
  workspace_details: 'P-12: current workspace name and revision; separately covered by workspace-case-management.test.sql',
  update_workspace_details: 'P-17: owner/admin name CAS; separately covered by workspace-case-management.test.sql',
  case_workspace_access: 'P-11 case-aware read; home management gates destination and additional access inventory; workspace-case-management.test.sql',
  set_case_workspace_access: 'Composed P-17 home + P-14 destination; revocation needs home management only; workspace-case-management.test.sql',
  move_case_workspace: 'Composed P-17 in both workspaces; no case-only grant; CAS and in-use fences; workspace-case-management.test.sql',
  get_access: 'the caller\'s own membership, grant and policies on one place, read by the Worker\'s authorize; grants nothing',
  list_shared_cases: 'the caller\'s own live case grants ("Shared with you", CASE-336); each reaches only its case',
  record_invitation_delivery: 'send bookkeeping the Worker writes after a create or resend it was authorized for (CASE-339)',
  peek_invitation: 'P-46: the reference holder\'s read (capability, CASE-341); address, inviter, place and level of a live invitation only',
  accept_invitations: 'the verified caller\'s own invitations, matched to the verified email in auth.users (CASE-339)',
  purge_invitation_addresses: 'retention job: nulls ended invitations\' addresses after 30 days',
  version_case: 'an id lookup the Worker makes before a case-only holder\'s version read (ruling R7); authorizes nothing',
  admin_read_access: 'deployment read behind the Worker admin gate: each listed account\'s workspace roles and live case grants (A5 People); authorizes nothing',
});


/** The exact signature (pg regprocedure arguments) each bound or unbound RPC name stands for. */
export const RPC_SIGNATURES = Object.freeze({
  beta_issue_dispatch: 'jsonb,text,jsonb', beta_issue_sweep: 'text,jsonb',
  builder_list_assets: 'uuid,uuid,boolean,text,uuid[]',
  builder_media_put_allowance: 'uuid,uuid,boolean,text,text,integer,text',
  builder_set_asset_attestation: 'uuid,uuid,boolean,boolean,uuid,boolean,text',
  builder_create_asset: 'uuid,uuid,boolean,text,jsonb,jsonb,jsonb,jsonb',
  builder_asset_rendition: 'uuid,uuid,text,uuid,boolean,text',
  admin_review_asset: 'uuid,uuid,text,jsonb,text[],uuid,boolean,text',
  room_media_manifest: 'uuid,uuid,uuid,boolean,text',
  admin_withdraw_asset: 'uuid,uuid,text,uuid,boolean,text,uuid',
  media_purge_claim: 'integer',
  media_purge_complete: 'text[]',
  media_known_keys: 'text[]',
  media_sweep_position: 'text',
  builder_cleanup_expired_state: 'uuid',
  purge_abandoned_lobbies:'integer',
  query_teaching_session_portfolio:'uuid,uuid,text,text,timestamp with time zone,timestamp with time zone,uuid,boolean,boolean,text,uuid',
  personal_teaching_portfolio_stats:'uuid,uuid,boolean,text',
  builder_create_checkpoint: 'uuid,text,bigint,uuid,boolean,text',
  builder_delete_checkpoint: 'uuid,uuid,uuid,boolean,text',
  builder_archive_case: 'uuid,uuid,text,boolean,text',
  builder_list_drafts: 'uuid,integer,integer,uuid,boolean,text',
  builder_list_draft_summaries: 'uuid,integer,integer,uuid,boolean,text',
  builder_get_draft: 'uuid,uuid,boolean,text',
  builder_get_save_receipt: 'uuid,uuid,uuid,boolean,text',
  builder_list_checkpoints: 'uuid,uuid,boolean,text',
  builder_open_save_window: 'uuid,bigint,uuid,boolean,text',
  builder_restore_checkpoint: 'uuid,uuid,uuid,uuid,boolean,text',
  builder_save_draft: 'uuid,uuid,jsonb,jsonb,uuid,boolean,text',
  builder_publication_readiness: 'uuid,bigint,uuid,boolean,text',
  builder_submit_candidate: 'uuid,uuid,bigint,jsonb,jsonb,uuid,boolean,text',
  builder_list_candidates: 'uuid,uuid,boolean,text',
  builder_get_review_candidate: 'uuid,uuid,uuid,boolean,text',
  builder_cancel_candidate: 'uuid,uuid,uuid,boolean,text',
  builder_delete_candidate_body: 'uuid,uuid,uuid,boolean,text',
  builder_approve_candidate: 'uuid,uuid,bigint,bytea,bytea,uuid,boolean,text',
  builder_release_candidate: 'uuid,uuid,bigint,bytea,bytea,uuid[],jsonb,uuid,boolean,text',
  builder_release_update: 'uuid,uuid,bigint,bytea,bytea,uuid[],jsonb,boolean,uuid,boolean,text',

  get_me: 'uuid,integer,uuid,uuid,boolean,text',
  list_published_versions: 'uuid,uuid,integer,uuid,boolean,text',
  list_case_catalogue: 'uuid,uuid,text,boolean,text,integer,text,integer,integer,uuid,boolean,boolean,text',
  list_case_catalogue_current: 'uuid,uuid,text,boolean,text,integer,text,integer,integer,uuid,boolean,boolean,text',
  list_case_catalogue_groups: 'uuid,uuid,boolean,text',
  list_groups: 'uuid,uuid,boolean,text',
  get_case_group: 'uuid,uuid,boolean,text',
  create_group: 'uuid,uuid,text,text,text,boolean,text',
  edit_group: 'uuid,uuid,uuid,bigint,text,text,text,boolean,text',
  archive_group: 'uuid,uuid,uuid,bigint,text,uuid,boolean,text,uuid',
  assign_case_group: 'uuid,uuid,uuid,bigint,uuid,boolean,text',
  list_case_catalogue_audiences: 'uuid,uuid,boolean,text',
  get_catalogue_case: 'uuid,uuid,integer,boolean,text',
  get_catalogue_case_current: 'uuid,uuid,integer,boolean,text',
  get_catalogue_case_history: 'uuid,uuid,integer,boolean,text',
  create_case: 'uuid,uuid,text,boolean,text',
  get_case_authoring_access: 'uuid,uuid,boolean,text',
  get_draft: 'uuid,uuid,boolean,text',
  save_draft: 'uuid,bigint,integer,jsonb,uuid,boolean,text',
  get_case_version_for_workspace: 'uuid,uuid,uuid,boolean,text',
  create_session: 'uuid,uuid,uuid,uuid,text,interval,boolean,text',
  list_workspace_audit: 'uuid,uuid,integer,uuid,boolean,text',
  finalize_session_portfolio: 'uuid,uuid,bigint,integer,bigint,integer,integer',
  resolve_catalogue_case:'uuid,uuid,boolean,text',
  query_case_session_portfolio:'uuid,uuid,text,text,timestamp with time zone,timestamp with time zone,uuid,boolean,boolean,text,uuid',
  query_session_portfolio: 'uuid,uuid,text,text,timestamp with time zone,timestamp with time zone,uuid,boolean,boolean,text',
  personal_portfolio_stats: 'uuid,uuid,boolean,text',
  read_session_portfolio: 'uuid,uuid,bigint,text,boolean,text',
  session_media_rendition: 'uuid,uuid,uuid,boolean,text',
  session_feedback_summary: 'uuid,uuid,boolean,text',
  case_feedback_summary: 'uuid,uuid,integer,boolean,text',
  admin_feedback_page: 'uuid,jsonb,integer,boolean,text',
  list_room_history: 'uuid,uuid,text,integer,timestamp with time zone,uuid,boolean,text',
  admin_list_workspaces: 'uuid,uuid,boolean,text',
  admin_workspace_query: 'uuid,uuid,text,text,text,timestamp with time zone,timestamp with time zone,uuid,boolean,text',
  admin_change_membership: 'uuid,uuid,text,text,uuid,bigint,text,uuid,boolean,text',
  admin_query_operations: 'uuid,text,uuid,boolean,text',
  bootstrap_workspace: 'uuid,text,text,boolean,text',
  admin_provision_facilitator: 'uuid,uuid,uuid,boolean,text',
  admin_set_workspace_owner: 'uuid,uuid,uuid,boolean,text',
  admin_set_version_state: 'uuid,bigint,text,uuid,boolean,text,uuid',
  admin_transition_profile: 'uuid,bigint,text,boolean,text',
  admin_revert_profile: 'uuid,bigint,timestamp with time zone,timestamp with time zone,timestamp with time zone,boolean,text',
  admin_set_facilitator_label: 'uuid,bigint,text,text,boolean,text',
  set_own_facilitator_label: 'uuid,text,text',
  admin_read_facilitator_labels: 'uuid[]',
  set_session_facilitator_label: 'uuid,text',
  ensure_profile: 'uuid,text',
  list_owned_active_sessions: 'uuid,integer,uuid,boolean,text',
  get_session_workspace: 'uuid',
  record_admin_elevation: 'uuid,text,text,uuid',
  resolve_join_code: 'text',
  feedback_resolve: 'text',
  feedback_upsert: 'uuid,bytea,text,jsonb,integer',
  feedback_mine: 'uuid,bytea',
  session_feedback_code: 'uuid',
  set_session_debrief: 'uuid,boolean',
  archive_session_batch: 'uuid,jsonb',
  end_session: 'uuid,bigint,integer',
  purge_expired_participant_data: 'interval',
  retention_status: 'uuid',
  ping: '',
  heartbeats: '',
  lockdown_alerts_since: 'timestamp with time zone,integer,uuid',
  admin_account_active: 'uuid',
  admin_teaching_workspace_exists: 'uuid',
  admin_read_profiles: 'uuid[]',
  admin_read_case_version: 'uuid',
  list_admin_case_versions: 'integer,uuid',
  list_admin_audit: 'integer,uuid',
  write_admin_audit: 'uuid,uuid,text,text,text,uuid,text,jsonb,jsonb,cidr',
  claim_admin_stepup_attempt: 'uuid,text,text,cidr',
  list_admin_due_profiles: 'integer,uuid',
  admin_claim_due_profile_deletion: 'uuid,bigint,uuid',
  admin_delete_due_profile: 'uuid,bigint',
  builder_case_media_put_allowance: 'uuid,uuid,boolean,text,text,integer,text',
  builder_create_case_asset: 'uuid,uuid,boolean,text,jsonb,jsonb,jsonb,jsonb',
  builder_list_case_assets: 'uuid,uuid,boolean,text,uuid[]',
  builder_case_asset_rendition: 'uuid,uuid,text,uuid,boolean,text',
  admin_workspace_storage: 'uuid,uuid,boolean,text',
  admin_delete_unused_assets: 'uuid,uuid,uuid[],uuid,boolean,text',
  personal_record_workspaces: 'uuid,uuid',
  personal_record_workspace_access: 'uuid,uuid',
  workspace_details: 'uuid,uuid,boolean,text',
  update_workspace_details: 'uuid,uuid,bigint,text,boolean,text',
  case_workspace_access: 'uuid,uuid,boolean,text',
  set_case_workspace_access: 'uuid,uuid,uuid,text,bigint,boolean,text',
  move_case_workspace: 'uuid,uuid,uuid,bigint,boolean,text',
  get_access: 'uuid,uuid,uuid,boolean,text',
  list_shared_cases: 'uuid',
  list_case_access: 'uuid,uuid,boolean,text',
  revoke_case_grant: 'uuid,uuid,boolean,text',
  admin_set_workspace_policies: 'uuid,uuid,bigint,jsonb,bigint,boolean,text',
  create_invitation: 'uuid,uuid,uuid,text,text,bytea,uuid,boolean,text',
  list_invitations: 'uuid,uuid,uuid,boolean,text',
  resend_invitation: 'uuid,uuid,bytea,boolean,text',
  record_invitation_delivery: 'uuid,text,timestamp with time zone',
  revoke_invitation: 'uuid,uuid,boolean,text',
  peek_invitation: 'bytea',
  accept_invitations: 'uuid,text',
  purge_invitation_addresses: '',
  version_case: 'uuid',
  admin_read_access: 'uuid[]',
});
/**
 * Expand-window overloads (PERMISSIONS §7.1): the old signatures the previous Workers still called, kept by the
 * expand migrations. The card 35 CONTRACT migration (20261010000000_permissions_contract.sql, card 35b;
 * docs/RUNBOOK-INCIDENT.md §Card 35 database rollout, step 4) dropped its set. Card 62's expand step
 * (20261103000000_asset_review_fence.sql) kept the unfenced six-argument admin_review_asset for the Worker deployed
 * before it; its contract step (20261105000000_asset_review_contract.sql) dropped it. The list is empty again, so the
 * generated PM-rpc test fails if any old signature comes back. A future expand step lists its old signatures here.
 */
export const EXPAND_WINDOW = Object.freeze([]);

function rpcChecks() {
  const people = [['admin', U('05'), true], ['owner', U('01'), false], ['author', U('02'), false],
    ['facilitator', U('03'), false], ['outsider', U('04'), false], ['removed', U('08'), false], ['disabled', U('06'), false]];
  const lines = [];
  for (const [name, [action, sql, opts = {}]] of Object.entries(RPC_BINDINGS)) {
    for (const [who, id, admin] of people) {
      const allowed = who === 'admin' ? adminReaches(action)
        : ['owner', 'author', 'facilitator'].includes(who) && !opts.adminOnly && sqlAllowsAtDefaults(action, who);
      const call = sql.replace(/:u(?![A-Za-z_])/g, id).replace(/:a(?![A-Za-z_])/g, String(admin))
        .replace(/:e(?![A-Za-z_])/g, admin ? `'pm-admin@example.org'` : 'null')
        .replace(/:j(?![A-Za-z_])/g, admin ? U('1f') : 'null');
      if (who === 'admin' && name === 'builder_get_review_candidate') lines.push(`  insert into pg_temp.pm_builder_test_candidates(kind,candidate_id) values ('review',pg_temp.pm_builder_candidate(${REVIEW_CASE}));`);
      if (who === 'admin' && name === 'builder_cancel_candidate') lines.push(`  insert into pg_temp.pm_builder_test_candidates(kind,candidate_id) values ('cancel',pg_temp.pm_builder_cancelled_candidate(${CANCEL_CASE}));`);
      lines.push(`  perform pg_temp.pm_rpc('${name}', '${who}', ${allowed}, $c$${call}$c$);`);
    }
  }
  const names = [...Object.keys(RPC_BINDINGS), ...Object.keys(RPC_UNBOUND)];
  for (const name of names) if (!Object.hasOwn(RPC_SIGNATURES, name)) throw new Error(`no signature for ${name}`);
  const expected = [...names.map(name => `case_api.${name}(${RPC_SIGNATURES[name]})`), ...EXPAND_WINDOW].sort().map(n => `'${n}'`).join(',\n    ');
  return `-- [PM-rpc] every service-callable case_api SIGNATURE is bound to a matrix row, unbound with a reason, or on the
-- expand-window list; no listed signature may be missing (the contract migration empties the expand list).
do $$
declare v_extra text; v_missing text; v_expected text[] := array[
    ${expected}];
begin
  select string_agg(s, ', ') into v_extra from (
    select p.oid::regprocedure::text as s from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'case_api' and has_function_privilege('service_role', p.oid, 'execute')) x
   where s <> all (v_expected);
  if v_extra is not null then raise exception 'PM-rpc: unclassified case_api signature(s): %', v_extra; end if;
  select string_agg(e, ', ') into v_missing from unnest(v_expected) e
   where not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'case_api' and p.oid::regprocedure::text = e and has_function_privilege('service_role', p.oid, 'execute'));
  if v_missing is not null then raise exception 'PM-rpc: listed signature(s) not service-callable: %', v_missing; end if;
end;
$$;
create temp table pm_builder_test_candidates(kind text primary key,candidate_id uuid not null);
create function pg_temp.pm_builder_ready_draft(p_case_id uuid)
returns table(revision bigint,document jsonb,authoring_metadata jsonb) language plpgsql as $pm$
declare operation uuid; current_revision bigint;
begin
  select d.revision into current_revision from case_app.case_drafts d where d.case_id=p_case_id;
  select operation_id into operation from case_api.builder_open_save_window(p_case_id,current_revision,${U('02')},false,null);
  perform 1 from case_api.builder_save_draft(p_case_id,operation,(select doc from pm_doc),
    '{"metadata_version":1,"sources":[],"provenance":[]}'::jsonb,${U('02')},false,null);
  return query select d.revision,d.document,d.authoring_metadata from case_app.case_drafts d where d.case_id=p_case_id;
end; $pm$;
create function pg_temp.pm_builder_candidate(p_case_id uuid)
returns uuid language plpgsql as $pm$
declare candidate uuid;
begin
  select submitted.candidate_id into candidate from pg_temp.pm_builder_ready_draft(p_case_id) d
    cross join lateral case_api.builder_submit_candidate(p_case_id,case_app.uuid_v7(),d.revision,d.document,d.authoring_metadata,${U('02')},false,null) submitted;
  return candidate;
end; $pm$;
create function pg_temp.pm_builder_cancelled_candidate(p_case_id uuid)
returns uuid language plpgsql as $pm$
declare candidate uuid;
begin
  candidate:=pg_temp.pm_builder_candidate(p_case_id);
  perform 1 from case_api.builder_cancel_candidate(p_case_id,candidate,${U('02')},false,null);
  perform 1 from case_api.builder_delete_candidate_body(p_case_id,candidate,${U('02')},false,null);
  return candidate;
end; $pm$;
create function pg_temp.pm_builder_receipt(c uuid, u uuid, a boolean, e text)
returns setof case_app.builder_save_windows language plpgsql as $pm$
declare ticket uuid;
begin
  select operation_id into ticket from case_api.builder_open_save_window(c, 1, u, a, e);
  if not exists (select 1 from case_api.builder_get_save_receipt(c, ticket, u, a, e) where status = 'issued') then
    raise exception 'PM-builder: fresh issued operation is not readable';
  end if;
  return query select * from case_app.builder_save_windows where operation_id = ticket;
end; $pm$;
-- [PM-rpc] each bound RPC, called as every principal, lets through exactly whom its matrix row names.
do $$
begin
${lines.join('\n')}
  raise notice 'ok PM-rpc ${Object.keys(RPC_BINDINGS).length} bound RPCs x 7 principals match the matrix';
end;
$$;`;
}
/** The generated SQL matrix test: every R row, every principal the database can see. */
export function sqlFixture() {
  const checks = [];
  for (const id of SQL_ACTIONS) {
    checks.push(`  if case_app.action_roles('${id}') is distinct from ${sqlArray(sqlRolesFor(id))} or case_app.action_admin('${id}') is distinct from ${adminReaches(id)}
     or case_app.action_case_roles('${id}') is distinct from ${sqlArray(caseRolesFor(id))} then
    raise exception 'PM-matrix: role table drift at ${id}'; end if;`);
    // P-01 and P-03 create the workspace or the membership; they are checked through their RPCs instead.
    if (['P-01', 'P-03'].includes(id)) continue;
    for (const role of ['owner', 'author', 'facilitator']) {
      const expect = sqlAllowsAtDefaults(id, role);
      checks.push(`  perform pg_temp.pm_expect('${id}', ${U(role === 'owner' ? '01' : role === 'author' ? '02' : '03')}, false, null, ${expect});`);
    }
    checks.push(`  perform pg_temp.pm_expect('${id}', ${U('04')}, false, null, false); -- a member of another workspace`);
    checks.push(`  perform pg_temp.pm_expect('${id}', null, false, null, false); -- signed out`);
    checks.push(`  perform pg_temp.pm_expect('${id}', ${U('05')}, true, 'pm-admin@example.org', ${adminReaches(id)}); -- admin, no membership`);
    checks.push(`  perform pg_temp.pm_expect('${id}', ${U('05')}, true, null, false); -- admin flag without email`);
    checks.push(`  perform pg_temp.pm_expect('${id}', ${U('05')}, false, null, false); -- the same person without the flag`);
    checks.push(`  perform pg_temp.pm_expect('${id}', ${U('06')}, false, null, false); -- a disabled owner`);
  }
  // [PM-policy] each policy flips exactly its rows' policy cells; only a JSON true is on.
  const allOn = JSON.stringify(Object.fromEntries(Object.keys(POLICIES).map(k => [k, true])));
  const allOff = JSON.stringify(Object.fromEntries(Object.keys(POLICIES).map(k => [k, false])));
  const policyChecks = [];
  const expectPolicy = (id, role, json, want) => policyChecks.push(
    `  if case_app.policy_allows('${id}', '${role}', '${json}'::jsonb) is distinct from ${want} then raise exception 'PM-policy: ${id} ${role} under ${json.replace(/'/g, "''")}'; end if;`);
  for (const id of Object.keys(MATRIX)) for (const role of WORKSPACE_ROLES) {
    const governed = policyRolesFor(id).includes(role);
    expectPolicy(id, role, allOn, governed);
    if (!Object.hasOwn(POLICY_OF, id)) continue; // a row with no policy: every policy on still grants nothing
    expectPolicy(id, role, allOff, false);
    for (const key of Object.keys(POLICIES)) expectPolicy(id, role, JSON.stringify({ [key]: true }), governed && POLICY_OF[id] === key);
    if (governed) expectPolicy(id, role, JSON.stringify({ [POLICY_OF[id]]: 'true' }), false);
  }
  for (const id of policyRows()) {
    expectPolicy(id, 'admin', allOn, false);
    expectPolicy(id, 'outsider', allOn, false);
    policyChecks.push(`  if case_app.policy_allows('${id}', '${policyRolesFor(id)[0]}', null) is distinct from false then raise exception 'PM-policy: ${id} with no policies'; end if;`);
  }
  policyChecks.push(`  if case_app.policy_allows('P-99', 'owner', '${allOn}'::jsonb) is distinct from false then raise exception 'PM-policy: unknown action'; end if;`);
  policyChecks.push(`  if case_app.action_case_roles('P-99') is not null then raise exception 'PM-matrix: unknown action has case roles'; end if;`);
  return `-- db/tests/permission-matrix.test.sql: GENERATED by scripts/gen-permissions.mjs from src/shared/permissions.mjs,
-- which tests/permissions-matrix.test.mjs checks against docs/PERMISSIONS.md §4. Do not edit by hand.
-- [PM-matrix] case_app.authorize grants each R row exactly to the principals the matrix names.
\\set QUIET on
begin;
insert into auth.users values (${U('01')}), (${U('02')}), (${U('03')}), (${U('04')}), (${U('05')}), (${U('06')}),
  (${U('08')}), (${U('09')});
update auth.users set email='pm-author@example.org' where id=${U('02')};
insert into case_app.profiles (id, display_name) values (${U('01')}, 'PM owner'), (${U('02')}, 'PM author'),
  (${U('03')}, 'PM facilitator'), (${U('04')}, 'PM outsider'), (${U('06')}, 'PM disabled'), (${U('08')}, 'PM removed'),
  (${U('09')}, 'PM target');
insert into case_app.workspaces (id, slug, name) values (${U('0a')}, 'pm-home', 'PM home'), (${U('0b')}, 'pm-other', 'PM other');
insert into case_app.workspace_members (workspace_id, user_id, role) values
  (${U('0a')}, ${U('01')}, 'owner'), (${U('0a')}, ${U('02')}, 'author'), (${U('0a')}, ${U('03')}, 'facilitator'),
  (${U('0b')}, ${U('04')}, 'owner'), (${U('0a')}, ${U('06')}, 'owner');
update case_app.profiles set disabled_at = now() where id = ${U('06')};
-- A former author, removed from the workspace.
insert into case_app.workspace_members (workspace_id, user_id, role) values (${U('0a')}, ${U('08')}, 'author');
delete from case_app.workspace_members where user_id = ${U('08')};
-- One case with a draft at revision 1 and a published version 1; a step-up recorded for the admin.
create temp table pm_doc as select d as doc,
  case_app.art_structure(d) || '{"attempt":0,"summarised":false,"renderer":1}'::jsonb as art
  from (select '{"schema_version":1,"start_beat_id":"a","beats":[{"id":"a","kind":"debrief"}],"decisions":[]}'::jsonb as d) x;
insert into case_app.cases (id, workspace_id, owner_id, title) values (${U('c1')}, ${U('0a')}, ${U('02')}, 'PM case');
insert into case_app.case_drafts (case_id, revision, schema_version, document, updated_by)
  select ${U('c1')}, 1, 1, doc, ${U('02')} from pm_doc;
insert into case_app.case_versions (id, case_id, version_no, schema_version, document, content_sha256, published_by)
  select ${U('e1')}, ${U('c1')}, 1, 1, doc, sha256(convert_to(doc::text, 'UTF8')), ${U('02')} from pm_doc;
-- Own records for every allowed workspace principal; an admin can inspect the owner's record.
insert into case_app.sessions(id,case_version_id,workspace_id,facilitator_id,join_code,expires_at) values
 (${U('01')},${U('e1')},${W},${U('01')},'PM0001',now()+interval '1 hour'),
 (${U('02')},${U('e1')},${W},${U('02')},'PM0002',now()+interval '1 hour'),
 (${U('03')},${U('e1')},${W},${U('03')},'PM0003',now()+interval '1 hour'),
 (${U('f1')},${U('e1')},${W},${U('01')},'PM0004',now()+interval '1 hour');
-- Separate Builder review fixtures keep candidate lifecycle transitions away from legacy draft/publish fixtures.
insert into case_app.cases (id, workspace_id, owner_id, title) values
  (${U('c2')}, ${U('0a')}, ${U('02')}, 'PM legacy draft case'),
  (${U('c3')}, ${U('0a')}, ${U('02')}, 'PM review case'), (${U('c4')}, ${U('0a')}, ${U('02')}, 'PM cancellation case');
insert into case_app.case_drafts (case_id, revision, schema_version, document, updated_by)
  select ${U('c2')}::uuid, 1, 1, doc, ${U('02')}::uuid from pm_doc
union all select ${U('c3')}::uuid, 1, 1, doc, ${U('02')}::uuid from pm_doc
union all select ${U('c4')}::uuid, 1, 1, doc, ${U('02')}::uuid from pm_doc;
select case_api.record_admin_elevation(${U('1f')}, 'pm-admin@example.org', 'admin', ${U('0f')});
-- A2: one live Can run grant (on the PM case, for the target account) and one pending invitation, for the share and
-- invitation RPCs.
insert into case_app.case_grants (id, case_id, workspace_id, user_id, level) values (${GRANT}, ${U('c1')}, ${U('0a')}, ${U('09')}, 'run');
insert into case_app.invitations (id, workspace_id, level, email, ref_hash, inviter_kind, expires_at)
  values (${INVITATION}, ${U('0a')}, 'run', 'pm-pending@example.org', sha256(convert_to('pm-pending', 'UTF8')), 'admin', now() + interval '30 days');
-- One live group (card 30) for the group RPCs.
insert into case_app.case_groups (id, workspace_id, name, tint) values (${U('a1')}, ${U('0a')}, 'PM group', 'sage');

create function pg_temp.pm_expect(p_action text, p_user uuid, p_admin boolean, p_email text, p_allowed boolean)
returns void language plpgsql as $f$
declare v_role text;
begin
  begin
    v_role := case_app.authorize(p_user, ${U('0a')}, p_action, p_admin, p_email);
  exception when insufficient_privilege then v_role := null;
  end;
  if (v_role is not null) <> p_allowed then
    raise exception 'PM-matrix: % for user % (admin %) expected allowed=% got role %', p_action, p_user, p_admin, p_allowed, v_role;
  end if;
end;
$f$;

-- Calls one RPC and always rolls it back, so every principal meets the same state. Only 42501 is a refusal;
-- any other error fails the test (an allowed principal must get all the way through).
create function pg_temp.pm_rpc(p_name text, p_who text, p_allowed boolean, p_sql text)
returns void language plpgsql as $f$
declare v boolean; v_granted boolean; v_candidate uuid;
begin
  begin
    if p_name in ('builder_get_review_candidate','builder_approve_candidate','builder_release_candidate','builder_release_update') then
      select candidate_id into v_candidate from pg_temp.pm_builder_test_candidates where kind='review';
      if v_candidate is null then raise exception 'PM-builder: review candidate fixture missing'; end if;
      p_sql:=replace(p_sql,'$candidate',quote_literal(v_candidate::text));
    elsif p_name in ('builder_cancel_candidate','builder_delete_candidate_body') then
      select candidate_id into v_candidate from pg_temp.pm_builder_test_candidates where kind='cancel';
      if v_candidate is null then raise exception 'PM-builder: cancelled candidate fixture missing'; end if;
      p_sql:=replace(p_sql,'$candidate',quote_literal(v_candidate::text));
    end if;
    execute p_sql into v;
    raise exception using errcode = 'XPM01', message = coalesce(v::text, 'null');
  exception
    when sqlstate 'XPM01' then v_granted := sqlerrm = 'true';
    when insufficient_privilege then v_granted := false;
  end;
  if v_granted <> p_allowed then
    raise exception 'PM-rpc: % as % expected allowed=% got %', p_name, p_who, p_allowed, v_granted;
  end if;
end;
$f$;

do $$
begin
${checks.join('\n')}
end;
$$;
-- [PM-policy] case_app.policy_allows flips exactly the policy cells each workspace policy governs.
do $$
begin
${policyChecks.join('\n')}
  raise notice 'ok PM-policy ${policyChecks.length} policy checks';
end;
$$;
${rpcChecks()}
rollback;
`;
}

function main() {
  const check = process.argv.includes('--check');
  if (process.argv.includes('--sql')) { console.log(sqlRoleBlock()); return; }
  const problems = [];
  let rows = [];
  try { rows = parseMatrixTable(readFileSync(DOC, 'utf8')); } catch (error) { problems.push(`docs/PERMISSIONS.md §4: ${error.message}`); }
  if (rows.length) problems.push(...matrixDrift(rows));
  const latest = latestSqlBlock();
  if (!latest) problems.push('no migration carries the generated permission role block');
  else if (latest.block !== sqlRoleBlock()) problems.push(`${latest.file}: generated permission role block is stale (print the new one with --sql, in a NEW migration)`);
  const fixture = sqlFixture();
  if (check) {
    let current = null;
    try { current = readFileSync(SQL_FIXTURE, 'utf8'); } catch { /* missing */ }
    if (current !== fixture) problems.push('db/tests/permission-matrix.test.sql is stale: run node scripts/gen-permissions.mjs');
  } else writeFileSync(SQL_FIXTURE, fixture);
  if (problems.length) { console.error(`permission matrix drift:\n  ${problems.join('\n  ')}`); process.exitCode = 1; return; }
  console.log(check ? 'permission matrix: doc, shared module and SQL agree' : 'permission matrix: fixture written');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
