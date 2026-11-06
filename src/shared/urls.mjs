// src/shared/urls.mjs — the one place Case URLs are built and parsed.
//
// Rules (docs/ARCHITECTURE.md §URLs):
//   • QR / printed routes are SHORT, upper case, QR-alphanumeric only: /J/<join>, /D/<pair>, /P/<pair>.
//     The server matches them case-insensitively, so a hand-typed lower-case URL still works.
//   • App routes are lower case and carry UUIDv7 ids: /cases/<id>, /sessions/<id>/…
//   • API routes are same-origin and versioned: /api/v1/…
//   • Never a token, name or other personal datum in any URL.

import { JOIN_CODE_LENGTH, PAIR_CODE_LENGTH, isUuid, isUuidV7, normalizeCode } from './ids.mjs';

/** Fixed GoTrue endpoints. Neither credentials nor user input enter an Auth URL. */
export function authApiUrl(supabaseOrigin, operation, redirectOrigin = null) {
  const origin = new URL(supabaseOrigin);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' ||
      origin.search || origin.hash) throw new TypeError('Invalid Auth origin');
  const paths = {
    base: '/auth/v1/',
    otp: '/auth/v1/otp', verify: '/auth/v1/verify', logout: '/auth/v1/logout',
    refresh: '/auth/v1/token?grant_type=refresh_token', pkce: '/auth/v1/token?grant_type=pkce',
  };
  if (!Object.hasOwn(paths, operation)) throw new TypeError('Unknown Auth endpoint');
  const url = new URL(paths[operation], origin);
  if (redirectOrigin !== null) {
    if (operation !== 'otp') throw new TypeError('Auth redirect only applies to OTP start');
    const redirect = new URL(redirectOrigin);
    if (redirect.href !== redirect.origin + '/' || !['https:', 'http:'].includes(redirect.protocol))
      throw new TypeError('Invalid same-origin Auth redirect');
    url.searchParams.set('redirect_to', redirect.href);
  }
  return url.href;
}

export const ORIGIN = 'https://case.iatrogenic.app';

/** Token-free admin live-room continuation: one shard, optionally its last six-character code. */
export function parseAdminRoomsCursor(value) {
  if (value === null) return {shard:'0',afterCode:null};
  if (typeof value !== 'string' || !/^[0-9A-HJKMNP-TV-Z](?::[0-9A-HJKMNP-TV-Z]{6})?$/.test(value) ||
      value.length > 8) throw new TypeError('Invalid admin room cursor');
  const [shard,afterCode = null] = value.split(':');
  if (afterCode !== null && afterCode[0] !== shard) throw new TypeError('Invalid admin room cursor');
  return {shard,afterCode};
}

/** ISO/IEC 18004 alphanumeric-mode character set. */
export const QR_ALPHANUMERIC = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

/** Short-route prefixes. One letter each; upper case in QR, any case accepted. */
export const SHORT = Object.freeze({
  join: 'J', // participant joins a room
  display: 'D', // a projector/display window pairs to a session
  pair: 'P', // a shared PC asks a signed-in phone to approve a facilitator sign-in
});

const SHORT_LEN = { J: JOIN_CODE_LENGTH, D: PAIR_CODE_LENGTH, P: PAIR_CODE_LENGTH, F: JOIN_CODE_LENGTH };

export function isQrAlphanumeric(s) {
  for (const c of s) if (!QR_ALPHANUMERIC.includes(c)) return false;
  return true;
}

function short(prefix, code, origin) {
  const c = normalizeCode(code, SHORT_LEN[prefix]);
  if (!c) throw new TypeError(`invalid ${prefix} code: ${code}`);
  return `${origin}/${prefix}/${c}`;
}

