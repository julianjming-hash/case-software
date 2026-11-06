// The built-in tagged PDF writer (card 40 integration slice 1). Text is read back the way assistive technology reads
// it: through the structure tree, the parent tree, ToUnicode and /ActualText, never by searching the bytes.
// SESSION_PDF overrides the module under test, so the same assertions can be shown failing on an older writer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { readPdf } from './helpers/pdf-read.mjs';
const { sessionPdf } = await import(process.env.SESSION_PDF ? pathToFileURL(process.env.SESSION_PDF).href : '../src/client/session-pdf.mjs');

const DOC = [
  ['SECT', { title: 'Day 8 · Next step' }],
  ['H3', 'Support and antibiotics continue. What do we do next?'],
  ['P', { runs: [{ sym: 'single', label: 'Single choice' }, ' Urgent surgical assessment ', { sym: 'sound', label: 'Sound', colour: 'ink' }, ' Sound'] }],
  ['P', 'White cells 2.74 × 10⁹/L, platelets 101 × 10⁹/L.'],
  ['L', { items: ['Ceftriaxone and doxycycline started', 'Leptospirosis tests and blood cultures sent'] }],
  ['L', { ordered: true, items: ['Resuscitation and ICU support', 'Source control (surgery)'] }],
  ['TABLE', { cols: [1, 4, 3, 1], head: ['', 'Answer', '', 'n'], rows: [
    [{ runs: [{ mark: 0, label: 'Red triangle' }] }, 'Keep watching on antibiotics', { bar: { value: 4, total: 33, colour: 'd34b36' } }, '4'],
    [{ runs: [{ mark: 1, label: 'Blue diamond' }] }, 'Ask the surgeons to explore now', { bar: { value: 24, total: 33, colour: '5e74cc' } }, '24'],
  ] }],
  ['BOX', { fill: 'private', rows: [['P', { runs: 'Ask what the CT leaves unresolved.', colour: 'privateInk' }], ['P', { runs: [{ sym: 'cue', label: 'Cue' }, ' Confirm urgent surgical escalation.'] }]] }],
  ['DIAGRAM', { alt: 'Three route choices on the main route', height: 40, draw: [{ line: [[0, 20], [499, 20]], stroke: 'petrol', width: 3 }, { sym: 'dia', x: 100, y: 14, size: 12 }, { text: 'Day 6', x: 90, y: 8 }] }],
  ['ART', { height: 20, draw: [{ rect: [0, 0, 499, 20], fill: 'quiet' }, { text: 'decorative words', x: 4, y: 14 }] }],
  ['/SECT'],
  ['P', 'After the section.'],
];

test('[card 40 writer] text reads back exactly, in structure order, with symbols and superscripts as their words', () => {
  const pdf = readPdf(sessionPdf(DOC, { title: 'Diving Deeper' }));
  assert.deepEqual(pdf.lines, [
    'Day 8 · Next step',
    'Support and antibiotics continue. What do we do next?',
    'Single choice Urgent surgical assessment Sound Sound',
    'White cells 2.74 × 10⁹/L, platelets 101 × 10⁹/L.',
    'Ceftriaxone and doxycycline started', 'Leptospirosis tests and blood cultures sent',
    '1.', 'Resuscitation and ICU support', '2.', 'Source control (surgery)',
    'Answer', 'n', 'Red triangle', 'Keep watching on antibiotics', '4', 'Blue diamond', 'Ask the surgeons to explore now', '24',
    'Ask what the CT leaves unresolved.', 'Cue Confirm urgent surgical escalation.',
    'Three route choices on the main route',
    'After the section.',
  ]);
  assert.doesNotMatch(pdf.lines.join('\n'), /decorative words|Page \d/, 'art and the page footer are Artifacts, never read');
});

