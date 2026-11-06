import { roomNetwork } from '../tests/helpers/room-network.mjs';
// Card13 tests only the built phone against a local Worker, never a deployed origin.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { settled } from '../tests/helpers/settled.mjs';
import { startLocalWorker, createRoom, facilitatorCommand as postFacilitatorCommand, serverMirror, FIXTURE } from '../tests/helpers/local-worker.mjs';
import { joinUrl, joinEntryUrl, sessionUrl, apiPath } from '../src/shared/urls.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
import { project } from '../src/shared/room-machine.mjs';
import { markFor } from '../src/client/projector-marks.mjs';
import { strayText } from '../tests/helpers/stray-text.mjs';
import { readPdf } from '../tests/helpers/pdf-read.mjs';
import { readFileSync } from 'node:fs';

async function facilitatorCommand(...args) {
  const receipt = await postFacilitatorCommand(...args);
  expect(receipt?.receipt, JSON.stringify(receipt)).toBe('accepted');
  return receipt.receipt;
}

// The MVC fixture has a two-group arrival and a three-group first decision. Keep
// every real authority transition visible here; the vote opens only on the last,
// separate command after both public roles have received all context.
async function openMvcFirstDecision(room) {
  const send = (type) => facilitatorCommand(worker.origin, room, type);
  expect(await send('start')).toBe('accepted');
  let state = await serverMirror(worker.origin, room);
  expect(state.revealed.at(-1).groupsShown).toBe(1);
  expect(state.round).toBeNull();
  expect(await send('advance')).toBe('accepted'); // arrival findings
  state = await serverMirror(worker.origin, room);
  expect(state.revealed.at(-1).groupsShown).toBe(2);
  expect(state.round).toBeNull();
  expect(await send('advance')).toBe('accepted'); // decision scene
  state = await serverMirror(worker.origin, room);
  expect(state.revealed.at(-1).groupsShown).toBe(1);
  expect(state.round).toBeNull();
  expect(await send('advance')).toBe('accepted'); // decision observations
  expect((await serverMirror(worker.origin, room)).round).toBeNull();
  expect(await send('advance')).toBe('accepted'); // decision findings
  expect((await serverMirror(worker.origin, room)).round).toBeNull();
  expect(await send('advance')).toBe('accepted'); // Open responses, separately
  expect((await serverMirror(worker.origin, room)).phase).toBe('responses_open');
}

let worker;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => { worker = await startLocalWorker(); });
test.afterAll(async () => { await worker?.stop(); });
test.use({ viewport: { width: 390, height: 844 } });

test('served phone joins through the masked code, customizes its avatar and saves a real authored answer', async ({ page }, testInfo) => {
  const room = await createRoom(worker.origin), requests = [], payloads = [];
  page.on('request', request => requests.push(request.url()));
  page.on('response', async response => {
    if (!/\/(snapshot|updates)(?:\?|$)/.test(response.url())) return;
    const body = await response.json().catch(() => null);if(body?.t==='snapshot')payloads.push(body);
  });
  page.on('websocket', socket => socket.on('framereceived', ({payload}) => {
    try{const body=JSON.parse(String(payload));if(body.t==='snapshot')payloads.push(body);}catch{/* fixed ping/pong */}
  }));
  await page.goto(joinUrl(room.joinCode, worker.origin));
  await expect(page.getByRole('heading', { name: 'Join the case' })).toBeVisible();
  await page.getByRole('button', { name: 'Change code' }).click(); // a prefilled code is one line until Change opens it (card 36a)
  const code = page.getByLabel('Session code');
  await code.fill('');
  await code.pressSequentially(room.joinCode.toLowerCase().slice(0, 3) + '-' + room.joinCode.slice(3));
  await expect(code).toHaveValue(room.joinCode);
  await expect(page.getByText('6 of 6 characters')).toBeVisible();
  await page.getByLabel('Your name', { exact: true }).fill('Sam');
  await page.getByText('Change avatar', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Randomise avatar', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Join case', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Waiting to start' })).toBeVisible();
  await expect(page.locator('#lobbyH')).toBeVisible();
  await page.getByText('Change name or avatar', { exact: true }).first().click();
  await page.getByRole('radio', { name: 'Teal', exact: true }).check();
  await page.getByRole('radio', { name: 'Shape 4: afro', exact: true }).check();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(async () => Object.values((await serverMirror(worker.origin, room)).participants)[0]?.avatarId).toBe('shadows-04-teal');
  await expect(page.locator('.ctx')).not.toHaveAttribute('open', '');
  await openMvcFirstDecision(room);
  const mirror = await serverMirror(worker.origin, room), decision = FIXTURE.decisions.find(row => row.id === mirror.decisionId);
  await page.getByRole('radio', { name: `${markFor(0).name}: ${decision.interaction.options[0].label}`, exact: true }).check();
  await expect(page.getByText('Answer saved · you can change it until responses lock', { exact: true })).toBeVisible();
  await expect(page.locator('#lobbyH')).toBeHidden();
  await expect.poll(async () => Object.keys((await serverMirror(worker.origin, room)).round.responses).length).toBe(1);
  expect(requests.every(url => !url.includes('Sam') && !url.includes(room.facilitatorToken))).toBe(true);
  expect(requests.some(url => /case-pack/.test(url))).toBe(false);
  await expect.poll(()=>payloads.length).toBeGreaterThan(2);
  for(const body of payloads){
    expect(body.view.role).toBe('participant');
    expect(JSON.stringify(body)).not.toMatch(/"(?:mirror|casePack|caseDoc|paths|cue|rationale|participants|answers|aggregate|suggestion|surfaces|decisions|spine|flags)"\s*:/);
    const publicIds=new Set([body.view.liveSurface?.surfaceId,...body.view.timeline.map(surface=>surface.surfaceId)]);
    for(const surface of FIXTURE.surfaces.filter(surface=>!publicIds.has(surface.id)))expect(JSON.stringify(body.view)).not.toContain(surface.id);
  }
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    // Contrast is read once the Send answer button's and the theme's colour transitions settle (1.98:1 mid-way).
    await settled(page);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`phone-${theme}.png`), fullPage: true });
  }
});

