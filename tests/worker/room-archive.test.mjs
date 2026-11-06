import { SELF, env, runInDurableObject, runDurableObjectAlarm, evictDurableObject } from 'cloudflare:test';
import { it, expect } from 'vitest';
import fixture from '../../src/fixtures/synthetic-workshop.case.json';
import { signTestJwt } from '../../src/worker/auth.mjs';
import { uuidv7 } from '../../src/shared/ids.mjs';

import {nativeAccountFetch} from './admin-fixtures.mjs';
const nativeActors=new Set();
const api = (path, token, body) => nativeAccountFetch(`https://case.test/api/v1${path}`, {
  method: body ? 'POST' : 'GET', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
},[...nativeActors]);
async function create(associated = true) {
  const actor=uuidv7();nativeActors.add(actor);
  const jwt = await signTestJwt({ sub: actor, aud: 'authenticated', role: 'authenticated',
    exp: Math.floor(Date.now() / 1000) + 3600 }, 'test-only-secret-not-for-production');
  const response = await api('/sessions', jwt, { caseDocument: fixture });
  expect(response.status).toBe(201);
  const room = await response.json();
  room.stub = env.ROOM.get(env.ROOM.idFromName(room.sessionId));
  await runInDurableObject(room.stub, instance => {
    if (associated) instance.sql.exec("INSERT INTO meta(key,value) VALUES('archive_session_id',?)", instance.state.sessionId);
    instance.testArchive = { down: true, lost: false, requests: [], applied: new Map(), alerts: [] };
    instance.onArchiveAlert = alert => { instance.testArchive.alerts.push(alert); return new Promise(() => {}); };
    instance.archiveClient = { call: async (name, args) => {
      const fake = instance.testArchive;
      fake.requests.push({ name, args: structuredClone(args) });
      if (fake.stall) return new Promise(resolve => { fake.release = resolve; });
      if (fake.down) return { ok: false, kind: 'unavailable', status: 503 };
      if (name === 'archive_session_batch') {
        for (const [table, rows] of Object.entries(args.p_batch)) if (Array.isArray(rows))
          for (const row of rows) fake.applied.set(`${table}:${row.id ?? row.seq}`, structuredClone(row));
        if (fake.lost) { fake.lost = false; return { ok: false, kind: 'unavailable', status: 503, code: 'timeout' }; }
        return { ok: true, data: Math.max(0, ...args.p_batch.events.map(row => row.seq)) };
      }
      return { ok: true, data: null };
    } };
  });
  return room;
}
async function join(room) {
  const response = await api('/join', null, { v: 1, code: room.joinCode, displayName: 'Sam', avatarId: 'shadows-01' });
  expect(response.status).toBe(201);
  return response.json();
}
async function send(room, type, extra = {}, token = room.facilitatorToken) {
  const response = await api(`/sessions/${room.sessionId}/commands`, token,
    { v: 1, type, epoch: 0, clientEventId: uuidv7(), ...extra });
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.receipt.receipt, `${type}: ${result.receipt.reason ?? 'no reason'}`).toBe('accepted');
  return result;
}
const pending = room => runInDurableObject(room.stub, (instance, state) => ({
  count: ['participants', 'rounds', 'responses', 'journal'].reduce((n, table) =>
    n + state.storage.sql.exec(`SELECT count(*) AS n FROM ${table} WHERE archived=0`).toArray()[0].n, 0),
  eligible: (instance.state.endedAt ? ['participants', 'rounds', 'responses', 'journal'] : ['rounds', 'journal']).reduce((n, table) => n + state.storage.sql.exec(`SELECT count(*) AS n FROM ${table} WHERE archived=0`).toArray()[0].n, 0),
  attempts: instance.testArchive.requests.length,
}));
async function recover(room) {
  await runInDurableObject(room.stub, instance => { instance.testArchive.down = false; });
  for (let i = 0; i < 8; i++) {
    await runInDurableObject(room.stub, instance => instance.flushArchive());
    if (!(await pending(room)).eligible) break;
  }
}

