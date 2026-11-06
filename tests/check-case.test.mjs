import test from 'node:test';
import assert from 'node:assert/strict';
import { checkDocHygiene, checkImportCase, checkPrototypeDrift, RULES } from '../scripts/check-case.mjs';

const living = (body) => `---\ndoc: CASE-FIXTURE\nstatus: living\npurpose: fixture\nread_when: tests\n---\n${body}`;
const failures = (file, body, targets = new Map()) => checkDocHygiene(file, living(body), targets);

test('SINGLE_GATES_TABLE accepts links and rejects duplicated verify tables', () => {
  assert.deepEqual(failures('README.md', '[Gates](AGENTS.md#gates)'), []);
  assert.equal(failures('README.md', '| Command | What |\n|---|---|\n| `npm run verify` | gates |')[0].gate, 'SINGLE_GATES_TABLE');
  assert.deepEqual(failures('AGENTS.md', '| `npm run verify` | gates |'), []);
  assert.equal(failures('README.md', '| Command | What |\n|---|---|\n| npm run verify | gates |')[0].gate, 'SINGLE_GATES_TABLE');
});
test('NO_PLACEHOLDERS rejects markers and accepts fenced examples or reasoned line exemptions', () => {
  for (const marker of ['{N}', 'N pending', 'TBD', '<case-project-ref>']) {
    assert.equal(failures('docs/FIXTURE.md', marker)[0].gate, 'NO_PLACEHOLDERS');
    assert.deepEqual(failures('docs/FIXTURE.md', `${marker} <!-- placeholder-ok: deliberate fixture -->`), []);
    assert.deepEqual(failures('docs/FIXTURE.md', `\`\`\`text\n${marker}\n\`\`\``), []);
    assert.deepEqual(failures('docs/FIXTURE.md', `~~~text\n${marker}\n~~~`), []);
  }
  assert.equal(checkDocHygiene('prototypes/room/phone.html', '<p>TBD</p>')[0].gate, 'NO_PLACEHOLDERS');
  assert.equal(failures('docs/FIXTURE.md', 'TBD <!-- placeholder-ok: -->')[0].gate, 'NO_PLACEHOLDERS');
});
test('EMPTY_CODE_SPAN catches empty inline code and accepts ordinary code', () => {
  assert.equal(failures('docs/FIXTURE.md', 'Under `` lives code.')[0].gate, 'EMPTY_CODE_SPAN');
  assert.deepEqual(failures('docs/FIXTURE.md', 'Under `Case/` lives code.'), []);
  assert.deepEqual(failures('docs/FIXTURE.md', 'The example ` `` ` describes forbidden syntax.'), []);
});
test('SUPERSEDED_LINKS rejects historical targets but accepts current targets', () => {
  const targets = new Map([['docs/OLD.md', '---\nstatus: superseded\n---\n'], ['docs/CURRENT.md', living('current')]]);
  assert.equal(failures('README.md', '[Old](docs/OLD.md#heading)', targets)[0].gate, 'SUPERSEDED_LINKS');
  assert.deepEqual(failures('README.md', '[Current](docs/CURRENT.md)', targets), []);
});
test('historical and frozen documents remain exempt from drift gates', () => {
  const bad = 'TBD under `` | `npm run verify` |';
  assert.deepEqual(checkDocHygiene('docs/archive/OLD.md', living(bad)), []);
  assert.deepEqual(checkDocHygiene('docs/DECISIONS.md', living(bad)), []);
  assert.deepEqual(checkDocHygiene('docs/SESSIONS.md', living(bad)), []);
  assert.deepEqual(checkDocHygiene('docs/plans/2026-10-01-old.md', living(bad).replace('status: living', 'status: frozen')), []);
});
test('FILENAMES permits the exact audit allowlist path without opening other root JSON paths', () => {
  assert.equal(RULES.some((r) => r.test('audit-allowlist.json')), true);
  assert.equal(RULES.some((r) => r.test('other-allowlist.json')), false);
});
test('FILENAMES permits only the pilot guide set and dated debrief records', () => {
  const allowed = ['FACILITATOR-GUIDE', 'REHEARSAL', 'DEBRIEF-TEMPLATE', 'RUNSHEET-OPS'];
  for (const name of allowed) assert.equal(RULES.some(rule => rule.test(`docs/pilot/${name}.md`)), true, name);
  assert.equal(RULES.some(rule => rule.test('docs/pilot/2026-10-03-debrief.md')), true);
  for (const name of ['notes.md', '2026-10-03-notes.md', '2026-10-03-DEBRIEF.md'])
    assert.equal(RULES.some(rule => rule.test(`docs/pilot/${name}`)), false, name);
});
test('REMOVAL_STAMP dates removal records and exempts quoted examples and reasoned generic rules', () => {
  for (const word of ['removed', 'retired', 'superseded']) {
    assert.equal(failures('docs/FIXTURE.md', `The old endpoint was ${word}.`)[0]?.gate, 'REMOVAL_STAMP');
    assert.deepEqual(failures('docs/FIXTURE.md', `The old endpoint was ${word} on 2026-10-02.`), []);
    assert.deepEqual(failures('docs/FIXTURE.md', `The old endpoint was ${word} on \`2026-10-02\`.`), []);
  }
  assert.deepEqual(failures('docs/FIXTURE.md', 'The message is "You were removed from this room".'), []);
  assert.deepEqual(failures('docs/FIXTURE.md', 'The state is `removed`.'), []);
  assert.deepEqual(failures('docs/FIXTURE.md', 'A removed participant sees the room message.'), []);
  assert.deepEqual(failures('docs/FIXTURE.md', 'The accessibility test passes with colour removed.'), []);
  assert.deepEqual(failures('docs/FIXTURE.md', 'Overflow drops the oldest *superseded* answer first.'), []);
  assert.deepEqual(failures('docs/FIXTURE.md', 'Superseded docs move to the archive. <!-- removal-stamp-exempt: generic rule: lifecycle policy -->'), []);
  assert.equal(failures('docs/FIXTURE.md', 'The endpoint was removed. <!-- removal-stamp-exempt: generic rule: -->')[0]?.gate, 'REMOVAL_STAMP');
  assert.deepEqual(failures('docs/FIXTURE.md', '```text\nThe endpoint was removed.\n```'), []);
  assert.deepEqual(checkDocHygiene('docs/archive/OLD.md', living('The endpoint was removed.')), []);
});

