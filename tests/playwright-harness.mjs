// tests/playwright-harness.mjs: Playwright fixtures that drive the stage C room lab
// (`prototypes/room/index.html`); e2e/room-real.spec.mjs separately exercises the Phase 1 runtime.
//
// The lab page IS the room server: it runs the simulated Durable Object (`lib/sim-do.mjs`) over the
// real `room-machine.mjs` and `wire.mjs`, frames the facilitator console, the same-PC projector and
// three phones, and exposes `window.caseLab = { room, clients, log }`. Every helper here acts through
// a window's real UI (buttons, inputs) and reads the server's state only to assert, never to steer,
// except for the two faults the lab's fault panel offers (a window's link, eviction).
//
// Deterministic by construction: helpers wait on observable state (`expect.poll`, locators), never on
// fixed timeouts.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test as base, expect } from '@playwright/test';

const AXE_SOURCE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

export const LAB_PATH = '/prototypes/room/index.html';
export const WINDOWS = Object.freeze({
  facilitator: { url: /\/facilitator\.html$/, label: 'Facilitator' },
  facilitator2: { url: /\/facilitator\.html\?tab=2$/, label: 'Facilitator tab 2' },
  display: { url: /\/display\.html\?topology=same-pc/, label: 'Projector (same PC)' },
  A: { url: /\/phone\.html\?slot=A/, label: 'Phone A' },
  B: { url: /\/phone\.html\?slot=B/, label: 'Phone B' },
  C: { url: /\/phone\.html\?slot=C/, label: 'Phone C' },
});

/** The server's reducer state without the case document (assertions only). */
export function serverState(page) {
  return page.evaluate(() => {
    const s = window.caseLab.room.state;
    if (!s) return null;
    const { caseDoc, ...rest } = s;
    return structuredClone(rest);
  });
}

/** Wait until the server state satisfies `predicate` (evaluated in Node on a structured clone). */
export async function untilServer(page, predicate, message = 'server state') {
  await expect.poll(async () => { const s = await serverState(page); return Boolean(s && predicate(s)); }, { message, timeout: 15_000 }).toBe(true);
  return serverState(page);
}

function frameOf(page, key) {
  const f = page.frame({ url: WINDOWS[key].url });
  if (!f) throw new Error(`lab window ${key} is not framed`);
  return f;
}

export async function openLab(page, { caseKey = 'mvc' } = {}) {
  await page.goto(`${LAB_PATH}${caseKey === 'demo' ? '?case=demo' : ''}`);
  await expect.poll(() => page.evaluate(() => Boolean(window.caseLab?.room?.state)), { message: 'lab server running' }).toBe(true);
  // Server initialization can precede iframe navigation commit; getters require both role frames.
  await expect.poll(() => Boolean(page.frame({ url: WINDOWS.facilitator.url }) && page.frame({ url: WINDOWS.display.url })),
    { message: 'mandatory facilitator and projector frames loaded', timeout: 10_000 }).toBe(true);
  const lab = {
    page,
    get facilitator() { return frameOf(page, 'facilitator'); },
    get display() { return frameOf(page, 'display'); },
    phone(slot) { return frameOf(page, slot); },
    state: () => serverState(page),
    until: (predicate, message) => untilServer(page, predicate, message),
    /** Lab fault panel: set one window's link to up | down | flaky. */
    async setLink(key, mode) {
      const label = WINDOWS[key].label;
      const n = await page.evaluate(({ label, mode }) => {
        let hits = 0;
        for (const c of window.caseLab.clients.values()) if (c.label === label) { c.mode = mode; hits += 1; }
        return hits;
      }, { label, mode });
      if (n !== 1) throw new Error(`expected one lab client labelled ${label}, found ${n}`);
    },
    /** Lab fault panel: evict the simulated Durable Object; resolves once it has rebuilt. */
    evict: (ms = 300) => page.evaluate((ms) => window.caseLab.room.evict(ms), ms),
    /** Facilitator console: press a button by its accessible name. */
    async press(name, { exact = true } = {}) {
      const button = lab.facilitator.getByRole('button', { name, exact });
      await expect(button).toBeEnabled();
      await button.click();
    },
  };
  // The console and projector are connected once the simulated DO has welcomed them.
  await expect(lab.facilitator.getByRole('heading', { level: 1, name: 'Lobby' })).toBeVisible();
  await expect(lab.display.getByRole('heading', { level: 2, name: 'Join on your phone' })).toBeVisible();
  return lab;
}

/**
 * Join a phone through its own UI with the code the projector shows: a name (required, CASE-119; a
 * default per slot when the test does not care) and an avatar (by its spoken label, default the first).
 */
export async function joinPhone(lab, slot, name = `Guest ${slot}`, avatar = 'Wine, curls') {
  const code = (await lab.state()).joinCode;
  const phone = lab.phone(slot);
  await phone.getByLabel('Room code').fill(code);
  await phone.getByLabel('Your name').fill(name);
  await phone.getByRole('radio', { name: avatar, exact: true }).check();
  await phone.getByRole('button', { name: 'Join case', exact: true }).click();
  await expect(phone.getByRole('heading', { level: 1, name: 'Waiting to start' })).toBeVisible();
}

/** The console's Room tab (CASE-118): people, displays, names, settings, manual mode, the end. */
export async function roomTab(frame) {
  await frame.getByRole('tab', { name: 'Room' }).click();
  return frame.locator('#panel-room');
}
export async function runTab(frame) {
  await frame.getByRole('tab', { name: 'Run' }).click();
  return frame.locator('#panel-run');
}

/** The display check and Start case, through the console. */
export async function startCase(lab) {
  await lab.press('Projector is showing, console is not visible');
  await lab.press('Start case');
  await lab.until((s) => s.phase === 'surface_live', 'case started');
}

/** Answer the open decision on a phone by option label, and wait for the saved receipt. */
export async function vote(lab, slot, optionLabel) {
  const phone = lab.phone(slot);
  await phone.getByRole('radio', { name: optionLabel }).check();
  await phone.getByRole('button', { name: /^(Send|Change) answer$/ }).click();
  await expect(phone.getByText('Answer saved · you can change it until responses lock')).toBeVisible();
}

/** Choose a route on the console (radio) and confirm it with the primary action. */
export async function selectRoute(lab, routeLabel) {
  await lab.facilitator.getByRole('radio', { name: routeLabel }).check();
  await lab.press('Select this route');
  await expect(lab.facilitator.getByRole('heading', { level: 1, name: 'Route chosen · not yet shown to the room' })).toBeVisible();
}

/** Reveal is a two-press control (the first press arms it for 3 s). */
export async function reveal(lab) {
  const primary = lab.facilitator.locator('[data-k="primary"]');
  await expect(primary).toHaveText(/^Reveal: /);
  await primary.click();
  await expect(primary).toHaveText('Show to room?');
  await primary.click();
}

/** Run axe inside one lab window (its own document, not the lab scaffolding). */
export async function axeViolations(frame) {
  if (!(await frame.evaluate(() => Boolean(window.axe)))) await frame.addScriptTag({ content: AXE_SOURCE });
  const result = await frame.evaluate(() => window.axe.run(document, { resultTypes: ['violations'] }));
  return result.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map((n) => n.target.join(' ')).slice(0, 5) }));
}

export const test = base.extend({
  lab: async ({ page }, use) => { await use(await openLab(page)); },
});
export { expect };