it('[AS-029] a complete room survives archive outage and recovery drains replay-safe rows then ends the SQL session', async () => {
  const room = await create(), participants = [];
  for (let i = 0; i < 50; i++) participants.push(await join(room));
  await send(room, 'start');
  let finished = false;
  // Each authored beat can now need up to four text reveals plus its existing room actions.
  for (let i = 0; i < fixture.beats.length * 8; i++) {
    // Walk the full case at the real facilitator command rate (2/s), not a synthetic burst
    // that would correctly trip the production per-credential limiter after 20 actions.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const snapshot = await (await api(`/sessions/${room.sessionId}/snapshot`, room.facilitatorToken)).json();
    const mirror = snapshot.mirror;
    if (['surface_live', 'consequence_revealed'].includes(mirror.phase)) {
      if (!mirror.nextBeatId && !mirror.decisionId) { finished = true; break; }
      await send(room, 'advance', { expectRevision: snapshot.revision });
    } else if (mirror.phase === 'responses_open') {
      const decision = fixture.decisions.find(item => item.id === mirror.decisionId);
      await Promise.all(participants.map(participant => send(room, 'vote', {
        roundId: mirror.round.id, response: { option_id: decision.interaction.options[0].id },
      }, participant.token)));
      await send(room, 'lock');
      const path = decision.paths.find(item => item.classification !== 'terminal-unsafe' &&
        (item.requires_flags ?? []).every(flag => mirror.flags.includes(flag)));
      await send(room, 'select_path', { pathId: path.id });
      await send(room, 'show_results', { on: false });
      await send(room, 'reveal');
    }
  }
  expect(finished).toBe(true);
  await send(room, 'end');
  expect((await pending(room)).count).toBeGreaterThan(0);
  await recover(room);
  expect((await pending(room)).count).toBe(0);
  const measured = await runInDurableObject(room.stub, instance => {
    const requests = instance.testArchive.requests.filter(request => request.name === 'archive_session_batch');
    expect(requests.every(request => request.args.p_batch.status !== 'ended')).toBe(true);
    const firstBeat = instance.sql.exec("SELECT occurred_at FROM journal WHERE kind='beat_entered' ORDER BY seq LIMIT 1").toArray()[0].occurred_at;
    expect(requests.at(-1).args.p_batch.started_at).toBe(firstBeat);
    expect(instance.sql.exec("SELECT value FROM meta WHERE key='archive_started_at'").toArray()[0].value).toBe(firstBeat);
    expect([...instance.testArchive.applied.keys()].some(key => key.startsWith('responses:'))).toBe(true);
    let expectedRows = 0;
    for (const table of ['participants', 'rounds', 'responses', 'journal']) {
      const rows = instance.sql.exec(`SELECT * FROM ${table}`).toArray();
      expectedRows += rows.length;
      for (const row of rows) expect(instance.testArchive.applied.has(`${table === 'journal' ? 'events' : table}:${row.id ?? row.seq}`)).toBe(true);
    }
    expect(instance.testArchive.applied.size).toBe(expectedRows);
    expect(instance.sql.exec('SELECT count(*) AS n FROM participants').toArray()[0].n).toBe(50);
    expect(instance.sql.exec('SELECT count(*) AS n FROM rounds').toArray()[0].n).toBe(3);
    expect(instance.sql.exec('SELECT count(*) AS n FROM responses').toArray()[0].n).toBe(150);
    const successfulBatches = requests.filter(request => request.args.p_batch.participants.length || request.args.p_batch.rounds.length || request.args.p_batch.responses.length || request.args.p_batch.events.length);
    expect(instance.testArchive.requests.filter(request => request.name === 'end_session')).toHaveLength(1);
    return { rows: expectedRows,
      attemptBytes: successfulBatches.map(request => new TextEncoder().encode(JSON.stringify(request.args)).length) };
  });
  console.log('Card06 MVC50', JSON.stringify(measured));
}, 30_000);

it('archive work with an unresolved RPC never blocks an accepted room command', async () => {
  const room = await create();
  await join(room);
  await runInDurableObject(room.stub, instance => { instance.testArchive.stall = true; });
  let watchdog;
  try {
    await Promise.race([send(room, 'start'), new Promise((_, reject) => {
      watchdog = setTimeout(() => reject(new Error('archive blocked room command')), 1000);
    })]);
  } finally {
    clearTimeout(watchdog);
    await runInDurableObject(room.stub, instance => {
      instance.testArchive.stall = false;
      instance.testArchive.release?.({ ok: false, kind: 'unavailable', status: 503 });
    });
  }
});

