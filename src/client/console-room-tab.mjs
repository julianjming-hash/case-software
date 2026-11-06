// The console's Room setup cards (console layout v2, Julian 2026-10-18; formerly the Room tab, card 36b, CASE-174): a
// lazy chunk that console-room.mjs preloads when the room mounts, so the first paint does not carry it. It renders
// People management, the briefing, the consoles and the shared-computer slot, plus the rail's faces and the round
// timer; the projector pairing, manual room and End case stay in console-room.mjs, so the outage path never depends on
// this chunk. The room's state and commands stay in console-room.mjs and arrive through `c` (getters and callbacks,
// never a copy of the capability). Only console-room.mjs imports it (tests/surface-parity-36b.test.mjs).
import { devicePairUrl, feedbackUrl } from '../shared/urls.mjs';
import { accountRequest, node } from './auth-ui.mjs';
import { formatCode, normalizeCode, PAIR_CODE_LENGTH } from '../shared/ids.mjs';
import { cleanText } from '../shared/text.mjs';
import { renderPlayer } from './console-player.mjs';
import { avatarEl } from './avatar.mjs';
import { displayNameProblem, normaliseDisplayName } from '../shared/participant.mjs';

const keyed = (key, item) => { item.dataset.focusKey = key; return item; };

/** Up to `max` avatar faces for the rail's People card, then `+n`; decorative (the count beside them is the text). */
export function peopleFaces(roster, max, el) {
  const faces = el('div', null, 'console-faces'); faces.setAttribute('aria-hidden', 'true');
  const shown = roster.length > max ? max - 1 : max;
  for (const person of roster.slice(0, shown)) faces.append(avatarEl(person.avatarId, { size: 26, name: '' }));
  if (roster.length > shown) faces.append(el('span', `+${roster.length - shown}`, 'console-faces-more'));
  return faces;
}

/**
 * Console layout v2 (Julian, 2026-10-18): the Room setup sheet's cards. People management, the facilitator briefing,
 * the consoles (with Take over only when another console is connected) and the shared computer; the projector pairing
 * and manual room cards are console-room.mjs's own, so the outage path never depends on this chunk.
 */
export function renderSetupCards(view, c) {
  const { el, button, section, roomCommand, render, armable } = c;
  const { manual } = c.state();
  const roster = view.participants?.filter(p => !p.removed) ?? [];
  const people = section(`People · ${roster.length}`, 'console-card console-setup-people');
  if (view.actions?.includes('show_names') && view.phase !== 'lobby') people.append(button(view.namesShown ?
    'Hide names on projector' : 'Show names on projector', () => roomCommand('show_names', { on: !view.namesShown }), 'btn quiet'));
  const list = el('div', null, 'console-people-list');
  if (!roster.length) list.append(el('p', 'No one has joined yet'));
  for (const person of roster) {
    const row = el('div', null, 'console-person');
    row.dataset.id = person.id; // what Rename and Remove capture, so an unchanged row is never kept stale (card 37)
    const identity = el('div', null, 'console-person-identity');
    const name = cleanText(person.name || 'Unnamed', 80);
    const joinedAt = Date.parse(person.joinedAt);
    const joined = Number.isFinite(joinedAt) ? new Date(joinedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'time unavailable';
    identity.append(avatarEl(person.avatarId, { size: 32, name }), el('span', name), el('small', `Joined ${joined}`));
    row.append(identity);
    // Focus keys name the person, not only the name: two people may share one (card 37).
    if (view.actions?.includes('rename')) row.append(keyed(`rename-${person.id}`, button(`Rename ${name}`, () => {
      const requested = window.prompt('Rename participant', name);
      if (requested == null) return;
      const renamed = normaliseDisplayName(requested);
      if (displayNameProblem(renamed)) {
        c.setStatus('Use a name of 3 to 20 letters, numbers, spaces, hyphens or apostrophes.');
        render(); return;
      }
      roomCommand('rename', { participantId: person.id, displayName: renamed });
    }, 'btn tertiary')));
    if (view.actions?.includes('remove_participant')) row.append(armable(`remove-${person.id}`, `Remove ${person.name || 'participant'} from session`,
      `Press again: remove ${name}`, () => roomCommand('remove_participant', { participantId: person.id }), 'btn tertiary', `Removes ${name} (joined ${joined}) from the session.`));
    list.append(row);
  }
  people.append(list);
  // Card 40a: the facilitator briefing from the pack this console already holds (CASE-092); nothing is kept after.
  const briefing = section('Facilitator briefing', 'console-card console-briefing');
  briefing.append(el('p', 'Every slide, question, path and note, to read before you start.', 'field-hint'));
  const files = el('div', null, 'case-actions');
  files.append(keyed('briefing-pdf', button('Download briefing (PDF)', () => void openBriefing('pdf', view, c), 'btn quiet')),
    keyed('briefing-print', button('Print briefing', () => void openBriefing('print', view, c), 'btn quiet')));
  briefing.append(files);
  const consoles = c.consoles();
  // A slot: console-room.mjs places the persistent panel in it after reconciling, so typed codes survive (card 37).
  let shared = null;
  if (c.sharedComputer() && !manual) { shared = el('div', null, 'console-shared-slot'); shared.dataset.keep = 'shared-computer'; }
  return { people, briefing, consoles: consoles && !manual ? renderConsoles(consoles, c, view) : null, shared };
}

const clock = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null; };
const counted = (n, one, many) => `${n} ${n === 1 ? one : many}`;
function countList(c, counts) {
  const list = c.el('ol', null, 'console-option-list');
  counts.forEach((row, index) => { const item = c.el('li', null, 'console-debrief-count'); item.append(c.markSvg(index, { size: 18 }), c.el('span', row.label), c.el('strong', String(row.count))); list.append(item); });
  return list;
}

