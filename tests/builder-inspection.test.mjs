import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountInspection } from '../src/client/builder-inspection.mjs';
import { createInspector } from '../src/client/builder-route.mjs';

// Minimal fake DOM: enough for mountInspection's chrome. Running the room is proved in e2e/run-preview.spec.mjs.
function fakeElement(tag) {
  const node = { tagName: tag.toUpperCase(), children: [], dataset: {}, style: {}, attributes: {}, listeners: {}, textContent: '', value: '',
    setAttribute(name, value) { this.attributes[name] = value; }, append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items; }, addEventListener(type, fn) { this.listeners[type] = fn; },
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; } };
  return node;
}
function fakeDocument() {
  return { title: '', compatMode: 'CSS1Compat', head: fakeElement('head'), body: fakeElement('body'), documentElement: { dataset: {} }, baseURI: 'https://case.test/', location: { origin: 'https://case.test' },
    createElement: fakeElement, createTextNode: text => ({ text }), getElementById: () => null, querySelectorAll: () => [] };
}
function harness() {
  const intervals = [], timeouts = [], listeners = {};
  const ownerWindow = { setInterval: fn => { intervals.push(fn); return intervals.length; }, clearInterval: () => { intervals.length = 0; },
    setTimeout: fn => { timeouts.push(fn); return timeouts.length; }, addEventListener: (type, fn) => { listeners[type] = fn; }, removeEventListener: () => {} };
  const doc = fakeDocument(), child = { closed: false, document: doc, focus() {}, close() { this.closed = true; }, addEventListener() {}, removeEventListener() {} };
  let generation = 1, retired = 0; const validated = [];
  const auth = { sessionGeneration: () => generation };
  const controller = mountInspection(child, { ownerWindow, sourceDocument: fakeDocument(), auth, onRetired: () => { retired++; }, validate: document => { validated.push(structuredClone(document)); return { ok: false, issues: [{ message: 'fake' }] }; } });
  return { controller, child, ownerWindow, intervals, timeouts, tick: () => intervals.forEach(fn => fn()), flush: () => timeouts.splice(0).forEach(fn => fn()),
    signOut: () => { generation++; }, retired: () => retired, validated };
}

test('[AS-150] an account change alone closes the child on the next liveness tick, without any Builder unmount', () => {
  const h = harness();
  assert.equal(h.controller.alive, true);
  h.signOut(); h.tick();
  assert.equal(h.child.closed, true);
  assert.equal(h.retired(), 1);
  assert.equal(h.controller.update({ document: {}, selection: {} }), false, 'a stopped controller never renders again');
  h.tick(); assert.equal(h.retired(), 1, 'stopping is idempotent');
});

test('[AS-150] a child closed by the user, or navigated away from the mounted document, stops its controller', () => {
  const closed = harness();
  closed.child.closed = true; closed.tick();
  assert.equal(closed.retired(), 1);
  const navigated = harness();
  navigated.child.document = fakeDocument();
  assert.equal(navigated.controller.alive, false);
  assert.equal(navigated.controller.update({ document: {}, selection: {} }), false);
  assert.equal(navigated.retired(), 1);
  const crossOrigin = harness();
  Object.defineProperty(crossOrigin.child, 'document', { get() { throw new Error('SecurityError'); } });
  crossOrigin.tick();
  assert.equal(crossOrigin.retired(), 1);
});

test('[AS-150] updates coalesce newest-only: a burst takes only the last pair, once', async () => {
  const h = harness();
  const first = { document: { title: 'first' }, selection: {} }, second = { document: { title: 'second' }, selection: {} };
  h.controller.update(first); h.controller.update(second);
  assert.equal(h.timeouts.length, 1, 'a burst schedules one take');
  h.flush(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.validated.map(document => document.title), ['second']);
});

test('[AS-150] the inspector opens the window inside the call, before anything is awaited, and reuses it', async () => {
  const calls = [];
  let release;
  const child = { closed: false, focus() { calls.push('focus'); }, close() { this.closed = true; } };
  const ownerWindow = { open(url, name) { calls.push(['open', url, name]); return child; } };
  const inspector = createInspector({ ownerWindow, sourceDocument: {}, auth: { sessionGeneration: () => 1 }, createName: () => 'case-inspection-test',
    load: () => new Promise(resolve => { release = resolve; }) });
  assert.equal(inspector.open(), true);
  assert.deepEqual(calls, [['open', 'about:blank', 'case-inspection-test']], 'opened synchronously, before the module loads');
  assert.equal(child.opener, null);
  inspector.open();
  assert.deepEqual(calls.at(-1), 'focus', 'a second click while loading focuses the same window');
  assert.equal(calls.filter(call => Array.isArray(call)).length, 1);
  release({ mountInspection: () => ({ alive: true, focus() { calls.push('focus-mounted'); return true; }, update() {}, close() {} }) });
  await new Promise(resolve => setImmediate(resolve));
  inspector.open();
  assert.equal(calls.at(-1), 'focus-mounted');
});

test('[AS-150] a late stop from a closed window cannot clear a newer one; a failed load is reported', async () => {
  const windows = [], stops = [], updates = [];
  const ownerWindow = { open() { const w = { closed: false, focus() {}, close() { this.closed = true; } }; windows.push(w); return w; } };
  let failed = null;
  const inspector = createInspector({ ownerWindow, sourceDocument: {}, auth: {}, onFailed: message => { failed = message; },
    load: async () => ({ mountInspection: (child, { onRetired }) => { stops.push(onRetired); const id = windows.indexOf(child); return { get alive() { return !child.closed; }, focus() { return true; }, update(next) { updates.push([id, next]); }, close() { child.close(); } }; } }) });
  inspector.open(); await new Promise(resolve => setImmediate(resolve));
  windows[0].closed = true;
  inspector.open(); await new Promise(resolve => setImmediate(resolve));
  stops[0]();
  inspector.update('latest');
  assert.deepEqual(updates.at(-1), [1, 'latest'], 'the newer window still receives edits');
  inspector.close();
  assert.equal(windows[1].closed, true, 'close still reaches the newer window');
  const broken = createInspector({ ownerWindow, sourceDocument: {}, auth: {}, onFailed: message => { failed = message; }, load: () => Promise.reject(new Error('chunk')) });
  broken.open(); await new Promise(resolve => setImmediate(resolve));
  assert.match(failed, /could not be loaded/);
  assert.equal(windows.at(-1).closed, true);
});
