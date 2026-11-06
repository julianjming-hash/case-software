#!/usr/bin/env node
// Static shell only: no fixtures, cases, secrets or API responses enter the build graph.
import { readFile, writeFile, mkdir, rm, readdir, realpath, access } from 'node:fs/promises';
import { resolve, relative, dirname, extname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { withSecurityHeaders } from '../src/worker/headers.mjs';
import { WIRE_VERSION } from '../src/shared/wire.mjs';
import { init, parse } from 'es-module-lexer';
import { transformSync } from 'esbuild';
import { AVATAR_IDS } from '../src/shared/participant.mjs';
import { readRoomMusicManifest, ROOM_MUSIC_DIR } from './room-music-manifest.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const HTML_ROUTES = ['/', '/join', '/privacy', '/help', '/account', '/history', '/present', '/create', '/create/*', '/sessions', '/i', '/i/', '/cases', '/cases/*', '/index.html', '/room.html', '/J/*', '/j/*', '/F/*', '/f/*', '/D/*', '/d/*', '/P/*', '/p/*', '/sessions/*', '/check', '/check.html', '/admin', '/admin.html'];
const ASSET_ROOTS = ['src/client/', 'src/shared/', 'public/fonts/', 'public/avatars/', 'public/audio/', 'public/icons/'];
// CSS lexical tokens consume comments and strings before considering a real url().
function cssReferences(text) {
  const refs = [];
  const tokens = /\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\burl\(\s*(?:"([^"\\]*)"|'([^'\\]*)'|([^)'"\s]+))\s*\)|@import\b/gi;
  for (const token of text.matchAll(tokens)) {
    if (/^@import/i.test(token[0])) throw new Error('unsupported_css_import');
    const target = token[1] ?? token[2] ?? token[3];
    if (target !== undefined) { const start = token.index + token[0].indexOf(target); refs.push({ start, end: start + target.length, target }); }
  }
  return refs;
}
const replaceSpans = (text, spans) => {
  for (const { start, end, value } of spans.sort((a, b) => b.start - a.start)) text = text.slice(0, start) + value + text.slice(end);
  return text;
};
function htmlReferences(text) {
  const masked = text.replace(/<!--[\s\S]*?-->/g, match => ' '.repeat(match.length));
  const refs = [];
  for (const tag of masked.matchAll(/<(?:script|link|img|source)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
    for (const attr of tag[0].matchAll(/\b(?:src|href)\s*=\s*(["'])(\.{1,2}\/[^"']+)\1/g)) {
      const start = tag.index + attr.index + attr[0].indexOf(attr[2]);
      refs.push({ start, end: start + attr[2].length, target: attr[2] });
    }
  }
  return refs;
}

// Static assets receive headers before the Worker runs. Read only the selected
// environment's three public Auth URL bindings; key material is never a build input.
async function selectedPublicAuthBindings(root, env) {
  if (env === 'local') return {};
  let source;
  try { source = await readFile(join(root, 'wrangler.toml'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  const section = `[env.${env}.vars]`;
  const start = source.indexOf(section);
  if (start < 0) return {};
  const body = source.slice(start + section.length).split(/^\[/m, 1)[0];
  const bindings = {};
  for (const key of ['SUPABASE_URL', 'SUPABASE_JWT_ISSUER', 'SUPABASE_JWKS_URL']) {
    const line = body.match(new RegExp(`^${key}\\s*=\\s*("[^"\\n]*")\\s*$`, 'm'));
    if (line) bindings[key] = JSON.parse(line[1]);
  }
  return bindings;
}

// Reviewed modules that receive syntax and identifier compaction in addition to whitespace. Card 50 adds the
// model/preview dependencies the Builder routes already load; no module, export, asset or byte ceiling is removed,
// and tests/builder-compiled-model.test.mjs proves every listed module keeps its exports after emission.
export const COMPACT_MODULES = Object.freeze(['src/client/permission-comparison.mjs','src/client/permission-labels.mjs','src/client/issue-auth-binding.mjs','src/client/issue-capture.mjs','src/client/issue-entry.mjs','src/client/issue-reporter.mjs','src/client/issues-client.mjs','src/client/issues-ui.mjs','src/client/admin-issues.mjs','src/shared/issues.mjs','src/client/console.mjs','src/client/library.mjs','src/client/admin-invitations.mjs','src/client/surface-notice.mjs','src/client/ui-icons.mjs','src/client/music-audition.mjs','src/client/surface-controls.mjs','src/client/accessible-select.mjs','src/client/case-detail.mjs','src/client/auth.mjs','src/shared/ordinary-question.mjs','src/client/publication-summary.mjs','src/shared/blank-slide.mjs','src/shared/slide-edit.mjs','src/client/keymap.mjs', 'src/client/keymap-sheet.mjs', 'src/shared/mosaic-geometry.mjs', 'src/shared/art-descriptor.mjs', 'src/client/projector-marks.mjs', 'src/shared/ranked-groups.mjs', 'src/shared/ranked-page-view.mjs', 'src/shared/ranked-presentation.mjs', 'src/shared/room-corrections.mjs', 'src/shared/identifiers.mjs', 'src/shared/presentation-groups.mjs', 'src/shared/presentation-order.mjs', 'src/client/presentation-nav.mjs', 'src/shared/runtime-document.mjs', 'src/shared/tints.mjs', 'src/shared/room-machine.mjs', 'src/shared/case-document.mjs', 'src/shared/case-map.mjs', 'src/shared/room-interpretation.mjs', 'src/client/case-map.mjs', 'src/client/teaching-controls.mjs', 'src/client/preview-rehearsal.mjs', 'src/client/console-route-selection.mjs', 'src/client/console-actions.mjs', 'src/client/console-focus.mjs', 'src/client/console-timeline.mjs', 'src/client/console-view.mjs', 'src/client/console-ranking.mjs', 'src/client/account-session.mjs', 'src/client/native-dom.mjs', 'src/client/format-editor.mjs', 'src/client/formatted-text.mjs', 'src/client/groups-screen.mjs', 'src/shared/urls.mjs', 'src/client/admin.mjs', 'src/client/admin-workbench.mjs', 'src/client/auth-ui.mjs', 'src/client/shared-menu.mjs', 'src/client/site-header.mjs', 'src/client/portfolio-page.mjs', 'src/client/session-detail.mjs', 'src/client/session-export.mjs', 'src/client/session-pdf.mjs', 'src/shared/session-record.mjs', 'src/shared/session-record-wire.mjs', 'src/shared/media-gif.mjs', 'src/shared/media-mp4.mjs','src/client/recap-journey.mjs','src/client/recap-pdf.mjs','src/client/facilitator-label-form.mjs','src/shared/facilitator-label.mjs','src/client/room-sound-engine.mjs','src/client/room-music.mjs','src/shared/music-timeline.mjs','src/client/room-audio-state.mjs','src/shared/music-catalogue.mjs']);
/** The selected environment travels with the public build SHA into the shared response policy. */
export async function buildClient({ root = ROOT, outDir = join(root, 'dist'), env = 'local', buildSha = 'unconfigured', wireVersion = WIRE_VERSION, publicAuthBindings = null } = {}) {
  if (!['local', 'production', 'staging'].includes(env)) throw new Error('invalid_environment');
  if (buildSha !== 'unconfigured' && (typeof buildSha !== 'string' || buildSha.length !== 40 || !/^[0-9a-f]{40}$/.test(buildSha))) throw new Error('invalid_build');
  if (env !== 'local' && buildSha === 'unconfigured') throw new Error('invalid_build');
  root = resolve(root); outDir = resolve(outDir);
  const physicalRoot = await realpath(root);
  await init;
  if (outDir === root) throw new Error('invalid_output');
  if (outDir === join(root, 'dist')) await rm(outDir, { recursive: true, force: true });
  else await mkdir(outDir); // Noncanonical outputs must be fresh; never delete a caller's directory.
  await mkdir(join(outDir, 'assets'), { recursive: true });
  const emitted = new Map(); const visiting = new Set(); const hashedFiles = [];
  const asset = async path => {
    path = resolve(path); const source = relative(root, path).split('\\').join('/');
    const allowed = candidate => ASSET_ROOTS.some(prefix => candidate.startsWith(prefix)) && !candidate.includes('/fixtures/') && /\.(mjs|css|woff2|svg|txt|wav|mp3)$/.test(candidate);
    if (!allowed(source)) throw new Error('non_shell_asset');
    const physicalSource = relative(physicalRoot, await realpath(path)).split('\\').join('/');
    if (!allowed(physicalSource)) throw new Error('non_shell_asset');
    if (emitted.has(path)) return emitted.get(path);
    if (visiting.has(path)) throw new Error('asset_cycle'); visiting.add(path);
    let bytes = await readFile(path);
    if (/\.(mjs|css)$/.test(path)) {
      let text = bytes.toString();
      // One explicit generated module; never rewrite arbitrary JavaScript URL-looking text.
      if (source === 'src/client/avatar-assets.mjs') {
        if (text !== 'export const AVATAR_URLS = Object.freeze(/*__AVATAR_URLS__*/{});\n') throw new Error('invalid_avatar_template');
        const urls = {};
        for (const id of AVATAR_IDS) urls[id] = `/${await asset(join(root, 'public/avatars', `${id}.svg`))}`;
        text = `export const AVATAR_URLS = Object.freeze(${JSON.stringify(urls)});\n`;
      }

      // On-demand room audio: hashed into dist/assets but never precached (see `shell` below). Event cues
      // (projector) and ui-* tones (console only) are separate maps so neither surface ships the other's URLs.
      const audioMap = { 'src/client/audio-assets.mjs': ['CUE_URLS', name => !name.startsWith('ui-')], 'src/client/ui-tone-assets.mjs': ['UI_TONE_URLS', name => name.startsWith('ui-')] }[source];
      if (audioMap) {
        const [exportName, pick] = audioMap;
        if (text !== `export const ${exportName} = Object.freeze(/*__${exportName}__*/{});\n`) throw new Error('invalid_audio_template');
        const urls = {};
        for (const file of (await readdir(join(root, 'public/audio'))).filter(name => name.endsWith('.wav') && pick(name)).sort()) urls[file.replace(/\.wav$/, '')] = `/${await asset(join(root, 'public/audio', file))}`;
        text = `export const ${exportName} = Object.freeze(${JSON.stringify(urls)});\n`;
      }
      // CASE-334: the approved room music library, hashed into dist/assets and never precached. Playback receives only
      // the public metadata it schedules with and each asset's hashed URL, never a file-system path.
      if (source === 'src/client/music-assets.mjs') {
        if (text !== 'export const MUSIC_LIBRARY = Object.freeze(/*__MUSIC_LIBRARY__*/{});\n') throw new Error('invalid_music_template');
        const manifest = await readRoomMusicManifest(root), urls = new Map();
        for (const file of [...new Set(manifest.tracks.flatMap(track => [track, ...track.boosts]).flatMap(profile => Object.values(profile.assets)).map(a => a.file))].sort())
          urls.set(file, '/' + await asset(join(root, ROOM_MUSIC_DIR, file)));
        await asset(join(root, ROOM_MUSIC_DIR, 'LICENSE.txt'));
        const assets = profile => Object.fromEntries(Object.entries(profile.assets).map(([part, { file, sha256, ...rest }]) => [part, { url: urls.get(file), ...rest }]));
        const tracks = manifest.tracks.map(({ boosts, ...track }) => ({ ...track, assets: assets(track),
          boosts: boosts.map(boost => ({ ...track, ...boost, kind: track.kind, meter: track.meter, bars: track.bars, assets: assets(boost) })) }));
        text = 'export const MUSIC_LIBRARY = Object.freeze(' + JSON.stringify({ tracks }) + ');\n';
      }
      if (source === 'src/client/builder-page.mjs') {
        const marker = "'__BUILDER_PAGE_CSS_URL__'";
        if (!text.includes(marker)) throw new Error('invalid_builder_page_styles_template');
        text = text.replace(marker, JSON.stringify(`/${await asset(join(root, 'src/client/builder-page.css'))}`));
      }
      if (source === 'src/client/builder-route.mjs') {
        const marker = "'__BUILDER_STUDIO_CSS_URL__'";
        if (!text.includes(marker)) throw new Error('invalid_builder_styles_template');
        const cssUrl = `/${await asset(join(root, 'src/client/builder-studio.css'))}`;
        text = text.replace(marker, JSON.stringify(cssUrl));
      }
      if (source === 'src/client/builder-shell.mjs') {
        const marker = "'__BUILDER_SHELL_CSS_URL__'";
        if (!text.includes(marker)) throw new Error('invalid_builder_shell_styles_template');
        text = text.replace(marker, JSON.stringify(`/${await asset(join(root, 'src/client/builder-shell.css'))}`));
      }
      if (source === 'src/client/builder-slides.mjs') {
        const marker = "'__BUILDER_SLIDES_CSS_URL__'";
        if (!text.includes(marker)) throw new Error('invalid_builder_slides_styles_template');
        text = text.replace(marker, JSON.stringify(`/${await asset(join(root, 'src/client/builder-slides.css'))}`));
      }
      if (source === 'src/client/builder-gas.mjs') {
        const marker = "'__BUILDER_GAS_CSS_URL__'";
        if (!text.includes(marker)) throw new Error('invalid_builder_gas_styles_template');
        text = text.replace(marker, JSON.stringify(`/${await asset(join(root, 'src/client/builder-gas.css'))}`));
      }
  if(source==='src/client/issues-ui.mjs'){
   const marker="'__ISSUES_CSS_URL__'";if(!text.includes(marker))throw Error('missing_issues_css_marker');text=text.replace(marker,JSON.stringify('/'+await asset(join(root,'src/client/issues.css'))));
  }
  if(source==='src/client/feedback-style.mjs'){
      const marker="'__FEEDBACK_PRESENTATION_CSS_URL__'";if(!text.includes(marker))throw new Error('missing_feedback_style_marker');text=text.replace(marker,JSON.stringify('/'+await asset(join(root,'src/client/feedback-presentation.css'))));
    }
        if(source==='src/client/console.mjs'){
        const marker="'__ADMIN_SURFACE_CSS_URL__'";if(!text.includes(marker))throw Error('invalid_admin_styles_template');
        text=text.replace(marker,JSON.stringify(`/${await asset(join(root,'src/client/admin.css'))}`));
      }
      if(source==='src/client/music-audition.mjs'){
        const marker="'__MUSIC_PLAYER_CSS_URL__'";
        if(!text.includes(marker))throw Error('invalid_music_styles_template');
        text=text.replace(marker,JSON.stringify(`/${await asset(join(root,'src/client/console.css'))}`));
      }
      const refs = path.endsWith('.mjs') ? parse(text)[0].filter(ref => ref.d !== -2).map(ref => {
        if (!ref.n) throw new Error('dynamic_asset');
        return { start: ref.s, end: ref.e, target: ref.n, quoted: ref.d >= 0 };
      }) : cssReferences(text);
      const spans = [];
      for (const ref of refs) {
        if (!ref.target.startsWith('./') && !ref.target.startsWith('../')) throw new Error('external_asset');
        const output = await asset(resolve(dirname(path), ref.target));
        spans.push({ ...ref, value: ref.quoted ? JSON.stringify(`/${output}`) : `/${output}` });
      }
      text = replaceSpans(text, spans);
      // Minify only measured Builder modules plus the explicitly listed shared modules. Sources stay
      // readable; each emitted ESM keeps its import/export boundaries and remains fully budgeted.
      const compactBuilderModule = /^src\/(?:client|shared)\/builder-[^/]+\.mjs$/.test(source) ||
        COMPACT_MODULES.includes(source);
      // Whitespace compaction is the existing emitted-ESM build behavior. Only the reviewed
      // Builder/shared targets receive the additional syntax and identifier compaction.
      bytes = Buffer.from(path.endsWith('.mjs') ? transformSync(text, { loader: 'js', target: 'esnext',
        minifyWhitespace: true, minifyIdentifiers: compactBuilderModule, minifySyntax: compactBuilderModule, legalComments: 'inline' }).code
        // Card 50: Builder stylesheets get the same whitespace compaction; selectors, values and references are unchanged.
        : /^src\/client\/builder-[^/]+\.css$/.test(source) ? transformSync(text, { loader: 'css', minifyWhitespace: true }).code : text);
    }
    const file = `assets/${basename(path, extname(path))}.${digest(bytes)}${extname(path)}`;
    await writeFile(join(outDir, file), bytes); emitted.set(path, file); visiting.delete(path); hashedFiles.push(file); return file;
  };
  const publicFiles = (await readdir(join(root, 'public'))).filter(name => name.endsWith('.html')).sort();
  for (const page of publicFiles) {
    let text = await readFile(join(root, 'public', page), 'utf8');
    if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(text) || /<style\b|\son\w+=|\sstyle=/i.test(text)) throw new Error('inline_shell_code');
    const spans = [];
    for (const ref of htmlReferences(text)) {
      const file = await asset(resolve(root, 'public', ref.target)); spans.push({ ...ref, value: `/${file}` });
    }
    text = replaceSpans(text, spans);
    await writeFile(join(outDir, page), text);
    // Wrangler rejects wildcard proxies to index.html even with HTML handling disabled.
    if (page === 'index.html') await writeFile(join(outDir, 'room.html'), text);
  }
  // The icon is the app's wordmark tessera (site-header.mjs) on the dark ground, so it reads on light and dark tab bars.
  let icon = null; try { await access(join(root, 'public/icons/case.svg')); icon = `/${await asset(join(root, 'public/icons/case.svg'))}`; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const manifest = { id: '/', name: 'Case', short_name: 'Case', start_url: '/', scope: '/', display: 'standalone', ...(icon ? { icons: [{ src: icon, sizes: 'any', type: 'image/svg+xml' }] } : {}) };
  await writeFile(join(outDir, 'manifest.webmanifest'), JSON.stringify(manifest));
  // Optional vendors have no runtime coupling to prototype HTML or case data.
  for (const folder of ['fonts', 'avatars']) {
    let files = []; try { files = await readdir(join(root, 'public', folder)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const file of files.sort()) await asset(join(root, 'public', folder, file));
  }
  // Email images outlive a shell release. Keep every content-versioned source; never precache them.
  let emailFiles = [];
  try { emailFiles = await readdir(join(root, 'public/email')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (emailFiles.length) await mkdir(join(outDir, 'email'));
  for (const file of emailFiles.sort()) {
    const match = /^([a-f0-9]{12})\.jpg$/.exec(file);
    if (!match) throw new Error('invalid_email_asset');
    const path = join(root, 'public/email', file), physical = await realpath(path);
    if (physical !== join(physicalRoot, 'public/email', file)) throw new Error('invalid_email_asset');
    const bytes = await readFile(path);
    if (!digest(bytes).startsWith(match[1])) throw new Error('email_asset_hash_mismatch');
    await writeFile(join(outDir, 'email', file), bytes);
  }
  const shell = [...new Set([...publicFiles, ...(publicFiles.includes('index.html') ? ['room.html'] : []), 'manifest.webmanifest', ...hashedFiles.filter(file => !/\.(wav|mp3)$/.test(file))])].sort();
  const parts = [];
  for (const file of shell) parts.push(file, '\0', await readFile(join(outDir, file)), '\0');
  const hash = createHash('sha256'); for (const part of parts) hash.update(part);
  const cacheName = `case-shell-wire${wireVersion}-${hash.digest('hex')}`;
  const template = await readFile(join(root, 'src/client/sw.mjs'), 'utf8');
  await writeFile(join(outDir, 'sw.mjs'), template.replace('__CACHE_NAME__', cacheName).replace('/*__SHELL__*/[]', JSON.stringify(shell.map(file => `/${file}`))));
  const bindings = { CASE_ENV: env === 'local' ? '' : env, BUILD_SHA: buildSha,
    ...(publicAuthBindings ?? await selectedPublicAuthBindings(root, env)) };
  const policy = kind => [...withSecurityHeaders(new Response(), kind, bindings).headers].filter(([key]) => key !== 'content-type');
  const common = policy('asset').filter(([key]) => !['cache-control', 'content-security-policy'].includes(key));
  const block = (pattern, headers) => `${pattern}\n${headers.map(([key, value]) => `  ${key}: ${value}`).join('\n')}\n`;
  const perKind = kind => policy(kind).filter(([key]) => ['cache-control', 'content-security-policy'].includes(key));
  const headers = [block('/*', common), ...HTML_ROUTES.map(path => block(path, perKind('html'))), block('/assets/*', perKind('immutable-asset')), block('/email/*', perKind('immutable-asset')), block('/manifest.webmanifest', perKind('asset')), block('/sw.mjs', perKind('html'))].join('\n');
  await writeFile(join(outDir, '_headers'), headers);
  // Accompany the generated distribution with complete vendor permission notices.
  // Fixed build-tool inputs only: no arbitrary documentation, records or case source.
  const noticeInputs = ['licenses/lucide-static-1.59.0-package-LICENSE.txt',
    'public/fonts/ofl-montserrat.txt', 'public/fonts/ofl-jetbrains-mono.txt', 'public/fonts/ofl-noto-sans.txt'];
  const notices = await Promise.all(noticeInputs.map(async name => name + '\n\n' + await readFile(join(ROOT, name), 'utf8')));
  await writeFile(join(outDir, 'third-party-notices.txt'), notices.join('\n\n'));
  await writeFile(join(outDir, '_redirects'), ['/ /index.html 200', '/join /index.html 200', '/privacy /index.html 200', '/help /index.html 200', '/account /index.html 200', '/history /index.html 200', '/present /index.html 200', '/create /index.html 200', '/sessions /index.html 200', '/i /index.html 200', '/i/ /index.html 200', '/cases /index.html 200', '/check /check.html 200', '/admin /admin.html 200', ...['J', 'j', 'F', 'f', 'D', 'd', 'P', 'p', 'sessions', 'cases', 'create'].map(route => `/${route}/* /room.html 200`)].join('\n') + '\n');
  const entries = Object.fromEntries([...emitted].filter(([file]) => /\/(console|projector|phone|feedback-page|participant-record|check|pair|app|admin|home|library|console-tones|groups-screen|admin-workbench|portfolio-page|session-detail|session-export|session-pdf|briefing|ended-summary|debrief-render|feedback-results|help|keymap-sheet|splash|console-room|console-room-tab|console-mirror|account-session|room-music|case-map|builder-page|builder-route|builder-studio|builder-api|builder-templates|builder-workflows|builder-preview-snapshot|builder-slides|builder-slide-check|builder-inspection|builder-shell|builder-structure|builder-gas|builder-sources|builder-overview|builder-fit|projector-slides|slide-render|builder-media|media-gif|media-mp4|recap-pdf|finish-block|feedback-client|record-summary|facilitator-label-form|admin-invitations|admin-people|admin-workspaces|invite-page|invite-landing|case-share|case-detail|case-workspace-access|account-page|menu-account|music-audition|issue-entry|issue-reporter|admin-issues|unavailable)\.mjs$/.test(file)).map(([file, target]) => [basename(file, '.mjs'), target]));
  entries['issues-css']=emitted.get(resolve(join(root,'src/client/issues.css')));
  entries['feedback-presentation-css']=emitted.get(resolve(join(root,'src/client/feedback-presentation.css')));
  entries['admin-css']=emitted.get(resolve(join(root,'src/client/admin.css')));
  entries['music-audition-css']=emitted.get(resolve(join(root,'src/client/console.css')));
  entries['builder-page-css'] = emitted.get(resolve(join(root, 'src/client/builder-page.css')));
  entries['builder-studio-css'] = emitted.get(resolve(join(root, 'src/client/builder-studio.css')));
  entries['builder-slides-css'] = emitted.get(resolve(join(root, 'src/client/builder-slides.css')));
  entries['builder-shell-css'] = emitted.get(resolve(join(root, 'src/client/builder-shell.css')));
  entries['builder-gas-css'] = emitted.get(resolve(join(root, 'src/client/builder-gas.css')));
  // CASE-344: the callout icons' geometry, a lazy chunk the slide renderer loads with the first slide that draws one.
  entries.icons = emitted.get(resolve(join(root, 'src/shared/icons.mjs')));
  // `assets` maps each emitted source (repository-relative) to its hashed asset, for emission-parity tests.
  const assets = Object.fromEntries([...emitted].map(([path, file]) => [relative(root, path).split('\\').join('/'), file]));
  return { environment: env, cacheName, shell, hashedFiles: [...new Set(hashedFiles)].sort(), entries, assets };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); let env = 'local'; let buildSha;
  for (let i = 0; i < args.length; i++) { if (args[i] === '--env') env = args[++i]; else if (args[i] === '--build-sha') buildSha = args[++i]; else throw new Error('unknown_option'); }
  buildSha ??= execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  buildClient({ env, buildSha }).then(result => console.log(`client build: ${result.environment}; ${result.hashedFiles.length} hashed files`)).catch(() => { console.error('client build failed'); process.exitCode = 1; });
}
