import {rememberIssueAuth,bindIssueIdentity} from '../src/client/issue-auth-binding.mjs';
// Execute the actual console hook with controlled transport/chunk promises, without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { consolePage } from '../src/client/console-pages.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
import { offerRejoin } from '../src/client/account-session.mjs';
import { canEditCases, menuIdentity as accountIdentity } from '../src/client/navigation-access.mjs';
import { parseCaseWorkspace } from '../src/shared/urls.mjs';

const integratedSource = readFileSync(new URL('../src/client/console.mjs', import.meta.url), 'utf8');
const source = process.env.CASE_CONSOLE_STARTUP_SOURCE ? readFileSync(process.env.CASE_CONSOLE_STARTUP_SOURCE, 'utf8') : integratedSource;
const begin = source.indexOf("  async function loadPrivate(");
const end = source.indexOf('  let navigationEpoch=', begin);
assert.ok(begin >= 0 && end > begin, 'actual private account loader is present');
const hook = source.slice(begin, end).trim().replaceAll('import(', 'load(');
const helpersBegin = integratedSource.indexOf('  function rememberMenuWorkspaces(');
const helpersEnd = integratedSource.indexOf('  async function loadPrivate(', helpersBegin);
assert.ok(helpersBegin >= 0 && helpersEnd > helpersBegin, 'actual integrated account helpers are present');
const helpers = integratedSource.slice(helpersBegin, helpersEnd);
const makeHook = new Function('env', `with (env) { ${helpers}; const onSignedIn = (${hook}); hooks = {onSignedIn}; return onSignedIn; }`);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function fixture({ marker = null, saved = null, mounted = null, storageUnavailable = false, invalidMembership = false, mode = 'cases', requestedSessionId = null } = {}) {
  const owner = deferred(), creation = deferred(), calls = [], options = [];
  let libraryOptions, historyOptions;
  const nodes = [], accounts = [];
  const workspaceId = uuidv7();
  const env = {
    rememberIssueAuth,bindIssueIdentity,stagedAdmin:null,navigationEpoch:0,surfaceMode:mode,privateContext(){},navigatePrivate(){return true;},invite: null, generation: 0, activeRoom: mounted, endedSummary: null, library: null, signedInAuth: null, menuIdentity: null, menuWorkspace:null,canEditCases,hooks: null, mode, requestedSessionId,requestedRecordId:null,accountIdentity, authSplash() {}, parseCaseWorkspace, location: { pathname: '/cases', origin: 'http://127.0.0.1', href: 'http://127.0.0.1/cases' },
    main: { classList: { add() {},remove(){} } }, catalog: {setAttribute(){},removeAttribute(){},replaceChildren() { nodes.length = 0; }, append(node) { nodes.push(node); } }, status: { textContent: '',classList:{add(){},remove(){}} },
    header: { setAccount(value) { accounts.push(value); } }, account: { status: { textContent: '',classList:{add(){},remove(){}} }, signOut: { click() {} } }, roomOwnership: {},
    savedSegment: () => saved, ACTIVE_ROOM_KEY: 'case:console:active-room',
    sessionStorage: { getItem() { if (storageUnavailable) throw Error('unavailable'); return marker; } },
    savedPanel: { replaceChildren() { calls.push('clear-saved'); }, querySelector() { return { remove() { calls.push('remove-offer'); } }; } }, consolePage,
    node: (tag, text, className) => ({ tag, text, className }),
    mountRoomHistory(_host, option) { calls.push('history'); historyOptions = option; return { close() {} }; },
    mountAccountDetails(_host, me, memberships) { calls.push('account'); assert.deepEqual(memberships, me.memberships); return { close() {} }; },
    async accountRequest(_auth, parts) {
      calls.push(parts[0]);
      if (parts[0] === 'me') return { memberships: invalidMembership ? [{ workspace_id: 'bad', role: 'facilitator' }] : [{ workspace_id: workspaceId, role: 'facilitator' }], nextAfter: null };
      if (parts[0] === 'sessions') return creation.promise;
      throw Error('unexpected request');
    },
    openRoom(_auth, room) { calls.push(['open', room]); env.generation++; },
    async load(path) {
      calls.push(path);
      if (path === './account-session.mjs') return { async offerRejoin(option) { options.push(option); await owner.promise; if (option.current()) calls.push('late-offer'); } };
      if(path==='./account-page.mjs')return{mountAccountPage(_host,option){calls.push('account');historyOptions=option;return{close(){}};}};
      if (path === './portfolio-page.mjs') return { mountPortfolio(_host, option) { calls.push(option.mode); historyOptions = option; assert.ok(Array.isArray(option.memberships)); return { close() {} }; } };
      if (path === './library.mjs') return { mountLibrary(_host, option) { calls.push('library'); libraryOptions = option; return { close() {} }; } };
      throw Error('unexpected chunk');
    },
  };
  return { env, owner, creation, calls, options, nodes, accounts, signedIn: makeHook(env), libraryOptions: () => libraryOptions, historyOptions: () => historyOptions, workspaceId };
}

