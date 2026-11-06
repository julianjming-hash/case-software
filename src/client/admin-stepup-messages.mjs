// What is said when a step-up code could not be sent or checked (facilitator-UX A5, AS-212). Kept apart from the rest of the
// Administration messages because Groups (the owners' library screen too) says the same things. Whatever the reason,
// asking for or checking a code changed nothing.
export const CODE_REJECTED = 'That code did not work: it is wrong or has expired. Send a new code and try again. Nothing was changed.';
export const CODE_RATE_LIMITED = 'Too many code attempts. Wait a few minutes before asking for another code. Nothing was changed.';
export const SIGNED_OUT = 'Your sign-in has ended. Sign in again; nothing was changed.';
const STEP_UP = Object.freeze({
  code_rejected: CODE_REJECTED, rate_limited: CODE_RATE_LIMITED, unauthorised: SIGNED_OUT,
  forbidden: 'This sign-in cannot confirm changes. Sign out, sign in again and retry. Nothing was changed.',
});
const DOWN = 'Case could not reach the sign-in service. Nothing was changed; try again in a minute.';
/** A code could not be sent or checked: whatever the reason, nothing was changed. */
export const stepUpMessage = error => STEP_UP[error] ?? DOWN;
/** The same, from the elevation's `{ ok, code }` (older callers read `error`). */
export const stepUpFailure = result => stepUpMessage(result?.code ?? result?.error);