/** Human-readable join URL for printing on the projector: https://case.iatrogenic.app/J/7K3QX9 */
export const privacyUrl = (origin = ORIGIN) => `${origin}/privacy`;
/** Card 29 (CASE-166): the participant-first root, the facilitator catalogue and the network check. */
export const homeUrl = (origin = ORIGIN) => `${origin}/`;
export const presentUrl = (origin = ORIGIN) => `${origin}/present`;
export const createUrl = (origin = ORIGIN) => `${origin}/create`;
// Retained export names are source-compatible; new navigation uses the canonical destinations.
export const casesUrl = presentUrl;
/** Addressable private inventory; workspace IDs select context, never grant authority. */
export function caseWorkspaceUrl(workspaceId = null, section = 'published', origin = ORIGIN) {
  if (!['published', 'drafts', 'new'].includes(section) || workspaceId !== null && !isUuidV7(workspaceId)) throw new TypeError('Invalid case workspace');
  const url = new URL(section === 'new' ? '/create/new' : section === 'drafts' ? '/create' : '/present', origin);
  if (workspaceId) url.searchParams.set('workspace', workspaceId);
  return url.href;
}
export function parseCaseWorkspace(input) {
  try { const url = new URL(input, ORIGIN); return { drafts: url.pathname === '/create' || url.pathname === '/create/new' || url.pathname === '/cases' && url.searchParams.get('view') === 'drafts', workspaceId: isUuidV7(url.searchParams.get('workspace')) ? url.searchParams.get('workspace') : null }; }
  catch { return { drafts: false, workspaceId: null }; }
}

export const checkUrl = (origin = ORIGIN) => `${origin}/check`;
/** Device-local menu destinations never carry a room capability or personal datum. */
export const helpUrl = (origin = ORIGIN) => `${adminOrigin(origin)}/help`;
export const accountUrl = (origin = ORIGIN) => `${adminOrigin(origin)}/account`;
export function sessionsUrl(origin = ORIGIN, workspaceId = null, caseId = null) {
  if (workspaceId !== null && !isUuidV7(workspaceId)) throw new TypeError('Invalid session workspace');
  if (caseId !== null && (!isUuidV7(caseId) || workspaceId === null)) throw new TypeError('Invalid session case');
  const url = new URL('/sessions', adminOrigin(origin)); if (workspaceId) url.searchParams.set('workspace', workspaceId); if (caseId) url.searchParams.set('case', caseId); return url.href;
}
export const historyUrl = sessionsUrl;
export const sessionRecordUrl = (sessionId, origin = ORIGIN) => `${adminOrigin(origin)}/sessions/${need(sessionId)}`;
/** Browser-only alias replacement; no HTTP redirects, credentials, callback or invitation rewriting. */
export function canonicalAppUrl(input) {
  const url = new URL(input, ORIGIN), workspace = parseCaseWorkspace(url.href).workspaceId;
  if (url.pathname === '/admin.html' || url.pathname === '/admin') return adminPageUrl(url.origin);
  if (url.pathname === '/cases') return caseWorkspaceUrl(workspace, parseCaseWorkspace(url.href).drafts ? 'drafts' : 'published', url.origin);
  if (url.pathname === '/cases/new') return caseWorkspaceUrl(workspace, 'new', url.origin);
  if (url.pathname === '/history') { const next = new URL(sessionsUrl(url.origin)); if (workspace) next.searchParams.set('workspace', workspace); return next.href; }
  const route=parseRoute(url.pathname);if(route?.route==='case-map')return caseUrl(route.caseId,url.origin);
  return url.href;
}
export const joinEntryUrl = (origin = ORIGIN) => `${origin}/join`;
export const joinUrl = (code, origin = ORIGIN) => short(SHORT.join, code, origin);
export const displayPairUrl = (code, origin = ORIGIN) => short(SHORT.display, code, origin);
export const devicePairUrl = (code, origin = ORIGIN) => short(SHORT.pair, code, origin);
// CASE-284 (D8): participant feedback for an ended room, /F/<never-reused code>. Kept out of SHORT and parseRoute so the
// shared chunk every surface loads grows by this one builder; API paths use apiPath('feedback', code).
export const feedbackUrl = (code, origin = ORIGIN) => short('F', code, origin);

/**
 * QR payload: the same URL upper-cased so every character is QR-alphanumeric.
 * Scheme and host are case-insensitive by RFC 3986; short routes are matched
 * case-insensitively by the Worker, so this round-trips.
 */
export function qrPayload(url) {
  const u = url.toUpperCase();
  if (!isQrAlphanumeric(u)) throw new TypeError(`not QR-alphanumeric: ${url}`);
  return u;
}

