// Participant feedback page (CASE-284 slice 4): the built /F document served by local workerd, with the feedback API
// and the vendor challenge as explicit local fakes. The routes themselves are proven in tests/worker/feedback-runtime.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { startLocalWorker } from '../tests/helpers/local-worker.mjs';
import { feedbackUrl, apiPath, turnstileWidgetScriptUrl } from '../src/shared/urls.mjs';
import { newCapabilityToken, newJoinCode, uuidv7 } from '../src/shared/ids.mjs';
import { readFile } from 'node:fs/promises';
import { readPdf } from '../tests/helpers/pdf-read.mjs';

let worker;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => { worker = await startLocalWorker(); });
test.afterAll(async () => { await worker?.stop(); });
test.use({ viewport: { width: 390, height: 844 } });

const facts = (sessionId, extra = {}) => ({ state: 'open', sessionId, title: 'Diving Deeper', versionNo: 2, audience: 'Registrars',
  startedAt: '2026-10-17T06:00:00Z', endedAt: '2026-10-17T07:04:00Z', closesAt: new Date(Date.now() + 86400000).toISOString(),
  objectives: ['First.'], formUrl: null, ...extra });

/** Fake feedback API: `respond(method, path, request)` answers each call; every call and its headers are recorded. */
async function fakeApi(page, code, respond) {
  const calls = [];
  await page.route(`**${apiPath('feedback', code)}**`, async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    calls.push({ method: request.method(), path, url: request.url(), auth: request.headers().authorization ?? null, body: request.postDataJSON?.() ?? null });
    const [status, body] = await respond(request.method(), path, request, calls);
    if (status === 'abort') return route.abort('connectionfailed');
    return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return calls;
}
const saved = { revision: 1, updatedAt: '2026-10-17T08:00:00Z', closesAt: new Date(Date.now() + 86400000).toISOString() };

// Room PDFs v2 (Julian 2026-10-18): /F draws the Finish block. A rating saves on tap and a comment on blur (auto-save), each
// send carrying the whole answer set; My Takehome is shared anonymously unless switched off.
const rating = (page, subject, n) => page.getByRole('group', { name: subject, exact: true }).getByRole('button', { name: `${n} of 5` }).click();
const puts = calls => calls.filter(c => c.method === 'PUT');

test('[AS-171] [AS-175] a phone from the QR saves each tap with a browser key in the header only; comments save on blur', async ({ page }) => {
  const code = newJoinCode(), sessionId = uuidv7();
  const calls = await fakeApi(page, code, (method, path) => method === 'GET' && !path.endsWith('/mine') ? [200, facts(sessionId)] : method === 'PUT' ? [200, saved] : [200, { answers: null, revision: 0 }]);
  const urls = []; page.on('request', request => urls.push(request.url()));
  await page.goto(feedbackUrl(code, worker.origin));
  await expect(page.getByRole('heading', { name: 'Diving Deeper' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your participant record' })).toBeVisible();
  await expect(page.getByText('Anonymous', { exact: true })).toBeVisible();
  await rating(page, 'The session', 4);
  await expect(page.getByText(/^Saved · you can change it until /)).toBeVisible();
  await rating(page, 'The case', 5);
  await expect.poll(() => puts(calls).length).toBe(2);
  const put = puts(calls)[0];
  expect(put.auth).toMatch(/^Feedback [A-Za-z0-9_-]{22}$/);
  expect(put.body).toEqual({ answers: { rating_session: 4 } });
  expect(puts(calls)[1].body).toEqual({ answers: { rating_session: 4, rating_case: 5 }, expectedRevision: 1 });
  const browserKey = put.auth.slice('Feedback '.length);
  expect(urls.every(url => !url.includes(browserKey))).toBe(true);
  expect(await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('case:feedback:')))).toEqual([`case:feedback:${sessionId}:key`]);
  // A comment opens under its own rating and saves when it loses focus.
  await page.getByRole('button', { name: 'Add a comment on the case' }).click();
  await page.getByLabel('Comment on the case', { exact: true }).fill('More imaging, please.');
  await page.getByLabel('Comment on the case', { exact: true }).blur();
  await expect.poll(() => puts(calls).at(-1)?.body.answers).toEqual({ rating_session: 4, rating_case: 5, comment_case: 'More imaging, please.' });
  // My Takehome is shared unless switched off; switching it off sends the set without it.
  await page.getByLabel('My Takehome', { exact: true }).fill('Re-examine early.');
  await page.getByLabel('My Takehome', { exact: true }).blur();
  await expect.poll(() => puts(calls).at(-1)?.body.answers.takeaway).toBe('Re-examine early.');
  await page.getByRole('switch', { name: 'Share anonymously' }).click();
  await expect.poll(() => puts(calls).at(-1)?.body.answers.takeaway).toBeUndefined();
  expect(puts(calls).every(c => c.auth === put.auth)).toBe(true);
  // Strict Trusted Types: the page renders text only.
  expect(await page.evaluate(() => { try { document.createElement('div').innerHTML = 'fixture'; return false; } catch { return true; } })).toBe(true);
});

test('a phone that joined the room answers as its participant credential, also when it arrives from the QR', async ({ page }) => {
  const code = newJoinCode(), sessionId = uuidv7(), credential = newCapabilityToken();
  await page.goto(`${worker.origin}/privacy`);
  await page.evaluate(([id, value]) => localStorage.setItem(`case:participant:${id}:token`, JSON.stringify({ sessionId: id, token: value, expiresAt: Date.now() + 3600000 })), [sessionId, credential]);
  const calls = await fakeApi(page, code, (method, path) => method === 'GET' && !path.endsWith('/mine') ? [200, facts(sessionId)] : method === 'PUT' ? [200, saved] : [200, { answers: null, revision: 0 }]);
  await page.goto(feedbackUrl(code, worker.origin));
  await rating(page, 'The app', 3);
  await expect(page.getByText(/^Saved/)).toBeVisible();
  expect(puts(calls)[0].auth).toBe(`Participant ${credential}`);
  expect(calls.every(c => !c.url.includes(credential))).toBe(true);
  expect(await page.evaluate(() => Object.keys(localStorage).some(k => k.startsWith('case:feedback:')))).toBe(false);
});

test('the first QR answer passes the local challenge, sending only its one-use answer in the JSON body', async ({ page }) => {
  const code = newJoinCode(), sessionId = uuidv7(), siteKey = newCapabilityToken(), challengeAnswer = newCapabilityToken();
  await page.route(turnstileWidgetScriptUrl(), route => route.fulfill({ contentType: 'application/javascript', body: `
    window.turnstile={render(container,options){if(options.sitekey!==${JSON.stringify(siteKey)}||options.action!=='join')throw Error('fixture_options');const button=document.createElement('button');button.type='button';button.textContent='Verify local challenge';button.addEventListener('click',()=>options.callback(${JSON.stringify(challengeAnswer)}));container.append(button);return 'fixture';},remove(){}};` }));
  const calls = await fakeApi(page, code, (method, path, request) => {
    if (method === 'GET') return path.endsWith('/mine') ? [200, { answers: null, revision: 0 }] : [200, facts(sessionId)];
    return request.postDataJSON().turnstileToken === challengeAnswer ? [200, saved] : [428, { error: 'challenge_required', siteKey }];
  });
  await page.goto(feedbackUrl(code, worker.origin));
  await rating(page, 'The session', 5);
  await page.getByRole('button', { name: 'Verify local challenge' }).click();
  await expect(page.getByText(/^Saved/)).toBeVisible();
  expect(puts(calls).map(c => Boolean(c.body.turnstileToken))).toEqual([false, true]);
  expect(calls.every(c => !c.url.includes(challengeAnswer))).toBe(true);
});

test('broken links and closed or early rooms each say what happened (§13); a closed room keeps the record', async ({ page }) => {
  const wrong = newJoinCode(), early = newJoinCode(), closed = newJoinCode();
  await fakeApi(page, wrong, () => [404, { error: 'not_found' }]);
  await page.goto(feedbackUrl(wrong, worker.origin));
  await expect(page.getByText("That code isn't right · check it against the projector")).toBeVisible();
  await expect(page.getByLabel('Feedback code')).toBeVisible();
  await fakeApi(page, early, () => [200, { state: 'not_ended' }]);
  await page.goto(feedbackUrl(early, worker.origin));
  await expect(page.getByText('Feedback opens when the session ends.')).toBeVisible();
  const closedCalls = await fakeApi(page, closed, () => [200, facts(uuidv7(), { state: 'closed', formUrl: 'https://forms.example.org/eval' })]);
  await page.goto(feedbackUrl(closed, worker.origin));
  await expect(page.getByText('Feedback for this session has closed. Your record still downloads.')).toBeVisible();
  await expect(page.getByRole('group', { name: 'The session', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download participant record (PDF)' })).toBeVisible();
  expect(closedCalls.every(c => c.method === 'GET' && !c.path.endsWith('/mine'))).toBe(true);
  const form = page.getByRole('link', { name: 'Organisation evaluation form' });
  await expect(form).toHaveAttribute('href', 'https://forms.example.org/eval');
  await expect(form).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(page.getByText('Opens forms.example.org')).toBeVisible();
});

test('a failed save retries without claiming success, and a full room says so', async ({ page }) => {
  const code = newJoinCode(), sessionId = uuidv7();
  let n = 0;
  await fakeApi(page, code, method => {
    if (method === 'GET') return [200, facts(sessionId)];
    n++;
    return n === 1 ? ['abort'] : [409, { error: 'feedback_full' }];
  });
  await page.goto(feedbackUrl(code, worker.origin));
  await rating(page, 'The session', 2);
  await expect(page.getByText("This session isn't taking more responses.")).toBeVisible();
  await expect(page.getByText(/^Saved/)).toHaveCount(0);
});

// Room PDFs v2: the participant record is made on the phone from the Finish block. Its acceptance number is assigned at merge.
test('the participant record is made on the phone: the typed name and My Takehome reach only the downloaded file when not shared', async ({ page }) => {
  const code = newJoinCode(), sessionId = uuidv7();
  const NAME = 'Dr Quillon Vashti-Marr', TAKE = 'Zephyrine thresholds need a fresh history', FAC = 'Wexcombe teaching';
  await fakeApi(page, code, (method, path) => method === 'GET' && !path.endsWith('/mine') ? [200, facts(sessionId, { objectives: ['Recognise the unexplained finding.', 'Escalate early.'] })] : method === 'PUT' ? [200, saved] : [200, { answers: null, revision: 0 }]);
  // Every request the browser makes, from the page or its service worker: URL, headers and body.
  const sent = []; page.context().on('request', request => sent.push([request.url(), JSON.stringify(request.headers()), request.postData() ?? ''].join('\n')));
  const loaded = name => page.evaluate(n => performance.getEntriesByType('resource').some(e => new URL(e.name).pathname.startsWith(`/assets/${n}.`)), name);
  await page.goto(feedbackUrl(code, worker.origin));
  await expect(page.getByRole('heading', { name: 'Your participant record' })).toBeVisible();
  expect(await loaded('participant-record')).toBe(false);
  expect(await loaded('session-pdf')).toBe(false);
  await page.getByRole('switch', { name: 'Share anonymously' }).click(); // private: never sent
  await page.getByLabel('My Takehome', { exact: true }).fill(TAKE);
  await page.getByLabel('My Takehome', { exact: true }).blur();
  // I can now starts ticked (Julian, 2026-10-18): untick the one the participant is unsure of.
  await page.getByRole('group', { name: 'I can now' }).getByRole('button', { name: 'Recognise the unexplained finding.' }).click();
  await page.getByRole('button', { name: /^Your details/ }).click();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByLabel('Your name').fill(NAME);
  await page.getByLabel('Facilitator and organisation').fill(FAC);
  await expect(page.getByLabel('Hours')).toHaveValue('1');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download participant record (PDF)' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('Diving Deeper – Participant record – 2026-10-17.pdf');
  expect(await loaded('participant-record')).toBe(true);
  expect(await loaded('session-pdf')).toBe(true);
  const { lines } = readPdf(await readFile(await file.path()));
  for (const line of ['Diving Deeper', NAME, FAC, TAKE, 'Not ticked', 'Recognise the unexplained finding.', 'Ticked', 'Escalate early.',
    'Self-recorded by the participant. Case does not confirm identity or attendance and is not a CPD provider.']) expect(lines).toContain(line);
  expect(lines.join('\n')).not.toContain(sessionId);
  expect(lines.join('\n')).not.toContain(code);
  // Nothing typed for the record left memory: no request carried it, in any encoding, and no storage holds it.
  const TOKEN = new Map([[NAME, 'Quillon'], [TAKE, 'Zephyrine'], [FAC, 'Wexcombe']]);
  const forms = value => [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1), TOKEN.get(value), TOKEN.get(value).toLowerCase()];
  for (const value of [NAME, TAKE, FAC]) for (const form of forms(value)) expect(sent.filter(s => s.includes(form))).toEqual([]);
  expect(page.url()).toBe(feedbackUrl(code, worker.origin));
  const stored = await page.evaluate(async () => {
    const dump = s => Object.keys(s).map(k => `${k}=${s.getItem(k)}`);
    const out = [...dump(localStorage), ...dump(sessionStorage), document.cookie, document.title, JSON.stringify(history.state)];
    for (const db of await indexedDB.databases()) out.push(`idb:${db.name}`);
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) out.push(request.url, await (await cache.match(request)).text());
    }
    return out.join('\n');
  });
  for (const value of [NAME, TAKE, FAC]) for (const form of forms(value)) expect(stored).not.toContain(form);
  expect(stored).not.toMatch(/case:feedback:[^=]*:(record|name|reflection)/);
});

for (const scheme of ['light', 'dark']) test(`the feedback page has no axe violations (${scheme})`, async ({ page }) => {
  const code = newJoinCode();
  await page.emulateMedia({ colorScheme: scheme });
  await fakeApi(page, code, (method, path) => method === 'GET' && !path.endsWith('/mine') ? [200, facts(uuidv7())] : [200, { answers: null, revision: 0 }]);
  await page.goto(feedbackUrl(code, worker.origin));
  await page.getByRole('button', { name: 'Add a comment on the session' }).click();
  await expect(page.getByLabel('Comment on the session', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Your details/ }).click();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
