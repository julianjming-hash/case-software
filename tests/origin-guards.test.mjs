import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { liveRooms } from '../scripts/deploy-guard.mjs';
import { parseDeployOptions } from '../scripts/predeploy.mjs';
import { publishCase } from '../scripts/publish-case.mjs';
import { resolvePilotTarget, STAGING_ORIGIN } from '../scripts/pilot-target.mjs';
import { stageRoom } from '../scripts/load-room.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
import { miniCase } from './helpers/mini-case.mjs';

test('scripts with fixed Case deployment origins are inventoried and refuse unconsented production requests', async () => {
  const directory = new URL('../scripts/', import.meta.url);
  const scripts = readdirSync(directory).filter(file => file.endsWith('.mjs') && /https:\/\/(?:case|case-staging)\.iatrogenic\.app/.test(readFileSync(new URL(file, directory), 'utf8'))).sort();
  assert.deepEqual(scripts, ['deploy-guard.mjs', 'pilot-target.mjs', 'predeploy.mjs', 'publish-case.mjs', 'simulated-rooms.mjs', 'usage-window.mjs']);
  let requests = 0;
  const result = await liveRooms({ api: 'https://case.iatrogenic.app', token: 'test-only-guard', fetchImpl: async () => { requests++; return new Response('{"live":0}'); } });
  assert.equal(result.ok, false); assert.equal(requests, 0);
  assert.throws(() => parseDeployOptions(['--env', 'production']), /production_requires_prod/);
  let tokenReads = 0;
  await assert.rejects(publishCase({
    args: ['--target', 'https://case.iatrogenic.app', '--workspace-id', uuidv7()],
    readFixture: async () => miniCase().doc,
    readToken: async () => { tokenReads++; return 'test-only-jwt'; },
    fetchImpl: async () => { requests++; return Response.json({}); },
  }), /Production target requires --prod/);
  assert.equal(tokenReads, 0);
  assert.equal(requests, 0);

  let pilotCredentialReads = 0;
  const pilotEnvironment = new Proxy({}, { get() {
    pilotCredentialReads++; throw Error('pilot credentials touched before target admission');
  } });
  const pilotFetch = () => { requests++; throw Error('pilot network touched before target admission'); };
  await assert.rejects(stageRoom('https://case.iatrogenic.app', pilotEnvironment, pilotFetch, { own: true }),
    { message: 'target refused' });
  assert.equal(pilotCredentialReads, 0);
  assert.equal(requests, 0);
  await assert.rejects(stageRoom(STAGING_ORIGIN, pilotEnvironment, pilotFetch),
    { message: 'staging target requires ownership acknowledgement' });
  assert.equal(pilotCredentialReads, 0);
  assert.equal(requests, 0);
  assert.throws(() => resolvePilotTarget({ target: 'https://case.iatrogenic.app', own: true }),
    { message: 'target refused' });
  assert.throws(() => resolvePilotTarget({ target: STAGING_ORIGIN }),
    { message: 'staging target requires ownership acknowledgement' });
  assert.deepEqual(resolvePilotTarget({ target: STAGING_ORIGIN, own: true }),
    { kind: 'staging', origin: STAGING_ORIGIN });
});
