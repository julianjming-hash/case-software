// Numbers-only topology read from the released Diving Deeper version 1.
export const divingArt = { v: 1, stops: 37, attempt: 0, renderer: 1, summarised: true,
  decisions: [2,3,4,5,6,8,9,11,12,17,20,23,24,26,27,29,31,34].map(stop => ({ stop, ends: 0, resets: 0,
    strands: ({ 5: [6,6], 11: [12], 23: [24,24] }[stop] ?? []).map(rejoin => ({ rejoin })) })) };