/**
 * Console layout v2 (Julian, 2026-10-18): the Debrief review. Where the projector is (the summary, a question's results or
 * a replayed slide), Room sees for the debrief pages, the right panel for that place and the Questions jump row. The
 * routes not taken and their rationales are the facilitator view's alone: they never reach the projector or a phone.
 */
export function renderDebrief(view, c) {
  const { el, button, roomCommand, CLASS, debriefQuestionStep } = c, d = view.debrief, pub = d.public ?? {}, rows = view.publicTimeline ?? [];
  const questions = d.questions ?? [], cursor = view.display?.cursor, atSlide = Number.isSafeInteger(cursor), first = c.summaryPages(pub);
  const question = atSlide ? questions.find((q) => q.entryIndex === cursor) : questions.find((q) => q.resultPage === pub.page);
  const joined = view.participants?.length ?? 0, facts = `${counted(joined, 'person', 'people')} joined · ${counted(questions.length, 'question', 'questions')}`;
  // Room sees, for the debrief's own pages (a replayed slide is drawn by console-room.mjs from the public surface).
  let sees = null;
  if (!atSlide) {
    sees = el('div', null, 'console-debrief-sees');
    if (question && pub.page >= first) sees.append(el('p', `Results · Question ${question.no}`, 'eyebrow'), el('p', question.prompt, 'console-prompt'), countList(c, question.counts));
    else sees.append(el('p', `${view.caseTitle ?? 'Case'} · Debrief`, 'console-prompt'), el('p', facts),
      el('p', pub.page > 0 ? 'Summary, part 2: the learning objectives' : 'The path taken in the session and a large feedback QR', 'field-hint'));
  }
  // The right panel.
  const review = el('div', null, 'console-debrief-review');
  let title = 'Debrief';
  if (question) {
    title = `Question ${question.no} of ${questions.length}`;
    review.append(el('p', counted(question.total, 'answer', 'answers'), 'field-hint'));
    // CASE-327: a question's result is always on the projector with it; there is no Hide. Its slide, replayed from the strip,
    // offers the way back to the result.
    if (question.resultPage !== null) {
      if (atSlide) {
        const show = button('Show results on projector', () => roomCommand('debrief_page', { page: question.resultPage }), 'btn quiet');
        show.dataset.focusKey = 'debrief-results'; review.append(show);
      } else review.append(el('p', 'Results on the projector', 'field-hint'));
    }
    review.append(el('p', question.prompt, 'console-prompt'));
    if (question.counts.length) review.append(countList(c, question.counts));
    else review.append(el('p', 'Free-text answers stay private; only their total is shown.', 'field-hint'));
    if (question.chosen) {
      const taken = el('div', null, 'console-debrief-routes');
      taken.append(el('p', question.agreed === true ? 'Path you chose · most participants chose it too' : question.agreed === false ? 'Path you chose · most participants chose another answer' : 'Path you chose', 'eyebrow'),
        el('p', `${question.chosen.label} · ${CLASS[question.chosen.classification] ?? question.chosen.classification}`, 'console-debrief-route is-taken'));
      review.append(taken);
    }
    if (question.notTaken.length) {
      const others = el('div', null, 'console-debrief-routes'); others.append(el('p', 'Not taken · only you', 'eyebrow'));
      for (const path of question.notTaken) {
        const row = el('details', null, 'console-debrief-route'), summary = el('summary', `${path.label} · ${CLASS[path.classification] ?? path.classification}`);
        row.append(summary); if (path.rationale) row.append(el('p', path.rationale)); others.append(row);
      }
      review.append(others);
    }
  } else if (atSlide) { title = 'Slide'; review.append(el('p', `${cursor + 1} of ${rows.length} · no question on this slide`, 'field-hint')); }
  else review.append(el('p', facts, 'field-hint'),
    el('p', 'The projector shows the summary and a large feedback QR. Phones show their recap and the feedback form.'),
    el('p', 'Next shows each question with its results. Jump to one below, or replay any slide from the strip. The projector follows; phones stay on their recap.', 'field-hint'));
  // The Questions jump row, above the strip.
  const jump = el('div', null, 'console-debrief-questions'); jump.setAttribute('role', 'group'); jump.setAttribute('aria-label', 'Questions');
  jump.append(el('span', 'Questions', 'eyebrow'));
  const summaryChip = button('Summary', () => roomCommand('debrief_page', { page: 0 }), 'btn quiet console-chip');
  summaryChip.dataset.focusKey = 'debrief-q-summary'; if (!atSlide && pub.page < first) summaryChip.setAttribute('aria-current', 'step');
  jump.append(summaryChip);
  for (const q of questions) {
    const step = debriefQuestionStep(q), chip = button(`Q${q.no}`, () => step && roomCommand(step.command, step.payload), 'btn quiet console-chip');
    chip.dataset.focusKey = `debrief-q-${q.no}`; chip.title = q.prompt; chip.setAttribute('aria-label', `Question ${q.no}: ${q.prompt}`);
    if (!step) chip.disabled = true;
    if (question === q) chip.setAttribute('aria-current', 'step');
    jump.append(chip);
  }
  return { title, sees, review, jump };
}

