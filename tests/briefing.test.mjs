// Card 40a facilitator briefing (card 40 + feedback integration, slice 8). The briefing is derived from the published
// case document alone, so these read the built PDF back the way assistive technology does (tests/helpers/pdf-read.mjs)
// and check completeness, derivation, privacy and isolation against a schema-1 fixture and the schema-3 Diving Deeper
// document. Known answers are hand-counted from the fixtures, so a gate that cannot fire would show here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { readPdf } from './helpers/pdf-read.mjs';
import { miniCase } from './helpers/mini-case.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
import { sessionPdf } from '../src/client/session-pdf.mjs';
import { briefingRows, briefingPdf, printBriefing, linkSegments, CHROME } from '../src/client/briefing.mjs';

const DIVING = JSON.parse(readFileSync(new URL('../tests/fixtures/synthetic/diving-revision-243.json', import.meta.url), 'utf8')).document;
const META = { versionNo: 2, sha256: 'abcd1234ef567890abcd1234ef567890abcd1234ef567890abcd1234ef567890' };
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const pad = (i) => String(i).padStart(2, '0');
const short = (t) => (t.includes(' · ') ? t.split(' · ').slice(1).join(' · ') : t);
const plain = (v) => (typeof v === 'string' ? v : v?.blocks ? v.blocks.map((b) => (b.items ?? [b]).map((i) => (i.runs ?? []).map((r) => r.text).join('')).join('\n')).join('\n') : '');
const build = (doc) => readPdf(sessionPdf(briefingRows(doc, META), { title: doc.title }));
// The writer drops the space at a soft line break when text is read back (a slice-1 extraction gap, reported), so
// derivation and print parity compare text with whitespace removed.
const squash = (s) => s.replace(/\s+/g, '');
// The mini fixture's '→' is outside the PDF font: the writer refuses it rather than substituting (tested below).
const pdfSafeMini = () => { const m = miniCase(); m.doc.decisions[0].paths[2].rationale = 'PPV on untreated tension, then arrest.'; return m.doc; };

/** The recommended walk from the start beat, written independently of the renderer. */
function mainRoute(doc) {
  const B = new Map(doc.beats.map((b) => [b.id, b])), D = new Map(doc.decisions.map((d) => [d.id, d]));
  const out = [], seen = new Set();
  for (let b = B.get(doc.start_beat_id); b && !seen.has(b.id);) {
    seen.add(b.id); out.push(b);
    const d = b.decision_id && D.get(b.decision_id);
    b = B.get(d ? (d.paths.find((p) => p.recommended) ?? d.paths[0]).next_beat_id : b.next_beat_id);
  }
  return out;
}
/** The lines between one section heading and the next (headings are fixed chrome words). */
function sections(lines) {
  const at = (word, from = 0) => lines.findIndex((l, i) => i >= from && l === word);
  const run = at(CHROME.runSheet), theCase = at(CHROME.theCase, run), other = at(CHROME.otherSlides, theCase);
  assert.ok(run > 0 && theCase > run, 'run sheet precedes The Case');
  return { cover: lines.slice(0, run), runSheet: lines.slice(run + 1, theCase), theCase: lines.slice(theCase + 1, other < 0 ? undefined : other), other: other < 0 ? [] : lines.slice(other + 1) };
}
const withSpare = () => {
  const doc = pdfSafeMini(), sid = uuidv7();
  doc.surfaces.push({ id: sid, kind: 'update', title: 'Spare handout', points: ['Kept for questions afterwards.'] });
  doc.beats.push({ id: uuidv7(), kind: 'surface', title: 'Spare handout', surface_id: sid });
  return doc;
};
// Hand-counted from the fixtures: beats on the main route, route labels, and every alternative's rejoin target in order.
const KNOWN = [
  { name: 'mini (schema 1)', doc: pdfSafeMini, main: 4, paths: 5, clarifications: 0, rejoins: ['Reassess', 'Decisive intervention', 'Debrief'] },
  { name: 'Diving Deeper (schema 3)', doc: () => DIVING, main: 37, paths: 23, clarifications: 2,
    rejoins: ['S2106 workshop item. Inspectz', 'S2106 workshop item. Inspectz', 'S2142 workshop item. Insp', 'S2252 workshop item. Inspect the si', 'S2331 workshop item. Inspect t'] },
];

