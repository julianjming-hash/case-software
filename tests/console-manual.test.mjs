import test from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from '../src/shared/ids.mjs';
import { initialState } from '../src/shared/room-machine.mjs';
import { miniCase } from './helpers/mini-case.mjs';
import { ConsoleManualRoom } from '../src/client/console-manual.mjs';
import { closeConsoleResources } from '../src/client/console-room.mjs';

function setup() {
  const { doc } = miniCase();
  const state = initialState({ sessionId: uuidv7(), joinCode: '7K3QX9', caseDoc: doc });
  const { caseDoc, ...mirror } = state;
  const entries = new Map(), frames = [];
  const storage = { getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) };
  const channel = { postMessage: frame => frames.push(frame), close() {} };
  return { caseDoc, mirror, entries, frames, storage, channel };
}

test('Card 12 manual authority runs offline from memory and redacts marker text on upload', () => {
  const { caseDoc, mirror, entries, frames, storage, channel } = setup();
  const manual = new ConsoleManualRoom(mirror, caseDoc, { storage, channel });
  assert.equal(manual.enter().receipt, 'accepted');
  assert.equal(manual.command('manual_marker', { text: 'Spoken patient detail stays here' }).receipt, 'accepted');
  assert.equal(manual.view().manual !== null, true);
  assert.equal(manual.segmentBody().events.at(-1).text, '');
  assert.equal(JSON.stringify(manual.segmentBody()).includes('Spoken patient detail'), false);
  assert.equal(manual.notesText().includes('Spoken patient detail'), true);
  assert.equal([...entries.keys()].length, 1);
  assert.equal(frames.every(frame => frame.view.role === 'display' &&
    !JSON.stringify(frame).includes('Spoken patient detail') && !('caseDoc' in frame)), true);
  manual.close(); manual.forget();
  assert.deepEqual(frames.at(-1), { t: 'local_end', sessionId: mirror.sessionId });
  assert.equal(entries.size, 0);
});

test('Card 12 manual segment restores only on the original room epoch and remains bounded', () => {
  const first = setup();
  const manual = new ConsoleManualRoom(first.mirror, first.caseDoc,
    { storage: first.storage, channel: first.channel });
  assert.equal(manual.enter().receipt, 'accepted');
  const saved = ConsoleManualRoom.saved(first.mirror.sessionId, first.storage);
  assert.equal(saved.events.length, 1);
  const restored = ConsoleManualRoom.restore(first.mirror, first.caseDoc, saved,
    { storage: first.storage, channel: first.channel });
  assert.equal(restored?.view().manual !== null, true);
  assert.equal(ConsoleManualRoom.restore({ ...first.mirror, epoch: first.mirror.epoch + 1 },
    first.caseDoc, saved, { storage: first.storage, channel: first.channel }), null);
  assert.equal(ConsoleManualRoom.saved(first.mirror.sessionId,
    { getItem: () => 'x'.repeat(300_000) }), null);
  restored.close(); manual.close();
});

test('Card 12 manual segment uses a UTF-8 byte cap and rejects malformed stored markers', () => {
  const first = setup();
  const { caseDoc, mirror, storage, entries } = first;
  const manual = new ConsoleManualRoom(mirror, caseDoc, { storage, channel: first.channel });
  assert.equal(manual.enter().receipt, 'accepted');
  const key = [...entries.keys()][0];
  const stored = JSON.parse(entries.get(key));
  stored.markers = Array.from({ length: 300 }, () =>
    ({ at: '2026-10-02T00:00:00.000Z', text: 'é'.repeat(200) }));
  const enter = stored.events[0];
  stored.events = [enter, ...Array.from({ length: 299 }, () =>
    ({ v: enter.v, type: 'manual_marker', epoch: enter.epoch,
      clientEventId: enter.clientEventId, at: enter.at, text: 'é'.repeat(200) }))];
  const multibyte = JSON.stringify(stored);
  assert.equal(multibyte.length < 256_000, true);
  assert.equal(new TextEncoder().encode(multibyte).byteLength > 256_000, true);
  entries.set(key, multibyte);
  assert.equal(ConsoleManualRoom.saved(mirror.sessionId, storage), null);
  stored.events = stored.events.slice(0, 1);
  stored.markers = [{ at: '2026-10-02T00:00:00.000Z', text: { unsafe: true } }];
  entries.set(key, JSON.stringify(stored));
  assert.equal(ConsoleManualRoom.saved(mirror.sessionId, storage), null);
  manual.close(); manual.forget();
});

