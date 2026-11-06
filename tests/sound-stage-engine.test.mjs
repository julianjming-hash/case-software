// Card 69 source/recording regressions. Full room-timer engine tests follow direction selection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = new URL('../prototypes/sound-stage/', import.meta.url);
const sources = JSON.parse(await readFile(new URL('sources/manifest.json', root), 'utf8'));
const tracks = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));

test('Card69 original source recordings match their pinned hashes and permitted licence', async () => {
  for (const sample of sources.samples) {
    assert.equal(sample.license, 'CC0-1.0');
    assert.match(sample.revision, /^[a-f0-9]{40}$/);
    assert.equal(createHash('sha256').update(await readFile(new URL(`sources/${sample.file}`, root))).digest('hex'), sample.sha256, sample.file);
  }
});

test('Card69 Swagbass root notes follow authoritative SFZ pitch_keycenter rather than filename octaves', async () => {
  const sfz = await readFile(new URL('sources/bass-keycenters.txt', root), 'utf8');
  assert.equal(createHash('sha256').update(sfz).digest('hex'), sources.pitchMappingEvidence.sha256);
  const centers = new Map();
  for (const group of sfz.split('<group>').slice(1)) {
    const note = Number(group.match(/pitch_keycenter=(\d+)/)?.[1]);
    for (const [, path] of group.matchAll(/sample=([^\r\n]+)/g)) centers.set(path.replaceAll('\\', '/'), note);
  }
  const bass = sources.samples.filter(sample => sample.kind === 'bass');
  assert.equal(bass.length, 10);
  for (const sample of bass) assert.equal(sample.note, centers.get(sample.originalPath), sample.file);
  assert.equal(centers.get('notes/a1_p_rr1.wav'), 21, 'A0 = 27.5 Hz in this source library');
});

test('Card69 final audition recordings match their measured hashes and consistent loudness', async () => {
  assert.equal(tracks.tracks.length, 8);
  for (const track of tracks.tracks) {
    const bytes = await readFile(new URL(track.file, root));
    assert.equal(bytes.length, track.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), track.sha256, track.id);
    assert(Math.abs(track.integratedLufs + 23) <= .25, track.id);
    assert(track.truePeakDbtp <= -1.9, track.id);
  }
});

// Developed engine: these tests use fake audio nodes and never fetch an asset.
const { createRoomSound, energyCurve, sectionMix, shuffledTracks, envelopeValue } = await import('../prototypes/sound-stage/engine.mjs');
function harness({leadInS=0,boosts=false}={}) {
  const nodes=[];
  const param=()=>({value:1,events:[],cancelScheduledValues(t){this.events.push(['cancel',t]);},setValueAtTime(v,t){this.value=v;this.events.push(['set',v,t]);},linearRampToValueAtTime(v,t){this.value=v;this.events.push(['ramp',v,t]);},setTargetAtTime(v,t,c){this.value=v;this.events.push(['target',v,t,c]);}});
  const context={currentTime:0,createGain(){const node={gain:param(),connect(){},disconnect(){}};nodes.push(node);return node;},createBufferSource(){const node={buffer:null,loop:false,playbackRate:param(),detune:{value:0,events:[]},connect(target){this.destination=target;},disconnect(){},start(at=0,offset=0){this.at=at;this.offset=offset;this.started=true;},stop(at=0){this.stoppedAt=at;this.stopped=true;}};nodes.push(node);return node;}};
  const tracks=['a','b','c','d'].map(id=>({id,kind:'decision',bpm:120,meter:4,loopS:16,assets:Object.fromEntries(['low','mid','peak','zero'].map(part=>[part,{id:`${id}:${part}`,sha256:`${id}:${part}`,file:`assets/${id}-${part}.mp3`,loopS:part==='zero'?null:16,leadInS:part==='zero'?leadInS:0}]))}));
  if(boosts)for(const track of tracks){track.boosts=[1.25,1.5].map((drive,i)=>{const speed=i?1.12:1.06,id=track.id+'-boost-'+Math.round(drive*100);return {...track,id,drive,bpm:track.bpm*speed,loopS:track.loopS/speed,assets:Object.fromEntries(Object.entries(track.assets).map(([part,a])=>[part,part==='zero'?a:{...a,id:id+':'+part,sha256:id+':'+part,loopS:track.loopS/speed}]))};});}
  tracks.push({id:'arrival',kind:'lobby',bpm:90,meter:4,loopS:16,assets:{low:{id:'arrival:low',sha256:'arrival:low',file:'assets/arrival.mp3',loopS:16}}});
  const loads=[];const destination=Object.freeze({connect(){}});
  const sound=createRoomSound({context,destination,assets:{tracks},seed:1,load:async(asset,{signal})=>{loads.push(asset.id);if(signal.aborted)throw Error('aborted');return {id:asset.id,duration:asset.loopS||(asset.leadInS||0)+4};}});
  return {sound,context,nodes,loads,zero:()=>nodes.filter(n=>n.buffer?.id.endsWith(':zero')),activeZero:()=>nodes.filter(n=>n.buffer?.id.endsWith(':zero')&&n.started&&!n.stopped)};
}

