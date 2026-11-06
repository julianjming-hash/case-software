// Builder graph tools (card 54, BWR06; D01 conservative scope). Pure planners over a paired draft: each returns a
// refusal with its reason, or the next draft plus the exact link changes a review shows. They never sort storage arrays
// as a "move", never rewire decisions, starts, checkpoints or rejoins implicitly, and never cascade.
import { blankSlide } from './blank-slide.mjs';

const refuse = reason => ({ ok: false, reason });
const list = value => Array.isArray(value) ? value : [];
const title = beat => beat?.title || 'Untitled stage';

/** Every reference that leads into a stage: the case start, a stage's next link, a consequence, a terminal checkpoint. */
export function incomingLinks(document, beatId) {
  const links = [];
  if (document.start_beat_id === beatId) links.push({ kind: 'start' });
  for (const beat of list(document.beats)) if (beat.next_beat_id === beatId) links.push({ kind: 'stage', beatId: beat.id });
  for (const decision of list(document.decisions)) for (const path of list(decision.paths)) {
    if (path.next_beat_id === beatId) links.push({ kind: 'path', pathId: path.id, decisionId: decision.id });
    if (path.terminal?.checkpoint_beat_id === beatId) links.push({ kind: 'checkpoint', pathId: path.id });
  }
  return links;
}
const describe = (document, link) => link.kind === 'start' ? 'the case start'
  : link.kind === 'stage' ? `“${title(list(document.beats).find(beat => beat.id === link.beatId))}”`
    : `consequence “${list(document.decisions).flatMap(item => list(item.paths)).find(path => path.id === link.pathId)?.label || 'Untitled consequence'}”`;
/** Point one incoming link at another stage. */
function retarget(next, link, to) {
  if (link.kind === 'start') next.start_beat_id = to;
  else if (link.kind === 'stage') next.beats.find(beat => beat.id === link.beatId).next_beat_id = to;
  else next.decisions.flatMap(item => list(item.paths)).find(path => path.id === link.pathId).next_beat_id = to;
}
const linear = beat => beat && beat.kind !== 'decision' && beat.kind !== 'debrief';

/**
 * Move a teaching stage one place later (delta 1) or earlier (delta -1) along its path (D01): P → S → N → M becomes
 * P → N → S → M. Both stages must be linear teaching stages, each reached by exactly one link and neither a checkpoint;
 * anything else is refused with the reason, and Connect is the explicit route.
 */
export function moveStage(document, beatId, delta) {
  const beats = list(document.beats), self = beats.find(beat => beat.id === beatId);
  if (!self) return refuse('That stage no longer exists.');
  if (!linear(self)) return refuse('Only teaching stages move along a path; decisions and debriefs stay where their routes put them. Use Connect to change a route.');
  let first, second;
  if (delta > 0) { first = self; second = beats.find(beat => beat.id === self.next_beat_id); }
  else { const into = incomingLinks(document, beatId).filter(link => link.kind === 'stage'); second = self; first = into.length === 1 ? beats.find(beat => beat.id === into[0].beatId) : null; }
  if (!first || !second) return refuse(delta > 0 ? 'Nothing follows this stage on its path.' : 'No single teaching stage leads into this one.');
  // The neighbour is the one that cannot move: say so, rather than blaming the teaching stage chosen (r24 P3).
  if (!linear(first) || !linear(second)) return refuse(`“${title(first === self ? second : first)}” is a decision or debrief, which stays where its routes put it. Use Connect to change a route.`);
  const intoFirst = incomingLinks(document, first.id), intoSecond = incomingLinks(document, second.id);
  if (intoFirst.some(link => link.kind === 'checkpoint') || intoSecond.some(link => link.kind === 'checkpoint')) return refuse('A stage used as a checkpoint keeps its place. Change the checkpoint first.');
  if (intoFirst.length !== 1) return refuse(`“${title(first)}” is reached from ${intoFirst.length} places; moving it would rewire a rejoin. Use Connect instead.`);
  if (intoSecond.length !== 1) return refuse(`“${title(second)}” is reached from ${intoSecond.length} places; moving it would rewire a rejoin. Use Connect instead.`);
  const next = structuredClone(document), before = intoFirst[0], after = second.next_beat_id;
  retarget(next, before, second.id);
  next.beats.find(beat => beat.id === second.id).next_beat_id = first.id;
  const moved = next.beats.find(beat => beat.id === first.id);
  if (after) moved.next_beat_id = after; else delete moved.next_beat_id;
  const end = after ? `“${title(beats.find(beat => beat.id === after))}”` : 'the end of the path';
  return { ok: true, document: next, changes: [`${describe(document, before)} now leads to “${title(second)}”.`, `“${title(second)}” now leads to “${title(first)}”.`, `“${title(first)}” now leads to ${end}.`] };
}

