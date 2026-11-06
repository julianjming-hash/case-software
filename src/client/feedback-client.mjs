// Feedback saving for the Finish block (room PDFs v2), shared by the ended phone screen and the /F page. A phone that
// joined the room answers as its participant credential; any other browser answers with a random key kept here until
// feedback closes (CASE-284 D2). Both travel only in the Authorization header. Saves are coalesced: while one is in flight
// the newest answers wait, so auto-save never races itself and each send carries the whole answer set.
import { apiPath } from '../shared/urls.mjs';
import { fetchResult } from './net.mjs';

const RETRY_MS = [2000, 5000, 10000];
const keyName = sessionId => `case:feedback:${sessionId}:key`;
const randomKey = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const safeStorage = win => { try { return win?.localStorage ?? null; } catch { return null; } };

/** Remove every expired browser key (they live only until their room's feedback closes). */
export function purgeExpiredKeys(storage, now = Date.now()) {
  if (!storage) return;
  try {
    for (let i = storage.length - 1; i >= 0; i--) {
      const name = storage.key(i);
      if (!/^case:feedback:[0-9a-f-]{36}:key$/.test(name ?? '')) continue;
      let record = null; try { record = JSON.parse(storage.getItem(name)); } catch { /* malformed */ }
      if (!record || typeof record.key !== 'string' || !(record.expiresAt > now)) storage.removeItem(name);
    }
  } catch { /* storage denied: nothing kept */ }
}
function readKey(storage, sessionId) {
  try { const r = JSON.parse(storage?.getItem(keyName(sessionId)) ?? 'null'); return r && typeof r.key === 'string' && r.expiresAt > Date.now() ? r.key : null; } catch { return null; }
}
function saveKey(storage, sessionId, value, closesAt) {
  const expiresAt = Date.parse(closesAt);
  try { storage?.setItem(keyName(sessionId), JSON.stringify({ key: value, expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 86400000 })); } catch { /* kept in memory only */ }
}
/** This room's participant credential if the phone joined it (CASE-106 record); the room DO verifies it. */
export function joinedCredential(storage, sessionId) {
  try {
    const r = JSON.parse(storage?.getItem(`case:participant:${sessionId}:token`) ?? 'null');
    return r && r.sessionId === sessionId && typeof r.token === 'string' && !(r.expiresAt <= Date.now()) ? r : null;
  } catch { return null; }
}

/**
 * A saver for one room's feedback. `challenge(siteKey)` runs Turnstile for a browser key's first send and resolves to its
 * token, or null. `save(answers)` resolves to { ok: true, closesAt } or { ok: false, error } with error one of closed,
 * not_open, full, edit_cap, changed, challenge, offline, invalid.
 */
export function createFeedbackSaver({ code, sessionId, closesAt = null, win = globalThis.window, fetchImpl = globalThis.fetch, challenge = async () => null }) {
  const storage = safeStorage(win), held = joinedCredential(storage, sessionId);
  let joined = Boolean(held?.token), browserKey = readKey(storage, sessionId), revision = 0, inFlight = null, queued = null;
  const auth = () => (joined ? `Participant ${held.token}` : browserKey ? `Feedback ${browserKey}` : null);
  async function api(path, init = {}) {
    try {
      const { response, offline } = await fetchResult(path, { cache: 'no-store', ...init }, fetchImpl);
      if (!response || offline) return { status: 0 };
      let data = null; try { data = await response.json(); } catch { /* empty */ }
      return { status: response.status, data, retryAfter: response.headers?.get?.('retry-after') ?? null };
    } catch { return { status: 0 }; }
  }
  /** This respondent's saved answers, or null. A credential from elsewhere falls back to this browser's key. */
  async function mine() {
    if (!auth()) return null;
    const r = await api(apiPath('feedback', code, 'mine'), { headers: { authorization: auth() } });
    if (r.status === 200 && r.data?.answers) { revision = r.data.revision; closesAt = r.data.closesAt ?? closesAt; return r.data.answers; }
    if ([401, 403].includes(r.status) && joined) { joined = false; return mine(); }
    return null;
  }
  async function send(answers, token = null, again = true) {
    if (!joined && !browserKey) { browserKey = randomKey(); saveKey(storage, sessionId, browserKey, closesAt); }
    const body = JSON.stringify({ answers, ...(revision ? { expectedRevision: revision } : {}), ...(token ? { turnstileToken: token } : {}) });
    let r;
    for (let attempt = 0; ; attempt++) {
      r = await api(apiPath('feedback', code), { method: 'PUT', headers: { authorization: auth(), 'content-type': 'application/json' }, body });
      if (![0, 503].includes(r.status) || attempt >= RETRY_MS.length) break;
      await new Promise(resolve => win.setTimeout(resolve, RETRY_MS[attempt]));
    }
    const error = r.data?.error;
    if (r.status === 200) { revision = r.data.revision; closesAt = r.data.closesAt ?? closesAt; return { ok: true, closesAt }; }
    if (r.status === 428 && r.data?.siteKey) { const answer = await challenge(r.data.siteKey); return answer ? send(answers, answer, again) : { ok: false, error: 'challenge' }; }
    if ([401, 403].includes(r.status) && joined && error !== 'challenge_failed') { joined = false; return send(answers, null, again); }
    // Changed elsewhere (another tab): re-read the revision once, then this phone's newest answers win.
    if ((error === 'feedback_conflict' || error === 'feedback_changed') && again) { await mine(); return send(answers, null, false); }
    if (error === 'feedback_conflict' || error === 'feedback_changed') return { ok: false, error: 'changed' };
    // The venue's shared limit: wait as asked (at most a minute), then try once more.
    if (r.status === 429 && again) { const wait = Math.min(60, Math.max(5, Number(r.retryAfter) || 20)); await new Promise(resolve => win.setTimeout(resolve, wait * 1000)); return send(answers, token, false); }
    if (r.status === 0 || r.status === 503 || r.status === 429) return { ok: false, error: 'offline' };
    return { ok: false, error: { feedback_closed: 'closed', feedback_not_open: 'not_open', feedback_full: 'full', feedback_edit_cap: 'edit_cap', challenge_failed: 'challenge', invalid_feedback: 'invalid' }[error] ?? 'offline' };
  }
  /** Save the whole answer set; a save requested while one is in flight replaces any waiting one. */
  function save(answers) {
    if (inFlight) { const waiting = queued ?? (queued = { answers, promise: null }); waiting.answers = answers;
      return waiting.promise ??= inFlight.then(() => { const next = queued; queued = null; return save(next.answers); }); }
    inFlight = send(answers).finally(() => { inFlight = null; });
    return inFlight;
  }
  return { mine, save, get joined() { return joined; }, get closesAt() { return closesAt; } };
}
