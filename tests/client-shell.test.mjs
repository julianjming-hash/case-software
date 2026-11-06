import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildClient } from '../scripts/build-client.mjs';
import { withSecurityHeaders } from '../src/worker/headers.mjs';
import { pathToFileURL } from 'node:url';
import { init, parse } from 'es-module-lexer';

const SHA = 'a'.repeat(40);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'case-shell-build-'));
  mkdirSync(join(root, 'public')); mkdirSync(join(root, 'src/client'), { recursive: true });
  writeFileSync(join(root, 'public/index.html'), '<!doctype html><script type="module" src="../src/client/app.mjs"></script>');
  writeFileSync(join(root, 'public/check.html'), '<!doctype html><script type="module" src="../src/client/check.mjs"></script>');
  writeFileSync(join(root, 'src/client/app.mjs'), "import './dependency.mjs';\nexport const shell = 1;");
  writeFileSync(join(root, 'src/client/check.mjs'), "import './dependency.mjs';");
  writeFileSync(join(root, 'src/client/dependency.mjs'), 'export const value = 1;');
  writeFileSync(join(root, 'src/client/sw.mjs'), "const name = '__CACHE_NAME__'; const files = /*__SHELL__*/[];");
  return { root, outDir: join(root, 'dist'), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
test('shell build hashes final rewritten bytes and includes the full import closure deterministically', async () => {
  const f = fixture(); try {
    const first = await buildClient({ ...f, env: 'staging', buildSha: SHA });
    const second = await buildClient({ ...f, env: 'staging', buildSha: SHA });
    assert.equal(first.cacheName, second.cacheName);
    for (const file of first.hashedFiles) {
      const hash = createHash('sha256').update(readFileSync(join(f.outDir, file))).digest('hex');
      assert.ok(file.includes(hash), file);
      if (file.endsWith('.mjs')) assert.doesNotMatch(readFileSync(join(f.outDir, file), 'utf8'), /\.\/dependency\.mjs/);
    }
    writeFileSync(join(f.root, 'src/client/dependency.mjs'), 'export const value = 2;');
    assert.notEqual((await buildClient({ ...f, env: 'staging', buildSha: SHA })).cacheName, first.cacheName);
  } finally { f.cleanup(); }
});
test('shell build rejects import cycles and files outside shell roots', async () => {
  const f = fixture(); try {
    writeFileSync(join(f.root, 'src/client/dependency.mjs'), "import './app.mjs';");
    await assert.rejects(buildClient({ ...f, buildSha: SHA }), /asset_cycle/);
    writeFileSync(join(f.root, 'src/client/dependency.mjs'), "import '../../fixtures/patient.json';");
    await assert.rejects(buildClient({ ...f, buildSha: SHA }), /non_shell_asset/);
    writeFileSync(join(f.root, 'src/client/dependency.mjs'), 'export const value = 1;');
    mkdirSync(join(f.root, 'fixtures'));
    writeFileSync(join(f.root, 'fixtures/fixture.svg'), '<svg></svg>');
    symlinkSync(join(f.root, 'fixtures/fixture.svg'), join(f.root, 'src/client/linked.svg'));
    writeFileSync(join(f.root, 'src/client/private.css'), `.icon { background: url('./linked.svg'); }`);
    writeFileSync(join(f.root, 'public/index.html'), '<link rel="stylesheet" href="../src/client/private.css">');
    await assert.rejects(buildClient({ ...f, buildSha: SHA }), /non_shell_asset/);
  } finally { f.cleanup(); }
});
test('manifest, selected environment headers and only named SPA rewrites are generated', async () => {
  const f = fixture(); try {
    const result = await buildClient({ ...f, env: 'production', buildSha: SHA });
    assert.deepEqual(JSON.parse(readFileSync(join(f.outDir, 'manifest.webmanifest'))), { id: '/', name: 'Case', short_name: 'Case', start_url: '/', scope: '/', display: 'standalone' });
    const headers = readFileSync(join(f.outDir, '_headers'), 'utf8');
    const expected = withSecurityHeaders(new Response(), 'html', { CASE_ENV: 'production', BUILD_SHA: SHA }).headers;
    for (const [key, value] of expected) assert.ok(headers.includes(`${key}: ${value}`), key);
    assert.equal(result.environment, 'production');
    const redirects = readFileSync(join(f.outDir, '_redirects'), 'utf8');
    assert.match(redirects, /\/J\/\* \/room\.html 200/);
    assert.equal(readFileSync(join(f.outDir, 'room.html'), 'utf8'), readFileSync(join(f.outDir, 'index.html'), 'utf8'));
    assert.ok(result.shell.includes('room.html')); assert.match(headers, /^\/room\.html$/m); assert.match(redirects, /\/check \/check\.html 200/);
    assert.doesNotMatch(redirects, /^\/\* /m); assert.doesNotMatch(headers, /googleapis|gstatic/);
    await assert.rejects(buildClient({ ...f, env: 'unknown', buildSha: SHA }), /invalid_environment/);
  } finally { f.cleanup(); }
});
test('[AS-079] static shell CSP uses only the selected exact HTTPS Auth origin', async () => {
  const f = fixture();
  const selected = 'https://auth.example.invalid';
  const bindings = { SUPABASE_URL: selected,
    SUPABASE_JWT_ISSUER: `${selected}/auth/v1`,
    SUPABASE_JWKS_URL: `${selected}/auth/v1/.well-known/jwks.json` };
  try {
    await buildClient({ ...f, env: 'staging', buildSha: SHA, publicAuthBindings: bindings });
    let headers = readFileSync(join(f.outDir, '_headers'), 'utf8');
    assert.match(headers, /connect-src 'self' https:\/\/auth\.example\.invalid\/auth\/v1\/;/);
    assert.doesNotMatch(headers, /rest\/v1|connect-src[^\n]*\*/);
    await buildClient({ ...f, env: 'staging', buildSha: SHA,
      publicAuthBindings: { ...bindings, SUPABASE_JWKS_URL: 'https://other.invalid/auth/v1/.well-known/jwks.json' } });
    headers = readFileSync(join(f.outDir, '_headers'), 'utf8');
    assert.doesNotMatch(headers, /auth\.example\.invalid/);
  } finally { f.cleanup(); }
});
test('rewriting preserves earlier JS labels and HTML text while replacing only real reference spans', async () => {
  const f = fixture(); try {
    writeFileSync(join(f.root, 'src/client/app.mjs'), "const label = './dependency.mjs';\n// import './not-real.mjs';\nconst note = \"import './also-not-real.mjs';\";\nimport './dependency.mjs';");
    writeFileSync(join(f.root, 'public/index.html'), '<!doctype html><p>../src/client/app.mjs</p><!-- <script src="../src/client/missing.mjs"></script> --><script type="module" src="../src/client/app.mjs"></script>');
    writeFileSync(join(f.root, 'src/client/style.css'), `/* url('./comment-missing.svg') */\n.label::after { content: \"url('./string-missing.svg')\"; }\n.icon { background: url('./icon.svg'); }`);
    writeFileSync(join(f.root, 'src/client/icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    writeFileSync(join(f.root, 'public/index.html'), readFileSync(join(f.root, 'public/index.html'), 'utf8') + '<link rel="stylesheet" href="../src/client/style.css">');
    const result = await buildClient({ ...f, buildSha: SHA });
    const css = readFileSync(join(f.outDir, result.hashedFiles.find(file => file.endsWith('.css'))), 'utf8');
    assert.match(css, /url\('\.\/string-missing\.svg'\)/);
    assert.match(css, /url\('\/assets\/icon\.[a-f0-9]{64}\.svg'\)/);
    const app = readFileSync(join(f.outDir, result.entries.app), 'utf8');
    assert.match(app, /const label=["']\.\/dependency\.mjs["']/); assert.match(app, /import["']\/assets\/dependency\.[a-f0-9]{64}\.mjs["']/);
    assert.doesNotMatch(app, /\.\/not-real\.mjs/); // Source comments are omitted by the whitespace-only formatter.
    assert.match(app, /import '\.\/also-not-real\.mjs'/);
    const html = readFileSync(join(f.outDir, 'index.html'), 'utf8');
    assert.match(html, /<p>\.\.\/src\/client\/app\.mjs<\/p>/); assert.match(html, /src="\/assets\/app\.[a-f0-9]{64}\.mjs"/);
  } finally { f.cleanup(); }
});

test('formatted modules preserve imports, exports, strings, regexp and automatic semicolon behavior', async () => {
  const f = fixture();
  try {
    const source = `/*! Case fixture licence */
// COMMENT_ONLY must never be served
import { value } from './dependency.mjs';
export const literal = "import './also-not-real.mjs'; /* literal stays */";
export const expression = /[a-z]\\/\\*.*\\*\\//;
export function Result(input) {
  const object = { input, value };
  const newline = () => { return\n  { unreachable: true }; };
  return [object, expression.test(input), literal, newline()];
}
export const symbols = ['Result', 'literal', 'expression'];\n`;
    writeFileSync(join(f.root, 'src/client/app.mjs'), source);
    const result = await buildClient({ ...f, buildSha: SHA });
    let formatted = readFileSync(join(f.outDir, result.entries.app), 'utf8');
    assert.doesNotMatch(formatted, /COMMENT_ONLY/);
    assert.match(formatted, /Case fixture licence/);
    await init;
    const imports = parse(formatted)[0];
    assert.equal(imports.length, 1); assert.match(imports[0].n, /^\/assets\/dependency\.[a-f0-9]{64}\.mjs$/);
    const ref = imports[0], dependency = pathToFileURL(join(f.outDir, ref.n.slice(1))).href;
    formatted = formatted.slice(0, ref.s) + dependency + formatted.slice(ref.e);
    writeFileSync(join(f.outDir, 'formatted-fixture.mjs'), formatted);
    const [original, emitted] = await Promise.all([import(pathToFileURL(join(f.root, 'src/client/app.mjs'))), import(pathToFileURL(join(f.outDir, 'formatted-fixture.mjs')))]);
    assert.deepEqual(Object.keys(emitted), Object.keys(original));
    assert.equal(emitted.Result.name, original.Result.name);
    for (const input of ['alpha/*note*/', '界', '\n/* */']) assert.deepEqual(emitted.Result(input), original.Result(input));
    assert.equal(emitted.literal, original.literal); assert.equal(String(emitted.expression), String(original.expression));
    assert.deepEqual(emitted.symbols, original.symbols);
  } finally { f.cleanup(); }
});
test('client/public filename rules permit shell assets and reject unrelated files', async () => {
  const { RULES } = await import('../scripts/check-case.mjs');
  for (const path of ['src/client/shell.css', 'src/client/theme/extra.css', 'public/index.html', 'public/manifest.webmanifest', 'public/fonts/montserrat-latin.woff2', 'public/avatars/shadows-01.svg']) assert.ok(RULES.some(rule => rule.test(path)), path);
  for (const path of ['public/patient.json', 'public/name.txt', 'src/worker/page.css', 'public/fonts/private.key']) assert.ok(!RULES.some(rule => rule.test(path)), path);
});

test('the cache name hashes exactly the shell paths and final contents and embeds wire version', async () => {
  const f = fixture(); try {
    const result = await buildClient({ ...f, buildSha: SHA, wireVersion: 2 });
    const hash = createHash('sha256');
    for (const file of result.shell) { hash.update(file); hash.update('\0'); hash.update(readFileSync(join(f.outDir, file))); hash.update('\0'); }
    assert.equal(result.cacheName, `case-shell-wire2-${hash.digest('hex')}`);
    assert.ok(!result.shell.some(file => /api|case-pack|fixtures/.test(file)));
    rmSync(join(f.root, 'src/client/sw.mjs'));
    await assert.rejects(buildClient({ ...f, buildSha: SHA }), /ENOENT/);
  } finally { f.cleanup(); }
});

test('isolated shell output is fresh and never deletes an existing noncanonical directory', async () => {
  const f = fixture(); const temp = mkdtempSync(join(tmpdir(), 'case-shell-output-'));
  try {
    const outDir = join(temp, 'assets');
    await buildClient({ ...f, outDir, buildSha: SHA });
    assert.ok(readFileSync(join(outDir, 'index.html'), 'utf8').includes('/assets/'));
    await assert.rejects(buildClient({ ...f, outDir, buildSha: SHA }), /EEXIST/);
    const before = readFileSync(join(f.root, 'src/client/app.mjs'), 'utf8');
    await assert.rejects(buildClient({ ...f, outDir: join(f.root, 'src/client'), buildSha: SHA }), /EEXIST/);
    assert.equal(readFileSync(join(f.root, 'src/client/app.mjs'), 'utf8'), before);
  } finally { f.cleanup(); rmSync(temp, { recursive: true, force: true }); }
});
