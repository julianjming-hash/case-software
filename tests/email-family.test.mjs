import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { AUTH_EMAIL_KINDS, authEmail } from '../src/shared/email-family.mjs';
import { inviteMessage, inviteHtml, inviteText } from '../src/worker/invite-email.mjs';
import { emailArtUrl } from '../src/shared/urls.mjs';
import { buildEmails } from '../scripts/build-emails.mjs';
import { buildClient } from '../scripts/build-client.mjs';

test('email palette and all hosted candidates match the shipped tokens and shared renderer', async () => {
  assert.equal(await buildEmails({ check: true }), 13);
});
for (const kind of AUTH_EMAIL_KINDS) test(`Auth candidate ${kind} preserves template variables in text and HTML without embedding credentials`, () => {
  const { html, text } = authEmail(kind);
  const variables = value => [...new Set(value.match(/\{\{\s*\.\w+\s*\}\}/g))].sort();
  assert.deepEqual(variables(html), variables(text));
  assert.equal([...html.matchAll(/<img\s/g)].length, 1);
  assert.ok(html.includes(`src="${emailArtUrl()}"`));
  assert.ok(Buffer.byteLength(html) < 20_000, 'small HTML; no embedded artwork');
  assert.doesNotMatch(html, /<script|<svg|data:image|@font-face|@import|utm_/i);
  if (['magic-link', 'confirm-signup', 'reauthentication'].includes(kind)) {
    assert.match(html, /Your verification code is:/);
    assert.match(html, /white-space:nowrap;[^>]*>\{\{ \.Token \}\}<\/p>/);
    assert.ok(text.endsWith('@case.iatrogenic.app #{{ .Token }}'));
    assert.ok(html.includes('@case.iatrogenic.app #{{ .Token }}'));
    assert.doesNotMatch(html.slice(0, html.indexOf('<body')), /\{\{ \.Token \}\}/);
  }
});
for (const level of ['run', 'edit', 'manage']) test(`invitation ${level} keeps role, expiry and acceptance facts in both alternatives`, () => {
  const m = inviteMessage({ email: 'sam@example.invalid', inviterName: 'Alex <script> & Morgan', workspaceName: 'Harbour ICU', level,
    ref: 'F'.repeat(43), origin: 'https://case.iatrogenic.app', expiresAt: '2027-02-02T00:00:00Z' });
  const html = inviteHtml(m), text = inviteText(m);
  assert.ok(html.includes(`<b>Can ${level}</b> - you can:`));
  assert.ok(text.includes(`Can ${level} - you can:`));
  assert.doesNotMatch(html, /means you can|<script>|the facilitator-led clinical decision theatre/);
  assert.ok(html.includes('Alex &lt;script&gt; &amp; Morgan'));
  for (const fact of [m.expires, m.to, m.url, ...m.can]) assert.ok(text.includes(fact));
});

test('email artwork is content-versioned, byte-identical in the build, immutable and outside the shell cache', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'case-email-build-'));
  try {
    const outDir = join(dir, 'build'), result = await buildClient({ outDir });
    const path = new URL(emailArtUrl()).pathname;
    const source = await readFile(new URL(`../public${path}`, import.meta.url));
    assert.ok(createHash('sha256').update(source).digest('hex').startsWith(/([a-f0-9]{12})\.jpg$/.exec(path)[1]));
    assert.ok(source.length < 100_000);
    assert.deepEqual(await readFile(join(outDir, path)), source);
    assert.ok(!result.shell.some(p => p.startsWith('email/')));
    assert.match(await readFile(join(outDir, '_headers'), 'utf8'), /\/email\/\*\n[^\n]*cache-control: public, max-age=31536000, immutable/);
    const root = join(dir, 'invalid-root'); await mkdir(join(root, 'public/email'), { recursive: true });
    await writeFile(join(root, 'public/email/000000000000.jpg'), source);
    await assert.rejects(buildClient({ root, outDir: join(dir, 'invalid-build') }), /email_asset_hash_mismatch/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Auth candidate selection rejects prototype names and unknown kinds', () => {
  for (const kind of ['toString', '__proto__', 'unknown']) assert.throws(() => authEmail(kind), /Unknown Auth email/);
});

test('password-change notice retains actionable password reset instructions in both alternatives', () => {
  const { html, text } = authEmail('password-changed');
  for (const body of [html, text]) assert.match(body, /reset your password and contact your Case administrator immediately/);
});
