#!/usr/bin/env node
// scripts/deploy-guard.mjs: refuse a deploy while any room is live (spec red team 2, P1-8; CASE-109).
//
// A Worker deploy restarts every Durable Object. A room survives that (its state rebuilds from
// storage), but every socket drops at once, mid-vote, in front of a room. `npm run deploy` runs this
// first: it asks the deployed Worker how many rooms are live and stops the deploy unless it is none.
//
//   DEPLOY_GUARD_TOKEN=… npm run deploy
//   --api <explicit Case/local origin> (or explicit CASE_API) · production additionally requires --prod
//   --allow-live overrides a positive count only; failures still stop the deploy.
//
// The token goes only in the Authorization header, never in a URL or a log line. The Worker answers
// GET /api/v1/ops/live-rooms only when its own DEPLOY_GUARD_TOKEN secret matches (constant time).
// Zero dependencies; Node ≥ 22.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Reject credentials, suffix tricks, redirects and non-Case targets before sending a token. */
export function validateDeployOrigin(api, { prod = false } = {}) {
  let url; try { url = new URL(api); } catch { throw new Error('invalid_deploy_origin'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('invalid_deploy_origin');
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.protocol === 'http:';
  const staging = url.origin === 'https://case-staging.iatrogenic.app';
  const production = url.origin === 'https://case.iatrogenic.app';
  if (production && !prod) throw new Error('production_requires_prod');
  if (!local && !staging && !production) throw new Error('invalid_deploy_origin');
  return url.origin;
}

/** One deadline covers fetch and streamed body, even when an injected fetch ignores cancellation. */
export async function fetchBoundedJson(url, { headers = {}, fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) throw new TypeError('invalid_timeout');
  const controller = new AbortController(); let reader; let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new DOMException('Request timed out', 'TimeoutError');
      controller.abort(error); reader?.cancel().catch(() => {}); reject(error);
    }, timeoutMs);
  });
  const operation = async () => {
    const response = await fetchImpl(url, { redirect: 'error', headers, signal: controller.signal });
    if (response.status !== 200) { const error = new Error('unexpected_http_status'); error.status = response.status; throw error; }
    reader = response.body?.getReader(); if (!reader) throw new Error('empty_response');
    const chunks = []; let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.length; if (bytes > 4096) { await reader.cancel(); throw new Error('response_too_large'); } chunks.push(value);
    }
    const merged = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
    return { body: JSON.parse(new TextDecoder().decode(merged)), headers: response.headers };
  };
  try { return await Promise.race([operation(), deadline]); }
  finally { clearTimeout(timer); controller.abort(); }
}

/** `{ ok: true, live }` or `{ ok: false, error }`. */
export async function liveRooms({ api, prod = false, token, fetchImpl = globalThis.fetch, timeoutMs = 15_000 }) {
  if (!token) return { ok: false, error: 'DEPLOY_GUARD_TOKEN is not set: the guard cannot ask the Worker, so the deploy stops.' };
  let origin;
  try { origin = validateDeployOrigin(api, { prod }); } catch { return { ok: false, error: 'Explicit valid Case/local origin required; production also requires --prod.' }; }
  try {
    const { body } = await fetchBoundedJson(`${origin}/api/v1/ops/live-rooms`, { headers: { authorization: `Bearer ${token}` }, fetchImpl, timeoutMs });
    if (!Number.isSafeInteger(body?.live) || body.live < 0) return { ok: false, error: 'the guard endpoint gave no live-room count' };
    return { ok: true, live: body.live };
  } catch (e) {
    if (Number.isInteger(e?.status)) return { ok: false, error: `the guard endpoint answered HTTP ${e.status} (is DEPLOY_GUARD_TOKEN set on the Worker, and the same here?)` };
    return { ok: false, error: `could not reach ${origin}: ${e?.name === 'TimeoutError' ? 'timed out' : 'network error'}` };
  }
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const allowLive = argv.includes('--allow-live');
  let api = env.CASE_API;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--api') api = argv[++i];
    else if (!['--prod', '--allow-live'].includes(argv[i])) { console.error('deploy-guard: unknown option'); return 1; }
  }
  const r = await liveRooms({ api, prod: argv.includes('--prod'), token: env.DEPLOY_GUARD_TOKEN });
  if (!r.ok) { console.error(`deploy-guard: ${r.error}`); return 1; }
  if (r.live === 0) { console.log('deploy-guard: no live rooms; deploying.'); return 0; }
  const msg = `deploy-guard: ${r.live} live room${r.live === 1 ? '' : 's'}. A deploy now drops every phone and projector mid-session (docs/RUNBOOK-INCIDENT.md §Deploy mid-room).`;
  if (allowLive) { console.warn(`${msg} Deploying anyway (--allow-live).`); return 0; }
  console.error(`${msg} Not deploying. Wait for the rooms to end, or pass --allow-live for an urgent fix.`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code));
}
