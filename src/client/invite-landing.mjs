// The first-sign-in landing (CASE-339, prototypes/invite-email.html steps 3-4): after /me accepted invitations, it says what
// is new — "You've joined <place> as <role>" for a new place, "Your access to <place> is now <level>" for a raised one —
// and opens the shared case, or continues to the library for a workspace. Only new or raised access is listed, so a second
// invitation to a new place says exactly what is new. Text only.
import { caseUrl } from '../shared/urls.mjs';

const ROLE = Object.freeze({ run: 'Can run', edit: 'Can edit', manage: 'Can manage' });
const LEVEL = Object.freeze({ run: 'Can run', edit: 'Can edit' });
const el = (tag, text, className) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (className) node.className = className; return node; };

/** One sentence per change, as parts: plain text or { strong }. */
export function joinedLine(row) {
  const by = row.inviterName ? `, invited by ${row.inviterName}` : '';
  if (row.caseId) return row.change === 'raised'
    ? ['Your access to ', { strong: row.caseTitle ?? 'a shared case' }, ' is now ', { strong: LEVEL[row.level] ?? 'Can edit' }, '.']
    : [`${row.inviterName ?? 'A facilitator'} shared `, { strong: row.caseTitle ?? 'a case' }, ' with you (', { strong: LEVEL[row.level] ?? 'Can run' }, `) in ${row.workspaceName ?? 'their workspace'}.`];
  return row.change === 'raised'
    ? ['Your access is now ', { strong: ROLE[row.level] ?? 'Can run' }, ' in ', { strong: row.workspaceName ?? 'your workspace' }, `${by}.`]
    : ['You’ve joined ', { strong: row.workspaceName ?? 'a workspace' }, ' with ', { strong: ROLE[row.level] ?? 'Can run' }, ` access${by}.`];
}

/**
 * Show the landing in `host`. Resolves once the person continues to the library ('library'), or navigates to the shared
 * case (never resolves then: the page is leaving).
 */
export function mountJoinedLanding(host, joined, { current = () => true } = {}) {
  host.replaceChildren();
  const panel = el('section', null, 'invite-landing');
  const heading = el('h2', joined.length > 1 ? 'Your new access' : 'Welcome to Case'); heading.tabIndex = -1;
  const list = el('ul', null, 'invite-landing-list');
  for (const row of joined) {
    const item = el('li');
    for (const part of joinedLine(row)) item.append(typeof part === 'string' ? document.createTextNode(part) : el('strong', part.strong));
    list.append(item);
  }
  const shared = joined.find(row => row.caseId && row.change === 'new') ?? joined.find(row => row.caseId) ?? null;
  const actions = el('div', null, 'invite-landing-actions');
  panel.append(heading, list, actions);
  host.append(panel);
  heading.focus();
  return new Promise(resolve => {
    const library = el('button', 'Open Present', shared ? 'btn' : 'btn primary'); library.type = 'button';
    library.addEventListener('click', () => { if (current()) { host.replaceChildren(); resolve('library'); } });
    if (shared) {
      const open = el('a', `Open “${shared.caseTitle ?? 'the shared case'}”`, 'btn primary'); open.href = caseUrl(shared.caseId, location.origin);
      actions.append(open);
    }
    actions.append(library);
  });
}
