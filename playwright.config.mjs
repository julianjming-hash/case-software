import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.PW_PORT || 4173); // PW_PORT: run beside another checkout's server

// The e2e suite drives the stage C room lab (tests/playwright-harness.mjs). Playwright starts the
// static prototype server itself, so CI and a local run behave the same; a server already listening
// on the port is reused locally (e.g. one started by hand with `node scripts/serve-prototypes.mjs`).
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.mjs',
  testIgnore: '**/device-recovery.spec.mjs',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0, // a flaky room test is a bug to fix, not to retry past
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    baseURL: process.env.PW_BASE_URL || `http://127.0.0.1:${PORT}`,
    // Large enough that every lab window is on screen at once: a fixed-position control inside a
    // framed window (the console's action dock) cannot be scrolled into view from outside.
    viewport: { width: 1800, height: 2600 },
    trace: 'retain-on-failure',
  },
  webServer: process.env.PW_BASE_URL ? undefined : {
    command: 'node scripts/serve-prototypes.mjs',
    env: { PORT: String(PORT) },
    url: `http://127.0.0.1:${PORT}/prototypes/room/index.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
