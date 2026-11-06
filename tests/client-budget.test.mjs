import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { brotliCompressSync } from 'node:zlib';
import { measureEntries, assertBudgets } from '../scripts/size-budget.mjs';
test('the Brotli budget includes imported shared code and fails above measured headroom', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'case-budget-'));
  try {
    mkdirSync(join(outDir, 'assets')); writeFileSync(join(outDir, 'assets/app.mjs'), "import '/assets/shared.mjs';"); writeFileSync(join(outDir, 'assets/shared.mjs'), 'export const value = 1;');
    const measured = await measureEntries(outDir, { app: 'assets/app.mjs' }); const budgets = { app: Math.ceil(measured.app * 1.1) };
    assertBudgets(measured, budgets);
    writeFileSync(join(outDir, 'assets/shared.mjs'), Array.from({ length: 1500 }, (_, i) => `export const v${i} = '${createHash('sha256').update(String(i)).digest('hex')}';`).join('\n'));
    assert.throws(() => assertBudgets({ app: 999 }, {}), /unbudgeted_entry/);
    const grown = await measureEntries(outDir, { app: 'assets/app.mjs' }); assert.ok(grown.app > budgets.app); assert.throws(() => assertBudgets(grown, budgets), /bundle_budget_exceeded/);
  } finally { rmSync(outDir, { recursive: true, force: true }); }
});
test('[AS-102] a lazily imported chunk counts against its own budget, never silently: an unbudgeted dynamic chunk fails', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'case-budget-'));
  try {
    mkdirSync(join(outDir, 'assets'));
    const big = Array.from({ length: 800 }, (_, i) => `export const v${i} = '${createHash('sha256').update(String(i)).digest('hex')}';`).join('\n');
    writeFileSync(join(outDir, 'assets/app.mjs'), "import '/assets/shared.mjs'; export const load = () => import('/assets/library.mjs');");
    writeFileSync(join(outDir, 'assets/shared.mjs'), 'export const value = 1;');
    writeFileSync(join(outDir, 'assets/library.mjs'), `import '/assets/shared.mjs';\n${big}`);
    await assert.rejects(measureEntries(outDir, { app: 'assets/app.mjs' }), /unbudgeted_dynamic_chunk/);
    const measured = await measureEntries(outDir, { app: 'assets/app.mjs', library: 'assets/library.mjs' });
    assert.ok(measured.app < 200, 'the first load excludes the lazy chunk');
    assert.ok(measured.library > 10_000, 'the lazy chunk is measured with its own static closure');
  } finally { rmSync(outDir, { recursive: true, force: true }); }
});

// Card 29 re-check: a file whose Brotli size is close to `bytes` (random base64 inside a comment).
import { randomBytes } from 'node:crypto';
import { BASELINE as BASE, BUDGETS as CAPS, DEFERRED_ROUTES, ROUTES } from '../scripts/size-budget.mjs';
const noise = (bytes, imports = '') => `${imports}/* ${randomBytes(Math.max(0, bytes - 40)).toString('base64')} */\nexport const x = 1;\n`;

test('[AS-102] the root first load is capped at its measured size: 20 KB more in app.mjs fails', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'case-budget-'));
  try {
    mkdirSync(join(outDir, 'assets'));
    writeFileSync(join(outDir, 'assets/app.mjs'), noise(BASE.app + 20_000));
    const measured = await measureEntries(outDir, { app: 'assets/app.mjs' });
    assert.ok(measured.app > BASE.app + 19_000);
    assert.throws(() => assertBudgets(measured), /bundle_budget_exceeded:app/);
  } finally { rmSync(outDir, { recursive: true, force: true }); }
});

