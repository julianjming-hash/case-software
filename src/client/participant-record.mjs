// Participant-held participant record (CASE-284 D7; room PDFs v2, Julian 2026-10-18). A lazy chunk the Finish block loads only
// on Download; it loads the tagged PDF writer only then. The record is built from the record summary
// (record-summary.mjs: this phone's own ended view, or the feedback page's public facts) and what the participant typed or
// ticked in the Finish block. Typed fields live only in that form's memory and in the file: nothing is sent, stored,
// journalled or put in a URL, and the file says what Case does not attest.
import { cleanText } from '../shared/text.mjs';
import { sessionRecordObjectUrl } from '../shared/urls.mjs';
import { openingRows, pdfFileName, fileDate } from './pdf-chrome.mjs';
import { ACTIVITY, parseHours } from './participant-record-fields.mjs';
export { ACTIVITY, parseHours, defaultHours } from './participant-record-fields.mjs';

export const RECORD_DISCLAIMER = 'Self-recorded by the participant. Case does not confirm identity or attendance and is not a CPD provider.';
export const RECORD_CHROME = Object.freeze({ kicker: 'Participant record',
  objectives: 'Objectives', takeHome: 'My Takehome' });
const FORMAT = 'Facilitated simulated clinical case in Case, with live anonymous voting and discussion';
const SHORT_MAX = 200, LONG_MAX = 2000;

const when = iso => { const d = new Date(iso ?? NaN); return Number.isNaN(+d) ? null : d; };
// Fixed English formats: the record is read by a CPD home, and the PDF font holds Latin text only.
const fmt = (d, options, timeZone) => d.toLocaleString('en-AU', { ...options, timeZone }).replace(/[  ]/g, ' ');
/** A typed field, cleaned (rule 14) and bounded; an over-long one refuses rather than being cut. */
function typed(value, max) {
  const text = cleanText(value, Infinity);
  if (text.length > max) throw new Error('record_input');
  return text;
}

/**
 * The writer's rows (session-pdf.mjs) for one record. `summary` is a record summary; `entry` holds the participant's own
 * fields: name, facilitator, location, hours, activity, takeHome and canNow (objective indexes they ticked). Blank fields and
 * missing facts are left off.
 */
