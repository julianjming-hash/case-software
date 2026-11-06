import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { prepareBuilderPreviewSnapshot } from '../src/client/builder-preview-snapshot.mjs';

// The Run preview (CASE-226) admits a Builder draft only through this strict readiness check; the surface itself is
// proved in tests/builder-inspection.test.mjs, tests/preview-room.test.mjs and e2e/run-preview.spec.mjs.
const fixture = JSON.parse(await readFile(new URL('../src/fixtures/synthetic-workshop.case.json', import.meta.url), 'utf8'));
const metadata = { metadata_version: 1, preparation_requirements: 'PRIVATE_SOURCE_SENTINEL' };

test('strict readiness rejects incomplete snapshots without repairing or mutating the source pair', async () => {
  const document = structuredClone(fixture), privateMetadata = structuredClone(metadata);
  document.duration_min = 17;
  const before = structuredClone(document), result = await prepareBuilderPreviewSnapshot(document, privateMetadata);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some(issue => issue.code === 'duration'));
  assert.deepEqual(document, before);
  assert.equal(privateMetadata.preparation_requirements, 'PRIVATE_SOURCE_SENTINEL');
});
