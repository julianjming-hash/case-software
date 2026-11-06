import { uuidv7, isUuid, isUuidV7 } from './ids.mjs';
import { parseBoundedJson } from './builder-json.mjs';
import { validateSlideParts } from './slide-document.mjs';
import { validateBuilderDocument, BUILDER_KNOWN_CAPABILITIES, BUILDER_ENVELOPE_MAX_BYTES, BUILDER_JSON_MAX_DEPTH, BUILDER_JSON_MAX_NODES, BUILDER_MAX_ISSUES } from './builder-document.mjs';
import { validateBuilderMetadata } from './builder-metadata.mjs';

export const BUILDER_TRANSFER_VERSION = 1;
// Transfer version 2 (CASE-221) carries slide drafts (schema 3: blocks and compositions); version-1 files import unchanged.
export const BUILDER_SLIDE_TRANSFER_VERSION = 2;
export const BUILDER_TRANSFER_MAX_BYTES = BUILDER_ENVELOPE_MAX_BYTES;
export const BUILDER_TRANSFER_MAX_OPERATIONS = 200;

// This is an envelope allowlist, not a second document validator. Values are always
// passed unchanged to C41's canonical preservation validator before a candidate returns.
const DOCUMENT_FIELDS = new Set([
  'schema_version', 'required_capabilities', 'title', 'summary', 'audience', 'setting',
  'duration_min', 'learning_objectives', 'flags', 'surfaces', 'beats', 'start_beat_id',
  'decisions', 'clarifications', 'blocks', 'compositions', 'theme',
]);
const SLIDE_FIELDS = new Set(['blocks', 'compositions', 'theme']);
const PRIVATE_KEYS = new Set(['notes', 'cue', 'rationale', 'debrief_prompt']);
const UUID_REFERENCE_KEYS = new Set([
  'id', 'start_beat_id', 'surface_id', 'decision_id', 'next_beat_id', 'fallback_path_id', 'path_id',
  'reveal_surface_id', 'checkpoint_beat_id',
  'entity_id', 'source_id', 'block_id',
]);
const UUID_ARRAY_REFERENCE_KEYS = new Set(['beat_ids', 'asset_ids', 'option_ids', 'includes_all', 'includes_any', 'excludes', 'top', 'before', 'block_ids', 'reading_order']);
const utf8 = new TextEncoder();

/** Parse the exact bounded JSON envelope used by Builder transfer. */
export function parseBuilderTransfer(text) {
  const parsed = parseBoundedJson(text, { maxBytes: BUILDER_TRANSFER_MAX_BYTES, maxDepth: BUILDER_JSON_MAX_DEPTH, maxNodes: BUILDER_JSON_MAX_NODES });
  if (!parsed.ok) return { ok: false, errors: [safeIssue(parsed.error?.code ?? 'not_json', parsed.error?.at ?? '', parsed.error?.message ?? 'invalid transfer')] };
  const errors = validateEnvelope(parsed.value);
  return errors.length ? { ok: false, errors: cap(errors), remainingIssues: Math.max(0, errors.length - BUILDER_MAX_ISSUES) }
    : { ok: true, envelope: parsed.value, bytes: parsed.bytes, nodes: parsed.nodes };
}

