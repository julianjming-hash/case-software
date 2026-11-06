// The participant-record summary (room PDFs v2, Julian 2026-10-18): what the Finish card and the participant record PDF show,
// derived only from this phone's own ended view (recap-journey.mjs): time, decisions made, topics. No room data except
// results the room was already shown (`room`, when the view carries it); nothing is sent or stored. Pure data.
import { recapJourney } from './recap-journey.mjs';
import { facilitatorOf } from './record-facts.mjs';

const when = iso => { const d = Date.parse(iso ?? ''); return Number.isFinite(d) ? d : null; };

/**
 * { title, versionNo, startedAt, endedAt, minutes, decisions: { made, total }, topics, objectives, room, facilitator }. `now` (ms) gives the
 * length so far while the room is in Debrief.
 */
export function recordSummary(view, { now = null } = {}) {
  const j = recapJourney(view), tl = Array.isArray(view?.timeline) ? view.timeline : [];
  const startedAt = tl.map(e => e?.at).find(at => when(at) !== null) ?? null, endedAt = when(view?.endedAt) !== null ? view.endedAt : null;
  // In Debrief the room has not ended, so the session so far (to `now`, the phone's clock) is its length (Julian, 2026-11-01).
  const until = endedAt ? when(endedAt) : view?.phase === 'debrief' && Number.isFinite(now) ? now : null;
  const minutes = startedAt && until !== null && until >= when(startedAt) ? Math.round((until - when(startedAt)) / 60000) : null;
  const asks = j.stops.filter(s => s.kind === 'question').map(s => s.question);
  // The answer that stands for a question: its last round with an answer.
  const final = q => [...q.rounds].reverse().find(r => r.words.length) ?? null;
  // You and the room: each shown result beside this phone's own answer (option marks follow the shared order; a ranking's split
  // counts first places, so your own first place is marked).
  const room = asks.map(q => ({ q, r: [...q.rounds].reverse().find(x => x.room) })).filter(x => x.r).map(({ q, r }) => ({
    prompt: String(q.prompt ?? ''), total: r.room.total, options: r.room.options.map((o, k) => ({ mark: k, label: o.label, count: o.count, mine: q.shape === 'ranking' ? r.marks[0] === k : r.marks.includes(k) })) }));
  return {
    title: j.title, room, versionNo: Number.isSafeInteger(view?.recap?.caseVersionNo) ? view.recap.caseVersionNo : null, startedAt, endedAt, minutes,
    decisions: { made: asks.filter(q => final(q)).length, total: asks.length }, topics: j.objectives.length, objectives: j.objectives,
    facilitator: facilitatorOf(view?.recap?.facilitator),
  };
}

export { factsSummary } from './record-facts.mjs';
