// Participant-held participant record (CASE-284 D7; room PDFs v2, Julian 2026-10-18). The record is built only from the learning
// summary (here the /F page's public facts, record-summary.mjs factsSummary) plus what the participant typed or ticked in the
// Finish block, and read back through the structure tree (tests/helpers/pdf-read.mjs) the way assistive technology reads it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readPdf } from './helpers/pdf-read.mjs';
import { sessionPdf } from '../src/client/session-pdf.mjs';
import { participantRecordRows, participantRecordPdf, recordFileName, parseHours, defaultHours, RECORD_DISCLAIMER } from '../src/client/participant-record.mjs';
import { factsSummary } from '../src/client/record-summary.mjs';

const SESSION_ID = '01a14509-77e2-76d4-82c0-49d4c678885e', CODE = 'A7K2M9QX4';
const FACTS = { state: 'open', sessionId: SESSION_ID, title: 'Diving Deeper', versionNo: 2, audience: 'Senior residents and registrars',
  startedAt: '2026-10-17T06:00:00Z', endedAt: '2026-10-17T07:04:00Z', closesAt: '2026-10-18T07:04:00Z',
  objectives: ['Recognise findings the referral diagnosis does not explain.', 'Escalate suspected necrotising infection early.'],
  formUrl: `https://forms.example.org/eval/${CODE}` };
const ENTRY = { name: 'Dr Ana Ruiz-Ødegård', facilitator: 'Dr A. Lee, St Elsewhere ED', location: 'Registrar teaching, Tuesday', hours: '1.25',
  activity: 'educational', takeHome: 'Re-examine when the findings do not fit.', canNow: [1] };
const TZ = { timeZone: 'Australia/Perth' };
const summaryOf = facts => ({ ...factsSummary(facts), audience: facts.audience ?? null });
const read = (facts, entry) => readPdf(sessionPdf(participantRecordRows(summaryOf(facts), entry, TZ), { title: 'Participant record' }));

test('the record reads back as one document: what Case knows, then what the participant typed, then what Case does not attest', () => {
  const { lines, tree } = read(FACTS, ENTRY);
  // Letterhead (Julian, 2026-10-18): the details lead as their own card, then Objectives, then My Takehome; the kicker and date
  // are the page header (an artifact), the answer strip decorative.
  assert.deepEqual(lines, [
    'Diving Deeper',
    'Participant', 'Dr Ana Ruiz-Ødegård',
    'Facilitator', 'Dr A. Lee, St Elsewhere ED',
    'Location', 'Registrar teaching, Tuesday',
    'Date', 'Saturday 17 October 2026 · 2:00 pm–3:04 pm (64 min)',
    'Hours', '1.25 · Educational activity',
    'Case', 'Diving Deeper · version 2 · Senior residents and registrars',
    'Format', 'Facilitated simulated clinical case in Case, with live anonymous voting and discussion',
    // Each objective carries the participant's own tick from the phone: a ticked or an empty box, read as its word, as the list
    // item's label (its own column, so a wrapped objective hangs clear of it).
    'Objectives', 'Not ticked', 'Recognise findings the referral diagnosis does not explain.', 'Ticked', 'Escalate suspected necrotising infection early.',
    'My Takehome', 'Re-examine when the findings do not fit.',
    'Self-recorded by the participant. Case does not confirm identity or attendance and is not a CPD provider.',
  ]);
  for (const t of ['Document', 'Sect', 'H1', 'H3', 'Table', 'Span', 'L', 'LI', 'Lbl', 'LBody']) assert.ok(tree.some(e => e.type === t), t);
});

test('the file states what Case does not attest, and never claims a certificate, accreditation or points', () => {
  const blank = read(FACTS, {});
  assert.equal(RECORD_DISCLAIMER, 'Self-recorded by the participant. Case does not confirm identity or attendance and is not a CPD provider.');
  for (const pdf of [blank, read(FACTS, ENTRY)]) {
    assert.ok(pdf.lines.includes(RECORD_DISCLAIMER), 'the disclaimer is tagged text a reader reaches, not an Artifact');
    assert.ok(pdf.lines.some(l => /simulated clinical case/.test(l)), 'the format says it was a simulated case');
    assert.ok(!pdf.lines.some(l => /educational simulation|clinical advice/i.test(l)), 'the disclaimer stays on the policy page (CASE-168)');
    assert.doesNotMatch(pdf.lines.join('\n'), /certificat|accredit|CPD points|\bpoints\b|verified|attended/i);
  }
});

test('empty participant fields are left off rather than printed as not recorded (D7)', () => {
  const { lines } = read(FACTS, { name: '  ', facilitator: '', location: '‮', hours: '', takeHome: ' ', canNow: [] });
  for (const gone of ['Participant', 'Facilitator', 'Location', 'My Takehome']) assert.ok(!lines.includes(gone), gone);
  assert.doesNotMatch(lines.join('\n'), /not recorded|—|✓|^Ticked/im);
  assert.ok(lines.includes('Hours') && lines.includes('Educational activity'), 'the activity type defaults to educational and stands alone without hours');
  // My Takehome appears only when written.
  const one = read(FACTS, { takeHome: 'Ask about the dive profile early.' }).lines;
  assert.ok(one.includes('My Takehome') && one.includes('Ask about the dive profile early.'));
  assert.equal(read(FACTS, { activity: 'performance', hours: '2' }).lines[read(FACTS, { activity: 'performance', hours: '2' }).lines.indexOf('Hours') + 1], '2 · Reviewing performance');
});