it('a 300-participant outage retains all participant rows outside the reducer state budget', async () => {
  const room = await create();
  for (let i = 0; i < 300; i += 30) await Promise.all(Array.from({ length: 30 }, () => join(room)));
  const measured = await runInDurableObject(room.stub, instance => {
    const count = instance.sql.exec('SELECT count(*) AS n FROM participants').toArray()[0].n;
    const journal = instance.sql.exec('SELECT count(*) AS n FROM journal').toArray()[0].n;
    expect(count).toBe(300);
    expect(journal).toBe(300);
    let bytes = 0;
    for (const table of ['participants', 'rounds', 'responses', 'journal'])
      bytes += new TextEncoder().encode(JSON.stringify(instance.sql.exec(`SELECT * FROM ${table}`).toArray())).length;
    return { participants: count, journal, jsonBytes: bytes };
  });
  console.log('Card06 lobby300', JSON.stringify(measured));
}, 30_000);

it('a lost archive acknowledgement is resent and row identity stays unchanged', async () => {
  const room = await create();
  await join(room);
  await runInDurableObject(room.stub, async instance => {
    instance.testArchive.down = false;
    instance.testArchive.lost = true;
    await instance.flushArchive();
  });
  expect((await pending(room)).count).toBeGreaterThan(0);
  await recover(room);
  await runInDurableObject(room.stub, instance => {
    const sent = instance.testArchive.requests.filter(request => request.name === 'archive_session_batch');
    expect(sent).toHaveLength(2);
    expect(sent[0].args).toEqual(sent[1].args);
    expect(instance.testArchive.applied.size).toBe(1); // Live delivery: text-free joined event only.
    expect(instance.sql.exec('SELECT count(*) AS n FROM participants WHERE archived=0').toArray()[0].n).toBe(1);
  });
});

it('a live participant rename keeps the latest deferred name for archive after end acknowledgement', async () => {
  const room = await create(), participant = await join(room);
  await recover(room);
  await send(room, 'rename', { displayName: 'Alex' }, participant.token);
  expect((await pending(room)).count).toBeGreaterThan(0);
  await send(room, 'end');
  await recover(room);
  await runInDurableObject(room.stub, instance => {
    expect(instance.testArchive.applied.get(`participants:${participant.participantId}`).display_name).toBe('Alex');
  });
});

it('retention deletion never waits for archive or alert delivery and its alert contains counts only', async () => {
  const room = await create();
  await join(room);
  await send(room, 'end');
  await runInDurableObject(room.stub, (_instance, state) => {
    state.storage.sql.exec("UPDATE meta SET value='1' WHERE key='recap_delete_at'");
    state.storage.setAlarm(Date.now() + 60_000);
  });
  expect(await runDurableObjectAlarm(room.stub)).toBe(true);
  await runInDurableObject(room.stub, (instance, state) => {
    expect(state.storage.sql.exec("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='meta'").toArray()[0].n).toBe(0);
    expect(instance.testArchive.alerts).toHaveLength(1);
    expect(instance.testArchive.alerts[0]).toEqual({ kind: 'archive_deleted_unsent',
      counts: { participants: 1, rounds: 0, responses: 0, journal: 2, endSession: 1 } });
  });
});

it('archive backoff shares the alarm slot without losing expiry or recap deletion', async () => {
  const room = await create();
  await join(room);
  await runInDurableObject(room.stub, async (instance, state) => {
    state.storage.sql.exec("UPDATE meta SET value=? WHERE key='expires_at'", String(Date.now() + 100));
    await instance.flushArchive();
    expect(await state.storage.getAlarm()).toBeLessThanOrEqual(Date.now() + 100);
    state.storage.sql.exec("UPDATE meta SET value=? WHERE key='expires_at'", String(Date.now() - 1000));
    await state.storage.setAlarm(Date.now() + 60_000);
  });
  expect(await runDurableObjectAlarm(room.stub)).toBe(true);
  await runInDurableObject(room.stub, async (instance, state) => {
    expect(instance.state.phase).toBe('ended');
    const deletion = Number(state.storage.sql.exec("SELECT value FROM meta WHERE key='recap_delete_at'").toArray()[0].value);
    const alarm = await state.storage.getAlarm();
    expect(alarm).toBeLessThan(deletion);
    expect(alarm).toBeGreaterThan(Date.now());
  });
});

