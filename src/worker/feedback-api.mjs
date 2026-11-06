// Participant feedback routes (CASE-284 slice 4, P-35; docs/plans/CARD40-FEEDBACK-INTEGRATION.md).
//   GET /api/v1/feedback/<code>        the public facts behind a feedback code (only {state} before End, R7)
//   PUT /api/v1/feedback/<code>        create or edit this respondent's one response
//   GET /api/v1/feedback/<code>/mine   this respondent's own answers
// The URL carries only the public code. The respondent is in the Authorization header: `Participant <token>`, which
// the room DO turns into a per-room HMAC (R8), or `Feedback <key>`, a random browser key hashed here (the QR path).
// Every unknown, malformed or recycled-looking code gets the same 404. The SQL is the final authority on the window,
// the shape and the caps; the checks here exist so each refusal has its own answer without a write.
import { normalizeCode, JOIN_CODE_LENGTH } from '../shared/ids.mjs';
import { normaliseFeedbackAnswers } from '../shared/feedback.mjs';
import { readJson } from './request-json.mjs';
import { validLabel } from '../shared/facilitator-label.mjs';

const MAX_BODY_BYTES = 8192; // four 280-character answers in four-byte characters, with room for the JSON
const EDIT_LIMIT = 21; // one send plus 20 edits (session_feedback.revision)
const PARTICIPANT = /^Participant ([A-Za-z0-9_-]{20,256})$/;
const BROWSER_KEY = /^Feedback ([A-Za-z0-9_-]{22,128})$/;
const ROUTE = /^\/api\/v1\/feedback\/([^/]{1,32})(\/mine)?$/;
const STATES = new Set(['open', 'closed', 'not_ended']);

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...extra } });
const fail = (error, status, extra = {}) => json({ error, ...extra }, status);
const notFound = () => fail('not_found', 404);
const unavailable = () => fail('unavailable', 503, { 'retry-after': '5' });
const hex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
const same = (a, b) => JSON.stringify(Object.entries(a ?? {}).sort()) === JSON.stringify(Object.entries(b ?? {}).sort());

export const isFeedbackPath = path => path.startsWith('/api/v1/feedback/');

/** Only what the room was shown, and nothing at all before End. */
function publicFacts(f) {
  if (f.state === 'not_ended') return { state: 'not_ended' };
  return { state: f.state, sessionId: f.session_id, title: f.title, versionNo: f.version_no, audience: f.audience ?? null,
    startedAt: f.started_at ?? null, endedAt: f.ended_at ?? null, closesAt: f.closes_at ?? null,
    objectives: Array.isArray(f.objectives) ? f.objectives : [], formUrl: f.form_url ?? null,
    // The facilitator who ran the room, "Name, Role" fixed at start (Julian, 2026-10-18); gone after the 24 h purge.
    facilitator: validLabel(f.facilitator) ? f.facilitator : null };
}

/** `{ source, hash }` for the caller, or `{ error, status }`. Never reads a credential from the URL. */
async function respondent(request, sessionId, roomFor) {
  const auth = request.headers.get('authorization') ?? '';
  const participant = PARTICIPANT.exec(auth);
  if (participant) {
    const r = await roomFor(sessionId).feedbackRespondent(participant[1], sessionId);
    if (r?.error) return r.status === 401 || r.status === 404 ? { error: 'unauthorised', status: 401 } : { error: 'forbidden', status: 403 };
    if (typeof r?.respondent !== 'string' || !/^[0-9a-f]{64}$/.test(r.respondent)) return { error: 'unavailable', status: 503 };
    return { source: 'joined', hash: `\\x${r.respondent}` };
  }
  const key = BROWSER_KEY.exec(auth);
  if (key) return { source: 'qr', hash: `\\x${hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`qr:${key[1]}`)))}` };
  return { error: 'unauthorised', status: 401 };
}

function parseBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['answers', 'expectedRevision', 'turnstileToken'].includes(k))) return null;
  const { expectedRevision, turnstileToken } = body;
  if (expectedRevision !== undefined && (!Number.isInteger(expectedRevision) || expectedRevision < 1 || expectedRevision > EDIT_LIMIT)) return null;
  if (turnstileToken !== undefined && (typeof turnstileToken !== 'string' || !turnstileToken.length || turnstileToken.length > 2048)) return null;
  const answers = normaliseFeedbackAnswers(body.answers);
  return answers.ok ? { answers: answers.answers, expectedRevision, turnstileToken } : null;
}

