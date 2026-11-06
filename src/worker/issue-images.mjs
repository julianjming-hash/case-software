// Bounded structural validation only; screenshot pixels are never classified or masked.
import {inspectJpeg} from '../shared/media.mjs';
const CRC=Uint32Array.from({length:256},(_,n)=>{let c=n;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);return c>>>0;});
const crc32=bytes=>{let c=0xffffffff;for(const b of bytes)c=(c>>>8)^CRC[(c^b)&255];return(c^0xffffffff)>>>0;};
// Private evidence retains metadata. Inspect a bounded coding-only copy; never return it for storage.
function inspectEvidenceJpeg(bytes){
 if(bytes.length<4||bytes[0]!==255||bytes[1]!==216)return null;
 const parts=[bytes.subarray(0,2)];let at=2,segments=0,ended=false;
 while(at+1<bytes.length){
  if(++segments>1024||bytes[at]!==255)return null;const marker=bytes[at+1];
  if(marker===217){if(at+2!==bytes.length)return null;parts.push(bytes.subarray(at));ended=true;break;}
  if(at+4>bytes.length)return null;const length=(bytes[at+2]<<8)|bytes[at+3],end=at+2+length;
  if(length<2||end>bytes.length)return null;
  if(!(marker>=224&&marker<=239)&&marker!==254)parts.push(bytes.subarray(at,end));
  at=end;
  if(marker===218){const start=at;while(at<bytes.length&&!(bytes[at]===255&&bytes[at+1]!==0&&!(bytes[at+1]>=208&&bytes[at+1]<=215)))at++;parts.push(bytes.subarray(start,at));}
 }
 if(!ended)return null;const coding=new Uint8Array(parts.reduce((sum,p)=>sum+p.length,0));let offset=0;for(const p of parts){coding.set(p,offset);offset+=p.length;}return inspectJpeg(coding);
}
export async function inspectIssueImage(bytes,type){
 if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>5_000_000)return false;
 if(type==='image/jpeg'){const v=inspectEvidenceJpeg(bytes);return !!v?.ok&&v.width<=8192&&v.height<=8192&&v.width*v.height<=20_000_000;}
 if(type!=='image/png'||bytes.length<57||[137,80,78,71,13,10,26,10].some((n,i)=>bytes[i]!==n))return false;
 const dv=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let pos=8,width=0,height=0,channels=0,expected=0,ended=false,seenData=false,dataEnded=false;const chunks=[];
 while(pos+12<=bytes.length){const len=dv.getUint32(pos),end=pos+12+len;if(end>bytes.length)return false;
  const name=String.fromCharCode(...bytes.subarray(pos+4,pos+8));if(crc32(bytes.subarray(pos+4,pos+8+len))!==dv.getUint32(pos+8+len))return false;
  if(pos===8&&name!=='IHDR')return false;
  if(name==='IHDR'){if(pos!==8||len!==13)return false;width=dv.getUint32(pos+8);height=dv.getUint32(pos+12);const bit=bytes[pos+16],color=bytes[pos+17];channels=({0:1,2:3,4:2,6:4})[color];if(!width||!height||width>8192||height>8192||width*height>20_000_000||bit!==8||!channels||bytes[pos+18]||bytes[pos+19]||bytes[pos+20])return false;expected=(1+width*channels)*height;}
  else if(name==='IDAT'){if(dataEnded||!len)return false;seenData=true;chunks.push(bytes.subarray(pos+8,pos+8+len));}
  else if(name==='IEND'){if(len!==0||end!==bytes.length||!seenData)return false;ended=true;break;}
  else{if(seenData)dataEnded=true;if(!['sRGB','gAMA','cHRM','pHYs','iCCP','eXIf','tEXt','zTXt','iTXt'].includes(name))return false;if(({sRGB:1,gAMA:4,cHRM:32,pHYs:9})[name]!==undefined&&len!==({sRGB:1,gAMA:4,cHRM:32,pHYs:9})[name])return false;}
  pos=end;
 }
 if(!ended)return false;
 let reader,timer;
 try{reader=new Blob(chunks).stream().pipeThrough(new DecompressionStream('deflate')).getReader();let count=0;const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('timeout')),2000);});for(;;){const part=await Promise.race([reader.read(),deadline]);if(part.done)break;const stride=1+width*channels;for(let j=(stride-count%stride)%stride;j<part.value.byteLength;j+=stride)if(part.value[j]>4)return false;count+=part.value.byteLength;if(count>expected)return false;}return count===expected;
 }catch{return false;}finally{clearTimeout(timer);try{void reader?.cancel().catch(()=>{});}catch{}}
}
