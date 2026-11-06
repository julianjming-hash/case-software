import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir,readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join,relative } from 'node:path';
const root=fileURLToPath(new URL('../src/worker/',import.meta.url));
async function files(dir) {
  const paths=[];
  for(const entry of await readdir(dir,{withFileTypes:true})) {
    const path=join(dir,entry.name);
    if(entry.isDirectory()) paths.push(...await files(path));
    else if(/\.(?:mjs|js)$/.test(entry.name)) paths.push(path);
  }
  return paths;
}
test('every Worker log goes through the single fixed-schema sink',async()=> {
  const violations=[];
  for(const path of await files(root)) {
    if(relative(root,path)==='log.mjs') continue;
    const source=await readFile(path,'utf8');
    if(/\bconsole\s*(?:\.|\[)/.test(source)) violations.push(relative(root,path));
  }
  assert.deepEqual(violations,[],'direct console calls bypass log scrubbing');
});
