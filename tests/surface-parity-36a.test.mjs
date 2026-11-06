// Card 36a (surface parity, phone, Help and access denied): the pieces a browser test cannot pin.
// Routing for /help, the Help copy against the source it restates, the splash art choice, the disclaimer
// ruling, and the payload key sets (this card adds no field to any view).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeCode, JOIN_CODE_LENGTH, PAIR_CODE_LENGTH } from '../src/shared/ids.mjs';
import { RECAP_TTL_MS, initialState, project } from '../src/shared/room-machine.mjs';
import { validArtDescriptor, describeCase, withSolution } from '../src/shared/art-descriptor.mjs';
import { solveArt } from '../src/shared/mosaic-geometry.mjs';
import { helpUrl, parseRoute } from '../src/shared/urls.mjs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const FIXTURE = JSON.parse(read('src/fixtures/synthetic-workshop.case.json'));

test('[36a] /help is one public route: the builder, the parser and the shell cache agree', () => {
  assert.match(read('src/client/site-header.mjs'), /export \{ helpUrl \} from '\.\.\/shared\/urls\.mjs'/);
  assert.match(read('src/client/shared-menu.mjs'), /helpUrl\(origin\)/);
  assert.equal(helpUrl('http://127.0.0.1:4173'), 'http://127.0.0.1:4173/help');
  assert.deepEqual(parseRoute(helpUrl('http://127.0.0.1:4173')), { route: 'help' });
  assert.ok(read('scripts/build-client.mjs').includes("'/help'"), '/help is an HTML route with the strict policy');
  assert.match(read('scripts/build-client.mjs'), /'\/help \/index\.html 200'/, '/help is rewritten to the shell');
  assert.match(read('src/client/sw.mjs'), /join\|privacy\|help\|cases/, 'the shell cache recovers /help offline');
  assert.match(read('src/client/app.mjs'), /path === '\/help'[^\n]*import\('\.\/help\.mjs'\)/, 'Help is its own lazily imported chunk');
});

test('[36a] the Help copy restates shipped behaviour and carries no disclaimer', async () => {
  const { HELP_TABS } = await import('../src/client/help.mjs');
  assert.deepEqual(HELP_TABS.map(tab => tab.title), ['Joining', 'Connection', 'Facilitating', 'Projector', 'Shared computer']);
  const words = tab => tab.answers.flatMap(a => [a.q, ...a.a.map(p => (typeof p === 'string' ? p : p.strong ?? p.link?.text ?? ''))]).join(' ');
  const all = HELP_TABS.map(words).join('\n');
  assert.doesNotMatch(all, /simulation|clinical advice|disclaimer/i, 'CASE-168: no disclaimer on Help');
  for (const tab of HELP_TABS) assert.ok(tab.answers.length >= 1 && tab.answers.every(a => a.q && a.a.length), tab.title);
  // Code aliases come from normalizeCode: O reads as 0, I and L as 1, spaces and hyphens are dropped.
  assert.equal(normalizeCode('o-i l 0 0 0', JOIN_CODE_LENGTH), '011000');
  assert.match(words(HELP_TABS[0]), /O and 0 .*I, L and 1/s);
  assert.equal(JOIN_CODE_LENGTH, 6); assert.match(all, /six characters/);
  // The shared-computer code: eight characters and five minutes (ids.mjs, directory-do.mjs).
  assert.equal(PAIR_CODE_LENGTH, 8); assert.match(words(HELP_TABS[4]), /eight characters/);
  assert.match(read('src/worker/directory-do.mjs'), /PAIR_TTL_MS = 5 \* 60 \* 1000/); assert.match(words(HELP_TABS[4]), /five minutes/);
  // The recap window (room-machine RECAP_TTL_MS) and the refusal string the phone really shows.
  assert.equal(RECAP_TTL_MS, 24 * 60 * 60 * 1000); assert.match(all, /24 hours/);
  assert.ok(read('src/client/phone.mjs').includes("closed: 'This session is not accepting new participants'"));
  assert.ok(all.includes('This session is not accepting new participants'));
  // The three code definitions that used to be a folded menu section now live in the tabs.
  assert.doesNotMatch(read('src/client/site-header.mjs'), /site-help|Sign-in code: six digits/);
  assert.match(all, /Sign-in code/);
});

