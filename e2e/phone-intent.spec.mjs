// Real local Worker delivery ordering; no deployed origins or private fixture logging.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { startLocalWorker, createRoom, facilitatorCommand, serverMirror, FIXTURE } from '../tests/helpers/local-worker.mjs';
import { joinUrl } from '../src/shared/urls.mjs';
import { markFor } from '../src/client/projector-marks.mjs';

let worker;
test.beforeAll(async () => { worker = await startLocalWorker(); });
test.afterAll(async () => { await worker?.stop(); });
async function open(page) {
  const room = await createRoom(worker.origin);
  await page.goto(joinUrl(room.joinCode, worker.origin));
  await page.getByLabel('Your name', { exact: true }).fill('Sam');
  await page.getByRole('button', { name: 'Join case', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Waiting to start' })).toBeVisible();
  for (const type of ['start', 'advance', 'advance', 'advance', 'advance', 'advance'])
    expect((await facilitatorCommand(worker.origin, room, type)).receipt).toBe('accepted');
  await expect(page.locator('.decision')).toBeVisible();
  return room;
}
const option = (page, i) => page.getByRole('radio', { name: `${markFor(i).name}: ${FIXTURE.decisions[0].interaction.options[i].label}`, exact: true });

test('single-choice latest tap waits for admitted A, coalesces B/C and remains final after late old delivery', async ({ page }) => {
  const room = await open(page), sent = []; let held;
  await page.route('**/api/v1/sessions/*/commands', route => {
    const body = route.request().postDataJSON();
    if (body.type !== 'vote') return route.continue();
    sent.push({ body, headers: route.request().headers(), url: route.request().url() });
    if (sent.length === 1) held = route; else return route.continue();
  });
  await option(page, 0).check();
  await expect.poll(() => sent.length).toBe(1);
  await option(page, 1).check(); await option(page, 2).check();
  await expect(page.getByText('Not sent yet · 1', { exact: true })).toBeVisible();
  expect(sent).toHaveLength(1);
  expect(Object.keys((await serverMirror(worker.origin, room)).round.responses)).toHaveLength(0);
  await expect(page.getByText('Answer saved · you can change it until responses lock', { exact: true })).toHaveCount(0);
  await held.continue();
  await expect(page.getByText('Answer saved · you can change it until responses lock', { exact: true })).toBeVisible();
  await expect.poll(() => sent.length).toBe(2);
  expect(sent.map(row => row.body.response.option_id)).toEqual([0, 2].map(i => FIXTURE.decisions[0].interaction.options[i].id));
  expect(sent[1].body.clientEventId).not.toBe(sent[0].body.clientEventId);
  // An already admitted HTTP duplicate arriving later cannot overwrite the newest choice.
  const late = await fetch(sent[0].url, { method: 'POST', headers: { authorization: sent[0].headers.authorization, 'content-type': 'application/json' }, body: JSON.stringify(sent[0].body) });
  expect((await late.json()).receipt.receipt).toBe('already_accepted');
  expect(Object.values((await serverMirror(worker.origin, room)).round.responses).map(row => row.response)).toEqual([sent[1].body.response]);
  await expect(page.getByRole('button', { name: 'Send answer', exact: true })).toBeHidden();
  const change = page.getByRole('button', { name: 'Change decision', exact: true });
  await expect(change).toBeVisible(); await expect(option(page, 2)).toBeDisabled();
  await change.click(); await expect(option(page, 2)).toBeFocused();
  await option(page, 1).check();
  await expect.poll(() => sent.length).toBe(3);
  await expect(change).toBeVisible();
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  }
});

test('a deliberate keyboard change autosends once and accepted restore stays silent', async ({ page }) => {
  const room = await open(page), votes = [];
  page.on('request', request => { if (/\/commands$/.test(request.url()) && request.postDataJSON()?.type === 'vote') votes.push(request.postDataJSON()); });
  await option(page, 0).focus(); await option(page, 0).press('Space');
  await expect(page.getByRole('button', { name: 'Change decision', exact: true })).toBeVisible();
  expect(votes).toHaveLength(1);
  await page.getByRole('button', { name: 'Change decision', exact: true }).click();
  await option(page, 0).press('ArrowRight');
  await expect.poll(async () => Object.values((await serverMirror(worker.origin, room)).round.responses).map(row => row.response.option_id)).toEqual([FIXTURE.decisions[0].interaction.options[1].id]);
  expect(votes).toHaveLength(2);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Change decision', exact: true })).toBeVisible();
  expect(votes).toHaveLength(2, 'accepted choice restore must stay silent');
});


test('failed durable enqueue offers a real Retry decision and never reports Saved first', async ({ page }) => {
  const room=await open(page),votes=[];
  page.on('request',request=>{if(/\/commands$/.test(request.url())&&request.postDataJSON()?.type==='vote')votes.push(request.postDataJSON());});
  await page.evaluate(()=>{const original=IDBObjectStore.prototype.put;window.rejectDecisionWrite=true;
    IDBObjectStore.prototype.put=function(value,...rest){if(this.name==='votes'&&window.rejectDecisionWrite)throw new DOMException('local fixture write refusal','QuotaExceededError');return original.call(this,value,...rest);};});
  await option(page,0).check();
  await expect(page.getByText('Answer not queued · storage is unavailable or the queue is full',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Retry decision',exact:true})).toBeVisible();
  expect(votes).toHaveLength(0);expect(Object.keys((await serverMirror(worker.origin,room)).round.responses)).toHaveLength(0);
  await expect(page.getByText('Answer saved · you can change it until responses lock',{exact:true})).toHaveCount(0);
  await page.evaluate(()=>window.rejectDecisionWrite=false);
  await page.getByRole('button',{name:'Retry decision',exact:true}).click();
  await expect(page.getByRole('button',{name:'Change decision',exact:true})).toBeVisible();
  expect(votes).toHaveLength(1);
  expect(Object.values((await serverMirror(worker.origin,room)).round.responses).map(row=>row.response.option_id)).toEqual([FIXTURE.decisions[0].interaction.options[0].id]);
});