async function joinPhone(page, room, name = 'Sam') {
  await page.goto(joinUrl(room.joinCode, worker.origin));
  await page.getByLabel('Your name', { exact: true }).fill(name);
  await page.getByText('Change avatar', { exact: true }).click();
  await page.getByRole('radio', { name: 'Wine, curls', exact: true }).check();
  await page.getByRole('button', { name: 'Join case', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Waiting to start' })).toBeVisible();
}

async function queuedResponses(page, roomId) {
  return page.evaluate(roomId => new Promise((resolve, reject) => {
    const opened = indexedDB.open('case:phone-outbox', 1);
    opened.onerror = () => reject(opened.error);
    opened.onsuccess = () => {
      const db = opened.result;
      const tx = db.transaction('votes', 'readonly');
      const rows = tx.objectStore('votes').index('roomId').getAll(roomId);
      tx.oncomplete = () => {
        db.close();
        resolve(rows.result.filter(row => !row.superseded).map(row => row.envelope.response));
      };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
    };
  }), roomId);
}

test('[AS-082] served offline votes survive reload counts-only and send the latest once after a real closed IDB handle reopens', async ({ page, context }) => {
  const outage = await roomNetwork(context);
  await page.addInitScript(() => {
    const transaction = IDBDatabase.prototype.transaction;
    let closed = false;
    IDBDatabase.prototype.transaction = function(stores, mode, ...rest) {
      if (!closed && this.name === 'case:phone-outbox' && mode === 'readwrite') { closed = true; this.close(); }
      return transaction.call(this, stores, mode, ...rest);
    };
  });
  const room = await createRoom(worker.origin);
  await joinPhone(page, room);
  for (const [step, type] of [['Start', 'start'], ['Arrival findings', 'advance'],
    ['Decision scene', 'advance'], ['Decision observations', 'advance'],
    ['Decision findings', 'advance'], ['Open responses', 'advance']])
    expect(await facilitatorCommand(worker.origin, room, type), step).toBe('accepted');
  const mirror = await serverMirror(worker.origin, room), current = FIXTURE.decisions.find(row => row.id === mirror.decisionId);
  expect(mirror.phase).toBe('responses_open');
  const radios = page.getByRole('radio');
  await expect(radios).toHaveCount(current.interaction.options.length);
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await outage.offline(page);
  await expect(page.getByText('Connection lost', { exact: false }).first()).toBeVisible();
  for (let i = 0; i < 3; i++) {
    await page.getByRole('radio', { name: `${markFor(i).name}: ${current.interaction.options[i].label}`, exact: true }).check();
    await expect(page.getByText('Not sent yet · 1', { exact: true })).toBeVisible();
    await expect.poll(() => queuedResponses(page, room.sessionId)).toEqual([
      { option_id: current.interaction.options[i].id },
    ]);
  }
  expect(Object.keys((await serverMirror(worker.origin, room)).round.responses)).toHaveLength(0);
  await page.reload();
  await expect(page.getByText('Not sent yet · 1', { exact: true })).toBeVisible();
  await expect(page.getByRole('radio')).toHaveCount(0);
  const receipts = [];
  page.on('response', async response => { if (/\/commands$/.test(response.url())) { const body = await response.json().catch(() => null); if (body?.receipt?.receipt === 'accepted') receipts.push(body); } });
  await outage.online();
  await expect(page.getByText('Answer saved · you can change it until responses lock', { exact: true })).toBeVisible();
  await expect.poll(async () => Object.values((await serverMirror(worker.origin, room)).round.responses).map(row => row.response)).toEqual([{ option_id: current.interaction.options[2].id }]);
  await expect(page.getByText('Not sent yet · 1', { exact: true })).toHaveCount(0);
  await expect.poll(() => receipts.length).toBe(1);
});

function interactionFixture(type) {
  const document = structuredClone(FIXTURE), decision = document.decisions[0], options = decision.interaction.options;
  decision.interaction.type = type;
  for (const path of decision.paths) delete path.option_ids;
  const when = type === 'multi_select' ? { includes_all: options.slice(0, 2).map(row => row.id) }
    : type === 'ranking' ? { top: [options[1].id] } : { keywords: ['simulation'] };
  decision.rules = [{ when, path_id: decision.fallback_path_id }];
  if (type === 'ranking') decision.interaction.rank_count = 2;
  if (type === 'free_text') { decision.interaction = { type, max_length: 280 }; }
  return document;
}
// D26: ranking every option leaves no options to add, and the phone once printed the missing Add list as "null" under
// the last ranked option. Every question kind is checked for stray text when it opens and once the answer is saved.
test('[AS-052] D26: a phone ranking of every option shows only the ranked options, with no stray text, before and after sending', async ({ page }) => {
  const document = interactionFixture('ranking'); delete document.decisions[0].interaction.rank_count;
  const room = await createRoom(worker.origin, { caseDocument: document });
  await joinPhone(page, room);
  await openMvcFirstDecision(room);
  const options = document.decisions[0].interaction.options;
  for (const option of options) if (await page.getByRole('button', { name: `Add to ranking: ${option.label}`, exact: true }).count()) await page.getByRole('button', { name: `Add to ranking: ${option.label}`, exact: true }).click();
  await expect(page.locator('.rank li')).toHaveCount(options.length);
  await expect(page.locator('.avail')).toHaveCount(0);
  expect(await page.evaluate(strayText), 'every option ranked').toEqual([]);
  await page.getByRole('button', { name: 'Send answer', exact: true }).click();
  await expect(page.getByText('Answer saved · you can change it until responses lock', { exact: true })).toBeVisible();
  expect(await page.evaluate(strayText), 'after sending').toEqual([]);
});
for (const type of ['multi_select', 'ranking', 'free_text']) test(`served phone sends real ${type} controls with authored order and accessible movement or identifier warning`, async ({ page }) => {
  const document = interactionFixture(type), room = await createRoom(worker.origin, { caseDocument: document });
  await joinPhone(page, room);
  await openMvcFirstDecision(room);
  const current = document.decisions[0];
  expect(await page.evaluate(strayText), `${type}: no stray text when the question opens (D26)`).toEqual([]);
  let response;
  if (type === 'multi_select') {
    const names = current.interaction.options.map((option, i) => `${markFor(i).name}: ${option.label}`);
    await expect(page.getByRole('checkbox')).toHaveCount(names.length);
    for (let i = 0; i < names.length; i++) await expect(page.getByRole('checkbox').nth(i)).toHaveAccessibleName(names[i]);
    for (const name of names.slice(0, 2)) await page.getByRole('checkbox', { name, exact: true }).check();
    response = { option_ids: current.interaction.options.slice(0, 2).map(row => row.id) };
  } else if (type === 'ranking') {
    for (const option of current.interaction.options.slice(0, 2)) await page.getByRole('button', { name: `Add to ranking: ${option.label}`, exact: true }).click();
    const move = page.getByRole('button', { name: `Move up: ${current.interaction.options[1].label}`, exact: true });
    await expect(move).toHaveText('↑');
    const row = move.locator('xpath=ancestor::li');
    const controls = row.locator('.row-btns button');
    await expect(controls).toHaveCount(3);
    await expect(controls.nth(0)).toHaveText('↑');
    await expect(controls.nth(1)).toHaveText('↓');
    await expect(controls.nth(2)).toHaveText('×');
    await expect(controls.nth(2)).toHaveAccessibleName(`Remove from ranking: ${current.interaction.options[1].label}`);
    // D24 (CASE-265): the controls share the rank number's line, above the full-width label.
    const posBox = await row.locator('.pos').boundingBox(), labelBox = await row.locator('.lbl').boundingBox(), boxes = await controls.evaluateAll(elements => elements.map(element => {
      const {x,y,width,height}=element.getBoundingClientRect();return {x,y,width,height};
    }));
    for (const box of boxes) {
      expect(box.width).toBeGreaterThanOrEqual(44);expect(box.height).toBeGreaterThanOrEqual(44);
      expect(Math.min(box.y+box.height,posBox.y+posBox.height)).toBeGreaterThan(Math.max(box.y,posBox.y));
      expect(box.y+box.height).toBeLessThanOrEqual(labelBox.y+1);
      expect(Math.abs(box.y-boxes[0].y)).toBeLessThan(1);
    }
    await controls.nth(2).focus();await expect(controls.nth(2)).toBeFocused();
    await move.click();
    response = { order: current.interaction.options.slice(0, 2).reverse().map(row => row.id) };
  } else {
    await page.getByRole('textbox', { name: current.prompt }).fill('Mr Smith 123456 simulation');
    await expect(page.getByText('This looks like it may contain a name and a record number. Do not enter patient details.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send answer', exact: true })).toBeEnabled();
    response = { text: 'Mr Smith 123456 simulation' };
  }
  await page.getByRole('button', { name: 'Send answer', exact: true }).click();
  await expect(page.getByText('Answer saved · you can change it until responses lock', { exact: true })).toBeVisible();
  await expect.poll(async () => Object.values((await serverMirror(worker.origin, room)).round.responses).map(row => row.response)).toEqual([response]);
  expect(await page.evaluate(strayText), `${type}: no stray text once saved (D26)`).toEqual([]);
  await facilitatorCommand(worker.origin,room,'lock');
  await facilitatorCommand(worker.origin,room,'select_path',{pathId:current.paths[0].id});
  await facilitatorCommand(worker.origin,room,'show_results',{on:false});
  await facilitatorCommand(worker.origin,room,'reveal');
  await expect(page.getByRole('region',{name:'Group result'})).toBeVisible();
  await expect(page.getByRole('region',{name:'Group result'})).not.toContainText('The facilitator');
  if(type==='free_text')await expect(page.getByText('Your answer was submitted',{exact:true})).toBeVisible();
});

test('served phone content sits flush under its header with no page-ground gap', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const room = await createRoom(worker.origin);
  await joinPhone(page, room);
  const gap = await page.evaluate(() => {
    const app = document.querySelector('.phone-app'), main = app.querySelector('main');
    const above = [...app.children].filter(child => child !== main && child.getBoundingClientRect().height > 0 &&
      child.getBoundingClientRect().bottom <= main.getBoundingClientRect().top + 0.5);
    const edge = Math.max(...above.map(child => child.getBoundingClientRect().bottom + parseFloat(getComputedStyle(child).marginBottom)));
    return { top: Math.round(main.getBoundingClientRect().top - edge), bottom: Math.round(app.getBoundingClientRect().bottom - main.getBoundingClientRect().bottom) };
  });
  expect(gap).toEqual({ top: 0, bottom: 0 });
});

