// The invitation study must describe the real permission contract, including conditional cells.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseMatrixTable,DOC} from '../scripts/gen-permissions.mjs';
import {MATRIX,PRINCIPALS,permissionLabels} from '../prototypes/design/studio-permissions.mjs';
import {MATRIX as canonicalMatrix,PRINCIPALS as canonicalPrincipals} from '../src/shared/permissions.mjs';
import {permissionGroups} from '../prototypes/design/studio-permission-view.mjs';
test('Studio full permissions disclosure uses canonical cells and complete current action labels',()=>{
 const rows=parseMatrixTable(readFileSync(DOC,'utf8'));
 assert.strictEqual(MATRIX,canonicalMatrix);assert.strictEqual(PRINCIPALS,canonicalPrincipals);
 assert.deepEqual(permissionLabels,Object.fromEntries(rows.map(r=>[r.id,r.action])));
 assert.equal(rows.length,49);assert.equal(PRINCIPALS.length,9);
 assert.deepEqual(permissionGroups.flatMap(([,ids])=>ids).sort(),Object.keys(canonicalMatrix).sort(),'grouping must neither omit nor repeat a canonical action');
});
