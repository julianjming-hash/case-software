// Case's own invitation email (CASE-340, plan §3 A4; prototypes/invite-email.html). One data object renders the HTML (light,
// with a dark variant under prefers-color-scheme) and the plain-text part. One action, `/i/#<ref>` (CASE-341); one fixed public
// mosaic image, no tracking parameter. Sending follows alerts.mjs: an injected fetchImpl, an idempotency key per send, and
// the provider's response body is never read. Reply-to is the inviter.
import { invitationHtml } from '../shared/email-family.mjs';
import { uuidv7 } from '../shared/ids.mjs';
import { inviteUrl, resendEmailsUrl } from '../shared/urls.mjs';

export const INVITATION_DAYS = 90;
export const INVITE_FROM = 'Case <noreply@iatrogenic.app>';
const SEND_TIMEOUT_MS = 2500;

/** What each level is called and what it can do (CASE-336). A workspace invitation names the role; a case one the level. */
const ROLE = Object.freeze({ run: 'Can run', edit: 'Can edit', manage: 'Can manage' });
const LEVEL = Object.freeze({ run: 'Can run', edit: 'Can edit' });
function abilities(level, place) {
  const run = [`Present ${place} with your group: put it on the projector and people join from their phones.`, 'Preview privately before presenting.'];
  if (level === 'run') return run;
  if (level === 'edit') return [...run, `Edit ${place} in Create. Publish or send for review according to the workspace policy.`];
  return [...run, `Manage and publish the cases in ${place}, and manage its groups. Invitations and workspace session records depend on policy; Admin access is separate.`];
}

const clean = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
const addressOk = value => typeof value === 'string' && value.length <= 320 && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(value);

/** The expiry as a date people read (Sydney, where Case runs), e.g. "1 February 2027". */
export function expiryDate(iso) {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) throw new TypeError('Invalid expiry');
  return at.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Australia/Sydney' });
}

/**
 * The facts one email states, from create_invitation / resend_invitation (case_app.invitation_facts) plus the fresh
 * reference and the origin: { ref, origin, email, inviterName, workspaceName, caseTitle, level, expiresAt }.
 */
export function inviteMessage(facts) {
  const level = facts?.level;
  if (!Object.hasOwn(ROLE, level) || (facts.caseTitle && level === 'manage') || !addressOk(facts.email)) throw new TypeError('Invalid invitation facts');
  const inviter = clean(facts.inviterName) || 'A facilitator', workspace = clean(facts.workspaceName) || 'a workspace';
  const caseTitle = facts.caseTitle ? clean(facts.caseTitle) : null;
  const url = inviteUrl(facts.ref, facts.origin);
  const expires = expiryDate(facts.expiresAt);
  const place = caseTitle ?? workspace;
  const subject = `${inviter} invited you to ${place} on Case`.slice(0, 200);
  const lead = caseTitle
    ? `${inviter} shared “${caseTitle}” (${workspace}) with you on Case. You ${LEVEL[level].toLowerCase()} this case.`
    : `${inviter} invited you to ${workspace} on Case. You’ll have ${ROLE[level]} access in this workspace.`;
  const can = abilities(level, caseTitle ? `“${caseTitle}”` : `the cases in ${workspace}`);
  const permission = ROLE[level], canHeading = `${permission} - you can`;
  return Object.freeze({ subject, inviter, workspace, caseTitle, level, url, expires, to: facts.email, lead, can, permission, canHeading,
    preheader: `${caseTitle ? `Run “${caseTitle}”` : `Join ${workspace}`} on Case. This invitation works until ${expires}.` });
}

/** The plain-text part: every fact the HTML states. */
export function inviteText(message) {
  return [`${message.inviter} invited you to ${message.caseTitle ? `“${message.caseTitle}”` : message.workspace}`, '',
    message.lead, '', `${message.canHeading}:`, ...message.can.map(line => `- ${line}`), '',
    `Sign in to Case: ${message.url}`,
    `We'll fill in ${message.to} for you and email a 6-digit code; there is no password.`,
    `This invitation works for ${INVITATION_DAYS} days, until ${message.expires}.`, '',
    `Not expecting this? You can ignore this email; nothing happens unless you sign in. Reply to reach ${message.inviter}.`, '',
    'Case · case.iatrogenic.app'].join('\n');
}

/** Shared table-based email family; all message facts are escaped by the renderer. */
export const inviteHtml = message => invitationHtml(message, INVITATION_DAYS);

/**
 * Send one invitation email. `RESEND_INVITE_API_KEY` absent → { ok: false, kind: 'email_not_configured' } and nothing is
 * sent (the invitation stays saved; Resend completes it later). A provider 429 → { kind: 'email_limit', retryAfter } from
 * its Retry-After header (an hour when absent). Anything else that is not a 2xx → { kind: 'failed' }.
 */
export async function sendInviteEmail({ env, message, replyTo = null, fetchImpl = fetch, nowMs = Date.now(), timeoutMs = SEND_TIMEOUT_MS }) {
  const key = env?.RESEND_INVITE_API_KEY;
  if (typeof key !== 'string' || !key) return { ok: false, kind: 'email_not_configured' };
  if (typeof fetchImpl !== 'function') return { ok: false, kind: 'failed' };
  const body = JSON.stringify({ from: INVITE_FROM, to: [message.to], subject: message.subject, html: inviteHtml(message), text: inviteText(message),
    ...(addressOk(replyTo) ? { reply_to: [replyTo] } : {}) });
  const controller = new AbortController();
  let timer;
  const expired = new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, Math.min(Math.max(1, timeoutMs), SEND_TIMEOUT_MS)); });
  try {
    const request = Promise.resolve().then(() => fetchImpl(resendEmailsUrl(), { method: 'POST', redirect: 'manual', signal: controller.signal,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'idempotency-key': `case-invite:${uuidv7()}` }, body })).catch(() => null);
    const response = await Promise.race([request, expired]);
    // Provider response content is neither needed nor read.
    try { void response?.body?.cancel?.().catch?.(() => {}); } catch { /* contained */ }
    if (response?.status === 429) {
      const seconds = Number(response.headers?.get?.('retry-after'));
      const wait = Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 86_400 ? seconds : 3600;
      return { ok: false, kind: 'email_limit', retryAfter: new Date(nowMs + wait * 1000).toISOString() };
    }
    if (!response?.ok || response.type === 'opaqueredirect') return { ok: false, kind: 'failed' };
    return { ok: true };
  } catch { return { ok: false, kind: 'failed' }; }
  finally { clearTimeout(timer); controller.abort(); }
}