// One feedback count read per Debrief at most every 60 s (P-37: the starter's account only), kept for this room only.
let feedbackRead = null;
function feedbackCount(c, view) {
  if (!c.auth) return null;
  if (feedbackRead?.sessionId !== c.sessionId) feedbackRead = { sessionId: c.sessionId, value: null, at: 0 };
  const read = feedbackRead;
  if (Date.now() - read.at > 60_000) {
    read.at = Date.now();
    accountRequest(c.auth, ['portfolio', 'sessions', c.sessionId, 'feedback'], { maxResponseBytes: 262144 })
      .then((v) => { const n = v?.responses?.total; if (Number.isSafeInteger(n) && n >= 0 && n !== read.value) { read.value = n; c.render(); } }, () => {});
  }
  return read.value;
}

/** The Debrief rail: the feedback window (open on phones, with its count and link) and the debrief record. */
export function renderDebriefRail(view, c) {
  const { el, button } = c, cards = [];
  if (view.feedbackCode) {
    const card = el('section', null, 'console-card console-feedback'); card.setAttribute('aria-label', 'Feedback');
    const head = el('div', null, 'console-card-head'); head.append(el('h2', 'Feedback'), el('span', 'Open', 'tag ok')); card.append(head);
    const n = feedbackCount(c, view), joined = view.participants?.length ?? 0;
    if (n !== null) { const count = el('p', null, 'console-people-count'); count.append(el('strong', String(n)), ` of ${joined} joined have sent it`); card.append(count); }
    const ends = clock(view.debrief?.expiresAt);
    card.append(el('p', `On phones now; new joins stopped.${ends ? ` Ends by itself at ${ends}.` : ''}`, 'field-hint'));
    card.append(keyed('feedback-copy', button('Copy feedback link', async () => {
      try { await navigator.clipboard.writeText(feedbackUrl(view.feedbackCode, location.origin)); c.setStatus('Feedback link copied.'); }
      catch { c.setStatus(`Copy is unavailable here. The link is ${feedbackUrl(view.feedbackCode, location.origin).replace(/^https:\/\//, '')}`); }
      c.render();
    }, 'btn quiet')));
    cards.push(card);
  }
  const record = el('section', null, 'console-card console-record'); record.setAttribute('aria-label', 'Debrief record');
  const files = el('div', null, 'console-card-actions');
  for (const [label, kind] of [['Debrief PDF', 'download'], ['Print', 'print']]) files.append(keyed(`debrief-${kind}`, button(label, () => void debriefFile(kind, c), 'btn quiet')));
  record.append(el('h2', 'Debrief record'), files);
  cards.push(record);
  return cards;
}
async function debriefFile(kind, c) {
  const model = c.debriefModel();
  if (!model) { c.setStatus('The debrief needs the case pack. Reload the console and try again.'); c.render(); return; }
  try {
    const { debriefRecord } = await import('./ended-summary.mjs');
    const file = debriefRecord(model, (text) => { c.setStatus(text); c.render(); });
    await file[kind]();
    setTimeout(file.close, 60_000); // the PDF's object URL is already revoked; this drops the print copy and the model
  } catch { c.setStatus('The debrief could not load. Reload the console and try again.'); c.render(); }
}

