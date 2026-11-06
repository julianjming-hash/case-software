import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareLocalAssets } from './helpers/local-worker.mjs';

test('parallel local Workers receive independent immutable asset outputs and build-free configurations', async () => {
  const first = mkdtempSync(join(tmpdir(), 'case-worker-assets-'));
  const second = mkdtempSync(join(tmpdir(), 'case-worker-assets-'));
  try {
    const a = await prepareLocalAssets(first, { buildSha: 'a'.repeat(40) });
    const before = readFileSync(join(a.assetDir, 'sw.mjs'), 'utf8');
    const b = await prepareLocalAssets(second, { buildSha: 'a'.repeat(40) });
    assert.notEqual(a.assetDir, b.assetDir);
    assert.equal(readFileSync(join(a.assetDir, 'sw.mjs'), 'utf8'), before);
    for (const build of [a, b]) {
      const rootConfig = readFileSync(build.configPath, 'utf8').split('[env.production]')[0];
      assert.doesNotMatch(rootConfig, /^\[build\]/m);
      assert.ok(rootConfig.includes(`directory = ${JSON.stringify(build.assetDir)}`));
      assert.match(rootConfig, /^main = "\/.+\/src\/worker\/index\.mjs"$/m);
      assert.match(readFileSync(join(build.assetDir, 'index.html'), 'utf8'), /\/assets\//);
    }
    rmSync(second, { recursive: true, force: true });
    assert.equal(readFileSync(join(a.assetDir, 'sw.mjs'), 'utf8'), before);
  } finally { rmSync(first, { recursive: true, force: true }); rmSync(second, { recursive: true, force: true }); }
});
