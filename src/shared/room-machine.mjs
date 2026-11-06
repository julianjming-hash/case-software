// src/shared/room-machine.mjs: the executable spec of a live Case room (CASE-057).
//
// ONE pure module. The Durable Object, the facilitator/display/participant clients, the
// prototypes and the tests all run this same reducer, so they cannot disagree.
//
//   initialState({ sessionId, joinCode, caseDoc })  → state
//   reduce(state, event)                             → { state, effects }   (pure; no idempotency)
//   dispatch(state, event, ledger)                   → reduce + idempotency through a receipt ledger
//   applySegment(state, events, ledger)              → all-or-nothing replay of a manual segment
//   project(state, role, participantId?)             → what that role may see, and nothing more
//
// Pure: no I/O, no clock, no randomness. Time (`at`, ISO-8601) and ids arrive inside events.
// The input state is never mutated.
//
// Event: { type, epoch, actor: { role, id? }, at, clientEventId?, ...payload }
// Effects:
//   { type: 'receipt', clientEventId, receipt, reason? }   answer to the sender (idempotent)
//   { type: 'journal', seq, epoch, kind, payload, at }     append to the session journal
//   { type: 'broadcast', revision }                        role projections changed
//   { type: 'display', displayRevision }                   projector-only change (replay)
//
// Rules carried from docs/HANDOFF.md and docs/DECISIONS.md:
//   • a vote never chooses the path; the facilitator selects an authored path (CASE-042)
//   • manual room, presentation replay and the lobby screen are layers, not phases (CASE-037, CASE-176)
//   • manual mode starts only at a stable boundary; inside a decision only after void (CASE-035)
//   • every authority change bumps `epoch`; older-epoch commands change nothing (CASE-037)
//   • terminal paths reset to a snapshot checkpoint and grey the explored option (CASE-041)
//   • nothing unrevealed, no cue or private suggestion reaches public projections

import { indexCaseDocument, suggestPath, SLIDE_SCHEMA_VERSION } from './case-document.mjs';
import { summaryPages } from './debrief-pages.mjs';
import { FREE_TEXT_MAX } from './content-limits.mjs';
import { packTextPages } from './text-pages.mjs';
import { identifierKinds } from './identifiers.mjs';
import { isAvatarId } from './participant.mjs';
import { cleanText } from './text.mjs';
import { sanitizeArt } from './art-descriptor.mjs';
import { tintOf } from './tints.mjs';
import { buildRankedGroups } from './ranked-groups.mjs';
import { rankedPage, rankedLayout } from './ranked-presentation.mjs';
import { populatedPresentationGroups, publicPresentationSurface } from './presentation-groups.mjs';
import { slideTheme } from './slide-themes.mjs';
import { isUuidV7 } from './ids.mjs';
import { recordTeachingAction, undoDescriptor, consumeTeachingAction, publicationDescriptor, entryPublication } from './room-corrections.mjs';
import { traceSpine } from './room-interpretation.mjs';
import { decisionBranches } from './decision-branches.mjs';
import { MUSIC_INTENSITY_DEFAULT, MUSIC_VOLUME_DEFAULT, validMusicVolume, validMusicChoice, validMusicIntensity, musicTrackFor, musicSegments, segmentAt, freshAnchor, continuedAnchor, changedTrackAnchor } from './music-timeline.mjs';
export { cleanText } from './text.mjs';

export const PHASES = Object.freeze([
  'lobby', 'surface_live', 'responses_open', 'responses_locked', 'path_selected',
  'consequence_revealed', 'terminal_teaching', 'discussion_paused', 'debrief', 'ended',
]);
/** Console layout v2 (Julian, 2026-10-18): Debrief is a reversible phase before End, entered at a shown slide (never inside a
 *  round or in manual mode). Phones get their recap and feedback opens; the projector shows the debrief and its feedback QR. */
export const DEBRIEF_FROM = Object.freeze(['surface_live', 'consequence_revealed', 'terminal_teaching']);
/** The phases in which a phone gets its private recap (Debrief and End), so it needs its own answer to every round. */
export const recapPhase = phase => phase === 'ended' || phase === 'debrief';
/** What a room in Debrief still accepts: review, membership, leaving Debrief and End. */
const DEBRIEF_COMMANDS = new Set(['join', 'rename', 'remove_participant', 'vote', 'replay', 'debrief_page', 'back_to_case', 'takeover', 'end']);
export const ROLES = Object.freeze(['facilitator', 'display', 'participant']);
export const RECEIPTS = Object.freeze(['accepted', 'already_accepted', 'locked', 'paused_held', 'stale_epoch', 'rejected']);

/** Phases where manual room mode may begin (HANDOFF §Manual room and recovery contract).
 *  A pause counts only if it was taken from one of these too: never from inside a decision. */
export const STABLE_PHASES = Object.freeze(['lobby', 'surface_live', 'consequence_revealed', 'discussion_paused', 'terminal_teaching']);
export const isStableBoundary = (state) => STABLE_PHASES.includes(state.phase)
  && (state.phase !== 'discussion_paused' || STABLE_PHASES.includes(state.resumePhase));

/** Facilitator commands, the participant commands, and who may send each. */
export const COMMANDS = Object.freeze({
  join: ['participant'],
  rename: ['participant', 'facilitator'],
  vote: ['participant'],
  remove_participant: ['facilitator'],
  start: ['facilitator'],
  advance: ['facilitator'],
  lock: ['facilitator'],
  finalise_lock: ['facilitator'],
  cancel_lock: ['facilitator'],
  set_auto_lock: ['facilitator'],
  reopen: ['facilitator'],
  void_round: ['facilitator'],
  select_path: ['facilitator'],
  back_to_review: ['facilitator'],
  reveal: ['facilitator'],
  reveal_path: ['facilitator'],
  undo: ['facilitator'],
  reset_checkpoint: ['facilitator'],
  confirm_recovery: ['facilitator'],
  show_clarification: ['facilitator'],
  return_clarification: ['facilitator'],
  pause: ['facilitator'],
  resume: ['facilitator'],
  show_names: ['facilitator'],
  show_results: ['facilitator'],
  results_page: ['facilitator'],
  text_page: ['facilitator'],
  ranked_page: ['facilitator'],
  set_timer: ['facilitator'],
  set_music: ['facilitator'],
  media_control: ['facilitator'],
  replay: ['facilitator'],
  show_lobby: ['facilitator'],
  enter_manual: ['facilitator'],
  manual_marker: ['facilitator'],
  resume_online: ['facilitator'],
  takeover: ['facilitator'],
  close_joining: ['facilitator'],
  end: ['facilitator'],
  debrief: ['facilitator'],
  back_to_case: ['facilitator'],
  debrief_page: ['facilitator'],
});

/** Facilitator commands that may carry `expectRevision` (a precondition fence for stale tabs). */
/** Commands that publish to or change the projector: refused as `lobby_shown` while the lobby screen is up (CASE-176). */
const LOBBY_BLOCKED = new Set(['advance', 'reveal', 'reset_checkpoint', 'replay', 'show_results', 'results_page', 'text_page', 'ranked_page', 'show_names', 'media_control']);
/** The projector is on the lobby join screen mid-case (CASE-176). A stored room without the field reads as off. */
const lobbyShown = (state) => state.display?.lobby === true && state.phase !== 'lobby' && state.phase !== 'ended' && !state.manual;

export const FENCEABLE = new Set(['start', 'advance', 'lock', 'reopen', 'void_round', 'select_path', 'back_to_review', 'reveal', 'reveal_path', 'undo', 'confirm_recovery', 'show_clarification', 'return_clarification', 'reset_checkpoint', 'enter_manual', 'resume_online', 'end', 'text_page', 'ranked_page', 'debrief', 'back_to_case']);

/** CASE-319: the Durable Object's own actors. `system:lock` finalises a closing window at its deadline; `system:auto`
 *  starts one when everyone connected has answered. Clients cannot claim either: the Worker sets every actor. */
export const SYSTEM_LOCK_ACTOR = 'system:lock';
export const SYSTEM_AUTO_LOCK_ACTOR = 'system:auto';
const LOCK_GRACE_MAX_MS = 10_000;

const NAME_MAX = 40;
/** Participant entries a room keeps (removed ones included): bounds the stored state and every
 *  facilitator snapshot, so a join flood cannot make the room unwritable (runtime red team P0-1). */
export const MAX_PARTICIPANTS = 300;
const TIME_MIN = Date.UTC(2020, 0, 1);
const TIME_MAX = Date.UTC(2100, 0, 1);
export const RECAP_TTL_MS = 24 * 60 * 60 * 1000; // CASE-043
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const indexCache = new WeakMap();
function idx(state) {
  let i = indexCache.get(state.caseDoc);
  if (!i) { i = indexCaseDocument(state.caseDoc); indexCache.set(state.caseDoc, i); }
  return i;
}

// Schema-3 slides (card 57, CASE-210): an occurrence's composition, found by its owner. Its non-empty authored steps
// take the place of the fixed legacy groups, so every existing progress, fencing, manual and replay path is reused.
const compositionCache = new WeakMap();
// Slide behaviour is decided once, by schema: a stray `compositions` key on a schema-1/2 document is ignored, so the
// legacy path, stored rooms and their projections stay exactly as they were (red-team F1).
export const isSlideDocument = doc => doc?.schema_version === SLIDE_SCHEMA_VERSION && Array.isArray(doc.compositions) && doc.compositions.length > 0;
function slideIndex(state) {
  let found = compositionCache.get(state.caseDoc);
  if (!found) {
    const list = Array.isArray(state.caseDoc.compositions) ? state.caseDoc.compositions : [];
    found = { byOwner: new Map(list.map(item => [`${item.owner?.kind}:${item.owner?.id}`, item])),
      blocks: new Map((Array.isArray(state.caseDoc.blocks) ? state.caseDoc.blocks : []).map(block => [block.id, block])) };
    compositionCache.set(state.caseDoc, found);
  }
  return found;
}
function compositionFor(state, entry) {
  if (!entry || !isSlideDocument(state.caseDoc)) return null;
  const owner = entry.kind === 'clarification' ? `clarification:${entry.clarificationId}` : entry.pathId ? `path:${entry.pathId}` : `beat:${entry.beatId}`;
  return slideIndex(state).byOwner.get(owner) ?? null;
}
const releasableSteps = composition => composition.steps.filter(step => step.block_ids.length > 0);

function groupsForEntry(state, entry) {
  if (!entry) return [];
  const composition = compositionFor(state, entry);
  // Empty steps never consume a reveal press; the count of the rest is never sent to public roles.
  if (composition) return releasableSteps(composition).map(step => step.id);
  const surface = idx(state).surfaces.get(entry.surfaceId);
  if (!surface) return [];
  const variant = entry.variant >= 0 ? surface.variants[entry.variant] : surface;
  return populatedPresentationGroups({
    scene: variant.scene ?? surface.scene ?? null,
    assetIds: surface.asset_ids ?? [],
    observations: surface.observations ?? [],
    points: variant.points ?? surface.points ?? [],
    investigations: variant.investigations ?? surface.investigations ?? [],
  });
}

/** Preserve pre-progress rooms' already-public text without trusting malformed new progress. */
export function normalizePresentationState(state) {
  const legacy = state.presentationVersion === undefined;
  if (!legacy && state.presentationVersion !== 1 && state.presentationVersion !== 2) throw new TypeError('invalid_presentation_version');
  // Slide rooms are version 2 from creation; a version that does not match the case's content fails closed.
  const slides = isSlideDocument(state.caseDoc);
  if (slides !== (state.presentationVersion === 2)) throw new TypeError('invalid_presentation_version');
  if (!Array.isArray(state.revealed)) throw new TypeError('invalid_presentation_progress');
  let changed = legacy;
  const revealed = state.revealed.map((entry) => {
    if (!entry || !idx(state).surfaces.has(entry.surfaceId)) throw new TypeError('invalid_presentation_progress');
    const total = groupsForEntry(state, entry).length;
    if (entry.groupsShown === undefined) {
      // Missing grouped progress is never invented for a slide room.
      if (slides) throw new TypeError('invalid_presentation_progress');
      changed = true;
      return { ...entry, groupsShown: legacy ? total : 0 };
    }
    if (!Number.isSafeInteger(entry.groupsShown) || entry.groupsShown < 0 || entry.groupsShown > total) {
      throw new TypeError('invalid_presentation_progress');
    }
    return entry;
  });
  return changed ? { ...state, presentationVersion: 1, revealed } : state;
}

// Card 59 M3 (CASE-269): the room's images, fixed at start. Each image the published version pins has an opaque room
// handle (minted by the room, UUIDv7) and only public-safe facts, or is marked withdrawn. Asset ids and storage keys never
// enter this map; an image block reaches every role with `media` from it, and public roles never see its asset id.
const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function sanitizeRoomMedia(media) {
  if (media === null || media === undefined) return null;
  if (typeof media !== 'object' || Array.isArray(media) || Object.keys(media).length > 64) throw new TypeError('invalid_room_media');
  const out = {};
  for (const [assetId, entry] of Object.entries(media)) {
    if (!UUID7.test(assetId) || !entry || typeof entry !== 'object') throw new TypeError('invalid_room_media');
    if (entry.state === 'withdrawn' && Object.keys(entry).length === 1) { out[assetId] = { state: 'withdrawn' }; continue; }
    const size = value => Number.isSafeInteger(value) && value >= 16 && value <= 4096;
    // A still (JPEG), an animated GIF, or a video with its length (card 59 M2 re-ruling, 2026-10-15).
    if (Object.keys(entry).sort().join() !== 'credit,durationMs,handle,height,type,width' || !UUID7.test(entry.handle) || !size(entry.width) || !size(entry.height) ||
        !(entry.credit === null || (typeof entry.credit === 'string' && entry.credit.length <= 300)) || !['image/jpeg', 'image/gif', 'video/mp4'].includes(entry.type) ||
        !(entry.type === 'video/mp4' ? entry.durationMs === null || (Number.isSafeInteger(entry.durationMs) && entry.durationMs >= 0 && entry.durationMs <= 121_000) : entry.durationMs === null))
      throw new TypeError('invalid_room_media');
    out[assetId] = { handle: entry.handle, width: entry.width, height: entry.height, credit: entry.credit, type: entry.type, durationMs: entry.durationMs };
  }
  return out;
}
/**
 * The projector's video playback (card 59 M3), only while the surface the projector shows holds that released video;
 * otherwise null. Positions are seconds; `since` is the server time the state was set.
 */
function playbackView(state, I) {
  const p = state.playback;
  if (!p) return null;
  const cursor = state.display?.cursor ?? null;
  const entry = Number.isSafeInteger(cursor) ? state.revealed[cursor] : typeof cursor === 'string' ? lastEntryFor(state, cursor)
    : state.liveSurfaceId ? lastEntryFor(state, state.liveSurfaceId) : null;
  const view = entry ? surfaceView(I, entry, { state, facilitator: false }) : null;
  const shown = (view?.slide?.blocks ?? []).some(block => block?.id === p.blockId && block.type === 'image' && block.media?.type === 'video/mp4');
  return shown ? { blockId: p.blockId, playing: p.playing, at: p.at, since: p.since } : null;
}
const imageView = (state, block, facilitator) => {
  if (block?.type !== 'image') return block;
  const { asset_id: _assetId, ...rest } = block;
  const media = state.media?.[block.asset_id] ?? null;
  return { ...(facilitator ? block : rest), media: media?.handle ? { ...media, credit: null } : media };
};
/**
 * Card 40b (Julian's ruling 1, 2026-10-17): the credit of each image this phone's own timeline released, by block id, for the
 * recap PDF to print under it (CC BY / BY-SA). Absent when there is none. An unreleased or unrevealed image is never in the
 * timeline, so its credit cannot appear; slides keep credits facilitator-only.
 */
