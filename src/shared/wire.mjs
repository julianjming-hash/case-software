// src/shared/wire.mjs: the network contract between Case clients and the room's Durable Object.
//
// One module, shared by the Worker/DO and every client, so both sides validate the same shapes.
// It is dependency-free and pure. Transport choice and fallback order are in docs/HANDOFF.md
// §Network resilience; storage tiers are in docs/ARCHITECTURE.md §2 and §4.
//
// ── HTTP (same origin, /api/v1) ──────────────────────────────────────────────
//   POST /api/v1/join                         body JoinRequest      → JoinResponse
//   POST /api/v1/sessions/:id/commands        body CommandEnvelope  → CommandResponse
//   GET  /api/v1/sessions/:id/snapshot                              → Snapshot
//   GET  /api/v1/sessions/:id/updates?after=<rev>&afterDisplay=<drev>&wait=<s> → Snapshot | {t:"unchanged", revision, displayRevision}
//   POST /api/v1/sessions/:id/manual-segment  body ManualSegment    → CommandResponse[]   (facilitator)
//   Every request after join carries  Authorization: Bearer <capability token or facilitator JWT>.
//   Never a token in a URL (CASE-052).
//
// ── WebSocket  /api/v1/sessions/:id/ws ───────────────────────────────────────
//   client → server: hello (first frame; carries the token), ping, sync, command
//   server → client: snapshot, receipt, pong, sync, error
//   Heartbeat frames are FIXED strings (PING_FRAME / PONG_FRAME) so the Durable Object can answer
//   them with setWebSocketAutoResponse without waking: hibernation survives a 10 s heartbeat.
//   Clients treat ANY inbound frame as liveness. Because the pong comes from the runtime's
//   auto-response, a pong proves the socket, not the room: every SYNC_MS the client also sends the
//   fixed SYNC_FRAME, which the Durable Object itself answers with its current revisions
//   ({t:"sync", revision, displayRevision, epoch}). A missing answer is a dead socket; a newer
//   revision is a missed broadcast, so the client refetches the snapshot (spec red team 2, P1-1).
//   Snapshots are the FULL role projection (project() in room-machine.mjs). No deltas, so no
//   delta drift: a client that sees a revision gap simply waits for, or fetches, the next snapshot.
//   The phone timeline is the same for every phone, so a broadcast builds and serialises it once
//   (src/worker/snapshot-text.mjs, CASE-281); the bytes each phone receives are unchanged.
//
// The client never supplies `actor`, `at`, or ids for rounds the server opens. The server derives
// those (buildEvent), so a client cannot impersonate a role or forge time.

import { displayNameProblem, normaliseDisplayName, isAvatarId } from './participant.mjs';
import { isCapabilityToken } from './ids.mjs';
import { parseVoteEnvelope, VOTE_WIRE_VERSION } from './vote-envelope.mjs';

export const WIRE_VERSION = VOTE_WIRE_VERSION;
export const HEARTBEAT_MS = 10_000;     // client ping interval
export const DEAD_AFTER_MS = 25_000;    // no pong for this long ⇒ socket is dead (iOS can report OPEN)
export const LONG_POLL_MAX_S = 25;      // under common proxy idle timeouts
export const MAX_FRAME_BYTES = 16_384;
/** A client declares the newest case schema it renders. Rooms from schema 2 up refuse older clients before any
 *  content is sent (slide rooms, schema 3, need 3); newer clients may join older rooms. */
export const clientSchemaTooOld = (caseSchema, supportedSchema) => (caseSchema ?? 1) >= 2 && !(supportedSchema >= caseSchema);
export const MAX_MANUAL_EVENTS = 500;
export const PING_FRAME = '{"v":1,"t":"ping"}';
export const PONG_FRAME = '{"v":1,"t":"pong"}';
export const SYNC_FRAME = '{"v":1,"t":"sync"}';
export const SYNC_MS = 60_000;          // app-level sync every minute, answered by the Durable Object itself
export const SYNC_TIMEOUT_MS = 15_000;  // no sync answer within this ⇒ the socket is dead
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ufeff]/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/**
 * Per-command payload allowlist: role → permitted extra keys. Anything else in an envelope is
 * rejected, never ignored, so a client cannot smuggle fields such as `actor` into the reducer.
 */
