// The brand splash: a fixed numbers-only braid (no case is disclosed on the root or the join page). Its own tiny
// module so the root can name it without loading the lazy `splash` renderer chunk (card 36b, CASE-174).
import { withSolution } from '../shared/art-descriptor.mjs';

export const BRAND_ART = Object.freeze(withSolution({ v: 1, stops: 6, decisions: [
  { stop: 1, strands: [{ rejoin: 2 }, { rejoin: 2 }], resets: 0, ends: 0 },
  { stop: 2, strands: [{ rejoin: 3 }], resets: 1, ends: 0 },
  { stop: 3, strands: [{ rejoin: 4 }, { rejoin: 4 }], resets: 0, ends: 0 },
  { stop: 4, strands: [{ rejoin: 5 }], resets: 0, ends: 0 },
] }, { attempt: 0, summarised: false }));


// The compact brand braid (Julian, 2026-10-10): five stops and two decisions, for free regions too narrow for the
// brand braid's plaits (a phone-width band). Tried only after every attempt of BRAND_ART fails there; never a case's art.
export const BRAND_COMPACT = Object.freeze(withSolution({ v: 1, stops: 5, decisions: [
  { stop: 0, strands: [{ rejoin: 2 }, { rejoin: 2 }], resets: 0, ends: 0 },
  { stop: 2, strands: [{ rejoin: 4 }], resets: 1, ends: 0 },
] }, { attempt: 0, summarised: false }));