it('a stalled pre-deletion archive alarm returns and deletion runs while that RPC remains unresolved', async () => {
  const room = await create();
  await join(room);
  await send(room, 'end');
  const boundary = await runInDurableObject(room.stub, async (instance, state) => {
    await instance.flushArchive();
    instance.testArchive.stall = true;
    const deletion = Date.now() + 2000;
    state.storage.sql.exec("UPDATE meta SET value=? WHERE key='recap_delete_at'", String(deletion));
    state.storage.sql.exec("UPDATE meta SET value=? WHERE key='archive_next_at'", String(Date.now() - 1));
    state.storage.setAlarm(Date.now() + 60_000);
    return deletion;
  });
  let watchdog;
  const boundedAlarm = () => Promise.race([runDurableObjectAlarm(room.stub), new Promise((_, reject) => {
    watchdog = setTimeout(() => reject(new Error('retention handler waited for archive')), 300);
  })]).finally(() => clearTimeout(watchdog));
  try {
    expect(await boundedAlarm()).toBe(true);
    await runInDurableObject(room.stub, async (instance, state) => {
      expect(instance.testArchive.release).toBeTypeOf('function');
      expect(await state.storage.getAlarm()).toBe(boundary); // No past-due retry spin.
      state.storage.sql.exec("UPDATE meta SET value=? WHERE key='recap_delete_at'", String(Date.now() - 1));
      state.storage.setAlarm(Date.now() + 60_000);
    });
    expect(await boundedAlarm()).toBe(true);
    await runInDurableObject(room.stub, (instance, state) => {
      expect(instance.state).toBeNull();
      expect(state.storage.sql.exec("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='meta'").toArray()[0].n).toBe(0);
    });
  } finally {
    await runInDurableObject(room.stub, instance => {
      instance.testArchive.stall = false;
      instance.testArchive.release?.({ ok: true, data: 0 });
    });
  }
});

it('configured inline rooms without a persisted SQL-session association never deliver archive RPCs', async () => {
  const room = await create(false);
  await join(room);
  await send(room, 'start');
  await runInDurableObject(room.stub, async instance => {
    await instance.flushArchive();
    expect(instance.testArchive.requests).toHaveLength(0);
    instance.sql.exec('UPDATE journal SET pending_at=?', Date.now() - 1000);
    expect(instance.archiveLag()).toBe(0);
  });
});

it('a pending archive watchdog survives a durable checkpoint restored after graceful eviction', async () => {
  const room = await create();
  await join(room);
  await runInDurableObject(room.stub, instance => { instance.testArchive.stall = true; });
  await send(room, 'start');
  let release, watchdog, evicted = false;
  try {
    const due = await runInDurableObject(room.stub, async (instance, state) => {
      release = instance.testArchive.release;
      const retry = Number(state.storage.sql.exec("SELECT value FROM meta WHERE key='archive_next_at'").toArray()[0].value);
      expect(retry).toBeGreaterThan(Date.now() + 5000);
      expect(retry).toBeLessThanOrEqual(Date.now() + 10_000);
      expect(await state.storage.getAlarm()).toBe(retry);
      return retry;
    });
    // The test eviction API waits for waitUntil. Dispose the fake, then restore the
    // checkpoint recorded while it was pending; this models storage after a crash,
    // and does not claim native abrupt-crash coverage.
    await runInDurableObject(room.stub, async (instance, state) => {
      instance.testArchive.stall = false;
      release({ ok: false, kind: 'unavailable', status: 503 });
      await instance.archiveTask;
      state.storage.sql.exec("UPDATE meta SET value=? WHERE key='archive_next_at'", String(due));
      await state.storage.setAlarm(due);
    });
    await Promise.race([evictDurableObject(room.stub), new Promise((_, reject) => {
      watchdog = setTimeout(() => reject(new Error('eviction exceeded test watchdog')), 1000);
    })]);
    clearTimeout(watchdog);
    evicted = true;
    await runInDurableObject(room.stub, async (instance, state) => {
      expect(instance.archiveTask).toBeUndefined();
      expect(await state.storage.getAlarm()).toBe(due);
      expect(state.storage.sql.exec("SELECT value FROM meta WHERE key='archive_session_id'").toArray()[0].value).toBe(room.sessionId);
      instance.archiveClient = { call: async () => ({ ok: true, data: 0 }) };
      state.storage.sql.exec("UPDATE meta SET value='1' WHERE key='archive_next_at'");
      state.storage.setAlarm(Date.now() + 60_000);
    });
    expect(await runDurableObjectAlarm(room.stub)).toBe(true);
    await runInDurableObject(room.stub, async (instance, state) => {
      await instance.flushArchive();
      expect(state.storage.sql.exec('SELECT count(*) AS n FROM journal WHERE archived=0').toArray()[0].n).toBe(0);
      expect(state.storage.sql.exec('SELECT count(*) AS n FROM participants WHERE archived=0').toArray()[0].n).toBe(1); // Intentional live personal deferral.
    });
  } finally {
    clearTimeout(watchdog);
    if (!evicted) await runInDurableObject(room.stub, () => release?.({ ok: false, kind: 'unavailable', status: 503 }));
  }
});