export const COMMAND_PAYLOADS = Object.freeze({
  join: { participant: ['displayName', 'avatarId'] },
  rename: { participant: ['displayName', 'avatarId'], facilitator: ['displayName', 'avatarId', 'participantId'] },
  vote: { participant: ['roundId', 'response'] },
  remove_participant: { facilitator: ['participantId'] },
  start: { facilitator: ['expectRevision'] },
  advance: { facilitator: ['expectRevision'] },
  lock: { facilitator: ['expectRevision'] },
  finalise_lock: { facilitator: [] },
  cancel_lock: { facilitator: [] },
  set_auto_lock: { facilitator: ['on'] },
  reopen: { facilitator: ['expectRevision'] },
  void_round: { facilitator: ['expectRevision'] },
  select_path: { facilitator: ['pathId', 'expectRevision'] },
  back_to_review: { facilitator: ['expectRevision'] },
  reveal: { facilitator: ['expectRevision'] },
  reveal_path: { facilitator: ['pathId', 'expectRevision'] },
  show_clarification: { facilitator: ['clarificationId', 'expectRevision'] },
  return_clarification: { facilitator: ['occurrenceId', 'expectRevision'] },
  confirm_recovery: { facilitator: ['occurrenceId', 'confirmed', 'expectRevision'] },
  undo: { facilitator: ['targetEventId', 'expectRevision'] },
  reset_checkpoint: { facilitator: ['expectRevision'] },
  pause: { facilitator: [] },
  resume: { facilitator: [] },
  show_names: { facilitator: ['on'] },
  show_results: { facilitator: ['on'] },
  show_lobby: { facilitator: ['on'] },
  results_page: { facilitator: ['page'] },
  text_page: { facilitator: ['closedRoundId', 'page', 'expectRevision'] },
  ranked_page: { facilitator: ['group', 'position', 'closedRoundId', 'expectRevision'] },
  set_timer: { facilitator: ['seconds'] },
  set_music: { facilitator: ['choice', 'intensity', 'playing', 'volume', 'effects'] },
  media_control: { facilitator: ['blockId', 'action', 'position'] },
  replay: { facilitator: ['surfaceId', 'entryIndex'] },
  enter_manual: { facilitator: ['segmentId', 'expectRevision'] },
  manual_marker: { facilitator: ['text'] },
  resume_online: { facilitator: ['expectRevision'] },
  takeover: { facilitator: [] },
  close_joining: { facilitator: ['closed'] },
  end: { facilitator: ['expectRevision'] },
  // Console layout v2: the reversible Debrief phase before End, and the debrief page the projector shows.
  debrief: { facilitator: ['expectRevision'] },
  back_to_case: { facilitator: ['expectRevision'] },
  debrief_page: { facilitator: ['page'] },
});

/** Commands that may open a response round; the server supplies `roundId`. */
export const ROUND_OPENING = Object.freeze(['start', 'advance', 'reopen', 'reset_checkpoint']);

const ENVELOPE_KEYS = ['v', 'type', 'epoch', 'clientEventId'];

/**
 * Validate a client command envelope for a given authenticated role.
 * @returns {{ok:true, envelope:object} | {ok:false, error:string}}
 */
export function parseCommandEnvelope(body, role) {
  return parseEnvelope(body, role, false);
}

/** Trusted authenticated manual upload/local restore only; never the command endpoint. */
export function parseManualCommandEnvelope(body) {
  const parsed = parseEnvelope(body, 'facilitator', true);
  if (parsed.ok && ['text_page', 'ranked_page', 'reveal_path', 'undo', 'confirm_recovery', 'show_clarification', 'return_clarification'].includes(parsed.envelope.type)) {
    const { expectRevision, ...recorded } = parsed.envelope;
    return { ok: true, envelope: recorded };
  }
  return parsed;
}

