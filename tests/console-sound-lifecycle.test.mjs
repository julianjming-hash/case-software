// Execute the actual room sound action and device-mute handler against held promises.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(process.env.CASE_CONSOLE_SOUND_SOURCE || new URL('../src/client/console-room.mjs', import.meta.url), 'utf8');
const start = source.indexOf('  async function toggleUiSounds()');
// The slice ends where the in-place confirms begin (console layout v2 replaced the End room dialog).
const end = source.indexOf('  // Console layout v2 (Julian, 2026-10-18): every confirm is in place.', start);
assert.ok(start >= 0 && end > start);
const toggleSource = source.slice(start, end).replaceAll('import(', 'load(');
const preferenceStart = source.indexOf('  const preferenceChanged=event=>{');
const preferenceEnd = source.indexOf('\n  };', preferenceStart);
const preferenceSource = source.slice(preferenceStart, preferenceEnd + 5).replace('const preferenceChanged=', 'return ');
const make = new Function('env', `with (env) { ${toggleSource}; return {toggle:toggleUiSounds, preference: (()=>{ ${preferenceSource} })()}; }`);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function fixture({ rejectResume = false } = {}) {
  const imported = deferred(), calls = [], state = { uiTones: true, timelineCollapsed: true };
  let playerOptions;
  const env = {
    closed: false, uiAudio: null, uiSoundOn: false, uiSoundPending: false, uiSoundGeneration: 0, uiSoundModuleFailed: false, uiTones: null,
    statusText: '', timelineCollapsed: true, reducedMotion: { matches: false }, document: { hidden: false },
    location: { reload() { calls.push('reload'); } }, preferenceStorage: () => ({}),
    readDevicePreferences: () => state, DEVICE_PREFERENCE_KEYS: { uiTones: 'case:preferences:ui-tones' },
    writeDevicePreference(_storage, name, value) { calls.push(['write', name, value]); state[name] = value; return true; },
    readAudioLevel: (_storage, channel, fallback) => { assert.equal(channel, 'effects'); return .3; }, readVolume: () => .8,
    render() { calls.push('render'); },
    AudioContext: class { state = 'running'; resume() { calls.push('resume'); return rejectResume ? Promise.reject(Error('resume failed')) : Promise.resolve(); } },
    load() { calls.push('import'); return imported.promise; },
  };
  const player = { cancel() { calls.push('cancel'); } };
  const module = { createUiTonePlayer(options) { calls.push('player'); playerOptions = options; return player; } };
  return { env, state, calls, imported, module, ...make(env), playerOptions: () => playerOptions };
}

test('device mute during held module import cannot enable sound or rewrite the muted preference', async () => {
  const f = fixture(), pending = f.toggle();
  assert.ok(f.calls.includes('resume'), 'gesture resumes context before the action returns');
  await tick(); assert.ok(f.calls.includes('import'));
  f.state.uiTones = false; f.preference({ type: 'case-device-preferences-change' });
  f.imported.resolve(f.module); await pending;
  assert.equal(f.env.uiSoundOn, false); assert.equal(f.env.uiSoundPending, false);
  assert.equal(f.state.uiTones, false); assert.equal(f.calls.includes('player'), false);
  assert.equal(f.calls.some(c => Array.isArray(c) && c[2] === true), false);
});

test('pending enable is cancellable and a new gesture supersedes the old import continuation', async () => {
  const f = fixture(), old = f.toggle(); await tick();
  assert.equal(f.env.uiSoundPending, true);
  await f.toggle(); assert.equal(f.env.uiSoundPending, false); assert.equal(f.state.uiTones, false);
  const latest = f.toggle(); await tick(); f.imported.resolve(f.module); await Promise.all([old, latest]);
  assert.equal(f.env.uiSoundOn, true); assert.equal(f.calls.filter(c => c === 'player').length, 1);
  assert.equal(f.calls.filter(c => Array.isArray(c) && c[2] === true).length, 1);
  assert.equal(f.playerOptions().volume(), .3, 'console samples use the common effects volume caller');
});

test('closed console cannot finish a held enable', async () => {
  const f = fixture(), pending = f.toggle(); await tick(); f.env.closed = true;
  f.imported.resolve(f.module); await pending;
  assert.equal(f.env.uiSoundOn, false); assert.equal(f.calls.includes('player'), false);
  assert.equal(f.calls.some(c => Array.isArray(c) && c[2] === true), false);
});

test('cached module rejection exposes Reload and never pretends a repeated enable retries its URL', async () => {
  const f = fixture(), pending = f.toggle(); await tick(); f.imported.reject(Error('module unavailable')); await pending;
  assert.equal(f.env.uiSoundModuleFailed, true);
  assert.match(f.env.statusText, /Reload the page/); assert.equal(f.env.uiSoundPending, false);
  await f.toggle(); assert.deepEqual(f.calls.filter(c => c === 'import'), ['import']);
  assert.equal(f.calls.filter(c => c === 'reload').length, 1);
});

test('WebAudio resume failure remains a real retry and does not claim a module failure', async () => {
  const f = fixture({ rejectResume: true }); await f.toggle();
  assert.equal(f.env.uiSoundOn, false); assert.equal(f.env.uiSoundPending, false); assert.equal(f.env.uiSoundModuleFailed, false);
  assert.match(f.env.statusText, /Try enabling it again/); assert.equal(f.calls.includes('import'), false);
  await f.toggle(); assert.equal(f.calls.filter(c => c === 'resume').length, 2);
});
