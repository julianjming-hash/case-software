// What Administration says for each refusal the Worker names (facilitator-UX A5, AS-212). One reading per fixed error
// string, no raw keys, and a statement of whether anything changed wherever that is known. A step-up failure
// (asking for or checking a code) is a different family: nothing was changed by it.
import { CODE_REJECTED, CODE_RATE_LIMITED, SIGNED_OUT } from './admin-stepup-messages.mjs';
export { stepUpMessage, stepUpFailure } from './admin-stepup-messages.mjs';
const MESSAGES = Object.freeze({
  conflict: 'This record changed. Current information has been loaded.',
  forbidden: 'Your access does not allow this action. Check Account → Your access or ask a Case administrator.',
  rate_limited: CODE_RATE_LIMITED,
  request_timeout: 'The request timed out. Check current information before acting again.',
  change_reverted_audit_unavailable: 'The change was reverted because audit recording is unavailable.',
  manual_reconciliation_needed: 'Manual reconciliation is needed. Do not repeat this action.',
  audit_unavailable: 'Audit recording is unavailable. No change was made.',
  bad_request: 'Check the information and try again.',
  admin_unavailable: 'Administration is unavailable. Do not repeat an uncertain change.',
  not_found: 'That record no longer exists. Current information has been loaded.',
  unauthorised: SIGNED_OUT,
  too_large: 'That is more than Case can show at once. Narrow the search and try again.',
  unsupported_media_type: 'Case could not read the server’s answer. Reload the page; if it keeps happening, tell the Case owner.',
  code_rejected: CODE_REJECTED,
  step_up_required: 'Your confirmation code is no longer valid. Send a new code and try again. Nothing was changed.',
});
export const adminMessage = error => MESSAGES[error] ?? 'Administration is unavailable.';

