import test from 'node:test';
import assert from 'node:assert/strict';
import { h } from '../src/client/phone-dom.mjs';

test('phone human strings are sanitized and markup remains a literal text node', () => {
  const previousDocument = globalThis.document, previousNode = globalThis.Node;
  class Node {
    constructor(tagName, text = '') { this.tagName = tagName; this.textContent = text; this.children = []; }
    set innerHTML(value) { throw new Error('HTML sink used'); }
    setAttribute() {}
    append(child) { this.children.push(child); }
  }
  globalThis.Node = Node;
  globalThis.document = { createElement: tag => new Node(tag), createTextNode: text => new Node(null, text) };
  try {
    const node = h('p', { text: 'own\u0000\u202ename' }, '<img src=x onerror=alert(1)>\u0000', h('span', { text: 'safe' }));
    assert.equal(node.textContent, 'own name');
    assert.equal(node.children[0].tagName, null);
    assert.equal(node.children[0].textContent, '<img src=x onerror=alert(1)>');
    assert.equal(node.children[1].tagName, 'span');
  } finally { globalThis.document = previousDocument; globalThis.Node = previousNode; }
});
