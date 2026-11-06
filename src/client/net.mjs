/** A real server failure is an error response, never proof that the network is offline. */
export async function fetchResult(url, init = {}, fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(url, { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', ...init });
    return { response, offline: response.status === 503 && response.headers.get('x-case-offline') === '1' };
  } catch (error) {
    if (error instanceof TypeError) return { response: null, offline: true };
    throw error;
  }
}
