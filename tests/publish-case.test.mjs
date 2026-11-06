import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uuidv7 } from '../src/shared/ids.mjs';
import { miniCase } from './helpers/mini-case.mjs';
import { chainCase } from './helpers/art-cases.mjs';
import { publishCase } from '../scripts/publish-case.mjs';
import { describeCase, withSolution, validArtDescriptor, ART_SUMMARISED_WARNING } from '../src/shared/art-descriptor.mjs';
import { solveArt } from '../src/shared/mosaic-geometry.mjs';

const workspaceId = uuidv7(), caseId = uuidv7(), versionId = uuidv7();
const document = miniCase().doc;
const contentSha256 = `\\x${'a'.repeat(64)}`;
const fake = () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const endpoint = new URL(url).pathname;
    return Response.json(endpoint === '/api/v1/cases' ? { caseId }
      : endpoint.endsWith('/draft') ? { revision: 1 }
        : { versionId, versionNo: 1, contentSha256 }, { status: endpoint === '/api/v1/cases' || endpoint.endsWith('/publish') ? 201 : 200 });
  };
  return { calls, fetchImpl };
};
const run = (args, options = {}) => publishCase({ args, readToken: async () => 'test-only-jwt',
  readFixture: async () => document, ...options });

test('target guard refuses prod without --prod and refuses arbitrary origins before token read', async () => {
  let reads = 0;
  for (const args of [[], ['--target', 'https://case.iatrogenic.app', '--workspace-id', workspaceId],
    ['--target', 'https://evil.invalid', '--workspace-id', workspaceId],
    ['--target', 'https://case-staging.iatrogenic.app/extra', '--workspace-id', workspaceId],
    ['--target', 'https://case-staging.iatrogenic.app', '--workspace-id', workspaceId, '--prod']]) {
    await assert.rejects(run(args, { readToken: async () => { reads++; return 'secret'; },
      fetchImpl: async () => Response.json({}) }), /target|argument/i);
  }
  assert.equal(reads, 0);
});

test('Julian-run CLI reads JWT only from supplied stdin reader and calls Worker authoring endpoints', async () => {
  const service = fake();
  const result = await run(['--target', 'https://case-staging.iatrogenic.app', '--workspace-id', workspaceId],
    { fetchImpl: service.fetchImpl });
  assert.deepEqual(result, { caseId, versionId, versionNo: 1, contentSha256 });
  assert.deepEqual(service.calls.map(call => new URL(call.url).pathname), [
    '/api/v1/cases', `/api/v1/cases/${caseId}/draft`, `/api/v1/cases/${caseId}/publish`,
  ]);
  assert.equal(service.calls.every(call => new URL(call.url).search === '' &&
    call.init.headers.authorization === 'Bearer test-only-jwt' && call.init.redirect === 'error'), true);
  assert.deepEqual(JSON.parse(service.calls[1].init.body), { expectedRevision: 0,
    schemaVersion: 1, document });
  const art = withSolution(describeCase(document), solveArt(describeCase(document)));
  assert.equal(validArtDescriptor(art), true);
  assert.deepEqual(JSON.parse(service.calls[2].init.body), { expectedRevision: 1, assetIds: [], art });
});

test('[CASE-164] the builder publishes a summarised cover with the exact readiness warning and never blocks', async () => {
  // Fourteen decisions of three alternatives each exceed the braid's capacity.
  const big = chainCase(14, 3, { resetEvery: 2 });
  const solved = solveArt(describeCase(big));
  assert.equal(solved.summarised, true);
  const warnings = [];
  const service = fake();
  await run(['--target', 'https://case-staging.iatrogenic.app', '--workspace-id', workspaceId],
    { fetchImpl: service.fetchImpl, readFixture: async () => big, warn: message => warnings.push(message) });
  const body = JSON.parse(service.calls[2].init.body);
  assert.equal(body.art.summarised, solved.summarised);
  assert.equal(body.art.attempt, solved.attempt);
  assert.deepEqual(warnings, [ART_SUMMARISED_WARNING]);
  const plain = [];
  await run(['--target', 'https://case-staging.iatrogenic.app', '--workspace-id', workspaceId],
    { fetchImpl: fake().fetchImpl, warn: message => plain.push(message) });
  assert.deepEqual(plain, []);
});

