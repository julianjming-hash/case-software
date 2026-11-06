// Shared set-up for the Builder-simplification specs (CASE-344): a served Builder against a local mocked draft API that
// grants `slide_composition`, a slide case with room to build on, and the helpers the specs share. Not a spec itself.
import { expect } from '@playwright/test';
import { convertSchema1ToBuilderDocument, validateBuilderDocument } from '../../src/shared/builder-document.mjs';
import { convertToSlideDocument } from '../../src/shared/slide-legacy.mjs';
import { validateSlideParts } from '../../src/shared/slide-document.mjs';
import * as ops from '../../src/shared/slide-edit.mjs';
import { uuidv7 } from '../../src/shared/ids.mjs';
import sourceFixture from '../../src/fixtures/synthetic-workshop.case.json' with { type: 'json' };
import { startLocalAuthStub } from './local-auth-stub.mjs';
import { startPublishedWorker } from './published-worker.mjs';
import { startServedAuthShell } from './served-auth-shell.mjs';

export async function startServers() {
  const auth = await startLocalAuthStub({ appOrigin: null, jwt: null });
  const worker = await startPublishedWorker({ authOrigin: auth.origin });
  auth.setJwt(worker.jwt);
  const shell = await startServedAuthShell({ apiOrigin: worker.origin, buildAuthBindings: {
    SUPABASE_URL: auth.origin, SUPABASE_JWT_ISSUER: `${auth.origin}/auth/v1`, SUPABASE_JWKS_URL: `${auth.origin}/auth/v1/.well-known/jwks.json`,
  } });
  auth.setAppOrigin(shell.origin);
  return { auth, worker, shell, stop: async () => { await shell?.stop(); await worker?.stop(); await auth?.stop(); } };
}

const must = result => { if (!result.ok) throw new Error(result.reason); return result.document; };
export const startSlide = document => document.compositions.find(item => item.owner.kind === 'beat' && item.owner.id === document.start_beat_id);

/** A slide case whose opening slide is the title alone, so most of it is free to build on. */
export function roomyPair() {
  const converted = convertSchema1ToBuilderDocument(structuredClone(sourceFixture), { metadata_version: 1 });
  for (const surface of converted.candidate.surfaces) delete surface.variants;
  converted.candidate.title = 'Simplified Builder fixture';
  const upgraded = convertToSlideDocument(converted.candidate, { metadata_version: 1 }, { createId: uuidv7 });
  if (!upgraded.ok) throw new Error(upgraded.message);
  let document = upgraded.candidate.document;
  const opening = startSlide(document);
  const keep = opening.reading_order.find(id => document.blocks.find(block => block.id === id)?.paragraphs?.every(item => item.style !== 'p'));
  for (const id of opening.reading_order) if (id !== keep) document = must(ops.removeBlock(document, opening.id, id));
  // A title and one block would be shown large (D23), with no free area; the opening slide keeps its placed size.
  document = must(ops.setHero(document, opening.id, 'off'));
  return { document, authoringMetadata: upgraded.candidate.authoringMetadata ?? { metadata_version: 1 } };
}

/** A draft API with one case. Writes are validated exactly as the slide-activated server will validate them. */
export async function mockDraft(page, worker, pair, { capabilities = ['slide_composition'], failSave = null } = {}) {
  const state = { revision: 1, pair: structuredClone(pair), puts: [], gate: null }, windows = new Map(), receipts = new Map();
  const reply = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
  await page.route(url => url.pathname.startsWith(`/api/v1/builder/cases/${worker.caseId}`), async route => {
    const request = route.request(), method = request.method(), suffix = new URL(request.url()).pathname.split(`/cases/${worker.caseId}/`)[1] ?? '';
    const body = method === 'GET' ? null : request.postDataJSON();
    const context = { case: { caseId: worker.caseId, workspaceId: worker.workspaceId, role: 'owner', title: state.pair.document.title, sourceVersion: null, ...(capabilities ? { capabilities } : {}) } };
    if (suffix === 'draft' && method === 'GET') return reply(route, { ...context, revision: state.revision, draft: { revision: state.revision, ...structuredClone(state.pair), intentDigest: `\\x${'a'.repeat(64)}` } });
    if (suffix === 'save-windows' && method === 'POST') {
      if (body.baseRevision !== state.revision) return reply(route, { error: 'revision_conflict' }, 409);
      const operationId = uuidv7(); windows.set(operationId, state.revision); return reply(route, { operationId, baseRevision: state.revision });
    }
    if (suffix === 'draft' && method === 'PUT') {
      const lose = failSave?.();
      if (lose === true) return route.abort('failed');
      if (state.gate) await state.gate;
      if (windows.get(body.operationId) !== state.revision) return reply(route, { error: 'revision_conflict' }, 409);
      const checked = validateBuilderDocument(body.document, body.authoringMetadata, { mode: 'preserve', validateSlides: validateSlideParts });
      if (!checked.ok) return reply(route, { error: 'invalid_draft', issues: checked.errors }, 422);
      state.pair = { document: structuredClone(body.document), authoringMetadata: structuredClone(body.authoringMetadata) }; state.revision++; state.puts.push(state.revision);
      const receipt = { operationId: body.operationId, revision: state.revision, intentDigest: `\\x${'a'.repeat(64)}`, status: 'saved' };
      receipts.set(body.operationId, receipt);
      // 'after': the service took the save but its answer was lost, so the browser cannot tell (an uncertain save).
      return lose === 'after' ? route.abort('failed') : reply(route, receipt);
    }
    if (suffix === 'checkpoints' && method === 'GET') return reply(route, { checkpoints: [] });
    const receipt = /^save-windows\/([0-9a-f-]{36})$/.exec(suffix);
    if (receipt && method === 'GET') return receipts.has(receipt[1]) ? reply(route, receipts.get(receipt[1])) : reply(route, { error: 'not_found' }, 404);
    if (suffix === 'readiness' && method === 'POST') return reply(route, { ready: false, revision: body.revision, issues: [{ code: 'asset_not_approved', at: '/blocks/0', message: 'An image is awaiting approval.' }] });
    return reply(route, { error: 'not_found' }, 404);
  });
  return state;
}

export async function signIn(page, shell, path) {
  await page.goto(`${shell.origin}${path}`);
  await page.getByLabel('Email', { exact: true }).fill('owner@example.invalid');
  await page.getByRole('button', { name: 'Email me a sign-in code', exact: true }).click();
  await page.getByLabel('One-time code').fill('123456');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

export const inspectorOf = page => page.getByRole('complementary', { name: 'Inspector', exact: true });
export const slideOf = page => page.getByRole('region', { name: 'Slide editor', exact: true });
export const block = (page, id) => page.locator(`.builder-slide [data-block-id="${id}"]`);

/** Open the editor on a pair and wait for its slide. */
export async function openEditor(page, servers, pair = roomyPair(), options = {}) {
  const state = await mockDraft(page, servers.worker, pair, options);
  await signIn(page, servers.shell, `/cases/${servers.worker.caseId}/edit`);
  await expect(slideOf(page).locator('.slide-canvas')).toBeVisible();
  return state;
}