/** Build a preview and transfer bundle without mutating either input. */
export async function createBuilderTransferExport({
  document, metadata = { metadata_version: 1 }, intent = 'copy', base = null,
  includePrivate = false, includeSources = false, sourceIds = [], includeProvenance = false,
  includePreparationRequirements = false, includeLineage = false, acknowledgeUnknownRights = false,
} = {}) {
  let documentCopy, metadataCopy, baseCopy, selectedIds;
  try { documentCopy = cloneJson(document); metadataCopy = cloneJson(metadata); baseCopy = base === null ? null : cloneJson(base); selectedIds = cloneJson(sourceIds); }
  catch { return refusal('not_json', '', 'document and metadata must be finite JSON values'); }
  const checked = validatePair(documentCopy, metadataCopy);
  if (!checked.ok) return { ok: false, errors: checked.errors };
  if (!['copy', 'revise'].includes(intent)) return refusal('intent', '', 'intent must be copy or revise');
  const canonicalBase = intent === 'revise' ? normalizeBase(baseCopy) : null;
  if (intent === 'revise' && !canonicalBase) return refusal('base', '/base', 'revision exports require an exact revision and paired digest');

  const projected = documentCopy;
  const excluded = [];
  if (!includePrivate) stripPrivate(projected, '', excluded);
  const operations = Object.keys(projected).sort().map(key => ({ kind: 'set', path: `/${escapePointer(key)}`, value: projected[key] }));
  const scope = operations.map(operation => operation.path);
  let exportedMetadata;
  if (includeSources) {
    if (!Array.isArray(selectedIds) || selectedIds.length < 1 || selectedIds.length > 32 || new Set(selectedIds).size !== selectedIds.length || selectedIds.some(id => !isUuid(id)))
      return refusal('source_selection', '/authoring_metadata/sources', 'choose one or more exact source record IDs before including source text');
    const allSources = metadataCopy.sources ?? [];
    if (selectedIds.some(id => !allSources.some(source => source.id === id))) return refusal('source_selection', '/authoring_metadata/sources', 'a selected source record is not present in this draft');
    const selectedSources = allSources.filter(source => selectedIds.includes(source.id));
    if (selectedSources.some(source => source.rights_status === 'restricted')) return refusal('restricted_source', '/authoring_metadata/sources', 'restricted source text cannot be exported');
    if (selectedSources.some(source => source.rights_status === 'unknown') && !acknowledgeUnknownRights)
      return refusal('unknown_rights', '/authoring_metadata/sources', 'unknown source rights need an explicit export acknowledgement');
    const digestCheck = await verifySourceHashes({ metadata_version: 1, sources: selectedSources });
    if (!digestCheck.ok) return { ok: false, errors: digestCheck.errors };
    exportedMetadata = {
      metadata_version: 1,
      sources: cloneJson(selectedSources),
      ...(includeProvenance && metadataCopy.provenance ? { provenance: cloneJson(metadataCopy.provenance.filter(item => item.source_id === undefined || selectedIds.includes(item.source_id))) } : {}),
      ...(includePreparationRequirements && metadataCopy.preparation_requirements !== undefined ? { preparation_requirements: metadataCopy.preparation_requirements } : {}),
      ...(includeLineage && metadataCopy.lineage ? { lineage: cloneJson(metadataCopy.lineage) } : {}),
    };
    operations.push({ kind: 'set', path: '/authoring_metadata', value: exportedMetadata });
    scope.push('/authoring_metadata');
  }
  const privateIncluded = includePrivate ? collectPrivatePaths(documentCopy) : [];
  const excludedAll = [...excluded,
      ...(includeSources ? [] : ['/authoring_metadata', '/authoring_metadata/sources', '/authoring_metadata/provenance', '/authoring_metadata/lineage']),
      ...(includeSources && !includeProvenance ? ['/authoring_metadata/provenance'] : []),
      ...(includeSources && !includePreparationRequirements ? ['/authoring_metadata/preparation_requirements'] : []),
      ...(includeSources && !includeLineage ? ['/authoring_metadata/lineage'] : [])];
  const envelope = {
    format: 'case-builder-transfer', transfer_version: documentCopy.schema_version === 3 ? BUILDER_SLIDE_TRANSFER_VERSION : BUILDER_TRANSFER_VERSION, intent,
    ...(intent === 'revise' ? { base: canonicalBase } : {}), scope, excluded_fields: excludedAll.slice(0, BUILDER_MAX_ISSUES),
    private_fields: privateIncluded, operations,
  };
  const bytes = utf8.encode(JSON.stringify(envelope)).byteLength;
  if (bytes > BUILDER_TRANSFER_MAX_BYTES) return refusal('too_large', '', 'transfer envelope exceeds the byte limit');
  const preview = {
    intent, included: [...scope, ...privateIncluded].slice(0, BUILDER_MAX_ISSUES), excluded: excludedAll.slice(0, BUILDER_MAX_ISSUES),
    remainingIncluded: Math.max(0, scope.length + privateIncluded.length - BUILDER_MAX_ISSUES),
    remainingExcluded: Math.max(0, excludedAll.length - BUILDER_MAX_ISSUES),
    privateIncluded: privateIncluded.slice(0, BUILDER_MAX_ISSUES), requiresExplicitRedactionReview: intent === 'copy',
    sourceRecords: includeSources ? exportedMetadata.sources?.map(({ id, title, rights_status }) => ({ id, title, rights_status })) ?? [] : [],
    byteLength: bytes,
  };
  return { ok: true, envelope, preview };
}

