// Local decode and offline-render measurements. No external asset or backend requests.
import { chromium, firefox, webkit } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const output=process.argv.includes('--output')?process.argv[process.argv.indexOf('--output')+1]:null;
const chromiumPath=process.argv.includes('--chromium')?process.argv[process.argv.indexOf('--chromium')+1]:null;
const reports=[],failures=[];
for(const [name,type]of Object.entries({chromium,firefox,webkit})){
 let browser;
 try{browser=await type.launch({headless:true,...(name==='chromium'&&chromiumPath?{executablePath:chromiumPath}:{})});}
 catch(error){failures.push({engine:name,stage:'launch',error:error.message.split('\n').slice(0,9).join('\n')});console.error(name,'LAUNCH FAILED');continue;}
 try{
  const page=await browser.newPage();page.on('request',r=>assert(r.url().startsWith('http://127.0.0.1:4179/')));await page.goto('http://127.0.0.1:4179/prototypes/sound-stage/');
  const decoded=await page.evaluate(async()=>{
   const library=await fetch('./assets/library.json').then(r=>r.json()),profiles=library.tracks.flatMap(t=>[t,...(t.boosts||[])]),context=new OfflineAudioContext(2,1,44100),results=[];
   const entries=[...new Map(profiles.flatMap(track=>Object.entries(track.assets).map(([part,asset])=>[asset.sha256,{track,part,asset}]))).values()];
   for(const {track,part,asset}of entries){
    const bytes=await fetch(asset.file).then(r=>{if(!r.ok)throw Error('HTTP '+r.status);return r.arrayBuffer();});const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');if(hash!==asset.sha256)throw Error('Asset hash mismatch: '+track.id+':'+part);const buffer=await context.decodeAudioData(bytes);let peak=0,mono=0,stereo=0,jump=0,maxStep=0;
    const l=buffer.getChannelData(0),r=buffer.getChannelData(1);
    for(let i=0;i<l.length;i++){peak=Math.max(peak,Math.abs(l[i]),Math.abs(r[i]));mono+=((l[i]+r[i])/2)**2;stereo+=(l[i]**2+r[i]**2)/2;if(i)maxStep=Math.max(maxStep,Math.abs(l[i]-l[i-1]),Math.abs(r[i]-r[i-1]));}
    jump=Math.max(Math.abs(l[0]-l.at(-1)),Math.abs(r[0]-r.at(-1)));
    results.push({track:track.id,part,sha256:asset.sha256,sampleRate:buffer.sampleRate,channels:buffer.numberOfChannels,decodedFrames:buffer.length,expectedFrames:Math.round(asset.durationS*buffer.sampleRate),samplePeakDbfs:20*Math.log10(peak),monoVsStereoDb:10*Math.log10(mono/stereo),loopBoundaryStep:asset.loopS?jump:null,maxInteriorStep:maxStep});
   }
   return results;
  });
  for(const result of decoded){assert.equal(result.channels,2);assert(Math.abs(result.decodedFrames-result.expectedFrames)<=2,`${name} ${result.track}:${result.part} length`);assert(result.samplePeakDbfs<=-1.9);assert(result.monoVsStereoDb>-.5);if(result.loopBoundaryStep!==null)assert(result.loopBoundaryStep<=Math.max(.03,result.maxInteriorStep),`${name} suspicious loop discontinuity`);}
  reports.push({engine:name,version:await browser.version(),decoded});console.log(name,decoded.length,'exact-length assets decoded, mono/peak/seam bounds passed');
  if(name==='chromium'){
   const offline=await page.evaluate(async()=>{
    const {createRoomSound}=await import('./engine.mjs');const library=await fetch('./assets/library.json').then(r=>r.json());const decoded=new Map(),decoder=new OfflineAudioContext(2,1,44100);const results=[];
    for(const track of library.tracks.flatMap(t=>[t,...(t.boosts||[])]).filter(t=>t.kind==='decision')){
     for(const asset of Object.values(track.assets))decoded.set(asset.sha256,await decoder.decodeAudioData(await fetch(asset.file).then(r=>r.arrayBuffer())));
     for(const totalS of [10,60,600]){
      const context=new OfflineAudioContext(2,(totalS+4)*44100,44100);const sound=createRoomSound({context,destination:context.destination,assets:{tracks:[track]},seed:1,load:async asset=>decoded.get(asset.sha256)});
      sound.control({intensity:track.drive||1});sound.setTimer({remainingS:totalS,totalS,paused:false,nowMs:0});await sound.setScene({kind:'decision',decisionId:'offline-fixture',decisionIndex:0,trackId:track.id});
      const began=performance.now(),buffer=await context.startRendering(),renderMs=performance.now()-began,l=buffer.getChannelData(0),r=buffer.getChannelData(1);
      let peak=0,invalid=0;const segment=(a,b)=>{let sum=0,n=0;for(let i=Math.round(a*44100);i<Math.min(l.length,Math.round(b*44100));i++){sum+=(l[i]**2+r[i]**2)/2;n++;}return 10*Math.log10(sum/n);};
      for(let i=0;i<l.length;i++){peak=Math.max(peak,Math.abs(l[i]),Math.abs(r[i]));if(!Number.isFinite(l[i])||!Number.isFinite(r[i]))invalid++;}
      results.push({track:track.id,totalS,samplePeakDbfs:20*Math.log10(peak),openingRmsDbfs:segment(.3,Math.min(5,totalS*.3)),lastBuildRmsDbfs:segment(Math.max(0,totalS-4),totalS-.1),afterZeroRmsDbfs:segment(totalS+1,totalS+3.5),renderMs,renderWallFraction:renderMs/(totalS*1000),invalidSamples:invalid});sound.close();
     }
    }
    return results;
   });
   for(const run of offline){assert.equal(run.invalidSamples,0);assert(run.samplePeakDbfs<-.5,`${run.track}/${run.totalS}s clipping`);assert(run.renderWallFraction<.5,'Offline render unexpectedly slow');}
   reports.at(-1).offlineWindows=offline;console.log(offline.length,'complete offline windows (10/60/600s) rendered without clipping/invalid samples');
  }
 }finally{await browser.close();}
}
if(output)await writeFile(output,JSON.stringify({checkedAt:new Date().toISOString(),reports,failures,limits:['Playwright browser engines, not physical Safari/iOS/Windows/Edge qualification','Offline render time is a processing-load proxy, not a real-device CPU percentage','Seam bounds and RMS are signal checks, not listening approval']},null,2)+'\n');

if(failures.length){console.error('Codec gate incomplete: browser startup failed; see report.');process.exitCode=1;}
