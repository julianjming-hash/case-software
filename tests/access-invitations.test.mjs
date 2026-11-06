// Facilitator-UX A4 (CASE-339, CASE-340, CASE-341; plan §3 A4): invitations, Case's own email, the reference peek, acceptance
// from /me and the address purge. Fake RPC, GoTrue and Resend only (hard rule 12); nothing leaves the process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { uuidv7 } from '../src/shared/ids.mjs';
import { POLICIES } from '../src/shared/permissions.mjs';
import { inviteUrl, emailArtUrl, parseInviteFragment, adminAuthUrl, parseRoute } from '../src/shared/urls.mjs';
import { handleInvitationsApi, acceptInvitations, runInvitationPurge, referenceHash } from '../src/worker/invitations.mjs';
import { inviteMessage, inviteHtml, inviteText, sendInviteEmail, INVITATION_DAYS } from '../src/worker/invite-email.mjs';
import { handleFacilitatorApi } from '../src/worker/facilitator-api.mjs';
import { gotrueAdminClient } from '../src/worker/admin/gotrue.mjs';

const WS = uuidv7(), CASE = uuidv7(), INVITATION = uuidv7(), USER = uuidv7(), EXISTING = uuidv7();
const ADMIN = 'admin@example.org', OWNER = 'owner@example.org';
const env = { ADMIN_EMAILS: ADMIN, CASE_PUBLIC_ORIGIN: 'https://case.test' };
const expiresAt = new Date(Date.now() + 90 * 86_400_000).toISOString();
const facts = (args = {}) => ({ invitationId: INVITATION, email: args.p_email ?? 'new@example.org', level: args.p_level ?? 'run', workspaceId: WS,
  workspaceName: 'Northern ICU', caseId: args.p_case_id ?? null, caseTitle: args.p_case_id ? 'Every Breath You Take' : null, inviterName: 'Julian Ming', expiresAt });