/**
 * Parse any Case URL path (or full URL) into a route. Returns null for unknown paths.
 * @returns {{route:string, code?:string, caseId?:string, sessionId?:string, versionNo?:number}|null}
 */
export function parseRoute(input) {
  let path = input;
  try { path = new URL(input, ORIGIN).pathname; } catch { return null; }
  const seg = path.split('/').filter(Boolean);

  if (seg.length === 2 && /^[jdp]$/i.test(seg[0])) {
    const prefix = seg[0].toUpperCase();
    const code = normalizeCode(seg[1], SHORT_LEN[prefix]);
    if (!code) return null;
    const route = { J: 'join', D: 'display-pair', P: 'device-pair' }[prefix];
    return { route, code };
  }
  if (seg.length === 1 && seg[0] === 'join') return { route: 'join' };
  // CASE-341: the invitation page. Its reference is the URL fragment, which never reaches a server or this parser.
  if (seg.length === 1 && seg[0] === 'i') return { route: 'invite' };
  if (seg.length === 1 && seg[0] === 'privacy') return { route: 'privacy' };
  if (seg.length === 1 && ['help', 'account', 'history','admin'].includes(seg[0])) return { route: seg[0] };
  if (seg.length === 1 && ['present', 'create'].includes(seg[0])) return { route: 'cases' };
  if (seg.length === 1 && seg[0] === 'sessions') return { route: 'history' };
  if (seg.length === 2 && seg[0] === 'create' && seg[1] === 'new') return { route: 'case-new' };
  const id = (s) => (s && isUuid(s) ? s : null);
  if (seg[0] === 'cases') {
    if (seg.length === 1) return { route: 'cases' };
    if (seg.length === 2 && seg[1] === 'new') return { route: 'case-new' };
    const caseId = id(seg[1]);
    if (!caseId) return null;
    if (seg.length === 2) return { route: 'case', caseId };
    if (seg.length === 3 && seg[2] === 'edit') return { route: 'case-edit', caseId };
    if (seg.length === 4 && seg[2] === 'edit' && ['workflows', 'preview', 'overview'].includes(seg[3]))
      return { route: 'case-edit', caseId, view: seg[3] };
    if ([6, 7].includes(seg.length) && seg[2] === 'edit' && seg[3] === 'source' && /^[1-9]\d*$/.test(seg[5]) &&
        (seg.length === 6 || ['workflows', 'preview', 'restore', 'overview'].includes(seg[6]))) {
      const versionId = id(seg[4]);
      const versionNo = Number(seg[5]);
      if (versionId && Number.isSafeInteger(versionNo) && versionNo > 0)
        return { route: 'case-edit', caseId, sourceVersion: { versionId, versionNo }, ...(seg.length === 7 ? { view: seg[6] } : {}) };
    }
    if (seg.length === 3 && seg[2] === 'map') return { route: 'case-map', caseId };
    if (seg.length === 4 && seg[2] === 'v' && /^[1-9]\d*$/.test(seg[3])) {
      return { route: 'case-version', caseId, versionNo: Number(seg[3]) };
    }
    return null;
  }
  if (seg[0] === 'sessions' && seg.length === 2) {
    const sessionId = id(seg[1]); return sessionId ? { route: 'session-record', sessionId } : null;
  }
  if (seg[0] === 'sessions' && seg.length === 3) {
    const sessionId = id(seg[1]);
    const role = { facilitate: 'facilitate', display: 'display', play: 'play', recap: 'recap' }[seg[2]];
    return sessionId && role ? { route: role, sessionId } : null;
  }
  return null;
}

// App-route builders (lower case, UUIDs).
const need = (x) => { if (!isUuid(x)) throw new TypeError(`not a UUID: ${x}`); return x; };
export const caseUrl = (caseId, origin = ORIGIN) => `${origin}/cases/${need(caseId)}`;
export const caseNewUrl = (origin = ORIGIN) => `${origin}/create/new`;
export const caseEditUrl = (caseId, origin = ORIGIN) => `${origin}/cases/${need(caseId)}/edit`;
export function caseEditWorkspaceUrl(caseId, workspaceId, origin = ORIGIN) {
  if (!isUuidV7(workspaceId)) throw new TypeError('Invalid case workspace');
  const url = new URL(caseEditUrl(caseId, origin)); url.searchParams.set('workspace', workspaceId); return url.href;
}

