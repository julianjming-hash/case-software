import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildClient } from '../scripts/build-client.mjs';

const DIR = new URL('../public/audio/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', DIR), 'utf8'));

test('shipped cue files match their manifest: mono 24 kHz PCM WAV, hash, bytes, one-shot, small', () => {
  const files = readdirSync(DIR).filter(f => f.endsWith('.wav')).sort();
  assert.deepEqual(files, manifest.files.map(f => f.file).sort());
  let total = 0;
  for (const entry of manifest.files) {
    const bytes = readFileSync(new URL(entry.file, DIR));
    assert.equal(bytes.length, entry.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
    assert.equal(bytes.toString('latin1', 0, 4), 'RIFF'); assert.equal(bytes.toString('latin1', 8, 12), 'WAVE');
    assert.equal(bytes.readUInt16LE(20), 1); assert.equal(bytes.readUInt16LE(22), 1);
    assert.equal(bytes.readUInt32LE(24), 24000); assert.equal(bytes.readUInt16LE(34), 16);
    total += bytes.length;
  }
  assert.ok(total <= 60_000, `cue audio is ${total} bytes`);
  assert.equal(manifest.files.length, 5);
});

test('the build hashes cue audio into a generated map and keeps it out of the offline shell', async () => {
  const root = mkdtempSync(join(tmpdir(), 'case-audio-assets-'));
  try {
    for (const folder of ['public/audio', 'src/client']) mkdirSync(join(root, folder), { recursive: true });
    writeFileSync(join(root, 'public/index.html'), '<script type="module" src="../src/client/app.mjs"></script>');
    writeFileSync(join(root, 'src/client/app.mjs'), "import './audio-assets.mjs';\nimport './ui-tone-assets.mjs';\n");
    writeFileSync(join(root, 'src/client/ui-tone-assets.mjs'), 'export const UI_TONE_URLS = Object.freeze(/*__UI_TONE_URLS__*/{});\n');
    writeFileSync(join(root, 'src/client/audio-assets.mjs'), 'export const CUE_URLS = Object.freeze(/*__CUE_URLS__*/{});\n');
    writeFileSync(join(root, 'src/client/sw.mjs'), "const name = '__CACHE_NAME__'; const files = /*__SHELL__*/[];");
    for (const entry of manifest.files) writeFileSync(join(root, 'public/audio', entry.file), readFileSync(new URL(entry.file, DIR)));
    const result = await buildClient({ root });
    const modules = result.hashedFiles.filter(p => p.endsWith('.mjs')).map(p => readFileSync(join(root, 'dist', p), 'utf8'));
    const mapOf = name => JSON.parse(modules.find(s => s.startsWith(`export const ${name}`)).match(/Object.freeze\((.*)\);/)[1]);
    const names = pick => manifest.files.map(f => f.file.replace(/\.wav$/, '')).filter(pick).sort();
    assert.deepEqual(Object.keys(mapOf('CUE_URLS')).sort(), names(n => !n.startsWith('ui-')));
    assert.deepEqual(Object.keys(mapOf('UI_TONE_URLS')).sort(), names(n => n.startsWith('ui-')));
    for (const url of [...Object.values(mapOf('CUE_URLS')), ...Object.values(mapOf('UI_TONE_URLS'))]) {
      assert.match(url, /^\/assets\/.+\.[a-f0-9]{64}\.wav$/);
      assert.ok(readFileSync(join(root, 'dist', url.slice(1))).length > 1000);
      assert.ok(!result.shell.includes(url.slice(1)) && !result.shell.includes(url), 'audio must not be precached');
    }
    assert.ok(!readFileSync(join(root, 'dist/sw.mjs'), 'utf8').includes('.wav'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
