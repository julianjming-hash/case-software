// Help (card 36a): short answers by role, in a real tablist. Static text only: every string is a text node,
// nothing is fetched, nothing is stored. Each answer restates behaviour that ships; the sources are named in the card's PR.
// There is no disclaimer here (CASE-168): the policy page carries it once.
import { privacyUrl, checkUrl } from '../shared/urls.mjs';
import { mountSiteHeader } from './site-header.mjs';

const check = { link: { text: 'Check this network', to: 'check' } };
/** `a` is a list of parts: plain text, `{ strong }` or `{ link: { text, to } }` (`to` is 'check' or 'privacy'). */
export const HELP_TABS = Object.freeze([
  { id: 'joining', title: 'Joining', answers: [
    { q: "My code isn't accepted", a: ['Check the six characters against the projector. Spaces and hyphens are fine, and O and 0 count as the same, as do I, L and 1. If the phone says "This session is not accepting new participants", ask the facilitator to open joining. After several wrong codes the join page may ask for a short check before it tries again.'] },
    { q: 'Do I need an account?', a: ['No. A participant only needs the session code and a name. Accounts are for facilitators.'] },
    { q: 'Will others see my answers?', a: ['The facilitator sees your name, avatar and answers. Other phones never receive your individual answers, and the charts for closed responses never link a name to an answer.'] },
    { q: 'Where is my recap?', a: ['When the session ends, this phone shows your private recap. Only this phone can see it. Online access ends 24 hours after the session ends, and clearing this browser\'s data ends it sooner.'] },
  ] },
  { id: 'connection', title: 'Connection', answers: [
    { q: 'The page says it is waiting for a connection', a: ['Keep the page open. An answer you send while the connection is down is kept on this phone and sent automatically when it returns.'] },
    { q: 'I closed the page', a: ['Your place in the session is saved on this phone. If this browser no longer has it, enter the session code again to rejoin a session that is still open.'] },
    { q: 'The page will not load', a: ['Open it in your browser, or try mobile data. ', check, ' shows whether this phone can reach Case.'] },
  ] },
  { id: 'facilitating', title: 'Facilitating', answers: [
    { q: 'Which code do I enter?', a: [{ strong: 'Session code' }, ': six characters on the projector. Enter it on the join page. ', { strong: 'Computer code' }, ': eight characters on a shared computer, entered by a signed-in facilitator in the room\'s Room tab. ', { strong: 'Sign-in code' }, ': six digits from your email, for facilitators only. It is not a session code.'] },
    { q: 'Where do I present a case?', a: ['Choose Sign in from the menu, then Present. Present opens a session in Lobby; Start case reveals its opening slide.'] },
    { q: 'Who can see what the group sees?', a: ['The facilitator controls what the group sees. Your display name and avatar appear on the projector in the lobby. During play it shows avatars, and names only if you choose Show names.'] },
  ] },
  { id: 'projector', title: 'Projector', answers: [
    { q: 'What does the projector show before the case starts?', a: ['The session code and the address to join, a QR code to scan, and the names and avatars of the people who have joined.'] },
    { q: 'The projector has no sound', a: ['Session sound is silent until someone presses Session sound on that projector. It stays off while the page is hidden or the device asks for reduced motion.'] },
  ] },
  { id: 'shared-computer', title: 'Shared computer', answers: [
    { q: 'What is a computer code?', a: ['A computer code has eight characters and expires after five minutes. It is only for a signed-in facilitator moving a room onto another computer, and it is not a session code.'] },
    { q: 'What stays on a shared computer?', a: ['Signing out, or ending the session, clears the room from that computer\'s browser. Close the page when you are done.'] },
  ] },
]);

const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const LINKS = { check: checkUrl, privacy: privacyUrl };
function paragraph(parts) {
  const p = el('p');
  for (const part of parts) {
    if (typeof part === 'string') p.append(document.createTextNode(part));
    else if (part.strong) p.append(el('strong', part.strong));
    else { const a = el('a', part.link.text); a.href = LINKS[part.link.to](location.origin); p.append(a); }
  }
  return p;
}

export function mount() {
  const main = document.querySelector('main');
  main.replaceChildren(); main.className = 'help-page'; main.removeAttribute('aria-labelledby');
  document.title = 'Help | Case';
  const header = mountSiteHeader(document.body, { current: 'help' });
  const head = el('div', null, 'help-head');
  const title = el('h1', 'Help'); title.id = 'helpTitle'; title.tabIndex = -1;
  head.append(title, el('p', 'Short answers, by what you are doing.', 'muted'));
  const list = el('div', null, 'help-tabs'); list.setAttribute('role', 'tablist'); list.setAttribute('aria-label', 'Help by role');
  const tabs = [], panels = [];
  const select = (index, focus) => {
    tabs.forEach((tab, i) => { const on = i === index; tab.setAttribute('aria-selected', String(on)); tab.tabIndex = on ? 0 : -1; panels[i].hidden = !on; });
    if (focus) tabs[index].focus();
  };
  HELP_TABS.forEach((topic, i) => {
    const tab = el('button', topic.title, 'help-tab'); tab.type = 'button'; tab.id = `help-tab-${topic.id}`;
    tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', `help-panel-${topic.id}`);
    tab.addEventListener('click', () => select(i, false));
    tab.addEventListener('keydown', event => {
      const last = HELP_TABS.length - 1;
      const next = { ArrowRight: i === last ? 0 : i + 1, ArrowLeft: i === 0 ? last : i - 1, Home: 0, End: last }[event.key];
      if (next === undefined) return;
      event.preventDefault(); select(next, true);
    });
    const panel = el('section', null, 'help-panel'); panel.id = `help-panel-${topic.id}`;
    panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', tab.id); panel.tabIndex = 0;
    for (const answer of topic.answers) panel.append(el('h2', answer.q), paragraph(answer.a));
    tabs.push(tab); panels.push(panel); list.append(tab);
  });
  select(0, false);
  const foot = el('p', null, 'help-foot small muted');
  const privacy = el('a', 'Privacy'); privacy.href = privacyUrl(location.origin);
  foot.append(document.createTextNode('Do not enter patient details. '), privacy);
  main.append(head, list, ...panels, foot);
  return { header, tabs, panels };
}
