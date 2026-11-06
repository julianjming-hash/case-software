// Private Builder Outline (card 50, BWR03). A bounded, iterative, non-mutating navigation projection of the
// authored graph: the spine follows explicit authored recommendations only, alternatives stay local to their
// decision, and rejoins/returns are named references instead of duplicated downstream stages.
const record = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const list = value => Array.isArray(value) ? value : [];

/** Rows in display order; each row names the decision stages (and alternatives) it sits under. */
export function deriveBuilderOutline(document) {
  const diagnostics = new Set(), beats = new Map(), decisions = new Map(), paths = new Map();
  const index = (rows, into, kind) => {
    for (const row of list(rows)) {
      if (!record(row) || typeof row.id !== 'string' || !row.id) diagnostics.add(`A ${kind} has no identity.`);
      else if (into.has(row.id)) diagnostics.add(`Two ${kind} records share one identity.`);
      else into.set(row.id, row);
    }
  };
  index(document?.beats, beats, 'stage'); index(document?.decisions, decisions, 'decision');
  for (const decision of decisions.values()) index(decision.paths, paths, 'consequence');
  // Rejected input never becomes an editor state: refuse ambiguous navigation instead of guessing an owner.
  if (diagnostics.size) return { ok: false, rows: [], stages: 0, diagnostics: [...diagnostics] };
  const uses = new Map();
  for (const beat of beats.values()) uses.set(beat.decision_id, (uses.get(beat.decision_id) ?? 0) + 1);
  // D15: an early clarification's slide (schema 3) is listed under the stage it is shown during (its first), so it can
  // be opened and written like any other slide.
  const clarifications = new Map();
  for (const card of document?.schema_version === 3 ? list(document?.clarifications) : []) {
    const at = record(card) && typeof card.id === 'string' && card.id ? list(card.beat_ids)[0] : null;
    if (beats.has(at)) clarifications.set(at, [...(clarifications.get(at) ?? []), card]);
  }
  const title = id => beats.get(id)?.title || 'Untitled stage';
  // `prior` maps each claimed stage to the stage that led to it, so an upstream reference is a return, not a join.
  const prior = new Map(), queue = [];
  let number = 0, refs = 0;
  function walk(id, depth, owners, numbered, last = null) {
    const nodes = [], ref = (reference, label, beatId) => nodes.push({ kind: 'reference', key: `ref:${refs++}`, depth, owners, reference, label, beatId });
    for (;;) {
      if (!beats.has(id)) { ref('missing', id ? 'Destination needs repair' : 'No next stage set'); break; }
      if (prior.has(id)) {
        let at = last; while (at && at !== id) at = prior.get(at);
        ref(at ? 'returns' : 'joins', `${at ? 'Returns to' : 'Joins'} ${title(id)}`, id); break;
      }
      prior.set(id, last); last = id;
      const beat = beats.get(id), stage = { kind: 'stage', key: `beat:${id}`, beatId: id, depth, owners, number: numbered ? ++number : null, title: title(id), beatKind: beat.kind, surfaceId: beat.surface_id, consequences: [],
        clarifications: (clarifications.get(id) ?? []).map(card => ({ kind: 'clarification', key: `clarification:${card.id}`, beatId: id, clarificationId: card.id, depth: depth + 1, owners, label: card.label || 'Untitled clarification', surfaceId: card.surface_id })) };
      nodes.push(stage);
      if (beat.kind !== 'decision') { if (typeof beat.next_beat_id !== 'string') break; id = beat.next_beat_id; continue; }
      const decision = decisions.get(beat.decision_id), authored = list(decision?.paths), marked = authored.filter(path => path.recommended === true);
      const main = marked.length === 1 ? marked[0] : null, inside = [...owners, id];
      if (authored.length === 1 && main?.continue_to_next === true) { id = main.next_beat_id; continue; }
      const target = path => path.terminal ? `t${path.terminal.checkpoint_beat_id}` : path.next_beat_id;
      const diverge = new Set(authored.map(target)).size > 1;
      stage.shared = uses.get(beat.decision_id) > 1;
      stage.issue = !decision ? 'Decision details need repair' : !authored.length ? 'No consequences yet' : main ? null : 'Choose exactly one recommended consequence';
      for (const path of authored) {
        const terminal = record(path.terminal), to = terminal ? path.terminal.checkpoint_beat_id : path.next_beat_id, known = beats.has(to);
        const consequence = { kind: 'consequence', key: `path:${id}:${path.id}`, beatId: id, pathId: path.id, depth: depth + 1, owners: inside, label: path.label || 'Untitled consequence',
          recommended: path === main, recovery: record(path.recovery), surfaceId: path.reveal_surface_id, route: [],
          destination: terminal ? `Ends · checkpoint ${known ? title(to) : 'needs repair'}` : !known ? 'Destination needs repair' : diverge ? title(to) : null };
        stage.consequences.push(consequence);
        // The recommended continuation stays on this route; every other non-terminal consequence is a local route.
        if (!terminal && path !== main) queue.push([consequence, to, depth + 2, [...inside, consequence.key], id]);
      }
      if (!main || main.terminal) break;
      id = main.next_beat_id;
    }
    return nodes;
  }
  const drain = () => { for (let task; (task = queue.shift());) task[0].route = walk(task[1], task[2], task[3], false, task[4]); };
  const top = walk(document?.start_beat_id, 0, [], true); drain();
  if (!document?.start_beat_id) top[0].label = 'Choose the first stage';
  // Unconnected chains start at their own roots (no incoming authored link) so they are not split by array order.
  const loose = [], incoming = new Set();
  for (const beat of beats.values()) incoming.add(beat.next_beat_id);
  for (const path of paths.values()) incoming.add(path.next_beat_id).add(path.terminal?.checkpoint_beat_id);
  for (const roots of [true, false]) for (const id of beats.keys()) if (!prior.has(id) && (!roots || !incoming.has(id))) { loose.push(...walk(id, 0, [], false)); drain(); }
  if (loose.length) top.push({ kind: 'heading', key: 'heading', depth: 0, owners: [], label: 'Not connected to the start' }, ...loose);
  // Flatten iteratively; nesting depth never consumes call stack.
  const rows = [], stack = [...top].reverse();
  while (stack.length) {
    const node = stack.pop(); rows.push(node);
    const children = node.kind === 'stage' ? [...node.clarifications, ...node.consequences] : node.route ?? [];
    for (let at = children.length - 1; at >= 0; at--) stack.push(children[at]);
  }
  return { ok: true, rows, stages: number, diagnostics: [] };
}