for (const known of KNOWN) {
  test(`[card 40a briefing] ${known.name}: every beat, route and clarification appears once, in its section, and forks rejoin`, () => {
    const doc = known.doc(), pdf = build(doc), lines = pdf.lines.map(norm), s = sections(lines);
    const main = mainRoute(doc), onMain = new Set(main.map((b) => b.id)), D = new Map(doc.decisions.map((d) => [d.id, d]));
    assert.equal(main.length, known.main, 'main-route length (known answer)');
    // Run sheet: one row per main-route beat, in order, title last in its cell; the number cells run 01…NN.
    const titled = s.runSheet.filter((l) => main.some((b) => l === b.title || l.endsWith(` ${b.title}`)));
    assert.deepEqual(titled.map((l) => main.find((b) => l === b.title || l.endsWith(` ${b.title}`)).title), main.map((b) => b.title));
    for (let i = 1; i <= main.length; i++) assert.equal(s.runSheet.filter((l) => l === pad(i)).length, 1, `run sheet row ${pad(i)}`);
    // The Case: every main-route beat once, numbered, as its title (slides) or its prompt (questions).
    const body = [...s.theCase, ...s.other];
    main.forEach((b, i) => {
      const at = s.theCase.filter((l) => l.startsWith(`${pad(i + 1)} `));
      assert.equal(at.length, 1, `beat ${pad(i + 1)} appears once in The Case`);
      const d = b.decision_id && D.get(b.decision_id);
      assert.ok(at[0].includes(d ? norm(plain(d.prompt)) : short(b.title)), `${at[0]} names ${b.title}`);
    });
    // Every other beat once, as a heading, in The Case (a fork reaches it) or under Other slides.
    for (const b of doc.beats.filter((x) => !onMain.has(x.id))) assert.equal(body.filter((l) => l === short(b.title)).length, 1, `off-route ${b.title}`);
    // Every route label once, with its classification word; the total is a known answer.
    const routeLines = [];
    for (const d of doc.decisions) for (const p of d.paths) {
      const hits = body.filter((l) => l.startsWith(`${p.label} `) && l.includes(CHROME.classification[p.classification]));
      assert.equal(hits.length, 1, `route ${p.label}`); routeLines.push(hits[0]);
    }
    assert.equal(routeLines.length, known.paths, 'route count (known answer)');
    assert.equal(body.filter((l) => l.includes(CHROME.recommended)).length, doc.decisions.filter((d) => d.paths.length > 1).length, 'Recommended once per route-changing question');
    // Clarifications: once each.
    for (const c of doc.clarifications ?? []) assert.equal(body.filter((l) => l === `${CHROME.clarification} ${c.label}`).length, 1, `clarification ${c.label}`);
    assert.equal((doc.clarifications ?? []).length, known.clarifications);
    // Forks rejoin, in order, at the known beats; every rejoin target is a beat the briefing places.
    const rejoins = s.theCase.filter((l) => l.startsWith(`${CHROME.rejoins} `)).map((l) => l.slice(CHROME.rejoins.length + 1));
    assert.deepEqual(rejoins, known.rejoins);
    for (const t of rejoins) assert.ok(doc.beats.some((b) => b.title === t));
  });
}

test('[card 40a briefing] a slide no route reaches is listed under Other slides; none means no section', () => {
  const s = sections(build(withSpare()).lines.map(norm));
  assert.deepEqual(s.other.filter((l) => l === 'Spare handout'), ['Spare handout']);
  assert.ok(s.other.includes('Kept for questions afterwards.'));
  assert.equal(build(pdfSafeMini()).lines.includes(CHROME.otherSlides), false);
});

