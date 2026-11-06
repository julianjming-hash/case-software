import test from 'node:test';
import assert from 'node:assert/strict';
import { attachRoomCodeMask } from '../src/client/phone-join-code.mjs';

test('phone room-code typing and paste normalize aliases, cap six characters and preserve edit caret', () => {
  const events = {}; const code = { value: '', selectionStart: 0, selectionEnd: 0, addEventListener: (event, handler) => events[event] = handler, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; } };
  const hint = { textContent: '' }; attachRoomCodeMask(code, hint, '7k3-qx9');
  assert.equal(code.value, '7K3QX9'); assert.equal(hint.textContent, '6 of 6 characters');
  code.value = 'o-iL!?-9'; code.selectionStart = 4; events.input();
  assert.equal(code.value, '0119'); assert.equal(code.selectionStart, 3); assert.equal(hint.textContent, '4 of 6 characters');
  code.selectionStart = 1; code.selectionEnd = 3; let prevented = false;
  events.paste({ clipboardData: { getData: () => 'ab-cd-efgh' }, preventDefault() { prevented = true; } });
  assert.ok(prevented); assert.equal(code.value, '0ABCDE'); assert.equal(code.selectionStart, 6); assert.equal(hint.textContent, '6 of 6 characters');
});
