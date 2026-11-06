// Participant feedback results (card 40 + feedback integration slice 9; docs/plans/PARTICIPANT-FEEDBACK.md §6–§8): the
// P-37, P-38 and P-39 routes against the fake PostgREST, the shared result shapes, and the three results views, drawn
// as text-only DOM and as rows for the tagged PDF writer, read back through its structure tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from '../src/shared/ids.mjs';
import { rpcClient } from '../src/worker/rpc.mjs';
import { fakePostgrest } from './helpers/fake-postgrest.mjs';
import { readPdf } from './helpers/pdf-read.mjs';
import { handleFeedbackResults } from '../src/worker/feedback-results.mjs';
import { handleAdminRequest } from '../src/worker/admin/handler.mjs';
import { COMMENT_WARNING, validSessionFeedback, validCaseFeedback, validAdminFeedback } from '../src/shared/feedback-results.mjs';
import { feedbackSection, feedbackPdfRows, caseFeedbackSection } from '../src/client/feedback-results.mjs';
import { feedbackCountText } from '../src/client/ended-summary.mjs';
import { sessionPdf } from '../src/client/session-pdf.mjs';
import { FONT } from '../src/client/session-pdf-font.mjs';

const W = uuidv7(), OTHER = uuidv7(), S = uuidv7(), C = uuidv7();
const STARTER = uuidv7(), AUTHOR = uuidv7(), FACILITATOR = uuidv7(), ADMIN = uuidv7(), OUTSIDER = uuidv7();
const ROLE = { [STARTER]: 'facilitator', [AUTHOR]: 'author', [FACILITATOR]: 'facilitator' };
const EMAIL = 'fr-admin@example.org';
const env = { SUPABASE_URL: 'https://postgrest.test/', SUPABASE_SECRET_KEY: `sb_secret_${uuidv7()}`, ADMIN_EMAILS: EMAIL, CASE_PUBLIC_ORIGIN: 'https://case.test' };
const ratings = () => ({ session: { counts: [0, 0, 0, 1, 1], n: 2 }, case: { counts: [0, 1, 0, 1, 0], n: 2 }, app: { counts: [0, 0, 1, 0, 1], n: 2 } });
const comments = () => [{ kind: 'takeaway', about: 'session', body: 'Call for help sooner.' }, { kind: 'takeaway', about: 'session', body: 'Dr Rivers explained it well.' },
  { kind: 'improve', about: 'session', body: 'Shorter intro.' }, { kind: 'improve', about: 'case', body: 'More time on the ECG 🙂' }, { kind: 'improve', about: 'app', body: 'Phones were slow to load.' }];
/** What case_api.session_feedback_summary returns (db/tests/feedback-results.test.sql pins the SQL side). */
const sessionRow = (own = true) => ({ session: { id: S, workspaceId: W, caseId: C, versionNo: 2, title: 'Diving Deeper', date: '2026-10-19', own },
  closed: false, responses: { total: 4, joined: 2, qr: 2 }, ratings: ratings(), comments: comments() });
const caseRow = () => ({ case: { id: C, workspaceId: W, versionNo: 2, title: 'Diving Deeper' }, rooms: 2, responses: { total: 5, joined: 3, qr: 2 },
  ratings: { case: { counts: [0, 1, 0, 1, 1], n: 3 } }, comments: comments().filter(c => c.kind === 'takeaway' || c.about === 'case'), commentsTotal: 3 });

function world({ session = sessionRow(), kase = caseRow(), admin = null, fault = null } = {}) {
  const fake = fakePostgrest();
  // A fault answers only the results read, as the database's own refusal would.
  const fetchImpl = async (input, init) => fault && /feedback_summary$/.test(new URL(input).pathname)
    ? new Response(JSON.stringify({ code: fault.code, message: 'refused', details: null, hint: null }), { status: fault.status, headers: { 'content-type': 'application/json' } })
    : fake.fetchImpl(input, init);
  const rpc = rpcClient(env, { fetchImpl });
  fake.replies.set('admin_account_active', true);
  fake.replies.set('get_me', args => [{ user_id: args.p_user_id, display_name: null, next_after: null, admin: args.p_admin === true,
    memberships: args.p_admin ? [{ workspace_id: W, slug: 'fr', name: 'FR', role: 'admin' }]
      : ROLE[args.p_user_id] ? [{ workspace_id: W, slug: 'fr', name: 'FR', role: ROLE[args.p_user_id] }]
        : args.p_user_id === OUTSIDER ? [{ workspace_id: OTHER, slug: 'o', name: 'O', role: 'owner' }] : [] }]);
  fake.replies.set('session_feedback_summary', () => session);
  fake.replies.set('case_feedback_summary', () => kase);
  fake.replies.set('admin_feedback_page', args => admin ? admin(args) : { scope: 'app', next: null,
    result: { responses: { total: 6, joined: 4, qr: 2 }, ratings: { app: { counts: [0, 0, 1, 0, 1], n: 2 } }, months: [{ month: '2026-10', counts: [0, 0, 1, 0, 1], n: 2 }],
      comments: [{ kind: 'improve', about: 'app', body: 'Phones were slow to load.', date: '2026-10-19' }] } });
  return { fake, rpc };
}
const userFor = id => async () => (id ? { userId: id, email: id === ADMIN ? EMAIL : 'someone@example.org', sessionId: uuidv7() } : null);
const get = (path, init = {}) => new Request(`https://case.test/api/v1${path}`, { method: 'GET', headers: { authorization: 'Bearer jwt' }, ...init });
const roomPath = `/portfolio/sessions/${S}/feedback`, casePath = `/cases/${C}/versions/2/feedback`;
async function call(path, who, options = {}, init = {}) {
  const { rpc, fake } = world(options);
  const response = await handleFeedbackResults(get(path, init), { env, rpc, verifyUser: userFor(who) });
  return { response, fake, body: response ? await response.json().catch(() => null) : null };
}

