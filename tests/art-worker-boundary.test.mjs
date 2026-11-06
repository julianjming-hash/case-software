// Card 28: the layout search and the renderer never reach the Worker (CASE-164; spec §6.1 step 4).
// The Worker may re-derive the descriptor (src/shared/art-descriptor.mjs) but must not import the
// geometry core, whose bounded search would put Worker CPU limits at risk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

function closure(entry) {
  const seen = new Set();
  const visit = (url) => {
    if (seen.has(url.href) || !existsSync(url)) return;
    seen.add(url.href);
    const text = readFileSync(url, 'utf8');
    for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) visit(new URL(m[1], url));
  };
  visit(entry);
  return [...seen].map((href) => href.slice(new URL('../', import.meta.url).href.length));
}

test('the Worker import graph re-derives the descriptor but never imports the geometry, search or renderer', () => {
  const files = closure(new URL('../src/worker/index.mjs', import.meta.url));
  assert.ok(files.includes('src/shared/art-descriptor.mjs'), 'the Worker verifies the descriptor');
  for (const banned of ['src/shared/mosaic-geometry.mjs', 'src/client/mosaic.mjs']) assert.ok(!files.includes(banned), `${banned} reached the Worker`);
  for (const file of files) assert.doesNotMatch(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), /\bsolveArt\s*\(/, `${file} runs the layout search`);
});
