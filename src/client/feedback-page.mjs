// Participant feedback page at /F/<code> (CASE-284 slice 4; docs/plans/PARTICIPANT-FEEDBACK.md §3, §13).
// Room PDFs v2 (Julian 2026-10-18): the page draws the Finish block (finish-block.mjs), saving through feedback-client.mjs:
// a phone that joined the room answers as its participant credential, any other browser with a random key kept until
// feedback closes (D2), both only in the Authorization header. Text-only DOM throughout (hard rule 14).
import { feedbackUrl, apiPath } from '../shared/urls.mjs';
import { normalizeCode, JOIN_CODE_LENGTH } from '../shared/ids.mjs';
import { fetchResult } from './net.mjs';
import { createTurnstileController } from './turnstile-widget.mjs';
import { createFeedbackSaver, purgeExpiredKeys, safeStorage } from './feedback-client.mjs';
import { factsSummary } from './record-facts.mjs';

const NOT_ENDED_POLL_MS = 10000, NOT_ENDED_POLLS = 18;
const feedbackPath = code => apiPath('feedback', code);
/** The code in a /F/<code> path, normalised, or null. */
const codeFromPath = path => { const m = /^\/[Ff]\/([^/]+)$/.exec(path); return m ? normalizeCode(m[1], JOIN_CODE_LENGTH) : null; };
const COPY = {
  invalidCode: "That code isn't right · check it against the projector",
  notEnded: 'Feedback opens when the session ends.',
  closed: 'Feedback for this session has closed.',
  unavailable: 'Feedback is unavailable · try again shortly',
};

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) e.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return e;
}
const day = iso => { const d = new Date(iso); return Number.isNaN(+d) ? '' : d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); };

export async function mount({ win = globalThis.window, fetchImpl = globalThis.fetch } = {}) {
  const doc = win.document, main = doc.querySelector('main'), storage = safeStorage(win);
  doc.title = 'Feedback · Case';
  doc.body.classList.add('phone-page');
  main.removeAttribute('aria-labelledby');
  main.className = 'phone-app feedback-app';
  purgeExpiredKeys(storage);
  const code = codeFromPath(win.location.pathname);
  const bar = el('header', { class: 'fb-bar' }, el('span', { class: 'fb-word', text: 'CASE' }), el('span', { class: 'fb-where', text: 'Feedback' }));
  const body = el('div', { class: 'fb-body' });
  main.replaceChildren(bar, body);
  const show = (...nodes) => { body.replaceChildren(...nodes.filter(Boolean)); };
  const receipt = (kind, text, role = 'status') => el('p', { class: `receipt ${kind}`, role, text });
  const heading = facts => el('div', { class: 'fb-head' }, el('h1', { class: 'fb-title', text: facts.title || 'Feedback' }),
    el('p', { class: 'fb-meta', text: [facts.versionNo ? `Version ${facts.versionNo}` : '', day(facts.endedAt || facts.startedAt)].filter(Boolean).join(' · ') }),
    // The facilitator who ran the room (Julian, 2026-10-18); /F has it only after End, and not after the 24 h purge.
    factsSummary(facts).facilitator ? el('p', { class: 'fb-meta', text: `Facilitator: ${factsSummary(facts).facilitator}` }) : null);
  const formLink = facts => {
    if (!facts.formUrl) return null;
    let host = ''; try { const u = new URL(facts.formUrl); if (u.protocol !== 'https:') return null; host = u.host; } catch { return null; }
    return el('div', { class: 'fb-extra' }, el('a', { class: 'btn', href: facts.formUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Organisation evaluation form' }),
      el('p', { class: 'fb-host', text: `Opens ${host}` }));
  };

  function codeEntry(message) {
    const input = el('input', { class: 'input fb-code', id: 'fbCode', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', maxlength: '9', 'aria-describedby': 'fbCodeErr' });
    const err = el('p', { class: 'receipt bad', id: 'fbCodeErr', role: 'alert', text: message ?? '' });
    const go = () => { const c = normalizeCode(input.value, JOIN_CODE_LENGTH); if (c) win.location.assign(feedbackUrl(c, win.location.origin)); else err.textContent = COPY.invalidCode; };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    show(el('h1', { class: 'fb-title', text: 'Feedback' }), err, el('div', { class: 'field' }, el('label', { for: 'fbCode', text: 'Feedback code' }), input),
      el('button', { type: 'button', class: 'btn primary', text: 'Continue', onclick: go }));
  }
  if (!code) return codeEntry(win.location.pathname.length > 3 ? COPY.invalidCode : '');

  async function api(path, init = {}) {
    try {
      const { response, offline } = await fetchResult(path, { cache: 'no-store', ...init }, fetchImpl);
      if (!response || offline) return { status: 0 };
      let data = null; try { data = await response.json(); } catch { /* empty */ }
      return { status: response.status, data };
    } catch { return { status: 0 }; }
  }

  async function load(polls = 0) {
    const r = await api(feedbackPath(code));
    if (r.status === 404) return codeEntry(COPY.invalidCode);
    if (r.status !== 200 || !r.data) return show(el('h1', { class: 'fb-title', text: 'Feedback' }), receipt('bad', COPY.unavailable, 'alert'),
      el('button', { type: 'button', class: 'btn', text: 'Try again', onclick: () => load() }));
    const facts = r.data;
    if (facts.state === 'not_ended') {
      show(el('h1', { class: 'fb-title', text: 'Feedback' }), receipt('neutral', COPY.notEnded));
      // The archive can lag End by a few seconds (R7): look again for a while, then leave it to a reload.
      if (polls < NOT_ENDED_POLLS) win.setTimeout(() => load(polls + 1), NOT_ENDED_POLL_MS);
      return;
    }
    return openForm(facts);
  }

  // Room PDFs v2: the same Finish block as the ended phone screen (finish-block.mjs), from this page's public facts: the
  // record card, three ratings each with an optional comment, My Takehome and Download. A closed room keeps the record.
  async function openForm(facts) {
    const turnstile = el('div', { class: 'fb-turnstile' });
    let controller = null;
    const challenge = siteKey => new Promise(resolve => {
      controller ??= createTurnstileController(turnstile, { onToken: answer => resolve(answer), onUnavailable: () => resolve(null) });
      controller.challenge(siteKey);
    });
    const open = facts.state === 'open';
    const saver = open ? createFeedbackSaver({ code, sessionId: facts.sessionId, closesAt: facts.closesAt, win, fetchImpl, challenge }) : null;
    const saved = saver ? await saver.mine() : null;
    let mod;
    try { mod = await import('./finish-block.mjs'); } catch { return show(heading(facts), receipt('bad', COPY.unavailable, 'alert')); }
    const summary = { ...factsSummary(facts), audience: facts.audience ?? null };
    const block = mod.createFinishBlock({ win, summary, saver, saved, closesAt: saver?.closesAt ?? facts.closesAt, feedbackClosed: !open,
      download: async (s, entry) => (await import('./participant-record.mjs')).downloadParticipantRecord(doc, s, entry) });
    show(heading(facts), el('p', { class: 'fb-anon', text: 'Anonymous' }), block.node, turnstile, formLink(facts));
    block.shown();
  }

  await load();
}