/**
 * Move a teaching stage several places along its path (gap audit #25): the one-place move repeated, each step checked,
 * and the review lists only the net link changes between the draft now and after the move.
 */
export function moveStageTo(document, beatId, delta) {
  if (!Number.isInteger(delta) || delta === 0) return refuse('Choose where the stage moves.');
  let current = document;
  for (let step = 0; step < Math.abs(delta); step++) { const moved = moveStage(current, beatId, Math.sign(delta)); if (!moved.ok) return moved; current = moved.document; }
  const beats = list(document.beats), name = id => `“${title(beats.find(beat => beat.id === id))}”`, to = id => id ? name(id) : 'the end of its path';
  const changes = [];
  if (current.start_beat_id !== document.start_beat_id) changes.push(`the case start now leads to ${name(current.start_beat_id)}.`);
  for (const beat of list(current.beats)) { const was = beats.find(item => item.id === beat.id); if ((was?.next_beat_id ?? null) !== (beat.next_beat_id ?? null)) changes.push(`${name(beat.id)} now leads to ${to(beat.next_beat_id)}.`); }
  for (const decision of list(current.decisions)) for (const path of list(decision.paths)) {
    const was = list(list(document.decisions).find(item => item.id === decision.id)?.paths).find(item => item.id === path.id);
    if ((was?.next_beat_id ?? null) !== (path.next_beat_id ?? null)) changes.push(`The consequence “${path.label || 'Untitled consequence'}” now leads to ${to(path.next_beat_id)}.`);
  }
  return { ok: true, document: current, changes };
}

/**
 * The places a teaching stage can move to along its path: [delta, label naming the stage it would sit beside, that
 * stage's id]. A path is never longer than the case, so the search is bounded by its stage count (re-audit #15).
 */
export function stageMoveTargets(document, beatId, limit = list(document.beats).length) {
  const targets = [];
  for (const direction of [-1, 1]) {
    let current = document;
    for (let step = 1; step <= limit; step++) {
      const self = list(current.beats).find(beat => beat.id === beatId);
      const passed = direction > 0 ? list(current.beats).find(beat => beat.id === self?.next_beat_id) : list(current.beats).find(beat => beat.next_beat_id === beatId);
      const moved = moveStage(current, beatId, direction);
      if (!moved.ok || !passed) break;
      current = moved.document;
      targets.push([direction * step, `${direction < 0 ? 'Before' : 'After'} “${title(passed)}”`, passed.id]);
    }
  }
  return targets.sort((a, b) => a[0] - b[0]);
}

/** Connect a teaching stage's next link to a named stage (or end its path). Shows what loses or gains a link. */
export function connectStage(document, beatId, targetId) {
  const beats = list(document.beats), self = beats.find(beat => beat.id === beatId), target = targetId ? beats.find(beat => beat.id === targetId) : null;
  if (!self) return refuse('That stage no longer exists.');
  if (self.kind === 'decision') return refuse('A decision continues through its consequences; connect each consequence instead.');
  if (targetId && !target) return refuse('That destination no longer exists.');
  if (targetId === beatId) return refuse('A stage cannot lead to itself.');
  if ((self.next_beat_id ?? null) === (targetId ?? null)) return refuse('The stage already leads there.');
  const next = structuredClone(document), mine = next.beats.find(beat => beat.id === beatId), old = beats.find(beat => beat.id === self.next_beat_id);
  if (targetId) mine.next_beat_id = targetId; else delete mine.next_beat_id;
  const changes = [`“${title(self)}” now leads to ${target ? `“${title(target)}”` : 'the end of its path'}.`];
  if (old && !incomingLinks(next, old.id).length) changes.push(`“${title(old)}” is no longer reached from anywhere; it stays in the draft as unconnected material.`);
  if (target && incomingLinks(document, target.id).length) changes.push(`“${title(target)}” is also reached from elsewhere; it becomes a rejoin.`);
  return { ok: true, document: next, changes };
}

