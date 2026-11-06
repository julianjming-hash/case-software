import test from 'node:test';
import assert from 'node:assert/strict';
import { ratingDistribution, feedbackComments, monthlyRatings } from '../src/client/feedback-presentation.mjs';
import { mountCaseFeedback, mountAdminFeedback } from '../src/client/feedback-results.mjs';
import { QUESTIONS, COMMENT_WARNING } from '../src/shared/feedback-results.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.style = {}; this._text = ''; this.className = ''; this.attrs = new Map(); this.listeners = {}; }
  get attributes() { return [...this.attrs].map(([name,value]) => ({ name,value })); }
  setAttribute(name,value) { this.attrs.set(name,String(value)); }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  removeAttribute(name) { this.attrs.delete(name); }
  append(...children) { for (let child of children) { if (typeof child === 'string') { const text = new Element(null); text.textContent = child; child = text; } child.remove(); child.parent = this; this.children.push(child); } }
  replaceChildren(...children) { for (const child of this.children) child.parent = null; this.children = []; this._text = ''; this.append(...children); }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter(n => n !== this); this.parent = null; } }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  get textContent() { return this._text + this.children.map(n => n.textContent).join(''); }
  set innerHTML(_) { throw Error('HTML is forbidden'); }
  all() { return [this,...this.children.flatMap(n => n.all())]; }
  querySelectorAll(selector) { assert.equal(selector,'*'); return this.all().slice(1); }
  addEventListener(name,fn) { (this.listeners[name] ??= []).push(fn); }
  fire(name) { for (const fn of this.listeners[name] ?? []) fn(); }
}
const find = (root,cls) => root.all().filter(n => n.className.split(' ').includes(cls));
const flush = async () => { for (let i=0;i<12;i++) await Promise.resolve(); };
async function withDocument(fn) { const previous = globalThis.document; globalThis.document = { createElement: tag => new Element(tag) }; try { await fn(); } finally { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; } }
const emptyRatings = () => ({ counts: [0,0,0,0,0], n:0 });

// Values and n can differ from the total number of submissions because each question is optional.
test('distribution bars use the question denominator, keep zero truly zero and expose exact counts',()=>withDocument(()=>{
 const root=ratingDistribution(QUESTIONS[0],{counts:[0,1,0,2,0],n:3});
 assert.deepEqual(find(root,'feedback-bar-fill').map(n=>n.style.width),['0%','33%','0%','67%','0%']);
 assert.deepEqual(find(root,'feedback-count').map(n=>n.children[0].textContent),['0','1','0','2','0']);
 assert.match(root.textContent,/n = 3/);assert.match(root.textContent,/Not useful/);assert.match(root.textContent,/Very useful/);assert.doesNotMatch(root.textContent,/average|mean/i);
 const empty=ratingDistribution(QUESTIONS[2],emptyRatings());assert.match(empty.textContent,/No ratings for this question yet/);assert.ok(find(empty,'feedback-bar-fill').every(n=>n.style.width==='0%'));
}));

test('monthly chart retains a real count table and uses one common scale across the returned months',()=>withDocument(()=>{
 const root=monthlyRatings([{month:'2026-11',counts:[0,0,0,0,10],n:10},{month:'2026-10',counts:[0,0,0,0,5],n:5},{month:'2026-09',counts:[0,0,0,0,0],n:0}]);
 assert.equal(root.all().filter(n=>n.tagName==='table').length,1);
 assert.deepEqual(find(root,'feedback-month-fill').map(n=>n.style.height),['0%','0%','0%','0%','100%','0%','0%','0%','0%','50%','0%','0%','0%','0%','0%']);
 assert.deepEqual(root.all().filter(n=>n.tagName==='th'&&n.getAttribute('scope')==='col').map(n=>n.textContent),['Month','1','2','3','4','5','n']);
 assert.deepEqual(root.all().filter(n=>n.tagName==='th'&&n.getAttribute('scope')==='row').map(n=>n.textContent),['2026-11','2026-10','2026-09']);
 assert.match(root.textContent,/same count scale/);
}));

test('participant comments remain literal text, grouped by subject, with the privacy warning first',()=>withDocument(()=>{
 const root=feedbackComments([{kind:'takeaway',about:'session',body:'<script>Text only</script>'},{kind:'comment',about:'case',body:'Long\ncomment'},{kind:'improve',about:'app',body:'Larger controls.',date:'2026-11-04'}],{dated:true,level:'h3'});
 assert.ok(root.textContent.indexOf(COMMENT_WARNING)<root.textContent.indexOf('<script>Text only</script>'));
 assert.deepEqual(find(root,'feedback-comment-group').map(n=>n.children[0].textContent),['Take home','The case','The Case app']);
 assert.equal(root.all().filter(n=>n.tagName==='script').length,0);assert.match(root.textContent,/Long\ncomment/);
}));

test('closing case feedback aborts its read and cannot restore private content after a late response',()=>withDocument(async()=>{
 const host=new Element('div'),caseId=uuidv7();let release,signal;
 const controller=mountCaseFeedback(host,{caseId,versionNo:1,request:async(_parts,options)=>{signal=options.signal;return new Promise(resolve=>{release=resolve;});}});
 assert.match(host.textContent,/Loading feedback/);controller.close();assert.equal(signal.aborted,true);
 release({case:{id:caseId,versionNo:1,title:'Late private title'},rooms:0,responses:{total:0,joined:0,qr:0},ratings:{case:emptyRatings()},comments:[],commentsTotal:0});await flush();assert.equal(host.children.length,0);assert.equal(host.textContent,'');
}));

test('Admin feedback refuses a returned case identity different from its requested scope',()=>withDocument(async()=>{
 const host=new Element('div'),sessionId=uuidv7(),caseId=uuidv7(),foreign=uuidv7();let calls=0;
 const controller=mountAdminFeedback(host,{request:async(_parts,{body})=>{
  calls++;if(body.filter.scope==='app')return{scope:'app',result:{responses:{total:0,joined:0,qr:0},ratings:{app:emptyRatings()},months:[],comments:[]},nextAfter:null};
  if(body.filter.scope==='rooms')return{scope:'rooms',result:{rooms:[{sessionId,caseId,versionNo:1,title:'Authorised title',date:'2026-11-04',responses:1}]},nextAfter:null};
  return{scope:'case',result:{case:{id:foreign,versionNo:1,title:'WRONG PRIVATE SCOPE'},rooms:0,responses:{total:0,joined:0,qr:0},ratings:{case:emptyRatings()},comments:[],commentsTotal:0},nextAfter:null};
 }});await flush();
 host.all().find(n=>n.tagName==='button'&&n.textContent==='Sessions').fire('click');await flush();host.all().find(n=>n.tagName==='button'&&n.textContent==='Version 1 feedback').fire('click');await flush();
 assert.equal(calls,3);assert.match(host.textContent,/Feedback is unavailable/);assert.doesNotMatch(host.textContent,/WRONG PRIVATE SCOPE/);controller.close();assert.equal(host.children.length,0);
}));
