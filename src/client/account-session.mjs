// Card 38 (CASE-175): facilitator session resilience, a lazy chunk of every account surface (plus the
// magic-link start, moved here to keep the account surfaces' first load inside their budgets).
// Tabs: every tab of the origin shares one stored account session. One tab refreshes at a time (a Web Lock),
// because GoTrue revokes a session whose refresh token is reused; the rotated session reaches the other tabs
// in memory over a BroadcastChannel, never through storage; removal of the stored token (Sign out, a 401,
// a failed refresh) signs every tab out.
// Rejoin (the console, /cases): in the same tab (Back, reload, Forward) the tab's room marker names a room
// `/me/rooms` still lists, so it reopens without a press, once per load. Otherwise (a fresh sign-in, a new tab,
// a browser restart) the caller's own active rooms are offered at the top of /cases, one Rejoin room press
// each; none opens by itself. A rejoin always re-mints a console credential (P-24) and refetches the pack.
import { ACTIVE_ROOM_KEY, validPendingPkce } from './account-policy.mjs';
import { isUuid, isUuidV7 } from '../shared/ids.mjs';
export {prepareParticipantPreservation} from './storage-policy.mjs';

// A saved tab segment is opaque until fresh Auth establishes that its exact
// session belongs to this caller. Incomplete paging never means nonownership.
const JOIN_CODE = /^[0-9A-HJKMNP-TV-Z]{6}$/;
export async function findOwnedRoom(sessionId, listPage, { nowMs = Date.now() } = {}) {
  if (!isUuidV7(sessionId)) throw new Error('invalid_saved_room');
  let after = null;
  const seen = new Set();
  // Bound ownership discovery to twenty complete pages; incomplete paging refuses recovery.
  for (let pages = 20; pages > 0; pages--) {
    const response = await listPage(after);
    if (!Array.isArray(response?.rooms) || response.rooms.length > 100 ||
        response.nextAfter !== null && !isUuidV7(response.nextAfter))
      throw new Error('invalid_owner_page');
    for (const room of response.rooms) {
      if (!isUuidV7(room?.sessionId) || !JOIN_CODE.test(room.joinCode) ||
          typeof room.expiresAt !== 'string' || !(Date.parse(room.expiresAt) > nowMs)) throw new Error('invalid_owner_page');
    }
    const matching = response.rooms.find(room => room.sessionId === sessionId);
    if (matching) return { sessionId: matching.sessionId,
      joinCode: matching.joinCode, expiresAt: matching.expiresAt };
    if (response.nextAfter === null) return null;
    if (!response.rooms.length || response.nextAfter !== response.rooms.at(-1).sessionId ||
        seen.has(response.nextAfter)) throw new Error('invalid_owner_page');
    seen.add(response.nextAfter);
    after = response.nextAfter;
  }
  throw new Error('owner_pages_incomplete');
}

