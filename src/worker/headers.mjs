import { joinDocumentCsp } from './join-policy.mjs';
import { WIRE_VERSION } from '../shared/wire.mjs';
import { authApiUrl } from '../shared/urls.mjs';
import { selectedAuthOrigin } from './console-pairs.mjs';

// Every HTTP surface uses this policy; content and user input never enter headers.
export const HTML_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; require-trusted-types-for 'script'; trusted-types case-default";
const JSON_CSP = "default-src 'none'; frame-ancestors 'none'";
const KINDS = new Set(['json', 'html', 'join-html', 'asset', 'immutable-asset', 'ws-refusal']);

export function buildInfo(env = {}) {
  return { build: typeof env.BUILD_SHA === 'string' && env.BUILD_SHA.length === 40 && /^[0-9a-f]{40}$/.test(env.BUILD_SHA) ? env.BUILD_SHA : 'unconfigured',
    env: ['production', 'staging'].includes(env.CASE_ENV) ? env.CASE_ENV : 'local', wire: WIRE_VERSION };
}

/** Asset defaults to no-store. Only a caller that verified a content-hashed path uses immutable-asset. */
export function withSecurityHeaders(response, kind = 'json', env = {}) {
  if (!KINDS.has(kind)) throw new TypeError('Unknown response kind');
  const headers = new Headers(response.headers);
  headers.set('x-case-build', buildInfo(env).build);
  headers.set('cache-control', kind === 'immutable-asset' ? 'public, max-age=31536000, immutable' : 'no-store');
  const isHtml = kind === 'html' || kind === 'join-html';
  const authOrigin = isHtml ? selectedAuthOrigin(env) : null;
  const htmlCsp = authOrigin ? HTML_CSP.replace("connect-src 'self';",
    `connect-src 'self' ${authApiUrl(authOrigin, 'base')};`) : HTML_CSP;
  // A stored image, GIF or video (card 59) is shown only as media: sandboxed, same-origin, never cached by a browser or proxy.
  const image = kind === 'json' && ['image/jpeg', 'image/gif', 'video/mp4'].includes(headers.get('content-type'));
  if (image) { headers.set('cache-control', 'private, no-store'); headers.set('cross-origin-resource-policy', 'same-origin'); }
  headers.set('content-security-policy', kind === 'join-html' ? joinDocumentCsp(htmlCsp, '/join') : isHtml ? htmlCsp : image ? `${JSON_CSP}; sandbox` : JSON_CSP);
  headers.set('strict-transport-security', 'max-age=63072000; includeSubDomains');
  headers.set('permissions-policy', 'camera=(), screen-wake-lock=(self), window-management=(self)');
  headers.set('cross-origin-opener-policy', 'same-origin');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  // workerd requires the socket explicitly when rebuilding a 101 response.
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers,
    ...(response.webSocket ? { webSocket: response.webSocket } : {}) });
}
