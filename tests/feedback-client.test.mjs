// The Finish block's feedback saver (room PDFs v2): credentials only in the Authorization header, coalesced auto-saves,
// one re-read on a conflict, and a joined credential from elsewhere falling back to this browser's key. A fake fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFeedbackSaver, joinedCredential } from '../src/client/feedback-client.mjs';

const SID = '01a14509-77e2-76d4-82c0-49d4c678885e', CODE = 'A7K2M9';
function memoryStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return { get length() { return m.size; }, key: i => [...m.keys()][i] ?? null, getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), m };
}
function harness({ joined = false, responses = [] } = {}) {
  const storage = memoryStorage(joined ? { [`case:participant:${SID}:token`]: JSON.stringify({ sessionId: SID, token: 'tok-1', expiresAt: Date.now() + 3600e3 }) } : {});
  const calls = [], queue = [...responses];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', auth: init.headers?.authorization ?? null, body: init.body ? JSON.parse(init.body) : null });
    const next = queue.shift() ?? { status: 200, data: { revision: calls.length, closesAt: '2026-10-20T09:00:00Z' } };
    if (next.wait) await next.wait;
    return new Response(JSON.stringify(next.data ?? {}), { status: next.status, headers: { 'content-type': 'application/json' } });
  };
  const win = { localStorage: storage, setTimeout: (f) => { f(); return 0; } };
  return { calls, storage, saver: createFeedbackSaver({ code: CODE, sessionId: SID, closesAt: '2026-10-20T09:00:00Z', win, fetchImpl }) };
}

test('[AS-175] a joined phone saves as its participant credential; nothing personal in the URL', async () => {
  const { calls, saver } = harness({ joined: true });
  assert.deepEqual(await saver.save({ rating_session: 4 }), { ok: true, closesAt: '2026-10-20T09:00:00Z' });
  assert.equal(calls[0].auth, 'Participant tok-1');
  assert.equal(calls[0].method, 'PUT');
  assert.match(calls[0].url, /\/api\/v1\/feedback\/A7K2M9$/);
  assert.doesNotMatch(calls[0].url, /tok-1|rating/);
});

test('[room PDFs v2] a browser that did not join mints one random key and keeps it until feedback closes', async () => {
  const { calls, storage, saver } = harness();
  await saver.save({ rating_app: 5 }); await saver.save({ rating_app: 4 });
  const record = JSON.parse(storage.getItem(`case:feedback:${SID}:key`));
  assert.match(calls[0].auth, /^Feedback [A-Za-z0-9_-]{22}$/);
  assert.equal(calls[1].auth, calls[0].auth, 'the same key both times');
  assert.equal(record.expiresAt, Date.parse('2026-10-20T09:00:00Z'));
  assert.equal(calls[1].body.expectedRevision, 1, 'an edit names the revision it read');
});

test('[AS-175] saves made while one is in flight coalesce into one more save with the newest answers', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const { calls, saver } = harness({ joined: true, responses: [{ status: 200, data: { revision: 1 }, wait: gate }] });
  const first = saver.save({ rating_case: 1 }), second = saver.save({ rating_case: 2 }), third = saver.save({ rating_case: 3 });
  assert.equal(second, third, 'the waiting saves share one promise');
  release(); await first; await third;
  assert.deepEqual(calls.map(c => c.body.answers.rating_case), [1, 3]);
});

test('[room PDFs v2] a conflict re-reads once, then this phone\'s newest answers win; a second conflict reports it', async () => {
  const conflict = { status: 409, data: { error: 'feedback_conflict' } };
  const once = harness({ joined: true, responses: [conflict, { status: 200, data: { answers: { rating_app: 2 }, revision: 3 } }] });
  assert.equal((await once.saver.save({ rating_app: 5 })).ok, true);
  assert.deepEqual(once.calls.map(c => c.method), ['PUT', 'GET', 'PUT']);
  assert.equal(once.calls[2].body.expectedRevision, 3);
  const twice = harness({ joined: true, responses: [conflict, { status: 200, data: { answers: { rating_app: 2 }, revision: 3 } }, conflict] });
  assert.deepEqual(await twice.saver.save({ rating_app: 5 }), { ok: false, error: 'changed' });
});

test('[room PDFs v2] a credential the room refuses falls back to this browser\'s key; refusals map to plain errors', async () => {
  const fallback = harness({ joined: true, responses: [{ status: 401, data: { error: 'unauthorised' } }] });
  assert.equal((await fallback.saver.save({ rating_app: 5 })).ok, true);
  assert.match(fallback.calls[1].auth, /^Feedback /);
  for (const [error, mapped] of [['feedback_closed', 'closed'], ['feedback_edit_cap', 'edit_cap'], ['feedback_full', 'full'], ['invalid_feedback', 'invalid']]) {
    const h = harness({ joined: true, responses: [{ status: 409, data: { error } }] });
    assert.deepEqual(await h.saver.save({ rating_app: 5 }), { ok: false, error: mapped });
  }
  assert.equal(joinedCredential(memoryStorage({ [`case:participant:${SID}:token`]: JSON.stringify({ sessionId: 'other', token: 'x' }) }), SID), null, 'another room\'s credential is not used');
});
