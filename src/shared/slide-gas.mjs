// Blood gas blocks (CASE-311): an arterial or venous gas report in the grouping of an analyser printout (blood gas values,
// acid–base status, electrolytes, metabolites, oxygen status). Apart from slide-document.mjs so the report has one home:
// the validator, the renderer, the Builder and every text export read the same rows, flags and visibility rules.
// A row shows only when its value is typed, so an author fills the parameters they need and the rest stay out of the room.
// What the room sees (visibility, flags, plain-text lines) lives in slide-gas-view.mjs, re-exported here.
import { GAS_SAMPLES, GAS_BOUND, gasNumber, gasTyped } from './slide-gas-view.mjs';
export * from './slide-gas-view.mjs';
// Compare mode (CASE-317): up to three earlier samples beside the current one, each column headed by a short label.
export const GAS_LIMITS = Object.freeze({ groups: 8, rows: 16, totalRows: 48, label: 60, value: 24, unit: 24, caption: 200, earlier: 3, sampleLabel: 24 });
const ROW_KEYS = ['id', 'label', 'value', 'unit', 'low', 'high'];

// Editable adult defaults (Julian, 2026-10-30, CASE-311): generic ranges an author changes per case, never a lab's own.
// A venous sample has no oxygenation ranges, because venous pO2 and saturation are not interpreted against them.
const ROWS = [
  ['Blood gas values', [['pH', '', ['7.35', '7.45'], ['7.31', '7.41']], ['pCO2', 'mmHg', ['35', '45'], ['41', '51']], ['pO2', 'mmHg', ['75', '100'], null]]],
  ['Acid–base status', [['cHCO3−', 'mmol/L', ['22', '28'], ['22', '29']], ['cBase(B)', 'mmol/L', ['-3.0', '3.0'], ['-3.0', '3.0']]]],
  ['Electrolytes', [['cK+', 'mmol/L', ['3.5', '5.2']], ['cNa+', 'mmol/L', ['135', '145']], ['cCa2+', 'mmol/L', ['1.15', '1.30']], ['cCl−', 'mmol/L', ['95', '110']]]],
  ['Metabolites', [['cGlu', 'mmol/L', ['3.9', '7.8']], ['cLac', 'mmol/L', ['0.5', '2.0']]]],
  ['Oxygen status', [['ctHb', 'g/L', ['115', '165']], ['sO2', '%', ['95', '99'], null], ['FO2Hb', '%', ['94', '98'], null], ['FCOHb', '%', ['0', '1.5']], ['FMetHb', '%', ['0', '1.5']], ['Hct', '%', ['35', '50']]]],
];

/** A new report for a sample: every standard row with its unit and default range, and no values. */
export function gasStarter(sample, createId) {
  const venous = sample === 'venous';
  return {
    sample: venous ? 'venous' : 'arterial', caption: '',
    groups: ROWS.map(([label, rows]) => ({ id: createId(), label, rows: rows.map(([name, unit, arterial, venousRange]) => {
      const range = venous && venousRange !== undefined ? venousRange : arterial;
      return { id: createId(), label: name, value: '', unit, low: range?.[0] ?? '', high: range?.[1] ?? '' };
    }) })),
  };
}


/** The block's contract; slide-document.mjs passes its shared checks. */
export function validateGas(gas, at, { text, rows, keys, claim, fail, flag }) {
  if (!Object.hasOwn(GAS_SAMPLES, gas.sample)) fail('enum', `${at}/sample`, `one of ${Object.keys(GAS_SAMPLES).join(', ')}`);
  text(gas.caption, `${at}/caption`, GAS_LIMITS.caption);
  // Compare mode: the current column's label and 1–3 earlier samples, oldest first; every row then carries exactly one
  // `earlier` reading per sample, in that order, under the same text limit as its value (CASE-317).
  let samples = -1;
  if (gas.compare !== undefined) {
    const compareAt = `${at}/compare`, compare = gas.compare;
    if (!compare || typeof compare !== 'object' || Array.isArray(compare)) fail('type', compareAt, 'must be an object when present');
    else {
      keys(compare, ['label', 'earlier'], compareAt);
      text(compare.label, `${compareAt}/label`, GAS_LIMITS.sampleLabel, 1);
      rows(compare.earlier, `${compareAt}/earlier`, GAS_LIMITS.earlier, (sample, sampleAt) => {
        keys(sample, ['id', 'label'], sampleAt); claim(sample.id, `${sampleAt}/id`);
        text(sample.label, `${sampleAt}/label`, GAS_LIMITS.sampleLabel, 1);
      });
      if (Array.isArray(compare.earlier)) samples = compare.earlier.length;
    }
  }
  let total = 0, filled = 0;
  rows(gas.groups, `${at}/groups`, GAS_LIMITS.groups, (group, groupAt) => {
    keys(group, ['id', 'label', 'rows'], groupAt); claim(group.id, `${groupAt}/id`);
    text(group.label, `${groupAt}/label`, GAS_LIMITS.label, 1);
    rows(group.rows, `${groupAt}/rows`, GAS_LIMITS.rows, (row, rowAt) => {
      keys(row, gas.compare === undefined ? ROW_KEYS : [...ROW_KEYS, 'earlier'], rowAt); claim(row.id, `${rowAt}/id`);
      text(row.label, `${rowAt}/label`, GAS_LIMITS.label, 1); text(row.value, `${rowAt}/value`, GAS_LIMITS.value); text(row.unit, `${rowAt}/unit`, GAS_LIMITS.unit);
      for (const key of ['low', 'high']) {
        text(row[key], `${rowAt}/${key}`, GAS_LIMITS.value);
        if (typeof row[key] === 'string' && row[key].trim() && !GAS_BOUND.test(row[key].trim())) fail('number', `${rowAt}/${key}`, 'must be a number such as 7.35 or -3');
      }
      const low = gasNumber(row.low ?? ''), high = gasNumber(row.high ?? '');
      if (low !== null && high !== null && !(low < high)) flag('range_order', `${rowAt}/high`, 'the upper reference must be above the lower');
      if (samples >= 0) {
        if (!Array.isArray(row.earlier) || row.earlier.length !== samples) fail('gas_shape', `${rowAt}/earlier`, `must hold exactly one reading per earlier sample (${samples})`);
        else row.earlier.forEach((value, index) => text(value, `${rowAt}/earlier/${index}`, GAS_LIMITS.value));
      }
      total += 1; if (gasTyped(row.value) || samples > 0 && Array.isArray(row.earlier) && row.earlier.some(gasTyped)) filled += 1;
    });
  });
  if (total > GAS_LIMITS.totalRows) fail('too_many', `${at}/groups`, `a report holds at most ${GAS_LIMITS.totalRows} rows`);
  if (Array.isArray(gas.groups) && !filled) flag('empty_gas', `${at}/groups`, 'type at least one value; rows without a value stay off the slide');
}
