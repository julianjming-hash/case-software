import { el, button } from './native-dom.mjs';
export { el, button } from './native-dom.mjs';
import { primaryAction } from './console-actions.mjs';
import { CHORD } from './keymap.mjs';
import { renderRankedControls } from './console-ranking.mjs';
// Shared native teaching controls. Commands and live state are supplied by the caller.
import { markFor, markSvg } from './projector-marks.mjs';
import { consolePublicSurface, presentationNav } from './presentation-nav.mjs';
import { paragraphsText } from '../shared/slide-text.mjs';
import { consoleRankingRows } from './console-ranking.mjs';
import { gasLines } from '../shared/slide-gas-view.mjs';
const CLASSIFICATION = Object.freeze({
  sound: '● Sound', defensible: '◯ Defensible',
  'context-dependent': '⑂ Context-dependent', unsafe: '▲ Unsafe · recoverable',
  'terminal-unsafe': '⬣ Terminal · needs a checkpoint reset',
  'discussion-prompt': '▤ Discussion prompt',
});
export function section(title, className = 'console-card') {
  const item = el('section', null, className);
  item.append(el('h2', title));
  return item;
}
function addTextList(parent, items, className = '') {
  if (!items?.length) return;
  const list = el('ul', null, className);
  for (const text of items) list.append(el('li', text));
  parent.append(list);
}

