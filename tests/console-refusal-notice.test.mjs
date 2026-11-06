import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { refusedCommandNotice } from '../src/client/console-actions.mjs';

test('a rate-limited console command says to wait, in plain text', () => {
  assert.equal(refusedCommandNotice('rate_limited'), 'Too many actions at once — try again in a moment.');
  assert.equal(refusedCommandNotice('stale_revision'), 'The session changed. Refreshing its state.');
  for (const reason of [undefined, 'invalid', '<img src=x onerror=alert(1)>'])
    assert.equal(refusedCommandNotice(reason), 'The session could not apply that action.');
});

test('the console renders the refusal notice through its text-only status', () => {
  const source = ['console-room.mjs','teaching-controls.mjs'].map(file=>readFileSync(new URL(`../src/client/${file}`, import.meta.url), 'utf8')).join('\n');
  assert.match(source, /statusText = refusedCommandNotice\(result\?\.reason, result\?\.receipt\);/);
  assert.match(source, /const feedback = el\('span', busy \? 'Sending to the room…' : statusText \|\| control\.note \|\| ''\);/);
  assert.match(source, /feedback\.setAttribute\('role', 'status'\)/);
  assert.match(source, /item\.textContent = cleanText\(text, MAX_TEXT\)/);
  assert.doesNotMatch(source, /innerHTML\s*=\s*statusText/);
});
