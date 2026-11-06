// Blood gas reports as the room sees them (CASE-311): the rows that show, their computed flags and the plain-text lines.
// Apart from slide-gas.mjs (the starter rows and the validator) so the served slide chunks carry only what they draw.
// Flags (↑ ↓) are computed from the row's own reference bounds, never typed, so a flag can never disagree with its range.
// Compare mode (CASE-317): `compare` names the current sample's column and up to three earlier samples, oldest first; each
// row then holds one `earlier` reading per earlier sample, so every sample is a column of the same printout. Readings sit
// on their row, like a trend series' values on its points, so a row's identity is never a key and copies stay valid.
export const GAS_SAMPLES = Object.freeze({ arterial: 'Arterial blood gas', venous: 'Venous blood gas' });
/** A reference bound or reading: optional minus (hyphen or minus sign), up to 5 integer and 3 fraction digits (".5" too), kept as typed. */
export const GAS_BOUND = /^[-−]?(?:\d{1,5}(?:\.\d{1,3})?|\.\d{1,3})$/;
export const gasNumber = text => typeof text === 'string' && GAS_BOUND.test(text.trim()) ? Number(text.trim().replace('−', '-')) : null;
/** 'high', 'low' or null for `value` (the row's own by default): computed from the row's bounds, only for a plain number. */
export function gasFlag(row, value = row?.value) {
  const reading = gasNumber(value ?? ''), low = gasNumber(row?.low ?? ''), high = gasNumber(row?.high ?? '');
  if (reading === null) return null;
  if (high !== null && reading > high) return 'high';
  if (low !== null && reading < low) return 'low';
  return null;
}
/** The range as printed: "7.35–7.45", "≥ 0.5" or "≤ 1.5"; empty when the row has neither bound. */
export function gasRange(row) {
  const low = (row?.low ?? '').trim(), high = (row?.high ?? '').trim();
  return low && high ? `${low}–${high}` : low ? `≥ ${low}` : high ? `≤ ${high}` : '';
}
export const gasTyped = value => typeof value === 'string' && Boolean(value.trim());
/** The compared samples' column headings, oldest first and the current one last; null without compare mode. */
export const gasColumns = block => Array.isArray(block?.compare?.earlier) ? [...block.compare.earlier.map(sample => sample?.label ?? ''), block.compare.label ?? ''] : null;
/** A row's readings in column order (earlier samples, then the current value); just the value without compare mode. */
export const gasCells = (block, row) => (gasColumns(block) ?? ['']).map((_, at, all) => (at < all.length - 1 ? row?.earlier?.[at] : row?.value) ?? '');
/** The groups and rows the room sees: rows with any typed reading, groups with at least one such row. */
export function gasVisible(block) {
  return (Array.isArray(block?.groups) ? block.groups : [])
    .map(group => ({ ...group, rows: (Array.isArray(group?.rows) ? group.rows : []).filter(row => gasCells(block, row).some(gasTyped)) }))
    .filter(group => group.rows.length);
}
/** The report's heading: its sample, then the author's caption (time, oxygen, ventilator settings). */
export const gasTitle = block => [GAS_SAMPLES[block?.sample] ?? GAS_SAMPLES.arterial, (block?.caption ?? '').trim()].filter(Boolean).join(' · ');
export const GAS_FLAG_MARK = Object.freeze({ high: '↑', low: '↓' });
/** One row's readings as text: "60 mmHg", or in compare mode "30 → 40 → 60 mmHg" with "–" for a sample without a value. */
export const gasReading = (block, row) => `${gasCells(block, row).map(value => gasTyped(value) ? value.trim() : '–').join(' → ')}${row.unit ? ` ${row.unit}` : ''}`;
/** Plain text lines in the room's order, for the console, recaps and briefings: "↑ pCO2 60 mmHg (35–45)", flagged by the newest value. */
export function gasLines(block) {
  const columns = gasColumns(block);
  return [gasTitle(block), ...(columns ? [columns.join(' → ')] : []), ...gasVisible(block).flatMap(group => [group.label, ...group.rows.map(row => {
    const flag = gasFlag(row), range = gasRange(row);
    return `${flag ? `${GAS_FLAG_MARK[flag]} ` : ''}${row.label} ${gasReading(block, row)}${range ? ` (${range})` : ''}`;
  })])];
}
