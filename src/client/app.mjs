import { parseRoute, canonicalAppUrl } from '../shared/urls.mjs';
import { storedCredential } from './transport.mjs';
import { startShell } from './shell.mjs';
import { mount as privacyMount } from './privacy.mjs';
import { boot, loadFailedNotice } from './app-boot.mjs';
// Consume a one-use Auth code before mounting a surface, starting service-worker
// work or making any application request. Only the root callback is accepted.
const callback = new URL(location.href);
const magicCallback = callback.pathname === '/' && callback.searchParams.has('code') ? callback.href : null;
if (magicCallback) history.replaceState(null, '', callback.origin + callback.pathname);
if (!magicCallback) { const canonical = canonicalAppUrl(location.href); if (canonical !== location.href) history.replaceState(history.state, '', canonical); }
const path = location.pathname;
// CASE-166 (Julian, 2026-10-06, "trim first"): each surface is its own chunk, loaded by a literal
// same-origin import() (script-src 'self'; no Trusted Types sink), so the root loads only room-code entry.
// Every chunk is a budgeted entry in scripts/size-budget.mjs.
async function route() {
  const mount = (fn, ...args) => { performance.mark('case-route-module-loaded'); return fn(...args); };
  if (storedCredential('display') && /\/facilitate$/.test(path)) return mount((await import('./projector.mjs')).mount);
  else if (path === '/privacy') return mount(privacyMount);
  else if (parseRoute(path)?.route === 'case-edit' || parseRoute(path)?.route === 'case-new')
    return mount((await import('./builder-page.mjs')).mountBuilderPage, document.querySelector('main'), { route: parseRoute(path) });
  else if (path === '/help') return mount((await import('./help.mjs')).mount);
  else if (parseRoute(path)?.route === 'invite') return mount((await import('./invite-page.mjs')).mount); // CASE-341 /i/#<ref>
  else if (path === '/join' || /^\/[Jj]\//.test(path) || /\/play$|\/recap$/.test(path)) return mount((await import('./phone.mjs')).mount);
  else if (/^\/[Ff]\//.test(path)) return mount((await import('./feedback-page.mjs')).mount); // CASE-284 participant feedback
  else if (/^\/[PpDd]\//.test(path)) return mount((await import('./pair.mjs')).mount);
  else if (/^\/[Pp]\/?$/.test(path)) return mount((await import('./pair.mjs')).mountConsolePair);
  else if (/\/display$/.test(path)) return mount((await import('./projector.mjs')).mount);
  // Card 29 (CASE-166): the root is participant-first for everyone. It never touches an account; a
  // magic-link callback (root only) and the catalogue (/cases) mount the facilitator document.
else if ((path === '/' || path === '/index.html') && !magicCallback) return mount((await import('./home.mjs')).mount);
  else if (magicCallback || ['cases','case','case-version','history','account','session-record','facilitate','admin'].includes(parseRoute(path)?.route) || path === '/room.html')
    return mount((await import('./console.mjs')).mount,{ magicCallback,mode:path==='/admin'?'admin':['history','session-record'].includes(parseRoute(path)?.route)?'history':path === '/account'?'account':'cases',requestedRecordId:parseRoute(path)?.route==='session-record'?parseRoute(path).sessionId:null,requestedSessionId:parseRoute(path)?.route==='facilitate'?parseRoute(path).sessionId:null });
  else { const {mountUnavailable}=await import('./unavailable.mjs'); return mount(mountUnavailable); }
}
await boot({ route, notice: reason => loadFailedNotice(document, reason), startShell });