test('missing public facts drop their rows; a room without objectives prints no objectives section', () => {
  const { lines } = read({ title: 'Diving Deeper', versionNo: null, audience: null, startedAt: null, endedAt: '2026-10-17T07:04:00Z', objectives: [] }, {});
  assert.ok(!lines.some(l => /min\)$/.test(l)) && !lines.includes('Objectives'));
  assert.ok(lines.includes('Date') && lines.includes('Saturday 17 October 2026'));
  assert.equal(lines[lines.indexOf('Case') + 1], 'Diving Deeper');
});

test('no URL, token, code or session id reaches the file, its title or its name', async () => {
  const bytes = await participantRecordPdf(summaryOf(FACTS), ENTRY, TZ);
  const pdf = readPdf(bytes), all = [pdf.lines.join('\n'), pdf.text].join('\n');
  for (const secret of [SESSION_ID, SESSION_ID.slice(-8), CODE, 'forms.example.org', '/F/', 'http', 'api/v1']) assert.ok(!all.includes(secret), secret);
  assert.doesNotMatch(new TextDecoder('latin1').decode(bytes).match(/\/Title <FEFF([0-9A-F]*)>/)[1].match(/..../g).map(h => String.fromCharCode(parseInt(h, 16))).join(''), /Ana|Ruiz/, 'the PDF title carries no name');
  const name = recordFileName(summaryOf(FACTS), TZ);
  assert.equal(name, 'Diving Deeper – Participant record – 2026-10-17.pdf');
  assert.ok(!name.includes(SESSION_ID) && !/ana|ruiz/i.test(name));
});

test('typed text is cleaned (rule 14) and bounded; hours are a positive number up to 24 or left off', () => {
  const { lines } = read(FACTS, { name: 'Dr\u0000 Ana‮  Ruiz', takeHome: 'Line one.\n\nLine two.' });
  assert.ok(lines.includes('Dr Ana Ruiz'));
  assert.ok(lines.includes('Line one. Line two.'));
  assert.deepEqual(['1', '1.5', ' 0.25 ', '2,5', '24', '0', '-1', '25', 'one', '1.333', ''].map(parseHours),
    [{ ok: true, value: '1' }, { ok: true, value: '1.5' }, { ok: true, value: '0.25' }, { ok: true, value: '2.5' }, { ok: true, value: '24' },
      { ok: false }, { ok: false }, { ok: false }, { ok: false }, { ok: false }, { ok: true, value: '' }]);
  assert.throws(() => participantRecordRows(summaryOf(FACTS), { name: 'x'.repeat(201) }), /record_input/);
  assert.throws(() => participantRecordRows(summaryOf(FACTS), { takeHome: 'x'.repeat(2001) }), /record_input/);
  assert.deepEqual([64, 7, 90, null, 0].map(defaultHours), ['1', '0.25', '1.5', '', '']);
});

test('a character the PDF font cannot draw refuses rather than substitutes', async () => {
  await assert.rejects(participantRecordPdf(summaryOf(FACTS), { name: '王芳' }, TZ), /pdf_font_unsupported/);
});

test('the writer is reached only lazily: the Finish block loads the record on Download, and the record loads the writer then', () => {
  const page = readFileSync(new URL('../src/client/feedback-page.mjs', import.meta.url), 'utf8');
  const record = readFileSync(new URL('../src/client/participant-record.mjs', import.meta.url), 'utf8');
  assert.match(page, /import\('\.\/participant-record\.mjs'\)/);
  assert.doesNotMatch(page, /^import [^\n]*(participant-record|session-pdf)/m);
  assert.match(record, /import\('\.\/session-pdf\.mjs'\)/);
  assert.doesNotMatch(record, /^import [^\n]*session-pdf/m);
  // Nothing typed is kept: the record module touches no storage and makes no request.
  assert.doesNotMatch(record, /localStorage|sessionStorage|indexedDB|caches\.|fetch\(|sendBeacon|XMLHttpRequest|WebSocket|history\.(push|replace)State|location\.(assign|replace|hash|search)/);
});

test('[room PDFs v2] every PDF file name has one shape: case title – document – date or version, plain characters, never a name or code', async () => {
  const { pdfFileName, fileDate, fileTime } = await import('../src/client/pdf-chrome.mjs');
  assert.equal(pdfFileName('Diving Deeper', 'Recap', { date: fileDate('2026-10-19T06:04:00Z', 'Australia/Perth') }), 'Diving Deeper – Recap – 2026-10-19.pdf');
  assert.equal(pdfFileName('Café: Ölmühle / A?', 'Facilitator debrief', { date: '2026-10-19', time: fileTime('2026-10-19T06:04:00Z', 'Australia/Perth') }), 'Cafe Olmuhle A – Facilitator debrief – 2026-10-19 1404.pdf');
  assert.equal(pdfFileName('Not Yet Stable', 'Facilitator briefing', { version: 2 }), 'Not Yet Stable – Facilitator briefing – v2.pdf');
  assert.equal(pdfFileName('', 'Participant record'), 'Case – Participant record.pdf');
  assert.equal(pdfFileName('x'.repeat(90), 'Recap').length, 60 + ' – Recap.pdf'.length);
});

test('[room PDFs v2] the downloaded (deflated) record reads back exactly like the plain one', async () => {
  const plain = readPdf(await participantRecordPdf(summaryOf(FACTS), ENTRY, TZ)), packed = await participantRecordPdf(summaryOf(FACTS), ENTRY, { ...TZ, deflate: true });
  assert.ok(new TextDecoder('latin1').decode(packed).includes('/FlateDecode'));
  assert.deepEqual(readPdf(packed).lines, plain.lines);
});
