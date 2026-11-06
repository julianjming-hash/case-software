// Read-only presentation decisions from the facilitator projection; never compute a vote outcome.
const HEADINGS={lobby:'Lobby',surface_live:'Live surface',responses_open:'Team decision open',responses_locked:'Responses locked',path_selected:'Path chosen · not yet shown to participants',consequence_revealed:'Consequence shown',terminal_teaching:'Teaching point',discussion_paused:'Discussion pause',debrief:'Debrief',ended:'Session ended'};
export function phaseModel(view) {
  const reviewing=['responses_locked','path_selected'].includes(view.phase);
  const open=view.phase==='responses_open';
  return {
    heading:HEADINGS[view.phase] ?? '',
    count:open ? view.namesShown ? 'Names are shown on the projector · the live count is hidden' : `Round ${view.round.no} · ${view.round.responseCount} of ${view.round.participantCount} responded` : null,
    reopened:open && view.round.no>1 ? `Reopened as round ${view.round.no} · earlier answers are kept privately` : null,
    aggregate:reviewing ? view.round?.aggregate ?? null : null,
    suggestion:reviewing ? view.round?.suggestion ?? null : null,
  };
}
