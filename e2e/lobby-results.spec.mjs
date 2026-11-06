import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startLocalWorker, createRoom, facilitatorCommand, serverMirror } from '../tests/helpers/local-worker.mjs';
import { apiUrl, displayPairUrl, joinUrl } from '../src/shared/urls.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
import { miniCase } from '../tests/helpers/mini-case.mjs';
import { openLab, joinPhone, startCase, vote } from '../tests/playwright-harness.mjs';
import { docShotsDir } from '../tests/helpers/doc-shots.mjs';

test.describe('Card24 served closed results', () => {
  let worker;
  test.describe.configure({ mode: 'serial' });
  test.beforeAll(async () => { worker = await startLocalWorker(); });
  test.afterAll(async () => { await worker?.stop(); });
  const post = async (parts, token, body) => {
    const response = await fetch(apiUrl(worker.origin, ...parts), { method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    expect(response.ok).toBe(true); return response.json();
  };
  const steer = async (room, type, payload = {}) => expect((await facilitatorCommand(worker.origin, room, type, payload)).receipt).toBe('accepted');
  async function pair(page, room) {
    await page.goto(displayPairUrl('00000000', worker.origin));
    await expect(page.locator('.pair-code')).toHaveText(/[0-9A-Z]{4} [0-9A-Z]{4}/);
    const code = (await page.locator('.pair-code').textContent()).replace(/\s/g, '');
    await post(['sessions', room.sessionId, 'display-pairs', 'approve'], room.facilitatorToken, { code });
    await expect(page.locator('.joinpanel')).toBeVisible();
  }

  test('[AS-089] Card24 actual projector closes an anonymous ranking chart before reveal and phones wait for consequence', async ({ browser }) => {
    const fixture = miniCase(), decision = fixture.doc.decisions[0];
    decision.interaction.type = 'ranking'; decision.interaction.rank_count = 3;
    decision.paths.forEach(path => { delete path.option_ids; });
    decision.rules = [{ when: { top: [fixture.o.decompress] }, path_id: fixture.p.decompress }];
    const room = await createRoom(worker.origin, { caseDocument: fixture.doc });
    const display = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
      await pair(display, room); await phone.goto(joinUrl(room.joinCode, worker.origin));
      await phone.getByLabel('Your name', { exact: true }).fill('Same');
      await expect(phone.getByText('Your name and avatar appear on the projector in the lobby.', { exact: true })).toBeVisible();
      await phone.getByRole('button', { name: 'Join case', exact: true }).click();
      await expect(phone.getByRole('heading', { name: 'Waiting to start' })).toBeVisible();
      await expect(display.locator('.names .nm')).toHaveText(['Same']);
      const screenshots = docShotsDir('24-screenshots');
      for (const [width, height] of [[1280, 720], [1920, 1080]]) for (const theme of ['light', 'dark']) {
        await display.setViewportSize({ width, height });
        await display.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        await display.screenshot({ path: `${screenshots}/lobby-${width}-${theme}.png` });
      }
      await display.setViewportSize({ width: 1280, height: 720 });
      await display.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
      await steer(room, 'start'); await steer(room, 'advance');
      expect((await serverMirror(worker.origin, room)).round).toBeNull();
      await steer(room, 'advance'); // Explicitly open after prepared decision context.
      for (const option of decision.interaction.options) await phone.getByRole('button', { name: `Add to ranking: ${option.label}`, exact: true }).click();
      await phone.getByRole('button', { name: 'Send answer', exact: true }).click();
      await expect.poll(async () => Object.keys((await serverMirror(worker.origin, room)).round.responses).length).toBe(1);
      await expect(display.getByRole('region', { name: 'Responses closed', exact: true })).toHaveCount(0);
      await steer(room, 'lock'); const chart = display.getByRole('region', { name: 'Responses closed', exact: true });
      await expect(chart).toBeVisible();
      // Card25 supersedes only the public marginal table with one complete order.
      await expect(chart.locator('.ranked-label')).toHaveText(decision.interaction.options.map(option => option.label));
      await expect(chart.locator('.ranked-rank')).toHaveText(['1','2','3']);
      await expect(chart.locator('.ranked-overall')).toHaveText('1 response'); // CASE-327: one order, one footer count
      const closed = (await serverMirror(worker.origin, room)).round.aggregate;
      expect(closed.positionCounts).toEqual(Object.fromEntries(decision.interaction.options.map((option,index)=>[option.id,[0,1,2].map(rank=>Number(rank===index))])));
      await steer(room, 'results_page', { page: 1 }); // Legacy wire remains accepted without fabricating another order.
      expect((await serverMirror(worker.origin,room)).resultsPage).toBe(1);
      await expect(chart.locator('.ranked-label')).toHaveText(decision.interaction.options.map(option=>option.label));
      for (const [width, height] of [[1280, 720], [1920, 1080]]) for (const theme of ['light', 'dark']) {
        await display.setViewportSize({ width, height });
        await display.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        for (const page of [0, 1]) {
          await steer(room, 'results_page', { page });
          await expect(chart.locator('.ranked-label')).toHaveText(decision.interaction.options.map(option=>option.label));
          await expect(chart.locator('.ranked-rank')).toHaveText(['1','2','3']);
          expect((await serverMirror(worker.origin,room)).round.aggregate).toEqual(closed);
          await display.screenshot({ path: `${screenshots}/ranking-three-${width}-${theme}-page${page + 1}.png` });
        }
      }
      await display.setViewportSize({ width: 1280, height: 720 });
      await display.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
      await expect(phone.getByRole('region', { name: 'Group result', exact: true })).toHaveCount(0);
      await steer(room, 'show_results', { on: false }); await expect(chart).toHaveCount(0);
      await steer(room, 'show_results', { on: true }); await expect(chart).toBeVisible();
      await steer(room, 'select_path', { pathId: fixture.p.decompress }); await expect(chart.locator('.ranked-rank')).toHaveText(['1','2','3']);
      expect((await serverMirror(worker.origin,room)).round.aggregate).toEqual(closed);
      await steer(room, 'show_results', { on: false });
      await steer(room, 'reveal'); await expect(phone.getByRole('region', { name: 'Group result', exact: true })).toContainText('Rank 3: 1');
    } finally { await display.close(); await phone.close(); }
  });

  test('Card24 complete ranking counts meet projector floors and phone controls remain usable in both themes', async ({ browser }) => {
    const fixture = miniCase(), decision = fixture.doc.decisions[0];
    decision.interaction.type = 'ranking'; decision.interaction.rank_count = 8;
    const originalOptions = decision.interaction.options;
    decision.interaction.options = Array.from({ length: 8 }, (_, index) => ({
      id: originalOptions[index]?.id ?? uuidv7(),
      label: (`Option ${index + 1}: ` + (index < 4 ? 'A long authored intervention description with clinical context and further details '.repeat(2) : '临床评估'.repeat(40))).slice(0, 120),
    }));
    expect(decision.interaction.options.every(option => option.label.length === 120)).toBe(true);
    decision.paths.forEach(path => { delete path.option_ids; });
    decision.rules = [{ when: { top: [fixture.o.decompress] }, path_id: fixture.p.decompress }];
    const room = await createRoom(worker.origin, { caseDocument: fixture.doc });
    const displayContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const display = await displayContext.newPage(), phone = await phoneContext.newPage();
    try {
      await pair(display, room); await phone.goto(joinUrl(room.joinCode, worker.origin));
      await phone.getByLabel('Your name', { exact: true }).fill('Learner');
      await phone.getByRole('button', { name: 'Join case', exact: true }).click();
      await expect(phone.getByRole('heading', { name: 'Waiting to start' })).toBeVisible();
      await steer(room, 'start');
      for (let step = 0; step < 20 && (await serverMirror(worker.origin, room)).phase !== 'responses_open'; step++) await steer(room, 'advance');
      expect((await serverMirror(worker.origin, room)).phase).toBe('responses_open');
      for (const option of decision.interaction.options) await phone.getByRole('button', { name: `Add to ranking: ${option.label}`, exact: true }).click();
      const controls = phone.locator('.row-btns button');
      await expect(controls).toHaveCount(24);
      for (const theme of ['light', 'dark']) {
        await phone.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        const dimensions = await controls.evaluateAll(elements => elements.map(element => {
          const { width, height } = element.getBoundingClientRect(); return { width, height };
        }));
        for (const box of dimensions) { expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44); }
        expect((await new AxeBuilder({ page: phone }).analyze()).violations).toEqual([]);
      }
      await phone.getByRole('button', { name: 'Send answer', exact: true }).click();
      await expect.poll(async () => Object.keys((await serverMirror(worker.origin, room)).round.responses).length).toBe(1);
      await steer(room, 'lock');
      const chart = display.getByRole('region', { name: 'Responses closed', exact: true });
      const closed = (await serverMirror(worker.origin,room)).round.aggregate;
      expect(closed.positionCounts).toEqual(Object.fromEntries(decision.interaction.options.map((option,index)=>[option.id,Array.from({length:8},(_,rank)=>Number(rank===index))])));
      const screenshots = docShotsDir('24-screenshots');
      for (const [width, height] of [[1280, 720], [1920, 1080]]) for (const theme of ['light', 'dark']) {
        await display.setViewportSize({ width, height });
        await display.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        const seenLabels = [], measurements = [];
        for (const resultsPage of [0, 1, 2, 3]) {
          const mirror=await serverMirror(worker.origin,room), position=resultsPage*2;
          await steer(room,'ranked_page',{group:0,position,closedRoundId:mirror.round.id,expectRevision:mirror.revision});
          const options = decision.interaction.options.slice(position,position+2);
          await expect(chart.locator('.ranked-label')).toHaveText(options.map(option=>option.label));
          seenLabels.push(...await chart.locator('.ranked-label').allTextContents());
          await expect(chart.locator('.ranked-rank')).toHaveText([String(position+1),String(position+2)]);
          await expect(chart.locator('.ranked-overall')).toHaveText('1 response'); // CASE-327: one order, one footer count
          await expect(chart.locator('.ranked-continuation')).toHaveText(`Positions ${position+1}–${position+2} of 8${position?' · continued':''}`);
          expect((await serverMirror(worker.origin,room)).round.aggregate).toEqual(closed);
          const layout = await display.evaluate(() => ({
            fonts: [...document.querySelectorAll('.ranked-rank')].map(node => parseFloat(getComputedStyle(node).fontSize)),
            labelFonts: [...document.querySelectorAll('.ranked-label')].map(node => parseFloat(getComputedStyle(node).fontSize)),
            clipped: [...document.querySelectorAll('.ranked-label')].some(node => node.scrollWidth > node.clientWidth+1 || node.scrollHeight > node.clientHeight+1),
            mainOverflow: document.querySelector('main').dataset.overflow,
            pageOverflow: document.documentElement.scrollHeight > innerHeight || document.documentElement.scrollWidth > innerWidth,
            availableHeight: document.querySelector('main .col').clientHeight, contentHeight: document.querySelector('main .col').scrollHeight,
          }));
          await test.info().attach(`maximum-ranking-${width}-${theme}-${resultsPage}-layout`, { body: JSON.stringify(layout), contentType: 'application/json' });
          await display.screenshot({ path: `${screenshots}/ranking-maximum-${width}-${theme}-page${resultsPage + 1}.png` });
          measurements.push(layout);
          console.log('Card24 maximum ranking layout', JSON.stringify({ width, height, theme, page: resultsPage, ...layout }));
          expect((await new AxeBuilder({ page: display }).analyze()).violations).toEqual([]);
        }
        expect(seenLabels).toEqual(decision.interaction.options.map(option => option.label));
        for (const layout of measurements) {
          expect(layout.fonts).toHaveLength(2);
          for (const font of layout.fonts) expect(font).toBeGreaterThanOrEqual(24);
          expect(layout.labelFonts).toHaveLength(2);
          for (const font of layout.labelFonts) expect(font).toBeGreaterThanOrEqual(24);
          expect(layout.clipped).toBe(false); expect(layout.mainOverflow).toBe('false'); expect(layout.pageOverflow).toBe(false);
        }
      }
      await steer(room, 'show_results', { on: false });
      await expect(chart).toHaveCount(0);
      await expect(display.getByRole('heading', { name: 'Primary survey', exact: true })).toBeVisible();
      await steer(room, 'show_results', { on: true });
      await expect(chart.locator('.ranked-continuation')).toHaveText('Positions 7–8 of 8 · continued');
      await expect(chart.locator('.ranked-label')).toHaveText(decision.interaction.options.slice(6).map(option=>option.label));
      expect((await serverMirror(worker.origin,room)).round.aggregate).toEqual(closed);
      await steer(room,'show_results',{on:false});await steer(room,'select_path',{pathId:fixture.p.decompress});await steer(room,'reveal');
      await expect(phone.locator('.ranking-result > li > ul > li')).toHaveText(decision.interaction.options.flatMap((_,index)=>Array.from({length:8},(_,rank)=>`Rank ${rank+1}: ${Number(rank===index)}`)));
    } finally { await displayContext.close(); await phoneContext.close(); }
  });

  test('[AS-088] Card24 actual reduced-motion lobby seeds silently and reports only fresh duplicate-name arrivals', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const room = await createRoom(worker.origin); await pair(page, room);
    const status = page.locator('.arrival-status');
    await expect(status).toHaveText('');
    const joined = await post(['join'], null, { v: 1, code: room.joinCode, displayName: 'Same', avatarId: 'shadows-01' });
    await expect(status).toHaveText('1 joined');
    await expect(status).toHaveAttribute('data-arrivals', '1');
    await post(['join'], null, { v: 1, code: room.joinCode, displayName: 'Same', avatarId: 'shadows-01' });
    await expect(page.locator('.names .nm')).toHaveText(['Same', 'Same']);
    await expect(status).toHaveAttribute('data-arrivals', '2');
    await steer(room, 'rename', { participantId: joined.participantId, displayName: 'Changed' });
    await expect(page.locator('.names .nm')).toHaveText(['Changed', 'Same']);
    await expect(status).toHaveAttribute('data-arrivals', '2');
    await steer(room, 'remove_participant', { participantId: joined.participantId });
    await expect(page.locator('.names .nm')).toHaveText(['Same']);
    await expect(status).toHaveAttribute('data-arrivals', '2');
    await expect(page.locator('.arrival-pending, .splash-join-avatar')).toHaveCount(0); // reduced motion: nothing waits or flies
    await expect(page.locator('.names .arrival-note')).toHaveText('1 joined');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    // Someone joins (2026-10-10): the avatar appears in the art while its chip waits; it lands, then the count updates.
    await post(['join'], null, { v: 1, code: room.joinCode, displayName: 'New', avatarId: 'shadows-02' });
    await expect(status).toHaveAttribute('data-arrivals', '3');
    await expect(page.locator('.chip.arrival-pending .nm')).toHaveText('New');
    await expect(page.locator('.splash-join-avatar')).toHaveCount(1);
    await expect(page.locator('.names .arrival-note')).toHaveText('1 joined');
    await expect(page.locator('.chip.arrival-pending')).toHaveCount(0, { timeout: 6000 });
    await expect(page.locator('.splash-join-avatar')).toHaveCount(0);
    await expect(page.locator('.names .arrival-note')).toHaveText('2 joined');
    let overflowObserved = false;
    // Stay below the twelve-row projection cap so physical chip fitting is exercised.
    for (let index = 0; index < 9; index++) {
      await post(['join'], null, { v: 1, code: room.joinCode, displayName: `Team member ${index}`, avatarId: 'shadows-03' });
      await expect(status).toHaveAttribute('data-arrivals', String(4 + index));
      await expect(page.locator('.chip.arrival-pending')).toHaveCount(0, { timeout: 6000 });
      await expect(page.locator('.names .arrival-note')).toHaveText(`${3 + index} joined`);
      if (await page.locator('.names .chip.more').count()) { overflowObserved = true; break; }
    }
    expect(overflowObserved).toBe(true);
    await page.reload(); await expect(page.locator('.joinpanel')).toBeVisible();
    await expect(status).toHaveText('');
    await expect(page.locator('.arrival-pending')).toHaveCount(0);
  });
});

