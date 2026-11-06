// Card 29 (CASE-166): Start room moved from the catalogue to case detail. Browser specs that start a room
// open the case, then the explicit Present confirmation. The returned button commits the launch.
import { expect } from '@playwright/test';

export async function openCase(page, title = 'Published case', {confirm=true}={}) {
  await expect(page.locator('.case-catalog')).not.toHaveAttribute('aria-busy','true');
  const dialog=page.getByRole('dialog',{name:'Present case',exact:true});if(await dialog.isVisible())return dialog.getByRole('button',{name:'Present',exact:true});
  const start = page.locator('.case-present').getByRole('button', { name: 'Present', exact: true });
  if (!await start.isVisible().catch(() => false))await page.locator('.library-list').getByRole('link', { name: title, exact: true }).click();
  await expect(start).toBeVisible();
  if(!confirm||await start.isDisabled())return start;
  await start.click();await expect(dialog).toBeVisible();return dialog.getByRole('button',{name:'Present',exact:true});
}
