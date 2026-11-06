// Development library composition kernel; original recordings remain pinned in sample-bank.mjs.
import { recorded } from './sample-bank.mjs';
const rate=44100,tau=2*Math.PI,hz=n=>440*2**((n-69)/12);
let randomState=69;
function rand(){randomState=(Math.imul(randomState,1664525)+1013904223)>>>0;return randomState/4294967296;}
export function renderComposition(track, { loop = false, oneShot = false, cadence = false, onEvent = null, probe = null } = {}) {
 randomState = 327 + track.style + (track.variation || 0);
 const beat=60/track.bpm, zero=oneShot?0:track.bars*track.meter*beat, duration=zero+(loop?2:4);
 const left=new Float64Array(Math.ceil(duration*rate)), right=new Float64Array(left.length);
 function mix(samples,at,level,pan=0) {
  const start=Math.round(at*rate), l=Math.sqrt((1-pan)/2)*level, r=Math.sqrt((1+pan)/2)*level;
  for(let j=0;j<samples.length && start+j<left.length;j++) if(start+j>=0) {left[start+j]+=samples[j]*l;right[start+j]+=samples[j]*r;}
 }
 function tone(note,seconds,kind,velocity=1) {
  const sampleKind=kind==='nylon'||kind==='muted'?'guitar':kind==='keys'&&track.style===7?'piano':kind==='marimba'?'marimba':kind==='bass'&&[0,1,4,5,7].includes(track.style)?'bass':null;
  if(sampleKind){const sample=recorded(sampleKind,note,seconds,rate);if(sample){
   const amount=1+((track.drive||1)-1)*2;
   for(let i=0;i<sample.length;i++){sample[i]*=velocity*(kind==='muted'?Math.exp(-i/rate*18):1);if(kind==='bass'&&track.drive>1)sample[i]=Math.tanh(sample[i]*amount)/Math.tanh(amount);}
   return sample;
  }}
  const f=hz(note), out=new Float64Array(Math.ceil(seconds*rate));
  // Karplus–Strong string: noise excitation, tuned fractional delay and bridge loss.
  if(kind==='nylon'||kind==='muted') {
   const len=rate/f, ring=new Float64Array(Math.ceil(len)+2);
   for(let i=0;i<ring.length;i++) ring[i]=(rand()*2-1)*.65;
   let old=0;
   for(let i=0;i<out.length;i++) {
    const p=i%ring.length, q=(p-len+ring.length*2)%ring.length, a=Math.floor(q), frac=q-a;
    const y=ring[a]*(1-frac)+ring[(a+1)%ring.length]*frac;
    const smooth=(y+old)*.5; old=y; ring[p]=smooth*(kind==='muted'?.965:.993);
    out[i]=smooth*Math.min(1,i/(rate*.004))*Math.exp(-i/rate/(kind==='muted'?.12:1.2));
   }
   return out;
  }
  for(let i=0;i<out.length;i++) {
   const t=i/rate, attack=1-Math.exp(-t/0.006), release=Math.min(1,(seconds-t)/.06);
   let s;
   if(kind==='keys') s=Math.sin(tau*f*t+1.6*Math.exp(-t*5)*Math.sin(tau*f*2*t))*.7*Math.exp(-t*2.6)+.12*Math.sin(tau*f*3*t)*Math.exp(-t*8);
   else if(kind==='bass') s=(Math.sin(tau*f*t)+.24*Math.sin(tau*f*2*t)+.10*Math.sin(tau*f*3*t))*Math.exp(-t*4);
   else if(kind==='marimba') s=Math.sin(tau*f*t)*Math.exp(-t*6)+.3*Math.sin(tau*f*3.99*t)*Math.exp(-t*18)+.1*Math.sin(tau*f*10*t)*Math.exp(-t*40);
   else if(kind==='glass') s=Math.sin(tau*f*t+2*Math.exp(-t*4)*Math.sin(tau*f*2*t))*.5*Math.exp(-t*2)+.16*Math.sin(tau*f*4*t)*Math.exp(-t*7);
   else s=(Math.sin(tau*f*t)+.25*Math.sin(tau*f*2*t)+.1*Math.sin(tau*f*3*t))*.55*Math.exp(-t*3)*(1+.12*Math.sin(tau*1.3*t));
   out[i]=s*attack*release*velocity;
  }
  if(kind==='bass'&&track.drive>1){const amount=1+(track.drive-1)*2;for(let i=0;i<out.length;i++)out[i]=Math.tanh(out[i]*amount)/Math.tanh(amount);}
  return out;
 }
 function drum(kind,at,level,pan=0) {
  onEvent?.({kind:'percussion',instrument:kind,time:at});
  // The same hit keeps its waveform/round robin across every energy section.
  randomState=(Math.imul(Math.round(at*rate)+kind.length,2654435761)+327+track.style+(track.variation||0))>>>0;
  if([0,1,4,5,7].includes(track.style)&&['kick','snare','hat','conga'].includes(kind)){const sample=recorded(kind,null,kind==='kick'?.45:kind==='snare'?.4:kind==='conga'?.3:.15,rate,Math.floor(rand()*2));if(sample){mix(sample,at,level,pan);return;}}
  const seconds=kind==='kick'?.32:kind==='brush'?.3:kind==='snare'?.17:.09;
  const out=new Float64Array(Math.ceil(seconds*rate)); let last=0,low=0;
  for(let i=0;i<out.length;i++) {
   const t=i/rate,n=rand()*2-1; low+=.15*(n-low);const high=n-last;last=n;
   if(kind==='kick') out[i]=Math.sin(tau*(48*t+5*(1-Math.exp(-t*35))))*Math.exp(-t*19)+high*.07*Math.exp(-t*180);
   else if(kind==='snare') out[i]=(.65*(n-low)*Math.exp(-t*35)+.3*Math.sin(tau*180*t)*Math.exp(-t*48))*(1-Math.exp(-t*900));
   else if(kind==='rim') out[i]=(Math.sin(tau*430*t)+.4*Math.sin(tau*1670*t))*Math.exp(-t*150);
   else if(kind==='conga') out[i]=(Math.sin(tau*(190*t+.5*(1-Math.exp(-t*50))))*.7+low*.5)*Math.exp(-t*34);
   else if(kind==='brush') out[i]=(n-low)*Math.sin(Math.PI*t/seconds)*Math.exp(-t*8)*.3;
   else out[i]=high*Math.exp(-t*(kind==='shaker'?75:120))*.45;
  }
  mix(out,at,level,pan);
 }
 if(probe){const data=tone(probe.note,1.5,probe.voice);return encode(data,data,track,{noteProbe:true});}
 const rootNotes=[50,45,41,48,43,40,47,41], base=track.tonic ?? rootNotes[track.style];
 // [bass root, chord tones relative to the tonic]. Each direction has its own cadence.
 const progressions=[
  [[0,[0,3,7,10,14]],[5,[5,8,12,15]],[8,[8,12,15,19]],[7,[7,11,14,17]]],
  [[0,[0,3,7,9]],[5,[5,8,12,15]],[10,[10,14,17,21]],[3,[3,7,10,14]],[8,[8,12,15,19]],[2,[2,5,8,12]],[7,[7,11,14,17]]],
  [[0,[0,3,7,10,14]],[3,[3,7,10,14]],[8,[8,12,15,19]],[10,[10,14,17,20]]],
  [[0,[0,3,7,10,17]],[8,[8,12,15,19]],[3,[3,7,10,14]],[10,[10,14,17,24]]],
  [[0,[0,4,7,11]],[4,[4,7,11,14]],[2,[2,5,9,12]],[7,[7,11,14,17]]],
  [[0,[0,3,7,10]],[9,[9,12,16,19]],[5,[5,9,12,16]],[7,[7,11,14,17]]],
  [[0,[0,3,7,14]],[8,[8,12,15,19]],[5,[5,8,12,15]],[0,[0,3,7,14]]],
  [[0,[0,4,7,11]],[9,[9,12,16,19]],[2,[2,5,9,12]],[7,[7,11,14,17]]],
 ];
 const harmony=track.harmony || progressions[track.style];
 const buildNames=['Call and response','Acoustic lift','Break and return','Filter opening','Interlocking answers','Octave lift','Space to detail','Walking cadence'];
 for(let bar=0;!oneShot&&bar<track.bars;bar++) {
  const progress=bar/(track.bars-1), final=!loop&&bar===track.bars-1;
  const chordIndex=cadence?harmony.length-1:final?0:Math.floor(bar/2)%harmony.length;
  let [rootOffset,chord]=harmony[chordIndex];
  chord=[...chord];
  const lift=cadence?.65+.35*progress:track.energy === undefined?Math.max(0,Math.min(1,(progress-.35)/.65)):track.energy;
  const energy=.4+.6*lift;
  const root=base+rootOffset,barTime=bar*track.meter*beat;
  // Distinct phrase builds: voice leading, breaks, interlock and register, not only hats.
  if(track.style===0&&lift>.55)chord=[chord[1],chord[2],chord[3],chord[0]+12,chord.at(-1)];
  if(track.style===1&&lift>.8&&!track.warm)chord=chord.map((n,i)=>i<2?n+12:n);
  const restBar=!loop&&!cadence&&track.style===2&&bar===Math.floor(track.bars/2);
  const swing=track.style===0||track.style===2?.13:track.style===7?.18:0;
  for(let step=0;step<track.meter*4;step++) {
   if((final&&step>=track.meter*4-(track.style===3?4:2))||restBar||(track.style===6&&bar<2))continue;
   const b=step/4, at=barTime+(b+(step%2?swing/2:0))*beat, quarter=step%4===0;
   let kick=false,back=false;
   if(track.style===1){kick=step===0||step===6||step===8;back=step===4||step===12;}
   else if(track.style===2){kick=step===0||step===7||step===10;back=step===4||step===12;}
   else if(track.style===3||track.style===5){kick=quarter;back=step===4||step===12;}
   else if(track.style===6){kick=step===0||step===11;back=step===8;}
   else if(track.style===7){kick=step===0;back=step===4||step===8;}
   else {kick=step===0||step===6||step===10;back=step===4||step===12;}
   if(track.style===4&&step!==0)kick=false;
   if(track.quiet&&step!==0)kick=false;
   if(kick)drum('kick',at,track.style===7?.19:track.style===1?.28:.52);
   if(back&&!track.quiet)drum(track.style===1||track.style===4?'rim':track.style===7?'brush':'snare',at,track.style===7?.28:.22);
   if(step%2===0&&(!track.quiet||step%4===0))drum(track.style===1||track.style===4?'shaker':'hat',at,.10+(step%4===2?.05:0),.26);
   if([0,2,4,5].includes(track.style)&&energy>.72&&step%2===1)drum('shaker',at,.045,-.25);
   if(track.style===4&&(step%3===0||(lift>.7&&[10,14].includes(step))))drum('conga',at,.19+.08*lift,step%2?.3:-.3);
   if(track.style===2&&lift>.8&&bar%4===3&&step>=12)drum('snare',at,.045+(step-12)*.008,-.1);
   if(track.style===7&&quarter)drum('brush',at,.18,.22);
   // Authored final two bars: the existing kit answers more closely, never an added riser or roll.
   if(cadence&&bar===track.bars-1&&step>=8&&step%2===0){
    drum(track.style===4?'conga':track.style===1?'rim':'snare',at,.06+.025*(step-8)/2,step%4?.18:-.18);
   }
  }
  let chordBeats;
  if(track.style===1)chordBeats=track.kind==='decision'&&lift<.3?[0,1.5,2.5]:lift>.8?[0,.75,1.5,2.5,3.25,3.75]:[0,.75,1.5,2.5,3.25];
  else if(track.style===3)chordBeats=[.5,1.5,2.5,3.5];
  else if(track.style===5)chordBeats=[.5,.75,1.5,2.5,2.75,3.5];
  else if(track.style===4)chordBeats=track.kind==='decision'&&lift<.3?[0,.75,1.5,3]:[0,.75,1.5,2.25,3,3.5];
  else if(track.style===7)chordBeats=[0,1.66];
  else if(track.style===2)chordBeats=[0,1.75,2.5];
  else chordBeats=[0,2.5];
  for(const [activeIndex,b] of chordBeats.entries()) {
   // Shared hits keep their identity as density changes: pitch, pan and velocity never remap.
   const identity=track.kind==='decision'&&track.style===4?[0,.75,1.5,3,2.25,3.5]:track.kind==='decision'&&track.style===1?[0,1.5,2.5,.75,3.25,3.75]:chordBeats;
   const index=identity.indexOf(b);
   if(final&&b>track.meter-(track.style===3?1:.65))continue;
   if(track.style===4){const note=base+12+chord[index%4],pan=-.23+index%3*.23;onEvent?.({kind:'chord',bar,beat:b,note,pan,velocity:1});mix(tone(note,.65,'marimba'),barTime+b*beat,.21,pan);}
   else for(let v=0;v<chord.length;v++){
    const duration=track.voice==='muted'?.22:track.voice==='nylon'?.7:track.style===2?.36:track.style===3?.32:1.15;
    const pitch=base+(track.warm?0:12)+chord[v],velocity=.87+(index%2?-.05:.08);onEvent?.({kind:'chord',bar,beat:b,note:pitch,pan:-.24+v*.12,velocity});const note=tone(pitch,duration,track.voice,velocity);
    if(track.style===3||track.warm){let value=0;const alpha=1-Math.exp(-tau*(track.warm?1850:(500+2600*lift))/rate);for(let i=0;i<note.length;i++){value+=alpha*(note[i]-value);note[i]=value;}}
    mix(note,barTime+b*beat+v*.007,.092*(.8+energy*.2),-.24+v*.12);
   }
  }
  const bassBeats=track.style===4&&lift>.75?[0,1.5,2.75,3.5]:track.style===7?[0,1,2]:track.style===1?[0,1.5,2,3.5]:track.style===3?[.75,1.75,2.75,3.5]:[0,1.5,2.75];
  for(const [i,b] of bassBeats.entries())if((!final||b<track.meter-(track.style===3?1:.65))&&!restBar){
   let interval=i%3===1?7:0;
   if(track.style===5)interval=lift>.5?[0,12,7][i%3]:[0,7,0][i%3];
   if(track.style===7){const next=harmony[(chordIndex+1)%harmony.length][0];interval=i===0?0:i===1?chord[1]-rootOffset:(bar%2?next-rootOffset-1:7);}
   onEvent?.({kind:'bass',bar,beat:b,note:root-12+interval,pan:0,velocity:1});
   mix(tone(root-12+interval,track.style===7?.53:.4,'bass'),barTime+b*beat,(track.warm?.39:.29)*(1+.6*((track.drive||1)-1)));
  }
  // A composed answer every second bar; density grows without unrelated layers.
  if(bar%2===1&&lift>.35&&!restBar&&!track.noLead){
   const count=track.style===6?2:energy>.8?4:2;
   for(let i=0;i<count;i++){
    const slot=count===2?i*2:i, b=track.meter-2+slot*.5;
    if(final&&b>track.meter-(track.style===3?1:.65))continue;
    const interval=chord[(slot+1)%chord.length];onEvent?.({kind:'answer',bar,beat:b,note:base+12+interval,pan:-.15,velocity:1});
    mix(tone(base+12+interval,.55,track.style===1?'nylon':track.style===4?'marimba':track.style===5?'muted':track.voice),barTime+b*beat,.063,-.15);
   }
  }
 }
 if(!loop){
  if(oneShot){
   // A short descending fifth–third–tonic signature, played by this theme's own instrument.
   const third=(track.style===4||track.style===7)&&track.mode!=='minor'?4:3,register=base+(track.warm?12:24);
   for(const [i,interval]of [7,third,0].entries()){
    const at=[0,.16,.34][i],pitch=register+interval;onEvent?.({kind:'resolution',note:pitch,voice:track.voice,time:at});
    const note=tone(pitch,i===2?1.6:.75,track.voice,.85);if(track.warm){let low=0;const alpha=1-Math.exp(-tau*2600/rate);for(let j=0;j<note.length;j++){low+=alpha*(note[j]-low);note[j]=low;}}
    mix(note,at,[.22,.23,.27][i],[-.12,.1,0][i]);
   }
   for(const [i,interval]of [0,third,7].entries()){
    const pitch=base+12+interval;onEvent?.({kind:'resolution-support',note:pitch,voice:track.voice,time:.34});mix(tone(pitch,2,track.voice,.7),.34,.065,-.16+i*.16);
   }
   mix(tone(base-12,1.5,'bass'),.34,.17);
  }else{

 // Zero resolves the authored dominant phrase with the same instruments; no alarm or extra sound.
 for(const [i,n] of (track.style===1?[0,3,7,14]:(track.style===4||track.style===7)&&track.mode!=='minor'?[0,4,7,14]:[0,3,7,14]).entries()){
  const pitch=base+(track.warm?0:12)+n;onEvent?.({kind:'resolution',note:pitch,voice:track.voice,time:zero+i*.012});const note=tone(pitch,2.5,track.voice);
  if(track.warm){let value=0;const alpha=1-Math.exp(-tau*1850/rate);for(let j=0;j<note.length;j++){value+=alpha*(note[j]-value);note[j]=value;}}
  mix(note,zero+i*.012,.16,-.2+i*.13);
 }
 mix(tone(base-12,1.2,'bass'),zero,.33);
 if(cadence){drum('kick',zero,.32);if(track.style===4)drum('conga',zero,.12);}
 // Deliberate calm tail while responses would remain open.
 for(let i=0;i<2;i++)mix(tone(base+12+(i?7:0),1.1,track.voice),zero+1.4+i*.6,.075,i?.15:-.15);
   }
 }
 // Short stereo room, low-passed returns; centred dry mix remains mono compatible.
 for(const channel of [left,right]){
  const delay=Math.round(rate*(channel===left?.087:.113)); let smooth=0;
  for(let i=delay;i<channel.length;i++) {smooth+=.12*(channel[i-delay]-smooth);channel[i]+=smooth*.12;}
 }
 // Broad 1.5 kHz cut, Q .55, -5 dB: speech room without removing musical fundamentals.
 function notch(data) {
  const a=10**(-5/40),w=tau*1500/rate,alpha=Math.sin(w)/(2*.55),a0=1+alpha/a;
  const b0=(1+alpha*a)/a0,b1=-2*Math.cos(w)/a0,b2=(1-alpha*a)/a0,a1=-2*Math.cos(w)/a0,a2=(1-alpha/a)/a0;
  let x1=0,x2=0,y1=0,y2=0;
  for(let i=0;i<data.length;i++){const x=data[i],y=b0*x+b1*x1+b2*x2-a1*y1-a2*y2;x2=x1;x1=x;y2=y1;y1=y;data[i]=y;}
 }
 notch(left);notch(right);
 for(let i=0;i<left.length;i++){const phase=oneShot?1:i/rate/zero;const lift=Math.max(0,Math.min(1,(phase-.35)/.65));const envelope=loop?1:.85+.15*lift;left[i]*=envelope;right[i]*=envelope;}
 if(loop){
  const frames=Math.round(zero*rate);
  for(let i=frames;i<left.length;i++){left[i-frames]+=left[i];right[i-frames]+=right[i];}
  return encode(left.subarray(0,frames),right.subarray(0,frames),track,{loopS:frames/rate});
 }
 return encode(left,right,track,{zeroS:zero});
}
function encode(left,right,track,extra){
 let sum=0,peak=0;for(let i=0;i<left.length;i++){sum+=(left[i]**2+right[i]**2)/2;peak=Math.max(peak,Math.abs(left[i]),Math.abs(right[i]));}
 const rms=Math.sqrt(sum/left.length),gain=Math.min(.105/Math.max(rms,1e-9),.88/Math.max(peak,1e-9));
 const wav=Buffer.alloc(44+left.length*4);wav.write('RIFF',0);wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(2,22);wav.writeUInt32LE(rate,24);wav.writeUInt32LE(rate*4,28);wav.writeUInt16LE(4,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(left.length*4,40);
 for(let i=0;i<left.length;i++){const fade=extra.loopS?1:Math.min(1,i/(rate*.015),(left.length-i)/(rate*.3));wav.writeInt16LE(Math.round(left[i]*gain*fade*32767),44+i*4);wav.writeInt16LE(Math.round(right[i]*gain*fade*32767),46+i*4);}
 return {wav,meta:{...track,...extra,durationS:left.length/rate}};
}
