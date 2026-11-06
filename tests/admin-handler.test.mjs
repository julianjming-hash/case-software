import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAdminRequest } from '../src/worker/admin/handler.mjs';
import { ADMIN_ROUTES } from '../src/worker/admin/routes.mjs';
import { newCapabilityToken, uuidv7 } from '../src/shared/ids.mjs';
import { verifyElevation } from '../src/worker/admin/stepup.mjs';

const email = 'admin@example.test';
const SESSION = uuidv7();
const secret = newCapabilityToken();
const env = { ADMIN_EMAILS: email, CASE_PUBLIC_ORIGIN: 'https://case.invalid', STEPUP_SECRET: secret };
const request = (path, body = {}, headers = {}) => new Request(`https://case.invalid${path}`, {
  method: 'POST', headers: { authorization: 'Bearer local-test', origin: env.CASE_PUBLIC_ORIGIN,
    'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});
const services = ({ result = { ok: true, data: true }, otp = { ok: true }, verified = { ok: true } } = {}) => {
  const calls = [];
  const actorId = uuidv7();
  return {
    calls, actorId,
    verifyUser: async token => token ? { userId: actorId, email, sessionId: SESSION } : null,
    // Dedicated actor-cutoff test records this mandatory authorization RPC.
    rpc: { call: async (name, args) => {
      if (name === 'admin_account_active' && args.p_user_id === actorId) return {ok:true,data:true};
      if (name === 'admin_read_profiles') return {ok:true,data:[]};
      if (name === 'admin_read_facilitator_labels') return {ok:true,data:[]};
      if (name === 'admin_read_access') return {ok:true,data:[]};
      calls.push(['rpc', name, args]); return result;
    } },
    gotrue: {
      startStepUp: async address => { calls.push(['otp', address]); return otp; },
      verifyStepUp: async (address, code) => { calls.push(['verify', address, code]); return verified; },
    },
  };
};

test('[AS-086] Card 21a every admin route rejects missing and non-admin JWT before services', async () => {
  const deps = services();
  for (const route of ADMIN_ROUTES) {
    const path = route.template.replace(':id', uuidv7());
    const unauthenticated = new Request(`https://case.invalid${path}`, { method: route.method });
    const denied = await handleAdminRequest(unauthenticated, { env, ...deps,
      verifyUser: async () => null });
    assert.equal(denied.status, 401, route.key);
    const outsider = new Request(`https://case.invalid${path}`, {
      method: route.method, headers: { authorization: 'Bearer local-test' },
    });
    const forbidden = await handleAdminRequest(outsider, { env, ...deps,
      verifyUser: async () => ({ userId: uuidv7(), email: 'outsider@example.test' }) });
    assert.equal(forbidden.status, 403, route.key);
  }
  assert.deepEqual(deps.calls, []);
});

test('Card 21a step-up start durably claims attempt before one-shot OTP and returns no email', async () => {
  const deps = services();
  const response = await handleAdminRequest(request('/api/v1/admin/stepup/start'), { env, ...deps });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { accepted: true });
  assert.deepEqual(deps.calls.map(call => call[0]), ['rpc', 'otp']);
  assert.equal(deps.calls[0][1], 'claim_admin_stepup_attempt');
  assert.equal(deps.calls[0][2].p_actor_email, email);
  assert.equal(deps.calls[0][2].p_action, 'stepup_start');
  assert.equal(deps.calls[1][1], email);
});

test('Card 21a sixth step-up attempt returns 429 before GoTrue and failed audit fails closed', async () => {
  for (const [result, status] of [[{ ok: true, data: false }, 429],
    [{ ok: false, kind: 'unavailable', status: 503 }, 503]]) {
    const deps = services({ result });
    const response = await handleAdminRequest(request('/api/v1/admin/stepup', { code: '123456' }),
      { env, ...deps });
    assert.equal(response.status, status);
    assert.deepEqual(deps.calls.map(call => call[0]), ['rpc']);
    assert.equal(JSON.stringify(await response.json()).includes('123456'), false);
  }
});

test('[PM-38] a verified code yields a session-bound elevation, recorded before it is returned, without a GoTrue session', async () => {
  const deps = services();
  const response = await handleAdminRequest(request('/api/v1/admin/stepup', { code: '123456' }),
    { env, ...deps, nowMs: () => 1_000_000 });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(Object.keys(body), ['elevation']);
  const admitted = await verifyElevation(body.elevation, email, SESSION, secret);
  assert.ok(admitted.jti);
  assert.equal(await verifyElevation(body.elevation, 'other@example.test', SESSION, secret), false);
  assert.equal(await verifyElevation(body.elevation, email, uuidv7(), secret), false);
  assert.equal(JSON.stringify(body).includes('access_token'), false);
  assert.deepEqual(deps.calls.map(call => call[0]), ['rpc', 'verify', 'rpc']);
  assert.deepEqual(deps.calls[1], ['verify', email, '123456']);
  assert.deepEqual(deps.calls[2], ['rpc', 'record_admin_elevation', { p_jti: admitted.jti, p_actor_email: email, p_scope: 'admin', p_session_id: SESSION }]);
  // No session id on the JWT, or a failed record: no elevation is handed out.
  const sessionless = services(); sessionless.verifyUser = async () => ({ userId: sessionless.actorId, email, sessionId: null });
  assert.equal((await handleAdminRequest(request('/api/v1/admin/stepup', { code: '123456' }), { env, ...sessionless })).status, 403);
  const unrecorded = services({ result: { ok: true, data: true } }); const call = unrecorded.rpc.call;
  unrecorded.rpc.call = async (name, args) => name === 'record_admin_elevation' ? { ok: true, data: false } : call(name, args);
  assert.equal((await handleAdminRequest(request('/api/v1/admin/stepup', { code: '123456' }), { env, ...unrecorded })).status, 503);
});

test('Card 21a Origin, content type and malformed code stop step-up before external work', async () => {
  const deps = services();
  const wrongOrigin = await handleAdminRequest(request('/api/v1/admin/stepup/start', {},
    { origin: 'https://other.invalid' }), { env, ...deps });
  assert.equal(wrongOrigin.status, 403);
  const wrongType = await handleAdminRequest(request('/api/v1/admin/stepup/start', {},
    { 'content-type': 'text/plain' }), { env, ...deps });
  assert.equal(wrongType.status, 415);
  assert.deepEqual(deps.calls, []);
  const badCode = await handleAdminRequest(request('/api/v1/admin/stepup', { code: '12345x' }),
    { env, ...deps });
  assert.equal(badCode.status, 400);
  assert.deepEqual(deps.calls.map(call => call[0]), ['rpc']);
  assert.equal(deps.calls[0][1], 'claim_admin_stepup_attempt');
});

test('Card 21a stalled step-up body times out before audit or GoTrue even when cancel hangs', async () => {
  let cancelled = 0;
  const deps = services();
  const stalled = new Request('https://case.invalid/api/v1/admin/stepup', {
    method: 'POST', duplex: 'half', headers: { authorization: 'Bearer local-test',
      origin: env.CASE_PUBLIC_ORIGIN, 'content-type': 'application/json' },
    body: new ReadableStream({ pull: () => new Promise(() => {}),
      cancel: () => { cancelled++; return new Promise(() => {}); } }),
  });
  const response = await handleAdminRequest(stalled, { env, ...deps, bodyTimeoutMs: 20 });
  assert.equal(response.status, 408);
  assert.equal(cancelled, 1);
  assert.deepEqual(deps.calls, []);
});


test('Card 21a parsed malformed step-up attempts claim durable audit before refusal without exposing code', async () => {
  for (const [result, status] of [[{ ok: true, data: true }, 400], [{ ok: true, data: false }, 429]]) {
    const deps = services({ result });
    const response = await handleAdminRequest(request('/api/v1/admin/stepup', { code: 'private-code\n' }), { env, ...deps });
    assert.equal(response.status, status);
    assert.deepEqual(deps.calls.map(call => call[0]), ['rpc']);
    assert.equal(deps.calls[0][1], 'claim_admin_stepup_attempt');
    assert.equal(deps.calls[0][2].p_action, 'stepup_verify');
    assert.equal(JSON.stringify(deps.calls).includes('private-code'), false);
    assert.equal(JSON.stringify(await response.json()).includes('private-code'), false);
  }
});

test('Card 21a facilitator search reads one explicit provider page with personal filter only in JSON', async () => {
  const target = {id:uuidv7(), email:'wanted@example.test'};
  const calls = [];
  const deps = services();
  deps.gotrue.listUsers = async args => {calls.push(args);return {ok:true, users:[target,{id:uuidv7(), email:'other@example.test'}], nextPage:3};};
  const response = await handleAdminRequest(request('/api/v1/admin/facilitators/search',
    {query:'WANTED', page:2, perPage:100}), {env,...deps});
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(), {users:[{...target,profile:null,label:null,access:{memberships:[],grants:[]}}], nextPage:3});
  assert.deepEqual(calls,[{page:2, perPage:100}]);
  assert.deepEqual(deps.calls,[]);
});

test('Card 21a facilitator list refuses personal URL queries and bounds explicit paging before provider', async () => {
  let calls=0;
  const deps=services();
  deps.gotrue.listUsers=async args=>{calls++;return {ok:true, users:[], nextPage:null};};
  for (const query of ['?email=private@example.test','?page=0','?perPage=1001','?page=1&page=2']) {
    const response=await handleAdminRequest(new Request(`https://case.invalid/api/v1/admin/facilitators${query}`, {headers:{authorization:'Bearer local-test'}}),{env,...deps});
    assert.equal(response.status,400);
  }
  assert.equal(calls,0);
  const response=await handleAdminRequest(new Request('https://case.invalid/api/v1/admin/facilitators?page=2&perPage=1000',{headers:{authorization:'Bearer local-test'}}),{env,...deps});
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{users:[], nextPage:null});
  assert.equal(calls,1);
});

