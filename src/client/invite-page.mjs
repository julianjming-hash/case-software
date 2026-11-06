// The invitation page `/i/#<ref>` (CASE-341, plan §3 A4, prototypes/invite-email.html step 1). The reference is read from
// the fragment, dropped from the address bar at once, and POSTed in a body to the rate-limited peek endpoint (P-46). A live
// invitation shows "Join <place>" with the invited address filled into the ordinary sign-in; an ended or unknown one says
// so and shows no address. Signing in then runs on the facilitator document, which accepts the invitation from /me.
import { parseInviteFragment, invitePageUrl, invitationPeekPath, casesUrl } from '../shared/urls.mjs';
import { mountSiteHeader } from './site-header.mjs';

const ROLE = Object.freeze({ run: 'Can run', edit: 'Can edit', manage: 'Can manage' });
const LEVEL = Object.freeze({ run: 'Can run', edit: 'Can edit' });
const el = (tag, text, className) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (className) node.className = className; return node; };

/** What the page says for one live invitation: { heading, lead }. */
export function inviteWords(invitation) {
  const inviter = invitation.inviterName || 'A facilitator';
  if (invitation.caseTitle) return { heading: `Join “${invitation.caseTitle}”`,
    lead: `${inviter} shared this case from ${invitation.workspaceName ?? 'their workspace'} with you (${LEVEL[invitation.level] ?? 'Can run'}).` };
  return { heading: `Join ${invitation.workspaceName ?? 'a workspace'}`, lead: `${inviter} invited you with ${ROLE[invitation.level] ?? 'Can run'} access.` };
}

async function peek(ref) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(new URL(invitationPeekPath(), location.origin).href, { method: 'POST', credentials: 'omit', cache: 'no-store',
      redirect: 'manual', signal: controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ref }) });
    if (response.status === 429) return { state: 'busy' };
    if (!response.ok) return { state: response.status === 400 ? 'ended' : 'unavailable' };
    const body = await response.json();
    const row = body?.invitation;
    if (row === null) return { state: 'ended' };
    if (!row || typeof row.email !== 'string' || !['run', 'edit', 'manage'].includes(row.level)) return { state: 'unavailable' };
    return { state: 'live', invitation: row };
  } catch { return { state: 'unavailable' }; }
  finally { clearTimeout(timer); }
}

function endedPanel(main, text) {
  main.replaceChildren(); main.className = 'invite-page';
  const panel = el('section', null, 'invite-ended');
  const heading = el('h1', text.heading); heading.tabIndex = -1;
  const link = el('a', 'Sign in to Case', 'btn primary'); link.href = casesUrl(location.origin);
  panel.append(heading, el('p', text.body, 'muted'), link);
  main.append(panel);
  document.title = `${text.heading} | Case`;
  heading.focus();
}

export async function mount() {
  const ref = parseInviteFragment(location.hash);
  // The reference never stays in the address bar, history or a later Referer.
  history.replaceState(null, '', invitePageUrl(location.origin));
  // Opening another invitation link in this tab changes only the fragment: read it afresh.
  addEventListener('hashchange', () => { if (location.pathname === new URL(invitePageUrl(location.origin)).pathname && parseInviteFragment(location.hash)) location.reload(); });
  const main = document.querySelector('main');
  main.replaceChildren(el('p', 'Opening your invitation…', 'muted'));
  const found = ref ? await peek(ref) : { state: 'ended' };
  if (found.state !== 'live') {
    mountSiteHeader(document.body, { context: 'Invitation' });
    return endedPanel(main, found.state === 'ended'
      ? { heading: 'This invitation has ended', body: 'It expired, was revoked or has been used. Ask the person who invited you to send a new one. If you already have access, sign in.' }
      : found.state === 'busy' ? { heading: 'Too many attempts', body: 'Wait a minute, then open the link from your email again.' }
        : { heading: 'The invitation could not be opened', body: 'Check your connection and open the link from your email again, or sign in.' });
  }
  const words = inviteWords(found.invitation);
  document.title = `${words.heading} | Case`;
  const { mount: mountConsole } = await import('./console.mjs');
  return mountConsole({ mode: 'cases', invite: { ...words, email: found.invitation.email } });
}
