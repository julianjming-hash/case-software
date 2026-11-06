// The participant record's typed fields (CASE-284 D7; room PDFs v2), shared by the Finish block and the PDF without loading
// either's other code: the activity types, the hours rule and the default hours. Pure.
export const ACTIVITY = Object.freeze([['educational', 'Educational activity'], ['performance', 'Reviewing performance']]);

/** Hours claimed: blank, or a positive number up to 24 with at most two decimals (a comma is read as a point). */
export function parseHours(input) {
  const s = String(input ?? '').trim().replace(',', '.');
  if (!s) return { ok: true, value: '' };
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(s) || !(Number(s) > 0 && Number(s) <= 24)) return { ok: false };
  return { ok: true, value: String(Number(s)) };
}
/** The session length as hours, rounded to a quarter hour (at least 0.25), or ''. */
export const defaultHours = minutes => (Number.isFinite(minutes) && minutes > 0 ? String(Math.max(0.25, Math.round(minutes / 15) / 4)) : '');