// Every string in the document (and the meta line's version and digest), split at line breaks and at a title's
// "Label · " prefix (chapters and short titles are derived that way).
function documentStrings(doc) {
  const out = new Set();
  const walk = (v) => { if (typeof v === 'string') { out.add(v); for (const part of [...v.split(/\n+/), ...v.split(' · ')]) out.add(part); } else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x); };
  walk(doc);
  const authored = [...out].filter((x) => x.trim() && !/^[0-9a-f-]{36}$/.test(x) && !/^[a-z0-9_-]+$/.test(x));
  return [...authored, String(META.versionNo), META.sha256.slice(0, 4), META.sha256.slice(4, 8)].map(squash).sort((a, b) => b.length - a.length);
}
const chromeStrings = () => {
  const out = [];
  const walk = (v) => { if (typeof v === 'string') out.push(...v.split(/\{\w+\}/)); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  walk(CHROME);
  return out.map(squash).filter(Boolean).sort((a, b) => b.length - a.length);
};
for (const [name, doc] of [['mini', withSpare()], ['Diving Deeper', DIVING]]) {
  test(`[card 40a briefing] ${name}: every line is document text or fixed chrome (no hard-coded teaching text)`, () => {
    const pdf = build(doc), strings = documentStrings(doc), chrome = chromeStrings();
    const alts = pdf.tree.filter((t) => t.alt).map((t) => t.alt), actual = pdf.tree.filter((t) => t.actual).map((t) => t.actual);
    for (const line of [...pdf.lines, ...alts, ...actual]) {
      let rest = squash(line);
      for (const x of strings) rest = rest.split(x).join(' ').split(x.toUpperCase()).join(' '); // a chapter kicker prints in capitals
      for (const x of chrome) rest = rest.split(x).join(' ').split(x.toUpperCase()).join(' '); // a kicker prints its chrome word in capitals
      assert.match(rest, /^[\s\d·:;,.()/⁰-⁹–-]*$/, `underived text in "${line}": "${rest.trim()}"`);
    }
  });
}

// Ruling 4 (Julian, 2026-10-17): the handling label is a page header on every page, the word "Facilitator" only.
test('[card 40a briefing] the PDF is tagged: language, document title, the Facilitator header on every page, and a described glance figure', async () => {
  const doc = DIVING, pdf = readPdf(await briefingPdf(doc, META));
  assert.match(pdf.text, /\/Type \/Catalog[^\n]*\/Lang \(en\)/);
  assert.match(pdf.text, /\/Info|\/Title <FEFF/);
  assert.equal(CHROME.header, 'Facilitator');
  assert.equal(CHROME.handling, undefined, 'the old handling line is gone');
  const title = pdf.lines.indexOf(doc.title);
  assert.ok(title >= 0 && pdf.lines[title + 1] === doc.summary, 'the summary follows the title; no handling line between');
  assert.ok(pdf.pageCount > 3);
  pdf.artifacts.forEach((art, p) => assert.ok(art.includes('Facilitator'), `page ${p + 1} carries the header`));
  assert.ok(!pdf.lines.some((l) => /Facilitator copy|contains answers|^Facilitator$/.test(l)), 'the header is never read as content');
  const glance = pdf.tree.filter((t) => t.type === 'Figure').map((t) => t.alt);
  const expected = CHROME.glanceAlt.replace('{n}', '37').replace('{q}', '18').replace('{b}', '3');
  assert.ok(glance.includes(expected), `glance alt: ${glance[0]}`);
});

test('[card 40a briefing] the briefing adds no URL, token or credential: the only links are ones the author wrote', () => {
  for (const doc of [DIVING, pdfSafeMini()]) {
    const pdf = build(doc), authored = squash(JSON.stringify(doc));
    const readable = [...pdf.lines, ...pdf.tree.map((t) => t.alt ?? ''), ...pdf.tree.map((t) => t.actual ?? ''), doc.title].join('\n');
    assert.doesNotMatch(readable, /case\.iatrogenic|\/api\/|\/[JDP]\/|bearer|apikey|sb_(?:publishable|secret)|token/i);
    // Diving Deeper's notes credit image sources by URL (authored content); nothing else may carry one.
    for (const [url] of squash(readable).matchAll(/https?:[^\s)]+|www\.[^\s)]+/g)) assert.ok(authored.includes(url), `URL not in the document: ${url}`);
    assert.match(pdf.text, new RegExp(`/Title ${'<FEFF'}`), 'the PDF title is the case title');
  }
});

