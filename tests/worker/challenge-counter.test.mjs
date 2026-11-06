import { env, runInDurableObject } from 'cloudflare:test';
import { it, expect } from 'vitest';
import { uuidv7 } from '../../src/shared/ids.mjs';
import { limitsFor } from '../../src/worker/directory-do.mjs';

it('Directory challenge strikes require three failures, reset and expire on exact server boundary', async () => {
  const prefix = uuidv7(), stub = limitsFor(env, prefix), now = Date.now();
  expect(await stub.challengeRequired(prefix, now)).toBe(false);
  for (let n = 1; n <= 3; n++) {
    await stub.failChallenge(prefix, now + n);
    expect(await stub.challengeRequired(prefix, now + n)).toBe(n === 3);
  }
  expect(await stub.challengeRequired(prefix, now + 600000)).toBe(true);
  expect(await stub.challengeRequired(prefix, now + 600001)).toBe(false);
  await stub.resetChallenge(prefix);
  expect(await stub.challengeRequired(prefix, now + 3)).toBe(false);
  await stub.failChallenge(prefix, now + 4);
  expect(await stub.challengeRequired(prefix, now + 4)).toBe(false);
});

it('Directory challenge storage saturates, arms TTL and removes expired prefix rows', async () => {
  const prefix = uuidv7(), stub = limitsFor(env, prefix), now = Date.now();
  for (let n = 0; n < 100; n++) await stub.failChallenge(prefix, now + n);
  const result = await runInDurableObject(stub, async (instance, state) => ({
    rows: instance.sql.exec('SELECT window_start,n,expires_at FROM challenges WHERE prefix = ?', prefix).toArray(),
    alarm: await state.storage.getAlarm(),
  }));
  expect(result.rows).toEqual([{ window_start: now, n: 3, expires_at: now + 600000 }]);
  expect(result.alarm).toBeLessThanOrEqual(now + 600000);
  await runInDurableObject(stub, async instance => {
    instance.sql.exec('UPDATE challenges SET expires_at = ? WHERE prefix = ?', Date.now() - 1, prefix);
    await instance.alarm();
  });
  const remaining = await runInDurableObject(stub, instance => instance.sql.exec('SELECT count(*) AS n FROM challenges WHERE prefix = ?', prefix).toArray()[0].n);
  expect(remaining).toBe(0);
});