const IMPORT = "/* shim */\n@import url('../../src/client/tokens.css');\n";
const proto = (extra = {}) => new Map(Object.entries({ 'prototypes/design/tokens.css': IMPORT, 'prototypes/room/check.html': '<style>body{background:var(--ground)}</style>', ...extra }));
test('[CASE-163] PROTO_DRIFT: a colour literal in a prototype fails; tokens.css must stay an @import of the shipped tokens', () => {
  assert.deepEqual(checkPrototypeDrift(proto()), []);
  for (const bad of ['#ff0000', '#f00', 'rgb(255 0 0)', 'rgba(0,0,0,.5)', 'hsl(10 40% 70%)']) {
    const hit = checkPrototypeDrift(proto({ 'prototypes/room/check.html': `<style>a{color:${bad}}</style>` }));
    assert.equal(hit[0]?.gate, 'PROTO_DRIFT', bad);
  }
  // a brand-new prototype file, and a new literal in a baselined file, both fail
  assert.equal(checkPrototypeDrift(proto({ 'prototypes/new-page.html': '<i style="color:#123456"></i>' }))[0].gate, 'PROTO_DRIFT');
  assert.equal(checkPrototypeDrift(proto({ 'prototypes/room/index.html': 'x{background:#fff;color:#ff0000}' }))[0].gate, 'PROTO_DRIFT');
  // the mosaic renderer owns its pigments; the allow-listed file passes
  assert.deepEqual(checkPrototypeDrift(proto({ 'prototypes/design/mosaic.mjs': 'const c="#a1b2c3"' })), []);
  // the shim must be exactly an import
  for (const text of ['', ':root{--ink:#000}', "@import url('tokens-old.css');", IMPORT + 'body{margin:0}']) {
    assert.equal(checkPrototypeDrift(proto({ 'prototypes/design/tokens.css': text }))[0]?.gate, 'PROTO_DRIFT', JSON.stringify(text));
  }
});