export function participantRecordRows(summary, entry = {}, { timeZone } = {}) {
  const title = cleanText(summary.title, SHORT_MAX) || 'Case session';
  const name = typed(entry.name, SHORT_MAX), facilitator = typed(entry.facilitator, SHORT_MAX), location = typed(entry.location, SHORT_MAX);
  const takeHome = typed(entry.takeHome, LONG_MAX), hours = parseHours(entry.hours);
  if (!hours.ok) throw new Error('record_input');
  const ticked = new Set(Array.isArray(entry.canNow) ? entry.canNow.filter(Number.isInteger) : []);
  const objectives = (summary.objectives ?? []).map(o => cleanText(o, LONG_MAX)).filter(Boolean);
  const start = when(summary.startedAt), end = when(summary.endedAt), day = (start ?? end) && fmt(start ?? end, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }, timeZone);
  const time = d => fmt(d, { hour: 'numeric', minute: '2-digit' }, timeZone);
  const label = t => ({ runs: [{ text: t, bold: true, colour: 'muted' }] });
  const shortDay = (start ?? end) && fmt(start ?? end, { day: 'numeric', month: 'short', year: 'numeric' }, timeZone);
  const span = summary.minutes != null && start && end ? `${time(start)}–${time(end)} (${summary.minutes} min)` : null;
  const caseLine = [title, summary.versionNo != null && `version ${summary.versionNo}`, summary.audience && cleanText(summary.audience, SHORT_MAX)].filter(Boolean).join(' · ');
  // Letterhead (Julian, 2026-10-18): the details lead in their own card, then Objectives, then My Takehome.
  const details = [
    name && ['Participant', name], facilitator && ['Facilitator', facilitator], location && ['Location', location],
    day && ['Date', [day, span].filter(Boolean).join(' · ')],
    ['Hours', [hours.value, (ACTIVITY.find(([k]) => k === entry.activity) ?? ACTIVITY[0])[1]].filter(Boolean).join(' · ')],
    summary.decisions?.total > 0 && ['Decisions', `${summary.decisions.made} of ${summary.decisions.total}`],
    ['Case', caseLine], ['Format', FORMAT],
  ].filter(Boolean).map(([l, v]) => [label(l), v]);
  // The letterhead is the mosaic banner: the case's braid from the shared renderer, its shading seeded with the participant's
  // name on the phone (summary.band; Julian, 2026-10-18).
  const rows = [...openingRows({ title, label: [RECORD_CHROME.kicker, shortDay].filter(Boolean).join(' · '), band: summary.band ?? null }),
    ['H1', { runs: title, colour: 'petrol' }], ['GAP', 4],
    ['SECT', {}], ['BOX', { fill: 'white', stroke: 'line', rows: [['TABLE', { cols: [1.5, 5], size: 9.5, pad: 5, rows: details }]] }], ['/SECT']];
  if (objectives.length) rows.push(['SECT', {}], ['BOX', { fill: 'quiet', rows: [['H3', RECORD_CHROME.objectives],
    // Each objective with the participant's own tick from the phone, a ticked box or an empty one, in its own column so a
    // wrapped objective hangs clear of it (Julian, 2026-10-18).
    ['L', { size: 9.5, items: objectives, marks: objectives.map((_, i) => ticked.has(i)
      ? { sym: 'multi', label: 'Ticked', colour: 'petrol' } : { sym: 'unticked', label: 'Not ticked', colour: 'muted' }) }]] }], ['/SECT']);
  if (takeHome) rows.push(['SECT', {}], ['BOX', { fill: 'tint', rows: [['H3', RECORD_CHROME.takeHome], ['P', { runs: takeHome, size: 11.5 }]] }], ['/SECT']);
  // What Case does not attest: a grey card on the page's foot, above the footer (Julian, 2026-10-18).
  rows.push(['GAP', 4], ['BOX', { fill: 'sunken', pad: 8, radius: 6, foot: true, rows: [['P', { runs: RECORD_DISCLAIMER, colour: 'muted', size: 8 }]] }]);
  return rows;
}

/** The record as tagged PDF bytes; the writer is loaded only here. */
export async function participantRecordPdf(summary, entry, options = {}) {
  const rows = participantRecordRows(summary, entry, options);
  // Download deflates the streams; the plain file (the default) is what the tests read back.
  const writer = await import('./session-pdf.mjs');
  return (options.deflate ? writer.sessionPdfDeflated : writer.sessionPdf)(rows, { title: `Participant record · ${cleanText(summary.title, SHORT_MAX) || 'Case session'}`, maxPages: 6 });
}

/** The file name: the case title, "Participant record" and the session date (pdf-chrome.mjs): never a name, code or id. */
export function recordFileName(summary, { timeZone } = {}) {
  return pdfFileName(summary.title, RECORD_CHROME.kicker, { date: fileDate(summary.startedAt ?? summary.endedAt, timeZone) });
}

/** Download: the PDF made on this phone as a blob link, clicked once and revoked. Returns an error message, or null. */
export async function downloadParticipantRecord(doc, summary, entry) {
  let bytes;
  try { bytes = await participantRecordPdf(summary, entry, { deflate: true }); }
  catch (error) {
    if (error?.message === 'pdf_font_unsupported') return "The PDF can't show a character you typed · change it and try again";
    if (/budget|record_input/.test(error?.message ?? '')) return 'This record is too long for the PDF · shorten My Takehome';
    return "Couldn't make the PDF · try again";
  }
  const url = sessionRecordObjectUrl(new Blob([bytes], { type: 'application/pdf' })), a = doc.createElement('a');
  a.href = url; a.download = recordFileName(summary); a.hidden = true; doc.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return null;
}