function recapCredits(state, timeline) {
  const credits = {}, blocks = slideIndex(state).blocks;
  for (const entry of timeline) for (const block of entry.slide?.blocks ?? []) {
    const credit = block.media?.handle && state.media?.[blocks.get(block.id)?.asset_id]?.credit;
    if (credit) credits[block.id] = credit;
  }
  return Object.keys(credits).length ? { imageCredits: credits } : {};
}
/**
 * The handles a role may fetch: every image of the room for the facilitator; for public roles only images whose block
 * belongs to a step already released in some timeline entry (a replay or recap shows only those, and a later undo does
 * not take back what the room has seen).
 */
export function releasedMediaHandles(state, role) {
  const handles = new Set();
  if (!state?.media) return handles;
  if (role === 'facilitator') { for (const entry of Object.values(state.media)) if (entry.handle) handles.add(entry.handle); return handles; }
  if (role !== 'display' && role !== 'participant') return handles;
  const blocks = slideIndex(state).blocks;
  for (const entry of state.revealed ?? []) {
    const composition = compositionFor(state, entry);
    if (!composition) continue;
    const steps = releasableSteps(composition), shown = Number.isSafeInteger(entry.groupsShown) ? Math.min(entry.groupsShown, steps.length) : 0;
    for (const step of steps.slice(0, shown)) for (const id of step.block_ids) {
      const block = blocks.get(id);
      if (block?.type === 'image') { const handle = state.media[block.asset_id]?.handle; if (handle) handles.add(handle); }
    }
  }
  return handles;
}

export function initialState({ sessionId, joinCode = null, caseDoc, caseVersionNo = null, art = null, tint = null, media = null, feedbackCode = null, facilitatorLabel = null }) {
  return {
    v: 1,
    presentationVersion: isSlideDocument(caseDoc) ? 2 : 1,
    sessionId,
    joinCode,
    caseVersionNo,
    // The published version's numbers-only art descriptor (CASE-164), fixed for the room's life.
    art: sanitizeArt(art),
    // The group tint at start (CASE-168 (4)); a retint never reaches the room.
    tint: tintOf(tint),
    media: sanitizeRoomMedia(media),
    caseDoc,
    epoch: 0,
    revision: 0,
    phase: 'lobby',
    resumePhase: null,
    beatId: null,
    nextBeatId: caseDoc.start_beat_id,
    decisionId: null,
    liveSurfaceId: null,
    round: null,           // current round: { id, decisionId, no, status, openedAt, lockedAt, responses{pid→…}, aggregate, suggestion }
    rounds: [],            // closed rounds (summary only, no per-person answers)
    selectedPathId: null,
    resolutionKind: null,
    terminalPathId: null,
    flags: [],
    checkpoints: {},       // beatId → { flags }
    exploredTerminal: [],  // terminal path ids already explored (greyed)
    disabledOptions: {},   // decisionId → optionIds
    revealed: [],          // timeline: { surfaceId, beatId, pathId, kind, variant, manual, at, groupsShown }
    participants: {},      // pid → { name, avatarId, joinedAt, removedAt }
    namesShown: false,
    arrivalCount: 0,
    resultsShown: true,
    resultsPage: 0,
    rankedSelection: { group: 0, position: 0 },
    manual: null,          // { segmentId, startedAt, markers: [] }
    manualSegments: [],
    timer: null,           // { durationS, startedAt, remainingS, totalS } advisory only; totalS = the length as set (CASE-320)
    music: initialMusic(sessionId), // CASE-334: the facilitator's track and Build choice, the shuffle and the public transport
    playback: null,        // card 59 M3: { blockId, playing, at, since } the projector's video, set by the facilitator
    display: { revision: 0, cursor: null, lobby: false }, // lobby: the mid-case lobby screen layer (CASE-176)
    joiningClosed: false,
    // The room's never-reused feedback code (CASE-284), minted with the session; public only once the room has ended.
    feedbackCode: typeof feedbackCode === 'string' && /^[0-9A-HJKMNP-TV-Z]{6}$/.test(feedbackCode) ? feedbackCode : null,
    // The facilitator's "Name, Role" fixed at start (Julian, 2026-10-18), checked by the room DO (validLabel); public only on an
    // ended phone's recap, for its record.
    facilitatorLabel: typeof facilitatorLabel === 'string' && facilitatorLabel ? cleanText(facilitatorLabel, 162) : null,
    lastAt: null,          // monotonic clock: every event time is clamped to ≥ lastAt
    endedAt: null,
    debrief: null, // console layout v2: { resumePhase, joiningClosed, page, startedAt } while in Debrief
  };
}

