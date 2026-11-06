// Approved APP 5/APP 8 participant notice, ported as text from the room prototype.
import { h } from './phone-dom.mjs';
import { normalizeCode, JOIN_CODE_LENGTH } from '../shared/ids.mjs';
export const PRIVACY_INTRO = 'Case is an educational simulation only. It is not clinical advice. This notice explains what happens to information you give when you join a teaching room.';
export const ANALYTICS_NOTICE = 'Anonymous usage and connection metrics are retained for three months. These analytics points contain no names, answers, room or participant IDs, tokens, IP addresses or URLs.';
export const TURNSTILE_NOTICE = 'After repeated incorrect room codes, Cloudflare Turnstile may check this join page. Its script has access to this document and may read the entered room code, display name, avatar and browser storage. Cloudflare also processes network information such as your IP address. The check does not run in the session play or recap page.';
export const RETENTION_DAYS = 7;
export const RETENTION_NOTICE = `Names and per-person answers in the live room and session records are deleted within 25 hours after the session ends. Encrypted backups and connection logs expire within ${RETENTION_DAYS} days.`;
export const PRIVACY_SECTIONS = [
  {id:'beta-issues',heading:'Issue reports',paragraphs:['Issue reports and optional screenshots are visible to deployment administrators and their reporter. Security or privacy incidents are restricted to the designated incident administrator. The browser picker captures a single unfiltered screenshot into a local draft; nothing uploads before Send. Preview or remove it before sending.','Unresolved issues are retained; evidence is deleted thirty days after resolution. Participant original prose, screenshots and identity links follow the room end plus twenty-four-hour deadline. A reviewed nonpersonal engineering summary may remain until thirty days after resolution. Anonymous report access ends with room capability. Contact requires your separate consent. Reports are not automatically sent to AI services.']},
  {
    "id": "who",
    "heading": "Who runs Case",
    "paragraphs": [
      "Case is run by its owner for facilitator-led clinical teaching. The facilitator runs your session and controls what the room sees."
    ]
  },
  {
    "id": "collect",
    "heading": "What we collect",
    "paragraphs": [
      "When you join, Case asks for a display name and an avatar. It records your answers during the session. It also handles connection data needed to connect your phone and keep the room in step."
    ]
  },
  {
    "id": "sees",
    "heading": "Who sees it",
    "paragraphs": [
      "The facilitator sees your name, avatar and answers. Names and avatars appear in the projector lobby. During play, avatars appear; names require Show names. Closed responses, including free text, appear without names on the projector. The facilitator can hide them."
    ]
  },
  {
    "id": "where",
    "heading": "Where it is stored",
    "paragraphs": [
      "Case runs on Cloudflare's edge network and stores session records in Sydney. Cloudflare may process information outside Australia.",
      TURNSTILE_NOTICE
    ]
  },
  {
    "id": "how-long",
    "heading": "How long we keep it",
    "paragraphs": [
      RETENTION_NOTICE,
      ANALYTICS_NOTICE
    ]
  },
  {
    "id": "avoid",
    "heading": "What not to enter",
    "paragraphs": [
      "Do not enter patient details or information that identifies another person in your name or answers."
    ]
  },
  {
    "id": "choices",
    "heading": "Your choices",
    "paragraphs": [
      "You can use a name the room can call you without using your legal name, choose an avatar, and change either during the session. You can choose whether to answer a decision. Ask the facilitator if you have concerns about showing names on the projector."
    ]
  },
  {
    "id": "contact",
    "heading": "Contact",
    "paragraphs": [
      "For a privacy question, or to ask about access or correction, contact the facilitator or your hospital teaching organiser. They can put you in touch with the Case operator."
    ]
  }
];

export async function mount() {
  const { joinUrl, joinEntryUrl } = await import('../shared/urls.mjs');
  let code = null;
  try { code = normalizeCode(sessionStorage.getItem('case:phone:join-code-draft'), JOIN_CODE_LENGTH); } catch { /* denied storage still permits return */ }
  const back = code ? joinUrl(code, location.origin) : joinEntryUrl(location.origin);
  const root = h('div', { class: 'privacy-page' },
    h('header', {}, h('p', { class: 'brand', text: 'Case' }), h('a', { class: 'back', href: back, text: 'Back to join' })),
    h('main', {}, h('p', { class: 'kicker', text: 'Privacy' }), h('h1', { text: 'Privacy and data notice' }),
      h('p', { class: 'lede', text: PRIVACY_INTRO }),
      PRIVACY_SECTIONS.map(section => h('section', { 'aria-labelledby': section.id }, h('h2', { id: section.id, text: section.heading }), section.paragraphs.map(text => h('p', { text })))))
  );
  document.querySelector('main').replaceWith(root);
  document.title = 'Privacy | Case';
  return { teardown() { root.replaceChildren(); } };
}
