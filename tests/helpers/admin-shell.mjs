// Card21b UI fixture only: actual built static policies, local Auth, strict declared HTTP contracts.
// This is not a substitute for the separately required integrated real-Worker/server gate.
import {createServer,request as proxyRequest} from 'node:http';
import {createServer as createHttpsServer} from 'node:https';
import {execFileSync} from 'node:child_process';
import {startAdminWorker} from './admin-worker.mjs';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join,resolve,sep,extname} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes,randomInt,randomUUID} from 'node:crypto';
import {buildClient} from '../../scripts/build-client.mjs';
import {uuidv7,isUuidV7} from '../../src/shared/ids.mjs';
import {startLocalAuthStub} from './local-auth-stub.mjs';
import {describeCase,withSolution} from '../../src/shared/art-descriptor.mjs';
import {FIXTURE} from './local-worker.mjs';
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const MIME={'.html':'text/html; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.woff2':'font/woff2'};
function policies(raw){const result=[];for(const line of raw.split('\n')){if(!line.trim())continue;if(!/^\s/.test(line))result.push({path:line.trim(),headers:{}});else{const [,key,value]=/^\s+([^:]+):\s*(.*)$/.exec(line)??[];if(key)result.at(-1).headers[key]=value;}}return result;}
const DESTRUCTIVE=['facilitators_disable','facilitators_soft_delete','versions_withdraw','cases_publish','rooms_end'];
export async function startAdminShell({integrated=false}={}){
 if(typeof integrated!=='boolean')throw Error('invalid_fixture_mode');
 const temp=await mkdtemp(join(tmpdir(),'case-admin-ui-')),otp=String(randomInt(1000000)).padStart(6,'0'),stepupCode=String(randomInt(1000000)).padStart(6,'0');
 const actor=randomUUID(),email='administrator@example.invalid',jwt=[Buffer.from('{"alg":"HS256"}').toString('base64url'),Buffer.from(JSON.stringify({sub:actor,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url'),randomBytes(32).toString('base64url')].join('.');
 const elevation=randomBytes(32).toString('base64url'),stamp=new Date().toISOString(),facilitatorId=randomUUID();
 const user={id:facilitatorId,email:'facilitator@example.invalid',invitedAt:stamp,confirmedAt:null,bannedUntil:null,createdAt:stamp,profile:{user_id:facilitatorId,disabled_at:null,soft_deleted_at:null,delete_due_at:null,admin_revision:0},label:{name:'Facilitator',role:null,confirmed:false}};
 // Card 30: the case's workspace and group travel with each listed version (Group column, Change group).
 const workspaces=[{workspace_id:uuidv7(),slug:'teaching',name:'Teaching',role:'admin'},{workspace_id:uuidv7(),slug:'bondi',name:'Bondi SLSC',role:'admin'}];
 const version={case_id:uuidv7(),version_id:uuidv7(),version_no:1,title:'Teaching case',status:'published',admin_revision:0,
  workspace_id:workspaces[0].workspace_id,group_id:null,group_name:null,tint:'neutral',group_revision:0};
 user.access={memberships:[{workspaceId:workspaces[0].workspace_id,workspaceName:'Teaching',role:'author'}],grants:[{caseId:version.case_id,caseTitle:version.title,workspaceId:workspaces[0].workspace_id,workspaceName:'Teaching',level:'run'}]};
 const art=withSolution(describeCase(FIXTURE),{attempt:0,summarised:false});
 const room={code:'7K3QX9',sessionId:uuidv7(),registeredAt:null,expiresAt:new Date(Date.now()+3600000).toISOString(),ownerEmail:user.email,phase:'surface_live',participantCount:2};
 const settings=new Map(workspaces.map(w=>[w.workspace_id,{policies:{managers_invite:true,editors_publish:false,runners_share:false,managers_see_records:true},revision:0,quotaBytes:2e9,usedBytes:1.7e9,unused:[{assetId:uuidv7(),kind:'image',mediaType:'image/jpeg',altText:'Spare chest film',createdAt:'2026-10-01T00:00:00.000Z',bytes:400000},{assetId:uuidv7(),kind:'image',mediaType:'image/jpeg',altText:null,createdAt:'2026-10-02T00:00:00.000Z',bytes:250000}]}]));
 const state={mode:'ready',meMode:null,stepupMode:null,settings,users:[user],version,room,events:[],actionMode:null,calls:[],invites:0,resends:0,mutations:0,groups:[],workspaces},holds=new Map(),sockets=new Set();
 // A5 Activity: workspace audit rows as the database records them, by every actor kind (no email except an admin's).
 {const row=(action,actor_kind,target_type,at)=>({id:uuidv7(),action,actor_kind,actor_email:actor_kind==='admin'?email:null,target_type,target_id:randomUUID(),revision:null,at,before_state:{},after_state:{}});
  state.workspaceEvents=[row('invitation_create','admin','invitation','2026-11-03T01:00:00.000Z'),row('case_grant_revoke','owner','grant','2026-11-03T02:00:00.000Z'),row('invitation_accept','system','invitation','2026-11-03T03:00:00.000Z'),row('version_publish','author','version','2026-11-03T04:00:00.000Z'),row('invitation_resend','facilitator','invitation','2026-11-03T05:00:00.000Z')].sort((a,b)=>b.id.localeCompare(a.id));}
 let auth,server,worker;
 function audit(action,targetType,targetId,before,after){const id=uuidv7();state.events.push({id,intent_id:id,phase:'intent',action,target_type:targetType,target_id:targetId,actor_email:email,before,after:{},at:new Date().toISOString(),from_prefix:null},{id:uuidv7(),intent_id:id,phase:'outcome',action,target_type:targetType,target_id:targetId,actor_email:email,before,after,at:new Date().toISOString(),from_prefix:null});}
 function hold(operation){if(holds.has(operation))throw new Error('duplicate_hold');let release,ready;const wait=new Promise(done=>release=done),observed=new Promise(done=>ready=done);const entry={wait,ready,release};holds.set(operation,entry);return{ready:observed,release(){holds.delete(operation);release();}};}
 async function body(request){let value='',bytes=0;for await(const chunk of request){bytes+=chunk.length;if(bytes>2048)throw new Error('body_limit');value+=chunk;}return value?JSON.parse(value):{};}
 try{
  auth=await startLocalAuthStub({appOrigin:null,jwt,email,otp});const outDir=join(temp,'dist');await buildClient({outDir,env:'staging',buildSha:'b'.repeat(40),publicAuthBindings:{SUPABASE_URL:auth.origin,SUPABASE_JWT_ISSUER:auth.origin+'/auth/v1',SUPABASE_JWKS_URL:auth.origin+'/auth/v1/.well-known/jwks.json'}});
  const blocks=policies(await readFile(join(outDir,'_headers'),'utf8')),redirects=new Map((await readFile(join(outDir,'_redirects'),'utf8')).trim().split('\n').map(line=>line.split(' ')).filter(parts=>parts[2]==='200'&&!parts[0].includes('*')).map(parts=>[parts[0],parts[1]]));
  let makeServer=createServer;
  if(integrated){
   const keyPath=join(temp,'key.pem'),certPath=join(temp,'cert.pem');
   execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=127.0.0.1','-keyout',keyPath,'-out',certPath],{stdio:'ignore'});
   const tls={key:await readFile(keyPath),cert:await readFile(certPath)};
   makeServer=handler=>createHttpsServer(tls,handler);
  }
  server=makeServer(async(request,response)=>{
   const target=new URL(request.url,'http://127.0.0.1');const json=(status,value)=>{if(response.destroyed)return;response.writeHead(status,{'content-type':'application/json','cache-control':'no-store'}).end(JSON.stringify(value));};
   try{
    if(integrated&&target.pathname.startsWith('/api/')){
     if(!worker||!(target.pathname==='/api/v1/config'||target.pathname==='/api/v1/version'||target.pathname==='/api/v1/me'||target.pathname.startsWith('/api/v1/admin/')||/^\/api\/v1\/(?:invitations|workspaces\/[0-9a-f-]{36}\/invitations)(?:\/|$)/.test(target.pathname))){json(404,{error:'not_found'});return;}
     const upstream=new URL(worker.origin);
     if(upstream.protocol!=='http:'||upstream.hostname!=='127.0.0.1'||upstream.href!==upstream.origin+'/')throw Error('local_api_required');
     let bytes=0,finished=false;
     const finish=()=>{if(finished)return;finished=true;clearTimeout(timer);};
     const proxy=proxyRequest({host:upstream.hostname,port:upstream.port,method:request.method,path:request.url,headers:{...request.headers,host:upstream.host}},result=>{
      response.writeHead(result.statusCode,result.headers);result.pipe(response);
      result.once('end',finish);result.once('error',()=>{finish();response.destroy();});
     });
     const timer=setTimeout(()=>{finish();proxy.destroy();if(!response.headersSent)json(504,{error:'fixture_timeout'});else response.destroy();},10000);
     proxy.once('error',()=>{finish();if(!response.headersSent)json(502,{error:'fixture_unavailable'});else response.destroy();});
     request.on('data',chunk=>{bytes+=chunk.length;if(bytes>65536){finish();proxy.destroy();if(!response.headersSent)json(413,{error:'too_large'});else response.destroy();}});
     request.once('aborted',()=>{finish();proxy.destroy();});response.once('close',()=>{finish();proxy.destroy();});
     request.pipe(proxy);return;
    }
    if(target.pathname==='/api/v1/config'&&request.method==='GET'&&!target.search){json(200,{supabaseUrl:auth.origin,publishableKey:'sb_publishable_'+randomBytes(12).toString('hex')});return;}
    if(target.pathname.startsWith('/api/')){
     if(request.headers.authorization!==`Bearer ${jwt}`){json(401,{error:'unauthorised'});return;}
     if(target.pathname==='/api/v1/me'&&request.method==='GET'){if(state.meMode==='unavailable'){json(503,{error:'admin_unavailable'});return;}json(200,{profile:{userId:actor,displayName:'Administrator'},memberships:workspaces,nextAfter:null,account:{email:state.meMode==='no_email'?null:email,administration:state.mode==='ready'}});return;}
     if(state.mode==='forbidden'){json(403,{error:'forbidden'});return;}if(state.mode==='unavailable'){json(503,{error:'admin_unavailable'});return;}if(state.mode==='unauthorised'){json(401,{error:'unauthorised'});return;}
     // CASE-356: loaded Feedback evidence, using the public validator's exact projection.
     if(target.pathname==='/api/v1/admin/feedback'&&request.method==='POST'){
      const b=await body(request);if(!exact(b,['filter','after'])||b.after!==null||b.filter?.scope!=='app'){json(400,{error:'bad_request'});return;}
      json(200,{scope:'app',result:{responses:{total:1,joined:1,qr:0},ratings:{app:{counts:[0,0,0,0,1],n:1}},months:[{month:'2026-11',counts:[0,0,0,0,1],n:1}],comments:[]},nextAfter:null});return;
     }
     // Fast-follow declared local workspace contracts. SQL authority is proved separately against PostgreSQL.
     if(target.pathname==='/api/v1/admin/workspaces/query'&&request.method==='POST'){
      const b=await body(request);if(!exact(b,['after'])||b.after!==null){json(400,{error:'bad_request'});return;}
      json(200,{workspaces:workspaces.map(w=>({id:w.workspace_id,name:w.name,membership_revision:state.membershipRevision??0})).sort((a,b)=>a.id.localeCompare(b.id)),nextAfter:null});return;
     }
     if(target.pathname==='/api/v1/admin/workspace/query'&&request.method==='POST'){
      const b=await body(request);if(!exact(b,['workspaceId','tab','query','status','from','until','after'])||!workspaces.some(w=>w.workspace_id===b.workspaceId)||!['members','cases','rooms','audit'].includes(b.tab)||typeof b.query!=='string'){json(400,{error:'bad_request'});return;}
      let rows=b.tab==='cases'&&b.workspaceId===version.workspace_id?[{id:version.version_id,case_id:version.case_id,version_no:1,title:version.title,status:version.status,admin_revision:version.admin_revision,group_id:version.group_id,group_name:version.group_name,tint:version.tint,group_revision:version.group_revision}]:b.tab==='rooms'&&state.room?[{id:state.room.sessionId,case_version_id:version.version_id,title:version.title,version_no:1,status:'live',created_at:stamp,started_at:stamp,ended_at:null,expires_at:state.room.expiresAt,own:false}]:b.tab==='members'?(state.members??[{id:facilitatorId,email:user.email,role:'owner',created_at:stamp,account_state:'active'}]):b.tab==='audit'?(state.workspaceEvents??[]):[];
      rows=rows.filter(r=>(r.title??r.email??r.action).toLowerCase().includes(b.query.toLowerCase())&&(b.status==='all'||r.status===b.status)).sort((a,b)=>b.id.localeCompare(a.id));
      json(200,{workspace:{id:b.workspaceId,name:workspaces.find(w=>w.workspace_id===b.workspaceId).name,membership_revision:state.membershipRevision??0},rows:rows.slice(0,20),nextAfter:null});return;
     }
     if(target.pathname==='/api/v1/admin/operations/query'&&request.method==='POST'){
      const b=await body(request);if(!exact(b,['query','after'])){json(400,{error:'bad_request'});return;}
      const rows=state.events.filter(e=>e.phase==='intent').map(e=>{const out=state.events.filter(o=>o.intent_id===e.id&&o.phase==='outcome').at(-1);return{id:e.id,action:e.action,actor_email:e.actor_email,target_type:e.target_type,target_id:e.target_id,at:e.at,before:e.before,after:out?.after??null,phase:out?'outcome':'unresolved',outcome_id:out?.id??null,outcome_at:out?.at??null};}).filter(e=>e.action.includes(b.query)).sort((a,b)=>b.id.localeCompare(a.id));json(200,{rows:rows.slice(0,20),nextAfter:null});return;
     }
     if(target.pathname==='/api/v1/admin/memberships/change'&&request.method==='POST'){
      const b=await body(request);state.calls.push({operation:'membership_change',body:b});
      if(!exact(b,['workspaceId','email','role','transferFrom','expectedRevision','confirmEmail'])||request.headers['x-admin-elevation']!==elevation||b.email!==b.confirmEmail){json(403,{error:'forbidden'});return;}
      if(b.expectedRevision!==(state.membershipRevision??0)){json(409,{error:'conflict'});return;}
      state.members??=[{id:facilitatorId,email:user.email,role:'owner',created_at:stamp,account_state:'active'}];const member=state.members.find(m=>m.email===b.email);
      if(member?.role==='owner'&&b.role!=='owner'&&state.members.filter(m=>m.role==='owner').length===1){json(409,{error:'conflict'});return;}
      const before=member?.role??null;if(member){if(b.role===null)state.members=state.members.filter(m=>m!==member);else member.role=b.role;}else if(b.role!==null)state.members.push({id:randomUUID(),email:b.email,role:b.role,created_at:stamp,account_state:'active'});
      if(b.transferFrom){const old=state.members.find(m=>m.id===b.transferFrom);if(old)old.role='author';}
      {const person=state.users.find(item=>item.email===b.email);if(person?.access){const w=workspaces.find(item=>item.workspace_id===b.workspaceId);person.access.memberships=person.access.memberships.filter(m=>m.workspaceId!==b.workspaceId);if(b.role!==null)person.access.memberships.push({workspaceId:b.workspaceId,workspaceName:w.name,role:b.role});}}
      state.membershipRevision=(state.membershipRevision??0)+1;state.workspaceEvents??=[];state.workspaceEvents.push({id:uuidv7(),action:'member_role',actor_kind:'admin',actor_email:email,target_type:'member',target_id:member?.id??state.members.at(-1).id,revision:state.membershipRevision,at:new Date().toISOString(),before_state:{role:before},after_state:{role:b.role,transferFrom:b.transferFrom}});json(200,{membership_revision:state.membershipRevision,changed:true});return;
     }
     const nameRoute=/^\/api\/v1\/workspaces\/([0-9a-f-]{36})\/details$/.exec(target.pathname);
     if(nameRoute){const w=workspaces.find(w=>w.workspace_id===nameRoute[1]);if(!w){json(404,{error:'not_found'});return;}w.detailsRevision??=0;
      if(request.method==='GET'){json(200,{id:w.workspace_id,name:w.name,revision:w.detailsRevision});return;}
      if(request.method==='PUT'){const b=await body(request);state.calls.push({operation:'workspace_rename',body:b});if(!exact(b,['expectedRevision','name'])||typeof b.name!=='string'||!b.name.trim()||b.name.length>120){json(400,{error:'bad_request'});return;}if(b.expectedRevision!==w.detailsRevision){json(409,{error:'conflict'});return;}w.name=b.name.trim();w.detailsRevision++;state.mutations++;json(200,{id:w.workspace_id,name:w.name,revision:w.detailsRevision});return;}
     }
     // A5: workspace settings (policies, quota, storage), Delete unused, creation and the invitation list.
     const storageRoute=/^\/api\/v1\/admin\/workspaces\/([0-9a-f-]{36})\/(storage|settings|storage\/delete-unused)$/.exec(target.pathname);
     if(storageRoute&&state.settings.has(storageRoute[1])){
      const entry=state.settings.get(storageRoute[1]),kind=storageRoute[2];state.calls.push({operation:'workspace_'+kind.replace('/','_'),body:kind==='storage'?{}:await body(request),elevation:request.headers['x-admin-elevation']??null});
      const sent=state.calls.at(-1).body;
      if(kind==='storage'&&request.method==='GET'){json(200,{workspaceId:storageRoute[1],usedBytes:entry.usedBytes,quotaBytes:entry.quotaBytes,unusedBytes:entry.unused.reduce((n,a)=>n+a.bytes,0),policies:entry.policies,policyRevision:entry.revision,unused:entry.unused});return;}
      if(kind==='settings'&&request.method==='POST'){if(sent.expectedRevision!==entry.revision){json(409,{error:'conflict'});return;}Object.assign(entry.policies,sent.policies);if(sent.mediaQuotaBytes!==null)entry.quotaBytes=sent.mediaQuotaBytes;entry.revision++;json(200,{policies:entry.policies,revision:entry.revision,mediaQuotaBytes:entry.quotaBytes});return;}
      if(kind==='storage/delete-unused'&&request.method==='POST'){if(request.headers['x-admin-elevation']!==elevation){json(403,{error:'step_up_required'});return;}const kept=state.keepUnused??[],deleted=sent.assetIds.filter(id=>!kept.includes(id));entry.unused=entry.unused.filter(a=>!deleted.includes(a.assetId));entry.usedBytes-=100000*deleted.length;state.mutations++;json(200,{deleted,kept:sent.assetIds.filter(id=>!deleted.includes(id))});return;}
      json(404,{error:'not_found'});return;
     }
     if(target.pathname==='/api/v1/workspaces'&&request.method==='POST'){
      const b=await body(request);state.calls.push({operation:'workspace_create',body:b});
      if(!exact(b,['slug','name'])||!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(b.slug)){json(400,{error:'bad_request'});return;}
      if(workspaces.some(w=>w.slug===b.slug)){json(409,{error:'conflict'});return;}
      const created={workspace_id:uuidv7(),slug:b.slug,name:b.name,role:'admin'};workspaces.push(created);state.settings.set(created.workspace_id,{policies:{managers_invite:true,editors_publish:false,runners_share:false,managers_see_records:true},revision:0,quotaBytes:2e9,usedBytes:0,unused:[]});json(201,{workspaceId:created.workspace_id});return;
     }
     const inviteRoute=/^\/api\/v1\/workspaces\/([0-9a-f-]{36})\/invitations(?:\/([0-9a-f-]{36})\/(revoke|resend))?$/.exec(target.pathname);
     if(inviteRoute&&workspaces.some(w=>w.workspace_id===inviteRoute[1])){
      state.invitations??=[{id:uuidv7(),email:'s.lee@example.invalid',level:'run',status:'pending',sendState:'sent',inviterName:'Administrator',expiresAt:new Date(Date.now()+86400000*30).toISOString(),caseId:null,caseTitle:null}];
      if(inviteRoute[3]==='revoke'){await body(request);state.calls.push({operation:'invitation_revoke'});const row=state.invitations.find(i=>i.id===inviteRoute[2]);if(row)row.status='revoked';json(200,{outcome:'revoked'});return;}
      json(200,{invitations:state.invitations,nextAfter:null});return;
     }
     // Card 30: the facilitator group routes Administration -> Groups and Change group call with admin authority.
     const groupRoute=/^\/api\/v1\/workspaces\/([0-9a-f-]{36})\/(groups|catalogue|groups\/([0-9a-f-]{36})|groups\/([0-9a-f-]{36})\/archive|cases\/([0-9a-f-]{36})\/group)$/.exec(target.pathname);
     if(groupRoute&&workspaces.some(ws=>ws.workspace_id===groupRoute[1])){
      const ws=groupRoute[1],live=()=>state.groups.filter(g=>g.workspace_id===ws&&!g.archived),find=id=>live().find(g=>g.id===id);
      const view=g=>({id:g.id,name:g.name,description:g.description,tint:g.tint,revision:g.revision,caseCount:version.group_id===g.id?1:0});
      const taken=(name,except)=>live().some(g=>g.id!==except&&g.name.toLowerCase()===name.toLowerCase());
      const kind=groupRoute[2]==='groups'?(request.method==='GET'?'group_list':'group_create'):groupRoute[2]==='catalogue'?'catalogue':groupRoute[4]?'group_archive':groupRoute[3]?'group_edit':'case_group';
      const payload=['group_list','catalogue'].includes(kind)?{}:await body(request);state.calls.push({operation:kind,body:payload,elevation:request.headers['x-admin-elevation']??null});
      const pending=holds.get(kind);if(pending){pending.ready();await pending.wait;}if(response.destroyed)return;
      if(kind==='group_list'){json(200,{groups:live().sort((a,b)=>a.name.localeCompare(b.name)).map(view)});return;}
      if(kind==='catalogue'){json(200,{cases:ws===version.workspace_id?[{version_id:version.version_id,case_id:version.case_id,title:version.title,summary:null,audience:null,setting:null,duration_min:15,version_no:1,published_at:stamp,content_sha256:'\\x'+'a'.repeat(64),art,group_id:version.group_id,group_name:version.group_name,tint:version.tint}]:[],total:ws===version.workspace_id?1:0,offset:0,limit:1,pilotPin:null});return;}
      if(kind==='group_create'){if(!exact(payload,['name','description','tint'])){json(400,{error:'bad_request'});return;}if(taken(payload.name)){json(409,{error:'name_taken'});return;}const g={id:uuidv7(),workspace_id:ws,name:payload.name,description:payload.description,tint:payload.tint,revision:0,archived:false};state.groups.push(g);json(201,{group:{id:g.id,revision:0}});return;}
      if(kind==='group_edit'){const g=find(groupRoute[3]);if(!g){json(404,{error:'not_found'});return;}if(payload.expectedRevision!==g.revision){json(409,{error:'conflict'});return;}if(taken(payload.name,g.id)){json(409,{error:'name_taken'});return;}Object.assign(g,{name:payload.name,description:payload.description,tint:payload.tint,revision:g.revision+1});if(version.group_id===g.id)Object.assign(version,{group_name:g.name,tint:g.tint});json(200,{group:{id:g.id,revision:g.revision}});return;}
      if(kind==='group_archive'){if(request.headers['x-admin-elevation']!==elevation){json(403,{error:'forbidden'});return;}const g=find(groupRoute[4]);if(!g){json(404,{error:'not_found'});return;}if(payload.expectedRevision!==g.revision){json(409,{error:'conflict'});return;}if(payload.confirmName!==g.name){json(422,{error:'confirm_mismatch'});return;}const to=payload.moveTo?find(payload.moveTo):null;if(payload.moveTo&&(!to||to.id===g.id)){json(404,{error:'not_found'});return;}let moved=0;if(version.group_id===g.id){Object.assign(version,{group_id:to?.id??null,group_name:to?.name??null,tint:to?.tint??'neutral',group_revision:version.group_revision+1});moved=1;}g.archived=true;g.revision++;state.mutations++;json(200,{group:{id:g.id,revision:g.revision},moved});return;}
      if(groupRoute[5]!==version.case_id||ws!==version.workspace_id){json(404,{error:'not_found'});return;}
      if(payload.expectedRevision!==version.group_revision){json(409,{error:'conflict'});return;}const to=payload.groupId?find(payload.groupId):null;if(payload.groupId&&!to){json(404,{error:'not_found'});return;}
      Object.assign(version,{group_id:to?.id??null,group_name:to?.name??null,tint:to?.tint??'neutral',group_revision:version.group_revision+1});json(200,{case:{id:version.case_id,groupId:version.group_id,groupRevision:version.group_revision}});return;
     }
     let operation=null;const prefix='/api/v1/admin/';
     const paths={facilitators:'facilitators_list','facilitators/search':'facilitators_search',cases:'cases_list',rooms:'rooms_list',audit:'audit_list','stepup/start':'stepup_start',stepup:'stepup_verify'};
     if(target.pathname.startsWith(prefix))operation=paths[target.pathname.slice(prefix.length)]??null;
     const profileMatch=new RegExp(`^${prefix}facilitators/([0-9a-f-]{36})/(disable|enable|soft-delete|restore)$`).exec(target.pathname);
     const profileUser=profileMatch?state.users.find(item=>item.id===profileMatch[1]):null;
     if(profileMatch&&profileUser)operation='facilitators_'+profileMatch[2].replace('-','_');
     if(target.pathname===`${prefix}cases/${version.case_id}/publish`)operation='cases_publish';if(target.pathname===`${prefix}versions/${version.version_id}/withdraw`)operation='versions_withdraw';if(target.pathname===`${prefix}rooms/${room.sessionId}/end`)operation='rooms_end';
     const reads=new Set(['facilitators_list','cases_list','rooms_list','audit_list']);
     if(!operation||request.method!==(reads.has(operation)?'GET':'POST')){json(404,{error:'not_found'});return;}
     const query=[...target.searchParams.keys()];if(reads.has(operation)?query.some(key=>!['page','perPage','limit','after'].includes(key)):query.length){json(400,{error:'bad_request'});return;}
     const payload=reads.has(operation)?{}:await body(request);state.calls.push({operation,body:payload});
     const pending=holds.get(operation);if(pending){pending.ready();await pending.wait;}if(response.destroyed)return;
     if(operation==='facilitators_list'||operation==='facilitators_search'){
      const page=operation==='facilitators_list'?Number(target.searchParams.get('page')):payload.page;
      if(operation==='facilitators_list'?(page<1||!Number.isSafeInteger(page)||target.searchParams.get('perPage')!=='100'):(!exact(payload,['query','page','perPage'])||typeof payload.query!=='string'||payload.query.length>320||payload.perPage!==100||!Number.isSafeInteger(page)||page<1)){json(400,{error:'bad_request'});return;}
      const users=operation==='facilitators_search'&&payload.query==='sparse'?[]:state.users;json(200,{users,nextPage:operation==='facilitators_search'&&payload.query==='sparse'&&page===1?2:null});return;
     }
     if(['cases_list','rooms_list','audit_list'].includes(operation)){
      const after=target.searchParams.get('after');if(target.searchParams.get('limit')!=='100'||(after&&(operation==='rooms_list'?!/^[0-9A-HJKMNP-TV-Z](?::[0-9A-HJKMNP-TV-Z]{6})?$/.test(after)||(after.includes(':')&&after[0]!==after[2]):!isUuidV7(after)))){json(400,{error:'bad_request'});return;}
      json(200,operation==='cases_list'?{versions:[state.version],nextCursor:null}:operation==='rooms_list'?{rooms:state.room?[state.room]:[],nextCursor:null}:{events:state.events,nextCursor:null});return;
     }
     if(['stepup_start','stepup_verify'].includes(operation)&&state.stepupMode){const failure={rate_limited:[429,'rate_limited'],down:[503,'admin_unavailable']}[state.stepupMode];if(failure){json(failure[0],{error:failure[1]});return;}}
     if(operation==='stepup_start'){if(!exact(payload,[])){json(400,{error:'bad_request'});return;}json(202,{accepted:true});return;}
     // Card 35 (R-a): one code opens a window for every destructive action until sign-out.
     if(operation==='stepup_verify'){if(!exact(payload,['code'])){json(400,{error:'bad_request'});return;}if(payload.code!==stepupCode){json(422,{error:'code_rejected'});return;}state.stepups=(state.stepups??0)+1;json(200,{elevation});return;}
     const failures={conflict:[409,'conflict'],protected:[403,'forbidden'],rate_limited:[429,'rate_limited'],reverted:[500,'change_reverted_audit_unavailable'],reconciliation:[500,'manual_reconciliation_needed']};
     if(state.actionMode&&failures[state.actionMode]&&(operation==='stepup_verify'||operation.startsWith('facilitators_')&&operation!=='facilitators_list'&&operation!=='facilitators_search'||operation==='cases_publish'||operation==='versions_withdraw'||operation==='rooms_end')){const [status,error]=failures[state.actionMode];json(status,{error});return;}
     if(DESTRUCTIVE.includes(operation)&&request.headers['x-admin-elevation']!==elevation){json(403,{error:'forbidden'});return;}
     if(operation==='facilitators_invite'){
      if(!exact(payload,['email'])||typeof payload.email!=='string'||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)){json(400,{error:'bad_request'});return;}
      const existing=state.users.find(item=>item.email===payload.email);if(existing){json(202,{accepted:true,userId:existing.id,idempotent:true});return;}
      const id=randomUUID();state.users.push({id,email:payload.email,invitedAt:stamp,confirmedAt:null,bannedUntil:null,createdAt:stamp,profile:null,label:null,access:{memberships:[],grants:[]}});state.invites++;json(202,{accepted:true,userId:id,idempotent:false});return;
     }
     if(operation==='facilitators_resend'){if(!exact(payload,[])||profileUser.confirmedAt){json(400,{error:'bad_request'});return;}state.resends++;json(202,{accepted:true,userId:profileUser.id});return;}
     if(operation.startsWith('facilitators_')){
      const destructive=['facilitators_disable','facilitators_soft_delete'].includes(operation);if(!profileUser?.profile||!exact(payload,destructive?['expectedRevision','confirmEmail']:['expectedRevision'])||(destructive&&payload.confirmEmail!==profileUser.email)||payload.expectedRevision!==profileUser.profile.admin_revision){json(409,{error:'conflict'});return;}
      const before={admin_revision:profileUser.profile.admin_revision};profileUser.profile.admin_revision++;if(operation==='facilitators_disable')profileUser.profile.disabled_at=stamp;if(operation==='facilitators_enable')profileUser.profile.disabled_at=null;if(operation==='facilitators_soft_delete'){profileUser.profile.soft_deleted_at=stamp;profileUser.profile.delete_due_at=new Date(Date.now()+30*86400000).toISOString();}if(operation==='facilitators_restore'){profileUser.profile.soft_deleted_at=null;profileUser.profile.delete_due_at=null;}state.mutations++;audit(operation.replace('facilitators_','facilitator_'),'facilitator',profileUser.id,before,{admin_revision:profileUser.profile.admin_revision});json(200,{profile:profileUser.profile});return;
     }
     if(operation==='cases_publish'||operation==='versions_withdraw'){
      const keys=operation==='cases_publish'?['expectedRevision','versionId']:['expectedRevision'];if(!exact(payload,keys)||payload.expectedRevision!==version.admin_revision||(operation==='cases_publish'&&payload.versionId!==version.version_id)){json(409,{error:'conflict'});return;}
      version.status=operation==='cases_publish'?'published':'withdrawn';version.admin_revision++;json(200,{version:{version_id:version.version_id,status:version.status,admin_revision:version.admin_revision}});return;
     }
     if(operation==='rooms_end'&&exact(payload,[])){state.room=null;json(200,{ended:true});return;}json(400,{error:'bad_request'});return;
    }
    const path=redirects.get(target.pathname)??target.pathname,file=resolve(outDir,path.slice(1));if(!file.startsWith(outDir+sep)){response.writeHead(404).end();return;}
    const bytes=await readFile(file),headers={'content-type':MIME[extname(file)]??'application/octet-stream'};for(const block of blocks)if(block.path.endsWith('*')?target.pathname.startsWith(block.path.slice(0,-1)):block.path===target.pathname)Object.assign(headers,block.headers);response.writeHead(200,headers).end(bytes);
   }catch{if(!response.headersSent)json(404,{error:'not_found'});else response.destroy();}
  });server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});await new Promise((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);});const origin=`${integrated?'https':'http'}://127.0.0.1:${server.address().port}`;auth.setAppOrigin(origin);
  if(integrated){worker=await startAdminWorker({authOrigin:auth.origin,caseOrigin:origin});auth.setJwt(worker.jwt);}
  return{origin,email,otp,stepupCode,state,hold,outDir,worker,async stop(){for(const entry of holds.values()){entry.ready();entry.release();}for(const socket of sockets)socket.destroy();await new Promise(done=>server.close(done));await worker?.stop();await auth.stop();await rm(temp,{recursive:true,force:true});}};
 }catch(error){if(server){for(const socket of sockets)socket.destroy();server.close();}await worker?.stop();await auth?.stop();await rm(temp,{recursive:true,force:true});throw error;}
}
