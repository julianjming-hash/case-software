import test from 'node:test';
import assert from 'node:assert/strict';
import { observeDisplayTopology } from '../src/client/console-screen.mjs';
import { createDisplayCheck } from '../src/client/console-device.mjs';

function emitter(initial = {}) {
  const listeners = new Map();
  return { ...initial, addEventListener(name, fn) { listeners.set(name, fn); },
    removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
    fire(name) { listeners.get(name)?.(); }, listeners };
}

test('Card 12 real screen extension change invalidates the observed display count without a prompt', async () => {
  const screenRef = emitter({ isExtended: true }), seen = [];
  const observer = observeDisplayTopology({ screenRef, onChange: count => seen.push(count),
    windowRef: {}, navigatorRef: {}, schedule: () => 0, unschedule() {} });
  assert.equal(observer.count, 2);
  screenRef.isExtended = false; screenRef.fire('change');
  assert.deepEqual(seen, [2, 1]);
  observer.dispose(); screenRef.isExtended = true; screenRef.fire('change');
  assert.deepEqual(seen, [2, 1]);
});

test('Card 12 granted ScreenDetails counts three displays and observes a disconnect', async () => {
  const screenRef = emitter({ isExtended: true }), details = emitter({ screens: [{}, {}, {}] });
  const seen = [];
  const observer = observeDisplayTopology({ screenRef, onChange: count => seen.push(count),
    navigatorRef: { permissions: { query: async () => ({ state: 'granted' }) } },
    windowRef: { getScreenDetails: async () => details }, schedule: () => 0, unschedule() {} });
  await observer.ready;
  assert.equal(observer.count, 3);
  details.screens = [{}]; details.fire('screenschange');
  assert.deepEqual(seen, [2, 3, 1]);
  observer.dispose(); assert.equal(details.listeners.has('screenschange'), false);
});

// CASE-167: screen identity. These tests drive the observer the way console-room
// does: every poll feeds count + fingerprint into createDisplayCheck.update.
function room(observer, check) {
  return () => check.update({ connected: true, displayCount: observer.count,
    pairingId: 'pairing-0', screenId: observer.fingerprint });
}
const granted = { permissions: { query: async () => ({ state: 'granted' }) } };
const quiet = { schedule: () => 0, unschedule() {} };
function detailedSetup() {
  const laptop = { label: 'Built-in Retina Display', left: 0, top: 0, width: 1440, height: 900,
    availHeight: 875, isPrimary: true, isExtended: true, devicePixelRatio: 2 };
  const projector = { label: 'EPSON PJ', left: 1440, top: 0, width: 1920, height: 1080,
    availHeight: 1080, isPrimary: false, isExtended: true, devicePixelRatio: 1 };
  const screenRef = emitter({ isExtended: true, width: 1440, height: 900, availHeight: 875 });
  const details = emitter({ screens: [laptop, projector], currentScreen: laptop });
  let calls = 0;
  const windowRef = { screenX: 100, screenY: 50, outerWidth: 1200, outerHeight: 800, devicePixelRatio: 2,
    getScreenDetails: async () => { calls += 1; return details; } };
  return { laptop, projector, screenRef, details, windowRef, calls: () => calls };
}
function fallbackSetup(extra = {}) {
  const screenRef = emitter({ width: 1440, height: 900, availWidth: 1440, availHeight: 875, ...extra });
  const windowRef = { screenX: 100, screenY: 50, outerWidth: 1200, outerHeight: 800, devicePixelRatio: 2 };
  return { screenRef, windowRef };
}

test('CASE-167 (a) a different projector at the same screen count clears the display check', async () => {
  const s = detailedSetup(), check = createDisplayCheck();
  const observer = observeDisplayTopology({ screenRef: s.screenRef, windowRef: s.windowRef, navigatorRef: granted, ...quiet });
  await observer.ready; const poll = room(observer, check);
  poll(); check.confirm(); poll(); assert.equal(check.needsCheck(), false);
  s.details.screens = [s.laptop, { ...s.projector, label: 'Hospital Panasonic', width: 1280, height: 800 }];
  s.details.fire('screenschange'); poll();
  assert.equal(observer.count, 2);
  assert.equal(check.needsCheck(), true);
  observer.dispose();
});

