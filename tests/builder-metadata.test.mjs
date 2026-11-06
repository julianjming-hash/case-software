import { test } from 'node:test';
import assert from 'node:assert/strict';
import { builderSourceSha256, validateBuilderMetadata } from '../src/shared/builder-metadata.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';

test('empty metadata and a complete source trace validate within the private cap', () => {
  assert.equal(validateBuilderMetadata({ metadata_version: 1 }).ok, true);
  const sourceId = uuidv7(), entityId = uuidv7(), text = 'line one\nline two';
  const metadata = {
    metadata_version: 1,
    preparation_requirements: 'Discuss the source privately.',
    sources: [{ id: sourceId, title: 'Source', text, sha256: '0'.repeat(64), rights_status: 'unknown' }],
    provenance: [{ entity_id: entityId, field: 'surfaces.scene', source_id: sourceId, start_line: 1, end_line: 2,
      transformation: 'adapted', visibility: 'public', review_status: 'unreviewed' }],
  };
  const result = validateBuilderMetadata(metadata);
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some(issue => issue.code === 'rights_unresolved'));
});

test('unknown keys, malformed IDs, oversized values and unsafe text refuse atomically', () => {
  const base = { metadata_version: 1 };
  for (const metadata of [
    { ...base, extra: 'x' },
    { ...base, sources: [{ id: 'bad', title: 'x', text: '', sha256: '0'.repeat(64), rights_status: 'unknown' }] },
    { ...base, preparation_requirements: '\u202eunsafe' },
    { ...base, preparation_requirements: 'x'.repeat(100), },
  ]) {
    const options = metadata.preparation_requirements?.length === 100 ? { maxBytes: 32 } : {};
    assert.equal(validateBuilderMetadata(metadata, options).ok, false);
  }
});

test('source span gaps remain visible as warnings and invalid schema shape refuses', () => {
  const sourceId = uuidv7();
  const metadata = {
    metadata_version: 1,
    sources: [{ id: sourceId, title: 'Source', text: 'one line', sha256: 'a'.repeat(64), rights_status: 'permitted' }],
    provenance: [{ entity_id: uuidv7(), field: 'surfaces.scene', source_id: sourceId, start_line: 1, end_line: 2,
      transformation: 'verbatim', visibility: 'public', review_status: 'confirmed' }],
  };
  assert.ok(validateBuilderMetadata(metadata).warnings.some(issue => issue.code === 'source_range'));
  metadata.sources[0].unknown = true;
  assert.equal(validateBuilderMetadata(metadata).ok, false);
});

test('line spans without a source remain preservable but carry a release-blocking warning', () => {
  const metadata = { metadata_version: 1, provenance: [{ entity_id: uuidv7(), field: 'surfaces.scene', start_line: 1, end_line: 1,
    transformation: 'editorial', visibility: 'private', review_status: 'confirmed' }] };
  const result = validateBuilderMetadata(metadata);
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some(issue => issue.code === 'source_range_missing'));
});

test('source hash helper recomputes SHA-256 from UTF-8 text', async () => {
  assert.equal(await builderSourceSha256('hello'), '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
});
