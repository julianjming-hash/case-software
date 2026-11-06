// Curated event-cue configuration, independent of public-state and playback lifecycle. Room music no longer lives here:
// it plays the approved round8 library from public room state (CASE-334; room-audio-state.mjs, room-music.mjs).
export const ROOM_EFFECTS = Object.freeze({
  decision_open: Object.freeze({ semantic: 'material-revealed', source: 'material-revealed', gain: 1 }),
  reveal: Object.freeze({ semantic: 'reveal-soft', source: 'material-revealed', gain: .5 }),
});
