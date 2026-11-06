// src/shared/participant.mjs: who a participant is in a room, the rules every side enforces.
//
// A participant joins with a REQUIRED display name and a REQUIRED avatar (CASE-119). The phone
// checks both before it sends, and the server checks them again in wire.mjs (parseJoinRequest and
// the rename envelope), so a hand-made request cannot skip them. Pure and dependency-free.
//
//   Name:   3–20 characters after trimming and collapsing spaces; letters (any script, with their
//           accents), numbers, spaces, hyphens and apostrophes only; at least one letter or number.
//           Duplicates are allowed: two people may both be "Sam".
//   Avatar: one allow-listed id: 16 original drawings and their fixed colour variants from DiceBear's "Shadows" style
//           (CC0 1.0, by DiceBear), vendored as static files by scripts/gen-avatars.mjs. Never
//           fetched from the DiceBear API at runtime: that would hand every participant's IP to a
//           third party (CASE-120).

export const NAME_MIN = 3;
export const NAME_MAX = 20;
const ALLOWED = /^[\p{L}\p{M}\p{N}' ’-]+$/u;
const HAS_WORD = /[\p{L}\p{N}]/u;

/** NFC, every whitespace run to one space, trimmed. What the rules are checked against and what is stored. */
export function normaliseDisplayName(raw) {
  return String(raw ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

/**
 * Why a display name is refused, or null when it is fine.
 * @returns {null | 'required' | 'too_short' | 'too_long' | 'characters'}
 */
export function displayNameProblem(raw) {
  const name = normaliseDisplayName(raw);
  if (!name) return 'required';
  const n = [...name].length;
  if (n < NAME_MIN) return 'too_short';
  if (n > NAME_MAX) return 'too_long';
  if (!ALLOWED.test(name) || !HAS_WORD.test(name)) return 'characters';
  return null;
}

/** The phone's words for each problem (docs/SCREENS.md §Join flow). */
export const NAME_PROBLEM_TEXT = Object.freeze({
  required: 'Enter a name the room can call you',
  too_short: `Use at least ${NAME_MIN} characters`,
  too_long: `Use at most ${NAME_MAX} characters`,
  characters: 'Use letters, numbers, spaces, hyphens or apostrophes',
});

/**
 * The 16 avatars, in picker order. `label` is the accessible name (colour, then hair or hat); the
 * drawing parameters are what scripts/gen-avatars.mjs renders. Ids are stable: never reuse one for
 * a different drawing, since a stored room state refers to it.
 */
export const AVATARS = Object.freeze([
  { id: 'shadows-01', label: 'Wine, curls', ink: '#7b373f', background: '#ede4e4', shoulders: 'regular', head: 'round', top: 'curls' },
  { id: 'shadows-02', label: 'Brown, bun', ink: '#6b4630', background: '#ede4e0', shoulders: 'narrow', head: 'oval', top: 'bun' },
  { id: 'shadows-03', label: 'Olive, beanie', ink: '#4a5530', background: '#deedc2', shoulders: 'wide', head: 'round', top: 'beanie' },
  { id: 'shadows-04', label: 'Green, afro', ink: '#345945', background: '#d6eddf', shoulders: 'round', head: 'wide', top: 'afro' },
  { id: 'shadows-05', label: 'Teal, quiff', ink: '#345757', background: '#d0edec', shoulders: 'square', head: 'tall', top: 'quiff' },
  { id: 'shadows-06', label: 'Slate blue, braid', ink: '#335565', background: '#dfe8ed', shoulders: 'sloped', head: 'oval', top: 'braid' },
  { id: 'shadows-07', label: 'Blue, topknot', ink: '#33477f', background: '#e3e6ed', shoulders: 'regular', head: 'taper', top: 'topknot' },
  { id: 'shadows-08', label: 'Purple, puffs', ink: '#5e3b87', background: '#e8e4ed', shoulders: 'narrow', head: 'round', top: 'puffs' },
  { id: 'shadows-09', label: 'Plum, waves', ink: '#733662', background: '#ede3e9', shoulders: 'uneven', head: 'oval', top: 'waves' },
  { id: 'shadows-10', label: 'Charcoal, bowler hat', ink: '#3b3b42', background: '#e3e6ed', shoulders: 'wide', head: 'round', top: 'bowler' },
  { id: 'shadows-11', label: 'Khaki, tuft', ink: '#5b4e30', background: '#ede6d6', shoulders: 'regular', head: 'wide', top: 'tuft' },
  { id: 'shadows-12', label: 'Wine, flat top', ink: '#7b373f', background: '#ede6d6', shoulders: 'square', head: 'tall', top: 'flat' },
  { id: 'shadows-13', label: 'Green, hat', ink: '#345945', background: '#deedc2', shoulders: 'sloped', head: 'taper', top: 'hat' },
  { id: 'shadows-14', label: 'Blue, curls', ink: '#33477f', background: '#d0edec', shoulders: 'round', head: 'oval', top: 'curls' },
  { id: 'shadows-15', label: 'Purple, beanie', ink: '#5e3b87', background: '#ede3e9', shoulders: 'uneven', head: 'round', top: 'beanie' },
  { id: 'shadows-16', label: 'Brown, afro', ink: '#6b4630', background: '#ede4e4', shoulders: 'wide', head: 'wide', top: 'afro' },
]);
/** Original join picker silhouettes; existing IDs and drawings remain stable. */
export const AVATAR_SHAPES = AVATARS;
export const AVATAR_COLORS = Object.freeze([
  { id: 'wine', label: 'Wine', ink: '#7b373f', background: '#ede4e4' },
  { id: 'brown', label: 'Brown', ink: '#6b4630', background: '#ede4e0' },
  { id: 'olive', label: 'Olive', ink: '#4a5530', background: '#deedc2' },
  { id: 'green', label: 'Green', ink: '#345945', background: '#d6eddf' },
  { id: 'teal', label: 'Teal', ink: '#345757', background: '#d0edec' },
  { id: 'blue', label: 'Blue', ink: '#33477f', background: '#e3e6ed' },
  { id: 'purple', label: 'Purple', ink: '#5e3b87', background: '#e8e4ed' },
  { id: 'charcoal', label: 'Charcoal', ink: '#3b3b42', background: '#e3e6ed' },
].map(Object.freeze));
const SHAPE_SET = new Set(AVATAR_SHAPES.map((a) => a.id));
const COLOR_SET = new Set(AVATAR_COLORS.map((c) => c.id));

/** Only recognized silhouettes and colours can produce an asset ID. */
export function customAvatarId(shapeId, colorId) {
  return SHAPE_SET.has(shapeId) && COLOR_SET.has(colorId) ? `${shapeId}-${colorId}` : null;
}

const PARTS = new Map();
const LABELS = new Map();
// Three original tones sit between palette colours; editing starts with the nearest palette tone.
const ORIGINAL_TONES = Object.freeze({ '#335565': 'blue', '#733662': 'wine', '#5b4e30': 'olive' });
for (const shape of AVATAR_SHAPES) {
  const colorId = AVATAR_COLORS.find((c) => c.ink === shape.ink)?.id ?? ORIGINAL_TONES[shape.ink];
  PARTS.set(shape.id, Object.freeze({ shapeId: shape.id, colorId }));
  LABELS.set(shape.id, shape.label);
}
for (const shape of AVATAR_SHAPES) for (const color of AVATAR_COLORS) {
  const id = customAvatarId(shape.id, color.id);
  PARTS.set(id, Object.freeze({ shapeId: shape.id, colorId: color.id }));
  LABELS.set(id, `${color.label}, ${shape.label.split(', ')[1]}`);
}
export const AVATAR_IDS = Object.freeze([...PARTS.keys()]);
const AVATAR_SET = new Set(AVATAR_IDS);

export const isAvatarId = (id) => typeof id === 'string' && AVATAR_SET.has(id);
export const avatarLabel = (id) => LABELS.get(id) ?? null;
/** Decode only exact allow-listed IDs; never interpret arbitrary path fragments. */
export const avatarParts = (id) => PARTS.get(id) ?? null;