/** The round timer, the lock controls (CASE-319/320) and the room music, as one player widget (CASE-335; console-player.mjs). */
export function renderTimer(view, c) { return renderPlayer(view, c); }
export { timerClockParts, buildWords } from './console-player.mjs';

async function openBriefing(kind, view, c) {
  const doc = c.pack?.();
  if (!doc) { c.setStatus('Waiting for the private case pack.'); c.render(); return; }
  try {
    const chunk = await import('./briefing.mjs'), meta = { versionNo: view.caseVersionNo ?? null };
    c.setStatus(kind === 'print' ? (chunk.printBriefing(doc, meta), '') : await chunk.downloadBriefing(doc, meta) ?? '');
  } catch { c.setStatus('The briefing could not be prepared. Try again.'); }
  if (!c.state().closed) c.render();
}

// Consoles (card 35b, E27, P-27, CASE-177): the signed-in starter sees the room's live console credentials (device
// kind and issue time only) and stops one shared computer now. Rendered into the patched Room tab, so its
// controls take property handlers and id-based focus keys (card 37); the list itself lives in createConsoles.
function renderConsoles(consoles, c, view) {
  const { el, button, section, render, armable, roomCommand } = c;
  const { rows, failed } = consoles.view();
  const card = section(rows?.length > 1 ? `Consoles · ${rows.length}` : 'Consoles', 'console-card console-consoles');
  // Loaded once on first render; after a failure only Refresh asks again, so a render never loops a request.
  if (!rows) { if (!failed) consoles.load(); card.append(el('p', failed ? 'The consoles could not be listed.' : 'Checking consoles…')); }
  for (const entry of rows ?? []) {
    const row = el('div', null, 'console-person'); row.dataset.id = `console-${entry.id}`;
    const since = time(entry.issuedAt), shared = entry.kind === 'shared';
    row.append(el('span', entry.kind === 'unknown' ? `Console paired before an update · since ${since} · use Take over or End case to remove it`
      : `${shared ? 'Shared computer' : 'Signed-in device'} · since ${since}`));
    if (shared) row.append(armable(`revoke-console-${entry.id}`, `Stop shared computer (since ${since})`, 'Press again: stop it',
      () => consoles.revoke(entry.id), 'btn danger'));
    card.append(row);
  }
  // Take over (Julian, 2026-10-18): only when another console is connected, with what it does.
  if (rows?.length > 1 && view?.actions?.includes('takeover') && !c.state().manual) {
    card.append(el('p', 'Every console can run the session. Take over makes this the only one; the others stop and say so.', 'field-hint'),
      armable('takeover', 'Take over this session', 'Press again: take over', () => roomCommand('takeover'), 'btn quiet'));
  }
  card.append(keyed('refresh-consoles', button('Refresh consoles', () => { consoles.load(); render(); }, 'btn tertiary')));
  return card;
}

