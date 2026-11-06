// One terminal boundary: common cleanup clears memory synchronously and storage
// completes before any public status. Navigation suppresses a late render.
export function createPhoneTerminal({cleanup,show,active}) {
 let flight=null;
 return reason=>{
  if(flight)return flight;
  const cleanupReason=reason==='removed'?'token_loss':reason;
  let result;
  try{result=cleanup(cleanupReason);}catch{result=Promise.reject();}
  flight=Promise.resolve(result).catch(()=>({complete:false})).then(result=>{
   const complete=result?.complete===true;if(!complete)flight=null;
   if(active())show(reason,complete);
  });
  return flight;
 };
}
