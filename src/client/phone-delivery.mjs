// Contain durable-storage failure at the phone renderer's delivery boundary.
// The caller supplies fixed public copy; raw storage errors never leave here.
export async function settlePhoneDelivery({flush,current,failed,settled}) {
 try {await flush();}
 catch {if(current()) failed();}
 finally {if(current()) settled();}
}

// Restore an asynchronous outbox read only while its view is current and no local answer/receipt
// change happened since the read began (`version` advances on every pending/receipt change).
export async function restorePhoneVote({read,current,accepted,version=()=>0,restore}) {
 const began=version();
 const pending=await read();
 if (!current() || version()!==began || !pending || accepted()?.clientEventId === pending.clientEventId) return null;
 restore(pending);
 return pending;
}

// Live phone writes recheck exact captured ownership while the store holds its origin lock.
export function guardPhoneVoteStore(store,fence) {
 const update=store.update.bind(store);
 store.update=(roomId,change)=>update(roomId,rows=>{
  if(!fence?.valid())throw new Error('Vote storage closed');
  return change(rows);
 });
 return store;
}