test('Card69 automatic energy uses the last 40 percent, capped at 90 seconds, and remains bounded',()=>{
  assert.equal(energyCurve(60,100),.15);assert.equal(energyCurve(20,100),.575);assert.equal(energyCurve(0,100),1);
  assert.equal(energyCurve(90,600),.15);assert.equal(energyCurve(45,600),.575);
  assert.equal(energyCurve(null,60),.15);assert.equal(energyCurve(5,10),.15);
  assert.equal(energyCurve(2,10),.575);assert.equal(energyCurve(-10,100),1);
  assert.equal(energyCurve(20,100,{energy:.8}),.8);
});
test('Card69 full-mix section blends sum to one and have hand-computed midpoint gains',()=>{
  assert.deepEqual(sectionMix(0),[1,0,0]);assert.deepEqual(sectionMix(.25),[.5,.5,0]);
  assert.deepEqual(sectionMix(.5),[0,1,0]);assert.deepEqual(sectionMix(.75),[0,.5,.5]);assert.deepEqual(sectionMix(1),[0,0,1]);
});
test('Card69 shuffle agrees across displays and never repeats until the four-track library has played',()=>{
  const ids=['a','b','c','d'];const order=shuffledTracks(1,ids,40);
  assert.deepEqual(order.slice(0,4),['c','b','d','a']); // xorshift draws 270369, 67634689, 2647435461.
  assert.deepEqual(order,shuffledTracks(1,ids,40));assert.notDeepEqual(order,shuffledTracks(2,ids,40));
  for(let i=0;i<40;i+=4)assert.equal(new Set(order.slice(i,i+4)).size,4);
  for(let i=1;i<order.length;i++)assert.notEqual(order[i],order[i-1]);
});
test('Card69 early lock cancels the scheduled zero; undo resumes the saved remaining timer',async()=>{
  const h=harness();h.sound.setTimer({remainingS:20,totalS:20,paused:false,nowMs:0});await h.sound.setScene({kind:'decision',decisionId:'first',decisionIndex:0});
  assert.equal(h.activeZero().length,1);h.context.currentTime=8;h.sound.lock();assert.equal(h.activeZero().length,0);
  h.context.currentTime=50;await h.sound.unlock();assert.equal(h.sound.clock().toZeroS,12);assert.equal(h.activeZero().length,1);assert.equal(h.activeZero()[0].at,62);
});
test('Card69 adding 30 seconds replaces the old zero schedule without restarting the loop clock',async()=>{
  const h=harness();h.sound.setTimer({remainingS:20,totalS:20,paused:false,nowMs:0});await h.sound.setScene({kind:'decision',decisionId:'first',decisionIndex:0});
  h.context.currentTime=5;const clock=h.sound.clock();h.sound.setTimer({remainingS:45,totalS:50,paused:false,nowMs:5000});
  assert.equal(h.sound.clock().beatPhase,clock.beatPhase);assert.equal(h.sound.clock().toZeroS,45);
  assert.equal(h.activeZero().length,1);assert.equal(h.activeZero()[0].at,50);
});
test('Card69 reload after zero resumes a calm open window without replaying the finish',async()=>{
  const h=harness();h.sound.setTimer({endsAtMs:5000,nowMs:10000,totalS:60,paused:false});await h.sound.setScene({kind:'decision',decisionId:'first',decisionIndex:0});
  assert.equal(h.zero().length,0);assert.equal(h.sound.clock().section,'after-zero');assert.equal(h.sound.clock().toZeroS,0);
});
test('Card69 timer pause cancels zero; resume schedules it once from the remaining time',async()=>{
  const h=harness();h.sound.setTimer({remainingS:20,totalS:20,paused:false,nowMs:0});await h.sound.setScene({kind:'decision',decisionId:'first',decisionIndex:0});
  h.sound.setTimer({remainingS:12,totalS:20,paused:true,nowMs:0});assert.equal(h.activeZero().length,0);h.context.currentTime=80;
  assert.equal(h.sound.clock().toZeroS,12);h.sound.setTimer({remainingS:12,totalS:20,paused:false,nowMs:80000});assert.equal(h.activeZero()[0].at,92);
});
test('Card69 repeated public views do not refetch buffers or restart current sources',async()=>{
  const h=harness();const scene={kind:'decision',decisionId:'first',decisionIndex:0};await h.sound.setScene(scene);const count=h.nodes.filter(n=>n.started).length;
  await h.sound.setScene(scene);assert.equal(h.nodes.filter(n=>n.started).length,count);assert.equal(h.loads.length,4);
});
test('Card69 music remains lazy until a scene starts and closes without closing the caller audio context',async()=>{
  const h=harness();assert.deepEqual(h.loads,[]);await h.sound.setScene({kind:'lobby'});assert.deepEqual(h.loads,['arrival:low']);
  h.sound.close();assert(h.nodes.filter(n=>n.started).every(n=>n.stopped));assert.throws(()=>h.sound.setTimer(null),/closed/);
});

