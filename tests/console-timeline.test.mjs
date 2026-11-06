import test from 'node:test';
import assert from 'node:assert/strict';
import { presentationTiles } from '../src/client/console-timeline.mjs';
test('timeline thumbnails use exact public occurrence, never private pack or current reveal count', () => {
 const view={timeline:[{title:'PRIVATE_TITLE',notes:'PRIVATE_NOTE'},{title:'SECOND_PRIVATE'}],
  publicTimeline:[{entryIndex:0,occurrenceId:'one',surface:{title:'Public arrival',scene:'Already shared',points:[],notes:'PRIVATE_NOTE'}},
   {entryIndex:1,occurrenceId:'two',surface:{title:'Public arrival',scene:'Already shared',points:['New shared finding'],notes:'OTHER_PRIVATE'}}]};
 const rows=presentationTiles(view);assert.equal(rows.length,2);assert.deepEqual(rows[0].points,[]);
 assert.deepEqual(rows[1].points,['New shared finding']);assert.equal(rows[0].occurrenceId,'one');
 assert.doesNotMatch(JSON.stringify(rows),/PRIVATE/);
});
test('missing or mismatched public evidence never falls back to facilitator timeline', () => {
 assert.deepEqual(presentationTiles({timeline:[{title:'PRIVATE'}]}),[]);
 assert.deepEqual(presentationTiles({timeline:[{}],publicTimeline:[]}),[]);
 assert.deepEqual(presentationTiles({timeline:[{}],publicTimeline:[{entryIndex:4,surface:{title:'wrong'}}]}),[]);
});

test('public tile marks the exact authority correction metadata',()=>{
 const rows=presentationTiles({timeline:[{},{}],publicTimeline:[{entryIndex:0,publication:{v:1,occurrenceId:'first'},surface:{title:'Shared'}},{entryIndex:1,publication:{v:1,occurrenceId:'undo',correctionOf:'reveal',restoresOccurrenceId:'first'},surface:{title:'Shared'}}]});
 assert.equal(rows[0].correction,false);assert.equal(rows[1].correction,true);
});