/**
 * Duplicate one teaching stage as independent material: a new stage, its own learner content and (for slides) its own
 * slide and blocks, all with fresh identities and internal references remapped. Source traces on the copied content
 * are copied as needing review. `insert` places it straight after the original; otherwise it stays unconnected.
 */
export function duplicateStage(document, metadata, beatId, createId, { insert = false } = {}) {
  const self = list(document.beats).find(beat => beat.id === beatId);
  if (!self) return refuse('That stage no longer exists.');
  if (self.kind === 'decision') return refuse('A decision stage is not copied yet: its consequences and rules need their own reviewed copy.');
  const next = structuredClone(document), meta = structuredClone(metadata ?? { metadata_version: 1 }), ids = new Map();
  const fresh = id => { if (!ids.has(id)) ids.set(id, createId()); return ids.get(id); };
  const copy = { ...structuredClone(self), id: fresh(self.id), title: `${title(self)} (copy)` };
  const surface = list(next.surfaces).find(item => item.id === self.surface_id);
  if (surface) { const own = { ...structuredClone(surface), id: fresh(surface.id) }; next.surfaces.push(own); copy.surface_id = own.id; }
  const composition = list(next.compositions).find(item => item.owner?.kind === 'beat' && item.owner.id === self.id);
  if (composition) {
    const renew = items => { for (const item of list(items)) if (item && typeof item === 'object' && 'id' in item) item.id = fresh(item.id); };
    for (const id of composition.reading_order) {
      const block = next.blocks.find(item => item.id === id);
      if (!block || block.type === 'question') continue;
      // Every nested identity is renewed (trend points and series too, which this once missed; gas groups, their rows and
      // compared samples, CASE-317).
      const own = structuredClone(block); own.id = fresh(block.id); renew(own.columns); renew(own.rows); renew(own.entries); renew(own.points); renew(own.series); renew(own.groups); renew(own.compare?.earlier);
      for (const group of list(own.groups)) renew(group.rows);
      next.blocks.push(own);
    }
    const kept = id => ids.has(id);
    next.compositions.push({ ...structuredClone(composition), id: fresh(composition.id), owner: { kind: 'beat', id: copy.id },
      reading_order: composition.reading_order.filter(kept).map(fresh),
      placements: composition.placements.filter(item => kept(item.block_id)).map(item => ({ ...item, block_id: fresh(item.block_id) })),
      steps: composition.steps.map(step => ({ id: createId(), block_ids: step.block_ids.filter(kept).map(fresh) })).filter((step, at) => at === 0 || step.block_ids.length),
      styles: list(composition.styles).filter(item => kept(item.block_id)).map(item => ({ ...item, block_id: fresh(item.block_id) })) });
  }
  // Traces follow the copied content and must be reviewed again; the sources themselves are shared references.
  const traces = list(meta.provenance).filter(entry => ids.has(entry.entity_id) && entry.entity_id !== self.id);
  for (const entry of traces) meta.provenance.push({ ...structuredClone(entry), entity_id: ids.get(entry.entity_id), review_status: 'stale' });
  const original = next.beats.find(beat => beat.id === self.id), at = next.beats.indexOf(original);
  const changes = [`A copy “${copy.title}” with its own learner content${composition ? ' and slide' : ''}.`];
  if (traces.length) changes.push(`${traces.length} source ${traces.length === 1 ? 'trace is' : 'traces are'} copied and marked for review again.`);
  if (insert) {
    original.next_beat_id = copy.id;
    changes.push(`“${title(self)}” now leads to the copy; the copy leads to ${self.next_beat_id ? `“${title(list(document.beats).find(beat => beat.id === self.next_beat_id))}”` : 'the end of the path'}.`);
  } else changes.push(`The copy is not connected yet: it keeps “${title(self)}”’s destination and appears under “Not connected to the start”.`);
  next.beats.splice(at + 1, 0, copy);
  return { ok: true, document: next, metadata: meta, beatId: copy.id, changes };
}

