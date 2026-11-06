import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { miniCase } from './helpers/mini-case.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
import {
  createBuilderTransferExport, createBuilderCopyCandidate, inspectBuilderTransfer,
  parseBuilderTransfer, verifyBuilderSourceHashes,
} from '../src/shared/builder-transfer.mjs';
import { convertSchema1ToBuilderDocument, validateBuilderDocument } from '../src/shared/builder-document.mjs';

const digest = 'a'.repeat(64);

test('default export excludes private cues and metadata; revise reconstructs omissions from the exact bound base', async () => {
  const { doc } = miniCase();
  doc.beats[0].cue = 'facilitator-only sentinel';
  doc.decisions[0].paths[0].rationale = 'private rationale sentinel';
  const metadata = { metadata_version: 1, preparation_requirements: 'prep sentinel' };
  const input = structuredClone(doc), metadataInput = structuredClone(metadata);
  const exported = await createBuilderTransferExport({ document: doc, metadata, intent: 'revise', base: { revision: 3, intentDigest: `\\x${digest}` } });
  assert.equal(exported.ok, true);
  assert.equal(JSON.stringify(exported.envelope).includes('sentinel'), false);
  assert.ok(exported.preview.excluded.includes('/beats/0/cue'));
  assert.equal(exported.preview.requiresExplicitRedactionReview, false);
  const inspected = await inspectBuilderTransfer(exported.envelope, {
    current: { document: doc, authoringMetadata: metadata, revision: 3, intentDigest: `\\x${digest}` },
  });
  assert.equal(inspected.ok, true);
  assert.equal(inspected.candidate.document.beats[0].cue, doc.beats[0].cue);
  assert.equal(inspected.candidate.document.decisions[0].paths[0].rationale, doc.decisions[0].paths[0].rationale);
  assert.deepEqual(inspected.candidate.authoring_metadata, metadata);
  assert.deepEqual(doc, input);
  assert.deepEqual(metadata, metadataInput);
});

test('stale exact base, undeclared writes, malformed keys and duplicate decoded keys refuse atomically', async () => {
  const { doc } = miniCase();
  const exported = await createBuilderTransferExport({ document: doc, intent: 'revise', base: { revision: 5, intent_digest: digest } });
  assert.equal(exported.ok, true);
  const stale = await inspectBuilderTransfer(exported.envelope, { current: { document: doc, revision: 6, intentDigest: digest } });
  assert.equal(stale.errors[0].code, 'stale_base');
  const tampered = structuredClone(exported.envelope);
  tampered.operations.push({ kind: 'set', path: '/owner', value: 'forged' });
  tampered.scope.push('/owner');
  assert.ok((await inspectBuilderTransfer(tampered, { current: { document: doc, revision: 5, intentDigest: digest } })).errors.length);
  const dup = parseBuilderTransfer('{"format":"case-builder-transfer","\\u0066ormat":"case-builder-transfer"}');
  assert.equal(dup.errors[0].code, 'duplicate_key');
  const unknown = parseBuilderTransfer(JSON.stringify({ ...exported.envelope, approval: true }));
  assert.ok(unknown.errors.some(issue => issue.code === 'unknown_key'));
});

