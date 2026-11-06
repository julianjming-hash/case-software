export const CHALLENGE_WINDOW_MS = 10 * 60 * 1000;
export const CHALLENGE_STRIKES = 3;
const active = (row, nowMs) => row && row.windowStart <= nowMs && row.expiresAt > nowMs;

/** Directory-only server-clock state; successful codes never record a strike. */
export function challengeRequired(row, nowMs) {
  return Boolean(active(row, nowMs) && row.n >= CHALLENGE_STRIKES);
}

/** Saturation bounds storage under wrong-code floods; retries never extend the fixed window. */
export function recordChallengeFailure(row, nowMs) {
  const windowStart = active(row, nowMs) ? row.windowStart : nowMs;
  return { windowStart, expiresAt: windowStart + CHALLENGE_WINDOW_MS,
    n: active(row, nowMs) ? Math.min(CHALLENGE_STRIKES, row.n + 1) : 1 };
}

/** Start fresh after successful verification, rather than exempting subsequent wrong codes. */
export const resetChallenge = () => null;
