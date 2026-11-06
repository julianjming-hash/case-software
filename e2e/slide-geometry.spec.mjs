import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';

// G07 probe (CASE-209). Evidence class: local Chromium with the shipped fonts, projector frame and CSS. It records
// measurements for the owner's G07 ruling; it does not claim projector, device or real-zoom evidence.
const PROJECTORS = [[1280, 720], [1920, 1080]];
const SCENARIOS = ['dense', 'sparse', 'table-max', 'q8', 'q8-results', 'q8-wide'];

test('[AS-141] slides fit a 16:9 stage inside the real projector band with loaded fonts; measurements recorded for G07', async ({ page }, testInfo) => {
  const rows = [];
  for (const theme of ['light', 'dark']) for (const [width, height] of PROJECTORS) for (const scenario of SCENARIOS) {
    await page.setViewportSize({ width, height });
    await page.goto(`/prototypes/slide-geometry.html?s=${scenario}&t=${theme}`);
    const probe = await page.evaluate(() => window.probe);
    expect(probe.fonts).toContain('Montserrat');
    expect(probe.pageOverflow, `${scenario} ${width}`).toBeLessThanOrEqual(0);
    // The slide is exactly 16:9 and never larger than the band it sits in.
    expect(Math.abs(probe.slide[0] / probe.slide[1] - 16 / 9)).toBeLessThan(0.01);
    expect(probe.slide[0]).toBeLessThanOrEqual(probe.band[0]); expect(probe.slide[1]).toBeLessThanOrEqual(probe.band[1]);
    // CASE-211 A: slide body text meets the 24 px projector floor at every projector target.
    if (probe.paragraph !== null) expect(probe.paragraph, `${scenario} ${width}`).toBeGreaterThanOrEqual(24);
    rows.push({ theme, ...probe });
    if (theme === 'light' || scenario === 'dense') await page.screenshot({ path: testInfo.outputPath(`g07-${scenario}-${width}-${theme}.png`) });
  }
  // Phone and 200 percent zoom of the editor width use semantic reflow, never a scaled miniature.
  for (const [width, height, label] of [[390, 844, 'phone'], [640, 360, 'zoom200-1280']]) {
    await page.setViewportSize({ width, height });
    await page.goto(`/prototypes/slide-geometry.html?s=dense&l=reflow`);
    const probe = await page.evaluate(() => window.probe);
    expect(probe.pageOverflow, label).toBeLessThanOrEqual(0);
    await expect(page.locator('.slide-table-card')).toHaveCount(8);
    rows.push({ theme: 'light', label, ...probe });
    await page.screenshot({ path: testInfo.outputPath(`g07-reflow-${label}.png`), fullPage: true });
  }
  // CASE-211 B: how many options each question slot holds once shrunk to the 24 px floor (recorded for readiness).
  for (const [width, height] of PROJECTORS) for (const scenario of ['q8', 'q8-results', 'q8-wide']) for (let options = 2; options <= 8; options++) {
    await page.setViewportSize({ width, height });
    await page.goto(`/prototypes/slide-geometry.html?s=${scenario}&n=${options}`);
    const probe = await page.evaluate(() => window.probe);
    expect(probe.questions[0].px).toBeGreaterThanOrEqual(24);
    rows.push({ theme: 'light', label: 'capacity', ...probe });
  }
  writeFileSync(testInfo.outputPath('g07-measurements.json'), JSON.stringify(rows, null, 1));
});
