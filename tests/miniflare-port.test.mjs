// The Miniflare test Workers must bind a port the OS assigns to workerd itself. A port probed and released
// beforehand can be taken by another process before workerd binds it ("bind(): Address already in use",
// seen on main CI shards 4 and 6 on 2026-10-16). This test makes that race certain: every port a probe
// server releases is taken at once, so a helper that still probes cannot start.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';

async function withReleasedPortsTaken(run) {
  const realCreateServer = net.createServer;
  const blockers = [];
  net.createServer = (...args) => {
    const server = realCreateServer(...args);
    const close = server.close.bind(server);
    server.close = (callback) => {
      const port = server.address()?.port;
      return close((error) => {
        if (!port) return callback?.(error);
        const blocker = realCreateServer();
        blocker.unref();
        blocker.listen(port, '127.0.0.1', () => { blockers.push(blocker); callback?.(error); });
      });
    };
    return server;
  };
  syncBuiltinESMExports();
  try { return await run(blockers); } finally {
    net.createServer = realCreateServer;
    syncBuiltinESMExports();
    await Promise.all(blockers.map((blocker) => new Promise((resolve) => blocker.close(resolve))));
  }
}

test('published test Worker starts when every probed port is taken before workerd binds', { timeout: 60_000 }, async () => {
  const { startPublishedWorker } = await import('./helpers/published-worker.mjs');
  let worker;
  try {
    worker = await withReleasedPortsTaken(() => startPublishedWorker());
    const response = await fetch(`${worker.origin}/api/v1/version`);
    assert.equal(response.status, 200);
    assert.match(new URL(worker.origin).port, /^\d+$/);
  } finally { await worker?.stop(); }
});

test('admin test Worker starts when every probed port is taken before workerd binds', { timeout: 60_000 }, async () => {
  const { startAdminWorker } = await import('./helpers/admin-worker.mjs');
  let worker;
  try {
    worker = await withReleasedPortsTaken(() => startAdminWorker({ authOrigin: 'https://127.0.0.1:9', caseOrigin: 'https://127.0.0.1:9' }));
    const response = await fetch(`${worker.origin}/api/v1/version`);
    assert.equal(response.status, 200);
  } finally { await worker?.stop?.(); }
});
