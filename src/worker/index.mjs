import {handleIssuesApi,isIssuesPath,sweepIssues} from './issues-api.mjs';
// src/worker/index.mjs: the Case Worker (Phase 1). Stateless routing in front of the Durable Objects.
//
// API contract: docs/plans/2026-10-01-phase-1-room-runtime.md. Every response is no-store and
// no-referrer; tokens travel only in `Authorization: Bearer` (or the first WebSocket frame), never in
// a URL. Request bodies are size-capped before parsing. No nodejs_compat: Web APIs only.
import { uuidv7, newJoinCode, normalizeCode, isUuid, isUuidV7, uuidv7Time, JOIN_CODE_LENGTH, PAIR_CODE_LENGTH } from '../shared/ids.mjs';
import { WIRE_VERSION, MAX_FRAME_BYTES, LONG_POLL_MAX_S, parseJoinRequest, parseUpdatesQuery } from '../shared/wire.mjs';
import { bearer, verifyFacilitatorJwt, AuthUnavailableError, signInKeysReady } from './auth.mjs';
import { handleHealth, HEALTH_RPC_TIMEOUT_MS } from './health.mjs';
import { withSecurityHeaders, buildInfo } from './headers.mjs';
import { clampTtl } from './room-do.mjs';
import { directoryFor, pairsDirectory, limitsFor, clientPrefix, roomFor, CODE_SHARDS } from './directory-do.mjs';
import { rpcClient } from './rpc.mjs';
import { handleBuilderListApi } from './builder-list-api.mjs';
import { handleMediaApi, imageResponse, runMediaSweep } from './media-api.mjs';
import { handleBuilderApi } from './builder-api.mjs';
import { handleBuilderReviewApi } from './builder-review-api.mjs';
import { parseBoundedJson } from '../shared/builder-json.mjs';
import { validateBuilderDocument } from '../shared/builder-document.mjs';
import { validateSlideParts } from '../shared/slide-document.mjs';
import { builderSourceSha256 } from '../shared/builder-metadata.mjs';
import { handleFacilitatorApi } from './facilitator-api.mjs';
import { handleConsolePairApi, publicAuthConfig } from './console-pairs.mjs';
import { handleOwnedRooms } from './owned-rooms.mjs';
import { handleRoomHistory } from './room-history.mjs';
import { handleSessionPortfolio } from './session-portfolio.mjs';
import { handleFeedbackResults } from './feedback-results.mjs';
import { startPublishedRoom, parseFacilitatorOverride } from './published-rooms.mjs';
import { actorFor, mayMintConsole } from './authorize.mjs';
import { ACTIONS } from '../shared/permissions.mjs';
import { log } from './log.mjs';
import { createObserver, observedRpc } from './observability.mjs';
import { handleTelemetry } from './telemetry.mjs';
import { metric } from './metrics.mjs';
import { joinDocumentCsp } from './join-policy.mjs';
import { recoverParticipant } from './participant-recovery.mjs';
import { readJson } from './request-json.mjs';
import { verifyTurnstile, turnstileConfigured } from './turnstile.mjs';
import { handleFeedbackApi, isFeedbackPath } from './feedback-api.mjs';
import { HEALTH_CRONS, HEALTH_THRESHOLDS, runHourlyCatchup, runWeeklyCheck } from './cron-health.mjs';
import { handleAdminRequest } from './admin/handler.mjs';
import { gotrueAdminClient } from './admin/gotrue.mjs';
import { createAdminRooms } from './admin/rooms.mjs';
import { readAdminInventory } from './admin/inventory.mjs';
import { ADMIN_PURGE_CRON, runAdminDeletionSweep } from './admin/sweep.mjs';
import { handleInvitationsApi, runInvitationPurge } from './invitations.mjs';
import { handleCaseAccessApi } from './case-access.mjs';
import { accountActive } from './admin/account-active.mjs';
import { handleRetentionStatus } from './retention-status.mjs';
import { refusedRoomWorkspaces } from './room-workspace-refusal.mjs';
import { requestDeadlineMs, requestTrace, traceStage, withRequestDeadline } from './request-deadline.mjs';

export { RoomDO } from './room-do.mjs';
export { DirectoryDO } from './directory-do.mjs';
export { AlertDO } from './alert-do.mjs';