test('Card69 a locked scene retains the playable decision and stable shuffle position for undo',async()=>{
  const h=harness();h.sound.setTimer({remainingS:20,totalS:20,paused:false,nowMs:0});await h.sound.setScene({kind:'decision',decisionId:'first',decisionIndex:2});
  const id=h.sound.clock().trackId;await h.sound.setScene({kind:'locked'});await h.sound.unlock();assert.equal(h.sound.clock().trackId,id);assert.equal(h.sound.clock().section,'settle');assert.equal(h.activeZero().length,1);
});
test('Card69 Stop also cancels a zero sound that has already begun',async()=>{
  const h=harness();await h.sound.setScene({kind:'decision',decisionId:'first',decisionIndex:0});h.sound.control({drop:true});assert.equal(h.activeZero().length,1);h.context.currentTime=.2;h.sound.stop();assert.equal(h.activeZero().length,0);
});
test('Card69 next-track selection can be restored from an explicit public draw index',async()=>{
  const a=harness(),b=harness();await a.sound.setScene({kind:'decision',decisionId:'first',decisionIndex:0});await a.sound.control({next:true});
  const drawIndex=a.sound.clock().drawIndex;assert.equal(drawIndex,1);await b.sound.setScene({kind:'decision',decisionId:'first',decisionIndex:0,drawIndex});assert.equal(a.sound.clock().pendingTrackId,b.sound.clock().trackId);a.context.currentTime=3;assert.equal(a.sound.clock().trackId,b.sound.clock().trackId);
});
test('Card69 automatic time-up relaxes over two bars and manual Drop preserves the current groove',async()=>{
  const h=harness();h.sound.setTimer({remainingS:20,totalS:20,paused:false,nowMs:0});await h.sound.setScene({kind:'decision',decisionId:'first',decisionIndex:0});
  h.context.currentTime=21;assert(h.sound.clock().energy>.2&&h.sound.clock().energy<1);h.context.currentTime=25;assert(h.sound.clock().energy<.2);
  h.sound.setTimer(null);h.sound.control({energy:1,drop:true});assert(h.sound.clock().energy>.9);assert.equal(h.sound.clock().section,'after-drop');h.context.currentTime=30;assert(h.sound.clock().energy<.2);
});

test('Card69 polling the clock while locked cannot consume the future finish before undo',async()=>{
  const h=harness();h.sound.setTimer({remainingS:20,totalS:20,paused:false,nowMs:0});await h.sound.setScene({kind:'decision',decisionId:'first',decisionIndex:0});
  h.context.currentTime=8;h.sound.lock();h.context.currentTime=50;assert.equal(h.sound.clock().section,'locked');await h.sound.unlock();assert.equal(h.activeZero()[0].at,62);
});
test('Card69 queued Next changes do not leave any source active after an intervening lock',async()=>{
  const h=harness();await h.sound.setScene({kind:'decision',decisionId:'first',decisionIndex:0});h.context.currentTime=1;await h.sound.control({next:true});h.context.currentTime=1.2;await h.sound.control({next:true});
  const queued=h.nodes.filter(n=>n.started&&n.loop&&!n.stopped);assert.equal(queued.length,3);assert(queued.every(n=>n.at===2.02));
  h.context.currentTime=1.4;h.sound.lock();assert(h.nodes.filter(n=>n.started).every(n=>n.stopped&&n.stoppedAt<1.45));
});
test('Card69 controls deliberately set before first scene are retained, with Cut applied before source start',async()=>{
  const h=harness();h.sound.control({cut:true,energy:1,hold:true});await h.sound.setScene({kind:'decision',decisionId:'first',decisionIndex:0});
  assert.equal(h.sound.clock().controls.cut,true);assert.equal(h.sound.clock().controls.hold,true);assert.equal(h.sound.clock().energy,1);
  assert(h.nodes[0].gain.events.some(e=>e[0]==='ramp'&&e[1]===0&&e[2]<.02));
});
test('Card69 Next starts on the current bar boundary and exposes the audible and queued track separately',async()=>{
  const h=harness();await h.sound.setScene({kind:'decision',decisionId:'first',decisionIndex:0});const before=h.sound.clock().trackId;
  h.context.currentTime=.4;await h.sound.control({next:true});assert.equal(h.sound.clock().trackId,before);assert(h.sound.clock().pendingTrackId);
  const newSources=h.nodes.filter(n=>n.started&&n.loop&&!n.stopped);assert(newSources.every(n=>n.at===2.02));h.context.currentTime=2.1;assert.notEqual(h.sound.clock().trackId,before);assert.equal(h.sound.clock().pendingTrackId,null);
});

