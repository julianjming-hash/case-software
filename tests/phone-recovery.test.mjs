import test from 'node:test';
import assert from 'node:assert/strict';
import { participantRoomInventory, validateParticipantRecovery, readParticipantRecovery } from '../src/client/phone-recovery.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';

function state() {
  const now = Date.now(), sessionId = uuidv7();
  return { role: 'participant', sessionId, now, knownInventory: true,
    credential: { sessionId, token: 'x'.repeat(32), expiresAt: now + 60_000 },
    rows: [{ roomId: sessionId, participantId: uuidv7(), superseded: false, envelope: { v: 1, type: 'vote', epoch: 1, clientEventId: uuidv7(), roundId: uuidv7(), response: { text: 'own answer' } } }] };
}

test('participant reload preservation rejects role, room, expiry, malformed, oversized and unknown-inventory states', () => {
  const valid = state(); assert.deepEqual(validateParticipantRecovery(valid), { preserve: true, count: 1 });
  for (const change of [{ role: 'facilitator' }, { sessionId: uuidv7() }, { knownInventory: false },
    { credential: { ...valid.credential, token: '' } },
    { credential: { ...valid.credential, expiresAt: valid.now } },
    { credential: { ...valid.credential, expiresAt: valid.now + 49 * 60 * 60_000 } },
    { rows: Array(21).fill(valid.rows[0]) }, { rows: [{ ...valid.rows[0], roomId: uuidv7() }] },
    { rows: [{ ...valid.rows[0], token: 'private' }] },
    { rows: [{ ...valid.rows[0], envelope: { ...valid.rows[0].envelope, response: { text: 'own', otherAnswer: 'private' } } }] }])
    assert.deepEqual(validateParticipantRecovery({ ...valid, ...change }), { preserve: false, count: 0 });
});

test('delivery admission persists exactly one bounded boolean beside legacy vote rows', () => {
  const valid = state();
  for (const admitted of [false, true]) assert.deepEqual(validateParticipantRecovery({ ...valid, rows: [{ ...valid.rows[0], admitted }] }), { preserve: true, count: 1 });
  for (const admitted of [null, 'true', 1, {}, []]) assert.deepEqual(validateParticipantRecovery({ ...valid, rows: [{ ...valid.rows[0], admitted }] }), { preserve: false, count: 0 });
  assert.deepEqual(validateParticipantRecovery({ ...valid, rows: [{ ...valid.rows[0], admitted: true, sequence: 1 }] }), { preserve: false, count: 0 });
});

test('participant queue prevalidation is bounded, closes its reader and never preserves after read failure or timeout', async () => {
  const valid = state(); let closed = 0;
  const options = { ...valid, openStore: () => ({ read: async room => { assert.equal(room, valid.sessionId); return valid.rows; }, close: async () => closed++ }) };
  assert.deepEqual(await readParticipantRecovery(options), { preserve: true, count: 1 }); assert.equal(closed, 1);
  assert.deepEqual(await readParticipantRecovery({ ...options, openStore: () => ({ read: async () => { throw new Error('closed'); }, close: async () => closed++ }) }), { preserve: false, count: 0, status:'unavailable' });
  let completeRead;
  const timeout = await readParticipantRecovery({ ...options, timeoutMs: 10, openStore: () => ({ read: () => new Promise(resolve => completeRead = resolve), close: async () => closed++ }) });
  assert.deepEqual(timeout, { preserve: false, count: 0, status:'unavailable' }); completeRead(valid.rows);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, 3);
});

test('phone storage inventory fails closed on unknown Case keys databases and stalled enumeration', async () => {
  const { inspectPhoneInventory } = await import('../src/client/phone-recovery.mjs');
  const storage = keys => ({ length: keys.length, key: i => keys[i] });
  const options = { sessionStorage: storage(['case:phone:join-code-draft']), localStorage: storage(['case:participant:main:token']),
    assertKnownStorageKeys: keys => { if (keys.some(key => key.startsWith('case:unknown'))) throw Error('unlisted'); },
    knownDatabases: ['case:phone-outbox'], indexedDB: { databases: async () => [{ name: 'case:phone-outbox' }, { name: 'unrelated' }] } };
  assert.equal(await inspectPhoneInventory(options), true);
  assert.equal(await inspectPhoneInventory({ ...options, localStorage: storage(['case:unknown:private']) }), false);
  assert.equal(await inspectPhoneInventory({ ...options, indexedDB: { databases: async () => [{ name: 'case:unknown' }] } }), false);
  assert.equal(await inspectPhoneInventory({ ...options, timeoutMs: 10, indexedDB: { databases: () => new Promise(() => {}) } }), false);
});

test('legacy and explicit admitted row markers preserve strict recovery and server-owner boundaries',()=>{
 const valid=state();
 for(const admitted of [true,false])assert.deepEqual(validateParticipantRecovery({...valid,rows:valid.rows.map(row=>({...row,admitted}))}),{preserve:true,count:1});
 for(const admitted of [0,'true',null])assert.deepEqual(validateParticipantRecovery({...valid,rows:valid.rows.map(row=>({...row,admitted}))}),{preserve:false,count:0});
});

test('expired legacy and newer scoped same-room credentials are conflicting inventory and cannot share erasure ownership',()=>{
 const sessionId=uuidv7(),now=Date.now(),credential={sessionId,token:'x'.repeat(32),expiresAt:now+60000};
 const values=new Map([['case:participant:main:token',JSON.stringify({...credential,expiresAt:now-1})],[`case:participant:${sessionId}:token`,JSON.stringify(credential)]]);
 const localStorage={get length(){return values.size;},key:i=>[...values.keys()][i],getItem:key=>values.get(key)};
 assert.throws(()=>participantRoomInventory(localStorage,now),/conflicting_participant_owner/);
});
