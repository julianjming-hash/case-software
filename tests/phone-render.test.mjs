// Preview overhaul slice 2 (CASE-226): the participant room screens are one renderer, drawn into a given document, that
// the live phone wraps with its delivery and the Builder's Run preview will draw into a blank frame.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sameResponse, savedResponse, PHONE_COPY } from '../src/client/phone-render.mjs';

const read = file => readFileSync(new URL(`../src/client/${file}`, import.meta.url), 'utf8');
const code = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

test('[CASE-226] the phone renderer draws only: no storage, network, page globals or HTML sinks', () => {
  const src = code(read('phone-render.mjs'));
  for (const banned of [/\blocalStorage\b/, /\bsessionStorage\b/, /\bindexedDB\b/, /\bBroadcastChannel\b/, /\bcaches\b/, /\bfetch\s*\(/, /\bWebSocket\b/,
    /\bXMLHttpRequest\b/, /\bsendBeacon\b/, /\bdocument\b/, /\bwindow\b/, /\blocation\b/, /\binnerHTML\b/, /\binsertAdjacentHTML\b/, /\bsetInterval\b/])
    assert.doesNotMatch(src, banned, `phone-render.mjs uses ${banned}`);
  // Every node it creates comes from the given document; its only timers are tracked and cleared on dispose.
  assert.match(src, /domBuilder\(doc\)/);
  assert.match(src, /for \(const id of timeouts\) globalThis\.clearTimeout\(id\)/);
});

test('[CASE-226] the live phone draws its room screens through the renderer and keeps delivery around it', () => {
  const phone = code(read('phone.mjs'));
  assert.match(phone, /createPhoneRenderer\(\{ doc: document, parts, onAnswer,/);
  for (const moved of ['function updateRoom(', 'function buildSurface(', 'function buildRecap(', 'function buildCard(', 'function refreshCard(', 'function updateLobby('])
    assert.ok(!phone.includes(moved), `phone.mjs still defines ${moved}`);
  for (const kept of ['function onReceipt(', 'function reconcilePending(', 'function dispatchPending(', 'createOutbox(', 'restorePhoneVote('])
    assert.ok(phone.includes(kept), `phone.mjs lost ${kept}`);
});

test('[CASE-226] saved and same-answer rules the card and the delivery share', () => {
  assert.equal(sameResponse({ option_ids: ['b', 'a'] }, { option_ids: ['a', 'b'] }), true);
  assert.equal(sameResponse({ order: ['b', 'a'] }, { order: ['a', 'b'] }), false);
  assert.equal(sameResponse(null, { option_id: 'a' }), false);
  const d = { roundId: 'r2', yourResponse: { option_id: 'a' } };
  assert.deepEqual(savedResponse(d, { roundId: 'r2', response: { option_id: 'b' } }), { option_id: 'b' });
  assert.deepEqual(savedResponse(d, { roundId: 'r1', response: { option_id: 'b' } }), { option_id: 'a' });
  assert.equal(PHONE_COPY.saved, 'Answer saved · you can change it until responses lock');
});
