import { isUuidV7 } from '../shared/ids.mjs';

// Each click reads one page. Never auto-loop a large workspace or silently
// present the first page as the full catalog.
export function consolePage(kind, value, after) {
  if (!['memberships', 'versions'].includes(kind)) throw new Error('invalid_page');
  const rows = value?.[kind], id = kind === 'memberships' ? 'workspace_id' : 'version_id';
  if (!Array.isArray(rows) || rows.length > 20 || !Object.hasOwn(value, 'nextAfter') ||
      value.nextAfter !== null && !isUuidV7(value.nextAfter)) throw new Error('invalid_page');
  if (rows.some(row => !isUuidV7(row?.[id]) ||
      (kind === 'memberships' && row.name !== undefined && typeof row.name !== 'string') ||
      (kind === 'versions' && typeof row.title !== 'string')))
    throw new Error('invalid_page');
  if (after && (!isUuidV7(after) || rows.some(row => row[id] <= after)))
    throw new Error('invalid_page');
  if (value.nextAfter !== null && (!rows.length || value.nextAfter !== rows.at(-1)[id] ||
      value.nextAfter === after)) throw new Error('invalid_page');
  return { rows, nextAfter: value.nextAfter };
}