/** @returns {{ state: object, effects: object[] }} */
export function reduce(prev, event) {
  prev = normalizePresentationState(prev);
  const effects = [];
  const fail = (receipt, reason) => {
    effects.length = 0; // a rejected command emits nothing but its receipt
    if (event?.clientEventId) effects.push({ type: 'receipt', clientEventId: event.clientEventId, receipt, reason });
    return { state: prev, effects };
  };

  // ── envelope ──
  if (!event || typeof event !== 'object' || typeof event.type !== 'string') return fail('rejected', 'malformed_event');
  const allowedRoles = COMMANDS[event.type];
  if (!allowedRoles) return fail('rejected', 'unknown_command');
  if (!event.actor || !allowedRoles.includes(event.actor.role)) return fail('rejected', 'forbidden');
  const t = typeof event.at === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(event.at) ? Date.parse(event.at) : NaN;
  if (!Number.isFinite(t) || t < TIME_MIN || t > TIME_MAX) return fail('rejected', 'bad_time');
  if (event.clientEventId !== undefined && !UUID.test(event.clientEventId)) return fail('rejected', 'bad_client_event_id');
  // Joining is not epoch-fenced: a phone that has never seen the room cannot know its epoch.
  if (event.type !== 'join' && event.epoch !== prev.epoch) return fail('stale_epoch', `room is at epoch ${prev.epoch}`);
  if (prev.phase === 'ended') return fail('rejected', 'room_ended');
  if (['reveal_path', 'undo', 'confirm_recovery', 'show_clarification', 'return_clarification'].includes(event.type) && (!isUuidV7(event.clientEventId) || event.expectRevision === undefined)) return fail('rejected', 'missing_correction_fence');
  if (['text_page', 'ranked_page'].includes(event.type) && event.expectRevision === undefined) return fail('rejected', 'missing_expect_revision');
  if (event.expectRevision !== undefined) {
    if (!FENCEABLE.has(event.type)) return fail('rejected', 'unexpected_expect_revision');
    if (event.expectRevision !== prev.revision) return fail('rejected', 'stale_revision');
  }
  if (prev.clarification && ['lock','reveal','reveal_path','select_path','back_to_review','reset_checkpoint','undo','reopen','void_round','enter_manual','resume_online'].includes(event.type)) return fail('rejected', 'return_from_clarification_first');
  // Monotonic, normalised time: a device clock can never move the room backwards or emit an invalid date.
  const at = new Date(Math.max(t, prev.lastAt ? Date.parse(prev.lastAt) : t)).toISOString();

  // ── copy-on-write (the case document is shared, never copied) ──
  const { caseDoc, ...rest } = prev;
  let s = structuredClone(rest);
  s.caseDoc = caseDoc;
  s.lastAt = at;
  const I = idx(s);
  let revisionBumped = false;
  let displayBumped = false;

  const journal = (kind, payload = {}) => {
    s.revision += 1;
    revisionBumped = true;
    effects.push({ type: 'journal', seq: s.revision, epoch: s.epoch, kind, payload, at });
  };
  const reject = (reason, receipt = 'rejected') => fail(receipt, reason);
  const isFac = event.actor.role === 'facilitator';

  const result = handle();
  if (result) return result; // a rejection
  syncMusicTransport(prev, s, at);

  // CASE-319: a lock is a teaching action only when it takes effect: at once, or when its closing window finalises
  // (with the id of the Lock that opened the window), never when the window opens.
  const lockId = event.type === 'finalise_lock' ? prev.round?.closing?.lockId : event.type === 'lock' && s.phase === 'responses_locked' ? event.clientEventId : undefined;
  const teachingKind = lockId ? 'lock' : { select_path: 'selection', reveal: 'reveal', reveal_path: 'reveal' }[event.type];
  if (teachingKind) s = recordTeachingAction(prev, s, { ...event, ...(lockId ? { clientEventId: lockId } : {}), at }, teachingKind);
  if (['reopen', 'void_round', 'enter_manual', 'resume_online', 'reset_checkpoint', 'end'].includes(event.type)) {
    s.teachingActions = []; s.undoPruned = false;
  }
  if (event.type === 'back_to_review' && s.teachingActions?.at(-1)?.kind === 'selection') s.teachingActions.pop();

  markShownResult(I, s);
  if (event.clientEventId) effects.unshift({ type: 'receipt', clientEventId: event.clientEventId, receipt: 'accepted' });
  // A participant's own view does not change when someone else votes or joins, so those
  // broadcasts skip phones (red team: fan-out cost). The voter learns from its receipt.
  if (revisionBumped) {
    // A participant renaming themselves changes no other phone's view either (runtime red team P2-6), and the
    // lobby screen layer is the projector's alone (CASE-176).
    const closingChanged = Boolean(prev.round?.closing) !== Boolean(s.round?.closing);
    const quiet = !closingChanged && (['vote', 'join', 'show_lobby', 'media_control', 'set_music'].includes(event.type) || (event.type === 'rename' && !isFac));
    effects.push({ type: 'broadcast', revision: s.revision, roles: quiet ? ['facilitator', 'display'] : [...ROLES] });
  }
  if (displayBumped) effects.push({ type: 'display', displayRevision: s.display.revision });
  return { state: s, effects };

  // Returns undefined on success, or a { state, effects } rejection.
  function handle() {
    if (LOBBY_BLOCKED.has(event.type) && lobbyShown(s)) return reject('lobby_shown');
    if (s.phase === 'debrief' && !DEBRIEF_COMMANDS.has(event.type)) return reject('in_debrief');
    switch (event.type) {
      case 'join': {
        const pid = event.actor.id;
        if (!UUID.test(pid || '')) return reject('bad_participant_id');
        const existing = s.participants[pid];
        if (existing?.removedAt) return reject('removed');
        if (existing) return undefined; // idempotent rejoin: nothing changes
        if (s.joiningClosed) return reject('joining_closed');
        if (Object.keys(s.participants).length >= MAX_PARTICIPANTS) return reject('room_full');
        s.participants[pid] = { name: cleanName(event.displayName), avatarId: avatarOf(event.avatarId), joinedAt: at, removedAt: null };
        s.arrivalCount = (s.arrivalCount ?? Object.keys(prev.participants).length) + 1;
        // CASE-319: a late joiner gets to answer, so an automatic countdown stops (a facilitator's own Lock does not).
        if (s.round?.closing?.auto) delete s.round.closing;
        journal('participant_joined', { participantId: pid });
        return undefined;
      }
      case 'rename': {
        const pid = isFac ? event.participantId : event.actor.id;
        const p = s.participants[pid];
        if (!p || p.removedAt) return reject('unknown_participant');
        p.name = cleanName(event.displayName);
        if (event.avatarId !== undefined) p.avatarId = avatarOf(event.avatarId); // optional on a rename (CASE-119)
        journal('participant_renamed', { participantId: pid });
        return undefined;
      }
      case 'remove_participant': {
        const p = s.participants[event.participantId];
        if (!p || p.removedAt) return reject('unknown_participant');
        p.removedAt = at;
        if (s.round?.responses[event.participantId]) delete s.round.responses[event.participantId];
        journal('participant_removed', { participantId: event.participantId });
        return undefined;
      }

      case 'vote': return vote();

      case 'start':
        if (s.phase !== 'lobby') return reject('not_in_lobby');
        return enterBeat(s.nextBeatId);

      case 'advance': {
        // A slide step advances only against the revision the facilitator saw: two distinct inputs on one occurrence
        // cannot consume two steps (receipt retries of one input are already idempotent).
        // Manual mode is a single local writer whose staged segment carries no revision (red-team F2); online the room
        // already requires expectRevision on every advance.
        if (!s.manual && compositionFor(s, s.revealed.at(-1)) && event.expectRevision === undefined) return reject('missing_expect_revision');
        if (s.clarification) {
          if (s.phase !== 'responses_open') return reject('cannot_advance_now');
          const entry = s.revealed.at(-1);
          if (entry.groupsShown >= groupsForEntry(s, entry).length) return reject('return_from_clarification_first');
          entry.groupsShown++;
          journal('presentation_group_revealed', { surfaceId: entry.surfaceId, groupIndex: entry.groupsShown, occurrenceId: entry.occurrenceId });
          return undefined;
        }
        if (!['surface_live', 'consequence_revealed', 'terminal_teaching'].includes(s.phase)) return reject('cannot_advance_now');
        if (responsesBlockPublication(I, s)) return reject('hide_responses_first');
        const current = s.revealed.at(-1);
        const total = groupsForEntry(s, current).length;
        if (current && current.groupsShown < total) {
          current.groupsShown += 1;
          journal('presentation_group_revealed', { surfaceId: current.surfaceId, groupIndex: current.groupsShown,
            occurrenceId: current.occurrenceId ?? null });
          return undefined;
        }
        if (recoveryDescriptor(s)?.confirmed === false) return reject('recovery_required');
        if (s.phase === 'terminal_teaching') return reject('no_next_group');
        // A decision beat whose round was voided (or not yet opened) opens a fresh round.
        if (s.decisionId && s.phase === 'surface_live') {
          if (s.manual) return reject('manual_select_path_instead');
          return openRound();
        }
        if (!s.nextBeatId) return reject('no_next_beat');
        return enterBeat(s.nextBeatId);
      }

      case 'lock': {
        if (s.phase !== 'responses_open') return reject('not_open');
        if (s.round.closing) return reject('already_closing');
        // CASE-319: the Worker stamps `graceMs` (and `auto` for its own countdown); a lock without one is immediate, as
        // before. During the window the round stays open (status and phase unchanged, so old screens keep working) and
        // phones send what is in their answer box; `finalise_lock` then freezes the totals once.
        const graceMs = Number.isSafeInteger(event.graceMs) && event.graceMs > 0 ? Math.min(event.graceMs, LOCK_GRACE_MAX_MS) : 0;
        const auto = event.actor.id === SYSTEM_AUTO_LOCK_ACTOR;
        if (auto && (!graceMs || s.autoLock === false || s.round.keptOpen || s.manual || s.clarification)) return reject('auto_lock_off');
        if (!graceMs) return lockRound();
        if (!isUuidV7(event.clientEventId)) return reject('missing_client_event_id');
        s.round.closing = { lockId: event.clientEventId, openedAt: at, closesAt: new Date(Date.parse(at) + graceMs).toISOString(), auto };
        journal('responses_closing', { roundId: s.round.id, closesAt: s.round.closing.closesAt, auto });
        return undefined;
      }

      // Lock now (the facilitator, unfenced: every vote in the window moves the revision) or the deadline (system).
      case 'finalise_lock': {
        if (s.phase !== 'responses_open' || !s.round?.closing) return reject('not_closing');
        if (event.actor.id === SYSTEM_LOCK_ACTOR && Date.parse(at) < Date.parse(s.round.closing.closesAt)) return reject('not_due');
        return lockRound();
      }

      // Keep open: stops the window. After an automatic countdown the round stays open until the facilitator locks.
      case 'cancel_lock': {
        if (s.phase !== 'responses_open' || !s.round?.closing) return reject('not_closing');
        if (s.round.closing.auto) s.round.keptOpen = true;
        delete s.round.closing;
        journal('lock_cancelled', { roundId: s.round.id });
        return undefined;
      }

      case 'set_auto_lock': {
        if (typeof event.on !== 'boolean') return reject('bad_on');
        if ((s.autoLock !== false) === event.on) return undefined;
        s.autoLock = event.on;
        journal('auto_lock_set', { on: event.on });
        return undefined;
      }

      case 'reopen': {
        if (s.phase !== 'responses_locked') return reject('not_locked');
        closeRound('superseded');
        return openRound();
      }

      case 'void_round': {
        if (!['responses_open', 'responses_locked'].includes(s.phase)) return reject('no_round_to_void');
        closeRound('abandoned');
        s.timer = null;
        s.phase = 'surface_live'; // decisionId kept: `advance` opens a fresh round
        return undefined;
      }

      case 'select_path': {
        const manualPending = s.manual && s.decisionId && s.phase === 'surface_live';
        if (s.phase !== 'responses_locked' && !manualPending) return reject('cannot_select_now');
        const current = s.revealed.at(-1);
        if (manualPending && current && current.groupsShown < groupsForEntry(s, current).length) return reject('presentation_context_pending');
        const path = I.paths.get(event.pathId);
        if (!path || path.decision_id !== s.decisionId) return reject('path_not_in_decision');
        if (s.exploredTerminal.includes(path.id)) return reject('path_already_explored');
        s.selectedPathId = path.id;
        s.resolutionKind = s.manual ? 'manual_room' : resolutionKind(path.id);
        s.phase = 'path_selected';
        journal('path_selected', { decisionId: s.decisionId, pathId: path.id, resolutionKind: s.resolutionKind });
        return undefined;
      }

      case 'back_to_review': {
        if (s.phase !== 'path_selected') return reject('nothing_selected');
        s.selectedPathId = null;
        s.resolutionKind = null;
        s.phase = s.round && s.round.status === 'locked' ? 'responses_locked' : 'surface_live';
        journal('selection_cleared', { decisionId: s.decisionId });
        return undefined;
      }

      case 'reveal_path': {
        if (s.phase === 'discussion_paused') return reject('resume_first');
        const manualPending = s.manual && s.decisionId && ['surface_live', 'path_selected'].includes(s.phase);
        if (!manualPending && !(s.round?.status === 'locked' && ['responses_locked', 'path_selected'].includes(s.phase))) return reject('cannot_reveal_now');
        const current = s.revealed.at(-1);
        if (!current || current.groupsShown < groupsForEntry(s, current).length) return reject('presentation_context_pending');
        const path = I.paths.get(event.pathId);
        if (!path || path.decision_id !== s.decisionId) return reject('path_not_in_decision');
        if (s.exploredTerminal.includes(path.id)) return reject('path_already_explored');
        if (s.phase === 'path_selected' && s.selectedPathId !== path.id) return reject('selected_path_mismatch');
        if (s.phase !== 'path_selected') {
          s.selectedPathId = path.id;
          s.resolutionKind = s.manual ? 'manual_room' : resolutionKind(path.id);
          s.phase = 'path_selected';
          journal('path_selected', { decisionId: s.decisionId, pathId: path.id, resolutionKind: s.resolutionKind });
        }
        s.resultsShown = false;
        s.namesShown = false;
        if (s.display.cursor !== null || s.display.lobby) { s.display.revision++; displayBumped = true; }
        s.display.cursor = null;
        s.display.lobby = false;
        return publishConsequence();
      }

      case 'undo': {
        const descriptor = undoDescriptor(s);
        if (!descriptor.available) return reject(descriptor.reason);
        if (event.targetEventId !== descriptor.targetEventId) return reject('stale_undo_target');
        const action = s.teachingActions.at(-1);
        const context = s.revealed[action.contextIndex];
        if (!context || (action.contextOccurrenceId && context.occurrenceId !== action.contextOccurrenceId)) return reject('correction_context_missing');
        if (action.kind === 'selection') {
          if (s.phase !== 'path_selected') return reject('selection_context_changed');
          s.selectedPathId = null; s.resolutionKind = null;
          s.phase = s.manual ? 'surface_live' : 'responses_locked';
        } else {
          if (!s.manual) {
            const source = event.sourceRound ?? (s.round?.id === action.roundId ? s.round : null);
            if (!source || source.id !== action.roundId || source.decisionId !== action.decisionId ||
                !['locked', 'resolved'].includes(source.status) || !isUuidV7(event.roundId)) return reject('correction_evidence_missing');
            const responses = {};
            const decision = I.decisions.get(action.decisionId);
            for (const [pid, row] of Object.entries(source.responses ?? {})) {
              if (!s.participants[pid] || s.participants[pid].removedAt) continue;
              const response = normaliseResponse(decision, row.response, s.disabledOptions[action.decisionId] ?? []);
              if (!response) continue;
              const id = event.seedResponseIds?.[pid];
              if (!isUuidV7(id) || id === row.id) return reject('missing_seed_id');
              responses[pid] = { ...row, id, response, seed: { sourceResponseId: row.id,
                sourceRoundId: source.id, sourceClientEventId: row.clientEventId,
                seededAt: at, correctionEventId: event.clientEventId } };
            }
            // The live round gives way to the fresh seeded round and closes as superseded, as Reopen closes it:
            // a history round left locked with no closedAt never lets the archive finalise.
            if (s.round) {
              if (s.round.status === 'open') freezeRound();
              closeRound('superseded');
            }
            const status = action.kind === 'reveal' ? 'locked' : 'open';
            const no = Math.max(source.no, ...s.rounds.filter(round => round.decisionId === action.decisionId).map(round => round.no)) + 1;
            s.round = { id: event.roundId, decisionId: action.decisionId, no, status, openedAt: at,
              lockedAt: status === 'locked' ? at : null, responses, aggregate: null, suggestion: null,
              seedSourceRoundId: source.id, correctionEventId: event.clientEventId, seededStatus: status };
            if (status === 'locked') freezeRound();
            const remaining = Math.min(action.remainingS ?? 0,
              Math.max(0, Math.floor(((event.expiresAtMs ?? Infinity) - Date.parse(at)) / 1000)));
            s.timer = status === 'open' && remaining > 0 ? { durationS: remaining, startedAt: at, remainingS: null, totalS: Math.max(remaining, action.totalS ?? remaining) } : null;
            s.phase = status === 'locked' ? 'responses_locked' : 'responses_open';
          } else {
            if (action.kind !== 'reveal' || s.round) return reject('manual_context_mismatch');
            s.phase = 'surface_live'; s.timer = null;
          }
          Object.assign(s, action.control);
          if (action.continuation) {
            if (action.continuation.checkpoint) s.checkpoints[action.continuation.beatId] = structuredClone(action.continuation.checkpoint);
            else delete s.checkpoints[action.continuation.beatId];
          }
          if (action.control.checkpoint) s.checkpoints[action.control.beatId] = structuredClone(action.control.checkpoint);
          else if (action.kind === 'reveal') delete s.checkpoints[action.control.beatId];
          delete s.checkpoint;
          s.decisionId = action.decisionId;
          s.selectedPathId = null; s.resolutionKind = null; s.resumePhase = null;
          if (action.kind === 'reveal') {
            const restored = { ...context, groupsShown: action.groupsShown, at,
              occurrenceId: event.clientEventId, correctionOf: action.id,
              restoresOccurrenceId: context.occurrenceId ?? null };
            s.revealed.push(restored); s.liveSurfaceId = context.surfaceId;
          }
        }
        s.resultsShown = false; s.namesShown = false; s.resultsPage = 0;
        s.rankedSelection = { group: 0, position: 0 };
        if (s.display.cursor !== null || s.display.lobby) { s.display.revision++; displayBumped = true; }
        s.display.cursor = null; s.display.lobby = false;
        s.teachingActions = consumeTeachingAction(s, action);
        journal('teaching_corrected', { targetEventId: action.id, actionKind: action.kind,
          decisionId: action.decisionId, sourceRoundId: action.roundId,
          roundId: s.round?.id ?? null, occurrenceId: s.revealed.at(-1)?.occurrenceId ?? null,
          contextOccurrenceId: context.occurrenceId ?? null, groupsShown: action.groupsShown,
          mode: action.mode });
        return undefined;
      }

      case 'reveal': {
        if (s.phase !== 'path_selected') return reject('nothing_selected');
        if (responsesBlockPublication(I, s)) return reject('hide_responses_first');
        return publishConsequence();
      }

      case 'show_clarification': {
        if (s.clarification) return reject('clarification_already_shown');
        if (s.round?.closing) return reject('closing');
        const card = s.caseDoc.schema_version >= 2 && s.caseDoc.required_capabilities?.includes('early_clarification')
          ? s.caseDoc.clarifications?.find(item => item.id === event.clarificationId && item.beat_ids.includes(s.beatId)) : null;
        if (!card || s.phase !== 'responses_open' || !s.round || !I.surfaces.has(card.surface_id)) return reject('clarification_unavailable');
        const context = s.revealed.at(-1);
        if (!context?.occurrenceId) return reject('clarification_context_missing');
        s.clarification = { id: card.id, contextIndex: s.revealed.length - 1, occurrenceId: event.clientEventId };
        revealSurface(card.surface_id, { kind: 'clarification', clarificationId: card.id });
        journal('clarification_shown', { clarificationId: card.id, occurrenceId: event.clientEventId, ...publicationEvidence() });
        return undefined;
      }
      case 'return_clarification': {
        if (!s.clarification || event.occurrenceId !== s.clarification.occurrenceId) return reject('stale_clarification_occurrence');
        const context = s.revealed[s.clarification.contextIndex];
        if (!context || !['responses_open','responses_locked'].includes(s.phase)) return reject('clarification_context_missing');
        s.revealed.push({ ...context, at, occurrenceId: event.clientEventId, clarificationReturnOf: context.occurrenceId });
        s.liveSurfaceId = context.surfaceId;
        s.clarification = null;
        journal('clarification_returned', { ...publicationEvidence(), restoresOccurrenceId: context.occurrenceId });
        return undefined;
      }

      case 'confirm_recovery': {
        const recovery = recoveryDescriptor(s);
        if (!recovery || !['consequence_revealed', 'terminal_teaching'].includes(s.phase)) return reject('no_recovery_pending');
        if (event.occurrenceId !== recovery.occurrenceId || !isUuidV7(event.occurrenceId)) return reject('stale_recovery_occurrence');
        if (typeof event.confirmed !== 'boolean') return reject('bad_recovery_confirmation');
        s.recoveryConfirmation = { occurrenceId: recovery.occurrenceId, pathId: recovery.pathId, confirmed: event.confirmed };
        journal('recovery_confirmation', { occurrenceId: recovery.occurrenceId, pathId: recovery.pathId, confirmed: event.confirmed });
        return undefined;
      }

      case 'reset_checkpoint': {
        if (s.phase !== 'terminal_teaching') return reject('not_terminal');
        if (responsesBlockPublication(I, s)) return reject('hide_responses_first');
        if (recoveryDescriptor(s)?.confirmed === false) return reject('recovery_required');
        const path = I.paths.get(s.terminalPathId);
        const cp = path.terminal.checkpoint_beat_id;
        const snap = s.checkpoints[cp];
        s.flags = snap ? [...snap.flags] : [];
        s.exploredTerminal.push(path.id);
        const greyed = new Set([...(s.disabledOptions[path.decision_id] || []), ...(path.option_ids || [])]);
        s.disabledOptions[path.decision_id] = [...greyed];
        s.terminalPathId = null;
        s.decisionId = null;
        journal('checkpoint_reset', { pathId: path.id, checkpointBeatId: cp });
        return enterBeat(cp, { checkpointOf: snap?.occurrenceId ?? null });
      }

      case 'pause':
        // CASE-255: Pause for discussion is retired. Nothing enters `discussion_paused` any more;
        // `resume` stays so a room persisted while paused can still continue.
        return reject('retired');

      case 'resume': {
        if (s.phase !== 'discussion_paused') return reject('not_paused');
        s.phase = s.resumePhase;
        s.resumePhase = null;
        if (s.timer && s.timer.remainingS !== null) s.timer = { durationS: s.timer.remainingS, startedAt: at, remainingS: null, totalS: s.timer.totalS ?? s.timer.durationS };
        journal('discussion_resumed', { phase: s.phase });
        return undefined;
      }

      case 'show_names': {
        if (typeof event.on !== 'boolean') return reject('bad_payload');
        if (event.on && responsesBlockPublication(I, s)) return reject('hide_responses_first');
        s.namesShown = event.on;
        journal('names_shown', { on: event.on });
        return undefined;
      }

      case 'show_results': {
        if (typeof event.on !== 'boolean') return reject('bad_payload');
        if (!closedResponseRound(I, s) || s.display.cursor !== null) return reject('no_closed_result');
        s.resultsShown = event.on;
        if (event.on) s.namesShown = false;
        journal('results_shown', { on: event.on });
        return undefined;
      }

      case 'results_page': {
        if (!Number.isInteger(event.page) || event.page < 0 || event.page > 3) return reject('bad_payload');
        const result = responseResult(I, s);
        if (!result || result.type !== 'ranking' || result.counts.length <= 2
          || event.page >= Math.ceil(result.counts.length / 2)) return reject('no_closed_result');
        s.resultsPage = event.page;
        journal('results_page', { page: event.page });
        return undefined;
      }

      case 'text_page': {
        if (!UUID.test(event.closedRoundId ?? '') || !Number.isInteger(event.page) || event.page < 0 || event.page >= MAX_PARTICIPANTS) return reject('bad_payload');
        const page = responseResult(I, s)?.textPage;
        if (!page) return reject('no_closed_result');
        if (event.closedRoundId !== page.closedRoundId) return reject('stale_closed_round');
        if (event.page >= page.pages) return reject('bad_payload');
        s.textSelection = { closedRoundId: page.closedRoundId, page: event.page };
        journal('results_page', { page: event.page });
        return undefined;
      }

      case 'ranked_page': {
        if (!UUID.test(event.closedRoundId ?? '') || !Number.isSafeInteger(event.group) || event.group < 0 || event.group >= 300
          || !Number.isSafeInteger(event.position) || event.position < 0 || event.position >= 8) return reject('bad_payload');
        const result = responseResult(I, s);
        const round = closedResponseRound(I, s);
        if (!result?.ranked || !round || result.ranked.totalGroups === 0) return reject('no_closed_result');
        if (event.closedRoundId !== round.id) return reject('stale_closed_round');
        const page = rankedPage(I.decisions.get(round.decisionId), round.aggregate, { group: event.group, position: event.position });
        if (!page || page.groupStart !== event.group || page.positionStart !== event.position) return reject('bad_page');
        s.rankedSelection = { group: event.group, position: event.position };
        journal('ranked_page', { group: event.group, position: event.position });
        return undefined;
      }

      case 'media_control': {
        // Card 59 M3 (Julian, 2026-10-15): the facilitator plays, pauses or restarts a video the projector shows now.
        // `position` is seconds into the video; the event's own `at` is the server time it was set.
        const position = event.action === 'restart' ? 0 : event.position;
        if (typeof position !== 'number' || !Number.isFinite(position) || position < 0 || position > 121) return reject('bad_payload');
        const next = { blockId: event.blockId, playing: event.action !== 'pause', at: position, since: at };
        if (!playbackView({ ...s, playback: next }, I)) return reject('not_revealed');
        s.playback = next;
        journal('media_control', { blockId: event.blockId, action: event.action, position });
        return undefined;
      }

      case 'set_timer': {
        if (s.phase !== 'responses_open') return reject('no_open_round');
        if (s.round?.closing) return reject('closing');
        if (event.seconds !== null && !(Number.isInteger(event.seconds) && event.seconds >= 10 && event.seconds <= 600)) return reject('bad_payload');
        s.timer = event.seconds === null ? null : { durationS: event.seconds, startedAt: at, remainingS: null, totalS: event.seconds };
        journal('timer_set', { seconds: event.seconds });
        return undefined;
      }

      // CASE-334: the room music's track (Auto shuffles the four decision themes) and Build intensity, 0–150%. Public,
      // non-personal room state the projector plays from; it never depends on votes, correctness or the case pack.
      case 'set_music': {
        // CASE-335: the player also sets the room's music on/off, music volume and Effects on/off for every projector.
        const valid = { choice: validMusicChoice, intensity: validMusicIntensity, playing: v => typeof v === 'boolean', volume: validMusicVolume, effects: v => typeof v === 'boolean' };
        const given = Object.keys(valid).filter(key => event[key] !== undefined);
        if (!given.length || given.some(key => !valid[key](event[key]))) return reject('bad_payload');
        const current = musicOf(s), next = { ...current, ...Object.fromEntries(given.map(key => [key, event[key]])) };
        if (given.every(key => next[key] === current[key])) return undefined;
        s.music = structuredClone(next);
        journal('music_set', { choice: next.choice, intensity: next.intensity, playing: next.playing, volume: next.volume, effects: next.effects });
        return undefined;
      }

      case 'replay': {
        if (event.entryIndex !== undefined && event.surfaceId !== undefined) return reject('ambiguous_replay_target');
        let target = null;
        if (event.entryIndex !== undefined) {
          if (event.entryIndex !== null && !(Number.isSafeInteger(event.entryIndex) && event.entryIndex >= 0 && event.entryIndex < s.revealed.length)) return reject('not_revealed');
          target = event.entryIndex;
        } else if (event.surfaceId !== undefined && event.surfaceId !== null) {
          target = s.revealed.findLastIndex((r) => r.surfaceId === event.surfaceId);
          if (target < 0) return reject('not_revealed');
        }
        // In Debrief a null cursor is the debrief page, so the last slide is replayed by its index like any other.
        s.display.cursor = target === s.revealed.length - 1 && s.phase !== 'debrief' ? null : target;
        s.display.revision += 1;
        displayBumped = true;
        return undefined;
      }

      case 'show_lobby': {
        // The projector returns to the lobby join screen mid-case (CASE-176): a display layer over the phase.
        // Only display.lobby and display.revision change; phones are not told (their view is identical).
        if (typeof event.on !== 'boolean') return reject('bad_payload');
        if (s.phase === 'lobby') return reject('already_in_lobby');
        if (s.manual) return reject('manual_room');
        if (event.on === lobbyShown(s)) return reject('no_change');
        s.display.lobby = event.on;
        s.display.revision += 1;
        displayBumped = true;
        journal('lobby_shown', { on: event.on });
        return undefined;
      }

      case 'enter_manual': {
        if (s.manual) return reject('already_manual');
        if (!UUID.test(event.segmentId || '')) return reject('bad_payload');
        if (s.manualSegments.some((m) => m.segmentId === event.segmentId)) return reject('segment_reused');
        // Inside an open or locked round, entering manual mode voids that round first, as ONE
        // command: the facilitator may be offline and cannot send void_round separately (CASE-071).
        const inRound = ['responses_open', 'responses_locked'].includes(s.phase)
          || (s.phase === 'discussion_paused' && ['responses_open', 'responses_locked'].includes(s.resumePhase));
        if (inRound) {
          closeRound('abandoned');
          s.timer = null;
          if (s.phase === 'discussion_paused') s.resumePhase = 'surface_live';
          else s.phase = 'surface_live';
        }
        if (!isStableBoundary(s)) return reject('not_a_stable_boundary');
        // An outage tool: the same-PC projector follows the manual projection, so the lobby layer ends (CASE-176).
        if (s.display.lobby) { s.display.lobby = false; s.display.revision += 1; displayBumped = true; }
        s.epoch += 1;
        s.manual = { segmentId: event.segmentId, startedAt: at, markers: [] };
        journal('manual_entered', { segmentId: event.segmentId });
        return undefined;
      }

      case 'manual_marker': {
        if (!s.manual) return reject('not_manual');
        // The console keeps marker text on the device and uploads it empty (SCREENS §Manual room
        // mode); an empty marker is still a marker, counted by ordinal.
        const text = cleanText(event.text, 200) || null;
        s.manual.markers.push({ text, at });
        // Free text never enters the journal (it outlives the 24 h purge); only its ordinal does.
        journal('manual_marker', { segmentId: s.manual.segmentId, markerNo: s.manual.markers.length });
        return undefined;
      }

      case 'resume_online': {
        if (!s.manual) return reject('not_manual');
        if (s.phase === 'path_selected' || s.resumePhase === 'path_selected') return reject('reveal_or_clear_selection_first');
        s.manualSegments.push({ segmentId: s.manual.segmentId, startedAt: s.manual.startedAt, endedAt: at, markers: s.manual.markers.length });
        journal('manual_exited', { segmentId: s.manual.segmentId });
        s.manual = null;
        s.epoch += 1;
        return undefined;
      }

      case 'takeover': {
        // A new facilitator device claims the room; every older tab is fenced out.
        s.epoch += 1;
        journal('facilitator_takeover', {});
        return undefined;
      }

      case 'close_joining': {
        if (typeof event.closed !== 'boolean') return reject('bad_payload');
        s.joiningClosed = event.closed;
        journal('joining_closed', { closed: event.closed });
        return undefined;
      }

      case 'debrief': {
        // Console layout v2: from a shown slide only, never inside a round or in manual mode. Joining stops (it returns
        // as it was on Back to the case); the projector leaves the join screen and any replay for the debrief summary.
        if (!DEBRIEF_FROM.includes(s.phase)) return reject('not_at_a_slide');
        if (s.manual) return reject('manual_room');
        if (s.clarification) return reject('clarification_shown');
        s.debrief = { resumePhase: s.phase, joiningClosed: Boolean(s.joiningClosed), page: 0, startedAt: at };
        s.phase = 'debrief';
        s.joiningClosed = true;
        s.timer = null;
        s.display.lobby = false; s.display.cursor = null; s.display.revision += 1; displayBumped = true;
        journal('debrief_started', {});
        return undefined;
      }
      case 'back_to_case': {
        // Back to the case restores exactly where the room was: its phase and joining. Feedback already sent is kept.
        if (s.phase !== 'debrief' || !s.debrief) return reject('not_in_debrief');
        s.phase = s.debrief.resumePhase;
        s.joiningClosed = s.debrief.joiningClosed;
        s.debrief = null;
        s.display.cursor = null; s.display.revision += 1; displayBumped = true;
        journal('debrief_left', {});
        return undefined;
      }
      case 'debrief_page': {
        // Which debrief page the projector shows: 0 is the summary, then each result the room was shown. Like replay, a
        // display-only change (no journal); it clears any replayed slide.
        if (s.phase !== 'debrief' || !s.debrief) return reject('not_in_debrief');
        if (!Number.isSafeInteger(event.page) || event.page < 0) return reject('bad_payload');
        const pages = debriefPageCount(I, s);
        s.debrief.page = Math.min(event.page, pages - 1);
        s.display.cursor = null; s.display.revision += 1; displayBumped = true;
        return undefined;
      }

      case 'end': {
        if (s.round && ['open', 'locked'].includes(s.round.status)) closeRound('abandoned');
        if (s.phase === 'debrief') s.display.cursor = null; // a Debrief replay ends with the room
        s.debrief = null;
        if (s.manual) {
          s.manualSegments.push({ segmentId: s.manual.segmentId, startedAt: s.manual.startedAt, endedAt: at, markers: s.manual.markers.length });
          s.manual = null;
        }
        s.rankedSelection = { group: 0, position: 0 };
        s.phase = 'ended';
        s.resumePhase = null;
        s.timer = null;
        s.endedAt = at;
        journal('room_ended', {});
        return undefined;
      }
    }
    return reject('unknown_command');
  }

  function publishConsequence() {
        const path = I.paths.get(s.selectedPathId);
        const decisionId = s.decisionId;
        const roundId = s.round?.id ?? null;
        if (s.round) {
          s.round.selectedPathId = path.id;
          s.round.resolutionKind = s.resolutionKind;
          s.round.consequenceOccurrenceId = event.clientEventId ?? null;
          closeRound('resolved');
        }
        applyFlags(path.set_flags, path.clear_flags);
        const terminal = path.classification === 'terminal-unsafe';
        if (directContinuation(s.caseDoc, path)) {
          const resolutionKind = s.resolutionKind;
          s.selectedPathId = null; s.resolutionKind = null;
          const rejected = enterBeat(path.next_beat_id);
          if (rejected) return rejected;
          journal('consequence_revealed', { decisionId, pathId: path.id, resolutionKind, terminal: false,
            roundId, publication: publicationEvidence() });
          return undefined;
        }
        revealSurface(path.reveal_surface_id, { pathId: path.id, kind: terminal ? 'terminal' : 'consequence' });
        s.revealed.at(-1).decisionId = decisionId;
        journal('consequence_revealed', { decisionId, pathId: path.id, resolutionKind: s.resolutionKind, terminal,
          roundId, publication: publicationEvidence() });
        s.selectedPathId = null;
        if (terminal) {
          s.terminalPathId = path.id;
          s.phase = 'terminal_teaching';
          s.nextBeatId = null;
        } else {
          s.decisionId = null;
          s.nextBeatId = path.next_beat_id;
          s.phase = 'consequence_revealed';
        }
        s.resolutionKind = null;
        return undefined;
  }

  function vote() {
    const pid = event.actor.id;
    const p = s.participants[pid];
    if (!event.clientEventId) return reject('missing_client_event_id');
    if (!p || p.removedAt) return reject('unknown_participant');
    if (s.manual) return reject('manual_room');
    const known = s.round?.id === event.roundId ? s.round : null;
    if (!known) {
      const old = s.rounds.find((r) => r.id === event.roundId);
      if (old?.status === 'abandoned') return reject('round_voided');
      return old ? reject('round_closed', 'locked') : reject('unknown_round');
    }
    if (s.phase === 'discussion_paused' && s.resumePhase === 'responses_open') return reject('paused', 'paused_held');
    if (s.phase !== 'responses_open') return reject('round_locked', 'locked');
    if (known.closing && Date.parse(at) >= Date.parse(known.closing.closesAt)) return reject('round_locked', 'locked');
    const decision = I.decisions.get(known.decisionId);
    const response = normaliseResponse(decision, event.response, s.disabledOptions[decision.id] || []);
    if (!response) return reject('bad_response');
    const prior = known.responses[pid];
    if (!prior && !UUID.test(event.responseId || '')) return reject('missing_response_id'); // minted by the server (wire.buildEvent)
    // A free-text answer that looks like a patient identifier is flagged for the facilitator (spec red
    // team 2, P2). The flag carries kinds only, never the matched text, and changes nothing else.
    const idFlags = response.text !== undefined ? identifierKinds(response.text) : [];
    known.responses[pid] = {
      id: prior?.id ?? event.responseId,
      response,
      clientEventId: event.clientEventId ?? null,
      firstAt: prior?.firstAt ?? at,
      lastAt: at,
      ...(prior?.seed ? { seed: prior.seed } : {}),
      ...(idFlags.length ? { idFlags } : {}),
    };
    journal('response_recorded', { roundId: known.id, participantId: pid });
    return undefined;
  }

  function enterBeat(beatId, { checkpointOf = null } = {}) {
    const beat = I.beats.get(beatId);
    if (!beat) return reject('unknown_beat');
    for (const k of beat.requires_flags || []) if (!s.flags.includes(k)) return reject('entry_flags_unmet');
    s.checkpoints[beat.id] = { flags: [...s.flags], ...(isUuidV7(event.clientEventId) ? { occurrenceId: event.clientEventId } : {}) };
    s.rankedSelection = { group: 0, position: 0 };
    s.beatId = beat.id;
    revealSurface(beat.surface_id, { kind: 'live' });
    if (checkpointOf) s.revealed.at(-1).checkpointOf = checkpointOf;
    if (beat.kind === 'decision') {
      s.decisionId = beat.decision_id;
      s.nextBeatId = null;
      journal('beat_entered', { beatId: beat.id, decisionId: beat.decision_id, publication: publicationEvidence() });
      // A decision first presents its authored context; even a direct start/advance cannot open
      // responses until the facilitator has deliberately revealed every populated group.
      s.phase = 'surface_live';
    } else {
      s.decisionId = null;
      s.nextBeatId = beat.next_beat_id ?? null;
      s.phase = 'surface_live';
      journal('beat_entered', { beatId: beat.id, publication: publicationEvidence() });
    }
    return undefined;
  }

  function lockRound() {
    delete s.round.closing;
    s.round.status = 'locked';
    s.round.lockedAt = at;
    freezeRound();
    s.timer = null;
    s.phase = 'responses_locked';
    if (s.resultsShown !== false) s.namesShown = false;
    journal('responses_locked', { roundId: s.round.id, total: s.round.aggregate.total });
    return undefined;
  }

  function freezeRound() {
        const decision = I.decisions.get(s.round.decisionId);
        const responses = Object.values(s.round.responses).map((r) => r.response);
        const sug = runtimeSuggestion(s, decision, responses);
        s.round.aggregate = { counts: sug.counts, total: sug.total };
        if (decision.interaction.type === 'ranking') {
          const eligibleOptionIds = decision.interaction.options.filter(option => !(s.disabledOptions[decision.id] ?? []).includes(option.id)).map(option => option.id);
          const rankCount = decision.interaction.rank_count ?? eligibleOptionIds.length;
          const positionCounts = Object.fromEntries(decision.interaction.options.map(option => [option.id, Array(rankCount).fill(0)]));
          for (const response of responses) response.order.forEach((optionId, position) => { positionCounts[optionId][position]++; });
          Object.assign(s.round.aggregate, { rankCount, eligibleOptionIds, positionCounts,
            completeOrders: buildRankedGroups(decision.interaction.options, responses, { rankCount, eligibleOptionIds }) });
        }
        s.round.suggestion = { pathId: sug.path_id, reason: sug.reason, kind: sug.kind };
  }

  function openRound() {
    const decision = I.decisions.get(s.decisionId);
    const no = s.rounds.filter((r) => r.decisionId === decision.id).length + 1;
    if (!UUID.test(event.roundId || '')) return reject('missing_round_id');
    s.round = { id: event.roundId, decisionId: decision.id, no, status: 'open', openedAt: at, lockedAt: null, responses: {}, aggregate: null, suggestion: null };
    s.resultsShown = true;
    s.resultsPage = 0;
    s.rankedSelection = { group: 0, position: 0 };
    s.timer = decision.timer_s ? { durationS: decision.timer_s, startedAt: at, remainingS: null, totalS: decision.timer_s } : null;
    s.phase = 'responses_open';
    journal('responses_opened', { roundId: s.round.id, decisionId: decision.id, roundNo: no });
    return undefined;
  }

  function closeRound(status) {
    const r = s.round;
    if (status === 'abandoned') s.rankedSelection = { group: 0, position: 0 };
    s.rounds.push({
      id: r.id, decisionId: r.decisionId, no: r.no, status, openedAt: r.openedAt, lockedAt: r.lockedAt,
      closedAt: at, aggregate: status === 'abandoned' ? null : r.aggregate,
      selectedPathId: r.selectedPathId ?? null, resolutionKind: r.resolutionKind ?? null,
      ...(r.consequenceOccurrenceId ? { consequenceOccurrenceId: r.consequenceOccurrenceId } : {}),
      ...(r.seedSourceRoundId ? { seedSourceRoundId: r.seedSourceRoundId, correctionEventId: r.correctionEventId } : {}),
      ...(['open', 'locked'].includes(r.seededStatus) ? { seededStatus: r.seededStatus } : {}),
      ...(r.shown ? { shown: true } : {}), // card 40 (R5): the room saw this round's result
      // per-participant answers survive for the private recap only; never projected publicly
      answers: status === 'abandoned' ? {} : Object.fromEntries(Object.entries(r.responses).map(([pid, x]) => [pid, x.response])),
    });
    journal('round_closed', { roundId: r.id, status });
    s.round = null;
  }

  function revealSurface(surfaceId, { pathId = null, kind, clarificationId = null }) {
    const surface = I.surfaces.get(surfaceId);
    const variant = (surface.variants || []).findIndex((v) => v.when_flags.every((k) => s.flags.includes(k)));
    const entry = { surfaceId, beatId: s.beatId, pathId, kind, variant, manual: Boolean(s.manual), at, groupsShown: 0 };
    if (isUuidV7(event.clientEventId)) entry.occurrenceId = event.clientEventId;
    // The clarification identity is known before progress is counted, so its own slide is found (key order kept).
    if (clarificationId) entry.clarificationId = clarificationId;
    entry.groupsShown = Math.min(1, groupsForEntry(s, entry).length);
    s.revealed.push(entry);
    s.liveSurfaceId = surfaceId;
  }

  function publicationEvidence() {
    const entry = s.revealed.at(-1);
    return { occurrenceId: entry.occurrenceId ?? null, surfaceId: entry.surfaceId, beatId: entry.beatId,
      kind: entry.kind, variant: entry.variant, groupsShown: entry.groupsShown, manual: entry.manual,
      ...(entry.checkpointOf ? { checkpointOf: entry.checkpointOf } : {}) };
  }

  function applyFlags(set = [], clear = []) {
    s.flags = [...new Set([...s.flags, ...set])].filter((k) => !clear.includes(k));
  }

  function resolutionKind(pathId) {
    // `majority` only when votes actually favoured this path; a fallback (no votes, tie) is not a majority.
    if (s.round?.suggestion?.pathId === pathId && ['plurality', 'rules'].includes(s.round.suggestion.kind)) return 'majority';
    const decision = I.decisions.get(s.decisionId);
    const path = I.paths.get(pathId);
    if (humanInterpretation(s, decision)) return 'override';
    const anyone = Object.values(s.round?.responses || {}).some(({ response }) => {
      if (decision.interaction.type === 'single_choice') return (path.option_ids || []).includes(response.option_id);
      return suggestPath(decision, [response]).path_id === pathId;
    });
    return anyone ? 'minority' : 'override';
  }
}

