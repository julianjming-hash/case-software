// Participant bootstrap exposes counts only until storage and same-room authority are confirmed.
import { readParticipantRecovery, recoverJoinCapability } from './phone-recovery.mjs';
import {validateParticipantRecovery} from './storage-policy.mjs';
export function createPhoneBootstrap({code=null,sessionId=null,credential,knownInventory,
  inspectInventory=()=>knownInventory,readRecovery=readParticipantRecovery,preflight=recoverJoinCapability,cleanup,candidateCredentials=null,onCandidate=()=>{}}) {
  let count=0,terminal=null,flight=null,disposed=false,invalid=false,invalidProof=false;
  const gone=()=>({status:'disposed',count:0});
  const unavailable=()=>({status:'storage_unavailable',count:0});
  const release=()=>{credential=null;};
  async function resolveCandidates(candidates) {
    if(!Array.isArray(candidates)||candidates.length>20||new Set(candidates.map(c=>c?.sessionId)).size!==candidates.length||candidates.some(c=>!validateParticipantRecovery({role:'participant',sessionId:c?.sessionId,credential:c,rows:[],knownInventory:true}).preserve))return unavailable();
    if(!candidates.length)return null;
    let expired=false,timer;const until=Date.now()+10_000;
    const done=()=>disposed||expired||Date.now()>=until;
    const probe=(async()=>{
      for(const selected of candidates){
        if(done())return disposed?gone():unavailable();
        credential=selected;onCandidate(selected);
        const checked=await readRecovery({role:'participant',sessionId:selected.sessionId,credential:selected,knownInventory:true});
        if(done())return disposed?gone():unavailable();
        if(!checked.preserve)return unavailable();
        const cleaned=await cleanup('next_load',true);
        if(done())return disposed?gone():unavailable();
        if(!cleaned?.complete)return unavailable();
        const result=await preflight({code,credential:selected,timeoutMs:Math.max(1,until-Date.now())});
        if(done())return disposed?gone():unavailable();
        if(result.status==='unavailable')return {status:'unavailable',count:0};
        if(result.status==='foreign')continue;
        if(result.status==='recovered'&&result.sessionId===selected.sessionId){terminal={status:'ready',count:checked.count,sessionId:selected.sessionId};release();return terminal;}
        const erased=await cleanup('token_loss',false,{provenInvalid:true});
        if(done())return disposed?gone():unavailable();
        if(!erased?.complete)return unavailable();
      }
      credential=null;onCandidate(null);terminal={status:'refused',count:0};return terminal;
    })().catch(()=>unavailable());
    const deadline=new Promise(resolve=>{timer=setTimeout(()=>{expired=true;resolve(unavailable());},10_000);});
    try{return await Promise.race([probe,deadline]);}finally{clearTimeout(timer);}
  }
  async function reject(provenInvalid=invalidProof) {
    if(disposed)return gone();
    invalid=true;invalidProof=provenInvalid;count=0;
    try {
      const cleaned=await cleanup('token_loss',false,{provenInvalid});
      if(disposed)return gone();
      if(!cleaned?.complete)return unavailable();
      terminal={status:'refused',count:0};release();return terminal;
    } catch{return disposed?gone():unavailable();}
  }
  async function start() {
    if(disposed)return gone();
    if(terminal)return terminal;
    if(invalid)return reject();
    const inventory=await inspectInventory();
    if(disposed)return gone();
    if(inventory?.status==='unavailable')return unavailable();
    const known=inventory===true||inventory?.status==='known';
    if(!known||sessionId&&credential&&sessionId!==credential.sessionId)return reject();
    if(code&&!sessionId&&candidateCredentials){
      let candidates;try{candidates=candidateCredentials();}catch{return unavailable();}
      if(!Array.isArray(candidates)||candidates.length>20||new Set(candidates.map(c=>c?.sessionId)).size!==candidates.length||candidates.some(c=>!validateParticipantRecovery({role:'participant',sessionId:c?.sessionId,credential:c,rows:[],knownInventory:true}).preserve))return unavailable();
      if(candidates.length>1)return resolveCandidates(candidates);
      credential=candidates[0]??null;onCandidate(credential);
    }
    // New public join pages still need verified cleanup before activating join sending.
    if(!credential) {
      const cleaned=await cleanup('next_load',false);
      if(disposed)return gone();
      if(!cleaned?.complete)return unavailable();
      terminal={status:'refused',count:0};return terminal;
    }
    {
      const result=await readRecovery({role:'participant',sessionId:credential.sessionId,credential,knownInventory:known});
      if(disposed)return gone();
      if(result.status==='unavailable')return unavailable();
      if(!result.preserve)return reject();
      count=result.count;
    }
    const cleaned=await cleanup('next_load',true);
    if(disposed)return gone();
    if(!cleaned?.complete)return unavailable();
    if(code) {
      const result=await preflight({code,credential});
      if(disposed)return gone();
      if(result.status==='unavailable')return {status:'unavailable',count};
      // A QR for another room does not invalidate the valid room we just checked.
      if(result.status==='foreign'){terminal={status:'refused',count:0};release();return terminal;}
      if(result.status!=='recovered'||result.sessionId!==credential.sessionId)return reject(true);
    }
    terminal={status:'ready',count,sessionId:credential.sessionId};release();return terminal;
  }
  const run=()=>{if(!flight)flight=Promise.resolve().then(start).catch(()=>disposed?gone():unavailable()).finally(()=>{flight=null;});return flight;};
  return {start:run,retry:run,release,dispose(){disposed=true;release();count=0;terminal=null;}};
}