/** A database that answers like case_api for a member with `role` (or the admin path), with replies overridable per RPC. */
function fakeRpc({ role = 'owner', policies = POLICIES, grants = [], replies = {} } = {}) {
  const calls = [];
  return { calls, async call(name, args) {
    calls.push([name, args]);
    if (replies[name]) return replies[name](args);
    switch (name) {
      case 'admin_account_active': return { ok: true, data: true };
      case 'get_me': return { ok: true, data: [{ user_id: args.p_user_id, display_name: 'Julian', next_after: null, admin: args.p_admin === true,
        memberships: args.p_admin ? [{ workspace_id: WS, slug: 'ws', name: 'Northern ICU', role: 'admin', policies }] : role ? [{ workspace_id: WS, slug: 'ws', name: 'Northern ICU', role, policies }] : [],
        grants: grants.map(g => ({ workspace_id: WS, workspace_name: 'Northern ICU', title: 'T', policies, ...g })) }] };
      case 'admin_read_profiles': return { ok: true, data: [] };
      case 'create_invitation': return { ok: true, data: { outcome: 'created', ...facts(args) } };
      case 'resend_invitation': return { ok: true, data: { outcome: 'resend', ...facts() } };
      case 'record_invitation_delivery': return { ok: true, data: { outcome: 'recorded', sendState: args.p_outcome } };
      case 'revoke_invitation': return { ok: true, data: { outcome: 'revoked' } };
      case 'list_invitations': return { ok: true, data: { invitations: [{ ...facts(), status: 'pending', sendState: 'sent', sendCount: 1, createdAt: new Date().toISOString(), inviterKind: 'admin' }], nextAfter: null } };
      case 'peek_invitation': return { ok: true, data: [] };
      default: return { ok: false, kind: 'bad_request', status: 400, code: null };
    }
  } };
}
function fakeGotrue({ existing = null, create = null } = {}) {
  const calls = [];
  return { calls, async findUserByEmail(email) { calls.push(['find', email]); return { ok: true, user: existing && existing.email === email ? existing : null }; },
    async createUser(email) { calls.push(['create', email]); return create ? create(email) : { ok: true, userId: uuidv7() }; } };
}
function fakeResend({ status = 200, retryAfter = null } = {}) {
  const sent = [];
  return { sent, fetchImpl: async (url, init) => {
    sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    let read = false;
    const body = new ReadableStream({ pull() { read = true; } }, { highWaterMark: 0 });
    sent.at(-1).bodyRead = () => read;
    return new Response(body, { status, headers: retryAfter ? { 'retry-after': retryAfter } : {} });
  } };
}
const who = email => async () => ({ userId: USER, email, sessionId: uuidv7() });
const post = (path, body) => new Request(`https://case.test/api/v1${path}`, { method: 'POST',
  headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function call(request, { rpc = fakeRpc(), gotrue = fakeGotrue(), email = ADMIN, resend = fakeResend(), keyed = true, peekLimited } = {}) {
  const response = await handleInvitationsApi(request, { env: { ...env, ...(keyed ? { RESEND_INVITE_API_KEY: 're_test_only' } : {}) }, rpc, gotrue,
    verifyUser: who(email), fetchImpl: resend.fetchImpl, peekLimited });
  return { status: response.status, body: await response.json(), rpc, gotrue, resend };
}
const invite = (extra = {}) => post('/invitations', { workspaceId: WS, level: 'run', email: 'New@Example.org ', ...extra });

// ── Email (plan §3 A4, the five assertions) ─────────────────────────────────────────────────────────────────────
const REF = 'Q'.repeat(43);
const message = (extra = {}) => inviteMessage({ ...facts(), ref: REF, origin: 'https://case.iatrogenic.app', ...extra });

test('[AS-204] the email carries exactly one link, /i/#<ref>, and no personal datum in any URL', () => {
  for (const m of [message(), message({ caseTitle: 'Every Breath You Take', caseId: CASE, level: 'edit' })]) {
    const html = inviteHtml(m), text = inviteText(m);
    const urls = [...html.matchAll(/https?:\/\/[^\s"'<>]+/g)].map(x => x[0]);
    assert.deepEqual([...new Set(urls)], [emailArtUrl(), `https://case.iatrogenic.app/i/#${REF}`], 'one fixed branding image and one invitation action');
    assert.equal([...html.matchAll(/<a\s/g)].length, 1);
    assert.deepEqual([...text.matchAll(/https?:\/\/\S+/g)].map(x => x[0]), [`https://case.iatrogenic.app/i/#${REF}`]);
    for (const url of urls) for (const datum of ['new@example.org', 'Julian', 'Northern', INVITATION, WS])
      assert.ok(!url.includes(datum) && !url.includes(encodeURIComponent(datum)), `${datum} in a URL`);
  }
  assert.throws(() => inviteUrl('new@example.org'), 'a reference is 43 base64url characters, never an address');
});

test('[AS-204] the email permits only one fixed branding image, no tracking, and escapes all names', () => {
  const html = inviteHtml(message({ inviterName: '<img src=x onerror=1>', workspaceName: 'A & B' }));
  assert.deepEqual([...html.matchAll(/\bsrc="([^"]+)"/g)].map(m => m[1]), [emailArtUrl()]);
  assert.equal([...html.matchAll(/<img\s/g)].length, 1);
  assert.match(html, /alt="Case mosaic:/);
  assert.doesNotMatch(html, /<script|<link|<iframe|url\(|utm_|@import|data:image|<svg/i);
  assert.match(html, /&lt;img src=x onerror=1&gt;/);
  assert.match(html, /A &amp; B/);
  assert.match(html, /prefers-color-scheme: dark/, 'a dark variant');
});

test('[AS-204] the plain text carries every fact the HTML states, and the expiry is 90 days', () => {
  const m = message();
  const text = inviteText(m);
  for (const fact of ['Julian Ming', 'Northern ICU', 'Can run', 'new@example.org', `/i/#${REF}`, m.expires, 'Not expecting this?', '6-digit code'])
    assert.ok(text.includes(fact), `the plain text lacks ${fact}`);
  assert.equal(INVITATION_DAYS, 90);
  assert.match(text, /works for 90 days, until /);
  assert.equal(m.expires, new Date(expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Australia/Sydney' }));
  assert.match(inviteHtml(m), new RegExp(`90 days, until <b[^>]*>${m.expires}</b>`));
});

test('[AS-209] sending: an idempotency key per send, reply-to the inviter, the response body never read; 429 is email_limit with its retry time', async () => {
  const resend = fakeResend();
  assert.deepEqual(await sendInviteEmail({ env: { RESEND_INVITE_API_KEY: 'k' }, message: message(), replyTo: ADMIN, fetchImpl: resend.fetchImpl }), { ok: true });
  await sendInviteEmail({ env: { RESEND_INVITE_API_KEY: 'k' }, message: message(), replyTo: ADMIN, fetchImpl: resend.fetchImpl });
  const [a, b] = resend.sent;
  assert.equal(a.url, 'https://api.resend.com/emails');
  assert.match(a.headers['idempotency-key'], /^case-invite:[0-9a-f-]{36}$/);
  assert.notEqual(a.headers['idempotency-key'], b.headers['idempotency-key']);
  assert.deepEqual(a.body.reply_to, [ADMIN]); assert.deepEqual(a.body.to, ['new@example.org']);
  assert.equal(a.bodyRead(), false);
  const limited = fakeResend({ status: 429, retryAfter: '120' }), now = Date.parse('2026-11-03T00:00:00Z');
  assert.deepEqual(await sendInviteEmail({ env: { RESEND_INVITE_API_KEY: 'k' }, message: message(), fetchImpl: limited.fetchImpl, nowMs: now }),
    { ok: false, kind: 'email_limit', retryAfter: '2026-11-03T00:02:00.000Z' });
  assert.deepEqual(await sendInviteEmail({ env: {}, message: message(), fetchImpl: limited.fetchImpl }), { ok: false, kind: 'email_not_configured' });
  assert.equal(limited.sent.length, 1, 'no key, no request');
});

// ── Create (P-03 / P-43) ───────────────────────────────────────────────────────────────────────────────────────
test('[AS-209] a new address: the account is created with its email confirmed, the invitation saved by hash, Case sends one email', async () => {
  const r = await call(invite());
  assert.equal(r.status, 201); assert.equal(r.body.outcome, 'sent'); assert.equal(r.body.account, 'new');
  assert.deepEqual(r.gotrue.calls.map(c => c[0]), ['find', 'create']);
  const [, args] = r.rpc.calls.find(([name]) => name === 'create_invitation');
  assert.equal(args.p_email, 'new@example.org'); assert.equal(args.p_invitee_user_id, null);
  assert.match(args.p_ref_hash, /^\\x[0-9a-f]{64}$/, 'only the SHA-256 is stored');
  const link = /\/i\/#([A-Za-z0-9_-]{43})/.exec(r.resend.sent[0].body.text)[1];
  assert.equal(await referenceHash(link), args.p_ref_hash, 'the emailed reference is the one whose hash was saved');
  assert.ok(!JSON.stringify(r.body).includes(link), 'the reference never returns to the inviter');
  assert.deepEqual(r.rpc.calls.find(([name]) => name === 'record_invitation_delivery')[1], { p_invitation_id: INVITATION, p_outcome: 'sent', p_retry_after: null });
});

test('[AS-209] GoTrue is asked to create the account with email_confirm, through the allowlisted admin users URL', async () => {
  const seen = [];
  const gotrue = gotrueAdminClient({ SUPABASE_URL: 'https://auth.test/', SUPABASE_SECRET_KEY: 'sb_secret_test' }, { fetchImpl: async (url, init) => {
    seen.push({ url, method: init.method, body: JSON.parse(init.body) }); return Response.json({ id: EXISTING, email: 'new@example.org' }); } });
  assert.deepEqual(await gotrue.createUser('new@example.org'), { ok: true, userId: EXISTING });
  assert.deepEqual(seen, [{ url: adminAuthUrl('https://auth.test', 'user_create'), method: 'POST', body: { email: 'new@example.org', email_confirm: true } }]);
  const answer = status => gotrueAdminClient({ SUPABASE_URL: 'https://auth.test/', SUPABASE_SECRET_KEY: 'sb_secret_test' }, { fetchImpl: async () => new Response('{}', { status }) }).createUser('new@example.org');
  assert.deepEqual(await answer(422), { ok: false, kind: 'exists' });
  assert.deepEqual(await answer(429), { ok: false, kind: 'rate_limited' });
  assert.deepEqual(await answer(400), { ok: false, kind: 'rejected' });
  assert.deepEqual(await answer(500), { ok: false, kind: 'unknown_outcome' });
  assert.throws(() => adminAuthUrl('https://auth.test', 'user_create', { email: 'x@example.org' }));
});

test('[AS-209] an existing active account is invited without a new account; disabled and soft-deleted accounts are named to an admin, not to an owner', async () => {
  const existing = { id: EXISTING, email: 'new@example.org' };
  const active = await call(invite(), { gotrue: fakeGotrue({ existing }) });
  assert.equal(active.status, 201); assert.equal(active.body.account, 'existing');
  assert.deepEqual(active.gotrue.calls.map(c => c[0]), ['find']);
  assert.equal(active.rpc.calls.find(([name]) => name === 'create_invitation')[1].p_invitee_user_id, EXISTING);
  for (const [field, adminError] of [['disabled_at', 'account_disabled'], ['soft_deleted_at', 'account_deleted']]) {
    const replies = { admin_read_profiles: () => ({ ok: true, data: [{ user_id: EXISTING, disabled_at: null, soft_deleted_at: null, [field]: new Date().toISOString() }] }) };
    const asAdmin = await call(invite(), { rpc: fakeRpc({ replies }), gotrue: fakeGotrue({ existing }) });
    assert.deepEqual([asAdmin.status, asAdmin.body.error], [409, adminError]);
    assert.ok(!asAdmin.rpc.calls.some(([name]) => name === 'create_invitation'), 'nothing is saved');
    const asOwner = await call(invite(), { rpc: fakeRpc({ replies }), gotrue: fakeGotrue({ existing }), email: OWNER });
    assert.deepEqual([asOwner.status, asOwner.body.error], [409, 'account_unavailable']);
  }
});

test('[AS-209] already has access, already invited and the daily cap say so and send nothing', async () => {
  const outcomes = { already_has_access: { outcome: 'already_has_access', role: 'author' }, already_invited: { outcome: 'already_invited', ...facts() },
    cap_reached: { outcome: 'cap_reached', retryAfter: '2026-11-04T00:00:00Z' } };
  for (const [outcome, data] of Object.entries(outcomes)) {
    const r = await call(invite(), { rpc: fakeRpc({ replies: { create_invitation: () => ({ ok: true, data }) } }) });
    assert.equal(r.resend.sent.length, 0, outcome);
    assert.ok(!r.gotrue.calls.some(c => c[0] === 'create'), `${outcome}: no account is created`);
    if (outcome === 'cap_reached') assert.deepEqual([r.status, r.body], [429, { error: 'cap_reached', retryAfter: '2026-11-04T00:00:00Z' }]);
    else assert.deepEqual([r.status, r.body.outcome], [200, outcome]);
  }
});

test('[AS-209] email_not_configured, email_limit and saved_not_sent are saved outcomes with their reasons, never "manual reconciliation"', async () => {
  const unkeyed = await call(invite(), { keyed: false });
  assert.deepEqual([unkeyed.status, unkeyed.body.outcome], [201, 'email_not_configured']);
  assert.equal(unkeyed.rpc.calls.find(([name]) => name === 'record_invitation_delivery')[1].p_outcome, 'email_not_configured');
  const limited = await call(invite(), { resend: fakeResend({ status: 429, retryAfter: '600' }) });
  assert.equal(limited.body.outcome, 'email_limit'); assert.ok(Date.parse(limited.body.retryAfter) > Date.now());
  assert.equal(limited.rpc.calls.find(([name]) => name === 'record_invitation_delivery')[1].p_retry_after, limited.body.retryAfter);
  const failed = await call(invite(), { resend: fakeResend({ status: 500 }) });
  assert.deepEqual([failed.body.outcome, failed.body.reason], ['saved_not_sent', 'email_failed']);
  const busy = await call(invite(), { gotrue: fakeGotrue({ create: () => ({ ok: false, kind: 'rate_limited' }) }) });
  assert.deepEqual([busy.status, busy.body.outcome, busy.body.reason], [201, 'saved_not_sent', 'account_rate_limited']);
  assert.equal(busy.resend.sent.length, 0, 'no email without an account to sign in to');
  const raced = await call(invite(), { gotrue: (() => { const g = fakeGotrue({ create: () => ({ ok: false, kind: 'exists' }) }); let n = 0;
    g.findUserByEmail = async email => (n++ ? { ok: true, user: { id: EXISTING, email } } : { ok: true, user: null }); return g; })() });
  assert.equal(raced.body.outcome, 'sent', 'an account made first by another request is found again');
  for (const r of [unkeyed, limited, failed, busy]) assert.doesNotMatch(JSON.stringify(r.body), /reconciliation/);
});

test('[AS-209] Resend completes a saved-not-sent invitation: a fresh reference, the account made, the email sent', async () => {
  const rpc = fakeRpc();
  const r = await call(post(`/workspaces/${WS}/invitations/${INVITATION}/resend`, {}), { rpc });
  assert.deepEqual([r.status, r.body.outcome], [200, 'sent']);
  const [, args] = rpc.calls.find(([name]) => name === 'resend_invitation');
  assert.match(args.p_ref_hash, /^\\x[0-9a-f]{64}$/);
  assert.deepEqual(r.gotrue.calls.map(c => c[0]), ['find', 'create']);
  for (const [outcome, status, error] of [['ended', 409, 'invitation_ended'], ['cap_reached', 429, 'cap_reached']]) {
    const ended = await call(post(`/workspaces/${WS}/invitations/${INVITATION}/resend`, {}), { rpc: fakeRpc({ replies: { resend_invitation: () => ({ ok: true, data: { outcome } }) } }) });
    assert.deepEqual([ended.status, ended.body.error], [status, error]); assert.equal(ended.resend.sent.length, 0);
  }
  const revoked = await call(post(`/workspaces/${WS}/invitations/${INVITATION}/revoke`, {}));
  assert.deepEqual([revoked.status, revoked.body], [200, { outcome: 'revoked' }]);
  const gone = await call(post(`/workspaces/${WS}/invitations/${INVITATION}/revoke`, {}), { rpc: fakeRpc({ replies: { revoke_invitation: () => ({ ok: true, data: { outcome: 'ended' } }) } }) });
  assert.deepEqual([gone.status, gone.body.error], [409, 'invitation_ended']);
});

test('[AS-209] who may invite: an owner only under managers_invite and never as owner; a case is shared to run below Can manage', async () => {
  const owner = { email: OWNER };
  assert.equal((await call(invite(), { ...owner, rpc: fakeRpc() })).status, 201);
  assert.equal((await call(invite(), { ...owner, rpc: fakeRpc({ policies: { ...POLICIES, managers_invite: false } }) })).status, 403);
  assert.equal((await call(invite({ level: 'manage' }), { ...owner, rpc: fakeRpc() })).status, 403);
  assert.equal((await call(invite({ level: 'manage' }))).status, 201, 'an administrator invites an owner');
  assert.equal((await call(invite(), { ...owner, rpc: fakeRpc({ role: 'author' }) })).status, 403);
  const runner = { email: OWNER, rpc: fakeRpc({ role: null, grants: [{ case_id: CASE, level: 'run' }], policies: { ...POLICIES, runners_share: true } }) };
  assert.equal((await call(invite({ caseId: CASE }), runner)).status, 201);
  assert.equal((await call(invite({ caseId: CASE, level: 'edit' }), { ...runner, rpc: fakeRpc({ role: null, grants: [{ case_id: CASE, level: 'run' }], policies: { ...POLICIES, runners_share: true } }) })).status, 403);
  assert.equal((await call(invite({ caseId: CASE, level: 'manage' }))).status, 400, 'Can manage is never a case grant');
  const nobody = await call(invite(), { email: OWNER, rpc: fakeRpc({ role: null }) });
  assert.equal(nobody.status, 403); assert.equal(nobody.gotrue.calls.length, 0, 'GoTrue is never asked for a refused inviter');
  for (const bad of [{ email: 'a@b' }, { email: 'x@example.org', extra: 1 }, { level: 'admin' }, { workspaceId: 'nope' }])
    assert.equal((await call(invite(bad))).status, 400, JSON.stringify(bad));
});

test('[AS-209] an invitation list reads one workspace (P-44) and never returns a reference or its hash', async () => {
  const r = await handleInvitationsApi(new Request(`https://case.test/api/v1/workspaces/${WS}/invitations`, { headers: { authorization: 'Bearer t' } }),
    { env, rpc: fakeRpc(), gotrue: fakeGotrue(), verifyUser: who(ADMIN) });
  const body = await r.json();
  assert.equal(r.status, 200); assert.equal(body.invitations[0].email, 'new@example.org');
  assert.doesNotMatch(JSON.stringify(body), /ref|hash/i);
  const refused = await handleInvitationsApi(new Request(`https://case.test/api/v1/workspaces/${WS}/invitations`, { headers: { authorization: 'Bearer t' } }),
    { env, rpc: fakeRpc({ role: 'author' }), gotrue: fakeGotrue(), verifyUser: who(OWNER) });
  assert.equal(refused.status, 403);
});

// ── Peek (P-46), acceptance, purge ────────────────────────────────────────────────────────────────────────────
test('[P-46] [AS-208] the peek takes the reference in a body, asks SQL by its hash, and an ended reference answers nothing', async () => {
  const ref = 'A'.repeat(43);
  const live = fakeRpc({ replies: { peek_invitation: () => ({ ok: true, data: [{ email: 'new@example.org', inviter_name: 'Julian Ming', workspace_name: 'Northern ICU', case_title: null, level: 'run' }] }) } });
  const r = await handleInvitationsApi(post('/invitations/peek', { ref }), { env, rpc: live });
  assert.deepEqual([r.status, await r.json()], [200, { invitation: { email: 'new@example.org', inviterName: 'Julian Ming', workspaceName: 'Northern ICU', caseTitle: null, level: 'run' } }]);
  assert.deepEqual(live.calls, [['peek_invitation', { p_ref_hash: await referenceHash(ref) }]], 'no sign-in, and only the hash reaches SQL');
  const ended = await handleInvitationsApi(post('/invitations/peek', { ref }), { env, rpc: fakeRpc() });
  assert.deepEqual(await ended.json(), { invitation: null });
  assert.equal((await handleInvitationsApi(post('/invitations/peek', { ref: 'new@example.org' }), { env, rpc: fakeRpc() })).status, 400);
  const limited = fakeRpc();
  assert.equal((await handleInvitationsApi(post('/invitations/peek', { ref }), { env, rpc: limited, peekLimited: async () => true })).status, 429);
  assert.equal(limited.calls.length, 0, 'a limited peek never reaches SQL');
  const query = await handleInvitationsApi(new Request(`https://case.test/api/v1/invitations/peek?ref=${ref}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), { env, rpc: fakeRpc() });
  assert.equal(query.status, 400, 'a reference in a query string is refused');
  assert.equal(parseInviteFragment(`#${ref}`), ref); assert.equal(parseInviteFragment('#x@y.z'), null);
  assert.deepEqual(parseRoute('/i/'), { route: 'invite' });
});

test('[AS-204] /me accepts the verified address\'s invitations first and answers only what is new or raised', async () => {
  const rows = [{ ...facts(), change: 'new' }, { ...facts({ p_case_id: CASE, p_level: 'edit' }), change: 'raised' }, { ...facts(), change: 'unchanged' }].map(row => { const { email, ...rest } = row; return rest; });
  const rpc = fakeRpc({ replies: { accept_invitations: () => ({ ok: true, data: rows }) } });
  const response = await handleFacilitatorApi(new Request('https://case.test/api/v1/me', { headers: { authorization: 'Bearer t' } }),
    { env: {}, rpc, verifyUser: async () => ({ userId: USER, email: 'New@Example.org', sessionId: uuidv7() }) });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.joined.map(row => [row.change, row.level, row.caseId]), [['new', 'run', null], ['raised', 'edit', CASE]]);
  const names = rpc.calls.map(([name]) => name);
  assert.ok(names.indexOf('accept_invitations') < names.indexOf('get_me'), 'acceptance runs before the read');
  assert.deepEqual(rpc.calls.find(([name]) => name === 'accept_invitations')[1], { p_user_id: USER, p_email: 'new@example.org' });
  assert.deepEqual(await acceptInvitations({ call: async () => { throw new Error('down'); } }, { userId: USER, email: 'a@example.org' }), [], 'a failure never blocks /me');
  const later = await handleFacilitatorApi(new Request(`https://case.test/api/v1/me?after=${WS}`, { headers: { authorization: 'Bearer t' } }),
    { env: {}, rpc, verifyUser: async () => ({ userId: USER, email: 'new@example.org', sessionId: uuidv7() }) });
  assert.deepEqual((await later.json()).joined, []);
});

test('[AS-208] the admin purge sweep nulls ended invitations\' addresses (purge_invitation_addresses on ADMIN_PURGE_CRON)', async () => {
  const calls = [];
  assert.deepEqual(await runInvitationPurge({ rpc: { call: async (name, args) => { calls.push([name, args]); return { ok: true, data: 3 }; } } }), { ok: true, purged: 3 });
  assert.deepEqual(calls, [['purge_invitation_addresses', {}]]);
  assert.deepEqual(await runInvitationPurge({ rpc: { call: async () => ({ ok: false }) } }), { ok: false });
  const index = readFileSync(new URL('../src/worker/index.mjs', import.meta.url), 'utf8');
  const sweep = index.slice(index.indexOf('controller?.cron === ADMIN_PURGE_CRON'), index.indexOf('const run = controller?.cron'));
  assert.match(sweep, /runInvitationPurge\(/, 'the purge runs in the ADMIN_PURGE_CRON sweep');
});

test('[AS-204] the first-sign-in landing says what is new: a new place, a raised level, and a shared case it opens', async () => {
  const { joinedLine } = await import('../src/client/invite-landing.mjs');
  const text = parts => parts.map(part => typeof part === 'string' ? part : part.strong).join('');
  const { inviteWords } = await import('../src/client/invite-page.mjs');
  assert.equal(text(joinedLine({ change: 'new', level: 'run', workspaceName: 'Northern ICU', caseId: null, inviterName: 'Julian Ming' })),
    'You’ve joined Northern ICU with Can run access, invited by Julian Ming.');
  assert.equal(text(joinedLine({ change: 'raised', level: 'edit', workspaceName: 'Northern ICU', caseId: null, inviterName: 'Julian Ming' })),
    'Your access is now Can edit in Northern ICU, invited by Julian Ming.');
  assert.equal(text(joinedLine({ change: 'new', level: 'run', workspaceName: 'Northern ICU', caseId: CASE, caseTitle: 'Every Breath You Take', inviterName: 'Julian Ming' })),
    'Julian Ming shared Every Breath You Take with you (Can run) in Northern ICU.');
  assert.equal(text(joinedLine({ change: 'raised', level: 'edit', caseId: CASE, caseTitle: 'Every Breath You Take' })), 'Your access to Every Breath You Take is now Can edit.');
  assert.deepEqual(inviteWords({ caseTitle: null, workspaceName: 'Northern ICU', inviterName: 'Julian Ming', level: 'run' }),
    { heading: 'Join Northern ICU', lead: 'Julian Ming invited you with Can run access.' });
});
