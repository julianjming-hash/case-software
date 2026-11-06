import { validAuthoredText } from './authored-text.mjs';
// Display-only boundary for server snapshots and future same-PC console senders.
// No case pack, facilitator mirror, participant identifiers cross it. Closed free-text pages contain anonymous text only.
import { cleanText } from '../shared/text.mjs';
import { isUuid, isUuidV7, normalizeCode } from '../shared/ids.mjs';
import { isAvatarId } from '../shared/participant.mjs';
import { validRankedPage } from '../shared/ranked-page-view.mjs';
import { validArtDescriptor } from '../shared/art-descriptor.mjs';
import { isTint } from '../shared/tints.mjs';
import { SLIDE_THEMES } from '../shared/slide-themes.mjs';
import { SLIDE_FILLS } from '../shared/slide-text.mjs';
import { fitsTextPage, TEXT_PAGE_ANSWERS } from '../shared/text-pages.mjs';
import { MUSIC_DECISION_TRACKS, validMusicChoice, validMusicIntensity, validMusicVolume } from '../shared/music-catalogue.mjs';
const text = v => typeof v === 'string' && v.length <= 2000;
const nullable = check => v => v === null || check(v);
const integer = v => Number.isSafeInteger(v) && v >= 0;
const bool = v => typeof v === 'boolean';
const oneOf = values => v => values.includes(v);
const list = (check, max = 300) => v => Array.isArray(v) && v.length <= max && v.every(check);
const object = shape => v => v !== null && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).every(k => Object.hasOwn(shape, k))
  && Object.entries(shape).every(([k, check]) => check(v[k]));
const avatar = nullable(isAvatarId);
const option = object({ id: isUuid, label: text, disabled: bool, explored: bool });
const surface = object({ surfaceId: isUuid, kind: text, title: text, scene: nullable(validAuthoredText), points: list(text, 30), investigations: list(text, 30),
  observations: list(object({ label: text, value: text, unit: v => v === undefined || nullable(text)(v), trend: oneOf(['up', 'down', null]), previous: nullable(text) }), 30),
  assetIds: list(isUuid, 30), timelineKind: oneOf(['live', 'consequence', 'terminal', 'clarification']), manual: bool, at: text });
// Card 57: a slide surface carries only released blocks and their placements (the room's public projection). The DOM is
// built text-only from an allowlist, so this boundary checks shape and the 32 KiB public bound on blocks (CASE-212),
// measured exactly as the validator measures it.
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const slide = object({ template: text, blocks: list(v => record(v) && typeof v.id === 'string' && typeof v.type === 'string', 32),
  placements: list(record, 32), reading_order: list(v => typeof v === 'string', 32), styles: list(record, 32), theme: v => v === undefined || Object.hasOwn(SLIDE_THEMES, v),
  fill: v => v === undefined || SLIDE_FILLS.includes(v),
  // D23 hero (CASE-264): which released block shows large, from which grid row, top-aligned or centred.
  hero: v => v === undefined || object({ block_id: text, title_id: v => v === null || typeof v === 'string', row: v => Number.isInteger(v) && v >= 1 && v <= 12, align: oneOf(['top', 'centred']) })(v) });
const slideSurface = v => object({ surfaceId: isUuid, kind: text, title: text, assetIds: list(isUuid, 30), slide,
  timelineKind: oneOf(['live', 'consequence', 'terminal', 'clarification']), manual: bool, at: text })(v) && new TextEncoder().encode(JSON.stringify(v.slide.blocks)).length <= 32768;
const timer = v => object({ paused: bool, remainingS: integer })(v) || object({ paused: bool, endsAt: text })(v);
const optional = check => v => v === undefined || check(v);
const resultRow = object({ optionId: isUuid, label: text, count: integer, positionCounts: nullable(list(integer, 30)) });
const responseResult = object({ decisionId: isUuid, prompt: validAuthoredText, roundNo: integer,
  type: oneOf(['single_choice', 'multi_select', 'ranking', 'free_text']), total: integer,
  rankCount: nullable(integer), counts: list(resultRow, 30), textPage: optional(object({ closedRoundId: isUuid, page: integer, pages: integer, answers: list(v => typeof v === 'string' && v.length > 0 && v.length <= 500 && cleanText(v, 500) === v, TEXT_PAGE_ANSWERS) })), ranked: optional(v => Boolean(v) && typeof v === 'object') });