test('[card 40 writer] the structure tree has a Document, sections, lists, a table with column headers and a described figure', () => {
  const pdf = readPdf(sessionPdf(DOC));
  const types = pdf.tree.map((t) => t.type);
  assert.equal(pdf.tree[0].type, 'Document');
  for (const t of ['Sect', 'H2', 'H3', 'P', 'Span', 'L', 'LI', 'Lbl', 'LBody', 'Table', 'TR', 'TH', 'TD', 'Figure']) assert.ok(types.includes(t), t);
  assert.ok(pdf.tree.filter((t) => t.type === 'TH').every((t) => t.scope === 'Column'));
  assert.deepEqual(pdf.tree.filter((t) => t.type === 'Figure').map((t) => t.alt), ['Three route choices on the main route']);
  assert.ok(pdf.tree.filter((t) => t.type === 'Span').every((t) => t.actual), 'every symbol or superscript span carries /ActualText');
});

test('[card 40 writer] the parent tree maps every marked-content id to the element that owns it, once', () => {
  const pdf = readPdf(sessionPdf([...DOC, ...Array.from({ length: 120 }, (_, i) => ['P', `Recorded activity ${i + 1}: naïve résumé − 20.`])]));
  assert.ok(pdf.pageCount >= 2);
  const keys = pdf.seen.map(([p, m]) => `${p}:${m}`);
  assert.equal(new Set(keys).size, keys.length, 'no MCID is claimed twice');
  for (const [page, mcid, owner] of pdf.seen) assert.equal(pdf.parentTree.get(page)[mcid], owner, `page ${page} MCID ${mcid}`);
  for (const [page, owners] of pdf.parentTree) assert.equal(owners.length, pdf.seen.filter(([p]) => p === page).length, `page ${page} has no orphan MCID`);
});

test('[card 40 writer] a box continues across pages with its background on each, and a heading never ends a page', () => {
  const long = Array.from({ length: 70 }, (_, i) => ['P', `Note line ${i + 1} about the calf, neck and shoulder.`]);
  const bytes = sessionPdf([['H2', 'Notes'], ['BOX', { fill: 'private', rows: long }], ...Array.from({ length: 30 }, (_, i) => ['P', `Filler ${i}`]), ['H2', 'Late heading'], ['P', 'Its first line.']]);
  const pdf = readPdf(bytes);
  assert.ok(pdf.pageCount >= 2);
  // Room PDFs v2: a card is a rounded path (Room PDFs v2), drawn from the column's left edge across its width.
  const fills = [...pdf.text.matchAll(/\/Artifact BMC\nq 0\.93 0\.93 0\.97 rg 58 ([\d.]+) m /g)].length;
  assert.ok(fills >= 2, `box background drawn on each page it spans (found ${fills})`);
  // Sweep the filler length so that some case puts the heading exactly at a page boundary: it must move with its line.
  for (let n = 20; n <= 60; n++) {
    const sweep = readPdf(sessionPdf([...Array.from({ length: n }, (_, i) => ['P', `Filler ${i}`]), ['H2', 'Late heading'], ['P', 'Its first line.']]));
    const pageOf = (type, idx) => { const el = sweep.tree.filter((t) => t.type === type).at(idx); return sweep.seen.find(([, , owner]) => owner === el.id)[0]; };
    assert.equal(pageOf('H2', -1), pageOf('P', -1), `heading and its first line share a page (n=${n})`);
  }
});

test('[card 40 writer] a wrapped paragraph keeps the space at each soft line break, in text and in table cells', () => {
  const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
  const pdf = readPdf(sessionPdf([['P', words], ['TABLE', { cols: [1, 1], rows: [[words, 'n']] }]]));
  assert.equal(pdf.lines[0], words);
  assert.equal(pdf.lines[1], words, 'a wrapped table cell reads back with its spaces');
});

test('[card 40 writer] a box never leaves a padding-only strip at the foot or head of a page', () => {
  for (let n = 20; n <= 70; n++) {
    const pdf = readPdf(sessionPdf([...Array.from({ length: n }, (_, i) => ['P', `Filler ${i}`]), ['BOX', { fill: 'private', rows: [['P', 'Boxed line one.'], ['P', 'Boxed line two.']] }]]));
    // Each segment's height: the rounded path starts at its bottom edge (x+r, bottom) and its top edge is bottom + h.
    for (const m of pdf.text.matchAll(/\/Artifact BMC\nq 0\.93 0\.93 0\.97 rg 58 ([\d.]+) m [\d.]+ [\d.]+ l [^\n]*? 547 ([\d.]+) l /g))
      assert.ok(Number(m[2]) - Number(m[1]) + 10 > 16, `a box segment holds content, not just padding (n=${n}, height ${Number(m[2]) - Number(m[1]) + 10})`);
  }
});

