// Participant feedback results (card 40 + feedback integration slice 9; docs/plans/PARTICIPANT-FEEDBACK.md §6–§8): the exact
// shapes of the P-37, P-38 and P-39 reads, checked by the Worker before it answers and by the client before it draws.
// Exact keys at every level, so a respondent hash, a participant id, a name, an average or a timestamp can never ride
// along. Distributions are counts per value 1–5 with n. Pure data and pure functions.
import { isUuidV7 } from './ids.mjs';

export const COMMENT_WARNING = 'Written by participants. Comments may contain names.';
/** The three ratings, in order, with their end labels (form 2, room PDFs v2: the same three subjects as form 1, named plainly). */
export const QUESTIONS = Object.freeze([
  Object.freeze({ key: 'session', question: 'The session', low: 'Not useful', high: 'Very useful' }),
  Object.freeze({ key: 'case', question: 'The case', low: 'Not realistic', high: 'Very realistic' }),
  Object.freeze({ key: 'app', question: 'The app', low: 'Hard to use', high: 'Easy to use' }),
]);
export const ABOUT = Object.freeze({ session: 'This session', case: 'The case', app: 'The Case app' });

const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const exact = (x, keys) => object(x) && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
const count = x => Number.isSafeInteger(x) && x >= 0 && x <= 1e9;
const text = (x, max) => typeof x === 'string' && x.length >= 1 && x.length <= max && !/[\u0000-\u001f\u007f]/.test(x);
const day = x => typeof x === 'string' && /^\d{4}-\d\d-\d\d$/.test(x) && Number.isFinite(Date.parse(x));
const version = x => Number.isSafeInteger(x) && x > 0;

const distribution = (d, total) => exact(d, ['counts', 'n']) && Array.isArray(d.counts) && d.counts.length === 5 && d.counts.every(count) &&
  count(d.n) && d.counts.reduce((a, b) => a + b, 0) === d.n && d.n <= total;
const responses = r => exact(r, ['total', 'joined', 'qr']) && count(r.total) && count(r.joined) && count(r.qr) && r.total === r.joined + r.qr;
// A take-away (Take home) is about the session; a form 2 `comment` or a form 1 `improve` is about its subject.
const comment = (c, extra = []) => exact(c, ['kind', 'about', 'body', ...extra]) && ['takeaway', 'improve', 'comment'].includes(c.kind) &&
  Object.hasOwn(ABOUT, c.about) && (c.kind !== 'takeaway' || c.about === 'session') && text(c.body, 280);
const comments = (list, max, check = c => comment(c)) => Array.isArray(list) && list.length <= max && list.every(check);

/** A room's results. `internal`: the SQL row, which also carries the workspace and the starter flag for the Worker's check. */
export function validSessionFeedback(v, { internal = false } = {}) {
  const head = ['id', 'caseId', 'versionNo', 'title', 'date', ...(internal ? ['workspaceId', 'own'] : [])];
  return exact(v, ['session', 'closed', 'responses', 'ratings', 'comments']) && exact(v.session, head) && isUuidV7(v.session.id) &&
    isUuidV7(v.session.caseId) && version(v.session.versionNo) && text(v.session.title, 200) && day(v.session.date) &&
    (!internal || isUuidV7(v.session.workspaceId) && typeof v.session.own === 'boolean') && typeof v.closed === 'boolean' &&
    responses(v.responses) && exact(v.ratings, ['session', 'case', 'app']) && QUESTIONS.every(q => distribution(v.ratings[q.key], v.responses.total)) &&
    comments(v.comments, 4 * Math.max(1, v.responses.total));
}

/** A version's pooled case-content results: take-aways and improvements about the case only (D4). */
export function validCaseFeedback(v, { internal = false } = {}) {
  const head = ['id', 'versionNo', 'title', ...(internal ? ['workspaceId'] : [])];
  return exact(v, ['case', 'rooms', 'responses', 'ratings', 'comments', 'commentsTotal']) && exact(v.case, head) && isUuidV7(v.case.id) &&
    version(v.case.versionNo) && text(v.case.title, 200) && (!internal || isUuidV7(v.case.workspaceId)) && count(v.rooms) &&
    responses(v.responses) && v.rooms <= v.responses.total && exact(v.ratings, ['case']) && distribution(v.ratings.case, v.responses.total) &&
    comments(v.comments, 300, c => comment(c) && (c.kind === 'takeaway' || c.about === 'case')) && count(v.commentsTotal) &&
    v.commentsTotal >= v.comments.length;
}

const room = r => exact(r, ['sessionId', 'caseId', 'versionNo', 'title', 'date', 'responses']) && isUuidV7(r.sessionId) && isUuidV7(r.caseId) &&
  version(r.versionNo) && text(r.title, 200) && day(r.date) && count(r.responses) && r.responses > 0;
const month = m => exact(m, ['month', 'counts', 'n']) && typeof m.month === 'string' && /^\d{4}-\d\d$/.test(m.month) && distribution({ counts: m.counts, n: m.n }, Infinity);
const appResult = v => exact(v, ['responses', 'ratings', 'months', 'comments']) && responses(v.responses) && exact(v.ratings, ['app']) &&
  distribution(v.ratings.app, v.responses.total) && Array.isArray(v.months) && v.months.length <= 12 && v.months.every(month) &&
  comments(v.comments, 20, c => comment(c, ['date']) && c.kind !== 'takeaway' && c.about === 'app' && day(c.date));

/** The admin page, as the SQL returns it (`next` an offset) or as the Worker answers it (`nextAfter` an opaque cursor). */
export function validAdminFeedback(v, { internal = false } = {}) {
  const pager = internal ? 'next' : 'nextAfter';
  if (!exact(v, ['scope', 'result', pager])) return false;
  const next = v[pager], single = v.scope === 'session' || v.scope === 'case';
  if (!(next === null || (internal ? Number.isSafeInteger(next) && next > 0 && next <= 10020 && next % 20 === 0 : typeof next === 'string' && next.length <= 512)) || single && next !== null) return false;
  if (v.scope === 'session') return validSessionFeedback(v.result);
  if (v.scope === 'case') return validCaseFeedback(v.result);
  if (v.scope === 'rooms') return exact(v.result, ['rooms']) && Array.isArray(v.result.rooms) && v.result.rooms.length <= 20 && v.result.rooms.every(room) &&
    new Set(v.result.rooms.map(r => r.sessionId)).size === v.result.rooms.length;
  if (v.scope === 'app') return appResult(v.result);
  return false;
}

/** Admin filters (exact keys), as the client sends them and the Worker forwards them. */
export function validFeedbackFilter(f) {
  if (!object(f)) return false;
  if (f.scope === 'app' || f.scope === 'rooms') return exact(f, ['scope']);
  if (f.scope === 'session') return exact(f, ['scope', 'sessionId']) && isUuidV7(f.sessionId);
  if (f.scope === 'case') return exact(f, ['scope', 'caseId', 'versionNo']) && isUuidV7(f.caseId) && version(f.versionNo) && f.versionNo <= 1e6;
  return false;
}