test('[card 40a briefing] a character outside the PDF font refuses rather than substitutes; Download says so and Print still works', async () => {
  // The writer now draws symbols, Greek and Latin Extended-A (Julian, 2026-10-17); a character in no embedded font still refuses.
  const doc = miniCase().doc; doc.decisions[0].paths[2].rationale = 'Escalate (中).';
  await assert.rejects(briefingPdf(doc, META), /pdf_font_unsupported/);
});

test('[card 40a briefing] the built-in PDF loads the writer lazily and reads back the same rows', async () => {
  const bytes = await briefingPdf(pdfSafeMini(), META), pdf = readPdf(bytes);
  assert.deepEqual(pdf.lines, readPdf(sessionPdf(briefingRows(pdfSafeMini(), META), { title: 'Mini case' })).lines);
  const src = readFileSync(new URL('../src/client/briefing.mjs', import.meta.url), 'utf8');
  assert.match(src, /import\('\.\/session-pdf\.mjs'\)/, 'the writer is a lazy import, so Print never loads it');
  assert.doesNotMatch(src, /^import[^\n]*session-pdf/m);
});

// A minimal text-only DOM: enough for the print fallback, and it has no storage, so touching storage throws.
function fakeDom() {
  const textNode = (s) => ({ text: s, parent: null, get textContent() { return this.text; }, remove() { if (this.parent) { this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; } } });
  class El {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attrs = new Map(); this.parent = null; this.className = '';
      this.classList = { add: (...c) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), ...c])].join(' '); }, remove: (...c) => { this.className = this.className.split(' ').filter((x) => !c.includes(x)).join(' '); }, contains: (c) => this.className.split(' ').includes(c) }; }
    append(...kids) { for (const k of kids) { const n = typeof k === 'string' ? textNode(k) : k; n.remove?.(); n.parent = this; this.children.push(n); } }
    remove() { if (this.parent) { this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; } }
    replaceChildren(...kids) { for (const c of this.children) c.parent = null; this.children = []; this.append(...kids); }
    set textContent(v) { this.replaceChildren(); if (v != null && v !== '') this.append(String(v)); }
    get textContent() { return this.children.map((c) => c.textContent).join(''); }
    setAttribute(k, v) { this.attrs.set(k, String(v)); } getAttribute(k) { return this.attrs.get(k) ?? null; } removeAttribute(k) { this.attrs.delete(k); }
    get attributes() { return [...this.attrs.keys()].map((name) => ({ name })); }
    querySelectorAll() { const out = []; const walk = (n) => { for (const c of n.children) if (c.tagName) { out.push(c); walk(c); } }; walk(this); return out; }
  }
  const document = { title: 'Case · Library', body: new El('body'), createElement: (t) => new El(t), createElementNS: (_, t) => new El(t), createTextNode: textNode };
  const seen = {};
  const window = { listeners: new Map(), addEventListener(k, f) { this.listeners.set(k, f); }, removeEventListener(k) { this.listeners.delete(k); },
    print() { seen.title = document.title; seen.root = document.body.children.at(-1); seen.bodyClass = document.body.className; seen.text = read(seen.root);
      seen.anchors = seen.root.querySelectorAll().filter((n) => n.tagName === 'A').map((a) => ({ href: a.href, rel: a.rel, target: a.target, text: a.textContent })); } };
  // Read as assistive technology would: an image is its label, a hidden node is silent.
  const read = (n) => !n.tagName ? n.text : n.attrs.get('aria-hidden') === 'true' ? '' : n.attrs.get('role') === 'img' ? (n.attrs.get('aria-label') ?? '') : n.children.map(read).join(' ');
  return { document, window, seen };
}

