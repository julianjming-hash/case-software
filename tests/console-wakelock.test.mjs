import test from 'node:test';
import assert from 'node:assert/strict';
import { keepScreenAwake } from '../src/client/device.mjs';

function harness(request) {
  const listeners = new Map();
  const documentRef = { visibilityState: 'visible',
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type); } };
  return { documentRef, navigatorRef: { wakeLock: { request } }, listeners };
}

test('Card 12 late wake lock grant is released after console close and cannot reacquire', async () => {
  let resolveRequest, releases = 0, requests = 0;
  const pending = new Promise(resolve => { resolveRequest = resolve; });
  const source = harness(() => { requests++; return pending; });
  const wake = keepScreenAwake(source);
  wake.dispose();
  resolveRequest({ addEventListener() {}, release() { releases++; } });
  await new Promise(resolve => setImmediate(resolve));
  source.listeners.get('visibilitychange')?.();
  assert.equal(releases, 1);
  assert.equal(requests, 1);
  assert.equal(wake.held, false);
  assert.equal(source.listeners.has('visibilitychange'), false);
});

test('Card 12 held wake lock is released on close despite a rejecting release promise', async () => {
  let releases = 0;
  const source = harness(async () => ({ addEventListener() {},
    release() { releases++; return Promise.reject(new Error('device_unavailable')); } }));
  const wake = keepScreenAwake(source);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(wake.held, true);
  wake.dispose();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(releases, 1);
  assert.equal(wake.held, false);
});
