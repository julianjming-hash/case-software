import test from 'node:test';
import assert from 'node:assert/strict';
import { turnstileSiteverifyUrl, turnstileWidgetScriptUrl } from '../src/shared/urls.mjs';

test('Turnstile Siteverify URL is fixed and cannot accept credential/query overrides', () => {
  assert.equal(turnstileSiteverifyUrl(), 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
  assert.equal(turnstileSiteverifyUrl('https://foreign.test/?token=forbidden'), 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
});

test('Turnstile widget script URL is fixed with explicit rendering and accepts no override', () => {
  assert.equal(turnstileWidgetScriptUrl(), 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit');
  assert.equal(turnstileWidgetScriptUrl('https://foreign.test/?token=forbidden'), 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit');
});
