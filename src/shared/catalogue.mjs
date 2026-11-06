// src/shared/catalogue.mjs: the case catalogue query contract (card 29, CASE-166), shared by the
// Worker route and the library client so the two cannot drift. Sorting and filtering always run on the
// server over the whole set (case_api.list_case_catalogue); the client only names them.
import { isUuidV7 } from './ids.mjs';
import { isTint, cleanGroupName } from './groups.mjs';

// Card 30 adds the group sort (named groups by name, Ungrouped last) and the group filter.
export const CATALOGUE_SORTS = Object.freeze(['title', 'published', 'length', 'audience', 'group']);
export const CATALOGUE_DURATIONS = Object.freeze(Array.from({ length: 16 }, (_, i) => 15 + i * 5));
export const CATALOGUE_PAGE = 24;
export const CATALOGUE_PAGE_MAX = 50;
export const CATALOGUE_OFFSET_MAX = 10_000;
export const CATALOGUE_QUERY_MAX = 80;
export const CATALOGUE_AUDIENCE_MAX = 200;
export const CATALOGUE_SUMMARY_MAX = 1200;
export const CATALOGUE_OBJECTIVES_MAX = 8;
export const CATALOGUE_DEFAULT = Object.freeze({ sort: 'title', descending: false, query: '', duration: null,
  audience: null, group: null, limit: CATALOGUE_PAGE, offset: 0 });
/** The group filter's Ungrouped value; any other value is a group id. */
export const CATALOGUE_UNGROUPED = 'ungrouped';

const digits = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,5})$/.test(value);

/** Parse catalogue search parameters. Returns the normalised query, or null for anything malformed. */
export function parseCatalogueQuery(params) {
  const allowed = new Set(['sort', 'order', 'q', 'length', 'audience', 'group', 'limit', 'offset']);
  for (const key of params.keys()) if (!allowed.has(key)) return null;
  for (const key of allowed) if (params.getAll(key).length > 1) return null;
  const sort = params.get('sort') ?? 'title', order = params.get('order') ?? 'asc';
  const query = (params.get('q') ?? '').trim(), length = params.get('length'), audience = params.get('audience');
  const limit = params.get('limit'), offset = params.get('offset'), group = params.get('group');
  if (!CATALOGUE_SORTS.includes(sort) || !['asc', 'desc'].includes(order) || query.length > CATALOGUE_QUERY_MAX) return null;
  if (length !== null && !CATALOGUE_DURATIONS.map(String).includes(length)) return null;
  if (audience !== null && (audience.length < 1 || audience.length > CATALOGUE_AUDIENCE_MAX)) return null;
  if (limit !== null && (!digits(limit) || Number(limit) < 1 || Number(limit) > CATALOGUE_PAGE_MAX)) return null;
  if (offset !== null && (!digits(offset) || Number(offset) > CATALOGUE_OFFSET_MAX)) return null;
  if (group !== null && group !== CATALOGUE_UNGROUPED && !isUuidV7(group)) return null;
  return { sort, descending: order === 'desc', query, duration: length === null ? null : Number(length),
    audience, group, limit: limit === null ? CATALOGUE_PAGE : Number(limit), offset: offset === null ? 0 : Number(offset) };
}

/** The search parameters for a catalogue query (the client side of parseCatalogueQuery). */
export function catalogueSearch({ sort = 'title', descending = false, query = '', duration = null, audience = null,
  group = null, limit = CATALOGUE_PAGE, offset = 0 } = {}) {
  const params = new URLSearchParams({ sort, order: descending ? 'desc' : 'asc' });
  if (query.trim()) params.set('q', query.trim());
  if (duration !== null) params.set('length', String(duration));
  if (audience !== null) params.set('audience', audience);
  if (group !== null) params.set('group', group);
  params.set('limit', String(limit)); params.set('offset', String(offset));
  if (!parseCatalogueQuery(params)) throw new TypeError('invalid_catalogue_query');
  return params;
}

const text = (value, max) => value === null || (typeof value === 'string' && value.length >= 1 && value.length <= max);

/** A catalogue row's group: a named live group with its tint, or Ungrouped (null, null, neutral). */
export const validRowGroup = row => row.group_id === null ? row.group_name === null && row.tint === 'neutral'
  : isUuidV7(row.group_id) && typeof row.group_name === 'string' && cleanGroupName(row.group_name) === row.group_name && isTint(row.tint);

/** A catalogue row exactly as the Worker serves it: public library fields and the case's group only. */
export function validCatalogueRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
  const keys = Object.keys(row).sort().join(',');
  return keys === 'art,audience,case_id,content_sha256,duration_min,group_id,group_name,published_at,setting,summary,tint,title,version_id,version_no' &&
    validRowGroup(row) &&
    isUuidV7(row.version_id) && isUuidV7(row.case_id) && typeof row.title === 'string' && row.title.length >= 1 &&
    row.title.length <= 200 && text(row.summary, CATALOGUE_SUMMARY_MAX) && text(row.audience, CATALOGUE_AUDIENCE_MAX) &&
    text(row.setting, 200) && (row.duration_min === null || CATALOGUE_DURATIONS.includes(row.duration_min)) &&
    Number.isSafeInteger(row.version_no) && row.version_no >= 1 && typeof row.published_at === 'string' &&
    Number.isFinite(Date.parse(row.published_at)) && typeof row.content_sha256 === 'string' &&
    /^\\x[0-9a-f]{64}$/.test(row.content_sha256) && (row.art === null || (typeof row.art === 'object' && !Array.isArray(row.art)));
}

/** Case detail's version list (Julian, 2026-10-06): every published, non-withdrawn version, newest first,
 *  metadata only, so an older or pilot-pinned version stays startable from detail. */
export function validVersionList(list) {
  return Array.isArray(list) && list.length >= 1 && list.length <= 50 && list.every((item, index) => item &&
    typeof item === 'object' && !Array.isArray(item) &&
    ['content_sha256,published_at,version_id,version_no', 'content_sha256,edition,published_at,version_id,version_no'].includes(Object.keys(item).sort().join(',')) &&
    (item.edition === undefined || typeof item.edition === 'boolean') &&
    isUuidV7(item.version_id) && Number.isSafeInteger(item.version_no) && item.version_no >= 1 &&
    (index === 0 || item.version_no < list[index - 1].version_no) &&
    typeof item.published_at === 'string' && Number.isFinite(Date.parse(item.published_at)) &&
    typeof item.content_sha256 === 'string' && /^\\x[0-9a-f]{64}$/.test(item.content_sha256));
}