test('served privacy notice uses the approved seven-day copy and returns the public code draft in the same tab', async ({ page },testInfo) => {
  await page.addInitScript(()=>addEventListener('pageshow',event=>{window.__casePageShowPersisted=event.persisted;}));
  const room = await createRoom(worker.origin);
  await page.goto(joinUrl(room.joinCode, worker.origin));
  await page.getByLabel('Your name', { exact: true }).fill('Private draft');
  const privacy = page.getByRole('link', { name: 'Privacy', exact: true });
  const box = await privacy.boundingBox(); expect(box.height).toBeGreaterThanOrEqual(44);
  await privacy.click();
  await expect(page.getByRole('heading', { name: 'Privacy and data notice', exact: true })).toBeVisible();
  await expect(page.getByText('Names and per-person answers in the live room and session records are deleted within 25 hours after the session ends. Encrypted backups and connection logs expire within 7 days.', { exact: true })).toBeVisible();
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    // Contrast is read once the Send answer button's and the theme's colour transitions settle (1.98:1 mid-way).
    await settled(page);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  }
  expect(page.url()).not.toContain('Private');
  await page.getByRole('link', { name: 'Back to join', exact: true }).click();
  await expect(page.getByLabel('Session code')).toHaveValue(room.joinCode);
  await expect(page.getByLabel('Your name', { exact: true })).toHaveValue('');
  await page.getByRole('link',{name:'Privacy',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Privacy and data notice',exact:true})).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading',{name:'Join the case',exact:true})).toBeVisible();
  const persisted=await page.evaluate(()=>window.__casePageShowPersisted===true);
  testInfo.annotations.push({type:'native-back-pageshow',description:`persisted=${persisted}`});
  console.log(`Card13 native Back pageshow persisted=${persisted}`);
  await expect(page.getByLabel('Session code')).toHaveValue(room.joinCode);
  await expect(page.getByLabel('Your name',{exact:true})).toHaveValue('');
});

