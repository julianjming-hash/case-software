// Phone-owned IndexedDB queue; no account or room credentials are persisted here.
import { reopenOnce } from './idb.mjs';
import { storageBarrier } from './storage-barrier.mjs';
import { storageGeneration } from './storage-generation.mjs';

export const VOTE_DATABASE = 'case:phone-outbox';

function openDatabase(indexedDB,onInvalidated) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(VOTE_DATABASE, 1); let refused=false;
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('votes', { keyPath: 'envelope.clientEventId' });
      store.createIndex('roomId', 'roomId');
    };
    request.onerror = () => { refused=true; reject(request.error); };
    request.onblocked = () => { refused=true; reject(new Error('Vote storage unavailable')); };
    request.onsuccess = () => {
      const db = request.result;
      if(refused){db.close();return;}
      try {
        if(db.objectStoreNames.length!==1||!db.objectStoreNames.contains('votes'))throw Object.assign(new Error('Unknown vote storage'),{code:'invalid_storage_inventory'});
        const schema=db.transaction('votes','readonly').objectStore('votes');
        if(schema.keyPath!=='envelope.clientEventId'||schema.indexNames.length!==1||!schema.indexNames.contains('roomId')||schema.index('roomId').keyPath!=='roomId')throw Object.assign(new Error('Unknown vote storage'),{code:'invalid_storage_inventory'});
      }catch(error){db.close();reject(error);return;}
      db.onversionchange = () => { onInvalidated(); db.close(); };
      resolve(db);
    };
  });
}

export function openVoteStore({ openDatabase: suppliedFactory, indexedDB = globalThis.indexedDB,
  locks = typeof window !== 'undefined' ? globalThis.navigator?.locks : null, requireLocks = typeof window !== 'undefined', timeoutMs = 1000, localStorage = globalThis.localStorage } = {}) {
  const barrier = indexedDB ? storageBarrier({ indexedDB, locks, requireLocks, timeoutMs }) : null;
  if (!suppliedFactory && !barrier) throw new Error('Vote storage unavailable');
  let tail = Promise.resolve(), closed = false;
  const generation=storageGeneration(localStorage);
  const database = reopenOnce(suppliedFactory ?? (() => openDatabase(indexedDB, () => { closed = true; })));
  const operationIfActive = operation => { if (closed || storageGeneration(localStorage)!==generation) throw new Error('Vote storage closed'); return database.run(operation); };
  const run = operation => barrier ? barrier.run(() => operationIfActive(operation)) : operationIfActive(operation);
  const unregister = barrier?.register(() => { closed = true; return database.close(); });
  return {
    read(roomId) {
      if (closed) return Promise.reject(new Error('Vote storage closed'));
      return tail.then(() => run(db => new Promise((resolve, reject) => {
        const tx = db.transaction('votes', 'readonly');
        const request = tx.objectStore('votes').index('roomId').getAll(roomId);
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Vote storage unavailable'));
        request.onerror = () => reject(request.error);
      })));
    },
    readAll(inspect = rows => rows) {
      if (closed) return Promise.reject(new Error('Vote storage closed'));
      return tail.then(() => run(db => new Promise((resolve, reject) => {
        const tx = db.transaction('votes', 'readonly');
        const request = tx.objectStore('votes').getAll();
        tx.oncomplete = () => {try{resolve(inspect(request.result));}catch(error){reject(error);}};
        tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Vote storage unavailable'));
        request.onerror = () => reject(request.error);
      })));
    },
    update(roomId, change) {
      if (closed) return Promise.reject(new Error('Vote storage closed'));
      const task = tail.then(() => run(db => new Promise((resolve, reject) => {
        const tx = db.transaction('votes', 'readwrite'), store = tx.objectStore('votes');
        let result,afterCommit;
        tx.oncomplete = () => {try{afterCommit?.();resolve(result);}catch(error){reject(error);}};
        tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Vote storage unavailable'));
        const request = store.index('roomId').getAll(roomId);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          try {
            const next = change(request.result);
            if (!next || !Array.isArray(next.rows) || next.rows.some(row => row.roomId !== roomId)) throw new TypeError('Invalid vote storage update');
            for (const row of request.result) store.delete(row.envelope.clientEventId);
            for (const row of next.rows) store.put(row);
            result = next.result;afterCommit=next.afterCommit;
            if(afterCommit!==undefined&&typeof afterCommit!=='function')throw new TypeError('Invalid vote commit callback');
          } catch (error) { tx.abort?.(); reject(error); }
        };
      })));
      tail = task.catch(() => {});
      return task;
    },
    async close() { closed = true; await tail; await database.close(); unregister?.(); },
  };
}
