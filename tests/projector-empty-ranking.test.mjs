import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderResponseResult } from '../src/client/projector-result.mjs';

function el(tag, className, text) {
  return { tag, className, text, children: [], attrs: {}, classList: { add() {} },
    append(...children) { this.children.push(...children); },
    setAttribute(name, value) { this.attrs[name] = value; } };
}

test('Card24 shared projector empty ranking renders no invented table and retains the no-answer caption', () => {
  const box = renderResponseResult({ replay: false, responseResult: { type: 'ranking', prompt: 'Simulation question', total: 0, rankCount: null, counts: [] } },
    { el, markSvg() { assert.fail('an empty result must not invent an option mark'); } });
  assert.equal(box.attrs['aria-label'], 'Responses closed');
  assert.equal(box.children.some(child => child.tag === 'table'), false);
  assert.ok(box.children.some(child => child.text?.startsWith('No one answered')));
});
