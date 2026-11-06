// Card 62 PUBLISH-01 after image approval was removed (CASE-342, plan §3 A6): a refused image is named by its slide, text alternative
// and reason, from the listed statuses. An image that is live is never refused; no message mentions approval.
import test from 'node:test';
import assert from 'node:assert/strict';
import { namedImageIssues, withImageNames } from '../src/client/builder-image-issues.mjs';

const id = n => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const document = {
  schema_version: 3,
  beats: [{ id: id(1), title: 'Arrival' }, { id: id(2), title: '' }],
  decisions: [{ id: id(3), paths: [{ id: id(4), label: 'Needle decompression' }] }],
  compositions: [{ id: id(10), owner: { kind: 'beat', id: id(1) }, reading_order: [id(20), id(21)] }, { id: id(11), owner: { kind: 'beat', id: id(2) }, reading_order: [id(22)] },
    { id: id(12), owner: { kind: 'path', id: id(4) }, reading_order: [id(23)] }],
  blocks: [{ id: id(20), type: 'image', asset_id: id(30), alt: 'Portable chest film' }, { id: id(21), type: 'text' }, { id: id(22), type: 'image', asset_id: id(31), alt: '' },
    { id: id(23), type: 'image', asset_id: id(32), alt: 'Post-decompression film' }, { id: id(24), type: 'image', asset_id: id(33), alt: 'Unplaced ECG' }],
};
const rows = [{ asset_id: id(30), status: 'quarantined', alt_text: 'Chest X-ray' }, { asset_id: id(31), status: 'withdrawn', alt_text: 'Old ECG' }, { asset_id: id(32), status: 'approved' }];
const approvalWords = /approv|await|administrator/i;

test('[AS-173] each missing or taken-down image is named by slide, text alternative and reason; a live image is never refused', () => {
  // The first image is live the moment it is uploaded (status quarantined is only a storage state): no issue for it.
  const issues = namedImageIssues(document, rows);
  assert.deepEqual(issues, [
    { code: 'asset_not_approved', at: '/blocks/2', message: 'Image “Old ECG” was taken down: replace it.', slide: 'An untitled slide' },
    { code: 'asset_not_approved', at: '/blocks/4', message: 'Image “Unplaced ECG” is not in this case’s images: replace it.', slide: 'Content no slide shows' },
  ]);
  assert.ok(issues.every(issue => !approvalWords.test(issue.message)), 'no approval wording');
  // A consequence slide is named by its consequence.
  const rejected = namedImageIssues(document, [...rows.slice(0, 2), { asset_id: id(32), status: 'rejected' }, { asset_id: id(33), status: 'approved' }]);
  assert.deepEqual(rejected.at(-1), { code: 'asset_not_approved', at: '/blocks/3', message: 'Image “Post-decompression film” was taken down: replace it.', slide: 'Slide “Needle decompression”' });
});

test('[AS-173] card 62 PUBLISH-01: the Worker’s one sentence is replaced only when the images can be named', async () => {
  const refused = { revision: 7, ready: false, issues: [{ code: 'asset_not_approved', message: 'An image is missing, belongs to another workspace, or was taken down.' }, { code: 'builder_storage_quota', message: 'Quota' }] };
  let listed = 0;
  const named = await withImageNames(refused, document, async () => { listed++; return rows; }, { withSlide: true });
  assert.equal(listed, 1);
  assert.deepEqual(named.issues.map(issue => issue.message), ['Quota', 'An untitled slide: Image “Old ECG” was taken down: replace it.',
    'Content no slide shows: Image “Unplaced ECG” is not in this case’s images: replace it.']);
  assert.equal((await withImageNames(refused, document, async () => rows)).issues[1].message, 'Image “Old ECG” was taken down: replace it.');
  // Nothing refused: the list is never read. A failed list keeps the Worker's sentence.
  const ready = { revision: 7, ready: true, issues: [] };
  assert.equal(await withImageNames(ready, document, async () => { throw Error('not called'); }), ready);
  assert.equal(await withImageNames(refused, document, async () => { throw Error('offline'); }), refused);
  assert.equal(await withImageNames(refused, { blocks: [] }, async () => rows), refused);
});