test('[P-37] a room\'s feedback reaches its starter and the admin only, without the workspace, the starter flag or any hash', async () => {
  const ok = await call(roomPath, STARTER);
  assert.equal(ok.response.status, 200);
  assert.equal(ok.response.headers.get('cache-control'), 'no-store');
  assert.equal(ok.response.headers.get('referrer-policy'), 'no-referrer');
  const { workspaceId, own, ...session } = sessionRow().session;
  assert.deepEqual(ok.body, { ...sessionRow(), session });
  assert.ok(validSessionFeedback(ok.body));
  assert.equal((await call(roomPath, ADMIN, { session: sessionRow(false) })).response.status, 200, 'the admin reads any room');
  assert.equal((await call(roomPath, FACILITATOR, { session: sessionRow(false) })).response.status, 403, 'a member who did not start the room');
  assert.equal((await call(roomPath, AUTHOR, { session: sessionRow(false) })).response.status, 403, 'an author who did not start the room');
  assert.equal((await call(roomPath, OUTSIDER)).response.status, 403, 'another workspace, even if SQL let it through');
  assert.equal((await call(roomPath, null)).response.status, 401);
  assert.equal((await call(roomPath, STARTER, { fault: { status: 400, code: '42501' } })).response.status, 403, 'SQL refusal');
  assert.equal((await call(roomPath, STARTER, { fault: { status: 400, code: 'P0002' } })).response.status, 404);
  assert.equal((await call(roomPath, STARTER, {}, { method: 'POST' })).response.status, 405);
  assert.equal((await call(`${roomPath}?sessionId=${S}`, STARTER)).response.status, 400, 'nothing in the query string');
  assert.equal((await call(`/portfolio/sessions/not-a-room/feedback`, STARTER)).response.status, 400);
  assert.equal(await handleFeedbackResults(get('/portfolio/record'), { env, rpc: world().rpc, verifyUser: userFor(STARTER) }), null, 'other routes pass through');
});

test('[P-37] a result with a respondent hash, a participant id, an average or a timestamp is refused, not forwarded', async () => {
  const poison = [
    r => { r.comments[0].respondent_sha256 = '\\x' + 'a'.repeat(64); },
    r => { r.comments[0].participantId = uuidv7(); },
    r => { r.ratings.session.average = 4.5; },
    r => { r.session.date = '2026-10-19T08:15:00Z'; },
    r => { r.ratings.case.counts = [0, 1, 0, 1]; },
    r => { r.ratings.case.n = 3; },
    r => { r.responses.total = 5; },
    r => { r.comments[0].body = 'x'.repeat(281); },
    r => { r.comments.push({ kind: 'takeaway', about: 'app', body: 'A take-away is about the session.' }); },
    r => { r.session.id = uuidv7(); },
  ];
  for (const change of poison) {
    const row = sessionRow(); change(row);
    assert.equal((await call(roomPath, STARTER, { session: row })).response.status, 503, JSON.stringify(row).slice(0, 120));
  }
});

