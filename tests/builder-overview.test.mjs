// CASE-321: the Builder Overview counts what the draft holds, groups Readiness by what it stops, opens every slide and
// branch it draws, renders text only, and has its own address that round-trips through urls.mjs (hard rule 4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overviewCounts, overviewChecklist, renderOverview } from '../src/client/builder-overview.mjs';
import { deriveBuilderOutline } from '../src/client/builder-outline.mjs';
import { caseEditViewUrl, caseEditSourceViewUrl, parseRoute } from '../src/shared/urls.mjs';

const doc = () => ({
  schema_version: 2, title: 'Every Breath You Take', audience: 'ED registrars', setting: 'Resus', duration_min: 45, summary: 'Life-threatening asthma.', learning_objectives: ['Escalate bronchodilation'],
  start_beat_id: 'start',
  surfaces: [{ id: 's1', title: 'Arrival' }, { id: 's2', title: 'Question' }, { id: 's3', title: 'Gas' }, { id: 's4', title: 'Arrest' }, { id: 's5', title: 'Delay' }, { id: 's6', title: 'End' }],
  beats: [
    { id: 'start', kind: 'surface', title: 'Arrival', surface_id: 's1', next_beat_id: 'q' },
    { id: 'q', kind: 'decision', title: 'First hour', surface_id: 's2', decision_id: 'd' },
    { id: 'gas', kind: 'surface', title: 'First gas', surface_id: 's3', next_beat_id: 'end' },
    { id: 'delay', kind: 'surface', title: 'Delay', surface_id: 's5', next_beat_id: 'gas' },
    { id: 'end', kind: 'debrief', title: 'Debrief', surface_id: 's6' },
  ],
  decisions: [{ id: 'd', prompt: 'What now?', paths: [
    { id: 'best', label: 'Back-to-back nebs', classification: 'sound', recommended: true, reveal_surface_id: 's3', next_beat_id: 'gas' },
    { id: 'wait', label: 'Wait and see', classification: 'context-dependent', reveal_surface_id: 's5', next_beat_id: 'delay' },
    { id: 'tube', label: 'Intubate now', classification: 'terminal-unsafe', reveal_surface_id: 's4', terminal: { checkpoint_beat_id: 'q', debrief_prompt: 'Why?', restore_policy: 'snapshot' } },
  ] }],
  blocks: [{ id: 'img', type: 'image' }],
});
const metadata = () => ({ metadata_version: 1, sources: [{ id: 'a', title: 'GINA', rights_status: 'permitted' }, { id: 'b', title: 'Leatherman', rights_status: 'unknown' }], provenance: [] });

test('[AS-192] Overview counts slides, questions, branches, resets, images awaiting approval and sources needing permission', () => {
  const document = doc(), projection = deriveBuilderOutline(document);
  assert.deepEqual(overviewCounts(document, metadata(), projection, 1), { slides: 8, questions: 1, branches: 2, resets: 1, images: 1, imagesAwaiting: 1, sources: 2, sourcesNeedPermission: 1 });
  // Unchecked images are counted, not called approved or awaiting.
  assert.equal(overviewCounts(document, metadata(), projection).imagesAwaiting, null);
});

test('[AS-192] Before you publish groups Readiness into Stops publishing, Stops rehearsal and Advice, each with its jump', () => {
  const readiness = { staleSlides: 2, unreviewed: 3, entries: [
    { name: 'Case', home: null, issues: [{ code: 'rights_unresolved', at: '/sources/1/rights_status', stops: 'publish', message: 'Source 2 “Leatherman”: Record permission to use this source before publishing.' }] },
    { name: 'Slide 2 · First hour', home: '/beats/1', issues: [{ code: 'required', at: '/decisions/0/prompt', stops: 'run', message: 'Write the question' }, { code: 'fit', at: '/compositions/0', stops: null, message: 'Text is small at projector size' }, { code: 'fit', at: '/compositions/0', stops: null, message: 'Text is small at projector size' }] },
  ] };
  const bands = overviewChecklist(readiness);
  assert.deepEqual(bands.publish.map(item => item.text), ['Source 2 “Leatherman”: Record permission to use this source before publishing.', '2 slides changed since cited', 'Sources: 3 detailed traces not reviewed']);
  assert.deepEqual(bands.publish.map(item => item.at ?? item.action), ['/sources/1/rights_status', 'review', 'sources']);
  assert.deepEqual(bands.rehearsal, [{ text: 'Slide 2 · First hour: Write the question', at: '/decisions/0/prompt', home: '/beats/1' }]);
  assert.equal(bands.advice.length, 1, 'one line per message, as Readiness');
});

