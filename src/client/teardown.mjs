// One cleanup path for sign-out, room end, idle lock, account change and tab close.
// The broad Case prefixes intentionally catch a newly added key until the inventory is updated.
import { isUuidV7 } from '../shared/ids.mjs';
import { storageBarrier } from './storage-barrier.mjs';
import { STORAGE_FENCE_KEY, advanceStorageGeneration } from './storage-generation.mjs';
export const TEARDOWN_KEYS = Object.freeze({
  sessionPrefixes: Object.freeze(['case:', 'case-lab:']),
  localPrefixes: Object.freeze(['case:', 'case-lab:']),
  keepOnly: 'case:transport:pin',
  // Device preferences that are not personal data (card 29: Appearance) survive every teardown.
  preferences: Object.freeze(['case:appearance', 'case:audio:music-volume', 'case:audio:effects-volume', 'case:preferences:ui-tones', 'case:preferences:timeline-collapsed', 'case:preferences:motion', 'case:preferences:console-split',
    'case:console:timer-seconds']), // the console's last timer pick (CASE-320)
  knownKeyPrefixes: Object.freeze(['case-lab:segment:']),
  knownExact: Object.freeze(['case:auth:refresh', 'case:auth:pkce', 'case:transport:pin', 'case:appearance', 'case:audio:music-volume', 'case:audio:effects-volume', 'case:preferences:ui-tones', 'case:preferences:timeline-collapsed', 'case:preferences:motion', 'case:preferences:console-split', 'case:console:timer-seconds',
    STORAGE_FENCE_KEY,'case:privacy-return-search','case:phone:join-code-draft','case:console:active-room']),
  // case:feedback:<session>:key is a random browser key for one room's feedback (CASE-284), purged when it expires.
  // case:finish:<session>:saved is a content-free session flag: this tab saved feedback from the Finish block (room PDFs v2).
  knownPatterns: Object.freeze([/^case:(?:(?:participant|display|facilitator):[^:]+:token|feedback:[^:]+:key|finish:[^:]+:saved)$/,
    /^case:join-code-draft:[^:]+$/, /^case-lab:segment:[^:]+$/,
    /^case-lab:(?:participant|display|facilitator):[^:]+:token$/]),
  knownDatabases: Object.freeze(['case:phone-outbox']),
  shellCachePrefix: 'case-shell-',
  indexedDBPrefixes: Object.freeze(['case:', 'case-lab:']),
});

const isCaseKey = key => TEARDOWN_KEYS.sessionPrefixes.some(prefix => key.startsWith(prefix));
const knownKey = key => TEARDOWN_KEYS.knownExact.includes(key) ||
  TEARDOWN_KEYS.knownPatterns.some(pattern => pattern.test(key));
export function assertKnownStorageKeys(keys) {
  if (keys.some(key => isCaseKey(key) && !knownKey(key))) throw new Error('unlisted_case_key');
}

const REFRESH = 'case:auth:refresh';
import {ACTIVE_ROOM_KEY,validPendingPkce} from './account-policy.mjs';
export {ACTIVE_ROOM_KEY,validPendingPkce} from './account-policy.mjs';
const ACCOUNT_ENDS = ['sign_out', 'unauthorised', 'account_changed', 'refresh_failed', 'next_load_failed'];
const manualKeys = callback => {
  const keys = callback();
  if (!Array.isArray(keys) || keys.length > 1 || keys.some(key => typeof key !== 'string' ||
      !key.startsWith('case-lab:segment:') || !isUuidV7(key.slice('case-lab:segment:'.length))))
    throw new Error('invalid_manual_preservation');
  return keys;
};

export function authNavigationPreservation({ sessionStorage, now = Date.now, preserveSessionKeys = () => [] } = {}) {
  return {
    preserveSession: reason => reason === 'pagehide' || reason === 'next_load' ? [
      ...(validPendingPkce(sessionStorage?.getItem('case:auth:pkce'), now()) ? ['case:auth:pkce'] : []),
      ...(isUuidV7(sessionStorage?.getItem(ACTIVE_ROOM_KEY)) ? [ACTIVE_ROOM_KEY] : []), ...manualKeys(preserveSessionKeys)] : [],
  };
}

function clearStorage(store, prefixes, preserve, keepCurrent = () => false) {
  if (!store) return true;
  try {
    const keys = [];
    for (let i = 0; i < store.length; i++) keys.push(store.key(i));
    let known = true;
    for (const key of keys) if (key && !preserve.includes(key) && prefixes.some(prefix => key.startsWith(prefix)) && !keepCurrent(key,store.getItem(key))) {
      if (!knownKey(key)) known = false;
      store.removeItem(key);
    }
    return known;
  } catch { return false; }
}

