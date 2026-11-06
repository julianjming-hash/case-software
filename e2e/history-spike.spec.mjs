import { test, expect } from '@playwright/test';

// G09 spike (card 58). Evidence class: real Chromium keyboard/editing events and its IME pipeline driven over CDP.
// This is browser evidence, not operating-system IME, VoiceOver or Safari evidence (owner protocol in the spike record).
const state = page => page.evaluate(() => window.historySpike.state().document);
const undoKey = 'ControlOrMeta+z', redoKey = 'ControlOrMeta+Shift+z';

test('[AS-140] typed text, a structural command and a contenteditable share one chronological Undo/Redo through native shortcuts', async ({ page }) => {
  await page.goto('/prototypes/history-spike.html');
  await page.getByLabel('Stage name', { exact: true }).click(); await page.keyboard.type('Ab');
  await page.getByRole('button', { name: 'Add finding', exact: true }).click();
  await page.getByLabel('Learner scene', { exact: true }).click(); await page.keyboard.type('Cd');
  const notes = page.getByRole('textbox', { name: 'Private notes', exact: true });
  await notes.click(); await page.keyboard.type('Ef');
  const full = await state(page);
  expect(full).toEqual({ title: 'Ab', scene: 'Cd', notes: 'Ef', findings: ['Finding 1'] });
  // Focus stays in the notes; each native shortcut walks back one step across fields and structure.
  const expected = [
    { title: 'Ab', scene: 'Cd', notes: '', findings: ['Finding 1'] },
    { title: 'Ab', scene: '', notes: '', findings: ['Finding 1'] },
    { title: 'Ab', scene: '', notes: '', findings: [] },
    { title: '', scene: '', notes: '', findings: [] },
  ];
  for (const step of expected) { await page.keyboard.press(undoKey); expect(await state(page)).toEqual(step); }
  await expect(notes).toBeFocused();
  // The browser's own field undo never ran: the visible fields equal the canonical draft at every step.
  await expect(page.getByLabel('Stage name', { exact: true })).toHaveValue('');
  for (const step of [...expected.slice(0, 3)].reverse().concat([full])) { await page.keyboard.press(redoKey); expect(await state(page)).toEqual(step); }
  await expect(page.getByLabel('Learner scene', { exact: true })).toHaveValue('Cd');
  // New editing after Undo clears Redo.
  await page.keyboard.press(undoKey); await page.keyboard.type('X');
  await page.keyboard.press(redoKey);
  expect((await state(page)).notes).toBe('X');
});

test('[AS-140] historyUndo/historyRedo input events route to the same history and are cancelled (synthetic event routing)', async ({ page }) => {
  // Chromium's execCommand('undo') does not fire beforeinput, so the Edit/context-menu path cannot be driven here.
  // This proves only the routing on a synthetic event; the real menu path is an owner check in the spike record.
  await page.goto('/prototypes/history-spike.html');
  await page.getByLabel('Learner scene', { exact: true }).click(); await page.keyboard.type('Scene');
  await page.getByRole('button', { name: 'Add finding', exact: true }).click();
  const fire = type => page.evaluate(type => { const event = new InputEvent('beforeinput', { inputType: type, bubbles: true, cancelable: true }); document.getElementById('scene').dispatchEvent(event); return event.defaultPrevented; }, type);
  expect(await fire('historyUndo')).toBe(true);
  expect(await state(page)).toEqual({ title: '', scene: 'Scene', notes: '', findings: [] });
  expect(await fire('historyRedo')).toBe(true);
  expect((await state(page)).findings).toEqual(['Finding 1']);
});

test('[AS-140] an IME composition is one step, records nothing while composing, and Undo waits for it to finish', async ({ page }) => {
  await page.goto('/prototypes/history-spike.html');
  const scene = page.getByLabel('Learner scene', { exact: true });
  await scene.click(); await page.keyboard.type('A ');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'にほ', selectionStart: 2, selectionEnd: 2 });
  await cdp.send('Input.imeSetComposition', { text: 'にほん', selectionStart: 3, selectionEnd: 3 });
  // While composing the canonical draft is untouched, and the shortcut is left to the IME.
  expect((await state(page)).scene).toBe('A ');
  await page.keyboard.press(undoKey);
  expect((await state(page)).scene).toBe('A ');
  await cdp.send('Input.insertText', { text: '日本' });
  await expect(scene).toHaveValue('A 日本');
  expect((await state(page)).scene).toBe('A 日本');
  // One Undo removes the whole committed composition, never a partial reading.
  await page.keyboard.press(undoKey);
  expect((await state(page)).scene).toBe('A ');
  await page.keyboard.press(redoKey);
  expect((await state(page)).scene).toBe('A 日本');
});