// ─── idempotency and manual segments ────────────────────────────────────────

/**
 * Stable key and payload fingerprint for idempotency. The key is scoped to the sender, so one
 * participant can never collide with another's client_event_id.
 */
export function ledgerKey(event) {
  return `${event.actor?.role}:${event.actor?.id ?? ''}:${event.clientEventId}`;
}
function fingerprint(event) {
  const { at, epoch, actor, clientEventId, responseId, roundId, expectRevision, sourceRound, seedResponseIds, expiresAtMs, ...payload } = event;
  return stableStringify(payload);
}
function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/**
 * reduce() plus idempotency. `ledger` is any { get(key), set(key, value) } store: a Map in
 * tests, the Durable Object's `receipts` table in production (pruned by age, not by count).
 * Receipts live OUTSIDE reducer state, so state stays small and cheap to copy.
 *   • same client_event_id and same payload → the original outcome (`already_accepted`)
 *   • same client_event_id, different payload → `rejected: client_event_id_reused`
 *   • only `accepted` is remembered; other outcomes may legitimately be retried
 */
export function dispatch(state, event, ledger) {
  if (!event?.clientEventId) return reduce(state, event);
  const key = ledgerKey(event);
  const seen = ledger.get(key);
  if (seen) {
    const same = seen.fingerprint === fingerprint(event);
    return { state, effects: [{ type: 'receipt', clientEventId: event.clientEventId, receipt: same ? 'already_accepted' : 'rejected', ...(same ? {} : { reason: 'client_event_id_reused' }) }] };
  }
  const r = reduce(state, event);
  if (r.effects[0]?.receipt === 'accepted') ledger.set(key, { fingerprint: fingerprint(event), at: r.state.lastAt });
  return r;
}