/** Only structural inputs rebuild the Outline DOM. Names refill rows in place; scene typing repaints thumbnails. */
export function builderOutlineSignature(document, names = false) {
  return JSON.stringify([document?.start_beat_id, list(document?.beats).map(b => [b?.id, b?.kind, b?.surface_id, b?.decision_id, b?.next_beat_id, names && b?.title]),
    list(document?.decisions).map(d => [d?.id, list(d?.paths).map(p => [p?.id, p?.recommended, p?.next_beat_id, p?.terminal?.checkpoint_beat_id, !p?.terminal, !p?.recovery, p?.reveal_surface_id, names && p?.label])]),
    document?.schema_version === 3 && list(document?.clarifications).map(c => [c?.id, list(c?.beat_ids)[0], c?.surface_id, names && c?.label])]);
}

/** Mount-local Outline. A new selection reveals its owners; manual open/closed choices persist independently of it. */
/** A key naming which slides show a block that another slide shows too (the Outline marks them). */
function syncMarks(document) {
  const uses = new Map();
  for (const composition of list(document?.compositions)) for (const id of list(composition?.reading_order)) uses.set(id, (uses.get(id) ?? 0) + 1);
  return list(document?.compositions).filter(composition => list(composition?.reading_order).some(id => uses.get(id) > 1)).map(composition => composition.id).join();
}