const safeStorage = name => { try { return globalThis[name] ?? null; } catch { return null; } };

export function createTeardown({
  sessionStorage = safeStorage('sessionStorage'), localStorage = safeStorage('localStorage'),
  caches = globalThis.caches, indexedDB = globalThis.indexedDB, clearMemory = () => {},
  cleanupTimeoutMs = 1500, preserveSession = [], preserveLocal = [TEARDOWN_KEYS.keepOnly],
  preserveDatabases = [], accountEnds = ACCOUNT_ENDS,
  locks = typeof window !== 'undefined' ? globalThis.navigator?.locks : null, requireLocks = typeof window !== 'undefined', roomCleanup: initialRoomCleanup = null,
} = {}) {
  return async function teardown(reason) {
    let roomCleanup=accountEnds.includes(reason)?null:initialRoomCleanup;
    // Decide narrow pagehide exceptions before clearMemory clears the opt-in bit.
    let sessionKeep = [], localKeep = [], databaseKeep = [], complete = true;
    try {
      const requested = typeof preserveSession === 'function' ? preserveSession(reason) : preserveSession;
      if (!Array.isArray(requested) || requested.some(key => !knownKey(key))) complete = false;
      if (Array.isArray(requested) && (reason === 'pagehide' || reason === 'next_load'))
        sessionKeep = requested.filter(knownKey);
    }
    catch { complete = false; }
    try {
      const requested = typeof preserveLocal === 'function' ? preserveLocal(reason) : preserveLocal;
      if (!Array.isArray(requested) || requested.some(key => !knownKey(key))) complete = false;
      if (Array.isArray(requested)) localKeep = requested.filter(key => knownKey(key) &&
        ((reason === 'pagehide' || reason === 'next_load') || key === TEARDOWN_KEYS.keepOnly));
    }
    catch { complete = false; }
    if (!accountEnds.includes(reason)) localKeep.push(REFRESH);
    try {
      const requested = typeof preserveDatabases === 'function' ? preserveDatabases(reason) : preserveDatabases;
      if (!Array.isArray(requested) || requested.some(name => !TEARDOWN_KEYS.knownDatabases.includes(name)))
        complete = false;
      else if (reason === 'pagehide' || reason === 'next_load') databaseKeep = requested;
    } catch { complete = false; }
    if (roomCleanup) {
      try {
        const requested = roomCleanup.keys;
        if (!Array.isArray(requested) || requested.some(key => !knownKey(key) ||
            !/^case:participant:(?:main|[0-9a-f-]{36}):token$/.test(key))) throw new Error('invalid_room_cleanup');
        localKeep.push(...requested); databaseKeep.push(...TEARDOWN_KEYS.knownDatabases);
      } catch { complete = false; }
    }
    // Memory is dropped before any asynchronous browser storage operation.
    try { clearMemory(reason); } catch { complete = false; }
    if (!clearStorage(sessionStorage, TEARDOWN_KEYS.sessionPrefixes, sessionKeep)) complete = false;

    if (accountEnds.includes(reason) && !clearStorage(localStorage, TEARDOWN_KEYS.localPrefixes,
        [...localKeep, ...TEARDOWN_KEYS.preferences, STORAGE_FENCE_KEY], roomCleanup?.keepCurrent)) complete = false;
    let expired = false;
    const duration = Number.isFinite(cleanupTimeoutMs) ? Math.max(1, Math.min(1500, cleanupTimeoutMs)) : 1500;
    let timer;
    const timeout = new Promise(resolve => { timer = setTimeout(() => { expired = true; resolve(false); }, duration); });
    const cleanup = (async () => {
      // Other room tabs are separate participants. Preserve only exact credentials and validated known rows.
      if (!roomCleanup && !accountEnds.includes(reason) && ['next_load','pagehide','room_end'].includes(reason)) {
        try {
          let scoped = false;
          for (let i = 0; i < (localStorage?.length ?? 0); i++) {
            const key = localStorage.key(i);
            if (/^case:participant:(?:main|[0-9a-f-]{36}):token$/.test(key ?? '')) { scoped = true; break; }
          }
          if (scoped) {
            const {prepareParticipantPreservation}=await import('./account-session.mjs');
            const plan=await prepareParticipantPreservation({sessionStorage,localStorage,indexedDB,locks,requireLocks,assertKnownStorageKeys,knownDatabases:TEARDOWN_KEYS.knownDatabases});
            if (expired || plan.status === 'unavailable') return false;
            if (plan.status === 'known') { localKeep.push(...plan.keys); databaseKeep.push(...TEARDOWN_KEYS.knownDatabases);roomCleanup={keepCurrent:plan.keepCurrent}; }
          }
        } catch { return false; }
      }
      if (!clearStorage(localStorage, TEARDOWN_KEYS.localPrefixes, [...localKeep, ...TEARDOWN_KEYS.preferences, STORAGE_FENCE_KEY], roomCleanup?.keepCurrent)) complete = false;
      const jobs = [];
      if (indexedDB && !databaseKeep.length) {
        jobs.push(storageBarrier({indexedDB,locks,requireLocks,timeoutMs:duration}).secure(async remove => {
          advanceStorageGeneration(localStorage);
          if (!clearStorage(localStorage, TEARDOWN_KEYS.localPrefixes,
              [...localKeep,...TEARDOWN_KEYS.preferences,STORAGE_FENCE_KEY])) complete=false;
          if (typeof indexedDB.deleteDatabase !== 'function') return false;
          if (typeof indexedDB.databases !== 'function') {
            await Promise.all(TEARDOWN_KEYS.knownDatabases.map(remove));
            return false; // Missing enumeration cannot establish a known complete inventory.
          }
          const databases = await indexedDB.databases();
          if (!Array.isArray(databases)) return false;
          const privateNames = databases.filter(db => db.name && TEARDOWN_KEYS.indexedDBPrefixes
            .some(prefix => db.name.startsWith(prefix))).map(db => db.name);
          const results = await Promise.all(privateNames.map(remove));
          return results.every(Boolean) && privateNames.every(name => TEARDOWN_KEYS.knownDatabases.includes(name));
        }).catch(() => false));
      }
      if (indexedDB && databaseKeep.length) jobs.push(storageBarrier({indexedDB,locks,requireLocks,timeoutMs:duration}).wait().catch(() => false));
      if (roomCleanup?.cleanup) jobs.push(Promise.resolve().then(roomCleanup.cleanup).catch(() => false));
      if (caches?.keys && caches?.delete) jobs.push((async () => {
        try {
          const names = await caches.keys();
          if (expired || !Array.isArray(names)) return false;
          const results = await Promise.allSettled(names.filter(name => !name.startsWith(TEARDOWN_KEYS.shellCachePrefix))
            .map(name => caches.delete(name)));
          return results.every(result => result.status === 'fulfilled' && result.value === true);
        } catch { return false; }
      })());
      if (indexedDB && databaseKeep.length) jobs.push((async () => {
        try {
          if (typeof indexedDB.deleteDatabase !== 'function') return false;
          if (typeof indexedDB.databases !== 'function') {
            await Promise.all(TEARDOWN_KEYS.knownDatabases.filter(name => !databaseKeep.includes(name))
              .map(name => storageBarrier({ indexedDB, locks, requireLocks, timeoutMs: duration }).delete(name).catch(() => false)));
            // Without enumeration, unknown private databases cannot be ruled out.
            return false;
          }
          const databases = await indexedDB.databases();
          if (expired || !Array.isArray(databases)) return false;
          const privateNames = databases.filter(db => db.name && TEARDOWN_KEYS.indexedDBPrefixes
            .some(prefix => db.name.startsWith(prefix))).map(db => db.name);
          const results = await Promise.all(privateNames.filter(name => !databaseKeep.includes(name))
            .map(name => storageBarrier({ indexedDB, locks, requireLocks, timeoutMs: duration }).delete(name).catch(() => false)));
          return results.every(Boolean) && privateNames.every(name => TEARDOWN_KEYS.knownDatabases.includes(name));
        } catch { return false; }
      })());
      return (await Promise.all(jobs)).every(Boolean);
    })().catch(() => false);
    const cleaned = await Promise.race([cleanup, timeout]);
    clearTimeout(timer);
    const finished = complete && cleaned;
    if (!finished) for (const key of sessionKeep) {
      if (key.startsWith('case-lab:segment:')) try { sessionStorage?.removeItem(key); } catch {}
    }
    return { complete: finished };
  };
}

/** On reload, finish private cleanup before considering an existing tab refresh or PKCE. */
export const recoverOnLoad = ({ nowMs = Date.now(), sessionStorage = safeStorage('sessionStorage'),
  preserveSessionKeys, ...options } = {}) => createTeardown({ ...options, sessionStorage,
  ...authNavigationPreservation({ sessionStorage, now: () => nowMs, preserveSessionKeys }) })('next_load');
