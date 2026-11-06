// User-triggered native frame only. No network, persistence, masking or content filtering.
const stop = stream => { try { for (const track of stream?.getTracks?.() ?? []) { try { track.stop(); } catch {} } } catch {} };
const fault = name => Object.assign(new Error(name), { name });
export async function captureTabFrame({mediaDevices=globalThis.navigator?.mediaDevices,doc=globalThis.document,signal,isCurrent=()=>true,timeoutMs=15000,maxBytes=5_000_000}={}) {
 if(signal?.aborted||!isCurrent())return{state:'cancelled'};
 if(typeof mediaDevices?.getDisplayMedia!=='function')return{state:'unavailable'};
 let stream=null,video=null,canvas=null,timer=null,retired=false,stopped=false;
 const cleanup=()=>{if(!stopped&&stream){stop(stream);stopped=true;}if(video){try{video.pause();}catch{}video.srcObject=null;video.remove?.();}if(canvas){canvas.width=0;canvas.height=0;}};
 let abort;
 try {
  // Invoke before any await: the real caller must retain the click's transient activation.
  const requested=mediaDevices.getDisplayMedia({video:true,audio:false,preferCurrentTab:true});
  const current=()=>!retired&&!signal?.aborted&&isCurrent();
  const work=Promise.resolve(requested).then(async value=>{
   if(!current()){stop(value);throw fault('AbortError');}stream=value;
   if(!stream?.getVideoTracks?.().length)throw fault('NotSupportedError');
   video=doc.createElement('video');video.muted=true;video.playsInline=true;video.srcObject=stream;
   await video.play();if(!current())throw fault('AbortError');
   if(!(video.videoWidth>0&&video.videoHeight>0))throw fault('InvalidStateError');
   if(video.videoWidth>8192||video.videoHeight>8192||video.videoWidth*video.videoHeight>20_000_000)throw fault('LimitError');
   canvas=doc.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;
   const context=canvas.getContext('2d');if(!context)throw fault('NotSupportedError');
   context.drawImage(video,0,0);cleanupStream();
   const encode=type=>new Promise(resolve=>canvas.toBlob(resolve,type,type==='image/jpeg'?0.85:undefined));
   let blob=await encode('image/png');if(blob?.size>maxBytes)blob=await encode('image/jpeg');
   if(!current())throw fault('AbortError');
   if(!blob)throw fault('EncodingError');if(blob.size>maxBytes)throw fault('LimitError');
   return{state:'captured',blob,width:canvas.width,height:canvas.height};
  });
  function cleanupStream(){if(!stopped){stop(stream);stopped=true;}try{video.pause();}catch{}video.srcObject=null;}
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{retired=true;cleanup();reject(fault('TimeoutError'));},timeoutMs);});
  const cancelled=new Promise((_,reject)=>{abort=()=>{retired=true;cleanup();reject(fault('AbortError'));};signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();});
  return await Promise.race([work,deadline,cancelled]);
 } catch(error) {
  return{state:error?.name==='NotAllowedError'||error?.name==='AbortError'?'cancelled':error?.name==='NotSupportedError'?'unavailable':error?.name==='TimeoutError'?'timeout':error?.name==='LimitError'?'too_large':'failed'};
 } finally {retired=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);cleanup();}
}
