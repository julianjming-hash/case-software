#!/usr/bin/env node
// scripts/check-case.mjs — repository hygiene gate for Case (`npm run check`).
//
// Enforces the machine-checkable parts of docs/CONVENTIONS.md and docs/WORKFLOW.md:
//   FILENAMES  every file matches a RULES pattern for its folder
//   HEADERS    every .md has YAML front matter with doc/status (+ id/status rules)
//   LINKS      relative markdown links resolve
//   PATHS      backticked repo paths in living docs exist
//   ABS_PATHS  machine-absolute paths only in the path-roots homes
//   DECISIONS  fresh PUB ids are contiguous; attributed legacy CASE witnesses are unique and well-formed
//   SCENARIOS  acceptance scenario rows are well-formed with contiguous AS-NNN ids (coverage: tests/acceptance-coverage.test.mjs)
//   SESSIONS   ≤ 5 entries, ≤ 200 lines
//   PROTO_DRIFT no new colour literal in prototypes/** outside the allow-list; prototypes/design/tokens.css stays an @import of src/client/tokens.css (CASE-163)
//   SECRETS    no credential-shaped strings in tracked text
//   IMPORT_CASE every relative import names its file with the on-disk case (macOS APFS is case-insensitive,
//              Linux is not; CI runs on both since CASE-257)
//   SINGLE_GATES_TABLE / NO_PLACEHOLDERS / EMPTY_CODE_SPAN / SUPERSEDED_LINKS / REMOVAL_STAMP
//              prevent drift in current documentation; historical records stay exempt
// Zero dependencies. Exit 1 on any failure.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { checkDecisionIndex } from './decision-index.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Generated, git-ignored output (Playwright writes test-results/ on every e2e run).
const SKIP_DIRS = new Set(['.git', 'node_modules', '.wrangler', 'dist', 'test-results', 'playwright-report']);

const KEBAB = '[a-z0-9]+(?:-[a-z0-9]+)*';
const UPPER = '[A-Z0-9]+(?:-[A-Z0-9]+)*';
const DATED = `\\d{4}-\\d{2}-\\d{2}-${KEBAB}`;