test('[P-38] pooled case-content feedback per version reaches owners, authors and the admin, never a facilitator', async () => {
  const ok = await call(casePath, AUTHOR);
  assert.equal(ok.response.status, 200);
  const { workspaceId, ...kase } = caseRow().case;
  assert.deepEqual(ok.body, { ...caseRow(), case: kase });
  assert.ok(validCaseFeedback(ok.body));
  assert.equal((await call(casePath, ADMIN)).response.status, 200);
  assert.equal((await call(casePath, FACILITATOR)).response.status, 403, 'the Worker refuses even when SQL would answer');
  assert.equal((await call(casePath, OUTSIDER)).response.status, 403);
  assert.equal((await call(casePath, null)).response.status, 401);
  assert.equal((await call(`/cases/${C}/versions/0/feedback`, AUTHOR)).response.status, 400);
  const sessionImprovement = caseRow(); sessionImprovement.comments.push({ kind: 'improve', about: 'app', body: 'Not for authors.' }); sessionImprovement.commentsTotal = 4;
  assert.equal((await call(casePath, AUTHOR, { kase: sessionImprovement })).response.status, 503, 'only take-aways and case improvements reach authors');
  const other = caseRow(); other.case.versionNo = 3;
  assert.equal((await call(casePath, AUTHOR, { kase: other })).response.status, 503, 'the version asked for, only');
});

test('[P-39] Administration → Feedback is admin only, with an exact filter and a cursor bound to it', async () => {
  const admin = async (who, body, options = {}) => {
    const { rpc, fake } = world(options);
    const response = await handleAdminRequest(new Request('https://case.test/api/v1/admin/feedback', { method: 'POST',
      headers: { authorization: 'Bearer jwt', 'content-type': 'application/json', origin: 'https://case.test' }, body: JSON.stringify(body) }),
    { env, rpc, verifyUser: userFor(who), nowMs: () => Date.now() });
    return { status: response.status, body: await response.json().catch(() => null), fake };
  };
  const first = await admin(ADMIN, { filter: { scope: 'app' }, after: null });
  assert.equal(first.status, 200);
  assert.ok(validAdminFeedback(first.body));
  assert.equal(first.body.nextAfter, null);
  const call = first.fake.requests.find(r => r.name === 'admin_feedback_page');
  assert.deepEqual(call.args, { p_user_id: ADMIN, p_filter: { scope: 'app' }, p_after: 0, p_admin: true, p_admin_email: EMAIL });
  assert.equal((await admin(STARTER, { filter: { scope: 'app' }, after: null })).status, 403);
  assert.equal((await admin(null, { filter: { scope: 'app' }, after: null })).status, 401);
  for (const filter of [{ scope: 'everything' }, { scope: 'app', sessionId: S }, { scope: 'session' }, { scope: 'case', caseId: C, versionNo: 0 }])
    assert.equal((await admin(ADMIN, { filter, after: null })).status, 400, JSON.stringify(filter));
  // A full page carries an opaque cursor; it is refused for another filter or another admin.
  const page = args => ({ scope: 'rooms', next: args.p_after + 20, result: { rooms: Array.from({ length: 20 }, (_, i) => ({ sessionId: uuidv7(), caseId: C, versionNo: 1, title: `Room ${i}`, date: '2026-10-19', responses: 3 })) } });
  const full = await admin(ADMIN, { filter: { scope: 'rooms' }, after: null }, { admin: page });
  assert.equal(full.status, 200); assert.equal(typeof full.body.nextAfter, 'string');
  const second = await admin(ADMIN, { filter: { scope: 'rooms' }, after: full.body.nextAfter }, { admin: page });
  assert.equal(second.status, 200);
  assert.equal(second.fake.requests.find(r => r.name === 'admin_feedback_page').args.p_after, 20);
  assert.equal((await admin(ADMIN, { filter: { scope: 'app' }, after: full.body.nextAfter })).status, 400, 'a cursor for another filter');
  const room = await admin(ADMIN, { filter: { scope: 'session', sessionId: S }, after: null }, { admin: () => ({ scope: 'session', next: null, result: (({ session: { workspaceId, own, ...s }, ...rest }) => ({ ...rest, session: s }))(sessionRow()) }) });
  assert.equal(room.status, 200); assert.equal(room.body.result.comments.length, 5);
  const leaky = await admin(ADMIN, { filter: { scope: 'app' }, after: null }, { admin: () => ({ scope: 'app', next: null, result: { responses: { total: 1, joined: 1, qr: 0 }, ratings: { app: { counts: [0, 0, 0, 0, 1], n: 1 } }, months: [], comments: [{ kind: 'improve', about: 'app', body: 'x', date: '2026-10-19', respondent: 'y' }] } }) });
  assert.equal(leaky.status, 503);
});

test('[AS feedback results] the shared shapes refuse averages and private fields, and every comment view carries the names warning', () => {
  assert.equal(COMMENT_WARNING, 'Written by participants. Comments may contain names.');
  const { workspaceId, own, ...session } = sessionRow().session;
  const result = { ...sessionRow(), session };
  assert.ok(validSessionFeedback(result));
  assert.equal(validSessionFeedback(sessionRow()), false, 'the internal row is not the public shape');
  assert.ok(validSessionFeedback(sessionRow(), { internal: true }));
  assert.equal(validSessionFeedback({ ...result, average: 4 }), false);
  assert.equal(validCaseFeedback({ ...caseRow(), case: { id: C, versionNo: 2, title: 'Diving Deeper' }, commentsTotal: 2 }), false, 'more comments than the total');
});