it('actual server end metadata precedes personal rows and lost metadata ACK marks no outbox rows', async () => {
  const room = await create();
  await join(room);
  const before = Date.now();
  await send(room, 'end');
  await runInDurableObject(room.stub, async instance => {
    await instance.flushArchive(); // Dispose the automatic failed attempt before inspecting retries.
    const ended = Number(instance.sql.exec("SELECT value FROM meta WHERE key='archive_ended_at'").toArray()[0]?.value);
    const deletion = Number(instance.sql.exec("SELECT value FROM meta WHERE key='archive_personal_delete_at'").toArray()[0]?.value);
    const recap = Number(instance.sql.exec("SELECT value FROM meta WHERE key='recap_delete_at'").toArray()[0].value);
    expect(ended).toBeGreaterThanOrEqual(before);
    expect(ended).toBeLessThanOrEqual(Date.now());
    expect(deletion).toBe(recap);
    expect(recap - ended).toBe(86_400_000);
    // Reducer timestamps are not the archive retention authority.
    instance.state.endedAt = '2000-01-01T00:00:00.000Z';
    const counts = () => instance.sql.exec('SELECT count(*) AS n FROM participants WHERE archived=0').toArray()[0].n;
    const pendingBefore = counts();
    instance.testArchive.requests = []; instance.testArchive.down = false; instance.testArchive.lost = true;
    await instance.flushArchive();
    const first = instance.testArchive.requests[0];
    expect(first.name).toBe('archive_session_batch');
    expect(first.args.p_batch.ended_at).toBe(new Date(ended).toISOString());
    expect(first.args.p_batch.personal_data_delete_at).toBe(new Date(deletion).toISOString());
    for (const key of ['participants', 'rounds', 'responses', 'events']) expect(first.args.p_batch[key]).toEqual([]);
    expect(counts()).toBe(pendingBefore);
    expect(instance.sql.exec("SELECT value FROM meta WHERE key='archive_boundary_sent'").toArray()).toEqual([]);
    await instance.flushArchive();
    expect(instance.testArchive.requests[1].args).toEqual(first.args);
    expect(counts()).toBe(pendingBefore);
    expect(instance.sql.exec("SELECT value FROM meta WHERE key='archive_boundary_sent'").toArray()[0].value).toBe('1');
    await instance.flushArchive();
    const data = instance.testArchive.requests[2];
    expect(data.args.p_batch.participants.length).toBeGreaterThan(0);
    expect(data.args.p_batch.ended_at).toBe(first.args.p_batch.ended_at);
    expect(data.args.p_batch.personal_data_delete_at).toBe(first.args.p_batch.personal_data_delete_at);
    expect(instance.testArchive.requests.at(-1).name).toBe('end_session');
  });
});