const MAX_CASE_BYTES = 512 * 1024;
const MAX_SEGMENT_BYTES = 256 * 1024;

async function accountRefusal(user, rpc) {
  const refused = await accountActive(rpc,user.userId);
  return refused ? fail(refused.error,refused.status) : null;
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...extra } });
}
const fail = (error, status, extra = {}) => json({ error, ...extra }, status);
/** An RPC result `{ error, status }` becomes an error response; anything else is passed to `ok`. */
const reply = (r, ok = (x) => json(x)) => (r?.error ? fail(r.error, r.status ?? 400, r.details ? { details: r.details } : r.failedAt !== undefined ? { failedAt: r.failedAt } : {}) : ok(r));

const tooBig = (error) => fail(error, error === 'too_large' ? 413 : error === 'request_timeout' ? 408 : 400);

const room = roomFor; // placed in Oceania (CASE-107)
/** A session id must be a UUIDv7 minted within the last 48 h: anything else never reaches a Durable Object (red team P1-5). */
const SESSION_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const liveSessionId = (id) => isUuidV7(id) && Date.now() - uuidv7Time(id) < SESSION_MAX_AGE_MS && uuidv7Time(id) <= Date.now() + 60_000;
/** Cloudflare rate-limit bindings cut floods before any Durable Object is touched (red team P1-1). Absent in a bare dev setup. */
async function limited(binding, key) {
  if (!binding) return false;
  const { success } = await binding.limit({ key });
  return !success;
}

/** Constant-time comparison of two secrets: both are hashed first, so length and content leak nothing. */
async function sameSecret(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || !given || !expected) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(given)), crypto.subtle.digest('SHA-256', enc.encode(expected))]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// ── network self-test (prototypes/room/check.html; spec red team 2, P1-4) ──
// No room, no state, no token: a socket that echoes, and an HTTP wait that answers after `wait` s.
const CHECK_WS_MAX_MS = 90_000;
const CHECK_ECHO_MAX = 256;
function checkSocket() {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();
  const timer = setTimeout(() => { try { server.close(1000, 'check_complete'); } catch { /* gone */ } }, CHECK_WS_MAX_MS);
  server.addEventListener('message', (e) => {
    if (typeof e.data !== 'string' || e.data.length > CHECK_ECHO_MAX) { try { server.close(1009, 'too_large'); } catch { /* gone */ } return; }
    try { server.send(e.data); } catch { /* closing */ }
  });
  server.addEventListener('close', () => { clearTimeout(timer); try { server.close(1000, 'closed'); } catch { /* gone */ } });
  return new Response(null, { status: 101, webSocket: client });
}