/** Inspect and atomically materialise one complete candidate against the supplied base. */
export async function inspectBuilderTransfer(envelope, {
  current = null, intent = null, mode = 'preserve',
  acknowledgeRedactions = false, acknowledgeRightsWarnings = false,
} = {}) {
  let encoded;
  try { encoded = JSON.stringify(envelope); } catch { return refusal('not_json', '', 'transfer envelope must be finite JSON data'); }
  const bounded = parseBoundedJson(encoded, { maxBytes: BUILDER_TRANSFER_MAX_BYTES, maxDepth: BUILDER_JSON_MAX_DEPTH, maxNodes: BUILDER_JSON_MAX_NODES });
  if (!bounded.ok) return refusal(bounded.error?.code ?? 'not_json', bounded.error?.at ?? '', bounded.error?.message ?? 'transfer envelope exceeds its bounds');
  envelope = bounded.value;
  if (intent === null) intent = envelope.intent;
  const shapeErrors = validateEnvelope(envelope);
  if (shapeErrors.length) return { ok: false, errors: cap(shapeErrors), remainingIssues: Math.max(0, shapeErrors.length - BUILDER_MAX_ISSUES), candidate: null };
  if (intent !== envelope.intent) return refusal('intent_mismatch', '/intent', 'requested intent differs from the envelope');
  if (intent === 'revise') {
    const currentBase = current ? normalizeBase({ revision: current.revision, intentDigest: current.intentDigest }) : null;
    if (!currentBase || currentBase.revision !== envelope.base.revision || currentBase.intent_digest !== envelope.base.intent_digest)
      return refusal('stale_base', '/base', 'the exact bound draft revision or paired digest is no longer current');
  }
  if (current && !validatePair(current.document, current.authoringMetadata ?? { metadata_version: 1 }).ok)
    return refusal('invalid_base', '', 'current base is not safe to preserve');

  const sourceDocument = intent === 'revise' ? current.document : {};
  const sourceMetadata = intent === 'revise' ? (current.authoringMetadata ?? { metadata_version: 1 }) : { metadata_version: 1 };
  for (const operation of envelope.operations) if (operation.path === '/authoring_metadata' && operation.kind === 'set') {
    if (operation.value.sources?.some(source => source.rights_status === 'restricted')) return refusal('restricted_source', '/authoring_metadata/sources', 'restricted source text cannot be imported');
    const hashes = await verifySourceHashes(operation.value);
    if (!hashes.ok) return hashes;
  }
  const document = cloneJson(sourceDocument), metadata = cloneJson(sourceMetadata);
  const before = cloneJson({ document, authoring_metadata: metadata });
  const applicationErrors = [];
  for (const operation of envelope.operations) {
    if (operation.path === '/authoring_metadata') {
      if (operation.kind === 'remove') applicationErrors.push(safeIssue('metadata_remove', operation.path, 'metadata removal is not supported; supply an explicit metadata object'));
      else replaceObject(metadata, mergeOmitted(metadata, operation.value));
      continue;
    }
    applyRootOperation(document, operation, applicationErrors);
  }
  if (applicationErrors.length) return { ok: false, errors: cap(applicationErrors), candidate: null };

  // A revise has an exact prior document for field-level comparison. A copy
  // has no canonical prior candidate; imported review labels remain claims and
  // are surfaced as such rather than spuriously marking every field stale.
  const staleProvenance = intent === 'revise' ? markStaleProvenance(before.document, document, metadata) : [];
  const checked = validatePair(document, metadata, { mode });
  const readiness = mode === 'ready' ? checked : validatePair(document, metadata, { mode: 'ready' });
  const preservationBlockers = checked.warnings.filter(item => item.code === 'missing_capability');
  const diff = boundedDiff(before, { document, authoring_metadata: metadata });
  if (diff.overflow) return refusal('diff_too_large', '', 'candidate diff exceeds the visible review limit');
  const result = {
    ok: checked.ok, errors: checked.errors, warnings: checked.warnings,
    readinessErrors: readiness.errors,
    remainingIssues: checked.remainingIssues ?? 0, diff: diff.items,
    candidate: { document, authoring_metadata: metadata },
    staleProvenance,
    incomplete: !checked.ok || (checked.warnings?.length ?? 0) > 0,
    explicitScope: [...envelope.scope, ...envelope.private_fields], intent,
    senderListedExcludedFields: envelope.excluded_fields,
    copyReviewWarning: intent === 'copy' ? 'This is a new candidate. The sender list is an unverified claim; inspect the complete candidate and acknowledge possible omissions.' : null,
    requiresExplicitRedactionReview: intent === 'copy',
    acknowledgementCodes: [
      ...(intent === 'copy' ? ['copy_is_a_new_candidate_and_may_omit_unselected_content'] : []),
      ...checked.warnings.filter(item => item.code === 'rights_unresolved' || item.code === 'rights_restricted').map(item => item.code),
    ],
    // Accepting a bounded preserve-mode candidate is distinct from it being
    // ready for rehearsal. Keep both decisions explicit for the caller.
    readyForRehearsal: readiness.ok,
    canAcceptPreservedCandidate: checked.ok && preservationBlockers.length === 0 && (intent !== 'copy' || acknowledgeRedactions) &&
      (acknowledgeRightsWarnings || !checked.warnings.some(item => item.code === 'rights_unresolved' || item.code === 'rights_restricted')),
    preservationBlockers,
    readyToAccept: checked.ok && preservationBlockers.length === 0 && (intent !== 'copy' || acknowledgeRedactions) &&
      (acknowledgeRightsWarnings || !checked.warnings.some(item => item.code === 'rights_unresolved' || item.code === 'rights_restricted')),
  };
  return result;
}

/** New-copy adaptation: one UUIDv7 mapping for every in-bundle identity/reference closure. */
export async function createBuilderCopyCandidate(candidate, { identityMap = null } = {}) {
  const checked = validatePair(candidate?.document, candidate?.authoring_metadata ?? { metadata_version: 1 });
  if (!checked.ok) return { ok: false, errors: checked.errors };
  const pair = cloneJson({ document: candidate.document, authoring_metadata: candidate.authoring_metadata ?? { metadata_version: 1 } });
  const sourceHashes = await verifySourceHashes(pair.authoring_metadata);
  if (!sourceHashes.ok) return sourceHashes;
  const identities = collectIdentities(pair);
  const refs = collectReferences(pair);
  const external = refs.filter(id => !identities.has(id));
  if (external.length) return refusal('external_reference', '', 'new-copy mapping refuses references outside the copied identity closure');
  let mapping;
  if (identityMap === null) mapping = Object.fromEntries([...identities].map(id => [id, uuidv7()]));
  else {
    if (!record(identityMap) || Object.keys(identityMap).length !== identities.size || [...identities].some(id => !isUuidV7(identityMap[id])) || new Set(Object.values(identityMap)).size !== identities.size)
      return refusal('identity_map', '', 'retry mapping must be a complete unique UUIDv7 mapping for this exact closure');
    mapping = { ...identityMap };
  }
  remapReferences(pair, mapping);
  const final = validatePair(pair.document, pair.authoring_metadata);
  return final.ok ? { ok: true, candidate: pair, mapping, warnings: final.warnings } : { ok: false, errors: final.errors, mapping };
}

