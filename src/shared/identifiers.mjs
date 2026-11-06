// src/shared/identifiers.mjs: a soft check for patient identifiers in free text (spec red team 2, P2).
//
// The join notice says "Do not enter patient details".
// People still type them. This module spots text that LOOKS like an Australian patient identifier so
// the phone can warn before sending and the room can flag the answer to the facilitator. It is a
// heuristic, never a gate: it does not refuse, store or log anything, and a false positive only
// costs a warning. Pure and dependency-free; the reducer, the phone and the tests share it.
//
//   identifierKinds('Mr Smith, DOB 03/04/1961')  → ['dob', 'titled_name']
//
// Kinds:
//   medicare     10 or 11 digits (a Medicare card number, with or without the IRN)
//   ihi          16 digits starting 800360 (an Individual Healthcare Identifier)
//   dob          a date such as 03/04/1961, 3-4-61, 1961-04-03 or 3 Apr 1961
//   titled_name  Mr, Mrs, Ms, Miss or Mx followed by a capitalised surname
//   mrn          a 6 to 10 digit number (a hospital record number)

export const IDENTIFIER_KINDS = Object.freeze(['medicare', 'ihi', 'dob', 'titled_name', 'mrn']);

const MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const DATE_PATTERNS = [
  /(?<!\d)\d{1,2}[/.-]\d{1,2}[/.-](?:\d{4}|\d{2})(?!\d)/,          // 03/04/1961, 3-4-61, 3.4.61
  /(?<!\d)(?:19|20)\d{2}-\d{1,2}-\d{1,2}(?!\d)/,                    // 1961-04-03
  new RegExp(`(?<!\\d)\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})\\.?,?\\s+(?:19|20)?\\d{2}(?!\\d)`, 'i'), // 3 Apr 1961
];
const TITLED_NAME = /(?<![\p{L}])(?:Mr|Mrs|Ms|Miss|Mx)\.?\s+\p{Lu}[\p{Ll}'’-]+/u;

/** Each run of digits, joined across single spaces or hyphens when it is grouped like a card number. */
function digitRuns(text) {
  const out = [];
  for (const m of String(text).matchAll(/\d+(?:[ -]\d+)*/g)) {
    const groups = m[0].split(/[ -]/);
    // "8003 6012 3456 7890" or "2123 45670 1" read as one number; "120 80 90" (vitals) does not:
    // a grouped run counts as one only when every group but the last has at least three digits.
    if (groups.length === 1 || groups.slice(0, -1).every((g) => g.length >= 3)) out.push(groups.join(''));
    else out.push(...groups);
  }
  return out;
}

/** The identifier kinds `text` appears to contain, in IDENTIFIER_KINDS order; [] for none. */
export function identifierKinds(text) {
  const s = String(text ?? '');
  if (!s) return [];
  const found = new Set();
  for (const run of digitRuns(s)) {
    if (run.length === 16 && run.startsWith('800360')) found.add('ihi');
    if (run.length === 10 || run.length === 11) found.add('medicare');
    if (run.length >= 6 && run.length <= 10) found.add('mrn');
  }
  if (DATE_PATTERNS.some((re) => re.test(s))) found.add('dob');
  if (TITLED_NAME.test(s)) found.add('titled_name');
  return IDENTIFIER_KINDS.filter((k) => found.has(k));
}

/** Plain words for a warning line, e.g. "a date of birth and a name". Never repeats the text itself. */
export function identifierWords(kinds) {
  const words = { medicare: 'a Medicare number', ihi: 'an IHI', dob: 'a date of birth', titled_name: 'a name', mrn: 'a record number' };
  const list = kinds.map((k) => words[k]).filter(Boolean);
  if (!list.length) return '';
  return list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
}

/** The phone's soft warning copy for `text`, or '' when nothing looks like an identifier. */
export function identifierWarning(text) {
  const kinds = identifierKinds(text);
  return kinds.length ? `This looks like it may contain ${identifierWords(kinds)}. Do not enter patient details.` : '';
}
