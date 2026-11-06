// Reference room-sound engine. Only public scene/timer/control data belongs here.
const clamp = n => Math.max(0, Math.min(1, n));
export function energyCurve(remainingS, totalS, controls = {}) {
  if (typeof controls.energy === 'number') return clamp(controls.energy);
  if (remainingS === null || remainingS === undefined) return .15;
  const windowS = Math.min(90, Math.max(0, totalS) * .4);
  if (remainingS <= 0) return 1;
  if (!windowS || remainingS >= windowS) return .15;
  return .15 + .85 * (1 - remainingS / windowS);
}
export function sectionMix(energy) {
  const t = clamp(energy) * 2;
  // These are correlated full mixes at the same musical phase: convex crossfades avoid a +3 dB bump.
  return t <= 1 ? [1 - t, t, 0] : [0, 2 - t, t - 1];
}
export function resolutionEnvelope(intensity=1){const level=.55+.1*Math.min(1.5,Math.max(0,intensity));return [[0,0],[.04,level],[.7,level*.65],[2,0]];}
export function audioProfiles(library){return library.tracks.flatMap(track=>[track,...(track.boosts||[])]);}
export function envelopeValue(points,time){
  let previous={time:0,value:0};
  for(const point of points){
    if(point.time>time){
      if(point.type==='ramp'&&point.time>previous.time)return previous.value+(point.value-previous.value)*(time-previous.time)/(point.time-previous.time);
      return previous.value;
    }
    previous=point;
  }
  return previous.value;
}
function setGain(voice,value,time){
  voice.gain.gain.setValueAtTime(value,time);
  voice.envelope=voice.envelope.filter(p=>p.time!==time);voice.envelope.push({time,value,type:'set'});voice.envelope.sort((a,b)=>a.time-b.time);
}
function rampGain(voice,value,time){
  voice.gain.gain.linearRampToValueAtTime(value,time);
  voice.envelope=voice.envelope.filter(p=>p.time!==time);voice.envelope.push({time,value,type:'ramp'});voice.envelope.sort((a,b)=>a.time-b.time);
}
function holdGain(voice,time){
  const value=envelopeValue(voice.envelope,time);voice.gain.gain.cancelScheduledValues(time);
  voice.envelope=voice.envelope.filter(p=>p.time<time).slice(-96);setGain(voice,value,time);return value;
}
function seedNumber(seed) {
  if (Number.isInteger(seed)) return seed >>> 0 || 1;
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(String(seed))) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  return hash || 1;
}
export function shuffledTracks(seed, ids, count) {
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length) throw TypeError('Unique track ids required');
  if (!Number.isInteger(count) || count < 0 || count > 10000) throw TypeError('Decision count must be 0–10000');
  const result = []; let state = seedNumber(seed);
  const draw = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
  while (result.length < count) {
    const cycle = [...ids];
    for (let i = cycle.length - 1; i > 0; i--) { const j = Math.floor(draw() * (i + 1)); [cycle[i], cycle[j]] = [cycle[j], cycle[i]]; }
    if (ids.length > 1 && cycle[0] === result.at(-1)) cycle.push(cycle.shift());
    result.push(...cycle);
  }
  return result.slice(0, count);
}
export function createRoomSound({ context, destination, assets, seed, load }) {
  if (!context || !destination || !Array.isArray(assets?.tracks) || typeof load !== 'function') throw TypeError('Context, destination, library and lazy loader required');
  const library = assets.tracks, decisions = library.filter(track => track.kind === 'decision');
  if (!decisions.length) throw TypeError('Decision library required');
  const bus = context.createGain(); bus.gain.value=0; bus.connect(destination);
  const busVoice={gain:bus,envelope:[{time:context.currentTime,value:0,type:'set'}]};
  const cache = new Map(), shots = new Set(), sources = new Set(); let clockOffsetMs=0,hasPublicClock=false;
  let closed = false, generation = 0, controller = null, pending = null, requestedKey = null;
  let scene = null, playableScene = null, track = null, voices = [], zero = null, timer = null, origin = context.currentTime, transition = null;
  let locked = false, lockedRemaining = null, zeroHandled = false, manualEnergy = null, holdEnergy = null;
  let tempoTask=null,tempoRetryAt=0,tempoError=null;
  let faded = false, cut = false, duck = false, drawIndex = 0, intensity = 1, releaseAt = null, releaseFrom = null, releaseBase = 1;
  const assertOpen = () => { if (closed) throw Error('Room sound is closed'); };
  const now = () => context.currentTime;
  const remaining = () => !timer ? null : timer.paused ? timer.remainingS : Math.max(0, timer.deadline - now());
  const scaled=value=>Math.min(value,.15)+Math.max(0,value-.15)*Math.max(0,intensity-.15)/.85;
  const unscaled=value=>value<=.15||intensity<=.15?value:.15+(value-.15)*.85/(intensity-.15);
  const sectionWeights=value=>sectionMix(value/(track?.tempoTier===2?1.5:track?.tempoTier===1?1.25:1));
  const releaseSeconds = () => 2*(60/(track?.bpm||120))*(track?.meter||4);
  function releaseEnergy(at,from){const t=clamp((at-(releaseAt??timer?.deadline??at))/releaseSeconds());return from*(1-t*t*(3-2*t));}
  function settle() {
    if (!locked && timer && !timer.paused && now() >= timer.deadline && !zeroHandled) {
      releaseAt=timer.deadline;releaseBase=manualEnergy??holdEnergy??1;releaseFrom=scaled(releaseBase);zeroHandled=true;manualEnergy=null;holdEnergy=null;
    }
  }
  function energy() {
    settle();
    if(manualEnergy!==null)return scaled(manualEnergy);
    if(zeroHandled)return releaseEnergy(now(),releaseFrom??scaled(1));
    return scaled(holdEnergy??energyCurve(remaining(),timer?.totalS||60));
  }
  function cancelZero(force = false) {
    if (zero && (force || (zero.finishAt??zero.at) > now())) {
      const deadline=zero.finishAt??zero.at;
      retire(zero,.015,now(),deadline>now()?deadline:Infinity);
    }
    zero = null;
  }
  function retire(voice,seconds=.04,at=now(),hardStop=Infinity){
    // Cancelled one-shots keep their earliest stop. A still-audible loop may move its queued transition later.
    const retimingLoop=voice.node.loop&&at>now()&&(voice.stopAt??Infinity)>now();
    const stopAt=Math.min(at+seconds+.002,hardStop,retimingLoop?Infinity:voice.stopAt??Infinity);voice.stopAt=stopAt;
    const start=Math.min(at,stopAt),end=Math.max(start,stopAt-.002);
    holdGain(voice,start);rampGain(voice,0,end);
    try{voice.node.stop(stopAt);}catch{}
  }
  function retireAll(seconds, at) { for (const voice of voices) retire(voice, seconds, at); voices = []; }
  function cancelLoad() { generation++; if (controller) controller.abort(); controller = null; pending = null; }
  function level(seconds=.15){holdGain(busVoice,now());rampGain(busVoice,cut||faded||locked?0:duck?.25:1,now()+seconds);}
  function makeVoice(buffer, at, offset, loopS = null) {
    const node = context.createBufferSource(), gain = context.createGain();
    node.buffer = buffer; node.loop = Boolean(loopS); if (loopS) { node.loopStart = 0; node.loopEnd = loopS; }
    gain.gain.value=0; node.connect(gain); gain.connect(bus);
    const voice = { node, gain, at, envelope:[{time:now(),value:0,type:'set'}] };
    setGain(voice,0,now());
    sources.add(voice); if (!loopS) shots.add(voice);
    node.onended = () => { node.disconnect(); gain.disconnect(); shots.delete(voice); sources.delete(voice); };
    node.start(at, offset); return voice;
  }
  async function buffer(asset, signal) {
    if (cache.has(asset.sha256)) return cache.get(asset.sha256);
    const decoded = await load(asset, { signal });
    if (signal.aborted) throw Error('Load cancelled');
    if (cache.size >= 8) cache.delete(cache.keys().next().value);
    cache.set(asset.sha256, decoded); return decoded;
  }
  function finishDuck(at,deadline){const t=at-deadline;if(t<-.12||t>=2)return 1;if(t<0)return .78-.22*t/.12;return t<.7?.78:.78+.22*(t-.7)/1.3;}
  function finishLevel(){return .55+.1*Math.min(intensity,1.5);}
  function automateFinish(voice,deadline){
    const start=Math.max(now(),deadline);holdGain(voice,start);if(start===deadline)setGain(voice,0,start);
    for(const [seconds,value]of resolutionEnvelope(intensity).slice(1)){const at=deadline+seconds;if(at>start)rampGain(voice,value,at);}
  }
  function automate() {
    const start=Math.max(now(),voices[0]?.at||now()),rem=timer&&!timer.paused?Math.max(0,timer.deadline-start):remaining();
    const initial=track?.kind==='decision'?sectionWeights(energy()):[1,0,0];
    const terminal=releaseFrom??scaled(manualEnergy??holdEnergy??1);
    for(const [index,voice]of voices.entries()){
      holdGain(voice,start);const deadlineNow=zeroHandled?releaseAt:timer&&!timer.paused?timer.deadline:null;const mixLevel=deadlineNow===null?1:finishDuck(start,deadlineNow);rampGain(voice,(initial[index]??0)*mixLevel,start+.15);
      if(track?.kind!=='decision'||zeroHandled&&manualEnergy!==null)continue;
      if(timer&&!timer.paused&&rem>0&&!zeroHandled){
        const buildS=Math.min(90,timer.totalS*.4),begin=Math.max(.15,rem-buildS),end=rem,steps=48;
        if(manualEnergy===null&&holdEnergy===null&&end>begin)for(let step=0;step<=steps;step++){
          const ahead=begin+(end-begin)*step/steps;
          rampGain(voice,sectionWeights(scaled(energyCurve(Math.max(0,rem-ahead),timer.totalS)))[index]*finishDuck(start+ahead,timer.deadline),start+ahead);
        }
      }
      // Keep every loop running: crest at zero, then ease its density down over two bars.
      const deadline=zeroHandled?releaseAt:timer&&!timer.paused?timer.deadline:null;
      if(deadline===null)continue;
      if(deadline-.12>start+.15){const before=scaled(manualEnergy??holdEnergy??energyCurve(.12,timer?.totalS||60));rampGain(voice,sectionWeights(before)[index],deadline-.12);}
      const duration=releaseSeconds();
      for(let step=0;step<=32;step++){
        const at=deadline+duration*step/32;if(at<start+.15)continue;
        const t=step/32,value=terminal*(1-t*t*(3-2*t));rampGain(voice,sectionWeights(value)[index]*finishDuck(at,deadline),at);
      }
    }
  }
  function scheduleZero() {
    if(zero?.manual&&zeroHandled&&!locked&&zero.assetSha===track?.assets.zero?.sha256)return;
    if(zero&&timer&&!timer.paused&&!locked&&zero.finishAt===timer.deadline&&zero.assetSha===track?.assets.zero?.sha256)return;
    cancelZero();
    if (!track || !voices.length || track.kind !== 'decision' || locked || !timer || timer.paused || zeroHandled) return;
    const rem = remaining();
    if (rem <= .005) { zeroHandled = true; automate(); return; }
    const finishTrack = transition && timer.deadline < transition.at ? transition.previous : track;
    const decoded = cache.get(finishTrack.assets.zero?.sha256); if (!decoded) return;
    const leadIn=finishTrack.assets.zero.leadInS||0;
    const at=timer.deadline, offset=leadIn+(finishTrack.assets.zero.attackSkipS??.15);
    const voice=makeVoice(decoded,at,offset);
    automateFinish(voice,at);
    zero = Object.assign(voice,{finishAt:timer.deadline,startAt:at,assetSha:finishTrack.assets.zero.sha256});
    if (transition && at < transition.at) retire(voice,.12,transition.at);
  }
  function desiredTempoTier(base){
    if(base?.kind!=='decision'||intensity<=1)return 0;
    const ahead=2*60/base.bpm*(base.meter||4),rem=remaining();
    const forecast=scaled(manualEnergy??holdEnergy??energyCurve(rem===null?null:Math.max(0,rem-(timer?.paused?0:ahead)),timer?.totalS||60));
    return forecast>1.25?2:forecast>1?1:0;
  }
  function tempoProfile(base,view){
    if(base?.kind!=='decision')return base;
    const tier=view.tempoTier??desiredTempoTier(base),profile=tier?(base.boosts||[])[tier-1]:null;
    return {...(profile||base),id:base.id,variantId:profile?.id||base.id,tempoTier:profile?tier:0};
  }
  function syncTempo(force=false){
    if(closed||locked||now()<tempoRetryAt||zeroHandled||!voices.length||track?.kind!=='decision')return;
    if(!force&&(timer?.paused||pending||tempoTask||transition&&now()<transition.at))return;
    const base=library.find(t=>t.id===track.id),tier=desiredTempoTier(base),next=tempoProfile(base,{tempoTier:tier});
    if(next.variantId===(track.variantId||track.id))return;
    tempoTask=setScene({...playableScene,tempoTier:tier,tempoOnly:true,effectiveAtMs:undefined,nowMs:undefined}).then(()=>{tempoError=null;}).catch(error=>{tempoError=error.message;tempoRetryAt=now()+5;}).finally(()=>{tempoTask=null;});
  }
  function selectedTrack(nextScene) {
    if (nextScene.trackId && nextScene.trackId !== 'auto') {
      const found = library.find(item => item.id === nextScene.trackId);
      if (!found || found.kind !== (nextScene.kind === 'closing' ? 'decision' : nextScene.kind)) throw TypeError('Track is unavailable in this scene');
      return tempoProfile(found,nextScene);
    }
    if (['decision', 'closing'].includes(nextScene.kind)) {
      if (!Number.isInteger(nextScene.decisionIndex) || nextScene.decisionIndex < 0 || nextScene.decisionIndex > 9999) throw TypeError('A stable public decisionIndex is required for shuffle');
      const index = nextScene.drawIndex ?? nextScene.decisionIndex;
      if (!Number.isInteger(index) || index < 0 || index > 9999) throw TypeError('Public drawIndex must be 0–9999');
      return tempoProfile(decisions.find(item => item.id === shuffledTracks(seed, decisions.map(t => t.id), index + 1)[index]),nextScene);
    }
    return library.find(item => item.kind === nextScene.kind) || null;
  }
  function playback() {
    if (transition && now()<transition.at) return {track:transition.previous,voices:transition.oldVoices,origin:transition.origin};
    return {track:transition?.nextTrack||track,voices,origin};
  }
  async function setScene(nextScene) {
    assertOpen();
    if (!nextScene || typeof nextScene.kind !== 'string') throw TypeError('Scene kind required');
    if (['locked', 'silent', 'ended', 'reveal', 'reflection'].includes(nextScene.kind)) {
      scene = { ...nextScene }; lock(); if (nextScene.kind === 'ended') cache.clear(); return;
    }
    if(Number.isFinite(nextScene.nowMs)){clockOffsetMs=nextScene.nowMs-now()*1000;hasPublicClock=true;}
    const requestedOrigin=Number.isFinite(nextScene.effectiveAtMs)&&hasPublicClock?(nextScene.effectiveAtMs-clockOffsetMs)/1000:null;
    const nextTrack = selectedTrack(nextScene);
    if (!nextTrack) { stop(); scene = { ...nextScene }; return; }
    const key=`${nextScene.decisionId||nextScene.kind}:${nextTrack.variantId||nextTrack.id}:${nextScene.effectiveAtMs??''}`;
    if(pending&&requestedKey===key)return pending;
    const same = scene?.decisionId === nextScene.decisionId && track?.id === nextTrack.id && (track?.variantId||track?.id)===(nextTrack.variantId||nextTrack.id) && !locked && (requestedOrigin===null||Math.abs(requestedOrigin-origin)<.02);
    if (same && voices.length && !pending) { scene = { ...nextScene }; playableScene={...nextScene}; return; }
    const hadScene=Boolean(playableScene);
    const changedDecision = playableScene?.decisionId !== nextScene.decisionId;
    cancelLoad(); if(!nextScene.tempoOnly)cancelZero();
    scene = { ...nextScene }; playableScene = { ...nextScene }; locked = false; requestedKey=key;
    if(nextTrack.kind==='decision')drawIndex=nextScene.drawIndex??nextScene.decisionIndex;
    if (changedDecision) {tempoRetryAt=0;tempoError=null; zeroHandled = Boolean(timer && remaining() <= 0);if(!zeroHandled){releaseAt=null;releaseFrom=null;} if(hadScene){manualEnergy = null; holdEnergy = null;} }
    const ticket = generation, signal = (controller = new AbortController()).signal;
    const task = (async () => {
      const parts = nextTrack.kind === 'decision' ? ['low', 'mid', 'peak', 'zero'] : ['low'];
      const live=playback(),sameLive=(live.track?.variantId||live.track?.id)===(nextTrack.variantId||nextTrack.id);
      const decoded = await Promise.all(parts.map((part,index)=>sameLive&&index<live.voices.length?live.voices[index].node.buffer:buffer(nextTrack.assets[part], signal)));
      if (ticket !== generation || signal.aborted || closed || nextScene.tempoOnly&&timer&&!timer.paused&&now()>=timer.deadline) return;
      const previous=playback(), oldVoices=previous.voices;
      const quantize=!changedDecision&&oldVoices.length&&previous.track?.kind==='decision'&&nextTrack.kind==='decision'&&(previous.track.id!==nextTrack.id||(previous.track.variantId||previous.track.id)!==(nextTrack.variantId||nextTrack.id));
      let at=now()+.02;
      if(requestedOrigin!==null)at=Math.max(at,requestedOrigin);
      else if(quantize){const barS=60/previous.track.bpm*previous.track.meter;at=previous.origin+Math.ceil((now()+.08-previous.origin)/barS)*barS;}
      if(nextScene.tempoOnly&&timer&&!timer.paused&&at>=timer.deadline)return;
      // Replacing a queued change cancels its not-yet-audible sources, not the audible group.
      if(transition&&now()<transition.at)for(const voice of voices)retire(voice,.005);
      const oldWeights=previous.track?.kind==='decision'?sectionWeights(energy()):[1,0,0];
      for(const [index,voice]of oldVoices.entries()){
        holdGain(voice,now());
        retire(voice,.15,at);
      }
      const tempoChange=oldVoices.length&&previous.track?.id===nextTrack.id&&previous.track.bpm!==nextTrack.bpm;
      const tempoOrigin=tempoChange?at-(at-previous.origin)/(60/previous.track.bpm*previous.track.meter)*(60/nextTrack.bpm*nextTrack.meter):null;
      const sameProfile=oldVoices.length&&previous.track?.id===nextTrack.id&&previous.track.bpm===nextTrack.bpm;
      const nextOrigin=requestedOrigin??(sameProfile?previous.origin:tempoOrigin)??(!oldVoices.length&&timer&&!timer.paused&&remaining()>0 ? timer.deadline-Math.ceil(remaining()/nextTrack.loopS)*nextTrack.loopS : at);
      transition=oldVoices.length?{at,previous:previous.track,nextTrack,oldVoices,origin:previous.origin}:null;
      track=nextTrack;origin=nextOrigin;
      const offset=((at-origin)%nextTrack.loopS+nextTrack.loopS)%nextTrack.loopS;
      for(const shot of shots)if(shot!==zero||zero.assetSha!==nextTrack.assets.zero?.sha256)retire(shot,.12,at);
      voices=decoded.slice(0,nextTrack.kind==='decision'?3:1).map(buffer=>makeVoice(buffer,at,offset,nextTrack.loopS));
      level();automate();scheduleZero();
    })();
    pending=task;
    try{await task;}catch(error){if(!signal.aborted&&ticket===generation)throw error;}
    finally{if(ticket===generation){pending=null;requestedKey=null;}}
  }
  function reconcileQueuedTempo(){
    if(!scene?.tempoOnly||!timer||locked)return;
    const audible=playback(),base=library.find(t=>t.id===track?.id),wanted=desiredTempoTier(base);
    const invalid=transition&&now()<transition.at&&(timer.paused||remaining()===0||transition.at>=timer.deadline||wanted<(track?.tempoTier||0));
    if(invalid){
      for(const voice of voices)retire(voice,.005);
      const restore={...playableScene,trackId:audible.track.id,tempoTier:audible.track.tempoTier||0,tempoOnly:false,effectiveAtMs:hasPublicClock?audible.origin*1000+clockOffsetMs:undefined,nowMs:hasPublicClock?now()*1000+clockOffsetMs:undefined};
      void setScene(restore).catch(error=>{tempoError=error.message;});
    }else if(pending&&(timer.paused||remaining()===0||wanted<(scene.tempoTier||0))){cancelLoad();scene={...scene,tempoTier:audible.track?.tempoTier||0,tempoOnly:false};playableScene={...scene};}
  }
  function setTimer(value) {
    assertOpen();
    if (value === null) { timer = null; zeroHandled = false;releaseAt=null;releaseFrom=null; cancelZero(); automate(); return; }
    if (!Number.isFinite(value.totalS) || value.totalS < 10 || value.totalS > 600) throw TypeError('Timer total must be 10–600 seconds');
    if(Number.isFinite(value.nowMs)){clockOffsetMs=value.nowMs-now()*1000;hasPublicClock=true;}
    const rem = value.endsAtMs !== undefined ? (value.endsAtMs - value.nowMs) / 1000 : value.remainingS;
    if (!Number.isFinite(rem)) throw TypeError('Timer remaining time required');
    const next = { totalS: value.totalS, paused: Boolean(value.paused), remainingS: Math.max(0, rem), deadline: now() + rem };
    if (timer && timer.totalS === next.totalS && timer.paused === next.paused && (next.paused ? timer.remainingS === next.remainingS : Math.abs(timer.deadline - next.deadline) < .02)) return;
    const wasPast = remaining() === 0;
    const priorRaw=manualEnergy??holdEnergy??(timer?energyCurve(remaining(),timer.totalS):1);
    timer = next;
    if (locked) lockedRemaining = next.remainingS;
    if ((wasPast || zeroHandled) && next.remainingS > 0) {zeroHandled=false;releaseAt=null;releaseFrom=null;}
    if(next.remainingS===0){if(!zeroHandled){releaseBase=priorRaw;releaseFrom=scaled(releaseBase);releaseAt=next.deadline;}zeroHandled=true;manualEnergy=null;holdEnergy=null;}
    automate(); scheduleZero();reconcileQueuedTempo();
  }
  function lock() {
    assertOpen(); if (!locked) lockedRemaining = remaining();
    const audible=playback();if(audible.track){track=audible.track;origin=audible.origin;playableScene={...playableScene,trackId:track.id,tempoTier:track.tempoTier||0,tempoOnly:false,effectiveAtMs:hasPublicClock?origin*1000+clockOffsetMs:undefined};}
    locked = true; cancelLoad(); cancelZero(true); for(const voice of sources)retire(voice,.04); voices=[];transition=null; level(.04);
  }
  async function unlock() {
    assertOpen(); if (!locked) return;
    locked = false;
    if (timer && lockedRemaining !== null) timer = { ...timer, remainingS: lockedRemaining, deadline: now() + lockedRemaining };
    const restore = playableScene?{...playableScene,tempoOnly:false}:null;
    if (restore) await setScene(restore);
  }
  function control(command) {
    assertOpen(); settle();const forceTempo=Object.hasOwn(command,'intensity')&&command.intensity!==intensity;
    if(Object.hasOwn(command,'intensity')){if(!Number.isFinite(command.intensity)||command.intensity<0||command.intensity>1.5)throw TypeError('Intensity must be 0–1.5');intensity=command.intensity;if(zeroHandled)releaseFrom=scaled(releaseBase);if(zero)automateFinish(zero,zero.finishAt);}
    if (Object.hasOwn(command, 'energy')) { if (command.energy !== null && (!Number.isFinite(command.energy) || command.energy < 0 || command.energy > 1)) throw TypeError('Energy must be 0–1 or null'); manualEnergy = command.energy; }
    if (Object.hasOwn(command, 'hold')) holdEnergy = command.hold ? (manualEnergy??(zeroHandled?(unscaled(energy())):energyCurve(remaining(),timer?.totalS||60))) : null;
    if (Object.hasOwn(command, 'fade')) faded = command.fade === 'out';
    if (Object.hasOwn(command, 'cut')) cut = Boolean(command.cut);
    if (Object.hasOwn(command, 'duck')) duck = Boolean(command.duck);
    if(['cut','fade','duck'].some(key=>Object.hasOwn(command,key)))level(command.cut ? .005 : command.fade ? 2 : .08); automate();
    syncTempo(forceTempo);
    if (command.next && playableScene) return setScene({ ...playableScene, drawIndex: drawIndex + 1, trackId: 'auto',tempoTier:undefined,tempoOnly:false,effectiveAtMs:undefined,nowMs:undefined });
    if(command.drop&&track?.assets.zero&&!locked){
      const from=energy();cancelZero(true);const at=now()+.06;
      releaseBase=unscaled(from);releaseFrom=from;releaseAt=at;zeroHandled=true;manualEnergy=null;holdEnergy=null;automate();
      const decoded=cache.get(track.assets.zero.sha256);
      if(decoded){const voice=makeVoice(decoded,at,(track.assets.zero.leadInS||0)+(track.assets.zero.attackSkipS??.15));automateFinish(voice,at);zero=Object.assign(voice,{finishAt:at,manual:true,assetSha:track.assets.zero.sha256});}
    }

  }
  function clock() {
    settle();syncTempo();
    const audible = playback().track;
    const audibleOrigin = transition && now() < transition.at ? transition.origin : origin;
    const bpm = audible?.bpm || 120, meter = audible?.meter || 4, beats = Math.max(0, now() - audibleOrigin) * bpm / 60;
    const rem = locked && lockedRemaining !== null ? lockedRemaining : remaining();
    return {tempoError,tempoTier:audible?.tempoTier||0,pendingBpm:transition&&now()<transition.at?track?.bpm:null, controls:{intensity,energy:manualEnergy,hold:holdEnergy!==null,faded,cut,duck},started: playback().voices.length>0 && now()>=(playback().voices[0]?.at||0) && !locked, trackId: audible?.id || null, pendingTrackId: transition && now()<transition.at ? track?.id : null, drawIndex,transportStartedAtMs:hasPublicClock?audibleOrigin*1000+clockOffsetMs:null,selectionStartedAtMs:hasPublicClock?origin*1000+clockOffsetMs:null,bar:Math.floor(beats/meter)%Math.max(1,Math.round((audible?.loopS||16)/(60/bpm*meter)))+1, beat: Math.floor(beats) % meter + 1, beatPhase: beats % 1, bpm,
      section: locked ? 'locked' : track?.kind !== 'decision' ? track?.kind || 'silent' : rem === 0 ? 'after-zero' : zeroHandled ? 'after-drop' : timer&&!timer.paused&&rem!==null&&rem<=(track?.assets.zero?.leadInS||0) ? 'crescendo' : energy() < .35 ? 'settle' : energy() < .8 ? 'build' : 'peak',
      energy: track?.kind==='decision'?energy():.15, toZeroS: rem };
  }
  function stop() { assertOpen(); cancelLoad(); cancelZero(true); for(const voice of sources)retire(voice,.02); voices=[];transition=null; holdGain(busVoice,now());rampGain(busVoice,0,now()+.02); }
  function close() { if (closed) return; stop(); cache.clear(); bus.disconnect(); closed = true; }
  return { setScene, setTimer, lock, unlock, control, clock, stop, close };
}