test('[card 40 writer] existing callers keep working and refusals stay refusals', () => {
  const pdf = readPdf(sessionPdf([['H1', 'Teaching café'], ['H2', 'Round 1: resolved'], ['P', 'Opened: 14:04.']]));
  assert.deepEqual(pdf.lines, ['Teaching café', 'Round 1: resolved', 'Opened: 14:04.']);
  assert.throws(() => sessionPdf([['P', '中']]), /pdf_font_unsupported/, 'an unsupported character refuses, never substitutes');
  assert.throws(() => sessionPdf([['X', 'unknown role']]), /pdf_input/);
  assert.throws(() => sessionPdf([['P', { runs: [{ sym: 'nope', label: 'x' }] }]]), /pdf_input/);
  assert.throws(() => sessionPdf([['DIAGRAM', { alt: '', height: 10, draw: [] }]]), /pdf_input/, 'a meaningful figure needs a text alternative');
  assert.doesNotThrow(() => sessionPdf([['BOX', { rows: [['BOX', { rows: [['P', 'An inner card.']] }]] }]]), 'a card holds one level of inner card (Room PDFs v2)');
  assert.throws(() => sessionPdf([['BOX', { rows: [['BOX', { rows: [['BOX', { rows: [] }]] }]] }]]), /pdf_input/, 'cards nest one level only');
  assert.throws(() => sessionPdf(Array.from({ length: 100 }, () => ['P', 'A paragraph.']), { maxPages: 1 }), /pdf_page_budget/);
});

// Julian's ruling (2026-10-17): characters outside the primary font draw from a second, embedded fallback subset built
// from bundled OFL fonts only, with its own ToUnicode, so the real symbols draw and the text stays exact.
const fontCount = (pdf) => (pdf.text.match(/\/Subtype \/Type0/g) ?? []).length;
test('[pdf symbols] ≥, ✓, → and a Greek letter read back exactly through ToUnicode, in a paragraph and a table cell', () => {
  const para = 'Target SpO2 ≥ 94% ✓ then wean → room air; μ-opioid ≤ 2 doses ✗ ← ↔ ≠ ≈ 5 ⇒ ✔ ✘ ⇔.';
  const long = Array.from({ length: 40 }, (_, i) => `step ${i} → MAP ≥ ${60 + i} ✓`).join(' ');
  const pdf = readPdf(sessionPdf([['P', para], ['TABLE', { cols: [1, 2], head: ['Goal', 'Plan'], rows: [['MAP ≥ 65 ✓', 'Fluids → review μ']] }], ['P', long]]));
  assert.deepEqual(pdf.lines, [para, 'Goal', 'Plan', 'MAP ≥ 65 ✓', 'Fluids → review μ', long]);
  assert.equal(pdf.tree.filter((t) => t.type === 'Span').length, 0, 'the symbols are font glyphs read through ToUnicode, not /ActualText spans');
  assert.equal(fontCount(pdf), 3, 'the fallback font is embedded beside Regular and the SemiBold table header');
  assert.ok(pdf.fonts.length === 3 && pdf.fonts.every((f) => f.toUnicode > 0), 'each font carries its own ToUnicode');
});

test('[pdf symbols] the fallback font is embedded only when a character needs it', () => {
  const latin = [['H1', 'Teaching café'], ['P', 'Opened: 14:04 · 2.74 × 10⁹/L − naïve “quoted” – done…']];
  const plain = sessionPdf(latin), pdf = readPdf(plain);
  // Room PDFs v2: the heading draws in SemiBold, so a pure-Latin document with a heading embeds the two Montserrat weights only.
  assert.equal(fontCount(pdf), 2, 'a pure-Latin document embeds Montserrat Regular and SemiBold only');
  assert.equal((pdf.text.match(/\/FontFile2/g) ?? []).length, 2);
  assert.doesNotMatch(pdf.text, /\/F4 /, 'no page names the symbols font');
  const withSymbol = sessionPdf([...latin, ['P', 'Then ≥ 1.']]);
  assert.equal(fontCount(readPdf(withSymbol)), 3);
  assert.ok(withSymbol.length - plain.length < 8192, `the fallback subset stays small (${withSymbol.length - plain.length} bytes)`);
});

