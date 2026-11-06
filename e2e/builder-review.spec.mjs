import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { uuidv7 } from '../src/shared/ids.mjs';
import { convertSchema1ToBuilderDocument, validateBuilderDocument } from '../src/shared/builder-document.mjs';
import sourceFixture from '../src/fixtures/synthetic-workshop.case.json' with { type: 'json' };
import { startLocalAuthStub } from '../tests/helpers/local-auth-stub.mjs';
import { startPublishedWorker } from '../tests/helpers/published-worker.mjs';
import { startServedAuthShell } from '../tests/helpers/served-auth-shell.mjs';

test.use({ ignoreHTTPSErrors: true });
let auth, worker, shell;

test.beforeAll(async () => {
  auth = await startLocalAuthStub({ appOrigin: null, jwt: null });
  worker = await startPublishedWorker({ authOrigin: auth.origin });
  auth.setJwt(worker.jwt);
  shell = await startServedAuthShell({ apiOrigin: worker.origin, buildAuthBindings: {
    SUPABASE_URL: auth.origin,
    SUPABASE_JWT_ISSUER: `${auth.origin}/auth/v1`,
    SUPABASE_JWKS_URL: `${auth.origin}/auth/v1/.well-known/jwks.json`,
  } });
  auth.setAppOrigin(shell.origin);
});
test.afterAll(async () => { await shell?.stop(); await worker?.stop(); await auth?.stop(); });

