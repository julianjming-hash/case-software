import { STORAGE_FENCE_KEY, storageGeneration } from './storage-generation.mjs';
// A deletion request survives its caller's deadline. Hold the origin lock until the browser settles it.
const contexts = new WeakMap();
const LOCK = 'case-private-storage';
const unavailable = () => Object.assign(new Error('Private storage unavailable'), { code: 'storage_unavailable' });
export function storageBarrier({ indexedDB = globalThis.indexedDB, locks = typeof window !== 'undefined' ? globalThis.navigator?.locks : null,
  requireLocks = typeof window !== 'undefined', timeoutMs = 1000 } = {}) {
  if (!indexedDB || typeof indexedDB !== 'object') throw unavailable();
  let state = contexts.get(indexedDB);
  if (!state) { state = { tail: Promise.resolve(), deletions: new Map(), closers: new Set(), securityVersion: 0, watchers: new Set() }; contexts.set(indexedDB, state); }
  const duration = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(1500, timeoutMs)) : 1000;
  const serial = operation => {
    if (requireLocks && !locks?.request) return Promise.reject(unavailable());
    const task = state.tail.then(() => locks?.request ? locks.request(LOCK, operation) : operation());
    state.tail = task.catch(() => {}); return task;
  };
  const bounded = promise => {
    let timer; const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(unavailable()), duration); });
    return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
  };
  const remove = async name => {
    await Promise.all([...state.closers].map(close => Promise.resolve().then(close)));
    return new Promise((resolve, reject) => {
      try {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => resolve(true);
        request.onerror = () => reject(unavailable());
        request.onblocked = () => {}; // The native deletion remains pending under the origin lock.
      } catch { reject(unavailable()); }
    });
  };
  return {
    // A queued timed-out reader must never execute after its caller abandons it.
    run(operation) {
      let abandoned = false;
      const task = serial(() => { if (abandoned) throw unavailable(); return operation(); });
      return bounded(task).catch(error => { abandoned = true; throw error; });
    },
    wait() { return this.run(() => true); },
    register(close) { state.closers.add(close); return () => state.closers.delete(close); },
    get securityVersion() { return state.securityVersion; },
    watchSecurity(stop) { state.watchers.add(stop); return () => state.watchers.delete(stop); },
    // Cancel this document immediately, then keep the durable generation/deletion work queued even
    // when its caller times out. The supplied remove primitive already owns this origin lock.
    secure(operation) {
      state.securityVersion++;
      for (const stop of [...state.watchers]) try { stop(); } catch { /* Independent subscribers. */ }
      return bounded(serial(() => operation(remove)));
    },
    delete(name) {
      let task = state.deletions.get(name);
      if (!task) {
        task = serial(() => remove(name));
        state.deletions.set(name, task);
        task.then(() => state.deletions.delete(name), () => state.deletions.delete(name));
      }
      return bounded(task);
    },
  };
}
export const awaitPrivateStorage = options => storageBarrier(options).wait();

/** Injected only by the participant entry; shared transport never imports private storage machinery. */
export function participantStorageFence({localStorage=globalThis.localStorage,initialBinding=null,...options}={}) {
  const generation=storageGeneration(localStorage),barrier=storageBarrier(options),securityVersion=barrier.securityVersion;
  let binding=initialBinding?{key:initialBinding.key,token:initialBinding.credential?.token,sessionId:initialBinding.credential?.sessionId}:null;
  const valid=()=>{try {
    if(barrier.securityVersion!==securityVersion||storageGeneration(localStorage)!==generation)return false;
    if(!binding)return true;
    const saved=JSON.parse(localStorage.getItem(binding.key)??'null');
    return saved?.token===binding.token&&saved?.sessionId===binding.sessionId;
  }catch{return false;}};
  return {valid,commit:(write,next)=>barrier.run(()=>{
    if(!valid())return false;
    const result=write();if(result!==false&&next)binding={key:next.key,token:next.credential.token,sessionId:next.credential.sessionId};
    return result;
  }),watch:stop=>{
    const listener=event=>{if((event.key===null||event.key===STORAGE_FENCE_KEY||event.key===binding?.key)&&!valid())stop();};
    const unwatch=barrier.watchSecurity(()=>{if(!valid())stop();});
    globalThis.addEventListener?.('storage',listener);
    return ()=>{unwatch();globalThis.removeEventListener?.('storage',listener);};
  }};
}
