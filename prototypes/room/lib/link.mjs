// prototypes/room/lib/link.mjs: one switch between the stage C lab bus and the real Worker.
//
// Every room window imports `connect` from here. Without `?api=` in the page URL it is the lab bus
// (lib/bus.mjs), unchanged. With `?api=<origin>&session=<uuid>` it is the real client transport
// (src/client/transport.mjs) against that Worker, for the facilitator, the display and the phone:
//
//   facilitator.html?api=http://127.0.0.1:4173&session=<uuid>
//   display.html?api=…&session=<uuid>        (after pairing; see pair-display.html)
//   phone.html?api=…                         (the phone learns the session from POST /join)
//   optional &scale=0.2                       shrink every transport timing (tests and demos)
//
// Tokens never go in these URLs. Where each one comes from, and where it is kept (CASE-103, CASE-106):
//   • phone: POST /join; the transport keeps it in localStorage until the recap expires;
//   • display: pair-display.html pairs it for real (POST /display-pairs, number matching on the
//     console), stores the token in sessionStorage and opens display.html;
//   • facilitator: held in MEMORY ONLY. DEV AND TESTS ONLY, until Phase 1b's sign-in UI, it is handed
//     over by putting `{sessionId, token}` in this tab's sessionStorage under
//     `case:facilitator:main:token` before the page loads (Playwright: `context.addInitScript`), e.g.
//     with the `facilitatorToken` from `POST /api/v1/sessions`. The page reads it once and removes it.
// The Worker is same-origin only (no CORS): serve the windows and the API from one origin, e.g.
// `CASE_API_PROXY=<worker origin> node scripts/serve-prototypes.mjs` (docs/RUNBOOK-LOCAL.md).
import { connect as labConnect } from './bus.mjs';
import { connect as realConnect, storedCredential, credentialKey, apiOrigin } from '../../../src/client/transport.mjs';

export * from './bus.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The real-room parameters of this page, or null in the lab. */
export function realRoom(search = globalThis.location?.search ?? '') {
  const p = new URLSearchParams(search);
  const raw = p.get('api');
  if (!raw) return null;
  let api;
  try { api = apiOrigin(raw); } catch { return null; }
  const session = p.get('session');
  const scale = Math.min(1, Math.max(0.05, Number(p.get('scale')) || 1));
  return { api, sessionId: session && UUID.test(session) ? session : null, scale };
}

/** URL of a sibling window in the same real room (no token, ever). */
export function roomUrl(page, room, extra = {}) {
  const q = new URLSearchParams({ api: room.api, ...(room.sessionId ? { session: room.sessionId } : {}), ...(room.scale !== 1 ? { scale: String(room.scale) } : {}), ...extra });
  return `${page}?${q}`;
}

export function connect(opts) {
  const room = realRoom();
  if (!room) return labConnect(opts);
  const stored = storedCredential(opts.role, opts.slot ?? null);
  if (opts.role === 'display' && (!stored || (room.sessionId && stored.sessionId !== room.sessionId))) {
    // Not paired in this tab yet: pair for real first.
    location.replace(roomUrl('pair-display.html', { ...room, sessionId: null }, opts.topology ? { topology: opts.topology } : {}));
  }
  let token = null;
  let sessionId = room.sessionId;
  if (opts.role === 'facilitator') {
    // The dev hand-off is consumed: from here the token lives only in this page's memory (CASE-103).
    const handed = storedCredential('facilitator', opts.slot ?? null);
    try { sessionStorage.removeItem(credentialKey('facilitator', opts.slot ?? null)); } catch { /* private mode */ }
    if (handed && (!sessionId || handed.sessionId === sessionId)) ({ token, sessionId } = handed);
  }
  const link = realConnect({ ...opts, api: room.api, sessionId, token, timeScale: room.scale });
  if (opts.role === 'display') {
    // A display whose token stops working (room deleted, re-pair needed) goes back to pairing.
    link.on('error', (e) => {
      if (e === 'unauthorised' || e === 'unknown_room') { link.forget(); location.replace(roomUrl('pair-display.html', { ...room, sessionId: null })); }
    });
  }
  return link;
}