let tried = false; // one automatic attempt per load, so a failing re-mint can never loop
const forget = key => { try { sessionStorage.removeItem(key); } catch {} };
const el = (tag, text, className) => {
  const item = document.createElement(tag);
  if (text != null) item.textContent = text;
  if (className) item.className = className;
  return item;
};
const until = value => new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** `request(parts, options)` is the console's accountRequest; `open(room, saved)` mounts it; `current()` is false once superseded. */
export async function offerRejoin({ request, open, panel, status, current, saved = null, ownership, requestedSessionId = null, resumeRequestedSession = false }) {
  let marker = null;
  try { marker = sessionStorage.getItem(ACTIVE_ROOM_KEY); } catch {}
  if (!isUuidV7(marker)) marker = null;
  const list = (after, limit = '100') => request(['me', 'rooms'], { query: new URLSearchParams({ limit, ...(after ? { after } : {}) }) });
  async function rejoin(room) {
    const fresh = await request(['sessions', room.sessionId, 'facilitator-token'], { method: 'POST' });
    if (current()) await open({ ...room, facilitatorToken: fresh.facilitatorToken }, saved?.sessionId === room.sessionId ? saved.saved : null);
  }
  function offer(rooms) {
    const box = el('section', null, 'console-rejoin');
    box.append(el('h2', rooms.length > 1 ? 'Your active sessions' : 'Your session is still running'));
    for (const room of rooms) {
      const press = el('button', `Rejoin session · ${room.joinCode} · until ${until(room.expiresAt)}`, 'btn primary');
      press.type = 'button';
      press.addEventListener('click', async () => {
        press.disabled = true; status.textContent = 'Rechecking this session…';
        try { await rejoin(room); }
        catch { if (current()) { status.textContent = 'This session could not be rejoined. Try again.'; press.disabled = false; } }
      });
      box.append(press);
    }
    panel.prepend(box);
  }
  const target = isUuidV7(requestedSessionId) ? requestedSessionId : marker ?? saved?.sessionId ?? null;
  if (target) {
    const owned = await findOwnedRoom(target, list);
    if (!current()) return;
    if (owned) {
      // Only the tab that owns the room rejoins by itself: a duplicated or window.open tab copies the marker with
      // sessionStorage, but the original still holds the room's lock, so the copy gets the Rejoin press.
      const owns = (requestedSessionId === null || resumeRequestedSession === true) && target === marker && !tried && await ownership?.holdRoom(marker);
      if (!current()) return;
      if (owns) {
        tried = true;
        try { await rejoin(owned); return; }
        catch { if (!current()) return; ownership.releaseRoom(); status.textContent = 'The session could not be reopened automatically.'; }
      }
      offer([owned]); return;
    }
    // Ended, expired or no longer this person's room.
    if(target===marker)forget(ACTIVE_ROOM_KEY);
    if (saved?.sessionId===target) { forget(saved.key); panel.replaceChildren(); }
  }
  const page = await list(null, '20');
  const rooms = Array.isArray(page?.rooms) ? page.rooms.filter(room => isUuidV7(room?.sessionId) &&
    JOIN_CODE.test(room.joinCode) && Number.isFinite(Date.parse(room.expiresAt))) : [];
  if (current() && rooms.length) offer(rooms);
}

const KEY = 'case:auth:refresh', PKCE = 'case:auth:pkce';
export function linkTabs(auth, { events = globalThis.window, locks = globalThis.navigator?.locks,
  channel = new BroadcastChannel(KEY) } = {}) {
  const serial = run => locks ? locks.request(KEY, run) : Promise.resolve().then(run);
  channel?.unref?.(); // Node only (tests): an open channel would hold the process; browsers have no unref
  let shared = null, arrived = () => {}, delay = 2500, waiting = null;
  const take = expected => {
    const seconds = Math.min(86_400, Math.floor((shared.expiresAt - auth.now()) / 1000));
    return seconds > 30 && auth.state().stored === shared.refresh ? auth.adopt({ access_token: shared.access,
      refresh_token: shared.refresh, expires_in: seconds, user: { id: shared.userId } }, expected, false) : null;
  };
  // Removal elsewhere signs this tab out, aborting an in-flight restore too (RT6). A delayed
  // removal from the old session cannot erase a deliberate new sign-in now present in storage.
  events?.addEventListener('storage', event => {
    const state = auth.state();
    if ((event.key === KEY || event.key === null) && !event.newValue && (!state.stored || state.userId && state.stored !== state.known) && (state.userId || state.flight)) void auth.teardown('signed_out_elsewhere');
  });
  // A tab shown again after sleep refreshes a stale access token before anything uses it (RT5).
  events?.addEventListener('visibilitychange', () => {
    const state = auth.state();
    if (globalThis.document?.visibilityState !== 'hidden' && state.userId && auth.now() > state.until - 60_000) void auth.refresh();
  });
  channel?.addEventListener('message', ({ data }) => {
    if (typeof data?.access !== 'string' || typeof data.refresh !== 'string' || !isUuid(data.userId) ||
        !Number.isSafeInteger(data.expiresAt)) return;
    shared = data; arrived();
    const state = auth.state();
    if (state.userId === data.userId && state.known !== data.refresh && !state.flight)
      void serial(() => take(state.generation)).catch(() => {});
  });
  return {
    announce(session) { try { channel?.postMessage(session); } catch {} },
    serial,
    commit: (value, expected) => serial(() => auth.adopt(value, expected)),
    /** Sign out clears this device at once (synchronously with the click); then, never awaited, GoTrue is asked to
     *  revoke the session with a fresh access token (minted from the old refresh token when the access token is
     *  stale). The queued local fence removes any late rotation even when revocation cannot reach GoTrue. */
    signOut() {
      const { access, until, stored } = auth.state();
      const done = auth.teardown('sign_out');
      // Queue the fence synchronously behind any rotation already in progress. Sign-in commits
      // use the same lock and queue afterward; clearing storage must not advance their generation.
      void serial(() => auth.forget()).catch(() => {});
      void (async () => {
        const { supabaseUrl, publishableKey } = await auth.publicConfig();
        const token = access && auth.now() < until - 60_000 ? access : stored &&
        (await auth.request(auth.authApiUrl(supabaseUrl, 'refresh'), { refresh_token: stored }, publishableKey)).access_token;
        if (token) await auth.request(`${auth.authApiUrl(supabaseUrl, 'logout')}?scope=local`, {}, publishableKey, token);
      })().catch(() => {});
      return done;
    },
    /** A refresh failed on the network, a timeout or a 5xx: one pending retry, at the next 'online' event or an
     *  exponential backoff (5 s doubling to 5 min), never a tight loop. A recovered session tells the page. */
    retry(refresh) {
      if (waiting) return;
      const go = async () => {
        clearTimeout(waiting.timer); events?.removeEventListener('online', go); waiting = null;
        if (await refresh()) { delay = 2500; auth.onRecovered(); }
      };
      delay = Math.min(delay * 2, 300_000);
      waiting = { timer: setTimeout(go, delay) };
      events?.addEventListener('online', go);
    },
    /** Inside the lock: another tab rotated the token while this one waited, so take its session. */
    async adopted(token, seen, expected) {
      if (token === auth.state().known) return null;
      if (token !== seen && shared?.refresh !== token) await new Promise(resolve => { arrived = resolve; setTimeout(resolve, 1000); });
      return shared?.refresh === token ? take(expected) : null;
    },
  };
}