test('[AS-115] verified fresh catalogue mounts while the owner list remains held', async () => {
  const f = fixture(); const pending = f.signedIn({}); await tick();
  assert.ok(f.calls.includes('library'), 'useful catalogue starts before the owner list resolves');
  await pending; assert.equal(f.options[0].current(), true);
  f.owner.resolve(); await tick(); assert.ok(f.calls.includes('late-offer'));
});

test('Start fences a late owner offer and open before its held creation response; failure leaves retry available', async () => {
  const f = fixture(); const ready = f.signedIn({}); await tick();
  assert.ok(f.libraryOptions(), 'fresh catalogue is ready despite held owner list');
  await ready;
  const starting = f.libraryOptions().onStart({ workspaceId: f.workspaceId, versionId: uuidv7() });
  assert.equal(f.options[0].current(), false, 'fenced at callback entry');
  f.options[0].open({ sessionId: uuidv7() });
  f.owner.resolve(); await tick();
  assert.equal(f.calls.includes('late-offer'), false);
  assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === 'open'), false);
  f.creation.reject(Error('local creation failed')); await assert.rejects(starting);
  assert.ok(f.env.library, 'failed creation keeps the mounted catalogue');
  assert.equal(f.options[0].current(), false, 'old owner result stays fenced after failure');
});

for (const [name, settings] of [
  ['same-tab marker', { marker: uuidv7() }],
  ['validated saved segment', { saved: { sessionId: uuidv7(), saved: {} } }],
  ['mounted live room', { mounted: {} }],
  ['unavailable marker storage', { storageUnavailable: true }],
]) test(`${name} preserves the serial recovery path`, async () => {
  const f = fixture(settings), pending = f.signedIn({}); await tick();
  assert.equal(f.calls.includes('library'), false);
  f.owner.resolve(); await pending;
  assert.ok(f.calls.includes('library'));
});

test('account generation change fences a late fresh owner result', async () => {
  const f = fixture(); await f.signedIn({}); f.env.generation++;
  f.owner.resolve(); await tick(); f.options[0].open({ sessionId: uuidv7() });
  assert.equal(f.calls.includes('late-offer'), false);
  assert.equal(f.calls.some(call => Array.isArray(call)), false);
});

test('private navigation epoch fences a held owner offer without requiring a DOM replacement', async()=>{
 const f=fixture();await f.signedIn({});f.env.navigationEpoch++;
 f.owner.resolve();await tick();f.options[0].open({sessionId:uuidv7()});
 assert.equal(f.options[0].current(),false);assert.equal(f.calls.includes('late-offer'),false);assert.equal(f.calls.some(call=>Array.isArray(call)),false);
});