const SHAPE = { role: oneOf(['display']), sessionId: isUuid, joinCode: v => normalizeCode(v, 6) === v,
  publication: optional(object({ v: oneOf([1]), occurrenceId: isUuidV7,
    correctionOf: optional(isUuidV7), restoresOccurrenceId: optional(nullable(isUuidV7)), checkpointOf: optional(isUuidV7) })),
  epoch: integer, revision: integer, displayRevision: integer, caseTitle: text, caseVersionNo: nullable(integer), art: v => v === undefined || v === null || validArtDescriptor(v), tint: v => v === undefined || isTint(v), endedAt: nullable(text), recapExpiresAt: nullable(text),
  // CASE-334: the room music's public choice, Build and decision transport (src/shared/music-timeline.mjs). Optional, so an
  // older room's view without it still renders; a malformed one refuses the view like any other bad key.
  music: optional(object({ choice: validMusicChoice, intensity: validMusicIntensity, playing: bool, volume: validMusicVolume, effects: bool, transport: nullable(object({
    trackId: v => MUSIC_DECISION_TRACKS.includes(v), draw: v => integer(v) && v < 10000, tier: oneOf([0, 1, 2]),
    atMs: v => typeof v === 'number' && Number.isFinite(v), originMs: v => typeof v === 'number' && Number.isFinite(v), closing: v => v === undefined || v === true })) })),
  timer: nullable(timer), timerTotalS: optional(nullable(v => Number.isSafeInteger(v) && v >= 1 && v <= 600)), playback: optional(nullable(object({ blockId: isUuid, playing: bool, at: v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 121, since: text }))),
  phase: oneOf(['waiting', 'live', 'decision_open', 'reviewing', 'teaching', 'paused', 'debrief', 'ended']),
  manual: bool, joiningClosed: bool, replay: bool, surface: nullable(v => surface(v) || slideSurface(v)),
  decision: nullable(object({ decisionId: isUuid, prompt: validAuthoredText, status: oneOf(['open', 'locked', 'paused', 'manual']),
    interaction: object({ type: oneOf(['single_choice', 'multi_select', 'ranking', 'free_text']), options: list(option, 30), rankCount: nullable(v => integer(v) && v >= 1 && v <= 30) }) })),
  // CASE-313: present only (and only true) while a question whose routes lead to different next slides is on screen.
  decisionBranches: v => v === undefined || v === true,
  counts: object({ participants: integer, present: integer, responded: nullable(integer) }),
  avatars: nullable(list(avatar)), names: nullable(list(object({ name: text, avatarId: avatar }))),
  arrivalCount: v => integer(v) && v <= 300, resultsShown: bool, resultsPage: v => integer(v) && v <= 3, responseResult: nullable(responseResult),
  lastResult: nullable(object({ decisionId: isUuid, prompt: validAuthoredText, roundNo: integer, total: integer, countMeaning: oneOf(['chose', 'selected', 'ranked_first', null]),
    rankCount: optional(integer), counts: list(object({ optionId: isUuid, label: text, count: integer, positionCounts: optional(list(integer, 30)) }), 30),
    split: bool, howChosen: oneOf(['majority', 'minority', 'override']), whatHappened: text })),
  // Card 40d, only at End: the public debrief (revealed route titles, objectives, closed results the room was shown) and
  // the feedback code for the QR card. Optional, so an older console's frame still passes; every level is exact.
  debrief: optional(object({ route: list(text, 60), objectives: list(v => validAuthoredText(v), 30),
    results: list(object({ prompt: validAuthoredText, type: oneOf(['single_choice', 'multi_select', 'ranking']), roundNo: integer, total: integer,
      counts: list(object({ label: text, count: integer }), 30) }), 60), page: optional(integer) })),
  feedbackCode: optional(v => typeof v === 'string' && /^[0-9A-HJKMNP-TV-Z]{6}$/.test(v)) };
