import test from 'node:test';
import assert from 'node:assert/strict';
import { createConsoleSelects } from '../src/client/console-selects.mjs';
import { patchChildren } from '../src/client/console-focus.mjs';
// Small DOM double with the exact data-keep reconciler. A native option rebuild resets its selection,
// matching the browser: the adapter must deliberately preserve a pick and adopt fresh handlers.
class Element {
  constructor(tag, attributes = {}) { this.nodeType = 1; this.tagName = tag.toUpperCase(); this.attrs = new Map(Object.entries(attributes)); this.childNodes = []; this.parent = null; }
  get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }
  get dataset() { return Object.fromEntries([...this.attrs].filter(([name]) => name.startsWith('data-')).map(([name, value]) => [name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()), value])); }
  hasAttribute(name) { return this.attrs.has(name); }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  removeAttribute(name) { this.attrs.delete(name); }
  append(...children) { for (const child of children) { child.remove(); child.parent = this; this.childNodes.push(child); } }
  remove() { if (this.parent) this.parent.childNodes = this.parent.childNodes.filter(child => child !== this); this.parent = null; }
  replaceWith(child) { const parent = this.parent, index = parent.childNodes.indexOf(this); child.remove(); parent.childNodes[index] = child; child.parent = parent; this.parent = null; }
  contains(node) { return this === node || this.childNodes.some(child => child.contains(node)); }
  querySelectorAll(selector) { return this.childNodes.flatMap(child => [ ...(selector === '[data-console-select]' && child.hasAttribute('data-console-select') ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.childNodes.find(child => selector === 'select' && child.tagName === 'SELECT') ?? this.childNodes.map(child => child.querySelector(selector)).find(Boolean) ?? null; }
}
class Option extends Element {
  constructor(value, label, selected = false) { super('option', selected ? { selected: '' } : {}); this.value = value; this.label = label; this.disabled = false; }
  cloneNode() { const copy = new Option(this.value, this.label, this.hasAttribute('selected')); copy.disabled = this.disabled; return copy; }
}
class Select extends Element {
  constructor(options, mode, handler) { super('select', { 'data-focus-key': mode }); this.disabled = false; this.onchange = handler; this.replaceChildren(...options); }
  get options() { return this.childNodes; }
  replaceChildren(...options) { for (const child of this.childNodes) child.parent = null; this.childNodes = []; this.append(...options); this.value = options.find(option => option.hasAttribute('selected'))?.value ?? options[0]?.value ?? ''; }
}
function fresh(mode, selected, handler, label = 'One', disabled = false) {
  const root = new Element('main'), slot = new Element('span', { 'data-keep': `select-${mode}`, 'data-console-select': mode, 'data-selection-mode': mode });
  const native = new Select([new Option('0', label, selected === '0'), new Option('1', 'Two', selected === '1')], mode, handler);
  native.disabled = disabled; slot.append(native); root.append(slot); return { root, slot, native };
}
function fixture(mode = 'observed') {
  const initial = fresh(mode, '0', () => 'old'), controls = [];
  const adapter = createConsoleSelects(initial.root, { enhance: native => { const control = { native, opened: true, updates: 0, disposed: 0, update() { this.updates++; }, dispose() { this.disposed++; } }; controls.push(control); return control; } });
  const render = next => { adapter.prepare(next.root); patchChildren(initial.root, next.root); adapter.sync(); };
  render(initial); return { ...initial, adapter, controls, render };
}
test('exact data-keep patch retains one select/popup instance but dispatches fresh authority payload', () => {
  const f = fixture(), next = fresh('observed', '0', event => `new:${event.currentTarget.value}`);
  f.native.value = '1'; const updates = f.controls[0].updates;
  f.render(next);
  assert.equal(f.root.querySelector('select'), f.native); assert.equal(f.controls.length, 1);
  assert.equal(f.controls[0].opened, true); assert.equal(f.controls[0].updates, updates, 'unchanged render does not rebuild popup rows');
  assert.equal(f.native.value, '1'); assert.equal(f.native.onchange({ currentTarget: f.native }), 'new:1');
  assert.equal(f.native.hasAttribute('data-focus-key'), false, 'hidden native cannot steal visible trigger focus');
});
test('count label updates retain local pick; changed observed selected attribute applies server authority', () => {
  const f = fixture(); f.native.value = '1';
  f.render(fresh('observed', '0', () => {}, 'One · 2 responses'));
  assert.equal(f.native.value, '1'); assert.equal(f.native.options[0].label, 'One · 2 responses');
  f.render(fresh('observed', '1', () => {}, 'One · 2 responses', true));
  assert.equal(f.native.value, '1'); assert.equal(f.native.disabled, true);
  f.render(fresh('observed', '0', () => {}, 'One · 2 responses'));
  assert.equal(f.native.value, '0'); assert.equal(f.native.disabled, false); assert.equal(f.controls.length, 1);
});
test('manual timer choice survives rebuilt render defaults; removed controls and final close dispose once', () => {
  const f = fixture('manual'); f.native.value = '1';
  f.render(fresh('manual', '0', () => {}, 'No timer'));
  assert.equal(f.native.value, '1');
  f.render({ root: new Element('main') }); assert.equal(f.controls[0].disposed, 1);
  f.render(fresh('manual', '0', () => {})); assert.equal(f.controls.length, 2);
  f.adapter.dispose(); f.adapter.dispose(); assert.equal(f.controls[1].disposed, 1);
});
