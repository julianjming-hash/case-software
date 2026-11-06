// Paste a blood gas printout into one column of a gas block (CASE-317). Builder-only and pure: each line becomes a name and
// its first reading, and names match a report's rows loosely, so an analyser's "K+ 3.4" or "Lactate 3.8" fills cK+ and cLac.
// Nothing is guessed beyond the alias table below; an unmatched line is listed back to the author, never dropped silently.

/** Names that mean the same row, after normalising (see gasNameKey). Each list is one row; the first entry is its key. */
export const GAS_ALIASES = Object.freeze([
  ['ph'], ['pco2', 'paco2', 'pvco2'], ['po2', 'pao2', 'pvo2'],
  ['hco3', 'bicarbonate', 'bicarb', 'hco3act', 'hco3std'], ['baseb', 'be', 'base', 'baseexcess', 'beb', 'abe', 'sbe', 'baseecf'],
  ['k', 'potassium'], ['na', 'sodium'], ['ca2', 'ca', 'ica', 'calcium', 'ionisedcalcium', 'ionizedcalcium'], ['cl', 'chloride'],
  ['glu', 'glucose'], ['lac', 'lactate'],
  ['thb', 'hb', 'haemoglobin', 'hemoglobin'], ['so2', 'sao2', 'svo2', 'sat', 'sats'], ['fo2hb', 'o2hb', 'oxyhb', 'oxyhaemoglobin'],
  ['fcohb', 'cohb', 'carboxyhaemoglobin', 'carboxyhemoglobin'], ['fmethb', 'methb', 'methaemoglobin', 'methemoglobin'],
  ['hct', 'haematocrit', 'hematocrit'],
]);
const ALIAS = new Map(GAS_ALIASES.flatMap(names => names.map(name => [name, names[0]])));
/**
 * A name's comparison key: an analyser's concentration prefix "c" (cK+, cHCO3−, ctHb) dropped, then lower case without
 * spaces, signs, brackets or punctuation, then its alias row's key. "cBase(B)", "BE" and "Base excess" all read "baseb".
 */
export function gasNameKey(name) {
  const plain = String(name ?? '').trim().replace(/^c(?=t?[A-Z])/, '').toLowerCase().replace(/[\s+\-−–:=()[\],.*]/g, '');
  return ALIAS.get(plain) ?? plain;
}
// A reading: a plain decimal with an optional sign, optionally followed by an analyser's flag letters or arrows ("60H", "7.23*").
const READING = /^([-−]?(?:\d+(?:\.\d+)?|\.\d+))[A-Za-z*↑↓!]*$/;
/** Each non-empty line as { line, name, value }: the words before its first reading, and that reading (value '' when none). */
export function parseGasPrintout(text) {
  return String(text ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
    const words = line.split(/[\s:=]+/).filter(Boolean), at = words.findIndex((word, index) => index > 0 && READING.test(word));
    return at < 0 ? { line, name: line, value: '' } : { line, name: words.slice(0, at).join(' '), value: READING.exec(words[at])[1] };
  });
}
/**
 * Match a pasted printout to a report's rows: { readings: [{ rowId, label, value }], unmatched: [line], lines }. The first
 * line for a row wins; a later line for the same row, a line without a reading or a name no row has is unmatched.
 */
export function matchGasPrintout(text, gas) {
  const rows = new Map();
  for (const group of Array.isArray(gas?.groups) ? gas.groups : []) for (const row of Array.isArray(group?.rows) ? group.rows : []) {
    const key = gasNameKey(row.label);
    if (key && !rows.has(key)) rows.set(key, row);
  }
  const lines = parseGasPrintout(text), readings = [], unmatched = [], used = new Set();
  for (const { line, name, value } of lines) {
    const row = value ? rows.get(gasNameKey(name)) : null;
    if (!row || used.has(row.id)) { unmatched.push(line); continue; }
    used.add(row.id); readings.push({ rowId: row.id, label: row.label, value });
  }
  return { readings, unmatched, lines: lines.length };
}
