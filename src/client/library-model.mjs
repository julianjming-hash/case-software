// Library view model (card 29, CASE-166): pure text and arrangement rules for the catalogue's three
// views over one dataset. Sorting and filtering are the server's (case_api.list_case_catalogue); this
// module never reorders rows across pages, it only labels them and lays loaded rows into board columns.
import { validCatalogueRow, CATALOGUE_PAGE_MAX } from '../shared/catalogue.mjs';
import { UNGROUPED } from '../shared/groups.mjs';

export const NOT_SET = Object.freeze({ summary: 'Summary not set', length: 'Length not set',
  audience: 'Audience not set', setting: 'Setting not set' });
export const PILOT_TEXT = Object.freeze({ approved: 'Pinned pilot version',
  different: 'Different from the approved pilot version' });
export const SORT_CHOICES = Object.freeze([
  ['title', false, 'Title A–Z'], ['title', true, 'Title Z–A'], ['published', true, 'Recently published'],
  ['published', false, 'Oldest published'], ['length', false, 'Shortest first'], ['length', true, 'Longest first'],
  ['audience', false, 'Audience A–Z'],
].map(([sort, descending, label]) => Object.freeze({ value: `${sort}:${descending ? 'desc' : 'asc'}`, sort, descending, label })));
export const TABLE_COLUMNS = Object.freeze([['title', 'Title'], ['group', 'Group'], ['length', 'Length'], ['audience', 'Audience'], ['published', 'Published']]);
export const BOARD_COLUMNS = Object.freeze([['length', 'Length'], ['audience', 'Audience'], ['group', 'Group']]);
/** A case's group by name (card 30): colour is never the only identifier. */
export const groupText = row => typeof row?.group_name === 'string' && row.group_name ? row.group_name : UNGROUPED;

export const lengthText = minutes => Number.isInteger(minutes) && minutes >= 15 && minutes <= 90 && minutes % 5 === 0 ? `${minutes} min` : NOT_SET.length;
export const fieldText = (value, key) => typeof value === 'string' && value.trim() ? value : NOT_SET[key];
export const pilotTone = state => state === 'approved' ? 'ok' : 'warn';

/** "Showing N of M": paging never implies completeness. */
export function showingText(loaded, total) {
  if (total === 0) return 'No published cases match.';
  if (!Number.isSafeInteger(total)) return `Showing ${loaded} published ${loaded === 1 ? 'case' : 'cases'}; more may exist.`;
  return `Showing ${loaded} of ${total} published ${total === 1 ? 'case' : 'cases'}`;
}

/** aria-sort for a table header, from the server sort in force. */
export const ariaSort = (column, sort, descending) => column === sort ? (descending ? 'descending' : 'ascending') : 'none';
/** The next sort when a header is activated: a new column starts ascending (published starts newest). */
export function nextSort(column, sort, descending) {
  if (column === sort) return { sort, descending: !descending };
  return { sort: column, descending: column === 'published' };
}

/** Board columns over loaded rows, in server order; a missing value is its own column, last. By group, the
 *  columns are the workspace's live groups in the server's order (empty ones too) and then Ungrouped, each with
 *  its whole-set count; without that list the loaded rows make their own columns. */
export function boardColumns(rows, by, groups = null) {
  if (by === 'group' && Array.isArray(groups) && groups.length) {
    const columns = groups.map(group => ({ label: group.id === null ? UNGROUPED : group.name, id: group.id, count: group.count, rows: [] }));
    for (const row of rows) (columns.find(column => column.id === row.group_id) ?? columns.find(column => column.id === null))?.rows.push(row);
    return columns.map(({ label, rows: items, count }) => ({ label, rows: items, count }));
  }
  const keyOf = row => by === 'length' ? lengthText(row.duration_min) : by === 'group' ? groupText(row) : fieldText(row.audience, 'audience');
  const columns = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!columns.has(key)) columns.set(key, []);
    columns.get(key).push(row);
  }
  const missing = by === 'length' ? NOT_SET.length : by === 'group' ? UNGROUPED : NOT_SET.audience;
  return [...columns].sort(([a], [b]) => (a === missing) - (b === missing)).map(([label, items]) => ({ label, rows: items }));
}

/** Validate one catalogue page as served; anything else is refused whole. */
export function cataloguePage(value, { offset, limit }) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.cases) || value.cases.length > Math.min(limit, CATALOGUE_PAGE_MAX) ||
      value.offset !== offset || !(value.total === null || (Number.isSafeInteger(value.total) && value.total >= offset + value.cases.length)) ||
      value.cases.some(row => !validCatalogueRow(row))) throw new Error('invalid_catalogue');
  return { rows: value.cases, total: value.total, pilotPin: value.pilotPin ?? null };
}