const routes = {
  async fetch(request, env, ctx, trace = null) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');
    const m = (re) => re.exec(path);
    const method = request.method;
    const observer=createObserver(env,ctx),requestRpc=observedRpc(env,observer,{},trace);
    const onProducerAlert=event=> {
      log('facilitator_alert',{reason:event.kind});
      // The injected generic RPC hook already reported forbidden/missing-function results.
      if(event.kind !== 'rpc_forbidden') return observer.alert(event);
    };
    try {
      if (path === '/api/v1/telemetry') return handleTelemetry(request,env);
      if (path === '/api/v1/version' && method === 'GET') return json(buildInfo(env));
      if (path === '/api/v1/health' && method === 'GET') return handleHealth({
        limited: () => limited(env.CHECK_ATTEMPTS, clientPrefix(request.headers.get('cf-connecting-ip'))),
        rpc: () => observedRpc(env, observer, { timeoutMs: HEALTH_RPC_TIMEOUT_MS }, trace),
        keysReady: () => signInKeysReady(env) });
      if (path === '/api/v1/config' && method === 'GET') {
        const config = publicAuthConfig(env);
        return config ? json(config) : fail('auth_unavailable', 503);
      }
      if(isIssuesPath(path))return handleIssuesApi(request,{env,rpc:requestRpc,roomFor:id=>room(env,id),attempt:()=>limited(env.JOIN_ATTEMPTS,`issues:${clientPrefix(request.headers.get('cf-connecting-ip'))}`)});
      if (path === '/api/v1/admin' || path.startsWith('/api/v1/admin/')) {
        return handleAdminRequest(request,{env,rpc:requestRpc,
          gotrue:() => gotrueAdminClient(env,{caseOrigin:env.CASE_PUBLIC_ORIGIN}),
          rooms:{...createAdminRooms({rpc:requestRpc,roomFor:sessionId => roomFor(env,sessionId)}),
            read:input=>readAdminInventory({...input,directoryFor:shard=>directoryFor(env,shard),
              roomFor:sessionId=>roomFor(env,sessionId),gotrue:gotrueAdminClient(env,{caseOrigin:env.CASE_PUBLIC_ORIGIN})})}});
      }
      if (path.startsWith('/api/v1/console-pairs')) {
        let consoleUser;
        if (method === 'POST' && ['/api/v1/console-pairs/preview','/api/v1/console-pairs/approve'].includes(path)) {
          consoleUser = await verifyFacilitatorJwt(bearer(request),env);
          if (!consoleUser) return fail('unauthorised',401);
          const denied = await accountRefusal(consoleUser,requestRpc);
          if (denied) return denied;
        }
        const consolePair = await handleConsolePairApi(request, { env, pairs: pairsDirectory(env), roomFor: room,
          verifyUser:async () => consoleUser,
          mayMint:(actor,roomView,action,sessionId) => mayMintConsole(requestRpc,actor,roomView,action,env,onProducerAlert,sessionId),
          rateLimited: candidate => limited(env.PAIR_CREATE, clientPrefix(candidate.headers.get('cf-connecting-ip'))) });
        if (consolePair) return consolePair;
      }
      // Invitations (CASE-339 to CASE-341): create, list, resend, revoke and the rate-limited reference peek.
      if (path === '/api/v1/invitations' || path.startsWith('/api/v1/invitations/') || /^\/api\/v1\/workspaces\/[^/]+\/invitations(?:\/|$)/.test(path)) {
        const invitations = await handleInvitationsApi(request, { env, rpc: requestRpc, onAlert: onProducerAlert,
          gotrue: () => gotrueAdminClient(env, { caseOrigin: env.CASE_PUBLIC_ORIGIN }),
          peekLimited: candidate => limited(env.INVITE_PEEK, clientPrefix(candidate.headers.get('cf-connecting-ip'))) });
        if (invitations) return invitations;
      }
      // Share and "Shared with you" (CASE-336, plan §3 A6): a case's access list, ending a grant, and the caller's shared cases.
      if (path === '/api/v1/shared-cases' || /^\/api\/v1\/cases\/[^/]+\/access(?:\/|$)/.test(path)) {
        const sharing = await handleCaseAccessApi(request, { env, rpc: requestRpc, onAlert: onProducerAlert });
        if (sharing) return sharing;
      }
      if (path === '/api/v1/me/rooms') {
        const owned = await handleOwnedRooms(request, { env,rpc:requestRpc,onAlert:onProducerAlert });
        if (owned) return owned;
      }
      // Card 40 + feedback slice 9: a room's feedback (P-37) and a version's pooled case feedback (P-38).
      const feedbackResults = await handleFeedbackResults(request, { env, rpc:requestRpc, onAlert:onProducerAlert });
      if (feedbackResults) return feedbackResults;
      const portfolio = await handleSessionPortfolio(request, { env, rpc:requestRpc, onAlert:onProducerAlert });
      if (portfolio) return portfolio;
      const history = await handleRoomHistory(request, { env,rpc:requestRpc,onAlert:onProducerAlert });
      if (history) return history;
      const draftList = await handleBuilderListApi(request, { env, rpc:requestRpc, onAlert:onProducerAlert });
      if (draftList) return draftList;
      const media = await handleMediaApi(request, { env, rpc:requestRpc, onAlert:onProducerAlert });
      if (media) return media;
      const builder = await handleBuilderApi(request, { env, rpc:requestRpc, onAlert:onProducerAlert,
        // CASE-214: drafts and checkpoints admit schema 3 (slides). Review and publish refuse it until slide rooms ship.
        parseJson:parseBoundedJson, validateDraft:(document, metadata, options) => validateBuilderDocument(document, metadata, { ...options, validateSlides: validateSlideParts }),
        hashSources:async metadata => {
          const sources = metadata?.sources ?? [];
          return Array.isArray(sources) && (await Promise.all(sources.map(async source =>
            typeof source?.text === 'string' && typeof source.sha256 === 'string' && source.sha256 === await builderSourceSha256(source.text)))).every(Boolean);
        } });
      if (builder) return builder;
      const builderReview = await handleBuilderReviewApi(request, { env, rpc:requestRpc, onAlert:onProducerAlert,
        // Card 57 activation: slide drafts review and release like schema 2 (CASE-214 admitted them as drafts).
        parseJson:parseBoundedJson, validateDraft:(document, metadata, options) => validateBuilderDocument(document, metadata, { ...options, validateSlides: validateSlideParts }),
        hashSources:async metadata => {
          const sources = metadata?.sources ?? [];
          return Array.isArray(sources) && (await Promise.all(sources.map(async source =>
            typeof source?.text === 'string' && typeof source.sha256 === 'string' && source.sha256 === await builderSourceSha256(source.text)))).every(Boolean);
        } });
      if (builderReview) return builderReview;
      const facilitator = await handleFacilitatorApi(request, { env,rpc:requestRpc,onAlert:onProducerAlert });
      if (facilitator) return facilitator;
      // ── facilitator: create a room ──
      if (path === '/api/v1/sessions' && method === 'POST') {
        const user = await verifyFacilitatorJwt(bearer(request), env);
        if (!user) return fail('unauthorised', 401);
        const denied = await accountRefusal(user,requestRpc);
        if (denied) return denied;
        const { body, error } = await readJson(request, MAX_CASE_BYTES);
        if (error) return tooBig(error);
        let caseDoc;
        if (body?.caseDocument !== undefined) {
          if (env.CASE_DEV_INLINE_CASES !== '1') return fail('inline_cases_disabled', 403);
          caseDoc = body.caseDocument;
        } else if (body?.caseVersionId !== undefined) {
          if (!isUuidV7(body.caseVersionId) || !isUuidV7(body.workspaceId) ||
              !Number.isFinite(body.ttlMinutes) || body.ttlMinutes <= 0) return fail('bad_request', 400);
          if (refusedRoomWorkspaces(env).has(body.workspaceId)) return fail('workspace_refused', 403);
          // "Facilitator on record (this session)": an optional Name & role for this room only.
          const override = parseFacilitatorOverride(body.facilitator);
          if (!override.ok) return fail('bad_request', 400);
          const sessionId = uuidv7();
          const ttlMs = clampTtl(body.ttlMinutes * 60_000);
          const result = await startPublishedRoom({
            rpc: requestRpc, actor: actorFor(user, env), workspaceId: body.workspaceId,
            caseVersionId: body.caseVersionId, ttlMs, sessionId,
            directory: {
              register: (code, id, expires) => directoryFor(env, code).register(code, id, expires),
              release: (code, id) => directoryFor(env, code).release(code, id),
            },
            room: room(env, sessionId), newCode: newJoinCode,
            onAlert: onProducerAlert, facilitatorOverride: override.value,
          });
          return result.ok ? json({ sessionId: result.sessionId, joinCode: result.joinCode,
            facilitatorToken: result.facilitatorToken, expiresAt: result.expiresAt }, 201)
            : fail(result.error, result.status);
        } else return fail('bad_request', 400);
        const sessionId = uuidv7();
        const ttlMs = clampTtl(Number(body.ttlMinutes) * 60_000);
        const expiresAtMs = Date.now() + ttlMs;
        let joinCode = null;
        for (let i = 0; i < 8 && !joinCode; i++) {
          const c = newJoinCode();
          if (await directoryFor(env, c).register(c, sessionId, expiresAtMs)) joinCode = c;
        }
        if (!joinCode) return fail('no_join_code', 503);
        let r;
        try {
          // An inline dev room has no workspace or session row; it is re-minted only where inline rooms are on.
          r = await room(env, sessionId).create({ sessionId, joinCode, caseDoc, ownerUserId: user.userId, inlineDev: true, ttlMs });
        } catch (e) {
          await directoryFor(env, joinCode).release(joinCode, sessionId);
          throw e;
        }
        if (r.error) { await directoryFor(env, joinCode).release(joinCode, sessionId); return reply(r); }
        return json({ sessionId, joinCode, facilitatorToken: r.facilitatorToken, expiresAt: r.expiresAt }, 201);
      }

      // ── participant: join by code ──
      if (path === '/api/v1/join' && method === 'POST') {
        const prefix = clientPrefix(request.headers.get('cf-connecting-ip'));
        const slowDown = () => {metric(env,{event:'join_fail',reason:'rate_limited'});return json({ error: 'rate_limited' }, 429, { 'retry-after': '60' });};
        if (await limited(env.JOIN_ATTEMPTS, prefix)) return slowDown();
        const { body, error } = await readJson(request, MAX_FRAME_BYTES);
        if (error) {metric(env,{event:'join_fail',reason:'invalid'});return tooBig(error);}
        const p = parseJoinRequest(body);
        if (!p.ok) {metric(env,{event:'join_fail',reason:'invalid'});return fail(p.error, 400);}
        const code = normalizeCode(p.code, JOIN_CODE_LENGTH);
        const found = code ? await directoryFor(env, code).lookup(code) : { error: 'unknown_code' };
        // Correct codes never consult failed-code or challenge state, even behind a shared hospital NAT.
        if (!found.error) return reply(await room(env, found.sessionId).join(p.displayName, p.avatarId, p.joinToken), (x) => json(x, 201));
        const limits = limitsFor(env, prefix);
        const unknown = () => { metric(env, { event: 'join_fail', reason: 'unknown_code' }); return fail('unknown_code', 404); };
        const outageFallback = async () => {
          if (await limits.blocked(prefix)) return slowDown();
          await limits.fail(prefix);
          await limits.failChallenge(prefix);
          return unknown();
        };
        const configured = ['production', 'staging'].includes(env.CASE_ENV)
          && typeof env.TURNSTILE_SECRET_KEY === 'string' && env.TURNSTILE_SECRET_KEY.trim().length > 0
          && typeof env.TURNSTILE_SITE_KEY === 'string' && env.TURNSTILE_SITE_KEY.length > 0
          && env.TURNSTILE_SITE_KEY.length <= 128 && !/[^A-Za-z0-9_-]/.test(env.TURNSTILE_SITE_KEY);
        // Public site key is emitted only with a configured challenge, never a secret or arbitrary URL.
        // Missing widget configuration must not demand a challenge that the phone cannot render.
        if (!configured) { metric(env, { event: 'turnstile_failopen' }); return outageFallback(); }
        if (await limits.challengeRequired(prefix)) {
          if (!p.turnstileToken) { metric(env, { event: 'join_fail', reason: 'invalid' }); return fail('challenge_required', 428, { siteKey: env.TURNSTILE_SITE_KEY }); }
          const verdict = await verifyTurnstile(p.turnstileToken, request.headers.get('cf-connecting-ip'), env,
            { onMetric: point => metric(env, point) });
          if (!verdict.ok) { metric(env, { event: 'join_fail', reason: 'invalid' }); return fail('challenge_failed', 403); }
          if (verdict.reason === 'unavailable') return outageFallback();
          await limits.resetChallenge(prefix);
        }
        await limits.failChallenge(prefix);
        return unknown();
      }

      // ── participant feedback (CASE-284, P-35): public code in the path, respondent only in the header ──
      if (isFeedbackPath(path)) {
        const ip = request.headers.get('cf-connecting-ip'), configured = turnstileConfigured(env);
        return handleFeedbackApi(request, { rpc: requestRpc, roomFor: sessionId => room(env, sessionId),
          attempt: () => limited(env.JOIN_ATTEMPTS, `feedback:${clientPrefix(ip)}`),
          challenge: { configured, siteKey: configured ? env.TURNSTILE_SITE_KEY : undefined,
            verify: token => verifyTurnstile(token, ip, env, { onMetric: point => metric(env, point) }) } });
      }

      // ── network self-test: rate-limited, stateless (P1-4) ──
      if (path.startsWith('/api/v1/check/')) {
        if (await limited(env.CHECK_ATTEMPTS, clientPrefix(request.headers.get('cf-connecting-ip')))) return json({ error: 'rate_limited' }, 429, { 'retry-after': '60' });
        if (path === '/api/v1/check/ws' && method === 'GET') {
          if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return fail('expected_websocket', 426);
          return checkSocket();
        }
        if (path === '/api/v1/check/poll' && method === 'GET') {
          const wait = Math.min(Math.max(0, Math.floor(Number(url.searchParams.get('wait') ?? 0)) || 0), LONG_POLL_MAX_S);
          if (wait) await new Promise((r) => setTimeout(r, wait * 1000));
          return json({ v: WIRE_VERSION, t: 'check', waitedS: wait });
        }
        return fail('not_found', 404);
      }

      // ── deploy guard (scripts/deploy-guard.mjs; P1-8): live rooms, for a deploy to refuse while any run ──
      // Off unless DEPLOY_GUARD_TOKEN is set; the token travels only in the Authorization header.
      if (path === '/api/v1/ops/live-rooms' && method === 'GET') {
        if (!env.DEPLOY_GUARD_TOKEN || !(await sameSecret(bearer(request), env.DEPLOY_GUARD_TOKEN))) return fail('not_found', 404);
        const counts = await Promise.all(CODE_SHARDS.map((c) => directoryFor(env, c).countLive()));
        return json({ live: counts.reduce((a, b) => a + b, 0) });
      }
      if (path === '/api/v1/ops/retention-status' && method === 'POST') {
        return handleRetentionStatus(request, { env, compareSecret: sameSecret,
          rpc: requestRpc, roomFor: sessionId => roomFor(env, sessionId) });
      }

      // Recovery validates an existing participant capability; it never joins again.
      if (path === '/api/v1/join/recover' && method === 'POST') {
        const prefix = clientPrefix(request.headers.get('cf-connecting-ip'));
        const limits = limitsFor(env, prefix);
        return recoverParticipant(request, {
          attempt: () => limited(env.JOIN_ATTEMPTS, prefix),
          blocked: () => limits.blocked(prefix), failed: () => limits.fail(prefix),
          lookup: code => directoryFor(env, code).lookup(code),
          recover: (sessionId, token, code) => room(env, sessionId).recoverParticipant(token, sessionId, code),
        });
      }

      // ── display pairing (number-matched, single use, 5 min) ──
      if (path === '/api/v1/display-pairs' && method === 'POST') {
        if (await limited(env.PAIR_CREATE, clientPrefix(request.headers.get('cf-connecting-ip')))) return json({ error: 'rate_limited' }, 429, { 'retry-after': '60' });
        return json(await pairsDirectory(env).createPair(), 201);
      }
      let mm = m(/^\/api\/v1\/display-pairs\/([0-9a-f-]{36})$/);
      if (mm && method === 'GET') {
        if (!isUuid(mm[1])) return fail('not_found', 404);
        const r = await pairsDirectory(env).pollPair(mm[1], bearer(request));
        if (r.error) return fail(r.error, r.error === 'expired' ? 410 : 404);
        if (r.pending) return json(r);
        // Approved and consumed: the room mints the display token now (it was never stored in clear).
        return reply(await room(env, r.sessionId).issueDisplayToken(), (x) => json({ sessionId: r.sessionId, token: x.token }));
      }

      // ── per-session routes ──
      mm = m(/^\/api\/v1\/sessions\/([0-9a-f-]{36})(\/[a-z0-9-/]+)$/);
      if (mm) {
        const [, sessionId, rest] = mm;
        if (!liveSessionId(sessionId)) return fail('not_found', 404);
        const stub = room(env, sessionId);
        if (rest === '/ws') {
          if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return fail('expected_websocket', 426);
          return stub.fetch(request); // the token arrives in the first frame
        }
        if (rest === '/facilitator-token' && method === 'POST') {
          const user = await verifyFacilitatorJwt(bearer(request), env);
          if (!user) return fail('unauthorised', 401);
          const denied = await accountRefusal(user,requestRpc);
          if (denied) return denied;
          // Re-mint (P-24) rechecks the starter's membership-or-admin in the room's workspace (invariant 10).
          const eligible = await stub.canIssueFacilitatorToken(user.userId);
          if (eligible?.error) return reply(eligible);
          const may = await mayMintConsole(requestRpc, actorFor(user, env), eligible, ACTIONS.mintConsole, env, onProducerAlert, sessionId);
          if (!may.ok) return fail(may.error, may.status);
          return reply(await stub.issueFacilitatorToken(user.userId), (x) => json(x, 201));
        }
        // P-27 (E27): the starter, signed in, lists the room's consoles and stops one shared computer. A room
        // token is never enough: the DO checks the verified user is the room's starter.
        if ((rest === '/consoles' && method === 'GET') || (rest === '/consoles/revoke' && method === 'POST')) {
          const user = await verifyFacilitatorJwt(bearer(request), env);
          if (!user) return fail('unauthorised', 401);
          const denied = await accountRefusal(user, requestRpc);
          if (denied) return denied;
          if (method === 'GET') return reply(await stub.listConsoles(user.userId));
          const { body, error } = await readJson(request, 256);
          if (error) return tooBig(error);
          return reply(await stub.revokeConsole(user.userId, body?.id));
        }
        const token = bearer(request);
        if (!token) return fail('unauthorised', 401);
        const supportedSchema = { '2': 2, '3': 3 }[request.headers.get('x-case-schema')] ?? 1;
        if (rest === '/snapshot' && method === 'GET') return reply(await stub.snapshot(token, supportedSchema), (x) => json(x.snapshot));
        if (rest === '/updates' && method === 'GET') {
          const q = parseUpdatesQuery(url.searchParams);
          if (!q.ok) return fail(q.error, 400);
          let r;
          try {
            r = await stub.updates(token, q.after, q.afterDisplay, q.wait, supportedSchema);
          } catch {
            return json({ error: 'room_restarting' }, 503, { 'retry-after': '1' }); // an evicted room drops its waiters
          }
          return reply(r, (x) => (x.unchanged ? json({ v: WIRE_VERSION, t: 'unchanged', revision: x.revision, displayRevision: x.displayRevision })
            : x.snapshotText ? new Response(x.snapshotText, { headers: { 'content-type': 'application/json; charset=utf-8' } })
              : json(x.snapshot)));
        }
        if (rest === '/commands' && method === 'POST') {
          const { body, error } = await readJson(request, MAX_FRAME_BYTES);
          if (error) return tooBig(error);
          return reply(await stub.command(token, body, supportedSchema));
        }
        if (rest === '/manual-segment' && method === 'POST') {
          const { body, error } = await readJson(request, MAX_SEGMENT_BYTES);
          if (error) return tooBig(error);
          return reply(await stub.manualSegment(token, body, supportedSchema));
        }
        if (rest === '/case-pack' && method === 'GET') return reply(await stub.casePack(token, supportedSchema), (x) => json(x.document));
        // Card 40d: paging the ended projector's debrief. Grant needs the facilitator credential; page, revoke and the
        // same-PC view take the grant itself in the Authorization header, never in a URL.
        if (rest === '/debrief/grant' && method === 'POST') return reply(await stub.debriefGrant(token));
        if (rest === '/debrief/page' && method === 'POST') {
          const { body, error } = await readJson(request, 256);
          if (error) return tooBig(error);
          if (!body || Object.keys(body).some((k) => k !== 'page')) return fail('bad_request', 400);
          return reply(await stub.debriefPage(token, body.page));
        }
        if (rest === '/debrief/revoke' && method === 'POST') return reply(await stub.debriefRevoke(token));
        if (rest === '/debrief/view' && method === 'GET') return reply(await stub.debriefView(token), (x) => json(x.snapshot));
        // Card 59 M3: a released image rendition, with the room credential in the header; the room decides who may see it.
        const mediaRoute = /^\/media\/([0-9a-f-]{36})\/(display|phone|poster)$/.exec(rest);
        if (mediaRoute && method === 'GET') {
          const found = await stub.mediaObject(token, mediaRoute[1], mediaRoute[2]);
          if (found?.error) return reply(found);
          if (!env.MEDIA) return fail('unavailable', 503);
          const object = typeof found?.key === 'string' ? await env.MEDIA.get(found.key) : null;
          // Gone, or stored again after the room started (red-team B1): the room's image was withdrawn.
          if (!object || (found.since && object.uploaded && new Date(object.uploaded).getTime() > found.since)) { try { object?.body?.cancel?.(); } catch { /* not read */ } return fail('withdrawn', 410); }
          return imageResponse(object.body, object.size, found.type);
        }
        if (rest === '/display-pairs/approve' && method === 'POST') {
          const { body, error } = await readJson(request, MAX_FRAME_BYTES);
          if (error) return tooBig(error);
          const code = normalizeCode(String(body?.code ?? ''), PAIR_CODE_LENGTH);
          if (!code) return fail('bad_code', 400);
          return reply(await stub.approveDisplayPair(token, code));
        }
        if (rest === '/display-pairs/revoke' && method === 'POST') return reply(await stub.revokeDisplays(token));
      }
      return fail('not_found', 404);
    } catch (e) {
      if (e instanceof AuthUnavailableError) return fail('auth_unavailable', 503);
      log('worker_error',{reason:'internal'});
      return fail('internal_error', 500);
    }
  },
};

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (['GET', 'HEAD'].includes(request.method) && env.ASSETS && (path === '/join' || /^\/[JjFf]\//.test(path))) {
      const response = withSecurityHeaders(await env.ASSETS.fetch(request), 'html', env);
      response.headers.set('content-security-policy', joinDocumentCsp(response.headers.get('content-security-policy'), path));
      return response;
    }
    const trace = requestTrace();
    const response = await withRequestDeadline(routes.fetch(request, env, ctx, trace), requestDeadlineMs(request, env), () => {
      log('request_deadline', { reason: traceStage(trace) });
      return json({ error: 'request_timeout' }, 503, { 'retry-after': '2' });
    });
    return withSecurityHeaders(response, 'json', env);
  },
  async scheduled(controller, env, ctx) {
    if (controller?.cron === ADMIN_PURGE_CRON) {
      try{if(!await sweepIssues({rpc:rpcClient(env,{timeoutMs:2500}),store:env.MEDIA,deployment:['production','staging'].includes(env.CASE_ENV)?env.CASE_ENV:'local'}))log('worker_error',{reason:'internal'});}catch{log('worker_error',{reason:'internal'});}
      try {
        // Builder operation windows and exact receipts have fixed 24 h / 7 d retention.
        // Cleanup runs independently of account deletion and emits no content or identifiers.
        const cleanup = await rpcClient(env, { timeoutMs: 2_500 }).call('builder_cleanup_expired_state', { p_case_id: null });
        if (!cleanup?.ok || !Number.isSafeInteger(cleanup.data) || cleanup.data < 0) log('worker_error',{reason:'internal'});
      } catch { log('worker_error',{reason:'internal'}); }
      try {
        const result=await runAdminDeletionSweep({env,rpc:rpcClient(env),gotrue:gotrueAdminClient(env)});
        if (!result.ok) log('worker_error',{reason:'internal'});
      } catch { log('worker_error',{reason:'internal'}); }
      // CASE-339: ended invitations' addresses are nulled 30 days after they end (hard rule 8).
      try {
        const result=await runInvitationPurge({rpc:rpcClient(env,{timeoutMs:2_500})});
        if (!result.ok) log('worker_error',{reason:'internal'});
      } catch { log('worker_error',{reason:'internal'}); }
      // CASE-359: one bounded page, after the existing 24 h expiry/personal deletion lifecycle.
      try { const result=await rpcClient(env,{timeoutMs:2_500}).call('purge_abandoned_lobbies',{p_limit:200});
        if(!result?.ok||!Number.isSafeInteger(result.data)||result.data<0||result.data>200)log('worker_error',{reason:'internal'});
      } catch { log('worker_error',{reason:'internal'}); }
      // Card 59 M4: withdrawn, rejected, abandoned and never-registered image bytes.
      try {
        const result=await runMediaSweep({env,rpc:rpcClient(env,{timeoutMs:2_500})});
        if (!result.ok) log('worker_error',{reason:'internal'});
      } catch { log('worker_error',{reason:'internal'}); }
      return;
    }
    const run = controller?.cron === HEALTH_CRONS.weekly ? runWeeklyCheck
      : controller?.cron === HEALTH_CRONS.hourly ? runHourlyCatchup : null;
    if (!run) return;
    const observer=createObserver(env,ctx);
    try {
      // Three 2.5 s RPCs leave time inside the 10 s run for alerts and dead-man response.
      await run({ rpc: rpcClient(env, { timeoutMs: HEALTH_THRESHOLDS.rpcTimeoutMs,onAlert:event=>event.kind === 'unavailable' ? undefined : observer.alert(event) }), healthcheckUrl: env.HEALTHCHECK_PING_URL,
        onAlert:event=>observer.alert(event,{required:true}),
        log: kind => log('cron_health',{reason:kind}) });
    } catch {
      // No binding value, URL, response body or upstream error reaches logs.
      log('cron_health',{reason:'config'});
    }
  },
};
