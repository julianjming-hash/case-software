import { turnstileWidgetScriptUrl } from '../shared/urls.mjs';

const policies = new WeakMap();
const validKey = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[^A-Za-z0-9_-]/.test(value);
const validToken = value => typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\s\u0000-\u001f\u007f]/.test(value);
const notify = (callback, value) => { try { Promise.resolve(callback?.(value)).catch(() => {}); } catch {} };

function scriptUrl(trustedTypes) {
  const url = turnstileWidgetScriptUrl();
  if (!trustedTypes) return url;
  let policy = policies.get(trustedTypes);
  if (!policy) {
    policy = trustedTypes.createPolicy('case-turnstile', { createScriptURL(value) {
      if (value !== url) throw new TypeError('Unsupported script URL');
      return url;
    } });
    policies.set(trustedTypes, policy);
  }
  return policy.createScriptURL(url);
}

/** Optional challenge UI. Tokens remain in this controller and never gate a valid-code submission. */
export function createTurnstileController(container, {
  documentImpl = container.ownerDocument, windowImpl = globalThis,
  trustedTypesImpl = windowImpl.trustedTypes, onToken, onUnavailable, loaderTimeoutMs = 3000,
} = {}) {
  let closed = false, generation = 0, token = null, widget = null, api = null, cancelLoad = null;
  const budget = Number.isFinite(loaderTimeoutMs) && loaderTimeoutMs > 0 ? Math.min(loaderTimeoutMs, 3000) : 3000;
  const unavailable = () => notify(onUnavailable, 'challenge_unavailable');
  function removeWidget() {
    if (widget !== null) { try { Promise.resolve(api?.remove(widget)).catch(() => {}); } catch {} }
    widget = null;
  }
  function load() {
    if (typeof windowImpl.turnstile?.render === 'function') return Promise.resolve(windowImpl.turnstile);
    return new Promise(resolve => {
      let script, timer, settled = false;
      const finish = result => {
        if (settled) return;
        settled = true; clearTimeout(timer); cancelLoad = null;
        if (!result) { try { script?.remove(); } catch {} }
        resolve(result);
      };
      cancelLoad = () => finish(null);
      timer = setTimeout(() => finish(null), budget);
      try {
        script = documentImpl.createElement('script');
        script.src = scriptUrl(trustedTypesImpl); script.async = true;
        script.onload = () => finish(typeof windowImpl.turnstile?.render === 'function' ? windowImpl.turnstile : null);
        script.onerror = () => finish(null);
        documentImpl.head.appendChild(script);
      } catch { finish(null); }
    });
  }
  return {
    async challenge(siteKey) {
      if (closed) return false;
      const current = ++generation; token = null; cancelLoad?.(); removeWidget();
      if (!validKey(siteKey)) { unavailable(); return false; }
      const loaded = await load();
      if (closed || current !== generation) return false;
      if (!loaded) { unavailable(); return false; }
      api = loaded;
      const active = () => !closed && current === generation;
      try {
        widget = api.render(container, {
          sitekey: siteKey, action: 'join',
          callback(value) { if (!active()) return; token = validToken(value) ? value : null; if (token) notify(onToken, token); },
          'expired-callback'() { if (active()) token = null; },
          'error-callback'() { if (active()) { token = null; unavailable(); } },
        });
        return true;
      } catch { token = null; unavailable(); return false; }
    },
    takeToken() { const value = token; token = null; return value; },
    close() { if (closed) return; closed = true; generation++; token = null; cancelLoad?.(); removeWidget(); },
  };
}
