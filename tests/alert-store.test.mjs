import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { AlertStore } from '../src/worker/alert-store.mjs';
import { ALERT_DEDUP_MS } from '../src/worker/alerts.mjs';
const payload={event:{kind:'lockdown_alert'},env:'local',build:'unconfigured'};
function database() {
  const db=new DatabaseSync(':memory:');
  const sql={exec(text,...args) {
    if (/^CREATE/.test(text.trim())) {db.exec(text);return {toArray:()=>[]};}
    const stmt=db.prepare(text);
    if (/^SELECT/.test(text.trim())) return {toArray:()=>stmt.all(...args)};
    stmt.run(...args);return {toArray:()=>[]};
  }};
  return {db,sql};
}
test('durable alert admission preserves the pending key/body and lease across reconstructed stores', () => {
  const {db,sql}=database();try {
    const first=new AlertStore(sql);
    assert.deepEqual(first.reserve('local:lockdown_alert:',100,payload,'one',5000),{id:'one',event:payload});
    const restored=new AlertStore(sql);
    assert.equal(restored.reserve('local:lockdown_alert:',200,payload,'two',5000),null);
    assert.deepEqual(restored.reserve('local:lockdown_alert:',5100,{...payload,build:'a'.repeat(40)},'two',5000),{id:'one',event:payload});
    restored.failure('local:lockdown_alert:','one');
    assert.deepEqual(restored.reserve('local:lockdown_alert:',5101,payload,'three',5000),{id:'one',event:payload});
  } finally {db.close();}
});
test('successful alert dedup survives reconstruction for exact six-hour interval and rejects stale acknowledgements', () => {
  const {db,sql}=database();try {
    const first=new AlertStore(sql);first.reserve('local:lockdown_alert:',100,payload,'one',5000);
    first.success('local:lockdown_alert:','stale',200);
    assert.equal(first.reserve('local:lockdown_alert:',200,payload,'two',5000),null);
    first.success('local:lockdown_alert:','one',300);
    const restored=new AlertStore(sql);
    assert.deepEqual(restored.reserve('local:lockdown_alert:',300+ALERT_DEDUP_MS-1,payload,'two',5000),{dedup:true});
    assert.deepEqual(restored.reserve('local:lockdown_alert:',300+ALERT_DEDUP_MS,payload,'two',5000),{id:'two',event:payload});
    restored.failure('local:lockdown_alert:','one');
    assert.equal(restored.reserve('local:lockdown_alert:',301+ALERT_DEDUP_MS,payload,'three',5000),null);
  } finally {db.close();}
});

// A deployment must not reinterpret a durable pending send under its existing provider key.
test('legacy pending alert retries the exact text-only provider body after the email release', async () => {
  const { AlertDelivery } = await import('../src/worker/alerts.mjs');
  const { uuidv7 } = await import('../src/shared/ids.mjs');
  const { db, sql } = database(), id = uuidv7(), event = { kind: 'lockdown_alert' };
  const facts = { event, env: 'staging', build: 'a'.repeat(40) };
  const env = { CASE_ENV: 'staging', BUILD_SHA: 'b'.repeat(40), ALERT_EMAIL_TO: 'operator@example.invalid', RESEND_ALERT_API_KEY: 'test-only' };
  try {
    const before = new AlertStore(sql); before.reserve('staging:lockdown_alert:', 100, facts, id, 5000); before.failure('staging:lockdown_alert:', id);
    let received;
    const delivery = new AlertDelivery({ env, store: new AlertStore(sql), now: () => 101, fetchImpl: async (_url, init) => { received = init; return new Response(null, { status: 202 }); } });
    assert.deepEqual(await delivery.send(event), { ok: true });
    assert.equal(received.headers['idempotency-key'], `case-alert:${id}`);
    assert.equal(received.body, JSON.stringify({ from: 'noreply@iatrogenic.app', to: [env.ALERT_EMAIL_TO], subject: 'Case staging: lockdown_alert', text: JSON.stringify(facts) }));
  } finally { db.close(); }
});

test('pending rendered alert survives a renderer/build change without changing its provider body', async () => {
  const { AlertDelivery } = await import('../src/worker/alerts.mjs');
  const { uuidv7 } = await import('../src/shared/ids.mjs');
  const { db, sql } = database(), id = uuidv7(), event = { kind: 'archive_lag_s', value: 50 };
  const facts = { event, env: 'staging', build: 'a'.repeat(40) };
  const message = { subject: 'Earlier approved subject', text: JSON.stringify(facts), html: '<p>Earlier approved layout</p>' };
  const env = { CASE_ENV: 'staging', BUILD_SHA: 'b'.repeat(40), ALERT_EMAIL_TO: 'operator@example.invalid', RESEND_ALERT_API_KEY: 'test-only' };
  try {
    const before = new AlertStore(sql); before.reserve('staging:archive_lag_s:', 100, { ...facts, message }, id, 5000); before.failure('staging:archive_lag_s:', id);
    let received;
    const delivery = new AlertDelivery({ env, store: new AlertStore(sql), now: () => 101, fetchImpl: async (_url, init) => { received = init; return new Response(null, { status: 202 }); } });
    assert.deepEqual(await delivery.send({ kind: 'archive_lag_s', value: 99 }), { ok: true });
    assert.equal(received.headers['idempotency-key'], `case-alert:${id}`);
    assert.equal(received.body, JSON.stringify({ from: 'noreply@iatrogenic.app', to: [env.ALERT_EMAIL_TO], ...message }));
  } finally { db.close(); }
});


test('new pending alert stores frozen content without storing recipient or credentials', async () => {
  const { AlertDelivery } = await import('../src/worker/alerts.mjs');
  const { db, sql } = database();
  const env = { CASE_ENV: 'staging', BUILD_SHA: 'a'.repeat(40), ALERT_EMAIL_TO: 'operator@example.invalid', RESEND_ALERT_API_KEY: 'private-test-only' };
  try {
    const delivery = new AlertDelivery({ env, store: new AlertStore(sql), now: () => 100, fetchImpl: async () => new Response(null, { status: 503 }) });
    assert.deepEqual(await delivery.send({ kind: 'lockdown_alert' }), { ok: false });
    const raw = sql.exec('SELECT pending_payload FROM alerts').toArray()[0].pending_payload, pending = JSON.parse(raw);
    assert.deepEqual(Object.keys(pending).sort(), ['build', 'env', 'event', 'message']);
    assert.deepEqual(Object.keys(pending.message).sort(), ['html', 'subject', 'text']);
    assert.deepEqual(JSON.parse(pending.message.text), { event: { kind: 'lockdown_alert' }, env: 'staging', build: 'a'.repeat(40) });
    assert.ok(pending.message.html.includes('lockdown_alert'));
    assert.ok(!raw.includes(env.ALERT_EMAIL_TO) && !raw.includes(env.RESEND_ALERT_API_KEY));
  } finally { db.close(); }
});
