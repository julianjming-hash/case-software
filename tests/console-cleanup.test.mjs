import test from 'node:test';
import assert from 'node:assert/strict';
import { closeConsoleResources } from '../src/client/console-room.mjs';

test('Card 12 console forgets its credential even when projector cleanup throws', () => {
  const called = [];
  const manual = { close() { called.push('manual_close'); throw new Error('closed channel'); },
    forget() { called.push('segment_forget'); } };
  const local = { postMessage() { called.push('post'); throw new Error('closed channel'); },
    close() { called.push('channel_close'); throw new Error('closed channel'); } };
  const link = { dropPending() { called.push('drop'); },
    forget() { called.push('forget'); }, close() { called.push('transport_close'); } };
  closeConsoleResources({ sessionId: 'room', manual, local, link });
  assert.deepEqual(called, ['manual_close', 'segment_forget', 'post', 'channel_close',
    'drop', 'forget', 'transport_close']);
});

test('Card 12 pagehide preserves only the tab manual segment while forgetting room capability', () => {
  const called = [];
  const manual = { close() { called.push('manual_close'); }, forget() { called.push('segment_forget'); } };
  const local = { postMessage() {}, close() {} };
  const link = { dropPending() {}, forget() { called.push('credential_forget'); }, close() {} };
  closeConsoleResources({ sessionId: 'room', manual, local, link, preserveSegment: true });
  assert.deepEqual(called, ['manual_close', 'credential_forget']);
  called.length = 0;
  closeConsoleResources({ sessionId: 'room', manual, local, link, preserveSegment: false });
  assert.deepEqual(called, ['manual_close', 'segment_forget', 'credential_forget']);
});

test('Card 12 wake release failure cannot retain the facilitator capability', () => {
  let forgot = false, released = false;
  closeConsoleResources({ sessionId: 'room', wake: { dispose() { released = true; throw new Error('device'); } },
    link: { forget() { forgot = true; } } });
  assert.equal(released, true);
  assert.equal(forgot, true);
});
