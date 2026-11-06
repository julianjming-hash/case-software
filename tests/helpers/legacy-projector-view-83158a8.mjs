// Frozen behavior from runtime83158a8; original SHA-256 648b0876dedc756f3cbdbfb75f48c93b50a26685bad18003fa12537648e924b2; only import paths rebased.
// Display-only boundary for server snapshots and future same-PC console senders.
// No case pack, facilitator mirror, participant identifiers or free-text responses cross it.
import { cleanText } from '../../src/shared/text.mjs';
import { isUuid, normalizeCode } from '../../src/shared/ids.mjs';
import { isAvatarId } from '../../src/shared/participant.mjs';
import { validRankedPage } from '../../src/shared/ranked-page-view.mjs';
import { validArtDescriptor } from '../../src/shared/art-descriptor.mjs';
import { isTint } from '../../src/shared/tints.mjs';
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
const surface = object({ surfaceId: isUuid, kind: text, title: text, scene: nullable(text), points: list(text, 30), investigations: list(text, 30),
  observations: list(object({ label: text, value: text, unit: v => v === undefined || nullable(text)(v), trend: oneOf(['up', 'down', null]), previous: nullable(text) }), 30),
  assetIds: list(isUuid, 30), timelineKind: oneOf(['live', 'consequence', 'terminal']), manual: bool, at: text });
const timer = v => object({ paused: bool, remainingS: integer })(v) || object({ paused: bool, endsAt: text })(v);
const optional = check => v => v === undefined || check(v);
const resultRow = object({ optionId: isUuid, label: text, count: integer, positionCounts: nullable(list(integer, 30)) });
const responseResult = object({ decisionId: isUuid, prompt: text, roundNo: integer,
  type: oneOf(['single_choice', 'multi_select', 'ranking', 'free_text']), total: integer,
  rankCount: nullable(integer), counts: list(resultRow, 30), ranked: optional(v => Boolean(v) && typeof v === 'object') });
const SHAPE = { role: oneOf(['display']), sessionId: isUuid, joinCode: v => normalizeCode(v, 6) === v,
  epoch: integer, revision: integer, displayRevision: integer, caseTitle: text, caseVersionNo: nullable(integer), art: v => v === undefined || v === null || validArtDescriptor(v), tint: v => v === undefined || isTint(v), endedAt: nullable(text), recapExpiresAt: nullable(text),
  timer: nullable(timer), phase: oneOf(['waiting', 'live', 'decision_open', 'reviewing', 'teaching', 'paused', 'ended']),
  manual: bool, joiningClosed: bool, replay: bool, surface: nullable(surface),
  decision: nullable(object({ decisionId: isUuid, prompt: text, status: oneOf(['open', 'locked', 'paused', 'manual']),
    interaction: object({ type: oneOf(['single_choice', 'multi_select', 'ranking', 'free_text']), options: list(option, 30), rankCount: nullable(v => integer(v) && v >= 1 && v <= 30) }) })),
  counts: object({ participants: integer, present: integer, responded: nullable(integer) }),
  avatars: nullable(list(avatar)), names: nullable(list(object({ name: text, avatarId: avatar }))),
  arrivalCount: v => integer(v) && v <= 300, resultsShown: bool, resultsPage: v => integer(v) && v <= 3, responseResult: nullable(responseResult),
  lastResult: nullable(object({ decisionId: isUuid, prompt: text, roundNo: integer, total: integer, countMeaning: oneOf(['chose', 'selected', 'ranked_first', null]),
    rankCount: optional(integer), counts: list(object({ optionId: isUuid, label: text, count: integer, positionCounts: optional(list(integer, 30)) }), 30),
    split: bool, howChosen: oneOf(['majority', 'minority', 'override']), whatHappened: text })) };
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
  if (result.type === 'free_text') return result.rankCount === null && result.counts.length === 0;
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
    if (!shape(view) || (view.names !== null && (view.avatars !== null || view.counts.responded !== null || view.responseResult !== null || view.lastResult !== null))) return null;
    if (view.avatars !== null && (view.responseResult !== null || view.lastResult !== null)) return null;
    if (view.arrivalCount < view.counts.participants || view.counts.participants > 300 || view.counts.present > view.counts.participants) return null;
    if (view.decision?.interaction.type === 'ranking' && (view.decision.interaction.options.length > 8 || view.decision.interaction.rankCount > 8
      || (view.decision.interaction.rankCount === null && (view.decision.interaction.options.length === 0 || view.decision.interaction.options.some(option => !option.disabled))))) return null;
    if (view.responseResult && (!view.resultsShown || view.replay || ['waiting', 'decision_open', 'ended'].includes(view.phase)
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