export const caseEditViewUrl = (caseId, view, origin = ORIGIN) => {
  if (!['editor', 'workflows', 'preview', 'overview'].includes(view)) throw new TypeError(`bad Builder view: ${view}`);
  return `${caseEditUrl(caseId, origin)}${view === 'editor' ? '' : `/${view}`}`;
};
export const caseEditSourceUrl = (caseId, sourceVersion, origin = ORIGIN) => {
  need(caseId);
  if (!sourceVersion || !isUuid(sourceVersion.versionId) || !Number.isSafeInteger(sourceVersion.versionNo) || sourceVersion.versionNo < 1)
    throw new TypeError('bad source version');
  return `${origin}/cases/${caseId}/edit/source/${sourceVersion.versionId}/${sourceVersion.versionNo}`;
};
export const caseEditSourceViewUrl = (caseId, sourceVersion, view, origin = ORIGIN) => {
  if (!['editor', 'workflows', 'preview', 'restore', 'overview'].includes(view)) throw new TypeError(`bad Builder view: ${view}`);
  const base = caseEditSourceUrl(caseId, sourceVersion, origin);
  return view === 'editor' ? base : `${base}/${view}`;
};
export const caseMapUrl = (caseId, origin = ORIGIN) => `${origin}/cases/${need(caseId)}/map`;
export const caseVersionUrl = (caseId, versionNo, origin = ORIGIN) => {
  if (!Number.isInteger(versionNo) || versionNo < 1) throw new TypeError(`bad version: ${versionNo}`);
  return `${origin}/cases/${need(caseId)}/v/${versionNo}`;
};
export const sessionUrl = (sessionId, role, origin = ORIGIN) => {
  if (!['facilitate', 'display', 'play', 'recap'].includes(role)) throw new TypeError(`bad role: ${role}`);
  return `${origin}/sessions/${need(sessionId)}/${role}`;
};

/** Same-PC display has no stored display credential; it receives only role-projected local frames. */
export const samePcProjectorUrl = (sessionId, origin = ORIGIN) =>
  `${sessionUrl(sessionId, 'display', origin)}?topology=same-pc`;

/** An opaque browser-local handle for an explicit text-only notes download. */
export function localNotesObjectUrl(blob, urlClass = URL) {
  if (!(blob instanceof Blob) || blob.type !== 'text/plain;charset=utf-8')
    throw new TypeError('Invalid notes blob');
  return urlClass.createObjectURL(blob);
}

/** Explicit private PDF/JSON export handles. Never cached or stored by the application. */
export function sessionRecordObjectUrl(blob, urlClass = URL) {
  if (!(blob instanceof Blob) || !['application/pdf', 'application/json'].includes(blob.type))
    throw new TypeError('Invalid record blob');
  return urlClass.createObjectURL(blob);
}

