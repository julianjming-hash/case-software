// Account navigation preservation policy, independent of destructive storage machinery.
/** CASE-175: a tab's room marker (an id); the reasons that end the account session. */
export const ACTIVE_ROOM_KEY = 'case:console:active-room';
const PKCE_MS = 10 * 60_000;
export function validPendingPkce(value, nowMs = Date.now()) {
  try {
    if (typeof value !== 'string' || value.length > 256) return null;
    const record = JSON.parse(value);
    if (!record || Object.keys(record).sort().join(',') !== 'createdAt,expiresAt,verifier' ||
        typeof record.verifier !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(record.verifier) ||
        !Number.isSafeInteger(record.createdAt) || !Number.isSafeInteger(record.expiresAt) ||
        record.createdAt > nowMs || record.expiresAt <= nowMs ||
        record.expiresAt - record.createdAt !== PKCE_MS) return null;
    return record;
  } catch { return null; }
}