// Folder → allowed file-name patterns. A new folder needs a row here and in CONVENTIONS.md.
export const RULES = [
  /^licenses\/lucide-static-1\.59\.0-package-LICENSE\.txt$/,
  /^(README|CLAUDE|AGENTS|NOTICE|SECURITY|CONTRIBUTING)\.md$/,
  /^(package\.json|package-lock\.json|\.gitignore|\.editorconfig|\.nvmrc|LICENSE|wrangler\.toml|(playwright(?:\.devices)?|vitest)\.config\.mjs)$/,
  /^\.github\/CODEOWNERS$/,
  /^src\/fixtures\/LICENSE\.txt$/,
  /^tests\/fixtures\/room-music-approval\.json$/,
  /^tests\/fixtures\/legacy-client\/(source\.tar|manifest\.json)$/,
  /^tests\/fixtures\/synthetic\/LICENSE\.txt$/,
  new RegExp(`^tests/fixtures/synthetic/${KEBAB}\\.(json|txt)$`),
  /^audit-allowlist\.json$/,
  /^public\/email\/[a-f0-9]{12}\.jpg$/,
  new RegExp(`^docs/email-templates/${KEBAB}\\.(html|txt)$`),
  new RegExp(`^src/client/(${KEBAB}/)*${KEBAB}\\.css$`),
  new RegExp(`^public/${KEBAB}\\.(html|webmanifest)$`),
  new RegExp(`^public/fonts/${KEBAB}\\.(woff2|txt)$`),
  new RegExp(`^public/avatars/${KEBAB}\\.svg$`),
  new RegExp(`^public/icons/${KEBAB}\\.svg$`),       // the favicon and manifest icon
  new RegExp(`^public/audio/${KEBAB}\\.(wav|json)$`), // on-demand room cue audio + its manifest (CASE-171)
  /^public\/audio\/LICENSE\.txt$/,
  new RegExp(`^public/audio/room-music/${KEBAB}\\.mp3$`), // CASE-334: the build admits exactly the approved round8 library
  /^public\/audio\/room-music\/(manifest\.json|LICENSE\.txt)$/,
  new RegExp(`^docs/${UPPER}\\.md$`),
  new RegExp(`^docs/(red-team|research|archive|plans)/(README|${UPPER}|${DATED})\\.md$`),
  /^docs\/red-team\/\d{4}-\d{2}-surface-audit\.md$/, // handoff-specified monthly working audit
  /^docs\/pilot\/(?:FACILITATOR-GUIDE|REHEARSAL|DEBRIEF-TEMPLATE|RUNSHEET-OPS|METERING|DEVICE-CHECKLIST|\d{4}-\d{2}-\d{2}-debrief)\.md$/,
  new RegExp(`^docs/archive/sessions-\\d{4}\\.md$`),
  new RegExp(`^docs/cards/(README|\\d{2}-${KEBAB})\\.md$`), // Codex task cards (CASE-124)
  new RegExp(`^docs/procurement/(README|${UPPER})\\.md$`),
  new RegExp(`^docs/cards/\\d{2}-screenshots/${KEBAB}\\.png$`), // card review evidence
  new RegExp(`^docs/cards/49-artifacts/${KEBAB}\\.(json|txt)$`), // frozen private Builder acceptance evidence
  new RegExp(`^docs/teaching-cases/${KEBAB}\\.(document|metadata|transfer|evidence)\\.json$`), // private native teaching pairs, transfers and evidence
  new RegExp(`^docs/teaching-cases/(README|${UPPER})\\.md$`),
  new RegExp(`^docs/teaching-cases/screenshots/${KEBAB}\\.png$`), // local exemplar review evidence
  new RegExp(`^docs/teaching-cases/figures/${KEBAB}\\.(svg|png|mjs)$`), // drawn case figures, their PNGs for upload and the script that draws them
  new RegExp(`^prototypes/(README\\.md|${KEBAB}\\.html)$`),
  /^prototypes\/sound-stage\/((index|directions)\.html|stage\.(mjs|css)|lab\.(mjs|css)|engine\.mjs|manifest\.json|LICENSE\.txt)$/,
  new RegExp(`^prototypes/sound-stage/(assets|sources)/${KEBAB}\\.(wav|mp3|json|txt)$`),
  new RegExp(`^scripts/sound/${KEBAB}\\.mjs$`),
  new RegExp(`^docs/cards/69-artifacts/${KEBAB}\\.(json|txt|png)$`),
  new RegExp(`^prototypes/room/${KEBAB}\\.html$`),
  new RegExp(`^prototypes/room/${KEBAB}-sw\\.mjs$`), // a service worker sits beside the pages it controls (scope)
  new RegExp(`^prototypes/room/lib/${KEBAB}\\.(mjs|css)$`),
  new RegExp(`^prototypes/room/lib/avatars/${KEBAB}\\.svg$`), // vendored DiceBear Shadows avatars (CASE-120, NOTICE.md)
  new RegExp(`^prototypes/room/lib/fonts/${KEBAB}\\.(woff2|txt)$`), // self-hosted, each family beside its OFL licence text; Montserrat and JetBrains Mono (CASE-112, NOTICE.md)
  new RegExp(`^prototypes/design/${KEBAB}\\.(mjs|css)$`), // shared sources for design-system.html and surface-design.html (2026-10-06 design proposal)
  /^db\/README\.md$/,
  /^db\/supabase\/migrations\/\d{14}_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/,
  /^db\/supabase\/(config\.toml|seed\.sql|\.gitignore)$/,
  new RegExp(`^db/tests/${KEBAB}(\\.test)?\\.sql$`),
  new RegExp(`^db/durable-object/${KEBAB}\\.sql$`),
  new RegExp(`^src/(${KEBAB}/)*${KEBAB}\\.(mjs|json)$`),
  new RegExp(`^tests/(?:${KEBAB}/)*${KEBAB}(?:\\.test)?\\.mjs$`),
  new RegExp(`^e2e/${KEBAB}\\.spec\\.mjs$`),
  new RegExp(`^tests/fixtures/media/${KEBAB}\\.(jpg|png)$`), // small encoder outputs for the media structural check (card 59)
  new RegExp(`^src/fixtures/${KEBAB}\\.case\\.json$`),
  new RegExp(`^scripts/${KEBAB}\\.(mjs|sh)$`),
  /^scripts\/case-macos-peer\.c$/, // Native macOS peer/process identity broker; no general C allowance.
  /^scripts\/linux-idle-canary\.py$/, // guarded disposable Linux kernel validation
  /^tests\/helpers\/linux-idle-canary\.py$/, // portable checks, mandatory Node test bridge
  new RegExp(`^\\.github/workflows/${KEBAB}\\.yml$`),
  /^\.claude\//,
];