test('[AS-105] route unions count each module once and cap /cases even when every chunk is under its own cap', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'case-budget-'));
  try {
    mkdirSync(join(outDir, 'assets'));
    writeFileSync(join(outDir, 'assets/shared.mjs'), noise(4_000));
    writeFileSync(join(outDir, 'assets/app.mjs'), noise(BASE.app - 6_000, "import '/assets/shared.mjs';\nexport const l = () => [import('/assets/console.mjs'), import('/assets/home.mjs')];\n"));
    writeFileSync(join(outDir, 'assets/console.mjs'), noise(CAPS.console - 5_000, "import '/assets/shared.mjs';\nexport const l = () => import('/assets/library.mjs');\n"));
    writeFileSync(join(outDir, 'assets/library.mjs'), noise(CAPS.library - 5_000, "import '/assets/shared.mjs';\nexport const g = () => import('/assets/groups-screen.mjs');\n"));
    writeFileSync(join(outDir, 'assets/home.mjs'), noise(1_000, "import '/assets/shared.mjs';\n"));
    writeFileSync(join(outDir, 'assets/console-tones.mjs'), "export const x = 1;\n");
    // Card 30: the Groups screen is a lazy chunk of /cases (library) and of the Administration page.
    // CASE-226 raised the /cases ceiling; the Groups chunk carries enough bytes that the union still crosses it.
    writeFileSync(join(outDir, 'assets/groups-screen.mjs'), noise(CAPS['groups-screen'] - 5_000, "import '/assets/shared.mjs';\n"));
    writeFileSync(join(outDir, 'assets/splash.mjs'), "export const x = 1;\n"); // the shared art chunk, a /cases route member (card 36a)
    writeFileSync(join(outDir, 'assets/account-session.mjs'), "export const x = 1;\n"); // card 38: a /cases and /admin route member
    writeFileSync(join(outDir, 'assets/admin.mjs'), noise(1_000, "export const g = () => import('/assets/groups-screen.mjs');\n"));
    // Card 40 slice 7 and CASE-334/335 raised the /cases cap (I6); the Room tab carries enough bytes that the union still crosses it.
    writeFileSync(join(outDir, 'assets/console-room-tab.mjs'), noise(9_000));
    writeFileSync(join(outDir, 'assets/projector.mjs'), "export const slides = () => import('/assets/projector-slides.mjs');\n");
    writeFileSync(join(outDir, 'assets/projector-slides.mjs'), "import '/assets/slide-render.mjs';\n");
    writeFileSync(join(outDir, 'assets/slide-render.mjs'), 'export const x = 1;');
    writeFileSync(join(outDir, 'assets/icons.mjs'), 'export const x = 1;'); // CASE-344: the callout icons, a lazy chunk of the slide renderer
    writeFileSync(join(outDir, 'assets/room-music.mjs'), "export const x = 1;\n"); // CASE-192: new display route member in the strict fixture
    writeFileSync(join(outDir, 'assets/builder-page.mjs'), noise(100, "export const open = () => import('/assets/builder-route.mjs');\nexport const make = () => import('/assets/builder-api.mjs');\nexport const templates = () => import('/assets/builder-templates.mjs');\n"));
    writeFileSync(join(outDir, 'assets/builder-route.mjs'), noise(2_000, "import '/assets/shared.mjs';\nexport const tools = () => import('/assets/builder-workflows.mjs');\nexport const studio = () => import('/assets/builder-studio.mjs');\nexport const check = () => import('/assets/builder-slide-check.mjs');\nexport const slides = () => import('/assets/builder-slides.mjs');\nexport const inspect = () => import('/assets/builder-inspection.mjs');\n"));
    writeFileSync(join(outDir, 'assets/builder-studio.mjs'), noise(2_000, "import '/assets/shared.mjs';\n"));
    writeFileSync(join(outDir, 'assets/builder-api.mjs'), noise(1_000, "import '/assets/shared.mjs';\n"));
    writeFileSync(join(outDir, 'assets/builder-templates.mjs'), noise(1_000, "import '/assets/shared.mjs';\n"));
    writeFileSync(join(outDir, 'assets/builder-page.css'), '.builder-page { display: block; }\n');
    writeFileSync(join(outDir, 'assets/builder-studio.css'), '.builder-studio { color: #123; }\n');
    writeFileSync(join(outDir, 'assets/builder-preview-snapshot.mjs'), 'export const ready = true;');
    writeFileSync(join(outDir, 'assets/console-room.mjs'), 'export const open = true;');
    writeFileSync(join(outDir, 'assets/builder-workflows.mjs'), "import '/assets/shared.mjs';\n");
    // Card 51: the slide validator loads on every Builder view; the canvas (and its stylesheet) on the editor view only.
    writeFileSync(join(outDir, 'assets/builder-slide-check.mjs'), 'export const check = true;');
    writeFileSync(join(outDir, 'assets/builder-slides.mjs'), "import '/assets/builder-slide-check.mjs';\nexport const media = () => import('/assets/builder-media.mjs');\nexport const gas = () => import('/assets/builder-gas.mjs');\n");
    writeFileSync(join(outDir, 'assets/builder-gas.mjs'), 'export const x = 1;\n'); // CASE-317: the lazy gas editor
    writeFileSync(join(outDir, 'assets/builder-gas.css'), '.builder-gas-entry { width: 100%; }\n');
    writeFileSync(join(outDir, 'assets/builder-media.mjs'), "export const gif = () => import('/assets/media-gif.mjs');\nexport const mp4 = () => import('/assets/media-mp4.mjs');\n"); // card 59 M2: the lazy upload chunk
    for (const name of ['media-gif', 'media-mp4']) writeFileSync(join(outDir, `assets/${name}.mjs`), 'export const x = 1;\n'); // GIF and video walks, loaded on choice
    writeFileSync(join(outDir, 'assets/builder-slides.css'), '.builder-slide { display: grid; }\n');
    // CASE-226: the Run preview loads the readiness check and lazily the slide renderers and the room art.
    writeFileSync(join(outDir, 'assets/builder-inspection.mjs'), "import '/assets/builder-preview-snapshot.mjs';\nexport const s = () => [import('/assets/projector-slides.mjs'), import('/assets/splash.mjs'), import('/assets/builder-slide-check.mjs')];\n");
    writeFileSync(join(outDir, 'assets/builder-fit.mjs'), "import '/assets/builder-slide-check.mjs';\n");
    writeFileSync(join(outDir, 'assets/builder-shell.mjs'), "export const fit = () => import('/assets/builder-fit.mjs');\n");
    writeFileSync(join(outDir, 'assets/builder-shell.css'), '.builder-studio { display: flex; }\n');
    writeFileSync(join(outDir, 'assets/case-map.mjs'), 'export const x = 1;');
    writeFileSync(join(outDir, 'assets/keymap-sheet.mjs'), 'export const x = 1;'); // CASE-249: the lazy ? sheet
    writeFileSync(join(outDir, 'assets/builder-structure.mjs'), 'export const x = 1;'); // 2026-10-17: the lazy slide menu
    for (const name of ['invite-landing', 'admin-invitations', 'admin-people', 'admin-workspaces', 'case-share']) writeFileSync(join(outDir, `assets/${name}.mjs`), 'export const x = 1;\n'); // CASE-339: route members
    writeFileSync(join(outDir,'assets/admin.css'),'.admin-surface {display:grid;}');
    const entries = { 'admin-css':'assets/admin.css', 'case-share':'assets/case-share.mjs','invite-landing':'assets/invite-landing.mjs','admin-invitations':'assets/admin-invitations.mjs','admin-people':'assets/admin-people.mjs','admin-workspaces':'assets/admin-workspaces.mjs','keymap-sheet':'assets/keymap-sheet.mjs','case-map':'assets/case-map.mjs','builder-page':'assets/builder-page.mjs','builder-preview-snapshot':'assets/builder-preview-snapshot.mjs','builder-workflows':'assets/builder-workflows.mjs','console-room':'assets/console-room.mjs','room-music': 'assets/room-music.mjs', app: 'assets/app.mjs', console: 'assets/console.mjs', library: 'assets/library.mjs', home: 'assets/home.mjs', 'console-tones': 'assets/console-tones.mjs',
      'groups-screen': 'assets/groups-screen.mjs', admin: 'assets/admin.mjs',
      projector: 'assets/projector.mjs', splash: 'assets/splash.mjs', 'console-room-tab': 'assets/console-room-tab.mjs', 'account-session': 'assets/account-session.mjs', 'builder-route': 'assets/builder-route.mjs', 'builder-studio': 'assets/builder-studio.mjs', 'builder-api': 'assets/builder-api.mjs', 'builder-templates': 'assets/builder-templates.mjs', 'builder-page-css': 'assets/builder-page.css', 'builder-studio-css': 'assets/builder-studio.css' };
    Object.assign(entries, { 'builder-shell': 'assets/builder-shell.mjs', 'builder-shell-css': 'assets/builder-shell.css', 'builder-fit': 'assets/builder-fit.mjs', 'builder-structure': 'assets/builder-structure.mjs' });
    Object.assign(entries, { icons: 'assets/icons.mjs', 'projector-slides': 'assets/projector-slides.mjs', 'slide-render': 'assets/slide-render.mjs', 'builder-slide-check': 'assets/builder-slide-check.mjs', 'builder-slides': 'assets/builder-slides.mjs', 'builder-gas': 'assets/builder-gas.mjs', 'builder-gas-css': 'assets/builder-gas.css', 'builder-media': 'assets/builder-media.mjs', 'media-gif': 'assets/media-gif.mjs', 'media-mp4': 'assets/media-mp4.mjs', 'builder-slides-css': 'assets/builder-slides.css', 'builder-inspection': 'assets/builder-inspection.mjs' });
    for(const name of ['case-detail','menu-account','account-page','unavailable','admin-workbench','portfolio-page','session-detail','session-export','session-pdf','feedback-page','participant-record','ended-summary','debrief-render','feedback-results','recap-pdf','finish-block','facilitator-label-form','builder-sources','builder-overview','console-mirror']){writeFileSync(join(outDir,`assets/${name}.mjs`),'export const x=1;');entries[name]=`assets/${name}.mjs`;}
    // Placement tools consume their own fixed closure and remain charged to the catalogue union.
    writeFileSync(join(outDir,'assets/case-workspace-access.mjs'),noise(CAPS['case-workspace-access']-5000,"import '/assets/shared.mjs';\n"));entries['case-workspace-access']='assets/case-workspace-access.mjs';
    writeFileSync(join(outDir,'assets/feedback-presentation.css'),'.feedback-question { display:grid; }');entries['feedback-presentation-css']='assets/feedback-presentation.css';
    // CASE-359: lazy audition is a separately charged closure and on-press route union, including its stylesheet.
    writeFileSync(join(outDir,'assets/music-audition.mjs'),noise(1000,"import '/assets/shared.mjs';\n"));entries['music-audition']='assets/music-audition.mjs';
    writeFileSync(join(outDir,'assets/music-audition.css'),'.player { display: grid; }');entries['music-audition-css']='assets/music-audition.css';
    writeFileSync(join(outDir,'assets/menu-account.mjs'),"export const audition=()=>import('/assets/music-audition.mjs');");
    // Card 40 slice 8: the briefing and the PDF writer it loads are /cases members; they carry enough bytes that the union crosses its raised cap.
    writeFileSync(join(outDir, 'assets/briefing.mjs'), noise(CAPS.briefing - 2_000));
    // CASE-343 A6: the /cases cap rose by Share's closure, so the Room tab (a /cases and facilitate member only) fills its own cap too.
    writeFileSync(join(outDir, 'assets/console-room-tab.mjs'), noise(CAPS['console-room-tab'] - 2_000)); entries.briefing = 'assets/briefing.mjs';
    writeFileSync(join(outDir, 'assets/session-pdf.mjs'), noise(CAPS['session-pdf'] - 2_000));
    for(const name of ['issue-entry','issue-reporter','admin-issues']){writeFileSync(join(outDir,`assets/${name}.mjs`),noise(500));entries[name]=`assets/${name}.mjs`;}
    writeFileSync(join(outDir,'assets/issues.css'),'.issues { display: grid; }');entries['issues-css']='assets/issues.css';
    const measured = await measureEntries(outDir, entries, ROUTES, DEFERRED_ROUTES);
    assert.equal(measured['route:/#music'],measured['route:/#menu']+measured['music-audition']-brotliCompressSync(readFileSync(join(outDir,'assets/shared.mjs'))).length+measured['music-audition-css'],'Music union charges JS/CSS once, without contaminating cold or menu-only routes');
    for (const name of ['app', 'console', 'library']) assert.ok(measured[name] <= CAPS[name], `${name} under its own cap`);
    // The shared module is counted once in the union, not once per chunk.
    assert.ok(measured['route:/cases'] < ROUTES['route:/cases'].reduce((sum, name) => sum + measured[name], 0) - 3_000);
    assert.ok(measured['route:/'] < measured.app + measured.home);
    // Check the intended over-budget route first: shared fixture growth may also exceed another route.
    assert.throws(() => assertBudgets({ 'route:/cases': measured['route:/cases'], ...measured }, { ...CAPS, 'builder-route': Math.ceil(measured['builder-route'] * 1.1), 'builder-studio': Math.ceil(measured['builder-studio'] * 1.1), 'builder-api': Math.ceil(measured['builder-api'] * 1.1), 'builder-templates': Math.ceil(measured['builder-templates'] * 1.1), 'builder-studio-css': Math.ceil(measured['builder-studio-css'] * 1.1), 'route:/cases/:id/edit': 169381 }), /bundle_budget_exceeded:route:\/cases/);
    assert.equal(CAPS['route:/cases'], 346396, '/cases is capped at its CASE-226 measured ceiling plus the card 40 + feedback stack, room PDFs v2, console Debrief, slide gas/fill/badge, facilitator-fix and Debrief-and-results growth (I6, CASE-289, CASE-291, CASE-311 to CASE-313, CASE-322, CASE-327), the proposed CASE-334 room music growth and the CASE-335 player, the CASE-366 scoped workspace invitation/confirmation/navigation closure and the approved CASE-378 authenticated report-entry accounting');
    assert.ok(measured['route:/cases/:id/edit'] > measured['builder-route'] + measured['builder-studio'], 'edit route charges shell, catalogue resolver and editor closure');
    assert.equal(ROUTES['route:/cases'].includes('builder-route'), false, 'catalogue route excludes unvisited editor closure');
  } finally { rmSync(outDir, { recursive: true, force: true }); }
});

