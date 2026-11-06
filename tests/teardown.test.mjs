import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uuidv7 } from '../src/shared/ids.mjs';
import { storageGeneration } from '../src/client/storage-generation.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import { createTeardown, recoverOnLoad, assertKnownStorageKeys, TEARDOWN_KEYS } from '../src/client/teardown.mjs';

function storage(entries = {}) {
  const values = new Map(Object.entries(entries));
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    entries: () => [...values],
  };
}

test('[AS-079] teardown clears every Case storage key including an unlisted future key, preserving only the transport pin', async () => {
  const sessionStorage = storage({ 'case:auth:refresh': 'refresh', 'case:facilitator:main:token': 'room',
    'case-lab:segment:room': 'segment', 'case:future:secret': 'unknown' });
  const localStorage = storage({ 'case:auth:refresh': 'refresh', 'case:participant:main:token': 'participant',
    'case:transport:pin': '{"wifi":123}', 'case:future:secret': 'unknown', unrelated: 'keep' });
  const removedCaches = [], removedDatabases = [], memory = { token: 'access', pack: { secret: true } };
  const caches = { keys: async () => ['case-shell-wire2-abc', 'case-room-private', 'unrelated'],
    delete: async name => { removedCaches.push(name); return true; } };
  const indexedDB = { databases: async () => [{ name: 'case:phone-outbox' }, { name: 'other' }],
    deleteDatabase: name => { removedDatabases.push(name); const request = {};
      queueMicrotask(() => request.onsuccess?.()); return request; } };
  const teardown = createTeardown({ sessionStorage, localStorage, caches, indexedDB,
    clearMemory: () => { memory.token = null; memory.pack = null; } });
  const result = await teardown('sign_out');
  assert.deepEqual(sessionStorage.entries(), []);
  assert.deepEqual(localStorage.entries(), [['case:transport:pin', '{"wifi":123}'], ['unrelated', 'keep'],['case:storage:fence','1']]);
  assert.deepEqual(removedCaches, ['case-room-private', 'unrelated']);
  assert.deepEqual(removedDatabases, ['case:phone-outbox']);
  assert.deepEqual(memory, { token: null, pack: null });
  assert.equal(TEARDOWN_KEYS.keepOnly, 'case:transport:pin');
  assert.deepEqual(result, { complete: false }); // unknown key was safely removed but inventory must be updated
});

test('[AS-079] storage inventory rejects an unknown Case key before it can silently become normal', () => {
  assert.doesNotThrow(() => assertKnownStorageKeys(['case:auth:refresh', 'case:transport:pin',
    'case:participant:A:token', 'case-lab:segment:session', 'case:phone:join-code-draft']));
  assert.throws(() => assertKnownStorageKeys(['case:future:secret']), /unlisted_case_key/);
});

test('[AS-080] only a validated participant pagehide or next load may preserve the known vote queue', async () => {
  const deleted = [];
  const database = { databases: async () => [{ name: 'case:phone-outbox' }], deleteDatabase(name) {
    deleted.push(name); const request = {}; queueMicrotask(() => request.onsuccess?.()); return request;
  } };
  let validParticipant = true;
  const cleanup = createTeardown({ sessionStorage: storage(), localStorage: storage(), caches: null,
    indexedDB: database, preserveDatabases: reason => validParticipant &&
      ['pagehide', 'next_load'].includes(reason) ? ['case:phone-outbox'] : [] });
  assert.deepEqual(await cleanup('pagehide'), { complete: true });
  assert.deepEqual(await cleanup('next_load'), { complete: true });
  assert.deepEqual(deleted, []);
  validParticipant = false;
  assert.deepEqual(await cleanup('next_load'), { complete: true });
  assert.deepEqual(deleted, ['case:phone-outbox']);
  validParticipant = true;
  assert.deepEqual(await cleanup('sign_out'), { complete: true });
  assert.deepEqual(deleted, ['case:phone-outbox', 'case:phone-outbox']);
  const refused = createTeardown({ sessionStorage: storage(), localStorage: storage(), caches: null,
    indexedDB: database, preserveDatabases: () => ['case:phone-outbox'] });
  assert.deepEqual(await refused('unauthorised'), { complete: true });
  assert.deepEqual(deleted.at(-1), 'case:phone-outbox');
  const unknown = createTeardown({ sessionStorage: storage(), localStorage: storage(), caches: null,
    indexedDB: database, preserveDatabases: () => ['case:unlisted-database'] });
  assert.deepEqual(await unknown('pagehide'), { complete: false });
  assert.deepEqual(deleted.at(-1), 'case:phone-outbox');
});

