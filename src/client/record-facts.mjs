// The participant-record summary from the feedback page's public facts (room PDFs v2): its own small module, so the /F page does not
// load the recap journey for a browser that never joined. Same shape as record-summary.mjs's recordSummary. Pure data.
const when = iso => { const d = Date.parse(iso ?? ''); return Number.isFinite(d) ? d : null; };
/** The facilitator who ran the room, "Name, Role" fixed at start (Julian, 2026-10-18), as the ended view or /F carries it; text only. */
export const facilitatorOf = value => typeof value === 'string' && value.length > 0 && value.length <= 324 ? value : null;

/** The same summary from the feedback page's public facts, for a browser that did not join: no answers, no decisions. */
export function factsSummary(facts) {
  const s = when(facts?.startedAt), e = when(facts?.endedAt), objectives = (Array.isArray(facts?.objectives) ? facts.objectives : []).map(String);
  return { title: String(facts?.title ?? ''), versionNo: Number.isSafeInteger(facts?.versionNo) ? facts.versionNo : null, startedAt: facts?.startedAt ?? null,
    endedAt: facts?.endedAt ?? null, minutes: s !== null && e !== null && e >= s ? Math.round((e - s) / 60000) : null,
    decisions: null, topics: objectives.length, objectives, room: [], facilitator: facilitatorOf(facts?.facilitator) };
}