test('CASE-167 (b) the console window moving to another screen clears the display check', async () => {
  const s = detailedSetup(), check = createDisplayCheck();
  const observer = observeDisplayTopology({ screenRef: s.screenRef, windowRef: s.windowRef, navigatorRef: granted, ...quiet });
  await observer.ready; const poll = room(observer, check);
  poll(); check.confirm(); poll(); assert.equal(check.needsCheck(), false);
  s.details.currentScreen = s.projector; s.details.fire('currentscreenchange'); poll();
  assert.equal(check.needsCheck(), true);
  observer.dispose();
  assert.equal(s.details.listeners.has('currentscreenchange'), false);
});

test('CASE-167 (b) without the permission, a move to a different-sized screen clears the display check', () => {
  const s = fallbackSetup({ isExtended: true }), check = createDisplayCheck();
  const observer = observeDisplayTopology({ screenRef: s.screenRef, windowRef: s.windowRef, navigatorRef: {}, ...quiet });
  const poll = room(observer, check);
  poll(); check.confirm(); poll(); assert.equal(check.needsCheck(), false);
  Object.assign(s.screenRef, { width: 1920, height: 1080, availWidth: 1920, availHeight: 1080 });
  Object.assign(s.windowRef, { screenX: 1600 }); s.screenRef.fire('change'); poll();
  assert.equal(check.needsCheck(), true);
  observer.dispose();
});

test('CASE-167 (c) mirroring toggled where the browser reports no screen count clears the display check', () => {
  const s = fallbackSetup(), check = createDisplayCheck();
  const observer = observeDisplayTopology({ screenRef: s.screenRef, windowRef: s.windowRef, navigatorRef: {}, ...quiet });
  const poll = room(observer, check);
  poll(); check.confirm(); poll();
  assert.equal(observer.count, null); assert.equal(check.needsCheck(), false);
  // macOS/Windows mirroring puts both outputs on one shared mode.
  Object.assign(s.screenRef, { width: 1024, height: 768, availWidth: 1024, availHeight: 743 }); poll();
  assert.equal(observer.count, null);
  assert.equal(check.needsCheck(), true);
  observer.dispose();
});

test('CASE-167 same-screen move, resize, dock autohide and zoom do not clear the display check', async () => {
  const s = detailedSetup(), check = createDisplayCheck();
  const observer = observeDisplayTopology({ screenRef: s.screenRef, windowRef: s.windowRef, navigatorRef: granted, ...quiet });
  await observer.ready; const poll = room(observer, check);
  poll(); check.confirm(); poll();
  Object.assign(s.windowRef, { screenX: 300, screenY: 120, outerWidth: 900, outerHeight: 600, devicePixelRatio: 2.2 });
  s.details.currentScreen = { ...s.laptop, availHeight: 900, devicePixelRatio: 2.0000001 };
  s.screenRef.availHeight = 900; s.details.fire('currentscreenchange'); poll();
  assert.equal(check.needsCheck(), false);
  observer.dispose();
  const f = fallbackSetup({ isExtended: true }), fallbackCheck = createDisplayCheck();
  const coarse = observeDisplayTopology({ screenRef: f.screenRef, windowRef: f.windowRef, navigatorRef: {}, ...quiet });
  const coarsePoll = room(coarse, fallbackCheck);
  coarsePoll(); fallbackCheck.confirm(); coarsePoll();
  Object.assign(f.windowRef, { screenX: 20, screenY: 0, outerWidth: 1400, outerHeight: 875, devicePixelRatio: 1.75 });
  Object.assign(f.screenRef, { availHeight: 900, availWidth: 1380 }); coarsePoll();
  assert.equal(fallbackCheck.needsCheck(), false);
  coarse.dispose();
});

test('CASE-167 permission not granted uses the fallback fingerprint and never calls getScreenDetails', async () => {
  for (const state of ['prompt', 'denied']) {
    const s = detailedSetup(), queried = [];
    const observer = observeDisplayTopology({ screenRef: s.screenRef, windowRef: s.windowRef,
      navigatorRef: { permissions: { query: async q => { queried.push(q.name); return { state }; } } }, ...quiet });
    await observer.ready;
    assert.deepEqual(queried, ['window-management']);
    assert.equal(s.calls(), 0);
    assert.equal(typeof observer.fingerprint, 'string');
    assert.match(observer.fingerprint, /^coarse:/);
    observer.dispose();
  }
});