test('[card 40a briefing] the accessible print fallback renders the same derived rows, swaps only the title and leaves nothing behind', () => {
  const dom = fakeDom(), saved = { document: globalThis.document, window: globalThis.window };
  Object.assign(globalThis, { document: dom.document, window: dom.window });
  try {
    for (const doc of [DIVING, withSpare(), miniCase().doc]) {
      printBriefing(doc, META);
      assert.equal(dom.seen.title, doc.title, 'document.title during print is the case title only');
      assert.ok(dom.seen.bodyClass.includes('printing-session-record'));
      // Same text in the same order (list numbers are the PDF's own Lbl; a printed list numbers itself). The original
      // mini case (with '→') still prints, though its PDF refuses.
      if (doc !== DIVING && doc.decisions[0].paths[2].rationale.includes('→')) assert.match(dom.seen.text, /→ arrest/);
      else {
        // List numbers are the PDF's own Lbl ("1." and the objectives grid's "01", before At a glance); a printed list numbers itself.
        const lines = build(doc).lines, glance = lines.indexOf(CHROME.glance);
        assert.equal(squash(dom.seen.text), squash(lines.filter((l, i) => !/^\d+\.$/.test(l) && !(/^\d\d$/.test(l) && i < glance)).join('')), 'print and PDF carry the same text');
      }
      assert.equal(dom.document.title, 'Case · Library', 'title restored');
      assert.equal(dom.document.body.children.length, 0, 'print DOM removed');
      assert.equal(dom.document.body.className, '');
      assert.equal(dom.window.listeners.size, 0, 'no afterprint listener left');
      assert.equal(dom.seen.root.children.length, 0, 'private print DOM cleared');
    }
  } finally { Object.assign(globalThis, saved); }
});