// A small text-only DOM: enough for the Overview's createElement/append/textContent/dataset use, and nothing that parses HTML.
function fakeDom() {
  class Node {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.dataset = {}; this.listeners = {}; this.className = ''; this._text = ''; this.style = { setProperty: (key, value) => { this.style[key] = String(value); } }; }
    set textContent(value) { this.children = []; this._text = String(value); }
    get textContent() { return this._text + this.children.map(child => typeof child === 'string' ? child : child.textContent).join(''); }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this._text = ''; this.children = nodes; }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) { return this.attributes[key] ?? null; }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    click() { for (const fn of this.listeners.click ?? []) fn(); }
    get innerHTML() { throw new Error('innerHTML is never used'); }
    set innerHTML(value) { throw new Error('innerHTML is never used'); }
    all() { return [this, ...this.children.flatMap(child => typeof child === 'string' ? [] : child.all())]; }
  }
  return { createElement: tag => new Node(tag) };
}
const element = (doc, tag, text, cls) => { const node = doc.createElement(tag); if (text !== undefined && text !== null) node.textContent = text; if (cls) node.className = cls; return node; };
const button = (doc, label, action, cls) => { const node = element(doc, 'button', label, cls); node.addEventListener('click', action); return node; };

test('[AS-192] Overview renders its header, counts, flow and grouped checklist as text, and every slide and branch opens', () => {
  const dom = fakeDom(), document = doc(), host = dom.createElement('section'), opened = [], issues = [];
  const readiness = { staleSlides: 0, unreviewed: 0, entries: [{ name: 'Case', home: null, issues: [{ at: '/sources/1/rights_status', stops: 'publish', message: 'Source 2 “Leatherman”: Record permission to use this source before publishing.' }] }] };
  renderOverview(host, { doc: dom, document, metadata: metadata(), projection: deriveBuilderOutline(document), readiness, button, element, saved: 'Saved', imagesAwaiting: 1,
    open: (...args) => opened.push(args), openIssue: at => issues.push(at), openSources: () => {}, openDetails: () => issues.push('details'), preview: () => {}, publish: { label: 'Send for review', run: () => {} }, reviewSources: () => {} });
  const text = host.textContent;
  for (const words of ['Every Breath You Take', 'ED registrars · Resus · about 45 min', 'Draft', 'Saved', '8 slides', '1 question', '2 branches', '1 reset', '1 image awaiting approval', '1 source needs permission',
    'Stops publishing · 1', 'Learning objectives', 'Escalate bronchodilation', '→ “Delay”', 'Joins First gas', '↺ resets to 2', 'Recommended']) assert.ok(text.includes(words), words);
  const nodes = host.all(), buttons = nodes.filter(node => node.tagName === 'BUTTON');
  assert.ok(buttons.some(node => node.textContent === 'Send for review…'));
  const branches = nodes.filter(node => node.className === 'builder-flow-branch');
  assert.deepEqual(branches.map(node => node.dataset.classification), ['sound', 'context-dependent', 'terminal-unsafe']);
  for (const node of branches) node.click();
  for (const node of nodes.filter(item => item.className === 'builder-flow-node')) node.click();
  assert.deepEqual(opened.slice(0, 3), [['q', 'best'], ['q', 'wait'], ['q', 'tube']]);
  assert.ok(opened.some(([id]) => id === 'gas') && opened.some(([id]) => id === 'delay'), 'off-spine slides open too');
  buttons.find(node => node.getAttribute('aria-label')?.startsWith('Open: Source 2')).click();
  buttons.find(node => node.textContent === 'Edit').click();
  assert.deepEqual(issues, ['/sources/1/rights_status', 'details']);
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-/.test(text), 'no raw ids');
});

test('[AS-192] the Overview has its own Builder address, and it round-trips', () => {
  const caseId = '0199a000-0000-7000-8000-0000000c3220', source = { versionId: '0199a000-0000-7000-8000-0000000c3221', versionNo: 3 };
  assert.equal(caseEditViewUrl(caseId, 'overview', 'https://case.invalid'), `https://case.invalid/cases/${caseId}/edit/overview`);
  assert.deepEqual(parseRoute(new URL(caseEditViewUrl(caseId, 'overview', 'https://case.invalid')).pathname), { route: 'case-edit', caseId, view: 'overview' });
  assert.deepEqual(parseRoute(new URL(caseEditSourceViewUrl(caseId, source, 'overview', 'https://case.invalid')).pathname), { route: 'case-edit', caseId, sourceVersion: source, view: 'overview' });
  assert.throws(() => caseEditViewUrl(caseId, 'topology'), TypeError);
});
