// Typography gate (CASE-112): no serif face anywhere in the prototypes, Montserrat as the one sans,
// self-hosted (never a font service, so production can keep `font-src 'self'`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
function files(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(html|css|mjs)$/.test(f) ? [p] : [];
  });
}
const SOURCES = files(join(ROOT, 'prototypes')).map((f) => [relative(ROOT, f), readFileSync(f, 'utf8')]);

test('[CASE-112] no serif family anywhere in the prototypes', () => {
  // Every font declaration: font, font-family, and the --sans / --serif / --mono stacks (CSS and inline styles).
  const DECL = /(?:font-family|font|--(?:sans|serif|mono))\s*:\s*([^;{}"\n]+)/g;
  const SERIF = /\b(Georgia|Times New Roman|Times|Garamond|Palatino|Cambria|Merriweather|Playfair)\b|ui-serif|(?<![-\w])serif\b/;
  const hits = SOURCES.flatMap(([f, text]) => [...text.matchAll(DECL)].filter((m) => SERIF.test(m[1])).map((m) => `${f}: ${m[0]}`));
  assert.deepEqual(hits, []);
  assert.ok(SERIF.test("Georgia, 'Times New Roman', serif") && !SERIF.test("'Montserrat', system-ui, sans-serif"), 'the pattern itself');
});

test('[CASE-112] fonts are self-hosted: no font service, and every @font-face file exists with its licence', () => {
  for (const [f, text] of SOURCES) assert.ok(!/fonts\.(googleapis|gstatic)\.com|use\.typekit|fonts\.bunny/.test(text), `${f} loads a font service`);
  const css = readFileSync(join(ROOT, 'prototypes/room/lib/tokens.css'), 'utf8');
  const urls = [...css.matchAll(/url\((fonts\/[^)]+)\)/g)].map((m) => m[1]);
  assert.ok(urls.length >= 3);
  for (const u of urls) assert.ok(existsSync(join(ROOT, 'prototypes/room/lib', u)), u);
  for (const lic of ['ofl-montserrat.txt', 'ofl-jetbrains-mono.txt']) assert.match(readFileSync(join(ROOT, 'prototypes/room/lib/fonts', lic), 'utf8'), /SIL OPEN FONT LICENSE Version 1\.1/i);
  assert.match(css, /--sans:\s*'Montserrat'/);
});
