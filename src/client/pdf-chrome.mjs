// Shared page chrome for Case's PDFs (Room PDFs v2, Julian 2026-10-18; prototypes/debrief-pdfs.html): the rows that open
// every document (the running header and three-slot footer, case.iatrogenic.app · the case title · n / N, and the cover band,
// which the lazily loaded writer draws from its seed) and the letter-spaced kicker. Rows only: no DOM, no state, no I/O.
import { ORIGIN } from '../shared/urls.mjs';

export const PDF_HOST = new URL(ORIGIN).host;

/**
 * One file-name shape for every Case PDF (Julian, 2026-10-18): "<case title> – <document> – <date or version>.pdf", e.g.
 * "Diving Deeper – Participant record – 2026-10-19.pdf". Never a participant name, code or session id. The title is folded
 * to plain characters (accents dropped, anything a file system dislikes turned to a space) and capped at 60.
 */
export function pdfFileName(title, kind, { date = null, time = null, version = null, ext = 'pdf' } = {}) {
  const t = String(title ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9 '&()+,.-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60).trim() || 'Case';
  const tail = version != null ? `v${version}` : [date, time].filter(Boolean).join(' ');
  return `${t} – ${kind}${tail ? ` – ${tail}` : ''}.${ext}`;
}
/** A local calendar date (YYYY-MM-DD) and 24-hour time (HHMM) for a file name, from an ISO instant; nulls when absent. */
export const fileDate = (iso, timeZone) => { const d = new Date(iso ?? NaN); return Number.isNaN(+d) ? null : d.toLocaleDateString('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }); };
export const fileTime = (iso, timeZone) => { const d = new Date(iso ?? NaN); return Number.isNaN(+d) ? null : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).replace(':', ''); };

/** A letter-spaced small-caps kicker paragraph ("FACILITATOR DEBRIEF"). */
export const kicker = (text, colour = 'petrol') => ['P', { runs: [{ text: String(text).toUpperCase(), bold: true, track: 1.1 }], size: 7.5, colour, keep: true }];

/**
 * The rows every document opens with: page chrome (header label from page 2, the shared footer) and the cover band. `band` is
 * the shared renderer's pdfBand (mosaic.mjs) for the case's braid, made where the art chunk is loaded; without it the band is
 * plain ground under the CASE chip.
 */
export function openingRows({ title, label, labelColour = 'muted', band = null, height = 150 }) {
  return [['PAGE', { header: { right: label, colour: labelColour }, footer: { left: PDF_HOST, centre: title } }],
    ['COVER', { height, draw: band?.shapes ?? [], ...(band ? { ground: band.grout, groutWidth: band.groutWidth } : {}) }]];
}
