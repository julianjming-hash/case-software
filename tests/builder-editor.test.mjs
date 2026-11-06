import { test } from 'node:test';
import assert from 'node:assert/strict';
import { builderSaveStatusText, mountBuilderSaveStatus, mountKeyedNativeFields } from '../src/client/builder-editor.mjs';

class FakeNode {
  constructor(doc, tag, text = '') { this.ownerDocument = doc; this.nodeType = tag ? 1 : 3; this.tagName = tag?.toUpperCase(); this.nodeValue = text; this.childNodes = []; this.attributes = new Map(); this.listeners = new Map(); this.parentNode = null; this._value = ''; this.selectionStart = 0; this.selectionEnd = 0; }
  get children() { return this.childNodes.filter(node => node.nodeType === 1); }
  get textContent() { return this.nodeType === 3 ? this.nodeValue : this.childNodes.map(node => node.textContent).join(''); }
  set textContent(value) { this.replaceChildren(this.ownerDocument.createTextNode(String(value))); }
  get value() { return this._value; }
  set value(value) { this._value = String(value); this.selectionStart = this.selectionEnd = 0; }
  append(...nodes) { for (const node of nodes) { node.parentNode?.removeChild(node); this.childNodes.push(node); node.parentNode = this; } }
  insertBefore(node, before) { node.parentNode?.removeChild(node); const index = before ? this.childNodes.indexOf(before) : -1; if (index < 0) this.childNodes.push(node); else this.childNodes.splice(index, 0, node); node.parentNode = this; }
  removeChild(node) { const index = this.childNodes.indexOf(node); if (index >= 0) this.childNodes.splice(index, 1); node.parentNode = null; return node; }
  replaceChildren(...nodes) { for (const child of this.childNodes) child.parentNode = null; this.childNodes = []; this.append(...nodes); }
  remove() { this.parentNode?.removeChild(this); }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  removeAttribute(key) { this.attributes.delete(key); }
  addEventListener(type, fn) { const rows = this.listeners.get(type) ?? []; rows.push(fn); this.listeners.set(type, rows); }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter(item => item !== fn)); }
  dispatch(type) { for (const fn of this.listeners.get(type) ?? []) fn({ type, target: this }); }
  focus() { this.ownerDocument.activeElement = this; this.dispatch('focus'); }
  select() { this.selectionStart = 0; this.selectionEnd = this.value.length; }
}

class FakeDocument {
  constructor() { this.activeElement = null; }
  createElement(tag) { return new FakeNode(this, tag); }
  createTextNode(text) { return new FakeNode(this, null, String(text)); }
}

const field = (key, label, value, more = {}) => ({ key, label, value, type: 'textarea', ...more });

test('save-state copy is explicit for uncertain historical and conflicting revisions', () => {
  assert.equal(builderSaveStatusText({ status: 'saved', baseRevision: 7 }), 'Saved revision 7.');
  assert.match(builderSaveStatusText({ status: 'uncertain' }), /Reconcile this exact save/);
  assert.match(builderSaveStatusText({ status: 'conflict', conflict: { revision: 9 } }), /Both copies are kept\. Saved revision 9/);
});

test('field sync preserves the keyed native node, focus and selection during readiness/save updates', () => {
  const doc = new FakeDocument(); const container = doc.createElement('section');
  const edits = [];
  const fields = mountKeyedNativeFields(container, { fields: [field('scene:uuid-a', 'Scene', 'Current text')], onEdit: (...args) => edits.push(args) });
  const node = fields.getField('scene:uuid-a');
  node.focus(); node.selectionStart = 3; node.selectionEnd = 8;
  fields.sync([field('scene:uuid-a', 'Scene', 'Current text', { issues: [{ message: 'Review this scene.' }] })]);
  assert.strictEqual(fields.getField('scene:uuid-a'), node);
  assert.strictEqual(doc.activeElement, node);
  assert.deepEqual([node.selectionStart, node.selectionEnd], [3, 8]);
  assert.equal(node.getAttribute('aria-invalid'), 'true');
  assert.equal(node.getAttribute('aria-describedby'), `${node.id}-error`);
});

test('focused editing and IME composition are reported without value replacement', () => {
  const doc = new FakeDocument(); const container = doc.createElement('section'); const edits = [];
  const fields = mountKeyedNativeFields(container, { fields: [field('summary:uuid-b', 'Summary', 'Start')], onEdit: (...args) => edits.push(args) });
  const node = fields.getField('summary:uuid-b');
  node.focus();
  node.dispatch('compositionstart');
  node.value = 'Start Japanese composition';
  node.dispatch('input');
  fields.sync([field('summary:uuid-b', 'Summary', 'Stale server text')]);
  assert.equal(edits.length, 0);
  assert.equal(node.value, 'Start Japanese composition');
  node.dispatch('compositionend');
  assert.equal(edits.length, 1);
  assert.deepEqual(edits[0], ['summary:uuid-b', 'Start Japanese composition', { composing: false }]);
});

test('field errors render as text and blur permits an explicit current-value sync', () => {
  const doc = new FakeDocument(); const container = doc.createElement('section');
  const fields = mountKeyedNativeFields(container, { fields: [field('observation:uuid-c', 'Heart rate', '100')] });
  const node = fields.getField('observation:uuid-c');
  fields.sync([field('observation:uuid-c', '<img src=x>', '100', { issues: [{ message: '<script> unsafe' }] })]);
  assert.equal(container.textContent.includes('<img src=x>'), true);
  assert.equal(container.textContent.includes('<script> unsafe'), true);
  assert.equal(node.getAttribute('aria-invalid'), 'true');
  doc.activeElement = null;
  fields.sync([field('observation:uuid-c', 'Heart rate', 'Saved value')]);
  assert.equal(node.value, 'Saved value');
  assert.equal(node.getAttribute('aria-invalid'), null);
});

test('unmount clears detached private field values and removes component nodes', () => {
  const doc = new FakeDocument(); const container = doc.createElement('section');
  const fields = mountKeyedNativeFields(container, { fields: [field('private:uuid-d', 'Private cue', 'sentinel')] });
  const node = fields.getField('private:uuid-d');
  fields.destroy();
  assert.equal(node.value, '');
  assert.equal(container.childNodes.length, 0);
  assert.equal(fields.getField('private:uuid-d'), null);
});

test('save status node uses an accessible polite live region and textContent', () => {
  const doc = new FakeDocument(); const container = doc.createElement('section');
  const status = mountBuilderSaveStatus(container);
  status.update({ status: 'saving' });
  assert.equal(container.childNodes[0].getAttribute('role'), 'status');
  assert.equal(container.childNodes[0].getAttribute('aria-live'), 'polite');
  assert.equal(container.textContent, 'Saving this draft…');
  status.destroy();
  assert.equal(container.childNodes.length, 0);
});
