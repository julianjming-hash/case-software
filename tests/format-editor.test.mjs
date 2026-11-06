import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyBoldSelection, convertParagraphToList, renderFormattedText, readFormattedDom } from '../src/client/format-editor.mjs';

const paragraph = runs => ({ type: 'paragraph', runs });
const validate = () => [];
const text = value => ({ nodeType: 3, nodeValue: value, childNodes: [] });
const element = (tag, children = []) => ({ nodeType: 1, tagName: tag.toUpperCase(), childNodes: children });
const fakeDocument = () => ({
  createElement(tag) { return { nodeType: 1, tagName: tag.toUpperCase(), childNodes: [], append(...nodes) { this.childNodes.push(...nodes); } }; },
  createTextNode(value) { return text(value); },
});

test('bold selection splits and recombines only the selected text, keeping whitespace and marks', () => {
  const input = { blocks: [paragraph([{ text: ' lead ' }, { text: 'bold', bold: true }, { text: ' tail' }])] };
  assert.deepEqual(applyBoldSelection(input, { blockIndex: 0, start: 7, end: 9 }), { blocks: [paragraph([
    { text: ' lead ' }, { text: 'b', bold: true }, { text: 'ol' }, { text: 'd', bold: true }, { text: ' tail' },
  ])] });
});

test('bold selection removes bold only when the complete selection is already bold', () => {
  const input = { blocks: [paragraph([{ text: 'a' }, { text: 'bold', bold: true }, { text: 'z' }])] };
  assert.deepEqual(applyBoldSelection(input, { blockIndex: 0, start: 1, end: 5 }), { blocks: [paragraph([{ text: 'a' }, { text: 'bold' }, { text: 'z' }])] });
});

test('selection spanning text runs preserves all unselected characters and list records', () => {
  const input = { blocks: [paragraph([{ text: 'abc' }, { text: 'def', bold: true }, { text: 'ghi' }]), { type: 'list', ordered: false, items: [{ runs: [{ text: 'item' }] }] }] };
  assert.deepEqual(applyBoldSelection(input, { blockIndex: 0, start: 2, end: 7 }), { blocks: [
    paragraph([{ text: 'ab' }, { text: 'c' , bold: true }, { text: 'def', bold: true }, { text: 'g', bold: true }, { text: 'hi' }]),
    { type: 'list', ordered: false, items: [{ runs: [{ text: 'item' }] }] },
  ] });
});

test('paragraph to list conversion preserves exact text runs and list order', () => {
  const input = { blocks: [paragraph([{ text: 'one', bold: true }, { text: ' two' }]), paragraph([{ text: 'next' }])] };
  assert.deepEqual(convertParagraphToList(input, 0, false), { blocks: [
    { type: 'list', ordered: false, items: [{ runs: [{ text: 'one', bold: true }, { text: ' two' }] }] },
    paragraph([{ text: 'next' }]),
  ] });
});

test('safe renderer creates text nodes and supported tags only', () => {
  const value = { blocks: [paragraph([{ text: 'A <script>', bold: true }]), { type: 'list', ordered: true, items: [{ runs: [{ text: 'step' }] }] }] };
  const dom = renderFormattedText(fakeDocument(), value, { validateFormattedText: validate });
  assert.deepEqual(dom.childNodes.map(node => node.tagName), ['P', 'OL']);
  assert.equal(dom.childNodes[0].childNodes[0].tagName, 'STRONG');
  assert.equal(dom.childNodes[0].childNodes[0].childNodes[0].nodeValue, 'A <script>');
  assert.equal(dom.childNodes[1].childNodes[0].childNodes[0].nodeValue, 'step');
});

test('DOM reader round-trips only supported paragraph/list/bold nodes', () => {
  const host = element('div', [
    element('p', [text(' hello '), element('strong', [text('world')])]),
    element('ol', [element('li', [text('first')]), element('li', [text('second')])]),
  ]);
  assert.deepEqual(readFormattedDom(host, { validateFormattedText: validate }), { value: { blocks: [
    paragraph([{ text: ' hello ' }, { text: 'world', bold: true }]),
    { type: 'list', ordered: true, items: [{ runs: [{ text: 'first' }] }, { runs: [{ text: 'second' }] }] },
  ] }, issues: [] });
});

test('unknown DOM elements refuse without flattening the visible content', () => {
  const host = element('div', [element('p', [text('keep me'), element('img', [])])]);
  const result = readFormattedDom(host);
  assert.equal(result.value, null);
  assert.equal(result.issues[0].code, 'unsupported_dom');
});

test('browser placeholder break in an empty paragraph or list item remains empty text', () => {
  const host = element('div', [element('p', [element('br')]), element('ul', [element('li', [element('br')])])]);
  assert.deepEqual(readFormattedDom(host, { validateFormattedText: validate }), {
    value: { blocks: [paragraph([{ text: '' }]), { type: 'list', ordered: false, items: [{ runs: [{ text: '' }] }] }] }, issues: [],
  });
});