test('invalid membership never loads catalogue or owner check', async () => {
  const f = fixture({ invalidMembership: true }); await f.signedIn({});
  assert.equal(f.calls.includes('./library.mjs'), false);
  assert.equal(f.calls.includes('./account-session.mjs'), false);
});

test('explicit requested session stays serial and reaches only the verified owner-offer path', async () => {
  const requestedSessionId = uuidv7(), f = fixture({ requestedSessionId }), pending = f.signedIn({}); await tick();
  assert.equal(f.calls.includes('library'), false);
  assert.equal(f.options[0].requestedSessionId, requestedSessionId);
  assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === 'open'), false);
  f.owner.resolve(); await pending;
  assert.ok(f.calls.includes('late-offer')); assert.ok(f.calls.includes('library'));
  assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === 'open'), false);
});

for (const mode of ['history', 'account']) test(`${mode} validates membership and never checks or claims owned live rooms`, async () => {
  const f = fixture({ mode, marker: uuidv7(), saved: { sessionId: uuidv7(), saved: {} }, requestedSessionId: uuidv7() });
  await f.signedIn({});
  assert.ok(f.calls.includes(mode)); assert.equal(f.calls.includes('library'), false);
  assert.equal(f.calls.includes('./account-session.mjs'), false); assert.equal(f.options.length, 0);
  assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === 'open'), false);
  if (mode === 'history') { assert.equal(f.historyOptions().current(), true); f.env.generation++; assert.equal(f.historyOptions().current(), false); }
});

for (const mode of ['history', 'account']) test(`${mode} membership failure uses the actual guarded account-access Retry helper`, async () => {
  const f = fixture({ mode, invalidMembership: true }), auth = {};
  await f.signedIn(auth);
  assert.equal(f.calls.includes(mode), false); assert.equal(f.calls.includes('./account-session.mjs'), false);
  assert.equal(f.accounts.at(-1), null);
  const retry = f.nodes.find(node => node.text === 'Retry account access'); assert.ok(retry);
  retry.onclick(); await tick();
  assert.equal(f.calls.filter(call => call === 'me').length, 2, 'current account Retry makes another membership request');
  const before = f.calls.filter(call => call === 'me').length;
  f.env.signedInAuth = {}; retry.onclick(); await tick();
  assert.equal(f.calls.filter(call => call === 'me').length, before, 'old account Retry cannot act for another identity');
});

test('actual requested-session offer requires an explicit press even when a same-tab marker exists', async () => {
  const sessionId = uuidv7(), originalDocument = globalThis.document, originalStorage = globalThis.sessionStorage;
  const requests = [], held = [], opened = [], boxes = [];
  const element = tag => ({ tag, children: [], listeners: {}, append(...nodes) { this.children.push(...nodes); }, addEventListener(name, callback) { this.listeners[name] = callback; } });
  globalThis.document = { createElement: element };
  globalThis.sessionStorage = { getItem: () => sessionId };
  try {
    await offerRejoin({ requestedSessionId: sessionId, current: () => true, panel: { prepend: box => boxes.push(box) }, status: {},
      ownership: { holdRoom: id => { held.push(id); return true; } }, open: room => opened.push(room),
      request: async parts => { requests.push(parts); return parts[0] === 'me' ? { rooms: [{ sessionId, joinCode: '7K3QX9', expiresAt: new Date(Date.now() + 60_000).toISOString() }], nextAfter: null } : { facilitatorToken: 'local-only' }; },
    });
    assert.equal(opened.length, 0); assert.equal(held.length, 0); assert.deepEqual(requests.map(parts => parts[0]), ['me']);
    const press = boxes[0].children.find(node => node.tag === 'button'); assert.ok(press);
    await press.listeners.click(); assert.equal(opened.length, 1); assert.equal(opened[0].sessionId, sessionId);
    assert.deepEqual(requests.at(-1), ['sessions', sessionId, 'facilitator-token']);
  } finally { if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
    if (originalStorage === undefined) delete globalThis.sessionStorage; else globalThis.sessionStorage = originalStorage; }
});

