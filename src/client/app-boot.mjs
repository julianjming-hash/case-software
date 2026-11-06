import { checkUrl } from '../shared/urls.mjs';

// The callback has already been consumed/stripped by app.mjs. Shell update recovery is independent of
// route import and required privacy/bootstrap validation. Await the whole mount, including its Promise;
// a deadline offers a document reload, never a second mount over unfinished destructive cleanup.
export async function boot({ route, notice, startShell, timeoutMs = 15_000,
  setTimer = setTimeout, clearTimer = clearTimeout, mark = name => globalThis.performance?.mark(name) }) {
  const show = timedOut => { try { notice({ timedOut }); } catch { /* Public fallback stays available. */ } };
  const timer = setTimer(() => { mark('case-surface-timeout'); show(true); }, timeoutMs);
  let pending;
  try { pending = route(); } catch (error) { pending = Promise.reject(error); }
  try { void Promise.resolve(startShell()).catch(() => {}); } catch { /* Online shell stays available. */ }
  try { const surface = await pending; mark('case-surface-mounted'); return surface; }
  catch { mark('case-surface-failed'); show(false); }
  finally { clearTimer(timer); }
}

/** Text-only notice in the page's main landmark. */
export function loadFailedNotice(doc = globalThis.document, { timedOut = false } = {}) {
  const main = doc.querySelector('main');
  if (!main) return;
  main.removeAttribute('aria-labelledby');
  const title = doc.createElement('h1'); title.textContent = timedOut ? 'Case is taking longer to open' : 'Case could not load this page';
  const text = doc.createElement('p'); text.textContent = 'Check your connection, then reload this page to try again. If Case was just updated, reloading fetches the new version.';
  text.setAttribute('role', 'alert');
  const reload = doc.createElement('button'); reload.type = 'button'; reload.className = 'btn primary'; reload.textContent = 'Reload page';
  reload.addEventListener('click', () => doc.defaultView.location.reload());
  const check = doc.createElement('a'); check.className = 'btn'; check.textContent = 'Network check'; check.href = checkUrl(doc.defaultView.location.origin);
  main.replaceChildren(title, text, reload, check);
}