const OPTION_PHASES = ['responses_open', 'responses_locked', 'path_selected'];
/** One option tile; `tail` is a numbers-only suffix (count and share, or rank counts). */
function optionTile(option, index, tail = '') {
  const tile = el('div', null, `opt-tile console-option${option.disabled || option.explored ? ' locked' : ''}`);
  tile.style.setProperty('--mk', markFor(index).fill);
  tile.append(markSvg(index, { size: 36, decorative: true }), el('span', `${markFor(index).name}: `, 'sr-only'), el('span', option.label, 'lbl'));
  if (tail) { const count = document.createElement('span'); count.className = 'console-option-count'; count.textContent = tail; tile.append(count); }
  if (option.explored) tile.append(el('span', 'Explored', 'tag'));
  else if (option.disabled) tile.append(el('span', 'Not available', 'tag'));
  return tile;
}
const routeLine = path => `${path.label} · ${CLASSIFICATION[path.classification] ?? '◇ Authored path'}${path.recommended ? ' · Recommended' : ''}`;
function routeCallout(paths) {
  if (!paths.length) return null;
  const callout = el('div', null, 'console-private console-callout');
  callout.append(el('p', 'Only you', 'eyebrow'));
  for (const path of paths) {
    callout.append(el('p', routeLine(path), 'console-callout-route'));
    if (path.rationale) callout.append(el('p', path.rationale));
  }
  return callout;
}
export function renderOptions(view) {
  const from = view.phase === 'discussion_paused' ? view.resumePhase : view.phase;
  const options = view.decision?.interaction?.options ?? [];
  if (!options.length || !OPTION_PHASES.includes(from)) return null;
  const card = section('Options', 'console-card console-options');
  const list = el('ol', null, 'console-option-list');
  const paths = view.decision.paths ?? [];
  options.forEach((option, index) => {
    const item = el('li');
    item.append(optionTile(option, index));
    const callout = routeCallout(paths.filter(path => path.optionIds?.includes(option.id)));
    if (callout) item.append(callout);
    list.append(item);
  });
  card.append(list);
  // A route no option maps to (an override-only or rule-chosen route) is listed once, under the tiles.
  const unmapped = routeCallout(paths.filter(path => !path.optionIds?.length));
  if (unmapped) card.append(unmapped);
  return card;
}

  const SLIDE_NAMES = { text: 'Text', list: 'List', quote: 'Quote', callout: 'Callout', values: 'Values', table: 'Table', timeline: 'Timeline', trend: 'Trend chart', image: 'Image', gas: 'Blood gas' };
  function slideLines(block) {
    if (block.paragraphs) return block.paragraphs.map(item => paragraphsText([item])).filter(Boolean);
    if (block.type === 'list') return block.items.map(item => paragraphsText([item]));
    if (block.type === 'values') return block.rows.map(row => `${row.label}: ${row.value}${row.unit ? ` ${row.unit}` : ''}`);
    if (block.type === 'timeline') return block.entries.map(entry => `${entry.label} · ${entry.text}`);
    // A trend's readings as the author typed them, one line per series (card 59 M1).
    if (block.type === 'image') return [`${block.ecg ? 'ECG' : 'Image'}: ${block.alt}`, ...(block.caption ? [block.caption] : [])];
    // A blood gas as the room reads it: the rows with a value, flags and ranges included (CASE-311).
    if (block.type === 'gas') return gasLines(block);
    if (block.type === 'trend') return [...(block.caption ? [block.caption] : []), ...block.series.map(series => `${series.label}${block.y_unit ? ` (${block.y_unit})` : ''}: ${block.points.map((point, index) => `${point.label} ${series.values[index] || '–'}`).join(' · ')}`)];
    if (block.type === 'table') return [...(block.caption ? [block.caption] : []), ...block.rows.map(row => row.cells.map((cell, index) =>
      `${block.header_row && block.columns[index]?.label ? `${block.columns[index].label}: ` : ''}${cell}${cell && block.columns[index]?.unit ? ` ${block.columns[index].unit}` : ''}`).join(' · '))];
    return [];
  }

  export function renderSurface(view) {
    const current = consolePublicSurface(view);
    const card = el('div', null, 'console-scene');
    if (!current) { card.append(el('p', view.phase === 'lobby' ? 'The case has not started.' : 'Waiting for the next surface.')); return card; }
    if (presentationNav(view).replaying)
      card.append(el('p', `Projector replay · ${current.title}`, 'console-replay-notice'));
    card.append(el('h3', current.title));
    // Card 57: a slide shows the room-visible blocks as text, in reading order (the projector draws the slide itself).
    if (current.slide) {
      const order = new Map(current.slide.reading_order.map((id, index) => [id, index]));
      for (const block of [...current.slide.blocks].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))) {
        const lines = slideLines(block);
        if (!lines.length) continue;
        const tile = section(SLIDE_NAMES[block.type] ?? 'Slide', 'console-tile');
        addTextList(tile, lines); card.append(tile);
      }
      return card;
    }
    if (current.scene) card.append(el('p', current.scene, 'console-scene-text'));
    for (const [title, values] of [['Findings', current.points], ['Investigations', current.investigations]]) {
      if (!values?.length) continue;
      const tile = section(title, 'console-tile');
      addTextList(tile, values); card.append(tile);
    }
    if (current.observations?.length) {
      const tile = section('Vitals', 'console-tile');
      addTextList(tile, current.observations.map(o =>
        `${o.label}: ${o.value}${o.unit ? ' ' + o.unit : ''}${o.trend ? ` ${o.trend} from ${o.previous}` : ''}`));
      card.append(tile);
    }
    return card;
  }

  export function renderAggregate(view, phase) {
    if (!phase.aggregate) return null;
    const total = phase.aggregate.total;
    if (!Number.isInteger(total) || total < 0) return null;
    const card = section(`Responses · ${total} ${total === 1 ? 'answer' : 'answers'}`,
      'console-card console-aggregate');
    if (view.decision?.interaction?.type === 'free_text') card.append(el('p',
      'Free-text responses are reviewed privately; only their total is shown here.'));
    else if (view.actions?.includes('reveal_path') && !view.decision?.directContinue && ['single_choice','multi_select'].includes(view.decision?.interaction?.type)) {
      card.append(el('p', 'Option counts appear once in the path cards below.'));
    } else if (consoleRankingRows(view.decision, phase.aggregate)) {
      const rows = consoleRankingRows(view.decision, phase.aggregate), options = view.decision.interaction.options;
      const list = el('ol', null, 'console-option-list');
      rows.forEach((line, index) => { const item = el('li'); item.append(optionTile(options[index], index, line.slice(options[index].label.length))); list.append(item); });
      card.append(list);
    } else {
      const list = el('ol', null, 'console-option-list');
      (view.decision?.interaction?.options ?? []).forEach((option, index) => {
        // The room stores only positive counters. A missing authored option is zero.
        const count = Object.hasOwn(phase.aggregate.counts ?? {}, option.id)
          ? phase.aggregate.counts[option.id] : 0;
        if (!Number.isInteger(count) || count < 0) return;
        const share = total ? Math.round(count / total * 100) : 0;
        const item = el('li'); item.append(optionTile(option, index, ` · ${count} · ${share}%`)); list.append(item);
      });
      card.append(list);
    }
    if (phase.suggestion && !view.decision?.directContinue) {
      const path = view.decision?.paths?.find(candidate => candidate.id === phase.suggestion.pathId);
      // Whole sentences, "choose" said once (CASE-251): a facilitator-interpreted decision suggests no route at all.
      card.append(el('p', path ? `Suggested by responses: ${path.label}.${phase.suggestion.reason ? ` ${phase.suggestion.reason}` : ''} You choose the path.` : 'No path is suggested: you choose an authored path.'));
    }
    return card;
  }

  export function renderRoutes(view, parent, context) {
    // Card 61: an ordinary question has no route to choose; the dock's Continue is its one action.
    if (!view.decision?.paths?.length || !view.actions?.includes('reveal_path') || view.decision.directContinue) return;
    const routes=section('Choose an authored path','console-card console-routes');
    const choices=el('div',null,'console-route-choices');choices.setAttribute('role','radiogroup');choices.setAttribute('aria-label','Authored path');
    const available=view.decision.paths.filter(path=>!path.explored);
    for(const path of view.decision.paths) {
      const row=el('div',null,'console-route');row.dataset.path=path.id;
      const selected=path.id===context.pickedPathId;
      const choose=button('',()=>{if(context.busy||context.recovery?.pending)return;if(context.routeSelection.choose(context.currentView(),path.id)){context.pickedPathId=context.routeSelection.sync(context.currentView());context.render();}},'btn console-route-pick');
      choose.setAttribute('role','radio');choose.setAttribute('aria-checked',String(selected));choose.setAttribute('aria-label',`Choose ${path.label}`);
      choose.dataset.focusKey = `route-${path.id}`;choose.tabIndex=selected||!context.pickedPathId&&path===available[0]?0:-1;
      const disabled=path.explored||Boolean(view.selectedPathId&&view.selectedPathId!==path.id);
      if(disabled)choose.setAttribute('aria-disabled','true');
      choose.onkeydown=event=>{if(!['ArrowDown','ArrowUp','ArrowRight','ArrowLeft','Home','End'].includes(event.key)||context.busy||view.selectedPathId)return;event.preventDefault();
        const at=available.findIndex(candidate=>candidate.id===path.id);const target=event.key==='Home'?0:event.key==='End'?available.length-1:(at+(['ArrowUp','ArrowLeft'].includes(event.key)?available.length-1:1))%available.length;
        if(!available[target])return;context.routeSelection.choose(context.currentView(),available[target].id);context.pickedPathId=context.routeSelection.sync(context.currentView());context.render();context.root.querySelector(`[data-focus-key="route-${available[target].id}"]`)?.focus({ preventScroll: true });};
      const indices=(view.decision.interaction?.options??[]).flatMap((option,index)=>path.optionIds?.includes(option.id)?[index]:[]);
      if(indices.length){const marks=el('span',null,'console-route-marks');marks.append(...indices.map(index=>markSvg(index,{size:28,decorative:true})));choose.append(marks);if(indices.length===1)choose.style.setProperty('--mk',markFor(indices[0]).fill);}
      // CASE-249 F: the choice is one glyph, the same on the console and the Run preview: an empty square to choose, a check
      // when chosen. An explored route says so in words. The row stays the 44 px target.
      const glyph=el('span',selected?'✓':'',`console-route-glyph${selected?' is-chosen':''}`);glyph.setAttribute('aria-hidden','true');
      choose.append(el('strong',path.label));
      if(indices.length&&view.round?.aggregate?.counts){const count=path.optionIds.reduce((total,id)=>total+(view.round.aggregate.counts[id]??0),0);const multiple=view.decision.interaction.type==='multi_select';const share=view.round.aggregate.total?Math.round(count/view.round.aggregate.total*100):0;choose.append(el('span',`${count} ${multiple?(count===1?'selection':'selections'):`${count===1?'response':'responses'} · ${share}%`}`,'console-option-count'));}
      // The glyph ends the row, so it keeps its place as the counts change (CASE-251).
      choose.append(path.explored&&!selected?el('span','Already explored','console-route-state'):glyph);
      row.append(choose,el('span',CLASSIFICATION[path.classification]??'◇ Authored path','console-classification'),el('p',`If revealed: ${path.revealPreview}`));
      if(path.rationale||path.cue){const detail=el('details',null,'console-private console-route-detail');detail.open=context.openRouteNotes.has(path.id);const summary=el('summary');summary.append(el('span','Private notes'),el('span',detail.open?'Hide':'Show','disclosure-action'));summary.setAttribute('aria-label',detail.open?'Hide private notes':'Show private notes');summary.dataset.focusKey=`route-notes-${path.id}`;summary.onclick=event=>{event.preventDefault();const control=event.currentTarget,current=control.closest('details');current.open=!current.open;control.lastElementChild.textContent=current.open?'Hide':'Show';control.setAttribute('aria-label',current.open?'Hide private notes':'Show private notes');if(current.open)context.openRouteNotes.add(path.id);else context.openRouteNotes.delete(path.id);};detail.append(summary);if(path.rationale)detail.append(el('p',path.rationale));if(path.cue)detail.append(el('p',path.cue.startsWith('Ask:')?path.cue:`Ask: ${path.cue}`));row.append(detail);}
      choices.append(row);
    }
    routes.append(choices);
    if(view.selectedPathId)routes.append(el('p','This route is confirmed. Undo the selection to choose another.'));
    parent.append(routes);
  }