test('CASE-167 fifty unchanged polls, with same-screen jitter, never clear a confirmation', async () => {
  for (const mode of ['detailed', 'coarse']) {
    const s = mode === 'detailed' ? detailedSetup() : fallbackSetup({ isExtended: true });
    const check = createDisplayCheck();
    const observer = observeDisplayTopology({ screenRef: s.screenRef, windowRef: s.windowRef,
      navigatorRef: mode === 'detailed' ? granted : {}, ...quiet });
    await observer.ready; const poll = room(observer, check);
    poll(); check.confirm();
    for (let i = 0; i < 50; i += 1) {
      Object.assign(s.windowRef, { screenX: 100 + (i % 7) * 10, outerWidth: 1200 - (i % 5) * 20,
        devicePixelRatio: 2 + (i % 3) * 0.0001 });
      s.screenRef.availHeight = 875 + (i % 2) * 25;
      poll();
      assert.equal(check.needsCheck(), false, `${mode} poll ${i} cleared the confirmation`);
    }
    observer.dispose();
  }
});

// Red-team round 1 (CASE-167).
function confirmedFallback(screen, win) {
  const s = { screenRef: emitter(screen), windowRef: win }, check = createDisplayCheck();
  const observer = observeDisplayTopology({ ...s, navigatorRef: {}, ...quiet });
  const poll = room(observer, check); poll(); check.confirm(); poll();
  return { s, check, observer, poll };
}

test('CASE-167 fallback: a drag within a 2560 screen right of a 1920 laptop does not clear', () => {
  const { s, check, observer, poll } = confirmedFallback({ width: 2560, height: 1440, isExtended: true },
    { screenX: 1920, screenY: 0, outerWidth: 1000, outerHeight: 900 });
  for (const screenX of [2500, 3000, 3400, 1950]) { s.windowRef.screenX = screenX; poll(); }
  assert.equal(check.needsCheck(), false);
  observer.dispose();
});

test('CASE-167 fallback: a drag within a 1366 console screen right of a 1920 primary projector does not clear', () => {
  const { s, check, observer, poll } = confirmedFallback({ width: 1366, height: 768, isExtended: true },
    { screenX: 1920, screenY: 0, outerWidth: 1000, outerHeight: 700 });
  for (const [screenX, outerWidth] of [[2300, 900], [2600, 600], [1930, 1366]]) {
    Object.assign(s.windowRef, { screenX, outerWidth }); poll();
  }
  assert.equal(check.needsCheck(), false);
  observer.dispose();
});

test('CASE-167 getScreenDetails resolving after a confirmation does not clear it (startup race)', async () => {
  const s = detailedSetup(), check = createDisplayCheck();
  s.details.screens = [...s.details.screens, { ...s.projector, label: 'Third', left: 3360 }];
  let open; const gate = new Promise(resolve => { open = resolve; });
  const windowRef = { ...s.windowRef, getScreenDetails: async () => { await gate; return s.details; } };
  const observer = observeDisplayTopology({ screenRef: s.screenRef, windowRef, navigatorRef: granted, ...quiet });
  const poll = room(observer, check);
  poll(); assert.match(observer.fingerprint, /^coarse:/);
  check.confirm(); poll();
  open(); await observer.ready; poll();
  assert.match(observer.fingerprint, /^detailed:/); assert.equal(observer.count, 3);
  assert.equal(check.needsCheck(), false);
  // A real change after the switch still clears.
  s.details.screens = s.details.screens.slice(0, 2); s.details.fire('screenschange'); poll();
  assert.equal(check.needsCheck(), true);
  observer.dispose();
});

test('CASE-167 the browser listing the same screens in another order does not clear', async () => {
  const s = detailedSetup(), check = createDisplayCheck();
  const observer = observeDisplayTopology({ screenRef: s.screenRef, windowRef: s.windowRef, navigatorRef: granted, ...quiet });
  await observer.ready; const poll = room(observer, check);
  poll(); check.confirm(); poll();
  s.details.screens = [...s.details.screens].reverse(); s.details.fire('screenschange'); poll();
  assert.equal(check.needsCheck(), false);
  observer.dispose();
});

