// Device-local control descriptions; the authority's action list is the only permission source.
import { presentationNav } from './presentation-nav.mjs';
import { summaryPages } from '../shared/debrief-pages.mjs';

export function primaryAction(view, {pickedPathId=null, now=Date.now(), armedUntil=0}={}) {
  const actions=new Set(view?.actions ?? []);
  if (actions.has('start')) return {command:'start',label:'Start case'};
  if (actions.has('lock')) return {command:'lock',label:'Lock responses & review'};
  // CASE-319: during the closing window the dock locks at once. Its first 600 ms stay disabled, so a double tap on Lock
  // cannot skip the window that saves what people were typing.
  if (actions.has('finalise_lock')) {
    const closing=view.round?.closing, opened=Date.parse(closing?.openedAt ?? '');
    if (Number.isFinite(opened) && now - opened < 600) return {disabled:true,label:'Locking…'};
    return {command:'finalise_lock',label:'Lock now',note:closing?.auto ? 'Everyone has answered · locking in a few seconds' : 'Phones are sending their answers'};
  }
  if (actions.has('advance') && view.presentation?.nextGroup)
    return {command:'advance',label:presentationNav(view).nextActionLabel};
  if (actions.has('return_clarification')) return {command:'return_clarification',payload:{occurrenceId:view.clarification.occurrenceId,expectRevision:view.revision},label:'Return to decision'};
  if (actions.has('reveal_path')) {
    // Card 61: an ordinary question's one Continue (CASE-280) goes on to the next slide; there is no route to choose.
    const direct=view.decision?.directContinue===true,path=view.decision?.paths?.find(p=>p.id===(direct?view.decision.paths[0].id:view.selectedPathId ?? pickedPathId) && !p.explored);
    return path ? {command:'reveal_path',payload:{pathId:path.id,expectRevision:view.revision},label:`${direct?'Continue to':'Reveal:'} ${path.revealPreview ?? path.label}`,pathId:path.id,...direct&&{direct}}
      : {local:'focus_resolution',label:'Choose a path'};
  }
  if (actions.has('select_path')) {
    const path=view.decision?.paths?.find(p=>p.id===pickedPathId && !p.explored);
    return path ? {command:'select_path',payload:{pathId:path.id},label:'Select this path'} : {local:'focus_resolution',label:'Select path'};
  }
  if (actions.has('reveal')) {
    if (armedUntil>now) return {command:'reveal',label:'Show to participants?',armed:true};
    const path=view.decision?.paths?.find(p=>p.id===view.selectedPathId);
    return {local:'arm_reveal',label:`Reveal: ${path?.revealPreview ?? ''}`,armed:false};
  }
  if (actions.has('confirm_recovery') && view.recovery?.confirmed === false) return {command:'confirm_recovery',payload:{occurrenceId:view.recovery.occurrenceId,confirmed:true,expectRevision:view.revision},label:'Confirm recovery action'};
  if (actions.has('reset_checkpoint')) return {command:'reset_checkpoint',label:`Reset to ${view.terminal?.checkpointBeat?.title ?? 'checkpoint'}`};
  if (actions.has('resume')) return {command:'resume',label:view.resumePhase==='responses_open' ? 'Resume · responses open' : view.resumePhase==='responses_locked' ? 'Resume · reviewing' : 'Resume discussion'};
  if (actions.has('advance')) return {command:'advance',label:presentationNav(view).nextActionLabel};
  return null;
}

/**
 * The dock's one control (card 37). Never blank in a live phase: the primary action; else, while a closed
 * chart blocks publication (CASE-143), the explicit Hide as its own press (never fused with the reveal, which
 * keeps its two steps); while the lobby screen is up (CASE-176), Return to case; else a disabled reason.
 * It only ever offers a command the authority's action list carries.
 */
export function dockControl(view, local = {}) {
  if (!view || view.phase === 'ended') return null;
  if (local.pending) return {disabled:true,label:'Upload pending'};
  // Console layout v2: in Debrief the one control steps the review; End case sits beside it, Back to the case in Undo.
  if (view.phase === 'debrief') return {...(debriefNext(view) ?? {disabled:true,label:'Nothing shown yet'}),debrief:true,note:'The projector follows'};
  const actions=new Set(view.actions ?? []);
  if (view.display?.lobby === true && !actions.has('reveal_path') && actions.has('show_lobby')) return {command:'show_lobby',payload:{on:false},label:'Return to case'};
  const primary=primaryAction(view, local);
  if (primary) return primary;
  // The case is complete: Debrief, with the press-again confirm (Back to the case undoes it).
  if (actions.has('debrief') && !view.nextBeat && view.phase !== 'discussion_paused')
    return local.debriefArmed ? {local:'debrief',label:'Press again: Debrief',armed:true} : {local:'debrief',label:'Debrief'};
  if (actions.has('show_results') && view.resultsShown !== false)
    return {command:'show_results',payload:{on:false},label:'Hide responses on projector',note:'Hide the responses to continue'};
  return {disabled:true,label:view.nextBeat || view.phase === 'discussion_paused' ? 'No session action available now'
    : 'Case complete · End case is in the side rail'};
}