/**
 * Replays a facilitator's manual segment all-or-nothing (HANDOFF §Manual room and recovery).
 * Every event must be accepted; otherwise nothing is applied and the first failure is named.
 * @returns {{ ok: boolean, state: object, effects: object[], failedAt?: number, reason?: string }}
 */
export function applySegment(state, events, ledger) {
  let s = state;
  const effects = [];
  const staged = new Map();
  const view = { get: (k) => staged.get(k) ?? ledger.get(k), set: (k, v) => staged.set(k, v) };
  for (let i = 0; i < events.length; i++) {
    // Presentation targets a particular frozen closure. Server participant activity
    // may advance the session revision during an outage; only this manual command
    // uses the staged revision. Epoch, target identity and receipts still fence it.
    const event = ['text_page', 'ranked_page', 'reveal_path', 'undo', 'confirm_recovery', 'show_clarification', 'return_clarification'].includes(events[i].type) && s.manual ?
      { ...events[i], expectRevision: s.revision } : events[i];
    const r = dispatch(s, event, view);
    const receipt = r.effects.find((e) => e.type === 'receipt');
    if (receipt && !['accepted', 'already_accepted'].includes(receipt.receipt)) {
      return { ok: false, state, effects: [], failedAt: i, reason: receipt.reason ?? receipt.receipt };
    }
    s = r.state;
    effects.push(...r.effects);
  }
  for (const [k, v] of staged) ledger.set(k, v);
  return { ok: true, state: s, effects };
}

function cleanName(n) {
  return cleanText(n, NAME_MAX) || null;
}
/** Only an allow-listed avatar id is ever stored (CASE-119); the wire refuses anything else first. */
function avatarOf(id) {
  return isAvatarId(id) ? id : null;
}

/** Validates a participant response against the decision; returns the normalised response or null. */
export function normaliseResponse(decision, response, disabled = []) {
  if (!response || typeof response !== 'object') return null;
  const it = decision.interaction;
  const options = new Set((it.options || []).map((o) => o.id).filter((id) => !disabled.includes(id)));
  switch (it.type) {
    case 'single_choice':
      return options.has(response.option_id) ? { option_id: response.option_id } : null;
    case 'multi_select': {
      const ids = response.option_ids;
      if (!Array.isArray(ids) || ids.length === 0 || new Set(ids).size !== ids.length || !ids.every((o) => options.has(o))) return null;
      return { option_ids: [...ids] };
    }
    case 'ranking': {
      const order = response.order;
      const need = it.rank_count ?? options.size;
      if (!Array.isArray(order) || order.length === 0 || order.length !== need || new Set(order).size !== order.length || !order.every((o) => options.has(o))) return null;
      return { order: [...order] };
    }
    case 'free_text': {
      // Keep one character beyond the supported ceiling so an overlong answer is
      // rejected instead of being silently truncated into a valid response.
      const text = cleanText(response.text, FREE_TEXT_MAX + 1);
      if (!text || text.length > it.max_length) return null;
      return { text };
    }
  }
  return null;
}

// ─── projections ─────────────────────────────────────────────────────────────

function surfaceView(I, entry, { state = null, facilitator = false } = {}) {
  const s = I.surfaces.get(entry.surfaceId);
  const composition = state ? compositionFor(state, entry) : null;
  if (composition) {
    // A composed surface has no legacy learner fields. The facilitator holds the whole composition; public roles
    // receive only the released steps' blocks through publicPresentationSurface.
    const blocks = slideIndex(state).blocks, view = { surfaceId: s.id, kind: s.kind, title: s.title,
      // The case's presentation theme (CASE-227) travels with each slide, only when one is chosen.
      slide: { composition, blocks: composition.reading_order.map(id => blocks.get(id)).filter(Boolean).map(block => imageView(state, block, facilitator)), ...(slideTheme(state.caseDoc) ? { theme: slideTheme(state.caseDoc) } : {}) },
      ...(facilitator ? { notes: [s.notes, ...new Set(composition.reading_order.map(id => state.media?.[blocks.get(id)?.asset_id]?.credit).filter(Boolean))].filter(Boolean).join('\n\n') || null } : {}), assetIds: [], timelineKind: entry.kind, manual: entry.manual, at: entry.at };
    return facilitator ? view : publicPresentationSurface(view, entry.groupsShown);
  }
  const v = entry.variant >= 0 ? s.variants[entry.variant] : s;
  const prev = state ? previousObservations(I, state, entry) : null;
  const view = {
    surfaceId: s.id, kind: s.kind, title: s.title,
    // These authored groups are assembled here; the public projection below releases them
    // one group at a time. The facilitator keeps the complete surface in memory.
    scene: v.scene ?? s.scene ?? null, points: [...(v.points ?? s.points ?? [])], investigations: [...(v.investigations ?? s.investigations ?? [])],
    ...(facilitator ? { notes: v.notes ?? s.notes ?? null } : {}),
    observations: (s.observations ?? []).map((o) => {
      const t = trend(prev?.get(o.label), o.value);
      // `previous` is the value the room last saw, shown beside the arrow (CASE-090).
      return { ...o, trend: t, previous: t ? String(prev.get(o.label)).replace(/\s*\(.*\)$/, '') : null }; // `14 (E3 V5 M6)` → `14`
    }),
    assetIds: s.asset_ids ?? [],
    timelineKind: entry.kind, manual: entry.manual, at: entry.at,
  };
  return facilitator ? view : publicPresentationSurface(view, entry.groupsShown);
}

/**
 * The entries on the path the room is now on, up to (not including) index `end`. A checkpoint reset
 * re-enters a beat the room already saw; everything revealed after that beat's earlier entry was the
 * abandoned branch, so it is dropped (walkthrough bug: the trend compared against the arrest scene).
 */
function pathBefore(revealed, end) {
  const throughCurrent = revealed.slice(0, Math.min(end + 1, revealed.length));
  if (throughCurrent.every(entry => isUuidV7(entry.occurrenceId))) {
    const { spine } = traceSpine(throughCurrent);
    return end < revealed.length ? spine.slice(0, -1) : spine;
  }
  // Explicit legacy-only compatibility: these pre-occurrence traces cannot claim v1 identity.
  const path = [];
  const cut = (e) => {
    const restore = e.correctionOf ? e.restoresOccurrenceId : e.checkpointOf;
    if (restore) {
      const index = path.findLastIndex(entry => entry.occurrenceId === restore);
      if (index >= 0) path.length = index;
      return;
    }
    if (e.occurrenceId) return;
    if (e.kind !== 'live' || !e.beatId) return;
    for (let j = path.length - 1; j >= 0; j--) if (path[j].kind === 'live' && path[j].beatId === e.beatId) { path.length = j; return; }
  };
  for (let k = 0; k < end; k++) { cut(revealed[k]); path.push(revealed[k]); }
  if (end < revealed.length) cut(revealed[end]);
  return path;
}

/** The observations of the last scene the room saw before `entry`, on the restored path (CASE-090 trend arrows). */
function previousObservations(I, state, entry) {
  const i = state.revealed.indexOf(entry);
  const path = pathBefore(state.revealed, i < 0 ? state.revealed.length : i);
  for (let k = path.length - 1; k >= 0; k--) {
    const prior = path[k];
    const observationIndex = groupsForEntry(state, prior).indexOf('observations');
    if (observationIndex < 0 || prior.groupsShown <= observationIndex) continue;
    const obs = I.surfaces.get(prior.surfaceId).observations;
    if (obs?.length) return new Map(obs.map((o) => [o.label, o.value]));
  }
  return null;
}

/** 'up' | 'down' | null, from the leading number (systolic for a BP, the total for a GCS). */
function trend(before, now) {
  const n = (x) => Number.parseFloat(String(x ?? '').replace(/^[^0-9.-]*/, ''));
  const a = n(before);
  const b = n(now);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return null;
  return b > a ? 'up' : 'down';
}

function lastEntryFor(state, surfaceId) {
  for (let i = state.revealed.length - 1; i >= 0; i--) if (state.revealed[i].surfaceId === surfaceId) return state.revealed[i];
  return null;
}

/** A CASE-280 direct continuation: the route goes on to the next slide, with no outcome screen. */
const directContinuation = (doc, path) => path.continue_to_next === true && doc.required_capabilities?.includes('direct_continuation');
function publicDecision(I, state) {
  if (!state.decisionId) return null;
  const d = I.decisions.get(state.decisionId);
  const disabled = state.disabledOptions[d.id] || [];
  const explored = new Set(d.paths.filter((p) => state.exploredTerminal.includes(p.id)).flatMap((p) => p.option_ids || []));
  // ONE order for every screen (CASE-088): clients mark options by position with a shared glyph
  // and colour, so the projector and every phone agree on "the blue diamond".
  const options = (d.interaction.options || []).map((o) => ({ id: o.id, label: o.label, disabled: disabled.includes(o.id), explored: explored.has(o.id) }));
  return {
    decisionId: d.id,
    prompt: d.prompt,
    interaction: {
      type: d.interaction.type,
      options,
      maxLength: d.interaction.max_length ?? null,
      rankCount: d.interaction.rank_count ?? null,
    },
    // Julian (2026-10-30, CASE-313): the room may know a choice changes the route, never which route; sent only when true.
    ...(decisionBranches(d) ? { branches: true } : {}),
  };
}

function humanInterpretation(state, decision) {
  return state.caseDoc.schema_version >= 2 && state.caseDoc.required_capabilities?.includes('human_interpretation') && decision.interpretation === 'facilitator';
}
function runtimeSuggestion(state, decision, responses) {
  if (!humanInterpretation(state, decision)) return suggestPath(decision, responses);
  const counts = {};
  for (const response of responses) for (const id of countedOptionIds(response)) counts[id] = (counts[id] ?? 0) + 1;
  return { path_id: null, kind: 'facilitator', reason: 'Facilitator interpretation; choose an authored route.', counts, total: responses.length };
}

/** The answer's path, for recap teaching: option mapping for single choice, rules otherwise. */
function pathOfResponse(I, decisionId, response, state) {
  if (!response) return null;
  const d = I.decisions.get(decisionId);
  if (humanInterpretation(state, d)) return null;
  if (d.interaction.type === 'single_choice') return d.paths.find((p) => (p.option_ids || []).includes(response.option_id)) ?? null;
  return d.paths.find((p) => p.id === suggestPath(d, [response]).path_id) ?? null;
}

