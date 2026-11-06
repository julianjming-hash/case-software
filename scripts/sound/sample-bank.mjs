// Offline authoring only. Pinned CC0 source recordings, never loaded by the browser.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root=new URL('../../prototypes/sound-stage/sources/',import.meta.url);
const manifest=JSON.parse(await readFile(new URL('manifest.json',root),'utf8'));
const bank=new Map();
for(const entry of manifest.samples){
 const wav=await readFile(new URL(entry.file,root));
 if(createHash('sha256').update(wav).digest('hex')!==entry.sha256)throw Error(`Source hash mismatch: ${entry.file}`);
 let format,channels,rate,bits,start,length;
 for(let i=12;i+8<=wav.length;){const kind=wav.toString('ascii',i,i+4),size=wav.readUInt32LE(i+4);if(kind==='fmt '){format=wav.readUInt16LE(i+8);channels=wav.readUInt16LE(i+10);rate=wav.readUInt32LE(i+12);bits=wav.readUInt16LE(i+22);if(format===65534)format=wav.readUInt16LE(i+32);}if(kind==='data'){start=i+8;length=size;}i+=8+size+(size%2);}
 if(!start||![1,3].includes(format)||![16,24,32].includes(bits))throw Error(`Unsupported source WAV: ${entry.file}`);
 const stride=bits/8*channels, count=Math.floor(length/stride), signal=new Float64Array(count);
 let peak=0;
 for(let i=0;i<count;i++){let sum=0;for(let c=0;c<channels;c++){const p=start+i*stride+c*bits/8;sum+=format===3?wav.readFloatLE(p):bits===24?wav.readIntLE(p,3)/8388608:bits===16?wav.readInt16LE(p)/32768:wav.readInt32LE(p)/2147483648;}signal[i]=sum/channels;peak=Math.max(peak,Math.abs(signal[i]));}
 // Strip only silence before the note. Preserve its real attack.
 let onset=0;while(onset<count&&Math.abs(signal[onset])<peak*.002)onset++;onset=Math.max(0,onset-Math.round(rate*.001));
 const samples=signal.subarray(onset);if(!bank.has(entry.kind))bank.set(entry.kind,[]);bank.get(entry.kind).push({...entry,samples,rate,scale:.75/Math.max(peak,.001)});
}
export function recorded(kind,note,seconds,rate,variant=0){
 const choices=bank.get(kind);if(!choices)return null;
 const entry=note===null?choices[variant%choices.length]:choices.reduce((a,b)=>Math.abs(a.note-note)<=Math.abs(b.note-note)?a:b);
 const step=entry.rate/rate*(note===null?1:2**((note-entry.note)/12)),out=new Float64Array(Math.ceil(seconds*rate));
 for(let i=0;i<out.length;i++){const p=i*step,j=Math.floor(p);if(j+1>=entry.samples.length)break;const frac=p-j;const sample=entry.samples[j]*(1-frac)+entry.samples[j+1]*frac;const envelope=Math.min(1,i/(rate*.002),(out.length-i)/(rate*.05));out[i]=sample*entry.scale*envelope;}
 return out;
}