test('Card 21a audit read uses bounded UUID cursor RPC and never accepts personal query fields', async () => {
  const cursor=uuidv7();const row={id:uuidv7(),action:'facilitator_disable',phase:'outcome'};
  const deps=services({result:{ok:true,data:[{event_id:row.id,action:row.action,phase:row.phase}]}});
  const read=query=>new Request(`https://case.invalid/api/v1/admin/audit${query}`,{headers:{authorization:'Bearer local-test'}});
  for(const query of ['?limit=101','?actor_email=private@example.test','?after=not-an-id','?limit=1&limit=2']) {
    assert.equal((await handleAdminRequest(read(query),{env,...deps})).status,400);
  }
  assert.deepEqual(deps.calls,[]);
  const response=await handleAdminRequest(read(`?limit=1&after=${cursor}`),{env,...deps});
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{events:[row],nextCursor:row.id});
  assert.deepEqual(deps.calls,[['rpc','list_admin_audit',{p_limit:1,p_after:cursor}]]);
});

test('Card 21a audit read maps actual SQL event_id rows to public id cursor schema',async()=>{
  const eventId=uuidv7();const row={event_id:eventId,intent_id:uuidv7(),phase:'outcome',action:'room_end',target_type:'room',target_id:uuidv7(),actor_email:email,before:{status:'active'},after:{status:'ended'},at:'2026-10-03T00:00:00Z',from_prefix:null};
  const deps=services({result:{ok:true,data:[row]}});
  const response=await handleAdminRequest(new Request('https://case.invalid/api/v1/admin/audit?limit=1',{headers:{authorization:'Bearer local-test'}}),{env,...deps});
  assert.equal(response.status,200);
  const {event_id,...metadata}=row;
  assert.deepEqual(await response.json(),{events:[{id:event_id,...metadata}],nextCursor:eventId});
});

