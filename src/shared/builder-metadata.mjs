import { isUuid } from './ids.mjs';

export const BUILDER_METADATA_VERSION = 1;
export const BUILDER_METADATA_MAX_BYTES = 128 * 1024;
export const BUILDER_SOURCE_MAX = 32;
export const BUILDER_PROVENANCE_MAX = 2000;
const unsafeText = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ufeff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** Validate the private, revision-paired source/provenance envelope without repairing it. */
export function validateBuilderMetadata(metadata = { metadata_version: 1 }, { maxBytes = BUILDER_METADATA_MAX_BYTES } = {}) {
  const errors = [];
  const warnings = [];
  const fail = (code, at, message) => errors.push({ code, at, message });
  const warn = (code, at, message) => warnings.push({ code, at, message });
  if (!record(metadata)) return result([{ code: 'type', at: '', message: 'must be a metadata object' }], [], 0);
  const bytes = size(metadata);
  if (!Number.isSafeInteger(bytes) || bytes > maxBytes) fail('too_large', '', `metadata exceeds ${maxBytes} UTF-8 bytes`);
  exactKeys(metadata, ['metadata_version', 'preparation_requirements', 'sources', 'provenance', 'lineage'], '');
  if (metadata.metadata_version !== BUILDER_METADATA_VERSION) fail('metadata_version', '/metadata_version', `must be ${BUILDER_METADATA_VERSION}`);
  if (metadata.preparation_requirements !== undefined) text(metadata.preparation_requirements, '/preparation_requirements', 16 * 1024);
  const sources = metadata.sources === undefined ? [] : metadata.sources;
  if (!Array.isArray(sources)) fail('type', '/sources', 'must be an array');
  else if (sources.length > BUILDER_SOURCE_MAX) fail('too_many_sources', '/sources', `must have at most ${BUILDER_SOURCE_MAX} sources`);
  const sourceById = new Map(), lineCounts = new Map();
  (Array.isArray(sources) ? sources : []).forEach((source, i) => {
    const at = `/sources/${i}`;
    if (!record(source)) { fail('type', at, 'must be a source object'); return; }
    exactKeys(source, ['id', 'title', 'text', 'sha256', 'rights_status'], at);
    uuid(source.id, `${at}/id`);
    if (sourceById.has(source.id)) fail('duplicate_id', `${at}/id`, 'source id is duplicated');
    else sourceById.set(source.id, source);
    text(source.title, `${at}/title`, 4 * 1024);
    text(source.text, `${at}/text`);
    if (typeof source.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(source.sha256)) fail('sha256', `${at}/sha256`, 'must be 64 lower-case hexadecimal characters');
    if (!['unknown', 'permitted', 'restricted'].includes(source.rights_status)) fail('rights_status', `${at}/rights_status`, 'must be unknown, permitted or restricted');
    if (source.rights_status === 'unknown') warn('rights_unresolved', `${at}/rights_status`, 'source rights remain unresolved');
    if (source.rights_status === 'restricted') warn('rights_restricted', `${at}/rights_status`, 'source is marked restricted and is not eligible for release');
  });
  const provenance = metadata.provenance === undefined ? [] : metadata.provenance;
  if (!Array.isArray(provenance)) fail('type', '/provenance', 'must be an array');
  else if (provenance.length > BUILDER_PROVENANCE_MAX) fail('too_many_provenance', '/provenance', `must have at most ${BUILDER_PROVENANCE_MAX} records`);
  (Array.isArray(provenance) ? provenance : []).forEach((entry, i) => {
    const at = `/provenance/${i}`;
    if (!record(entry)) { fail('type', at, 'must be a provenance object'); return; }
    exactKeys(entry, ['entity_id', 'field', 'source_id', 'start_line', 'end_line', 'transformation', 'visibility', 'review_status'], at);
    uuid(entry.entity_id, `${at}/entity_id`);
    if (typeof entry.field !== 'string' || entry.field.length < 1 || entry.field.length > 200 ||
        !/^[a-z][a-z0-9_.\[\]-]*$/.test(entry.field)) fail('field', `${at}/field`, 'must be a bounded canonical field path');
    if (entry.source_id !== undefined) {
      uuid(entry.source_id, `${at}/source_id`);
      if (!sourceById.has(entry.source_id)) warn('source_missing', `${at}/source_id`, 'provenance source is not present in this metadata value');
    }
    if (entry.source_id === undefined && entry.transformation !== 'editorial') warn('source_missing', `${at}/source_id`, 'source trace is missing for non-editorial content');
    const hasStart = entry.start_line !== undefined, hasEnd = entry.end_line !== undefined;
    if (hasStart !== hasEnd) fail('source_range', at, 'start_line and end_line must be supplied together');
    else if (hasStart) {
      if (!entry.source_id) warn('source_range_missing', `${at}/source_id`, 'line range has no source to bind it to');
      if (!Number.isSafeInteger(entry.start_line) || entry.start_line < 1 || !Number.isSafeInteger(entry.end_line) || entry.end_line < entry.start_line)
        fail('source_range', at, 'source line range must be positive and ordered');
      else if (entry.source_id && sourceById.has(entry.source_id)) {
        // Each source's line count once per validation, however many traces point into it (BWR13 at the caps).
        if (!lineCounts.has(entry.source_id)) lineCounts.set(entry.source_id, sourceLines(sourceById.get(entry.source_id).text));
        const lines = lineCounts.get(entry.source_id);
        if (entry.end_line > lines) warn('source_range', at, `source range exceeds ${lines} available lines`);
      }
    }
    if (!hasStart && entry.transformation !== 'editorial') warn('source_range_missing', at, 'source range is missing for non-editorial content');
    if (!['verbatim', 'adapted', 'editorial'].includes(entry.transformation)) fail('transformation', `${at}/transformation`, 'must be verbatim, adapted or editorial');
    if (!['public', 'private'].includes(entry.visibility)) fail('visibility', `${at}/visibility`, 'must be public or private');
    if (!['unreviewed', 'confirmed', 'stale'].includes(entry.review_status)) fail('review_status', `${at}/review_status`, 'must be unreviewed, confirmed or stale');
    if (entry.review_status === 'stale') warn('provenance_stale', `${at}/review_status`, 'source trace needs review');
    if (entry.review_status === 'unreviewed') warn('provenance_unreviewed', `${at}/review_status`, 'source trace has not been reviewed');
  });
  if (metadata.lineage !== undefined) {
    if (!record(metadata.lineage)) fail('type', '/lineage', 'must be a lineage object');
    else {
      exactKeys(metadata.lineage, ['source_case_id', 'source_version_id'], '/lineage');
      uuid(metadata.lineage.source_case_id, '/lineage/source_case_id');
      uuid(metadata.lineage.source_version_id, '/lineage/source_version_id');
    }
  }
  return result(errors, warnings, bytes);

  function exactKeys(value, allowed, at) {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) fail('unknown_key', `${at}/${escapePointer(key)}`, 'unknown metadata field');
  }
  function text(value, at, max = maxBytes) {
    if (typeof value !== 'string') fail('type', at, 'must be text');
    else if (value.length > max) fail('length', at, `must be at most ${max} characters`);
    else if (unsafeText.test(value)) fail('unsafe_characters', at, 'contains unsafe control or bidirectional characters');
  }
  function uuid(value, at) { if (typeof value !== 'string' || !isUuid(value)) fail('bad_id', at, 'must be a lower-case UUID'); }
}

