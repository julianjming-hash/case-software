import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ADMIN_PURGE_CRON} from '../src/worker/admin/sweep.mjs';
test('Card 21a every explicit environment adds dedicated purge47 without changing health crons',()=>{
 const source=readFileSync(new URL('../wrangler.toml',import.meta.url),'utf8');
 for(const section of ['triggers','env.production.triggers','env.staging.triggers']) {
  const start=source.indexOf(`[${section}]`);assert.ok(start>=0,section);
  const end=source.indexOf('\n[',start+1);const body=source.slice(start,end<0?source.length:end);
  const declaration=body.match(/^crons\s*=\s*(\[[^\n]+\])/m);assert.ok(declaration,section);
  assert.deepEqual(JSON.parse(declaration[1]),['37 3 * * 1','17 * * * *',ADMIN_PURGE_CRON],section);
 }
});
