// z-index lint (CASE-114): every stacking order in the prototypes comes from a --z-* band token in
// prototypes/room/lib/tokens.css. A raw literal (z-index: 7, style.zIndex = '10') fails, so nobody wins a
// stacking fight by picking a bigger number.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
function files(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(html|css|mjs)$/.test(f) ? [p] : [];
  });
}
const RAW = [
  /z-index\s*:(?!\s*var\(--z-)[^;"'}]+/gi,           // CSS, in a stylesheet or a style attribute
  /zIndex\s*=(?!\s*['"]?var\(--z-)[^;\n]+/g,          // element.style.zIndex = …
  /setProperty\(\s*['"]z-index['"]\s*,(?!\s*['"]var\(--z-)[^)]+/g,
];

test('[CASE-114] the lint catches a raw literal and passes a band token', () => {
  const hit = (t) => RAW.some((re) => { re.lastIndex = 0; return re.test(t); });
  for (const bad of ['z-index: 5', 'z-index:9999', "style.zIndex = '10'", "el.style.setProperty('z-index', '3')"]) assert.ok(hit(bad), bad);
  for (const good of ['z-index: var(--z-dock)', 'z-index:var(--z-overlay)', "style.zIndex = 'var(--z-toast)'"]) assert.ok(!hit(good), good);
});

test('[CASE-114] no raw z-index literal in any prototype; only var(--z-*) band tokens', () => {
  const hits = [];
  for (const f of files(join(ROOT, 'prototypes'))) {
    const text = readFileSync(f, 'utf8');
    for (const re of RAW) for (const m of text.matchAll(re)) hits.push(`${relative(ROOT, f)}: ${m[0].trim()}`);
  }
  assert.deepEqual(hits, []);
});

test('[CASE-114] the z-index bands are defined once, in tokens.css, in ascending order', () => {
  const css = readFileSync(join(ROOT, 'prototypes/room/lib/tokens.css'), 'utf8');
  const bands = [...css.matchAll(/--z-([a-z-]+):\s*(\d+);/g)].map((m) => [m[1], Number(m[2])]);
  assert.deepEqual(bands.map(([n]) => n), ['raised', 'sticky', 'dock', 'toast', 'overlay']);
  for (let i = 1; i < bands.length; i++) assert.ok(bands[i][1] > bands[i - 1][1], `${bands[i][0]} above ${bands[i - 1][0]}`);
});