test('Card24 prototype optional avatar, final Randomise and accepted profile save match shipped controls', async ({ page }) => {
  const lab = await openLab(page); const phone = lab.phone('A'); const code = (await lab.state()).joinCode;
  await phone.getByLabel('Room code').fill(code); await phone.getByLabel('Your name').fill('Same');
  await expect(phone.getByRole('button', { name: 'Randomise avatar', exact: true })).toBeVisible();
  await expect(phone.getByText('Your name and avatar appear on the projector in the lobby.', { exact: true })).toBeVisible();
  await phone.getByRole('button', { name: 'Join case', exact: true }).click();
  await expect(phone.getByRole('heading', { name: 'Waiting to start' })).toBeVisible();
  await phone.getByText('Change name or avatar', { exact: true }).first().click();
  await phone.getByRole('radio', { name: 'Teal', exact: true }).check();
  await phone.getByRole('radio', { name: 'Shape 4: afro', exact: true }).check();
  await phone.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(async () => Object.values((await lab.state()).participants)[0]?.avatarId).toBe('shadows-04-teal');
  await expect(phone.locator('.ctx')).not.toHaveAttribute('open', '');
});

test('Card24 prototype shows anonymous closed counts before any clinical route choice', async ({ page }) => {
  const lab = await openLab(page); await joinPhone(lab, 'A', 'Same');
  await startCase(lab); await lab.press('Reveal findings');
  await lab.press('Show decision context'); await lab.press('Reveal observations');
  await lab.press('Reveal findings'); await lab.press('Open responses');
  await lab.until(state => state.phase === 'responses_open');
  await vote(lab, 'A', 'S00175 workshop label. Record a s');
  const chart = lab.display.getByRole('region', { name: 'Responses closed', exact: true });
  await expect(chart).toHaveCount(0);
  await lab.press('Lock responses & review');
  await lab.until(state => state.phase === 'responses_locked');
  await expect(chart).toBeVisible(); await expect(chart).toContainText('1 answered');
  expect((await lab.state()).selectedPathId).toBeNull();
  await expect(lab.phone('A').getByRole('region', { name: 'Group result', exact: true })).toHaveCount(0);
});