test('served phone delivers a held answer then renders only its private recap with local print fallback and expiry cleanup', async ({ page, browser }) => {
  const document = interactionFixture('free_text'), room = await createRoom(worker.origin, { caseDocument: document });
  await joinPhone(page, room);
  await openMvcFirstDecision(room);
  const decision = document.decisions[0], held = [];
  let hold = true;
  await page.route('**/api/v1/sessions/*/commands', route => {
    if (hold && route.request().postDataJSON()?.type === 'vote') held.push(route); else route.continue();
  });
  await page.getByRole('textbox', { name: decision.prompt }).fill('Own simulation answer');
  await page.getByRole('button', { name: 'Send answer', exact: true }).click();
  await expect.poll(() => held.length).toBeGreaterThan(0);
  expect(Object.keys((await serverMirror(worker.origin, room)).round.responses)).toHaveLength(0);
  hold = false;
  for (const route of held) await route.continue().catch(() => {});
  await expect(page.getByText('Answer saved · you can change it until responses lock', { exact: true })).toBeVisible();
  const otherResponse = await fetch(worker.origin + apiPath('join'), { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ v: 1, code: room.joinCode, displayName: 'Robin', avatarId: 'shadows-02' }) });
  expect(otherResponse.status).toBe(201); const other = await otherResponse.json();
  const mirror = await serverMirror(worker.origin, room);
  const answer = await fetch(worker.origin + apiPath('sessions', room.sessionId, 'commands'), { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${other.token}` },
    body: JSON.stringify({ v: 1, type: 'vote', epoch: mirror.epoch, clientEventId: uuidv7(), roundId: mirror.round.id, response: { text: 'Other participant secret' } }) });
  expect((await answer.json()).receipt.receipt).toBe('accepted');
  expect(await facilitatorCommand(worker.origin, room, 'lock')).toBe('accepted');
  await expect(page.getByText('Your answer (locked): Own simulation answer', { exact: true })).toBeVisible();
  expect(await facilitatorCommand(worker.origin, room, 'select_path', { pathId: decision.fallback_path_id })).toBe('accepted');
  expect(await facilitatorCommand(worker.origin, room, 'show_results', { on: false })).toBe('accepted');
  expect(await facilitatorCommand(worker.origin, room, 'reveal')).toBe('accepted');
  await expect(page.getByText('Other participant secret', { exact: false })).toHaveCount(0);
  expect(await facilitatorCommand(worker.origin, room, 'enter_manual', { segmentId: uuidv7() })).toBe('accepted');
  await expect(page.getByText('Facilitator-led discussion · phone answers are off for now', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send answer', exact: true })).toHaveCount(0);
  expect(await facilitatorCommand(worker.origin, room, 'end')).toBe('accepted');
  await expect(page.getByRole('heading', { name: 'Your private recap', exact: true })).toBeVisible();
  await expect(page.getByText('Your answer: Own simulation answer', { exact: true })).toBeVisible();
  await expect(page.getByText('Other participant secret', { exact: false })).toHaveCount(0);
  // Room PDFs v2: the Finish block leads the ended screen; without a feedback code it has the record but no ratings. The title
  // never names the participant.
  await expect(page.getByRole('heading', { name: 'Your participant record', exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'The session', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Give feedback', exact: true })).toHaveCount(0);
  // Julian's ruling 2 (2026-10-17): Download recap (PDF) is always offered.
  await expect(page.getByRole('button', { name: 'Download recap (PDF)', exact: true })).toBeVisible();
  expect(await page.locator('.recap-actions > *').first().evaluate(node => node.textContent)).toBe('Download recap (PDF)');
  expect(await page.title()).not.toContain('Sam');
  const requests = [];
  page.on('request', request => requests.push(request.url()));
  await page.evaluate(() => { window.__printed = 0; window.print = () => window.__printed++; });
  // Download builds the built-in tagged PDF in a lazy chunk: Objectives, then The Case, this phone's own answer, and no
  // name, other participant's answer, token or URL.
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download recap (PDF)', exact: true }).click()]);
  expect(download.suggestedFilename()).toMatch(/^.+ – Recap – \d{4}-\d{2}-\d{2}\.pdf$/); // case title, document, date (room PDFs v2)
  const pdf = readPdf(new Uint8Array(readFileSync(await download.path()))), lines = pdf.lines.map(line => line.replace(/\s+/g, ' ').trim()), text = lines.join('\n');
  expect(lines.indexOf('Objectives')).toBeGreaterThan(0);
  expect(lines.indexOf('The Case')).toBeGreaterThan(lines.indexOf('Objectives'));
  expect(text).toContain('Own simulation answer');
  for (const leak of ['Sam', 'Other participant secret', 'http', room.joinCode, room.sessionId]) expect(text.includes(leak) || pdf.text.includes(leak), leak).toBe(false);
  await page.getByRole('button', { name: 'Print recap', exact: true }).click();
  expect(await page.evaluate(() => window.__printed)).toBe(1);
  // Nothing is sent: the only requests are the lazy recap chunk and the writer it loads, both hashed static assets.
  expect(requests.filter(url => !new URL(url).pathname.startsWith('/assets/'))).toEqual([]);
  expect(requests.some(url => /\/assets\/recap-pdf\.[0-9a-f]+\.mjs$/.test(new URL(url).pathname))).toBe(true);
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByRole('button', { name: 'Download recap (PDF)', exact: true })).toBeHidden();
  await expect(page.getByText('Your answer: Own simulation answer', { exact: true })).toBeVisible();
  await page.emulateMedia({ media: 'screen' });
  // With the room's feedback code, the Finish block shows the three ratings, and End brings no feedback read: nothing is asked of
  // the feedback API until this phone saves something.
  await page.route(/\/api\/v1\/sessions\/[^/]+\/(snapshot|updates)(?:\?|$)/, async route => {
    const response = await route.fetch(), body = await response.json().catch(() => null);
    if (body?.view?.recap) Object.assign(body.view.recap, { feedbackCode: '7K3QX9', facilitator: 'Julian Ming, Emergency registrar' });
    await route.fulfill(body ? { response, json: body } : { response });
  });
  // Reads go over HTTP after the reload, so the routed snapshot carries the code (as the served terminal tests do).
  await page.addInitScript(() => { window.WebSocket = class { constructor() { throw new Error('local fixture uses HTTP reads'); } }; });
  const feedbackReads = [];
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/v1/feedback/')) feedbackReads.push(request.url()); });
  await page.reload();
  await expect(page.getByRole('group', { name: 'The session', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download participant record (PDF)', exact: true })).toBeVisible();
  // The facilitator who ran the room is prefilled from the ended recap, and stays editable (Julian, 2026-10-18).
  await expect(page.getByLabel('Facilitator and organisation', { exact: true })).toHaveValue('Julian Ming, Emergency registrar');
  await expect(page.getByLabel('Facilitator and organisation', { exact: true })).toBeEditable();
  await expect(page.getByRole('link', { name: 'Give feedback', exact: true })).toHaveCount(0);
  expect(feedbackReads).toEqual([]);
  await page.unrouteAll({ behavior: 'ignoreErrors' }); // a long poll may still be in flight
  // A different storage partition cannot recover another browser's private recap.
  const partition = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const isolated = await partition.newPage(), writes = [];
    isolated.on('request', request => { if (request.method() === 'POST') writes.push(request.url()); });
    await isolated.goto(sessionUrl(room.sessionId, 'recap', worker.origin));
    await expect(isolated.getByRole('heading', { name: 'Your saved place is unavailable', exact: true })).toBeVisible();
    await expect(isolated.getByRole('link', { name: 'Enter a session code', exact: true })).toHaveAttribute('href', joinEntryUrl(worker.origin));
    await expect(isolated.getByRole('button', { name: 'Join case', exact: true })).toHaveCount(0);
    await expect(isolated.getByText('This browser no longer has your saved place. To rejoin a session that is still open, enter its code.', { exact: true })).toBeVisible();
    await expect(isolated.getByText("Open in your browser or use mobile data if this page won't load", { exact: true })).toBeVisible();
    await expect(isolated.getByText('Own simulation answer', { exact: false })).toHaveCount(0);
    expect(writes).toEqual([]);
  } finally { await partition.close(); }
  const recapOwner = Object.entries(mirror.participants).find(([, person]) => person.name === 'Sam')[0];
  const recapKey = `case:participant:${room.sessionId}:token`;
  expect(await page.evaluate(key => localStorage.getItem(key), recapKey)).not.toBeNull();
  await page.evaluate(key => { const record = JSON.parse(localStorage.getItem(key)); record.expiresAt = 1; localStorage.setItem(key, JSON.stringify(record)); }, recapKey);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your saved place is unavailable', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Enter a session code', exact: true })).toHaveAttribute('href', joinEntryUrl(worker.origin));
  await expect(page.getByRole('button', { name: 'Join case', exact: true })).toHaveCount(0);
  await expect(page.getByText('This browser no longer has your saved place. To rejoin a session that is still open, enter its code.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('case:participant:main:token'))).toBeNull();
  expect(await page.evaluate(key => localStorage.getItem(key), recapKey)).toBeNull();
  await expect.poll(() => page.evaluate(async ({ roomId, owner }) => {
    const names = (await indexedDB.databases()).map(db => db.name).filter(name => /^(case:|case-lab:)/.test(name));
    if (!names.includes('case:phone-outbox')) return { names, owned: [] };
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('case:phone-outbox', 1); request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction('votes', 'readonly'), read = tx.objectStore('votes').index('roomId').getAll(roomId);
        tx.oncomplete = () => { db.close(); resolve({ names, owned: read.result.filter(row => row.participantId === owner) }); };
        tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
  }, { roomId: room.sessionId, owner: recapOwner }).then(result => ({ known: result.names.every(name => name === 'case:phone-outbox'), owned: result.owned }))).toEqual({ known: true, owned: [] });
});

test('served QR recovery preserves counts on 503 and retries the same room before any private draft or queued send', async ({ page }) => {
  const document = interactionFixture('free_text'), room = await createRoom(worker.origin, { caseDocument: document });
  await joinPhone(page, room);
  await openMvcFirstDecision(room);
  let abortVotes = true, recoveryMode = 'malformed', commands = 0, commandsAtRecovery = 0;
  const recoveryModes = [];
  await page.route('**/api/v1/sessions/*/commands', route => {
    if (route.request().postDataJSON()?.type === 'vote') { commands++; if (abortVotes) return route.abort('connectionfailed'); }
    return route.continue();
  });
  await page.getByRole('textbox', { name: document.decisions[0].prompt }).fill('Queued private answer');
  await page.getByRole('button', { name: 'Send answer', exact: true }).click();
  await expect(page.getByText('Not sent yet · 1', { exact: true })).toBeVisible();
  await expect.poll(() => commands).toBeGreaterThan(0);
  const durableState = () => page.evaluate(roomId => new Promise((resolve, reject) => {
    const tokenKeys = ['case:participant:main:token', `case:participant:${roomId}:token`];
    const tokens = tokenKeys.map(key => [key, localStorage.getItem(key)]);
    const request = indexedDB.open('case:phone-outbox', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('votes', 'readonly');
      const read = tx.objectStore('votes').index('roomId').getAll(roomId);
      tx.oncomplete = () => { db.close(); resolve({ tokens, rows: JSON.stringify(read.result) }); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
    };
  }), room.sessionId);
  const savedState = await durableState(), savedRows = JSON.parse(savedState.rows);
  expect(savedState.tokens.some(([, token]) => token !== null)).toBe(true);
  expect(savedRows).toHaveLength(1);
  const queuedEventId = savedRows[0].envelope.clientEventId;
  await page.route('**/api/v1/join/recover', async route => {
    expect(route.request().postDataJSON()).toEqual({ code: room.joinCode, sessionId: room.sessionId });
    expect(route.request().headers().authorization).toMatch(/^Bearer /);
    commandsAtRecovery = commands;
    recoveryModes.push(recoveryMode);
    if (recoveryMode === 'malformed') await route.fulfill({ status: 200, contentType: 'application/json', body: '{"sessionId":' });
    else if (recoveryMode === '503') await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'unavailable' }) });
    else await route.continue();
  });
  await page.goto(joinUrl(room.joinCode, worker.origin));
  await expect(page.getByRole('heading', { name: 'Recovery unavailable', exact: true })).toBeVisible();
  await expect(page.getByText('Not sent yet · 1', { exact: true })).toBeVisible();
  await expect(page.getByText('Queued private answer', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: document.decisions[0].prompt })).toHaveCount(0);
  expect(commands).toBe(commandsAtRecovery);
  expect(Object.keys((await serverMirror(worker.origin, room)).round.responses)).toHaveLength(0);
  expect(recoveryModes).toEqual(['malformed']);
  expect(await durableState()).toEqual(savedState);
  recoveryMode = '503';
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect.poll(() => recoveryModes).toEqual(['malformed', '503']);
  await expect(page.getByRole('heading', { name: 'Recovery unavailable', exact: true })).toBeVisible();
  await expect(page.getByText('Not sent yet · 1', { exact: true })).toBeVisible();
  await expect(page.getByText('Queued private answer', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: document.decisions[0].prompt })).toHaveCount(0);
  expect(commands).toBe(commandsAtRecovery);
  expect(Object.keys((await serverMirror(worker.origin, room)).round.responses)).toHaveLength(0);
  expect(await durableState()).toEqual(savedState);
  recoveryMode = 'real'; abortVotes = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByText('Answer saved · you can change it until responses lock', { exact: true })).toBeVisible();
  const mirror = await serverMirror(worker.origin, room);
  expect(Object.keys(mirror.participants)).toHaveLength(1);
  expect(Object.values(mirror.round.responses).map(row => row.response)).toEqual([{ text: 'Queued private answer' }]);
  expect(Object.values(mirror.round.responses).map(row => row.clientEventId)).toEqual([queuedEventId]);
  expect(recoveryModes).toEqual(['malformed', '503', 'real']);
});

test('served foreign QR recovery preserves the previous room capability and durable answers without resuming private state', async ({ page }) => {
  const room = await createRoom(worker.origin), foreign = await createRoom(worker.origin);
  await joinPhone(page, room);
  await openMvcFirstDecision(room);
  await page.route('**/api/v1/sessions/*/commands', route => route.request().postDataJSON()?.type === 'vote' ? route.abort('connectionfailed') : route.continue());
  const current = FIXTURE.decisions.find(row => row.id === FIXTURE.decisions[0].id);
  await page.getByRole('radio', { name: `${markFor(0).name}: ${current.interaction.options[0].label}`, exact: true }).check();
  await expect(page.getByText('Not sent yet · 1', { exact: true })).toBeVisible();
  const credentialKey = `case:participant:${room.sessionId}:token`;
  const credential = await page.evaluate(key => localStorage.getItem(key), credentialKey);
  expect(credential).not.toBeNull();
  const durableRows = () => page.evaluate(roomId => new Promise((resolve, reject) => {
    const request = indexedDB.open('case:phone-outbox', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('votes', 'readonly');
      const read = tx.objectStore('votes').index('roomId').getAll(roomId);
      tx.oncomplete = () => { db.close(); resolve(read.result); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
    };
  }), room.sessionId);
  const before = await durableRows(); expect(before).toHaveLength(1);
  expect(before[0].envelope.response).toEqual({ option_id: current.interaction.options[0].id });
  const joins = [], oldPrivateRequests = []; let publicReady = false;
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === apiPath('join')) joins.push(request.url());
    if (publicReady && request.url().includes(`/api/v1/sessions/${room.sessionId}/`)) oldPrivateRequests.push(request.url());
  });
  await page.goto(joinUrl(foreign.joinCode, worker.origin));
  await expect(page.getByRole('heading', { name: 'Join the case', exact: true })).toBeVisible(); publicReady = true;
  await expect(page.getByLabel('Session code')).toHaveValue(foreign.joinCode);
  expect(await page.evaluate(() => localStorage.getItem('case:participant:main:token'))).toBeNull();
  await expect(page.getByText('Not sent yet · 1', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('radio')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send answer', exact: true })).toHaveCount(0);
  await expect(page.getByText('Sam', { exact: true })).toHaveCount(0);
  const body = await page.locator('body').innerText();
  expect(body).not.toContain(JSON.parse(credential).token); expect(body).not.toContain(before[0].envelope.clientEventId);
  expect(page.url()).not.toContain(JSON.parse(credential).token); expect(page.url()).not.toContain(before[0].envelope.clientEventId);
  expect(await page.evaluate(key => localStorage.getItem(key), credentialKey)).toBe(credential);
  expect(await durableRows()).toEqual(before);
  expect(Object.keys((await serverMirror(worker.origin, room)).round.responses)).toHaveLength(0);
  expect(Object.keys((await serverMirror(worker.origin, foreign)).participants)).toHaveLength(0);
  await expect.poll(() => page.evaluate(async () => (await indexedDB.databases()).some(db => db.name === 'case:phone-outbox'))).toBe(true);
  await page.waitForTimeout(1200); // Existing transport retry callbacks must remain unbound on the public QR page.
  expect(oldPrivateRequests).toEqual([]); expect(joins).toEqual([]);
  expect(await page.evaluate(key => localStorage.getItem(key), credentialKey)).toBe(credential);
  expect(await durableRows()).toEqual(before);
});

for(const terminal of ['removal','removed snapshot','401','recap expiry']) test(`served ${terminal} wipes participant storage and leaves a stable public status without private callbacks`,async({page})=>{
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(()=>{window.WebSocket=class {constructor(){throw new Error("local fixture uses HTTP reads");}};});
 const room=await createRoom(worker.origin);let deny=false,expire=false,removedSnapshot=false,readsClosed=false;
 await page.route(/\/api\/v1\/sessions\/[^/]+\/(snapshot|updates)(?:\?|$)/,async route=>{
  let response;try{response=await route.fetch();}catch(error){if(readsClosed)return;throw error;}
  if(readsClosed)return;
  if(deny)return route.fulfill({status:401,contentType:'application/json',body:'{"error":"unauthorised"}'});
  const body=await response.json().catch(()=>null);
  if(removedSnapshot&&body?.t==='snapshot'){
   const state={...await serverMirror(worker.origin,room),caseDoc:FIXTURE},participantId=body.view.you.id;
   state.participants[participantId].removedAt=new Date().toISOString();body.view=project(state,'participant',participantId);
  }
  if(expire&&body?.view?.recap)body.view.recap.expiresAt=new Date(Date.now()+300).toISOString();
  await route.fulfill(body?{response,json:body}:{response});
 });
 await joinPhone(page,room,'Private participant');
 await page.evaluate(()=>{window.__oldPhoneMain=document.querySelector('main#main');});
 const capturedKey=`case:participant:${room.sessionId}:token`,capturedCredential=await page.evaluate(key=>localStorage.getItem(key),capturedKey);
 expect(capturedCredential).not.toBeNull();
 const capturedOwner=Object.keys((await serverMirror(worker.origin,room)).participants)[0];expect(capturedOwner).toBeTruthy();
 if(terminal==='recap expiry') {expire=true;await facilitatorCommand(worker.origin,room,'end');}
 else {
  await openMvcFirstDecision(room);
  await page.route('**/api/v1/sessions/*/commands',route=>route.request().postDataJSON()?.type==='vote'?route.abort('connectionfailed'):route.continue());
  const decision=FIXTURE.decisions[0];
  await page.getByRole('radio',{name:`${markFor(0).name}: ${decision.interaction.options[0].label}`,exact:true}).check();
  await expect(page.getByText('Not sent yet · 1',{exact:true})).toBeVisible();
  if(terminal==='removal') {
   const mirror=await serverMirror(worker.origin,room),participantId=Object.keys(mirror.participants)[0];
   await facilitatorCommand(worker.origin,room,'remove_participant',{participantId});
  } else {if(terminal==='401')deny=true;else removedSnapshot=true;await facilitatorCommand(worker.origin,room,'set_timer',{seconds:60});}
 }
 const heading=terminal==='removed snapshot'?'You were removed from this session':terminal==='recap expiry'?'Your recap has expired':'Your saved place is unavailable';
 await expect(page.getByRole('heading',{name:heading,exact:true})).toBeVisible();
 await expect(page.getByRole('link',{name:'Enter a session code',exact:true})).toBeVisible();
 expect(await page.evaluate(()=>localStorage.getItem('case:participant:main:token'))).toBeNull();
 expect(await page.evaluate(()=>window.__oldPhoneMain.childElementCount)).toBe(0);
 expect(await page.evaluate(key=>localStorage.getItem(key),capturedKey)).toBeNull();
 await expect.poll(()=>page.evaluate(async({roomId,owner})=>{
  const names=(await indexedDB.databases()).map(db=>db.name).filter(name=>/^(case:|case-lab:)/.test(name));
  if(!names.includes('case:phone-outbox'))return {names,owned:[]};
  return new Promise((resolve,reject)=>{const request=indexedDB.open('case:phone-outbox',1);request.onerror=()=>reject(request.error);request.onsuccess=()=>{
   const db=request.result,tx=db.transaction('votes','readonly'),read=tx.objectStore('votes').index('roomId').getAll(roomId);
   tx.oncomplete=()=>{db.close();resolve({names,owned:read.result.filter(row=>row.participantId===owner)});};tx.onerror=tx.onabort=()=>{db.close();reject(tx.error);};
  };});
 },{roomId:room.sessionId,owner:capturedOwner}).then(result=>({known:result.names.every(name=>name==='case:phone-outbox'),owned:result.owned}))).toEqual({known:true,owned:[]});
 await expect(page.getByText('Private participant',{exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Send answer',exact:true})).toHaveCount(0);
 // The public status remains after the interrupted read/send has settled.
 await page.waitForTimeout(1200);
 await expect(page.getByRole('heading',{name:heading,exact:true})).toBeVisible();expect(errors).toEqual([]);
 readsClosed=true;await page.close();
});
