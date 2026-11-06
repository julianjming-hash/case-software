import { watchUpdate } from './update.mjs';

// Case's one Trusted Types policy (CSP `trusted-types case-default`, no duplicates). It is created once per realm and
// admits exactly two constants: the service worker's script path, and the blank standards-mode page every preview
// document is given before anything is drawn in it (CASE-249, R10, Julian's Q4 (a)). Preview windows and frames never
// create a policy of their own: the Builder's policy object writes their page.
export const BLANK_PAGE = '<!doctype html>';
const policies = new WeakMap();
function casePolicy(trusted) {
  let policy = policies.get(trusted);
  if (!policy) policies.set(trusted, policy = trusted.createPolicy('case-default', {
    createScriptURL(value) { if (value !== '/sw.mjs') throw new TypeError('unsupported_script'); return value; },
    createHTML(value) { if (value !== BLANK_PAGE) throw new TypeError('unsupported_html'); return value; },
  }));
  return policy;
}

export function serviceWorkerScriptURL(trusted = globalThis.trustedTypes) {
  if (!trusted) return '/sw.mjs';
  return casePolicy(trusted).createScriptURL('/sw.mjs');
}

/** Give a blank same-origin document (about:blank, so quirks mode) the standards-mode page, once, before drawing. */
// An engine that refuses a TrustedHTML made in another realm gets the page from the target realm's own policy instead
// (its first and only), so the preview never falls back to quirks mode or fails to open.
export function standardsPage(target, trusted = globalThis.trustedTypes) {
  if (target.compatMode === 'CSS1Compat') return target;
  const write = factory => { target.open(); target.write(factory ? casePolicy(factory).createHTML(BLANK_PAGE) : BLANK_PAGE); target.close(); };
  try { write(trusted); } catch (error) { const own = target.defaultView?.trustedTypes; if (!own || own === trusted) throw error; write(own); }
  return target;
}

/** The shell writes no web-storage or IndexedDB key. Only its service worker creates shell caches. */
export async function startShell() {
  if (!globalThis.isSecureContext || !navigator.serviceWorker) return;
  try {
    let promptEvents;
    const scriptURL = serviceWorkerScriptURL();
    const registration = await navigator.serviceWorker.register(scriptURL, { scope: '/', updateViaCache: 'none' });
    watchUpdate({ registration, serviceWorker: navigator.serviceWorker, reload: () => location.reload(), offer({ accept, decline }) {
      const dialog = document.getElementById('updateDialog');
      if (!dialog) return;
      promptEvents?.abort(); promptEvents = new AbortController();
      document.getElementById('updateAccept').addEventListener('click', () => { dialog.close(); promptEvents.abort(); accept(); }, { signal: promptEvents.signal });
      document.getElementById('updateLater').addEventListener('click', () => { dialog.close(); promptEvents.abort(); decline(); }, { signal: promptEvents.signal });
      dialog.showModal();
    } });
  } catch { /* Unsupported/blocked service workers leave the online shell available. */ }
}
export function shellNotice(title) {
  document.getElementById('surfaceTitle').textContent = title;
  document.getElementById('surfaceNotice').textContent = 'This room surface is being prepared. Use the network check before your session.';
}
