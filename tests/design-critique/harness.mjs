import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBuilderTransfer, inspectBuilderTransfer } from '../../src/shared/builder-transfer.mjs';
import { convertSchema1ToBuilderDocument, validateBuilderDocument } from '../../src/shared/builder-document.mjs';
import { validateSlideParts } from '../../src/shared/slide-document.mjs';
import { convertToSlideDocument } from '../../src/shared/slide-legacy.mjs';
import { uuidv7 } from '../../src/shared/ids.mjs';
import mvcFixture from '../../src/fixtures/synthetic-workshop.case.json' with { type: 'json' };
import { startLocalAuthStub } from '../../tests/helpers/local-auth-stub.mjs';
import { startPublishedWorker } from '../../tests/helpers/published-worker.mjs';
import { startServedAuthShell } from '../../tests/helpers/served-auth-shell.mjs';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const SHOTS = process.env.CRITIQUE_SHOTS ?? join(ROOT, 'test-results/design-critique/shots');
export let env = {};
export async function start() {
  const auth = await startLocalAuthStub({ appOrigin: null, jwt: null });
  const worker = await startPublishedWorker({ authOrigin: auth.origin }); auth.setJwt(worker.jwt);
  const shell = await startServedAuthShell({ apiOrigin: worker.origin, buildAuthBindings: {
    SUPABASE_URL: auth.origin, SUPABASE_JWT_ISSUER: `${auth.origin}/auth/v1`, SUPABASE_JWKS_URL: `${auth.origin}/auth/v1/.well-known/jwks.json` } });
  auth.setAppOrigin(shell.origin);
  env = { auth, worker, shell };
}
export async function stop() { await env.shell?.stop(); await env.worker?.stop(); await env.auth?.stop(); }
export async function divingSlides() {
  const parsed = parseBuilderTransfer(readFileSync(join(ROOT, 'tests/fixtures/synthetic/builder-diving-polished-transfer.json'), 'utf8'));
  const candidate = (await inspectBuilderTransfer(parsed.envelope, {})).candidate;
  for (const surface of candidate.document.surfaces) delete surface.variants;
  const converted = convertToSlideDocument(candidate.document, candidate.authoring_metadata ?? candidate.authoringMetadata, { createId: uuidv7 });
  return { document: converted.candidate.document, authoringMetadata: converted.candidate.authoringMetadata };
}
export function mvcSchema2() {
  const converted = convertSchema1ToBuilderDocument(structuredClone(mvcFixture), { metadata_version: 1 });
  for (const surface of converted.candidate.surfaces) delete surface.variants;
  return { document: converted.candidate, authoringMetadata: { metadata_version: 1 } };
}
export async function openBuilder(page, pair, { role = 'owner' } = {}) {
  const { worker, shell } = env;
  const state = { revision: 1, pair: structuredClone(pair), puts: 0, gate: null }, windows = new Map();
  const reply = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
  await page.route(url => url.pathname.startsWith(`/api/v1/builder/cases/${worker.caseId}`), async route => {
    const request = route.request(), method = request.method(), suffix = new URL(request.url()).pathname.split(`/cases/${worker.caseId}/`)[1] ?? '';
    if (/^(media\/|assets(?:\/|$))/.test(suffix)) return route.fallback();
    const body = method === 'GET' ? null : request.postDataJSON();
    if (suffix === 'draft' && method === 'GET') return reply(route, { case: { caseId: worker.caseId, workspaceId: worker.workspaceId, role, title: state.pair.document.title, sourceVersion: null, capabilities: ['slide_composition'] },
      revision: state.revision, draft: { revision: state.revision, ...structuredClone(state.pair), intentDigest: `\\x${'a'.repeat(64)}` } });
    if (suffix === 'save-windows' && method === 'POST') { const operationId = uuidv7(); windows.set(operationId, state.revision); return reply(route, { operationId, baseRevision: state.revision }); }
    if (suffix === 'draft' && method === 'PUT') {
      if (state.gate) await state.gate;
      if (windows.get(body.operationId) !== state.revision) return reply(route, { error: 'revision_conflict' }, 409);
      const checked = validateBuilderDocument(body.document, body.authoringMetadata, { mode: 'preserve', validateSlides: validateSlideParts });
      if (!checked.ok) return reply(route, { error: 'invalid_draft', issues: checked.errors }, 422);
      state.pair = { document: structuredClone(body.document), authoringMetadata: structuredClone(body.authoringMetadata) }; state.revision++; state.puts++;
      return reply(route, { operationId: body.operationId, revision: state.revision, intentDigest: `\\x${'a'.repeat(64)}`, status: 'saved' });
    }
    if (suffix === 'checkpoints') return reply(route, { checkpoints: [] });
    return reply(route, { error: 'not_found' }, 404);
  });
  await page.goto(`${shell.origin}/cases/${worker.caseId}/edit`);
  await page.getByLabel('Email', { exact: true }).fill('owner@example.invalid');
  await page.getByRole('button', { name: 'Email me a sign-in code', exact: true }).click();
  await page.getByLabel('One-time code').fill('123456');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('.builder-studio')).toBeVisible();
  return state;
}
export const slide = page => page.getByRole('region', { name: 'Slide editor', exact: true });
export const shot = (page, name, opts = {}) => page.screenshot({ path: `${SHOTS}/${name}.png`, ...opts });
