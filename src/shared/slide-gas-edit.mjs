// Blood gas compare mode (CASE-317): pure operations on a gas block's samples, apart from slide-edit.mjs so only the
// lazily loaded gas editor (builder-gas.mjs) carries them. Each returns a new document or a refusal, as slide-edit does.
import { editGas, gasRow } from './slide-edit.mjs';
import { gasStarter, gasColumns, gasTyped, GAS_LIMITS } from './slide-gas.mjs';

const refuse = reason => ({ ok: false, reason });
const byId = (list, id) => (Array.isArray(list) ? list : []).find(item => item?.id === id) ?? null;

// Columns are addressed by position in reading order (earlier samples oldest first, then the
// current one); a sample's own identity names it for removal and moves. Readings sit on each row (`earlier`).
const gasRows = gas => gas.groups.flatMap(group => group.rows);
const gasKey = label => String(label ?? '').trim().toLowerCase();
/** Set one reading: `column` counts the earlier samples oldest first, then the current value. */
export function setGasReading(document, blockId, rowId, column, value) {
  return editGas(document, blockId, gas => {
    const found = gasRow(gas, rowId), last = (gasColumns(gas)?.length ?? 1) - 1;
    if (!found || !Number.isInteger(column) || column < 0 || column > last || typeof value !== 'string') return refuse('That reading no longer exists.');
    const row = found.group.rows[found.index];
    if (column === last) row.value = value; else row.earlier[column] = value;
  });
}
/** Rename a column: an earlier sample's label, or the current sample's (the last column). */
export function setGasColumnLabel(document, blockId, column, value) {
  return editGas(document, blockId, gas => {
    const earlier = gas.compare?.earlier ?? [];
    if (!gas.compare || typeof value !== 'string' || !Number.isInteger(column) || column < 0 || column > earlier.length) return refuse('That column no longer exists.');
    if (column === earlier.length) gas.compare.label = value; else earlier[column].label = value;
  });
}
/**
 * Add an earlier sample just before the current one: empty, or copied once from another gas block's current values,
 * matched by row name (case and spacing ignored). The first one turns compare mode on, with `current` naming this sample.
 */
export function addGasSample(document, blockId, { label = '', current = '', from = null } = {}, createId) {
  const source = from ? byId(document.blocks, from) : null;
  if (from && (source?.type !== 'gas' || from === blockId)) return refuse('That blood gas no longer exists.');
  return editGas(document, blockId, gas => {
    if (typeof label !== 'string' || typeof current !== 'string') return refuse('That column cannot be added.');
    if ((gas.compare?.earlier.length ?? 0) >= GAS_LIMITS.earlier) return refuse(`A report compares at most ${GAS_LIMITS.earlier} earlier samples.`);
    const copied = new Map();
    for (const row of source ? gasRows(source) : []) if (gasTyped(row.value) && !copied.has(gasKey(row.label))) copied.set(gasKey(row.label), row.value.trim());
    gas.compare ??= { label: current, earlier: [] };
    gas.compare.earlier.push({ id: createId(), label });
    for (const row of gasRows(gas)) (row.earlier ??= []).push(copied.get(gasKey(row.label)) ?? '');
  });
}
/** Remove an earlier sample (a column with readings asks first); removing the last one ends compare mode. */
export function removeGasSample(document, blockId, sampleId, { confirmed = false } = {}) {
  return editGas(document, blockId, gas => {
    const at = (gas.compare?.earlier ?? []).findIndex(sample => sample.id === sampleId);
    if (at < 0) return refuse('That column no longer exists.');
    if (!confirmed && gasRows(gas).some(row => gasTyped(row.earlier?.[at]))) return { ok: false, reason: 'This column has values. Confirm to remove it.', review: true };
    gas.compare.earlier.splice(at, 1);
    for (const row of gasRows(gas)) row.earlier.splice(at, 1);
    if (!gas.compare.earlier.length) { delete gas.compare; for (const row of gasRows(gas)) delete row.earlier; }
  });
}
/** Move an earlier sample one column earlier (-1) or later (+1), among the earlier samples; its readings move with it. */
export function moveGasSample(document, blockId, sampleId, delta) {
  return editGas(document, blockId, gas => {
    const earlier = gas.compare?.earlier ?? [], at = earlier.findIndex(sample => sample.id === sampleId), to = at + delta;
    if (at < 0) return refuse('That column no longer exists.');
    if (to < 0 || to >= earlier.length) return refuse(delta < 0 ? 'That column is already the oldest.' : 'That column is already the latest earlier sample.');
    const move = list => list.splice(to, 0, list.splice(at, 1)[0]);
    move(earlier); for (const row of gasRows(gas)) move(row.earlier);
  });
}
/**
 * Fill one column from matched readings ([{ rowId, value }], from a pasted printout) in one change, so one Undo. Replacing
 * a different reading already typed asks first.
 */
export function fillGasColumn(document, blockId, column, readings, { confirmed = false } = {}) {
  return editGas(document, blockId, gas => {
    const last = (gasColumns(gas)?.length ?? 1) - 1;
    if (!Number.isInteger(column) || column < 0 || column > last || !Array.isArray(readings) || !readings.length) return refuse('There is nothing to fill.');
    const cells = readings.map(({ rowId, value }) => ({ found: gasRow(gas, rowId), value }));
    if (cells.some(cell => !cell.found || typeof cell.value !== 'string')) return refuse('A matched row no longer exists.');
    const own = ({ found }) => found.group.rows[found.index], get = row => column === last ? row.value : row.earlier[column];
    const replaced = cells.filter(cell => { const typed = get(own(cell)); return gasTyped(typed) && typed.trim() !== cell.value.trim(); }).length;
    if (replaced && !confirmed) return { ok: false, reason: `${replaced} typed ${replaced === 1 ? 'value' : 'values'} will be replaced. Confirm to fill.`, review: true };
    for (const cell of cells) { const row = own(cell); if (column === last) row.value = cell.value; else row.earlier[column] = cell.value; }
  });
}
/** Reset every row's range to the adult default for the block's sample, matched by row name; other rows keep theirs. */
export function resetGasRanges(document, blockId) {
  return editGas(document, blockId, gas => {
    const defaults = new Map(gasRows(gasStarter(gas.sample, () => '')).map(row => [gasKey(row.label), row]));
    let changed = 0;
    for (const row of gasRows(gas)) {
      const standard = defaults.get(gasKey(row.label));
      if (standard && (row.low !== standard.low || row.high !== standard.high)) { row.low = standard.low; row.high = standard.high; changed++; }
    }
    if (!changed) return refuse('Every standard row already has its adult default range.');
  });
}
