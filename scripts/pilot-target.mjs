// Admission for the owner-run load tool. Evaluate before reading credentials or opening a socket.
export const STAGING_ORIGIN = 'https://case-staging.iatrogenic.app';

export function resolvePilotTarget({ target = null, own = false } = {}) {
  if (target === null) {
    if (own) throw new TypeError('ownership acknowledgement requires --target');
    return { kind: 'local', origin: null };
  }
  if (target !== STAGING_ORIGIN) throw new TypeError('target refused');
  if (own !== true) throw new TypeError('staging target requires ownership acknowledgement');
  return { kind: 'staging', origin: STAGING_ORIGIN };
}
