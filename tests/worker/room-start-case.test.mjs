// Facilitator-UX A3 (CASE-336): the room DO records the case it was started from, so a later re-mint or shared-PC
// approval decides on that case (src/worker/authorize.mjs mayMintConsole). A case needs its workspace; a malformed one
// is refused before anything is stored.
import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { uuidv7 } from '../../src/shared/ids.mjs';
import { roomFor } from '../../src/worker/directory-do.mjs';
import fixture from '../../src/fixtures/synthetic-workshop.case.json';

const create = (stub, extra) => stub.create({ sessionId: extra.sessionId, joinCode: 'PMPM01', caseDoc: fixture, ownerUserId: extra.owner,
  ttlMs: 3_600_000, ...extra.fields });

it('[AS-207] a room started from a case returns that case to the console mint check', async () => {
  const sessionId = uuidv7(), owner = uuidv7(), workspaceId = uuidv7(), caseId = uuidv7(), stub = roomFor(env, sessionId);
  const made = await create(stub, { sessionId, owner, fields: { workspaceId, caseId } });
  expect(typeof made.facilitatorToken).toBe('string');
  expect(await stub.canIssueFacilitatorToken(owner)).toEqual({ ok: true, workspaceId, caseId, ownerAdminDigest: null, inlineDev: false });
});

it('[AS-207] a case without its workspace, or a malformed case, is refused at create', async () => {
  for (const fields of [{ caseId: uuidv7() }, { workspaceId: uuidv7(), caseId: 'not-a-case' }]) {
    const sessionId = uuidv7(), stub = roomFor(env, sessionId);
    expect(await create(stub, { sessionId, owner: uuidv7(), fields })).toEqual({ error: 'bad_request', status: 400 });
  }
});