const base64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** The magic-link PKCE start (Card 11), moved out of auth.mjs's first load (card 38). `current()` is false once
 *  signed out or superseded by a newer start; a stale start never writes or removes the newer verifier. */
export async function beginMagicLink({ origin, sessionStorage, now, publicConfig, request, authApiUrl, current }, email) {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  if (!current()) throw new Error('auth_unavailable');
  const createdAt = now();
  const record = JSON.stringify({ verifier, createdAt, expiresAt: createdAt + 600_000 });
  try {
    if (!sessionStorage) throw new Error('auth_unavailable');
    sessionStorage.setItem(PKCE, record);
  }
  catch { throw new Error('auth_unavailable'); }
  try {
    const { supabaseUrl, publishableKey } = await publicConfig();
    if (!current()) throw new Error('auth_unavailable');
    await request(authApiUrl(supabaseUrl, 'otp', origin), {
      email, create_user: false, code_challenge: challenge, code_challenge_method: 's256',
    }, publishableKey);
    if (!current()) throw new Error('auth_unavailable');
  } catch {
    try { if (current() && sessionStorage?.getItem(PKCE) === record) sessionStorage.removeItem(PKCE); } catch {}
    throw new Error('auth_unavailable');
  }
}

/** The PKCE exchange of a magic-link callback (Card 11), moved out of auth.mjs's first load (card 38). auth.mjs has
 *  already validated the callback and stripped the one-use code from the address before loading this. */
export async function completeMagicLink({ sessionStorage, now, publicConfig, request, authApiUrl, adopt }, code) {
  if (!code || code.length > 512) throw new TypeError('invalid_callback');
  const pending = validPendingPkce(sessionStorage?.getItem(PKCE), now());
  sessionStorage?.removeItem(PKCE);
  if (!pending) throw new Error('auth_unavailable');
  const { supabaseUrl, publishableKey } = await publicConfig();
  return adopt(await request(authApiUrl(supabaseUrl, 'pkce'), { auth_code: code, code_verifier: pending.verifier }, publishableKey));
}
