import test from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from '../src/shared/ids.mjs';
import { samePcProjectorUrl, localNotesObjectUrl } from '../src/shared/urls.mjs';

test('Card 12 same-PC projector URL carries only a fixed public topology marker', () => {
  const id = uuidv7();
  const url = samePcProjectorUrl(id, 'https://case.invalid');
  assert.equal(url, `https://case.invalid/sessions/${id}/display?topology=same-pc`);
  assert.equal(new URL(url).searchParams.size, 1);
  assert.throws(() => samePcProjectorUrl('not-an-id', 'https://case.invalid'), TypeError);
});

test('Card 12 explicit local notes use a shared builder without adding case data to the object URL', () => {
  const blob = new Blob(['Private local marker'], { type: 'text/plain;charset=utf-8' });
  const url = localNotesObjectUrl(blob, { createObjectURL(value) {
    assert.equal(value, blob); return 'blob:https://case.test/opaque';
  } });
  assert.equal(url, 'blob:https://case.test/opaque');
  assert.doesNotMatch(url, /Private|marker/);
  assert.throws(() => localNotesObjectUrl(new Blob(['x'], { type: 'text/html' }),
    { createObjectURL: () => 'blob:x' }));
});