const lib = (dir, outer = {}) => { mkdirSync(join(dir, 'assets')); for (const [f, body] of Object.entries(outer)) writeFileSync(join(dir, 'assets', f), body); };

test('[AS-105] a route member that lazily imports a chunk the route does not list fails (no byte escapes the route union)', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'case-budget-'));
  try {
    lib(outDir, { 'app.mjs': "export const l = () => import('/assets/home.mjs');", 'home.mjs': "export const l = () => import('/assets/library.mjs');", 'library.mjs': noise(5_000) });
    writeFileSync(join(outDir, 'assets/room-music.mjs'), "export const x = 1;\n"); // CASE-192: new display route member in the strict fixture
    writeFileSync(join(outDir, 'assets/case-map.mjs'), 'export const x = 1;');
    writeFileSync(join(outDir, 'assets/keymap-sheet.mjs'), 'export const x = 1;'); // CASE-249: the lazy ? sheet
    const entries = { 'keymap-sheet':'assets/keymap-sheet.mjs','case-map':'assets/case-map.mjs','room-music': 'assets/room-music.mjs', app: 'assets/app.mjs', home: 'assets/home.mjs', library: 'assets/library.mjs' };
    await assert.rejects(measureEntries(outDir, entries, { 'route:/': ['app', 'home'] }), /route_dynamic_escape:route:\/:home:assets\/library\.mjs/);
    // The shell (app) dispatches to every surface; a member importing a chunk the route lists is fine.
    const ok = await measureEntries(outDir, entries, { 'route:/': ['app', 'home', 'library'] });
    assert.ok(ok['route:/'] > 0);
  } finally { rmSync(outDir, { recursive: true, force: true }); }
});

