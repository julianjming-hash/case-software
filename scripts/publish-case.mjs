#!/usr/bin/env node
// Julian-run pilot publisher. It calls the Worker only; the bearer JWT is read from stdin.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { isUuidV7 } from '../src/shared/ids.mjs';
import { apiPath } from '../src/shared/urls.mjs';
import { validateCaseDocument } from '../src/shared/case-document.mjs';
import { prepareArt } from '../src/shared/mosaic-geometry.mjs';

const PROD = 'https://case.iatrogenic.app';
const STAGING = 'https://case-staging.iatrogenic.app';
const fail = message => new Error(message);

function options(args) {
  const found = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--prod' && !found.prod) { found.prod = true; continue; }
    if (flag === '--dry-run' && !found.dryRun) { found.dryRun = true; continue; }
    if ((flag === '--target' || flag === '--workspace-id' || flag === '--file') && args[i + 1] && !found[flag]) {
      found[flag] = args[++i]; continue;
    }
    throw fail('Invalid argument');
  }
  const target = found['--target'], workspaceId = found['--workspace-id'];
  if (!target || !isUuidV7(workspaceId)) throw fail('Invalid target or workspace argument');
  let url;
  try { url = new URL(target); } catch { throw fail('Invalid target'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      url.href !== `${url.origin}/`) throw fail('Invalid target');
  const local = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname) && Boolean(url.port);
  if (!local && url.origin !== STAGING && url.origin !== PROD) throw fail('Invalid target');
  if (url.origin === PROD && !found.prod) throw fail('Production target requires --prod');
  if (found.prod && url.origin !== PROD) throw fail('--prod requires production target');
  return { origin: url.origin, workspaceId, file: found['--file'], dryRun: Boolean(found.dryRun) };
}

async function stdinToken() {
  let token = '';
  for await (const chunk of process.stdin) {
    token += chunk.toString('utf8');
    if (token.length > 16_384) throw fail('Invalid stdin token');
  }
  return token.trim();
}

async function fixture() {
  return JSON.parse(await readFile(new URL('../src/fixtures/synthetic-workshop.case.json', import.meta.url), 'utf8'));
}

async function loadFile(path, readCaseFile) {
  let text;
  try { text = await readCaseFile(path); } catch { throw fail(`Cannot read case file ${path}`); }
  try { return JSON.parse(text); } catch { throw fail(`Case file ${path} is not valid JSON`); }
}

async function readSmallJson(response) {
  if (Number(response.headers.get('content-length') || 0) > 65_536) throw fail('Invalid Worker response');
  const reader = response.body?.getReader();
  if (!reader) throw fail('Invalid Worker response');
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 65_536) { await reader.cancel(); throw fail('Invalid Worker response'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw fail('Invalid Worker response'); }
}

export async function publishCase({ args, readToken = stdinToken, readFixture = fixture, fetchImpl = fetch,
  readCaseFile = path => readFile(path, 'utf8'), warn = message => console.error(`readiness: ${message}`) }) {
  const { origin, workspaceId, file, dryRun } = options(args);
  const document = file ? await loadFile(file, readCaseFile) : await readFixture();
  const checked = validateCaseDocument(document);
  if (!checked.ok) {
    if (!file) throw fail('Fixture is invalid');
    throw fail(`Case file ${file} is invalid:\n${checked.errors.map(e => `  ${e.at || '(document)'}: ${e.message}`).join('\n')}`);
  }
  // The builder solves the cover layout once (CASE-164); the Worker re-derives and verifies it.
  const { art, readiness } = prepareArt(document);
  for (const item of readiness) warn(item.message);
  if (dryRun) {
    // A new case is created on every run, so its first published version is 1. Nothing is sent.
    return { dryRun: true, title: document.title, versionNo: 1, decisions: document.decisions.length,
      routes: document.decisions.reduce((n, d) => n + (d.paths?.length || 0), 0),
      art: { attempt: art.attempt, summarised: art.summarised } };
  }
  const token = await readToken();
  if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) throw fail('Invalid stdin token');
  const call = async (parts, method, body, expectedStatus) => {
    let response;
    try {
      response = await fetchImpl(new URL(apiPath(...parts), origin).href, { method, redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body) });
    } catch { throw fail('Worker authoring request failed (network)'); }
    if (response.status !== expectedStatus) throw fail(`Worker authoring request failed (${response.status})`);
    return readSmallJson(response);
  };
  const created = await call(['cases'], 'POST', { workspaceId, title: document.title }, 201);
  if (!isUuidV7(created?.caseId)) throw fail('Invalid Worker response');
  const saved = await call(['cases', created.caseId, 'draft'], 'PUT',
    { expectedRevision: 0, schemaVersion: document.schema_version, document }, 200);
  if (!Number.isSafeInteger(saved?.revision) || saved.revision < 1) throw fail('Invalid Worker response');
  const published = await call(['cases', created.caseId, 'publish'], 'POST',
    { expectedRevision: saved.revision, assetIds: [], art }, 201);
  if (!isUuidV7(published?.versionId) || !Number.isSafeInteger(published.versionNo) ||
      published.versionNo < 1 || !/^\\x[0-9a-f]{64}$/i.test(published.contentSha256))
    throw fail('Invalid Worker response');
  return { caseId: created.caseId, versionId: published.versionId,
    versionNo: published.versionNo, contentSha256: published.contentSha256 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await publishCase({ args: process.argv.slice(2) }))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