const shape = object(SHAPE);

function validResult(result, decision) {
  if (result.ranked !== undefined && !validRankedPage(result.ranked, result)) return false;
  if (result.total > 300 || result.roundNo < 1 || new Set(result.counts.map(row => row.optionId)).size !== result.counts.length) return false;
  if (result.type === 'ranking' && result.rankCount === null) {
    return result.total === 0 && result.counts.length === 0 && decision?.interaction.type === 'ranking'
      && result.decisionId === decision.decisionId && decision.interaction.rankCount === null
      && decision.interaction.options.length > 0 && decision.interaction.options.every(option => option.disabled);
  }
  if (decision && (result.decisionId !== decision.decisionId || result.type !== decision.interaction.type
    || result.rankCount !== decision.interaction.rankCount
    || result.counts.length !== decision.interaction.options.length
    || result.counts.some((row, index) => row.optionId !== decision.interaction.options[index].id || row.label !== decision.interaction.options[index].label))) return false;
  if (result.type === 'free_text') {
    const p = result.textPage;
    return result.rankCount === null && result.counts.length === 0 && !result.ranked && (!p ||
      (p.pages >= Math.max(1, Math.ceil(result.total / TEXT_PAGE_ANSWERS)) && p.pages <= Math.max(1, result.total) && p.pages <= 300 && p.page < p.pages
        && p.answers.length <= result.total && fitsTextPage(p.answers) && (result.total === 0 || p.answers.length > 0)));
  }
  if (result.textPage) return false;
  if (result.counts.some(row => row.count > result.total)) return false;
  if (result.type !== 'ranking') return result.rankCount === null && result.counts.every(row => row.positionCounts === null)
    && (result.type !== 'single_choice' || result.counts.reduce((sum, row) => sum + row.count, 0) === result.total);
  if (result.counts.length > 8 || result.rankCount > 8 || result.rankCount < 1 || result.rankCount > result.counts.length || !integer(result.rankCount)) return false;
  if (result.counts.some(row => !Array.isArray(row.positionCounts) || row.positionCounts.length !== result.rankCount
    || row.positionCounts.some(count => count > result.total) || row.count !== row.positionCounts[0]
    || row.positionCounts.reduce((sum, count) => sum + count, 0) > result.total)) return false;
  return Array.from({ length: result.rankCount }, (_, position) => result.counts.reduce((sum, row) => sum + row.positionCounts[position], 0))
    .every(total => total === result.total);
}
// Deploy skew (CASE-172): an unknown top-level key is dropped, a private-named one refused.
const PRIVATE = /^(cue|notes|rationale|classification|casedoc|mirror|answers|beats|decisions|paths|facilitator.*|.*notes)$/i;
const known = view => view !== null && typeof view === 'object' && !Array.isArray(view) && !Object.keys(view).some(k => PRIVATE.test(k)) &&
  Object.keys(view).some(k => !Object.hasOwn(SHAPE, k)) ? Object.fromEntries(Object.entries(view).filter(([k]) => Object.hasOwn(SHAPE, k))) : view;
