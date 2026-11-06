// Counts-only validation before participant private-storage cleanup. No draft is returned.
import { normalizeCode, JOIN_CODE_LENGTH, isUuidV7 } from '../shared/ids.mjs';
import {validateParticipantRecovery,participantRoomInventory,validateRoomRows} from './storage-policy.mjs';
export {validateParticipantRecovery,participantRoomInventory,validateRoomRows} from './storage-policy.mjs';
import { openVoteStore } from './vote-store.mjs';
import { apiPath } from '../shared/urls.mjs';

const refused = () => ({ preserve: false, count: 0 });

export async function readParticipantRecovery({ openStore = openVoteStore, timeoutMs = 1000, ...state }) {
  if (!validateParticipantRecovery({ ...state, rows: [] }).preserve) return refused();
  let store, timer, expired = false;
  const unavailable=()=>({preserve:false,count:0,status:'unavailable'});
  const duration = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(1000, timeoutMs)) : 1000;
  const read = Promise.resolve().then(async () => {
    store = await openStore();
    if (expired) { store.close().catch(() => {}); return refused(); }
    try { return validateParticipantRecovery({ ...state, rows: await store.read(state.sessionId) }); }
    catch (error) { return error?.code==='invalid_storage_inventory'?refused():unavailable(); }
  }).catch(error=>error?.code==='invalid_storage_inventory'?refused():unavailable());
  const deadline = new Promise(resolve => { timer = setTimeout(() => { expired = true; resolve(unavailable()); }, duration); });
  try { return await Promise.race([read, deadline]); }
  finally { clearTimeout(timer); store?.close().catch(() => {}); }
}

/** A QR never resumes a different saved room; transient failure leaves the decision pending. */
export async function recoverJoinCapability({code,credential,fetch=globalThis.fetch,timeoutMs=10_000}) {
  const normalized = normalizeCode(code,JOIN_CODE_LENGTH);
  if (!normalized || normalized.length !== JOIN_CODE_LENGTH ||
      !validateParticipantRecovery({role:'participant',sessionId:credential?.sessionId,credential,rows:[],knownInventory:true}).preserve) return {status:'refused'};
  const controller=new AbortController();let timer,reader,responseBody;
  const unavailable=()=>({status:'unavailable'});
  const task=Promise.resolve().then(async()=>{
    const response=await fetch(apiPath('join','recover'),{method:'POST',credentials:'omit',redirect:'manual',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal,
      headers:{'content-type':'application/json',authorization:`Bearer ${credential.token}`},body:JSON.stringify({code:normalized,sessionId:credential.sessionId})});
    responseBody=response.body;
    if(controller.signal.aborted){try{Promise.resolve(response.body?.cancel()).catch(()=>{});}catch{/* Late response is discarded. */}return unavailable();}
    const forbidden=response.status===403;
    if(!response.ok&&!forbidden)return [401,404,410].includes(response.status)?{status:'refused'}:unavailable();
    if(!response.body||Number(response.headers.get('content-length')||0)>1024)return {status:'refused'};
    reader=response.body.getReader();const chunks=[];let n=0;
    for(;;){const next=await reader.read();if(next.done)break;n+=next.value.byteLength;if(n>1024)return {status:'refused'};chunks.push(next.value);}
    const bytes=new Uint8Array(n);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.byteLength;}
    let body;try{body=JSON.parse(new TextDecoder().decode(bytes));}catch{return response.status===200?unavailable():{status:'refused'};}
    if(forbidden)return {status:body&&Object.keys(body).length===1&&body.error==='code_mismatch'?'foreign':'refused'};
    return body&&Object.keys(body).length===1&&body.sessionId===credential.sessionId?{status:'recovered',sessionId:body.sessionId}:{status:'refused'};
  }).catch(unavailable);
  const duration=Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=10_000?timeoutMs:10_000;
  const deadline=new Promise(resolve=>{timer=setTimeout(()=>resolve(unavailable()),duration);});
  try{return await Promise.race([task,deadline]);}
  finally{clearTimeout(timer);controller.abort();try{Promise.resolve(reader ? reader.cancel() : responseBody?.cancel()).catch(()=>{});}catch{/* Cancellation cannot hold recovery. */}}
}

/** Enumerate actual writers' storage before choosing the participant-only preservation exception. */
export async function inspectPhoneInventory({sessionStorage,localStorage,indexedDB,assertKnownStorageKeys,knownDatabases,timeoutMs=1000,detailed=false}) {
  const result=status=>detailed?{status}:status==='known';
  let timer;
  try {
    const keys=[];
    for(const store of [sessionStorage,localStorage]){
      if(!store||!Number.isInteger(store.length)||store.length<0)return result('unavailable');
      if(store.length>1000)return result('invalid');
      for(let i=0;i<store.length;i++){const key=store.key(i);if(typeof key!=='string')return result('invalid');keys.push(key);}
    }
    try { assertKnownStorageKeys(keys); } catch { return result('invalid'); }
    if(!indexedDB?.databases||!Array.isArray(knownDatabases))return result('unavailable');
    const duration=Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=1000?timeoutMs:1000;
    const expired=new Promise(resolve=>{timer=setTimeout(()=>resolve(null),duration);});
    const databases=await Promise.race([Promise.resolve().then(()=>indexedDB.databases()).catch(()=>null),expired]);
    if(!Array.isArray(databases))return result('unavailable');
    if(databases.length>1000)return result('invalid');
    return result(databases.every(db=>typeof db?.name==='string'&&(!/^(case:|case-lab:)/.test(db.name)||knownDatabases.includes(db.name)))?'known':'invalid');
  }catch{return result('unavailable');}finally{clearTimeout(timer);}
}
