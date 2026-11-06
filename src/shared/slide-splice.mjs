// Splicing slides (Julian, 2026-10-17, I2–I4; supersedes D01's teaching-stage-only moves). A slide with one way on sits
// in a sequence: deleting it joins whatever led to it to what followed it, and moving it lifts it out the same way and
// drops it at a chosen place. Pure planners over a draft: each returns the next draft and the changes in words, or a
// refusal with a reason and a code the Builder turns into a fix. They write only the links the Builder already writes
// (start, a slide's next, a branch's next, a reset's checkpoint, a clarification's slides), so the schema is unchanged.
import { incomingLinks } from './builder-graph.mjs';

const list = value => Array.isArray(value) ? value : [];
const refuse = (code, reason, extra = {}) => ({ ok: false, code, reason, ...extra });
const name = beat => `“${beat?.title || 'Untitled slide'}”`;
const branchName = path => `branch “${path?.label || 'Untitled branch'}”`;
const decisionOf = (document, beat) => list(document.decisions).find(item => item.id === beat?.decision_id);
const shared = (document, beat) => beat?.decision_id && list(document.beats).filter(item => item.decision_id === beat.decision_id).length > 1;

/** The one slide a slide leads to (null at the end), or why it has no single way on. */
export function slideExit(document, beatId) {
  const beat = list(document.beats).find(item => item.id === beatId);
  if (!beat) return refuse('missing', 'That slide no longer exists.');
  if (beat.kind !== 'decision') return { ok: true, to: beat.next_beat_id ?? null };
  const paths = list(decisionOf(document, beat)?.paths);
  if (!paths.length) return refuse('missing', 'This question has no branches yet.');
  if (paths.some(path => path.terminal)) return refuse('reset', 'A branch of this question ends with a reset.');
  const to = [...new Set(paths.map(path => path.next_beat_id ?? null))];
  return to.length > 1 ? refuse('splits', 'Its branches lead to different slides. Point them elsewhere first.') : { ok: true, to: to[0] };
}

function pathById(document, id) { return list(document.decisions).flatMap(item => list(item.paths)).find(path => path.id === id); }
/** Point one incoming link at `to` (null ends a slide's sequence). */
function retarget(next, link, to) {
  if (link.kind === 'start') next.start_beat_id = to;
  else if (link.kind === 'stage') { const beat = next.beats.find(item => item.id === link.beatId); if (to) beat.next_beat_id = to; else delete beat.next_beat_id; }
  else if (link.kind === 'path') pathById(next, link.pathId).next_beat_id = to;
  else pathById(next, link.pathId).terminal.checkpoint_beat_id = to;
}
/** Every link into a slide must be able to follow it on to `after`; the first that cannot is returned as a refusal. */
function cannotFollow(document, links, after) {
  if (after) return null;
  for (const link of links) {
    if (link.kind === 'start') return refuse('only', 'Nothing follows this slide to start the case. Add or connect another slide first.');
    if (link.kind === 'path') return refuse('redirect', `${branchName(pathById(document, link.pathId)).replace(/^b/, 'B')} leads here and nothing follows. Choose where it goes instead.`, { pathId: link.pathId });
    if (link.kind === 'checkpoint') return refuse('checkpoint', `${branchName(pathById(document, link.pathId)).replace(/^b/, 'B')} resets to this slide. Choose another checkpoint first.`, { pathId: link.pathId });
  }
  return null;
}
const followed = (document, link, after) => {
  const to = after ? name(list(document.beats).find(item => item.id === after)) : null;
  if (link.kind === 'start') return `The case now starts at ${to}.`;
  if (link.kind === 'stage') return to ? `${name(list(document.beats).find(item => item.id === link.beatId))} now goes to ${to}.` : `${name(list(document.beats).find(item => item.id === link.beatId))} becomes the last slide.`;
  const path = branchName(pathById(document, link.pathId)).replace(/^b/, 'B');
  return link.kind === 'path' ? `${path} now goes to ${to}.` : `${path} now resets to ${to}.`;
};

/**
 * Join what led to a slide to what followed it, ready for the slide (and the content only it shows) to be removed.
 * Returns the healed draft, the changes, `after` (the slide that follows, or null) and `from` (each link that led here).
 * A clarification shown only during this slide goes too; one shown during other slides stays there.
 */
