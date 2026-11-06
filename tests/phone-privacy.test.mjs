import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const prototype = readFileSync(new URL('../prototypes/room/privacy.html', import.meta.url), 'utf8');
const screens = readFileSync(new URL('../docs/SCREENS.md', import.meta.url), 'utf8');
const analyticsNotice = 'Anonymous usage and connection metrics are retained for three months. These analytics points contain no names, answers, room or participant IDs, tokens, IP addresses or URLs.';
const challengeNotice = 'After repeated incorrect room codes, Cloudflare Turnstile may check this join page. Its script has access to this document and may read the entered room code, display name, avatar and browser storage. Cloudflare also processes network information such as your IP address. The check does not run in the session play or recap page.';
const plain = text => text.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const retention = plain(prototype.match(/<section aria-labelledby="how-long">([\s\S]*?)<\/section>/)[1].match(/<p>([\s\S]*?)<\/p>/)[1]);

test('SCREENS records the exact approved seven-day participant privacy retention sentence', () => {
  assert.ok(screens.includes(retention), 'missing exact SCREENS privacy-copy anchor');
});

test('participant privacy module preserves every headed prototype section as plain text and seven-day copy', async () => {
  const { PRIVACY_SECTIONS, RETENTION_DAYS, RETENTION_NOTICE } = await import('../src/client/privacy.mjs');
  assert.equal(RETENTION_DAYS, 7); assert.equal(RETENTION_NOTICE, retention);
  const expected = [...prototype.matchAll(/<section aria-labelledby="([^"]+)">([\s\S]*?)<\/section>/g)].map(([, id, body]) => ({ id, heading: plain(body.match(/<h2[^>]*>([\s\S]*?)<\/h2>/)[1]), paragraphs: [...body.matchAll(/<p>([\s\S]*?)<\/p>/g)].map(([, p]) => plain(p)) }));
  expected.find(section => section.id === 'how-long').paragraphs.push(analyticsNotice);
  expected.find(section => section.id === 'where').paragraphs.push(challengeNotice);
  assert.deepEqual(PRIVACY_SECTIONS, expected);
  assert.ok(PRIVACY_SECTIONS.every(section => section.paragraphs.every(text => !/[<>]/.test(text))));
});

test('participant Turnstile notice discloses join-script access and network processing without changing retention',async()=>{
 const {PRIVACY_SECTIONS,TURNSTILE_NOTICE,RETENTION_NOTICE}=await import('../src/client/privacy.mjs');
 assert.equal(TURNSTILE_NOTICE,challengeNotice);assert.ok(PRIVACY_SECTIONS.find(section=>section.id==='where').paragraphs.includes(challengeNotice));assert.ok(screens.includes(challengeNotice));assert.equal(RETENTION_NOTICE,retention);
});

test('participant anonymous-metrics disclosure matches the reviewed three-month copy in SCREENS without changing seven-day personal logs', async () => {
  const { PRIVACY_SECTIONS, ANALYTICS_NOTICE, RETENTION_NOTICE } = await import('../src/client/privacy.mjs');
  assert.equal(ANALYTICS_NOTICE, analyticsNotice);
  assert.ok(screens.includes(analyticsNotice), 'missing exact anonymous-metrics disclosure anchor');
  assert.deepEqual(PRIVACY_SECTIONS.find(section => section.id === 'how-long').paragraphs, [retention, analyticsNotice]);
  assert.equal(RETENTION_NOTICE, retention);
});


test('Card24 participant notice accurately separates lobby names, play opt-in and anonymous charts', async () => {
  const { PRIVACY_SECTIONS } = await import('../src/client/privacy.mjs');
  const notice = 'The facilitator sees your name, avatar and answers. Names and avatars appear in the projector lobby. During play, avatars appear; names require Show names. Closed responses, including free text, appear without names on the projector. The facilitator can hide them.';
  assert.deepEqual(PRIVACY_SECTIONS.find(section => section.id === 'sees').paragraphs, [notice]);
  assert.ok(plain(prototype).includes(notice), 'prototype disclosure differs');
  assert.ok(screens.includes(notice), 'SCREENS disclosure differs');
});