export function mountBuilderOutline(host, { createId, onSelect, thumbnail = () => null }) {
  const doc = host.ownerDocument, manual = new Map(), thumbs = [], items = [], listNode = doc.createElement('ol');
  const make = (tag, className, text) => { const item = doc.createElement(tag); item.className = className; if (text !== undefined) item.textContent = text; return item; };
  listNode.className = 'builder-outline-list'; host.append(listNode);
  // One Tab stop (round 18): the current slide holds the list's tab index; ↑/↓, Home and End move between visible rows
  // and their consequence chips, and the focused one becomes the stop, so Tab reaches the slide past a long Outline.
  const stops = () => [...listNode.querySelectorAll('.builder-outline-target, .builder-branch-chip')].filter(node => !node.closest('[hidden]'));
  const rove = node => { for (const other of stops()) other.tabIndex = other === node ? 0 : -1; };
  listNode.addEventListener('keydown', event => {
    if (event.altKey || event.ctrlKey || event.metaKey || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const list = stops(), at = list.indexOf(doc.activeElement); if (at < 0) return;
    const next = list[{ ArrowUp: at - 1, ArrowDown: at + 1, Home: 0, End: list.length - 1 }[event.key]];
    event.preventDefault(); if (next) { rove(next); next.focus(); }
  });
  listNode.addEventListener('focusin', event => { if (event.target.matches?.('.builder-outline-target, .builder-branch-chip')) rove(event.target); });
  const prefix = `outline-${createId()}-`;
  let signature, named, projection, selected = {}, surfaces = new Map(), revealed, current = null, query = '', unfit = new Set();
  const paintUnfit = () => {
    for (const [item, row] of items) {
      const target = item.querySelector('.builder-outline-target'); if (!target) continue;
      // A collapsed decision says when one of its hidden consequences does not fit (re-audit #14).
      const hidden = item.querySelector('.builder-branch-chip')?.getAttribute('aria-expanded') === 'false' && (row.consequences ?? []).some(path => unfit.has(path.key));
      const on = unfit.has(row.key) || hidden, words = unfit.has(row.key) ? 'Does not fit' : 'A consequence does not fit';
      let note = target.querySelector('.builder-outline-unfit');
      if (on && !note) { note = make('small', 'builder-outline-unfit', words); target.append(note); }
      if (on && note.textContent !== words) note.textContent = words;
      if (!on) note?.remove();
      item.toggleAttribute('data-unfit', on);
    }
  };
  // Decorative miniature of the current learner surface; the caption beside it carries the full name.
  const set = (node, text) => { if (node.textContent !== text) node.textContent = text; };
  // A slide stage shows its own slide, drawn small by the slide renderer; a fixed-layout stage shows its title and scene.
  const paint = ([box, id, row]) => {
    const mini = current && thumbnail(current, { beatId: row.beatId, pathId: row.pathId ?? null, clarificationId: row.clarificationId ?? null });
    if (mini) { box.classList.add('builder-thumb-slide'); box.replaceChildren(mini); return; }
    if (box.classList.contains('builder-thumb-slide')) { box.classList.remove('builder-thumb-slide'); box.replaceChildren(make('b', ''), make('span', '')); }
    const surface = surfaces.get(id); set(box.firstChild, surface?.title ?? ''); set(box.lastChild, typeof surface?.scene === 'string' ? surface.scene.slice(0, 240) : '');
  };
  function build() {
    thumbs.length = items.length = 0; listNode.replaceChildren();
    if (!projection.ok) { for (const text of projection.diagnostics) listNode.append(make('li', 'builder-outline-issue', text)); return; }
    for (const row of projection.rows) {
      const item = make('li', `builder-outline-${row.kind}`); item.id = prefix + row.key; item.style.paddingLeft = `${Math.min(row.depth, 4) * 12}px`;
      items.push([item, row, row]);
      if (row.kind === 'heading') item.append(make('h3', '', row.label));
      else if (row.kind === 'reference') item.append(make('span', 'builder-outline-ref', row.label));
      else {
        const target = make('button', 'builder-outline-target'), box = make('span', 'builder-thumb');
        target.type = 'button'; target.dataset.outlineKey = row.key; box.setAttribute('aria-hidden', 'true'); box.append(make('b', ''), make('span', ''));
        thumbs.push([box, row.surfaceId, row]);
        target.append(box, make('span', 'builder-outline-name')); target.onclick = () => onSelect(row.beatId, row.pathId ?? null, row.clarificationId ?? null);
        item.append(target);
        if (row.consequences?.length) {
          const foot = make('div', 'builder-outline-foot'), chip = make('button', 'builder-branch-chip'), glyph = make('span', '', '⑂');
          chip.type = 'button'; chip.dataset.outlineKey = `chip:${row.beatId}`; chip.setAttribute('aria-controls', row.consequences.map(item => `${prefix}${item.key}`).join(' '));
          glyph.setAttribute('aria-hidden', 'true'); chip.append(glyph, make('span', '', ` ${row.consequences.length}`));
          chip.onclick = () => { manual.set(row.beatId, chip.getAttribute('aria-expanded') !== 'true'); sync(); };
          foot.append(chip); item.append(foot);
        }
      }
      fill(item, row); listNode.append(item);
    }
    paintUnfit();
  }
  const text = row => JSON.stringify([row.title, row.label, row.destination, row.issue]);
  function fill(item, row) {
    const name = item.querySelector('.builder-outline-name'), chip = item.querySelector('.builder-branch-chip');
    if (!name) { item.firstChild.textContent = row.label; return; }
    const notes = row.kind === 'stage' ? [[row.number, row.beatKind === 'decision' ? 'Decision' : row.beatKind === 'debrief' ? 'Debrief' : 'Teaching stage', row.shared && 'Shared decision'].filter(Boolean).join(' · ')]
      : row.kind === 'clarification' ? ['Early clarification']
      : [row.recommended && 'Recommended', row.destination && `↳ ${row.destination}`, row.recovery && 'Required recovery'];
    name.replaceChildren(make('span', '', row.title ?? row.label));
    for (const note of [...notes, row.issue]) if (note) name.append(make('small', note === row.issue ? 'builder-outline-warn' : note === 'Recommended' ? 'builder-outline-badge' : '', note));
    chip?.setAttribute('aria-label', `${row.consequences.length} ${row.consequences.length === 1 ? 'consequence' : 'consequences'} of ${row.title}`);
  }
  function sync() {
    const key = selected.clarificationId ? `clarification:${selected.clarificationId}` : selected.pathId ? `path:${selected.beatId}:${selected.pathId}` : `beat:${selected.beatId}`, owners = new Set(items.find(([, row]) => row.key === key)?.[1].owners);
    // A new selection reopens the groups that contain it; afterwards a manual choice wins for the rest of the group.
    if (revealed !== key) { revealed = key; for (const owner of owners) if (manual.get(owner) === false) manual.delete(owner); }
    // The selected decision lists its own consequences too, as the study shows; a manual choice still wins.
    const open = owner => owner.startsWith('path:') || (manual.get(owner) ?? (owners.has(owner) || owner === selected.beatId));
    for (const [item, row] of items) {
      // Collapsing never hides the selected row or keyboard focus; alternative markers in `owners` need no expansion.
      // Find shows every matching row (opening its groups); the selected row and focus are never hidden.
      const match = !query || [row.title, row.label].some(text => text?.toLowerCase().includes(query));
      item.hidden = row.key !== key && !item.contains(doc.activeElement) && (query ? !match || row.kind === 'heading' : !row.owners.every(open));
      item.querySelector('.builder-outline-target')?.setAttribute('aria-current', String(row.key === key));
      const chip = item.querySelector('.builder-branch-chip');
      if (chip) { chip.setAttribute('aria-expanded', open(row.beatId)); chip.title = `${open(row.beatId) ? 'Hide' : 'Show'} ${row.consequences.length} ${row.consequences.length === 1 ? 'consequence' : 'consequences'}`; }
    }
    // The current slide is the Tab stop unless focus is already inside the list (its focused row keeps it).
    if (!listNode.contains(doc.activeElement)) { const list = stops(); rove(list.find(node => node.getAttribute('aria-current') === 'true') ?? list[0]); }
    if (unfit.size) paintUnfit();
  }
  return {
    /** Mark the slides that do not fit the projector (case-wide fit, gap audit #10): a labelled note, not colour alone. */
    markUnfit(keys) { unfit = new Set(keys); paintUnfit(); },
    /** The projection of the document last passed to update (cached by structure, so callers need not derive it again). */
    projection() { return projection; },
    /** Filter rows by name (case-insensitive); an empty query restores the authored disclosure. */
    filter(text) { query = String(text ?? '').trim().toLowerCase(); sync(); },
    /** Repaint every thumbnail (the slide renderer arrived after the first paint). */
    refresh() { thumbs.forEach(paint); },
    update(document, selection) {
      surfaces = new Map(list(document?.surfaces).filter(record).map(surface => [surface.id, surface]));
      const before = current; current = document;
      selected = { beatId: selection?.beatId, pathId: selection?.pathId, clarificationId: selection?.clarificationId ?? null };
      const next = builderOutlineSignature(document), names = builderOutlineSignature(document, true), focus = doc.activeElement?.dataset?.outlineKey;
      if (next !== signature) { signature = next; named = names; projection = deriveBuilderOutline(document); build(); if (focus) listNode.querySelector(`[data-outline-key="${CSS.escape(focus)}"]`)?.focus(); }
      // Renaming keeps every node (and focus); the same structure yields the same rows in the same order.
      else if (names !== named) { named = names; projection = deriveBuilderOutline(document); projection.rows.forEach((row, at) => { items[at][1] = row; if (text(row) !== text(items[at][2])) fill(items[at][0], row); items[at][2] = row; }); }
      // Between structural changes only the selected slide can have changed; repaint it, not every thumbnail.
      const rebuilt = signature !== thumbs.built; thumbs.built = signature;
      // A presentation theme (CASE-227) recolours every slide, so it repaints every thumbnail.
      // A block newly shown on other slides marks each of them (CASE-344), so a change in which slides are synced repaints all.
      const marks = syncMarks(document), marked = marks !== thumbs.marks; thumbs.marks = marks;
      if (rebuilt || marked || !before || before.schema_version !== document?.schema_version || before.theme !== document?.theme) thumbs.forEach(paint);
      else thumbs.filter(([, , row]) => row.beatId === selected.beatId && (row.pathId ?? null) === (selected.pathId ?? null) && (row.clarificationId ?? null) === selected.clarificationId).forEach(paint);
      sync();
      return projection;
    },
  };
}
