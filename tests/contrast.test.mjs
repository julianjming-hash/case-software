// Contrast gate for the room windows (CASE-114): every text and non-text colour pair, in BOTH themes,
// read from src/client/tokens.css and src/client/projector-marks.mjs. A pair whose token is missing in either
// theme FAILS (it is never skipped). The only pair allowed under its minimum is a named entry in ALLOW,
// which must cite a decision row that exists, and must still be under the minimum (no stale entries).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MARKS } from '../src/client/projector-marks.mjs';
import { MARKS as LAB_MARKS } from '../prototypes/room/lib/marks.mjs';

// The shipped tokens are the source (card 27); prototypes/room/lib/tokens.css is a mirror that a test below keeps equal.
const css = readFileSync(new URL('../src/client/tokens.css', import.meta.url), 'utf8');
const decisions = readFileSync(new URL('../docs/LEGACY-DECISIONS.md', import.meta.url), 'utf8');

/** The declarations of one rule body, as { name: value }. */
const decls = (body) => Object.fromEntries([...body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
function block(re) { const m = css.match(re); assert.ok(m, `tokens.css has ${re}`); return decls(m[1]); }
const LIGHT = block(/^:root \{([\s\S]*?)^\}/m);
const DARK_MEDIA = block(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n {2}\}/);
const DARK_PINNED = block(/^:root\[data-theme="dark"\] \{([\s\S]*?)^\}/m);
const THEMES = { light: LIGHT, dark: { ...LIGHT, ...DARK_MEDIA } };

const hex = (theme, name) => {
  const v = THEMES[theme][name];
  if (v === undefined) return null;
  assert.match(v, /^#[0-9a-f]{6}$/i, `--${name} in ${theme} must be a #rrggbb colour, got ${v}`);
  return v;
};
const lum = (h) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
/** sRGB mix, as CSS color-mix(in srgb, a p%, b). */
const mix = (a, b, p) => `#${[1, 3, 5].map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * p + parseInt(b.slice(i, i + 2), 16) * (1 - p)).toString(16).padStart(2, '0')).join('')}`;

const TEXT_BODY = 7; const TEXT = 4.5; const NON_TEXT = 3;
const BACKGROUNDS = ['ground', 'surface', 'sunken', 'nav-bg'];
/** [foreground token, background token, minimum, what it is] */
const PAIRS = [
  ...BACKGROUNDS.map((bg) => ['ink', bg, TEXT_BODY, 'body text']),
  ...BACKGROUNDS.map((bg) => ['ink-muted', bg, TEXT, 'secondary text']),
  ['nav-ink', 'nav-bg', TEXT_BODY, 'orientation band text'],
  ['on-petrol', 'petrol', TEXT, 'primary action label'],
  ['on-petrol', 'petrol-deep', TEXT, 'primary action label, hover'],
  ['petrol-ink', 'petrol-tint', TEXT, 'secondary action label'],
  ['petrol-ink', 'surface', TEXT, 'tertiary action label'],
  ['petrol-ink', 'ground', TEXT, 'tertiary action label, links'],
  ['alert-ink', 'surface', TEXT, 'destructive action label'],
  ['alert-ink', 'ground', TEXT, 'destructive action label'],
  ['alert', 'surface', NON_TEXT, 'destructive outline'],
  ['field-line', 'surface', NON_TEXT, 'input border'],
  ['field-line', 'ground', NON_TEXT, 'input border'],
  ['focus', 'ground', NON_TEXT, 'focus ring'],
  ['focus', 'surface', NON_TEXT, 'focus ring'],
  ['petrol', 'surface', NON_TEXT, 'selected border'],
  ...['open', 'locked', 'reveal', 'consequence', 'paused'].flatMap((p) => [
    ['on-phase', `ph-${p}`, TEXT, `${p} phase pill label`],
    [`ph-${p}-ink`, `ph-${p}-tint`, TEXT, `${p} phase text on its tint`],
    [`ph-${p}`, 'surface', NON_TEXT, `${p} phase rail on a card`],
    [`ph-${p}`, 'nav-bg', NON_TEXT, `${p} phase pill on the orientation band`],
  ]),
  ...['alert', 'manual', 'ok'].map((s) => [`${s}-ink`, `${s}-tint`, TEXT, `${s} banner text`]),
];

/** Named exceptions. Each cites the decision that allows it; nothing else may fall under its minimum. */
const ALLOW = [
  { id: 'yellow-mark-white-glyph', decision: 'CASE-115', why: 'Julian: the yellow option mark carries a WHITE glyph; the shape, the colour name and the full option text identify it, and its dark edge keeps the mark at 3:1 against every background' },
];

const allowed = new Set();
function check(label, fg, bg, min, theme, allowId = null) {
  assert.ok(fg && bg, `${label} (${theme}): a token is missing, so the pair cannot be checked; a skipped pair is a failure`);
  const r = ratio(fg, bg);
  if (allowId) {
    const entry = ALLOW.find((a) => a.id === allowId);
    assert.ok(entry, `allow-list entry ${allowId} exists`);
    assert.ok(r < min, `${label} (${theme}) now passes at ${r.toFixed(2)}:1; remove allow-list entry ${allowId}`);
    allowed.add(allowId);
    return;
  }
  assert.ok(r >= min, `${label} (${theme}): ${fg} on ${bg} is ${r.toFixed(2)}:1, under ${min}:1`);
}

test('[CASE-114] every token pair meets its minimum in the light AND the dark theme', () => {
  for (const theme of Object.keys(THEMES)) {
    for (const [fg, bg, min, what] of PAIRS) check(`--${fg} on --${bg} (${what})`, hex(theme, fg), hex(theme, bg), min, theme);
  }
});

test('[CASE-114] the two dark blocks (system preference and data-theme="dark") are identical', () => {
  assert.deepEqual(DARK_PINNED, DARK_MEDIA);
  for (const name of Object.keys(DARK_MEDIA)) assert.ok(name in LIGHT, `--${name} is themed in dark but missing from the light :root`);
});

test('[CASE-114] option marks: 3:1 against every background, their glyph 3:1 on the fill, option text 7:1 on its tile, in both themes', () => {
  for (const theme of Object.keys(THEMES)) {
    const surface = hex(theme, 'surface');
    const tint = Number(THEMES[theme]['tile-tint'].replace('%', '')) / 100;
    for (const m of MARKS) {
      // A mark is delineated by its fill, or by its edge where it has one (the yellow, CASE-115).
      const outer = (bg) => [m.fill, m.edge].filter(Boolean).sort((a, b) => ratio(b, bg) - ratio(a, bg))[0];
      for (const name of ['ground', 'surface', 'sunken']) { const bg = hex(theme, name); check(`${m.name} mark on --${name}`, outer(bg), bg, NON_TEXT, theme); }
      const tile = mix(m.fill, surface, tint);
      check(`${m.name} mark on its own tile`, outer(tile), tile, NON_TEXT, theme);
      check(`option text on the ${m.name} tile`, hex(theme, 'ink'), tile, TEXT_BODY, theme);
      check(`${m.name} glyph on its fill`, m.ink, m.fill, NON_TEXT, theme, m.colour === 'yellow' ? 'yellow-mark-white-glyph' : null);
    }
  }
});

test('[CASE-115] every allow-list entry cites a recorded decision and is actually used', () => {
  for (const a of ALLOW) {
    assert.match(decisions, new RegExp(`^\\| ${a.decision} \\|`, 'm'), `${a.id} cites ${a.decision}, which must be a row in docs/DECISIONS.md`);
  }
  assert.deepEqual([...allowed].sort(), ALLOW.map((a) => a.id).sort(), 'no unused allow-list entries');
  const yellow = MARKS.find((m) => m.colour === 'yellow');
  assert.equal(yellow.ink.toLowerCase(), '#ffffff', 'the yellow mark glyph is white (Julian, CASE-115)');
});

/** The v2 option-mark fills (card 27, design-system.html): the Case palette, same shapes, names and order. */
const V2_FILLS = { red: '#d34b36', blue: '#5e74cc', yellow: '#e9a51d', green: '#378862', purple: '#9c61b5', teal: '#21858c', orange: '#ba611c', grey: '#6b7b82' };
const V2_YELLOW_EDGE = '#6e5208';

test('[CASE-163] option-mark fills are the v2 palette, in the tokens and in both MARKS copies, with shapes, names and order unchanged', () => {
  const order = ['triangle:red', 'diamond:blue', 'circle:yellow', 'square:green', 'star:purple', 'hexagon:teal', 'cross:orange', 'pentagon:grey'];
  for (const list of [MARKS, LAB_MARKS]) {
    assert.deepEqual(list.map((m) => `${m.shape}:${m.colour}`), order);
    for (const m of list) assert.equal(m.fill.toLowerCase(), V2_FILLS[m.colour], `${m.name} fill`);
    assert.equal(list.find((m) => m.colour === 'yellow').edge.toLowerCase(), V2_YELLOW_EDGE);
  }
  assert.deepEqual(MARKS, LAB_MARKS, 'the two MARKS copies agree');
  for (const theme of Object.keys(THEMES)) {
    for (const [colour, fill] of Object.entries(V2_FILLS)) assert.equal(THEMES[theme][`mark-${colour}`], fill, `--mark-${colour} (${theme})`);
    assert.equal(THEMES[theme]['mark-yellow-edge'], V2_YELLOW_EDGE);
  }
});

test('[CASE-163] the lab tokens mirror (prototypes/room/lib/tokens.css) declares exactly the shipped custom properties', () => {
  const lab = readFileSync(new URL('../prototypes/room/lib/tokens.css', import.meta.url), 'utf8');
  const tokenBlocks = (text) => text.slice(text.indexOf(':root {'), text.indexOf('/* ── base ── */'));
  const props = (text) => [...tokenBlocks(text).matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((m) => `${m[1]}:${m[2].trim()}`).sort();
  assert.deepEqual(props(lab), props(css));
});

test('[CASE-163] new v2 text and surface pairs meet their minimum in both themes', () => {
  const NEW = [
    ...['ground', 'surface', 'sunken', 'nav-bg'].map((bg) => ['ink', bg, TEXT_BODY, 'body text on v2 grounds']),
    ['quiet-ink', 'quiet', TEXT_BODY, 'quiet button label'],
    ['ink-muted', 'quiet', TEXT, 'secondary text on quiet'],
    ['private-ink', 'private-tint', TEXT, 'private zone label'],
    ['ink', 'private-tint', TEXT_BODY, 'text inside the private zone'],
    ['ink-muted', 'private-tint', TEXT, 'secondary text inside the private zone'],
    ['petrol-ink', 'quiet', TEXT, 'link on quiet'],
    ['private', 'surface', NON_TEXT, 'private tessera on a card'],
    ['private', 'private-tint', NON_TEXT, 'private tessera on its tint'],
    ['ink', 'ph-consequence-tint', TEXT_BODY, 'text on a consequence scene'],
    ['ink-muted', 'ph-consequence-tint', TEXT, 'secondary text on a consequence scene'],
    ['ph-consequence', 'ph-consequence-tint', NON_TEXT, 'consequence tessera on its tint'],
    ...['open', 'locked', 'reveal', 'consequence', 'paused'].map((p) => [`ph-${p}`, `ph-${p}-tint`, NON_TEXT, `${p} phase tessera on its chip tint`]),
  ];
  for (const theme of Object.keys(THEMES)) for (const [fg, bg, min, what] of NEW) check(`--${fg} on --${bg} (${what})`, hex(theme, fg), hex(theme, bg), min, theme);
});

test('[card 40b] the recap prints on white: its text and journey shapes meet their minimum on the paper, its cards and the PDF', () => {
  // Print is always light (phone.mjs applies the light tokens while printing), so the paper is the light surface.
  const phone = readFileSync(new URL('../src/client/phone.css', import.meta.url), 'utf8');
  assert.match(phone, /@media print \{[\s\S]*?body\.phone-page, \.phone-app \{ background: var\(--surface\); color: var\(--ink\); \}/, 'the printed recap sits on the surface token');
  const paper = hex('light', 'surface');
  assert.equal(paper, '#ffffff');
  const tok = (name) => (name.startsWith('#') ? name : hex('light', name));
  for (const [fg, bg, min, what] of [
    ['ink', paper, TEXT_BODY, 'stop titles and slide text'], ['ink-muted', paper, TEXT, 'key and secondary text'], ['petrol-ink', paper, TEXT, 'chapter label'],
    ['petrol', paper, NON_TEXT, 'slide ring'], ['ink', paper, NON_TEXT, 'question diamond'], ['ph-consequence', paper, NON_TEXT, 'revealed-slide dot'],
    ['ink', 'quiet', TEXT_BODY, 'question card text'], ['ink-muted', 'quiet', TEXT, 'question card secondary text'],
    ['ink', 'petrol-tint', TEXT_BODY, 'your answer chip'], ['petrol', 'petrol-tint', NON_TEXT, 'answer swatch edge'],
  ]) check(`print: --${fg} on ${bg.startsWith('#') ? bg : `--${bg}`} (${what})`, tok(fg), tok(bg), min, 'print');
  // The built-in PDF uses the writer's own light values (session-pdf.mjs HEX) on a white page and a quiet question box.
  const writer = readFileSync(new URL('../src/client/session-pdf.mjs', import.meta.url), 'utf8');
  const HEX = Object.fromEntries([...writer.match(/const HEX=\{([^}]*)\}/)[1].matchAll(/(\w+):'([0-9a-f]{6})'/g)].map((m) => [m[1], `#${m[2]}`]));
  for (const [fg, bg, min, what] of [['ink', 'white', TEXT_BODY, 'text'], ['muted', 'white', TEXT, 'key and secondary text'], ['petrol', 'white', TEXT, 'kicker and chapters'],
    ['consequence', 'white', NON_TEXT, 'revealed-slide dot and card edge'], ['ink', 'quiet', TEXT_BODY, 'question box text'], ['petrol', 'quiet', TEXT, 'your answer on the question box'],
    ['muted', 'quiet', TEXT, 'teaching text on the question box']]) check(`recap PDF: ${fg} on ${bg} (${what})`, HEX[fg], HEX[bg], min, 'print');
});
