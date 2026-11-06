// Responsive participant states against the real local Worker, never deployed origins.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { settled } from '../tests/helpers/settled.mjs';
import { startLocalWorker, createRoom, facilitatorCommand, serverMirror, FIXTURE } from '../tests/helpers/local-worker.mjs';
import { joinUrl } from '../src/shared/urls.mjs';

let worker;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => { worker = await startLocalWorker(); });
test.afterAll(async () => { await worker?.stop(); });
test.use({ viewport: { width: 1366, height: 900 } });
async function command(room, type, payload) {
  expect((await facilitatorCommand(worker.origin, room, type, payload))?.receipt).toBe('accepted');
}
async function open(page, type = 'single_choice') {
  const doc = structuredClone(FIXTURE), d = doc.decisions[0], options = d.interaction.options;
  if (type !== 'single_choice') {
    d.interaction.type = type;
    for (const path of d.paths) delete path.option_ids;
    d.rules = [{ when: type === 'multi_select' ? { includes_all: [options[0].id] } : type === 'ranking' ? { top: [options[0].id] } : { keywords: ['simulation'] }, path_id: d.fallback_path_id }];
    if (type === 'ranking') d.interaction.rank_count = 2;
    if (type === 'free_text') d.interaction = { type, max_length: 280 };
  }
  d.prompt = 'A'.repeat(200);
  if (type !== 'free_text') for (const option of options) option.label = '長'.repeat(120);
  const room = await createRoom(worker.origin, { caseDocument: doc });
  await page.goto(joinUrl(room.joinCode, worker.origin));
  await page.getByLabel('Your name', { exact: true }).fill('Sam');
  await page.getByRole('button', { name: 'Join case', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Waiting to start' })).toBeVisible();
  await command(room, 'start');
  for (let i = 0; i < 5; i++) await command(room, 'advance');
  await expect(page.locator('.decision')).toBeVisible();
  return { room, d };
}
async function geometry(page, wide) {
  // Await the responsive DOM contract before measuring the next layout; a nonzero old box is not settled.
  await expect(page.locator('#main > section.stack details')).toHaveCount(wide ? 0 : 1);
  await expect.poll(() => page.locator('#main > section.stack').evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThan(0);
  const [info, answer] = await Promise.all([page.locator('#main > section.stack').boundingBox(), page.locator('.decision').boundingBox()]);
  if (wide) {
    expect(await page.locator('#main').evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThan(760);
    expect(info.x + info.width).toBeLessThanOrEqual(answer.x);
    expect(Math.abs(info.y - answer.y)).toBeLessThan(1);
    await expect(page.locator('#main > section.stack details')).toHaveCount(0);
    await expect(page.locator('#main > section.stack .scene')).toBeVisible();
  } else {
    expect(info.y + info.height).toBeLessThanOrEqual(answer.y);
    await expect(page.locator('#main > section.stack details')).toBeVisible();
  }
  const overflow = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, nodes: [...document.querySelectorAll('main *')].filter(el => el.getBoundingClientRect().right > innerWidth + 1).slice(0, 8).map(el => ({ tag:el.tagName, cls:el.className, right:el.getBoundingClientRect().right })) }));
  expect(overflow.scroll, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.width);
}
for (const type of ['single_choice', 'multi_select', 'ranking', 'free_text']) test(`desktop ${type} keeps full context beside private answers and preserves controls through resize`, async ({ page }, testInfo) => {
  const { d } = await open(page, type);
  const controls = page.locator('.decision input, .decision textarea, .decision .rank-move:not(:disabled)');
  if (type === 'ranking') {
    await page.getByRole('button', { name: `Add to ranking: ${d.interaction.options[0].label}`, exact: true }).first().click();
    await page.getByRole('button', { name: `Add to ranking: ${d.interaction.options[1].label}`, exact: true }).first().click();
  } else if (type === 'free_text') await page.getByRole('textbox', { name: d.prompt }).fill('Own simulation draft');
  else await controls.first().check();
  if (type === 'single_choice') {
    await page.getByRole('button', { name: 'Change decision', exact: true }).click();
  }
  await controls.first().evaluate(el => { window.__answerControl = el; });
  await controls.first().focus();
  for (const width of [1920, 1366, 1024, 1023, 768, 640, 390, 320, 1366]) {
    await page.setViewportSize({ width, height: 900 });
    await geometry(page, width >= 1024);
    expect(await controls.first().evaluate(el => el === window.__answerControl)).toBe(true);
    await expect(controls.first()).toBeFocused();
  }
  if (type === 'free_text') await expect(controls.first()).toHaveValue('Own simulation draft');
  else if (type !== 'ranking') await expect(controls.first()).toBeChecked();
  else await expect(page.locator('.rank li')).toHaveCount(2);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    // Contrast is read once the Send answer button's and the theme's colour transitions settle (1.98:1 mid-way).
    await settled(page);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`participant-${type}-${theme}.png`), fullPage: true });
  }
});
test('responsive information disclosure returns focus without losing its narrow open choice', async ({ page }) => {
  await open(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const summary = page.locator('#main > section.stack summary');
  await summary.click();
  await summary.focus();
  await page.setViewportSize({ width: 1366, height: 900 });
  await expect(page.locator('#surfH')).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(summary).toBeFocused();
  await expect(page.locator('#main > section.stack details')).toHaveAttribute('open', '');
});
test('narrow situation keeps both explicit open and closed choices through resize and phase updates', async ({ page }) => {
  const { room } = await open(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const details = page.locator('#main > section.stack details');
  const summary = details.locator('summary');
  await expect(summary).toHaveAttribute('aria-label', /^Show situation:/);
  expect(await summary.evaluate(node => getComputedStyle(node).listStyleType)).toBe('none');
  await summary.focus(); await page.keyboard.press('Enter');
  await expect(summary).toHaveAttribute('aria-label', /^Hide situation:/);
  await expect(summary.locator('.disclosure-action')).toHaveText('Hide');
  await expect(summary).toBeFocused();
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(details).toHaveAttribute('open', '');
  await summary.focus(); await page.keyboard.press('Space');
  await expect(summary).toHaveAttribute('aria-label', /^Show situation:/);
  await expect(summary.locator('.disclosure-action')).toHaveText('Show');
  await expect(summary).toBeFocused();
  await expect(details).not.toHaveAttribute('open', '');
  // A room update while closed (CASE-255 retired the pause this step used): the closed choice holds.
  await command(room, 'set_timer', { seconds: 60 });
  await expect(page.locator('.timer-line')).not.toBeEmpty();
  await expect(details).not.toHaveAttribute('open', '');
  await summary.click();
  await expect(details).toHaveAttribute('open', '');
  await command(room, 'lock');
  await expect(page.getByText('No answer recorded from this phone', { exact: true })).toBeVisible();
  await expect(details).toHaveAttribute('open', '');
});
test('desktop pending, locked, browsing and recap retain private state and readable document flow', async ({ page, context }) => {
  const { room, d } = await open(page, 'free_text');
  await page.getByRole('textbox', { name: d.prompt }).fill('Own simulation answer');
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Send answer', exact: true }).click();
  await expect(page.getByText('Not sent yet · 1', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 800 });
  await page.setViewportSize({ width: 1366, height: 900 });
  await expect(page.getByRole('textbox', { name: d.prompt })).toHaveValue('Own simulation answer');
  await context.setOffline(false);
  await expect(page.getByText('Answer saved · you can change it until responses lock', { exact: true })).toBeVisible();
  await expect.poll(async () => Object.keys((await serverMirror(worker.origin, room)).round.responses).length).toBe(1);
  await geometry(page, true);
  await command(room, 'lock');
  await expect(page.getByRole('textbox', { name: d.prompt })).toHaveCount(0);
  await geometry(page, true);
  await page.locator('.strip button').first().click();
  await expect(page.locator('.decision')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Live surface', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Live surface', exact: true }).click();
  await geometry(page, true);
  await command(room, 'select_path', { pathId: d.fallback_path_id });
  await command(room, 'show_results', { on: false });
  await command(room, 'reveal');
  await expect(page.locator('.decision')).toBeHidden();
  await command(room, 'end');
  await expect(page.getByRole('heading', { name: 'Your private recap', exact: true })).toBeVisible();
  await expect(page.getByText('Your answer: Own simulation answer', { exact: true })).toBeVisible();
  expect(await page.locator('main').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length)).toBe(1);
  await page.emulateMedia({ media: 'print' });
  expect(await page.locator('main').evaluate(el => getComputedStyle(el).display)).toBe('flex');
});
