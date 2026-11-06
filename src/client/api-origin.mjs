/** Normalise an API base to its origin; throws on anything that is not http(s). */
export function apiOrigin(api) {
  const u = new URL(api);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('api must be an http(s) origin');
  return u.origin;
}
