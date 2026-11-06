import { normalizeCode, JOIN_CODE_LENGTH } from '../shared/ids.mjs';
import { turnstileWidgetScriptUrl } from '../shared/urls.mjs';

/** Only entry documents (/join, /J/<code>, /F/<code>) can load the optional widget. Playback/recap link back to /join on token loss. */
export function joinDocumentCsp(base, path) {
  // The join entry and the participant feedback page (CASE-284) may both show the optional challenge.
  const codeEntry = typeof path === 'string' && path.length === JOIN_CODE_LENGTH + 3
    && /^\/[JjFf]\//.test(path)
    && normalizeCode(path.slice(3), JOIN_CODE_LENGTH) !== null;
  if (path !== '/join' && !codeEntry) return base;
  if (typeof base !== 'string') throw new TypeError('Unsupported join policy');
  const directives = base.split(';').map(value => value.trim()).filter(Boolean);
  for (const expected of ["script-src 'self'", "require-trusted-types-for 'script'", 'trusted-types case-default', "frame-ancestors 'none'"]) {
    const name = expected.split(' ')[0];
    if (directives.filter(value => value.split(' ')[0] === name).length !== 1 || !directives.includes(expected) || (name !== 'trusted-types' && !base.includes(expected + ';'))) throw new TypeError('Unsupported join policy');
  }
  if (directives.some(value => value.startsWith('frame-src '))) throw new TypeError('Unsupported join policy');
  const origin = new URL(turnstileWidgetScriptUrl()).origin;
  return base.replace("script-src 'self';", `script-src 'self' ${origin};`)
    .replace("frame-ancestors 'none';", `frame-src ${origin}; frame-ancestors 'none';`)
    .replace('trusted-types case-default', 'trusted-types case-default case-turnstile');
}
