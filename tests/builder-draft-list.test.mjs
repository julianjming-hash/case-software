import test from 'node:test';
import assert from 'node:assert/strict';
import { mountBuilderDraftList } from '../src/client/builder-draft-list.mjs';

class FakeNode {
  constructor(tag, ownerDocument) { this.tagName = tag; this.ownerDocument = ownerDocument; this.children = []; this.listeners = {}; this.attributes = {}; this.parentNode = null; this.hidden = false; this.disabled = false; this._text = ''; this.dataset={};this.classList={add:(...names)=>{this.className=[...new Set([...(this.className??'').split(' ').filter(Boolean),...names])].join(' ');},contains:name=>(this.className??'').split(' ').includes(name)}; }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentNode = this; this.children.push(node); } }
  remove() { if (!this.parentNode) return; const i = this.parentNode.children.indexOf(this); if (i >= 0) this.parentNode.children.splice(i, 1); this.parentNode = null; }
  replaceChildren(...nodes) { for (const child of this.children) child.parentNode = null; this.children = []; this._text = ''; this.append(...nodes); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
  getAttribute(key){return this.attributes[key]??null;}
  querySelectorAll(selector){return descendants(this).filter(n=>selector.split(',').some(s=>{const [tag,cls]=s.trim().split('.');return (!tag||n.tagName===tag)&&(!cls||(n.className??'').split(' ').includes(cls));}));}
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(type,fn){this.listeners[type]=(this.listeners[type]??[]).filter(item=>item!==fn);}
  showModal(){this.open=true;}
  close(){this.open=false;}
  focus(){this.ownerDocument.activeElement=this;}
  async fire(type) { if(this['on'+type])await this['on'+type]({target:this});for (const fn of this.listeners[type] ?? []) await fn({ target: this }); }
}
class FakeDocument {
  constructor() { this.defaultView = { addEventListener() {}, removeEventListener() {}, setInterval: fn => { this.timer = fn; return 1; }, clearInterval() {} }; }
  createElement(tag) { return new FakeNode(tag, this); }
  createElementNS(_ns,tag){return this.createElement(tag);}
}
const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
const find = (node, predicate) => descendants(node).find(predicate);
const button = (node, text) => find(node, item => item.tagName === 'button' && item.textContent === text);
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const WORKSPACE = '0199a000-0000-7000-8000-00000000c910';
const CASE_A = '0199a000-0000-7000-8000-00000000c912';
const CASE_B = '0199a000-0000-7000-8000-00000000c913';
const row = (caseId, title = 'Saved draft') => ({ caseId, title, revision: 2, updatedAt: '2026-10-09T12:00:00.000Z' });
function setup({ request = async () => ({ workspaceId: WORKSPACE, drafts: [], limit: 50, offset: 0, hasMore: false, nextOffset: 0 }), current = () => true, generation = { value: 3 } } = {}) {
  const doc = new FakeDocument(), host = doc.createElement('main'), edits = [];
  const auth = { sessionGeneration: () => generation.value };
  const control = mountBuilderDraftList(host, { auth, workspaceId: WORKSPACE, current, request, onEdit: id => edits.push(id) });
  return { doc, host, control, edits, generation };
}

test('loads content-free summaries, safely renders titles as text, and opens only on explicit action', async () => {
  let requestArgs;
  const ui = setup({ request: async (_auth, parts, options) => { requestArgs = { parts, options }; return { workspaceId: WORKSPACE, drafts: [row(CASE_A, '<script>text</script>')], limit: 50, offset: 0, hasMore: false, nextOffset: 1 }; } });
  await flush();
  assert.deepEqual(requestArgs.parts, ['builder', 'workspaces', WORKSPACE, 'drafts']);
  assert.equal(requestArgs.options.maxResponseBytes, 512 * 1024);
  assert.deepEqual(requestArgs.options.query, [['limit', '50'], ['offset', '0'],['v','2']]);
  assert.match(ui.host.textContent, /<script>text<\/script>/);
  assert.equal(ui.edits.length, 0);
  const open = find(ui.host, node => node.tagName === 'button' && node.attributes['aria-label'] === 'Open draft: <script>text</script>');
  await open.fire('click');
  assert.deepEqual(ui.edits, []);
  await button(ui.host,'Edit case').fire('click');assert.deepEqual(ui.edits,[CASE_A]);
  assert.match(ui.host.textContent,/Unsaved writing stays in its open editor tab/);
});

test('pagination is explicit and deduplicates overlap with a truthful refresh notice', async () => {
  let page = 0;
  const ui = setup({ request: async () => ++page === 1
    ? { workspaceId: WORKSPACE, drafts: [row(CASE_A)], limit: 50, offset: 0, hasMore: true, nextOffset: 1 }
    : { workspaceId: WORKSPACE, drafts: [row(CASE_A), row(CASE_B, 'Second')], limit: 50, offset: 1, hasMore: false, nextOffset: 3 } });
  await flush();
  await button(ui.host, 'Load more saved drafts').fire('click'); await flush();
  assert.equal(descendants(ui.host).filter(node => node.tagName === 'li').length, 2);
  assert.match(ui.host.textContent, /changed while paging/);
});