// CASE-255: the room-sound switch, the quiet affordance that outlives Pause for discussion. It has the dock's own slot
// (beside the main action, opposite Undo), never the round's controls, so the main action never moves for it.
// The projector's Room sound glyph (projector-sound.mjs), drawn without importing its audio module.
const SOUND_GLYPH = { on: 'M4 9v6h4l5 4V5L8 9zM16.5 9a4 4 0 0 1 0 6', off: 'M4 9v6h4l5 4V5L8 9zM17 9l4 6M21 9l-4 6' };
function roomSoundSwitch({ on, onToggle, title = '' }) {
 const sound=button('',onToggle,'btn tertiary console-room-sound');sound.dataset.focusKey='room-sound';
 sound.setAttribute('aria-pressed',String(on));if(title)sound.title=title;
 const ns='http://www.w3.org/2000/svg',glyph=document.createElementNS(ns,'svg'),path=document.createElementNS(ns,'path');
 glyph.setAttribute('viewBox','0 0 24 24');glyph.setAttribute('class','ic');glyph.setAttribute('aria-hidden','true');path.setAttribute('d',SOUND_GLYPH[on?'on':'off']);glyph.append(path);
 sound.append(glyph,el('span','Session sound','console-room-sound-label'));return sound;
}

// `omitUnavailable` (the Run preview, CASE-249 R7) leaves an Undo with nothing to undo undrawn; the console keeps it.
export function renderTeachingDock(view,control,{onPrimary,onUndo,onCommand,currentView=()=>view,routeSelection,busy=false,pending=false,feedback:statusText='',omitUnavailable=false,roomSound=null,undoControl=null,beside=null}={}){
 const dock=el('div',null,'console-action-dock');if(!control)return dock;
 const main=button(control.label,onPrimary,'btn primary console-primary');main.dataset.focusKey='primary-action';main.setAttribute('aria-keyshortcuts','Space');
 if(control.disabled||busy||pending)main.setAttribute('aria-disabled','true');if(busy)main.setAttribute('aria-busy','true');if(control.armed)main.classList.add('is-armed');
 const selected=view.decision?.paths?.find(path=>path.id===control.pathId),indices=(view.decision?.interaction?.options??[]).flatMap((option,index)=>selected?.optionIds?.includes(option.id)?[index]:[]);
 if(indices.length===1){main.prepend(markSvg(indices[0],{size:24,decorative:true}));main.style.setProperty('--mk',markFor(indices[0]).fill);main.classList.add('console-primary-route');}
 const localUndo=routeSelection.canUndo(view),authorityUndo=view.undo?.available&&view.actions?.includes('undo');
 // Console layout v2: Debrief puts Back to the case in the Undo slot and End case beside the main action.
 const undo=undoControl??button(localUndo?'Undo route choice':authorityUndo?`Undo ${view.undo.kind}`:'Undo unavailable',onUndo,'btn destructive console-undo');
 if(!undoControl){undo.dataset.focusKey='teaching-undo';undo.setAttribute('aria-keyshortcuts',CHORD.undo);if(!localUndo&&!authorityUndo||busy||pending)undo.setAttribute('aria-disabled','true');}
 if(omitUnavailable&&!undoControl&&!localUndo&&!authorityUndo)dock.append(main);else dock.append(undo,main);if(beside)dock.append(beside);
 // CASE-249 G: every other dock control sits in its own row above Undo and the main action, so neither moves when one
 // appears or goes.
 const extra=el('div',null,'console-dock-extra');dock.append(extra);
 if(roomSound)dock.append(roomSoundSwitch(roomSound));
 if (typeof onCommand==='function') {
  const send=(type,payload)=>{if(busy||pending)return;const fresh=currentView();if(!fresh?.actions?.includes(type))return;onCommand(type,{...payload,expectRevision:fresh.revision});};
  if(view.actions?.includes('show_clarification'))for(const card of view.clarifications??[]){
   const show=button(`${card.shared?'Share again':'Share'} ${card.label}`,()=>send('show_clarification',{clarificationId:card.id}),'btn');
   show.dataset.focusKey=`clarification-${card.id}`;if(busy||pending)show.setAttribute('aria-disabled','true');extra.append(show);
  }
  if(view.recovery?.confirmed&&view.actions?.includes('confirm_recovery')){
   const correct=button('Correct recovery confirmation',()=>{const fresh=currentView();if(fresh?.recovery?.confirmed)send('confirm_recovery',{occurrenceId:fresh.recovery.occurrenceId,confirmed:false});},'btn');
   correct.dataset.focusKey='correct-recovery';if(busy||pending)correct.setAttribute('aria-disabled','true');extra.append(correct);
  }
 }
 if(view.recovery&&!view.recovery.confirmed)extra.append(el('div',view.recovery.prompt,'console-private'));
 const feedback = el('span', busy ? 'Sending to the room…' : statusText || control.note || '');feedback.setAttribute('role', 'status');dock.append(feedback);return dock;
}

