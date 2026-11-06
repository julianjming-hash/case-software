// Strict counts-only persistence policy shared by phone recovery and common-role teardown.
import {isUuidV7} from '../shared/ids.mjs';
// Exact narrow parser supplied by the independent authority foundation (differentially matched to wire).
import {parseVoteEnvelope} from '../shared/vote-envelope.mjs';
import {OUTBOX_LIMIT,isVoteResponse} from './vote-policy.mjs';
import {openVoteStore} from './vote-store.mjs';
export const PARTICIPANT_TOKEN_MAX_MS=48*60*60_000;
const refused=()=>({preserve:false,count:0});
function validCredential(sessionId,credential,now) {
  if(!isUuidV7(sessionId)||!credential||Object.keys(credential).sort().join(',')!=='expiresAt,sessionId,token'||
      credential.sessionId!==sessionId||typeof credential.token!=='string'||!/^[A-Za-z0-9._~-]{16,4096}$/.test(credential.token)||
      !Number.isSafeInteger(credential.expiresAt)||credential.expiresAt<=now||credential.expiresAt>now+PARTICIPANT_TOKEN_MAX_MS)return false;
  return true;
}
export function validateParticipantRecovery({ role, sessionId, credential, rows, now = Date.now(), knownInventory }) {
  if(role!=='participant'||knownInventory!==true||!validCredential(sessionId,credential,now)||!Array.isArray(rows)||rows.length>OUTBOX_LIMIT)return refused();
  const ids = new Set();
  for (const row of rows) {
    if (!row || Object.keys(row).filter(key=>key!=='admitted').sort().join(',')!=='envelope,participantId,roomId,superseded' ||
        ('admitted' in row && typeof row.admitted !== 'boolean') ||
        row.roomId !== sessionId || row.participantId !== rows[0].participantId || typeof row.superseded !== 'boolean' ||
        !parseVoteEnvelope(row.envelope).ok ||
        ![row.participantId,row.envelope.clientEventId,row.envelope.roundId].every(isUuidV7) || !isVoteResponse(row.envelope.response) || ids.has(row.envelope.clientEventId)) return refused();
    ids.add(row.envelope.clientEventId);
  }
  return { preserve: true, count: rows.filter(row => !row.superseded).length };
}

/** Room inventory is bounded and exact. It authorizes preservation, never display or transmission. */
export function participantRoomInventory(localStorage, now=Date.now()) {
  const rooms=new Map(), expired=new Map(),keys=[];
  for(let i=0;i<(localStorage?.length??0);i++) {
    const key=localStorage.key(i);
    if(!/^case:participant:[^:]+:token$/.test(key??''))continue;
    const slot=key.slice(17,-6);
    if(slot!=='main'&&!isUuidV7(slot))continue; // Explicit lab slots stay outside the served-phone upgrade.
    let credential;try{credential=JSON.parse(localStorage.getItem(key));}catch{continue;}
    const checkedAt=Number.isSafeInteger(credential?.expiresAt)&&credential.expiresAt<=now?credential.expiresAt-1:now;
    if(!validCredential(credential?.sessionId,credential,checkedAt))continue;
    if(slot!=='main'&&slot!==credential.sessionId)throw new Error('invalid_participant_owner');
    const existing=rooms.get(credential.sessionId)??expired.get(credential.sessionId);
    if(existing&&(existing.credential.token!==credential.token||existing.credential.expiresAt!==credential.expiresAt))throw new Error('conflicting_participant_owner');
    if(credential.expiresAt<=now)expired.set(credential.sessionId,{credential,key});
    else {rooms.set(credential.sessionId,{credential,key});keys.push(key);}
  }
  return {rooms,expired,keys};
}

export function validateRoomRows(rows, inventory, now=Date.now()) {
  if(!Array.isArray(rows)||rows.length>1000)return false;
  const ids=new Set();
  for(const [roomId,{credential}] of [...inventory.rooms,...inventory.expired]) {
    const own=rows.filter(row=>row?.roomId===roomId);
    if(!validateParticipantRecovery({role:'participant',sessionId:roomId,credential,rows:own,knownInventory:true,now:credential.expiresAt<=now?credential.expiresAt-1:now}).preserve)return false;
  }
  for(const row of rows) {
    if(!inventory.rooms.has(row?.roomId)&&!inventory.expired.has(row?.roomId)||ids.has(row?.envelope?.clientEventId))return false;
    ids.add(row.envelope.clientEventId);
  }
  return true;
}


/** Synchronous late-key check; a concurrent validated room commit shares the origin lock. */
export function validScopedParticipantKey(key,value,now=Date.now()) {
  if(!/^case:participant:[0-9a-f-]{36}:token$/.test(key??''))return false;
  try{return validCredential(key.slice(17,-6),JSON.parse(value),now);}catch{return false;}
}

/** Revalidate the captured expiry owner inside the origin-serialized row update, then compare again
 * after commit. A missing old key cannot authorize erasing a replacement participant's answers. */
export function expiredRoomUpdate(storage,roomId,{credential:{token,expiresAt}},now=Date.now) {
  return rows=>{
    const scope=participantRoomInventory(storage,now()).expired.get(roomId);
    if(!scope||scope.credential.token!==token||scope.credential.expiresAt!==expiresAt)return {rows,result:null};
    const expected=JSON.stringify(scope.credential);
    if(storage.getItem(scope.key)!==expected)return {rows,result:null};
    return {rows:[],result:null,afterCommit:()=>{if(storage.getItem(scope.key)===expected)storage.removeItem(scope.key);}};
  };
}

/** Lazy common-role navigation exception: validated room credentials and their bounded known queue only. */
export async function prepareParticipantPreservation(options) {
  let keys=[];
  try {
    for(const store of [options.sessionStorage,options.localStorage]) {
      if(!store||store.length>1000)return {status:'unavailable'};
      for(let i=0;i<store.length;i++)keys.push(store.key(i));
    }
    try{options.assertKnownStorageKeys(keys);}catch{return {status:'invalid'};}
    const databases=await options.indexedDB.databases();
    if(!Array.isArray(databases)||databases.some(db=>!db?.name||/^(case:|case-lab:)/.test(db.name)&&!options.knownDatabases.includes(db.name)))return {status:'invalid'};
  }catch{return {status:'unavailable'};}
  let owners;
  try{owners=participantRoomInventory(options.localStorage);}catch{return {status:'invalid'};}
  if(!owners.rooms.size)return {status:'none'};
  let store;
  try {
    store=await (options.openStore??openVoteStore)(options);
    const valid=await store.readAll(rows=>{owners=participantRoomInventory(options.localStorage);return validateRoomRows(rows,owners);});
    if(!valid)return {status:'invalid'};
    for(const [roomId,expired] of owners.expired) {
      await store.update(roomId,expiredRoomUpdate(options.localStorage,roomId,expired));
    }
    return {status:'known',keys:owners.keys,keepCurrent:validScopedParticipantKey};
  }catch(error){return {status:error?.code==='invalid_storage_inventory'?'invalid':'unavailable'};}
  finally{try{await store?.close();}catch{}}
}
