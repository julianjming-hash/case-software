// D24 (CASE-268): on a phone, a question option reads as whole words. A ranked option takes the full row width,
// with its rank number and move controls on the line above. Checked against the built phone and a local Worker.
import { test, expect } from '@playwright/test';
import { startLocalWorker, createRoom, facilitatorCommand, FIXTURE } from '../tests/helpers/local-worker.mjs';
import { joinUrl } from '../src/shared/urls.mjs';
import { strayText } from '../tests/helpers/stray-text.mjs';

const LABELS = [
  'Antibiotics, including clindamycin for toxin suppression',
  'Urgent surgical exploration and debridement of the necrotic tissue',
  'Hyperbaric oxygen once the patient is haemodynamically stable',
  'Intravenous immunoglobulin for streptococcal toxic shock',
];
const WIDTHS = [320, 360, 390, 430];

let worker;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => { worker = await startLocalWorker(); });
test.afterAll(async () => { await worker?.stop(); });

function longLabelCase(type) {
  const document = structuredClone(FIXTURE), decision = document.decisions[0], options = decision.interaction.options;
  options.forEach((option, index) => { option.label = LABELS[index]; });
  decision.interaction.type = type;
  if (type !== 'single_choice') {
    for (const path of decision.paths) delete path.option_ids;
    decision.rules = [{ when: type === 'ranking' ? { top: [options[1].id] } : { includes_all: [options[0].id] }, path_id: decision.fallback_path_id }];
  }
  if (type === 'ranking') decision.interaction.rank_count = 3;
  return document;
}

async function openFirstDecision(room) {
  // Arrival (2 groups) then the decision stage (scene, observations, findings), then Open responses.
  for (let i = 0; i < 5; i++) expect((await facilitatorCommand(worker.origin, room, i ? 'advance' : 'start'))?.receipt).toBe('accepted');
  expect((await facilitatorCommand(worker.origin, room, 'advance'))?.receipt).toBe('accepted');
}

// Every option label's visible text, and each place where a line ends between two letters or digits of one word.
function measureLabels() {
  const word = /[\p{L}\p{N}]/u, report = [];
  for (const label of document.querySelectorAll('.opt .lbl, .rank .lbl, .avail .lbl')) {
    const chars = [];
    const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT, { acceptNode: node => node.parentElement.closest('.sr-only, .xnote') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) for (let i = 0; i < node.data.length; i++) {
      const range = document.createRange(); range.setStart(node, i); range.setEnd(node, i + 1);
      const rect = range.getClientRects()[0];
      if (rect) chars.push({ ch: node.data[i], top: rect.top, height: rect.height });
    }
    const breaks = [];
    for (let i = 1; i < chars.length; i++) {
      const a = chars[i - 1], b = chars[i];
      if (b.top - a.top > a.height / 2 && word.test(a.ch) && word.test(b.ch)) breaks.push(chars.slice(Math.max(0, i - 6), i + 6).map(c => c.ch).join(''));
    }
    const row = label.closest('li, .opt'), style = getComputedStyle(row);
    const inner = row.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth);
    report.push({ text: chars.map(c => c.ch).join(''), breaks, ranked: Boolean(label.closest('.rank')), width: label.getBoundingClientRect().width, inner, wrap: getComputedStyle(label).overflowWrap, wordBreak: getComputedStyle(label).wordBreak });
  }
  return { labels: report, sideways: document.scrollingElement.scrollWidth - window.innerWidth };
}

for (const type of ['single_choice', 'multi_select', 'ranking']) test(`[D24] phone ${type} options read as whole words at 320, 360, 390 and 430 px, light and dark`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const room = await createRoom(worker.origin, { caseDocument: longLabelCase(type) });
  await page.goto(joinUrl(room.joinCode, worker.origin));
  await page.getByLabel('Your name', { exact: true }).fill('Sam');
  await page.getByRole('button', { name: 'Join case', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Waiting to start' })).toBeVisible();
  await openFirstDecision(room);
  if (type === 'ranking') {
    for (const label of LABELS.slice(0, 2)) await page.getByRole('button', { name: `Add to ranking: ${label}`, exact: true }).click();
    await expect(page.locator('.rank li')).toHaveCount(2);
  } else await expect(page.locator('.opt')).toHaveCount(LABELS.length);
  expect(await page.evaluate(strayText), `${type}: no stray text (D26)`).toEqual([]);
  for (const colorScheme of ['light', 'dark']) for (const width of WIDTHS) {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width, height: 800 });
    const { labels, sideways } = await page.evaluate(measureLabels);
    const where = `${type} at ${width} px, ${colorScheme}`;
    expect(labels.length, where).toBe(LABELS.length);
    expect(sideways, `${where}: no sideways scroll`).toBeLessThanOrEqual(0);
    for (const label of labels) {
      expect.soft(label.breaks, `${where}: "${label.text}" breaks inside a word`).toEqual([]);
      expect.soft(label.wordBreak, where).not.toBe('break-all');
      expect.soft(label.wrap, `${where}: only an unbreakable token may break`).toBe('break-word');
      if (label.ranked) expect.soft(label.width, `${where}: a ranked option takes its row's full width`).toBeGreaterThanOrEqual(label.inner - 1);
    }
    if (type === 'ranking') {
      // The number and controls sit on the line above the label, never beside a squeezed column.
      const geometry = await page.locator('.rank li').first().evaluate(li => {
        const box = el => el.getBoundingClientRect();
        return { pos: box(li.querySelector('.pos')), label: box(li.querySelector('.lbl')), buttons: [...li.querySelectorAll('.row-btns button')].map(box) };
      });
      expect(geometry.buttons).toHaveLength(3);
      for (const button of geometry.buttons) {
        expect(button.width, where).toBeGreaterThanOrEqual(44); expect(button.height, where).toBeGreaterThanOrEqual(44);
        expect(button.bottom, `${where}: controls sit above the label`).toBeLessThanOrEqual(geometry.label.top + 1);
        expect(Math.abs(button.top - geometry.buttons[0].top), where).toBeLessThan(1);
      }
      expect(geometry.pos.bottom, where).toBeLessThanOrEqual(geometry.label.top + 1);
    }
  }
});