test('Card 21a every admin route refuses inactive verified Auth subject before privileged services',async()=>{
  const actorId=uuidv7();const calls=[];
  for(const route of ADMIN_ROUTES) {
    const path=route.template.replace(':id',uuidv7());
    const req=new Request(`https://case.invalid${path}`,{method:route.method,headers:{authorization:'Bearer local-test',origin:env.CASE_PUBLIC_ORIGIN,'content-type':'application/json'},...(route.method==='POST'?{body:'{}'}:{})});
    const response=await handleAdminRequest(req,{env,
      verifyUser:async()=>({userId:actorId,email}),
      rpc:{call:async(name,args)=>{calls.push([name,args]);return {ok:true,data:false};}},
      gotrue:{listUsers:async()=>{throw Error('inactive actor reached provider');},startStepUp:async()=>{throw Error('inactive actor reached provider');},verifyStepUp:async()=>{throw Error('inactive actor reached provider');}}});
    assert.equal(response.status,403,route.key);
  }
  assert.equal(calls.length,ADMIN_ROUTES.length);
  assert.ok(calls.every(([name,args])=>name==='admin_account_active'&&args.p_user_id===actorId));
  for(const route of ADMIN_ROUTES) {
    const req=new Request(`https://case.invalid${route.template.replace(':id',uuidv7())}`,{method:route.method,
      headers:{authorization:'Bearer local-test',origin:env.CASE_PUBLIC_ORIGIN,'content-type':'application/json'},
      ...(route.method==='POST'?{body:'{}'}:{})});
    const response=await handleAdminRequest(req,{env,verifyUser:async()=>({userId:actorId,email}),
      rpc:{call:async name=>{assert.equal(name,'admin_account_active');return {ok:true,data:{}};}}});
    assert.equal(response.status,503,route.key);assert.deepEqual(await response.json(),{error:'admin_unavailable'});
  }
});

