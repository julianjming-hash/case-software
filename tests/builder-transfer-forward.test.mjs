// CASE-344 B3, [AS-221]: a transfer file is read strictly. One from a newer Case is refused by name, one from an older Case
// imports and round-trips, and a field this Case does not know is never kept silently. Pure functions only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createBuilderTransferExport, parseBuilderTransfer, inspectBuilderTransfer, createBuilderCopyCandidate, summariseBuilderPair, BUILDER_SLIDE_TRANSFER_VERSION } from '../src/shared/builder-transfer.mjs';
import { everythingPair } from './helpers/builder-everything-fixture.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const exportOf = async (pair, options = {}) => {
  const exported = await createBuilderTransferExport({ document: pair.document, metadata: pair.authoringMetadata, intent: 'copy', includePrivate: true, includePreparationRequirements: false, ...options });
  assert.equal(exported.ok, true, JSON.stringify(exported.errors));
  return exported.envelope;
};
const operation = (envelope, path) => envelope.operations.find(item => item.path === path);

test('[AS-221] a file from a newer Case is refused by name, not as a validation failure', async () => {
  const pair = everythingPair(), envelope = await exportOf(pair);
  const newer = structuredClone(envelope);
  operation(newer, '/required_capabilities').value.push('callout_icon_v2', 'live_polls');
  const parsed = parseBuilderTransfer(JSON.stringify(newer));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.errors.length, 1, 'a newer capability must not manufacture private-scope errors in valid operations');
  assert.equal(parsed.errors[0].code, 'newer_case');
  assert.equal(parsed.errors[0].message, 'made by a newer Case: needs `callout_icon_v2`, `live_polls`');
  // Inspecting the object directly refuses the same way and never builds a candidate.
  const inspected = await inspectBuilderTransfer(newer, {});
  assert.equal(inspected.ok, false);
  assert.equal(inspected.errors[0].code, 'newer_case');
  assert.equal(inspected.candidate ?? null, null);
  // A newer transfer format is the same refusal.
  const format = parseBuilderTransfer(JSON.stringify({ ...envelope, transfer_version: BUILDER_SLIDE_TRANSFER_VERSION + 1 }));
  assert.equal(format.ok, false);
  assert.equal(format.errors.length, 1, 'a newer format must not manufacture private-scope errors');
  assert.match(format.errors[0].message, /^made by a newer Case: transfer format 3/);
  // A capability this Case knows (callout_icon) is not "newer".
  assert.ok(operation(envelope, '/required_capabilities').value.includes('callout_icon'));
  assert.equal(parseBuilderTransfer(JSON.stringify(envelope)).ok, true);
});

test('[AS-221] unknown fields are not silently kept: the file is refused, whatever the level', async () => {
  const pair = everythingPair(), envelope = await exportOf(pair);
  // An unknown top-level field of the document.
  const field = structuredClone(envelope);
  field.operations.push({ kind: 'set', path: '/future_field', value: 1 }); field.scope.push('/future_field');
  assert.equal(parseBuilderTransfer(JSON.stringify(field)).ok, false);
  // An unknown key inside a block.
  const block = structuredClone(envelope);
  operation(block, '/blocks').value[0].future_key = true;
  const refused = await inspectBuilderTransfer(block, {});
  assert.equal(refused.ok, false);
  assert.equal(refused.canAcceptPreservedCandidate, false, 'the candidate shown for review cannot be accepted');
  assert.equal(refused.readyToAccept, false);
  // An unknown key of the envelope itself.
  assert.equal(parseBuilderTransfer(JSON.stringify({ ...envelope, future_scope: [] })).ok, false);
  // And an unknown callout icon (a newer icon set) is a validation failure on the field, not dropped.
  const icon = structuredClone(envelope);
  operation(icon, '/blocks').value.find(item => item.type === 'callout').icon = 'future-icon';
  assert.equal((await inspectBuilderTransfer(icon, {})).ok, false);
});

test('[AS-221] an older file imports and round-trips: v1 transfer of a schema-2 case, and a slide case from before callout icons', async () => {
  // The shipped v1 file (transfer version 1, schema 2).
  const text = readFileSync(join(ROOT, 'tests/fixtures/synthetic/builder-diving-polished-transfer.json'), 'utf8');
  const parsed = parseBuilderTransfer(text);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.errors));
  assert.equal(parsed.envelope.transfer_version, 1);
  const first = await inspectBuilderTransfer(parsed.envelope, {});
  assert.equal(first.ok, true, JSON.stringify(first.errors));
  const again = await exportOf({ document: first.candidate.document, authoringMetadata: { metadata_version: 1 } }, { includePrivate: Boolean(parsed.envelope.private_fields.length) });
  assert.equal(again.transfer_version, 1, 'a schema-2 case is written in the format it was read in');
  const second = await inspectBuilderTransfer(again, {});
  assert.equal(second.ok, true, JSON.stringify(second.errors));
  // The file's own authoring notes travel only when asked for; the draft itself comes back exactly.
  assert.deepEqual(second.candidate.document, first.candidate.document);
  assert.deepEqual(summariseBuilderPair({ document: second.candidate.document }), summariseBuilderPair({ document: first.candidate.document }));

  // A slide case written before callout icons: no icon, no `callout_icon` capability.
  const old = everythingPair();
  for (const block of old.document.blocks) if (block.type === 'callout') delete block.icon;
  old.document.required_capabilities = old.document.required_capabilities.filter(name => name !== 'callout_icon');
  const file = JSON.stringify(await exportOf(old));
  const read = await inspectBuilderTransfer(parseBuilderTransfer(file).envelope, {});
  assert.equal(read.ok, true, JSON.stringify(read.errors));
  assert.deepEqual(read.candidate.document, old.document, 'importing the file gives back exactly the draft that made it');
  const written = await exportOf({ document: read.candidate.document, authoringMetadata: read.candidate.authoring_metadata });
  // The same file, bar the order the private paths are listed in (it follows the document's key order, which import sorts).
  const sorted = envelope => ({ ...envelope, private_fields: [...envelope.private_fields].sort() });
  assert.deepEqual(sorted(written), sorted(JSON.parse(file)), 'exporting what was imported gives back the same file');
  // And as a new case it keeps every field, with new identities.
  const copy = await createBuilderCopyCandidate(read.candidate);
  assert.equal(copy.ok, true, JSON.stringify(copy.errors));
  assert.equal(copy.candidate.document.blocks.length, old.document.blocks.length);
});

test('[AS-221] the import preview summarises a draft in the words an author uses', () => {
  const pair = everythingPair(), summary = summariseBuilderPair(pair);
  assert.equal(summary.title, pair.document.title);
  assert.equal(summary.stages, pair.document.beats.length);
  assert.equal(summary.questions, 4);
  assert.equal(summary.slides, pair.document.compositions.length);
  assert.equal(summary.blocks, pair.document.blocks.length);
  assert.deepEqual(summariseBuilderPair(null), { title: '', schema: null, stages: 0, questions: 0, slides: 0, blocks: 0, flags: 0, sources: 0 });
});