test('unexpected content fields are ignored and only the case identity reaches the editor callback', async () => {
  const ui = setup({ request: async () => ({ workspaceId: WORKSPACE, drafts: [{ ...row(CASE_A), document: { secret: 'clinical' } }], limit: 50, offset: 0, hasMore: false, nextOffset: 1 }) });
  await flush();
  assert.match(ui.host.textContent, /Saved draft/);
  assert.doesNotMatch(ui.host.textContent, /clinical/);
  await find(ui.host,n=>n.attributes['aria-label']==='Open draft: Saved draft').fire('click');
  assert.deepEqual(ui.edits,[]);await button(ui.host,'Edit case').fire('click');
  assert.deepEqual(ui.edits, [CASE_A]);
});

test('account retirement clears the list and fences delayed results and open callbacks', async () => {
  let release;
  const ui = setup({ request: () => new Promise(resolve => { release = resolve; }) });
  await flush();
  ui.generation.value++;
  ui.doc.timer();
  release({ workspaceId: WORKSPACE, drafts: [row(CASE_A)], limit: 50, offset: 0, hasMore: false, nextOffset: 1 });
  await flush();
  assert.equal(ui.host.children.length, 0);
  assert.deepEqual(ui.edits, []);
});

test('refresh restarts at zero and is explicit after paging', async () => {
  const offsets = [];
  const ui = setup({ request: async (_auth, _parts, options) => {
    const offset = Number(options.query[1][1]); offsets.push(offset);
    return { workspaceId: WORKSPACE, drafts: offset ? [row(CASE_B, 'Second')] : [row(CASE_A)], limit: 50, offset, hasMore: offset === 0, nextOffset: offset + 1 };
  } });
  await flush(); await button(ui.host, 'Load more saved drafts').fire('click'); await flush();
  await button(ui.host, 'Refresh saved drafts').fire('click'); await flush();
  assert.deepEqual(offsets, [0, 1, 0]);
});

const richRow = overrides => ({...row(CASE_A),audience:'Registrars',durationMin:30,artStructure:null,publicationVersion:2,publicationAt:'2026-10-08T12:00:00Z',publicationState:'changed',reviewStatus:'approved',...overrides});
test('versioned draft facts keep publication comparison and review distinct without claiming readiness',async()=>{
 const ui=setup({request:async()=>({workspaceId:WORKSPACE,summaryVersion:2,drafts:[richRow()],limit:50,offset:0,hasMore:false,nextOffset:1})});await flush();
 assert.match(ui.host.textContent,/30 minRegistrars/);assert.match(ui.host.textContent,/Unpublished changes · v2Review approved/);assert.doesNotMatch(ui.host.textContent,/Ready to publish/);
 await find(ui.host,n=>n.attributes['aria-label']==='Open draft: Saved draft').fire('click');assert.match(ui.host.textContent,/Readiness is checked before publication/);ui.control.close();assert.equal(ui.host.children.length,0);
});
test('an unsupported summary version or inconsistent summary fails closed without exposing partial cards',async()=>{
 for(const [summaryVersion,draft] of [[3,richRow()],[2,richRow({publicationVersion:null})],[2,richRow({reviewStatus:'ready'})]]){
  const ui=setup({request:async()=>({workspaceId:WORKSPACE,summaryVersion,drafts:[draft],limit:50,offset:0,hasMore:false,nextOffset:1})});await flush();assert.match(ui.host.textContent,/could not be loaded/);assert.equal(descendants(ui.host).filter(n=>n.tagName==='article').length,0);ui.control.close();
 }
});

test('absence of a current review never claims that editor readiness was not checked',async()=>{
 const ui=setup({request:async()=>({workspaceId:WORKSPACE,summaryVersion:2,drafts:[richRow({reviewStatus:null})],limit:50,offset:0,hasMore:false,nextOffset:1})});await flush();assert.match(ui.host.textContent,/No current review/);assert.doesNotMatch(ui.host.textContent,/Not checked|Ready to publish/);ui.control.close();
});


test('filtering a pending inventory keeps loading evidence until saved summaries arrive', async () => {
 let release;const ui=setup({request:()=>new Promise(resolve=>release=resolve)});
 ui.control.filter('Saved');assert.match(ui.host.textContent,/Loading saved drafts/);assert.doesNotMatch(ui.host.textContent,/0 of 0 loaded drafts match/);
 release({workspaceId:WORKSPACE,drafts:[row(CASE_A)],limit:50,offset:0,hasMore:false,nextOffset:1});await flush();
 assert.match(ui.host.textContent,/1 saved draft loaded/);assert.equal(descendants(ui.host).filter(n=>n.tagName==='li'&&!n.hidden).length,1);ui.control.close();
});