test('history-owned same-tab session resume acquires its marker lock and waits for the room mount', async () => {
  const sessionId = uuidv7(), originalDocument = globalThis.document, originalStorage = globalThis.sessionStorage;
  const requests = [], held = [], opened = [], gate = deferred();
  const element = tag => ({ tag, children: [], listeners: {}, append(...nodes) { this.children.push(...nodes); }, addEventListener(name, callback) { this.listeners[name] = callback; } });
  globalThis.document = { createElement: element };
  globalThis.sessionStorage = { getItem: () => sessionId };
  try {
    // A unique module URL resets its one-auto-attempt-per-page guard without mutating production code.
    const { offerRejoin: resume } = await import(`../src/client/account-session.mjs?resume-test=${uuidv7()}`);
    let settled = false;
    const pending = resume({ requestedSessionId: sessionId, resumeRequestedSession: true, current: () => true,
      panel: { prepend() { assert.fail('owned same-tab room should resume without an offer'); } }, status: {},
      ownership: { holdRoom: async id => { held.push(id); return true; }, releaseRoom() {} },
      open: async room => { opened.push(room); await gate.promise; },
      request: async parts => { requests.push(parts); return parts[0] === 'me'
        ? { rooms: [{ sessionId, joinCode: '7K3QX9', expiresAt: new Date(Date.now() + 60_000).toISOString() }], nextAfter: null }
        : { facilitatorToken: 'local-only' }; },
    }).then(() => { settled = true; });
    await tick();
    assert.deepEqual(held, [sessionId], 'the exact tab-local marker is fenced by its room lock');
    assert.deepEqual(requests.map(parts => parts[0]), ['me', 'sessions']);
    assert.equal(opened.length, 1);
    assert.equal(settled, false, 'owner recovery waits until lazy room mounting completes');
    gate.resolve(); await pending;
    assert.equal(settled, true);
  } finally {
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
    if (originalStorage === undefined) delete globalThis.sessionStorage; else globalThis.sessionStorage = originalStorage;
  }
});

for (const [label, marker, lockResult] of [
  ['foreign marker', uuidv7(), true],
  ['contended same-tab lock', null, false],
]) test(`requested-session resume stays deliberate for ${label}`, async () => {
  const sessionId = uuidv7(), originalDocument = globalThis.document, originalStorage = globalThis.sessionStorage;
  const held = [], opened = [], boxes = [];
  const actualMarker = label === 'foreign marker' ? marker : sessionId;
  const element = tag => ({ tag, children: [], listeners: {}, append(...nodes) { this.children.push(...nodes); }, addEventListener(name, callback) { this.listeners[name] = callback; } });
  globalThis.document = { createElement: element };
  globalThis.sessionStorage = { getItem: () => actualMarker };
  try {
    const { offerRejoin: resume } = await import(`../src/client/account-session.mjs?resume-test=${uuidv7()}`);
    await resume({ requestedSessionId: sessionId, resumeRequestedSession: true, current: () => true,
      panel: { prepend: box => boxes.push(box) }, status: {},
      ownership: { holdRoom: async id => { held.push(id); return lockResult; }, releaseRoom() {} },
      open: room => opened.push(room),
      request: async parts => parts[0] === 'me' ? { rooms: [{ sessionId, joinCode: '7K3QX9',
        expiresAt: new Date(Date.now() + 60_000).toISOString() }], nextAfter: null } : { facilitatorToken: 'local-only' },
    });
    assert.deepEqual(opened, [], 'a foreign marker or lock holder cannot trigger resume');
    assert.equal(held.length, label === 'foreign marker' ? 0 : 1, 'only a matching marker attempts the ownership lock');
    assert.equal(boxes.length, 1, 'failed ownership remains recoverable by explicit press');
  } finally {
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
    if (originalStorage === undefined) delete globalThis.sessionStorage; else globalThis.sessionStorage = originalStorage;
  }
});
