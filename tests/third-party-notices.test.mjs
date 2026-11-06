import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildClient} from '../scripts/build-client.mjs';

test('generated distribution accompanies emitted icons and embedded fonts with exact complete notices', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'case-notices-'));
  try {
    const outDir = join(dir, 'built');
    const built = await buildClient({outDir});
    const notice = await readFile(join(outDir, 'third-party-notices.txt'), 'utf8');
    for (const name of ['licenses/lucide-static-1.59.0-package-LICENSE.txt', 'public/fonts/ofl-montserrat.txt', 'public/fonts/ofl-jetbrains-mono.txt', 'public/fonts/ofl-noto-sans.txt']) {
      const original = await readFile(new URL('../' + name, import.meta.url), 'utf8');
      assert.ok(notice.includes(name + '\n\n' + original), name + ' complete text accompanies generated output');
    }
    assert.ok(built.assets['src/client/ui-icons.mjs'], 'real emitted icon geometry');
    assert.ok(built.assets['src/client/session-pdf-font.mjs'], 'real emitted embedded-font data');
    assert.ok(!built.shell.includes('third-party-notices.txt'), 'notice is served without changing the precached shell workload');
  } finally { await rm(dir, {recursive:true, force:true}); }
});