// CASE-339 retired the teaching-workspace invite and resend (and CASE_TEACHING_WORKSPACE_ID). Their properties moved with
// the invitation to POST /api/v1/invitations (tests/access-invitations.test.mjs): the account cutoff before any email, an
// incomplete account inventory never creating an account, no free-text note, and a saved invitation that Resend completes.
test('[AS-209] the retired admin invite and resend routes answer 404 before any service, so nothing can reach the old teaching workspace',async()=>{
 const deps=services();let provider=0;
 const gotrue=()=>{provider++;return {};};
 for(const path of ['/api/v1/admin/facilitators/invite',`/api/v1/admin/facilitators/${uuidv7()}/resend`]){
  const response=await handleAdminRequest(request(path,{email:'new@example.test'}),{env:{...env,CASE_TEACHING_WORKSPACE_ID:uuidv7()},...deps,gotrue});
  assert.equal(response.status,404,path);
 }
 assert.equal(provider,0);assert.deepEqual(deps.calls,[]);
});

test('Card 21a tagged enable route reaches profile CAS without destructive elevation or room termination',async()=>{
 const deps=services(),id=uuidv7();const events=[];
 const before={user_id:id,disabled_at:'2026-10-02T00:00:00.000Z',soft_deleted_at:null,delete_due_at:null,admin_revision:4};
 const after={...before,disabled_at:null,admin_revision:5};
 deps.rpc.call=async(name,args)=>{
  events.push(name);
  if(name==='admin_account_active')return {ok:true,data:true};
  if(name==='admin_read_profiles')return {ok:true,data:[before]};
  if(name==='admin_transition_profile'){assert.deepEqual(args,{p_user_id:id,p_expected_revision:4,p_action:'enable',p_admin:true,p_admin_email:email});return {ok:true,data:[after]};}
  return {ok:true,data:args.p_event_id};
 };
 deps.gotrue.getUser=async()=>({ok:true,user:{id,email:'target@example.test',bannedUntil:null}});
 deps.gotrue.updateUser=async(target,args)=>{assert.equal(target,id);assert.deepEqual(args,{banDuration:'none'});events.push('ban');return {ok:true};};
 const response=await handleAdminRequest(request(`/api/v1/admin/facilitators/${id}/enable`,{expectedRevision:4}),{env,...deps});
 assert.equal(response.status,200);
 assert.deepEqual(await response.json(),{profile:after});
 assert.deepEqual(events,['admin_account_active','admin_read_profiles','admin_account_active','write_admin_audit','admin_transition_profile','ban','write_admin_audit']);
});

test('Card 21a tagged case-list route invokes bounded metadata RPC and strips unrevealed content',async()=>{
 const deps=services(),row={case_id:uuidv7(),version_id:uuidv7(),version_no:1,title:'Teaching case',status:'published',admin_revision:0,
  workspace_id:uuidv7(),group_id:null,group_name:null,tint:'neutral',group_revision:0};
 deps.rpc.call=async(name,args)=>{
  if(name==='admin_account_active')return {ok:true,data:true};
  assert.equal(name,'list_admin_case_versions');assert.deepEqual(args,{p_limit:100,p_after:null});return {ok:true,data:[{...row,document:{private:'unrevealed'}}]};
 };
 const response=await handleAdminRequest(new Request('https://case.invalid/api/v1/admin/cases',{headers:{authorization:'Bearer local-test'}}),{env,...deps});
 assert.equal(response.status,200);assert.deepEqual(await response.json(),{versions:[row],nextCursor:null});
});