test('CLI refuses a malformed published hash or nonpositive version number before recording a pilot pin', async () => {
  for (const result of [{ versionId, versionNo: 1, contentSha256: 'garbage' },
    { versionId, versionNo: 0, contentSha256 }]) {
    const service = fake();
    const fetchImpl = async (url, init) => new URL(url).pathname.endsWith('/publish')
      ? Response.json(result, { status: 201 }) : service.fetchImpl(url, init);
    await assert.rejects(run(['--target', 'https://case-staging.iatrogenic.app', '--workspace-id', workspaceId],
      { fetchImpl }), /Invalid Worker response/);
  }
});

test('bad Worker response stops publication without echoing upstream text or JWT', async () => {
  const service = fake();
  const fetchImpl = async (url, init) => {
    if (new URL(url).pathname.endsWith('/draft')) return Response.json({ error: 'test-only-jwt private' }, { status: 503 });
    return service.fetchImpl(url, init);
  };
  await assert.rejects(run(['--target', 'http://localhost:8787', '--workspace-id', workspaceId], { fetchImpl }),
    error => error.message === 'Worker authoring request failed (503)');
  assert.equal(service.calls.some(call => call.url.endsWith('/publish')), false);
});

const staging = ['--target', 'https://case-staging.iatrogenic.app', '--workspace-id', workspaceId];

test('--file publishes the named case document instead of the built-in fixture', async () => {
  const other = { ...miniCase().doc, title: 'Other case' };
  const service = fake();
  const read = [];
  await publishCase({ args: [...staging, '--file', 'cases/other.json'], readToken: async () => 'test-only-jwt',
    readFixture: async () => { throw new Error('fixture must not be read'); },
    readCaseFile: async path => { read.push(path); return JSON.stringify(other); }, fetchImpl: service.fetchImpl });
  assert.deepEqual(read, ['cases/other.json']);
  assert.equal(JSON.parse(service.calls[0].init.body).title, 'Other case');
  assert.equal(JSON.parse(service.calls[1].init.body).document.title, 'Other case');
});

test('--file refuses an invalid document naming the field, and non-JSON, before reading the token or calling out', async () => {
  const bad = { ...miniCase().doc, duration_min: 7 };
  let reads = 0;
  const service = fake();
  const tryFile = text => publishCase({ args: [...staging, '--file', 'x.json'],
    readToken: async () => { reads++; return 'secret'; }, readCaseFile: async () => text, fetchImpl: service.fetchImpl });
  await assert.rejects(tryFile(JSON.stringify(bad)), /\/duration_min/);
  await assert.rejects(tryFile('{not json'), /not valid JSON/);
  assert.equal(reads, 0);
  assert.equal(service.calls.length, 0);
});

test('--dry-run validates and solves the art, prints a summary, and makes no network call or token read', async () => {
  let reads = 0, called = 0;
  const warnings = [];
  const result = await publishCase({ args: [...staging, '--dry-run'], readFixture: async () => document,
    readToken: async () => { reads++; return 'secret'; }, fetchImpl: async () => { called++; return Response.json({}); },
    warn: m => warnings.push(m) });
  assert.equal(reads, 0);
  assert.equal(called, 0);
  assert.equal(result.dryRun, true);
  assert.equal(result.title, document.title);
  assert.equal(result.versionNo, 1);
  assert.equal(result.decisions, document.decisions.length);
  assert.equal(result.routes, document.decisions.reduce((n, d) => n + d.paths.length, 0));
  const solved = solveArt(describeCase(document));
  assert.equal(result.art.attempt, solved.attempt);
  assert.equal(result.art.summarised, solved.summarised);
  const big = chainCase(14, 3, { resetEvery: 2 });
  const summarised = await publishCase({ args: [...staging, '--dry-run'], readFixture: async () => big,
    fetchImpl: async () => { called++; return Response.json({}); }, warn: m => warnings.push(m) });
  assert.equal(summarised.art.summarised, true);
  assert.deepEqual(warnings, [ART_SUMMARISED_WARNING]);
  assert.equal(called, 0);
});
