#!/usr/bin/env node
// Owner-only current-store verification; never calls a deployed origin without exact opt-in.
// A positive result does not attest to Cloudflare recovery history or a 25 h observation
// if first checked later. No credential, room ID, or upstream body is printed.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isUuidV7 } from '../src/shared/ids.mjs';
import { apiUrl } from '../src/shared/urls.mjs';
import { STAGING_ORIGIN } from './pilot-target.mjs';

const MAX_BODY_BYTES = 4096;
const DEFAULT_DEADLINE_MS = 10_000;
const HOUR_MS = 60 * 60 * 1000;
const absoluteTime = value => typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;

export function resolveDeletionTarget(target, { own = false } = {}) {
  if (target === STAGING_ORIGIN && own === true) return { origin: STAGING_ORIGIN, kind: 'staging' };
  if (typeof target !== 'string') throw new Error('target_refused');
  let parsed;
  try { parsed = new URL(target); } catch { throw new Error('target_refused'); }
  if (target !== parsed.origin || parsed.protocol !== 'http:' ||
      parsed.hostname !== '127.0.0.1' || !parsed.port ||
      !Number.isInteger(Number(parsed.port)) || Number(parsed.port) < 1 ||
      Number(parsed.port) > 65535)
    throw new Error('target_refused');
  return { origin: parsed.origin, kind: 'local' };
}

async function boundedStatus(url, sessionId, token, fetchImpl, timeoutMs) {
  const controller = new AbortController(); let timer, reader;
  let terminal = false, cancellationStarted = false;
  const cancel = body => {
    const target = reader ?? body;
    if (!target || cancellationStarted) return;
    cancellationStarted = true;
    try { void target.cancel().catch(() => {}); } catch { /* closed */ }
  };
  const requireActive = () => {
    if (terminal) { cancel(); throw new Error('unavailable'); }
  };
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => {
    terminal = true; controller.abort(); cancel(); reject(new Error('unavailable'));
  }, timeoutMs); });
  const task = (async () => {
    const response = await fetchImpl(url, {
      method: 'POST', redirect: 'manual', signal: controller.signal,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    if (terminal) { cancel(response.body); throw new Error('unavailable'); }
    if (response.status !== 200 ||
        !response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
      cancel(response.body);
      throw new Error(response.status === 404 || response.status === 410
        ? 'unknown_room' : 'unavailable');
    }
    reader = response.body?.getReader();
    if (!reader) throw new Error('unavailable');
    const chunks = []; let size = 0;
    for (;;) {
      requireActive();
      const { done, value } = await reader.read();
      requireActive();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { cancel(); throw new Error('unavailable'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  })();
  try { return await Promise.race([task, deadline]); }
  finally { clearTimeout(timer); terminal = true; controller.abort(); cancel(); }
}

function currentAbsence(body, sessionId) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      body.sessionId !== sessionId || body.status !== 'current_absence_timely' ||
      body.currentSqlPersonalAbsent !== true || body.currentDoStoreEmpty !== true ||
      body.archivedEndCorroborated !== true || body.observedWithin25h !== true ||
      body.providerRecoveryHistoryVerified !== false ||
      body.responseCount !== 0 || body.namedParticipantCount !== 0 ||
      body.tokenParticipantCount !== 0 ||
      !Number.isSafeInteger(body.participantCount) || body.participantCount < 0)
    return false;
  const sql = absoluteTime(body.sqlObservedAt), room = absoluteTime(body.doObservedAt),
    cutoff = absoluteTime(body.personalDeleteAt), ended = absoluteTime(body.endedAt),
    journal = absoluteTime(body.archivedRoomEndedAt), purged = absoluteTime(body.retentionPurgedAt),
    observed = absoluteTime(body.observedAt);
  if ([sql,room,cutoff,ended,journal,purged,observed].some(value => value === null)) return false;
  const deadline = Math.min(ended, journal) + 25 * HOUR_MS;
  return sql >= cutoff && room >= cutoff && room >= sql &&
    sql <= deadline && room <= deadline && observed === Math.max(sql, room) &&
    purged <= sql && cutoff <= ended + 24 * HOUR_MS;
}

export async function verifyDeletion({ target, own = false, sessionId } = {}, {
  environment = process.env, fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_DEADLINE_MS,
} = {}) {
  const { origin } = resolveDeletionTarget(target, { own });
  if (!isUuidV7(sessionId)) throw new Error('invalid_session');
  const token = environment.DEPLOY_GUARD_TOKEN;
  if (typeof token !== 'string' || !/^[\x21-\x7e]{20,8192}$/.test(token))
    throw new Error('operator_unconfigured');
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.min(timeoutMs, DEFAULT_DEADLINE_MS) : DEFAULT_DEADLINE_MS;
  let body;
  try { body = await boundedStatus(apiUrl(origin, 'ops', 'retention-status'),
    sessionId, token, fetchImpl, deadline); }
  catch (error) { return { ok: false, code: error?.message === 'unknown_room'
    ? 'unknown_room' : 'unavailable' }; }
  if (!currentAbsence(body, sessionId)) return { ok: false, code: 'not_confirmed' };
  return { ok: true, code: 'current_private_store_absence',
    observedAt: body.observedAt, providerRecoveryHistoryVerified: false };
}

function options(args) {
  const input = { target: null, own: false, sessionId: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--i-own-this-origin') { input.own = true; continue; }
    if (args[i] === '--target' && args[i + 1]) { input.target = args[++i]; continue; }
    if (args[i] === '--session-id' && args[i + 1]) { input.sessionId = args[++i]; continue; }
    throw new Error('invalid_options');
  }
  return input;
}

async function main() {
  try {
    const result = await verifyDeletion(options(process.argv.slice(2)));
    if (!result.ok) { console.error(`deletion verifier: ${result.code}`); return 1; }
    console.log('deletion verifier: current private store absence observed; provider recovery history unverified');
    return 0;
  } catch { console.error('deletion verifier: configuration refused'); return 1; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; });
}
