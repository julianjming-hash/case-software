// Card 29 re-check: a surface chunk that fails to load (stale chunk after a deploy, network error) still
// leaves a text notice and still starts the shell, so the service worker and update prompt keep working.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boot } from '../src/client/app-boot.mjs';

test('[AS-102] a rejected surface import shows a text notice and still starts the shell', async () => {
  const calls = [];
  await boot({ route: async () => { calls.push('route'); throw new TypeError('Failed to fetch dynamically imported module'); },
    notice: () => calls.push('notice'), startShell: () => calls.push('shell') });
  assert.deepEqual(calls, ['route', 'shell', 'notice']);
  const ok = [];
  await boot({ route: async () => ok.push('route'), notice: () => ok.push('notice'), startShell: () => ok.push('shell') });
  assert.deepEqual(ok, ['route', 'shell']);
});