test('Card 21a GoTrue factory remains lazy for auth refusal and audit reads but opens only admitted provider routes',async()=>{
 const deps=services();let factories=0,providerCalls=0;
 const gotrue=()=>{factories++;return {startStepUp:async()=>{providerCalls++;return {ok:true};},verifyStepUp:async()=>({ok:true})};};
 for(const verifyUser of [async()=>null,async()=>({userId:uuidv7(),email:'outside@example.test'})]){
  const response=await handleAdminRequest(request('/api/v1/admin/stepup/start'),{env,...deps,gotrue,verifyUser});
  assert.ok([401,403].includes(response.status));
 }
 deps.rpc.call=async name=>name==='admin_account_active'?{ok:true,data:true}:name==='list_admin_audit'?{ok:true,data:[]}:{ok:true,data:true};
 const audit=await handleAdminRequest(new Request('https://case.invalid/api/v1/admin/audit',{headers:{authorization:'Bearer local-test'}}),{env,...deps,gotrue});
 assert.equal(audit.status,200);assert.equal(factories,0);
 const admitted=await handleAdminRequest(request('/api/v1/admin/stepup/start'),{env,...deps,gotrue});
 assert.equal(admitted.status,202);assert.equal(factories,1);assert.equal(providerCalls,1);
});

test('Card 21a facilitator list joins only requested authoritative profile metadata; the Name & role come only from their own read (P-41)',async()=>{
 const deps=services(),id=uuidv7(),other=uuidv7(),calls=[];
 const state={user_id:id,disabled_at:'2026-10-03T00:00:00Z',soft_deleted_at:null,delete_due_at:null,admin_revision:7};
 deps.gotrue.listUsers=async()=>({ok:true,users:[{id,email:'target@example.test'},{id:other,email:'invited@example.test'}],nextPage:2});
 deps.rpc.call=async(name,args)=>{
  if(name==='admin_account_active')return {ok:true,data:true};
  calls.push([name,args]);
  if(name==='admin_read_facilitator_labels')return {ok:true,data:[{user_id:id,display_name:'Sam Lee',facilitator_role:'Registrar',label_confirmed_at:null}]};
  if(name==='admin_read_access')return {ok:true,data:[]};
  assert.equal(name,'admin_read_profiles');return {ok:true,data:[{...state,display_name:'Private name'}]};
 };
 const response=await handleAdminRequest(new Request('https://case.invalid/api/v1/admin/facilitators',{headers:{authorization:'Bearer local-test'}}),{env,...deps});
 assert.equal(response.status,200);
 assert.deepEqual(await response.json(),{users:[{id,email:'target@example.test',profile:state,label:{name:'Sam Lee',role:'Registrar',confirmed:false},access:{memberships:[],grants:[]}},
  {id:other,email:'invited@example.test',profile:null,label:null,access:{memberships:[],grants:[]}}],nextPage:2});
 assert.deepEqual(calls,[['admin_read_profiles',{p_user_ids:[id,other]}],['admin_read_facilitator_labels',{p_user_ids:[id,other]}],['admin_read_access',{p_user_ids:[id,other]}]]);
 // A malformed or foreign label row drops every label for the page, never the list.
 deps.rpc.call=async(name)=>name==='admin_account_active'?{ok:true,data:true}:name==='admin_read_facilitator_labels'
  ?{ok:true,data:[{user_id:uuidv7(),display_name:'X',facilitator_role:null,label_confirmed_at:null}]}:{ok:true,data:[state]};
 const foreign=await handleAdminRequest(new Request('https://case.invalid/api/v1/admin/facilitators',{headers:{authorization:'Bearer local-test'}}),{env,...deps});
 assert.deepEqual((await foreign.json()).users.map(u=>u.label),[null,null]);
});

test('Card 21a tagged live-room list reaches bounded inventory without instantiating unrelated GoTrue factory',async()=>{
 const deps=services();let reads=0;
 const response=await handleAdminRequest(new Request('https://case.invalid/api/v1/admin/rooms?limit=1&after=A',{headers:{authorization:'Bearer local-test'}}),{env,...deps,gotrue:()=>assert.fail('outer provider must stay lazy'),rooms:{read:async({query})=>{reads++;assert.equal(query.get('limit'),'1');assert.equal(query.get('after'),'A');return {ok:true,rooms:[],nextCursor:'B'};}}});
 assert.equal(response.status,200);assert.deepEqual(await response.json(),{rooms:[],nextCursor:'B'});assert.equal(reads,1);
});
