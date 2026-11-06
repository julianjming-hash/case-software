import test from 'node:test';
import assert from 'node:assert/strict';
import { mountBuilderTransferControls, BUILDER_TRANSFER_UI_MAX_BYTES } from '../src/client/builder-transfer-controls.mjs';

class FakeNode {
  constructor(tag, ownerDocument) { this.tagName = tag; this.ownerDocument = ownerDocument; this.children = []; this.listeners = {}; this.attributes = {}; this._value = ''; this.checked = false; this.disabled = false; this.files = []; this.text = ''; this.parentNode = null; }
  set value(value) { this._value = String(value); if (this.tagName === 'input' && this.type === 'file' && this._value === '') this.files = []; }
  get value() { return this._value; }
  append(...nodes) { for (const node of nodes) { if (node.parentNode) node.remove(); node.parentNode = this; this.children.push(node); if (this.tagName === 'select' && this.value === '') this.value = node.value; } }
  appendChild(node) { this.append(node); return node; }
  removeChild(node) { const index = this.children.indexOf(node); if (index >= 0) this.children.splice(index, 1); node.parentNode = null; return node; }
  remove() { this.parentNode?.removeChild(this); }
  set textContent(value) { this.text = String(value); for (const child of this.children) child.parentNode = null; this.children = []; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  async fire(type) { for (const fn of this.listeners[type] ?? []) await fn({ target: this }); }
  querySelectorAll(selector) { return selector === 'input[type="checkbox"]' ? descendants(this).filter(node => node.tagName === 'input' && node.type === 'checkbox') : []; }
}
class FakeDocument {
  createElement(tag) { return new FakeNode(tag, this); }
  createTextNode(value) { const node = new FakeNode('#text', this); node.textContent = value; return node; }
}
const descendants = root => root.children.flatMap(child => [child, ...descendants(child)]);
const find = (root, predicate) => descendants(root).find(predicate);
const buttonNamed = (root, label) => find(root, node => node.tagName === 'button' && node.textContent === label);
const selectNamed = (root, label) => {
  const labelNode = find(root, node => node.tagName === 'label' && node.textContent === label);
  return labelNode?.children.at(-1);
};
const checkboxNamed = (root, labelPart) => {
  const label = find(root, node => node.tagName === 'label' && node.textContent.includes(labelPart));
  return label?.children.find(node => node.tagName === 'input');
};
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const state = () => ({
  document: { schema_version: 2, title: 'Example', notes: 'private note' },
  authoringMetadata: { metadata_version: 1, sources: [{ id: 'source-id', title: 'Uncleared source', text: 'secret source', sha256: '0'.repeat(64), rights_status: 'unknown' }] },
  revision: 4, intentDigest: 'pair-digest', dirty: false, generation: 10,
});
const validTransfer = { format: 'case-builder-transfer', transfer_version: 1, intent: 'copy' };
const summarise = pair => ({ title: pair.document.title, stages: pair.document.stages ?? 1, questions: 1, slides: 2, blocks: 3 });
const fakeTransfer = overrides => ({
  summarise,
  createExport: async args => ({ ok: true, envelope: { intent: args.intent, selected: args.sourceIds }, preview: { excluded: ['/authoring_metadata'] } }),
  parse: text => ({ ok: true, envelope: JSON.parse(text) }),
  inspect: async (_envelope, args) => ({
    ok: true, intent: args.intent, candidate: { document: { title: 'Imported' }, authoring_metadata: { metadata_version: 1 } },
    canAcceptPreservedCandidate: true, readyToAccept: true, readyForRehearsal: false,
    requiresExplicitRedactionReview: args.intent === 'copy', acknowledgementCodes: [],
    diff: [{ path: '/document/title', before: 'Old', after: 'Imported' }],
    readinessErrors: [{ code: 'missing_recovery', message: 'Recovery prompt is missing.' }],
  }),
  createCopyCandidate: async candidate => ({ ok: true, candidate: { ...candidate, document: { ...candidate.document, id: 'mapped-id' } }, mapping: { old: 'mapped-id' } }),
  ...overrides,
});
function mount({ current = state(), operations = fakeTransfer(), applyCandidate = async () => ({ ok: true }), createCopy = async () => ({ ok: true }), download, onStatus = () => {} } = {}) {
  const doc = new FakeDocument(), container = doc.createElement('main');
  const control = mountBuilderTransferControls(container, { getCurrentState: () => current, transfer: operations, applyCandidate, createCopy, download, onStatus });
  return { doc, container, control, current, operations };
}

test('[AS-221] export is one click: private fields are in, source text is out, and nothing waits on a preview', async () => {
  let exportArgs, downloaded = null;
  const operations = fakeTransfer({ createExport: async args => { exportArgs = args; return { ok: true, envelope: { intent: args.intent }, preview: {} }; } });
  const ui = mount({ operations, download: async value => { downloaded = value; } });
  assert.equal(exportArgs, undefined);
  assert.equal(buttonNamed(ui.container, 'Prepare export preview'), undefined, 'there is no second step');
  assert.equal(buttonNamed(ui.container, 'Download reviewed bundle'), undefined);
  await buttonNamed(ui.container, 'Download this case').fire('click'); await flush();
  assert.equal(exportArgs.intent, 'copy');
  assert.equal(exportArgs.includePrivate, true);
  assert.equal(exportArgs.includeSources, false);
  assert.equal(exportArgs.sourceIds.length, 0);
  assert.match(downloaded.content, /"intent":"copy"/);
  assert.equal(downloaded.filename, 'case-builder-transfer.json');
});

test('a draft that changes while the file is prepared is never downloaded', async () => {
  let release, downloaded = null;
  const operations = fakeTransfer({ createExport: () => new Promise(resolve => { release = resolve; }) });
  const ui = mount({ operations, download: async value => { downloaded = value; } });
  const pending = buttonNamed(ui.container, 'Download this case').fire('click'); await flush();
  ui.current.generation++;
  release({ ok: true, envelope: { intent: 'copy' }, preview: {} });
  await pending; await flush();
  assert.equal(downloaded, null);
  assert.match(ui.container.textContent, /changed while the file was prepared/);
});

test('what else goes in the file is chosen before the one download, and unknown-rights source text needs acknowledgment', async () => {
  let exportArgs;
  const operations = fakeTransfer({ createExport: async args => { exportArgs = args; return { ok: true, envelope: {}, preview: {} }; } });
  const ui = mount({ operations, download: async () => {} });
  checkboxNamed(ui.container, 'Include selected source text').checked = true;
  const source = checkboxNamed(ui.container, 'Uncleared source'); source.checked = true;
  checkboxNamed(ui.container, 'Include private authored fields').checked = false;
  await buttonNamed(ui.container, 'Download this case').fire('click'); await flush();
  assert.equal(exportArgs, undefined);
  assert.match(ui.container.textContent, /Acknowledge unresolved rights/);
  checkboxNamed(ui.container, 'I acknowledge source records marked unknown').checked = true;
  await buttonNamed(ui.container, 'Download this case').fire('click'); await flush();
  assert.deepEqual(exportArgs.sourceIds, ['source-id']);
  assert.equal(exportArgs.acknowledgeUnknownRights, true);
  assert.equal(exportArgs.includePrivate, false);
});

test('bounded raw transfer refuses oversize pasted input before parsing', async () => {
  let parsed = false;
  const ui = mount({ operations: fakeTransfer({ parse: () => { parsed = true; return { ok: true, envelope: validTransfer }; } }) });
  const area = find(ui.container, node => node.tagName === 'textarea');
  area.value = 'x'.repeat(BUILDER_TRANSFER_UI_MAX_BYTES + 1);
  await buttonNamed(ui.container, 'Preview import').fire('click'); await flush();
  assert.equal(parsed, false);
  assert.match(ui.container.textContent, /exceeds the local size limit/);
});

test('paste and selected file are mutually exclusive inputs, with the latest deliberate source taking precedence; choosing a file previews it', async () => {
  const seen = [];
  const operations = fakeTransfer({ parse: raw => { seen.push(raw); return { ok: true, envelope: validTransfer }; } });
  const ui = mount({ operations });
  const area = find(ui.container, node => node.tagName === 'textarea');
  const file = find(ui.container, node => node.tagName === 'input' && node.type === 'file');
  file.files = [{ size: 1, text: async () => '{"from":"file"}' }];
  file.value = 'bundle.json'; await file.fire('change'); await flush();
  assert.equal(area.value, '');
  assert.deepEqual(seen, ['{"from":"file"}'], 'a chosen file is previewed without another click');
  area.value = '{"from":"paste"}'; await area.fire('input');
  assert.equal(file.value, '');
  assert.deepEqual(file.files, []);
  await buttonNamed(ui.container, 'Preview import').fire('click'); await flush();
  assert.deepEqual(seen, ['{"from":"file"}', '{"from":"paste"}']);
});

test('a file for a saved draft refuses an unsaved one, and a draft that changes during the check is left intact', async () => {
  const current = state(); current.dirty = true;
  let inspected = 0, applied = 0;
  const operations = fakeTransfer({ inspect: async () => { inspected++; return { ok: true, candidate: {}, canAcceptPreservedCandidate: true, readyForRehearsal: true }; } });
  const ui = mount({ current, operations, applyCandidate: async () => { applied++; return { ok: true }; } });
  const area = find(ui.container, node => node.tagName === 'textarea');
  area.value = JSON.stringify({ ...validTransfer, intent: 'revise', base: { revision: 4, intent_digest: 'pair-digest' } });
  await buttonNamed(ui.container, 'Preview import').fire('click'); await flush();
  assert.equal(inspected, 0); assert.match(ui.container.textContent, /Save this draft first/);

  current.dirty = false;
  area.value = JSON.stringify(validTransfer);
  let release;
  operations.inspect = () => new Promise(resolve => { release = resolve; });
  const pending = buttonNamed(ui.container, 'Preview import').fire('click');
  await flush(); current.generation++;
  release({ ok: true, intent: 'copy', candidate: { document: {}, authoring_metadata: {} }, canAcceptPreservedCandidate: true, readyForRehearsal: true, diff: [] });
  await pending; await flush();
  assert.equal(applied, 0);
  assert.equal(buttonNamed(ui.container, 'Replace this draft').disabled, true);
  assert.equal(area.value, JSON.stringify(validTransfer));
  assert.match(ui.container.textContent, /changed while the file was checked/);
});

test('[AS-221] the preview compares the file with this draft before either action, and a preserved file that is not ready to rehearse can still be imported', async () => {
  let applied = null;
  const ui = mount({ operations: fakeTransfer(), applyCandidate: async candidate => { applied = candidate; return { ok: true }; } });
  const area = find(ui.container, node => node.tagName === 'textarea');
  area.value = JSON.stringify(validTransfer);
  const replace = buttonNamed(ui.container, 'Replace this draft'), copy = buttonNamed(ui.container, 'Import as a new case');
  assert.equal(replace.disabled, true); assert.equal(copy.disabled, true);
  await buttonNamed(ui.container, 'Preview import').fire('click'); await flush();
  const rows = find(ui.container, node => node.tagName === 'table').textContent;
  assert.match(rows, /TitleExampleImported/);
  assert.match(rows, /Slides22 \(same\)/);
  assert.match(ui.container.textContent, /Replacing keeps nothing of this draft/);
  assert.match(ui.container.textContent, /Rehearsal readiness: blocked/);
  assert.equal(replace.disabled, false); assert.equal(copy.disabled, false);
  await replace.fire('click'); await flush();
  assert.deepEqual(applied.document, { title: 'Imported' });
  assert.match(ui.container.textContent, /replaced by the file/);
});

test('[AS-221] a file from a newer Case is refused with its name and enables nothing', async () => {
  const operations = fakeTransfer({ parse: () => ({ ok: false, errors: [{ code: 'newer_case', message: 'made by a newer Case: needs `callout_icon_v2`' }] }) });
  const ui = mount({ operations });
  find(ui.container, node => node.tagName === 'textarea').value = '{}';
  await buttonNamed(ui.container, 'Preview import').fire('click'); await flush();
  assert.match(ui.container.textContent, /made by a newer Case: needs `callout_icon_v2`/);
  assert.equal(buttonNamed(ui.container, 'Replace this draft').disabled, true);
  assert.equal(buttonNamed(ui.container, 'Import as a new case').disabled, true);
});

test('a file for a saved revision can replace that draft but is not offered as a new case', async () => {
  let applied = null;
  const ui = mount({ operations: fakeTransfer(), applyCandidate: async candidate => { applied = candidate; return { ok: true }; } });
  find(ui.container, node => node.tagName === 'textarea').value = JSON.stringify({ ...validTransfer, intent: 'revise', base: { revision: 4, intent_digest: 'pair-digest' } });
  await buttonNamed(ui.container, 'Preview import').fire('click'); await flush();
  assert.equal(buttonNamed(ui.container, 'Import as a new case').disabled, true);
  await buttonNamed(ui.container, 'Replace this draft').fire('click'); await flush();
  assert.ok(applied);
});

test('a new case retries the same mapped candidate after failure and never inherits approval', async () => {
  const seen = []; let attempts = 0, identityBuilds = 0;
  const operations = fakeTransfer({ createCopyCandidate: async candidate => { identityBuilds++; return { ok: true, candidate: { ...candidate, copyId: 'stable-copy' }, mapping: { a: 'b' } }; } });
  const ui = mount({ operations, createCopy: async (candidate, options) => { seen.push([candidate, options]); return ++attempts === 1 ? { ok: false, message: 'Temporary create failure.' } : { ok: true }; } });
  find(ui.container, node => node.tagName === 'textarea').value = JSON.stringify(validTransfer);
  await buttonNamed(ui.container, 'Preview import').fire('click'); await flush();
  const create = buttonNamed(ui.container, 'Import as a new case');
  assert.equal(create.disabled, false);
  await create.fire('click'); await flush();
  assert.match(ui.container.textContent, /Temporary create failure/);
  await create.fire('click'); await flush();
  assert.equal(attempts, 2); assert.equal(identityBuilds, 1);
  assert.equal(seen[0][0], seen[1][0]); assert.deepEqual(seen[0][1].identityMap, { a: 'b' });
  assert.equal(seen[0][1].doNotInheritApproval, true);
});

test('unresolved source rights need their own review before either action', async () => {
  const operations = fakeTransfer({ inspect: async (_envelope, args) => ({ ok: true, intent: 'copy', candidate: { document: { title: 'Imported' }, authoring_metadata: { metadata_version: 1 } },
    canAcceptPreservedCandidate: !(args.acknowledgeRightsWarnings === false), acknowledgementCodes: ['rights_unresolved'], readyForRehearsal: true, diff: [] }) });
  const ui = mount({ operations });
  find(ui.container, node => node.tagName === 'textarea').value = JSON.stringify(validTransfer);
  await buttonNamed(ui.container, 'Preview import').fire('click'); await flush();
  assert.equal(buttonNamed(ui.container, 'Replace this draft').disabled, true);
  const ack = checkboxNamed(ui.container, 'I reviewed unresolved source-rights warnings'); ack.checked = true;
  await ack.fire('change'); await flush();
  assert.equal(buttonNamed(ui.container, 'Replace this draft').disabled, false);
});

test('retirement clears private UI data and fences late async completion', async () => {
  let release, statuses = [];
  const operations = fakeTransfer({ createExport: () => new Promise(resolve => { release = resolve; }) });
  const ui = mount({ operations, onStatus: value => statuses.push(value), download: async () => { statuses.push('downloaded'); } });
  const pending = buttonNamed(ui.container, 'Download this case').fire('click'); await flush();
  ui.control.retire();
  release({ ok: true, envelope: { privateText: 'late' }, preview: {} });
  await pending; await flush();
  assert.equal(ui.container.children.length, 0);
  assert.equal(statuses.includes('downloaded'), false);
});
