// src/shared/music-catalogue.mjs: the room music's public catalogue (CASE-334): the four decision themes, their tempo profiles
// and the facilitator's choices. Small on purpose: the projector's view boundary and the console import it at boot, while the
// timeline (music-timeline.mjs) and the engine load only with the music.

/** The four decision themes, in the order the console lists them. Lobby and debrief beds follow the room's context. */
export const MUSIC_DECISION_TRACKS = Object.freeze(['atlas-current', 'atlas-crossing', 'side-street-developed', 'night-platform-developed']);
export const MUSIC_TRACK_NAMES = Object.freeze({
  'atlas-current': 'Atlas · Current', 'atlas-crossing': 'Atlas · Crossing',
  'side-street-developed': 'Side Street', 'night-platform-developed': 'Night Platform',
});
/** Tempo profiles per decision theme: base, 125% (+6% BPM) and 150% (+12% BPM), each rendered at its original pitch. `loopS` is
 *  the sample-exact rendered loop from the manifest; a bar is one `bars`-th of it (tests/room-music.test.mjs pins both). */
export const MUSIC_TEMPO = Object.freeze({
  'atlas-current': Object.freeze({ meter: 4, bars: 8, bpm: Object.freeze([106, 112.36, 118.72]), loopS: Object.freeze([18.113197278911564, 17.087936507936508, 16.17251700680272]) }),
  'atlas-crossing': Object.freeze({ meter: 4, bars: 8, bpm: Object.freeze([106, 112.36, 118.72]), loopS: Object.freeze([18.113197278911564, 17.087936507936508, 16.17251700680272]) }),
  'side-street-developed': Object.freeze({ meter: 4, bars: 14, bpm: Object.freeze([112, 118.72, 125.44]), loopS: Object.freeze([30, 28.3018820861678, 26.785714285714285]) }),
  'night-platform-developed': Object.freeze({ meter: 4, bars: 8, bpm: Object.freeze([126, 133.56, 141.12]), loopS: Object.freeze([15.238095238095237, 14.375555555555556, 13.605442176870747]) }),
});
/** Build intensity is a whole percent, 0–150; the room starts at the audition's 70 (CASE-334). */
export const MUSIC_INTENSITY_DEFAULT = 70;
export const MUSIC_INTENSITY_MAX = 150;
export const MUSIC_CHOICES = Object.freeze(['auto', ...MUSIC_DECISION_TRACKS]);

export const validMusicChoice = value => MUSIC_CHOICES.includes(value);
export const validMusicIntensity = value => Number.isInteger(value) && value >= 0 && value <= MUSIC_INTENSITY_MAX;
/** CASE-335: the room's own levels, set from the console's player (the projector keeps only its sound button, since a
 *  browser plays only after a tap on that device). Music volume is a whole percent; Effects are on or off. */
export const MUSIC_VOLUME_DEFAULT = 60;
export const EFFECTS_LEVEL = .6;
export const validMusicVolume = value => Number.isInteger(value) && value >= 0 && value <= 100;
