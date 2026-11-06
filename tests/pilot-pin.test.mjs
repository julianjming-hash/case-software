import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uuidv7 } from '../src/shared/ids.mjs';

const digest = async text => `\\x${Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(text))), byte => byte.toString(16).padStart(2, '0')).join('')}`;

test('[AS-095] Card20 pilot pin accepts only a complete canonical selected-environment version and digest', async () => {
  const { pilotPinFromEnv } = await import('../src/worker/pilot-pin.mjs');
  const versionId = uuidv7(), contentSha256 = await digest('throwaway published text');
  assert.deepEqual(pilotPinFromEnv({ CASE_PILOT_VERSION_ID: versionId,
    CASE_PILOT_CONTENT_SHA256: contentSha256 }), { versionId, contentSha256 });
  for (const env of [{}, { CASE_PILOT_VERSION_ID: versionId },
    { CASE_PILOT_CONTENT_SHA256: contentSha256 },
    { CASE_PILOT_VERSION_ID: '', CASE_PILOT_CONTENT_SHA256: '' },
    { CASE_PILOT_VERSION_ID: versionId, CASE_PILOT_CONTENT_SHA256: contentSha256.toUpperCase() },
    { CASE_PILOT_VERSION_ID: versionId.slice(0, 14) + '4' + versionId.slice(15), CASE_PILOT_CONTENT_SHA256: contentSha256 },
    { CASE_PILOT_VERSION_ID: versionId, CASE_PILOT_CONTENT_SHA256: 'not_a_digest' }])
    assert.equal(pilotPinFromEnv(env), null);
});

test('[AS-095] Card20 pilot picker marks approval only when both published UUID and digest match', async () => {
  const { pilotVersionState } = await import('../src/client/console-pin.mjs');
  const versionId = uuidv7(), contentSha256 = await digest('throwaway approved text');
  const pin = { versionId, contentSha256 };
  const row = { version_id: versionId, content_sha256: contentSha256 };
  assert.equal(pilotVersionState(row, pin), 'approved');
  assert.equal(pilotVersionState({ ...row, version_id: uuidv7() }, pin), 'different');
  assert.equal(pilotVersionState({ ...row, content_sha256: await digest('different') }, pin), 'different');
  assert.equal(pilotVersionState(row, null), 'unconfigured');
  assert.equal(pilotVersionState({ ...row, content_sha256: 'invalid' }, pin), 'unverified');
  assert.equal(pilotVersionState(row, { versionId, contentSha256: 'invalid' }), 'unconfigured');
});