test('Card 12 manual authority reports when its tab segment could not be saved', () => {
  const first = setup();
  const storage = { getItem: () => null, setItem() { throw new Error('quota'); }, removeItem() {} };
  const manual = new ConsoleManualRoom(first.mirror, first.caseDoc,
    { storage, channel: first.channel });
  const receipt = manual.enter();
  assert.equal(receipt.receipt, 'accepted');
  assert.equal(manual.persistenceOk, false);
  assert.equal(manual.view().manual !== null, true);
  manual.close();
});

test('Card 12 manual marker normalises unsafe text before local notes or tab persistence', () => {
  const first = setup();
  const manual = new ConsoleManualRoom(first.mirror, first.caseDoc,
    { storage: first.storage, channel: first.channel });
  assert.equal(manual.enter().receipt, 'accepted');
  assert.equal(manual.command('manual_marker', { text: 'A\u202eB\u0000\ud800' }).receipt, 'accepted');
  const raw = [...first.entries.values()][0];
  assert.equal(raw.includes('\u202e') || raw.includes('\u0000') || raw.includes('\ud800'), false);
  assert.equal(manual.notesText().includes('A B'), true);
  assert.equal(manual.segmentBody().events.at(-1).text, '');
  manual.close(); manual.forget();
});

test('Card 12 manual restore refuses extra private fields and unclean stored text', () => {
  const first = setup();
  const manual = new ConsoleManualRoom(first.mirror, first.caseDoc,
    { storage: first.storage, channel: first.channel });
  assert.equal(manual.enter().receipt, 'accepted');
  const key = [...first.entries.keys()][0];
  const saved = JSON.parse(first.entries.get(key));
  saved.markers = [{ at: '2026-10-02T00:00:00.000Z', text: 'Clean', caseDoc: { hidden: true } }];
  first.entries.set(key, JSON.stringify(saved));
  assert.equal(ConsoleManualRoom.saved(first.mirror.sessionId, first.storage), null);
  saved.markers = [{ at: '2026-10-02T00:00:00.000Z', text: 'A\u202eB' }];
  first.entries.set(key, JSON.stringify(saved));
  assert.equal(ConsoleManualRoom.saved(first.mirror.sessionId, first.storage), null);
  saved.markers = [];
  saved.events[0].caseDoc = { hidden: true };
  first.entries.set(key, JSON.stringify(saved));
  assert.equal(ConsoleManualRoom.saved(first.mirror.sessionId, first.storage), null);
  manual.close(); manual.forget();
});

test('Card 12 manual close leaves an injected console projector channel usable', () => {
  const first = setup();
  let closed = false;
  const channel = { postMessage: frame => first.frames.push(frame), close() { closed = true; } };
  const manual = new ConsoleManualRoom(first.mirror, first.caseDoc,
    { storage: first.storage, channel });
  assert.equal(manual.enter().receipt, 'accepted');
  manual.close();
  channel.postMessage({ t: 'show_projector', sessionId: first.mirror.sessionId });
  assert.equal(closed, false);
  assert.equal(first.frames.at(-1).t, 'show_projector');
  manual.forget();
});

test('accepted manual End survives a failed public-channel send and still purges its segment', () => {
  const { caseDoc, mirror, storage, channel, entries } = setup();
  const manual = new ConsoleManualRoom(mirror, caseDoc, { storage, channel });
  assert.equal(manual.enter().receipt, 'accepted');
  channel.postMessage = () => { throw new Error('closed channel'); };
  assert.equal(manual.command('end').receipt, 'accepted');
  assert.equal(manual.view().phase, 'ended');
  assert.equal(JSON.parse([...entries.values()][0]).events.at(-1).type, 'end');
  const cleanup = [];
  closeConsoleResources({ sessionId: mirror.sessionId, manual, local: channel,
    link: { dropPending() { cleanup.push('drop'); }, forget() { cleanup.push('forget'); },
      close() { cleanup.push('close'); } } });
  assert.equal(entries.size, 0);
  assert.deepEqual(cleanup, ['drop', 'forget', 'close']);
});