test('[pdf symbols] sub- and superscript signs and digits read back exactly', () => {
  const text = 'SpO₂ 92%, HCO₃⁻ 18, Na⁺ 131, 10⁻³ mol, ₀₁₄₅₆₇₈₉ ₊₋';
  assert.deepEqual(readPdf(sessionPdf([['P', text]])).lines, [text]);
});

test('[pdf symbols] a code point in no font still refuses, in a paragraph and a table cell', () => {
  assert.throws(() => sessionPdf([['P', 'An α-blocker ≥ 1, Łódź, 中.']]), /pdf_font_unsupported/);
  assert.throws(() => sessionPdf([['TABLE', { cols: [1], rows: [['中']] }]]), /pdf_font_unsupported/);
  assert.throws(() => sessionPdf([['P', 'Ж']]), /pdf_font_unsupported/, 'Cyrillic is in no embedded subset');
  assert.throws(() => sessionPdf([['P', '😀']]), /pdf_font_unsupported/);
});

// Julian's rulings (2026-10-17, b and c): Greek from a committed Noto Sans subset and Latin Extended-A from the bundled
// Montserrat latin-ext, each its own font resource with its own ToUnicode, embedded only when a document uses it.
const baseFonts = (pdf) => pdf.fonts.map((f) => f.name).sort();
test('[pdf scripts] Greek and Latin Extended-A read back exactly through ToUnicode, in a paragraph and a table cell', () => {
  const greek = 'α β γ δ Δ μ Ω, σοφός ς; ΐ ϑ ϕ ά', latin = 'Łódź, Kőszeg, Şişli, Čačak, Dvořák, Ţară, ℓ †', mixed = 'β-blocker ≥ 2 → Łukasz ✓';
  const pdf = readPdf(sessionPdf([['P', greek], ['P', latin], ['TABLE', { cols: [1, 1], head: ['Ωmega', 'Ł'], rows: [[greek, latin], [mixed, 'ő ş č']] }]]));
  assert.deepEqual(pdf.lines, [greek, latin, 'Ωmega', 'Ł', greek, latin, mixed, 'ő ş č']);
  assert.equal(pdf.tree.filter((t) => t.type === 'Span').length, 0, 'read through ToUnicode, not /ActualText');
  assert.deepEqual(baseFonts(pdf), ['CaseSymbols', 'MontserratLatinExt', 'MontserratRegular', 'MontserratSemiBold', 'NotoSansGreek'], 'the table header draws in SemiBold');
  assert.ok(pdf.fonts.every((f) => f.toUnicode > 0 && f.cmap.size > 0), 'each font carries its own ToUnicode');
});

test('[pdf scripts] each subset is embedded only when a document uses it', () => {
  const only = (text) => baseFonts(readPdf(sessionPdf([['P', `Dose ${text}.`]])));
  assert.deepEqual(only('5 mg'), ['MontserratRegular']);
  assert.deepEqual(only('5 μg'), ['MontserratRegular'], 'μ and µ stay in the primary font');
  assert.deepEqual(only('per β'), ['MontserratRegular', 'NotoSansGreek']);
  assert.deepEqual(only('for Łukasz'), ['MontserratLatinExt', 'MontserratRegular']);
  assert.deepEqual(only('≥ 5'), ['CaseSymbols', 'MontserratRegular']);
  const pdf = readPdf(sessionPdf([['P', 'Dose per β.']]));
  assert.match(pdf.text, /\/Font << \/F1 \d+ 0 R \/F6 \d+ 0 R >>/, 'resource names stay fixed per font, unused ones absent');
});

