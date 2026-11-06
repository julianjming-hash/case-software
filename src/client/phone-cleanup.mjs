import { createTeardown, TEARDOWN_KEYS } from './teardown.mjs';
import { credentialKey } from './transport.mjs';
import { normalizeCode, JOIN_CODE_LENGTH } from '../shared/ids.mjs';
import {validateParticipantRecovery,participantRoomInventory,validateRoomRows,validScopedParticipantKey,expiredRoomUpdate} from './storage-policy.mjs';
import {inspectPhoneInventory} from './phone-recovery.mjs';
import { assertKnownStorageKeys } from './teardown.mjs';
import { openVoteStore } from './vote-store.mjs';
import { storageBarrier } from './storage-barrier.mjs';
const JOIN_DRAFT='case:phone:join-code-draft';
const GLOBAL_REASONS=new Set(['sign_out','account_changed','account_change','next_load_failed']);
/** Room loss erases only proven ownership; account/security fences remain origin-wide. */
export function createPhoneCleanup({selection=()=>null,privacyReturn=()=>false,now=Date.now,
  openStore=openVoteStore,...options}={}) {
  return function cleanup(reason,{provenInvalid=false}={}) {
    const navigation=reason==='pagehide'||reason==='next_load';
    let selected=null,candidate=null,keepDraft=false;
    try {
      candidate=selection();
      if(navigation && candidate?.queueValidated===true && validateParticipantRecovery({...candidate,rows:[],now:now()}).preserve) selected=candidate;
      const code=options.sessionStorage?.getItem(JOIN_DRAFT);
      keepDraft=reason==='pagehide' && privacyReturn()===true && typeof code==='string' && code.length===JOIN_CODE_LENGTH && normalizeCode(code,JOIN_CODE_LENGTH)===code;
    } catch { selected=null;keepDraft=false; }
    // Clear memory synchronously, before bounded validation. The persisted binding is a separate value.
    let memoryComplete=true;try{options.clearMemory?.(reason);}catch{memoryComplete=false;}
    const common={...options,clearMemory:()=>{},accountEnds:[],preserveSession:keepDraft?[JOIN_DRAFT]:[]};
    const full=()=>createTeardown({...common,preserveLocal:[TEARDOWN_KEYS.keepOnly]})(reason);
    const run=async()=>{
      if(GLOBAL_REASONS.has(reason)||candidate?.role&&candidate.role!=='participant')return full();
      const inventory=await inspectPhoneInventory({...options,assertKnownStorageKeys,knownDatabases:TEARDOWN_KEYS.knownDatabases,detailed:true});
      if(inventory.status==='unavailable')return {complete:false};
      if(inventory.status==='invalid')return full();
      let owners;
      try{owners=participantRoomInventory(options.localStorage,now());}catch{return full();}

      if(!owners.rooms.size)return full();
      const target=candidate?.sessionId;
      const erase=!navigation&&(!!candidate?.participantId||provenInvalid)&&owners.rooms.has(target)&&candidate?.credential?.token===owners.rooms.get(target).credential.token;
      const keep=[...owners.keys,...[...owners.expired.values()].map(owner=>owner.key)]; // Removal waits for validated owner rows and the actual transaction commit.
      let invalidRows=false;
      const teardown=createTeardown({...common,roomCleanup:{keys:keep,keepCurrent:(key,value)=>validScopedParticipantKey(key,value,now()),cleanup:async()=>{
        let store;
        try {
          store=await openStore(options);
          const valid=await store.readAll(rows=>{owners=participantRoomInventory(options.localStorage,now());return validateRoomRows(rows,owners,now());});
          if(!valid){invalidRows=true;return false;}
          for(const [roomId,expired] of owners.expired) {
            await store.update(roomId,expiredRoomUpdate(options.localStorage,roomId,expired,now));
          }
          if(erase)await store.update(target, rows => {
            // Do not remove a newly replaced same-room capability or another server-confirmed owner.
            const scope=participantRoomInventory(options.localStorage,now()).rooms.get(target);
            if(!scope||scope.credential.token!==candidate.credential.token)return {rows,result:null};
            const current=options.localStorage.getItem(scope.key);
            if(current!==JSON.stringify(scope.credential))return {rows,result:null};
            return {rows:rows.filter(row=>candidate?.participantId && row.participantId!==candidate.participantId),result:null,afterCommit:()=>{if(options.localStorage.getItem(scope.key)===JSON.stringify(scope.credential))options.localStorage.removeItem(scope.key);}};
          });
          const legacy=owners.rooms.get(selected?.sessionId);
          if(navigation&&selected&&legacy?.key===credentialKey('participant')) {
            await storageBarrier(options).run(()=>{
              const old=options.localStorage.getItem(legacy.key),key=credentialKey('participant',selected.sessionId);
              if(old!==JSON.stringify(legacy.credential))throw new Error('ownership_changed');
              const current=options.localStorage.getItem(key);
              if(current&&current!==old)throw new Error('ownership_changed');
              options.localStorage.setItem(key,old);options.localStorage.removeItem(legacy.key);
            });
          }
          return true;
        } catch(error){if(error?.code==='invalid_storage_inventory')invalidRows=true;throw error;} finally {await store?.close();}
      }}});
      const result=await teardown(reason);
      return invalidRows?full():result;
    };
    return run().then(result=>({complete:memoryComplete&&result.complete})).catch(()=>({complete:false}));
  };
}
