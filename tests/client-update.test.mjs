import test from 'node:test';
import assert from 'node:assert/strict';
import { watchUpdate } from '../src/client/update.mjs';
test('declining a waiting service worker never activates it or reloads a room', () => {
  const serviceWorker = new EventTarget(); serviceWorker.controller = {};
  const registration = new EventTarget(); let messages = 0; registration.waiting = { postMessage() { messages++; } };
  let offer; let reloads = 0;
  watchUpdate({ registration, serviceWorker, offer(value) { offer = value; }, reload() { reloads++; } });
  assert.ok(offer); offer.decline(); serviceWorker.dispatchEvent(new Event('controllerchange'));
  assert.equal(messages, 0); assert.equal(reloads, 0);
});
test('accepting an update activates once and reloads only after controllerchange', () => {
  const serviceWorker = new EventTarget(); serviceWorker.controller = {};
  const registration = new EventTarget(); let message; registration.waiting = { postMessage(value) { message = value; } };
  let offer; let reloads = 0;
  watchUpdate({ registration, serviceWorker, offer(value) { offer = value; }, reload() { reloads++; } });
  offer.accept(); assert.deepEqual(message, { type: 'ACTIVATE_UPDATE' }); assert.equal(reloads, 0);
  serviceWorker.dispatchEvent(new Event('controllerchange')); serviceWorker.dispatchEvent(new Event('controllerchange')); assert.equal(reloads, 1);
});