test('[card 40a briefing] no storage, cache, broadcast or HTML sink in the briefing chunk', () => {
  const src = readFileSync(new URL('../src/client/briefing.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /localStorage|sessionStorage|indexedDB|caches\b|BroadcastChannel|innerHTML|outerHTML|insertAdjacentHTML|postMessage/);
});

// Static and literal dynamic imports, resolved against their file (pattern of tests/surface-parity-36b.test.mjs).
const DIR = new URL('../src/client/', import.meta.url), SRC = new URL('../src/', import.meta.url);
const specifiers = (url) => [...readFileSync(url, 'utf8').matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"](\.{1,2}\/[^'"]+\.mjs)['"]/g)].map((m) => m[1]);
const edges = (url) => specifiers(url).map((spec) => new URL(spec, url).href).filter((href) => href.startsWith(SRC.href));
function closure(entry) {
  const seen = new Set(); const walk = (href) => { if (seen.has(href)) return; seen.add(href); edges(new URL(href)).forEach(walk); };
  walk(new URL(entry, DIR).href);
  return new Set([...seen].map((href) => href.slice(DIR.href.length)));
}

test('[card 40a briefing] [CASE-092] projector, phone and splash module graphs, lazy chunks included, never reach the briefing', () => {
  const entries = readdirSync(DIR).filter((f) => /^(projector|phone)[\w-]*\.mjs$|^splash\.mjs$/.test(f));
  assert.ok(entries.includes('projector.mjs') && entries.includes('phone.mjs') && entries.includes('splash.mjs'));
  for (const entry of entries) {
    const reach = closure(entry);
    assert.ok(!reach.has('briefing.mjs'), `${entry} reaches briefing.mjs`);
  }
  // Only case detail and the console Room tab load it.
  const importers = readdirSync(DIR).filter((f) => f.endsWith('.mjs') && edges(new URL(f, DIR)).includes(new URL('briefing.mjs', DIR).href));
  assert.deepEqual(importers.sort(), ['case-detail.mjs', 'console-room-tab.mjs']);
  assert.ok(closure('case-detail.mjs').has('briefing.mjs') && closure('console-room-tab.mjs').has('briefing.mjs'), 'the walk does see the briefing from its importers');
});

// Ruling 3 (Julian, 2026-10-17): an authored https URL is a link (a /Link annotation in the PDF, an <a> in print);
// http, javascript: and anything else stay plain text.
const URL_A = 'https://example.org/tension?a=1';
const linkedMini = () => { const doc = pdfSafeMini(); doc.decisions[0].paths[2].rationale = `Read ${URL_A}, not http://insecure.example/x or javascript:alert(1).`; return doc; };
test('[briefing links] URLs are found in authored text; only https ones (validated by urls.mjs) become links', () => {
  assert.deepEqual(linkSegments('See https://example.org/a. Or http://plain.example/b and javascript:alert(1) (https://w.example/p_(x)).'), [
    'See ', { text: 'https://example.org/a', href: 'https://example.org/a' }, '. Or http://plain.example/b and javascript:alert(1) (',
    { text: 'https://w.example/p_(x)', href: 'https://w.example/p_(x)' }, ').']);
  assert.deepEqual(linkSegments('no links here'), ['no links here']);
  assert.deepEqual(linkSegments(''), []);
});

test('[briefing links] an authored https URL is a PDF link with its exact URI; http and javascript: stay text', async () => {
  const pdf = readPdf(await briefingPdf(linkedMini(), META));
  assert.deepEqual(pdf.annots.map((a) => a.uri), [URL_A]);
  assert.equal(pdf.tree.filter((t) => t.type === 'Link').length, 1);
  assert.ok(pdf.lines.includes(`Read ${URL_A}, not http://insecure.example/x or javascript:alert(1).`), 'the sentence reads back exactly');
  // Diving Deeper credits two sources by URL in three notes, each written "(URL)." (known answer, hand-read).
  const diving = readPdf(await briefingPdf(DIVING, META));
  assert.deepEqual(diving.annots.map((a) => a.uri).sort(), ['https://example.invalid/synthetic/source-a', 'https://example.invalid/synthetic/source-b', 'https://example.invalid/synthetic/source-b']);
  assert.equal(diving.tree.filter((t) => t.type === 'Link').length, 3);
});

test('[briefing links] the print DOM makes anchors only for https URLs, in a new tab without opener or referrer', () => {
  const dom = fakeDom(), saved = { document: globalThis.document, window: globalThis.window };
  Object.assign(globalThis, { document: dom.document, window: dom.window });
  try {
    printBriefing(linkedMini(), META);
    assert.deepEqual(dom.seen.anchors, [{ href: URL_A, rel: 'noopener noreferrer', target: '_blank', text: URL_A }]);
    assert.match(dom.seen.text, /http:\/\/insecure\.example\/x or javascript:alert\(1\)\./, 'other schemes print as text');
    assert.doesNotMatch(dom.seen.text, /Facilitator copy|contains answers/);
  } finally { Object.assign(globalThis, saved); }
});

test('[briefing header] print carries the Facilitator header on every page as a running header', () => {
  const css = readFileSync(new URL('../src/client/site.css', import.meta.url), 'utf8');
  assert.match(css, /\.briefing-print \{ page: briefing; \}/, 'the briefing prints on its own named page');
  const box = css.match(/@page briefing \{ @top-left \{ content: "([^"]*)";/);
  assert.equal(box?.[1], CHROME.header, 'the running header is the header word, in step with the PDF');
});