export function healSlideRemoval(document, beatId) {
  const beats = list(document.beats), self = beats.find(item => item.id === beatId);
  if (!self) return refuse('missing', 'That slide no longer exists.');
  if (beats.length === 1) return refuse('only', 'A case keeps at least one slide.');
  if (shared(document, self)) return refuse('shared', 'Another slide asks this same question. Delete that slide first, or change its question.');
  const exit = slideExit(document, beatId);
  if (!exit.ok) return exit;
  const after = exit.to === beatId ? null : exit.to, links = incomingLinks(document, beatId).filter(link => !(link.kind === 'stage' && link.beatId === beatId));
  const stuck = cannotFollow(document, links, after);
  if (stuck) return stuck;
  const next = structuredClone(document), changes = links.map(link => followed(document, link, after));
  for (const link of links) retarget(next, link, after);
  if (Array.isArray(next.clarifications)) {
    next.clarifications = next.clarifications.flatMap(card => {
      if (!list(card.beat_ids).includes(beatId)) return [card];
      const kept = card.beat_ids.filter(id => id !== beatId);
      if (kept.length) return [{ ...card, beat_ids: kept }];
      changes.push(`Clarification “${card.label || 'Untitled clarification'}” goes too.`);
      return [];
    });
  }
  return { ok: true, document: next, changes, after, from: links };
}

/**
 * Move a slide to a place: after a slide ({ beatId }), as the first slide of a branch ({ pathId }) or to the start
 * ({ start: true }). The slide is lifted out (what led to it now goes to what followed it) and dropped in (the place now
 * leads to it, and it leads to whatever the place led to before). A question moves with all of its branches only when
 * they lead to one slide.
 */
export function planSlideMove(document, beatId, anchor) {
  const beats = list(document.beats), self = beats.find(item => item.id === beatId);
  if (!self) return refuse('missing', 'That slide no longer exists.');
  if (shared(document, self)) return refuse('shared', 'Another slide asks this same question, so it stays where it is.');
  const exit = slideExit(document, beatId);
  if (!exit.ok) return exit.code === 'splits' ? refuse('splits', 'Its branches lead to different slides, so it moves with them. Change where each branch goes instead.') : exit;
  let place;
  if (anchor?.start) place = { kind: 'start', to: document.start_beat_id ?? null };
  else if (anchor?.pathId) {
    const path = pathById(document, anchor.pathId);
    if (!path) return refuse('missing', 'That branch no longer exists.');
    if (path.terminal) return refuse('reset', 'That branch ends with a reset.');
    if (list(decisionOf(document, self)?.paths).includes(path)) return refuse('here', 'That is this question’s own branch.');
    if (shared(document, beats.find(item => item.decision_id && list(decisionOf(document, item)?.paths).includes(path)))) return refuse('shared', 'That question is asked on another slide too.');
    place = { kind: 'path', path, to: path.next_beat_id ?? null };
  } else {
    const target = beats.find(item => item.id === anchor?.beatId);
    if (!target) return refuse('missing', 'That place no longer exists.');
    if (target.id === beatId) return refuse('here', 'It is already there.');
    if (shared(document, target)) return refuse('shared', 'That question is asked on another slide too.');
    const out = slideExit(document, target.id);
    if (!out.ok) return out.code === 'splits' ? refuse('splits', 'That question splits into branches. Put the slide after one of its branches.') : out;
    place = { kind: 'beat', target, to: out.to };
  }
  if (place.to === beatId) return refuse('here', 'It is already there.');
  // Lift.
  const next = structuredClone(document), links = incomingLinks(document, beatId).filter(link => !(link.kind === 'stage' && link.beatId === beatId) && link.kind !== 'checkpoint');
  const stuck = cannotFollow(document, links, exit.to);
  if (stuck) return stuck;
  for (const link of links) retarget(next, link, exit.to);
  // What the place leads to once the slide is lifted (it may have led through the slide itself).
  const old = place.kind === 'start' ? next.start_beat_id : place.kind === 'path' ? pathById(next, place.path.id).next_beat_id ?? null : slideExit(next, place.target.id).to;
  const moved = next.beats.find(item => item.id === beatId);
  if (moved.kind === 'decision') {
    if (!old) return refuse('question-last', 'A question can’t be the last slide. Put it before another slide.');
    for (const path of decisionOf(next, moved).paths) path.next_beat_id = old;
  } else if (old) moved.next_beat_id = old; else delete moved.next_beat_id;
  // Drop in.
  if (place.kind === 'start') next.start_beat_id = beatId;
  else if (place.kind === 'path') pathById(next, place.path.id).next_beat_id = beatId;
  else { const target = next.beats.find(item => item.id === place.target.id);
    if (target.kind === 'decision') for (const path of decisionOf(next, target).paths) path.next_beat_id = beatId; else target.next_beat_id = beatId; }
  const words = place.kind === 'start' ? 'now starts the case' : place.kind === 'path' ? `now follows ${branchName(place.path)}` : `now comes after ${name(place.target)}`;
  return { ok: true, document: next, changes: [`${name(self)} ${words}.`] };
}