const clone = value => structuredClone(value);
const hash = value => `\\x${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

function readyPair() {
  const converted = convertSchema1ToBuilderDocument(sourceFixture, { metadata_version: 1 });
  if (!converted.ok) throw new Error('Local non-diving fixture did not convert to a preservable Builder document.');
  const document = converted.candidate;
  document.title = 'Local review workflow exercise';
  const decisionBeat = document.beats.find(beat => beat.decision_id);
  const decision = document.decisions.find(item => item.id === decisionBeat.decision_id);
  for (const path of decision.paths) path.recovery = { prompt: 'Pause and ask the facilitator before continuing.' };
  document.clarifications = [{ id: uuidv7(), label: 'Local review clarification', surface_id: decisionBeat.surface_id, beat_ids: [decisionBeat.id] }];
  document.required_capabilities = ['required_recovery', 'early_clarification'];
  const metadata = { metadata_version: 1, preparation_requirements: 'LOCAL REVIEW TEST ONLY' };
  const readiness = validateBuilderDocument(document, metadata, { mode: 'ready' });
  if (!readiness.ok) throw new Error(`Local review pair is not ready: ${JSON.stringify(readiness.errors.slice(0, 5))}`);
  return { document, authoringMetadata: metadata };
}

// `role` selects the served UI branch through a local bounded API fake. Real entitlement is covered by Worker/SQL tests.
async function openReview(page, role = 'owner', prepare = () => {}) {
  const caseId = worker.caseId, workspaceId = worker.workspaceId;
  const state = { role, revision: 7, pair: readyPair(), candidates: [], calls: [], receipts: new Map(), windows: new Map() };
  prepare(state);
  const reply = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
  const currentDigest = () => hash({ document: state.pair.document, authoringMetadata: state.pair.authoringMetadata });
  const candidateRow = candidate => ({ candidateId: candidate.candidateId, revision: candidate.revision, status: candidate.status,
    submittedAt: candidate.submittedAt, approvedAt: candidate.approvedAt ?? null, releasedVersionId: candidate.versionId ?? null });
  const pairResponse = () => ({ case: { caseId, workspaceId, role: state.role, title: state.pair.document.title, sourceVersion: null },
    revision: state.revision, draft: { revision: state.revision, schemaVersion: state.pair.document.schema_version,
      ...clone(state.pair), intentDigest: currentDigest(), updatedAt: '2026-10-09T00:00:00.000Z' } });
  const supersedeActive = () => {
    for (const candidate of state.candidates) if (['pending', 'approved'].includes(candidate.status)) candidate.status = 'superseded';
  };
  const advanceDraft = () => {
    state.revision++;
    state.pair.document.title = `Updated local review exercise ${state.revision}`;
    supersedeActive();
  };
  await page.route('**/api/v1/builder/**', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    const match = new RegExp(`^/api/v1/builder/cases/${caseId}(?:/(.*))?$`).exec(url.pathname);
    if (!match) return reply(route, { error: 'not_found' }, 404);
    const suffix = match[1] ?? '';
    const rawBody = method === 'GET' || method === 'DELETE' ? null : request.postData() ?? '';
    if (rawBody && new TextEncoder().encode(rawBody).byteLength > 2 * 1_048_576)
      return reply(route, { error: 'too_large' }, 413);
    const body = rawBody ? JSON.parse(rawBody) : null;
    state.calls.push({ method, suffix, body: body && clone(body) });

    if (suffix === 'readiness' && method === 'POST') return reply(route, { revision: state.revision, ready: body.revision === state.revision, issues: body.revision === state.revision ? [] : [{ code: 'revision_conflict' }] });
    if (suffix === 'draft' && method === 'GET') return reply(route, pairResponse());
    if (suffix === 'checkpoints' && method === 'GET') return reply(route, { checkpoints: [] });
    if (suffix === 'save-windows' && method === 'POST') {
      if (body?.baseRevision !== state.revision) return reply(route, { error: 'conflict' }, 409);
      const operationId = uuidv7(); state.windows.set(operationId, state.revision);
      return reply(route, { operationId, baseRevision: state.revision });
    }
    if (suffix === 'draft' && method === 'PUT') {
      const base = state.windows.get(body?.operationId);
      if (base !== state.revision || !validateBuilderDocument(body?.document, body?.authoringMetadata, { mode: 'preserve' }).ok)
        return reply(route, { error: 'conflict' }, 409);
      state.revision++;
      state.pair = { document: clone(body.document), authoringMetadata: clone(body.authoringMetadata) };
      supersedeActive();
      const receipt = { operationId: body.operationId, revision: state.revision, intentDigest: currentDigest(), status: 'saved' };
      state.receipts.set(body.operationId, receipt);
      return reply(route, receipt);
    }
    const receipt = /^save-windows\/([0-9a-f-]{36})$/.exec(suffix);
    if (receipt && method === 'GET') return state.receipts.has(receipt[1])
      ? reply(route, state.receipts.get(receipt[1]))
      : reply(route, { operationId: receipt[1], status: 'not_found' }, 404);
    if (suffix === 'candidates' && method === 'GET') return reply(route, { candidates: state.candidates.map(candidateRow) });
    if (suffix === 'candidates' && method === 'POST') {
      if (body?.revision !== state.revision || JSON.stringify(body.document) !== JSON.stringify(state.pair.document) ||
          JSON.stringify(body.authoringMetadata) !== JSON.stringify(state.pair.authoringMetadata))
        return reply(route, { error: 'conflict' }, 409);
      supersedeActive();
      const candidate = { candidateId: uuidv7(), revision: state.revision, schemaVersion: state.pair.document.schema_version,
        document: clone(body.document), authoringMetadata: clone(body.authoringMetadata), intentDigest: currentDigest(),
        contentSha256: hash(body.document), status: 'pending', submittedAt: '2026-10-09T00:00:00.000Z', approvedAt: null };
      state.candidates.push(candidate);
      return reply(route, { candidateId: candidate.candidateId, revision: candidate.revision, status: candidate.status,
        intentDigest: candidate.intentDigest, contentSha256: candidate.contentSha256 });
    }
    const detail = /^candidates\/([0-9a-f-]{36})$/.exec(suffix);
    if (detail && method === 'GET') {
      if (state.role !== 'admin') return reply(route, { error: 'forbidden' }, 403);
      const candidate = state.candidates.find(item => item.candidateId === detail[1]);
      return candidate ? reply(route, { candidate: clone(candidate) }) : reply(route, { error: 'not_found' }, 404);
    }
    const action = /^candidates\/([0-9a-f-]{36})\/(approve|release)$/.exec(suffix);
    if (action && method === 'POST') {
      if (state.role !== 'admin') return reply(route, { error: 'forbidden' }, 403);
      const candidate = state.candidates.find(item => item.candidateId === action[1]);
      if (!candidate) return reply(route, { error: 'not_found' }, 404);
      const bindingMatches = body?.revision === candidate.revision && body?.intentDigest === candidate.intentDigest &&
        body?.contentSha256 === candidate.contentSha256 && candidate.revision === state.revision &&
        candidate.intentDigest === currentDigest();
      if (!bindingMatches || (action[2] === 'approve' ? candidate.status !== 'pending' : candidate.status !== 'approved')) {
        if (['pending', 'approved'].includes(candidate.status)) candidate.status = 'superseded';
        return reply(route, { error: 'conflict' }, 409);
      }
      if (action[2] === 'approve') {
        candidate.status = 'approved'; candidate.approvedAt = '2026-10-09T00:01:00.000Z';
        return reply(route, { candidateId: candidate.candidateId, revision: candidate.revision, status: candidate.status,
          approvedAt: candidate.approvedAt, intentDigest: candidate.intentDigest, contentSha256: candidate.contentSha256 });
      }
      candidate.status = 'released'; candidate.versionId = uuidv7(); candidate.versionNo = 2;
      return reply(route, { candidateId: candidate.candidateId, versionId: candidate.versionId, versionNo: candidate.versionNo,
        status: candidate.status, intentDigest: candidate.intentDigest, contentSha256: candidate.contentSha256 });
    }
    return reply(route, { error: 'not_found' }, 404);
  });

  await page.goto(`${shell.origin}/cases`);
  await page.getByLabel('Email', { exact: true }).fill('owner@example.invalid');
  await page.getByRole('button', { name: 'Email me a sign-in code', exact: true }).click();
  await page.getByLabel('One-time code').fill('123456');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('link', { name: 'Published case', exact: true }).click();
  await page.getByRole('button', { name: 'Edit case', exact: true }).click();
  await expect(page.locator('.builder-studio')).toBeVisible();
  return {
    state, caseId, currentDigest, advanceDraft,
    seedPending() {
      const candidate = { candidateId: uuidv7(), revision: state.revision, schemaVersion: state.pair.document.schema_version,
        document: clone(state.pair.document), authoringMetadata: clone(state.pair.authoringMetadata), intentDigest: currentDigest(),
        contentSha256: hash(state.pair.document), status: 'pending', submittedAt: '2026-10-09T00:00:00.000Z', approvedAt: null };
      state.candidates.push(candidate); return candidate;
    },
    async showReview() {
      await page.getByRole('button', { name: state.role === 'admin' ? 'Publish' : 'Send for review', exact: true }).first().click();
      const publication = page.getByRole('dialog', { name: 'Confirm publication' });
      if (state.role === 'admin') { await expect(publication).toBeVisible(); await publication.getByRole('button', { name: 'Keep editing', exact: true }).click(); }
      await expect(page.getByRole('region', { name: 'Awaiting case review' })).toBeVisible();
    },
    async inspect(id) {
      await page.getByText('Versions and review details', { exact: true }).evaluate(node => { node.parentElement.open = true; });
      const row = page.getByRole('list', { name: 'Review details' }).getByRole('listitem').filter({ hasText: id });
      await row.getByRole('button', { name: 'Inspect', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Selected candidate' })).toContainText(`Candidate ${id}.`);
    },
  };
}

test('[AS-123] served Pending author flow submits only the exact acknowledged pair and has no review buttons', async ({ page }) => {
  const model = await openReview(page, 'owner');
  await model.showReview();
  await expect(page.locator('.builder-editor-view')).toBeHidden();
  const review = page.getByRole('region', { name: 'Awaiting case review' });
  await expect(review.getByRole('status')).toContainText('No Pending or retained candidates');
  await review.getByRole('button', { name: 'Send for review', exact: true }).click();
  await expect.poll(() => model.state.candidates.length).toBe(1);
  const submitted = model.state.candidates[0];
  expect(submitted.revision).toBe(model.state.revision);
  expect(submitted.document).toEqual(model.state.pair.document);
  expect(submitted.authoringMetadata).toEqual(model.state.pair.authoringMetadata);
  await review.getByText('Versions and review details', { exact: true }).click();
  await expect(review.getByRole('list', { name: 'Review details' })).toContainText('pending');
  const row = review.getByRole('list', { name: 'Review details' }).getByRole('listitem').filter({ hasText: submitted.candidateId });
  await row.getByRole('button', { name: 'Inspect', exact: true }).click();
  await expect(review.getByRole('status')).toContainText('This account cannot perform that review action.');
  await expect(page.getByRole('region', { name: 'Selected candidate' }).getByRole('button', { name: /Approve|Publish/ })).toHaveCount(0);
  expect(model.state.calls.filter(call => /\/(approve|release)$/.test(call.suffix))).toEqual([]);
  await page.getByRole('button', { name: 'Return to case editing', exact: true }).click();
  await expect(page.locator('.builder-editor-view')).toBeVisible();
  await model.showReview();
  await page.reload();
  await expect(page.getByRole('region', { name: 'Awaiting case review' })).toBeVisible();
  await expect(page.locator('.builder-editor-view')).toBeHidden();
});

test('[AS-123] served admin publishing confirms once and preserves exact approval and release bindings', async ({ page }) => {
  const model = await openReview(page, 'admin');
  await model.showReview();
  const review = page.getByRole('region', { name: 'Awaiting case review' });
  await expect(page.getByRole('button', { name: 'Publish', exact: true })).toHaveCount(1);
  await review.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Confirm publication' })).toBeVisible();
  expect(model.state.calls.filter(call => call.method === 'POST' && call.suffix !== 'readiness')).toEqual([]);
  await page.getByRole('button', { name: 'Publish this update', exact: true }).click();
  await expect.poll(() => model.state.candidates[0]?.status).toBe('released');
  expect(model.state.candidates).toHaveLength(1);
  const candidate = model.state.candidates[0];
  const approval = model.state.calls.find(call => call.suffix.endsWith('/approve'));
  const release = model.state.calls.find(call => call.suffix.endsWith('/release'));
  expect(approval.body).toEqual({ revision: candidate.revision, intentDigest: candidate.intentDigest, contentSha256: candidate.contentSha256 });
  expect(release.body).toMatchObject({ revision: candidate.revision, intentDigest: candidate.intentDigest, contentSha256: candidate.contentSha256 });
  expect(release.body.assetIds).toEqual([]);
  expect(release.body.newEdition).toBe(false);
  expect(release.body.art).toBeTruthy();
});

test('[AS-123] served admin publishing opens its confirmation for a draft larger than 64 KB', async ({ page }) => {
  // Diving Deeper's draft is well over 64 KB; the publication summary must read it with the draft-sized limit.
  const model = await openReview(page, 'admin', state => {
    for (const surface of state.pair.document.surfaces) surface.notes = 'Facilitator note for a long case. '.repeat(60).slice(0, 1990);
    for (const beat of state.pair.document.beats) beat.cue = 'Facilitator cue for a long case. '.repeat(20).slice(0, 590);
    for (const path of state.pair.document.decisions.flatMap(decision => decision.paths)) path.cue = 'Facilitator path cue for a long case. '.repeat(20).slice(0, 590);
  });
  expect(JSON.stringify(model.state.pair).length).toBeGreaterThan(65_536);
  await page.getByRole('button', { name: 'Publish', exact: true }).first().click();
  await expect(page.getByRole('dialog', { name: 'Confirm publication' })).toBeVisible();
  await expect(page.getByText(/request_unavailable/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Publish this update', exact: true }).click();
  await expect.poll(() => model.state.candidates[0]?.status).toBe('released');
});

test('[AS-123] served edits supersede Pending and stale release acknowledgements are refused', async ({ page }) => {
  const model = await openReview(page, 'admin');
  model.seedPending();
  await model.showReview();
  const review = page.getByRole('region', { name: 'Awaiting case review' });
  await expect.poll(() => model.state.candidates.length).toBe(1);
  const first = model.state.candidates[0];

  await page.getByRole('button', { name: 'Return to case editing', exact: true }).click();
  // The case title is edited in Case details (the More menu; CASE-321).
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('group', { name: 'More', exact: true }).getByRole('button', { name: 'Case details', exact: true }).click();
  const title = page.locator('.builder-studio').getByLabel('Case title', { exact: true });
  await title.fill('Edited after Pending submission');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect.poll(() => model.state.revision).toBe(first.revision + 1);
  expect(model.state.candidates[0].status).toBe('superseded');

  await page.getByRole('button', { name: 'Publish', exact: true }).first().click();
  await expect(page.getByRole('dialog', { name: 'Confirm publication' })).toBeVisible();
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Awaiting case review' })).toBeVisible();
  await model.inspect(first.candidateId);
  const detail = page.getByRole('region', { name: 'Selected candidate' });
  await expect(detail).toContainText('superseded');
  await expect(detail.getByRole('button', { name: 'Approve for publication', exact: true })).toHaveCount(0);

  model.seedPending();
  await review.getByRole('button', { name: 'Check status', exact: true }).click();
  await expect.poll(() => model.state.candidates.length).toBe(2);
  const second = model.state.candidates[1];
  await model.inspect(second.candidateId);
  await page.getByRole('region', { name: 'Selected candidate' }).getByRole('button', { name: 'Approve for publication', exact: true }).click();
  await expect.poll(() => model.state.candidates[1].status).toBe('approved');
  await expect(detail.getByRole('button', { name: 'Publish' })).toBeVisible();

  // Model a second entitled editor advancing the saved pair after this approval but before release.
  model.advanceDraft();
  await detail.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByRole('region', { name: 'Awaiting case review' }).getByRole('status')).toContainText(/changed|Reload current information/i);
  expect(model.state.candidates[1].status).toBe('superseded');
  expect(model.state.calls.filter(call => call.suffix.endsWith('/release'))).toHaveLength(1);
});

test('[AS-123] confirmed orphan source traces remain visible publishing blockers with a repair destination', async ({ page }) => {
  await openReview(page, 'admin', state => {
    state.pair.authoringMetadata.provenance = [{ entity_id: uuidv7(), field: 'scene', transformation: 'editorial', visibility: 'public', review_status: 'confirmed' }];
  });
  const readiness = page.locator('.builder-zone-readiness');
  await readiness.locator('summary').click();
  const blocker = readiness.getByRole('button', { name: /Provenance identity is not present/ });
  await expect(blocker).toBeVisible();
  await expect(blocker.locator('..')).toContainText('stops publishing');
  await expect(blocker.locator('..')).toHaveAttribute('data-stops', 'publish');
  await expect(readiness).not.toContainText('Nothing to fix.');
  await blocker.click();
  await expect(page.locator('.builder-provenance-row').first()).toBeVisible();
});
