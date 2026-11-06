// e2e/room-lab.spec.mjs: independent room clients, driven through their own UI, against the stage C
// lab's simulated Durable Object (tests/playwright-harness.mjs). Every window is a separate document
// with its own connection; the only shared thing is the lab's simulated network.
import { readFileSync } from 'node:fs';
import { isAvatarId } from '../src/shared/participant.mjs';
import { test, expect, joinPhone, startCase, vote, selectRoute, reveal, axeViolations, roomTab, runTab } from '../tests/playwright-harness.mjs';

const OPT = {
  cxr: 'S00173 workshop label. Record az',
  rsi: 'S00174 workshop label. Record a senso',
  needle: 'S00175 workshop label. Record a s',
  finger: 'S00176 workshop label. Record az',
  icc: 'S00189 workshop label. Record a s',
};
const WINDOW_KEYS = ['facilitator', 'display', 'A', 'B', 'C'];
const FIXTURE = JSON.parse(readFileSync(new URL('../src/fixtures/synthetic-workshop.case.json', import.meta.url), 'utf8'));
const ROUTE = {needle:FIXTURE.decisions[0].paths[0].label,icc:FIXTURE.decisions[1].paths[0].label};
const notesOf = (title) => FIXTURE.surfaces.find((x) => x.title === title).notes;

async function openFirstDecisionAfterArrival(lab) {
  await lab.press('Show decision context');
  await lab.until((s) => s.decisionId && s.revealed.at(-1).groupsShown === 1 && !s.round, 'decision scene before vote');
  await lab.press('Reveal observations');
  await lab.until((s) => s.revealed.at(-1).groupsShown === 2 && !s.round, 'decision observations before vote');
  await lab.press('Reveal findings');
  await lab.until((s) => s.revealed.at(-1).groupsShown === 3 && !s.round, 'decision findings before vote');
  await lab.press('Open responses');
}

async function openSecondDecisionAfterConsequence(lab) {
  // The same test already revealed the consequence observations for the vitals check.
  await lab.press('Reveal findings');
  await lab.press('Show decision context');
  await lab.until((s) => s.decisionId && s.revealed.at(-1).groupsShown === 1 && !s.round, 'next decision scene before vote');
  await lab.press('Reveal observations');
  await lab.press('Reveal findings');
  await lab.press('Reveal investigations');
  await lab.until((s) => s.revealed.at(-1).groupsShown === 4 && !s.round, 'next decision context complete before vote');
  await lab.press('Open responses');
}

/** Everything a window keeps in web storage, as one string. */
// Web storage minus the manual segment, which CASE-093 deliberately keeps in sessionStorage.
const storedText = (frame) => frame.evaluate(() => JSON.stringify([{ ...localStorage }, Object.fromEntries(Object.entries(sessionStorage).filter(([k]) => !k.startsWith('case-lab:segment:')))]));
const savedSegments = (frame) => frame.evaluate(() => Object.entries(sessionStorage).filter(([k]) => k.startsWith('case-lab:segment:')).map(([, v]) => JSON.parse(v)));

/** axe on every lab window, light and dark (CASE-011, CASE-114), in the state the room is in now. */
async function expectAccessible(lab, state) {
  for (const colorScheme of ['light', 'dark']) {
    await lab.page.emulateMedia({ colorScheme });
    for (const key of WINDOW_KEYS) {
      const frame = key === 'facilitator' ? lab.facilitator : key === 'display' ? lab.display : lab.phone(key);
      expect.soft(await axeViolations(frame), `${key} window, ${state}, ${colorScheme}`).toEqual([]);
    }
  }
  await lab.page.emulateMedia({ colorScheme: 'light' });
}

