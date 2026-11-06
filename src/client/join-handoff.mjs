import { sessionUrl } from '../shared/urls.mjs';

/** Entry documents may hold vendor code. Private play always starts in a fresh strict document. */
export function createJoinDocumentHandoff({cleanup,active,navigate=url=>location.replace(url),origin=location.origin,onUnavailable}) {
 let flight=null;
 const unavailable=()=>{try{Promise.resolve(onUnavailable?.('storage_unavailable')).catch(()=>{});}catch{/* Fixed optional status only. */}};
 return sessionId=>{
  if(flight)return flight;
  flight=(async()=>{
   let result;
   try{result=await cleanup('next_load');}catch{result={complete:false};}
   if(!active())return false;
   if(result?.complete!==true){flight=null;unavailable();return false;}
   try{await navigate(sessionUrl(sessionId,'play',origin));return true;}catch{flight=null;unavailable();return false;}
  })();
  return flight;
 };
}