it('end boundary and its ACK survive eviction with the earlier expiry cutoff', async () => {
  const room = await create();
  await join(room);
  const expiry = Date.now() - 1000;
  await runInDurableObject(room.stub, instance => instance.sql.exec("UPDATE meta SET value=? WHERE key='expires_at'", String(expiry)));
  await send(room, 'end');
  const boundary = await runInDurableObject(room.stub, async instance => {
    await instance.flushArchive();
    const ended = Number(instance.sql.exec("SELECT value FROM meta WHERE key='archive_ended_at'").toArray()[0]?.value);
    const cutoff = Number(instance.sql.exec("SELECT value FROM meta WHERE key='archive_personal_delete_at'").toArray()[0]?.value);
    expect(Number.isFinite(ended)).toBe(true); expect(cutoff).toBe(expiry + 86_400_000);
    instance.testArchive.down = false;
    await instance.flushArchive();
    return { ended, cutoff };
  });
  await evictDurableObject(room.stub);
  await runInDurableObject(room.stub, async instance => {
    expect(Number(instance.sql.exec("SELECT value FROM meta WHERE key='archive_ended_at'").toArray()[0].value)).toBe(boundary.ended);
    expect(Number(instance.sql.exec("SELECT value FROM meta WHERE key='archive_personal_delete_at'").toArray()[0].value)).toBe(boundary.cutoff);
    const requests = [];
    instance.archiveClient = { call: async (name, args) => { requests.push({ name, args }); return { ok: true, data: name === 'archive_session_batch' ? 0 : null }; } };
    await instance.flushArchive();
    expect(requests[0].args.p_batch.participants.length).toBeGreaterThan(0); // Persisted ACK suppresses duplicate metadata-only attempt.
    expect(requests[0].args.p_batch.ended_at).toBe(new Date(boundary.ended).toISOString());
    expect(requests[0].args.p_batch.personal_data_delete_at).toBe(new Date(boundary.cutoff).toISOString());
  });
});

it('live delivery excludes personal rows and a deferred-only outbox has no retry or delivery lag', async () => {
  const room = await create();
  await join(room);
  await runInDurableObject(room.stub, async instance => {
    instance.testArchive.down = false;
    await instance.flushArchive();
    const sent = instance.testArchive.requests.at(-1).args.p_batch;
    expect(sent.participants).toEqual([]); expect(sent.responses).toEqual([]);
    expect(sent.events.length).toBeGreaterThan(0);
    expect(instance.sql.exec('SELECT count(*) AS n FROM participants WHERE archived=0').toArray()[0].n).toBe(1);
    instance.sql.exec('UPDATE participants SET pending_at=?', Date.now() - 3_600_000);
    expect(instance.archiveLag()).toBe(0);
    expect(instance.sql.exec("SELECT value FROM meta WHERE key='archive_next_at'").toArray()[0].value).toBe('0');
    const count = instance.testArchive.requests.length;
    await instance.flushArchive();
    expect(instance.testArchive.requests.length).toBe(count);
  });
});

it('personal archive lag starts at actual end and deletion still reports every deferred row', async () => {
  const room = await create();
  await join(room);
  await runInDurableObject(room.stub, async instance => {
    instance.testArchive.down = false; await instance.flushArchive();
    instance.sql.exec('UPDATE participants SET pending_at=?', Date.now() - 3_600_000);
    instance.testArchive.down = true;
  });
  await send(room, 'end');
  await new Promise(resolve => setTimeout(resolve, 30));
  await runInDurableObject(room.stub, async instance => {
    await instance.flushArchive();
    expect(instance.archiveLag()).toBeGreaterThan(0);
    expect(instance.archiveLag()).toBeLessThan(1);
    instance.sql.exec("UPDATE meta SET value=? WHERE key='recap_delete_at'", String(Date.now() - 1));
  });
  expect(await runDurableObjectAlarm(room.stub)).toBe(true);
  await runInDurableObject(room.stub, instance => {
    const alert = instance.testArchive.alerts.at(-1);
    expect(alert.counts.participants).toBe(1);
    expect(alert.counts.endSession).toBe(1);
    expect(Object.keys(alert)).toEqual(['kind', 'counts']);
  });
});

