import { test, expect, joinPhone, startCase, selectRoute, reveal } from '../tests/playwright-harness.mjs';

test('Card 23 lab navigation reveals one shared bento group per key without opening a vote or leaking the next group', async ({ lab }) => {
  await joinPhone(lab, 'A', 'Sam');
  await startCase(lab);
  const fac = lab.facilitator;
  const display = lab.display;
  const phone = lab.phone('A');
  const first = (await lab.state()).revealed[0];
  expect(first.groupsShown).toBe(1);
  expect((await lab.state()).round).toBeNull();
  await expect(fac.getByRole('button', { name: 'Reveal findings' })).toBeVisible();
  await expect(display.getByRole('region', { name: 'Findings' })).toHaveCount(0);
  await expect(phone.getByRole('region', { name: 'Findings' })).toHaveCount(0);
  await fac.locator('body').press('ArrowRight');
  await lab.until((state) => state.revealed[0].groupsShown === 2, 'one bento group shared');
  expect((await lab.state()).round).toBeNull();
  await expect(display.getByRole('region', { name: 'Findings' })).toBeVisible();
  await expect(phone.getByRole('region', { name: 'Findings' })).toBeVisible();
});

test('Card 23 every published presentation row is a button and a clicked earlier row replays only on the projector until Live', async ({ lab }) => {
  await joinPhone(lab, 'A', 'Sam');
  await startCase(lab);
  const fac = lab.facilitator;
  const strip = fac.getByRole('region', { name: 'Presentation strip' });
  await expect(strip.getByRole('button', { name: /S00011 workshop title.z/ })).toBeVisible();
  await fac.getByRole('button', { name: 'Reveal findings' }).click();
  await fac.getByRole('button', { name: 'Show decision context' }).click();
  await lab.until((state) => state.revealed.length === 2, 'decision context published');
  await strip.getByRole('button', { name: /S00011 workshop title.z/ }).click();
  await expect(lab.display.getByText('Presentation replay · phones remain on live surface')).toBeVisible();
  await expect(lab.phone('A').getByRole('heading', { name: 'S00021 worksho' })).toBeVisible();
  await fac.getByRole('button', { name: 'Live surface', exact: true }).click();
  await expect(lab.display.getByText('Presentation replay · phones remain on live surface')).toHaveCount(0);
});

test('Card 23 a phone can browse the earlier checkpoint entry when reset republishes the same surface', async ({ lab }) => {
  await joinPhone(lab, 'A', 'Sam');
  await startCase(lab);
  const fac = lab.facilitator;
  await fac.getByRole('button', { name: 'Reveal findings' }).click();
  await fac.getByRole('button', { name: 'Show decision context' }).click();
  await fac.getByRole('button', { name: 'Reveal observations' }).click();
  await fac.getByRole('button', { name: 'Reveal findings' }).click();
  await fac.getByRole('button', { name: 'Open responses' }).click();
  await lab.press('Lock responses & review');
  await selectRoute(lab, /^S00174 workshop label. Record a senso/);
  await lab.press('Hide responses on projector');
  await reveal(lab);
  await lab.until((state) => state.phase === 'terminal_teaching', 'terminal route shown');
  const reset = fac.getByRole('button', { name: /^Reset to / });
  for (let i = 0; i < 4 && !(await reset.count()); i++) {
    const shown = (await lab.state()).revealed.at(-1).groupsShown;
    const revealGroup = fac.getByRole('button', { name: /^Reveal (observations|findings|investigations)$/ });
    await expect(revealGroup).toBeEnabled();
    await revealGroup.click();
    await lab.until((state) => state.revealed.at(-1).groupsShown === shown + 1, 'one terminal group shared');
  }
  await expect(reset).toBeVisible();
  await expect(reset).toBeEnabled();
  await reset.evaluate((button) => button.click());
  const state = await lab.until((next) => next.revealed.filter((entry) => entry.surfaceId === next.liveSurfaceId).length === 2, 'checkpoint surface republished');
  const earlier = state.revealed.findIndex((entry) => entry.surfaceId === state.liveSurfaceId);
  const phone = lab.phone('A');
  await phone.getByRole('list', { name: 'Swipe through shared material' }).locator(`button[data-entry-index="${earlier}"]`).click();
  await expect(phone.getByText('Earlier material · read-only')).toBeVisible();
  await expect(phone.getByRole('list', { name: 'Swipe through shared material' }).locator(`button[data-entry-index="${earlier}"]`)).toHaveAttribute('aria-current', 'true');
  await phone.getByRole('button', { name: 'Live surface', exact: true }).click();
  await expect(phone.getByText('Earlier material · read-only')).toHaveCount(0);
});
