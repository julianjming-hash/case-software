import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBoundedJson } from '../src/shared/builder-json.mjs';

test('bounded JSON accepts ordinary nested JSON and reports measured limits', () => {
  const result = parseBoundedJson('{"a":[1,true,null,{"b":"x"}]}');
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { a: [1, true, null, { b: 'x' }] });
  assert.equal(result.bytes, 29);
  assert.ok(result.nodes > 0);
});

test('duplicate raw keys refuse, including escaped-equivalent names at every depth', () => {
  for (const input of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"nested":{"x":1,"x":2}}']) {
    const result = parseBoundedJson(input);
    assert.equal(result.ok, false, input);
    assert.equal(result.error.code, 'duplicate_key', input);
  }
});

test('bounded parser distinguishes keys from key-like text in strings', () => {
  const result = parseBoundedJson('{"text":"\\\"a\\\":1","a":2}');
  assert.equal(result.ok, true);
  assert.equal(result.value.text, '"a":1');
});

test('invalid JSON refuses without returning a partial value', () => {
  for (const input of ['{"a":}', '[1,]', 'undefined', '{"a":1,,"b":2}']) {
    const result = parseBoundedJson(input);
    assert.equal(result.ok, false, input);
    assert.equal(Object.hasOwn(result, 'value'), false);
  }
});

test('invalid UTF-8 bytes refuse instead of decoding with replacement characters', () => {
  const result = parseBoundedJson(new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'invalid_utf8');
});

test('byte, nesting and node bounds are enforced before returning a value', () => {
  assert.equal(parseBoundedJson('{"x":"12345"}', { maxBytes: 5 }).error.code, 'too_large');
  assert.equal(parseBoundedJson('[[[0]]]', { maxDepth: 2 }).error.code, 'too_deep');
  assert.equal(parseBoundedJson('[1,2,3]', { maxNodes: 3 }).error.code, 'too_many_nodes');
});