const STATUSES = new Set(['living', 'evolving', 'stable', 'frozen', 'superseded']);
// Where machine-absolute paths may appear (CONVENTIONS.md §Paths in docs). Append-only logs keep history.
const ABS_PATH_HOMES = new Set(['AGENTS.md', 'CLAUDE.md', 'docs/CONVENTIONS.md', 'docs/SESSIONS.md', 'docs/DECISIONS.md']);
// Append-only / historical docs: their path mentions describe the past, so PATHS skips them.
// Codex task cards name files their card will create, so PATHS skips them too (CASE-124).
const HISTORICAL = (f) => f === 'docs/SESSIONS.md' || f === 'docs/DECISIONS.md' || f.startsWith('docs/archive/') || f.startsWith('docs/cards/') || new RegExp(`/${DATED}\\.md$`).test(f);

export const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, 'JWT'],
  [/\bsb_secret_[A-Za-z0-9_-]{10,}/, 'Supabase secret key'],
  [/\bsk-(ant-|proj-)?[A-Za-z0-9_-]{24,}/, 'API secret key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key'],
];

const failures = [];
const fail = (gate, file, msg) => failures.push(`  ✗ [${gate}] ${file}: ${msg}`);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    // Finder writes .DS_Store into any folder open in a window; it is gitignored metadata, never content.
    if (name === '.DS_Store') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(relative(ROOT, p).split('\\').join('/'));
  }
  return out;
}

function frontMatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return fm;
}

