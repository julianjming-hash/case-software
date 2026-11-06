import {rememberIssueAuth} from './issue-auth-binding.mjs';
// A small text-only Auth surface shared by the facilitator console and approval phone.
import { createAuth } from './auth.mjs';
import { recoverOnLoad } from './teardown.mjs';
import { apiUrl } from '../shared/urls.mjs';

export const node = (tag, label, className) => {
  const item = document.createElement(tag);
  if (label != null) item.textContent = label;
  if (className) item.className = className;
  return item;
};

// Retire private DOM values/handlers as well as removing connected nodes.
export function clearPrivate(root){
 for(const child of [...root.querySelectorAll('*')].reverse()){
  if('value' in child)child.value='';for(const name of [...child.attributes])if(name.name.startsWith('data-')||['title','aria-label','aria-description'].includes(name.name))child.removeAttribute(name.name);
  child.onclick=child.onsubmit=child.onchange=null;child.textContent='';
 }
 root.replaceChildren();
}

// A refused request rejects with message 'request_unavailable' and, for an HTTP refusal, its `status` and the
// Worker's fixed error string as `code` (card 30: name_taken, conflict, confirm_mismatch ...), or null.
const refusal = (status, code) => Object.assign(new Error('request_unavailable'), { status, code });
const errorCode = text => { try { const value = JSON.parse(text)?.error; return typeof value === 'string' && /^[a-z_]{1,40}$/.test(value) ? value : null; } catch { return null; } };
export async function accountRequest(auth, parts, { method = 'GET', body, query = null, headers = {},
  signal = null, timeoutMs = 10_000, maxResponseBytes = 65_536 } = {}, retry = 1) {
  let token = auth.accessToken() ?? await auth.restore();
  if (!token) throw new Error('sign_in_required');
  const generation = auth.sessionGeneration();
  const current = () => !signal?.aborted && auth.sessionGeneration() === generation;
  if (!current()) throw new Error('request_unavailable');
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) throw new Error('request_unavailable');
  signal?.addEventListener('abort', cancel, { once: true });
  let timer;
  const duration = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(10_000, timeoutMs)) : 10_000;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => {
    controller.abort(); reject(new Error('request_unavailable'));
  }, duration); });
  const bounded = promise => Promise.race([promise, deadline]);
  try {
    const target = new URL(apiUrl(location.origin, ...parts));
    if (query) for (const [key, value] of query) target.searchParams.set(key, value);
    const response = await bounded(fetch(target.href, {
      method, credentials: 'omit', cache: 'no-store', redirect: 'manual', signal: controller.signal,
      headers: { ...Object.fromEntries(Object.entries(headers).filter(([name]) => !['authorization', 'content-type'].includes(name.toLowerCase()))), authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    if (!current() || response.status === 401) {
      controller.abort();
      try { void Promise.resolve(response.body?.cancel()).catch(() => {}); } catch {}
      if (!current()) throw new Error('request_unavailable');
    }
    if (response.status === 401) { if (retry && await auth.refresh()) return accountRequest(auth, parts, arguments[2], 0);
      await auth.handle401(); throw new Error('sign_in_required'); }
    const failed = !response.ok || response.status >= 300;
    const reader = response.body?.getReader?.();
    if (!reader) throw new Error('request_unavailable');
    let text = '', bytes = 0, done = false;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    try {
      while (!done) {
        const chunk = await bounded(reader.read());
        if (!current()) throw new Error('request_unavailable');
        done = chunk.done;
        if (done) break;
        if (!(chunk.value instanceof Uint8Array)) throw new Error('request_unavailable');
        bytes += chunk.value.byteLength;
        const responseLimit = Number.isSafeInteger(maxResponseBytes) && maxResponseBytes > 0
          ? Math.min(2 * 1_048_576, maxResponseBytes) : 65_536;
        if (bytes > responseLimit) throw new Error('request_unavailable');
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      if (!done) {
        controller.abort();
        try { void Promise.resolve(reader.cancel()).catch(() => {}); } catch {}
      }
    }
    if (!current()) throw new Error('request_unavailable');
    if (failed) throw refusal(response.status, errorCode(text));
    return rememberIssueAuth(JSON.parse(text),auth);
  } catch (error) { throw Number.isInteger(error?.status) ? error : new Error('request_unavailable'); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); token = null; }
}

export function mountAccount(main, { onSignedIn, onSignedOut = () => {}, magicCallback = null,
  preserveSessionKeys = () => [], idleText = 'Sign in to continue.', onStateChange = () => {}, prefillEmail = null } = {}) {
  let closed = false, recovering = true;
  const auth = createAuth({ preserveSessionKeys,
    onRecovered: () => !recovering && showSignedIn(),
    onTeardown: reason => { if (!closed) { resetForm(); onSignedOut(reason); } } });
  const form = node('form', null, 'auth-form');
  const emailLabel = node('label', 'Email');
  const email = node('input'); email.type = 'email'; email.required = true; email.autocomplete = 'email';
  emailLabel.append(email);
  const send = node('button', 'Email me a sign-in code', 'btn primary'); send.type = 'submit';
  const magic = node('button', 'Or email me a link instead', 'btn tertiary'); magic.type = 'button';
  const codeLabel = node('label', 'One-time code'); codeLabel.hidden = true;
  const code = node('input'); code.type = 'text'; code.inputMode = 'numeric'; code.pattern = '[0-9]{6}'; code.maxLength = 6; code.autocomplete = 'one-time-code'; code.name = 'verification-code';
  codeLabel.append(code);
  const signIn = node('button', 'Sign in', 'btn primary'); signIn.type = 'submit'; signIn.hidden = true;
  const status = node('p', 'Checking your session…', 'auth-status'); status.setAttribute('role', 'status');
  const signOut = node('button', 'Sign out', 'btn'); signOut.type = 'button'; signOut.hidden = true;
  const retry = node('button', 'Retry session', 'btn tertiary'); retry.type = 'button'; retry.hidden = true;
  form.append(emailLabel, send, magic, codeLabel, signIn, status, signOut, retry); main.append(form);
  emailLabel.hidden = send.hidden = magic.hidden = true;
  const busy = value => { send.disabled = value; signIn.disabled = value; };
  const state = onStateChange;
  function resetForm(value = 'signed-out') {
    const signedOut = value === 'signed-out';
    form.classList.remove('is-signed-in'); signOut.hidden = true;
    emailLabel.hidden = send.hidden = magic.hidden = !signedOut;
    codeLabel.hidden = signIn.hidden = true; retry.hidden = signedOut;
    // An invitation page fills in the invited address (CASE-341); the person may still change it.
    email.value = signedOut && typeof prefillEmail === 'string' ? prefillEmail : ''; code.value = '';
    status.textContent = signedOut ? idleText : 'Session unavailable. Check your connection and retry.';
    state(value);
  }
  function showSignedIn() {
    if (closed || form.classList.contains('is-signed-in')) return;
    retry.hidden = true; state('signed-in');
    form.classList.add('is-signed-in'); signOut.hidden = false; emailLabel.hidden = true;
    send.hidden = true; magic.hidden = true; codeLabel.hidden = true; signIn.hidden = true;
    status.textContent = 'Signed in.'; onSignedIn(auth);
  }
  form.addEventListener('submit', async event => {
    if (closed) return;
    event.preventDefault();
    if (send.disabled || signIn.disabled) return;
    if (!codeLabel.hidden) { await verifyCode(); return; }
    busy(true);
    try { await auth.requestOtp(email.value); if (closed) return;
      codeLabel.hidden = false; signIn.hidden = false; send.hidden = true; status.textContent = 'Enter the one-time code from your email.'; code.focus(); }
    catch { if (!closed) status.textContent = 'Sign-in is unavailable. Try again.'; }
    finally { if (!closed) busy(false); }
  });
  magic.addEventListener('click', async () => {
    if (closed) return;
    magic.disabled = true;
    try { await auth.beginMagicLink(email.value); if (!closed) status.textContent = 'Check your email for a sign-in link.'; }
    catch { if (!closed) status.textContent = 'The sign-in link is unavailable. Try again.'; }
    finally { if (!closed) magic.disabled = false; }
  });
  async function verifyCode() {
    if (closed) return;
    busy(true);
    try {
      const access = await auth.verifyOtp(email.value, code.value);
      if (closed) return;
      if (!access) throw new Error('auth_unavailable');
      email.value = ''; code.value = ''; showSignedIn();
    } catch { if (!closed) status.textContent = 'The code could not be verified.'; }
    finally { if (!closed) busy(false); }
  }
  signOut.addEventListener('click', () => {
    if (closed) return;
    void (tabs ? tabs.signOut() : auth.teardown('sign_out'));
    status.textContent = 'Signed out.'; busy(false);
  });
  // CASE-175: join the other tabs before any refresh; a bfcache restore reloads.
  let tabs; const linked = import('./account-session.mjs').then(chunk => { tabs = auth.link(chunk.linkTabs); }).catch(() => {});
  const unavailable = () => { if (!closed) resetForm('unavailable'); };
  function restoreSession() {
    recovering = true; retry.hidden = true; state('checking'); status.textContent = 'Checking your session…';
    void Promise.all([recoverOnLoad({ preserveSessionKeys }), linked]).then(async ([result]) => {
      if (closed) return null;
      if (!result.complete) { await auth.teardown('next_load_failed'); throw new Error('auth_unavailable'); }
      recovering = false;
      return magicCallback ? auth.completeMagicLink(magicCallback, { history: { replaceState() {} } }) : auth.restore();
    }).then(access => {
      if (closed) return;
      if (access) showSignedIn();
      else if (auth.hasSavedSession()) unavailable();
      else { resetForm(); if (magicCallback) status.textContent = 'The sign-in link is unavailable.'; }
    }).catch(unavailable);
  }
  retry.addEventListener('click', restoreSession);
  restoreSession();
  window.addEventListener('pagehide', () => { closed = true; void auth.teardown('pagehide'); }, { once: true });
  window.addEventListener('pageshow', event => event.persisted && location.reload());
  return { auth, status, signOut, retry };
}