/** What a per-option count means for an interaction type (room-result copy, spec red team 2 P2). */
const COUNT_MEANING = { single_choice: 'chose', multi_select: 'selected', ranking: 'ranked_first', free_text: null };

/** The option ids a response counts towards: the choice, every selection, or the first-ranked option. */
function countedOptionIds(response) {
  if (!response) return [];
  if (response.option_id) return [response.option_id];
  if (response.option_ids) return [...response.option_ids];
  if (response.order) return response.order.slice(0, 1);
  return [];
}

/** Keep an explicit authored length; old closed defaults need actual complete answers, never guessed positions. */
function closedRankCount(decision, round) {
  if (decision.interaction.rank_count !== undefined) return decision.interaction.rank_count;
  if (Number.isInteger(round.aggregate.rankCount)) return round.aggregate.rankCount;
  const answers = round.responses ? Object.values(round.responses).map(row => row.response) : Object.values(round.answers ?? {});
  if (answers.length !== round.aggregate.total || !answers.length) return null;
  const length = answers[0]?.order?.length;
  return Number.isInteger(length) && length > 0 && answers.every(answer => answer.order?.length === length) ? length : null;
}

function zeroEligibleResult(decision, round) {
  return decision.interaction.type === 'ranking' && decision.interaction.rank_count === undefined
    && round.aggregate.rankCount === 0 && round.aggregate.total === 0
    && Array.isArray(round.aggregate.eligibleOptionIds) && round.aggregate.eligibleOptionIds.length === 0
    && Object.values(round.aggregate.counts).every(count => count === 0)
    && Object.keys(round.responses ?? round.answers ?? {}).length === 0;
}

function rankingPositions(decision, round) {
  if (round.aggregate.positionCounts) return round.aggregate.positionCounts;
  const answers = round.responses ? Object.values(round.responses).map(row => row.response) : Object.values(round.answers ?? {});
  if (answers.length !== round.aggregate.total) return null;
  const rankCount = closedRankCount(decision, round);
  if (rankCount === null || rankCount < 1) return null;
  const counts = Object.fromEntries(decision.interaction.options.map(option => [option.id, Array(rankCount).fill(0)]));
  for (const answer of answers) {
    if (!Array.isArray(answer.order) || answer.order.length !== rankCount || new Set(answer.order).size !== rankCount
      || answer.order.some(id => !Object.hasOwn(counts, id))) return null;
    answer.order.forEach((id, position) => { counts[id][position]++; });
  }
  return counts;
}

/**
 * The room's result for the most recently revealed round (CASE-080): shown to the projector and
 * phones only AFTER its consequence is revealed, and only while that consequence is still the live
 * surface: it is gone when the room moves to the next surface (the debrief, say) or the next round
 * opens, so it can never anchor a vote. Per-option counts are always shown, however few answered
 * (Julian, CASE-104). Free text is not counted by option; selected anonymous pages use responseResult (CASE-275).
 */
function lastResult(I, state) {
  if (state.round) return null;
  const r = [...state.rounds].reverse().find((x) => x.status === 'resolved');
  if (!r || !r.aggregate) return null;
  const live = state.revealed.at(-1);
  if (!live || live.kind === 'live' || consequenceEvidence(state, r).entry !== live) return null;
  const d = I.decisions.get(r.decisionId);
  const type = d.interaction.type;
  if (type === 'ranking' && closedRankCount(d, r) === 0 && !zeroEligibleResult(d, r)) return null;
  const opts = type === 'free_text' || zeroEligibleResult(d, r) ? [] : d.interaction.options || [];
  const positions = type === 'ranking' && !zeroEligibleResult(d, r) ? rankingPositions(d, r) : null;
  const counts = opts.map((o) => ({ optionId: o.id, label: o.label, count: r.aggregate.counts[o.id] ?? 0,
    ...(positions ? { positionCounts: positions[o.id] } : {}) }));
  const top = Math.max(0, ...counts.map((c) => c.count));
  return {
    decisionId: d.id, prompt: d.prompt, roundNo: r.no, total: r.aggregate.total,
    countMeaning: COUNT_MEANING[type] ?? null,
    ...(positions ? { rankCount: closedRankCount(d, r) } : {}),
    counts,
    // A tie at the top of a single choice: the copy says "the room was split", not a majority.
    split: type === 'single_choice' && top > 0 && counts.filter((c) => c.count === top).length > 1,
    howChosen: r.resolutionKind, // majority | minority | override
    whatHappened: I.surfaces.get(live.surfaceId).title,
  };
}

/** Card 40 (red-team R5): a round's closed result counts as shown to the room once the projector has drawn it, either as
 *  the locked round's responses or as the last result beside its consequence. The flag is never unset, so the ended
 *  debrief lists only results the room actually saw. Pure: derived from the state the display projection reads. */
function markShownResult(I, state) {
  if (state.resultsShown === false || state.display.cursor !== null) return;
  if (responseResult(I, state) !== null) { const r = closedResponseRound(I, state); if (r) r.shown = true; }
  if (lastResult(I, state) !== null) { const r = [...state.rounds].reverse().find((x) => x.status === 'resolved'); if (r) r.shown = true; }
}

/** The Debrief review's questions, facilitator only (console layout v2): each decided round with the slide it was asked
 *  on, its counts, the route chosen (and whether the room's most-chosen answer was on it), the authored routes not taken,
 *  and the debrief page that shows its result on the projector (null for free text, which has no result page). A vote never chose
 *  the route (hard rule 2): `agreed` only reports the comparison. */
function debriefQuestions(I, state) {
  const pub = endedDebrief(I, state, true, 0), first = summaryPages(pub);
  return state.rounds.filter((r) => r.status === 'resolved').map((r, n) => {
    const d = I.decisions.get(r.decisionId), beat = state.caseDoc.beats.find((b) => b.decision_id === r.decisionId);
    const chosen = d.paths.find((p) => p.id === r.selectedPathId) ?? null, options = d.interaction.options || [];
    const positions = d.interaction.type === 'ranking' && r.aggregate ? rankingPositions(d, r) : null; // first-place counts, as the debrief
    const counts = options.map((o) => ({ label: o.label, count: positions ? (positions[o.id]?.[0] ?? 0) : (r.aggregate?.counts?.[o.id] ?? 0) }));
    const top = Math.max(0, ...counts.map((c) => c.count)), leaders = options.filter((o, i) => counts[i].count === top);
    const agreed = d.interaction.type === 'free_text' || d.interaction.type === 'ranking' || !chosen || top === 0 || leaders.length !== 1 ? null
      : (chosen.option_ids ?? []).includes(leaders[0].id);
    const result = pub.results.findIndex((x) => x.roundNo === r.no);
    return { no: n + 1, roundNo: r.no, prompt: d.prompt, type: d.interaction.type, total: r.aggregate?.total ?? 0,
      counts: d.interaction.type === 'free_text' ? [] : counts,
      entryIndex: beat ? (() => { const i = state.revealed.findIndex((e) => e.beatId === beat.id); return i < 0 ? null : i; })() : null,
      resultPage: result < 0 ? null : first + result,
      chosen: chosen ? { label: chosen.label, classification: chosen.classification } : null, agreed,
      notTaken: d.paths.filter((p) => p !== chosen).map((p) => ({ label: p.label, classification: p.classification, rationale: p.rationale ?? '' })) };
  });
}
/** The most pages the public debrief can have: the summary (one or two), then each decided choice or ranking result
 *  (CASE-327). An upper bound read without the aggregates, which a compacted room keeps in SQL for all but its latest
 *  round; the projection clamps the page again against the results it actually has. */
function debriefPageCount(I, state) {
  const shown = state.rounds.filter((r) => r.status === 'resolved' && I.decisions.get(r.decisionId)?.interaction.type !== 'free_text').length;
  return shown + summaryPages(endedDebrief(I, state, false));
}

/** Card 40d: the ended projector's public debrief. Revealed material only: the slides the room's route choices revealed,
 *  the learning objectives (already in every participant's recap) and, only when the facilitator is paging results
 *  (inputs.debriefResults, slice 5), the closed results of every decided round, choice and ranking only (CASE-327). */
function endedDebrief(I, state, withResults, page = 0) {
  const route = state.rounds.filter((r) => r.status === 'resolved' && (I.decisions.get(r.decisionId)?.paths?.length ?? 0) > 1)
    .map((r) => consequenceEvidence(state, r).entry).filter(Boolean).map((e) => I.surfaces.get(e.surfaceId).title);
  // CASE-327 (Julian, 2026-11-01): Debrief always shows a question's result, so every decided choice or ranking round is
  // here, including one the facilitator did not show live (this supersedes red-team R5's shown-only rule for the debrief).
  const results = withResults ? state.rounds.filter((r) => r.status === 'resolved' && r.aggregate).map((r) => {
    const d = I.decisions.get(r.decisionId), type = d.interaction.type;
    if (type === 'free_text' || zeroEligibleResult(d, r)) return null;
    const positions = type === 'ranking' ? rankingPositions(d, r) : null;
    return { prompt: d.prompt, type, roundNo: r.no, total: r.aggregate.total,
      counts: (d.interaction.options || []).map((o) => ({ label: o.label, count: positions ? (positions[o.id]?.[0] ?? 0) : (r.aggregate.counts[o.id] ?? 0) })) };
  }).filter(Boolean) : [];
  const debrief = { route, objectives: [...state.caseDoc.learning_objectives], results };
  // The page the facilitator is showing (slice 5): 0 is the summary, k the k-th result. Only while paging.
  if (withResults) debrief.page = Math.max(0, Math.min(Number.isSafeInteger(page) ? page : 0, results.length + summaryPages(debrief) - 1));
  return debrief;
}

/** Room PDFs v2 ("you vs the room", Julian 2026-10-18): a resolved round's closed result for the participant recap, only when the
 *  room was shown it (r.shown, the ended debrief's rule, red-team R5): revealed numbers and option labels the phone already saw,
 *  choice and ranking only (a ranking by first places). Nothing for a free-text or zero-eligible round. */
function roomSplit(I, r) {
  if (r.status !== 'resolved' || !r.shown || !r.aggregate) return {};
  const d = I.decisions.get(r.decisionId), type = d?.interaction?.type;
  if (!d || type === 'free_text' || zeroEligibleResult(d, r)) return {};
  const positions = type === 'ranking' ? rankingPositions(d, r) : null;
  return { room: { total: r.aggregate.total, options: (d.interaction.options || []).map((o) => ({ label: o.label, count: positions ? (positions[o.id]?.[0] ?? 0) : (r.aggregate.counts[o.id] ?? 0) })) } };
}

/** Legacy chronology can support a title only when its exact disclosure is unique. */
function consequenceEvidence(state, round) {
  if (round.consequenceOccurrenceId) return { entry: state.revealed.find(entry => entry.occurrenceId === round.consequenceOccurrenceId) ?? null,
    kind: 'exact_occurrence' };
  const beat = state.caseDoc.beats.find(candidate => candidate.decision_id === round.decisionId);
  const candidates = state.revealed.filter(entry => ['consequence', 'terminal'].includes(entry.kind) && entry.beatId === beat?.id &&
    entry.pathId === round.selectedPathId && entry.at === round.closedAt);
  return { entry: candidates.length === 1 ? candidates[0] : null,
    kind: candidates.length === 1 ? 'legacy_unique_chronology' : 'legacy_publication_reference_missing' };
}

const PUBLIC_PHASE = {
  lobby: 'waiting', surface_live: 'live', responses_open: 'decision_open', responses_locked: 'reviewing',
  path_selected: 'reviewing', consequence_revealed: 'live', terminal_teaching: 'teaching',
  discussion_paused: 'paused', debrief: 'debrief', ended: 'ended',
};

/** A chart is eligible only for an actually locked round or its still-live consequence. */
function closedResponseRound(I, state) {
  if (state.phase === 'ended' || state.phase === 'debrief' || state.round?.status === 'open') return null;
  if (state.round?.status === 'locked') return state.round;
  const result = lastResult(I, state);
  return result ? [...state.rounds].reverse().find(round => round.status === 'resolved') : null;
}

/** Only an actually displayed live chart can obscure newly published case context. */
function responsesBlockPublication(I, state) {
  return state.resultsShown !== false && state.display.cursor === null
    && (responseResult(I, state) !== null || lastResult(I, state) !== null);
}

// Only the selected anonymous page crosses the public boundary; no response IDs or timestamps.
function publicTextPage(round, selection) {
  const rows = round.responses ? Object.values(round.responses).map(row => row.response) : Object.values(round.answers ?? {});
  const answers = rows.map(row => row?.text).filter(text => typeof text === 'string').sort();
  const pages = packTextPages(answers);
  const page = selection?.closedRoundId === round.id && Number.isInteger(selection.page) && selection.page >= 0 && selection.page < pages.length ? selection.page : 0;
  return { total: answers.length, textPage: { closedRoundId: round.id, page, pages: pages.length, answers: pages[page] } };
}

function responseResult(I, state) {
  if (state.resultsShown === false || state.display.cursor !== null) return null;
  const round = closedResponseRound(I, state);
  if (!round?.aggregate) return null;
  const decision = I.decisions.get(round.decisionId);
  const type = decision.interaction.type;
  const options = type === 'free_text' ? [] : decision.interaction.options ?? [];
  const zero = zeroEligibleResult(decision, round);
  if (zero) {
    const current = projectorDecision(I, state);
    if (!current || current.interaction.rankCount !== null || current.interaction.options.some(option => !option.disabled)) return null;
    return { decisionId: decision.id, prompt: decision.prompt, roundNo: round.no, type, total: 0, rankCount: null, counts: [] };
  }
  const rankCount = type === 'ranking' ? closedRankCount(decision, round) : null;
  const positions = rankCount === null ? null : rankingPositions(decision, round);
  if (type === 'ranking' && (rankCount === null || rankCount < 1 || !positions)) return null;
  return {
    decisionId: decision.id, prompt: decision.prompt, roundNo: round.no,
    type, total: round.aggregate.total, rankCount,
    ...(type === 'free_text' ? publicTextPage(round, state.textSelection) : {}),
    ...(type === 'ranking' && rankedPage(decision, round.aggregate, state.rankedSelection)
      ? { ranked: rankedPage(decision, round.aggregate, state.rankedSelection) } : {}),
    counts: options.map(option => ({ optionId: option.id, label: option.label, count: round.aggregate.counts[option.id] ?? 0,
      positionCounts: rankCount === null ? null : positions[option.id] })),
  };
}

function projectorDecision(I, state) {
  const from = state.phase === 'discussion_paused' ? state.resumePhase : state.phase;
  const current = state.revealed.at(-1);
  const manualPending = state.manual && from === 'surface_live' && state.decisionId
    && current && current.groupsShown === groupsForEntry(state, current).length;
  if (!state.decisionId || !(['responses_open', 'responses_locked', 'path_selected'].includes(from) || manualPending)) return null;
  const status = state.manual ? 'manual' : state.phase === 'discussion_paused' ? 'paused' : from === 'responses_open' ? 'open' : 'locked';
  const { decisionId, prompt, interaction } = publicDecision(I, state);
  const rankCount = interaction.type === 'ranking' ? (state.round?.aggregate ? closedRankCount(I.decisions.get(decisionId), state.round) : interaction.rankCount ?? interaction.options.filter(option => !option.disabled).length) : null;
  return { decisionId, prompt, status, interaction: { type: interaction.type, options: interaction.options, rankCount: rankCount === 0 ? null : rankCount } };
}