test('[36a] the splash draws the room descriptor only when it validates, else the brand braid', async () => {
  const { BRAND_ART, artOrBrand } = await import('../src/client/splash.mjs');
  const desc = describeCase(FIXTURE), art = withSolution(desc, solveArt(desc));
  assert.ok(validArtDescriptor(BRAND_ART));
  assert.equal(artOrBrand(art), art);
  for (const bad of [null, undefined, {}, { v: 1, junk: true }, 'x', { ...art, stops: 'six' }]) assert.equal(artOrBrand(bad), BRAND_ART);
  // The home page requests the same brand braid through the optional lazy splash.
  const home = read('src/client/home.mjs');
  assert.match(home, /import\('\.\/splash\.mjs'\)/);
  assert.match(home, /brand: true/);
});

test('[36a] the phone draws art only from the participant view it already holds, never from the code check', () => {
  const phone = read('src/client/phone.mjs');
  assert.match(phone, /import\('\.\/splash\.mjs'\)/, 'the splash chunk is lazy in the phone');
  assert.doesNotMatch(phone, /import \{[^}]*\} from '\.\/mosaic\.mjs'/, 'the phone does not statically import the renderer');
  // The join page asks for the brand art explicitly.
  assert.match(phone, /brand: true|'brand'/);
});

test('[36a] initial public keys remain main; the exact private view adds teaching Undo and then-public timeline', () => {
  const state = initialState({ sessionId: '0198f3a0-0000-7000-8000-000000000001', joinCode: 'ABC234', caseDoc: FIXTURE });
  const keys = role => Object.keys(project(state, role, null)).sort();
  assert.deepEqual(keys('participant'), ['art', 'caseTitle', 'caseVersionNo', 'decision', 'endedAt', 'epoch', 'lastResult', 'lastRound', 'liveSurface', 'manual', 'phase', 'recap', 'recapExpiresAt', 'revision', 'role', 'sessionId', 'timeline', 'timer', 'tint', 'you']);
  assert.deepEqual(keys('display'), ['arrivalCount', 'art', 'avatars', 'caseTitle', 'caseVersionNo', 'counts', 'decision', 'displayRevision', 'endedAt', 'epoch', 'joinCode', 'joiningClosed', 'lastResult', 'manual', 'music', 'names', 'phase', 'recapExpiresAt', 'replay', 'responseResult', 'resultsPage', 'resultsShown', 'revision', 'role', 'sessionId', 'surface', 'timer', 'tint']);
  assert.deepEqual(keys('facilitator'), ['actions', 'art', 'autoLock', 'beat', 'caseTitle', 'caseVersionNo', 'debrief', 'decision', 'display', 'endedAt', 'epoch', 'flags', 'joinCode', 'joiningClosed', 'liveSurface', 'manual', 'music', 'namesShown', 'nextBeat', 'participants', 'phase', 'presentation', 'publicDisplaySurface', 'publicTimeline', 'rankedColumns', 'rankedPositionSpan', 'rankedPresentation', 'rankedRoundId', 'rankedSelection', 'recapExpiresAt', 'resolutionKind', 'resultsPage', 'resultsPageCount', 'resultsShown', 'resumePhase', 'revision', 'role', 'round', 'rounds', 'selectedPathId', 'sessionId', 'terminal', 'terminalPathId', 'textPresentation', 'timeline', 'timer', 'tint', 'undo']);
  const privateView = project(state, 'facilitator');
  assert.deepEqual(privateView.publicTimeline, []);
  assert.deepEqual(privateView.undo, { available: false, reason: 'no_teaching_action' });
  for (const role of ['participant', 'display']) {
    const view = project(state, role);
    assert.equal(Object.hasOwn(view, 'undo'), false);
    assert.equal(Object.hasOwn(view, 'publicTimeline'), false);
  }
});

test('[36a] the admin denied page names the account from the signed-in identity, as a text node, never in a URL', () => {
  const admin = read('src/client/admin.mjs');
  assert.match(admin, /administrator access/i);
  assert.doesNotMatch(admin, /innerHTML/);
  assert.match(admin, /accountRequest\(owner,\['me'\]/, 'the address comes from the same /me answer the menu uses');
  assert.doesNotMatch(admin, /searchParams\.set\([^)]*email|encodeURIComponent\([^)]*email/i);
});
