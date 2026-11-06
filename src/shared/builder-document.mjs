import { isUuid } from './ids.mjs';
import { validateCaseDocument } from './case-document.mjs';
import { BUILDER_CAPABILITIES, BUILDER_SCHEMA_VERSION, SLIDE_CAPABILITY, SLIDE_SCHEMA_VERSION } from './case-document.mjs';
import { validateFormattedText } from './builder-format.mjs';
import { validateBuilderMetadata } from './builder-metadata.mjs';
import { CALLOUT_ICON_CAPABILITY } from './slide-text.mjs';

// Capabilities only a schema-3 document may declare: its slide model, and the centred callout with an icon (CASE-344).
const SLIDE_ONLY_CAPABILITIES = Object.freeze([SLIDE_CAPABILITY, CALLOUT_ICON_CAPABILITY]);
/** Every capability this build understands; a file that needs another was made by a newer Case (CASE-221, AS-221). */
export const BUILDER_KNOWN_CAPABILITIES = Object.freeze([...BUILDER_CAPABILITIES, ...SLIDE_ONLY_CAPABILITIES]);

export const BUILDER_DOCUMENT_MAX_BYTES = 1024 * 1024;
export const BUILDER_ENVELOPE_MAX_BYTES = 2 * 1024 * 1024;
export const BUILDER_JSON_MAX_DEPTH = 32;
export const BUILDER_JSON_MAX_NODES = 100_000;
export const BUILDER_MAX_ISSUES = 200;

const unsafeText = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ufeff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const specs = {
  root: { schema_version: 'number', required_capabilities: 'capabilities', title: 'string', summary: 'string', audience: 'string', setting: 'string', duration_min: 'number', learning_objectives: 'array:string', flags: 'array:flag', surfaces: 'array:surface', beats: 'array:beat', start_beat_id: 'uuid', decisions: 'array:decision', clarifications: 'array:clarification' },
  flag: { id: 'uuid', key: 'string', label: 'string' },
  surface: { id: 'uuid', kind: 'string', title: 'string', scene: 'text', points: 'array:text', investigations: 'array:text', notes: 'text', observations: 'array:observation', asset_ids: 'array:uuid', variants: 'array:variant' },
  variant: { when_flags: 'array:string', scene: 'text', points: 'array:text', investigations: 'array:text', notes: 'text' },
  observation: { label: 'string', value: 'string', unit: 'string' },
  beat: { id: 'uuid', kind: 'string', title: 'string', surface_id: 'uuid', decision_id: 'uuid', next_beat_id: 'uuid', requires_flags: 'array:string', cue: 'text' },
  decision: { id: 'uuid', prompt: 'text', timer_s: 'number|null', interaction: 'object:interaction', rules: 'array:rule', paths: 'array:path', fallback_path_id: 'uuid', interpretation: 'string' },
  interaction: { type: 'string', options: 'array:option', max_length: 'number', rank_count: 'number', order_meaning: 'string' },
  option: { id: 'uuid', label: 'string' },
  rule: { when: 'object:when', path_id: 'uuid', reason: 'string' },
  when: { includes_all: 'array:uuid', includes_any: 'array:uuid', excludes: 'array:uuid', top: 'array:uuid', before: 'array:uuid', keywords: 'array:string' },
  path: { id: 'uuid', label: 'string', classification: 'string', recommended: 'boolean', rationale: 'text', option_ids: 'array:uuid', set_flags: 'array:string', clear_flags: 'array:string', reveal_surface_id: 'uuid', next_beat_id: 'uuid', terminal: 'object:terminal', cue: 'text', recovery: 'object:recovery', continue_to_next: 'boolean' },
  terminal: { checkpoint_beat_id: 'uuid', debrief_prompt: 'text', restore_policy: 'string' },
  recovery: { prompt: 'text' },
  clarification: { id: 'uuid', label: 'string', surface_id: 'uuid', beat_ids: 'array:uuid' },
};
const schema1Specs = {
  ...specs,
  root: { schema_version: 'number', title: 'string', summary: 'string', audience: 'string', setting: 'string', duration_min: 'number', learning_objectives: 'array:string', flags: 'array:flag', surfaces: 'array:surface', beats: 'array:beat', start_beat_id: 'uuid', decisions: 'array:decision' },
  decision: { id: 'uuid', prompt: 'text', timer_s: 'number|null', interaction: 'object:interaction', rules: 'array:rule', paths: 'array:path', fallback_path_id: 'uuid' },
  path: { id: 'uuid', label: 'string', classification: 'string', recommended: 'boolean', rationale: 'text', option_ids: 'array:uuid', set_flags: 'array:string', clear_flags: 'array:string', reveal_surface_id: 'uuid', next_beat_id: 'uuid', terminal: 'object:terminal', cue: 'text' },
};
// Schema 3 (CASE-210) is schema 2 plus slide blocks and compositions, which slide-document.mjs validates.
// CASE-227 adds an optional presentation theme, also checked there.
const slideSpecs = { ...specs, root: { ...specs.root, blocks: 'slides', compositions: 'slides', theme: 'slides' } };
const formattedFields = new Set(['scene', 'notes', 'cue', 'prompt', 'rationale', 'debrief_prompt']);