/**
 * What a role may see. Display and participant projections never include unrevealed surfaces,
 * paths, cues, classifications, suggestions, or other participants' answers. Closed anonymous
 * counts reach the display; phones receive their result only after the consequence.
 */
/**
 * A phone's revealed timeline (CASE-281). It reads no participant input, so it is the same for every phone: the
 * Durable Object builds it once per broadcast and passes it to project() as `inputs.timeline`.
 */
export function participantTimeline(state) {
  state = normalizePresentationState(state);
  const I = idx(state);
  return state.revealed.map((entry) => surfaceView(I, entry, { state }));
}

/** The console's `m` in "k of m answered": active participants who are connected or have already answered this round. */
function countedParticipants(state, present) {
  const answered = state.round ? state.round.responses : {};
  const active = Object.entries(state.participants).filter(([, p]) => !p.removedAt);
  return present ? active.filter(([id]) => present.has(id) || answered[id]).length : active.length;
}

/** CASE-319: the auto-lock test uses exactly the console's count; someone must be connected. */
export function everyoneAnswered(state, present) {
  if (!state.round) return false;
  const m = countedParticipants(state, new Set(present));
  return m > 0 && Object.keys(state.round.responses).length >= m;
}

// ── room music (CASE-334) ──
// The facilitator's choice and Build intensity, the room's shuffle seed and decision order, and the transport anchor every
// projector plays from (src/shared/music-timeline.mjs). A stored room from before CASE-334 has no `music` and reads as the default.
function initialMusic(seed) { return { seed: String(seed ?? 'room'), choice: 'auto', intensity: MUSIC_INTENSITY_DEFAULT, playing: true, volume: MUSIC_VOLUME_DEFAULT, effects: true, order: [], transport: null }; }
function musicOf(state) { return state.music ? { ...initialMusic(state.sessionId), ...state.music } : initialMusic(state.sessionId); }
function musicTimer(state) {
  const t = state.timer;
  if (!t) return null;
  const totalS = Math.min(600, Math.max(10, Math.round(t.totalS ?? t.durationS)));
  return t.remainingS !== null ? { paused: true, remainingS: t.remainingS, totalS }
    : { paused: false, deadlineMs: Date.parse(t.startedAt) + t.durationS * 1000, totalS };
}
/** Re-anchor the music when its public inputs change: a fresh transport for a new round (Undo's reopened round too),
 *  a bar-aligned switch for a new theme, and a seamless continuation for a timer or Build change. */
function syncMusicTransport(prev, s, at) {
  // A legacy pause taken from an open round keeps its transport (the projector is silent while paused anyway).
  const open = (s.phase === 'responses_open' || (s.phase === 'discussion_paused' && s.resumePhase === 'responses_open')) && s.round?.status === 'open';
  const before = musicOf(prev);
  if (!open) { if (s.music?.transport) s.music.transport = null; return; }
  const music = structuredClone(musicOf(s)), atMs = Date.parse(at), decisionId = s.round.decisionId;
  if (!music.order.includes(decisionId) && music.order.length < 1000) music.order.push(decisionId);
  const draw = music.order.indexOf(decisionId), trackId = musicTrackFor(music.choice, music.seed, draw);
  const timer = musicTimer(s), intensity = music.intensity / 100, old = music.transport;
  if (!trackId) music.transport = null;
  else if (!old || old.roundId !== s.round.id) {
    music.transport = { roundId: s.round.id, decisionId, draw, trackId, ...freshAnchor({ trackId, intensity, timer, atMs }) };
  } else {
    const oldTimer = musicTimer(prev), oldIntensity = before.intensity / 100;
    const anchor = { atMs: old.atMs, tier: old.tier, originMs: old.originMs };
    if (old.trackId !== trackId) {
      const playing = segmentAt(musicSegments({ trackId: old.trackId, intensity: oldIntensity, anchor, timer: oldTimer }), atMs);
      music.transport = { ...old, draw, trackId, ...changedTrackAnchor({ fromTrackId: old.trackId, fromSegment: playing, toTrackId: trackId, intensity, timer, atMs }) };
    } else if (JSON.stringify(oldTimer) !== JSON.stringify(timer) || oldIntensity !== intensity) {
      if (atMs > old.atMs) music.transport = { ...old, ...continuedAnchor({ trackId, intensity: oldIntensity, anchor, timer: oldTimer, atMs }) };
    }
  }
  if (JSON.stringify(music) !== JSON.stringify(s.music ?? null)) s.music = music;
}
/** Public music state: the choice, Build and the playing decision transport. No seed, round or decision id. */
function publicMusic(state) {
  const { choice, intensity, playing, volume, effects, transport: t } = musicOf(state);
  // While a lock's closing window runs, the projector releases the music and skips the time-up cue (an early lock
  // suppresses it); Keep open resumes the same transport, so nothing restarts.
  return { choice, intensity, playing, volume, effects, transport: t ? { trackId: t.trackId, draw: t.draw, tier: t.tier, atMs: t.atMs, originMs: t.originMs,
    ...(state.round?.closing ? { closing: true } : {}) } : null };
}