export function acceptDisplayView(input) {
  try {
    const view = known(input);
    if (view?.publication && ((view.publication.correctionOf === undefined) !== (view.publication.restoresOccurrenceId === undefined))) return null;
    if (view?.decisionBranches !== undefined && !view.decision) return null;
    if (!shape(view) || (view.names !== null && (view.avatars !== null || view.counts.responded !== null || view.responseResult !== null || view.lastResult !== null))) return null;
    if (view.avatars !== null && (view.responseResult !== null || view.lastResult !== null)) return null;
    if (view.arrivalCount < view.counts.participants || view.counts.participants > 300 || view.counts.present > view.counts.participants) return null;
    if (view.decision?.interaction.type === 'ranking' && (view.decision.interaction.options.length > 8 || view.decision.interaction.rankCount > 8
      || (view.decision.interaction.rankCount === null && (view.decision.interaction.options.length === 0 || view.decision.interaction.options.some(option => !option.disabled))))) return null;
    if (view.responseResult && (!view.resultsShown || view.replay || ['waiting', 'decision_open', 'debrief', 'ended'].includes(view.phase)
      || view.decision?.status === 'open' || !validResult(view.responseResult, view.decision))) return null;
    if (view.responseResult && view.resultsPage >= (view.responseResult.type === 'ranking' ? Math.max(1, Math.ceil(view.responseResult.counts.length / 2)) : 1)) return null;
    if (view.lastResult && (!view.resultsShown || view.replay)) return null;
    if (view.lastResult) {
      const last = view.lastResult;
      const type = { chose: 'single_choice', selected: 'multi_select', ranked_first: 'ranking' }[last.countMeaning] ?? 'free_text';
      if (type === 'ranking' && (last.counts.length > 8 || last.rankCount > 8)) return null;
      const hasPositions = last.rankCount !== undefined;
      if (type !== 'ranking' || hasPositions) {
        const result = { ...last, type, rankCount: last.rankCount ?? null,
          counts: last.counts.map(row => ({ ...row, positionCounts: row.positionCounts ?? null })) };
        if (!validResult(result, null)) return null;
      } else {
        // Old snapshots have first-choice counts only. Validate those counts without inventing ranking positions.
        if (last.counts.some(row => row.positionCounts !== undefined)
          || !validResult({ ...last, type: 'single_choice', rankCount: null,
            counts: last.counts.map(row => ({ ...row, positionCounts: null })) }, null)) return null;
      }
      if (view.responseResult && (last.decisionId !== view.responseResult.decisionId || last.total !== view.responseResult.total
        || last.rankCount !== (view.responseResult.rankCount ?? undefined)
        || last.counts.length !== view.responseResult.counts.length
        || last.counts.some((row, index) => {
          const other = view.responseResult.counts[index];
          return row.optionId !== other.optionId || row.label !== other.label || row.count !== other.count
            || (row.positionCounts ?? null)?.length !== (other.positionCounts ?? null)?.length
            || (row.positionCounts ?? []).some((count, position) => count !== other.positionCounts[position]);
        }))) return null;
    }
    if (view.responseResult?.ranked && !Object.hasOwn(view.responseResult.ranked, 'orderMeaning')) {
      return { ...view, responseResult: { ...view.responseResult, ranked: { ...view.responseResult.ranked, orderMeaning: null } } };
    }
    return view;
  } catch { return null; }
}
export function acceptLocalFrame(frame, sessionId, previous = null) {
  if (!object({ t: oneOf(['local_snapshot']), view: v => Boolean(acceptDisplayView(v)), epoch: integer, revision: integer, displayRevision: integer })(frame)) return null;
  if (frame.view.sessionId !== sessionId || ['epoch', 'revision', 'displayRevision'].some(k => frame[k] !== frame.view[k])) return null;
  if (previous && (frame.epoch < previous.epoch || (frame.epoch === previous.epoch && (frame.revision < previous.revision || (frame.revision === previous.revision && frame.displayRevision <= previous.displayRevision))))) return null;
  return frame;
}
export function visiblePeople(view) {
  const rows = view.names ?? (view.avatars ?? []).map(avatarId => ({ name: null, avatarId }));
  return { people: rows.slice(0, 12).map(row => ({ name: row.name === null ? null : cleanText(row.name, 40), avatarId: row.avatarId })), more: Math.max(0, rows.length - 12) };
}
export function cueForChange(previous, next, presented = false) {
  if (!previous || next.replay || next.manual || (presented && previous.phase === 'waiting')) return null;
  if (next.phase === 'decision_open' && previous.phase !== 'decision_open') return 'decision_open';
  if (next.phase === 'live' && next.surface?.timelineKind === 'live' && previous.surface?.surfaceId !== next.surface.surfaceId) return 'reveal';
  return null;
}
