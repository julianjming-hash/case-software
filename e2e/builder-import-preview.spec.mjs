// CASE-344 B3, [AS-221]: Import and export in the ⋯ menu. Export is one download. Choosing a file previews what will change
// and then offers Replace this draft or Import as a new case; a file from a newer Case is refused by name. Light and dark.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createBuilderTransferExport } from '../src/shared/builder-transfer.mjs';
import { startServers, openEditor, roomyPair } from '../tests/helpers/builder-simplify-fixture.mjs';
import { everythingPair } from '../tests/helpers/builder-everything-fixture.mjs';

test.use({ ignoreHTTPSErrors: true });
let servers;
test.beforeAll(async () => { servers = await startServers(); });
test.afterAll(async () => { await servers?.stop(); });
// Set SHOTS to a folder to save the light and dark screenshots (as the other Builder specs do); unset, nothing is written.
const SHOTS = process.env.SHOTS;

const fileOf = (name, envelope) => ({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(envelope)) });
async function fileFrom(pair, change = null) {
  const exported = await createBuilderTransferExport({ document: pair.document, metadata: pair.authoringMetadata, intent: 'copy', includePrivate: true });
  expect(exported.ok, JSON.stringify(exported.errors)).toBe(true);
  if (change) change(exported.envelope);
  return exported.envelope;
}
async function openTransfer(page) {
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('group', { name: 'More', exact: true }).getByRole('button', { name: 'Import and export', exact: true }).click();
  const transfer = page.getByRole('dialog', { name: 'Import and export' }).getByRole('region', { name: 'Transfer Builder draft', exact: true });
  await expect(transfer).toBeVisible();
  return transfer;
}
async function inBothThemes(page, name) {
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme });
    await page.waitForTimeout(400);
    const results = await new AxeBuilder({ page }).include('.builder-transfer-dialog').analyze();
    expect(results.violations.map(item => `${item.id}: ${item.nodes.map(node => node.target.join(' ')).slice(0, 2).join(', ')}`), `${name} (${theme})`).toEqual([]);
    if (SHOTS) await page.locator('.builder-transfer-dialog').screenshot({ path: `${SHOTS}/builder-import-preview-${name}-${theme}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

for (const unsaved of [false, true]) test(`[AS-221] ${unsaved ? 'unsaved private writing survives import Undo and Redo' : 'choosing a file previews what will change, then Replace this draft replaces it and nothing is saved until Save'}`, async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1250 });
  const incoming = everythingPair(), original = roomyPair();
  original.authoringMetadata.preparation_requirements = 'Private preparation to preserve across replacement.';
  const state = await openEditor(page, servers, original);
  const expected = structuredClone(original);
  if (unsaved) {
    // Freeze only this functional case; the other case runs the theme and accessibility checks on a live clock.
    await page.clock.pauseAt(new Date());
    await page.locator('.builder-zone-private > summary').click();
    await page.getByLabel('Private stage cue', { exact: true }).fill('Unsaved private cue');
    await page.clock.runFor(200);
    expected.document.beats.find(beat => beat.id === expected.document.start_beat_id).cue = 'Unsaved private cue';
  }
  const transfer = await openTransfer(page);
  // Before a file is chosen there is no preview and neither action.
  await expect(transfer.getByRole('group', { name: 'Import preview', exact: true })).toBeHidden();
  await expect(transfer.getByRole('button', { name: 'Replace this draft', exact: true })).toBeDisabled();
  await expect(transfer.getByRole('button', { name: 'Import as a new case', exact: true })).toBeDisabled();
  await transfer.getByLabel('Choose a transfer JSON file', { exact: true }).setInputFiles(fileOf('another-case.json', await fileFrom(incoming)));
  const preview = transfer.getByRole('group', { name: 'Import preview', exact: true });
  await expect(preview).toBeVisible();
  const table = preview.getByRole('table', { name: 'What will change', exact: true });
  await expect(table.getByRole('row', { name: /^Title Simplified Builder fixture/ })).toContainText('Simplified Builder fixture');
  await expect(table.getByRole('row', { name: /^Questions 3 4/ })).toHaveAttribute('data-changed', 'true');
  await expect(table.getByRole('row', { name: /^Stages/ })).toHaveAttribute('data-changed', 'true');
  await expect(preview).toContainText('Replacing keeps nothing of this draft');
  // Nothing has changed yet.
  expect(state.puts).toEqual([]);
  if (unsaved) await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeEnabled();
  else await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeDisabled();
  await expect(transfer.getByRole('button', { name: 'Replace this draft', exact: true })).toBeEnabled();
  await expect(transfer.getByRole('button', { name: 'Import as a new case', exact: true })).toBeEnabled();
  if (!unsaved) await inBothThemes(page, 'file');
  await transfer.getByRole('button', { name: 'Replace this draft', exact: true }).click();
  await expect(transfer.getByRole('status')).toContainText('replaced by the file');
  await page.getByRole('dialog', { name: 'Import and export' }).getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect.poll(() => state.puts.length).toBe(1);
  expect(state.pair).toEqual(expected);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect.poll(() => state.puts.length).toBe(2);
  // This export includes private document cues, but omits the opt-in source/preparation metadata.
  expect(state.pair).toEqual({ document: incoming.document, authoringMetadata: { metadata_version: 1 } });
});

test('[AS-221] a file from a newer Case is refused by name and offers nothing; one with an unknown field is refused too', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1250 });
  const incoming = everythingPair(), state = await openEditor(page, servers);
  const transfer = await openTransfer(page);
  const input = transfer.getByLabel('Choose a transfer JSON file', { exact: true });
  await input.setInputFiles(fileOf('newer.json', await fileFrom(incoming, envelope => envelope.operations.find(item => item.path === '/required_capabilities').value.push('callout_icon_v2'))));
  await expect(transfer.getByRole('status')).toHaveText('made by a newer Case: needs `callout_icon_v2`');
  await expect(transfer.getByRole('button', { name: 'Replace this draft', exact: true })).toBeDisabled();
  await expect(transfer.getByRole('button', { name: 'Import as a new case', exact: true })).toBeDisabled();
  await inBothThemes(page, 'newer');
  await input.setInputFiles(fileOf('unknown.json', await fileFrom(incoming, envelope => { envelope.operations.find(item => item.path === '/blocks').value[0].future_key = true; })));
  await expect(transfer.getByRole('button', { name: 'Replace this draft', exact: true })).toBeDisabled();
  await expect(transfer.getByRole('group', { name: 'Import preview', exact: true })).toContainText('unknown slide field');
  expect(state.puts).toEqual([]);
});

test('[AS-221] one download holds the whole case, and choosing that same file shows nothing to change', async ({ page }) => {
  const state = await openEditor(page, servers);
  const transfer = await openTransfer(page);
  const download = page.waitForEvent('download');
  await transfer.getByRole('button', { name: 'Download this case', exact: true }).click();
  const path = await (await download).path();
  await transfer.getByLabel('Choose a transfer JSON file', { exact: true }).setInputFiles(path);
  const table = transfer.getByRole('table', { name: 'What will change', exact: true });
  for (const row of await table.getByRole('row').all()) if (await row.getAttribute('data-changed') !== null) await expect(row).toHaveAttribute('data-changed', 'false');
  expect(state.puts).toEqual([]);
});