/** SHA-256 helper for the Worker; claimed source hashes are never authority. */
export async function builderSourceSha256(text) {
  if (typeof text !== 'string' || !globalThis.crypto?.subtle) throw new TypeError('Web Crypto and source text are required');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function record(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function size(value) { try { return new TextEncoder().encode(JSON.stringify(value)).byteLength; } catch { return NaN; } }
function sourceLines(value) { return typeof value === 'string' ? (value.match(/\r\n|\n|\r/g) || []).length + 1 : 0; }
function result(errors, warnings, bytes) { return { ok: errors.length === 0, errors, warnings, bytes }; }
function escapePointer(value) { return String(value).replaceAll('~', '~0').replaceAll('/', '~1'); }

/**
 * A pasted citation or link as a source's name and text (CASE-321), in the convention the hand-written sources already
 * use: the text is the citation (a link's address first) with its page, section or figure on the next line, and the
 * name is a short form of its first line. No field is added: the stored source keeps its five keys.
 */
export function builderCitationParts(citation, locator = '') {
  const lines = value => String(value ?? '').replace(/\r\n?/g, '\n').split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const cited = lines(citation), where = lines(locator).join(' '), first = cited[0] ?? '';
  let title = first;
  if (/^https?:\/\/\S+$/i.test(first)) { try { title = new URL(first).hostname.replace(/^www\./, ''); } catch { /* not a link after all: keep the line */ } }
  if (title.length > 120) title = `${title.slice(0, 119).replace(/\s+\S*$/, '')}…`;
  return { title, text: [...cited, ...(where ? [where] : [])].join('\n') };
}
/** The stored source: the tick "I can use this in teaching" stands in for the rights status (owner ruling 2026-10-30). */
export function builderCitationSource({ id, citation, locator = '', permitted = false, sha256 }) {
  return { id, ...builderCitationParts(citation, locator), sha256, rights_status: permitted ? 'permitted' : 'unknown' };
}