/**
 * Validate a schema-1/2 teaching document in preservation or strict-ready mode. Schema 3 is admitted only when the
 * caller injects `validateSlides` (slide-document.mjs `validateSlideParts`); shipped storage, Worker and room readers
 * do not, so they keep refusing it until slide activation and carry none of its bytes (CASE-210).
 */
export function validateBuilderDocument(doc, metadata = { metadata_version: 1 }, {
  mode = 'preserve', maxDocumentBytes = BUILDER_DOCUMENT_MAX_BYTES, maxMetadataBytes,
  maxDepth = BUILDER_JSON_MAX_DEPTH, maxNodes = BUILDER_JSON_MAX_NODES, validateSlides = null,
} = {}) {
  const errors = [];
  const warnings = [];
  const fail = issue => errors.push(issue);
  const warn = issue => warnings.push(issue);
  if (!['preserve', 'ready'].includes(mode)) return outcome([{ code: 'mode', at: '', message: 'mode must be preserve or ready' }], [], 0, 0, []);
  let bytes = 0;
  let serialized;
  try { serialized = JSON.stringify(doc); bytes = new TextEncoder().encode(serialized).byteLength; }
  catch { fail(issue('not_serializable', '', 'document must be JSON-serializable')); }
  if (serialized === undefined || errors.length) return outcome(errors, warnings, bytes, 0, []);
  if (bytes > maxDocumentBytes) fail(issue('too_large', '', `document exceeds ${maxDocumentBytes} serialized UTF-8 bytes`));
  if (!record(doc)) return outcome([...errors, issue('type', '', 'document must be an object')], warnings, bytes, 0, []);
  const slides = typeof validateSlides === 'function';
  if (![1, BUILDER_SCHEMA_VERSION, ...(slides ? [SLIDE_SCHEMA_VERSION] : [])].includes(doc.schema_version))
    fail(issue('schema_version', '/schema_version', slides ? 'must be 1, 2 or 3' : 'must be 1 or 2'));
  const bounds = measureJsonTree(doc, maxDepth, maxNodes);
  if (bounds.depth > maxDepth) fail(issue('too_deep', '', `document exceeds depth ${maxDepth}`));
  if (bounds.nodes > maxNodes) fail(issue('too_many_nodes', '', `document exceeds ${maxNodes} values`));
  if (errors.length) return outcome(errors, warnings, bytes, 0, []);

  const version = doc.schema_version;
  const activeSpecs = version === 1 ? schema1Specs : version === SLIDE_SCHEMA_VERSION ? slideSpecs : specs;
  const identities = new Set();
  inspect(doc, 'root', '', null);
  if (version === SLIDE_SCHEMA_VERSION) {
    const slideIssues = validateSlides(doc, { mode, identities });
    errors.push(...slideIssues.errors); warnings.push(...slideIssues.warnings);
  }
  const metadataResult = validateBuilderMetadata(metadata, maxMetadataBytes === undefined ? {} : { maxBytes: maxMetadataBytes });
  errors.push(...metadataResult.errors);
  warnings.push(...metadataResult.warnings);

  const capabilities = Array.isArray(doc.required_capabilities) ? doc.required_capabilities : [];
  if (version >= BUILDER_SCHEMA_VERSION) {
    const present = new Set(capabilities);
    const implied = impliedCapabilities(doc);
    for (const capability of implied) if (!present.has(capability)) {
      const missing = { code: 'missing_capability', at: '/required_capabilities', message: `declare required capability ${capability}` };
      (mode === 'ready' ? fail : warn)(missing);
    }
  }
  const readiness = validateCaseDocument(doc, { profile: version === 1 ? 'schema1' : version === SLIDE_SCHEMA_VERSION ? 'schema3' : 'schema2' });
  if (mode === 'ready') errors.push(...readiness.errors);
  else warnings.push(...readiness.errors);
  warnings.push(...readiness.warnings);

  return outcome(errors, warnings, bytes, metadataResult.bytes, capabilities, version);

  function inspect(value, kind, path, field) {
    if (value === undefined) return;
    if (kind.startsWith('array:')) {
      if (!Array.isArray(value)) { fail(issue('type', path, 'must be an array')); return; }
      const itemKind = kind.slice(6);
      value.forEach((item, index) => {
        const itemPath = `${path}/${index}`;
        if (IDENTITY_RECORDS.has(itemKind) && record(item) && !Object.hasOwn(item, 'id'))
          fail(issue('missing_id', `${itemPath}/id`, 'authored records require a stable identity'));
        if (itemKind === 'string' || itemKind === 'uuid') inspectPrimitive(item, itemKind, itemPath);
        else inspect(item, itemKind, itemPath, null);
      });
      return;
    }
    if (kind.startsWith('object:')) {
      const objectKind = kind.slice(7);
      if (!record(value)) { fail(issue('type', path, 'must be an object')); return; }
      inspect(value, objectKind, path, null);
      return;
    }
    if (kind === 'text') {
      if (typeof value === 'string') { inspectPrimitive(value, 'string', path); return; }
      if (version < BUILDER_SCHEMA_VERSION || !formattedFields.has(field) || !record(value)) { fail(issue('type', path, 'must be plain text or approved formatted text')); return; }
      for (const formattingIssue of validateFormattedText(value, { at: path, maxBytes: BUILDER_DOCUMENT_MAX_BYTES })) fail(formattingIssue);
      return;
    }
    if (kind === 'number|null') {
      if (value !== null) inspectPrimitive(value, 'number', path);
      return;
    }
    if (kind === 'slides') return;
    if (kind === 'capabilities') {
      if (!Array.isArray(value)) { fail(issue('type', path, 'must be an array')); return; }
      const seen = new Set();
      value.forEach((capability, index) => {
        const capAt = `${path}/${index}`;
        inspectPrimitive(capability, 'string', capAt);
        if (typeof capability === 'string') {
          if (!BUILDER_CAPABILITIES.includes(capability) && !(version === SLIDE_SCHEMA_VERSION && SLIDE_ONLY_CAPABILITIES.includes(capability))) fail(issue('unknown_capability', capAt, `unknown required capability ${capability}`));
          if (seen.has(capability)) fail(issue('duplicate_capability', capAt, 'required capability is duplicated'));
          seen.add(capability);
        }
      });
      return;
    }
    if (kind === 'string' || kind === 'uuid' || kind === 'number' || kind === 'boolean') {
      inspectPrimitive(value, kind, path);
      return;
    }
    if (!record(value)) { fail(issue('type', path, 'must be an object')); return; }
    const shape = activeSpecs[kind];
    if (!shape) { fail(issue('unsupported_shape', path, 'unsupported record shape')); return; }
    for (const key of Object.keys(value)) {
      const childKind = shape[key];
      const childPath = `${path}/${escapePointer(key)}`;
      if (!childKind) { fail(issue('unknown_key', childPath, 'unknown document field')); continue; }
      inspect(value[key], childKind, childPath, key);
    }
    if (Object.hasOwn(value, 'id')) {
      if (typeof value.id === 'string') {
        if (identities.has(value.id)) fail(issue('duplicate_id', `${path}/id`, 'document identity is duplicated'));
        else identities.add(value.id);
      }
    }
  }

  function inspectPrimitive(value, expected, path) {
    if (expected === 'uuid') {
      if (typeof value !== 'string' || !isUuid(value)) fail(issue('bad_id', path, 'must be a lower-case UUID'));
    } else if (expected === 'string') {
      if (typeof value !== 'string') fail(issue('type', path, 'must be text'));
      else if (unsafeText.test(value)) fail(issue('unsafe_characters', path, 'contains unsafe control or bidirectional characters'));
    } else if (expected === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) fail(issue('type', path, 'must be a finite number'));
    } else if (expected === 'boolean' && typeof value !== 'boolean') fail(issue('type', path, 'must be a boolean'));
  }

}