/** Recompute all selected UTF-8 source text hashes with Web Crypto; claimed hashes are untrusted. */
export async function verifyBuilderSourceHashes(metadata) {
  return verifySourceHashes(metadata);
}

function validateEnvelope(value) {
  const errors = [];
  if (!record(value)) return [safeIssue('envelope_type', '', 'transfer must be an object')];
  let encoded;
  try { encoded = JSON.stringify(value); } catch { return [safeIssue('not_json', '', 'transfer envelope must be finite JSON data')]; }
  const bounded = parseBoundedJson(encoded, { maxBytes: BUILDER_TRANSFER_MAX_BYTES, maxDepth: BUILDER_JSON_MAX_DEPTH, maxNodes: BUILDER_JSON_MAX_NODES });
  if (!bounded.ok) return [safeIssue(bounded.error?.code ?? 'not_json', bounded.error?.at ?? '', bounded.error?.message ?? 'transfer envelope exceeds its bounds')];
  value = bounded.value;
  const allowed = new Set(['format', 'transfer_version', 'intent', 'base', 'scope', 'excluded_fields', 'private_fields', 'operations']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(safeIssue('unknown_key', `/${escapePointer(key)}`, 'unknown transfer field'));
  if (value.format !== 'case-builder-transfer') errors.push(safeIssue('format', '/format', 'unsupported transfer format'));
  // A file from a newer Case is refused by name (AS-221); an unknown field is never kept silently, so nothing is half-read.
  if (Number.isInteger(value.transfer_version) && value.transfer_version > BUILDER_SLIDE_TRANSFER_VERSION) errors.push(safeIssue('newer_case', '/transfer_version', `made by a newer Case: transfer format ${value.transfer_version}, this Case reads up to ${BUILDER_SLIDE_TRANSFER_VERSION}`));
  else if (![BUILDER_TRANSFER_VERSION, BUILDER_SLIDE_TRANSFER_VERSION].includes(value.transfer_version)) errors.push(safeIssue('version', '/transfer_version', 'unsupported transfer version'));
  // Slide content travels only in version 2; a version-1 file that carries it is refused rather than half-read.
  if (value.transfer_version === BUILDER_TRANSFER_VERSION && Array.isArray(value.operations) && value.operations.some(operation => SLIDE_FIELDS.has(String(operation?.path ?? '').slice(1))))
    errors.push(safeIssue('version', '/transfer_version', 'slide content needs transfer version 2'));
  if (!['copy', 'revise'].includes(value.intent)) errors.push(safeIssue('intent', '/intent', 'must be copy or revise'));
  if (value.intent === 'revise' && !validBase(value.base)) errors.push(safeIssue('base', '/base', 'revise requires exact revision and paired digest'));
  if (value.intent === 'copy' && Object.hasOwn(value, 'base')) errors.push(safeIssue('base', '/base', 'copy does not carry an editable base binding'));
  if (!Array.isArray(value.scope) || value.scope.length > BUILDER_TRANSFER_MAX_OPERATIONS || value.scope.some(path => typeof path !== 'string') || new Set(value.scope).size !== value.scope.length)
    errors.push(safeIssue('scope', '/scope', 'scope must be a bounded list of unique canonical field paths'));
  if (!Array.isArray(value.private_fields) || value.private_fields.length > BUILDER_TRANSFER_MAX_OPERATIONS || value.private_fields.some(path => typeof path !== 'string') || new Set(value.private_fields).size !== value.private_fields.length)
    errors.push(safeIssue('private_scope', '/private_fields', 'private field scope must be a bounded list of unique canonical paths'));
  if (!Array.isArray(value.excluded_fields) || value.excluded_fields.length > BUILDER_MAX_ISSUES || value.excluded_fields.some(path => typeof path !== 'string' || path.length > 512 || !path.startsWith('/') || /[\u0000-\u001f]/.test(path)))
    errors.push(safeIssue('excluded_fields', '/excluded_fields', 'excluded field disclosure must be a bounded list of field paths'));
  if (!Array.isArray(value.operations) || value.operations.length > BUILDER_TRANSFER_MAX_OPERATIONS)
    errors.push(safeIssue('operations', '/operations', `operations must have at most ${BUILDER_TRANSFER_MAX_OPERATIONS} entries`));
  else {
    const seen = new Set();
    const operations = [];
    value.operations.forEach((operation, index) => {
      const at = `/operations/${index}`;
      if (!record(operation)) { errors.push(safeIssue('operation_type', at, 'operation must be an object')); return; }
      const expected = operation.kind === 'set' ? ['kind', 'path', 'value'] : ['kind', 'path'];
      if (!['set', 'remove'].includes(operation.kind) || Object.keys(operation).sort().join(',') !== expected.sort().join(',')) {
        errors.push(safeIssue('operation_shape', at, 'operation must be an exact set or remove record')); return;
      }
      if (typeof operation.path !== 'string' || !validPath(operation.path)) { errors.push(safeIssue('field_path', `${at}/path`, 'path is outside the supported canonical field allowlist')); return; }
      if (!value.scope.includes(operation.path)) errors.push(safeIssue('out_of_scope', `${at}/path`, 'operation path is not declared in scope'));
      const terminalField = typeof operation.path === 'string' ? unescapePointer(operation.path.split('/').at(-1)) : '';
      if (operation.kind === 'remove' && isPrivateKey(terminalField, operation.path) && !value.private_fields?.includes(operation.path)) errors.push(safeIssue('private_scope', `${at}/path`, 'private field removal requires explicit private field scope'));
      if (seen.has(operation.path)) errors.push(safeIssue('duplicate_operation', `${at}/path`, 'each canonical path may appear once')); else seen.add(operation.path);
      if (operation.kind === 'set' && operation.path === '/required_capabilities' && Array.isArray(operation.value)) {
        const newer = operation.value.filter(name => typeof name === 'string' && !BUILDER_KNOWN_CAPABILITIES.includes(name));
        if (newer.length) { errors.push(safeIssue('newer_case', `${at}/value`, `made by a newer Case: needs ${newer.slice(0, 8).map(name => `\`${name.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 48)}\``).join(', ')}`)); return; }
      }
      if (operation.kind === 'set' && !safeValueFields(operation.path, operation.value, value.private_fields ?? [], errors, at)) return;
      operations.push(operation);
    });
    for (let i = 0; i < operations.length; i++) for (let j = i + 1; j < operations.length; j++) {
      const left = operations[i].path, right = operations[j].path;
      if (left.startsWith(`${right}/`) || right.startsWith(`${left}/`)) errors.push(safeIssue('overlapping_operations', '/operations', 'parent and child paths cannot be edited in the same proposal'));
    }
    if (Array.isArray(value.scope)) for (const path of value.scope) if (typeof path !== 'string' || !validPath(path)) errors.push(safeIssue('scope_path', '/scope', 'scope contains a path outside the canonical allowlist'));
    for (const path of Array.isArray(value.scope) ? value.scope : []) if (!seen.has(path)) errors.push(safeIssue('unused_scope', '/scope', 'every declared scope path must have one operation'));
    for (const path of Array.isArray(value.private_fields) ? value.private_fields : []) {
      if (!validPath(path) || ![...seen].some(parent => path === parent || path.startsWith(`${parent}/`))) errors.push(safeIssue('private_scope', '/private_fields', 'private field scope must be beneath an explicitly selected operation path'));
      else if (!operations.some(operation => operation.kind === 'remove' && operation.path === path ||
        operation.kind === 'set' && valueContainsPath(operation.value, operation.path, path) && isPrivateKey(unescapePointer(path.split('/').at(-1)), path)))
        errors.push(safeIssue('private_scope', '/private_fields', 'private field scope does not identify private content in the selected operation'));
    }
  }
  return errors;
}

function validPath(path) {
  if (!path.startsWith('/') || path.length > 512 || path.includes('//') || /~(?![01])/.test(path)) return false;
  const segments = path.slice(1).split('/').map(unescapePointer);
  if (!segments.length || segments.some(segment => segment === '__proto__' || segment === 'prototype' || segment === 'constructor')) return false;
  if (segments[0] === 'authoring_metadata') return segments.length === 1;
  if (!DOCUMENT_FIELDS.has(segments[0])) return false;
  if (segments.length === 1) return true;
  // Nested paths are narrow record-property edits. Array containers remain atomic so
  // index shifts cannot make a sequence of operations target a different record.
  if (segments.some(segment => /^(?:0|[1-9]\d*)$/.test(segment))) {
    if (segments.some((segment, i) => /^(?:0|[1-9]\d*)$/.test(segment) && i === segments.length - 1)) return false;
    return segments.every(segment => /^[A-Za-z0-9_-]+$/.test(segment));
  }
  return segments.every(segment => /^[A-Za-z][A-Za-z0-9_-]*$/.test(segment));
}

function safeValueFields(path, value, privateFields, errors, at) {
  if (path === '/authoring_metadata') {
    const result = validateBuilderMetadata(value);
    if (!result.ok) errors.push(...result.errors.map(item => safeIssue(item.code, `${at}/value${item.at}`, item.message)));
    return result.ok;
  }
  // An earlier operation's refusal does not invalidate this operation's private-field declarations.
  const before = errors.length;
  const terminalField = unescapePointer(path.split('/').at(-1));
  if (isPrivateKey(terminalField, path) && !privateFields.includes(path)) errors.push(safeIssue('private_scope', `${at}/path`, 'private field path requires explicit private field scope'));
  const baseSegments = path.slice(1).split('/').map(unescapePointer);
  const inspect = (node, segments) => {
    if (Array.isArray(node)) { node.forEach((item, index) => inspect(item, [...segments, String(index)])); return; }
    if (!record(node)) return;
    for (const [key, child] of Object.entries(node)) {
      const childSegments = [...segments, key];
      const childPath = `/${childSegments.map(escapePointer).join('/')}`;
      if (isPrivateKey(key, childPath) && !privateFields.includes(childPath)) errors.push(safeIssue('private_scope', `${at}/value${childPath}`, 'private field is present without explicit field scope'));
      if (key === 'authoring_metadata' || key === 'approval' || key === 'permissions' || key === 'actor') errors.push(safeIssue('forged_authority', `${at}/value${childPath}`, 'authority and authoring metadata are not document fields'));
      inspect(child, childSegments);
    }
  };
  inspect(value, baseSegments);
  return errors.length === before;
}

function applyRootOperation(document, operation, errors) {
  const segments = operation.path.slice(1).split('/').map(unescapePointer);
  let target = document;
  for (const segment of segments.slice(0, -1)) {
    if (Array.isArray(target)) {
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || index < 0 || index >= target.length) { errors.push(safeIssue('path_missing', operation.path, 'path does not resolve in the exact base')); return; }
      target = target[index];
    } else if (record(target) && Object.hasOwn(target, segment)) target = target[segment];
    else { errors.push(safeIssue('path_missing', operation.path, 'path does not resolve in the exact base')); return; }
  }
  const key = segments.at(-1);
  if (Array.isArray(target)) { errors.push(safeIssue('array_atomic', operation.path, 'array element writes are refused; replace the canonical array atomically')); return; }
  if (!record(target)) { errors.push(safeIssue('path_missing', operation.path, 'path parent does not resolve in the exact base')); return; }
  if (operation.kind === 'remove') {
    if (!Object.hasOwn(target, key)) { errors.push(safeIssue('path_missing', operation.path, 'cannot remove a field absent from the exact base')); return; }
    delete target[key];
  } else {
    // A missing optional object property is a valid set; missing array/object parents are not.
    target[key] = mergeOmitted(target[key], operation.value);
  }
}

function validatePair(document, metadata, options = {}) {
  const mode = options.mode ?? 'preserve';
  const result = validateBuilderDocument(document, metadata, { mode, validateSlides: validateSlideParts });
  const metadataCheck = validateBuilderMetadata(metadata);
  const provenanceIssues = unresolvedProvenance(document, metadata);
  const errors = mode === 'ready' ? provenanceIssues : [];
  const warnings = mode === 'ready' ? [] : provenanceIssues;
  const allErrors = [...result.errors, ...errors];
  const allWarnings = [...result.warnings, ...warnings];
  const visibleErrors = allErrors.slice(0, BUILDER_MAX_ISSUES);
  const visibleWarnings = allWarnings.slice(0, Math.max(0, BUILDER_MAX_ISSUES - visibleErrors.length));
  return {
    ...result, errors: visibleErrors, warnings: visibleWarnings,
    remainingIssues: Math.max(0, allErrors.length + allWarnings.length + (result.remainingIssues ?? 0) - BUILDER_MAX_ISSUES),
    ok: result.ok && metadataCheck.ok && errors.length === 0,
  };
}
function normalizeBase(base) {
  if (!record(base) || !Number.isSafeInteger(base.revision) || base.revision < 0 || Object.keys(base).length !== 2) return null;
  const digest = Object.hasOwn(base, 'intent_digest') ? base.intent_digest : base.intentDigest;
  const normalized = typeof digest === 'string' && /^\\x[0-9a-f]{64}$/.test(digest) ? digest.slice(2) : digest;
  return typeof normalized === 'string' && /^[0-9a-f]{64}$/.test(normalized) ? { revision: base.revision, intent_digest: normalized } : null;
}
function validBase(base) { return record(base) && Object.keys(base).length === 2 && Object.hasOwn(base, 'revision') && Object.hasOwn(base, 'intent_digest') && Number.isSafeInteger(base.revision) && base.revision >= 0 && typeof base.intent_digest === 'string' && /^[0-9a-f]{64}$/.test(base.intent_digest); }
function cloneJson(value) { return JSON.parse(JSON.stringify(value)); }
function replaceObject(target, source) { for (const key of Object.keys(target)) delete target[key]; for (const [key, value] of Object.entries(cloneJson(source))) target[key] = value; }
function isPrivateKey(key, path) {
  if (PRIVATE_KEYS.has(key)) return true;
  if (key !== 'prompt') return false;
  const parentPath = path.slice(0, Math.max(0, path.lastIndexOf('/')));
  return parentPath.endsWith('/recovery');
}
function valueContainsPath(value, parentPath, targetPath) {
  if (targetPath === parentPath) return true;
  if (!targetPath.startsWith(`${parentPath}/`)) return false;
  const relative = targetPath.slice(parentPath.length + 1).split('/').map(unescapePointer);
  let current = value;
  for (const segment of relative) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || index < 0 || index >= current.length) return false;
      current = current[index];
    } else if (record(current) && Object.hasOwn(current, segment)) current = current[segment];
    else return false;
  }
  return true;
}
function stripPrivate(value, path, excluded) {
  if (Array.isArray(value)) { value.forEach((item, i) => stripPrivate(item, `${path}/${i}`, excluded)); return; }
  if (!record(value)) return;
  for (const key of Object.keys(value)) {
    const childPath = `${path}/${escapePointer(key)}`;
    if (isPrivateKey(key, childPath)) { delete value[key]; excluded.push(childPath); }
    else stripPrivate(value[key], childPath, excluded);
  }
}
function collectPrivatePaths(value, path = '', found = []) {
  if (Array.isArray(value)) { value.forEach((item, i) => collectPrivatePaths(item, `${path}/${i}`, found)); return found; }
  if (!record(value)) return found;
  for (const [key, child] of Object.entries(value)) {
    const next = `${path}/${escapePointer(key)}`;
    if (isPrivateKey(key, next)) found.push(next);
    collectPrivatePaths(child, next, found);
  }
  return found;
}
function mergeOmitted(base, incoming) {
  if (Array.isArray(incoming)) {
    if (!Array.isArray(base)) return cloneJson(incoming);
    const byId = new Map(base.filter(record).filter(item => typeof item.id === 'string').map(item => [item.id, item]));
    return incoming.map((item, index) => mergeOmitted(
      record(item) && typeof item.id === 'string' ? byId.get(item.id) : base[index], item,
    ));
  }
  if (record(incoming)) {
    const result = record(base) ? cloneJson(base) : {};
    for (const [key, value] of Object.entries(incoming)) result[key] = mergeOmitted(result[key], value);
    return result;
  }
  return cloneJson(incoming);
}
function markStaleProvenance(before, after, metadata) {
  const records = Array.isArray(metadata.provenance) ? metadata.provenance : [];
  const stale = [];
  for (const entry of records) {
    if (!canonicalProvenanceField(entry.field)) continue;
    const beforeValue = resolveProvenanceValue(before, entry);
    const afterValue = resolveProvenanceValue(after, entry);
    if ((!beforeValue.found || !afterValue.found || !sameJson(beforeValue.value, afterValue.value)) && entry.review_status !== 'stale') {
      entry.review_status = 'stale';
      stale.push({ entity_id: entry.entity_id, field: entry.field });
    }
  }
  return stale;
}
function unresolvedProvenance(document, metadata) {
  const warnings = [];
  for (let index = 0; index < (metadata.provenance?.length ?? 0); index++) {
    const entry = metadata.provenance[index];
    const at = `/authoring_metadata/provenance/${index}`;
    if (!findIdentity(document, entry.entity_id)) warnings.push(safeIssue('provenance_entity_missing', `${at}/entity_id`, 'provenance identity is not present in the canonical document'));
    else if (!provenanceFieldResolves(document, entry)) warnings.push(safeIssue('provenance_field_missing', `${at}/field`, 'provenance field path does not resolve in the canonical document'));
  }
  return warnings;
}
function findIdentity(value, id) {
  if (Array.isArray(value)) { for (const item of value) { const found = findIdentity(item, id); if (found) return found; } return null; }
  if (!record(value)) return null;
  if (value.id === id) return value;
  // A composition owner is a reference, not the canonical entity holding the traced field.
  for (const [key, child] of Object.entries(value)) { if (key === 'owner') continue; const found = findIdentity(child, id); if (found) return found; }
  return null;
}
function provenanceFieldResolves(document, entry) {
  return resolveProvenanceValue(document, entry).found;
}
function resolveProvenanceValue(document, entry) {
  if (!canonicalProvenanceField(entry.field)) return { found: false };
  const match = /^([a-z][a-z0-9_]*)\[([0-9a-f-]{36})\](?:\.(.+))?$/.exec(entry.field);
  let target, rest;
  if (match) {
    const collection = document[match[1]];
    if (!Array.isArray(collection)) return { found: false };
    target = collection.find(item => record(item) && item.id === match[2]);
    if (!target || match[2] !== entry.entity_id) return { found: false };
    rest = match[3] ?? '';
  } else {
    target = findIdentity(document, entry.entity_id);
    rest = entry.field;
    // C46-compatible shorthand: collection.field is accepted only when the
    // named top-level array directly contains this exact identity.
    const prefix = /^([a-z][a-z0-9_]*)\.(.+)$/.exec(rest);
    if (prefix && Array.isArray(document[prefix[1]]) && document[prefix[1]].some(item => record(item) && item.id === entry.entity_id)) {
      rest = prefix[2];
    }
  }
  if (!target) return { found: false };
  if (!rest) return { found: true, value: target };
  const segments = rest.replace(/\[(\d+)\]/g, '.$1').split('.');
  for (const segment of segments) {
    if (Array.isArray(target)) {
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || index < 0 || index >= target.length) return { found: false };
      target = target[index];
    } else if (record(target) && Object.hasOwn(target, segment)) target = target[segment];
    else return { found: false };
  }
  return { found: true, value: target };
}
function canonicalProvenanceField(value) {
  if (typeof value !== 'string' || !value) return false;
  const indexedCollection = /^([a-z][a-z0-9_]*)\[([0-9a-f-]{36})\](?:\.(.*))?$/.exec(value);
  const rest = indexedCollection ? indexedCollection[3] : value;
  if (!rest || rest.startsWith('.') || rest.endsWith('.') || rest.includes('..')) return false;
  return /^[a-z][a-z0-9_]*(?:\[\d+\])*(?:\.[a-z][a-z0-9_]*(?:\[\d+\])*)*$/.test(rest);
}
function collectIdentities(root) {
  const found = new Set();
  const walk = (value, key = '') => {
    if (Array.isArray(value)) { value.forEach(item => walk(item)); return; }
    if (!record(value)) return;
    if (isUuid(value.id)) found.add(value.id);
    for (const [childKey, child] of Object.entries(value)) walk(child, childKey);
  };
  walk(root);
  return found;
}
function collectReferences(root) {
  const found = [];
  const walk = (value, key = '') => {
    if (Array.isArray(value)) { for (const item of value) { if (typeof item === 'string' && UUID_ARRAY_REFERENCE_KEYS.has(key) && isUuid(item)) found.push(item); else walk(item, key); } return; }
    if (!record(value)) { if (typeof value === 'string' && UUID_REFERENCE_KEYS.has(key) && isUuid(value)) found.push(value); return; }
    for (const [childKey, child] of Object.entries(value)) walk(child, childKey);
  };
  walk(root);
  return found;
}
function remapReferences(root, mapping) {
  const walk = (value, key = '') => {
    if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) { if (typeof value[i] === 'string' && UUID_ARRAY_REFERENCE_KEYS.has(key)) value[i] = mapping[value[i]]; else walk(value[i], key); } return; }
    if (!record(value)) return;
    for (const [childKey, child] of Object.entries(value)) {
      if (typeof child === 'string' && UUID_REFERENCE_KEYS.has(childKey)) value[childKey] = mapping[child] ?? child;
      else if (typeof child === 'string' && childKey === 'field') value[childKey] = child.replace(/\[([0-9a-f-]{36})\]/g, (match, id) => mapping[id] ? `[${mapping[id]}]` : match);
      else walk(child, childKey);
    }
  };
  walk(root);
}
async function verifySourceHashes(metadata) {
  const result = validateBuilderMetadata(metadata);
  if (!result.ok) return { ok: false, errors: cap(result.errors) };
  const sources = metadata.sources ?? [];
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    if (typeof source.text !== 'string' || typeof source.sha256 !== 'string') return refusal('source_hash', `/sources/${i}`, 'source text and digest are required');
    let digest;
    try { digest = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(source.text))); }
    catch { return refusal('crypto_unavailable', `/sources/${i}`, 'source digest could not be verified'); }
    const actual = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
    if (actual !== source.sha256) return refusal('source_hash', `/sources/${i}/sha256`, 'source digest does not match its UTF-8 text');
  }
  return { ok: true, errors: [] };
}
function boundedDiff(before, after) {
  const items = [];
  let overflow = false;
  const add = item => {
    if (items.length >= BUILDER_MAX_ISSUES) { overflow = true; return false; }
    items.push(item); return true;
  };
  const walk = (a, b, path) => {
    if (overflow || sameJson(a, b)) return;
    if (items.length >= BUILDER_MAX_ISSUES) { overflow = true; return; }
    if (Array.isArray(a) && Array.isArray(b)) {
      const idsA = a.every(item => record(item) && typeof item.id === 'string') && new Set(a.map(item => item.id)).size === a.length;
      const idsB = b.every(item => record(item) && typeof item.id === 'string') && new Set(b.map(item => item.id)).size === b.length;
      if (!idsA || !idsB) { add({ path, before: present(a), after: present(b), kind: 'array_replaced' }); return; }
      const mapA = new Map(a.map(item => [item.id, item])), mapB = new Map(b.map(item => [item.id, item]));
      const orderA = a.map(item => item.id), orderB = b.map(item => item.id);
      if (!sameJson(orderA, orderB) && !add({ path: `${path}/@order`, before: orderA, after: orderB, kind: 'order' })) return;
      for (const id of new Set([...orderA, ...orderB])) {
        const itemA = mapA.get(id), itemB = mapB.get(id), itemPath = `${path}/@${id}`;
        if (itemA === undefined || itemB === undefined) {
          if (!add({ path: itemPath, before: present(itemA), after: present(itemB), kind: itemA === undefined ? 'add' : 'remove' })) return;
        }
        else walk(itemA, itemB, itemPath);
        if (overflow) return;
      }
      return;
    }
    if (Array.isArray(a) || Array.isArray(b) || !record(a) || !record(b)) { add({ path, before: present(a), after: present(b) }); return; }
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[key], b[key], `${path}/${escapePointer(key)}`);
  };
  walk(before, after, '');
  return { items, overflow };
}
function sameJson(a, b) {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => sameJson(value, b[index]));
  if (!record(a) || !record(b)) return false;
  const keysA = Object.keys(a).sort(), keysB = Object.keys(b).sort();
  return sameJson(keysA, keysB) && keysA.every(key => sameJson(a[key], b[key]));
}
function present(value) { return value === undefined ? { absent: true } : value; }
function refusal(code, at, message) { return { ok: false, errors: [safeIssue(code, at, message)] }; }
function safeIssue(code, at, message) { return { code, at, message }; }
function cap(errors) { return errors.slice(0, BUILDER_MAX_ISSUES); }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function escapePointer(value) { return String(value).replaceAll('~', '~0').replaceAll('/', '~1'); }
function unescapePointer(value) { return value.replaceAll('~1', '/').replaceAll('~0', '~'); }

/**
 * What a draft holds, in the words an author uses, for the import preview (AS-221): the title and the counts a person
 * would compare before replacing one draft with another. Never throws; a malformed pair summarises as empty.
 */
export function summariseBuilderPair(pair) {
  const document = record(pair?.document) ? pair.document : {};
  const list = value => Array.isArray(value) ? value : [];
  const slides = list(document.compositions).length, blocks = list(document.blocks).length;
  return {
    title: typeof document.title === 'string' ? document.title : '',
    schema: Number.isInteger(document.schema_version) ? document.schema_version : null,
    stages: list(document.beats).length, questions: list(document.decisions).length,
    slides, blocks, flags: list(document.flags).length,
    sources: list(pair?.authoringMetadata?.sources ?? pair?.authoring_metadata?.sources).length,
  };
}