test('[CASE-163] PROTO_DRIFT is a ratchet: whole literals, named colours, color(), and the lab component rules', () => {
  const edit = (file, text) => checkPrototypeDrift(proto({ [file]: text }));
  // a baselined function literal is allowed only as the exact same whole literal
  assert.deepEqual(edit('prototypes/room/facilitator.html', 'dialog::backdrop { background: rgba(10, 30, 36, .45); }'), []);
  assert.equal(edit('prototypes/room/facilitator.html', 'dialog::backdrop { background: rgba(0, 0, 0, .5); }')[0]?.gate, 'PROTO_DRIFT');
  assert.equal(edit('prototypes/room/facilitator.html', 'a{background:rgba(10,30,36,.45)} b{background:rgba(255,0,0,1)}')[0]?.gate, 'PROTO_DRIFT');
  // named colours and color() in CSS contexts
  for (const bad of ['a{color:red}', 'a{background:linear-gradient(white, tomato)}', 'a{border:1px solid rebeccapurple}', 'a{box-shadow:0 0 0 2px gold}', 'a{fill:currentColor;stroke:navy}', 'a{color:color(srgb 1 0 0)}', 'a{color:oklch(60% .2 20)}', '<svg fill="red"></svg>', 'a{color:HSL(1 2% 3%)}'])
    assert.equal(edit('prototypes/room/check.html', bad)[0]?.gate, 'PROTO_DRIFT', bad);
  // prose and token use are not literals
  for (const ok of ['<p>Red flags and orange cones.</p>', 'a{color:var(--ink);background:color-mix(in srgb, var(--ph) 20%, var(--surface));border:1px solid transparent}', 'a{color:currentColor;fill:none}'])
    assert.deepEqual(edit('prototypes/room/check.html', ok), [], ok);
  // the lab token file: token blocks are mirror-tested, but its component rules are scanned
  const labTokens = ':root{--ink:#16242a;}\n/* ── base ── */\nbody{color:var(--ink)}';
  assert.deepEqual(edit('prototypes/room/lib/tokens.css', labTokens), []);
  assert.equal(edit('prototypes/room/lib/tokens.css', labTokens + '\n.btn{background:#123456}')[0]?.gate, 'PROTO_DRIFT');
  assert.equal(edit('prototypes/room/lib/tokens.css', ':root{--ink:#16242a;}\nbody{color:#fff}')[0]?.gate, 'PROTO_DRIFT', 'a lab token file without its base marker is scanned whole');
  // the standalone pages and the lab marks are baselined, not exempt
  for (const f of ['prototypes/authoring-surfaces.html', 'prototypes/decision-path-editor.html', 'prototypes/synchronisation-lab.html', 'prototypes/room/lib/marks.mjs'])
    assert.equal(edit(f, 'x{color:#abcdef}')[0]?.gate, 'PROTO_DRIFT', f);
});

