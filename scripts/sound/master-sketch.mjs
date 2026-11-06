// Offline, dev-only FFmpeg mastering. No network or runtime dependency.
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export function run(ffmpeg,args){return execFileSync(ffmpeg,['-hide_banner','-nostdin',...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:4*1024*1024});}
function measure(ffmpeg,path,settings='I=-23:TP=-2:LRA=7'){
 const {stderr}=spawn(ffmpeg,['-i',path,'-af',`loudnorm=${settings}:print_format=json`,'-f','null','-']);
 const text=stderr.slice(stderr.lastIndexOf('{'),stderr.lastIndexOf('}')+1);return JSON.parse(text);
}
import { spawnSync } from 'node:child_process';
function spawn(ffmpeg,args){const r=spawnSync(ffmpeg,['-hide_banner','-nostdin',...args],{encoding:'utf8',maxBuffer:4*1024*1024});if(r.status!==0)throw Error(`FFmpeg failed: ${r.stderr}`);return r;}
export async function masterSketch(wav,ffmpeg,{targetLufs=-23}={}){
 const dir=await mkdtemp(join(tmpdir(),'case-sound-master-')),input=join(dir,'input.wav'),output=join(dir,'output.wav');
 try{
  await writeFile(input,wav);const before=measure(ffmpeg,input,`I=${targetLufs}:TP=-2:LRA=7`);
  const filter=`loudnorm=I=${targetLufs}:TP=-2:LRA=7:measured_I=${before.input_i}:measured_TP=${before.input_tp}:measured_LRA=${before.input_lra}:measured_thresh=${before.input_thresh}:offset=${before.target_offset}:linear=true`;
  spawn(ffmpeg,['-y','-i',input,'-af',filter,'-ar','44100','-ac','2','-c:a','pcm_s16le',output]);
  const after=measure(ffmpeg,output,`I=${targetLufs}:TP=-2:LRA=7`);
  return {wav:await readFile(output),loudness:{integratedLufs:Number(after.input_i),truePeakDbtp:Number(after.input_tp),loudnessRangeLu:Number(after.input_lra),method:`FFmpeg loudnorm, two-pass, target ${targetLufs} LUFS / -2 dBTP`}};
 }finally{await rm(dir,{recursive:true,force:true});}
}
