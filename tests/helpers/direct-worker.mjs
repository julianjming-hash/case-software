// tests/helpers/direct-worker.mjs: the real Case Worker in local workerd through Miniflare directly, for
// the CI load gates (AS-093, AS-097). `wrangler dev` (local-worker.mjs) puts its ProxyWorker in front of
// the Worker, and under a burst of concurrent commands that proxy dropped its own connection ("Error
// inside ProxyWorker ... Network connection lost", main CI 39005621478): the 2 s resend then landed in
// the gate's p95. Deployed Workers have no such layer, so the gates measure the Worker without it.
//
// The bindings come from wrangler.toml itself (unstable_getMiniflareWorkerOptions), so Durable Objects,
// rate limits and vars match `wrangler dev`; the test-only vars are the same ones local-worker.mjs
// passes. Durable Object SQLite goes to a throwaway dir under TMPDIR, as with `--persist-to`. No
// client assets are built: the load gates speak HTTP and WebSocket only. No network and no account.
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { unstable_getMiniflareWorkerOptions } from 'wrangler';
import { build } from 'esbuild';
import { createWriteStream, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { uuidv7 } from '../../src/shared/ids.mjs';
import { ACCOUNT_ORIGIN, TEST_JWT_SECRET, accountCallRefused, answerAccountCall } from './local-worker.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Writes every Miniflare line to the worker log, each stamped with wall-clock ms like local-worker.mjs. */
class FileLog extends Log {
  constructor(file, echo) { super(LogLevel.INFO, { prefix: 'workerd' }); this.file = file; this.echo = echo; }
  log(message) {
    this.file?.write(String(message).split('\n').filter(Boolean).map(line => `${Date.now()} ${line}\n`).join(''));
    if (this.echo) process.stderr.write(`${message}\n`);
  }
}

// Taken from wrangler.toml as `wrangler dev` reads it. The bundle replaces the source options, `wrangler dev`
// never fires the crons on its own either, and the gates request only /api/*, which runs the Worker first.
const PASSED = ['compatibilityDate', 'compatibilityFlags', 'bindings', 'durableObjects', 'ratelimits', 'r2Buckets'];
const REPLACED = ['rootPath', 'modulesRules', 'cronTriggers', 'assets'];
export function configBindings(configPath = join(ROOT, 'wrangler.toml')) {
  const { workerOptions } = unstable_getMiniflareWorkerOptions(configPath);
  const used = value => value != null && (Array.isArray(value) ? value.length > 0
    : typeof value === 'object' ? Object.values(value).some(used) : value !== false);
  // A binding kind added to wrangler.toml later must be passed here, never silently dropped.
  const dropped = Object.keys(workerOptions).filter(key => !PASSED.includes(key) && !REPLACED.includes(key) && used(workerOptions[key]));
  if (dropped.length) throw new Error(`direct worker does not pass wrangler.toml options: ${dropped.join(', ')}`);
  return Object.fromEntries(PASSED.map(key => [key, workerOptions[key]]));
}

/**
 * Start the Worker in workerd on an OS-assigned port. Resolves `{ origin, port, stop }` once it answers.
 * @param {{log?: boolean, bindings?: Record<string,string>}} [o]  `bindings` overrides test vars (e.g. LOCK_GRACE_MS)
 */
export async function startDirectWorker({ log = Boolean(process.env.CASE_WORKER_LOG), bindings = {} } = {}) {
  const persist = mkdtempSync(join(tmpdir(), 'case-direct-worker-'));
  const workerLogDir = process.env.CASE_WORKER_LOG_DIR || null;
  if (workerLogDir) mkdirSync(workerLogDir, { recursive: true });
  const logFile = workerLogDir ? createWriteStream(join(workerLogDir, `workerd-${Date.now()}-${uuidv7().slice(-8)}.log`)) : null;
  const fileLog = new FileLog(logFile, log);
  const closeLog = () => new Promise(resolve => logFile ? logFile.end(resolve) : resolve());
  // This key exists only in the throwaway harness; the Worker still calls an HTTPS-only RPC origin.
  const serviceKey = `sb_secret_local_${uuidv7()}`;
  let mf;
  try {
    const workerOptions = configBindings();
    const bundle = await build({ entryPoints: [join(ROOT, 'src/worker/index.mjs')], bundle: true,
      format: 'esm', platform: 'neutral', target: 'es2022', write: false,
      external: ['cloudflare:workers'], loader: { '.sql': 'text' } });
    mf = new Miniflare(convertV4MiniflareOptions({
      ...workerOptions,
      host: '127.0.0.1', port: 0, rootPath: ROOT, script: bundle.outputFiles[0].text, modules: true,
      bindings: { ...workerOptions.bindings,
        SUPABASE_JWT_SECRET: TEST_JWT_SECRET, CASE_ALLOW_HS256: '1', CASE_DEV_INLINE_CASES: '1', BROADCAST_COALESCE_MS: '0', LOCK_GRACE_MS: '0', AUTO_LOCK_MS: '0',
        SUPABASE_URL: `${ACCOUNT_ORIGIN}/`, SUPABASE_SECRET_KEY: serviceKey, ...bindings },
      durableObjectsPersist: join(persist, 'do'), r2Persist: join(persist, 'r2'),
      log: fileLog, logRequests: Boolean(workerLogDir || log),
      handleStructuredLogs: ({ message }) => fileLog.log(message),
      // The same single outbound call local-worker.mjs's bridge allows; every other host is refused.
      outboundService: async request => {
        const url = new URL(request.url);
        if (url.origin !== ACCOUNT_ORIGIN || url.search || url.hash ||
            accountCallRefused({ method: request.method, path: url.pathname, header: name => request.headers.get(name) }, serviceKey))
          throw new Error('Unexpected outbound host or RPC in local Worker test');
        const body = await request.text();
        if (new TextEncoder().encode(body).length > 1024) return Response.json({ error: 'fixture_refused' }, { status: 413 });
        return answerAccountCall(request.headers, body);
      },
    }));
    const origin = (await mf.ready).origin.replace(/\/$/, '');
    const port = Number(new URL(origin).port);
    const stop = async () => {
      try { await mf.dispose(); } finally { rmSync(persist, { recursive: true, force: true }); await closeLog(); }
    };
    return { origin, port, stop };
  } catch (error) {
    try { await mf?.dispose(); } catch { /* never started */ }
    rmSync(persist, { recursive: true, force: true });
    await closeLog();
    throw error;
  }
}
