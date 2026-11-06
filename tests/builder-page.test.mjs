import test from 'node:test';
import assert from 'node:assert/strict';
import { mountBuilderPage } from '../src/client/builder-page.mjs';
import { createBuilderStoryStarter } from '../src/client/builder-templates.mjs';

class Element {
  constructor(tag, ownerDocument) { this.tagName = tag.toUpperCase(); this.ownerDocument = ownerDocument; this.children = []; this.listeners = {}; this.attrs = {}; this.classList = { add: value => { this.className = value; } }; this.hidden = false; this.value = ''; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(key, value) { this.attrs[key] = value; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  removeEventListener(name) { delete this.listeners[name]; }
  dispatch(name, extra = {}) { return this.listeners[name]?.({ preventDefault() {}, ...extra }); }
  remove() { this.removed = true; }
}
class Document {
  constructor() { this.defaultView = new Window(); this.body = new Element('body', this); this.head = new Element('head', this); }
  getElementById(id) { return this.head.children.find(child => child.id === id) ?? null; }
  createElement(tag) { return new Element(tag, this); }
}
class Window {
  constructor() { this.listeners = {}; this.historyCalls = []; this.location = { origin: 'https://case.test', pathname: '/cases/new', assign: url => { this.assigned = url; }, reload() {} };
    this.history = { pushState: (...args) => this.historyCalls.push(['push', ...args]), replaceState: (...args) => this.historyCalls.push(['replace', ...args]) }; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  removeEventListener(name) { delete this.listeners[name]; }
  confirm() { return false; }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const makeAuth = callback => ({ onSignedIn: callback, onSignedOut: () => {}, close() {} });

test('direct edit route passes exact source identity and route view to the standalone Builder', async () => {
  const doc = new Document(), main = new Element('main', doc), auth = { sessionGeneration: () => 3 };
  const caseId = '01890f5e-7b1a-7cc1-98c4-3c0c3f4d4e5f', sourceVersion = { versionId: '01890f5e-7b1a-7cc1-98c4-3c0c3f4d4e60', versionNo: 7 };
  let args;
  const page = mountBuilderPage(main, { route: { route: 'case-edit', caseId, sourceVersion, view: 'preview' },
    authMount: (_host, callbacks) => { queueMicrotask(() => callbacks.onSignedIn(auth)); return makeAuth(); },
    headerMount: () => ({ remove() {} }), loadBuilder: async () => ({ mountBuilderCase: async (_host, value) => { args = value; return { getView: () => 'preview', close() {} }; } }) });
  await tick();
  assert.equal(args.caseId, caseId);
  assert.deepEqual(args.sourceVersion, sourceVersion);
  assert.equal(args.initialView, 'preview');
  assert.equal(doc.head.children[0].href, 'https://case.test/src/client/builder-page.css');
  page.close();
});

test('/cases/new keeps starter content in memory and replaces the URL only with the new case ID', async () => {
  const doc = new Document(), main = new Element('main', doc), auth = { sessionGeneration: () => 8 };
  const caseId = '01890f5e-7b1a-7cc1-98c4-3c0c3f4d4e61', workspaceId = '01890f5e-7b1a-7cc1-98c4-3c0c3f4d4e62';
  let builderArgs, created, requested = [];
  const page = mountBuilderPage(main, { route: { route: 'case-new' },
    authMount: (_host, callbacks) => { queueMicrotask(() => callbacks.onSignedIn(auth)); return makeAuth(); },
    headerMount: () => ({ remove() {} }), request: async (_auth, parts) => { requested.push(parts); return parts[0] === 'me' ? { memberships: [{ workspace_id: workspaceId, role: 'author', name: 'Teaching' }] } : {}; },
    createCase: async (_request, selectedWorkspace, title) => { created = { selectedWorkspace, title }; return caseId; },
    createStarter: async () => createBuilderStoryStarter(),
    loadBuilder: async () => ({ mountBuilderCase: async (_host, value) => { builderArgs = value; return { close() {} }; } }),
  });
  await tick();
  const content = main.children[1], form = content.children[1];
  assert.equal(form.tagName, 'FORM'); assert.equal(typeof form.listeners.submit, 'function');
  form.children[0].children[0].value = 'A teaching case';
  form.children[1].children[0].value = workspaceId;
  assert.equal(form.children.filter(child=>child.tagName==='LABEL').length,2,'only title and workspace precede writing');
  await form.dispatch('submit'); await tick(); await tick();
  assert.deepEqual(requested, [['me']]);
  assert.deepEqual(created, { selectedWorkspace: workspaceId, title: 'A teaching case' });
  assert.equal(builderArgs.caseId, caseId);
  assert.equal(builderArgs.initialCandidate.document.title, 'A teaching case');
  assert.equal(builderArgs.initialCandidate.document.schema_version,3);
  assert.equal(builderArgs.initialCandidate.document.decisions.length,0);
  assert.equal(doc.defaultView.historyCalls.at(-1)[3], `https://case.test/cases/${caseId}/edit?workspace=${workspaceId}`);
  assert.doesNotMatch(JSON.stringify(doc.defaultView.historyCalls), /A teaching case|ranking/);
  page.close();
});


test('a held Builder account response cannot restore menu identity after sign-out', async () => {
  const doc = new Document(), main = new Element('main', doc), auth = { sessionGeneration: () => 3 };
  let hooks, release; const identities = [];
  const page = mountBuilderPage(main, { route: { route: 'case-edit', caseId: '01890f5e-7b1a-7cc1-98c4-3c0c3f4d4e5f' },
    authMount: (_host, value) => { hooks = value; return { signOut: { click() {} } }; },
    headerMount: () => ({ setAccount(value) { identities.push(value); }, remove() {} }),
    request: () => new Promise(resolve => { release = resolve; }),
    loadBuilder: async () => ({ mountBuilderCase: async () => ({ close() {} }) }),
  });
  hooks.onSignedIn(auth); await tick(); hooks.onSignedOut();
  release({ account: { email: 'private@example.invalid', administration: true }, memberships: [] }); await tick();
  assert.ok(identities.length > 0); assert.ok(identities.every(value => value === null));
  assert.equal(main.children[1].children.length, 0);
  page.close();
});

test('[AS-125] dirty Builder cancellation retains its leave warning and sign-out fences late dirty callbacks', async () => {
  const doc = new Document(), main = new Element('main', doc), auth = { sessionGeneration: () => 3 };
  const caseId = '01890f5e-7b1a-7cc1-98c4-3c0c3f4d4e5f';
  let headerOptions, callbacks, args, confirmations = 0;
  const page = mountBuilderPage(main, { route: { route: 'case-edit', caseId },
    authMount: (_host, value) => { callbacks = value; queueMicrotask(() => value.onSignedIn(auth)); return makeAuth(); },
    headerMount: (_host, value) => { headerOptions = value; return { remove() {}, setAccount() {} }; },
    request: async () => ({ account: {}, memberships: [] }),
    loadBuilder: async () => ({ mountBuilderCase: (_host, value) => { args = value; return { close() {} }; } }),
  });
  await tick();
  args.onDirty(true); assert.equal(typeof doc.defaultView.listeners.beforeunload, 'function');
  doc.defaultView.confirm = () => { confirmations++; return false; };
  assert.equal(headerOptions.beforeNavigate(), false);
  assert.equal(typeof doc.defaultView.listeners.beforeunload, 'function');
  assert.match(headerOptions.signOutMessage(), /unsaved in-memory draft/);
  doc.defaultView.confirm = () => { confirmations++; return true; };
  assert.equal(headerOptions.beforeNavigate(), true); assert.equal(doc.defaultView.listeners.beforeunload, undefined);
  assert.equal(confirmations, 2);
  args.onDirty(true); callbacks.onSignedOut(); args.onDirty(true);
  assert.equal(doc.defaultView.listeners.beforeunload, undefined);
  assert.equal(headerOptions.beforeNavigate(), true);
  assert.doesNotMatch(headerOptions.signOutMessage(), /unsaved/);
  page.close();
});