test('CASE-167 opt-in: the screen-identity request is offered only for a prompt state and only runs when asked', async () => {
  const cases = [['prompt', true], ['granted', false], ['denied', false]];
  for (const [state, offered] of cases) {
    const s = detailedSetup();
    const observer = observeDisplayTopology({ screenRef: s.screenRef, windowRef: s.windowRef,
      navigatorRef: { permissions: { query: async () => ({ state }) } }, ...quiet });
    await observer.ready;
    assert.equal(observer.canRequestScreens, offered, state);
    assert.equal(s.calls(), state === 'granted' ? 1 : 0, state);
    observer.dispose();
  }
  const bare = observeDisplayTopology({ screenRef: emitter({ width: 1440, height: 900 }), windowRef: {},
    navigatorRef: { permissions: { query: async () => ({ state: 'prompt' }) } }, ...quiet });
  await bare.ready; assert.equal(bare.canRequestScreens, false); bare.dispose();
});

test('CASE-167 opt-in: granting switches to detailed identity without clearing a confirmation', async () => {
  const s = detailedSetup(), check = createDisplayCheck();
  let state = 'prompt';
  const observer = observeDisplayTopology({ screenRef: s.screenRef, windowRef: s.windowRef,
    navigatorRef: { permissions: { query: async () => ({ state }) } }, ...quiet });
  await observer.ready; const poll = room(observer, check);
  poll(); check.confirm(); poll();
  state = 'granted';
  assert.equal(await observer.requestScreens(), true);
  poll();
  assert.equal(s.calls(), 1);
  assert.match(observer.fingerprint, /^detailed:/);
  assert.equal(observer.canRequestScreens, false);
  assert.equal(check.needsCheck(), false);
  s.details.currentScreen = s.projector; s.details.fire('currentscreenchange'); poll();
  assert.equal(check.needsCheck(), true);
  observer.dispose();
});

test('CASE-167 opt-in: a denied request is quiet and keeps the fallback', async () => {
  const s = detailedSetup(), check = createDisplayCheck();
  let state = 'prompt';
  const windowRef = { ...s.windowRef, getScreenDetails: async () => {
    state = 'denied'; throw new DOMException('Permission denied', 'NotAllowedError'); } };
  const observer = observeDisplayTopology({ screenRef: s.screenRef, windowRef,
    navigatorRef: { permissions: { query: async () => ({ state }) } }, ...quiet });
  await observer.ready; const poll = room(observer, check);
  poll(); check.confirm(); poll();
  assert.equal(await observer.requestScreens(), false);
  poll();
  assert.match(observer.fingerprint, /^coarse:/);
  assert.equal(observer.canRequestScreens, false);
  assert.equal(check.needsCheck(), false);
  observer.dispose();
});

test('CASE-167 opt-in: a grant that reveals two screens where the fallback saw one clears the confirmation', async () => {
  const s = detailedSetup(), check = createDisplayCheck();
  s.screenRef.isExtended = false;
  let state = 'prompt';
  const observer = observeDisplayTopology({ screenRef: s.screenRef, windowRef: s.windowRef,
    navigatorRef: { permissions: { query: async () => ({ state }) } }, ...quiet });
  await observer.ready; const poll = room(observer, check);
  poll(); assert.equal(observer.count, 1); check.confirm(); poll();
  state = 'granted'; assert.equal(await observer.requestScreens(), true); poll();
  assert.equal(observer.count, 2);
  assert.equal(check.needsCheck(), true);
  observer.dispose();
});

test('CASE-167 a permission query that never settles, or missing screen APIs, never blocks or throws the safety poll', () => {
  const check = createDisplayCheck();
  const hung = observeDisplayTopology({ screenRef: emitter({ width: 390, height: 844 }),
    windowRef: { getScreenDetails: async () => { throw new Error('must not be called'); } },
    navigatorRef: { permissions: { query: () => new Promise(() => {}) } }, ...quiet });
  const poll = room(hung, check);
  poll(); check.confirm();
  for (let i = 0; i < 50; i += 1) poll();
  assert.equal(hung.count, null); assert.equal(hung.canRequestScreens, false);
  assert.equal(check.needsCheck(), false);
  hung.dispose();
  for (const screenRef of [undefined, null, {}]) {
    const bare = observeDisplayTopology({ screenRef, windowRef: undefined, navigatorRef: undefined, ...quiet });
    assert.equal(typeof bare.fingerprint, 'string');
    assert.doesNotThrow(() => room(bare, createDisplayCheck())());
    bare.dispose();
  }
});
