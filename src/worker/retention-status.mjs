// Operator-only current-store evidence. This cannot attest to provider recovery history.
import { isUuidV7 } from '../shared/ids.mjs';
import { readJson } from './request-json.mjs';

const MAX_BODY_BYTES = 1024;
const MAX_BUDGET_MS = 10_000;
const HOUR_MS = 60 * 60 * 1000;
const absoluteTime = value => typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const response = (body, status = 200) => new Response(JSON.stringify(body), { status,
  headers: { 'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
const fail = (error, status) => response({ error }, status);

function archivedRow(row, sessionId) {
  if (!row || row.session_id !== sessionId || !['ended','expired'].includes(row.status)) return null;
  const created = absoluteTime(row.created_at), ended = absoluteTime(row.ended_at);
  const archived = absoluteTime(row.archived_room_ended_at),
    cutoff = absoluteTime(row.personal_data_delete_at), server = absoluteTime(row.server_time);
  const expires = absoluteTime(row.expires_at), purged = row.retention_purged_at === null
    ? null : absoluteTime(row.retention_purged_at);
  const counts = ['response_count','participant_count','named_participant_count',
    'token_participant_count','archived_event_count','archived_room_ended_count'];
  if ([created,ended,cutoff,server,expires].some(value => value === null) ||
      (row.retention_purged_at !== null && purged === null) ||
      counts.some(field => !nonnegative(row[field])) ||
      row.participant_count < row.named_participant_count ||
      row.participant_count < row.token_participant_count ||
      created > ended || ended > server || cutoff > ended + 24 * HOUR_MS ||
      (purged !== null && purged > server)) return null;
  if (row.archived_room_ended_count === 0 && archived === null) return { incomplete: true };
  if (row.archived_room_ended_count !== 1 || row.archived_event_count < 1 ||
      archived === null || archived < created || archived > server) return null;
  return { ended, archived, cutoff, server, purged, row };
}

function roomEvidence(value, sessionId) {
  if (!value || value.sessionId !== sessionId ||
      !nonnegative(value.tableCount) ||
      ['storeEmpty','kvPresent','alarmPresent','statePresent'].some(
        field => typeof value[field] !== 'boolean') ||
      absoluteTime(value.observedAt) === null) return null;
  const empty = value.tableCount === 0 && !value.kvPresent &&
    !value.alarmPresent && !value.statePresent;
  if (value.storeEmpty !== empty) return null;
  return { empty, observed: absoluteTime(value.observedAt) };
}

/** The caller supplies index.mjs's constant-time comparison and observed service-role RPC. */
export async function handleRetentionStatus(request, {
  env, compareSecret, rpc, roomFor, budgetMs = MAX_BUDGET_MS,
} = {}) {
  const budget = Number.isFinite(budgetMs) && budgetMs > 0
    ? Math.min(budgetMs, MAX_BUDGET_MS) : MAX_BUDGET_MS;
  let timer, expired = false;
  const deadline = new Promise(resolve => { timer = setTimeout(() => {
    expired = true; resolve(fail('unavailable', 503));
  }, budget); });
  const work = (async () => {
    try {
      const token = request.headers.get('authorization');
      if (!env?.DEPLOY_GUARD_TOKEN || !/^Bearer [^\s]+$/.test(token ?? '') ||
          typeof compareSecret !== 'function' ||
          !await compareSecret(token.slice(7), env.DEPLOY_GUARD_TOKEN))
        return fail('not_found', 404);
      if (expired) return fail('unavailable', 503);
      const { body, error } = await readJson(request, MAX_BODY_BYTES, { timeoutMs: budget });
      if (expired) return fail('unavailable', 503);
      if (error) return fail(error, error === 'too_large' ? 413 : error === 'request_timeout' ? 408 : 400);
      if (body === null || typeof body !== 'object' || Array.isArray(body) ||
          Object.keys(body).length !== 1 || !isUuidV7(body.sessionId))
        return fail('bad_request', 400);
      const id = body.sessionId;
      const result = await rpc.call('retention_status', { p_session_id: id });
      if (expired) return fail('unavailable', 503);
      if (!result?.ok) return result?.code === '42501' ? fail('unavailable', 500) : fail('unavailable', 503);
      if (!Array.isArray(result.data) || result.data.length > 1) return fail('unavailable', 503);
      if (result.data.length === 0) return fail('unknown_room', 404);
      const archived = archivedRow(result.data[0], id);
      if (!archived) return fail('unavailable', 503);
      if (archived.incomplete) return fail('archive_incomplete', 409);
      const probe = await roomFor(id).retentionEvidence(id);
      if (expired) return fail('unavailable', 503);
      const room = roomEvidence(probe, id);
      if (!room) return fail('unavailable', 503);
      const observed = Math.max(archived.server, room.observed);
      const finalEvidenceBy = Math.min(archived.ended, archived.archived) + 25 * HOUR_MS;
      const personalAbsent = archived.purged !== null &&
        archived.row.response_count === 0 && archived.row.named_participant_count === 0 &&
        archived.row.token_participant_count === 0;
      const bothAfterCutoff = archived.server >= archived.cutoff && room.observed >= archived.cutoff;
      const timely = bothAfterCutoff && room.observed >= archived.server &&
        archived.server <= finalEvidenceBy && room.observed <= finalEvidenceBy;
      return response({
        sessionId: id, status: personalAbsent && room.empty
          ? timely ? 'current_absence_timely'
            : bothAfterCutoff ? 'current_absence_late' : 'not_confirmed'
          : 'not_confirmed',
        observedAt: new Date(observed).toISOString(),
        sqlObservedAt: new Date(archived.server).toISOString(),
        doObservedAt: new Date(room.observed).toISOString(),
        endedAt: new Date(archived.ended).toISOString(),
        archivedRoomEndedAt: new Date(archived.archived).toISOString(),
        personalDeleteAt: new Date(archived.cutoff).toISOString(),
        retentionPurgedAt: archived.purged === null ? null : new Date(archived.purged).toISOString(),
        responseCount: archived.row.response_count,
        participantCount: archived.row.participant_count,
        namedParticipantCount: archived.row.named_participant_count,
        tokenParticipantCount: archived.row.token_participant_count,
        currentSqlPersonalAbsent: personalAbsent, currentDoStoreEmpty: room.empty,
        archivedEndCorroborated: true, observedWithin25h: timely,
        providerRecoveryHistoryVerified: false,
      });
    } catch { return fail('unavailable', 503); }
  })();
  try { return await Promise.race([work, deadline]); }
  finally { expired = true; clearTimeout(timer); }
}
