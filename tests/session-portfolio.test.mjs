import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from '../src/shared/ids.mjs';
import { miniCase } from './helpers/mini-case.mjs';
import { projectSessionRecord } from '../src/shared/session-record.mjs';
import { recordPage } from '../src/shared/session-record-wire.mjs';
import { handleSessionPortfolio } from '../src/worker/session-portfolio.mjs';
import { sessionPdf } from '../src/client/session-pdf.mjs';
const W=uuidv7(),S=uuidv7(),C=uuidv7(),V=uuidv7(),U=uuidv7(),at='2026-10-09T01:00:00Z';
function raw(){return {interpretationLimited:false,session:{id:S,workspaceId:W,caseId:C,versionId:V,versionNo:1,digest:'a'.repeat(64),title:'Teaching café',status:'ended',sourceStatus:'published',createdAt:at,startedAt:at,endedAt:at,expiresAt:at,own:true,manifest:null},boundary:'b'.repeat(64),document:miniCase().doc,items:[],eventCount:0,maxSeq:0,nextPosition:null};}
function deps({record=raw(),active=true,member=true,admin=false,userId=U}={}){return {env:admin?{ADMIN_EMAILS:'admin@example.org'}:{},verifyUser:async token=>token==='jwt'?{userId,email:'admin@example.org'}:null,rpc:{async call(name){if(name==='admin_account_active')return {ok:true,data:active};if(name==='get_me')return {ok:true,data:[{user_id:userId,admin,display_name:null,next_after:null,memberships:member||admin?[{workspace_id:W,role:'owner'}]:[]}]};if(name==='get_access')return {ok:true,data:[]};if(name==='read_session_portfolio')return {ok:true,data:record};return {ok:false,code:'XX000'};}}};}
const req=(body={sessionId:S,after:null},token='jwt')=>new Request('https://case.test/api/v1/portfolio/record',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify(body)});
const wire=x=>{const value=projectSessionRecord(x);delete value.nextPosition;return value;};
test('[AS-127] historical projection retains only reached teaching text and allowlisted aggregate evidence',()=>{
 const r=raw(),d=r.document.decisions[0],p=d.paths[0],id=uuidv7();
 r.items=[{type:'event',position:1,seq:1,eventId:id,epoch:0,kind:'consequence_revealed',at,payload:{decisionId:d.id,pathId:p.id,participantId:uuidv7(),displayName:'PRIVATE NAME',token:'PRIVATE TOKEN',publication:{occurrenceId:uuidv7(),beatId:r.document.beats[0].id,participantId:uuidv7(),manual:false}}}];r.eventCount=r.maxSeq=1;
 r.document.surfaces[0].notes='UNREACHED PRIVATE CUE';const output=wire(r);assert.equal(recordPage(output),output);
 assert.equal(output.items[0].details.rationale,p.rationale);assert.doesNotMatch(JSON.stringify(output),/PRIVATE NAME|PRIVATE TOKEN|UNREACHED PRIVATE CUE|participantId/);
 const poisoned=structuredClone(output);poisoned.items[0].details.publication.participantId=uuidv7();assert.throws(()=>recordPage(poisoned),/invalid_record/);
 r.items[0].payload.publication.surfaceId=r.document.surfaces[1].id;r.document.surfaces[1].notes='Reached teaching note';
 const reached=wire(r);assert.equal(recordPage(reached).items[0].details.teachingNotes,'Reached teaching note');assert.doesNotMatch(JSON.stringify(reached),/UNREACHED PRIVATE CUE/);
 const terminal=d.paths.find(path=>path.terminal);r.items[0].payload.pathId=terminal.id;
 assert.equal(wire(r).items[0].details.debriefPrompt,terminal.terminal.debrief_prompt);
});
test('legacy missing publication references and unknown interpretation never claim a complete record',()=>{
 const r=raw();r.eventCount=r.maxSeq=1;r.session.manifest={interpretation:1,versionId:V,revision:1,epoch:0,seq:1,roundCount:0,joined:0};
 r.items=[{type:'event',position:1,seq:1,eventId:uuidv7(),epoch:0,kind:'beat_entered',at,payload:{beatId:r.document.beats[0].id}}];assert.equal(wire(r).completeness,'limited');
 r.items[0].kind='future_unknown_event';assert.equal(wire(r).completeness,'limited');
 r.session.manifest.interpretation=2;assert.throws(()=>wire(r),/invalid_manifest/);
});
test('record pages enforce complete-order ranking and bound wire bytes with ordered continuation',()=>{
 const r=raw(),d=r.document.decisions[0];d.interaction={type:'ranking',options:d.interaction.options};
 const a=d.interaction.options.slice(0,2),aggregate={total:2,counts:{[a[0].id]:2},rankCount:1,eligibleOptionIds:a.map(x=>x.id),positionCounts:Object.fromEntries(d.interaction.options.map(x=>[x.id,[x.id===a[0].id?2:0]])),completeOrders:[['0',2]],privateAnswers:{name:'PRIVATE'}};
 r.items=[{type:'round',position:1,id:uuidv7(),decisionId:d.id,number:1,status:'resolved',openedAt:at,closedAt:at,pathId:null,resolution:null,aggregate}];
 const output=wire(r);assert.equal(recordPage(output).items[0].aggregate.completeOrders[0].count,2);assert.doesNotMatch(JSON.stringify(output),/privateAnswers|PRIVATE/);
 r.items[0].aggregate.completeOrders=[['0',1]];assert.throws(()=>wire(r),/invalid_ranking/);
 const large=raw();large.document.learning_objectives=[];const prompt='Teaching sentence '.repeat(1000);large.document.decisions[0].prompt=prompt;
 large.items=Array.from({length:100},(_,i)=>({type:'event',position:i+1,seq:i+1,eventId:uuidv7(),epoch:0,kind:'path_selected',at,payload:{decisionId:large.document.decisions[0].id,pathId:large.document.decisions[0].paths[0].id}}));large.eventCount=large.maxSeq=100;
 const bounded=projectSessionRecord(large);assert.ok(JSON.stringify(bounded).length<262144);assert.ok(bounded.items.length<100);assert.equal(bounded.nextPosition,bounded.items.at(-1).position);
});
test('[AS-127] every record read checks account, current membership and starter; cursors bind actor/session/boundary',async()=>{
 assert.equal((await handleSessionPortfolio(req(),deps({active:false}))).status,403);
 assert.equal((await handleSessionPortfolio(req(),deps({member:false}))).status,403);
 const foreign=raw();foreign.session.own=false;assert.equal((await handleSessionPortfolio(req(),deps({record:foreign}))).status,503);
 assert.equal((await handleSessionPortfolio(req(),deps({record:foreign,admin:true,member:false}))).status,200);
 assert.equal((await handleSessionPortfolio(req({},'room-capability'),deps())).status,401);
 const r=raw();r.nextPosition=1;const first=await handleSessionPortfolio(req(),deps({record:r}));assert.equal(first.status,200);assert.equal(first.headers.get('cache-control'),'no-store');const body=await first.json();assert.ok(body.nextAfter);
 assert.equal((await handleSessionPortfolio(req({sessionId:S,after:body.nextAfter}),deps({userId:uuidv7()}))).status,400);
 assert.equal((await handleSessionPortfolio(req({sessionId:uuidv7(),after:body.nextAfter}),deps())).status,400);
 const changed=raw();changed.boundary='c'.repeat(64);assert.equal((await handleSessionPortfolio(req({sessionId:S,after:body.nextAfter}),deps({record:changed}))).status,503);
 assert.equal((await handleSessionPortfolio(req({sessionId:S,after:null,admin:true}),deps())).status,400);
});
test('[AS-128] built-in PDF has embedded Unicode font, reading-order tags, exact non-ASCII text and bounded pagination',()=>{
 const bytes=sessionPdf([['H1','Teaching café'],...Array.from({length:150},(_,i)=>['P',`Recorded activity ${i+1}: naïve résumé − 20.`])],{title:'Teaching café'}),pdf=new TextDecoder('latin1').decode(bytes);
 assert.ok(bytes.length<2*1048576);for(const marker of ['/StructTreeRoot','/ParentTree','/MarkInfo','/Marked true','/Lang (en)','/FontFile2','/ToUnicode','/StructParents','/Tabs /S'])assert.ok(pdf.includes(marker),marker);
 assert.match(pdf,/\/Count [2-9]/);assert.doesNotMatch(pdf,/\/Author|https:|Bearer/);
 assert.throws(()=>sessionPdf([['P','中']]),/pdf_font_unsupported/);
 assert.throws(()=>sessionPdf(Array.from({length:100},()=>['P','A paragraph.']),{maxPages:1}),/pdf_page_budget/);
});

