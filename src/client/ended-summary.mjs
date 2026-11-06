// Card 40 + feedback integration slice 6: the console's ended summary. One screen after End: the counts-only debrief
// (download and print), the projector pager over the room's bounded paging grant (P-36), Copy feedback link and Back
// to cases. The model and the grant live in this closure only, never in storage, a cache or a broadcast; Back to
// cases, sign-out and pagehide revoke the grant and clear both (AS-036 amended, red-team R12).
import { node, clearPrivate, accountRequest } from './auth-ui.mjs';
import { apiPath, feedbackUrl, historyUrl, sessionRecordObjectUrl } from '../shared/urls.mjs';

const MAX_BYTES = 2 * 1048576;
/** Slice 9 (P-37): the one feedback line the summary carries, from the room's results read; the results stay in History. */
export const feedbackCountText = (v) => (Number.isSafeInteger(v?.responses?.total) && v.responses.total >= 0 ? `Feedback · ${v.responses.total} so far` : null);

/** The debrief's PDF and print, for the ended summary and the console's Debrief record card (console layout v2). The
 *  renderer is its own chunk, fetched when this is made, so a route pays only when it shows a debrief. `say` gets the
 *  status line. `close` revokes the object URLs and clears any print copy. */
export function debriefRecord(model, say) {
  const renderer = model ? import('./debrief-render.mjs') : null, urls = new Set();
  let printRoot = null, previousTitle = null, closed = false;
  async function download() {
    if (closed || !model) return;
    say('Preparing the PDF…');
    try {
      const [{ sessionPdfDeflated }, { debriefPdfRows, debriefFileName }] = await Promise.all([import('./session-pdf.mjs'), renderer]);
      if (closed) return;
      const data = await sessionPdfDeflated(debriefPdfRows(model), { title: model.title, maxBytes: MAX_BYTES });
      const url = sessionRecordObjectUrl(new Blob([data], { type: 'application/pdf' })); urls.add(url);
      const a = node('a'); a.href = url; a.download = debriefFileName(model); a.click();
      setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url); }, 0);
      say('Debrief saved.');
    } catch (error) {
      if (!closed) say(error?.message === 'pdf_font_unsupported' ? 'The PDF font cannot show a character in this debrief. Use Print debrief.' : 'The PDF could not be made. Use Print debrief.');
    }
  }
  function clearPrint() {
    if (printRoot) { clearPrivate(printRoot); printRoot.remove(); printRoot = null; }
    document.body.classList.remove('printing-session-record');
    if (previousTitle !== null) { document.title = previousTitle; previousTitle = null; }
    window.removeEventListener('afterprint', clearPrint);
  }
  async function print() {
    if (closed || !model) return;
    let renderDebrief;
    try { ({ renderDebrief } = await renderer); } catch { say('Print is unavailable. Reload and try again.'); return; }
    if (closed) return;
    clearPrint();
    printRoot = node('article', null, 'private-session-print');
    printRoot.append(node('h1', model.title), renderDebrief(model));
    previousTitle = document.title; document.title = model.title;
    document.body.append(printRoot); document.body.classList.add('printing-session-record');
    window.addEventListener('afterprint', clearPrint, { once: true });
    try { window.print(); } finally { clearPrint(); }
  }
  function close() { closed = true; model = null; clearPrint(); for (const url of urls) URL.revokeObjectURL(url); urls.clear(); }
  return { download, print, close };
}

/**
 * `model` is the End model (debrief-model.mjs roomDebrief) or null when the console had no pack; `grant` resolves to
 * `{ token, pages }` or null. `onBack` runs once, after the grant is revoked.
 */