test('Card69 two late displays recover the same musical phase from a public transport epoch',async()=>{
  const a=harness(),b=harness();a.context.currentTime=10;
  a.sound.setTimer({endsAtMs:60000,nowMs:10000,totalS:60,paused:false});
  await a.sound.setScene({kind:'decision',decisionId:'first',decisionIndex:0,trackId:'b',effectiveAtMs:12000,nowMs:10000});
  a.context.currentTime=17.02;
  b.sound.setTimer({endsAtMs:60000,nowMs:17000,totalS:60,paused:false});
  await b.sound.setScene({kind:'decision',decisionId:'first',decisionIndex:0,trackId:'b',effectiveAtMs:12000,nowMs:17000});b.context.currentTime=.02;
  assert.equal(a.sound.clock().transportStartedAtMs,12000);assert.equal(a.sound.clock().bar,3);assert.equal(a.sound.clock().beat,3);assert.equal(a.sound.clock().bar,b.sound.clock().bar);assert.equal(a.sound.clock().beat,b.sound.clock().beat);assert(Math.abs(a.sound.clock().beatPhase-b.sound.clock().beatPhase)<1e-8);
});

test('Card69 gain-envelope holds use scheduled values rather than AudioParam intrinsic defaults',()=>{
 const points=[{time:0,value:0,type:'set'},{time:2,value:1,type:'ramp'},{time:3,value:1,type:'set'},{time:4,value:0,type:'ramp'}];
 assert.equal(envelopeValue(points,.5),.25);assert.equal(envelopeValue(points,2.5),1);assert.equal(envelopeValue(points,3.5),.5);
});


test('Card69 continuous crescendo resolves at the public deadline without restarting its groove',async()=>{
 const h=harness({leadInS:4});h.sound.setTimer({remainingS:20,totalS:20,paused:false,nowMs:0});await h.sound.setScene({kind:'decision',decisionId:'cadence',decisionIndex:0});
 const voice=h.activeZero()[0];assert.equal(voice.at,20);assert.equal(voice.offset,4.15);h.context.currentTime=17;assert.equal(h.sound.clock().section,'crescendo');
});
test('Card69 joining inside the crescendo retains the groove and schedules the tonic at zero',async()=>{
 const h=harness({leadInS:4});h.sound.setTimer({remainingS:2,totalS:20,paused:false,nowMs:18000});await h.sound.setScene({kind:'decision',decisionId:'cadence',decisionIndex:0});
 const voice=h.activeZero()[0];assert.equal(voice.at,2);assert.equal(voice.offset,4.15);
});
test('Card69 adding time during the crescendo cancels its old phrase and schedules the new ending',async()=>{
 const h=harness({leadInS:4});h.sound.setTimer({remainingS:20,totalS:20,paused:false,nowMs:0});await h.sound.setScene({kind:'decision',decisionId:'cadence',decisionIndex:0});const first=h.activeZero()[0];
 h.context.currentTime=17;h.sound.setTimer({remainingS:33,totalS:50,paused:false,nowMs:17000});assert(first.stopped);assert.equal(h.activeZero().length,1);assert.equal(h.activeZero()[0].at,50);
});
test('Card69 pausing or locking inside the crescendo cancels its time-up resolution',async()=>{
 for(const action of ['pause','lock']){const h=harness({leadInS:4});h.sound.setTimer({remainingS:20,totalS:20,paused:false,nowMs:0});await h.sound.setScene({kind:'decision',decisionId:'cadence',decisionIndex:0});h.context.currentTime=17;
 if(action==='pause')h.sound.setTimer({remainingS:3,totalS:20,paused:true,nowMs:17000});else h.sound.lock();assert.equal(h.activeZero().length,0);}
});
test('Card69 manual Drop plays the resolution directly without replaying its crescendo lead-in',async()=>{
 const h=harness({leadInS:4});await h.sound.setScene({kind:'decision',decisionId:'cadence',decisionIndex:0});h.sound.control({drop:true});assert.equal(h.activeZero()[0].offset,4.15);assert.equal(h.activeZero()[0].at,.06);
});

