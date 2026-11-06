// Card 30 (CASE-168 (3)): the case-group contract shared by the Worker and the clients. One workspace per group,
// one group per case or Ungrouped, ten tints; groups never grant access. Names are cleaned like every human string.
import { cleanText } from './text.mjs';
import { isUuidV7 } from './ids.mjs';
import { GROUP_TINTS, isTint, tintOf } from './tints.mjs';

export { GROUP_TINTS, isTint, tintOf };
export const GROUP_NAME_MAX = 60;
export const GROUPS_MAX = 100;
export const UNGROUPED = 'Ungrouped';

// Invisible characters are refused (CASE-172).
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/u;
export function cleanGroupName(value) {
  if (typeof value !== 'string' || value.length > 4 * GROUP_NAME_MAX || INVISIBLE.test(value)) return null;
  const name = cleanText(value, GROUP_NAME_MAX + 1);
  return name && name.length <= GROUP_NAME_MAX ? name : null;
}
export const exact = (value, keys) => Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');
export const count = value => Number.isSafeInteger(value) && value >= 0;
export const nameOk = value => typeof value === 'string' && cleanGroupName(value) === value;

/** One row of the library's group filter: a live group, or Ungrouped (null id and name, neutral). */
export function validCatalogueGroupRow(row) {
  return exact(row, ['id', 'name', 'tint', 'count']) && count(row.count) && isTint(row.tint) &&
    (row.id === null ? row.name === null && row.tint === 'neutral' : isUuidV7(row.id) && nameOk(row.name));
}
/** A case's group as case detail serves it. */
export function validCaseGroup(group) {
  return exact(group, ['id', 'name', 'tint', 'revision']) && count(group.revision) && isTint(group.tint) &&
    (group.id === null ? group.name === null && group.tint === 'neutral' : isUuidV7(group.id) && nameOk(group.name));
}

export const TINT_NAMES = Object.freeze({ petrol: 'Petrol', sage: 'Sage', olive: 'Olive', ochre: 'Ochre', coral: 'Coral',
  rose: 'Rose', plum: 'Plum', periwinkle: 'Periwinkle', sky: 'Sky', neutral: 'Neutral' });
export const GROUP_DESCRIPTION_MAX = 200;

// A description: null for none, undefined when refused.
export function cleanGroupDescription(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length > 4 * GROUP_DESCRIPTION_MAX || INVISIBLE.test(value)) return undefined;
  const text = cleanText(value, GROUP_DESCRIPTION_MAX + 1);
  if (!text) return null;
  return text.length <= GROUP_DESCRIPTION_MAX ? text : undefined;
}

/** One group as GET /workspaces/:id/groups serves it. */
export function validGroupRow(row) {
  return exact(row, ['id', 'name', 'description', 'tint', 'revision', 'caseCount']) && isUuidV7(row.id) && nameOk(row.name) &&
    (row.description === null || (typeof row.description === 'string' && cleanGroupDescription(row.description) === row.description)) &&
    isTint(row.tint) && count(row.revision) && count(row.caseCount);
}
