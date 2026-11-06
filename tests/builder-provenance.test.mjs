import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBuilderProvenancePaths } from '../src/shared/builder-provenance.mjs';

const surfaceId = '0199a000-0000-7000-8000-00000000c650';
const document = { schema_version: 1, surfaces: [{ id: surfaceId, scene: 'Synthetic scene', notes: { blocks: [] } }] };
const entry = (entity_id, field) => ({ entity_id, field });

test('provenance entity and relative, collection-prefixed, and indexed paths resolve against exact snapshot', () => {
  const metadata = { provenance: [entry(surfaceId, 'scene'), entry(surfaceId, 'surfaces.scene'), entry(surfaceId, `surfaces[${surfaceId}].scene`)] };
  assert.deepEqual(validateBuilderProvenancePaths(document, metadata), []);
});

test('provenance refuses an absent entity or a field absent from the exact snapshot', () => {
  const missingId = '0199a000-0000-7000-8000-00000000c651';
  const issues = validateBuilderProvenancePaths(document, { provenance: [entry(missingId, 'scene'), entry(surfaceId, 'not_authored')] });
  assert.deepEqual(issues.map(issue => issue.code), ['provenance_entity_missing', 'provenance_field_missing']);
});

test('provenance rejects noncanonical paths and source ranges without a source identity', () => {
  const exactDocument = { surfaces: [{ id: surfaceId, scene: 'text' }] };
  const noSourceRange = { metadata_version: 1, provenance: [{ entity_id: surfaceId, field: 'surfaces.scene', start_line: 1, end_line: 1, transformation: 'editorial' }] };
  const repeatedDot = { metadata_version: 1, provenance: [{ entity_id: surfaceId, field: 'surfaces..scene', transformation: 'editorial' }] };
  assert.ok(validateBuilderProvenancePaths(exactDocument, noSourceRange).some(item => item.code === 'source_range_missing'));
  assert.ok(validateBuilderProvenancePaths(exactDocument, repeatedDot).some(item => item.code === 'provenance_field_missing'));
});