function parseEnvelope(body, role, manual) {
  if (body?.type === 'vote') return parseVoteEnvelope(body, role);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('not_an_object');
  if (body.v !== WIRE_VERSION) return bad('wire_version');
  const spec = COMMAND_PAYLOADS[body.type];
  if (!spec) return bad('unknown_command');
  const allowed = spec[role];
  if (!allowed) return bad('forbidden');
  if (!Number.isInteger(body.epoch) || body.epoch < 0) return bad('bad_epoch');
  if (!UUID.test(body.clientEventId ?? '')) return bad('bad_client_event_id');
  for (const k of Object.keys(body)) {
    if (!ENVELOPE_KEYS.includes(k) && !allowed.includes(k)) return bad(`unexpected_field:${k}`);
  }
  const e = { ...body };
  const ok = payloadChecks(e, manual);
  return ok === true ? { ok: true, envelope: e } : bad(ok);
}

function payloadChecks(e, manual) {
  const id = (k) => e[k] === undefined || UUID.test(e[k]);
  if (e.expectRevision !== undefined && !(Number.isInteger(e.expectRevision) && e.expectRevision >= 0)) return 'bad_expect_revision';
  for (const k of ['displayName', 'text']) if (typeof e[k] === 'string' && UNSAFE.test(e[k])) return 'unsafe_characters';
  switch (e.type) {
    case 'join': case 'rename': {
      // The same rules as the join page (CASE-119): a name of 3-20 allowed characters is required;
      // an avatar is required to join and optional on a rename (the current one is kept).
      if (typeof e.displayName !== 'string' || e.displayName.length > 80 || displayNameProblem(e.displayName)) return 'bad_display_name';
      e.displayName = normaliseDisplayName(e.displayName);
      if (e.avatarId !== undefined || e.type === 'join') { if (!isAvatarId(e.avatarId)) return 'bad_avatar'; }
      if (!id('participantId')) return 'bad_participant_id';
      return true;
    }
    case 'remove_participant': return UUID.test(e.participantId ?? '') || 'bad_participant_id';
    case 'select_path': return UUID.test(e.pathId ?? '') || 'bad_path_id';
    case 'reveal_path': return UUID.test(e.pathId ?? '') && (manual || e.expectRevision !== undefined) || 'bad_reveal_path';
    case 'show_clarification': return UUID.test(e.clarificationId ?? '') && (manual || e.expectRevision !== undefined) || 'bad_clarification';
    case 'return_clarification': return UUID.test(e.occurrenceId ?? '') && (manual || e.expectRevision !== undefined) || 'bad_clarification_return';
    case 'confirm_recovery': return UUID.test(e.occurrenceId ?? '') && typeof e.confirmed === 'boolean' && (manual || e.expectRevision !== undefined) || 'bad_recovery_confirmation';
    case 'undo': return UUID.test(e.targetEventId ?? '') && (manual || e.expectRevision !== undefined) || 'bad_undo';
    case 'replay': {
      if (e.surfaceId !== undefined && e.entryIndex !== undefined) return 'ambiguous_replay_target';
      if (e.entryIndex !== undefined) return e.entryIndex === null
        || (Number.isSafeInteger(e.entryIndex) && e.entryIndex >= 0 && e.entryIndex < 4096)
        || 'bad_entry_index';
      return e.surfaceId === null || UUID.test(e.surfaceId ?? '') || 'bad_surface_id';
    }
    case 'show_names':
    case 'show_lobby':
    case 'show_results':
    case 'set_auto_lock': return typeof e.on === 'boolean' || 'bad_on';
    case 'results_page': return Number.isInteger(e.page) && e.page >= 0 && e.page <= 3 || 'bad_page';
    case 'text_page': return UUID.test(e.closedRoundId ?? '') && Number.isSafeInteger(e.page) && e.page >= 0 && e.page < 300
      && (manual && e.expectRevision === undefined || Number.isSafeInteger(e.expectRevision) && e.expectRevision >= 0) || 'bad_text_page';
    case 'ranked_page': return Number.isSafeInteger(e.group) && e.group >= 0 && e.group < 300
      && Number.isSafeInteger(e.position) && e.position >= 0 && e.position < 8
      && UUID.test(e.closedRoundId ?? '')
      && (manual && e.expectRevision === undefined || Number.isSafeInteger(e.expectRevision) && e.expectRevision >= 0) || 'bad_ranked_page';
    case 'set_timer': return e.seconds === null || Number.isInteger(e.seconds) || 'bad_seconds';
    // Card 59 M3: play, pause or restart a released video on the projector at a position in seconds (≤ 2 minutes).
    case 'media_control': return UUID.test(e.blockId ?? '') && ['play', 'pause', 'restart'].includes(e.action)
      && (e.position === null || (typeof e.position === 'number' && Number.isFinite(e.position) && e.position >= 0 && e.position <= 121)) || 'bad_media_control';
    case 'enter_manual': return UUID.test(e.segmentId ?? '') || 'bad_segment_id';
    case 'manual_marker': return (typeof e.text === 'string' && e.text.length <= 200) || 'bad_text';
    case 'close_joining': return typeof e.closed === 'boolean' || 'bad_closed';
    case 'debrief_page': return Number.isSafeInteger(e.page) && e.page >= 0 && e.page < 300 || 'bad_page';
    default: return true;
  }
}