it('a real live round edit remains unsent when an older in-flight batch is acknowledged', async () => {
  const room = await create();
  await join(room); await send(room, 'start');
  const expectedContext = [[2, 2], [1, 3], [2, 3], [3, 3]];
  for (const [shown, total] of expectedContext) {
    const before = await (await api(`/sessions/${room.sessionId}/snapshot`, room.facilitatorToken)).json();
    await send(room, 'advance', { expectRevision: before.revision });
    const after = await (await api(`/sessions/${room.sessionId}/snapshot`, room.facilitatorToken)).json();
    expect(after.view.presentation).toMatchObject({ shown, total });
    expect(after.view.phase).toBe('surface_live');
  }
  const prepared = await (await api(`/sessions/${room.sessionId}/snapshot`, room.facilitatorToken)).json();
  await send(room, 'advance', { expectRevision: prepared.revision });
  await runInDurableObject(room.stub, async instance => {
    await instance.flushArchive();
    expect(instance.state.phase).toBe('responses_open');
    instance.testArchive.stall = true;
    instance.ctx.waitUntil(instance.flushArchive());
    expect(instance.testArchive.requests.at(-1).args.p_batch.rounds[0].status).toBe('open');
  });
  try {
    await send(room, 'lock');
    await runInDurableObject(room.stub, async instance => {
      instance.testArchive.stall = false; instance.testArchive.down = false;
      instance.testArchive.release({ ok: true, data: 0 });
      await instance.archiveTask;
      const row = instance.sql.exec('SELECT status,archived FROM rounds').toArray()[0];
      expect(row.status).toBe('locked'); expect(row.archived).toBe(0);
      await instance.flushArchive();
      expect(instance.testArchive.requests.at(-1).args.p_batch.rounds[0].status).toBe('locked');
      expect(instance.sql.exec('SELECT archived FROM rounds').toArray()[0].archived).toBe(1);
    });
  } finally {
    await runInDurableObject(room.stub, instance => {
      instance.testArchive.stall = false;
      instance.testArchive.release?.({ ok: false, kind: 'unavailable', status: 503 });
    });
  }
});

it('end during an older live send re-arms metadata delivery before SQL finalization', async () => {
  const room = await create();
  await join(room);
  await runInDurableObject(room.stub, instance => {
    instance.testArchive.stall = true;
    instance.ctx.waitUntil(instance.flushArchive());
  });
  try {
    await send(room, 'end');
    await runInDurableObject(room.stub, async instance => {
      instance.testArchive.stall = false; instance.testArchive.down = false;
      instance.testArchive.release({ ok: true, data: 0 });
      await instance.archiveTask;
      expect(instance.testArchive.requests.some(request => request.name === 'end_session')).toBe(false);
      expect(Number(instance.sql.exec("SELECT value FROM meta WHERE key='archive_next_at'").toArray()[0].value)).toBeGreaterThan(Date.now());
      await instance.flushArchive();
      const metadata = instance.testArchive.requests.at(-1);
      expect(metadata.name).toBe('archive_session_batch');
      expect(metadata.args.p_batch.ended_at).toBeTypeOf('string');
      expect(metadata.args.p_batch.participants).toEqual([]);
      await instance.flushArchive();
      expect(instance.testArchive.requests.at(-1).name).toBe('end_session');
    });
  } finally {
    await runInDurableObject(room.stub, instance => {
      instance.testArchive.stall = false;
      instance.testArchive.release?.({ ok: false, kind: 'unavailable', status: 503 });
    });
  }
});

it('[AS-181] Debrief marks the session row and Back to the case clears it; an outage retries the mark until it is sent', async () => {
  const room = await create();
  await send(room, 'start');
  const marks = () => runInDurableObject(room.stub, instance => instance.testArchive.requests.filter(r => r.name === 'set_session_debrief').map(r => r.args));
  await send(room, 'debrief');
  // Down: the mark is attempted (the command's own flush, then ours) and not recorded as sent, so each flush retries it.
  await runInDurableObject(room.stub, instance => instance.flushArchive());
  const tried = (await marks()).length;
  expect(tried).toBeGreaterThan(0);
  expect(await marks()).toEqual(Array(tried).fill({ p_session_id: room.sessionId, p_on: true }));
  await runInDurableObject(room.stub, instance => { instance.testArchive.down = false; });
  await runInDurableObject(room.stub, instance => instance.flushArchive());
  expect((await marks()).length).toBe(tried + 1);
  await runInDurableObject(room.stub, instance => instance.flushArchive());
  expect((await marks()).length, 'sent once it succeeded').toBe(tried + 1);
  await send(room, 'back_to_case');
  await runInDurableObject(room.stub, instance => instance.flushArchive());
  expect((await marks()).at(-1)).toEqual({ p_session_id: room.sessionId, p_on: false });
});