test('[CASE-163] round 3: PROTO_DRIFT baseline is exact (a stale entry fails) and sees custom properties and var() colour functions', () => {
  const edit = (file, text) => checkPrototypeDrift(proto({ [file]: text }));
  const stale = edit('prototypes/room/phone.html', '<style>body{background:var(--ground)}</style>');
  assert.equal(stale[0]?.gate, 'PROTO_DRIFT');
  assert.match(stale[0].message, /no longer present.*delete/i);
  assert.deepEqual(edit('prototypes/room/phone.html', 'x{background:#fff}'), []);
  for (const bad of [':root{--x:red}', ':root{--accent: Tomato;}', 'a{color:hsl(var(--h) 30% 70%)}', 'a{color:rgb(var(--r) 0 0)}', 'a{background:RGBA(var(--r), 0, 0, .5)}'])
    assert.equal(edit('prototypes/room/check.html', bad)[0]?.gate, 'PROTO_DRIFT', bad);
  assert.deepEqual(edit('prototypes/room/check.html', 'a{background:color-mix(in srgb, var(--ph) 20%, var(--surface));color:var(--ink)}'), []);
});


test('FILENAMES permits monthly surface-audit records without opening arbitrary monthly artefacts', () => {
  assert.equal(RULES.some(rule => rule.test('docs/red-team/2026-10-surface-audit.md')), true);
  for (const file of ['docs/red-team/2026-10-notes.md', 'docs/research/2026-10-surface-audit.md', 'docs/red-team/2026-1-surface-audit.md'])
    assert.equal(RULES.some(rule => rule.test(file)), false, file);
});

test('FILENAMES confines frozen Builder evidence to the card49 JSON/text artifact directory', () => {
  for (const file of ['tests/fixtures/synthetic/builder-diving-source.txt', 'tests/fixtures/synthetic/builder-diving-transfer.json'])
    assert.equal(RULES.some(rule => rule.test(file)), true, file);
  for (const file of ['docs/cards/48-artifacts/draft.json', 'tests/fixtures/synthetic/draft.js', 'tests/fixtures/synthetic/nested/draft.json'])
    assert.equal(RULES.some(rule => rule.test(file)), false, file);
});

// CASE-257: macOS (APFS, case-insensitive) resolves a wrong-case import that Linux refuses; CI runs on both.
test('[CASE-257] IMPORT_CASE refuses a relative import whose case differs from the file on disk', () => {
  const tree = { '': ['src', 'tests'], src: ['client', 'shared'], 'src/client': ['Keymap.mjs', 'app.mjs'], 'src/shared': ['ids.mjs'], tests: ['a.test.mjs'] };
  const listDir = dir => tree[dir] ?? null;
  const check = (file, text) => checkImportCase(file, text, listDir).map(e => e.message);
  assert.deepEqual(check('src/client/app.mjs', "import { k } from \u0027./Keymap.mjs\u0027;\nimport { id } from \u0027../shared/ids.mjs\u0027;"), []);
  assert.deepEqual(check('src/client/app.mjs', "import { k } from \u0027./keymap.mjs\u0027;"), ["import \u0027./keymap.mjs\u0027 names keymap.mjs, but the file on disk is Keymap.mjs"]);
  assert.deepEqual(check('tests/a.test.mjs', "const m = await import(\u0027../SRC/client/app.mjs\u0027);"), ["import \u0027../SRC/client/app.mjs\u0027 names SRC, but the file on disk is src"]);
  assert.equal(check('tests/a.test.mjs', "export { x } from \u0027../src/Shared/ids.mjs\u0027;").length, 1);
  assert.equal(check('tests/a.test.mjs', "import \u0027../src/client/APP.mjs\u0027;").length, 1);
  assert.equal(check('src/client/app.mjs', "const u = new URL(\u0027../Shared/ids.mjs\u0027, import.meta.url);").length, 1);
  assert.equal(check('src/client/app.mjs', "fetch(\u0027./keymap.mjs?v=1\u0027)").length, 0, 'not an import');
  // Missing in any case, bare packages, template specifiers and paths outside the repo are someone else's concern.
  assert.deepEqual(check('src/client/app.mjs', "import a from \u0027./missing.mjs\u0027; import b from \u0027node:fs\u0027; import(`./${n}.mjs`); import c from \u0027../../../x.mjs\u0027;"), []);
});
