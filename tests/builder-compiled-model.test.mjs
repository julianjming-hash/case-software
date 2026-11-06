import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {init,parse} from 'es-module-lexer';
import {buildClient,COMPACT_MODULES} from '../scripts/build-client.mjs';
import * as sourceMachine from '../src/shared/room-machine.mjs';
import * as sourceDocument from '../src/shared/case-document.mjs';
import {miniCase} from './helpers/mini-case.mjs';
import {uuidv7} from '../src/shared/ids.mjs';

test('Builder budget compaction preserves emitted model exports, validation, reducer events and role projections',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'case-c50-emission-'));
 try{
  const out=join(dir,'built'),{assets}=await buildClient({outDir:out});
  const files=(await readdir(join(out,'assets'))).filter(f=>f.endsWith('.mjs'));
  // Node loading shim only: production absolute asset imports become sibling imports.
  // No algorithm or emitted identifier is changed by this test shim.
  for(const file of files){const path=join(out,'assets',file);await writeFile(path,(await readFile(path,'utf8')).replaceAll('/assets/','./'));}
  const load=async name=>import(pathToFileURL(join(out,'assets',files.find(f=>f.startsWith(name+'.')))).href);
  const machine=await load('room-machine'),document=await load('case-document');
  assert.deepEqual(Object.keys(machine).sort(),Object.keys(sourceMachine).sort());
  assert.deepEqual(Object.keys(document).sort(),Object.keys(sourceDocument).sort());
  const caseDoc=miniCase().doc, before=structuredClone(caseDoc);
  assert.deepEqual(document.validateCaseDocument(caseDoc),sourceDocument.validateCaseDocument(caseDoc));
  const invalid=structuredClone(caseDoc);invalid.beats[1].id=invalid.beats[0].id;
  assert.deepEqual(document.validateCaseDocument(invalid),sourceDocument.validateCaseDocument(invalid));
  const initial={sessionId:uuidv7(),joinCode:'7K3QX9',caseDoc};
  let expected=sourceMachine.initialState(initial),actual=machine.initialState(initial);
  assert.deepEqual(actual,expected);
  for(const type of ['start','advance','advance','pause','resume','advance']){
   const event={type,roundId:uuidv7(),clientEventId:uuidv7(),epoch:expected.epoch,at:'2026-10-10T00:00:00.000Z',actor:{role:'facilitator',id:'fac'}};
   const left=sourceMachine.reduce(expected,event),right=machine.reduce(actual,event);
   assert.deepEqual(right,left);expected=left.state;actual=right.state;
   for(const role of ['facilitator','display','participant'])assert.deepEqual(machine.project(actual,role),sourceMachine.project(expected,role));
  }
  assert.deepEqual(caseDoc,before);
  // Every compacted module keeps its exported names (read statically: some client modules need a browser to run);
  // a listed module the build no longer emits fails here too.
  await init;const names=text=>parse(text)[1].map(item=>item.n).sort();
  for(const source of COMPACT_MODULES){
   assert.ok(assets[source],`${source} is not emitted`);
   assert.deepEqual(names(await readFile(join(out,assets[source]),'utf8')),names(await readFile(new URL(`../${source}`,import.meta.url),'utf8')),source);
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});