export function renderTeachingSecondary(view,dock,context){
  const secondary = el('div', null, 'console-secondary');
      // While the lobby screen holds the dock (CASE-176), the phase's own private step stays here, in the Run view.
      const lobbyStep = view.display?.lobby === true ? primaryAction(view, { pickedPathId:context.pickedPathId, armedUntil: 0 }) : null;
      if (lobbyStep?.command && lobbyStep.command !== dock?.command) secondary.append(button(lobbyStep.label, () => context.roomCommand(lobbyStep.command, lobbyStep.payload)));
      // Every primary control lives in the dock (card 37): when the dock is the Hide, it is not repeated here.
      if (view.actions?.includes('show_results') && dock?.command !== 'show_results') secondary.append(button(
        view.resultsShown === false ? 'Show responses on projector' : 'Hide responses on projector',
        () => context.roomCommand('show_results', { on: view.resultsShown === false })));
      if (view.actions?.includes('show_results') && view.resultsShown !== false && !view.actions?.includes('reveal_path')) secondary.append(el('p',
        'Hide responses on projector before showing the next case context.'));
      if (view.actions?.includes('text_page') && view.textPresentation) {
        const { page, pages, closedRoundId } = view.textPresentation;
        const previous = button('Previous responses page', () => context.roomCommand('text_page', { closedRoundId, page: page - 1, expectRevision: view.revision }));
        const next = button('Next responses page', () => context.roomCommand('text_page', { closedRoundId, page: page + 1, expectRevision: view.revision }));
        previous.disabled = context.busy || context.recovery?.pending || page === 0;
        next.disabled = context.busy || context.recovery?.pending || page === pages - 1;
        secondary.append(el('p', `Responses page ${page + 1} of ${pages}`), previous, next);
      }
      const rankedControls = renderRankedControls(view, { el, button, send: context.roomCommand, disabled: context.busy || Boolean(context.recovery?.pending) });
      if (rankedControls) secondary.append(rankedControls);
      if (!view.rankedPresentation && view.actions?.includes('results_page')) {
        const page = view.resultsPage ?? 0, pages = view.resultsPageCount;
        const previous = button('Previous results page', () => context.roomCommand('results_page', { page: page - 1 })); previous.disabled = context.busy || context.recovery?.pending || page === 0;
        const next = button('Next results page', () => context.roomCommand('results_page', { page: page + 1 })); next.disabled = context.busy || context.recovery?.pending || page === pages - 1;
        secondary.append(el('p', `Results page ${page + 1} of ${pages}`), previous, next);
      }
      for (const [action, label, payload] of [
        ['reopen', 'Reopen as new round', {}],
        ['void_round', 'Void round', {}], ['back_to_review', 'Back to review', {}],
      ]) {
        if (!view.actions?.includes(action)) continue;
        // The console confirms Void round in place (console layout v2, Julian 2026-10-18); the Run preview asks in its window.
        if (action === 'void_round' && context.armable) {
          const run = () => { if (context.manual) { context.manual.command(action, payload); context.render(); } else void context.send(action, payload); };
          const control = secondary.appendChild(context.armable('void-round', label, 'Press again: discard answers', run, 'btn'));
          control.dataset.action = action; continue;
        }
        const control = secondary.appendChild(button(label, () => {
          // The Run preview asks in its own window (CASE-226); the console asks in its page.
          const question = 'Cancel this round? Its answers are discarded and never used.';
          if (action === 'void_round' && !(context.confirm ? context.confirm(question) : window.confirm(question))) return;
          if (context.manual) { context.manual.command(action, payload); context.render(); }
          else void context.send(action, payload);
        }));
        control.dataset.action = action;
      }

  return secondary;
}

export function renderOnlyYou(view) {
  const notes = view.liveSurface?.notes, cue = view.beat?.cue, media = view.presentation?.mediaUnavailable;
  if (!notes && !cue && !media) return null;
  const zone = el('div', null, 'console-private');
  if (notes) zone.append(el('p', 'Private notes · not shown to the room', 'eyebrow'), el('p', notes));
  if (cue) zone.append(el('p', 'Facilitator cue · not shown to the room', 'eyebrow'), el('p', cue));
  if (media) zone.append(el('p', 'This case references media that cannot be displayed in this version.'));
  return zone;
}