/**
 * Server side: turn a validated envelope into a reducer event.
 * @param {object} envelope from parseCommandEnvelope
 * @param {{actor:{role:string,id?:string}, at:string, newId:()=>string}} ctx  the server's authenticated actor, clock, and id source
 */
export function buildEvent(envelope, { actor, at, newId }) {
  const { v, ...rest } = envelope;
  const event = { ...rest, actor, at };
  if (ROUND_OPENING.includes(envelope.type)) event.roundId = newId();
  if (envelope.type === 'undo') event.roundId = newId();
  // Response ids are minted here, never taken from the client, so a reused client id cannot
  // collide with another room's primary key in the archive (red team P1).
  if (envelope.type === 'vote') event.responseId = newId();
  return event;
}

/** Server → client receipt body (HTTP response and WebSocket frame share it). */
export function receiptBody(receiptEffect, state) {
  return {
    v: WIRE_VERSION,
    t: 'receipt',
    clientEventId: receiptEffect.clientEventId,
    receipt: receiptEffect.receipt,
    ...(receiptEffect.reason ? { reason: receiptEffect.reason } : {}),
    revision: state.revision,
    epoch: state.epoch,
  };
}

/** Server → client answer to SYNC_FRAME: the room's current revisions, so a client can spot a missed broadcast. */
export function syncBody(state) {
  return { v: WIRE_VERSION, t: 'sync', revision: state.revision, displayRevision: state.display.revision, epoch: state.epoch };
}

/** Server → client snapshot. `view` is project(state, role, participantId). */
export function snapshotBody(state, view) {
  return { v: WIRE_VERSION, t: 'snapshot', revision: state.revision, epoch: state.epoch, displayRevision: state.display.revision, view };
}

/**
 * Validate a raw client WebSocket frame.
 * @returns {{ok:true, frame:object} | {ok:false, error:string}}
 */
export function parseClientFrame(raw) {
  if (typeof raw !== 'string') return bad('binary_not_supported');
  if (new TextEncoder().encode(raw).length > MAX_FRAME_BYTES) return bad('frame_too_large');
  let f;
  try { f = JSON.parse(raw); } catch { return bad('not_json'); }
  if (!f || typeof f !== 'object' || f.v !== WIRE_VERSION) return bad('wire_version');
  switch (f.t) {
    case 'hello':
      if (typeof f.token !== 'string' || f.token.length < 20 || f.token.length > 4096) return bad('bad_token');
      if (!Number.isInteger(f.lastRevision) || f.lastRevision < 0) return bad('bad_last_revision');
      if (!Number.isInteger(f.lastEpoch) || f.lastEpoch < 0) return bad('bad_last_epoch');
      if (f.supportedSchema !== undefined && ![1,2,3].includes(f.supportedSchema)) return bad('unsupported_schema');
      return { ok: true, frame: { t: 'hello', ...(f.supportedSchema === undefined ? {} : { supportedSchema: f.supportedSchema }), token: f.token, lastRevision: f.lastRevision, lastEpoch: f.lastEpoch } };
    case 'ping':
      if (raw !== PING_FRAME) return bad('bad_ping');
      return { ok: true, frame: { t: 'ping' } };
    case 'sync':
      if (raw !== SYNC_FRAME) return bad('bad_sync');
      return { ok: true, frame: { t: 'sync' } };
    case 'command':
      return { ok: true, frame: { t: 'command', body: (({ t, ...b }) => b)(f) } };
    default:
      return bad('unknown_frame');
  }
}

