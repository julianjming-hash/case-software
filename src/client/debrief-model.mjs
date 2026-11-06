// The counts-only facilitator debrief (card 40, Julian's rulings 2026-10-17): one model, built from a P-34 record page now
// and from the console's derived End model later, drawn by debrief-render.mjs as HTML/print and as a tagged PDF. No
// participant id, name, answer text or free text enters it; raw ids and event kinds stay in the JSON export only.
export const KIND = { single_choice: 'Single choice', multi_select: 'Select all that apply', ranking: 'Ranking', free_text: 'Free text' };
export const INTERACTION_SYMBOL = { single_choice: 'single', multi_select: 'multi', ranking: 'ranking', free_text: 'free' };
export const CLASS = { sound: 'Sound', defensible: 'Defensible', 'context-dependent': 'Context-dependent', unsafe: 'Unsafe · recoverable', 'terminal-unsafe': 'Terminal · needs a checkpoint reset', 'discussion-prompt': 'Discussion prompt' };
import { formattedTextPlainText } from '../shared/builder-format.mjs';
import { routeSummary } from './pdf-glance.mjs';
const CLOSED = new Set(['resolved', 'superseded', 'abandoned']);
const ms = (x) => (x ? Date.parse(x) : NaN);

/** One record page → the debrief model. Questions are the closed rounds in the order they opened. */
export function buildDebrief(page, { part = 1 } = {}) {
  const s = page.session, joined = page.joined;
  // Room PDFs v2: the published route's shape (chapters, questions, forks) for At a glance, and each question's chapter.
  const route = routeSummary(page.document), chapterOf = new Map(route.filter((x) => x.decisionId).map((x) => [x.decisionId, x.chapter]));
  const rounds = page.items.filter((i) => i.type === 'round' && CLOSED.has(i.status)).sort((a, b) => ms(a.openedAt) - ms(b.openedAt) || a.number - b.number);
  const questions = rounds.map((r, i) => {
    const agg = r.aggregate, type = r.interaction ?? null, ranking = type === 'ranking' || agg?.rankCount !== undefined;
    const rows = (agg?.counts ?? []).map((c, k) => ({ mark: k, label: c.label, count: ranking ? (c.positionCounts?.[0] ?? 0) : c.count }));
    return {
      n: i + 1, prompt: r.prompt, type, status: r.status, total: agg ? agg.total : null, rows, ranking,
      freeText: type === 'free_text' || (agg !== null && agg !== undefined && rows.length === 0),
      route: r.branch && r.pathLabel ? { label: r.pathLabel, classification: r.classification ?? null, recommended: r.recommended === true } : null,
      openedAt: r.openedAt, closedAt: r.closedAt, chapter: chapterOf.get(r.decisionId) || null,
    };
  });
  const resets = page.items.filter((i) => i.type === 'event' && i.kind === 'checkpoint_reset').length;
  return {
    title: s.title, versionNo: s.versionNo, digest: s.digest.slice(0, 8), startedAt: s.startedAt, endedAt: s.endedAt,
    minutes: s.startedAt && s.endedAt ? Math.max(0, Math.round((ms(s.endedAt) - ms(s.startedAt)) / 60000)) : null,
    joined, completeness: page.completeness, withdrawn: s.sourceStatus === 'withdrawn', part, more: Boolean(page.nextAfter),
    objectives: page.intendedObjectives ?? [], questions, routeChoices: questions.filter((q) => q.route), resets, route,
  };
}

const plainText = (x) => (typeof x === 'string' ? x : formattedTextPlainText(x));
/**
 * The console's End model (slice 6, ruling I1): the facilitator's ended mirror and the pack, before the purge, become
 * the same record-page shape buildDebrief reads. Only counts, labels and the case's own text are copied; participants
 * contribute a count, never a name, id or answer. No mirror or no pack gives no model.
 */
export function roomDebrief(mirror, doc) {
  if (!mirror || !doc || !Array.isArray(mirror.rounds) || !Array.isArray(doc.decisions)) return null;
  const decisions = new Map(doc.decisions.map((d) => [d.id, d]));
  const items = mirror.rounds.map((r) => {
    const d = decisions.get(r.decisionId), type = d?.interaction?.type ?? null, path = d?.paths?.find((p) => p.id === r.selectedPathId), a = r.aggregate;
    const aggregate = a && Number.isSafeInteger(a.total) ? { total: a.total, counts: type === 'free_text' ? [] : (d?.interaction?.options ?? []).map((o) => ({
      label: plainText(o.label), count: Number.isSafeInteger(a.counts?.[o.id]) ? a.counts[o.id] : 0,
      ...(type === 'ranking' ? { positionCounts: Array.isArray(a.positionCounts?.[o.id]) ? [...a.positionCounts[o.id]] : [] } : {}) })) } : null;
    return { type: 'round', decisionId: r.decisionId, number: r.no, status: r.status, openedAt: r.openedAt, closedAt: r.closedAt ?? null, prompt: plainText(d?.prompt) || 'Decision text unavailable',
      pathLabel: path ? plainText(path.label) : null, interaction: type, branch: (d?.paths?.length ?? 0) > 1,
      classification: path?.classification ?? null, recommended: path?.recommended === true, aggregate };
  });
  const startedAt = mirror.revealed?.[0]?.at ?? null;
  return buildDebrief({
    session: { title: plainText(doc.title), versionNo: mirror.caseVersionNo ?? null, digest: '', startedAt, endedAt: mirror.endedAt ?? null, sourceStatus: 'published' },
    joined: Object.keys(mirror.participants ?? {}).length, completeness: 'room', nextAfter: null, document: doc,
    intendedObjectives: (doc.learning_objectives ?? []).map(plainText),
    items: [...items, ...(mirror.exploredTerminal ?? []).map(() => ({ type: 'event', kind: 'checkpoint_reset' }))],
  });
}