/** Return an explicit schema-1 to schema-2 copy for preview; the source is never mutated. */
export function convertSchema1ToBuilderDocument(source, metadata = { metadata_version: 1 }) {
  const sourceValidation = validateBuilderDocument(source, metadata, { mode: 'preserve' });
  if (!sourceValidation.ok) return { ok: false, errors: sourceValidation.errors, warnings: sourceValidation.warnings };
  if (source.schema_version !== 1) return { ok: false, errors: [issue('schema_version', '/schema_version', 'conversion source must use schema 1')] };
  const candidate = JSON.parse(JSON.stringify(source));
  candidate.schema_version = BUILDER_SCHEMA_VERSION;
  candidate.required_capabilities = [];
  candidate.clarifications = [];
  for (const decision of candidate.decisions ?? []) {
    decision.interpretation = decision.interaction?.type === 'single_choice' || (Array.isArray(decision.rules) && decision.rules.length > 0)
      ? 'rules' : 'facilitator';
  }
  candidate.required_capabilities = [...impliedCapabilities(candidate)];
  const validation = validateBuilderDocument(candidate, metadata, { mode: 'preserve' });
  if (!validation.ok) return { ok: false, source, errors: validation.errors, warnings: validation.warnings };
  return { ok: true, source, candidate, changes: ['schema_version', 'required_capabilities', 'clarifications', 'decision.interpretation'], validation };
}

