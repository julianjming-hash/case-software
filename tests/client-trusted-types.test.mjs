import test from 'node:test';
import assert from 'node:assert/strict';
import { serviceWorkerScriptURL, standardsPage, BLANK_PAGE } from '../src/client/shell.mjs';

/** A Trusted Types factory that, like the browser under `trusted-types case-default`, refuses a second policy. */
function factory() {
  const made = [];
  return { made, createPolicy(name, rules) {
    if (made.length) throw new TypeError('duplicate_policy');
    made.push({ name, rules });
    return { createScriptURL: value => ({ url: rules.createScriptURL(value) }), createHTML: value => ({ html: rules.createHTML(value) }) };
  } };
}

test('the one case-default policy admits exactly the service worker path and the blank standards-mode page (CASE-249, Q4 a)', () => {
  const trusted = factory();
  assert.deepEqual(serviceWorkerScriptURL(trusted), { url: '/sw.mjs' });
  const [{ name, rules }] = trusted.made;
  assert.equal(name, 'case-default');
  assert.deepEqual(Object.keys(rules), ['createScriptURL', 'createHTML']);
  assert.equal(BLANK_PAGE, '<!doctype html>');
  for (const value of ['/other.mjs', '/sw.mjs?code=AAAAAA', 'https://example.test/sw.mjs', '<script>']) assert.throws(() => rules.createScriptURL(value), /unsupported_script/);
  for (const value of ['', '<!doctype html><script>alert(1)</script>', '<!DOCTYPE html>', '<!doctype html> ', '<b>x</b>', BLANK_PAGE.repeat(2)]) assert.throws(() => rules.createHTML(value), /unsupported_html/);
  assert.equal(rules.createHTML(BLANK_PAGE), BLANK_PAGE);
});

test('the policy is created once per realm and serves every later document write', () => {
  const trusted = factory(), writes = [];
  const blank = () => ({ compatMode: 'BackCompat', open() { writes.push('open'); }, write(html) { writes.push(html); this.compatMode = 'CSS1Compat'; }, close() { writes.push('close'); } });
  serviceWorkerScriptURL(trusted);
  const first = blank(), second = blank();
  assert.equal(standardsPage(first, trusted), first);
  standardsPage(second, trusted);
  assert.equal(trusted.made.length, 1, 'no second policy (the CSP refuses duplicates)');
  assert.deepEqual(writes, ['open', { html: BLANK_PAGE }, 'close', 'open', { html: BLANK_PAGE }, 'close']);
  // A document already in standards mode is left alone: nothing it holds is erased.
  standardsPage(first, trusted);
  assert.equal(writes.length, 6);
});

test('browsers without Trusted Types register the constant script path and write the constant page as text', () => {
  assert.equal(serviceWorkerScriptURL(null), '/sw.mjs');
  const writes = [], target = { compatMode: 'BackCompat', open() {}, write(html) { writes.push(html); }, close() {} };
  standardsPage(target, null);
  assert.deepEqual(writes, [BLANK_PAGE]);
});

test('an engine that refuses a foreign-realm TrustedHTML gets the page from the target realm\'s own policy', () => {
  const builder = factory(), frame = factory(), writes = [];
  const target = { compatMode: 'BackCompat', defaultView: { trustedTypes: frame }, open() {}, close() {},
    write(html) { if (html.html && !frame.made.length) throw new TypeError('foreign_trusted_html'); writes.push(html); this.compatMode = 'CSS1Compat'; } };
  standardsPage(target, builder);
  assert.deepEqual(writes, [{ html: BLANK_PAGE }]);
  assert.equal(frame.made.length, 1);
  // With no realm of its own to fall back on, the refusal is reported, never swallowed.
  const bare = { compatMode: 'BackCompat', open() {}, close() {}, write() { throw new TypeError('refused'); } };
  assert.throws(() => standardsPage(bare, factory()), /refused/);
});
