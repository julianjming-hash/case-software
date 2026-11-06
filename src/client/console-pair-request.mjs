import { apiUrl } from '../shared/urls.mjs';

// One deadline covers headers and the complete body. Abort is a hint to fetch;
// the race also settles when a broken stream ignores its signal.
export async function requestConsolePair({ origin, parts, method = 'GET', secret = null, body,
  large = false, fetchImpl = fetch, timeoutMs = 10_000, controllers = null } = {}) {
  const controller = new AbortController();
  controllers?.add(controller);
  const duration = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(10_000, timeoutMs)) : 10_000;
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => {
    controller.abort(); reject(new Error('pair_unavailable'));
  }, duration); });
  try {
    const response = await Promise.race([fetchImpl(apiUrl(origin, ...parts), {
      method, cache: 'no-store', credentials: 'omit', redirect: 'manual', signal: controller.signal,
      headers: { ...(secret ? { authorization: `Bearer ${secret}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), deadline]);
    if (!response.ok || response.status >= 300) throw new Error('pair_unavailable');
    const text = await Promise.race([response.text(), deadline]);
    if (typeof text !== 'string' || text.length > (large ? 65_536 : 1024)) throw new Error('pair_unavailable');
    return JSON.parse(text);
  } catch { throw new Error('pair_unavailable'); }
  finally { clearTimeout(timer); controllers?.delete(controller); }
}
