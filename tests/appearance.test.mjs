// Card 29 (CASE-166): Appearance is a local preference applied before first paint by a classic script
// (no inline code, CSP and Trusted Types unchanged), never on projector documents, and it survives the
// facilitator and participant teardowns. The browser no-flash and Auto checks are in e2e/library-root.spec.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { APPEARANCE_KEY, readAppearance, setAppearance } from '../src/client/appearance.mjs';
import { STORAGE_FENCE_KEY } from '../src/client/storage-generation.mjs';
import { createTeardown, assertKnownStorageKeys, TEARDOWN_KEYS } from '../src/client/teardown.mjs';

const BOOT = readFileSync(new URL('../src/client/appearance-boot.mjs', import.meta.url), 'utf8');
const storage = (entries = {}) => {
  const map = new Map(Object.entries(entries));
  return { get length() { return map.size; }, key: i => [...map.keys()][i] ?? null, getItem: k => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k), entries: () => [...map] };
};
function boot(path, stored, { throws = false } = {}) {
  const attributes = new Map();
  const root = { setAttribute: (k, v) => attributes.set(k, v) };
  const localStorage = throws ? { getItem() { throw new Error('blocked'); } } : storage(stored === undefined ? {} : { [APPEARANCE_KEY]: stored });
  const context = { document: { documentElement: root }, location: { pathname: path } };
  context.globalThis = { ...context, localStorage };
  vm.runInNewContext(BOOT, context);
  return attributes.get('data-theme') ?? null;
}

test('[AS-103] the pre-paint script applies a stored Light or Dark before first paint, and nothing for Auto', () => {
  assert.doesNotMatch(BOOT, /\b(?:import|export)\b|innerHTML|document\.write|eval\(/, 'a classic script with no sinks');
  assert.equal(boot('/', 'dark'), 'dark');
  assert.equal(boot('/cases', 'light'), 'light');
  assert.equal(boot('/J/A7K2M9', 'dark'), 'dark');
  for (const value of [undefined, 'auto', 'DARK', '<b>', '']) assert.equal(boot('/', value), null, String(value));
  assert.equal(boot('/', 'dark', { throws: true }), null, 'blocked storage falls back to the OS theme');
});

test('[AS-103] projector documents follow their own device, never the stored choice', () => {
  for (const path of ['/D/ABCD2345', '/d/abcd2345', '/sessions/0199a000-0000-7000-8000-000000000001/display',
    '/sessions/0199a000-0000-7000-8000-000000000001/facilitate']) assert.equal(boot(path, 'dark'), null, path);
});

test('[AS-103] setAppearance stores only light or dark; Auto clears both the key and the attribute', () => {
  const store = storage(), attributes = new Map();
  const root = { setAttribute: (k, v) => attributes.set(k, v), removeAttribute: k => attributes.delete(k) };
  assert.equal(setAppearance('dark', { storage: store, root }), 'dark');
  assert.equal(readAppearance(store), 'dark'); assert.equal(attributes.get('data-theme'), 'dark');
  assert.equal(setAppearance('auto', { storage: store, root }), 'auto');
  assert.equal(store.getItem(APPEARANCE_KEY), null); assert.equal(attributes.has('data-theme'), false);
  assert.equal(setAppearance('neon', { storage: store, root }), 'auto');
  assert.equal(readAppearance({ getItem() { throw new Error('blocked'); } }), 'auto');
});

test('[AS-103] the appearance key is a known preference that every teardown keeps', async () => {
  assert.doesNotThrow(() => assertKnownStorageKeys([APPEARANCE_KEY]));
  assert.ok(TEARDOWN_KEYS.preferences.includes(APPEARANCE_KEY));
  for (const reason of ['sign_out', 'pagehide', 'room_end', 'refresh_failed']) {
    const localStorage = storage({ [APPEARANCE_KEY]: 'dark', 'case:auth:refresh': 'private', 'case:participant:main:token': '{}' });
    const sessionStorage = storage({ 'case:auth:pkce': 'x' });
    const indexedDB = { databases: async () => [], deleteDatabase() { const request = {}; queueMicrotask(() => request.onsuccess?.()); return request; } };
    await createTeardown({ localStorage, sessionStorage, caches: null, indexedDB })(reason);
    // Card 38 (CASE-175): the account refresh token survives every teardown except those that end the account.
    assert.deepEqual(localStorage.entries(), ['sign_out', 'refresh_failed'].includes(reason)
      ? [[APPEARANCE_KEY, 'dark'], [STORAGE_FENCE_KEY, '1']] : [[APPEARANCE_KEY, 'dark'], ['case:auth:refresh', 'private'], [STORAGE_FENCE_KEY, '1']], reason);
  }
});


test('denied localStorage getter keeps appearance reads and local painting usable', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const painted = new Map();
  const root = { setAttribute: (key, value) => painted.set(key, value), removeAttribute: key => painted.delete(key) };
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new DOMException('Denied', 'SecurityError'); } });
    assert.equal(readAppearance(), 'auto');
    assert.equal(setAppearance('dark', { root }), 'dark');
    assert.equal(painted.get('data-theme'), 'dark');
    assert.equal(setAppearance('auto', { root }), 'auto');
    assert.equal(painted.has('data-theme'), false);
  } finally { if (original) Object.defineProperty(globalThis, 'localStorage', original); else delete globalThis.localStorage; }
});