export function project(state, role, participantId = null, inputs = {}) {
  state = normalizePresentationState(state);
  const I = idx(state);
  const sv = (e) => surfaceView(I, e, { state, facilitator: role === 'facilitator' });
  const live = state.liveSurfaceId ? sv(lastEntryFor(state, state.liveSurfaceId)) : null;
  const active = Object.entries(state.participants).filter(([, p]) => !p.removedAt);
  // `{k} of {m} answered` counts m from the people actually connected (spec red team 2, P1-7). Presence
  // is not reducer state: the Durable Object passes it in (`inputs.present`, participant ids with a
  // live socket or recent HTTP activity), so the reducer stays pure. Anyone who has answered this round
  // counts too, so k never exceeds m. Without presence (lab, tests, rebuild checks) m is everyone.
  const present = inputs.present ? new Set(inputs.present) : null;
  const answered = state.round ? state.round.responses : {};
  const presentCount = countedParticipants(state, present);
  const roundOpen = state.phase === 'responses_open' || (state.phase === 'discussion_paused' && state.resumePhase === 'responses_open');
  const meta = {
    caseTitle: state.caseDoc.title, caseVersionNo: state.caseVersionNo ?? null,
    // The one exception to hard rule 1 (CASE-164): numbers only, re-checked on the way out.
    art: sanitizeArt(state.art ?? null),
    // The frozen group tint, an enum name (CASE-172); a room from before card 30 projects none.
    ...(state.tint === undefined ? {} : { tint: tintOf(state.tint) }),
    endedAt: state.endedAt, recapExpiresAt: state.endedAt ? new Date(Date.parse(state.endedAt) + RECAP_TTL_MS).toISOString() : null,
    ...(publicationDescriptor(state) ? { publication: publicationDescriptor(state) } : {}),
  };
  // Advisory timer: everyone may see the time remaining; it never locks anything by itself.
  const timer = state.timer && roundOpen ? (state.timer.remainingS !== null
    ? { paused: true, remainingS: state.timer.remainingS }
    : { paused: false, endsAt: new Date(Date.parse(state.timer.startedAt) + state.timer.durationS * 1000).toISOString() }) : null;
  // CASE-320: the timer's full length, so a screen knows how far through it is (the music tightens with it). A new
  // top-level key, present only while a timer shows: a projector from before it drops it (CASE-172); `timer` is unchanged.
  const timerTotalS = timer ? Math.min(600, Math.max(1, Math.round(state.timer.totalS ?? state.timer.durationS))) : null;

  // The lobby screen layer (CASE-176): exactly the lobby's keys, from the lobby's public fields only. No surface,
  // decision, option, prompt, result, timer or presentation group. Mid-case the names keep their hidden state
  // (CASE-133): avatars only until Show names; with no counts shown, names may appear when shown.
  if (role === 'display' && lobbyShown(state)) {
    return {
      role, sessionId: state.sessionId, joinCode: state.joinCode, epoch: state.epoch,
      revision: state.revision, displayRevision: state.display.revision, ...meta, timer: null,
      // CASE-334: the same keys as the real lobby; the lobby bed plays, so no decision transport.
      music: { ...publicMusic(state), transport: null },
      phase: PUBLIC_PHASE.lobby, manual: false, joiningClosed: state.joiningClosed, replay: false, surface: null, decision: null,
      counts: { participants: active.length, present: presentCount, responded: null },
      avatars: state.namesShown ? null : active.map(([, p]) => p.avatarId ?? null),
      names: state.namesShown ? active.filter(([, p]) => p.name).map(([, p]) => ({ name: p.name, avatarId: p.avatarId ?? null })) : null,
      arrivalCount: state.arrivalCount ?? Object.keys(state.participants).length,
      resultsShown: true, resultsPage: 0, responseResult: null, lastResult: null,
    };
  }

  if (role === 'display') {
    const cursor = state.display.cursor;
    const selected = Number.isSafeInteger(cursor) ? state.revealed[cursor]
      : typeof cursor === 'string' ? lastEntryFor(state, cursor) : null;
    const inDebrief = state.phase === 'debrief';
    const displayedResponse = inDebrief ? null : responseResult(I, state);
    const displayedLast = inDebrief || state.resultsShown === false || cursor !== null ? null : lastResult(I, state);
    const answerCountsVisible = displayedResponse !== null || displayedLast !== null;
    const onScreen = inDebrief ? null : projectorDecision(I, state);
    return {
      role, sessionId: state.sessionId, joinCode: state.joinCode, epoch: state.epoch,
      revision: state.revision, displayRevision: state.display.revision, ...meta, timer, ...(timerTotalS ? { timerTotalS } : {}),
      // CASE-334: the room music, a new top-level key a projector from before it drops (CASE-172).
      music: publicMusic(state),
      // Present only while the projector shows a video the facilitator has started (card 59 M3).
      ...(playbackView(state, I) ? { playback: playbackView(state, I) } : {}),
      phase: PUBLIC_PHASE[state.phase], manual: Boolean(state.manual),
      joiningClosed: state.joiningClosed, // the projector hides its join route (stage C finding)
      replay: selected !== null && selected !== undefined,
      // In Debrief the projector shows a slide only while one is replayed; otherwise the debrief pages.
      surface: selected ? sv(selected) : inDebrief ? null : live,
      // The options are always on the projector while a decision is in play (CASE-089), so people
      // without a phone can follow and say their pick; the separate responseResult carries anonymous
      // counts only after responses close, never the route being considered.
      decision: onScreen,
      // CASE-313: the branch badge rides at the top level, so a projector from before it drops the key (CASE-172) and keeps the view.
      ...(onScreen && decisionBranches(I.decisions.get(onScreen.decisionId)) ? { decisionBranches: true } : {}),
      // No answered count while names are on the projector: with names up, a count lets the room work
      // out who has not answered (spec red team 2, P2).
      counts: {
        participants: active.length, present: presentCount,
        responded: state.phase === 'responses_open' && !state.namesShown ? Object.keys(state.round.responses).length : null,
      },
      // Avatars alone may reach the projector before Show names (CASE-133). No participant ids or
      // names accompany them; the named projection replaces this list after the explicit reveal.
      avatars: answerCountsVisible || state.namesShown || state.phase === 'lobby' ? null : active.map(([, p]) => p.avatarId ?? null),
      // Names with their avatars, for the projector's `In the room` chips (CASE-119).
      names: !answerCountsVisible && (state.namesShown || state.phase === 'lobby') ? active.filter(([, p]) => p.name).map(([, p]) => ({ name: p.name, avatarId: p.avatarId ?? null })) : null,
      arrivalCount: state.arrivalCount ?? Object.keys(state.participants).length,
      resultsShown: state.resultsShown !== false,
      resultsPage: Number.isInteger(state.resultsPage) && state.resultsPage >= 0 && state.resultsPage <= 3 ? state.resultsPage : 0,
      responseResult: displayedResponse,
      lastResult: displayedLast,
      // Only at End (card 40d): the public debrief, and the feedback code for the QR card when the room has one.
      ...(state.phase === 'ended' ? { debrief: endedDebrief(I, state, inputs.debriefResults === true, inputs.debriefPage), ...(state.feedbackCode ? { feedbackCode: state.feedbackCode } : {}) } : {}),
      // In Debrief (console layout v2): the same public debrief, paged by the facilitator's own command, and its QR.
      ...(inDebrief ? { debrief: endedDebrief(I, state, true, state.debrief?.page ?? 0), ...(state.feedbackCode ? { feedbackCode: state.feedbackCode } : {}) } : {}),
    };
  }

  if (role === 'participant') {
    const me = state.participants[participantId];
    const decisionVisible = state.round && ['open', 'locked'].includes(state.round.status);
    const mine = decisionVisible ? state.round.responses[participantId]?.response ?? null : null;
    let decision = null;
    if (decisionVisible) {
      decision = {
        ...publicDecision(I, state, participantId),
        roundId: state.round.id,
        roundNo: state.round.no,
        status: state.phase === 'responses_open' ? 'open' : roundOpen ? 'held' : 'locked',
        yourResponse: mine,
        // CASE-319: responses are closing; the phone sends what is in its answer box before this time (server clock).
        ...(state.phase === 'responses_open' && state.round.closing ? { closesAt: state.round.closing.closesAt } : {}),
      };
    }
    const labelOf = (decisionId, response) => {
      if (!response) return null;
      const opts = I.decisions.get(decisionId).interaction.options || [];
      const l = (id) => opts.find((o) => o.id === id)?.label ?? id;
      if (response.option_id) return l(response.option_id);
      if (response.option_ids) return response.option_ids.map(l).join(', ');
      if (response.order) return response.order.map(l).join(' → ');
      return response.text ?? null;
    };
    // `inputs.timeline` is participantTimeline() of this same state, built once by the Durable Object for every phone
    // in a broadcast (CASE-281). It is used only when it covers exactly this state's entries.
    const timeline = Array.isArray(inputs.timeline) && inputs.timeline.length === state.revealed.length ? inputs.timeline : state.revealed.map(sv);
    // The recap appears at Debrief (console layout v2) as at End: only resolved rounds, the phone's own answers.
    const recap = recapPhase(state.phase) && me ? {
      caseTitle: meta.caseTitle, caseVersionNo: meta.caseVersionNo, expiresAt: meta.recapExpiresAt,
      learningPoints: [...state.caseDoc.learning_objectives],
      rounds: state.rounds.filter((r) => r.status === 'resolved' || r.status === 'superseded').map((r) => {
        // What the team saw happen: the public consequence surface revealed for this round's path.
        const evidence = consequenceEvidence(state, r), shown = evidence.entry;
        // After the session the recap teaches (CASE-082): your answer's classification and why,
        // and what the recommended path was if you chose differently.
        const mine = pathOfResponse(I, r.decisionId, r.answers[participantId], state);
        const d = I.decisions.get(r.decisionId);
        const rec = d.paths.find((x) => x.recommended);
        const recLabel = rec ? (d.interaction.options || []).filter((o) => (rec.option_ids || []).includes(o.id)).map((o) => o.label).join(' / ') || rec.label : null;
        return {
          decisionId: r.decisionId, prompt: d.prompt, roundNo: r.no, status: r.status,
          optionIds: (d.interaction.options || []).map((o) => o.id), // the shared order, for the marks (CASE-088)
          yourResponse: r.answers[participantId] ?? null,
          yourAnswer: labelOf(r.decisionId, r.answers[participantId]),
          yourClassification: mine?.classification ?? null,
          why: mine?.rationale ?? null,
          doDifferently: mine && !mine.recommended && recLabel ? `Recommended here: ${recLabel}. ${rec.rationale}` : null,
          teamChoice: r.resolutionKind ?? null,
          whatHappened: shown ? I.surfaces.get(shown.surfaceId).title : null,
          // Card 40b (I4): the position of that slide in this phone's own timeline, so the recap journey pairs them.
          revealIndex: shown ? state.revealed.indexOf(shown) : null,
          ...(!r.consequenceOccurrenceId ? { publicationEvidence: evidence.kind } : {}),
          // Room PDFs v2 (Julian, 2026-10-18): the room's split beside this phone's answer, only for a result the projector drew.
          ...roomSplit(I, r),
        };
      }),
      teamPath: state.revealed.filter((e) => ['consequence', 'terminal'].includes(e.kind)).map((e) => I.surfaces.get(e.surfaceId).title),
      ...(state.feedbackCode ? { feedbackCode: state.feedbackCode } : {}),
      ...(state.facilitatorLabel ? { facilitator: state.facilitatorLabel } : {}),
      ...recapCredits(state, timeline),
    } : null;
    const last = state.rounds.at(-1);
    const lastRound = last ? { roundId: last.id, roundNo: last.no, status: last.status } : null;
    const result = lastResult(I, state);
    if (result) {
      const r = [...state.rounds].reverse().find((x) => x.status === 'resolved');
      // The phone's own answer only: its words, and the option ids it counted towards (the marks).
      result.yourAnswer = result.countMeaning ? labelOf(r.decisionId, r.answers[participantId]) : null;
      result.yourOptionIds = countedOptionIds(r.answers[participantId]);
      result.youAnswered = Boolean(r.answers[participantId]);
    }
    return {
      role, sessionId: state.sessionId, epoch: state.epoch, revision: state.revision, ...meta, timer, ...(timerTotalS ? { timerTotalS } : {}), lastRound,
      phase: PUBLIC_PHASE[state.phase], manual: Boolean(state.manual),
      you: me ? { id: participantId, name: me.name, avatarId: me.avatarId ?? null, removed: Boolean(me.removedAt) } : null,
      liveSurface: live,
      timeline,
      decision,
      lastResult: result,
      recap,
    };
  }

  if (role === 'facilitator') {
    const decision = state.decisionId ? I.decisions.get(state.decisionId) : null;
    const beat = state.beatId ? I.beats.get(state.beatId) : null;
    const next = state.nextBeatId ? I.beats.get(state.nextBeatId) : null;
    const presentationEntry = state.revealed.at(-1);
    const presentationGroups = groupsForEntry(state, presentationEntry);
    const displayCursor = state.display.cursor;
    const displayEntry = Number.isSafeInteger(displayCursor) ? state.revealed[displayCursor]
      : typeof displayCursor === 'string' ? lastEntryFor(state, displayCursor)
        : state.liveSurfaceId ? lastEntryFor(state, state.liveSurfaceId) : null;
    const presentation = presentationEntry ? {
      entryIndex: state.revealed.length - 1,
      shown: presentationEntry.groupsShown,
      total: presentationGroups.length,
      nextGroup: presentationEntry.groupsShown < presentationGroups.length ? (compositionFor(state, presentationEntry) ? 'step' : presentationGroups[presentationEntry.groupsShown]) : null,
      mediaUnavailable: Boolean(I.surfaces.get(presentationEntry.surfaceId)?.asset_ids?.length),
    } : null;
    const names = Object.fromEntries(Object.entries(state.participants).map(([id, p]) => [id, p.name]));
    const avatars = Object.fromEntries(Object.entries(state.participants).map(([id, p]) => [id, p.avatarId ?? null]));
    return {
      role, sessionId: state.sessionId, joinCode: state.joinCode, epoch: state.epoch, revision: state.revision, ...meta,
      phase: state.phase, resumePhase: state.resumePhase,
      manual: state.manual ? { ...state.manual } : null,
      namesShown: state.namesShown,
      resultsShown: state.resultsShown !== false,
      resultsPage: Number.isInteger(state.resultsPage) && state.resultsPage >= 0 && state.resultsPage <= 3 ? state.resultsPage : 0,
      rankedRoundId: closedResponseRound(I, state)?.id ?? null,
      rankedSelection: state.rankedSelection ?? { group: 0, position: 0 },
      rankedPresentation: responseResult(I, state)?.ranked ?? null,
      textPresentation: responseResult(I, state)?.textPage ?? null,
      rankedColumns: (() => { const round = closedResponseRound(I, state); return round?.aggregate?.completeOrders
        ? rankedLayout(I.decisions.get(round.decisionId).interaction.options, round.aggregate.rankCount, I.decisions.get(round.decisionId).prompt).columns : null; })(),
      rankedPositionSpan: (() => { const round = closedResponseRound(I, state); return round?.aggregate?.completeOrders
        ? rankedLayout(I.decisions.get(round.decisionId).interaction.options, round.aggregate.rankCount, I.decisions.get(round.decisionId).prompt).positions : null; })(),
      resultsPageCount: (() => { const result = responseResult(I, state); return result?.type === 'ranking' ? Math.ceil(result.counts.length / 2) : 1; })(),
      joiningClosed: state.joiningClosed,
      autoLock: state.autoLock !== false, // CASE-319: on unless the facilitator turned it off for this room
      beat: beat ? { id: beat.id, kind: beat.kind, title: beat.title, cue: beat.cue ?? null } : null,
      nextBeat: next ? { id: next.id, kind: next.kind, title: next.title } : null,
      presentation,
      // The full timeline and live surface remain private to the facilitator. This separately
      // projected row is exactly what the projector shows, including an older replay's reveal count.
      publicDisplaySurface: displayEntry ? surfaceView(I, displayEntry, { state }) : null,
      publicTimeline: state.revealed.map((entry, entryIndex) => ({ entryIndex,
        occurrenceId: entry.occurrenceId ?? null,
        ...(entryPublication(entry) ? { publication: entryPublication(entry) } : {}),
        surface: surfaceView(I, entry, { state }),
        // Publication dismisses results. Later chart actions are separately journalled.
        pathResult: null,
      })),
      liveSurface: live,
      timeline: state.revealed.map(sv),
      decision: decision ? {
        ...publicDecision(I, state),
        // Card 61: a sole direct continuation (CASE-280) is not a route to choose; the console offers one Continue.
        // The same test as publishConsequence. Additive: a console that ignores it still draws the one route.
        directContinue: decision.paths.length === 1 && !!directContinuation(state.caseDoc, decision.paths[0]),
        paths: decision.paths.map((p) => ({
          id: p.id, label: p.label, classification: p.classification, recommended: p.recommended === true,
          rationale: p.rationale, cue: p.cue, optionIds: p.option_ids ?? [],
          revealPreview: p.continue_to_next ? I.beats.get(p.next_beat_id)?.title ?? 'Next slide' : I.surfaces.get(p.reveal_surface_id).title,
          terminal: p.classification === 'terminal-unsafe', explored: state.exploredTerminal.includes(p.id),
        })),
      } : null,
      round: state.round ? {
        id: state.round.id, no: state.round.no, status: state.round.status,
        ...(['open', 'locked'].includes(state.round.seededStatus) ? { seededStatus: state.round.seededStatus,
          ...(isUuidV7(state.round.seedSourceRoundId) ? { seedSourceRoundId: state.round.seedSourceRoundId } : {}),
          ...(isUuidV7(state.round.correctionEventId) ? { correctionEventId: state.round.correctionEventId } : {}) } : {}),
        responseCount: Object.keys(state.round.responses).length, participantCount: presentCount,
        ...(state.round.closing ? { closing: { openedAt: state.round.closing.openedAt, closesAt: state.round.closing.closesAt, auto: state.round.closing.auto } } : {}),
        ...(state.round.keptOpen ? { keptOpen: true } : {}),
        responses: Object.entries(state.round.responses).map(([pid, r]) => ({ participantId: pid, name: names[pid] ?? null, avatarId: avatars[pid] ?? null, response: r.response, at: r.lastAt, identifierFlags: r.idFlags ?? [] })),
        aggregate: state.round.aggregate, suggestion: state.round.suggestion,
      } : null,
      selectedPathId: state.selectedPathId, resolutionKind: state.resolutionKind,
      terminalPathId: state.terminalPathId,
      terminal: state.terminalPathId ? (() => {
        const tp = I.paths.get(state.terminalPathId);
        const cp = I.beats.get(tp.terminal.checkpoint_beat_id);
        return { pathId: tp.id, debriefPrompt: tp.terminal.debrief_prompt, checkpointBeat: { id: cp.id, title: cp.title } };
      })() : null,
      flags: [...state.flags],
      participants: Object.entries(state.participants).map(([id, p]) => ({ id, name: p.name, avatarId: p.avatarId ?? null, joinedAt: p.joinedAt, removed: Boolean(p.removedAt) })),
      rounds: state.rounds.map(({ answers, shown, ...r }) => r),
      timer: state.timer,
      music: publicMusic(state),
      ...(playbackView(state, I) ? { playback: playbackView(state, I) } : {}),
      display: { ...state.display },
      // In Debrief: where the room was (for Back to the case) and the public debrief the projector pages through.
      debrief: state.phase === 'debrief' && state.debrief ? { resumePhase: state.debrief.resumePhase, page: state.debrief.page,
        startedAt: state.debrief.startedAt, public: endedDebrief(I, state, true, state.debrief.page), questions: debriefQuestions(I, state),
        // When the room ends by itself (the Durable Object's clock, an input; the reducer never reads time).
        expiresAt: typeof inputs.roomExpiresAt === 'string' ? inputs.roomExpiresAt : null } : null,
      ...(state.caseDoc.schema_version >= 2 ? { recovery: recoveryDescriptor(state), clarification: state.clarification ?? null, clarifications: (state.caseDoc.clarifications ?? []).filter(card => card.beat_ids.includes(state.beatId)).map(({id,label})=>({id,label,shared:state.revealed.some(entry=>entry.clarificationId===id)})) } : {}),
      actions: facilitatorActions(state),
      undo: undoDescriptor(state),
    };
  }
  throw new TypeError(`unknown role: ${role}`);
}

/** Private confirmation is bound to one actual revealed occurrence, never a path alone. */
export function recoveryDescriptor(state) {
  if (!(state.caseDoc.schema_version >= 2) || !state.caseDoc.required_capabilities?.includes('required_recovery')) return null;
  const entry = state.revealed.at(-1);
  if (!entry || !['consequence', 'terminal'].includes(entry.kind)) return null;
  const recovery = idx(state).paths.get(entry.pathId)?.recovery;
  if (!recovery) return null;
  const confirmation = state.recoveryConfirmation;
  return { occurrenceId: entry.occurrenceId ?? null, pathId: entry.pathId, prompt: recovery.prompt,
    confirmed: confirmation?.occurrenceId === entry.occurrenceId && confirmation?.pathId === entry.pathId && confirmation?.confirmed === true };
}

/** The facilitator commands valid right now; clients render only these (HANDOFF §Three projections). */
export function facilitatorActions(state) {
  let a = [];
  const p = state.phase;
  const publicationBlocked = responsesBlockPublication(idx(state), state);
  if (p === 'ended') return a;
  // Debrief (console layout v2): review the room's slides and results, leave Debrief, or end. Nothing teaches forward.
  if (p === 'debrief') return [...(state.revealed.length ? ['replay'] : []), 'debrief_page', 'back_to_case', 'takeover', 'remove_participant', 'rename', 'end'];
  if (p === 'lobby') a.push('start');
  const latest = state.revealed.at(-1);
  const moreGroups = latest && latest.groupsShown < groupsForEntry(state, latest).length;
  if (moreGroups && ['surface_live', 'consequence_revealed', 'terminal_teaching'].includes(p)) a.push('advance');
  else if (['surface_live', 'consequence_revealed'].includes(p)) {
    if (state.decisionId && p === 'surface_live') a.push(state.manual ? 'select_path' : 'advance');
    else if (state.nextBeatId) a.push('advance');
  }
  // CASE-319: while closing, Lock becomes Lock now / Keep open, and the timer cannot change.
  if (p === 'responses_open') a.push(...(state.round?.closing ? ['finalise_lock', 'cancel_lock'] : ['lock', 'set_timer']), 'void_round');
  if (!['ended', 'debrief'].includes(p)) a.push('set_auto_lock', 'set_music');
  if (p === 'responses_locked') a.push('select_path', 'reopen', 'void_round');
  if (p === 'path_selected') a.push('reveal', 'back_to_review');
  if (latest && !moreGroups && (['responses_locked', 'path_selected'].includes(p) ||
      (state.manual && state.decisionId && p === 'surface_live'))) a.push('reveal_path');
  if (undoDescriptor(state).available) a.push('undo');
  if (p === 'terminal_teaching') a.push('reset_checkpoint');
  if (p === 'discussion_paused') a.push('resume');
  const inRound = ['responses_open', 'responses_locked'].includes(p) || (p === 'discussion_paused' && ['responses_open', 'responses_locked'].includes(state.resumePhase));
  if (!state.manual && (isStableBoundary(state) || inRound)) a.push('enter_manual');
  if (state.manual) a.push('manual_marker', ...(p === 'path_selected' || state.resumePhase === 'path_selected' ? [] : ['resume_online']));
  if (state.revealed.length) a.push('replay');
  if (p !== 'lobby' && !state.manual) a.push('show_lobby');
  if (closedResponseRound(idx(state), state) && state.display.cursor === null) a.push('show_results');
  const result = responseResult(idx(state), state);
  if (result?.textPage && result.textPage.pages > 1) a.push('text_page');
  if (result?.ranked && result.ranked.totalGroups > 0) a.push('ranked_page');
  if (result?.type === 'ranking' && result.counts.length > 2) a.push('results_page');
  if (p !== 'lobby' && (!publicationBlocked || state.namesShown)) a.push('show_names');
  a.push('close_joining', 'takeover', 'remove_participant', 'rename', 'end');
  if (DEBRIEF_FROM.includes(p) && !state.manual && !state.clarification) a.push('debrief');
  if (state.caseDoc.schema_version >= 2 && state.caseDoc.required_capabilities?.includes('early_clarification')) {
    if (state.clarification) {
      a = a.filter(action => !['advance','lock','reveal','reveal_path','select_path','back_to_review','reset_checkpoint','undo','reopen','void_round','enter_manual','resume_online'].includes(action));
      if (p === 'responses_open') { a.push('return_clarification'); if (moreGroups) a.push('advance'); }
    } else if (p === 'responses_open' && !state.round?.closing && state.caseDoc.clarifications?.some(card => card.beat_ids.includes(state.beatId))) a.push('show_clarification');
  }
  const recovery = recoveryDescriptor(state);
  if (recovery && ['consequence_revealed', 'terminal_teaching'].includes(p)) {
    a.push('confirm_recovery');
    if (!recovery.confirmed) a = a.filter(action => action !== 'reset_checkpoint' && (action !== 'advance' || moreGroups));
  }
  if (lobbyShown(state)) return a.filter(action => !LOBBY_BLOCKED.has(action));
  return publicationBlocked ? a.filter(action => !['reveal', 'advance', 'reset_checkpoint'].includes(action)) : a;
}
