// Participant feedback answers (CASE-284, D1): the fixed form, shared by the /F page and the Worker. It mirrors
// case_app.feedback_answers (20261104000000_feedback_subject_comments.sql) so a shape SQL would refuse never leaves
// the phone or reaches an RPC. Text is cleaned (hard rule 14) and refused, never cut, above 280 characters.
import { cleanText } from './text.mjs';

export const FEEDBACK_TEXT_MAX = 280;
export const RATING_KEYS = Object.freeze(['rating_session', 'rating_case', 'rating_app']);
// Form 2 (room PDFs v2, Julian 2026-10-18): each rating has an optional comment about its subject; My Takehome is `takeaway`.
// Form 1's `improve` + `improve_about` stay accepted so a page cached from before the change still sends.
export const COMMENT_KEYS = Object.freeze(['comment_session', 'comment_case', 'comment_app']);
export const TEXT_KEYS = Object.freeze(['takeaway', 'improve', ...COMMENT_KEYS]);
export const IMPROVE_ABOUT = Object.freeze(['session', 'case', 'app']);
const KEYS = new Set([...RATING_KEYS, ...TEXT_KEYS, 'improve_about']);
const refused = Object.freeze({ ok: false, error: 'invalid_feedback' });

/** `{ ok: true, answers }` with omitted and null keys dropped, or `{ ok: false, error: 'invalid_feedback' }`. */
export function normaliseFeedbackAnswers(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return refused;
  const answers = {};
  for (const [key, value] of Object.entries(input)) {
    if (!KEYS.has(key)) return refused;
    if (value === null) continue;
    if (RATING_KEYS.includes(key)) {
      if (!Number.isInteger(value) || value < 1 || value > 5) return refused;
      answers[key] = value;
    } else if (TEXT_KEYS.includes(key)) {
      if (typeof value !== 'string') return refused;
      const text = cleanText(value, Infinity);
      if (!text || text.length > FEEDBACK_TEXT_MAX) return refused;
      answers[key] = text;
    } else {
      if (!IMPROVE_ABOUT.includes(value)) return refused;
      answers[key] = value;
    }
  }
  if (('improve' in answers) !== ('improve_about' in answers) || !Object.keys(answers).length) return refused;
  if ('improve' in answers && COMMENT_KEYS.some(k => k in answers)) return refused;
  return { ok: true, answers };
}
