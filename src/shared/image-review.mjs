// Card 62 (CASE-285 R1, MEDIA-03): the warnings an image could carry (CASE-268, CASE-273), named in plain words. Facilitator-UX A5
// (CASE-342): image approval is removed, so the review request shape and its Worker route are gone; the warnings and the shown
// state remain only for the Builder's own status text until it drops them. SQL works the warnings out the same way
// (case_app.asset_open_warnings in 20261103000000_asset_review_fence.sql).

/** Each licence's caution, word for word as MEDIA_LICENCES gives it to the author at upload (tests/image-review.test.mjs). */
export const LICENCE_CAUTIONS = Object.freeze({
  'CC-BY-NC-4.0': 'Non-commercial licence: check before any paid or commercial use.',
  'CC-BY-NC-SA-4.0': 'Non-commercial licence: check before any paid or commercial use.',
  'CC-BY-ND-4.0': 'No-derivatives licence: cropping or covering may count as an adaptation.',
  'CC-BY-NC-ND-4.0': 'Non-commercial, no-derivatives licence: check use and any cropping.',
  unlicensed: 'Copyright stays with the publisher: use only where your institution allows it.',
  unknown: 'Unknown source: the rights to show this are not recorded.',
});
// Sources whose licence expects a credit line (MEDIA_LICENCES `attribution`).
const CREDITED = new Set(['CC-BY-4.0', 'CC-BY-SA-4.0', 'licensed-other', 'CC-BY-NC-4.0', 'CC-BY-NC-SA-4.0', 'CC-BY-ND-4.0', 'CC-BY-NC-ND-4.0', 'unlicensed']);
const RESTRICTED = new Set(['CC-BY-NC-4.0', 'CC-BY-NC-SA-4.0', 'CC-BY-ND-4.0', 'CC-BY-NC-ND-4.0']);

/** The open-warning codes, sorted as SQL sorts them (collation "C"). */
export const IMAGE_WARNING_CODES = Object.freeze(['credit_missing', 'licence_caution', 'licence_terms_missing', 'no_licence', 'not_deidentified', 'source_unknown']);
/** The attestation and rights fields an approval names as shown (case_app.asset_review_state), sorted. */
export const IMAGE_REVIEW_KEYS = Object.freeze(['attested', 'attribution', 'creator', 'licence', 'rights_basis', 'rights_note', 'source_url']);

const blank = value => typeof value !== 'string' || !value.trim();

/** A listed image's open warnings, sorted by code, each with its plain words: [{ code, text }]. */
export function imageWarnings(row) {
  const found = [];
  if (row?.attested !== true) found.push({ code: 'not_deidentified', text: 'The author has not confirmed it is de-identified: no names, dates, record numbers or faces.' });
  if (RESTRICTED.has(row?.licence)) found.push({ code: 'licence_caution', text: LICENCE_CAUTIONS[row.licence] });
  if (row?.licence === 'unlicensed') found.push({ code: 'no_licence', text: `Textbook or journal figure with no licence held. ${LICENCE_CAUTIONS.unlicensed}` });
  if (row?.licence === 'unknown') found.push({ code: 'source_unknown', text: LICENCE_CAUTIONS.unknown });
  if (CREDITED.has(row?.licence) && blank(row?.attribution)) found.push({ code: 'credit_missing', text: 'No credit line, which this source usually needs.' });
  if (row?.licence === 'licensed-other' && blank(row?.rights_note)) found.push({ code: 'licence_terms_missing', text: 'The licence held is not written down.' });
  return found.sort((a, b) => (a.code < b.code ? -1 : 1));
}

/** What the admin was shown, exactly as listed: the value an approval sends as `expected`. */
export function imageReviewState(row) {
  return Object.fromEntries(IMAGE_REVIEW_KEYS.map(key => [key, key === 'attested' ? row?.attested === true : row?.[key] ?? null]));
}
