// Self-contained immutable old-client baseline. No Git, origin, network or credentials.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
export const LEGACY_SHA = '83158a82c5f82ca28827afcd0f58adb0f5894b38';
export const LEGACY_ARCHIVE_SHA256='9653b2a54051e582bea0977fd301b053abba36d3174b48316bf7b4c78c4cb225';
export const LEGACY_WITNESSES = Object.freeze({
  'src/client/update.mjs': '9fbaf0cd42c77d4f669b77b9791fa566358206810dc8fdd8c0f4c994d7bb5abf',
  'src/client/console-room.mjs': '99b3a4920300f95858b819c13e2c9ee801a076d02e2d47057738c30bca05bda5',
  'src/shared/case-document.mjs': '1afd6471861c7aee68da5b7b7906c9fb1928364fdaaf700272416e8334fdd481',
  'scripts/build-client.mjs': '44985318621b887f2fd114b00e41a9aea9af1d130eea87cc02fa39207cc77be3',
});
const digest=b=>createHash('sha256').update(b).digest('hex');
export function legacyFailureReason(step,error){
 const how=error?.code==='ETIMEDOUT'?'timed out after 30 s':error?.signal?`signal ${error.signal}`:Number.isInteger(error?.status)?`exit ${error.status}`:'not run';
 return `legacy_source_unavailable: git ${step} ${how}`;
}
export function archiveLegacySource(root,{report=line=>process.stderr.write(`${line}\n`)}={}){
 try{
  const dir=join(root,'tests/fixtures/legacy-client'),manifest=JSON.parse(readFileSync(join(dir,'manifest.json'),'utf8'));
  const bytes=readFileSync(join(dir,'source.tar'));
  if(manifest.origin_commit!==LEGACY_SHA||manifest.archive_sha256!==LEGACY_ARCHIVE_SHA256||digest(bytes)!==LEGACY_ARCHIVE_SHA256||manifest.archive_bytes!==bytes.length)throw new Error();
  if(!Array.isArray(manifest.files)||!manifest.files.length||manifest.files.some(x=>!x.path||x.path.startsWith('/')||x.path.split('/').some(p=>p==='..'||p==='.git')||!(/^[a-f0-9]{64}$/.test(x.sha256))))throw new Error();
  return bytes;
 }catch{
  report('legacy_source_unavailable: bundled baseline missing or integrity mismatch');throw new Error('legacy_source_unavailable');
 }
}
export function verifyLegacyWitnesses(root){
 for(const[file,expected]of Object.entries(LEGACY_WITNESSES)){
  let actual;try{actual=digest(readFileSync(join(root,file)));}catch{throw new Error(`legacy_source_witness_mismatch:${file}`);}
  if(actual!==expected)throw new Error(`legacy_source_witness_mismatch:${file}`);
 }
}
