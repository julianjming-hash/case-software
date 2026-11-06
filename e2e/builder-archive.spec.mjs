// CASE-316: an owner archives a never-published draft from the Builder's More menu. The exact title must be typed; the
// Worker's refusals are named; an author never sees the action. Local workerd and fakes only (hard rule 12).
import { test, expect } from '@playwright/test';
import { start, stop, env, mvcSchema2, openBuilder } from '../tests/design-critique/harness.mjs';

test.use({ ignoreHTTPSErrors: true });
test.beforeAll(start);
test.afterAll(stop);

async function openArchive(page) {
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('button', { name: 'Archive draft…', exact: true }).click();
  return page.getByRole('group', { name: 'Archive draft', exact: true });
}

test('[AS-185] an owner archives a draft only after typing its exact title, then leaves the editor; refusals are named', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const pair = mvcSchema2(), title = pair.document.title, sent = [];
  let reply = { status: 409, body: { error: 'review_open' } };
  await openBuilder(page, pair);
  await page.route(`**/api/v1/builder/cases/${env.worker.caseId}/archive`, route => {
    sent.push(route.request().postDataJSON());
    return route.fulfill({ status: reply.status, contentType: 'application/json', body: JSON.stringify(reply.body) });
  });
  const panel = await openArchive(page);
  await expect(panel).toBeVisible();
  const field = panel.getByRole('textbox', { name: `Type ${title} to confirm`, exact: true });
  const go = panel.getByRole('button', { name: 'Archive draft', exact: true });
  await expect(field).toBeFocused();
  await expect(go).toBeDisabled();
  await field.fill(title.slice(0, -1));
  await expect(go).toBeDisabled();
  await field.fill(title);
  await expect(go).toBeEnabled();
  // A refusal is named and the editor stays.
  await go.click();
  await expect(panel.getByRole('alert')).toHaveText('This draft is in review. Cancel the submission first.');
  await expect(page.locator('.builder-studio')).toBeVisible();
  // Archived: the exact title went once more, and the Builder hands back to the cases list.
  reply = { status: 200, body: { caseId: env.worker.caseId, archived: true } };
  await go.click();
  await expect(page.locator('.builder-studio')).toHaveCount(0);
  expect(sent).toEqual([{ confirmTitle: title }, { confirmTitle: title }]);
});

test('[AS-185] an author is never offered Archive draft', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBuilder(page, mvcSchema2(), { role: 'author' });
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Manage checkpoints', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Archive draft…', exact: true })).toHaveCount(0);
});