test('[AS-105] a route with a missing member fails loudly instead of being skipped', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'case-budget-'));
  try {
    lib(outDir, { 'app.mjs': 'export const x = 1;' });
    await assert.rejects(measureEntries(outDir, { app: 'assets/app.mjs' }, { 'route:/': ['app', 'home'] }), /route_member_missing:route:\/:home/);
  } finally { rmSync(outDir, { recursive: true, force: true }); }
});

test('[AS-105] a budget for a chunk or route that was not measured fails (stale budgets cannot hide)', () => {
  assert.throws(() => assertBudgets({ app: 10 }, { app: 100, gone: 100 }), /stale_budget:gone/);
  assert.doesNotThrow(() => assertBudgets({ app: 10 }, { app: 100 }));
});

test('[AS-102] every size cap is pinned: raising one needs a decision recorded in docs/DECISIONS.md', () => {
  // To raise a cap: record the decision (a CASE id) in docs/DECISIONS.md, then update this table in the same change.
  // Card 30 added two budgets (no existing cap raised): the new lazy Groups chunk and the Administration page's
  // union, each at its measured closure + 10% under CASE-166's rule. CASE-174 (card 36b) added the projector's /display union
  // (app ∪ projector ∪ the shared splash chunk) the same way.
  // CASE-192 adds only the explicitly approved4096B music cap; every prior cap remains byte-exact.
  // C45 adds measured lazy Builder entries and an edit route bounded by the unchanged catalogue ceiling.
  // Card 51 adds three measured lazy slide entries (closure + 10%); no existing cap changes.
  // Card 52 adds the measured lazy inspection entry the same way.
  // Card 57 served slides add projector-slides and slide-render the same way.
  // CASE-249 (Julian, 2026-10-14) adds the lazy keymap-sheet chunk (1,661 + 10%) and rebaselines the edit route (276,619 + 10%).
  // CASE-258 (Julian, 2026-10-15) rebaselines builder-studio (39,062 + 10%) and the workflows route (171,267 + 10%) for D15/D16.
  // CASE-263 (Julian, 2026-10-15, measured + 10%): slide-render 4,005 → 4,406; projector-slides 4,769 → 5,246; builder-slide-check 8,036 → 8,840; builder-inspection 100,557 → 110,613; builder-fit 38,914 → 42,806; builder-slides 43,158 → 47,474; pair 110,785 → 121,864; route:/cases/:id/edit/preview 254,412 → 279,854.
  // CASE-264 hero slides (Julian, 2026-10-15, "Approve 5,400"): projector-slides 5,246 → 5,400.
  // CASE-268 (Julian, 2026-10-15, measured + 10%): slide-render 4,711 → 5,183; projector-slides 5,478 → 6,026; builder-media 11,177 → 12,295.
  // CASE-269 (Julian, 2026-10-15, measured + 10%): projector 60,451 → 66,497; route:/display 89,773 → 98,751.
  // CASE-279/280: exact route and six Builder limits explicitly approved by Julian.
  // Card 40 + feedback integration slice 1 (Julian, 2026-10-17, I6): session-pdf 37,387; route:/history and route:/account 157,073; route:/admin 119,852.
  // PDF scripts (Julian, 2026-10-17, rulings a–c, measured + 10%): session-pdf 52,945; route:/history and route:/account 176,311; route:/admin 139,110.
  // Slide structure (Julian, 2026-10-17, I7): the new lazy builder-structure chunk, 10,610 + 10%.
  // Card 40 + feedback integration slice 10 (I6): participant-record 8,376 (7,614 + 10%); route:participant-record 53,705; route:/F unchanged.
  // Card 40 + feedback integration slice 2 (Julian, 2026-10-17, I6): session-detail 28,681; portfolio-page 34,696; route:/history and route:/account 160,830; route:/admin 123,610.
  // Card 62 PUBLISH-01 (Julian, 2026-10-18, standing rule: previous cap + 1.1 x growth): builder-route 48,819 → 49,739 (+836 B measured).
  // Card 40 + feedback integration slice 9 (I6, measured + 10%): feedback-results 19,448; route:/history and route:/account 165,703; route:/admin 128,721; route:/cases 217,059; facilitate 242,571.
  // Card 61 (Julian's rule via the orchestrator, 2026-10-18, previous cap + 1.1 × growth): console-room 112,638 + 152 = 112,790.
  // Console layout v2 (Julian, 2026-10-18, standing rule: previous cap + 1.1 × growth): console-room 112,790 + 2,519 = 115,309.
  // Room PDFs v2 (CASE-289; Julian's standing rule, 2026-10-18: previous cap + 1.1 × growth over main 351742a, at most +10%):
  // briefing 25,377; console-room 116,426 (115,309 after #304, + 1,117); pair 122,945 (121,864 + 1.1 × 983 over main e605fbb); debrief-render 22,831; groups-screen 47,822; participant-record 9,209; portfolio-page 37,246; recap-pdf 11,888; route:/ 59,654; route:/F 45,357; route:/account 186,604; route:/history 186,604; route:/admin 149,343; route:/cases 283,287; route:/sessions/:id/facilitate 308,917; route:participant-record 76,106; session-detail 31,229; session-pdf 54,537; splash 21,869.
  // New lazy chunks at measured + 10%: finish-block, feedback-client, record-summary.
  // Facilitator Name & role (CASE-290; the same rule over room PDFs v2's final head 8285e0c): the new lazy facilitator-label-form 17,250
  // (15,681 + 10%); admin 33,209 → 36,149; portfolio-page 37,246 → 39,822; route:/admin 149,343 → 152,057; facilitate 308,917 → 311,629.
  // Console Debrief (CASE-291; the same rule over 6af9ee4): pair 125,390; console-room 118,872; builder-inspection 112,098;
  // route:/cases 287,009; /history and /account 187,470; facilitate 316,497 (scripts/size-budget.mjs has the measured sizes).
  // Blood gas, slide fill and branch badge (CASE-311 to CASE-313; the same rule over main 0c410ffc): builder-inspection 113,960;
  // builder-fit 45,963; builder-slides 58,206; builder-workflows 51,318; recap-pdf 12,708; console-room 120,268; pair 126,790;
  // builder-slides-css 1,626; route:/cases 290,840; edit 342,281; /history and /account 189,119; facilitate 320,327.
  // Approved by Julian 2026-10-30 past the 10% ceiling: slide-render 6,950; projector-slides 8,716; builder-slide-check 12,284;
  // record-summary 4,269.
  // Blood gas compare mode and editor (CASE-317; the same rule over main 90ee1cda): builder-fit 46,836; builder-workflows 51,888;
  // edit 351,266; preview 280,755. New lazy chunks at measured + 10%: builder-gas 31,883 and builder-gas-css 1,008.
  // CASE-322 (Julian, 2026-10-30, the same rule over dfb5dad5): builder-inspection 116,030, builder-overview 3,978, builder-sources 8,906, builder-studio 48,735, builder-route 50,320, console-room 121,678, pair 128,198, builder-shell-css 8,245, route:/cases 293,392, route:/display 99,602, route:/cases/:id/edit 362,601, route:/cases/:id/edit/overview 401,855, route:/cases/:id/edit/workflows 189,935, route:/cases/:id/edit/preview 284,061, route:/history 190,201, route:/account 190,201, route:/sessions/:id/facilitate 322,907.
  // CASE-323 (the same rule over c37c4882): builder-fit 47,166, the projector's free-text fit shared with the fit check.
  // CASE-325 (the same rule over 0634cf0f): projector-slides 9,206, builder-fit 47,668, preview union 284,591; results take their room.
  // CASE-326 (the same rule over 8153aa41): builder-workflows 52,182; a publishing refusal counts repeated problems.
  // CASE-343 (facilitator-UX A4, previous cap + 1.1 × growth over 05baca88; new lazy chunks at measured + 10%): groups-screen 48,055,
  // session-pdf 54,719, builder-route 50,554, help 12,571, console-room 125,144, route:/ 59,923, /cases 302,735, /admin 155,672,
  // edit 363,446, preview 288,359, /history and /account 194,826; admin-invitations 21,084, invite-page 13,020, invite-landing 5,873.
  // CASE-348: exact measured-growth caps over fc588690; see the card-study audit table.
  // CASE-359: owner-approved fixed measured allocations, independently pinned here.
  const PINNED = {
  "case-workspace-access": 27267,
  "admin-css": 3463,
  "case-share": 9505,
  "admin-people": 41699,
  "admin-workspaces": 32018,
  "admin-invitations": 36815,
  "invite-page": 16364,
  "invite-landing": 5873,
  "facilitator-label-form": 17250,
  "finish-block": 7292,
  "feedback-client": 6712,
  "record-summary": 4269,
  "recap-pdf": 13092,
  "briefing": 25377,
  "participant-record": 9209,
  "route:participant-record": 76106,
  "builder-structure": 11672,
  "feedback-results": 20872,
  "ended-summary": 17420,
  "debrief-render": 22831,
  "route:ended-summary": 86900,
  "feedback-page": 12557,
  "route:/F": 45357,
  "builder-media": 22576,
  "media-gif": 1177,
  "media-mp4": 3335,
  "case-map": 29943,
  "room-music": 12459,
  "admin": 40871,
  "check": 24129,
  "console": 109630,
  "projector": 66784,
  "phone": 90287,
  "pair": 139337,
  "app": 34194,
  "sw": 10928,
  "home": 30211,
  "library": 50559,
  "console-tones": 1701,
  "route:/": 64287,
  "groups-screen": 55777,
  "route:/admin": 221845,
  "route:/history": 206228,
  "route:/account": 198772,
  "admin-workbench": 36040,
  "portfolio-page": 50623,
  "session-detail": 31229,
  "session-export": 24723,
  "session-pdf": 57758,
  "help": 16688,
  "splash": 21869,
  "route:/display": 110776,
  "console-room-tab": 32243,
  "account-session": 12616,
  "console-room": 132432,
  "builder-page-css": 636,
  "builder-page": 32408,
  "builder-route": 51454,
  "builder-studio": 54576,
  "builder-api": 2639,
  "builder-templates": 2764,
  "builder-studio-css": 1597,
  "builder-preview-snapshot": 16526,
  "builder-workflows": 52558,
  "builder-slide-check": 12284,
  "builder-slides": 62909,
  "builder-gas": 31883,
  "builder-gas-css": 1008,
  "builder-slides-css": 1711,
  "builder-inspection": 123869,
  "builder-shell": 9776,
  "builder-shell-css": 8896,
  "builder-fit": 48453,
  "keymap-sheet": 1828,
  "projector-slides": 9769,
  "slide-render": 7511,
  "route:/cases/new": 65593,
  "route:/cases/:id/edit": 378488,
  "route:/cases/:id/edit/workflows": 200579,
  "route:/cases/:id/edit/preview": 299439,
  "route:/sessions/:id/facilitate": 373295,
  "builder-overview": 3978,
  "builder-sources": 8906,
  "route:/cases/:id/edit/overview": 401855,
  "console-mirror": 38629,
  "icons": 1435,
  "route:/cases": 343508,
  "menu-account": 23284,
  "account-page": 23281,
  "case-detail": 38060,
  "unavailable": 15046,
  "route:participant-record#menu": 105082,
  "route:/#menu": 81498,
  "route:ended-summary#menu": 99885,
  "route:/display#menu": 134797,
  "route:/F#menu": 61786,
  "route:/present": 343508,
  "route:/create": 343508,
  "route:/create/new": 65593,
  "route:/sessions": 206228,
  "route:/sessions/:id": 206228,
  "music-audition": 24502,
  "music-audition-css": 9390,
  "route:participant-record#music": 137884,
  "route:/#music": 113160,
  "route:ended-summary#music": 132656,
  "route:/cases#music": 376174,
  "route:/admin#music": 263166,
  "route:/display#music": 155495,
  "route:/cases/new#music": 101206,
  "route:/cases/:id/edit#music": 442448,
  "route:/cases/:id/edit/overview#music": 450191,
  "route:/cases/:id/edit/workflows#music": 249671,
  "route:/cases/:id/edit/preview#music": 355759,
  "route:/history#music": 253790,
  "route:/account#music": 165690,
  "route:/F#music": 94606,
  "route:/sessions/:id/facilitate#music": 409880,
  "route:/present#music": 376174,
  "route:/create#music": 376174,
  "route:/create/new#music": 101206,
  "route:/sessions#music": 253790,
  "route:/sessions/:id#music": 253790,
  "feedback-presentation-css": 1369,
  // CASE-376: exact owner-approved values; no automatic rebaseline.
  ...{"builder-route":51776,"builder-page":33056,"help":17107,"briefing":25690,"console-room-tab":32564,"console-room":133067,"groups-screen":56341,"admin":41683,"portfolio-page":51249,"phone":90929,"unavailable":15456,"route:/":65027,"route:/cases":346396,"route:/admin":234875,"route:/display":111110,"route:/cases/new":68411,"route:/cases/:id/edit":381305,"route:/cases/:id/edit/workflows":203396,"route:/cases/:id/edit/preview":302256,"route:/sessions/:id/facilitate":376176,"route:/present":346396,"route:/create":346396,"route:/create/new":68411,"issue-reporter":15605,"issue-entry":4088,"admin-issues":15757,"issues-css":533,"route:participant-record#report":95114,"route:/#report":83652,"route:ended-summary#report":107944,"route:/cases#report":389831,"route:/admin#report":260080,"route:/display#report":136565,"route:/cases/new#report":85600,"route:/cases/:id/edit#report":429576,"route:/cases/:id/edit/overview#report":437319,"route:/cases/:id/edit/workflows#report":234053,"route:/cases/:id/edit/preview#report":342859,"route:/history#report":200792,"route:/account#report":108146,"route:/F#report":63474,"route:/sessions/:id/facilitate#report":423179,"route:/present#report":389831,"route:/create#report":389831,"route:/create/new#report":85600,"route:/sessions#report":200792,"route:/sessions/:id#report":200792,"route:participant-record#menu#report":120561,"route:/#menu#report":97602,"route:ended-summary#menu#report":115359,"route:/display#menu#report":150719,"route:/F#menu#report":77627,"route:participant-record#music#report":150394,"route:/#music#report":126487,"route:ended-summary#music#report":145192,"route:/cases#music#report":411649,"route:/admin#music#report":288965,"route:/display#music#report":168431,"route:/cases/new#music#report":114485,"route:/cases/:id/edit#music#report":455806,"route:/cases/:id/edit/overview#music#report":463549,"route:/cases/:id/edit/workflows#music#report":262938,"route:/cases/:id/edit/preview#music#report":369090,"route:/history#music#report":229677,"route:/account#music#report":137031,"route:/F#music#report":107461,"route:/sessions/:id/facilitate#music#report":444998,"route:/present#music#report":411649,"route:/create#music#report":411649,"route:/create/new#music#report":114485,"route:/sessions#music#report":229677,"route:/sessions/:id#music#report":229677}
  };
  assert.deepEqual({ ...CAPS }, PINNED, 'a size cap changed: raising one needs a CASE decision in docs/DECISIONS.md; update PINNED with it');
});


