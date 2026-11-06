// Offline developed library. Original source WAVs and instrument arrangements stay in Git.
import { renderComposition } from './compose-library.mjs';
import { masterSketch, run } from './master-sketch.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const ffmpeg=process.argv[process.argv.indexOf('--ffmpeg')+1];
if(!process.argv.includes('--ffmpeg')||!ffmpeg)throw Error('Supply --ffmpeg /path/to/ffmpeg');
const root=new URL('../../prototypes/sound-stage/assets/',import.meta.url);
const profiles=[
 {id:'atlas-current',name:'Atlas · Current',family:'Atlas',kind:'decision',style:4,tonic:43,key:'G major',voice:'marimba',bpm:106,bars:8,meter:4,description:'The original marimba atmosphere, with a bass-led lift, answering wooden phrases and a tighter final percussion weave.'},
 {id:'atlas-crossing',name:'Atlas · Crossing',family:'Atlas',kind:'decision',style:4,tonic:40,key:'E minor',mode:'minor',voice:'marimba',bpm:106,bars:8,meter:4,variation:71,harmony:[[0,[0,3,7,10]],[5,[5,8,12,15]],[10,[10,14,17,21]],[7,[7,11,14,17]]],description:'A second Atlas direction in E minor. A darker harmonic pull and interlocking answers build tension within the same wooden palette.'},
 {id:'side-street-developed',name:'Side Street',family:'Side Street',kind:'decision',style:1,tonic:45,key:'A minor',voice:'nylon',bpm:112,bars:14,meter:4,warm:true,noLead:true,description:'Lower archtop voicings, softened upper strings and a more present recorded bass. The groove gains percussion detail toward the finish.'},
 {id:'night-platform-developed',name:'Night Platform',family:'Night Platform',kind:'decision',style:2,tonic:41,key:'F minor',voice:'keys',bpm:126,bars:8,meter:4,description:'The kept two-step pace, opening from a lean pocket into denser hats, chord answers and short same-kit turnarounds.'},
 {id:'atlas-arrival',name:'Atlas · Arrival',family:'Atlas',kind:'lobby',style:4,tonic:43,key:'G major',voice:'marimba',bpm:88,bars:8,meter:4,quiet:true,energy:0,noLead:true,description:'A spacious arrival bed: slow marimba, a soft low anchor and sparse hand percussion, with no countdown build.'},
 {id:'side-street-afterglow',name:'Side Street · Afterglow',family:'Side Street',kind:'debrief',style:1,tonic:45,key:'A minor',voice:'nylon',bpm:82,bars:14,meter:4,warm:true,quiet:true,noLead:true,energy:0,description:'A warm, unhurried guitar-and-bass bed for debrief and wrap-up. Stable energy and room for discussion.'},
];
async function encodeAsset(raw,label,targetLufs){
 const mastered=await masterSketch(raw.wav,ffmpeg,{targetLufs});
 const dir=await mkdtemp(join(tmpdir(),'case-sound-library-'));const pcm=join(dir,'mix.wav'),compressed=join(dir,'mix.mp3');
 try{
  await writeFile(pcm,mastered.wav);
  execFileSync(ffmpeg,['-hide_banner','-nostdin','-y','-i',pcm,'-c:a','libmp3lame','-b:a','192k','-ar','44100','-ac','2','-write_xing','1',compressed],{stdio:'ignore'});
  const bytes=await readFile(compressed),sha256=createHash('sha256').update(bytes).digest('hex'),file=`${label}-${sha256}.mp3`;
  await writeFile(new URL(file,root),bytes);
  const measured=spawnSync(ffmpeg,['-hide_banner','-nostdin','-i',compressed,'-af',`loudnorm=I=${targetLufs}:TP=-2:LRA=7:print_format=json`,'-f','null','-'],{encoding:'utf8'});
  if(measured.status!==0)throw Error(measured.stderr);
  const text=measured.stderr,measurement=JSON.parse(text.slice(text.lastIndexOf('{'),text.lastIndexOf('}')+1));
  return {file:`assets/${file}`,sha256,bytes:bytes.length,format:'audio/mpeg',durationS:raw.meta.durationS,loopS:raw.meta.loopS??null,leadInS:raw.meta.zeroS??0,integratedLufs:Number(measurement.input_i),truePeakDbtp:Number(measurement.input_tp),targetLufs};
 }finally{await rm(dir,{recursive:true,force:true});}
}
const cuesOnly=process.argv.includes('--cues-only');const existing=cuesOnly?JSON.parse(await readFile(new URL('library.json',root),'utf8')):null;
async function renderProfile(profile,sharedZero=null){
 const assets={};
 for(const [section,energy,target]of profile.kind==='decision'?[['low',0,-25],['mid',.55,-24],['peak',1,-23]]:[['low',0,-26]]){
  if(cuesOnly){const previous=existing.tracks.flatMap(t=>[t,...(t.boosts||[])]).find(t=>t.id===profile.id);for(const key of ['style','tonic','key','voice','bpm','bars','meter','drive','tempoFactor','warm','mode','variation','harmony','quiet','noLead'])if(JSON.stringify(previous?.[key])!==JSON.stringify(profile[key]))throw Error('Loop profile changed in cue-only mode: '+profile.id+'/'+key);const asset=previous.assets[section],bytes=await readFile(new URL(asset.file.replace('assets/',''),root));if(createHash('sha256').update(bytes).digest('hex')!==asset.sha256)throw Error('Existing loop hash mismatch');assets[section]=asset;continue;}
  const raw=renderComposition({...profile,energy},{loop:true});assets[section]=await encodeAsset(raw,`${profile.id}-${section}`,target+energy*((profile.drive||1)-1)*3);console.log(profile.id,section,assets[section].bytes,assets[section].integratedLufs);
 }
 if(profile.kind==='decision')assets.zero=sharedZero||{...await encodeAsset(renderComposition(profile,{oneShot:true}),`${profile.id}-zero`,-21.5),attackSkipS:0};
 return {...profile,loopS:assets.low.loopS,assets};
}
const tracks=[];
for(const profile of profiles){
 const track=await renderProfile(profile);
 if(profile.kind==='decision'){
  track.boosts=[];
  for(const [drive,speed]of [[1.25,1.06],[1.5,1.12]])track.boosts.push(await renderProfile({...profile,id:`${profile.id}-boost-${Math.round(drive*100)}`,bpm:Number((profile.bpm*speed).toFixed(3)),drive,tempoFactor:speed,baseId:profile.id},track.assets.zero));
 }
 tracks.push(track);
}
const all=tracks.flatMap(t=>[t,...(t.boosts||[])]);
const uniqueAssets=[...new Map(all.flatMap(t=>Object.values(t.assets)).map(a=>[a.sha256,a])).values()];
const manifest={version:6,stage:'fluid-150-intensity-awaiting-owner-audition',licence:'CC0-1.0',source:'scripts/sound/render-library.mjs',masteringTool:run(ffmpeg,['-version']).split('\n')[0],codec:'MP3 192 kbit/s stereo; original pitches rendered at each authored tempo, no playback-rate pitch shift',tracks,uniqueAssetCount:uniqueAssets.length,totalBytes:uniqueAssets.reduce((sum,a)=>sum+a.bytes,0)};
await writeFile(new URL('library.json',root),JSON.stringify(manifest,null,2)+'\n');console.log('Library total bytes',manifest.totalBytes);
