// History browser evidence uses the real Worker and production shell. Only the local SQL boundary
// supplies summaries/memberships; authorization, cursor parsing and public response shaping are real.
import { expect } from '@playwright/test';
import { uuidv7 } from '../../src/shared/ids.mjs';
import { historyUrl, accountUrl } from '../../src/shared/urls.mjs';
import { controlsCase, startControlsHarness } from './live-console-controls.mjs';

export async function startHistoryHarness() {
  const harness = await startControlsHarness(controlsCase());
  const workspaces = [harness.worker.workspaceId, ...Array.from({ length: 21 }, () => uuidv7())].sort()
    .map((workspace_id, index) => ({ workspace_id, name: `Workspace ${String(index + 1).padStart(2, '0')}`, role: 'owner' }));
  const makeRows = (count = 23, title = 'Every Breath You Take') => Array.from({ length: count }, (_, index) => {
    const created = new Date(Date.now() - (index + 1) * 60_000).toISOString();
    return { session_id: uuidv7(), case_id: harness.worker.caseId??uuidv7(), case_version_id: harness.worker.versionId, title,
      joined:18+index,joined_exact:false,version_no: 1, status: index === 22 ? 'ended' : 'live', created_at: created,
      started_at: created, ended_at: index === 22 ? created : null,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(), archive_state: index===22?'limited':'pending', own: true };
  }).sort((a,b)=>b.session_id.localeCompare(a.session_id));
  const state = { memberships: workspaces, rows: makeRows(), failMembershipPage: false,
    failInitialMe: false, removed: false, foreign: false, hold: null };
  const fake = harness.worker.fake;
  fake.replies.set('get_me', args => {
    let memberships = state.memberships;
    if (args.p_workspace_id !== null) memberships = state.removed ? [] : memberships.filter(row => row.workspace_id === args.p_workspace_id);
    else if (args.p_after !== null) memberships = memberships.filter(row => row.workspace_id > args.p_after);
    memberships = memberships.slice(0, args.p_limit);
    return [{ user_id: harness.worker.userId, display_name: 'History facilitator', admin: args.p_admin === true,
      memberships, next_after: args.p_workspace_id === null && memberships.length === args.p_limit ? memberships.at(-1).workspace_id : null }];
  });
  // Revocation must agree in inventory and exact-case lookup. A stale cached owner response would
  // legitimately retain own-record access under CASE-375 and invalidate the intended removal scenario.
  fake.replies.set('get_access', args => {
    expect(args.p_user_id).toBe(harness.worker.userId);
    const member = state.removed ? null : state.memberships.find(row => row.workspace_id === harness.worker.workspaceId);
    return member && args.p_case_id === harness.worker.caseId ? [{ workspace_id: harness.worker.workspaceId,
      case_id: args.p_case_id, member_role: member.role, grant_level: null, role: member.role,
      scope: 'workspace', policies: member.policies ?? {} }] : [];
  });
  fake.replies.set('query_teaching_session_portfolio', args => {
    expect(args.p_user_id).toBe(harness.worker.userId);expect(args.p_admin).toBe(false);expect(args.p_personal).toBe(true);
    const matches=state.rows.filter(row=>row.started_at!==null&&(!args.p_case_id||row.case_id===args.p_case_id)&&(args.p_status==='all'||(args.p_status==='ended'?['ended','expired'].includes(row.status):['live','lobby'].includes(row.status)))&&row.title.toLowerCase().includes(args.p_query.toLowerCase())&&(!args.p_after||row.session_id<args.p_after)&&(!args.p_from||row.created_at>=args.p_from)&&(!args.p_until||row.created_at<args.p_until));
    const page=matches.slice(0,20).map(({session_id,...r})=>({id:session_id,...r}));
    return {rooms:state.foreign?page.map(r=>({...r,own:false,title:'FOREIGN_ROOM_PRIVATE_SENTINEL'})):page,nextAfter:matches.length>20?page.at(-1).id:null};
  });
  fake.replies.set('query_case_session_portfolio', args => {
    expect(args.p_user_id).toBe(harness.worker.userId);expect(args.p_admin).toBe(false);expect(args.p_personal).toBe(true);
    const matches=state.rows.filter(row=>row.case_id===args.p_case_id&&(args.p_status==='all'||(args.p_status==='ended'?['ended','expired'].includes(row.status):['live','lobby'].includes(row.status)))&&row.title.toLowerCase().includes(args.p_query.toLowerCase())&&(!args.p_after||row.session_id<args.p_after)&&(!args.p_from||row.created_at>=args.p_from)&&(!args.p_until||row.created_at<args.p_until));
    const page=matches.slice(0,20).map(({session_id,...r})=>({id:session_id,...r}));
    return {rooms:state.foreign?page.map(r=>({...r,own:false,title:'FOREIGN_ROOM_PRIVATE_SENTINEL'})):page,nextAfter:matches.length>20?page.at(-1).id:null};
  });
  fake.replies.set('personal_teaching_portfolio_stats',()=>{const rows=state.rows.filter(r=>r.started_at!==null);return ({asOf:new Date().toISOString(),firstSessionAt:rows.at(-1)?.started_at??null,sessions:rows.length,active:rows.filter(r=>!['ended','expired'].includes(r.status)).length,ended:rows.filter(r=>['ended','expired'].includes(r.status)).length,completeRecords:0,uniqueVersions:rows.length?1:0,recordedTeachingSeconds:0});});
  fake.replies.set('read_session_portfolio',args=>{
    const row=state.rows.find(r=>r.session_id===args.p_session_id);if(!row)return null;
    return {session:{id:row.session_id,workspaceId:state.memberships[0].workspace_id,caseId:row.case_id,versionId:row.case_version_id,versionNo:row.version_no,digest:'a'.repeat(64),title:row.title,status:row.status,sourceStatus:'published',createdAt:row.created_at,startedAt:row.started_at,endedAt:row.ended_at,expiresAt:row.expires_at,own:true,manifest:null},boundary:'b'.repeat(64),document:controlsCase().doc,items:[],eventCount:0,maxSeq:0,nextPosition:null};
  });
  const base = fake.fetchImpl;
  fake.fetchImpl = async (input, init) => {
    const name = new URL(input).pathname.split('/').at(-1), args = JSON.parse(init.body);
    const refusedMe = name === 'get_me' && args.p_workspace_id === null &&
      (args.p_after === null ? state.failInitialMe : state.failMembershipPage);
    if (refusedMe) return Response.json({ code: 'XX000', message: 'Local test account read unavailable' }, { status: 503 });
    if (name === 'query_teaching_session_portfolio' && state.hold) {
      const hold = state.hold; state.hold = null; hold.started(); await hold.wait;
    }
    return base(input, init);
  };
  return { ...harness, state, workspaces, makeRows,
    calls: name => fake.requests.filter(row => row.name === name),
    holdNextHistory() {
      let started, release;
      const ready = new Promise(resolve => { started = resolve; }), wait = new Promise(resolve => { release = resolve; });
      state.hold = { started, wait }; return { ready, release };
    },
  };
}

export async function signInHistory(page, harness, mode = 'history') {
  await page.goto(mode === 'history' ? historyUrl(harness.shell.origin) : accountUrl(harness.shell.origin));
  await page.getByLabel('Email', { exact: true }).fill('owner@example.invalid');
  await page.getByRole('button', { name: 'Email me a sign-in code', exact: true }).click();
  await page.getByLabel('One-time code', { exact: true }).fill('123456');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: mode === 'history' ? 'Sessions' : 'Account', exact: true })).toBeVisible();
}

export function forbidRoomClaims(context) {
  const claims = [];
  context.on('request', request => {
    if (request.method() === 'POST' && /\/(?:facilitator-token|sessions)$/.test(new URL(request.url()).pathname)) {
      claims.push(new URL(request.url()).pathname);
    }
  });
  return claims;
}

export async function chooseHistory(page, name, label) {
  const trigger = page.getByRole('combobox', { name, exact: true });
  await trigger.click();
  await page.getByRole('listbox', { name, exact: true }).getByRole('option', { name: label, exact: true }).click();
  await expect(trigger).toHaveText(label);
}
