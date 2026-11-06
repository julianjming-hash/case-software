// Local Web Audio regression for the owner-reported pre-zero groove restart.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
const output=process.argv.includes('--output')?process.argv[process.argv.indexOf('--output')+1]:null;
const browser=await chromium.launch();
try{
 const page=await browser.newPage();
 page.on('request',r=>assert(r.url().startsWith('http://127.0.0.1:4179/')));
 await page.goto('http://127.0.0.1:4179/prototypes/sound-stage/');
 const results=await page.evaluate(async()=>{
  const {createRoomSound}=await import('./engine.mjs');const library=await fetch('./assets/library.json').then(r=>r.json()),results=[];
  for(const track of library.tracks.filter(t=>t.kind==='decision')){
   const context=new OfflineAudioContext(2,24*44100,44100),starts=[];
   const native=context.createBufferSource.bind(context);
   context.createBufferSource=()=>{const node=native(),start=node.start.bind(node);node.start=(at,offset)=>{starts.push({at,offset,loop:node.loop,node});start(at,offset);};return node;};
   // Correlated constant full mixes make any scheduler-created amplitude dip unambiguous.
   const load=async asset=>{const buffer=context.createBuffer(2,Math.ceil(asset.durationS*44100),44100);for(let c=0;c<2;c++)buffer.getChannelData(c).fill(.1);return buffer;};
   const sound=createRoomSound({context,destination:context.destination,assets:library,seed:1,load});
   sound.setTimer({remainingS:60,totalS:60,paused:false,nowMs:0});await sound.setScene({kind:'decision',decisionId:'stutter-fixture',decisionIndex:0,trackId:track.id});
   const originalLoops=starts.filter(s=>s.loop).map(s=>s.node),pause=context.suspend(5.37),rendered=context.startRendering();await pause;
   const retimedAt=context.currentTime,before=sound.clock(),deadline=retimedAt+10;
   sound.setTimer({remainingS:10,totalS:60,paused:false,nowMs:retimedAt*1000});
   const after=sound.clock(),retained=starts.filter(s=>s.loop).every((s,i)=>s.node===originalLoops[i]);await context.resume();const buffer=await rendered;
   let min=Infinity,max=0;for(const channel of [buffer.getChannelData(0),buffer.getChannelData(1)])for(let i=Math.ceil((retimedAt+.2)*44100);i<Math.floor((deadline-.12)*44100);i++){min=Math.min(min,channel[i]);max=Math.max(max,channel[i]);}
   let releaseMin=Infinity,releaseMax=0;const releaseEnd=deadline+2*60/track.bpm*track.meter+.25;for(const channel of [buffer.getChannelData(0),buffer.getChannelData(1)])for(let i=Math.ceil((deadline-.12)*44100);i<Math.floor(releaseEnd*44100);i++){releaseMin=Math.min(releaseMin,channel[i]);releaseMax=Math.max(releaseMax,channel[i]);}
   const finish=starts.filter(s=>!s.loop).at(-1);
   results.push({track:track.id,retimedAt,deadline,loopVoicesRetained:retained&&originalLoops.length===3,beatPhaseBefore:before.beatPhase,beatPhaseAfter:after.beatPhase,minimumThroughReleaseAmplitude:releaseMin,maximumThroughReleaseAmplitude:releaseMax,expectedMinimumThroughReleaseAmplitude:.078,expectedMaximumThroughReleaseAmplitude:.143,minimumPreZeroAmplitude:min,maximumPreZeroAmplitude:max,expectedAmplitude:.1,finishAt:finish.at,finishOffset:finish.offset,expectedFinishOffset:track.assets.zero.leadInS+(track.assets.zero.attackSkipS??.15)});sound.close();
  }
  return results;
 });
 for(const result of results){
  assert(result.minimumPreZeroAmplitude>=.099,`${result.track}: pre-zero amplitude interruption (${result.minimumPreZeroAmplitude})`);
  assert(result.maximumPreZeroAmplitude<=.101,`${result.track}: correlated mixes gained level`);
  assert(Math.abs(result.minimumThroughReleaseAmplitude-.078)<.001,`${result.track}: after-zero amplitude interruption or unplanned duck (${result.minimumThroughReleaseAmplitude})`);assert(Math.abs(result.maximumThroughReleaseAmplitude-.143)<.001,`${result.track}: resolution gain differs from planned mix (${result.maximumThroughReleaseAmplitude})`);
  assert(result.loopVoicesRetained);assert.equal(result.beatPhaseBefore,result.beatPhaseAfter);
  assert.equal(result.finishAt,result.deadline,`${result.track}: finish restarted before zero`);assert.equal(result.finishOffset,result.expectedFinishOffset);
 }
 if(output)await writeFile(output,JSON.stringify({checkedAt:new Date().toISOString(),browser:await browser.version(),results,limits:['Synthetic constant full mixes isolate scheduler continuity; this is not a musical taste rating','Chromium offline Web Audio, not physical-device evidence']},null,2)+'\n');
 console.log('PASS: all four tracks retain their groove and amplitude through Last 10; gentle release through zero');
}finally{await browser.close();}
