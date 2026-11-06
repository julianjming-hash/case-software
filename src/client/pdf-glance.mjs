// "At a glance" for the facilitator PDFs (card 40a briefing, 40c debrief): the published case's main route as one line, a
// diamond per question (filled where the question changes the route), a dashed loop per alternative route, and a tick and
// label where a chapter opens ("Label · " title prefix). Facilitator documents only; nothing here reaches a phone.

const part = t => (typeof t === 'string' && t.includes(' · ') ? t.split(' · ')[0] : '');

/** The main route of a published document (recommended path at each question): [{ chapter, question, branch, alternatives, beatId, decisionId }]. */
export function routeSummary(doc) {
  if (!doc || !Array.isArray(doc.beats) || !Array.isArray(doc.decisions)) return [];
  const B = new Map(doc.beats.map(b => [b.id, b])), D = new Map(doc.decisions.map(d => [d.id, d]));
  const rec = d => d.paths?.find(p => p.recommended) ?? d.paths?.[0];
  const out = [], seen = new Set();
  for (let b = B.get(doc.start_beat_id); b && !seen.has(b.id);) {
    seen.add(b.id);
    const d = b.decision_id && D.get(b.decision_id), alts = d ? Math.max(0, (d.paths?.length ?? 0) - 1) : 0;
    out.push({ chapter: part(b.title), question: Boolean(d), branch: alts > 0, alternatives: alts, beatId: b.id, decisionId: d?.id ?? null });
    b = B.get(d ? rec(d)?.next_beat_id : b.next_beat_id);
  }
  return out;
}

/** The glance's draw list for a DIAGRAM row of height 66, 499 points wide; branch questions are numbered 1, 2, 3 … */
export function glanceDraw(route) {
  const n = route.length, x = i => (n > 1 ? 8 + i * 483 / (n - 1) : 249), y = 44, draw = [{ line: [[x(0), y], [x(Math.max(0, n - 1)), y]], stroke: 'petrol', width: 3 }];
  let last = '', lastX = -99, branchNo = 0;
  route.forEach((s, i) => {
    const cx = x(i);
    if (s.branch) for (let k = 0; k < s.alternatives; k++) draw.push({ line: [[cx, y], [cx + 4, y + 10 + k * 6], [cx + 22, y + 10 + k * 6], [cx + 26, y]], stroke: 'muted', width: 1, dash: true });
    if (s.question) draw.push({ sym: 'dia', x: cx - 6, y: y - 6.6, size: 12, colour: 'ink' }, ...(s.branch ? [] : [{ sym: 'dia', x: cx - 3.5, y: y - 3.85, size: 7, colour: 'white' }]));
    else draw.push({ sym: 'rev', x: cx - 4, y: y - 4.4, size: 8, colour: 'white' }, { sym: 'dot', x: cx - 4, y: y - 4.4, size: 8, colour: 'petrol' });
    if (s.chapter && s.chapter !== last && cx - lastX > 60) { lastX = cx; draw.push({ text: s.chapter, x: cx, y: 10, size: 7.5, colour: 'ink', bold: true }, { line: [[cx, 14], [cx, y - 9]], stroke: 'line', width: .6 }); }
    if (s.chapter) last = s.chapter;
    if (s.branch) draw.push({ text: String(++branchNo), x: cx, y: y - 10, size: 7, colour: 'ink', mono: true, align: 'middle' });
  });
  return draw;
}
