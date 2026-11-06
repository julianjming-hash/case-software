// Actual merged Worker/DOs. Only exact declared local provider/RPC requests are faked.
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {randomBytes,randomInt,randomUUID} from 'node:crypto';
import {uuidv7,isUuidV7} from '../../src/shared/ids.mjs';
import {signTestJwt} from '../../src/worker/auth.mjs';
import {RPC_ARGUMENTS} from '../../src/worker/rpc.mjs';
const ROOT=fileURLToPath(new URL('../..',import.meta.url));
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const error=()=>Response.json({error:'fixture_request_refused'},{status:503});
const localHttps=value=>{const url=new URL(value);if(url.protocol!=='https:'||url.hostname!=='127.0.0.1'||url.href!==url.origin+'/')throw Error('local_https_required');return url.origin;};
// One whole read deadline; overflow/invalid data cancel without awaiting a hostile stream.
export async function readAdminFixtureBody(request,{timeoutMs=1000}={}) {
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>5000||!request.body)return null;
 let reader,timer;
 const expired=Symbol('expired'),chunks=[];let bytes=0;
 const cancel=()=>{try{void Promise.resolve(reader?.cancel()).catch(()=>{});}catch{/* contained */}};
 try{
  reader=request.body.getReader();
  const deadline=new Promise(resolve=>{timer=setTimeout(()=>resolve(expired),timeoutMs);});
  for(;;){
   const part=await Promise.race([reader.read(),deadline]);
   if(part===expired){cancel();return null;}
   if(part.done)break;
   if(!(part.value instanceof Uint8Array)||(bytes+=part.value.byteLength)>65536){cancel();return null;}
   chunks.push(part.value);
  }
  const data=new Uint8Array(bytes);let offset=0;
  for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.byteLength;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));
 }catch{cancel();return null;}finally{clearTimeout(timer);try{reader?.releaseLock();}catch{/* pending cancelled read */}}
}
export async function startAdminWorker({authOrigin,caseOrigin}){
 authOrigin=localHttps(authOrigin);caseOrigin=localHttps(caseOrigin);
 const actorId=randomUUID(),nonadminId=randomUUID(),workspaceId=uuidv7(),email='administrator@example.invalid';
 const jwtSecret=randomBytes(32).toString('hex'),serviceKey='sb_secret_'+randomBytes(24).toString('hex');
 const stepupCode=String(randomInt(1000000)).padStart(6,'0'),stamp=new Date().toISOString();
 const user=(id,email)=>({id,email,invited_at:stamp,email_confirmed_at:null,confirmed_at:null,banned_until:null,created_at:stamp});
 const profile=id=>({user_id:id,disabled_at:null,soft_deleted_at:null,delete_due_at:null,admin_revision:0});
 // CASE-339: the disable target is an account that already accepted an invitation (a profile and a membership); a new
 // address is invited through POST /api/v1/invitations, which creates the account and saves the invitation only.
 const targetId=randomUUID(),target='integrated-facilitator@example.invalid',invitee='integrated-invitee@example.invalid';
 const state={users:[user(actorId,email),{...user(targetId,target),confirmed_at:stamp,email_confirmed_at:stamp}],profiles:new Map([[actorId,profile(actorId)],[targetId,profile(targetId)]]),
  memberships:new Map([[actorId,{workspaceId,role:'owner'}],[targetId,{workspaceId,role:'facilitator'}]]),invitations:[],events:[],calls:[],elevations:new Set()};
 const policies={managers_invite:true,editors_publish:false,runners_share:false,managers_see_records:true};
 const known=id=>id===nonadminId||state.users.some(user=>user.id===id);
 const record=operation=>state.calls.push({operation}); // No URLs, headers, codes or bodies in diagnostics.
 let clock=Date.now(),stepupStarted=false;
 const sessionId=randomUUID();
 function event(args){return {event_id:args.p_event_id,intent_id:args.p_intent_id,phase:args.p_phase,action:args.p_action,target_type:args.p_target_type,target_id:args.p_target_id,actor_email:args.p_actor_email,before:structuredClone(args.p_before),after:structuredClone(args.p_after),at:new Date(++clock).toISOString(),from_prefix:args.p_from_prefix};}
 async function outbound(request){
  const url=new URL(request.url),headers=request.headers;
  if(url.origin!==authOrigin||url.hash||headers.get('apikey')!==serviceKey||headers.has('authorization'))return error();
  let body=null;
  if(request.method==='POST'||request.method==='PUT'){
   body=await readAdminFixtureBody(request);if(body===null)return error();
   if(!headers.get('content-type')?.startsWith('application/json'))return error();
  }
  if(url.pathname.startsWith('/rest/v1/rpc/')){
   const name=url.pathname.slice('/rest/v1/rpc/'.length),args=RPC_ARGUMENTS[name];
   if(request.method!=='POST'||url.search||!args||!exact(body,args)||headers.get('content-profile')!=='case_api'||headers.get('accept-profile')!=='case_api')return error();
   switch(name){
    case 'admin_account_active':{
     if(!known(body.p_user_id))return error();record(name);const row=state.profiles.get(body.p_user_id);return Response.json(!row||row.disabled_at===null&&row.soft_deleted_at===null);
    }
    case 'get_me':
     if(body.p_user_id!==actorId||body.p_admin!==true||body.p_admin_email!==email||![null,workspaceId].includes(body.p_workspace_id))return error();record(name);
     return Response.json([{user_id:actorId,display_name:'Administrator',next_after:null,admin:true,facilitator_role:'Owner',label_confirmed_at:stamp,
      memberships:[{workspace_id:workspaceId,slug:'teaching',name:'Teaching',role:'admin',policies}],grants:[]}]);
    case 'admin_list_workspaces':
     if(body.p_user_id!==actorId||body.p_after!==null||body.p_admin!==true||body.p_admin_email!==email)return error();record(name);
     return Response.json({workspaces:[{id:workspaceId,name:'Teaching',membership_revision:0}],nextAfter:null});
    case 'list_invitations':
     if(body.p_user_id!==actorId||body.p_workspace_id!==workspaceId||body.p_after!==null||body.p_admin!==true||body.p_admin_email!==email)return error();record(name);
     return Response.json({invitations:state.invitations.map(row=>({...row})),nextAfter:null});
    case 'create_invitation':{
     // Only the SHA-256 of the reference arrives; the account it names must already exist (the Worker looked it up).
     if(body.p_user_id!==actorId||body.p_workspace_id!==workspaceId||body.p_case_id!==null||body.p_level!=='run'||body.p_email!==invitee||!/^\\x[0-9a-f]{64}$/.test(body.p_ref_hash)||body.p_invitee_user_id!==null||body.p_admin!==true||body.p_admin_email!==email)return error();
     record(name);const row={invitationId:uuidv7(),email:invitee,level:'run',workspaceId,workspaceName:'Teaching',caseId:null,caseTitle:null,inviterName:'Administrator',
      expiresAt:new Date(Date.now()+90*86400000).toISOString(),status:'pending',sendState:'not_sent',sendCount:0,createdAt:stamp,inviterKind:'admin'};
     state.invitations.push(row);return Response.json({outcome:'created',...row});
    }
    case 'record_invitation_delivery':{
     const row=state.invitations.find(item=>item.invitationId===body.p_invitation_id);
     if(!row||!['sent','failed','email_limit','email_not_configured'].includes(body.p_outcome))return error();record(name);row.sendState=body.p_outcome;return Response.json({outcome:'recorded',sendState:row.sendState});
    }
    case 'admin_read_access':
     if(!Array.isArray(body.p_user_ids)||body.p_user_ids.length>1000||!body.p_user_ids.every(known))return error();
     record(name);return Response.json(body.p_user_ids.flatMap(id=>state.memberships.has(id)?[{userId:id,kind:'member',workspaceId,workspaceName:'Teaching',role:state.memberships.get(id).role,caseId:null,caseTitle:null}]:[]));
    case 'revoke_invitation':{
     const row=state.invitations.find(item=>item.invitationId===body.p_invitation_id);
     if(!row||body.p_user_id!==actorId||body.p_admin!==true||body.p_admin_email!==email)return error();record(name);row.status='revoked';return Response.json({outcome:'revoked',invitationId:row.invitationId});
    }
    case 'admin_read_profiles':
     if(!Array.isArray(body.p_user_ids)||body.p_user_ids.length>1000||new Set(body.p_user_ids).size!==body.p_user_ids.length||!body.p_user_ids.every(known))return error();
     record(name);return Response.json(body.p_user_ids.flatMap(id=>state.profiles.has(id)?[state.profiles.get(id)]:[]));
    case 'admin_provision_facilitator':{
     // Card 35: the SQL refuses without the admin flag and the admin's own email.
     if(body.p_workspace_id!==workspaceId||body.p_actor_user_id!==actorId||body.p_admin!==true||body.p_admin_email!==email||!state.users.some(user=>user.id===body.p_user_id)||!state.events.some(row=>row.phase==='intent'&&row.action==='facilitator_invite'))return error();
     record(name);if(!state.profiles.has(body.p_user_id))state.profiles.set(body.p_user_id,profile(body.p_user_id));if(!state.memberships.has(body.p_user_id))state.memberships.set(body.p_user_id,{workspaceId,role:'facilitator'});return Response.json(null);
    }
    case 'admin_transition_profile':{
     const row=state.profiles.get(body.p_user_id);
     if(body.p_admin!==true||body.p_admin_email!==email||body.p_action!=='disable'||body.p_user_id===actorId||!row||body.p_expected_revision!==row.admin_revision||row.disabled_at!==null||!state.events.some(event=>event.phase==='intent'&&event.action==='facilitator_disable'&&event.target_id===row.user_id))return error();
     record('profile_disable');row.disabled_at=new Date().toISOString();row.admin_revision++;return Response.json([row]);
    }
    case 'list_owned_active_sessions':
     if(!state.users.some(user=>user.id===body.p_user_id)||body.p_limit!==100||body.p_after!==null||body.p_admin!==true||body.p_admin_email!==email)return error();record(name);return Response.json([]);
    case 'record_admin_elevation':{
     // Card 35 (R-a): an elevation is issued to this admin, in the admin scope, for this sign-in session.
     if(!isUuidV7(body.p_jti)||body.p_actor_email!==email||body.p_scope!=='admin'||body.p_session_id!==sessionId||state.elevations.has(body.p_jti))return error();
     record(name);state.elevations.add(body.p_jti);return Response.json(true);
    }
    case 'claim_admin_stepup_attempt':{
     if(body.p_actor_email!==email||!isUuidV7(body.p_event_id)||!['stepup_start','stepup_verify'].includes(body.p_action)||![null,'127.0.0.0/24'].includes(body.p_from_prefix)||state.events.some(row=>row.event_id===body.p_event_id))return error();
     record(name);const accepted=state.events.filter(row=>row.phase==='attempt'&&row.after.status==='accepted'&&Date.parse(row.at)>Date.now()-900000).length<5;
     state.events.push(event({...body,p_intent_id:null,p_phase:'attempt',p_target_type:'admin',p_target_id:null,p_before:{},p_after:{status:accepted?'accepted':'rate_limited'}}));return Response.json(accepted);
    }
    case 'write_admin_audit':{
     if(!isUuidV7(body.p_event_id)||!isUuidV7(body.p_intent_id)||body.p_actor_email!==email||![null,'127.0.0.0/24'].includes(body.p_from_prefix)||body.p_target_type!=='facilitator'||!['facilitator_invite','facilitator_disable'].includes(body.p_action)||!['intent','outcome'].includes(body.p_phase)||state.events.some(row=>row.event_id===body.p_event_id))return error();
     const invited=body.p_action==='facilitator_invite';
     if(invited?(body.p_target_id!==null||!exact(body.p_before,['email'])||body.p_before.email!=='integrated-facilitator@example.invalid'):(body.p_target_id===actorId||!known(body.p_target_id)||!exact(body.p_before,['status','admin_revision'])||body.p_before.status!=='active'||body.p_before.admin_revision!==0))return error();
     if(body.p_phase==='intent'){
      if(body.p_event_id!==body.p_intent_id||!exact(body.p_after,[]))return error();
     }else{
      const intent=state.events.find(row=>row.event_id===body.p_intent_id&&row.phase==='intent');
      if(!intent||intent.action!==body.p_action||intent.target_id!==body.p_target_id||JSON.stringify(intent.before)!==JSON.stringify(body.p_before))return error();
      if(invited?(!exact(body.p_after,['status','email'])||body.p_after.status!=='invited'||body.p_after.email!==body.p_before.email):(!exact(body.p_after,['status','admin_revision'])||body.p_after.status!=='disabled'||body.p_after.admin_revision!==1))return error();
     }
     record(invited?'invite_'+body.p_phase:'disable_'+body.p_phase);state.events.push(event(body));return Response.json(null);
    }
    case 'admin_query_operations':{
     if(body.p_user_id!==actorId||body.p_admin!==true||body.p_admin_email!==email||typeof body.p_query!=='string'||body.p_after!==null)return error();record(name);
     const rows=state.events.filter(e=>e.phase==='intent'&&e.action.includes(body.p_query)).map(e=>{const out=state.events.filter(o=>o.intent_id===e.event_id&&o.phase==='outcome').at(-1);return{id:e.event_id,action:e.action,actor_email:e.actor_email,target_type:e.target_type,target_id:e.target_id,at:e.at,before:e.before,after:out?.after??null,phase:out?'outcome':'unresolved',outcome_id:out?.event_id??null,outcome_at:out?.at??null};}).sort((a,b)=>b.id.localeCompare(a.id));return Response.json({rows:rows.slice(0,20),nextAfter:null});
    }
    case 'list_admin_audit':
     if(body.p_limit!==100||body.p_after!==null)return error();record(name);return Response.json([...state.events].reverse());
    default:return error();
   }
  }
  if(url.pathname==='/auth/v1/admin/users'&&request.method==='GET'){
   const keys=[...url.searchParams.keys()],page=Number(url.searchParams.get('page')),perPage=Number(url.searchParams.get('per_page'));
   if(keys.length!==2||!keys.includes('page')||!keys.includes('per_page')||!Number.isSafeInteger(page)||page<1||page>100000||!Number.isSafeInteger(perPage)||perPage<1||perPage>1000)return error();
   record('provider_list');return Response.json({users:state.users.slice((page-1)*perPage,page*perPage)});
  }
  // CASE-340: Case creates the invited account with its email confirmed; GoTrue sends no email.
  if(url.pathname==='/auth/v1/admin/users'&&request.method==='POST'){
   if(url.search||!exact(body,['email','email_confirm'])||body.email_confirm!==true||body.email!==invitee||state.users.some(user=>user.email===body.email)||!state.invitations.some(row=>row.email===body.email))return error();
   record('provider_create');const made={...user(randomUUID(),body.email),invited_at:null,email_confirmed_at:stamp,confirmed_at:stamp};state.users.push(made);return Response.json(made);
  }
  const target=state.users.find(user=>url.pathname==='/auth/v1/admin/users/'+user.id);
  if(target&&!url.search&&request.method==='GET'){record('provider_read');return Response.json(target);}
  if(target&&!url.search&&request.method==='PUT'){
   if(target.id===actorId||!exact(body,['ban_duration'])||body.ban_duration!=='876000h'||state.profiles.get(target.id)?.disabled_at===null)return error();
   record('provider_ban');target.banned_until=new Date(Date.now()+876000*3600000).toISOString();return Response.json(target);
  }
  if(url.pathname==='/auth/v1/otp'&&!url.search&&request.method==='POST'&&exact(body,['email','create_user'])&&body.email===email&&body.create_user===false){record('provider_otp');stepupStarted=true;return Response.json({});}
  if(url.pathname==='/auth/v1/verify'&&!url.search&&request.method==='POST'&&stepupStarted&&exact(body,['email','token','type'])&&body.email===email&&body.token===stepupCode&&body.type==='email'){
   record('provider_verify');stepupStarted=false;return Response.json({user:{id:actorId,email}});
  }
  return error();
 }
 const bundle=await build({entryPoints:[ROOT+'/src/worker/index.mjs'],bundle:true,format:'esm',platform:'neutral',target:'es2022',write:false,external:['cloudflare:workers'],loader:{'.sql':'text'}});
 // Port 0: workerd binds an OS-assigned port; a probed-then-released port can be taken first.
 const mf=new Miniflare(convertV4MiniflareOptions({host:'127.0.0.1',port:0,rootPath:ROOT,script:bundle.outputFiles[0].text,modules:true,compatibilityDate:'2026-08-22',
  bindings:{BUILD_SHA:'a'.repeat(40),CASE_ALLOW_HS256:'1',SUPABASE_JWT_SECRET:jwtSecret,SUPABASE_URL:authOrigin+'/',SUPABASE_JWT_ISSUER:authOrigin+'/auth/v1',SUPABASE_JWKS_URL:authOrigin+'/auth/v1/.well-known/jwks.json',SUPABASE_SECRET_KEY:serviceKey,SUPABASE_PUBLISHABLE_KEY:'sb_publishable_'+randomBytes(24).toString('hex'),ADMIN_EMAILS:email,CASE_PUBLIC_ORIGIN:caseOrigin,STEPUP_SECRET:randomBytes(32).toString('hex')},
  durableObjects:{ROOM:{className:'RoomDO',useSQLite:true},DIRECTORY:{className:'DirectoryDO',useSQLite:true},ALERTS:{className:'AlertDO',useSQLite:true}},outboundService:outbound}));
 try{
  const origin=(await mf.ready).origin;
  const claims={aud:'authenticated',role:'authenticated',iss:authOrigin+'/auth/v1',session_id:sessionId,exp:Math.floor(Date.now()/1000)+3600};
  return {origin,email,workspaceId,target,invitee,jwt:await signTestJwt({...claims,sub:actorId,email},jwtSecret),nonadminJwt:await signTestJwt({...claims,sub:nonadminId,email:'nonadmin@example.invalid'},jwtSecret),stepupCode,state,async stop(){await mf.dispose();}};
 }catch(error){await mf.dispose();throw error;}
}