test('[AS-001] [AS-002] [AS-003] [AS-005] [AS-063] [AS-006] [AS-007] [AS-009] [AS-017] [AS-024] [AS-046] [AS-047] [AS-051] [AS-052] [AS-053] [AS-054] [AS-055] a room votes, locks, reveals, pauses with a held answer and ends (axe on every window)', async ({ lab }) => {
  const { facilitator: fac, display } = lab;
  const phoneA = lab.phone('A');
  const phoneB = lab.phone('B');
  const phoneC = lab.phone('C');

  // AS-001: phones join through their own UI with the code the projector shows.
  const code = (await lab.state()).joinCode;
  await expect(display.getByText(code.replace(/^(...)(...)$/, '$1 $2'))).toBeVisible();
  await joinPhone(lab, 'A', 'Sam');
  await joinPhone(lab, 'B', 'Alex');
  await joinPhone(lab, 'C');
  await expect(display.getByText('3 in the room · Waiting to start')).toBeVisible();

  // AS-002: The display check is advisory and never blocks Start case.
  await expect(fac.getByRole('button', { name: 'Start case', exact: true })).toBeEnabled();
  await expect(fac.getByText('Confirm the display check first')).toHaveCount(0);
  await startCase(lab);
  await expect(display.getByRole('heading', { level: 1, name: 'S00011 workshop title.z' })).toBeVisible();
  await expect(phoneA.getByRole('heading', { name: 'S00011 workshop title.z' })).toBeVisible();
  // AS-063: one scene card, then the findings tile, on the projector and the phone alike (CASE-116, CASE-117).
  const arrival = FIXTURE.surfaces.find((x) => x.title === 'S00011 workshop title.z');
  await expect(display.getByRole('region', { name: 'Findings' })).toHaveCount(0);
  await expect(phoneA.getByRole('region', { name: 'Findings' })).toHaveCount(0);
  await lab.press('Reveal findings');
  for (const frame of [display, phoneA]) {
    await expect(frame.getByText(arrival.scene)).toBeVisible();
    await expect(frame.getByRole('region', { name: 'Findings' }).getByRole('listitem')).toHaveCount(arrival.points.length);
  }

  // AS-005 / AS-053 / AS-054: an open decision; the projector shows every option, marked, in the one
  // authored order, and the answered count.
  await openFirstDecisionAfterArrival(lab);
  await lab.until((s) => s.phase === 'responses_open', 'decision 1 open');
  const tiles = display.getByRole('list', { name: 'Options' }).getByRole('listitem');
  await expect(tiles).toHaveText([OPT.cxr, OPT.rsi, OPT.needle, OPT.finger].map((label) => new RegExp(label)));
  expect(await tiles.getByRole('img').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label'))))
    .toEqual(['Red triangle', 'Blue diamond', 'Yellow circle', 'Green square']);
  await expect(display.getByText('Prompt', { exact: true })).toBeVisible();
  await expect(display.getByText('0 of 3 answered')).toBeVisible();
  // Every phone lists the same options in the same order with the same marks (CASE-088).
  for (const phone of [phoneA, phoneB, phoneC]) {
    await expect(phone.getByRole('radio')).toHaveCount(4);
    expect(await phone.getByRole('radio').evaluateAll((els) => els.map((e) => e.closest('label').textContent)))
      .toEqual([`Red triangle: ${OPT.cxr}`, `Blue diamond: ${OPT.rsi}`, `Yellow circle: ${OPT.needle}`, `Green square: ${OPT.finger}`]);
  }
  await expectAccessible(lab, 'open decision');

  await vote(lab, 'A', OPT.needle);
  await vote(lab, 'B', OPT.cxr);
  await expect(display.getByText('2 of 3 answered')).toBeVisible();
  await vote(lab, 'C', OPT.needle);
  await expect(display.getByText('3 of 3 answered')).toBeVisible();
  await expect(fac.getByText('Round 1 · 3 of 3 responded')).toBeVisible();

  // AS-006: lock; every phone gets a definitive locked state; the projector keeps the options (CASE-089)
  // and shows the anonymous closed aggregate before the facilitator chooses an authored route.
  await lab.press('Lock responses & review');
  await lab.until((s) => s.phase === 'responses_locked', 'locked');
  const closedChart = display.getByRole('region', { name: 'Responses closed', exact: true });
  await expect(closedChart).toBeVisible();
  await expect(closedChart).toContainText('3 answered');
  await expect(closedChart.locator(':scope > ul > li')).toHaveCount(4);
  await expect(display.getByRole('region', { name: 'Room result' })).toHaveCount(0);
  await expect(phoneA.getByText(`Your answer (locked): ${OPT.needle}`)).toBeVisible();
  await expect(phoneB.getByText(`Your answer (locked): ${OPT.cxr}`)).toBeVisible();

  // AS-009: a phone browses back to earlier material; the reveal returns it to the new live surface.
  await phoneA.getByRole('list', { name: 'Swipe through shared material' }).getByRole('button', { name: /S00011 workshop title.z/ }).click();
  await expect(phoneA.getByText('Earlier material · read-only')).toBeVisible();

  // AS-007: select, then reveal; nothing public changes until the reveal.
  const closedBeforeChoice = await closedChart.innerText();
  await selectRoute(lab, ROUTE.needle);
  await expect.poll(() => closedChart.innerText()).toBe(closedBeforeChoice);
  await lab.press('Hide responses on projector');
  await reveal(lab);
  const revealed = await lab.until((s) => s.phase === 'consequence_revealed', 'consequence revealed');
  expect(revealed.rounds[0]).toMatchObject({ status: 'resolved', resolutionKind: 'majority' });
  await expect(display.getByRole('heading', { level: 1, name: 'S00031 workshop title. Recordz' })).toBeVisible();
  await expect(phoneA.getByRole('heading', { name: 'S00031 workshop title. Recordz' })).toBeVisible();
  await expect(phoneA.getByText('Earlier material · read-only')).toHaveCount(0);
  await phoneA.getByRole('list', { name: 'Swipe through shared material' }).getByRole('button', { name: /S00011 workshop title.z/ }).click();
  await expect(phoneA.getByText('Earlier material · read-only')).toBeVisible(); // still browseable afterwards
  await phoneA.getByRole('button', { name: 'Live surface', exact: true }).click();

  // AS-051: bullet points on every screen; the narrative notes on the console only.
  const notes = notesOf('S00031 workshop title. Recordz');
  await expect(fac.getByText('Facilitator notes · not shown to the room')).toBeVisible();
  await expect(fac.getByText(notes)).toBeVisible();
  for (const frame of [display, phoneA]) expect(await frame.locator('body').textContent()).not.toContain(notes.slice(0, 60));

  // AS-046 / AS-055: anonymous counts remain available explicitly; route attribution stays on each phone.
  await lab.press('Show responses on projector');
  const result = display.getByRole('region', { name: 'Responses closed', exact: true });
  await expect(result).toContainText('3 answered');
  await expect(result).not.toContainText('The facilitator followed the majority view');
  await expect(result).not.toContainText('Recorded as Majority');
  await expect(phoneA.getByRole('region', { name: 'Room result' })).toContainText('The facilitator followed the majority view');
  await expect(result.getByRole('listitem')).toHaveText([/S00173 workshop label. Record az\s*1$/, /S00174 workshop label. Record a senso\s*0$/, /S00175 workshop label. Record a s\s*2$/, /S00176 workshop label. Record az\s*0$/]);
  await expect(phoneA.getByText(`You chose ${OPT.needle} · 2 of 3 chose the same`)).toBeVisible();
  await expect(phoneB.getByText(`You chose ${OPT.cxr} · 1 of 3 chose the same`)).toBeVisible();
  await expect(display.getByRole('list', { name: 'Vitals' })).toHaveCount(0);
  await lab.press('Hide responses on projector');
  await lab.press('Reveal observations');
  const hr = display.getByRole('list', { name: 'Vitals' }).getByRole('listitem').first();
  await expect(hr).toContainText('↓ 92');
  await expect(hr.locator('.sr-only')).toHaveText('R1 71 unit, down from 92');
  const hrPhone = phoneA.getByRole('list', { name: 'Observations' }).getByRole('listitem').first();
  await expect(hrPhone).toContainText('↓ 92');
  await expect(hrPhone.locator('.sr-only')).toHaveText('R1 71 unit, down from 92');
  await expect(fac.getByRole('list', { name: 'Vitals' }).getByRole('listitem').first()).toContainText('↓ 92');
  await expectAccessible(lab, 'revealed');

  // An answer in flight (CASE-255 retired the pause this step once took): phone A loses its link and sends;
  // the open round offers no pause, and the answer lands once the link returns.
  await openSecondDecisionAfterConsequence(lab);
  await lab.until((s) => s.phase === 'responses_open' && s.round?.no === 1 && s.rounds.length === 1, 'decision 2 open');
  await lab.setLink('A', 'down');
  await phoneA.getByRole('radio', { name: OPT.icc }).check();
  await phoneA.getByRole('button', { name: 'Send answer' }).click();
  await expect(fac.getByRole('button', { name: 'Pause for discussion' })).toHaveCount(0);
  expect(Object.keys((await lab.state()).round.responses)).toHaveLength(0);
  await lab.setLink('A', 'up');
  await expect(phoneA.getByText('Answer saved · you can change it until responses lock')).toBeVisible();
  await lab.until((s) => s.phase === 'responses_open' && Object.keys(s.round.responses).length === 1, 'answer in flight recorded once the link returns');

  // AS-024: phone B's answer is in flight when the round locks; it is refused `locked`, and the phone
  // says so: it never claimed success before a receipt.
  await lab.setLink('B', 'down');
  await phoneB.getByRole('radio', { name: OPT.icc }).check();
  await phoneB.getByRole('button', { name: 'Send answer' }).click();
  await expect(phoneB.getByText('Answer saved', { exact: false })).toHaveCount(0);
  await lab.press('Lock responses & review');
  await lab.until((s) => s.phase === 'responses_locked', 'decision 2 locked');
  await lab.setLink('B', 'up');
  await expect(phoneB.getByText('Voting locked · no answer was recorded from this phone')).toBeVisible();
  expect(Object.keys((await lab.state()).round.responses)).toHaveLength(1);

  // AS-017 / AS-047: end (from the Room tab, CASE-118); every phone gets a private recap that teaches.
  await (await roomTab(fac)).getByRole('button', { name: 'End room', exact: true }).click();
  await fac.locator('#dlg').getByRole('button', { name: 'End room', exact: true }).click();
  await lab.until((s) => s.phase === 'ended', 'ended');
  await expect(fac.getByRole('heading', { level: 1, name: 'Room ended' })).toBeVisible();
  await expect(display.getByRole('main').getByText('Session ended')).toBeVisible();
  for (const phone of [phoneA, phoneB]) await expect(phone.getByRole('heading', { name: 'Your private recap' })).toBeVisible();
  const recapB = phoneB.locator('article.recap-round').first();
  await expect(recapB).toContainText(`Your answer: ${OPT.cxr}`);
  await expect(recapB).toContainText('Unsafe · recoverable');
  await expect(recapB).toContainText('Why: ');
  await expect(recapB).toContainText(`Recommended here: ${OPT.needle}`);
  await expect(recapB).toContainText('The room: Followed the majority view');
  await expect(recapB).toContainText('What happened: S00031 workshop title. Recordz');
  const recapA = phoneA.locator('article.recap-round').first();
  await expect(recapA).toContainText('Sound');
  await expect(recapA).not.toContainText('Recommended here');
  await expect(phoneA.getByText(OPT.cxr)).toHaveCount(0); // never another participant's answer
  await expectAccessible(lab, 'ended');
});

test('[AS-030] [AS-031] [AS-032] [AS-033] [AS-034] [AS-035] [AS-049] [AS-056] [AS-057] [AS-058] the facilitator drops mid-vote, runs the room by hand, and rejoins online (axe on every window)', async ({ lab }) => {
  const { facilitator: fac, display } = lab;
  const phoneA = lab.phone('A');
  const phoneB = lab.phone('B');
  await joinPhone(lab, 'A', 'Sam');
  await joinPhone(lab, 'B', 'Alex');
  await startCase(lab);
  await lab.press('Reveal findings');
  await openFirstDecisionAfterArrival(lab);
  await lab.until((s) => s.phase === 'responses_open', 'decision open');
  await vote(lab, 'A', OPT.needle);

  // AS-033: the console's link goes down; the phones keep voting into the server's open round.
  await lab.setLink('facilitator', 'down');
  await expect(fac.getByRole('button', { name: 'Switch to manual room', exact: true })).toBeVisible();
  await vote(lab, 'B', OPT.cxr);
  await lab.until((s) => Object.keys(s.round.responses).length === 2, 'phones kept voting');
  await expect(display.getByText('2 of 2 answered')).toBeVisible();

  // AS-031 / AS-030: manual mode from inside the open decision, entered locally with no server.
  await fac.getByRole('button', { name: 'Switch to manual room', exact: true }).click();
  const dialog = fac.locator('#dlg');
  await expect(dialog).toContainText('This cancels the open round. Its answers are discarded.');
  await dialog.getByRole('button', { name: 'Enter manual room mode', exact: true }).click();
  await expect(fac.getByText('Manual room mode · phone votes and recap capture are unavailable until connectivity returns')).toBeVisible();
  // The same-PC projector follows the console locally (DD topology).
  await expect(display.getByRole('region', { name: 'Room status' })).toContainText('Manual room mode · facilitator-led discussion');
  const unseen = await lab.state();
  expect(unseen).toMatchObject({ phase: 'responses_open', epoch: 0, manual: null }); // the server has heard nothing

  // AS-032: choose and reveal a route by hand; add a marker that stays on the console.
  await selectRoute(lab, ROUTE.needle);
  await reveal(lab);
  await expect(display.getByRole('heading', { level: 1, name: 'S00031 workshop title. Recordz' })).toBeVisible();
  await fac.getByLabel('Add marker').fill('Show of hands: most would decompress');
  await fac.getByRole('button', { name: 'Add marker', exact: true }).click();
  await expect(fac.getByText('1 added', { exact: false })).toBeVisible();
  await expectAccessible(lab, 'manual');
  // AS-056: the console holds the room state it runs from in memory only, never in web storage.
  const sessionId = unseen.sessionId;
  expect(await storedText(fac)).not.toContain(sessionId);
  // AS-057: the manual segment itself is saved in this tab's sessionStorage (commands only, no mirror).
  const [segment] = await savedSegments(fac);
  expect(segment.events.map((e) => e.type)).toEqual(expect.arrayContaining(['enter_manual', 'manual_marker']));
  expect(JSON.stringify(segment)).not.toContain('"participants"');

  // AS-058: the link returns, but nothing uploads until the facilitator chooses Rejoin online.
  await lab.setLink('facilitator', 'up');
  await expect(fac.getByText('Live', { exact: true })).toBeVisible();
  expect(await lab.state()).toMatchObject({ phase: 'responses_open', epoch: 0, manual: null });
  expect((await lab.state()).manualSegments).toEqual([]);

  // AS-035: Rejoin online uploads the segment; the server replays it all-or-nothing.
  await (await roomTab(fac)).getByRole('button', { name: 'Rejoin online at the next decision', exact: true }).click();
  const after = await lab.until((s) => s.manualSegments.length === 1, 'segment applied');
  expect(after.epoch).toBe(2); // enter_manual and resume_online each bump the epoch
  expect(after.phase).toBe('consequence_revealed');
  expect(after.manual).toBeNull();
  // AS-034: the round the phones kept voting in is abandoned; its votes are discarded, never used.
  expect(after.rounds).toHaveLength(1);
  expect(after.rounds[0]).toMatchObject({ status: 'abandoned', aggregate: null, answers: {} });
  expect(after.revealed.at(-1)).toMatchObject({ kind: 'consequence', manual: true });
  // AS-049: the marker reached the server as an ordinal only.
  expect(after.manualSegments[0].markers).toBe(1);
  expect(JSON.stringify(after)).not.toContain('Show of hands');
  const journal = await lab.page.evaluate(() => JSON.stringify(window.caseLab.room.storage.journal));
  expect(journal).not.toContain('Show of hands');
  await expect(fac.getByText('Round closed as abandoned · Manual choices recorded · New epoch', { exact: false })).toBeVisible();
  await expect(fac.getByRole('heading', { level: 1, name: 'Consequence shown' })).toBeVisible();
  for (const phone of [phoneA, phoneB]) {
    await expect(phone.getByRole('main').getByText('Round cancelled · the facilitator will open a new round')).toBeVisible();
    await expect(phone.getByRole('heading', { name: 'S00031 workshop title. Recordz' })).toBeVisible();
  }
  await expect(display.getByRole('region', { name: 'Room status' })).not.toContainText('Manual room mode');
  // The next decision opens fresh, online, as round 1 of decision 2.
  await lab.press('Reveal observations');
  await openSecondDecisionAfterConsequence(lab);
  const next = await lab.until((s) => s.phase === 'responses_open', 'decision 2 open online');
  expect(next.round.no).toBe(1);
  await vote(lab, 'A', OPT.icc);
  expect(await storedText(fac)).not.toContain(sessionId);
  expect(await savedSegments(fac)).toEqual([]); // AS-057: cleared after a successful upload
});

test('[AS-028] [AS-043] the server is evicted mid-vote; recorded and in-flight votes both survive', async ({ lab }) => {
  const { display } = lab;
  await joinPhone(lab, 'A', 'Sam');
  await joinPhone(lab, 'B', 'Alex');
  await startCase(lab);
  await lab.press('Reveal findings');
  await openFirstDecisionAfterArrival(lab);
  await lab.until((s) => s.phase === 'responses_open', 'decision open');
  await vote(lab, 'A', OPT.needle);
  const before = await lab.state();

  // Evict, and send phone B's answer while the server is gone: the bus retries it with the same
  // clientEventId until the rebuilt server answers with a receipt.
  const eviction = lab.evict(1500);
  await vote(lab, 'B', OPT.cxr);
  const rebuilt = await eviction;
  expect(rebuilt.identical).toBe(true); // every role's projection identical across the rebuild
  const after = await lab.until((s) => Object.keys(s.round.responses).length === 2, 'both votes held');
  expect(await lab.page.evaluate(() => window.caseLab.room.rebuilds)).toBe(1);
  expect(after.epoch).toBe(before.epoch);
  expect(after.round.id).toBe(before.round.id);
  expect(after.round.responses[Object.keys(before.round.responses)[0]].response).toEqual(Object.values(before.round.responses)[0].response);
  await expect(display.getByText('2 of 2 answered')).toBeVisible();
  // One accepted receipt per vote: the retried frame did not record B twice.
  const recorded = await lab.page.evaluate(() => window.caseLab.room.storage.journal.filter((j) => j.kind === 'response_recorded').length);
  expect(recorded).toBe(2);
});

test('[AS-027] [AS-039] a second console takes over; the stale tab is fenced and its command refused', async ({ lab }) => {
  const { page } = lab;
  await joinPhone(lab, 'A', 'Sam');
  await startCase(lab);
  await lab.press('Reveal findings');
  await lab.press('Show decision context');
  await lab.press('Reveal observations');
  await lab.press('Reveal findings');
  await page.getByRole('button', { name: 'Second facilitator tab' }).click();
  const tab2 = () => page.frame({ url: /\/facilitator\.html\?tab=2$/ });
  await expect.poll(() => Boolean(tab2())).toBe(true);
  await expect(tab2().getByRole('heading', { level: 1, name: 'This room is open on another device' })).toBeVisible();

  // The old tab's command is in flight on a dead link when the takeover lands.
  await lab.setLink('facilitator', 'down');
  await lab.press('Open responses');
  await tab2().getByRole('button', { name: 'Take over this room' }).click();
  await tab2().locator('#dlg').getByRole('button', { name: 'Take over this room' }).click();
  const taken = await lab.until((s) => s.epoch === 1, 'takeover bumped the epoch');
  expect(taken.phase).toBe('surface_live');
  await lab.setLink('facilitator', 'up');
  await expect(lab.facilitator.getByRole('heading', { level: 1, name: 'This room is now controlled from another device' })).toBeVisible();
  await expect(lab.facilitator.getByRole('button')).toHaveCount(0);
  // The stale command reached the server (the old tab got its receipt) and changed nothing.
  await expect.poll(() => lab.facilitator.evaluate(() => window.caseFacilitator.S.busy)).toBe(false);
  expect(await lab.state()).toMatchObject({ phase: 'surface_live', epoch: 1 });
  const kinds = await page.evaluate(() => window.caseLab.room.storage.journal.map((j) => j.kind));
  expect(kinds).not.toContain('responses_opened');
  // The new console controls the room; phones were never fenced.
  await tab2().getByRole('button', { name: 'Open responses', exact: true }).click();
  await lab.until((s) => s.phase === 'responses_open', 'opened from the new console');
  await vote(lab, 'A', OPT.needle);
});

test('[AS-014] [AS-041] [AS-044] [AS-050] [AS-062] names are required and checked; closing joining hides the join route; lobby names accompany avatars and play names require an explicit request', async ({ lab }) => {
  const { facilitator: fac, display } = lab;
  const code = (await lab.state()).joinCode;

  // AS-062: the phone refuses a missing, short or unsafe name, before sending; an omitted avatar receives a valid random assignment.
  const phoneA = lab.phone('A');
  await phoneA.getByLabel('Room code').fill(code);
  await phoneA.getByRole('button', { name: 'Join case', exact: true }).click();
  await expect(phoneA.getByText('Enter a name the room can call you')).toBeVisible();
  await phoneA.getByLabel('Your name').fill('Sa');
  await phoneA.getByRole('button', { name: 'Join case', exact: true }).click();
  await expect(phoneA.getByText('Use at least 3 characters')).toBeVisible();
  await phoneA.getByLabel('Your name').fill('Sam\u0007\u202eX');
  await phoneA.getByRole('button', { name: 'Join case', exact: true }).click();
  await expect(phoneA.getByText('Use letters, numbers, spaces, hyphens or apostrophes')).toBeVisible();
  await phoneA.getByLabel('Your name').fill('Sam X');
  await phoneA.getByRole('button', { name: 'Join case', exact: true }).click();
  await expect(phoneA.getByRole('heading', { name: 'Waiting to start', exact: true })).toBeVisible();
  const assigned = Object.values((await lab.state()).participants);
  expect(assigned).toHaveLength(1);
  expect(isAvatarId(assigned[0].avatarId)).toBe(true);
  await phoneA.getByText('Change name or avatar', { exact: true }).click();
  // A random legacy avatar can already be Teal/quiff; ensure a real colour change before saving.
  await phoneA.getByRole('radio', { name: 'Blue', exact: true }).check();
  await phoneA.getByRole('radio', { name: 'Teal', exact: true }).check();
  await phoneA.getByRole('radio', { name: 'Shape 5: quiff', exact: true }).check();
  await phoneA.getByRole('button', { name: 'Save changes', exact: true }).click();
  await lab.until(s => Object.values(s.participants)[0]?.avatarId === 'shadows-05-teal', 'chosen avatar saved');
  await joinPhone(lab, 'B', 'Sam X'); // duplicates are allowed
  const state = await lab.state();
  expect(Object.values(state.participants).map((p) => [p.name, p.avatarId])).toEqual([['Sam X', 'shadows-05-teal'], ['Sam X', 'shadows-01']]);
  await expect(fac.getByRole('region', { name: 'Join and people' }).getByText('Sam X')).toHaveCount(2);
  await expect(display.getByText('Sam X', { exact: true })).toHaveCount(2); // Automatic lobby roster.
  const anonymous = display.getByRole('region', { name: 'In the room' }).getByRole('listitem');
  await expect(anonymous).toHaveCount(2);
  expect(await anonymous.allTextContents()).toEqual(['Sam X', 'Sam X']);

  const room = await roomTab(fac);
  await room.getByRole('button', { name: 'Close joining', exact: true }).click();
  await lab.until((s) => s.joiningClosed === true, 'joining closed');
  await expect(display.getByRole('heading', { name: 'Joining is closed' })).toBeVisible();
  await expect(display.getByRole('img', { name: /QR code/ })).toHaveCount(0);
  const phoneC = lab.phone('C');
  await phoneC.getByLabel('Room code').fill(state.joinCode);
  await phoneC.getByLabel('Your name').fill('Alex');
  await phoneC.getByRole('radio', { name: 'Blue, topknot', exact: true }).check();
  await phoneC.getByRole('button', { name: 'Join case', exact: true }).click();
  await expect(phoneC.getByText('This room is not accepting new participants')).toBeVisible();
  expect(Object.keys((await lab.state()).participants)).toHaveLength(2); // existing participants unaffected

  await room.getByRole('button', { name: 'Reopen joining', exact: true }).click();
  await expect(display.getByRole('heading', { name: 'Join on your phone' })).toBeVisible();
  await phoneC.getByRole('button', { name: 'Join case', exact: true }).click();
  await expect(phoneC.getByRole('heading', { level: 1, name: 'Waiting to start' })).toBeVisible();

  await expect(room.getByRole('button', { name: /^(Show|Hide) names on projector$/ })).toHaveCount(0);
  const names = display.getByRole('region', { name: 'In the room' });
  await expect(names.getByRole('listitem')).toHaveText(['Sam X', 'Sam X', 'Alex']);
  expect(await names.locator('img').evaluateAll((els) => els.map((e) => new URL(e.src).pathname.split('/').pop()))).toEqual(['shadows-05-teal.svg', 'shadows-01.svg', 'shadows-07.svg']);
  await runTab(fac);
  await startCase(lab);
  await expect(names.getByText('Sam X', { exact: true })).toHaveCount(0);
  await roomTab(fac);
  await room.getByRole('button', { name: 'Show names on projector', exact: true }).click();
  await fac.locator('#dlg').getByRole('button', { name: 'Show names on projector', exact: true }).click();
  await expect(names.getByRole('listitem')).toHaveText(['Sam X', 'Sam X', 'Alex']);
  expect(await names.locator('img').evaluateAll((els) => els.map(e => new URL(e.src).pathname.split('/').pop()))).toEqual(['shadows-05-teal.svg', 'shadows-01.svg', 'shadows-07.svg']);
  await runTab(fac);
});

test('[AS-064] avatar chips stay anonymous during play and gain names only after Show names', async ({ lab }) => {
  await joinPhone(lab, 'A', 'Sam', 'Teal, quiff');
  await startCase(lab);
  await lab.press('Reveal findings');
  await openFirstDecisionAfterArrival(lab);
  await lab.until((s) => s.phase === 'responses_open', 'decision open');
  const names = lab.display.getByRole('region', { name: 'In the room' });
  await expect(names.getByRole('listitem')).toHaveCount(1);
  await expect(names.getByText('Sam')).toHaveCount(0);
  await expect(names.getByText('1 joined')).toHaveCount(0);
  expect(await names.locator('li.chip').evaluateAll((els) => els.map((el) => ({ label: el.getAttribute('aria-label'), title: el.getAttribute('title'), imageAlt: el.querySelector('img')?.alt, imageTitle: el.querySelector('img')?.getAttribute('title') })))).toEqual([{ label: 'Participant', title: null, imageAlt: '', imageTitle: null }]);
  const room = await roomTab(lab.facilitator);
  await room.getByRole('button', { name: 'Show names on projector', exact: true }).click();
  await lab.facilitator.locator('#dlg').getByRole('button', { name: 'Show names on projector', exact: true }).click();
  await expect(names.getByRole('listitem')).toContainText(['Sam']);
  await expect(lab.display.getByText('of 1 answered')).toHaveCount(0);
});

test('[AS-065] Findings and options fit a 1280 by 720 projector during an open decision', async ({ lab }) => {
  await joinPhone(lab, 'A', 'Sam');
  await startCase(lab);
  await lab.press('Reveal findings');
  await openFirstDecisionAfterArrival(lab);
  await lab.until((s) => s.phase === 'responses_open', 'decision open');
  const display = lab.display;
  await expect(display.getByRole('region', { name: 'Findings' })).toBeVisible();
  const metrics = await display.evaluate(() => {
    const main = document.querySelector('main');
    const find = document.querySelector('.findings');
    const option = document.querySelector('.opt-tile');
    const rect = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
    return { viewport: [innerWidth, innerHeight], main: rect(main), findings: rect(find), findingsSize: parseFloat(getComputedStyle(find.querySelector('ul')).fontSize), optionSize: parseFloat(getComputedStyle(option).fontSize), overflow: main.dataset.overflow, colOverflow: [...main.querySelectorAll('.col')].some((c) => c.scrollHeight > c.clientHeight + 1 || c.scrollWidth > c.clientWidth + 1) };
  });
  expect(metrics.viewport).toEqual([1280, 720]);
  expect(metrics.findingsSize).toBeGreaterThanOrEqual(18);
  expect(metrics.optionSize).toBeGreaterThanOrEqual(24);
  expect(metrics.findings.top).toBeGreaterThanOrEqual(metrics.main.top);
  expect(metrics.findings.bottom).toBeLessThanOrEqual(metrics.main.bottom);
  expect(metrics.overflow).toBe('false');
  expect(metrics.colOverflow).toBe(false);
  const shown = await display.locator('.findings li:not([hidden]):not(.more)').count();
  const omitted = FIXTURE.surfaces.find((s) => s.title === 'S00011 workshop title.z').points.length - shown;
  if (omitted) await expect(display.locator('.findings li.more')).toHaveText(`+${omitted} more on your phone`);
  else await expect(display.locator('.findings li.more')).toHaveCount(0);
});

test('[AS-062] a waiting participant independently changes avatar colour and shape', async ({ lab }) => {
  await joinPhone(lab, 'A', 'Sam');
  const phone = lab.phone('A');
  await phone.getByText('Change name or avatar', { exact: true }).click();
  await phone.getByRole('radio', { name: 'Blue', exact: true }).check();
  await phone.getByRole('radio', { name: 'Shape 2: bun', exact: true }).check();
  await phone.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(phone.locator('details.ctx')).not.toHaveAttribute('open', '');
  await lab.until((s) => Object.values(s.participants)[0].avatarId === 'shadows-02-blue', 'custom avatar saved');
  await expect(phone.locator('#whoAv img')).toHaveAttribute('src', /shadows-02-blue\.svg$/);
  await expect(lab.display.getByRole('region', { name: 'In the room' }).locator('img')).toHaveAttribute('src', /shadows-02-blue\.svg$/);
  for (const colorScheme of ['light', 'dark']) {
    await lab.page.emulateMedia({ colorScheme });
    expect(await axeViolations(phone), `avatar controls, ${colorScheme}`).toEqual([]);
  }
});

test('[AS-062] room code accepts only six canonical characters, including pasted and edited input', async ({ lab }) => {
  const code = lab.phone('A').getByLabel('Room code');
  await code.fill('7k3qx9zz');
  await expect(code).toHaveValue('7K3QX9');
  await code.fill('');
  await code.pressSequentially('oil-2@3q');
  await expect(code).toHaveValue('01123Q');
  await code.evaluate((input) => {
    input.value = ''; input.focus();
    const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', '7k3-qx9-extra');
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  });
  await expect(code).toHaveValue('7K3QX9');
  await code.press('Backspace');
  await expect(code).toHaveValue('7K3QX');
});

test('[AS-066] join footer opens the private notice, then returns with the typed room code', async ({ lab }) => {
  const phone = lab.phone('B');
  await phone.getByLabel('Room code').pressSequentially('7K3 QX9');
  await expect(phone.locator('form #jnotice')).toHaveCount(0);
  await expect(phone.getByText('Do not enter patient details.')).toBeVisible();
  await phone.locator('form footer').getByRole('link', { name: 'Privacy' }).click();
  await expect.poll(() => phone.url()).toMatch(/\/privacy\.html$/);
  for (const phrase of ['7 days', '25 hours', 'patient']) await expect(phone.getByText(phrase, { exact: false }).first()).toBeVisible();
  for (const colorScheme of ['light', 'dark']) {
    await lab.page.emulateMedia({ colorScheme });
    expect(await axeViolations(phone), `privacy page, ${colorScheme}`).toEqual([]);
  }
  await phone.getByRole('link', { name: 'Back to join' }).click();
  await expect(phone.getByLabel('Room code')).toHaveValue('7K3QX9');
  expect(new URL(phone.url()).searchParams.get('slot')).toBe('B');
});
