import test from 'node:test';
import assert from 'node:assert/strict';
import { mountBuilderReviewControls, refusalWords } from '../src/client/builder-review-controls.mjs';

class Element {
  constructor(tag, ownerDocument) { this.tagName = tag; this.ownerDocument = ownerDocument; this.children = []; this.listeners = new Map(); this.attributes = {}; this.dataset = {}; this.disabled = false; this.hidden = false; this.type = ''; this._text = ''; }
  set innerHTML(_value) { throw new Error('HTML parsing is forbidden'); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...items) { for (const item of items) { if (item?.parent) item.remove(); item.parent = this; this.children.push(item); } }
  replaceChildren(...items) { for (const item of this.children) item.parent = null; this.children = []; this._text = ''; this.append(...items); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(type, listener) { const listeners = this.listeners.get(type) ?? []; listeners.push(listener); this.listeners.set(type, listeners); }
  async click() { for (const listener of this.listeners.get('click') ?? []) await listener({ target: this }); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
}
class Document { createElement(tag) { return new Element(tag, this); } }
const CASE = '0199a000-0000-7000-8000-00000000c620';
const CANDIDATE = '0199a000-0000-7000-8000-00000000c630';
const REQUEST = '0199a000-0000-7000-8000-00000000c640';
const HEX = '\\x' + 'a'.repeat(64);
const draft = () => ({ revision: 8, intentDigest: HEX, document: { schema_version: 1, title: '<img onerror=bad()>' }, authoringMetadata: { metadata_version: 1, preparation_requirements: 'private' } });
const candidate = (status = 'pending') => ({ candidateId: CANDIDATE, revision: 8, schemaVersion: 1, document: { schema_version: 1, title: '<img onerror=bad()>' },
  authoringMetadata: { metadata_version: 1, preparation_requirements: 'private' }, intentDigest: HEX, contentSha256: HEX, status,
  submittedAt: '2026-10-09T00:00:00Z', approvedAt: status === 'approved' ? '2026-10-09T00:01:00Z' : null });
const find = (node, label) => {
  if (node.tagName === 'button' && node.textContent === label) return node;
  for (const child of node.children) { const found = find(child, label); if (found) return found; }
  return null;
};
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function mount(request, options = {}) {
  const document = new Document(), container = document.createElement('main');
  const root = mountBuilderReviewControls(container, { caseId: CASE, request, getAcknowledgedDraft: options.getDraft ?? (() => draft()), makeId: () => REQUEST,
    current: options.current ?? (() => true), canReview: options.canReview ?? true, releaseMaterial: options.releaseMaterial, simplified: options.simplified ?? false });
  return { document, container, root };
}

test('[AS-123] submits an explicit immutable acknowledged pair with one UUIDv7 request ID', async () => {
  const calls = []; let submitted = false;
  const ui = mount(async (parts, options = {}) => {
    calls.push({ parts, options: structuredClone(options) });
    if (parts.at(-1) === 'candidates' && !options.method) return { candidates: submitted ? [{ candidateId: CANDIDATE, revision: 8, status: 'pending', submittedAt: '2026-10-09T00:00:00Z' }] : [] };
    submitted = true;
    return { candidateId: CANDIDATE, revision: 8, intentDigest: HEX, contentSha256: HEX, status: 'pending', submittedAt: '2026-10-09T00:00:00Z' };
  });
  await tick();
  const acknowledged = draft();
  await find(ui.container, 'Send for review').click(); await tick();
  const write = calls.find(call => call.options.method === 'POST');
  assert.deepEqual(write.parts, ['builder', 'cases', CASE, 'candidates']);
  assert.deepEqual(write.options.body, { requestId: REQUEST, revision: acknowledged.revision, document: acknowledged.document, authoringMetadata: acknowledged.authoringMetadata });
  assert.match(ui.container.textContent, /1 retained candidate record/);
  ui.root.clear();
});

test('lost submission acknowledgement retries the same request ID and bytes after draft changes', async () => {
  const calls = []; let submissions = 0; let latest = draft();
  const ui = mount(async (parts, options = {}) => {
    if (parts.at(-1) === 'candidates' && !options.method) return { candidates: [] };
    calls.push(structuredClone(options.body));
    submissions++;
    if (submissions === 1) throw Object.assign(new Error('request_unavailable'), { code: 'request_timeout' });
    return { candidateId: CANDIDATE, revision: 8, intentDigest: HEX, contentSha256: HEX, status: 'pending', submittedAt: '2026-10-09T00:00:00Z' };
  }, { getDraft: () => latest });
  await tick();
  await find(ui.container, 'Send for review').click(); await tick();
  latest = { ...draft(), revision: 9, document: { title: 'newer typing' } };
  await find(ui.container, 'Retry exact pending review request').click(); await tick();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[1].requestId, REQUEST);
  assert.equal(calls[1].document.title, '<img onerror=bad()>');
  ui.root.clear();
});

test('candidate inspection uses text nodes and approval/release are distinct digest-bound actions', async () => {
  const calls = []; let status = 'pending';
  const ui = mount(async (parts, options = {}) => {
    calls.push({ parts, options });
    if (parts.at(-1) === 'candidates' && !options.method) return { candidates: [{ candidateId: CANDIDATE, revision: 8, status, submittedAt: '2026-10-09T00:00:00Z' }] };
    if (parts.at(-1) === 'approve') { status = 'approved'; return { candidateId: CANDIDATE, revision: 8, status, approvedAt: '2026-10-09T00:01:00Z', intentDigest: HEX, contentSha256: HEX }; }
    if (parts.at(-1) === 'release') { status = 'released'; return { candidateId: CANDIDATE, versionId: '0199a000-0000-7000-8000-00000000c650', versionNo: 2, status, intentDigest: HEX, contentSha256: HEX }; }
    if (parts.at(-1) === CANDIDATE) return { candidate: candidate(status) };
    return { candidates: [] };
  }, { releaseMaterial: async () => ({ art: { v: 1, stops: 1, decisions: [], attempt: 0, summarised: false, renderer: 1 }, assetIds: [] }) });
  await tick();
  await find(ui.container, 'Inspect').click(); await tick();
  assert.ok(ui.container.textContent.includes('<img onerror=bad()>'));
  assert.equal(ui.container.textContent.includes('private'), true);
  assert.equal(calls.find(call => call.parts.at(-1) === CANDIDATE).options.maxResponseBytes, 2 * 1_048_576);
  assert.equal(find(ui.container, 'Approve for publication') !== null, true);
  assert.equal(find(ui.container, 'Publish'), null);
  await find(ui.container, 'Approve for publication').click(); await tick(); await tick();
  const approveCall = calls.find(call => call.parts.at(-1) === 'approve');
  assert.deepEqual(approveCall.options.body, { revision: 8, intentDigest: HEX, contentSha256: HEX });
  assert.equal(find(ui.container, 'Publish') !== null, true);
  await find(ui.container, 'Publish').click(); await tick(); await tick();
  const releaseCall = calls.find(call => call.parts.at(-1) === 'release');
  assert.deepEqual(releaseCall.options.body, { revision: 8, intentDigest: HEX, contentSha256: HEX,
    assetIds: [], art: { v: 1, stops: 1, decisions: [], attempt: 0, summarised: false, renderer: 1 } });
  ui.root.clear();
});

test('release refuses without supplied artwork/assets and never invents a release body', async () => {
  const calls = [];
  const ui = mount(async (parts, options = {}) => {
    calls.push({ parts, options });
    if (parts.at(-1) === 'candidates' && !options.method) return { candidates: [{ candidateId: CANDIDATE, revision: 8, status: 'approved', submittedAt: '2026-10-09T00:00:00Z' }] };
    return { candidate: candidate('approved') };
  });
  await tick();
  await find(ui.container, 'Inspect').click(); await tick();
  // An approved candidate is inspectable, but release stays unavailable without the reviewed art/assets dependency.
  const listing = calls.find(call => call.parts.at(-1) === 'candidates' && !call.options.method);
  assert.ok(listing);
  assert.equal(find(ui.container, 'Publish'), null);
  assert.equal(calls.some(call => call.parts.at(-1) === 'release'), false);
  ui.root.clear();
});

test('cancellation and retained-body deletion each require explicit confirmation', async () => {
  const calls = []; let selectedStatus = 'pending';
  const ui = mount(async (parts, options = {}) => {
    calls.push({ parts, options });
    if (parts.at(-1) === 'candidates' && !options.method) return { candidates: [{ candidateId: CANDIDATE, revision: 8, status: selectedStatus, submittedAt: '2026-10-09T00:00:00Z' }] };
    if (parts.at(-1) === CANDIDATE) return { candidate: { ...candidate(selectedStatus), document: selectedStatus === 'cancelled' ? null : candidate(selectedStatus).document } };
    if (parts.at(-1) === 'cancel') { selectedStatus = 'cancelled'; return { candidateId: CANDIDATE, revision: 8, status: 'cancelled' }; }
    if (parts.at(-1) === 'body') return { candidateId: CANDIDATE, deleted: true };
    return { candidates: [] };
  });
  await tick(); await find(ui.container, 'Inspect').click(); await tick();
  await find(ui.container, 'Cancel this candidate…').click();
  assert.equal(calls.some(call => call.parts.at(-1) === 'cancel'), false, 'first control only opens explicit confirmation');
  await find(ui.container, 'Confirm cancel and delete this candidate body').click(); await tick();
  assert.ok(calls.some(call => call.parts.at(-1) === 'cancel' && call.options.method === 'POST'));

  selectedStatus = 'superseded';
  await ui.root.refresh(); await tick(); await find(ui.container, 'Inspect').click(); await tick();
  await find(ui.container, 'Delete retained candidate body…').click();
  assert.equal(calls.some(call => call.parts.at(-1) === 'body'), false, 'first delete control only opens explicit confirmation');
  await find(ui.container, 'Confirm delete retained candidate body').click(); await tick();
  assert.ok(calls.some(call => call.parts.at(-1) === 'body' && call.options.method === 'DELETE'));
  ui.root.clear();
});

test('retiring the view clears private candidate content and ignores a late response', async () => {
  let finish, signedIn = true;
  const ui = mount(() => new Promise(resolve => { finish = resolve; }), { current: () => signedIn });
  const late = ui.root.refresh();
  signedIn = false;
  finish?.({ candidates: [{ candidateId: CANDIDATE, revision: 8, status: 'pending', submittedAt: '2026-10-09T00:00:00Z' }] });
  await late; await tick();
  assert.equal(ui.container.children.length, 0);
  assert.equal(ui.container.textContent, '');
});

test('author inspection does not expose administrator approval or release controls', async () => {
  const ui = mount(async parts => parts.at(-1) === 'candidates'
    ? { candidates: [{ candidateId: CANDIDATE, revision: 8, status: 'pending', submittedAt: '2026-10-09T00:00:00Z' }] }
    : { candidate: candidate() }, { canReview: false });
  await tick(); await find(ui.container, 'Inspect').click(); await tick();
  assert.equal(find(ui.container, 'Approve for publication'), null);
  assert.ok(find(ui.container, 'Cancel this candidate…'));
  ui.root.clear();
});

test('reload and repeated clicks cannot retire or duplicate an in-flight submission', async () => {
  let resolveDraft, resolveSubmit, reads = 0, writes = 0;
  const ui = mount(async (parts, options = {}) => {
    if (!options.method) { reads++; return { candidates: [] }; }
    writes++; return new Promise(resolve => { resolveSubmit = resolve; });
  }, { getDraft: () => new Promise(resolve => { resolveDraft = resolve; }) });
  await tick(); const submit = find(ui.container, 'Send for review');
  await submit.click(); await submit.click();
  await ui.root.refresh();
  assert.equal(reads, 1); assert.equal(writes, 0);
  resolveDraft(draft()); await tick(); assert.equal(writes, 1);
  await ui.root.refresh(); await submit.click(); assert.equal(reads, 1); assert.equal(writes, 1);
  resolveSubmit({ candidateId: CANDIDATE, revision: 8, intentDigest: HEX, contentSha256: HEX, status: 'pending' });
  await tick(); await ui.root.refresh();
  assert.equal(reads, 3, 'completion releases the action fence and reload works');
  ui.root.clear();
});


test('refresh after a lost submission retires the retry when the revision is approved', async () => {
  let approved = false, writes = 0;
  const ui = mount(async (parts, options = {}) => {
    if (!options.method) return { candidates: approved ? [{ candidateId: CANDIDATE, revision: 8, status: 'approved', submittedAt: '2026-10-09T00:00:00Z' }] : [] };
    writes++;
    throw Object.assign(new Error('timeout'), { code: 'request_timeout' });
  });
  await tick();
  await find(ui.container, 'Send for review').click(); await tick();
  assert.ok(find(ui.container, 'Retry exact pending submission'));
  approved = true;
  await ui.root.refresh(); await tick();
  assert.equal(find(ui.container, 'Retry exact pending submission'), null);
  assert.equal(find(ui.container, 'Retry exact pending review request'), null);
  assert.equal(writes, 1);
  ui.root.clear();
});


test('single publishing action confirms once and reuses an approved candidate without submitting', async () => {
  const writes = []; let state = 'approved';
  const ui = mount(async (parts, options = {}) => {
    if (options.method) {
      writes.push(parts.at(-1)); state = 'released';
      return { candidateId: CANDIDATE, versionId: '0199a000-0000-7000-8000-00000000c650', versionNo: 1, status: state, intentDigest: HEX, contentSha256: HEX };
    }
    if (parts.at(-1) === 'candidates') return { candidates: [{ candidateId: CANDIDATE, revision: 8, status: state, submittedAt: '2026-10-09T00:00:00Z' }] };
    return { candidate: candidate(state) };
  }, { simplified: true, releaseMaterial: () => ({ art: { v: 1 }, assetIds: [] }) });
  await tick(); await find(ui.container, 'Publish').click(); await tick();
  assert.deepEqual(writes, [], 'opening confirmation cannot attest or publish');
  await find(ui.container, 'Publish this update').click(); await tick(); await tick();
  assert.deepEqual(writes, ['release'], 'an approved snapshot needs neither resubmission nor approval');
  assert.match(ui.container.textContent, /Update published. Available to facilitators/);
  ui.root.clear();
});

test('a saved revision change after publication confirmation prevents every write', async () => {
  let latest = draft(); const writes = [];
  const ui = mount(async (parts, options = {}) => { if (options.method) writes.push(parts); return { candidates: [] }; }, { simplified: true, getDraft: () => latest });
  await tick(); await find(ui.container, 'Publish').click(); await tick();
  latest = { ...draft(), revision: 9 };
  await find(ui.container, 'Publish this update').click(); await tick();
  assert.deepEqual(writes, []); assert.match(ui.container.textContent, /draft changed/);
  ui.root.clear();
});


test('checking a lost release acknowledgement recognises publication without another confirmation or write', async () => {
  let state = 'approved', writes = 0;
  const ui = mount(async (parts, options = {}) => {
    if (options.method) { writes++; state = 'released'; throw Object.assign(new Error('timeout'), { code: 'request_timeout' }); }
    if (parts.at(-1) === 'candidates') return { candidates: [{ candidateId: CANDIDATE, revision: 8, status: state, submittedAt: '2026-10-09T00:00:00Z' }] };
    return { candidate: candidate(state) };
  }, { simplified: true, releaseMaterial: () => ({ art: { v: 1 }, assetIds: [] }) });
  await tick(); await find(ui.container, 'Publish').click(); await tick();
  await find(ui.container, 'Publish this update').click(); await tick();
  await find(ui.container, 'Check status').click(); await tick();
  assert.equal(writes, 1); assert.equal(find(ui.container, 'Publish this update'), null);
  assert.match(ui.container.textContent, /already published/);
  ui.root.clear();
});

test('a publishing refusal names each problem once with its count, not once per trace', async () => {
  const traces = Array.from({ length: 86 }, (_, i) => ({ code: 'provenance_unreviewed', at: `/provenance/${i}/review_status`, message: 'source trace has not been reviewed' }));
  const issues = [...traces, { code: 'builder_review_metadata_unresolved', message: 'Resolve source rights and source traces before publishing.' }];
  assert.equal(refusalWords(issues), '86 source traces have not been reviewed. Review them in Readiness. Resolve source rights and source traces before publishing.');
  assert.equal(refusalWords([traces[0]]), 'Source trace has not been reviewed.');
  assert.equal(refusalWords([{ code: 'x', message: 'needs text' }, { code: 'x', message: 'needs text' }, { message: 7 }]), 'Needs text. (2 places)');
  const failing = () => { const error = new Error('not ready'); error.issues = issues; throw error; };
  const ui = mount(async parts => parts.at(-1) === 'candidates' ? { candidates: [] } : {}, { simplified: true, getDraft: failing });
  await tick(); await find(ui.container, 'Publish').click(); await tick();
  const status = ui.container.textContent;
  assert.match(status, /Publishing needs attention\. 86 source traces have not been reviewed\./);
  assert.equal(status.split('not been reviewed').length - 1, 1, 'the trace message appears once');
  ui.root.clear();
});