/** An authored link (Julian, 2026-10-17): https, a host, no credentials or whitespace; its canonical href, else null. */
export function httpsHref(t) {
  try { const u = new URL(t); return typeof t == 'string' && t.length <= 2000 && /^https:\/\/[^\s\\/?#@][^\s\\]*$/i.test(t) && !u.username && !u.password ? u.href : null; } catch { return null; }
}
/** Stored media bytes, shown through a browser-local handle (card 59). Only a JPEG, GIF or MP4 blob is admitted. */
export function mediaObjectUrl(blob, urlClass = URL) {
  if (!(blob instanceof Blob) || !['image/jpeg', 'image/gif', 'video/mp4'].includes(blob.type)) throw new TypeError('Invalid image blob');
  return urlClass.createObjectURL(blob);
}
const mediaRendition = rendition => { if (!['display', 'phone', 'poster'].includes(rendition)) throw new TypeError('bad rendition'); return rendition; };
/** Builder image routes (card 59 M2): ids only, never a name, file name or token. */
export const builderMediaUploadPath = (workspaceId, rendition) => apiPath('builder', 'workspaces', need(workspaceId), 'media', mediaRendition(rendition));
export const builderAssetsPath = workspaceId => apiPath('builder', 'workspaces', need(workspaceId), 'assets');
export const builderAssetRenditionPath = (workspaceId, assetId, rendition) => apiPath('builder', 'workspaces', need(workspaceId), 'assets', need(assetId), mediaRendition(rendition));
/** A released room image (card 59 M3): the session and the room's opaque handle, the credential in the header only. */
export const roomMediaPath = (sessionId, handle, rendition) => apiPath('sessions', need(sessionId), 'media', need(handle), mediaRendition(rendition));
/** The case place's image routes (CASE-342, plan §3 A6): a Can edit grant uploads and reads here; ids only. */
export const builderCaseMediaUploadPath = (caseId, rendition) => apiPath('builder', 'cases', need(caseId), 'media', mediaRendition(rendition));
export const builderCaseAssetsPath = caseId => apiPath('builder', 'cases', need(caseId), 'assets');
export const builderCaseAssetRenditionPath = (caseId, assetId, rendition) => apiPath('builder', 'cases', need(caseId), 'assets', need(assetId), mediaRendition(rendition));
export const builderAssetWithdrawPath = (workspaceId, assetId) => apiPath('builder', 'workspaces', need(workspaceId), 'assets', need(assetId), 'withdraw');

/** Versioned same-origin API path. */
export const apiPath = (...parts) => `/api/v1/${parts.map(encodeURIComponent).join('/')}`;
export const apiUrl = (origin, ...parts) => new URL(apiPath(...parts), origin).href;

/**
 * The invitation link (CASE-341, the one narrowing of hard rule 4): `/i/#<ref>`. The reference is a 32-byte random
 * base64url string in the FRAGMENT, so it never reaches a server log; the page POSTs it in a body to the peek endpoint,
 * and the database keeps only its SHA-256. It carries no address, name or id.
 */
export const INVITE_REF = /^[A-Za-z0-9_-]{43}$/;
export function inviteUrl(ref, origin = ORIGIN) {
  if (typeof ref !== 'string' || !INVITE_REF.test(ref)) throw new TypeError('Invalid invitation reference');
  return `${adminOrigin(origin)}/i/#${ref}`;
}
export const invitePageUrl = (origin = ORIGIN) => `${adminOrigin(origin)}/i/`;
/** The reference from a location hash (`#<ref>`), or null. */
export function parseInviteFragment(hash) {
  const ref = typeof hash === 'string' && hash.startsWith('#') ? hash.slice(1) : null;
  return ref !== null && INVITE_REF.test(ref) ? ref : null;
}
export const invitationPeekPath = () => apiPath('invitations', 'peek');

/** Fixed Resend endpoint for Case's own emails (alerts, CASE-340 invitations); keys go only in a header. */
export const resendEmailsUrl = () => 'https://api.resend.com/emails';

/** Fixed third-party verifier endpoint; credentials and tokens belong only in the POST body. */
export const turnstileSiteverifyUrl = () => 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Fixed explicit-render widget script; public site keys stay in render options. */
export const turnstileWidgetScriptUrl = () => 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

/** Fixed service-role GoTrue paths. Only numeric paging and an exact redirect origin enter queries. */
export function adminAuthUrl(supabaseOrigin, operation, options = {}) {
  const base = authApiUrl(supabaseOrigin, 'base');
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new TypeError('Invalid admin Auth options');
  const keys = Object.keys(options);
  // CASE-340: Case creates an invited account itself (email_confirm: true) and sends its own email; GoTrue sends none.
  if (operation === 'user_create') {
    if (keys.length) throw new TypeError('Invalid admin Auth options');
    return new URL('admin/users', base).href;
  }
  if (['user_read', 'user_update', 'user_delete'].includes(operation)) {
    if (keys.length !== 1 || keys[0] !== 'userId' || !isUuid(options.userId))
      throw new TypeError('Invalid admin Auth user');
    return new URL(`admin/users/${options.userId}`, base).href;
  }
  if (operation === 'users') {
    if (keys.some(key => !['page', 'perPage'].includes(key)))
      throw new TypeError('Invalid admin Auth options');
    const page = options.page ?? 1;
    const perPage = options.perPage ?? 100;
    if (!Number.isSafeInteger(page) || page < 1 || page > 100_000 ||
        !Number.isSafeInteger(perPage) || perPage < 1 || perPage > 1_000)
      throw new TypeError('Invalid admin Auth paging');
    const url = new URL('admin/users', base);
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', String(perPage));
    return url.href;
  }
  if (operation === 'invite' || operation === 'invite_resend') {
    if (keys.length !== 1 || keys[0] !== 'redirectOrigin')
      throw new TypeError('Invalid admin Auth options');
    const redirect = new URL(options.redirectOrigin);
    if (redirect.protocol !== 'https:' || redirect.username || redirect.password ||
        redirect.href !== `${redirect.origin}/`)
      throw new TypeError('Invalid admin Auth redirect');
    const url = new URL('invite', base);
    url.searchParams.set('redirect_to', redirect.href);
    return url.href;
  }
  if (keys.length || !['otp', 'verify'].includes(operation))
    throw new TypeError('Unknown admin Auth endpoint');
  return authApiUrl(supabaseOrigin, operation);
}

// Card21b: fixed same-origin private API inventory. Personal inputs belong in JSON/header only.
const ADMIN_PATHS = Object.freeze({
  workspaces_query:'workspaces/query', workspace_query:'workspace/query', membership_change:'memberships/change', operations_query:'operations/query',
  stepup_start:'stepup/start', stepup_verify:'stepup',
  facilitators_list:'facilitators', facilitators_search:'facilitators/search',
  facilitators_disable:'facilitators/:id/disable',
  facilitators_enable:'facilitators/:id/enable', facilitators_soft_delete:'facilitators/:id/soft-delete', facilitators_restore:'facilitators/:id/restore', facilitators_label:'facilitators/:id/label',
  cases_list:'cases', cases_publish:'cases/:id/publish', versions_withdraw:'versions/:id/withdraw',
  rooms_list:'rooms', rooms_end:'rooms/:id/end', audit_list:'audit',
});
function adminOrigin(value) {
  const u=new URL(value);
  if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.pathname!=='/'||u.search||u.hash) throw new TypeError('Invalid admin origin');
  return u.origin;
}
export const adminPageUrl=(origin=ORIGIN)=>`${adminOrigin(origin)}/admin`;
export function adminApiUrl(origin,operation,options={}) {
  if(!Object.hasOwn(ADMIN_PATHS,operation)||!options||typeof options!=='object'||Array.isArray(options)) throw new TypeError('Invalid admin operation');
  const list=operation==='facilitators_list'?'users':['cases_list','audit_list','rooms_list'].includes(operation)?'cursor':null;
  const template=ADMIN_PATHS[operation],target=template.includes(':id');
  const allowed=target?['id']:list==='users'?['page','perPage']:list==='cursor'?['limit','after']:[];
  if(Object.keys(options).some(key=>!allowed.includes(key)))throw new TypeError('Invalid admin options');
  let path=template;
  if(target){
    const auth=operation.startsWith('facilitators_');
    if(!(auth?isUuid(options.id):isUuidV7(options.id)))throw new TypeError('Invalid admin target');
    path=template.replace(':id',options.id);
  }
  const url=new URL(`/api/v1/admin/${path}`,adminOrigin(origin));
  for(const key of ['page','perPage','limit'])if(options[key]!==undefined){
    const max=key==='page'?100000:key==='perPage'?1000:100;
    if(!Number.isSafeInteger(options[key])||options[key]<1||options[key]>max)throw new TypeError('Invalid admin page');
    url.searchParams.set(key,String(options[key]));
  }
  if(options.after!==undefined&&options.after!==null){
    const after=options.after;
    const valid=operation==='rooms_list'?typeof after==='string'&&/^[0-9A-HJKMNP-TV-Z](?::[0-9A-HJKMNP-TV-Z]{6})?$/.test(after):isUuidV7(after);
    if(!valid||(operation==='rooms_list'&&after.includes(':')&&after[0]!==after[2]))throw new TypeError('Invalid admin cursor');
    url.searchParams.set('after',after);
  }
  return url.href;
}

/** Public, content-versioned branding only; never includes recipient or case data. */
export const emailArtUrl = () => `${ORIGIN}/email/d6b53814afe5.jpg`;