test('Card69 early lock and pause immediately before zero stop the composed phrase before its tonic',async()=>{
 for(const action of ['lock','pause']){const h=harness({leadInS:4});h.sound.setTimer({remainingS:20,totalS:20,paused:false,nowMs:0});await h.sound.setScene({kind:'decision',decisionId:'cadence',decisionIndex:0});const voice=h.activeZero()[0];h.context.currentTime=19.99;
 if(action==='pause')h.sound.setTimer({remainingS:.01,totalS:20,paused:true,nowMs:19990});else h.sound.lock();assert(voice.stoppedAt<=20,action+' must not cross into the tonic');assert(voice.stoppedAt>=19.99);}
});

test('Card69 Night Platform retains its bass and groove through the final crescendo bar',async()=>{
 const {renderComposition}=await import('../scripts/sound/compose-library.mjs');const library=JSON.parse(await readFile(new URL('assets/library.json',root),'utf8'));const track={...library.tracks.find(t=>t.id==='night-platform-developed'),bars:2};const {wav}=renderComposition(track,{cadence:true});
 const barS=240/track.bpm,energy=(start,end)=>{let low=0,sum=0,count=0;const alpha=1-Math.exp(-2*Math.PI*180/44100);for(let i=0;i<Math.round(end*44100);i++){const mono=(wav.readInt16LE(44+i*4)+wav.readInt16LE(46+i*4))/65536;low+=alpha*(mono-low);if(i>=Math.round(start*44100)){sum+=low*low;count++;}}return sum/count;};
 assert(energy(barS+.15,barS+1.4)>=energy(.15,1.4)*.36,'Final-bar low-band RMS must retain at least 60 percent of the groove, not inherit the old break');
});

test('Card69 replacing queued Next near a bar boundary keeps the audible loop until its replacement starts',async()=>{
 const h=harness({leadInS:4});h.sound.setTimer({remainingS:60,totalS:60,paused:false,nowMs:0});await h.sound.setScene({kind:'decision',decisionId:'cadence',decisionIndex:0});const first=h.nodes.filter(n=>n.started&&n.loop);
 h.context.currentTime=1;await h.sound.control({next:true});h.context.currentTime=1.97;await h.sound.control({next:true});const next=h.nodes.filter(n=>n.started&&n.loop&&!n.stopped);
 assert.equal(next[0].at,4);assert(first.every(n=>n.stoppedAt>=4),'Audible loop must bridge a moved pending transition without a gap');h.context.currentTime=2.5;assert.equal(h.sound.clock().trackId,'c');
});

test('Card69 final ten seconds retain the running groove without a pre-zero source restart',async()=>{
 const h=harness({leadInS:4});h.sound.setTimer({remainingS:60,totalS:60,paused:false,nowMs:0});await h.sound.setScene({kind:'decision',decisionId:'continuous',decisionIndex:0});const loops=h.nodes.filter(n=>n.started&&n.loop);h.context.currentTime=43.37;const before=h.sound.clock();h.sound.setTimer({remainingS:10,totalS:60,paused:false,nowMs:43370});
 assert.equal(h.sound.clock().beatPhase,before.beatPhase);assert.deepEqual(h.nodes.filter(n=>n.started&&n.loop),loops);const finish=h.activeZero()[0];assert.equal(finish.at,53.37);assert.equal(finish.offset,4.15,'Skip the percussive attack and never restart a second groove before zero');
});