// Julian's rulings (2026-10-17, briefing 3 and 4): an https link is its visible text plus a /Link annotation, tagged as a
// Link structure element that owns both the text and the annotation (OBJR, /StructParent, parent tree); anything else is
// refused. A page header is a pagination artifact on every page, never read as content.
const LINK = 'https://example.org/guide?topic=sepsis&a=1';
const LONG_LINK = `https://example.org/${'segment/'.repeat(14)}end`;
const LINKED = [
  ['H2', 'Sources'],
  ['P', { runs: ['See ', { text: LINK, href: LINK }, ' and http://insecure.example/x or javascript:alert(1) as text.'] }],
  ['TABLE', { cols: [1, 1], rows: [[{ runs: [{ text: LONG_LINK, href: LONG_LINK }] }, 'n']] }],
];
test('[pdf links] an https run is a /Link annotation with its exact URI, owned by a Link element; other schemes stay text', () => {
  const pdf = readPdf(sessionPdf(LINKED));
  assert.deepEqual(pdf.lines, ['Sources', `See ${LINK} and http://insecure.example/x or javascript:alert(1) as text.`, LONG_LINK, 'n'], 'the visible text reads back exactly');
  const links = pdf.tree.filter((t) => t.type === 'Link');
  assert.equal(links.length, 2, 'one Link element per linked run');
  assert.ok(pdf.annots.length >= 3, 'the wrapped link has one annotation per drawn line');
  assert.deepEqual([...new Set(pdf.annots.map((a) => a.uri))], [LINK, LONG_LINK], 'only the https runs are links, with their exact URIs');
  assert.ok(pdf.annots.every((a) => a.subtype === 'Link' && a.rect.length === 4 && a.rect[2] > a.rect[0] && a.rect[3] > a.rect[1]));
  assert.match(pdf.text, /\/A << \/Type \/Action \/S \/URI \/URI \(/);
  assert.doesNotMatch(pdf.text, /\/URI \((?:http:|javascript:)/);
  for (const a of pdf.annots) {
    const owner = pdf.objectParents.get(a.structParent), el = pdf.tree.find((t) => t.id === owner);
    assert.equal(el?.type, 'Link', 'the parent tree maps the annotation to its Link element');
    assert.ok(el.objr.some((r) => r.obj === a.id && r.page === a.page), 'the Link element references the annotation (OBJR)');
    assert.equal(a.contents, a.uri === LINK ? LINK : LONG_LINK, 'the annotation carries a text alternative');
  }
  const keys = [...pdf.parentTree.keys(), ...pdf.objectParents.keys()].sort((a, b) => a - b);
  assert.deepEqual(keys, keys.map((_, i) => i), 'parent-tree keys are unique and dense');
  assert.match(pdf.text, new RegExp(`/ParentTreeNextKey ${keys.length} `));
  // The Link element's own marked content is the link text, in order inside its paragraph.
  for (const [page, mcid, owner] of pdf.seen) assert.equal(pdf.parentTree.get(page)[mcid], owner);
});

test('[pdf links] an href that is not a credential-free https URL is a pdf_input refusal', () => {
  for (const href of ['http://example.org/', 'javascript:alert(1)', 'data:text/html,x', 'https://user:pw@example.org/', 'https:///nohost', 'https://exa mple.org/', '', 42, null, `https://example.org/${'x'.repeat(2100)}`])
    assert.throws(() => sessionPdf([['P', { runs: [{ text: 'link', href }] }]]), /pdf_input/, String(href).slice(0, 40));
});

test('[pdf header] a header is drawn on every page as a pagination artifact and never read as content', () => {
  const rows = [['H1', 'Briefing'], ...Array.from({ length: 140 }, (_, i) => ['P', `Line ${i + 1} of the notes.`])];
  const pdf = readPdf(sessionPdf(rows, { header: 'Facilitator' }));
  assert.ok(pdf.pageCount >= 3);
  pdf.artifacts.forEach((art, p) => {
    assert.ok(art.includes('Facilitator'), `page ${p + 1} carries the header`);
    assert.ok(art.includes(`Page ${p + 1} of ${pdf.pageCount}`), `page ${p + 1} keeps its footer`);
  });
  assert.equal((pdf.text.match(/\/Artifact << \/Type \/Pagination \/Subtype \/Header >> BDC/g) ?? []).length, pdf.pageCount);
  assert.ok(!pdf.lines.some((l) => l.includes('Facilitator')), 'the header is not content');
  assert.throws(() => sessionPdf(rows, { header: 'x'.repeat(201) }), /pdf_budget/);
  assert.throws(() => sessionPdf(rows, { header: 7 }), /pdf_budget/);
});

// Digests of the writer's output for documents with no links or header. A deliberate change to the writer's output updates
// these with its reason. Updated for Room PDFs v2 (Julian, 2026-10-18): hinting-free Montserrat subsets (Regular plus the new
// SemiBold for headings), rounded cards and table bars, and the new spacing rhythm.
const createHash = (await import('node:crypto')).createHash;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const PINNED = {
  DOC: 'da6e742c6048cd8c9e032ae4d5510328d52be95b3f04131625dd86058111a1ab',
  plain: 'e62b53ff569a377250cf46fc161194c1d1a024826dbddf133c9980757eba4aca',
  scripts: 'af3f7d25e9157383ac31e883ae174b4dc1a91b35fc1c93a0b11db19f90fcaf81',
  long: 'b6c56683e21f2ddc2b36b949b87b7032de1d54c9ffb409781643f9680e2a842c',
};
const PINNED_DOCS = {
  DOC,
  plain: [['H1', 'Teaching café'], ['H2', 'Round 1: resolved'], ['P', 'Opened: 14:04.']],
  scripts: [['P', 'β-blocker ≥ 2 → Łukasz ✓ 10⁹/L'], ['BOX', { fill: 'private', rows: [['P', { runs: [{ sym: 'cue', label: 'Cue' }, ' Go.'] }]] }], ['TABLE', { cols: [1, 1], head: ['a', 'b'], rows: [['x', { bar: { value: 1, total: 2 } }]] }]],
  long: Array.from({ length: 120 }, (_, i) => ['P', `Recorded activity ${i + 1}: naïve résumé − 20. See https://example.org/a as text.`]),
};
test('[pdf links] a document without links or a header is byte-identical to its pinned digest', () => {
  for (const [name, rows] of Object.entries(PINNED_DOCS)) {
    assert.equal(sha(sessionPdf(rows, { title: 'Pinned' })), PINNED[name], name);
    assert.equal(sha(sessionPdf(rows, { title: 'Pinned', header: '' })), PINNED[name], `${name} with an empty header`);
  }
});

// Room PDFs v2: the deflated variant is the same document with each stream compressed; inflated, every object matches.
test('[pdf deflate] sessionPdfDeflated inflates to exactly the plain writer\'s objects, and is smaller', async () => {
  const { sessionPdfDeflated } = await import(process.env.SESSION_PDF ? pathToFileURL(process.env.SESSION_PDF).href : '../src/client/session-pdf.mjs');
  const { inflateSync } = await import('node:zlib');
  const rows = [['H1', 'Diving Deeper'], ...DOC, ...Array.from({ length: 80 }, (_, i) => ['P', `Recorded activity ${i + 1}.`])];
  const plain = sessionPdf(rows, { title: 'Pinned' }), packed = await sessionPdfDeflated(rows, { title: 'Pinned' });
  assert.ok(packed.length < plain.length * 0.7, `deflated ${packed.length} vs plain ${plain.length}`);
  const objects = bytes => { const t = Buffer.from(bytes).toString('latin1'), out = [];
    for (const m of t.matchAll(/(\d+) 0 obj\n([\s\S]*?)\nendobj\n/g)) {
      const s = /^<< \/Length (\d+)( \/Filter \/FlateDecode)?([^\n]*?) >>\nstream\n/.exec(m[2]);
      if (!s) { out.push(m[2]); continue; }
      const body = Buffer.from(m[2].slice(s[0].length, s[0].length + Number(s[1])), 'latin1');
      out.push([s[3], (s[2] ? inflateSync(body) : body).toString('latin1')].join('|'));
    }
    return out; };
  assert.deepEqual(objects(packed), objects(plain));
  assert.equal((Buffer.from(packed).toString('latin1').match(/\/Filter \/FlateDecode/g) ?? []).length, (Buffer.from(plain).toString('latin1').match(/>>\nstream\n/g) ?? []).length - (Buffer.from(plain).toString('latin1').match(/\/DCTDecode/g) ?? []).length);
});