export function mountEndedSummary(host, { model, sessionId, feedbackCode = null, grant = null, auth = null, sharedComputer = false, onBack = () => {} }) {
  let closed = false, busy = false, paging = null, page = 0;
  const record = debriefRecord(model, (text) => { if (!closed) status.textContent = text; });
  const channel = (() => { try { return new BroadcastChannel('case-room-local'); } catch { return null; } })();
  const button = (label, cls, onclick) => { const b = node('button', label, cls); b.type = 'button'; b.onclick = onclick; return b; };
  const root = node('section', null, 'ended-summary'), status = node('p', null, 'ended-status');
  status.setAttribute('role', 'status');
  const heading = node('h1', model?.title ?? 'Session ended'); heading.id = 'ended-summary-h'; heading.tabIndex = -1;
  root.setAttribute('aria-labelledby', heading.id);
  root.append(node('p', 'Session ended', 'ended-pill'), heading);
  if (model) {
    const facts = [model.minutes !== null ? `${model.minutes} min` : null, `${model.joined} joined`, `${model.questions.length} ${model.questions.length === 1 ? 'question' : 'questions'}`].filter(Boolean);
    root.append(node('p', facts.join(' · '), 'ended-meta'));
  }
  const actions = node('div', null, 'ended-actions');
  if (model) actions.append(button('Download debrief (PDF)', 'btn primary', () => void download()), button('Print debrief', 'btn', () => void print()));
  actions.append(button('Back to Present', 'btn quiet', () => void back()));
  root.append(actions);
  if (!model) root.append(node('p', 'The debrief for this session is in Sessions.', 'ended-meta'));

  // The feedback link: the room's public code, the same URL the projector's QR carries (no token, no name).
  if (feedbackCode) {
    const url = feedbackUrl(feedbackCode, location.origin), row = node('div', null, 'ended-feedback');
    row.append(node('span', 'Feedback', 'ended-label'), node('span', url.replace(/^https:\/\//, ''), 'ended-url'),
      button('Copy link', 'btn', async () => {
        try { await navigator.clipboard.writeText(url); status.textContent = 'Feedback link copied.'; }
        catch { status.textContent = 'Copy is unavailable here. Select the link to copy it.'; }
      }));
    root.append(row);
  }
  // The starter's signed-in console reads the count (P-37) and links to History; a shared computer never does (R9).
  if (auth && !sharedComputer) {
    const line = node('p', null, 'ended-feedback-count'), count = node('span', 'Feedback'), link = node('a', 'Open Sessions', 'btn quiet');
    link.href = historyUrl(location.origin); link.target = '_blank'; link.rel = 'noopener noreferrer';
    line.append(count, ' ', link); root.append(line);
    accountRequest(auth, ['portfolio', 'sessions', sessionId, 'feedback'], { maxResponseBytes: 262144 })
      .then((v) => { const text = feedbackCountText(v); if (!closed && text) count.textContent = text; }, () => {});
  }

  // The pager moves the ended projector between the summary page and each shown result.
  const pager = node('div', null, 'ended-pager'), position = node('span', '', 'ended-pos');
  pager.setAttribute('role', 'group'); pager.setAttribute('aria-label', 'Projector'); pager.hidden = true;
  const prev = button('‹ Previous', 'btn', () => void move(page - 1)), next = button('Next ›', 'btn', () => void move(page + 1));
  prev.setAttribute('aria-label', 'Previous projector page'); next.setAttribute('aria-label', 'Next projector page');
  pager.append(node('span', 'Projector', 'ended-label'), prev, position, next);
  root.append(pager, status);
  host.replaceChildren(root);
  heading.focus();

  const show = () => { position.textContent = `${page + 1} of ${paging.pages}`; prev.disabled = busy || page <= 0; next.disabled = busy || page >= paging.pages - 1; };
  async function call(path, body) {
    const response = await fetch(new URL(apiPath('sessions', sessionId, 'debrief', path), location.origin).href, {
      method: body === undefined && path === 'view' ? 'GET' : 'POST', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error',
      headers: { authorization: `Bearer ${paging.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`debrief_${response.status}`);
    return response.json();
  }
  // A projector opened from this computer has no credential: it gets the same public view a network display reads.
  async function relay() {
    if (!channel) return;
    // The projector validates every local frame (acceptLocalFrame), so the view is relayed as the Worker sent it.
    try { const snap = await call('view'); if (!closed && snap?.view?.role === 'display') channel.postMessage({ t: 'local_snapshot', epoch: snap.epoch, revision: snap.revision, displayRevision: snap.displayRevision, view: snap.view }); }
    catch { /* a network projector still follows the room */ }
  }
  async function move(to) {
    if (closed || busy || !paging) return;
    busy = true; show();
    try { const moved = await call('page', { page: Math.max(0, to) }); if (closed) return; page = moved.page; paging.pages = moved.pages; status.textContent = ''; await relay(); }
    catch { if (!closed) { status.textContent = 'The projector page could not change. Its paging may have expired.'; pager.hidden = true; } }
    finally { busy = false; if (!closed && !pager.hidden) show(); }
  }
  Promise.resolve(grant).then((raw) => {
    const g = typeof raw?.token === 'string' && Number.isSafeInteger(raw.pages) && raw.pages > 0 ? raw : null;
    if (closed || !g) { if (g && closed) void revokeGrant(g); return; }
    paging = { token: g.token, pages: g.pages }; page = 0; pager.hidden = false; show(); void relay();
  }, () => {});

  const download = () => (closed || busy || !model ? null : (busy = true, record.download().finally(() => { busy = false; })));
  const print = () => (closed || !model ? null : record.print());
  async function revokeGrant(g) {
    try { await fetch(new URL(apiPath('sessions', sessionId, 'debrief', 'revoke'), location.origin).href, { method: 'POST', cache: 'no-store', credentials: 'omit',
      referrerPolicy: 'no-referrer', redirect: 'error', keepalive: true, headers: { authorization: `Bearer ${g.token}` } }); } catch { /* the grant expires on its own */ }
  }
  function close() {
    if (closed) return null;
    closed = true;
    const g = paging; paging = null; model = null;
    record.close();
    try { channel?.close(); } catch {}
    clearPrivate(root); root.remove();
    window.removeEventListener('pagehide', close);
    return g ? revokeGrant(g) : null;
  }
  async function back() {
    if (closed) return;
    await close();
    onBack();
  }
  window.addEventListener('pagehide', close, { once: true });
  return { close };
}