/** The starter's console list for one room, fetched with the account session (never the room capability). */
export function createConsoles({ auth, sessionId, render, setStatus }) {
  let rows = null, failed = false, loading = false;
  const path = ['sessions', sessionId, 'consoles'];
  async function load() {
    if (loading) return;
    loading = true;
    try {
      const body = await accountRequest(auth, path);
      rows = Array.isArray(body?.consoles) ? body.consoles.filter(entry => Number.isSafeInteger(entry?.id) &&
        ['shared', 'starter', 'unknown'].includes(entry.kind)) : []; failed = false;
    } catch { rows = null; failed = true; }
    finally { loading = false; render(); }
  }
  async function revoke(id) {
    try {
      await accountRequest(auth, [...path, 'revoke'], { method: 'POST', body: { id } });
      setStatus('Shared computer stopped. It has left this session.');
    } catch { setStatus('That shared computer could not be stopped. Refresh and try again; a console paired before an update needs Take over or End case.'); }
    rows = null; await load();
  }
  return { view: () => ({ rows, failed }), load, revoke };
}

// "Use a shared computer" (card 29, CASE-166; formerly "Approve a PC" on the library page). It lives in
// the console Room tab beside display pairing and is scoped to this room: the room is preselected, never
// chosen from a list. The approval flow and confirmation are unchanged: preview the computer's code, show
// browser, coarse location, requested and expiry in a review dialog, then approve. The computer then takes
// over the room and this console is fenced. The panel and dialog are created once and kept across Room
// tab re-renders, so a typed code, a preview or an open dialog survive room updates.

const BROWSERS = ['Chrome', 'Edge', 'Firefox', 'Safari', 'Other'];
const time = value => { const at = new Date(value); return Number.isFinite(at.getTime()) ? at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'Not recorded'; };