test('[AS-079] cleanup refuses unknown key preservation and never preserves refresh on sign-out', async () => {
  const sessionStorage = storage({ 'case:future:secret': 'unknown', 'case:auth:pkce': 'pending' });
  const localStorage = storage({ 'case:auth:refresh': 'phone', 'case:transport:pin': 'network-only' });
  const cleanup = createTeardown({ sessionStorage, localStorage, caches: null, indexedDB: null,
    preserveSession: () => ['case:future:secret'],
    preserveLocal: () => ['case:auth:refresh', 'case:transport:pin'] });
  assert.deepEqual(await cleanup('sign_out'), { complete: false });
  assert.deepEqual(sessionStorage.entries(), []);
  assert.deepEqual(localStorage.entries(), [['case:transport:pin', 'network-only']]);
});

test('[AS-079] every Case storage-key writer in the client and prototype has an inventory entry', () => {
  const here = new URL('../', import.meta.url);
  const walk = directory => readdirSync(new URL(directory, here), { withFileTypes: true }).flatMap(item => {
    const path = `${directory}/${item.name}`;
    return item.isDirectory() ? walk(path) : /\.(?:mjs|js|html)$/.test(path) ? [path] : [];
  });
  const writers = [...walk('src/client'), ...walk('prototypes/room')];
  const dynamic = new Set(["case:${role}:${slot ?? 'main'}:token", 'case-lab:segment:${mirror.sessionId}',
    'case-lab:segment:${sessionId}', 'case-lab:segment:${handoff.sessionId}', "case-lab:${role}:${slot ?? 'main'}:token", 'case:join-code-draft:${slot}', 'case:feedback:${sessionId}:key', 'case:finish:${view.sessionId}:saved',
    // The feedback page reads (never writes) a joined phone's credential in the case:<role>:<slot>:token family.
    'case:participant:${sessionId}:token']);
  for (const path of writers) {
    const source = readFileSync(new URL(path, here), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const literals = [/`((?:case|case-lab):[^`\n]+)`/g,
      /'((?:case|case-lab):[^'\n]+)'/g, /"((?:case|case-lab):[^"\n]+)"/g]
      .flatMap(pattern => [...source.matchAll(pattern)].map(match => match[1]));
    for (const key of literals) {
      if (key.includes('${')) assert.ok(dynamic.has(key), `${path}: unlisted dynamic key ${key}`);
      else if (TEARDOWN_KEYS.knownKeyPrefixes.includes(key))
        assert.doesNotThrow(() => assertKnownStorageKeys([`${key}inventory-probe`]), `${path}: ${key} prefix`);
      else if (!TEARDOWN_KEYS.knownDatabases.includes(key))
        assert.doesNotThrow(() => assertKnownStorageKeys([key]), `${path}: ${key}`);
    }
  }
});

test('[AS-079] next load clears stale private stores and a tab-scoped refresh while preserving valid PKCE and the stored account refresh (card 38)', async () => {
  const now = Date.now();
  const sessionStorage = storage({ 'case:auth:refresh': 'refresh', 'case:auth:pkce': 'verifier',
    'case:facilitator:main:token': 'stale-room', 'case-lab:segment:room': 'stale-pack' });
  sessionStorage.setItem('case:auth:pkce', JSON.stringify({ verifier: 'a'.repeat(43), createdAt: now, expiresAt: now + 600_000 }));
  const localStorage = storage({ 'case:transport:pin': 'network-only', 'case:auth:refresh': 'refresh-opaque',
    'case:participant:A:token': 'stale-vote' });
  const removedCaches = [], removedDatabases = [];
  const result = await recoverOnLoad({ sessionStorage, localStorage, nowMs: now,
    caches: { keys: async () => ['case-shell-wire2-abc', 'case-private'], delete: async name => { removedCaches.push(name); return true; } },
    indexedDB: { databases: async () => [{ name: 'case:phone-outbox' }], deleteDatabase: name => {
      removedDatabases.push(name); const request = {}; queueMicrotask(() => request.onsuccess?.()); return request;
    } } });
  assert.deepEqual(result, { complete: true });
  assert.deepEqual(sessionStorage.entries(), [['case:auth:pkce', JSON.stringify({ verifier: 'a'.repeat(43), createdAt: now, expiresAt: now + 600_000 })]]);
  assert.deepEqual(localStorage.entries(), [['case:transport:pin', 'network-only'], ['case:auth:refresh', 'refresh-opaque'],['case:storage:fence','1']]);
  assert.deepEqual(removedCaches, ['case-private']);
  assert.deepEqual(removedDatabases, ['case:phone-outbox']);
});

test('[AS-079] next load rejects stale or malformed PKCE records and a tab-scoped refresh; the account refresh stays (card 38)', async () => {
  for (const value of ['raw', '{invalid', JSON.stringify({ verifier: 'a'.repeat(43),
    createdAt: Date.now() + 60_000, expiresAt: Date.now() + 660_000 })]) {
    const sessionStorage = storage({ 'case:auth:pkce': value, 'case:auth:refresh': 'stale-tab' });
    const localStorage = storage({ 'case:auth:refresh': 'stored-account', 'case:transport:pin': 'network-only' });
    await recoverOnLoad({ sessionStorage, localStorage, caches: null, indexedDB: null });
    assert.equal(sessionStorage.getItem('case:auth:pkce'), null);
    assert.equal(sessionStorage.getItem('case:auth:refresh'), null);
    assert.equal(localStorage.getItem('case:auth:refresh'), 'stored-account');
    assert.equal(localStorage.getItem('case:transport:pin'), 'network-only');
  }
});

test('[AS-079] teardown clears memory immediately and reports incomplete cleanup when browser storage never settles', async () => {
  const sessionStorage = storage({ 'case:auth:refresh': 'refresh' });
  let cleared = false;
  const teardown = createTeardown({ sessionStorage, localStorage: storage(),
    caches: { keys: () => new Promise(() => {}), delete: async () => true },
    indexedDB: { databases: () => new Promise(() => {}), deleteDatabase: () => ({}) },
    clearMemory: () => { cleared = true; }, cleanupTimeoutMs: 20 });
  const result = await Promise.race([teardown('sign_out'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('cleanup exceeded watchdog')), 120))]);
  assert.equal(cleared, true);
  assert.equal(sessionStorage.getItem('case:auth:refresh'), null);
  assert.deepEqual(result, { complete: false });
});

test('[AS-079] teardown reports incomplete cleanup when cache deletion or individual IDB deletion stalls', async () => {
  const cache = createTeardown({ sessionStorage: storage(), localStorage: storage(),
    caches: { keys: async () => ['case-private'], delete: () => new Promise(() => {}) },
    indexedDB: null, cleanupTimeoutMs: 20 });
  assert.deepEqual(await cache('sign_out'), { complete: false });
  const database = createTeardown({ sessionStorage: storage(), localStorage: storage(), caches: null,
    indexedDB: { databases: async () => [{ name: 'case:private' }], deleteDatabase: () => ({}) },
    cleanupTimeoutMs: 20 });
  assert.deepEqual(await database('sign_out'), { complete: false });
});

test('[AS-079] cleanup attempts known IDB deletion and reports incomplete when database enumeration is unavailable', async () => {
  const deleted = [];
  const cleanup = createTeardown({ sessionStorage: storage(), localStorage: storage(), caches: null,
    indexedDB: { deleteDatabase(name) {
      deleted.push(name); const request = {}; queueMicrotask(() => request.onsuccess?.()); return request;
    } } });
  assert.deepEqual(await cleanup('sign_out'), { complete: false });
  assert.deepEqual(deleted, TEARDOWN_KEYS.knownDatabases);
});

test('[AS-079] teardown reports incomplete cleanup when synchronous storage removal fails', async () => {
  const blocked = storage({ 'case:auth:refresh': 'private' });
  blocked.removeItem = () => { throw new Error('storage denied'); };
  const teardown = createTeardown({ sessionStorage: blocked, localStorage: storage(), caches: null, indexedDB: null });
  assert.deepEqual(await teardown('sign_out'), { complete: false });
  assert.equal(blocked.getItem('case:auth:refresh'), 'private');
});

 test('blocked deletion waits for actual success instead of freezing a clean bootstrap', async () => {
  let deleted; const idb = { databases: async () => [{name: 'case:phone-outbox'}], deleteDatabase() {
   const request = {}; deleted = request; queueMicrotask(() => request.onblocked?.());
   setTimeout(() => request.onsuccess?.(), 15); return request;
  }};
  const teardown = createTeardown({sessionStorage:storage(), localStorage:storage(), caches:null, indexedDB:idb, cleanupTimeoutMs:100});
  assert.deepEqual(await teardown('sign_out'), {complete:true}); assert.ok(deleted);
 });

// Exercise common-role preservation through its actual lazy policy and store, not a mocked plan.
function reusableNavigationFixture() {
  const localStorage=storage({'case:auth:refresh':'saved-account'}),sessionStorage=storage(),deleted=[];
  let rows=[],opens=0;
  const names=values=>Object.assign(values,{contains:value=>values.includes(value)});
  const db={objectStoreNames:names(['votes']),close(){},transaction(){
    const tx={objectStore(){const read=filter=>{const request={result:rows.filter(filter)};queueMicrotask(()=>tx.oncomplete?.());return request;};
      return {keyPath:'envelope.clientEventId',indexNames:names(['roomId']),getAll:()=>read(()=>true),index:()=>({keyPath:'roomId',getAll:room=>read(row=>row.roomId===room)})};}};return tx;
  }};
  const indexedDB={open(){opens++;const request={result:db};queueMicrotask(()=>request.onsuccess());return request;},databases:async()=>[{name:'case:phone-outbox'}],deleteDatabase(name){
    deleted.push(name);const request={};queueMicrotask(()=>{rows=[];request.onsuccess();});return request;
  }};
  function replaceRoom() {
    for(const [key] of localStorage.entries())if(key.startsWith('case:participant:'))localStorage.removeItem(key);
    const credential={sessionId:uuidv7(),token:uuidv7()+uuidv7(),expiresAt:Date.now()+60000},key=`case:participant:${credential.sessionId}:token`;
    localStorage.setItem(key,JSON.stringify(credential));
    rows=[{roomId:credential.sessionId,participantId:uuidv7(),superseded:false,admitted:false,envelope:{v:1,type:'vote',epoch:0,clientEventId:uuidv7(),roundId:uuidv7(),response:{text:'another room own answer'}}}];
    return {key,credential,rows:structuredClone(rows)};
  }
  return {localStorage,sessionStorage,indexedDB,locks:{request:async(_key,run)=>run()},deleted,replaceRoom,rows:()=>rows,opens:()=>opens};
}
test('[AS-114] one reusable teardown freshly preserves other participant rooms on successive room ends, then erases them on signout',async()=>{
  const f=reusableNavigationFixture(),cleared=[],first=f.replaceRoom();
  const teardown=createTeardown({...f,requireLocks:true,caches:{keys:async()=>[]},clearMemory:reason=>cleared.push(reason)});
  assert.deepEqual(await teardown('room_end'),{complete:true});
  assert.equal(f.localStorage.getItem(first.key),JSON.stringify(first.credential));assert.deepEqual(f.rows(),first.rows);assert.deepEqual(f.deleted,[]);
  const second=f.replaceRoom();
  assert.deepEqual(await teardown('room_end'),{complete:true});
  assert.equal(f.localStorage.getItem(second.key),JSON.stringify(second.credential));assert.deepEqual(f.rows(),second.rows);assert.deepEqual(f.deleted,[]);
  assert.equal(f.opens(),2,'each room end rereads the actual fresh inventory/store');assert.equal(f.localStorage.getItem('case:auth:refresh'),'saved-account');assert.equal(storageGeneration(f.localStorage),0);
  assert.deepEqual(await teardown('sign_out'),{complete:true});
  assert.equal(f.localStorage.getItem(second.key),null);assert.equal(f.localStorage.getItem('case:auth:refresh'),null);assert.deepEqual(f.rows(),[]);assert.deepEqual(f.deleted,['case:phone-outbox']);assert.equal(storageGeneration(f.localStorage),1);
  assert.deepEqual(cleared,['room_end','room_end','sign_out']);
});
test('[AS-114] every account-ending cleanup ignores an injected room preservation plan and commits its origin security fence',async()=>{
  for(const reason of ['sign_out','unauthorised','account_changed','refresh_failed','next_load_failed']) {
    const f=reusableNavigationFixture(),saved=f.replaceRoom();let scopedCalls=0;
    const teardown=createTeardown({...f,requireLocks:true,caches:{keys:async()=>[]},roomCleanup:{keys:[saved.key],keepCurrent:()=>true,cleanup:async()=>{scopedCalls++;return true;}}});
    assert.deepEqual(await teardown(reason),{complete:true},reason);
    assert.equal(f.localStorage.getItem(saved.key),null,reason);assert.equal(f.localStorage.getItem('case:auth:refresh'),null,reason);assert.deepEqual(f.rows(),[],reason);assert.deepEqual(f.deleted,['case:phone-outbox'],reason);assert.equal(storageGeneration(f.localStorage),1,reason);assert.equal(scopedCalls,0,reason);
  }
});