test('source text stays excluded by default; opt-in validates UTF-8 digest and refuses restricted or unacknowledged rights', async () => {
  const { doc } = miniCase();
  const text = 'source record\nline two';
  const metadata = { metadata_version: 1, sources: [{ id: uuidv7(), title: 'Teaching source', text,
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'), rights_status: 'unknown' }] };
  const ordinary = await createBuilderTransferExport({ document: doc, metadata });
  assert.equal(ordinary.ok, true);
  assert.equal(JSON.stringify(ordinary.envelope).includes(text), false);
  const unacknowledged = await createBuilderTransferExport({ document: doc, metadata, includeSources: true, sourceIds: [metadata.sources[0].id] });
  assert.equal(unacknowledged.errors[0].code, 'unknown_rights');
  const selected = await createBuilderTransferExport({ document: doc, metadata, includeSources: true, sourceIds: [metadata.sources[0].id], acknowledgeUnknownRights: true });
  assert.equal(selected.ok, true);
  assert.equal(selected.envelope.operations.at(-1).value.sources[0].text, text);
  const inspected = await inspectBuilderTransfer(selected.envelope, { intent: 'copy' });
  assert.equal(inspected.readyToAccept, false);
  assert.ok(inspected.acknowledgementCodes.includes('rights_unresolved'));
  const bad = structuredClone(metadata); bad.sources[0].sha256 = '0'.repeat(64);
  assert.equal((await verifyBuilderSourceHashes(bad)).errors[0].code, 'source_hash');
  bad.sources[0].rights_status = 'restricted';
  assert.equal((await createBuilderTransferExport({ document: doc, metadata: bad, includeSources: true, sourceIds: [bad.sources[0].id], acknowledgeUnknownRights: true })).errors[0].code, 'restricted_source');
});

test('private fields need their own explicit scope even inside a selected parent array', async () => {
  const { doc } = miniCase();
  doc.beats[0].cue = 'private cue';
  const exported = await createBuilderTransferExport({ document: doc, includePrivate: true });
  assert.equal(exported.ok, true);
  assert.ok(exported.envelope.private_fields.includes(`/beats/0/cue`));
  assert.equal(parseBuilderTransfer(JSON.stringify(exported.envelope)).ok, true);
  const forged = structuredClone(exported.envelope);
  forged.private_fields = [];
  const result = await inspectBuilderTransfer(forged, { intent: 'copy' });
  assert.equal(result.ok, false);
  assert.ok(result.errors?.some(issue => issue.code === 'private_scope'));
  assert.equal(JSON.stringify(result.errors).includes('private cue'), false);
});

test('set null and remove are distinct operations and revision binding preserves all untouched fields', async () => {
  const { doc } = miniCase();
  const make = (kind, extra) => ({
    format: 'case-builder-transfer', transfer_version: 1, intent: 'revise',
    base: { revision: 2, intent_digest: digest }, scope: ['/summary'], excluded_fields: [], private_fields: [],
    operations: [{ kind, path: '/summary', ...(kind === 'set' ? { value: extra } : {}) }],
  });
  const current = { document: doc, revision: 2, intentDigest: digest };
  const setNull = await inspectBuilderTransfer(make('set', null), { current });
  const remove = await inspectBuilderTransfer(make('remove'), { current });
  assert.equal(setNull.candidate.document.summary, null);
  assert.equal(Object.hasOwn(remove.candidate.document, 'summary'), false);
  assert.equal(doc.summary, 'A minimal case for tests.');
});

test('default export preserves recovery prompt from exact base, while copy previews it as private loss', async () => {
  const { doc } = miniCase();
  const converted = convertSchema1ToBuilderDocument(doc);
  assert.equal(converted.ok, true);
  const v2 = converted.candidate;
  v2.decisions[0].paths[0].recovery = { prompt: 'Facilitator-only confirm reversal' };
  const exported = await createBuilderTransferExport({ document: v2, intent: 'revise', base: { revision: 4, intent_digest: digest } });
  assert.equal(exported.ok, true);
  assert.equal(JSON.stringify(exported.envelope).includes('Facilitator-only'), false);
  assert.ok(exported.preview.excluded.includes('/decisions/0/paths/0/recovery/prompt'));
  const inspected = await inspectBuilderTransfer(exported.envelope, { current: { document: v2, revision: 4, intentDigest: `\\x${digest}` } });
  assert.equal(inspected.ok, true);
  assert.equal(inspected.candidate.document.decisions[0].paths[0].recovery.prompt, 'Facilitator-only confirm reversal');
  const copy = await createBuilderTransferExport({ document: v2, intent: 'copy' });
  const copyProposal = await inspectBuilderTransfer(copy.envelope, { intent: 'copy' });
  assert.equal(copyProposal.candidate.document.decisions[0].paths[0].recovery.prompt, undefined);
  assert.equal(copyProposal.requiresExplicitRedactionReview, true);
  assert.equal(copyProposal.readyToAccept, false);
});

test('schema-2 formatted paragraph/list values round-trip without flattening', async () => {
  const { doc } = miniCase();
  const converted = convertSchema1ToBuilderDocument(doc);
  assert.equal(converted.ok, true);
  const v2 = converted.candidate;
  v2.required_capabilities.push('formatted_text');
  v2.surfaces[0].scene = { blocks: [
    { type: 'paragraph', runs: [{ text: 'Scene sentence.', bold: true }] },
    { type: 'list', ordered: false, items: [{ runs: [{ text: 'Finding one.' }] }, { runs: [{ text: 'Finding two.' }] }] },
  ] };
  const out = await createBuilderTransferExport({ document: v2 });
  assert.equal(out.ok, true);
  const proposal = await inspectBuilderTransfer(out.envelope, { intent: 'copy' });
  assert.equal(proposal.ok, true);
  assert.deepEqual(proposal.candidate.document.surfaces[0].scene, v2.surfaces[0].scene);
});

test('preserve mode retains incomplete capability data but does not call it ready to accept', async () => {
  const { doc } = miniCase();
  const converted = convertSchema1ToBuilderDocument(doc);
  const incomplete = converted.candidate;
  incomplete.surfaces[0].scene = { blocks: [{ type: 'paragraph', runs: [{ text: 'Formatted but undeclared.' }] }] };
  const exported = await createBuilderTransferExport({ document: incomplete });
  assert.equal(exported.ok, true);
  const proposal = await inspectBuilderTransfer(exported.envelope, { intent: 'copy' });
  assert.equal(proposal.ok, true);
  assert.ok(proposal.warnings.some(issue => issue.code === 'missing_capability'));
  assert.ok(proposal.readinessErrors.some(issue => issue.code === 'missing_capability'));
  assert.equal(proposal.canAcceptPreservedCandidate, false);
  assert.equal(proposal.readyToAccept, false);
});

test('array replacement preserves omissions only by stable ID and rejects index-removal paths', async () => {
  const { doc } = miniCase();
  doc.surfaces[0].notes = 'first secret';
  doc.surfaces[1].notes = 'second secret';
  const changed = structuredClone(doc);
  changed.surfaces[0].id = uuidv7();
  delete changed.surfaces[0].notes;
  delete changed.surfaces[1].notes;
  const envelope = {
    format: 'case-builder-transfer', transfer_version: 1, intent: 'revise',
    base: { revision: 7, intent_digest: digest }, scope: ['/surfaces'], excluded_fields: [], private_fields: [],
    operations: [{ kind: 'set', path: '/surfaces', value: changed.surfaces }],
  };
  const proposal = await inspectBuilderTransfer(envelope, { current: { document: doc, revision: 7, intentDigest: digest } });
  assert.equal(proposal.candidate.document.surfaces[0].notes, undefined, 'new identity must not inherit private content by array position');
  assert.equal(proposal.candidate.document.surfaces[1].notes, 'second secret', 'unchanged identity keeps omitted content');
  const shifted = structuredClone(envelope);
  shifted.scope = ['/surfaces/0'];
  shifted.operations = [{ kind: 'remove', path: '/surfaces/0' }];
  assert.ok(parseBuilderTransfer(JSON.stringify(shifted)).errors.some(issue => issue.code === 'field_path'));
});

test('all four interaction representations and their UUID references survive transfer and copy mapping', async () => {
  for (const type of ['single_choice', 'multi_select', 'ranking', 'free_text']) {
    const { doc, p, o } = miniCase();
    const decision = doc.decisions[0];
    if (type === 'multi_select') {
      decision.interaction.type = type;
      for (const path of decision.paths) delete path.option_ids;
      decision.rules = [{ when: { includes_any: [o.decompress] }, path_id: p.decompress }];
    } else if (type === 'ranking') {
      decision.interaction.type = type; decision.interaction.rank_count = 2;
      for (const path of decision.paths) delete path.option_ids;
      decision.rules = [{ when: { before: [o.decompress, o.image] }, path_id: p.decompress }];
    } else if (type === 'free_text') {
      decision.interaction = { type, max_length: 100 };
      for (const path of decision.paths) delete path.option_ids;
      decision.rules = [{ when: { keywords: ['decompress'] }, path_id: p.decompress }];
    }
    const out = await createBuilderTransferExport({ document: doc });
    assert.equal(out.ok, true, `${type} export`);
    const proposal = await inspectBuilderTransfer(out.envelope, { intent: 'copy' });
    assert.equal(proposal.ok, true, `${type} import`);
    assert.deepEqual(proposal.candidate.document.decisions[0].interaction, decision.interaction);
    const copy = await createBuilderCopyCandidate(proposal.candidate);
    assert.equal(copy.ok, true, `${type} copy`);
    assert.equal(copy.candidate.document.decisions[0].interaction.type, type);
    if (type === 'single_choice') assert.equal(copy.candidate.document.decisions[0].paths[0].option_ids[0], copy.mapping[o.decompress]);
    if (type === 'multi_select') assert.equal(copy.candidate.document.decisions[0].rules[0].when.includes_any[0], copy.mapping[o.decompress]);
    if (type === 'ranking') assert.equal(copy.candidate.document.decisions[0].rules[0].when.before[1], copy.mapping[o.image]);
    // A rule names its path by id, so a copy must remap it with the paths, or the copy fails its own validation.
    if (type !== 'single_choice') {
      assert.equal(copy.candidate.document.decisions[0].rules[0].path_id, copy.mapping[p.decompress], `${type} rule path`);
      // The default export strips private cues, so only reference errors matter here.
      const refs = validateBuilderDocument(copy.candidate.document, copy.candidate.authoring_metadata, { mode: 'ready' }).errors.filter(e => e.code === 'ref');
      assert.deepEqual(refs, [], `${type} copy keeps every reference`);
    }
  }
});

test('transfer bounds, duplicate raw keys and unknown identities fail closed without echoing private text', () => {
  assert.equal(parseBuilderTransfer(new Uint8Array([0xff])).errors[0].code, 'invalid_utf8');
  const nestedDuplicate = parseBuilderTransfer('{"outer":{"title":1,"\\u0074itle":2}}');
  assert.equal(nestedDuplicate.errors[0].code, 'duplicate_key');
  const tooDeep = parseBuilderTransfer('['.repeat(40) + '0' + ']'.repeat(40));
  assert.equal(tooDeep.errors[0].code, 'too_deep');
  const tooMany = parseBuilderTransfer('{"x":[' + Array(100_001).fill('0').join(',') + ']}');
  assert.equal(tooMany.errors[0].code, 'too_many_nodes');
  assert.equal(JSON.stringify(tooMany.errors).includes('patient or secret'), false);
});

test('changed source-bound fields stale only matching provenance and never promote approval claims', async () => {
  const { doc } = miniCase();
  const surface = doc.surfaces[0];
  const metadata = { metadata_version: 1, provenance: [
    { entity_id: surface.id, field: `surfaces[${surface.id}].points`, transformation: 'editorial', visibility: 'public', review_status: 'confirmed' },
    { entity_id: surface.id, field: `surfaces[${surface.id}].title`, transformation: 'editorial', visibility: 'public', review_status: 'confirmed' },
  ] };
  const envelope = {
    format: 'case-builder-transfer', transfer_version: 1, intent: 'revise',
    base: { revision: 8, intent_digest: digest }, scope: [`/surfaces/0/points`], excluded_fields: [], private_fields: [],
    operations: [{ kind: 'set', path: '/surfaces/0/points', value: ['Changed point.'] }],
  };
  const result = await inspectBuilderTransfer(envelope, { current: { document: doc, authoringMetadata: metadata, revision: 8, intentDigest: digest } });
  assert.equal(result.candidate.authoring_metadata.provenance[0].review_status, 'stale');
  assert.equal(result.candidate.authoring_metadata.provenance[1].review_status, 'confirmed');
  assert.deepEqual(result.staleProvenance, [{ entity_id: surface.id, field: `surfaces[${surface.id}].points` }]);
  assert.ok(result.diff.some(item => item.path.endsWith('/points') && item.before[0] === doc.surfaces[0].points[0] && item.after[0] === 'Changed point.'));
  assert.equal(metadata.provenance[0].review_status, 'confirmed', 'base metadata must remain unchanged');
  const forged = { ...envelope, approval: { status: 'approved' } };
  assert.ok((await inspectBuilderTransfer(forged, { current: { document: doc, authoringMetadata: metadata, revision: 8, intentDigest: digest } })).errors.length);
});

test('provenance stale detection resolves relative, collection-prefixed, identity-prefixed and child paths', async () => {
  const { doc } = miniCase();
  const surface = doc.surfaces[0];
  const metadata = { metadata_version: 1, provenance: [
    { entity_id: surface.id, field: 'points', transformation: 'editorial', visibility: 'public', review_status: 'confirmed' },
    { entity_id: surface.id, field: 'points[0]', transformation: 'adapted', visibility: 'public', review_status: 'confirmed' },
    { entity_id: surface.id, field: 'surfaces.points', transformation: 'verbatim', visibility: 'public', review_status: 'confirmed' },
    { entity_id: surface.id, field: `surfaces[${surface.id}].points`, transformation: 'editorial', visibility: 'public', review_status: 'confirmed' },
    { entity_id: surface.id, field: 'title', transformation: 'verbatim', visibility: 'public', review_status: 'confirmed' },
  ] };
  // Metadata is sent explicitly for this test; default export must not include private authoring metadata.
  const plain = await createBuilderTransferExport({ document: doc, intent: 'revise', base: { revision: 8, intentDigest: digest } });
  const envelope = structuredClone(plain.envelope);
  envelope.scope.push('/authoring_metadata');
  envelope.operations.push({ kind: 'set', path: '/authoring_metadata', value: metadata });
  envelope.operations.find(operation => operation.path === '/surfaces').value[0].points[0] = 'Changed point.';
  const result = await inspectBuilderTransfer(envelope, { current: { document: doc, authoringMetadata: { metadata_version: 1 }, revision: 8, intentDigest: digest } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.staleProvenance.map(item => item.field), ['points', 'points[0]', 'surfaces.points', `surfaces[${surface.id}].points`]);
  assert.equal(result.candidate.authoring_metadata.provenance[4].review_status, 'confirmed');
  assert.equal(result.candidate.authoring_metadata.provenance[0].review_status, 'stale');
});

test('provenance resolver rejects malformed dotted paths instead of normalizing empty segments', async () => {
  const { doc } = miniCase();
  const surface = doc.surfaces[0];
  const paths = ['points[0]', 'points..0', 'points.0', 'points[0]..title', 'points[0].'];
  const metadata = { metadata_version: 1, provenance: paths.map((field, index) => ({
    entity_id: surface.id, field, transformation: 'editorial', visibility: 'public', review_status: 'confirmed',
  })) };
  const exported = await createBuilderTransferExport({ document: doc, intent: 'revise', base: { revision: 8, intentDigest: digest } });
  const envelope = structuredClone(exported.envelope);
  envelope.scope.push('/authoring_metadata');
  envelope.operations.push({ kind: 'set', path: '/authoring_metadata', value: metadata });
  envelope.operations.find(operation => operation.path === '/surfaces').value[0].points[0] = 'Changed point.';
  const result = await inspectBuilderTransfer(envelope, { current: { document: doc, authoringMetadata: { metadata_version: 1 }, revision: 8, intentDigest: digest } });
  assert.equal(result.ok, true);
  assert.equal(result.candidate.authoring_metadata.provenance[0].review_status, 'stale');
  assert.deepEqual(result.candidate.authoring_metadata.provenance.slice(1).map(item => item.review_status), ['confirmed', 'confirmed', 'confirmed', 'confirmed']);
  assert.equal(result.staleProvenance.length, 1);
  assert.ok(result.warnings.filter(issue => issue.code === 'provenance_field_missing').length >= 4);
});

test('safe incomplete preserve-mode candidates can be accepted while strict rehearsal readiness stays false', async () => {
  const { doc } = miniCase();
  delete doc.duration_min;
  const exported = await createBuilderTransferExport({ document: doc, intent: 'copy' });
  assert.equal(exported.ok, true);
  const inspected = await inspectBuilderTransfer(exported.envelope, {
    intent: 'copy', mode: 'preserve', acknowledgeRedactions: true,
  });
  assert.equal(inspected.ok, true);
  assert.equal(inspected.canAcceptPreservedCandidate, true);
  assert.equal(inspected.readyToAccept, true, 'safe incomplete preservation can be adopted for repair');
  assert.equal(inspected.readyForRehearsal, false, 'incomplete candidate is not runnable/ready');
  assert.ok(inspected.readinessErrors.some(issue => issue.code === 'duration'));
});

test('unresolved provenance stays attached with explicit repair issues and blocks strict readiness', async () => {
  const { doc } = miniCase();
  const metadata = { metadata_version: 1, provenance: [{ entity_id: uuidv7(), field: 'surfaces[0199a000-0000-7000-8000-000000000001].scene',
    transformation: 'adapted', visibility: 'public', review_status: 'unreviewed' }] };
  const exported = await createBuilderTransferExport({ document: doc, metadata });
  assert.equal(exported.ok, true);
  const withMetadata = structuredClone(exported.envelope);
  withMetadata.scope.push('/authoring_metadata');
  withMetadata.operations.push({ kind: 'set', path: '/authoring_metadata', value: metadata });
  const preserve = await inspectBuilderTransfer(withMetadata, { intent: 'copy' });
  assert.equal(preserve.ok, true);
  assert.ok(preserve.warnings.some(issue => issue.code === 'provenance_entity_missing'));
  assert.equal(preserve.candidate.authoring_metadata.provenance.length, 1);
  const ready = await inspectBuilderTransfer(withMetadata, { intent: 'copy', mode: 'ready' });
  assert.equal(ready.ok, false);
  assert.ok(ready.errors.some(issue => issue.code === 'provenance_entity_missing'));
});

test('copy IDs are remapped as one stable UUIDv7 identity closure; external references refuse', async () => {
  const { doc } = miniCase();
  const surfaceId = doc.surfaces[0].id;
  const metadata = { metadata_version: 1, provenance: [{ entity_id: surfaceId, field: `surfaces[${surfaceId}].points`,
    transformation: 'editorial', visibility: 'public', review_status: 'confirmed' }] };
  const first = await createBuilderTransferExport({ document: doc });
  const withMetadata = structuredClone(first.envelope);
  withMetadata.scope.push('/authoring_metadata');
  withMetadata.operations.push({ kind: 'set', path: '/authoring_metadata', value: metadata });
  const inspected = await inspectBuilderTransfer(withMetadata, { intent: 'copy' });
  assert.equal(inspected.ok, true);
  const copied = await createBuilderCopyCandidate(inspected.candidate);
  assert.equal(copied.ok, true);
  assert.equal(new Set(Object.values(copied.mapping)).size, Object.keys(copied.mapping).length);
  assert.equal(copied.candidate.document.start_beat_id, copied.mapping[inspected.candidate.document.start_beat_id]);
  assert.equal(copied.candidate.document.beats[0].surface_id, copied.mapping[inspected.candidate.document.beats[0].surface_id]);
  assert.equal(copied.candidate.document.decisions[0].paths[2].terminal.checkpoint_beat_id,
    copied.mapping[inspected.candidate.document.decisions[0].paths[2].terminal.checkpoint_beat_id]);
  assert.equal(copied.candidate.authoring_metadata.provenance[0].entity_id, copied.mapping[surfaceId]);
  assert.equal(copied.candidate.authoring_metadata.provenance[0].field, `surfaces[${copied.mapping[surfaceId]}].points`);
  const retried = await createBuilderCopyCandidate(inspected.candidate, { identityMap: copied.mapping });
  assert.deepEqual(retried.candidate, copied.candidate);
  assert.ok(Object.values(copied.mapping).every(value => value[14] === '7'));
  const external = structuredClone(inspected.candidate);
  external.document.surfaces[0].asset_ids = [uuidv7()];
  assert.equal((await createBuilderCopyCandidate(external)).errors[0].code, 'external_reference');
});

test('whole array values are atomic, missing paths refuse, and the exact source stays unchanged on failure', async () => {
  const { doc } = miniCase();
  const before = structuredClone(doc);
  const envelope = {
    format: 'case-builder-transfer', transfer_version: 1, intent: 'revise',
    base: { revision: 1, intent_digest: digest }, scope: ['/surfaces/0'], excluded_fields: [], private_fields: [],
    operations: [{ kind: 'set', path: '/surfaces/0', value: { fabricated: true } }],
  };
  const result = await inspectBuilderTransfer(envelope, { current: { document: doc, revision: 1, intentDigest: digest } });
  assert.equal(result.ok, false);
  assert.deepEqual(doc, before);
});

test('[AS-156] transfer version 2 carries a slide draft; a new copy remaps every block, step and placement identity', async () => {
  const { convertSchema1ToBuilderDocument } = await import('../src/shared/builder-document.mjs');
  const { convertToSlideDocument } = await import('../src/shared/slide-legacy.mjs');
  const transfer = await import('../src/shared/builder-transfer.mjs');
  const { uuidv7 } = await import('../src/shared/ids.mjs');
  const fixture = (await import('../src/fixtures/synthetic-workshop.case.json', { with: { type: 'json' } })).default;
  const source = convertSchema1ToBuilderDocument(structuredClone(fixture), { metadata_version: 1 }).candidate;
  for (const surface of source.surfaces) delete surface.variants;
  const slides = convertToSlideDocument(source, { metadata_version: 1 }, { createId: uuidv7 }).candidate.document;
  const exported = await transfer.createBuilderTransferExport({ document: slides, intent: 'copy' });
  assert.equal(exported.ok, true, JSON.stringify(exported.errors));
  assert.equal(exported.envelope.transfer_version, 2);
  assert.ok(exported.envelope.scope.includes('/blocks') && exported.envelope.scope.includes('/compositions'));
  const parsed = transfer.parseBuilderTransfer(JSON.stringify(exported.envelope));
  assert.equal(parsed.ok, true, JSON.stringify(parsed.errors));
  const inspected = await transfer.inspectBuilderTransfer(parsed.envelope, {});
  assert.equal(inspected.ok, true, JSON.stringify(inspected.errors));
  const copy = await transfer.createBuilderCopyCandidate(inspected.candidate);
  assert.equal(copy.ok, true, JSON.stringify(copy.errors));
  const blocks = new Set(copy.candidate.document.blocks.map(block => block.id));
  assert.ok(slides.blocks.every(block => !blocks.has(block.id)), 'every block has a fresh identity');
  for (const composition of copy.candidate.document.compositions) {
    assert.ok(composition.reading_order.every(id => blocks.has(id)));
    assert.ok(composition.placements.every(item => blocks.has(item.block_id)));
    assert.ok(composition.steps.every(step => step.block_ids.every(id => blocks.has(id))));
  }
  // A version-1 file that carries slide content is refused rather than half-read.
  const forged = { ...exported.envelope, transfer_version: 1 };
  assert.equal(transfer.parseBuilderTransfer(JSON.stringify(forged)).ok, false);
});