/**
 * Long-poll query: return as soon as `revision > after` OR `displayRevision > afterDisplay`
 * (a projector on long-poll must also see presentation replay, which moves only displayRevision).
 */
export function parseUpdatesQuery(searchParams) {
  const after = Number(searchParams.get('after'));
  const afterDisplay = Number(searchParams.get('afterDisplay') ?? 0);
  const wait = Number(searchParams.get('wait') ?? LONG_POLL_MAX_S);
  if (!Number.isInteger(after) || after < 0) return bad('bad_after');
  if (!Number.isInteger(afterDisplay) || afterDisplay < 0) return bad('bad_after_display');
  if (!Number.isFinite(wait) || wait < 0) return bad('bad_wait');
  return { ok: true, after, afterDisplay, wait: Math.min(Math.floor(wait), LONG_POLL_MAX_S) };
}

/**
 * Manual segment uploaded by the facilitator on recovery (HANDOFF §Manual room and recovery).
 * Events are command envelopes plus the facilitator device's own `at` (the only place client
 * time is trusted, because the server was unreachable). They are replayed in order.
 */
export function parseManualSegment(body) {
  if (!body || typeof body !== 'object' || body.v !== WIRE_VERSION) return bad('wire_version');
  if (!UUID.test(body.segmentId ?? '')) return bad('bad_segment_id');
  if (!Array.isArray(body.events) || body.events.length === 0 || body.events.length > MAX_MANUAL_EVENTS) return bad('bad_events');
  const events = [];
  for (const [i, raw] of body.events.entries()) {
    if (!raw || typeof raw !== 'object') return bad(`event_${i}:not_an_object`);
    const { at, ...envelope } = raw;
    if (typeof at !== 'string' || !ISO.test(at)) return bad(`event_${i}:bad_at`);
    const r = parseManualCommandEnvelope(envelope);
    if (!r.ok) return bad(`event_${i}:${r.error}`);
    events.push({ envelope: r.envelope, at });
  }
  for (let i = 1; i < events.length; i++) if (Date.parse(events[i].at) < Date.parse(events[i - 1].at)) return bad(`event_${i}:out_of_order`);
  return { ok: true, segmentId: body.segmentId, events };
}

/**
 * Join request: a human-typed or QR-scanned code, a REQUIRED display name (3-20 letters, numbers,
 * spaces, hyphens or apostrophes after trimming; duplicates allowed) and a REQUIRED avatar from the
 * allow-list (CASE-119, `participant.mjs`). The phone checks the same rules first; this is the server's
 * own check, so a hand-made request cannot skip them. The name comes back normalised.
 */
export function parseJoinRequest(body) {
  if (!body || typeof body !== 'object' || body.v !== WIRE_VERSION) return bad('wire_version');
  if (typeof body.code !== 'string' || body.code.length > 20) return bad('bad_code');
  if (typeof body.displayName !== 'string' || body.displayName.length > 80) return bad('bad_display_name');
  if (UNSAFE.test(body.displayName)) return bad('unsafe_characters');
  if (displayNameProblem(body.displayName)) return bad('bad_display_name');
  if (!isAvatarId(body.avatarId)) return bad('bad_avatar');
  // The UI may choose a random avatar before submission; the server still requires its allow-listed id.
  // The optional join capability and challenge token travel only in this JSON body.
  const joinPresent = Object.hasOwn(body, 'joinToken');
  if (joinPresent && !isCapabilityToken(body.joinToken)) return bad('bad_join_token');
  const tokenPresent = Object.hasOwn(body, 'turnstileToken');
  if (tokenPresent && (typeof body.turnstileToken !== 'string' || !body.turnstileToken.length || body.turnstileToken.length > 2048 || /[\s\u0000-\u001f\u007f]/u.test(body.turnstileToken))) return bad('bad_turnstile_token');
  return { ok: true, code: body.code, displayName: normaliseDisplayName(body.displayName), avatarId: body.avatarId,
    ...(tokenPresent ? { turnstileToken: body.turnstileToken } : {}),
    ...(joinPresent ? { joinToken: body.joinToken } : {}) };
}

function bad(error) { return { ok: false, error }; }