test('a later-page interpretation gap limits the first page, and formatted lists preserve order',()=>{
 const r=raw();r.session.manifest={interpretation:1,versionId:V,revision:0,epoch:0,seq:0,roundCount:0,joined:0};
 assert.equal(wire(r).completeness,'complete');r.interpretationLimited=true;assert.equal(wire(r).completeness,'limited');
 r.document.schema_version=2;r.document.learning_objectives=[{blocks:[{type:'list',ordered:true,items:[{runs:[{text:'First'}]},{runs:[{text:'Second',bold:true}]}]}]}];
 assert.deepEqual(wire(r).intendedObjectives,['1. First 2. Second']);
});

// J10 (card 59 M3; Julian, 2026-10-15): the facilitator's session PDF carries the images of the slides the session reached.
test('[AS-168] a record part lists the images on the slides its publications reached, never one from a slide it did not', () => {
 const r=raw(),doc=r.document,reached=doc.beats[0].id,other=doc.beats[1].id,A=uuidv7(),B=uuidv7();
 doc.schema_version=3;doc.blocks=[{id:uuidv7(),type:'image',asset_id:A,alt:'12-lead ECG on arrival',caption:'Lead II',fit:'contain',ecg:null},{id:uuidv7(),type:'image',asset_id:B,alt:'Unreached CXR',caption:'',fit:'contain',ecg:null}];
 doc.compositions=[{id:uuidv7(),owner:{kind:'beat',id:reached},reading_order:[doc.blocks[0].id]},{id:uuidv7(),owner:{kind:'beat',id:other},reading_order:[doc.blocks[1].id]}];
 r.items=[{type:'event',position:1,seq:1,eventId:uuidv7(),epoch:0,kind:'beat_entered',at,payload:{beatId:reached,publication:{occurrenceId:uuidv7(),beatId:reached,groupsShown:1}}}];
 const page=wire(r);
 assert.deepEqual(page.images,[{assetId:A,alt:'12-lead ECG on arrival',caption:'Lead II'}]);
 assert.equal(recordPage(page),page);
 const poisoned=structuredClone(page);poisoned.images[0].participantId=uuidv7();assert.throws(()=>recordPage(poisoned),/invalid_record/);
 delete page.images;assert.equal(recordPage(page),page,'a page without images (an older record) still validates');
});
test('[AS-168] the session PDF places each image unchanged as a tagged figure with its text alternative', () => {
 const jpeg=Uint8Array.from([255,216,255,224,0,16,74,70,73,70,0,1,1,0,0,1,0,1,0,0,255,192,0,17,8,0,200,1,44,3,1,34,0,2,17,1,3,17,1,255,217]);
 const pdf=sessionPdf([['H1','Teaching café'],['FIG',{bytes:jpeg,alt:'12-lead ECG on arrival',caption:'Lead II'}]]),text=new TextDecoder('latin1').decode(pdf);
 assert.match(text,/\/Subtype \/Image \/Width 300 \/Height 200 \/ColorSpace \/DeviceRGB \/BitsPerComponent 8 \/Filter \/DCTDecode/);
 assert.match(text,/\/S \/Figure \/Alt <FEFF/);
 assert.match(text,/\/XObject << \/Im0 \d+ 0 R >>/);
 const at=pdf.findIndex((_,i)=>jpeg.every((byte,j)=>pdf[i+j]===byte));assert.ok(at>0,'the JPEG bytes are embedded exactly');
 assert.throws(()=>sessionPdf([['FIG',{bytes:new TextEncoder().encode('<svg/>'),alt:'x',caption:''}]]),/pdf_input/);
 assert.throws(()=>sessionPdf([['FIG',{bytes:jpeg,alt:'x',caption:''}]],{maxBytes:100}),/pdf_byte_budget/);
});
test('[AS-168] a record image is served only as an approved JPEG the session pins, to its starter, under the image response policy', async () => {
 const A=uuidv7(),body=JSON.stringify({sessionId:S,assetId:A}),store=new Map([['media/'+W+'/'+'a'.repeat(64)+'.jpg',Uint8Array.from([255,216,255,217])]]);
 const call=(rows,{code=null,media=true,payload=body}={})=>{const d=deps();const rpc={async call(name,args){if(name==='session_media_rendition'){assert.deepEqual([args.p_session_id,args.p_asset_id],[S,A]);return code?{ok:false,code}:{ok:true,data:rows};}return d.rpc.call(name,args);}};
  return handleSessionPortfolio(new Request('https://case.test/api/v1/portfolio/media',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer jwt'},body:payload}),
   {...d,rpc,env:{...d.env,...(media?{MEDIA:{async get(key){const bytes=store.get(key);return bytes?{body:bytes,size:bytes.length}:null;}}}:{})}});};
 const served=await call([{status:'approved',r2_key:'media/'+W+'/'+'a'.repeat(64)+'.jpg',byte_size:4}]);
 assert.equal(served.status,200);assert.equal(served.headers.get('content-type'),'image/jpeg');assert.match(served.headers.get('content-security-policy'),/sandbox/);
 assert.equal((await call([{status:'withdrawn',r2_key:null,byte_size:4}])).status,410);
 assert.equal((await call([])).status,404);
 assert.equal((await call([],{code:'42501'})).status,403);
 assert.equal((await call([],{payload:JSON.stringify({sessionId:S,assetId:'not-an-id'})})).status,400);
 assert.equal((await call([],{media:false})).status,503);
});


test('v2 teaching summaries add distinct lifetime participant evidence without changing the legacy response or authority',async()=>{
 const calls=[],row={id:S,case_id:C,case_version_id:V,title:'Every Breath You Take',version_no:1,status:'ended',created_at:at,started_at:at,ended_at:at,expires_at:at,archive_state:'complete',own:true};let evidence={joined:18,joined_exact:true};const f=deps(),base=f.rpc.call;
 f.rpc.call=async(name,args)=>{calls.push({name,args});if(name==='query_teaching_session_portfolio')return {ok:true,data:{rooms:[{...row,...evidence}],nextAfter:null}};if(name==='query_session_portfolio')return {ok:true,data:{rooms:[row],nextAfter:null}};return base(name,args);};
 const query=body=>new Request('https://case.test/api/v1/portfolio/query',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer jwt'},body:JSON.stringify({workspaceId:W,query:'',status:'all',from:null,until:null,after:null,personal:true,...body})});
 let response=await handleSessionPortfolio(query({v:2}),f);assert.equal(response.status,200);let value=await response.json();assert.equal(value.rooms[0].joined,18);assert.equal(value.rooms[0].joinedExact,true);assert.equal(value.rooms[0].title,'Every Breath You Take');assert.equal(calls.find(x=>x.name==='query_teaching_session_portfolio').args.p_case_id,null);
 response=await handleSessionPortfolio(query({}),f);assert.equal(response.status,200);value=await response.json();assert.ok(!Object.hasOwn(value.rooms[0],'joined'));
 for(const bad of [{joined:-1,joined_exact:true},{joined:null,joined_exact:true},{joined:1000001,joined_exact:false}]){evidence=bad;assert.equal((await handleSessionPortfolio(query({v:2}),f)).status,503);}
 assert.equal((await handleSessionPortfolio(query({v:3}),f)).status,400);
});

test('past workspace discovery is verified-self, paged, bounded and rejects forged or malformed evidence',async()=>{
 const calls=[],base=deps(),invoke=(body,result={workspaces:[{id:W,name:'Original home'}],nextAfter:null})=>handleSessionPortfolio(new Request('https://case.test/api/v1/portfolio/workspaces',{method:'POST',headers:{authorization:'Bearer jwt','content-type':'application/json'},body:JSON.stringify(body)}),{...base,rpc:{call:async(name,args)=>{if(name==='personal_record_workspaces'){calls.push(args);return {ok:true,data:result};}return base.rpc.call(name,args);}}});
 const response=await invoke({after:null});assert.equal(response.status,200);assert.deepEqual(calls,[{p_user_id:U,p_after:null}]);
 assert.equal((await invoke({after:null,userId:uuidv7()})).status,400);assert.equal(calls.length,1);
 assert.equal((await invoke({after:null},{workspaces:[{id:W,name:'Original home',role:'owner'}],nextAfter:null})).status,503);
 assert.equal((await invoke({after:W},{workspaces:[{id:W,name:'Original home'}],nextAfter:null})).status,503,'cursor cannot replay an earlier scope');
 assert.equal((await invoke({after:null},{workspaces:[],nextAfter:W})).status,503);
});
