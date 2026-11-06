import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare,convertV4MiniflareOptions } from 'miniflare';
import { fileURLToPath } from 'node:url';
import { uuidv7,newJoinCode } from '../src/shared/ids.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
async function worker() {
  const bundled=await build({stdin:{contents:`
    import {RoomDO} from './src/worker/room-do.mjs';
    import fixture from './src/fixtures/synthetic-workshop.case.json';
    export class ObservedRoom extends RoomDO {
      constructor(ctx,env) {
        const points=[],sent=[];
        super(ctx,{...env,DIRECTORY:{idFromName:name=>name,get:()=>({release:async()=>{}})},METRICS:{writeDataPoint:p=>points.push(p)},ALERTS:{idFromName:()=> 'alerts',get:()=>({send:async e=>{sent.push(e);return {ok:true};}})}});
        this.points=points;this.sent=sent;
        this.archiveClient={call:async()=>({ok:false,kind:'unavailable'})};
      }
      prepareArchive() {
        this.archiveClient={call:async()=>({ok:false,kind:'unavailable'})};
        this.sql.exec('UPDATE journal SET pending_at=? WHERE archived=0',Date.now()-121000);
      }
      inspect() {return {points:this.points,sent:this.sent,revision:this.state?.revision,roundId:this.state?.round?.id,optionId:fixture.decisions.find(d=>d.id===this.state?.decisionId)?.interaction?.options?.[0]?.id};}
      expireNow() {
        const past=Date.now()-1;
        this.sql.exec("UPDATE meta SET value=? WHERE key='expires_at'",String(past-24*60*60*1000));
        return this.alarm();
      }
    }
    export default {async fetch(request,env) {
      const input=await request.json(),stub=env.ROOM.get(env.ROOM.idFromName(input.id));
      let result;
      if(input.action==='create') result=await stub.create({...input.args,caseDoc:fixture});
      else if(input.action==='join') result=await stub.join('Private Name','shadows-01');
      else if(input.action==='command') result=await stub.command(input.token,input.body);
      else if(input.action==='archive') {await stub.prepareArchive();await stub.flushArchive();}
      else if(input.action==='delete') await stub.expireNow();
      return Response.json({result:result??null,observed:await stub.inspect()});
    }};`,resolveDir:root},bundle:true,write:false,format:'esm',platform:'browser',loader:{'.sql':'text'},external:['cloudflare:workers']});
  return new Miniflare(convertV4MiniflareOptions({script:bundled.outputFiles[0].text,modules:true,compatibilityDate:'2026-08-22',
    durableObjects:{ROOM:{className:'ObservedRoom',useSQLite:true}},bindings:{CASE_ENV:'staging',BUILD_SHA:'a'.repeat(40),BROADCAST_COALESCE_MS:'0',LOCK_GRACE_MS:'0',AUTO_LOCK_MS:'0'},
    outboundService:()=>{throw new Error('unexpected outbound');}}));
}
const action=async(mf,id,input)=>(await mf.dispatchFetch('http://localhost/',{method:'POST',body:JSON.stringify({id,...input})})).json();
async function create(mf,associated=false){const id=uuidv7();const result=await action(mf,id,{action:'create',args:{sessionId:id,joinCode:newJoinCode(),ownerUserId:uuidv7(),archiveSessionId:associated?id:null}});return {id,...result.result};}
const command=(mf,room,type,eventId=uuidv7(),expectRevision)=>action(mf,room.id,{action:'command',token:room.facilitatorToken,body:{v:1,type,epoch:0,clientEventId:eventId,...(expectRevision===undefined?{}:{expectRevision})}});
test('native RoomDO records create join receipts and one end transition without identities',{timeout:15000},async()=> {
  const mf=await worker();
  try {
    const room=await create(mf),startId=uuidv7();
    const participant=await action(mf,room.id,{action:'join'});
    const started=await command(mf,room,'start',startId);await command(mf,room,'start',startId);
    const openingFinding=await command(mf,room,'advance',uuidv7(),started.observed.revision);assert.equal(openingFinding.result.receipt.receipt,'accepted');assert.equal(openingFinding.observed.roundId,undefined);
    const decisionScene=await command(mf,room,'advance',uuidv7(),openingFinding.observed.revision);assert.equal(decisionScene.result.receipt.receipt,'accepted');assert.equal(decisionScene.observed.roundId,undefined);
    const decisionObservations=await command(mf,room,'advance',uuidv7(),decisionScene.observed.revision);assert.equal(decisionObservations.result.receipt.receipt,'accepted');assert.equal(decisionObservations.observed.roundId,undefined);
    const decisionFindings=await command(mf,room,'advance',uuidv7(),decisionObservations.observed.revision);assert.equal(decisionFindings.result.receipt.receipt,'accepted');assert.equal(decisionFindings.observed.roundId,undefined);
    const opened=await command(mf,room,'advance',uuidv7(),decisionFindings.observed.revision);assert.equal(opened.result.receipt.receipt,'accepted');assert.ok(opened.observed.roundId);
    const pause=await command(mf,room,'pause');assert.equal(pause.result.receipt.reason,'retired');
    const vote=()=>action(mf,room.id,{action:'command',token:participant.result.token,
      body:{v:1,type:'vote',epoch:0,clientEventId:uuidv7(),roundId:opened.observed.roundId,response:{option_id:opened.observed.optionId}}});
    assert.equal((await vote()).result.receipt.receipt,'accepted');
    const lockedRoom=await command(mf,room,'lock');
    assert.equal((await vote()).result.receipt.receipt,'locked');
    const stale=await action(mf,room.id,{action:'command',token:room.facilitatorToken,body:{v:1,type:'advance',epoch:1,clientEventId:uuidv7(),expectRevision:lockedRoom.observed.revision}});
    assert.equal(stale.result.receipt.receipt,'stale_epoch');
    await command(mf,room,'end');
    const after=await action(mf,room.id,{action:'join'});
    const labels=after.observed.points.map(p=>[p.blobs[0],p.blobs[4],p.doubles[0]]);
    assert.equal(labels.filter(p=>p[0]==='room_created').length,1);
    assert.equal(labels.filter(p=>p[0]==='room_ended').length,1);
    assert.equal(labels.filter(p=>p[0]==='join_ok').length,1);assert.equal(labels.filter(p=>p[0]==='join_fail').length,1);
    assert.deepEqual(labels.filter(p=>p[0]==='receipt').map(p=>p[1]),['accepted','already_accepted','accepted','accepted','accepted','accepted','accepted','rejected','accepted','accepted','locked','stale_epoch','accepted']);
    for(const point of after.observed.points){assert.equal(point.blobs.length,5);assert.equal(point.blobs[1],'staging');assert.equal(point.blobs[2],'a'.repeat(40));assert.ok(!JSON.stringify(point).includes(room.id));assert.ok(!JSON.stringify(point).includes('Private Name'));}
  }finally{await mf.dispose();}
});
test('[AS-081] native RoomDO samples eligible lag and failed archive then alerts with counts before nonblocking deletion',{timeout:15000},async()=> {
  const mf=await worker();
  try {
    const room=await create(mf,true);await action(mf,room.id,{action:'join'});await command(mf,room,'start');
    const failed=await action(mf,room.id,{action:'archive'});
    const lag=failed.observed.points.find(p=>p.blobs[0]==='archive_lag_s'&&p.doubles[0]>120);assert.ok(lag?.doubles[0]>120);
    assert.ok(failed.observed.points.some(p=>p.blobs[0]==='archive_fail'));
    assert.ok(failed.observed.sent.some(e=>e.kind==='archive_lag_s'&&e.value>120));
    assert.ok(failed.observed.sent.some(e=>e.kind==='archive_fail'));
    const deleted=await action(mf,room.id,{action:'delete'});assert.equal(deleted.observed.revision,undefined);
    const alert=deleted.observed.sent.find(e=>e.kind==='delete_before_archive');assert.ok(alert);
    assert.ok(alert.counts.participants>0);assert.ok(alert.counts.journal>0);
    assert.deepEqual(Object.keys(alert).sort(),['counts','kind']);
    assert.ok(Object.keys(alert.counts).every(k=>['participants','rounds','responses','journal','endSession'].includes(k)));
    assert.ok(deleted.observed.points.some(p=>p.blobs[0]==='delete_before_archive'));
  }finally{await mf.dispose();}
});
