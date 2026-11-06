import test from 'node:test';
import assert from 'node:assert/strict';
import { builderPublicationIssues } from '../src/shared/builder-publication.mjs';

test('confirmed orphan traces still block publication, alongside unresolved source rights', () => {
  const issues = builderPublicationIssues({ surfaces: [] }, { sources: [{ rights_status: 'unknown' }], provenance: [{ entity_id: '0199a000-0000-7000-8000-00000000c650', field: 'scene', review_status: 'confirmed' }] }, { errors: [], warnings: [] });
  assert.deepEqual(issues.map(issue => issue.code), ['provenance_entity_missing', 'rights_unresolved']);
  assert.equal(issues[0].at, '/authoring_metadata/provenance/0/entity_id');
});

test('publication includes all validation blockers and leaves ordinary advice nonblocking', () => {
  const issues = builderPublicationIssues({}, {}, { errors: [{ code: 'required', at: '/title' }], warnings: [{ code: 'provenance_stale', at: '/provenance/0' }, { code: 'branching_complexity', at: '/decisions' }] });
  assert.deepEqual(issues.map(issue => issue.code), ['required', 'provenance_stale']);
});