function hasEmptyCodeSpan(line) {
  const runs = [...line.matchAll(/`+/g)];
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    const before = line[run.index - 1] ?? ' ';
    const after = line[run.index + run[0].length] ?? ' ';
    if (run[0] === '``' && /\s/.test(before) && /[\s.,;:]/.test(after)) return true;
    const closing = runs.findIndex((next, j) => j > i && next[0].length === run[0].length);
    if (closing > i) i = closing;
  }
  return false;
}

// Pure drift checks: callers supply target documents, so fixture tests never walk the repo.
export function checkDocHygiene(file, text, targets = new Map()) {
  const errors = [];
  const report = (gate, line, message) => errors.push({ gate, file, message: `line ${line}: ${message}` });
  const fm = frontMatter(text);
  const markdown = file.endsWith('.md');
  if (file.startsWith('docs/archive/') || ['docs/DECISIONS.md', 'docs/SESSIONS.md'].includes(file) || (markdown && !['living', 'evolving', 'stable'].includes(fm?.status))) return errors;
  if (!markdown && !/^prototypes\/room\/[^/]+\.html$/.test(file)) return errors;
  let fence = null;
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    if (/(?:\{N\}|N pending|\bTBD\b|<case-project-ref>)/.test(line) &&
        !/<!--\s*placeholder-ok:\s*[^\s][\s\S]*?-->/.test(line.replace(/<!--\s*placeholder-ok:\s*-->/g, ''))) {
      report('NO_PLACEHOLDERS', index + 1, 'unresolved placeholder; resolve it or add a reasoned placeholder-ok comment on this line');
    }
    if (!markdown) continue;
    if (file !== 'AGENTS.md' && /^\s*\|\s*(?:`npm run verify`|npm run verify)\s*\|/.test(line)) {
      report('SINGLE_GATES_TABLE', index + 1, 'command tables belong only in AGENTS.md; link to its Gates section');
    }
    if (hasEmptyCodeSpan(line)) report('EMPTY_CODE_SPAN', index + 1, 'empty inline code span');
    // Julian approved dates for removal records, with quoted examples and generic policies exempt.
    // Generic policies need a reasoned marker so an undated event is not silently classified away.
    const removalText = line.replace(/(`+)[\s\S]*?\1/g, '').replace(/"[^"]*"|“[^”]*”|‘[^’]*’/g, '').replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\*+/g, '')
      // These describe transient room states and an accessibility test condition, not repo retirements.
      .replace(/\bremoved participants?\b|\bsuperseded answers?\b|\bwith colou?r removed\b/gi, '');
    const genericRule = /<!--\s*removal-stamp-exempt:\s*generic rule:\s*[^\s][\s\S]*?-->/.test(line.replace(/<!--\s*removal-stamp-exempt:\s*generic rule:\s*-->/g, ''));
    if (!/^\s*>/.test(line) && /\b(removed|retired|superseded)\b/i.test(removalText) && !/\b\d{4}-\d{2}-\d{2}\b/.test(line) && !genericRule) {
      report('REMOVAL_STAMP', index + 1, 'removal record needs a date on this line; generic policies need a reasoned removal-stamp-exempt marker');
    }
    for (const match of line.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|mailto:|#)/.test(match[1])) continue;
      const target = relative(ROOT, resolve(ROOT, dirname(file), match[1].split('#')[0])).split('\\').join('/');
      if (frontMatter(targets.get(target) ?? '')?.status === 'superseded') {
        report('SUPERSEDED_LINKS', index + 1, `link targets superseded document ${target}`);
      }
    }
  }
  return errors;
}