function impliedCapabilities(doc) {
  const found = new Set();
  const scanText = value => {
    if (record(value) && Array.isArray(value.blocks)) found.add('formatted_text');
  };
  for (const surface of Array.isArray(doc.surfaces) ? doc.surfaces : []) {
    for (const key of ['scene', 'notes']) scanText(surface?.[key]);
    for (const variant of Array.isArray(surface?.variants) ? surface.variants : []) for (const key of ['scene', 'notes']) scanText(variant?.[key]);
  }
  for (const beat of Array.isArray(doc.beats) ? doc.beats : []) scanText(beat?.cue);
  for (const decision of Array.isArray(doc.decisions) ? doc.decisions : []) {
    scanText(decision?.prompt);
    if (decision?.interpretation === 'facilitator') found.add('human_interpretation');
    for (const path of Array.isArray(decision?.paths) ? decision.paths : []) {
      scanText(path?.cue); scanText(path?.rationale); scanText(path?.recovery?.prompt); scanText(path?.terminal?.debrief_prompt);
      if (record(path) && Object.hasOwn(path, 'recovery')) found.add('required_recovery');
      if (path?.continue_to_next === true) found.add('direct_continuation');
    }
  }
  if (Array.isArray(doc.clarifications) && doc.clarifications.length) found.add('early_clarification');
  if (doc.schema_version === SLIDE_SCHEMA_VERSION) found.add(SLIDE_CAPABILITY);
  if (doc.schema_version === SLIDE_SCHEMA_VERSION && Array.isArray(doc.blocks) && doc.blocks.some(block => block?.type === 'callout' && record(block) && Object.hasOwn(block, 'icon'))) found.add(CALLOUT_ICON_CAPABILITY);
  return found;
}

function outcome(errors, warnings, bytes, metadataBytes, capabilities, version = BUILDER_SCHEMA_VERSION) {
  const combined = [...errors, ...warnings];
  const visible = combined.slice(0, BUILDER_MAX_ISSUES);
  const remainingIssues = Math.max(0, combined.length - visible.length);
  return {
    ok: errors.length === 0,
    errors: visible.filter(item => errors.includes(item)),
    warnings: visible.filter(item => warnings.includes(item)),
    bytes,
    metadataBytes,
    version,
    capabilities: [...capabilities],
    remainingIssues,
    issuesTruncated: remainingIssues > 0,
  };
}

function record(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function issue(code, at, message) { return { code, at, message }; }
function escapePointer(value) { return String(value).replaceAll('~', '~0').replaceAll('/', '~1'); }
function measureJsonTree(root, maxDepth, maxNodes) {
  let nodes = 0, deepest = 0;
  const stack = [{ value: root, depth: 1 }];
  while (stack.length && nodes <= maxNodes && deepest <= maxDepth) {
    const current = stack.pop();
    nodes++;
    if (current.depth > deepest) deepest = current.depth;
    if (Array.isArray(current.value)) {
      for (const item of current.value) stack.push({ value: item, depth: current.depth + 1 });
    } else if (record(current.value)) {
      for (const item of Object.values(current.value)) stack.push({ value: item, depth: current.depth + 1 });
    }
  }
  return { nodes, depth: deepest };
}
const IDENTITY_RECORDS = new Set(['flag', 'surface', 'beat', 'decision', 'option', 'path', 'clarification']);
