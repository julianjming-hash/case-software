import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_PREFERENCE_KEYS, readDevicePreferences, writeDevicePreference } from '../src/client/device-preferences.mjs';
import { createTeardown } from '../src/client/teardown.mjs';
import { AUDIO_LEVEL_KEYS } from '../src/client/audio-preferences.mjs';
import { STORAGE_FENCE_KEY } from '../src/client/storage-generation.mjs';
const store = () => { const data = new Map(); return { get length() { return data.size; }, key: index => [...data.keys()][index] ?? null,
  getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key), data }; };
test('device boolean preferences default to existing sounds, collapsed timeline and motion on; exact false opts out', () => {
  const storage = store(); assert.deepEqual(readDevicePreferences(storage), { uiTones: true, timelineCollapsed: true, motion: true });
  assert.equal(writeDevicePreference(storage, 'uiTones', false), true);
  assert.deepEqual(readDevicePreferences(storage), { uiTones: false, timelineCollapsed: true, motion: true });
  storage.setItem(DEVICE_PREFERENCE_KEYS.timelineCollapsed, '0');
  assert.equal(readDevicePreferences(storage).timelineCollapsed, true);
  assert.equal(writeDevicePreference(storage, 'timelineCollapsed', false), true);
  assert.equal(readDevicePreferences(storage).timelineCollapsed, false);
  assert.equal(writeDevicePreference(storage, 'motion', false), true);
  assert.equal(readDevicePreferences(storage).motion, false);
});
test('unknown keys, nonboolean and unavailable preference writes fail without inventing persistence', () => {
  const storage = store();
  assert.equal(writeDevicePreference(storage, 'unknown', true), false);
  assert.equal(writeDevicePreference(storage, 'uiTones', 'false'), false);
  assert.equal(storage.data.size, 0); assert.equal(writeDevicePreference(null, 'uiTones', false), false);
  const blocked = { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } };
  assert.deepEqual(readDevicePreferences(blocked), { uiTones: true, timelineCollapsed: true, motion: true });
  assert.equal(writeDevicePreference(blocked, 'uiTones', false), false);
});
test('all exact audio/device preferences survive cleanup; arbitrary preference-looking private keys are erased', async () => {
  for (const reason of ['sign_out', 'account_change', 'pagehide', 'next_load', 'room_end']) {
    const local = store(), session = store();
    const approved = [...Object.values(AUDIO_LEVEL_KEYS), ...Object.values(DEVICE_PREFERENCE_KEYS)];
    for (const key of approved) local.setItem(key, key.includes('volume') ? '0.25' : 'false');
    local.setItem('case:preferences:private-room', 'private'); session.setItem('case:preferences:ui-tones', 'private');
    const names=new Set(['case:phone-outbox']),deletions=[],locks={request:async(name,operation)=>{assert.equal(name,'case-private-storage');return operation();}};
    const indexedDB={databases:async()=>[...names].map(name=>({name})),deleteDatabase(name){deletions.push(name);const request={};queueMicrotask(()=>{names.delete(name);request.onsuccess?.();});return request;}};
    const result = await createTeardown({ localStorage: local, sessionStorage: session, indexedDB, locks, requireLocks:true, caches: null })(reason);
    assert.deepEqual(deletions,['case:phone-outbox']);
    assert.equal(result.complete, false, 'an unknown key is erased and reported rather than silently admitted');
    assert.deepEqual([...local.data.keys()].sort(), [...approved,STORAGE_FENCE_KEY].sort()); assert.equal(session.data.size, 0);
    assert.equal(local.getItem(STORAGE_FENCE_KEY),'1');
    assert.equal(local.getItem('case:preferences:private-room'),null);
    for(const key of approved)assert.equal(local.getItem(key),key.includes('volume')?'0.25':'false');
    const known=await createTeardown({localStorage:local,sessionStorage:session,indexedDB,locks,requireLocks:true,caches:null})(reason);
    assert.equal(known.complete,true,'a known clean inventory must not remain unavailable after unknown data is erased');
    assert.equal(local.getItem(STORAGE_FENCE_KEY),'2');assert.deepEqual(deletions,['case:phone-outbox']);
    assert.deepEqual([...local.data.keys()].sort(),[...approved,STORAGE_FENCE_KEY].sort());assert.equal(session.data.size,0);
    for(const key of approved)assert.equal(local.getItem(key),key.includes('volume')?'0.25':'false');
  }
});