/** A new stage in a slide draft starts as a Title and text slide: an empty H1 in the title slot and an empty text block (CASE-222). */
/**
 * Give a new occurrence its own slide (BWR14: every stage, consequence and clarification owns a composition). `owner` is
 * a beat id or { kind, id }. A decision stage also gets its question block, bound to `decisionId`, beside the text.
 */
export function withEmptySlide(document, owner, createId, { decisionId = null } = {}) {
  if (document?.schema_version !== 3) return document;
  const next = structuredClone(document), slide = blankSlide(owner, createId, decisionId);
  next.blocks.push(...slide.blocks); next.compositions.push(...slide.compositions);
  return withoutComposedShadows(next);
}

const SHADOWS = ['scene', 'points', 'investigations', 'observations', 'body', 'variants'];
/**
 * A surface whose every use now has a slide keeps its learner content in blocks only (schema 3), so the empty legacy
 * fields a new stage or decision starts with are dropped (D5). Filled ones are kept for the validator to name. Given the
 * draft `before` an edit, a stage's own learner heading also follows its renamed stage while it still matched the old
 * name, so naming a new stage names its heading too (round 23); a heading set apart stays as written. A consequence's or
 * clarification's own content follows its label in the same way (D25).
 */
export function withoutComposedShadows(document, before = null) {
  if (document?.schema_version !== 3) return document;
  const was = new Map(list(before?.beats).map(beat => [beat.id, beat.title])), single = new Map();
  for (const beat of list(document.beats)) single.set(beat.surface_id, single.has(beat.surface_id) ? null : beat);
  const renamed = list(document.surfaces).filter(surface => { const beat = single.get(surface.id);
    return beat && was.has(beat.id) && was.get(beat.id) !== beat.title && surface.title === was.get(beat.id) && typeof beat.title === 'string' && beat.title.length <= 120; });
  if (renamed.length) document = { ...document, surfaces: document.surfaces.map(surface => renamed.includes(surface) ? { ...surface, title: single.get(surface.id).title } : surface) };
  // D25: content only one consequence or clarification shows follows that owner's renamed label the same way.
  const label = new Map([...list(before?.decisions).flatMap(item => list(item?.paths)), ...list(before?.clarifications)].map(item => [item?.id, item?.label]));
  const sole = new Map(list(document.beats).map(beat => [beat.surface_id, null])), mark = (id, item) => sole.set(id, sole.has(id) ? null : item);
  for (const decision of list(document.decisions)) for (const path of list(decision.paths)) mark(path.reveal_surface_id, path);
  for (const item of list(document.clarifications)) mark(item.surface_id, item);
  const relabelled = list(document.surfaces).filter(surface => { const owner = sole.get(surface.id);
    return owner && label.has(owner.id) && label.get(owner.id) !== owner.label && surface.title === label.get(owner.id) && typeof owner.label === 'string' && owner.label.length <= 120; });
  if (relabelled.length) document = { ...document, surfaces: document.surfaces.map(surface => relabelled.includes(surface) ? { ...surface, title: sole.get(surface.id).label } : surface) };
  const owned = new Set(list(document.compositions).map(item => `${item?.owner?.kind}:${item?.owner?.id}`)), uses = new Map();
  const use = (id, key) => uses.set(id, [...(uses.get(id) ?? []), owned.has(key)]);
  for (const beat of list(document.beats)) use(beat.surface_id, `beat:${beat.id}`);
  for (const decision of list(document.decisions)) for (const path of list(decision.paths))
    if (!(path.continue_to_next === true && document.required_capabilities?.includes('direct_continuation'))) use(path.reveal_surface_id, `path:${path.id}`);
  for (const item of list(document.clarifications)) use(item.surface_id, `clarification:${item.id}`);
  const empty = value => value === '' || (Array.isArray(value) && !value.length);
  const stale = list(document.surfaces).filter(surface => uses.get(surface.id)?.every(Boolean) && SHADOWS.some(key => empty(surface[key])));
  if (!stale.length) return document;
  return { ...document, surfaces: document.surfaces.map(surface => stale.includes(surface)
    ? Object.fromEntries(Object.entries(surface).filter(([key, value]) => !(SHADOWS.includes(key) && empty(value)))) : surface) };
}