test('Card69 intensity scales the automatic ramp without restarting loops or muting the calm bed',async()=>{
 const h=harness();h.sound.setTimer({remainingS:10,totalS:60,paused:false,nowMs:0});await h.sound.setScene({kind:'decision',decisionId:'scale',decisionIndex:0});const loops=h.nodes.filter(n=>n.started&&n.loop);
 for(const [intensity,expected]of [[0,.15],[.5,.3541666666666667],[1,.6458333333333334]]){h.sound.control({intensity});assert(Math.abs(h.sound.clock().energy-expected)<1e-12);assert.deepEqual(h.nodes.filter(n=>n.started&&n.loop),loops);assert.equal(h.sound.clock().controls.intensity,intensity);const low=h.nodes.find(n=>n.buffer?.id.endsWith(':low'));const atRamp=.15+(.6518541666666667-.15)*Math.max(0,intensity-.15)/.85;assert(Math.abs(scheduledValue(low.destination.gain,.17)-Math.max(0,1-2*atRamp))<1e-10);}
 assert.throws(()=>h.sound.control({intensity:2}),/Intensity/);
});
function scheduledValue(param,at){let points=[];for(const e of param.events){if(e[0]==='cancel')points=points.filter(p=>p.time<e[1]);else if(e[0]==='set'||e[0]==='ramp')points.push({time:e[2],value:e[1],type:e[0]});}points.sort((a,b)=>a.time-b.time);return envelopeValue(points,at);}
test('Card69 post-zero release remains fluid through duck and intensity changes',async()=>{
 const h=harness();h.sound.setTimer({remainingS:20,totalS:20,paused:false,nowMs:0});await h.sound.setScene({kind:'decision',decisionId:'release',decisionIndex:0});h.context.currentTime=21;
 assert.equal(h.sound.clock().energy,.84375);h.sound.control({duck:true});assert.equal(h.sound.clock().energy,.84375);const low=h.nodes.find(n=>n.buffer?.id.endsWith(':low'));assert(Math.abs(scheduledValue(low.destination.gain,22))<1e-12);h.sound.control({intensity:.5});assert(Math.abs(scheduledValue(low.destination.gain,22)-.5)<1e-12);assert(Math.abs(h.sound.clock().energy-.421875)<1e-12);h.context.currentTime=24;assert.equal(h.sound.clock().energy,0);assert(h.nodes.filter(n=>n.started&&n.loop).every(n=>!n.stopped));
});
test('Card69 live intensity also scales the already scheduled gentle resolution without restarting it',async()=>{
 const h=harness({leadInS:4});h.sound.setTimer({remainingS:20,totalS:20,paused:false,nowMs:0});await h.sound.setScene({kind:'decision',decisionId:'cue-level',decisionIndex:0});const cue=h.activeZero()[0];h.context.currentTime=5;h.sound.control({intensity:0});assert.equal(h.activeZero()[0],cue);assert(cue.destination.gain.events.some(e=>e[0]==='ramp'&&e[1]===.55&&e[2]===20.04));h.sound.control({intensity:1});assert(cue.destination.gain.events.some(e=>e[0]==='ramp'&&e[1]===.65&&e[2]===20.04));
});
test('Card69 shared chord hits preserve their kept pitch pan and velocity across intensity sections',async()=>{
 const {renderComposition}=await import('../scripts/sound/compose-library.mjs');const library=JSON.parse(await readFile(new URL('assets/library.json',root),'utf8'));
 for(const id of ['atlas-current','side-street-developed']){
  const scores=[0,.55,1].map(energy=>{const events=[];renderComposition({...library.tracks.find(t=>t.id===id),energy,bars:2},{loop:true,onEvent:e=>events.push(e)});return events;});
  for(const event of scores[0].filter(e=>e.kind==='chord'))for(const score of scores.slice(1))assert(score.some(e=>JSON.stringify(e)===JSON.stringify(event)),id+' shared event changed');
  if(id==='atlas-current')assert.deepEqual(scores[0].find(e=>e.bar===0&&e.beat===3),{kind:'chord',bar:0,beat:3,note:66,pan:-.23,velocity:1});
  else assert(Math.abs(scores[0].find(e=>e.bar===0&&e.beat===1.5).velocity-.82)<1e-12);
 }
});
test('Card69 added answers share the eighth-note grid and preserve the existing answer identities',async()=>{
 const {renderComposition}=await import('../scripts/sound/compose-library.mjs');const library=JSON.parse(await readFile(new URL('assets/library.json',root),'utf8'));
 for(const id of ['atlas-current','night-platform-developed']){
  const scores=[.55,1].map(energy=>{const events=[];renderComposition({...library.tracks.find(t=>t.id===id),energy,bars:2},{loop:true,onEvent:e=>{if(e.kind==='answer')events.push(e);}});return events;});assert(scores[0].length>0);assert(scores[1].length>scores[0].length);
  for(const e of scores[1])assert(Number.isInteger(e.beat*2),'Answer wandered off the eighth-note grid');for(const e of scores[0])assert(scores[1].some(x=>JSON.stringify(x)===JSON.stringify(e)),'Shared answer changed');
 }
});

test('Card69 forcing time-up early releases the current energy without jumping to peak',async()=>{
 const h=harness();h.sound.setTimer({remainingS:60,totalS:60,paused:false,nowMs:0});await h.sound.setScene({kind:'decision',decisionId:'early-time-up',decisionIndex:0});h.context.currentTime=5;const loops=h.nodes.filter(n=>n.started&&n.loop);assert.equal(h.sound.clock().energy,.15);h.sound.setTimer({remainingS:0,totalS:60,paused:false,nowMs:5000});assert.equal(h.sound.clock().energy,.15);assert.deepEqual(h.nodes.filter(n=>n.started&&n.loop),loops);h.context.currentTime=9;assert.equal(h.sound.clock().energy,0);
});

