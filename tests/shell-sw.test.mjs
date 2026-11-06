// The offline shell (prototypes/room/shell-sw.mjs, AS-061) must hold every file a room window loads:
// each module a page imports, followed transitively, plus the stylesheet's fonts. A missing module
// means a reload during an outage opens a broken page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { AVATAR_IDS } from '../src/shared/participant.mjs';

const ROOM = new URL('../prototypes/room/', import.meta.url);
const ORIGIN = 'http://case.test';
const toHref = (url) => `${ORIGIN}/${url.href.slice(new URL('../', import.meta.url).href.length)}`;

function shellList() {
  const src = readFileSync(new URL('shell-sw.mjs', ROOM), 'utf8');
  const self = { location: new URL(`${ORIGIN}/prototypes/room/shell-sw.mjs`), addEventListener() {} };
  return new Set(runInNewContext(`${src}\n;SHELL`, { self, URL, Array, String, Set, Promise, setTimeout }));
}

/** Every local module a file imports (static `import … from` and `import(…)` with a literal), transitively. */
function closure(entries) {
  const seen = new Set();
  const visit = (url) => {
    if (seen.has(url.href)) return;
    seen.add(url.href);
    assert.ok(existsSync(url), `${url.pathname} exists`);
    if (!/\.(mjs|html)$/.test(url.pathname)) return;
    const text = readFileSync(url, 'utf8');
    for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) visit(new URL(m[1], url));
    for (const m of text.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)) visit(new URL(m[1], url));
    for (const m of text.matchAll(/url\((fonts\/[^)]+)\)/g)) visit(new URL(m[1], url));
  };
  for (const e of entries) visit(e);
  return seen;
}

test('[AS-061] the offline shell lists every module, stylesheet and font the room windows load', () => {
  const shell = shellList();
  const pages = ['facilitator.html', 'display.html', 'phone.html', 'pair-display.html', 'check.html', 'privacy.html'].map((p) => new URL(p, ROOM));
  const css = new URL('lib/tokens.css', ROOM);
  const needed = [...closure([...pages, css])].map((h) => toHref(new URL(h)));
  const missing = needed.filter((h) => !shell.has(h));
  assert.deepEqual(missing, [], 'add these to SHELL in prototypes/room/shell-sw.mjs');
});

test('[AS-061] the shell never caches the lab page, a fixture or the API', () => {
  for (const h of shellList()) {
    assert.ok(!/\/api\//.test(h) && !/fixtures/.test(h) && !/\/index\.html$/.test(h), h);
  }
});

test('[AS-061] the offline shell preserves all original avatars and every colour variant', () => {
  const shell = shellList();
  const expected = AVATAR_IDS.map((id) => toHref(new URL(`lib/avatars/${id}.svg`, ROOM))).sort();
  assert.equal(expected.length, 144);
  assert.deepEqual([...shell].filter((h) => h.includes('/avatars/')).sort(), expected);
  assert.match(readFileSync(new URL('shell-sw.mjs', ROOM), 'utf8'), /case-shell-v6/);
});