/**
 * @param {Request} request
 * @param {{ rpc: { call: Function }, roomFor: (sessionId: string) => any, env: object, attempt: () => Promise<boolean>,
 *   challenge: { configured: boolean, siteKey?: string, verify: (token: string) => Promise<{ ok: boolean, reason?: string }> } }} deps
 */
export async function handleFeedbackApi(request, { rpc, roomFor, attempt, challenge }) {
  const url = new URL(request.url), method = request.method;
  const route = ROUTE.exec(url.pathname.replace(/\/+$/, ''));
  let code = null;
  try { code = route ? normalizeCode(decodeURIComponent(route[1]), JOIN_CODE_LENGTH) : null; } catch { code = null; }
  if (!code) return notFound();
  const mine = Boolean(route[2]);
  if (!(mine ? method === 'GET' : ['GET', 'PUT'].includes(method))) return fail('method_not_allowed', 405);
  if (await attempt()) return fail('rate_limited', 429, { 'retry-after': '60' });

  const resolved = await rpc.call('feedback_resolve', { p_code: code });
  if (!resolved.ok) return unavailable();
  const facts = resolved.data;
  if (!facts || typeof facts !== 'object' || !STATES.has(facts.state)) return notFound();
  if (method === 'GET' && !mine) return json(publicFacts(facts));
  if (facts.state === 'not_ended') return fail('feedback_not_open', 409);
  if (facts.state === 'closed') return mine ? json({ answers: null, revision: 0, closesAt: facts.closes_at ?? null }) : fail('feedback_closed', 409);

  let input = null;
  if (method === 'PUT') {
    const { body, error } = await readJson(request, MAX_BODY_BYTES);
    if (error) return fail(error === 'too_large' ? 'too_large' : 'invalid_feedback', error === 'too_large' ? 413 : 400);
    input = parseBody(body);
    if (!input) return fail('invalid_feedback', 400);
  }
  const who = await respondent(request, facts.session_id, roomFor);
  if (who.error) return fail(who.error, who.status);

  const own = await rpc.call('feedback_mine', { p_session_id: facts.session_id, p_respondent_sha256: who.hash });
  if (!own.ok) return unavailable();
  const saved = own.data && typeof own.data === 'object' ? own.data : null;
  if (mine) return json({ answers: saved?.answers ?? null, revision: saved?.revision ?? 0, closesAt: saved?.closes_at ?? facts.closes_at ?? null });

  const resend = saved && same(saved.answers, input.answers);
  if (saved && !resend) {
    if (saved.revision >= EDIT_LIMIT) return fail('feedback_edit_cap', 409);
    if (input.expectedRevision !== undefined && input.expectedRevision !== saved.revision) return fail('feedback_conflict', 409);
  }
  // Turnstile gates only a browser key's first response; joined phones and edits are never challenged.
  if (!saved && who.source === 'qr' && challenge.configured) {
    if (!input.turnstileToken) return fail('challenge_required', 428, { siteKey: challenge.siteKey });
    const verdict = await challenge.verify(input.turnstileToken);
    if (!verdict.ok) return fail('challenge_failed', 403);
  }
  const args = { p_session_id: facts.session_id, p_respondent_sha256: who.hash, p_source: who.source, p_answers: input.answers };
  if (saved && !resend && input.expectedRevision !== undefined) args.p_expected_revision = input.expectedRevision;
  const written = await rpc.call('feedback_upsert', args);
  if (!written.ok) {
    if (written.kind === 'unavailable') return unavailable();
    // A refusal after the checks above: a new browser key in a full room, or the room changed underneath (closed,
    // edited elsewhere). The page re-reads the code and its own answers to show which.
    return fail(!saved && who.source === 'qr' ? 'feedback_full' : 'feedback_changed', 409);
  }
  const r = written.data ?? {};
  return json({ revision: r.revision, updatedAt: r.updated_at, closesAt: r.closes_at });
}
