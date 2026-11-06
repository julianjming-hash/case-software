/** Resolve private metadata provenance against the exact canonical document snapshot. */
export function validateBuilderProvenancePaths(document, metadata) {
  const issues = [];
  const entries = Array.isArray(metadata?.provenance) ? metadata.provenance : [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const at = `/authoring_metadata/provenance/${index}`;
    const entity = findIdentity(document, entry?.entity_id);
    if (!entity) issues.push(issue('provenance_entity_missing', `${at}/entity_id`, 'provenance identity is not present in the canonical document'));
    else if (!canonicalField(entry?.field) || !fieldResolves(document, entity, entry)) issues.push(issue('provenance_field_missing', `${at}/field`, 'provenance field path does not resolve in the canonical document'));
    if ((entry?.start_line !== undefined || entry?.end_line !== undefined) && typeof entry?.source_id !== 'string')
      issues.push(issue('source_range_missing', `${at}/source_id`, 'a line range must identify its source'));
  }
  return issues;
}

function findIdentity(value, id) {
  if (Array.isArray(value)) {
    for (const item of value) { const found = findIdentity(item, id); if (found) return found; }
    return null;
  }
  if (!record(value)) return null;
  if (value.id === id) return value;
  // A composition's owner reuses its stage's id; it is a reference, never the traced stage (card 57, matches SQL).
  for (const [key, child] of Object.entries(value)) { if (key === 'owner' && 'reading_order' in value) continue; const found = findIdentity(child, id); if (found) return found; }
  return null;
}

function fieldResolves(document, entity, entry) {
  let target = entity;
  let rest = entry.field;
  const indexedCollection = /^([a-z][a-z0-9_]*)\[([0-9a-f-]{36})\](?:\.(.+))?$/.exec(rest);
  if (indexedCollection) {
    const collection = document[indexedCollection[1]];
    if (!Array.isArray(collection) || indexedCollection[2] !== entry.entity_id || !collection.some(item => item === entity)) return false;
    rest = indexedCollection[3] ?? '';
  } else {
    const dot = rest.indexOf('.');
    if (dot > 0) {
      const collectionName = rest.slice(0, dot), collection = document[collectionName];
      if (Array.isArray(collection) && collection.some(item => item === entity)) rest = rest.slice(dot + 1);
    }
  }
  if (!rest) return false;
  const segments = rest.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  for (const segment of segments) {
    if (Array.isArray(target)) {
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || index < 0 || index >= target.length) return false;
      target = target[index];
    } else if (record(target) && Object.hasOwn(target, segment)) target = target[segment];
    else return false;
  }
  return true;
}

function canonicalField(value) {
  if (typeof value !== 'string' || !value) return false;
  const indexedCollection = /^([a-z][a-z0-9_]*)\[([0-9a-f-]{36})\](?:\.(.*))?$/.exec(value);
  const rest = indexedCollection ? indexedCollection[3] : value;
  if (!rest || rest.startsWith('.') || rest.endsWith('.') || rest.includes('..')) return false;
  return /^[a-z][a-z0-9_]*(?:\[\d+\])*(?:\.[a-z][a-z0-9_]*(?:\[\d+\])*)*$/.test(rest);
}

function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function issue(code, at, message) { return { code, at, message }; }

// Whole-source traces (CASE-321): a human's "Based on" link from a slide to a source. Owner ruling 2026-10-30: making
// the link is the review, so it is written confirmed; it covers the whole source (lines 1..N) and is re-ranged when
// the source's text changes, so it never becomes an out-of-range publishing blocker. Same eight-key shape as every trace.
/** Lines in a source's text, counted as the publishing gates count them (client validator and SQL). */
export function sourceLineCount(text) { return typeof text === 'string' ? (text.match(/\r\n|\n|\r/g) ?? []).length + 1 : 0; }
/** A confirmed whole-source trace from an authored record's field to a source. */
export function wholeSourceTrace(entityId, field, source) {
  return { entity_id: entityId, field, source_id: source.id, start_line: 1, end_line: Math.max(1, sourceLineCount(source.text)), transformation: 'adapted', visibility: 'private', review_status: 'confirmed' };
}
/** True when a trace spans its source from the first line to the last. */
export function isWholeSourceTrace(entry, source) {
  return Boolean(source) && entry?.source_id === source.id && entry.start_line === 1 && entry.end_line === Math.max(1, sourceLineCount(source.text));
}
/** Traces into `sourceId` that spanned all of `previousText` span all of `nextText`; every other trace is unchanged. */
export function rerangeWholeSourceTraces(provenance, sourceId, previousText, nextText) {
  const before = Math.max(1, sourceLineCount(previousText)), after = Math.max(1, sourceLineCount(nextText));
  if (!Array.isArray(provenance) || before === after) return provenance;
  return provenance.map(entry => entry?.source_id === sourceId && entry.start_line === 1 && entry.end_line === before ? { ...entry, end_line: after } : entry);
}
