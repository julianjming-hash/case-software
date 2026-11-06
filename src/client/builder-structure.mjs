// Moving, deleting and connecting slides from the Outline (Julian, 2026-10-17; docs/red-team/2026-10-17-builder-slide-structure.md).
// A lazy chunk the studio loads the first time the pointer or focus reaches the Outline, or a slide menu is asked for.
// It adds a ⋯ laid over each tile, one slide menu (right-click, long-press, ⋯, the menu key or Shift+F10), picking a
// destination or a gap on the strip itself, and the delete review that joins a slide's neighbours in one undoable change.
import { healSlideRemoval, planSlideMove, slideExit } from '../shared/slide-splice.mjs';
import { connectStage, duplicateStage, incomingLinks } from '../shared/builder-graph.mjs';

const CSS = `.builder-outline-list>li{position:relative}
.builder-slide-more{position:absolute;z-index:var(--z-raised);top:calc(var(--sp-1) + 5px);right:calc(var(--sp-1) + 5px);display:grid;place-items:center;width:32px;height:32px;padding:0;border:0;border-radius:var(--radius-xs);background:var(--surface);box-shadow:var(--shadow-1);color:var(--ink);font:inherit;line-height:1;opacity:0;cursor:pointer}
.builder-outline-list>li:is(:hover,:focus-within)>.builder-slide-more,.builder-outline-list>li:has(>[aria-current="true"])>.builder-slide-more,.builder-slide-more[aria-expanded="true"]{opacity:1}
.builder-slide-more:hover{background:var(--quiet)}
.builder-slide-menu{position:fixed;z-index:var(--z-overlay);display:grid;min-width:200px;padding:var(--sp-1);border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--surface);box-shadow:var(--shadow-2)}
.builder-slide-menu button{display:flex;justify-content:space-between;align-items:center;gap:var(--sp-4);min-height:40px;padding:0 var(--sp-3);border:0;border-radius:var(--radius-xs);background:transparent;color:var(--ink);font:inherit;font-size:var(--t-sm);text-align:left;cursor:pointer}
.builder-slide-menu button:is(:hover,:focus-visible):not(:disabled){background:var(--quiet);outline:none}
.builder-slide-menu button:disabled{color:var(--ink-muted);cursor:default}.builder-slide-menu small{font-size:var(--t-xs);color:var(--ink-muted)}
.builder-slide-menu .builder-danger{color:var(--alert-ink)}.builder-slide-menu hr{width:100%;margin:var(--sp-1) 0;border:0;border-top:1px solid var(--line)}
.builder-pick-bar{display:flex;align-items:center;gap:var(--sp-2);padding:var(--sp-2) var(--sp-3);background:var(--petrol);color:var(--on-petrol);font-size:var(--t-sm)}
.builder-pick-bar b{flex:1}.builder-pick-bar button{min-height:32px;padding:0 var(--sp-2);border:1px solid var(--on-petrol);border-radius:var(--radius-xs);background:transparent;color:var(--on-petrol);font:inherit;cursor:pointer}
.builder-picking li>.builder-outline-target{opacity:.4}.builder-picking li.builder-pick-can>.builder-outline-target{opacity:1;outline:2px dashed var(--petrol);outline-offset:2px}
.builder-picking li.builder-pick-now>.builder-outline-target{outline:2px solid var(--ink)}.builder-picking .builder-slide-more{display:none}
.builder-pick-gap{position:absolute;z-index:var(--z-raised);left:0;right:0;bottom:0;height:12px;padding:0;border:0;background:transparent;cursor:pointer}
.builder-pick-gap.builder-pick-first{top:0;bottom:auto}
.builder-pick-gap::after{content:"";position:absolute;left:0;right:0;top:5px;height:2px;border-radius:2px;background:var(--petrol);opacity:.4}
.builder-pick-gap:is(:hover,:focus-visible,[data-over])::after{top:4px;height:4px;opacity:1}
.builder-delete-chain{display:flex;align-items:center;gap:6px;font-size:var(--t-xs);color:var(--ink-muted)}
.builder-delete-chain i{display:grid;place-items:center;min-width:34px;height:20px;padding:0 4px;border:1px solid var(--line);border-radius:4px;background:var(--ground);color:var(--ink);font-style:normal}
.builder-delete-chain .gone{border-color:var(--alert);color:var(--alert-ink);text-decoration:line-through}.builder-delete-chain .end{border-style:dashed}`;

