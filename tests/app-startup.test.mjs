import assert from 'node:assert/strict';
import test from 'node:test';
import { boot } from '../src/client/app-boot.mjs';

test('surface readiness awaits asynchronous mount while corrective shell starts independently', async () => {
  const calls = []; let release;
  const pending = boot({ route: () => { calls.push('mount'); return new Promise(resolve => { release = resolve; }); },
    notice: () => calls.push('failure'), startShell: () => calls.push('shell') });
  await Promise.resolve();
  assert.deepEqual(calls, ['mount', 'shell']);
  let settled = false; pending.then(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false);
  release(); await pending; assert.equal(settled, true);
});

test('an asynchronous mount rejection is handled after shell startup without leaking the error', async () => {
  const calls = []; let reject;
  const pending = boot({ route: () => new Promise((_, fail) => { reject = fail; }),
    notice: reason => calls.push(['failure', reason]), startShell: () => calls.push(['shell']) });
  reject(new Error('private diagnostic must not reach the UI')); await pending;
  assert.deepEqual(calls, [['shell'], ['failure', { timedOut: false }]]);
});

test('a readiness deadline offers recovery without remounting or cancelling privacy work', async () => {
  const calls = []; let finish, fire; let timerCleared = false;
  const pending = boot({ route: () => { calls.push('mount'); return new Promise(resolve => { finish = resolve; }); },
    notice: reason => calls.push(['notice', reason]), startShell: () => calls.push('shell'),
    setTimer: callback => { fire = callback; return 123; }, clearTimer: id => { assert.equal(id, 123); timerCleared = true; } });
  assert.equal(typeof fire, 'function'); fire();
  assert.deepEqual(calls, ['mount', 'shell', ['notice', { timedOut: true }]]);
  assert.equal(timerCleared, false); finish(); await pending;
  assert.equal(timerCleared, true); assert.equal(calls.filter(call => call === 'mount').length, 1);
});

test('failed notice and a rejected shell registration cannot create an unhandled bootstrap rejection', async () => {
  await boot({ route: async () => { throw Error('surface'); }, notice: () => { throw Error('notice'); },
    startShell: async () => { throw Error('shell'); } });
  await boot({ route: async () => {}, notice: () => { throw Error('notice'); }, startShell: () => { throw Error('shell'); } });
});