test('Card69 moving intensity leaves an ongoing master-bus fade schedule untouched',async()=>{
 const h=harness();await h.sound.setScene({kind:'decision',decisionId:'fade-independence',decisionIndex:0});h.context.currentTime=1;h.sound.control({fade:'out'});const before=structuredClone(h.nodes[0].gain.events);h.context.currentTime=1.1;h.sound.control({intensity:.4});assert.deepEqual(h.nodes[0].gain.events,before,'Intensity must not shorten the two-second fade to an80ms cut');
});

test('Card69 150 percent uses faster authored tempo tiers on bar boundaries and peaks at zero',async()=>{
 const h=harness({boosts:true});h.sound.control({intensity:1.5});h.sound.setTimer({remainingS:10,totalS:60,paused:false,nowMs:0});await h.sound.setScene({kind:'decision',decisionId:'boost',decisionIndex:0});assert.equal(h.sound.clock().bpm,127.2);h.context.currentTime=3;h.sound.clock();await new Promise(resolve=>setImmediate(resolve));const queued=h.nodes.filter(n=>n.started&&n.loop&&!n.stopped);assert(queued.every(n=>n.buffer.id.includes('boost-150')));assert.equal(h.sound.clock().pendingBpm,134.4);const at=queued[0].at;assert(Math.abs(queued[0].offset/(240/134.4)-5)<1e-8,'Tempo change must preserve harmonic bar5');h.context.currentTime=at+.01;assert.equal(h.sound.clock().bpm,134.4);h.context.currentTime=9.9;assert(h.sound.clock().energy<1.5);h.context.currentTime=10;assert.equal(h.sound.clock().energy,1.5);assert(h.nodes.filter(n=>n.started).every(n=>n.playbackRate.value===1&&n.playbackRate.events.length===0&&n.detune.value===0),'Tempo must not be made by raising sample playback rate');
});
test('Card69 faster composition retains the rendered fundamental pitch',async()=>{
 const {renderComposition}=await import('../scripts/sound/compose-library.mjs');const frequency=wav=>{const first=Math.round(.08*44100),last=Math.round(.7*44100);let bestLag=0,best=-Infinity;for(let lag=160;lag<=230;lag++){let dot=0,a=0,b=0;for(let i=first;i<last;i++){const x=wav.readInt16LE(44+i*4)/32768,y=wav.readInt16LE(44+(i+lag)*4)/32768;dot+=x*y;a+=x*x;b+=y*y;}const corr=dot/Math.sqrt(a*b);if(corr>best){best=corr;bestLag=lag;}}return 44100/bestLag;};
 for(const [drive,tempoFactor]of [[1,1],[1.25,1.06],[1.5,1.12]]){const {wav}=renderComposition({style:2,voice:'keys',bpm:126*tempoFactor,bars:2,meter:4,drive,tempoFactor},{probe:{note:57,voice:'bass'}});assert.equal(wav.readUInt32LE(24),44100);assert(Math.abs(frequency(wav)-220)<2.2,'Faster tempo shifted an A3 bass note away from220Hz');}
});
test('Card69 new time-up chord starts at zero and uses the selected track own pitched palette',async()=>{
 const library=JSON.parse(await readFile(new URL('assets/library.json',root),'utf8'));for(const track of library.tracks.filter(t=>t.kind==='decision')){assert.equal(track.assets.zero.leadInS,0);assert.equal(track.assets.zero.attackSkipS,0);assert.equal(track.assets.zero.durationS,4);assert(track.assets.zero.integratedLufs>-24);for(const variant of track.boosts||[])assert.equal(variant.assets.zero.sha256,track.assets.zero.sha256,'Same family must share its time-up chord');}
});