const node = (doc, tag, text, className) => { const item = doc.createElement(tag); if (text !== undefined && text !== null) item.textContent = text; if (className) item.className = className; return item; };
// Menu reasons stay a few words (Julian, 2026-10-17: less wordy); the full sentence is the delete review's.
const SHORT = { splits: 'Splits into branches', reset: 'Ends with a reset', shared: 'Shared question', here: 'Already there', 'question-last': 'Can’t end the case', redirect: 'A branch needs it', only: 'Only slide', checkpoint: 'A reset returns here', missing: 'Gone' };
const keyOf = row => row?.querySelector(':scope > .builder-outline-target')?.dataset.outlineKey ?? '';

/** Wire the Outline and return the slide menu and delete review for the studio's own controls. */
export function attachSlideStructure(ctx) {
  const { doc, region, list, reviewHost } = ctx, view = doc.defaultView;
  const sheet = new view.CSSStyleSheet(); sheet.replaceSync(CSS); doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
  const title = beat => beat?.title || 'Untitled slide';
  const beatOf = id => ctx.document().beats?.find(item => item.id === id);
  const pathOf = id => ctx.document().decisions?.flatMap(item => item.paths ?? []).find(item => item.id === id);
  const rows = () => ctx.projection()?.rows ?? [];
  const number = id => rows().find(row => row.kind === 'stage' && row.beatId === id)?.number;
  const short = id => number(id) ?? `“${title(beatOf(id))}”`;
  const parse = key => { const [kind, a, b] = key.split(':'); return kind === 'beat' ? { beatId: a } : kind === 'path' ? { beatId: a, pathId: b } : kind === 'clarification' ? { clarificationId: a } : null; };
  const done = (next, metadata, label) => ctx.commit(next, metadata ?? ctx.metadata(), { structural: true, label });

  // ⋯ over each tile; a stage tile can be dragged. Re-applied when the Outline rebuilds its rows.
  const decorate = () => {
    for (const row of list.children) {
      const key = keyOf(row); if (!key || row.querySelector(':scope > .builder-slide-more')) continue;
      const more = node(doc, 'button', '⋯', 'builder-slide-more'); more.type = 'button'; more.dataset.menuKey = key;
      // The Outline stays one Tab stop (round 18): keyboard users open this menu with the menu key, Shift+F10 or Slide.
      more.tabIndex = -1;
      more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-label', `Options for ${row.querySelector('.builder-outline-name > span')?.textContent || 'this slide'}`);
      row.append(more);
      if (key.startsWith('beat:')) row.querySelector(':scope > .builder-outline-target').draggable = true;
    }
  };
  new view.MutationObserver(() => { decorate(); if (pick && !list.querySelector('.builder-pick-can, .builder-pick-gap')) endPick(); }).observe(list, { childList: true });
  decorate();

  // Opening the menu: right-click, the menu key or Shift+F10 on a row, ⋯, or a long press on a touch screen.
  const rowKey = target => keyOf(target?.closest?.('.builder-outline-list > li'));
  region.addEventListener('contextmenu', event => { const key = rowKey(event.target); if (!key || pick) return; event.preventDefault(); openMenu(key, { x: event.clientX, y: event.clientY }); });
  region.addEventListener('keydown', event => {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
    const key = rowKey(event.target); if (!key || pick) return; event.preventDefault();
    const box = event.target.getBoundingClientRect(); openMenu(key, { x: box.left + 24, y: box.bottom, back: event.target });
  });
  region.addEventListener('click', event => { const more = event.target.closest?.('.builder-slide-more'); if (!more) return; const box = more.getBoundingClientRect(); openMenu(more.dataset.menuKey, { x: box.left, y: box.bottom + 4, back: more }); });
  let press = null;
  region.addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse' || pick) return; const key = rowKey(event.target); if (!key) return;
    const at = [event.clientX, event.clientY]; clearTimeout(press?.timer);
    press = { at, timer: view.setTimeout(() => openMenu(key, { x: at[0], y: at[1] }), 550) };
  });
  const cancelPress = event => { if (press && (event.type !== 'pointermove' || Math.hypot(event.clientX - press.at[0], event.clientY - press.at[1]) > 10)) { clearTimeout(press.timer); press = null; } };
  for (const type of ['pointerup', 'pointercancel', 'pointermove']) region.addEventListener(type, cancelPress);

  // Dragging a stage tile shows the gaps it can land in; dropping in one moves it, as Move to… does.
  region.addEventListener('dragstart', event => {
    const key = rowKey(event.target); if (!key.startsWith('beat:')) return;
    event.dataTransfer.setData('application/x-case-slide', key); event.dataTransfer.effectAllowed = 'move';
    view.requestAnimationFrame(() => startPick('move', parse(key), true));
  });
  region.addEventListener('dragend', () => { if (pick?.drag) endPick(); });

  // ── The slide menu.
  let menu = null;
  const closeMenu = (focus = true) => {
    if (!menu) return; const { box, back } = menu; menu = null; box.remove();
    region.querySelector('.builder-slide-more[aria-expanded="true"]')?.setAttribute('aria-expanded', 'false');
    view.removeEventListener('pointerdown', outside, true); doc.removeEventListener('keydown', keys, true);
    if (focus && back?.isConnected) back.focus();
  };
  const outside = event => { if (menu && !menu.box.contains(event.target)) closeMenu(false); };
  const keys = event => {
    if (!menu) return; const items = [...menu.box.querySelectorAll('button:not(:disabled)')], at = items.indexOf(doc.activeElement);
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(); }
    else if (event.key === 'Tab') closeMenu(false);
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault();
      items[{ ArrowDown: (at + 1) % items.length, ArrowUp: (at - 1 + items.length) % items.length, Home: 0, End: items.length - 1 }[event.key]]?.focus(); }
  };
  function openMenu(key, { x, y, back = null }) {
    closeMenu(false); const target = parse(key); if (!target) return;
    // The menu acts on the row it was opened from, which becomes the selection.
    ctx.select(target.beatId ?? ctx.selection().beatId, target.pathId ?? null, target.clarificationId ?? null);
    const box = node(doc, 'div', undefined, 'builder-slide-menu'); box.setAttribute('role', 'menu'); box.setAttribute('aria-label', 'Slide options');
    const item = (label, refusal, run, className) => {
      const entry = node(doc, 'button', undefined, className); entry.type = 'button'; entry.setAttribute('role', 'menuitem'); entry.append(node(doc, 'span', label));
      if (refusal) { entry.disabled = true; entry.append(node(doc, 'small', refusal)); entry.setAttribute('aria-description', refusal); }
      else entry.addEventListener('click', () => { closeMenu(false); run(); });
      return entry;
    };
    box.append(...menuItems(target, item));
    doc.body.append(box);
    const width = box.offsetWidth, height = box.offsetHeight;
    box.style.left = `${Math.max(8, Math.min(x, view.innerWidth - width - 8))}px`; box.style.top = `${Math.max(8, Math.min(y, view.innerHeight - height - 8))}px`;
    const more = region.querySelector(`.builder-slide-more[data-menu-key="${CSS_escape(key)}"]`); more?.setAttribute('aria-expanded', 'true');
    menu = { box, back: back ?? more ?? region.querySelector(`[data-outline-key="${CSS_escape(key)}"]`) };
    view.addEventListener('pointerdown', outside, true); doc.addEventListener('keydown', keys, true);
    box.querySelector('button:not(:disabled)')?.focus();
  }
  const CSS_escape = value => view.CSS?.escape ? view.CSS.escape(value) : value.replace(/["\\]/g, '\\$&');
  const rule = () => node(doc, 'hr');

  function menuItems(target, item) {
    const document = ctx.document();
    if (target.clarificationId) {
      const card = document.clarifications?.find(entry => entry.id === target.clarificationId);
      return [item('Delete clarification', card ? null : 'Gone', () => ctx.removeClarification(card), 'builder-danger')];
    }
    const beat = beatOf(target.beatId); if (!beat) return [item('Gone', 'Gone', () => {})];
    if (target.pathId) {
      const path = pathOf(target.pathId), ends = path?.terminal ? 'Ends with a reset' : null;
      return [item('Add slide after', ends, () => ctx.addStage({ beatId: beat.id, pathId: path.id })),
        item('Add question after', ends, () => ctx.addQuestion({ beatId: beat.id, pathId: path.id })), rule(),
        item('Goes to…', ends, () => startPick('go', target))];
    }
    const exit = slideExit(document, beat.id), paths = document.decisions?.find(entry => entry.id === beat.decision_id)?.paths ?? [];
    // After a question, a new slide follows its one branch; with several branches, the author picks the branch.
    const after = beat.kind !== 'decision' ? { beatId: beat.id } : paths.length === 1 && !paths[0].terminal ? { beatId: beat.id, pathId: paths[0].id } : null;
    const branchFirst = after ? null : 'Use a branch’s ⋯';
    const [up, down] = neighbours(beat.id);
    const why = plan => plan?.ok ? null : SHORT[plan?.code] ?? 'Not here';
    const upPlan = up && planSlideMove(document, beat.id, up), downPlan = down && planSlideMove(document, beat.id, down);
    return [
      item('Add slide after', branchFirst, () => ctx.addStage(after)),
      item('Add question after', branchFirst, () => ctx.addQuestion(after)),
      item('Duplicate', beat.kind === 'decision' ? 'Not for questions yet' : null, () => duplicate(beat)), rule(),
      item('Move up', up ? why(upPlan) : 'First', () => moved(upPlan, 'Moved up.')),
      item('Move down', down ? why(downPlan) : 'Last', () => moved(downPlan, 'Moved down.')),
      item('Move to…', exit.ok ? null : SHORT[exit.code], () => startPick('move', target)),
      item(exit.ok ? 'Goes to…' : 'Branches go to…', null, () => exit.ok && beat.kind !== 'decision' ? startPick('go', target) : exit.ok ? startPick('go', { beatId: beat.id, pathId: paths[0].id })
        : ctx.setStatus('Open a branch’s ⋯ under this question to change where it goes.')), rule(),
      item('Delete', null, () => reviewRemoval(beat.id), 'builder-danger'),
    ];
  }
  /** The places one step up and one step down the slide's own sequence in the Outline (main line or one branch). */
  function neighbours(beatId) {
    const all = rows(), at = all.findIndex(row => row.kind === 'stage' && row.beatId === beatId); if (at < 0) return [null, null];
    const group = JSON.stringify(all[at].owners), same = all.filter(row => row.kind === 'stage' && JSON.stringify(row.owners) === group), index = same.findIndex(row => row.beatId === beatId);
    let up = null;
    if (index >= 2) up = { beatId: same[index - 2].beatId };
    else if (index === 1) { const links = incomingLinks(ctx.document(), same[0].beatId).filter(link => link.kind !== 'checkpoint');
      if (links.length === 1) up = links[0].kind === 'start' ? { start: true } : links[0].kind === 'path' ? { pathId: links[0].pathId } : { beatId: links[0].beatId }; }
    return [up, index < same.length - 1 ? { beatId: same[index + 1].beatId } : null];
  }
  function moved(plan, label) { if (plan?.ok && done(plan.document, null, `${label} ${plan.changes[0]} Undo puts it back.`)) return true; if (plan && !plan.ok) ctx.setStatus(`Not moved. ${plan.reason}`); return false; }
  function duplicate(beat) {
    const copy = duplicateStage(ctx.document(), ctx.metadata(), beat.id, ctx.createId, { insert: true });
    if (!copy.ok) { ctx.setStatus(`Not copied. ${copy.reason}`); return; }
    if (done(copy.document, copy.metadata, 'Slide duplicated after the original. Its copied source traces need review.')) ctx.select(copy.beatId);
  }

  // ── Picking on the strip: “Goes to…” lights every slide (and End); “Move to…” lights every gap the slide can land in.
  let pick = null;
  function startPick(mode, target, drag = false) {
    endPick(); const document = ctx.document(), beat = beatOf(target.beatId), path = target.pathId ? pathOf(target.pathId) : null; if (!beat) return;
    pick = { mode, target, drag, nodes: [] }; list.classList.add('builder-picking');
    const current = path ? path.next_beat_id ?? null : beat.next_beat_id ?? null;
    if (!drag) {
      const bar = node(doc, 'div', undefined, 'builder-pick-bar'); bar.setAttribute('role', 'status');
      bar.append(node(doc, 'b', mode === 'go' ? `“${path ? path.label || 'Untitled branch' : title(beat)}” goes to…` : `Move “${title(beat)}”: choose a gap`));
      const cancel = node(doc, 'button', 'Cancel'); cancel.type = 'button'; cancel.addEventListener('click', () => { endPick(); ctx.setStatus('Not changed.'); }); bar.append(cancel);
      region.insertBefore(bar, list.parentElement); pick.nodes.push(bar);
    }
    let first = true;
    for (const row of list.children) {
      const key = keyOf(row), at = key && parse(key); if (!at || row.hidden) continue;
      if (mode === 'go') {
        if (!key.startsWith('beat:') || at.beatId === beat.id) continue;
        row.classList.add('builder-pick-can'); if (at.beatId === current) row.classList.add('builder-pick-now');
        continue;
      }
      if (first && key.startsWith('beat:')) { gap(row, { start: true }, 'the start', true); first = false; }
      if (key.startsWith('beat:') && at.beatId !== beat.id) gap(row, { beatId: at.beatId }, `“${title(beatOf(at.beatId))}”`);
      else if (key.startsWith('path:')) gap(row, { pathId: at.pathId }, `branch “${pathOf(at.pathId)?.label || 'Untitled branch'}”`);
    }
    if (mode === 'go' && !path) { // a branch must lead somewhere; a slide may end the case
      const end = node(doc, 'li', undefined, 'builder-pick-can' + (current ? '' : ' builder-pick-now')), button = node(doc, 'button', 'End of case', 'builder-outline-target');
      button.type = 'button'; button.dataset.pickEnd = 'true'; end.append(button); list.append(end); pick.nodes.push(end);
    }
    pick.choose = to => {
      const plan = path ? branchTo(path.id, to) : connectStage(ctx.document(), beat.id, to);
      endPick();
      if (!plan.ok) { ctx.setStatus(`Not changed. ${plan.reason}`); return; }
      if (done(plan.document, null, `${plan.changes.join(' ')} Undo puts it back.`) && path) ctx.select(beat.id, path.id);
    };
    region.addEventListener('click', choose, true);
    doc.addEventListener('keydown', escape, true);
    (pick.nodes.find(item => item.matches?.('.builder-pick-bar')) ?? list.querySelector('.builder-pick-gap, .builder-pick-can > .builder-outline-target'))?.focus?.({ preventScroll: true });
    // Keep the author's place: the slide being placed stays in view, not the top of the strip.
    list.querySelector(`[data-outline-key="beat:${CSS_escape(beat.id)}"]`)?.scrollIntoView?.({ block: 'center' });
  }
  function gap(row, anchor, words, first = false) {
    const plan = planSlideMove(ctx.document(), pick.target.beatId, anchor); if (!plan.ok) return;
    const button = node(doc, 'button', undefined, `builder-pick-gap${first ? ' builder-pick-first' : ''}`); button.type = 'button';
    button.setAttribute('aria-label', `Put “${title(beatOf(pick.target.beatId))}” ${first ? 'at the start' : `after ${words}`}`);
    const run = () => { const latest = planSlideMove(ctx.document(), pick.target.beatId, anchor); endPick(); moved(latest, 'Moved.'); };
    button.addEventListener('click', run);
    button.addEventListener('dragover', event => { event.preventDefault(); button.dataset.over = ''; });
    button.addEventListener('dragleave', () => { delete button.dataset.over; });
    button.addEventListener('drop', event => { event.preventDefault(); run(); });
    row.append(button); pick.nodes.push(button);
  }
  function branchTo(pathId, to) {
    const path = pathOf(pathId); if (!to) return { ok: false, reason: 'A branch goes on to a slide.' };
    if ((path.next_beat_id ?? null) === to) return { ok: false, reason: 'It already goes there.' };
    const next = structuredClone(ctx.document()); next.decisions.flatMap(item => item.paths ?? []).find(item => item.id === pathId).next_beat_id = to;
    return { ok: true, document: next, changes: [`Branch “${path.label || 'Untitled branch'}” now goes to “${title(beatOf(to))}”.`] };
  }
  function choose(event) {
    if (!pick || pick.mode !== 'go') return; const end = event.target.closest?.('[data-pick-end]'), row = event.target.closest?.('.builder-pick-can');
    if (!end && !row) { if (event.target.closest?.('.builder-outline-list')) { event.preventDefault(); event.stopPropagation(); } return; }
    event.preventDefault(); event.stopPropagation(); pick.choose(end ? null : parse(keyOf(row)).beatId);
  }
  function escape(event) { if (pick && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); endPick(); ctx.setStatus('Not changed.'); } }
  function endPick() {
    if (!pick) return; const was = pick; pick = null;
    for (const item of was.nodes) item.remove();
    list.classList.remove('builder-picking'); for (const row of list.querySelectorAll('.builder-pick-can, .builder-pick-now')) row.classList.remove('builder-pick-can', 'builder-pick-now');
    region.removeEventListener('click', choose, true); doc.removeEventListener('keydown', escape, true);
  }

  // ── Delete: say what joins up, take the slide, what only it shows and the source traces on that, in one change.
  function reviewRemoval(beatId) {
    endPick(); const document = ctx.document(), beat = beatOf(beatId); if (!beat) return;
    const heal = healSlideRemoval(document, beatId);
    const panel = node(doc, 'section', undefined, 'builder-confirm-change'); panel.setAttribute('role', 'group'); panel.setAttribute('aria-label', 'Delete slide'); panel.tabIndex = -1;
    panel.append(node(doc, 'h4', `Delete “${title(beat)}”?`));
    const cancel = node(doc, 'button', 'Cancel', 'builder-btn'); cancel.type = 'button'; cancel.addEventListener('click', () => { panel.remove(); ctx.notChanged(); });
    if (!heal.ok) {
      panel.append(node(doc, 'p', heal.reason));
      const fix = heal.code === 'redirect' || heal.code === 'checkpoint' ? ['Choose where it goes', () => startPick('go', { beatId: ownerOf(heal.pathId), pathId: heal.pathId })]
        : heal.code === 'splits' ? ['Show its branches', () => ctx.select(beatId)] : null;
      if (fix) { const button = node(doc, 'button', fix[0], 'builder-btn builder-confirm'); button.type = 'button'; button.addEventListener('click', () => { panel.remove(); fix[1](); }); panel.append(button); }
      panel.append(cancel); reviewHost.replaceChildren(panel); panel.focus(); return;
    }
    const plan = removal(document, beatId, heal);
    const chain = node(doc, 'p', undefined, 'builder-delete-chain'); chain.setAttribute('aria-hidden', 'true');
    const from = heal.from.map(link => link.kind === 'start' ? 'Start' : link.kind === 'stage' ? short(link.beatId) : '⑂').join(', ') || '—';
    const box = (text, className) => node(doc, 'i', String(text), className);
    chain.append(box(from), '→', box(number(beatId) ?? '·', 'gone'), '→', box(heal.after ? short(heal.after) : 'End', heal.after ? undefined : 'end'));
    const notes = plan.traces.length ? ` ${plan.traces.length} source ${plan.traces.length === 1 ? 'trace goes' : 'traces go'} too.` : '';
    panel.append(chain, node(doc, 'p', `${heal.changes.join(' ') || 'Nothing else changes.'}${notes} Undo brings it all back.`));
    const go = node(doc, 'button', 'Delete', 'builder-btn builder-danger'); go.type = 'button';
    go.addEventListener('click', () => {
      // Confirm re-plans against the latest draft and refuses if it would now do something different.
      const latestHeal = healSlideRemoval(ctx.document(), beatId), latest = latestHeal.ok && removal(ctx.document(), beatId, latestHeal);
      panel.remove();
      if (!latest || JSON.stringify(latestHeal.changes) !== JSON.stringify(heal.changes) || latest.traces.length !== plan.traces.length) { ctx.setStatus('Not deleted. The draft changed since this review. Review it again.'); return; }
      const was = ctx.selection(), next = heal.after ?? (heal.from.find(link => link.kind === 'stage')?.beatId) ?? latest.document.start_beat_id;
      ctx.select(next ?? null);
      if (!done(latest.document, latest.metadata, `Slide deleted. ${latestHeal.changes.join(' ')} Undo brings it back.`.replace('  ', ' '))) ctx.select(was.beatId, was.pathId, was.clarificationId);
    });
    panel.append(go, cancel); reviewHost.replaceChildren(panel); go.focus();
  }
  const ownerOf = pathId => ctx.document().beats?.find(beat => ctx.document().decisions?.find(item => item.id === beat.decision_id)?.paths?.some(path => path.id === pathId))?.id;
  /** The healed draft without the slide, its question and what only they show; the traces on any of it are dropped. */
  function removal(document, beatId, heal) {
    const beat = beatOf(beatId), decision = document.decisions?.find(item => item.id === beat.decision_id);
    const next = heal.document; next.beats = next.beats.filter(item => item.id !== beatId);
    if (decision) next.decisions = next.decisions.filter(item => item.id !== decision.id);
    const gone = new Set([beatId, beat.surface_id, decision?.id, ...(decision?.paths ?? []).map(path => path.id), ...(decision?.interaction?.options ?? []).map(option => option.id),
      ...(document.clarifications ?? []).filter(card => !next.clarifications?.some(item => item.id === card.id)).map(card => card.id)].filter(Boolean));
    ctx.dropOrphaned(next);
    const traces = [...new Set([...(ctx.metadata().provenance ?? []).flatMap((entry, index) => gone.has(entry?.entity_id) ? [index] : []), ...ctx.removalTraces(next)])];
    const metadata = structuredClone(ctx.metadata()); if (traces.length) metadata.provenance = metadata.provenance.filter((entry, index) => !traces.includes(index));
    return { document: next, metadata, traces };
  }

  return { openMenu, reviewRemoval, decorate };
}
