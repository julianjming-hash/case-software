import test from 'node:test';
import assert from 'node:assert/strict';
import { newCapabilityToken } from '../src/shared/ids.mjs';
import { createTurnstileController } from '../src/client/turnstile-widget.mjs';

function fixture() {
  const scripts = [], policies = [], renders = [], removed = [], tokens = [], failures = [];
  const win = {};
  const document = { head: { appendChild: script => scripts.push(script) }, createElement: kind => {
    assert.equal(kind, 'script'); return { remove() { this.removed = true; } };
  } };
  const trusted = { createPolicy(name, rules) {
    policies.push({ name, rules }); return { createScriptURL: value => ({ trusted: rules.createScriptURL(value) }) };
  } };
  const api = { render(container, options) { renders.push({ container, options }); return String(renders.length); }, remove: id => removed.push(id), reset() {} };
  const container = { ownerDocument: document };
  const options = { documentImpl: document, windowImpl: win, trustedTypesImpl: trusted, onToken: token => tokens.push(token), onUnavailable: reason => failures.push(reason), loaderTimeoutMs: 25 };
  const controller = createTurnstileController(container, options);
  const loaded = () => { win.turnstile = api; scripts.at(-1).onload(); };
  return { scripts, policies, renders, removed, tokens, failures, win, api, container, options, controller, loaded };
}

test('widget loader uses only exact case-turnstile ScriptURL policy and fixed explicit-render script', async () => {
  const f = fixture(); const key = newCapabilityToken(); const pending = f.controller.challenge(key);
  assert.equal(f.scripts.length, 1); assert.equal(f.policies.length, 1);
  assert.equal(f.policies[0].name, 'case-turnstile'); assert.deepEqual(Object.keys(f.policies[0].rules), ['createScriptURL']);
  assert.deepEqual(f.scripts[0].src, { trusted: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit' });
  assert.throws(() => f.policies[0].rules.createScriptURL('https://foreign.test/'), TypeError);
  f.loaded(); assert.equal(await pending, true);
  assert.equal(f.renders[0].container, f.container); assert.equal(f.renders[0].options.sitekey, key);
  assert.equal(f.renders[0].options.action, 'join'); f.controller.close();
});

test('widget refuses malformed public keys before creating a script or rendering', async () => {
  const f = fixture();
  for (const key of ['', null, 10, '<invalid>', 'x'.repeat(129), 'key\n']) assert.equal(await f.controller.challenge(key), false);
  assert.deepEqual(f.scripts, []); assert.deepEqual(f.renders, []);
  assert.ok(f.failures.every(x => x === 'challenge_unavailable')); f.controller.close();
});

test('widget token stays in memory, is taken once and expiry or malformed callbacks clear it', async () => {
  const f = fixture(); const pending = f.controller.challenge(newCapabilityToken()); f.loaded(); await pending;
  const callbacks = f.renders[0].options, token = newCapabilityToken(); callbacks.callback(token);
  assert.equal(f.controller.takeToken(), token); assert.equal(f.controller.takeToken(), null);
  callbacks.callback(token); callbacks['expired-callback'](); assert.equal(f.controller.takeToken(), null);
  for (const invalid of ['', null, 42, 'x'.repeat(2049), 'a\nb']) { callbacks.callback(invalid); assert.equal(f.controller.takeToken(), null); }
  assert.equal(f.scripts[0].src.trusted.includes(token), false); f.controller.close();
});

test('widget close while loading fences late script, render and callbacks without blocking a join', async () => {
  const f = fixture(); const pending = f.controller.challenge(newCapabilityToken()); const late = f.scripts[0].onload;
  f.controller.close(); assert.equal(await pending, false);
  f.win.turnstile = f.api; late(); assert.deepEqual(f.renders, []); assert.deepEqual(f.tokens, []); assert.deepEqual(f.failures, []);
  assert.equal(f.scripts[0].removed, true); assert.equal(await f.controller.challenge(newCapabilityToken()), false);
});

test('widget replacing a challenge ignores earlier callbacks and reuses its exact policy', async () => {
  const f = fixture(); const first = f.controller.challenge(newCapabilityToken()); f.loaded(); await first;
  const old = f.renders[0].options;
  assert.equal(await f.controller.challenge(newCapabilityToken()), true);
  const current = f.renders[1].options, token = newCapabilityToken(); current.callback(token);
  old.callback(newCapabilityToken()); old['expired-callback'](); assert.equal(f.controller.takeToken(), token);
  assert.deepEqual(f.removed, ['1']); assert.equal(f.policies.length, 1); f.controller.close();
});

test('widget whole load deadline and optional callback failures are contained with fixed errors', { timeout: 1000 }, async () => {
  const f = fixture(); const started = performance.now();
  assert.equal(await f.controller.challenge(newCapabilityToken()), false); assert.ok(performance.now() - started < 250);
  assert.deepEqual(f.failures, ['challenge_unavailable']); assert.equal(f.scripts[0].removed, true); f.controller.close();
  const g = fixture(); g.options.onToken = () => Promise.reject(Error('fixed fixture failure'));
  const controller = createTurnstileController(g.container, g.options), pending = controller.challenge(newCapabilityToken()); g.loaded();
  assert.equal(await pending, true); g.renders[0].options.callback(newCapabilityToken()); controller.close();
});

test('widget loader failure permits a fresh attempt and never keeps an invalid token', async () => {
  const f = fixture(); const first = f.controller.challenge(newCapabilityToken()); f.scripts[0].onerror(); assert.equal(await first, false);
  const next = f.controller.challenge(newCapabilityToken()); assert.equal(f.scripts.length, 2); f.loaded(); assert.equal(await next, true);
  f.renders[0].options.callback(newCapabilityToken()); f.renders[0].options['error-callback'](); assert.equal(f.controller.takeToken(), null);
  assert.deepEqual(f.failures, ['challenge_unavailable', 'challenge_unavailable']); f.controller.close();
});