test('Card69 increasing tempo cannot make its own stable intensity ramp hunt down a gear',async()=>{
 const h=harness({boosts:true});h.sound.control({intensity:1.5});h.sound.setTimer({remainingS:14.8,totalS:60,paused:false,nowMs:0});await h.sound.setScene({kind:'decision',decisionId:'no-hunting',decisionIndex:0,effectiveAtMs:0,nowMs:0});let previous=120;
 for(const at of [1.92,2.01,3.9,4.1]){h.context.currentTime=at;h.sound.clock();await new Promise(r=>setImmediate(r));const c=h.sound.clock();assert(c.bpm>=previous,'Constant intensity made tempo slow down');if(c.pendingBpm)assert(c.pendingBpm>=c.bpm,'New faster BPM shortened its own forecast and queued a slower gear');previous=c.bpm;}
});
test('Card69 a late boost cannot accelerate after zero or cancel the required time-up chord',async()=>{
 const h=harness({boosts:true});h.sound.setTimer({remainingS:1,totalS:10,paused:false,nowMs:0});await h.sound.setScene({kind:'decision',decisionId:'late-gear',decisionIndex:0,effectiveAtMs:0,nowMs:0});const chord=h.activeZero()[0];h.context.currentTime=.95;h.sound.control({intensity:1.5});await new Promise(r=>setImmediate(r));assert.equal(h.sound.clock().pendingBpm,null);assert.equal(h.activeZero()[0],chord,'Rejected gear change lost the time-up signal');h.context.currentTime=2.01;assert.equal(h.sound.clock().bpm,120);
});
test('Card69 each zero signal is a recognizable melodic resolution on its own theme instrument',async()=>{
 const {renderComposition}=await import('../scripts/sound/compose-library.mjs');const library=JSON.parse(await readFile(new URL('assets/library.json',root),'utf8'));const expected={'atlas-current':[74,71,67],'atlas-crossing':[71,67,64],'side-street-developed':[64,60,57],'night-platform-developed':[72,68,65]};
 for(const track of library.tracks.filter(t=>t.kind==='decision')){const score=[];renderComposition(track,{oneShot:true,onEvent:e=>score.push(e)});const chord=score.filter(e=>e.kind==='resolution');assert.deepEqual(chord.map(e=>e.note),expected[track.id]);assert(chord.every(e=>e.voice===track.voice&&e.time<=.34));assert(!score.some(e=>e.kind==='percussion'),'Zero chord must not add an off-grid drum hit');}
});

test('Card69 an audible tempo change preserves the shared scheduled time-up signal',async()=>{
 const h=harness({boosts:true});h.sound.control({intensity:1.5});h.sound.setTimer({remainingS:10,totalS:60,paused:false,nowMs:0});await h.sound.setScene({kind:'decision',decisionId:'shared-cue',decisionIndex:0});const cue=h.activeZero()[0];h.context.currentTime=3;h.sound.clock();await new Promise(r=>setImmediate(r));assert(!cue.stopped,'Tempo handover retired the shared chord before it could start');assert.equal(h.activeZero()[0],cue);
});

test('Card69 forcing zero cancels a queued tempo acceleration while preserving the actual resolution',async()=>{
 const h=harness({boosts:true});h.sound.setTimer({remainingS:14.8,totalS:60,paused:false,nowMs:0});await h.sound.setScene({kind:'decision',decisionId:'retimed-boost',decisionIndex:0,effectiveAtMs:0,nowMs:0});h.context.currentTime=1.92;h.sound.control({intensity:1.5});await new Promise(r=>setImmediate(r));assert.equal(h.sound.clock().pendingBpm,127.2);h.context.currentTime=1.95;h.sound.setTimer({remainingS:0,totalS:60,paused:false,nowMs:1950});h.sound.control({drop:true});const cue=h.activeZero()[0];await new Promise(r=>setImmediate(r));assert(!cue.stopped,'Restoring the audible tempo truncated the manual zero cue');h.context.currentTime=3;assert.equal(h.sound.clock().bpm,120);assert.equal(h.sound.clock().pendingBpm,null);
});

test('Card69 pausing the timer cancels queued automatic acceleration and keeps the audible tempo',async()=>{
 const h=harness({boosts:true});h.sound.setTimer({remainingS:14.8,totalS:60,paused:false,nowMs:0});await h.sound.setScene({kind:'decision',decisionId:'paused-gear',decisionIndex:0,effectiveAtMs:0,nowMs:0});h.context.currentTime=1.92;h.sound.control({intensity:1.5});await new Promise(r=>setImmediate(r));assert.equal(h.sound.clock().pendingBpm,127.2);h.context.currentTime=1.95;h.sound.setTimer({remainingS:12.85,totalS:60,paused:true,nowMs:1950});await new Promise(r=>setImmediate(r));h.context.currentTime=4;h.sound.clock();await new Promise(r=>setImmediate(r));assert.equal(h.sound.clock().bpm,120);assert.equal(h.sound.clock().pendingBpm,null);
});

test('Card69 authored tempo handovers use matched fades without a mix-amplitude hole',async()=>{
 const h=harness({boosts:true});h.sound.control({intensity:1.5});h.sound.setTimer({remainingS:10,totalS:60,paused:false,nowMs:0});await h.sound.setScene({kind:'decision',decisionId:'matched-fade',decisionIndex:0});h.context.currentTime=3;h.sound.clock();await new Promise(r=>setImmediate(r));const incoming=h.nodes.filter(n=>n.started&&n.loop&&!n.stopped),sampleAt=incoming[0].at+.125;const sum=h.nodes.filter(n=>n.started&&n.loop&&n.at<=sampleAt&&(!n.stopped||n.stoppedAt>sampleAt)).reduce((total,n)=>total+scheduledValue(n.destination.gain,sampleAt),0);assert(Math.abs(sum-1)<1e-10,'Mismatched outgoing/incoming fades created a dip during acceleration');
});