// A small text-only DOM: textContent is a setter; nothing here offers innerHTML.
function fakeDocument() {
  class Node {
    constructor(tag, text = '') { this.tagName = tag; this.children = []; this.own = text; this.attributes = {}; this.style = {}; this.className = ''; }
    set textContent(value) { this.own = String(value); this.children = []; }
    get textContent() { return this.own + this.children.map(c => c.textContent).join(''); }
    set innerHTML(_) { throw new Error('HTML sink used'); }
    append(...nodes) { for (const n of nodes) this.children.push(typeof n === 'string' ? new Node(null, n) : n); }
    setAttribute(k, v) { this.attributes[k] = String(v); }
    addEventListener() {}
    all() { return [this, ...this.children.flatMap(c => c.all())]; }
  }
  return { createElement: tag => new Node(tag), createTextNode: text => new Node(null, text) };
}
function withDocument(fn) {
  const previous = globalThis.document; globalThis.document = fakeDocument();
  try { return fn(); } finally { globalThis.document = previous; }
}

test('[AS feedback results] the room view shows counts per value 1–5 with n, the joined/QR split and the warning, never an average or a score colour', () => {
  const { workspaceId, own, ...session } = sessionRow().session;
  const result = { ...sessionRow(), session };
  withDocument(() => {
    const root = feedbackSection(result), text = root.textContent;
    // Room PDFs v2: the three ratings are named by subject; Take home, then each rating's comments under their subject.
    for (const want of ['Feedback', '4 responses', '2 joined phones', '2 by QR code', 'The session', 'n = 2', 'Not useful', 'Very useful',
      'Take home', 'Call for help sooner.', 'Comments', 'The case', 'More time on the ECG 🙂', COMMENT_WARNING]) assert.ok(text.includes(want), want);
    assert.doesNotMatch(text, /average|mean|\b4\.5\b/i);
    const bars = root.all().filter(n => n.className.includes('feedback-bar-fill'));
    assert.equal(bars.length, 15, 'five values for each of the three questions');
    assert.ok(bars.every(b => b.style.background === undefined && !/color|background/.test(JSON.stringify(b.attributes))), 'no score colour');
    const empty = feedbackSection({ ...result, responses: { total: 0, joined: 0, qr: 0 }, ratings: { session: { counts: [0, 0, 0, 0, 0], n: 0 }, case: { counts: [0, 0, 0, 0, 0], n: 0 }, app: { counts: [0, 0, 0, 0, 0], n: 0 } }, comments: [] });
    assert.match(empty.textContent, /No feedback yet/);
    const kase = caseFeedbackSection({ ...caseRow(), case: { id: C, versionNo: 2, title: 'Diving Deeper' } }).textContent;
    for (const want of ['2 sessions', '5 responses', 'The case', 'n = 3', 'Call for help sooner.', 'More time on the ECG 🙂', COMMENT_WARNING]) assert.ok(kase.includes(want), want);
    assert.doesNotMatch(kase, /Phones were slow|Shorter intro|The session/);
  });
});

test('[AS feedback results] the debrief PDF gains a Feedback section that reads back with counts, n, comments and the warning (I5)', () => {
  const { workspaceId, own, ...session } = sessionRow().session;
  const rows = feedbackPdfRows({ ...sessionRow(), session });
  const lines = readPdf(sessionPdf([['H1', 'Diving Deeper'], ...rows], { title: 'Diving Deeper' })).lines.join('\n');
  for (const want of ['Feedback', '4 responses · 2 joined phones · 2 by QR code', 'The session', 'n = 2', 'Call for help sooner.',
    'Dr Rivers explained it well.', 'The case More time on the ECG ?', 'The Case app Phones were slow to load.', COMMENT_WARNING]) assert.ok(lines.includes(want), want);
  assert.doesNotMatch(lines, /average|[0-9a-f]{8}-[0-9a-f]{4}-7/i);
  // The PDF keeps only characters its font draws; the screen keeps the comment as written.
  for (const c of 'abcXYZ019 .,;:!?\'"()-–—‘’“”…·àéïøñßÆ') assert.ok(FONT.map[c.codePointAt(0)], `font lacks ${c}`);
});

test('[R9] the console\'s ended summary line counts feedback so far and nothing else', () => {
  assert.equal(feedbackCountText({ responses: { total: 4, joined: 2, qr: 2 } }), 'Feedback · 4 so far');
  assert.equal(feedbackCountText({ responses: { total: 0, joined: 0, qr: 0 } }), 'Feedback · 0 so far');
  assert.equal(feedbackCountText(null), null);
  assert.equal(feedbackCountText({ responses: { total: -1 } }), null);
});
