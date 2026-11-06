import test from 'node:test';import assert from'node:assert/strict';
import{mkdtempSync,readFileSync,rmSync,writeFileSync,mkdirSync,cpSync,existsSync}from'node:fs';
import{tmpdir}from'node:os';import{join}from'node:path';import{fileURLToPath}from'node:url';import{execFileSync}from'node:child_process';import{createHash}from'node:crypto';
import{LEGACY_SHA,LEGACY_ARCHIVE_SHA256,archiveLegacySource,legacyFailureReason,verifyLegacyWitnesses}from'./helpers/legacy-source.mjs';
const ROOT=fileURLToPath(new URL('..',import.meta.url)),digest=b=>createHash('sha256').update(b).digest('hex');
function isolated(){const temp=mkdtempSync(join(tmpdir(),'case-bundled-legacy-')),root=join(temp,'checkout');mkdirSync(join(root,'tests/fixtures'),{recursive:true});cpSync(join(ROOT,'tests/fixtures/legacy-client'),join(root,'tests/fixtures/legacy-client'),{recursive:true});return{temp,root};}
test('exact pinned legacy baseline works in a credential-free tree with no Git, origin or history and retains all file witnesses',()=>{
 const{temp,root}=isolated();try{
  assert.equal(existsSync(join(root,'.git')),false);const manifest=JSON.parse(readFileSync(join(root,'tests/fixtures/legacy-client/manifest.json')));
  const a=archiveLegacySource(root),b=archiveLegacySource(root);assert.equal(digest(a),LEGACY_ARCHIVE_SHA256);assert.deepEqual(a,b);assert.equal(manifest.origin_commit,LEGACY_SHA);
  const output=join(temp,'reference');mkdirSync(output);execFileSync('tar',['-xf','-'],{cwd:output,input:a});assert.doesNotThrow(()=>verifyLegacyWitnesses(output));
  for(const f of manifest.files)assert.equal(digest(readFileSync(join(output,f.path))),f.sha256,f.path);
  assert.equal(manifest.files.some(f=>f.path.startsWith('src/fixtures/')),false);
  writeFileSync(join(output,'src/client/update.mjs'),'WRONG_SOURCE_SENTINEL');assert.throws(()=>verifyLegacyWitnesses(output),/^Error: legacy_source_witness_mismatch:src\/client\/update.mjs$/);
 }finally{rmSync(temp,{recursive:true,force:true});}
});
for(const mutation of ['missing_archive','changed_archive','missing_manifest','wrong_origin','changed_archive_digest'])test(`unavailable or tampered ${mutation} refuses without fallback or private diagnostics`,()=>{
 const{temp,root}=isolated();try{
  const dir=join(root,'tests/fixtures/legacy-client'),file=join(dir,'source.tar');
  if(mutation==='missing_archive')rmSync(file);else if(mutation==='changed_archive'){const b=readFileSync(file);b[0]^=1;writeFileSync(file,b);}else if(mutation==='missing_manifest')rmSync(join(dir,'manifest.json'));else{const m=JSON.parse(readFileSync(join(dir,'manifest.json')));if(mutation==='wrong_origin')m.origin_commit='0'.repeat(40);else m.archive_sha256='0'.repeat(64);writeFileSync(join(dir,'manifest.json'),JSON.stringify(m));}
  const reported=[];assert.throws(()=>archiveLegacySource(root,{report:x=>reported.push(x)}),e=>e.message==='legacy_source_unavailable'&&Object.keys(e).length===0);assert.deepEqual(reported,['legacy_source_unavailable: bundled baseline missing or integrity mismatch']);assert.equal(reported[0].includes(temp),false);
 }finally{rmSync(temp,{recursive:true,force:true});}
});
test('[CASE-260] historical diagnostic formatting remains content-free',()=>{
 assert.equal(legacyFailureReason('fetch',{code:'ETIMEDOUT',signal:'SIGTERM',stderr:'PRIVATE_DIAGNOSTIC'}),'legacy_source_unavailable: git fetch timed out after 30 s');
 assert.equal(legacyFailureReason('fetch',{status:128,stderr:'PRIVATE_DIAGNOSTIC'}),'legacy_source_unavailable: git fetch exit 128');assert.equal(legacyFailureReason('archive',{signal:'SIGKILL'}),'legacy_source_unavailable: git archive signal SIGKILL');assert.equal(legacyFailureReason('cat-file after fetch',{status:1}),'legacy_source_unavailable: git cat-file after fetch exit 1');assert.equal(legacyFailureReason('fetch',{}),'legacy_source_unavailable: git fetch not run');
});