test('Card24 prototype ranking pages preserve every option and all44px glyph controls', async ({ page }) => {
  const fixture = miniCase(), decision = fixture.doc.decisions[0];
  decision.interaction.type = 'ranking'; decision.interaction.rank_count = 8;
  while (decision.interaction.options.length < 8) decision.interaction.options.push({ id: uuidv7(), label: `Additional option ${decision.interaction.options.length + 1}` });
  decision.paths.forEach(path => { delete path.option_ids; });
  decision.rules = [{ when: { top: [fixture.o.decompress] }, path_id: fixture.p.decompress }];
  await page.route('**/src/fixtures/synthetic-workshop.case.json', route => route.fulfill({ json: fixture.doc }));
  const lab = await openLab(page); await joinPhone(lab, 'A', 'Learner');
  await expect(lab.facilitator.getByRole('button', { name: /^(Show|Hide) names on projector$/ })).toHaveCount(0);
  await lab.facilitator.getByRole('tab', { name: /Room/ }).click();
  await expect(lab.facilitator.getByText('Names and avatars appear in the lobby.', { exact: true })).toBeVisible();
  await expect(lab.facilitator.getByRole('button', { name: /^(Show|Hide) names on projector$/ })).toHaveCount(0);
  await lab.facilitator.getByRole('tab', { name: 'Run', exact: true }).click(); await startCase(lab);
  await lab.press('Show decision context'); await lab.press('Open responses'); await lab.until(state => state.phase === 'responses_open');
  const phone = lab.phone('A');
  for (const option of decision.interaction.options) await phone.getByRole('button', { name: `Add to ranking: ${option.label}`, exact: true }).click();
  const controls = phone.locator('.rank .row-btns button');
  await expect(controls).toHaveCount(24);
  for (const box of await controls.evaluateAll(elements => elements.map(element => { const r = element.getBoundingClientRect(); return { width: r.width, height: r.height }; }))) {
    expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
  }
  await phone.getByRole('button', { name: 'Send answer', exact: true }).click();
  await lab.until(state => Object.keys(state.round.responses).length === 1);
  await lab.press('Lock responses & review');
  const chart = lab.display.getByRole('region', { name: 'Responses closed', exact: true });
  await expect(lab.facilitator.getByText('Hide responses on projector before showing the next case context.', { exact: true })).toBeVisible();
  await lab.facilitator.getByRole('tab', { name: /Room/ }).click();
  await expect(lab.facilitator.getByRole('button', { name: 'Show names on projector', exact: true })).toHaveCount(0);
  await lab.facilitator.getByRole('tab', { name: 'Run', exact: true }).click();
  const seen=[];
  // CASE-327: five positions a page, so 8 ranks page 1–5 then 6–8.
  await expect(chart.locator('.ranked-label')).toHaveText(decision.interaction.options.slice(0,5).map(option=>option.label));
  seen.push(...await chart.locator('.ranked-label').allTextContents());
  for(const position of [5]){
    await lab.press('Next positions');
    await expect(chart.locator('.ranked-label')).toHaveText(decision.interaction.options.slice(position,position+5).map(option=>option.label));
    await expect(chart.locator('.ranked-rank')).toHaveText(decision.interaction.options.slice(position,position+5).map((_,index)=>String(position+index+1)));
    await expect(chart.locator('.ranked-overall')).toHaveText('1 response');seen.push(...await chart.locator('.ranked-label').allTextContents());
  }
  expect(seen).toEqual(decision.interaction.options.map(option=>option.label));
  expect(await lab.facilitator.getByRole('button',{name:'Next positions',exact:true}).isDisabled()).toBe(true);
  await lab.press('Previous positions');
  await expect(chart.locator('.ranked-continuation')).toHaveText('Positions 1–5 of 8');
  expect(await lab.facilitator.getByRole('button',{name:'Previous positions',exact:true}).isDisabled()).toBe(true);
  await lab.press('Hide responses on projector');await expect(chart).toHaveCount(0);
  await lab.press('Show responses on projector');await expect(chart.locator('.ranked-label')).toHaveText(decision.interaction.options.slice(0,5).map(option=>option.label));
  expect((await lab.state()).selectedPathId).toBeNull();
});