test('SW budget is invariant under generated asset and cache hashes, while real growth still fails', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'case-budget-'));
  try {
    const sw = (salt, wire = 1, extra = '') => {
      const hash = name => salt === 'repetitive hashes' ? 'a'.repeat(64) : createHash('sha256').update(`${salt}:${name}`).digest('hex');
      return `const CACHE_NAME = 'case-shell-wire${wire}-${hash('cache')}';\nconst SHELL = ${JSON.stringify(
        ['app.mjs', 'console-room-tab.mjs', 'tokens.css', 'montserrat-latin.woff2', 'shadows-01.svg', 'ofl-montserrat.txt', 'decision-opened.wav'].map(name => {
          const dot = name.lastIndexOf('.'); return `/assets/${name.slice(0, dot)}.${hash(name)}${name.slice(dot)}`;
        }))};\n${extra}`;
    };
    writeFileSync(join(outDir, 'sw.mjs'), sw('first build'));
    const first = await measureEntries(outDir, { sw: 'sw.mjs' });
    writeFileSync(join(outDir, 'sw.mjs'), sw('second build'));
    assert.deepEqual(await measureEntries(outDir, { sw: 'sw.mjs' }), first, 'hash-only builds must measure identically');
    writeFileSync(join(outDir, 'sw.mjs'), sw('repetitive hashes'));
    assert.deepEqual(await measureEntries(outDir, { sw: 'sw.mjs' }), first, 'even repetitive generated hashes have identical cost');
    writeFileSync(join(outDir, 'sw.mjs'), sw('second build'));
    const before = sw('second build');
    await measureEntries(outDir, { sw: 'sw.mjs' });
    // Measurement must leave the actual hashed worker bytes untouched.
    assert.equal(readFileSync(join(outDir, 'sw.mjs'), 'utf8'), before);
    writeFileSync(join(outDir, 'sw.mjs'), sw('second build', 12345));
    assert.notDeepEqual(await measureEntries(outDir, { sw: 'sw.mjs' }), first, 'wire versions remain measured');
    const extra = Array.from({ length: 100 }, (_, i) => `self.extra${i} = '${createHash('sha256').update(String(i)).digest('hex')}';`).join('\n');
    writeFileSync(join(outDir, 'sw.mjs'), sw('second build', 1, extra));
    const grown = await measureEntries(outDir, { sw: 'sw.mjs' });
    assert.ok(grown.sw > first.sw, 'non-generated code and unrelated hashes remain measured');
    assert.throws(() => assertBudgets(grown, { sw: first.sw }), /bundle_budget_exceeded:sw/);
    mkdirSync(join(outDir, 'assets'));
    writeFileSync(join(outDir, 'assets/app.mjs'), before);
    const actual = await measureEntries(outDir, { app: 'assets/app.mjs' });
    assert.equal(actual.app, brotliCompressSync(before).length, 'other entries keep raw Brotli measurement');
  } finally { rmSync(outDir, { recursive: true, force: true }); }
});