// PROTO_DRIFT (CASE-163). Prototypes read the shipped tokens; they must not grow a private palette.
// A colour literal is a hex, a colour function written out in full (rgb, hsl, hwb, lab, lch, oklab, oklch, color), or a
// named CSS colour in a colour-bearing declaration or attribute. Per file, only the exact literals already present when the
// gate was added (its baseline, whole literals, whitespace-normalised) are allowed, so the list can only shrink.
// Exempt wholesale, with reasons recorded in CASE-163: the art renderer, the vendored avatar drawings, and the token shim.
const PROTOTYPE_OWNS_PALETTE = [
  /^prototypes\/design\/mosaic\.mjs$/,                 // the renderer owns the art pigments (card 27)
  /^prototypes\/room\/lib\/avatars\//,                 // vendored DiceBear drawings, art not interface chrome (NOTICE.md)
];
const NAMED_COLOURS = new Set(('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen').split(' '));
const COLOUR_DECL = /(?:^|[;{\s"'`(])(?:--[\w-]+|color|background(?:-color|-image)?|border(?:-[a-z-]+)?|fill|stroke|outline(?:-color)?|box-shadow|text-shadow|accent-color|caret-color|stop-color|flood-color|column-rule(?:-color)?)\s*:\s*([^;}"'`]*)/gi;
const COLOUR_ATTR = /(?:\b(?:fill|stroke|stop-color|flood-color|color)\s*=\s*["']([^"']+)["']|setAttribute\(\s*['"](?:fill|stroke|color)['"]\s*,\s*['"]([^'"]+)['"])/gi;
const COLOUR_FN = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi;
const norm = (text) => text.toLowerCase().replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').replace(/\s*,\s*/g, ', ');
export function colourLiterals(text) {
  const found = new Set();
  for (const m of text.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) found.add(m[0].toLowerCase());
  for (const m of text.matchAll(COLOUR_FN)) {
    let depth = 0, end = m.index + m[0].length - 1;
    for (; end < text.length; end++) { if (text[end] === '(') depth++; else if (text[end] === ')' && --depth === 0) break; }
    const literal = text.slice(m.index, end + 1);
    found.add(norm(literal));
  }
  const names = (value) => { for (const w of value.toLowerCase().split(/[^a-z-]+/)) if (NAMED_COLOURS.has(w)) found.add(`name:${w}`); };
  for (const m of text.matchAll(COLOUR_DECL)) names(m[1].replace(/color-mix\([^()]*(?:\([^()]*\)[^()]*)*\)|var\([^()]*(?:\([^()]*\)[^()]*)*\)/gi, ' '));
  for (const m of text.matchAll(COLOUR_ATTR)) names(m[1] ?? m[2]);
  return [...found].sort();
}
const PROTOTYPE_LITERAL_BASELINE = {
  "prototypes/authoring-surfaces.html": ["#101719", "#116c7b", "#137d8f", "#20252a", "#364244", "#4e6655", "#687170", "#708879", "#8b413b", "#a9aaa4", "#b5544e", "#b7c6ba", "#d6d1c5", "#d6eff1", "#d9ada5", "#dcebed", "#dfd9cd", "#e3ded1", "#e4ede5", "#e7efec", "#ebe7dd", "#ede9de", "#efebe0", "#f2eee5", "#f3e1dc", "#f3f0e7", "#f4f1e8", "#f5f8f4", "#f8f5ed", "#fff7f3", "#fffdfa", "name:white", "rgba(19, 125, 143, .06)", "rgba(38, 31, 20, .12)", "rgba(40, 34, 25, .06)", "rgba(70, 59, 42, .16)", "rgba(74, 63, 45, .16)"],
  "prototypes/decision-path-editor.html": ["#116c7b", "#137d8f", "#20252a", "#4d5554", "#58715f", "#6a7271", "#7a5a56", "#823f38", "#8c413b", "#943f38", "#9a9c94", "#b5544e", "#bed3d5", "#c6d9da", "#d4e3e2", "#d6d1c5", "#dcebed", "#ded8cc", "#dfb6af", "#e2ddd0", "#e4ede5", "#e9e6dc", "#ece8df", "#ede9df", "#eef5f4", "#efebe0", "#f2eee5", "#f2f8f7", "#f3e1dc", "#f3f0e7", "#f7fcfb", "#f8f5ed", "#fff", "#fff6f3", "#fffdfa", "name:white", "rgba(40, 31, 20, .13)", "rgba(75, 62, 43, .16)", "rgba(78, 66, 45, .16)"],
  "prototypes/design/kit.mjs": ["#0d1214", "rgb()", "rgb(c)"],
  "prototypes/design-system.html": ["#0f3b47", "#12181b", "#f3f5f5", "#f5f1e8", "hsl(12 40% 72%)", "hsl(186 30% 70%)", "hsl(g.h, gs, t.groundl + gl)", "hsl(h, sat, l)", "rgba(127, 127, 127, .35)"],
  "prototypes/room/facilitator.html": ["rgba(10, 30, 36, .45)"],
  "prototypes/room/index.html": ["#ded8ca", "#e5dfd3", "#f2eee6", "#fff"],
  "prototypes/room/lib/marks.mjs": ["#21858c", "#378862", "#5e74cc", "#6b7b82", "#6e5208", "#9c61b5", "#ba611c", "#d34b36", "#e9a51d", "#ffffff"],
  "prototypes/room/lib/qr.mjs": ["#000000", "#ffffff"],
  "prototypes/room/phone.html": ["#fff"],
  "prototypes/surface-design.html": ["#0d1214", "hsl(${g.h} ${g.s + 14}% 72%)", "hsl(186 30% 70%)", "rgba(13, 18, 20, .45)"],
  "prototypes/synchronisation-lab.html": ["#0f6774", "#11292e", "#137d8f", "#173e43", "#1b3237", "#20252a", "#263336", "#555b59", "#58735f", "#5b615d", "#5e3b09", "#62706f", "#754707", "#853c38", "#8cc7c7", "#9b6318", "#9ca19b", "#9cd3d3", "#a74743", "#b9dcdd", "#bdd0cb", "#d5cec0", "#d5e0da", "#d7aaa3", "#dbe7e6", "#dcd6c9", "#dce6e0", "#dcedee", "#ded8ca", "#e1ebe2", "#e5dfd3", "#e7e2d6", "#e8e6e1", "#ede9df", "#edf3ef", "#eee9df", "#efebe0", "#f0ebe0", "#f0ede5", "#f1ede3", "#f2eee6", "#f3dfb8", "#f4dfd9", "#f4e6c9", "#f4f1e8", "#f9f7f0", "#fbf8f0", "#ffe5a9", "#fff", "#fff9f7", "#fffdf8", "rgba(226, 241, 231, .25)", "rgba(230, 230, 230, .19)", "rgba(231, 248, 242, .14)", "rgba(244, 212, 132, .2)", "rgba(30, 28, 21, .22)", "rgba(41, 35, 26, .22)", "rgba(46, 39, 27, .14)", "rgba(67, 57, 38, .16)", "rgba(75, 65, 46, .19)", "rgba(8, 29, 33, .66)"]
};
// The lab token file mirrors src/client/tokens.css above its base marker (tests/contrast.test.mjs keeps that part equal);
// its component rules below the marker are scanned like any other prototype CSS.
const LAB_TOKENS = 'prototypes/room/lib/tokens.css';
const BASE_MARKER = '/* ── base ── */';
const TOKENS_SHIM = /^\s*(?:\/\*[\s\S]*?\*\/\s*)*@import\s+url\(\s*(['"])\.\.\/\.\.\/src\/client\/tokens\.css\1\s*\)\s*;\s*$/;
export function checkPrototypeDrift(files, { complete = false } = {}) {
  const errors = [];
  const report = (file, message) => errors.push({ gate: 'PROTO_DRIFT', file, message });
  const shim = files.get('prototypes/design/tokens.css');
  if (shim === undefined || !TOKENS_SHIM.test(shim)) {
    report('prototypes/design/tokens.css', "must be only comments and @import url('../../src/client/tokens.css'); the shipped tokens are the single source");
  }
  for (const [file, whole] of files) {
    if (!file.startsWith('prototypes/') || file === 'prototypes/design/tokens.css' || PROTOTYPE_OWNS_PALETTE.some((re) => re.test(file))) continue;
    const text = file === LAB_TOKENS && whole.includes(BASE_MARKER) ? whole.slice(whole.indexOf(BASE_MARKER)) : whole;
    const allowed = new Set(PROTOTYPE_LITERAL_BASELINE[file] ?? []);
    const present = new Set(colourLiterals(text));
    const fresh = [...present].filter((m) => !allowed.has(m));
    const stale = [...allowed].filter((m) => !present.has(m));
    if (stale.length) report(file, `baselined literal ${stale.join(', ')} is no longer present; delete it from PROTOTYPE_LITERAL_BASELINE so the list only shrinks`);
    if (fresh.length) report(file, `colour literal ${fresh.join(', ')} outside the baseline; use a var(--token) from src/client/tokens.css`);
  }
  if (complete) for (const file of Object.keys(PROTOTYPE_LITERAL_BASELINE)) if (!files.has(file)) report(file, 'baselined file no longer exists; delete its PROTOTYPE_LITERAL_BASELINE entry');
  return errors;
}

// IMPORT_CASE (CASE-257). A relative import whose case differs from the file on disk resolves on macOS (APFS is
// case-insensitive) and fails on Linux. `listDir(dir)` returns a directory's entry names; a target that does not
// exist in any case is left to the tests that import it.
const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bnew URL\(\s*)(['"])(\.{1,2}\/[^'"`$]+?)\1/g;
export function checkImportCase(file, text, listDir) {
  const errors = [];
  for (const match of text.matchAll(RELATIVE_IMPORT)) {
    const specifier = match[2].split(/[?#]/)[0];
    const target = relative(ROOT, resolve(ROOT, dirname(file), specifier)).split('\\').join('/');
    if (target.startsWith('..')) continue;
    let dir = '';
    for (const part of target.split('/').filter(Boolean)) {
      const names = listDir(dir);
      if (!names || names.includes(part)) { dir = dir ? `${dir}/${part}` : part; continue; }
      const actual = names.find((name) => name.toLowerCase() === part.toLowerCase());
      if (actual) errors.push({ gate: 'IMPORT_CASE', file, message: `import '${match[2]}' names ${part}, but the file on disk is ${actual}` });
      break;
    }
  }
  return errors;
}

function runCheck() {
const files = walk(ROOT);
const listings = new Map();
const listDir = (dir) => {
  if (!listings.has(dir)) { try { listings.set(dir, readdirSync(join(ROOT, dir))); } catch { listings.set(dir, null); } }
  return listings.get(dir);
};
const docIds = new Map();
const docs = new Map(files.filter((file) => file.endsWith('.md')).map((file) => [file, readFileSync(join(ROOT, file), 'utf8')]));

// A tracked symlink points at one machine's paths (a worktree's node_modules link reached main once, CASE-253) and
// dirties every other checkout, which the deploy's clean-tree gate refuses. The walk above cannot see the index.
let tracked = '';
try { tracked = execFileSync('git', ['ls-files', '-s'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { /* not a git checkout */ }
for (const line of tracked.split('\n')) if (line.startsWith('120000 ')) fail('FILENAMES', line.split('\t')[1], 'is a tracked symlink; untrack it (git rm --cached) and ignore it');

for (const f of files) {
  if (!RULES.some((r) => r.test(f))) fail('FILENAMES', f, 'does not match any pattern in RULES (see docs/CONVENTIONS.md)');

  const isText = /\.(md|mjs|sql|sh|json|html|toml|yml)$/.test(f) || f.startsWith('.');
  if (!isText) continue;
  const text = readFileSync(join(ROOT, f), 'utf8');
  if (/\.(mjs|js|html)$/.test(f)) for (const issue of checkImportCase(f, text, listDir)) fail(issue.gate, f, issue.message);
  for (const issue of checkDocHygiene(f, text, docs)) fail(issue.gate, f, issue.message);

  for (const [re, label] of SECRET_PATTERNS) if (re.test(text)) fail('SECRETS', f, `looks like a ${label}`);
  if (!ABS_PATH_HOMES.has(f) && !HISTORICAL(f) && /\/Users\/|\/home\/user\//.test(text)) {
    fail('ABS_PATHS', f, 'machine-absolute path outside the path-roots homes (use a Case-root-relative path)');
  }
  if (!f.endsWith('.md')) continue;

  if (f.startsWith('docs/procurement/') && /\b(?:TODO|TBD|FIXME|REPLACE_ME)\b|\[(?:insert|fill in|your)\b/gi.test(text)) {
    fail('NO_PLACEHOLDERS', f, 'unfinished template marker in procurement pack');
  }

  // HEADERS
  const fm = frontMatter(text);
  if (!fm) { fail('HEADERS', f, 'missing YAML front matter'); continue; }
  if (!fm.doc || !/^CASE-[A-Z0-9-]+$/.test(fm.doc)) fail('HEADERS', f, `doc: must be CASE-<UPPER-KEBAB>, got "${fm.doc ?? ''}"`);
  if (!STATUSES.has(fm.status)) fail('HEADERS', f, `status: must be one of ${[...STATUSES].join('|')}, got "${fm.status ?? ''}"`);
  if (!fm.purpose) fail('HEADERS', f, 'purpose: missing');
  if (!fm.read_when) fail('HEADERS', f, 'read_when: missing');
  if (new RegExp(`${DATED}\\.md$`).test(f) && fm.status !== 'frozen') fail('HEADERS', f, 'dated artefacts must be status: frozen');
  const upper = f.match(new RegExp(`^docs/(${UPPER})\\.md$`));
  if (upper && fm.doc !== `CASE-${upper[1]}`) fail('HEADERS', f, `doc: must be CASE-${upper[1]} to match the filename`);
  if (fm.doc) {
    if (docIds.has(fm.doc)) fail('HEADERS', f, `doc id ${fm.doc} also used by ${docIds.get(fm.doc)}`);
    docIds.set(fm.doc, f);
  }

  const body = text.replace(/```[\s\S]*?```/g, '');

  // LINKS
  for (const m of body.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const path = target.split('#')[0];
    if (!path) continue;
    if (!existsSync(resolve(ROOT, dirname(f), path))) fail('LINKS', f, `broken link → ${target}`);
  }

  // PATHS
  if (!HISTORICAL(f)) {
    for (const m of body.matchAll(/`((?:docs|db|src|scripts|tests|prototypes)\/[^`\s]*)`/g)) {
      const p = m[1];
      if (/[<>*…]|YYYY|\{/.test(p)) continue;
      if (!existsSync(join(ROOT, p.replace(/[.,;:]$/, '')))) fail('PATHS', f, `referenced path does not exist: ${p}`);
    }
  }
}

// DECISIONS: fresh namespace, plus separately labelled technical witnesses, never fake private rows.
for (const [f,options] of [['docs/DECISIONS.md',{prefix:'PUB',contiguous:true}],['docs/LEGACY-DECISIONS.md',{prefix:'CASE',contiguous:false}]]) {
  for (const message of checkDecisionIndex(readFileSync(join(ROOT,f),'utf8'),options)) fail('DECISIONS',f,message);
}

// SCENARIOS
{
  const f = 'docs/ACCEPTANCE-SCENARIOS.md';
  const rows = [];
  let inScenarioTable = false;
  for (const line of readFileSync(join(ROOT, f), 'utf8').split('\n')) {
    if (/^\| ID \| Scenario \|/.test(line)) { inScenarioTable = true; continue; }
    if (inScenarioTable && !line.startsWith('|')) { inScenarioTable = false; continue; }
    if (!inScenarioTable || /^\|[-| ]+\|$/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length !== 5 || !/^AS-\d{3}$/.test(cells[0])) {
      fail('SCENARIOS', f, `scenario row needs | AS-NNN | Scenario | facilitator | projector | participant |: ${line}`);
      continue;
    }
    rows.push(cells[0]);
  }
  if (!rows.length) fail('SCENARIOS', f, 'no scenario rows found');
  rows.forEach((id, index) => {
    const want = `AS-${String(index + 1).padStart(3, '0')}`;
    if (id !== want) fail('SCENARIOS', f, `row ${index + 1} is ${id}, expected ${want}`);
  });
  // Coverage (a real test per id, or an explicit pending reason) is tests/acceptance-coverage.test.mjs,
  // which `npm test` runs. A plain text search here passed vacuously: every id sat in a test.todo.
}

// PROTO_DRIFT
{
  const protoFiles = new Map(files.filter((f) => f.startsWith('prototypes/') && /\.(html|css|mjs|js|svg)$/.test(f)).map((f) => [f, readFileSync(join(ROOT, f), 'utf8')]));
  for (const issue of checkPrototypeDrift(protoFiles, { complete: true })) fail(issue.gate, issue.file, issue.message);
}

// DESIGN_CONTRACT: the canonical HTML must remain on every UI entry point's read-first map.
for(const file of ['AGENTS.md','README.md','docs/PRODUCT.md','prototypes/README.md']) {
 if(!readFileSync(join(ROOT,file),'utf8').includes('design-system.html'))fail('DESIGN_CONTRACT',file,'retain the canonical HTML design-system reference');
}

// SESSIONS
{
  const f = 'docs/SESSIONS.md';
  const text = readFileSync(join(ROOT, f), 'utf8');
  const lines = text.split('\n').length;
  const entries = (text.match(/^## /gm) || []).length;
  if (lines > 200) fail('SESSIONS', f, `${lines} lines > 200; move older entries to docs/archive/sessions-YYYY.md`);
  if (entries > 5) fail('SESSIONS', f, `${entries} entries > 5; move older entries to docs/archive/sessions-YYYY.md`);
}

if (failures.length) {
  console.error(`case:check — ${failures.length} failure(s)\n${failures.join('\n')}`);
  process.exit(1);
}
console.log(`case:check — ok (${files.length} files, ${docIds.size} docs)`);

}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCheck();
