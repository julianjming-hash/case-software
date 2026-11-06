import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildClient } from '../scripts/build-client.mjs';

const artifact = name => new URL(`../tests/fixtures/synthetic/${name}`, import.meta.url);
test('new synthetic UI rehearsal pair retains its fingerprint and explicitly synthetic receipt authority', async () => {
  const evidence = JSON.parse(await readFile(artifact('builder-diving-ui-evidence.json'), 'utf8'));
  const digest = createHash('sha256').update(JSON.stringify(evidence.pairedDraft)).digest('hex');
  assert.equal(digest, 'a4f555bb8b6c29b01e6f214001acf6d0af71c5598635543310dd76fc6bfab32c');
  assert.equal(evidence.pairedContentSha256, digest);
  assert.equal(evidence.checkpointPairSha256, digest);
  assert.equal(evidence.checkpoint.revision, evidence.revision);
  assert.equal(evidence.saveReceipt.authority, 'synthetic local browser route fixture; not a Worker or database receipt');
  assert.equal(evidence.pairedDraft.authoringMetadata.sources[0].text, await readFile(artifact('builder-diving-source.txt'), 'utf8'));
  assert.ok(evidence.pairedDraft.authoringMetadata.provenance.every(row => row.review_status !== 'confirmed'));
});

test('private diving source and acceptance artifacts never enter the public client build', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'case-builder-artifact-boundary-'));
  const output = join(temporary, 'client');
  try {
    await buildClient({ outDir: output });
    const markers = ['Pain after a diving holiday', '911d7166515dec00fcf8ab069eb443c8f07e6eadef770d257e509719be14eae0', 'builder-diving-transfer'];
    async function inspect(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        assert.doesNotMatch(entry.name, /49-artifacts|builder-diving/, path);
        if (entry.isDirectory()) await inspect(path);
        else {
          const bytes = await readFile(path);
          for (const marker of markers) assert.equal(bytes.includes(Buffer.from(marker)), false, `${path} contains private review material`);
        }
      }
    }
    await inspect(output);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