export function createSharedComputer({ auth, sessionId, joinCode }) {
  const room = formatCode(joinCode);
  const section = node('section', null, 'console-card console-shared-computer');
  const heading = node('h2', 'Use a shared computer');
  const pairPath = devicePairUrl('00000000', location.origin).replace(/\/00000000$/, '');
  const explain = node('p', `Only if you can\u2019t sign in on the room computer. On it, open ${pairPath.replace(/^https?:\/\//, '')} and type the code it shows here.`, 'field-hint');
  const label = node('label', 'Computer code', 'computer-code-label');
  const input = node('input', null, 'computer-code-input mono'); input.type = 'text'; input.maxLength = 11;
  input.autocomplete = 'off'; input.spellcheck = false; input.placeholder = 'XXXX XXXX'; input.dataset.focusKey = 'computer-code';
  input.setAttribute('autocapitalize', 'characters'); input.setAttribute('aria-describedby', 'computerCodeHint');
  label.append(input);
  const hint = node('p', 'Eight characters; not the session code. This console stops controlling the session once the computer takes over.', 'field-hint');
  hint.id = 'computerCodeHint';
  const review = node('button', 'Review computer', 'btn quiet'); review.type = 'button'; review.dataset.focusKey = 'review-computer';
  const status = node('p', '', 'console-status'); status.setAttribute('role', 'status');
  section.append(heading, explain, label, hint, review, status);

  const dialog = node('dialog', null, 'computer-dialog'); dialog.setAttribute('aria-labelledby', 'computerDialogTitle');
  const title = node('h2', `Use this computer for room ${room}?`); title.id = 'computerDialogTitle';
  const facts = node('dl', null, 'kv');
  const note = node('p', 'The computer gets control of this session only: no account, no library, no administration. This console stops controlling the session. Participants and the projector carry on unaffected.', 'banner manual');
  const cancel = node('button', 'Cancel', 'btn tertiary'); cancel.type = 'button';
  const approve = node('button', `Approve room ${room}`, 'btn primary'); approve.type = 'button';
  const buttons = node('div', null, 'dialog-actions'); buttons.append(cancel, approve);
  dialog.append(title, facts, note, buttons);
  document.body.append(dialog);

  let code = null, generation = 0, busy = false, closed = false;
  const reset = () => { code = null; generation++; };
  review.addEventListener('click', async () => {
    if (closed || busy) return;
    const next = normalizeCode(input.value, PAIR_CODE_LENGTH);
    if (!next) { status.textContent = 'Enter the eight-character code shown on the shared computer.'; return; }
    const current = ++generation; code = null; busy = true; review.disabled = true; status.textContent = 'Checking the computer…';
    try {
      const seen = await accountRequest(auth, ['console-pairs', 'preview'], { method: 'POST', body: { code: next } });
      if (closed || current !== generation) return;
      if (!BROWSERS.includes(seen?.browser) || typeof seen.country !== 'string' || typeof seen.city !== 'string') throw new Error('invalid_preview');
      code = next;
      facts.replaceChildren();
      for (const [term, value] of [['Code', formatCode(next)], ['Browser', seen.browser],
        ['Location', `${seen.city}, ${seen.country} (approximate)`], ['Requested', time(seen.requestedAt)], ['Expires', time(seen.expiresAt)]])
        facts.append(node('dt', term), node('dd', value));
      status.textContent = '';
      approve.disabled = false; cancel.disabled = false;
      dialog.showModal(); cancel.focus();
    } catch { if (!closed && current === generation) status.textContent = 'That computer code is unavailable or expired.'; }
    finally { if (current === generation || closed) { busy = false; review.disabled = false; } }
  });
  cancel.addEventListener('click', () => { reset(); dialog.close(); });
  dialog.addEventListener('cancel', () => reset());
  dialog.addEventListener('close', () => { if (!closed && review.isConnected) review.focus(); });
  approve.addEventListener('click', async () => {
    if (closed || busy || !code) return;
    const approvedCode = code, current = generation; busy = true; approve.disabled = true; cancel.disabled = true;
    try {
      const result = await accountRequest(auth, ['console-pairs', 'approve'], { method: 'POST', body: { code: approvedCode, sessionId } });
      if (closed || current !== generation) return;
      if (result?.approved !== true) throw new Error('approval_unavailable');
      reset(); input.value = ''; dialog.close();
      status.textContent = 'Computer approved. It now runs this room, and this console will stop controlling it.';
    } catch {
      if (!closed && current === generation) { dialog.close(); reset(); status.textContent = 'Approval failed, the code expired or the session ended. Ask the computer for a new code.'; }
    } finally { busy = false; approve.disabled = false; cancel.disabled = false; }
  });
  return { section, close() { closed = true; reset(); if (dialog.open) dialog.close(); dialog.remove(); section.remove(); } };
}

/** The display pairing code a facilitator types, approved over the room link (formerly console-display.mjs). */
export async function approveDisplayCode(link, rawCode) {
  const code = normalizeCode(rawCode, 8);
  if (!code) return { ok: false, error: 'bad_code' };
  try { return await link.approveDisplay(code); }
  catch { return { ok: false, error: 'unavailable' }; }
}
