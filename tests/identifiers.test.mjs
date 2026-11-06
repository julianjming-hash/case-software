// The soft patient-identifier check (src/shared/identifiers.mjs; spec red team 2, P2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identifierKinds, identifierWarning } from '../src/shared/identifiers.mjs';

test('[RT2] identifier kinds: Medicare, IHI, DOB-like dates, titled names and record numbers', () => {
  const cases = [
    ['Medicare 2123 45670 1', ['medicare', 'mrn']], // a 10-digit card number is also record-number shaped
    ['card 21234567801', ['medicare']],
    ['IHI 8003 6012 3456 7890', ['ihi']],
    ['8003601234567890', ['ihi']],
    ['born 03/04/1961', ['dob']],
    ['dob 3-4-61', ['dob']],
    ['1961-04-03', ['dob']],
    ['3 Apr 1961', ['dob']],
    ['Mrs Nguyen in bed 4', ['titled_name']],
    ['Mr. O\'Brien', ['titled_name']],
    ['MRN 1234567', ['mrn']],
    ['UR 123456', ['mrn']],
    ['1234567890', ['medicare', 'mrn']],
  ];
  for (const [text, want] of cases) assert.deepEqual(identifierKinds(text), want, text);
});

test('[RT2] clinical text without identifiers raises no warning', () => {
  for (const text of [
    'S00175 workshop label. Record a s', 'HR 118 BP 98/62 SpO2 94%', '120 80 90', '4:4:1 ratio',
    'GCS 14 (E3 V5 M6)', 'Give 1 g TXA over 10 min', 'Mrs', 'mr smith', 'Dr Example', '',
  ]) assert.deepEqual(identifierKinds(text), [], text);
  assert.equal(identifierWarning('Decompress now'), '');
});

test('[RT2] the warning names the kinds in plain words and never repeats the text', () => {
  const w = identifierWarning('Mrs Nguyen DOB 03/04/1961');
  assert.equal(w, 'This looks like it may contain a date of birth and a name. Do not enter patient details.');
  assert.ok(!w.includes('Nguyen') && !w.includes('1961'));
});
