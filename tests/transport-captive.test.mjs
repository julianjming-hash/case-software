// A TLS-inspecting hospital proxy or portal can answer a long-held request with its own HTML page and status 200
// (2026-10-17 reliability audit). That is not the room: the client must back off and say it is not live, not
// re-request at network speed while showing `online`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { connect, testLifecycle } from '../src/client/transport.mjs';
import { uuidv7, newCapabilityToken } from '../src/shared/ids.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const snapshot = revision => Response.json({ v: 1, t: 'snapshot', epoch: 0, revision, displayRevision: revision, view: {} });

test('an HTML 200 from a proxy is not a live room: the long-poll backs off and the status leaves online', { timeout: 5000 }, async () => {
  let portal = false, revision = 1, calls = 0;
  const fetchImpl = async url => {
    await sleep(5); // a nearby proxy answers fast
    if (portal) { calls++; return new Response('<html><body>Session expired. Sign in again.</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }); }
    const u = new URL(url);
    if (!u.pathname.endsWith('/updates')) return snapshot(revision);
    // Like the Worker: a long-poll behind the client's revision answers with the snapshot, never 'unchanged'.
    if (Number(u.searchParams.get('after')) < revision) return snapshot(revision);
    return (await sleep(40), Response.json({ v: 1, t: 'unchanged', revision, displayRevision: revision }));
  };
  const statuses = [];
  const link = connect({ role: 'display', api: 'https://case.test', sessionId: uuidv7(), token: newCapabilityToken(),
    storage: null, persistentStorage: null, lifecycle: testLifecycle(), fetchImpl, telemetryImpl: () => {},
    timings: { RECONNECT_BASE_MS: 20, POLL_MS: 100, LONG_POLL_PROBE_MS: 400, HEARTBEAT_MS: 50, DEAD_AFTER_MS: 150, LONG_POLL_WAIT_S: 0.04 } });
  link.on('status', status => statuses.push(status));
  try {
    const live = Date.now() + 1000;
    while (link.status !== 'online' && Date.now() < live) await sleep(5);
    assert.equal(link.status, 'online');
    portal = true;
    await sleep(1000);
    // Backoff then 100 ms short polls allow about ten requests in a second; a hot loop makes about 200.
    assert.ok(calls <= 20, `${calls} requests to the proxy page in one second`);
    assert.notEqual(link.status, 'online', 'a proxy page is not the room');
    portal = false; revision = 2;
    const back = Date.now() + 2000;
    while ((link.status !== 'online' || link.snapshot?.revision !== 2) && Date.now() < back) await sleep(10);
    assert.equal(link.status, 'online');
    assert.equal(link.snapshot.revision, 2);
  } finally { link.close(); }
});
