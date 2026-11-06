import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildClient } from '../scripts/build-client.mjs';
import { AVATAR_IDS } from '../src/shared/participant.mjs';

test('projector avatar build emits an allowlisted hashed map without rewriting decoy URL text', async () => {
  const root = mkdtempSync(join(tmpdir(), 'case-projector-assets-'));
  try {
    for (const folder of ['public/avatars', 'src/client']) mkdirSync(join(root, folder), { recursive: true });
    writeFileSync(join(root, 'public/index.html'), '<script type="module" src="../src/client/app.mjs"></script>');
    writeFileSync(join(root, 'src/client/app.mjs'), "import './avatar-assets.mjs';\n// COMMENT_DECOY new URL('../../public/avatars/shadows-01.svg', import.meta.url)\nexport const decoy = \"new URL('../../public/avatars/shadows-01.svg', import.meta.url)\";\n");
    writeFileSync(join(root, 'src/client/avatar-assets.mjs'), 'export const AVATAR_URLS = Object.freeze(/*__AVATAR_URLS__*/{});\n');
    writeFileSync(join(root, 'src/client/sw.mjs'), "const name = '__CACHE_NAME__'; const files = /*__SHELL__*/[];");
    for (const id of AVATAR_IDS) writeFileSync(join(root, 'public/avatars', `${id}.svg`), `<svg xmlns="http://www.w3.org/2000/svg"><title>${id}</title></svg>`);
    const result = await buildClient({ root });
    const modules = result.hashedFiles.filter(p => p.endsWith('.mjs')).map(p => readFileSync(join(root, 'dist', p), 'utf8'));
    const mapSource = modules.find(s => s.startsWith('export const AVATAR_URLS'));
    const map = JSON.parse(mapSource.match(/Object.freeze\((.*)\);/)[1]);
    assert.deepEqual(Object.keys(map).sort(), [...AVATAR_IDS].sort());
    for (const [id, url] of Object.entries(map)) {
      assert.match(url, /^\/assets\/.+\.[a-f0-9]{64}\.svg$/);
      assert.match(readFileSync(join(root, 'dist', url.slice(1)), 'utf8'), new RegExp(id));
    }
    assert.ok(modules.some(s => s.includes("new URL('../../public/avatars/shadows-01.svg', import.meta.url)")), 'a string decoy stays literal, never becoming an emitted URL');
    assert.ok(modules.every(s => !s.includes('COMMENT_DECOY')), 'nonlegal comments are omitted');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