/**
 * Where the Debrief review's Next goes (CASE-327, Julian 2026-11-01): the summary (its second page when it has one), then each
 * question with its result on the projector (a free-text question, which has no result page, replays its slide), then Back
 * to the summary. From a replayed slide, Next is the first question asked after it; with no decided question, Next walks the
 * slides. Each step is a command the room already
 * accepts in Debrief: debrief_page or replay.
 */
export const debriefQuestionStep = (q) => (Number.isSafeInteger(q?.resultPage) ? {command:'debrief_page',payload:{page:q.resultPage}}
  : Number.isSafeInteger(q?.entryIndex) ? {command:'replay',payload:{entryIndex:q.entryIndex}} : null);
export function debriefNext(view) {
  const d = view?.debrief;
  if (!d) return null;
  const cursor = view.display?.cursor, first = summaryPages(d.public ?? {}), page = d.public?.page ?? d.page ?? 0;
  const questions = (d.questions ?? []).filter((q) => debriefQuestionStep(q));
  const step = (q) => ({...debriefQuestionStep(q),label:`Next: Question ${q.no}`});
  const summary = {command:'debrief_page',payload:{page:0},label:'Back to the summary'};
  if (!Number.isSafeInteger(cursor) && page < first - 1) return {command:'debrief_page',payload:{page:page + 1},label:'Next: the summary, part 2'};
  // A Debrief before any question was decided has only slides: Next walks them, then back to the summary.
  if (!questions.length) {
    const rows = Array.isArray(view.publicTimeline) ? view.publicTimeline : [];
    const slide = (i) => ({command:'replay',payload:{entryIndex:i},label:`Next: ${rows[i]?.surface?.title ?? `Slide ${i + 1}`}`});
    if (Number.isSafeInteger(cursor)) return cursor + 1 < rows.length ? slide(cursor + 1) : summary;
    return rows.length ? slide(0) : null;
  }
  // Where the room is now: a question (its result page or its replayed slide), a slide between questions, or the summary.
  const at = Number.isSafeInteger(cursor) ? questions.findIndex((q) => q.entryIndex === cursor && !Number.isSafeInteger(q.resultPage))
    : questions.findIndex((q) => q.resultPage === page);
  // A question's slide replayed from the strip goes on to its own result.
  const here = Number.isSafeInteger(cursor) ? questions.find((q) => q.entryIndex === cursor && Number.isSafeInteger(q.resultPage)) : null;
  if (here) return {...debriefQuestionStep(here),label:`Next: Question ${here.no} results`};
  const next = at >= 0 ? questions[at + 1] : Number.isSafeInteger(cursor) ? questions.find((q) => Number.isSafeInteger(q.entryIndex) && q.entryIndex > cursor)
    : page < first ? questions[0] : undefined;
  return next ? step(next) : questions.length ? summary : null;
}

/** Debrief's Back and Forward (the strip and ← →): slide by slide; Back from the first slide is the summary. */
export function debriefSteps(view) {
  const rows = view?.publicTimeline?.length ?? 0, cursor = view?.display?.cursor, at = Number.isSafeInteger(cursor) ? cursor : null;
  const slide = (i) => ({command:'replay',payload:{entryIndex:i}});
  return { at, back: at === null ? null : at > 0 ? slide(at - 1) : {command:'debrief_page',payload:{page:0}},
    forward: at === null ? (rows ? slide(0) : null) : at + 1 < rows ? slide(at + 1) : null };
}

/** CASE-249: a route reveal while armed (a first press within 3 s) reads "Show to participants?"; the next press reveals.
 * An ordinary question's Continue (card 61) reveals no outcome, so it is one press, like Next. */
export const armsFirst = control => control?.command === 'reveal_path' && control.direct !== true;
export const armedRoute = (control, armedUntil, now = Date.now()) => armsFirst(control) && armedUntil > now ? { ...control, label: 'Show to participants?', armed: true } : control;

/** Plain-text status for a refused facilitator command (rendered with textContent, never as HTML). */
export function refusedCommandNotice(reason, receipt) {
  if (receipt === 'timeout') return 'No confirmation from the session. Check the case before continuing.';
  if (reason === 'hide_responses_first') return 'Hide the responses on the projector first.';
  if (reason === 'recovery_required') return 'Confirm the recovery action before continuing.';
  if (reason === 'stale_recovery_occurrence') return 'This recovery belongs to an earlier case moment. Check the current step.';
  if (reason === 'lobby_shown') return 'Return to the case on the projector first.';
  if (reason === 'no_change') return ''; // a stale lobby toggle: the resync shows the actual state
  if (reason === 'stale_revision') return 'The session changed. Refreshing its state.';
  if (reason === 'rate_limited') return 'Too many actions at once — try again in a moment.';
  return 'The session could not apply that action.';
}
